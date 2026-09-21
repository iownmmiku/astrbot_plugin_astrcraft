"""**空头承诺检查器**（D，见 docs/ESCAPE_ABILITIES.md）。

## 它防的是什么

同一个病已经出现三次：

  1. `mc_skill_run` —— 提示词让模型调这个工具，**58 个工具里根本没有它**
  2. **"先垫方块"** —— 知识库/提示词教她垫方块，**她没有垫方块的能力**
  3. **"回去捡东西"** —— 提示词说"东西都掉在那里，要不要回去捡你自己决定"，
     **她没有走回去捡的能力**（捡掉落物的反射只在空闲时触发、半径只有 6 格）

共同点：**提示词/知识库指向一个不存在的动作。**

这比"某个技能写错了"严重得多——**她会一直以为自己能做，然后一直失败**，
而且从日志上看不出来（日志只会说"走不到""够不到"）。

## 它怎么防

两层：

**① 工具名核对**：扫所有提示词来源里提到的 `mc_xxx`，逐个核对是否真实注册。
   （`test_action_agent.py` 里已经有一份，但**只扫了 action_agent.py**——
    而提示词散在 life.py、skills_docs/*.md、llm_tools_*.py 的 docstring 里。）

**② 能力承诺表**：把提示词里承诺的**动作短语**映射到必须存在的代码符号。
   这一层是关键——`mc_skill_run` 那种能被第一层抓到，
   但"垫方块""回去捡东西"**根本不是一个工具名**，第一层看不见。

## 用法

    python bot/tools/check_capabilities.py

退出码非 0 表示有承诺没兑现。新增能力时要往 `PROMISES` 里加一条。
"""

from __future__ import annotations

import re
import sys
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "plugin"
BOT = ROOT / "bot"


# ---------------------------------------------------------------- 能力承诺表
#
# 每一行：(提示词里承诺的动作, 必须在代码里找到的符号, 这个符号在哪个文件, 说明)
#
# **为什么要人工维护这张表**：自然语言里的动作短语没法自动映射到代码符号。
# 但"提示词承诺了、代码没有"这件事**必须被机器检查**——
# 靠人眼看不住（已经漏了三次）。
#
# 新增能力时：先在这里加一行，再写代码。**这一行就是"我承诺了"的登记。**
PROMISES: list[tuple[str, str, str, str]] = [
    # ---- 走路 / 地形 ----
    ("看路线要挖哪几格（mc_plan_route 的描述能力）", "_describeRouteNeeds", "bot/movement.js", "只描述，不改世界"),
    ("挖台阶/垫脚从坑里出来", "climbToSurface", "bot/skills/common.js", "代码已有"),
    ("垫脚上升（跳起来往脚下放方块）", "pillarUpOne", "bot/skills/common.js", "climbToSurface 内部"),
    # 下面这几条**故意留成失败**，等 A/B/C 批次做完再打开——
    # 它们就是当前"她做不到但提示词说能做"的证据。
    ("她能不能主动调'爬出坑'（工具入口）", "mc_climb_out", "plugin/llm_tools_skills.py", "A 批次要做"),
    ("她能不能主动'铺路/垫高'", "mc_pave", "plugin/llm_tools_skills.py", "B 批次要做"),
    ("她能不能主动'挖通一条路'", "mc_dig_path", "plugin/llm_tools_skills.py", "B 批次要做"),
    ("她能不能主动'走回去捡掉落物'", "mc_recover_drops", "plugin/llm_tools_skills.py", "C 批次要做"),
    ("死亡时写入恢复清单", "_death_recovery_todos", "plugin/life.py", "C 批次要做"),
]


def _read(path: pathlib.Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        return ""


def collect_prompt_sources() -> dict[str, str]:
    """所有"她能看到的话"的来源。

    提示词不只在一个文件里——这正是第一次漏掉 mc_skill_run 的原因
    （当时只检查了 action_agent.py）。
    """
    out: dict[str, str] = {}
    for p in sorted(PLUGIN.glob("*.py")):
        out[f"plugin/{p.name}"] = _read(p)
    for p in sorted(PLUGIN.glob("skills_docs/*.md")):
        out[f"plugin/skills_docs/{p.name}"] = _read(p)
    return out


def registered_tools() -> set[str]:
    """真实注册的 mc_* 工具名。"""
    names: set[str] = set()
    for p in PLUGIN.glob("llm_tools_*.py"):
        names |= set(re.findall(r'@filter\.llm_tool\(name="(mc_[a-z_]+)"', _read(p)))
    return names


def excluded_tools() -> set[str]:
    """**故意**不暴露给她的管理类工具（改配置/重启/暂停人生…）。"""
    src = _read(PLUGIN / "action_agent.py")
    if "EXCLUDED_TOOLS = (" not in src:
        return set()
    block = src.split("EXCLUDED_TOOLS = (")[1].split(")")[0]
    return set(re.findall(r'"(mc_[a-z_]+)"', block))


def main() -> int:
    fails: list[str] = []
    warns: list[str] = []

    print("=== ① 提示词里提到的 mc_xxx 必须真实存在 ===")
    tools = registered_tools()
    excluded = excluded_tools()
    print(f"  真实注册的工具：{len(tools)} 个")
    print(f"  故意排除的管理类：{len(excluded)} 个")
    if not tools:
        print("  ❌ 一个工具都没扫到——检查器自己坏了")
        return 1

    phantom: dict[str, set[str]] = {}
    for name, text in collect_prompt_sources().items():
        for m in set(re.findall(r"\bmc_[a-z_]+\b", text)):
            if m in tools or m in excluded:
                continue
            # 配置项/内部名不算（它们不是"让她调的工具"）
            if m in ("mc_version", "mc_persona_id") or m.startswith("mc_goal_"):
                continue
            phantom.setdefault(m, set()).add(name)

    if phantom:
        for m, files in sorted(phantom.items()):
            print(f"  ❌ {m} ← 出现在 {', '.join(sorted(files))}")
            fails.append(f"幻影工具 {m}")
    else:
        print("  ✅ 全部存在")

    print("\n=== ② 能力承诺表：提示词承诺的动作必须有代码 ===")
    for claim, symbol, where, note in PROMISES:
        path = ROOT / where
        text = _read(path)
        if not text:
            print(f"  ⚠️ {claim}：找不到文件 {where}")
            warns.append(f"{where} 不存在")
            continue
        # 工具名要去注册表里找，代码符号在文件里找
        if symbol.startswith("mc_"):
            found = symbol in tools
        else:
            found = symbol in text
        if found:
            print(f"  ✅ {claim}（{symbol}）")
        else:
            print(f"  ❌ {claim} → 找不到 {symbol}（{where}）  [{note}]")
            fails.append(f"{claim} → {symbol}")

    print("\n=== ③ 检查器自己的有效性（防止它变成永远通过的摆设）===")
    # 拿一个**已知不存在**的名字试一下：如果它也被判"存在"，说明检查器坏了
    probe = "mc_definitely_not_a_real_tool_xyz"
    if probe in tools:
        print("  ❌ 探针工具竟然被判为存在——检查器坏了")
        fails.append("检查器失效")
    else:
        print("  ✅ 不存在的名字会被判为不存在（检查器有效）")
    if "climbToSurface" in _read(BOT / "skills" / "common.js"):
        print("  ✅ 存在的代码符号会被找到（检查器有效）")
    else:
        print("  ❌ 存在的符号没找到——检查器坏了")
        fails.append("检查器失效")

    print("\n=== 结果 ===")
    if warns:
        for w in warns:
            print(f"  ⚠️ {w}")
    if fails:
        print(f"  ❌ {len(fails)} 项承诺没兑现：")
        for f in fails:
            print(f"     - {f}")
        print("\n  （这批正在做：A=climb_out / B=pave+dig_path / C=死亡恢复）")
        return 1
    print("  ✅ 所有承诺都兑现了")
    return 0


if __name__ == "__main__":
    sys.exit(main())
