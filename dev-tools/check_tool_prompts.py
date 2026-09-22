#!/usr/bin/env python3
"""工具名一致性检查：提示词里提到的 mc_* 必须真实注册，**而且在那条路径上真的可用**。

## 它防的是什么

"提示词让模型去调一个她手上没有的工具"——这个病已经出现过好几次：

  · `mc_skill_run` —— 提示词让模型调它，而 62 个工具里根本没有
  · `mc_todo_write` —— `ACTION_PROMPT` 说"复杂的事用它列清单"，
    却在 `EXCLUDED_TOOLS` 里被排除掉了（提示词承诺、工具集不给）
  · `mc_todo_write` / `mc_todo_done` / `mc_load_skill` / `mc_plan_route` ——
    `life.py` 的决策提示词让她用，而决策路径的工具集
    （`perception_agent.PERCEPTION_TOOLS`）里一个都没有

后果不是"报个错"：模型会照着提示词去调、拿到"没有工具 xxx"，
然后**要么重试、要么干脆放弃动手**——用户看到的就是"她只会说、不会做"。

所以这个检查器做三件事：

  ① **注册核对**：提示词/工具集里出现的每个 `mc_*` 都必须真实注册
     （`llm_tools_*.py` 里的 `@filter.llm_tool(name="mc_...")`）。
  ② **可用性核对**：每条提示词都要声明它属于哪条路径，路径的工具集
     （`EXCLUDED_TOOLS` / `PERCEPTION_TOOLS` / `GAME_ONLY_EXCLUDE`）里必须真的有它。
  ③ **工具集自检**：工具集里列的名字本身也不能是幽灵
     （`EXCLUDED_TOOLS` 曾经躺着 9 个**根本不存在**的管理工具名）。

## 为什么不像 test_action_agent.py 那样扫整个文件

那个测试扫的是**整个 .py 文件的文本**，于是连"解释为什么删掉了某个幽灵名字"
的注释都会被判成幻影工具引用。这里只扫**真正的提示词字符串字面量**
（`ACTION_PROMPT` / `static_rules` / `PERCEPTION_PROMPT` …），注释不算提示词。
两者互补：那个测试守住"文件里别出现不存在的工具名"，这个守住"提示词与工具集一致"。

## 用法

    py -3 dev-tools/check_tool_prompts.py

退出码非 0 表示提示词与工具集对不上。仓库根默认取本文件上一级，
可用环境变量 `ASTRCRAFT_REPO` 覆盖。
"""

from __future__ import annotations

import argparse
import ast
import io
import re
import sys
from pathlib import Path

# Windows 控制台默认 GBK，直接 print ✅/❌ 会抛 UnicodeEncodeError。
if hasattr(sys.stdout, "buffer"):
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _paths import REPO, read_text  # noqa: E402

TOOL_RE = re.compile(r'@filter\.llm_tool\(name="(mc_[a-z0-9_]+)"')
MENTION_RE = re.compile(r"\bmc_[a-z0-9_]+\b")

# 至少要扫到这么多工具，否则是**检查器自己没解析对**（而不是"代码很干净"）。
MIN_EXPECTED_TOOLS = 40
# 一定不存在的名字：如果它被判为"存在"，说明提取逻辑退化了
PROBE_NAME = "mc_definitely_not_a_real_tool_xyz"

# 各条提示词的来源与它所属的工具集
#   (说明, 文件, 变量名, 工具集来源)
PROMPT_SOURCES: tuple[tuple[str, str, str, str], ...] = (
    (
        "自主行动（action_agent）",
        "action_agent.py",
        "ACTION_PROMPT",
        "registered_minus_excluded",
    ),
    (
        "游戏内对话（game_agent）",
        "game_agent.py",
        "GAME_ACTION_PROMPT",
        "registered_minus_game_exclude",
    ),
    ("决策（life 的静态规则）", "life.py", "static_rules", "perception"),
    ("决策（life 的额外约束）", "life.py", "PERCEPTION_PROMPT_EXTRA", "perception"),
    ("决策（perception_agent）", "perception_agent.py", "PERCEPTION_PROMPT", "perception"),
)


def registered_tools(repo: Path) -> set[str]:
    names: set[str] = set()
    for p in sorted(repo.glob("llm_tools_*.py")):
        names |= set(TOOL_RE.findall(read_text(p)))
    return names


def _literal_tuple_or_set(src: str, var: str) -> set[str]:
    """取 `VAR = (...)` / `VAR = {...}` / `VAR = [...]` 里的字符串字面量。

    用 AST 而不是正则：这些容器里有注释和跨行，正则容易漏。
    取不到就返回空集合（调用方会把它当"解析失败"处理）。
    """
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == var for t in node.targets
        ):
            val = node.value
            elts = None
            if isinstance(val, (ast.Tuple, ast.Set, ast.List)):
                elts = val.elts
            if elts is None:
                return set()
            out = set()
            for e in elts:
                if isinstance(e, ast.Constant) and isinstance(e.value, str):
                    out.add(e.value)
            return out
    return set()


def _prompt_text(src: str, var: str) -> str:
    """取提示词字符串字面量（`VAR = <三引号>…<三引号>`，允许 f 前缀与缩进）。

    **允许缩进是必须的**：`life.py` 的 `static_rules` 是在方法体里赋值的
    （`        static_rules = f\"\"\"…\"\"\"`），不认缩进就会解析不到、
    然后静默地"这条提示词没有问题"——正是这个检查器要防的那种假通过。
    """
    m = re.search(rf'^[ \t]*{re.escape(var)}\s*=\s*f?"""(.*?)"""', src, re.S | re.M)
    return m.group(1) if m else ""


def main() -> int:
    ap = argparse.ArgumentParser(description="提示词与工具集一致性检查")
    ap.add_argument("--repo", default=None, help="仓库根目录（默认取本文件上一级 / ASTRCRAFT_REPO）")
    args = ap.parse_args()

    repo = Path(args.repo).resolve() if args.repo else REPO

    print("=== 提示词与工具集一致性检查 ===")
    print(f"仓库根：{repo}\n")

    failures: list[str] = []
    tools = registered_tools(repo)

    # ---- 检查器自检 ----
    if len(tools) < MIN_EXPECTED_TOOLS:
        print(f"❌ 只扫到 {len(tools)} 个注册工具（预期 >= {MIN_EXPECTED_TOOLS}）——检查器自己坏了")
        return 2
    if PROBE_NAME in tools:
        print("❌ 探针名字被判为存在——提取逻辑坏了")
        return 2
    print(f"真实注册的工具：{len(tools)} 个（探针自检通过 ✅）")

    action_src = read_text(repo / "action_agent.py")
    game_src = read_text(repo / "game_agent.py")
    perception_src = read_text(repo / "perception_agent.py")

    excluded = _literal_tuple_or_set(action_src, "EXCLUDED_TOOLS")
    game_exclude = _literal_tuple_or_set(game_src, "GAME_ONLY_EXCLUDE")
    perception_tools = _literal_tuple_or_set(perception_src, "PERCEPTION_TOOLS")

    if not excluded:
        failures.append("解析不出 action_agent.EXCLUDED_TOOLS")
        print("❌ 解析不出 EXCLUDED_TOOLS（结构变了？）")
    if not game_exclude:
        failures.append("解析不出 game_agent.GAME_ONLY_EXCLUDE")
        print("❌ 解析不出 GAME_ONLY_EXCLUDE（结构变了？）")
    if not perception_tools:
        failures.append("解析不出 perception_agent.PERCEPTION_TOOLS")
        print("❌ 解析不出 PERCEPTION_TOOLS（结构变了？）")
    if failures:
        print("\n=== 结果 ===")
        for f in failures:
            print(f"  ✗ {f}")
        return 2

    # ---- ① 工具集里不许有幽灵 ----
    print("\n① 工具集里列的名字必须真实注册（不许有幽灵条目）")
    for label, names in (
        ("action_agent.EXCLUDED_TOOLS", excluded),
        ("game_agent.GAME_ONLY_EXCLUDE", game_exclude),
        ("perception_agent.PERCEPTION_TOOLS", perception_tools),
    ):
        ghosts = sorted(n for n in names if n not in tools)
        if ghosts:
            for g in ghosts:
                failures.append(f"{label} 里的 {g} 没有注册（幽灵条目）")
            print(f"  ❌ {label}：{len(ghosts)} 个幽灵条目 → {ghosts}")
        else:
            print(f"  ✅ {label}：{len(names)} 个名字全部真实存在")

    available = {
        "registered_minus_excluded": tools - excluded,
        "registered_minus_game_exclude": tools - game_exclude,
        "perception": perception_tools,
    }

    # ---- ② 提示词里提到的工具必须在对应工具集里 ----
    print("\n② 提示词提到的 mc_* 必须在**那条路径的工具集里真的可用**")
    total_mentions = 0
    for label, filename, var, scope in PROMPT_SOURCES:
        src = read_text(repo / filename)
        if not src:
            failures.append(f"读不到 {filename}")
            print(f"  ❌ 读不到 {filename}")
            continue
        text = _prompt_text(src, var)
        if not text:
            failures.append(f"{filename} 里找不到提示词 {var}（结构变了？）")
            print(f"  ❌ {filename}：找不到提示词 {var}（结构变了？）")
            continue
        mentions = sorted(set(MENTION_RE.findall(text)))
        total_mentions += len(mentions)
        ok_set = available[scope]
        unknown = [m for m in mentions if m not in tools]
        unavailable = [m for m in mentions if m in tools and m not in ok_set]
        print(f"  {label}（{filename}:{var}）：提到 {len(mentions)} 个工具")
        if unknown:
            for m in unknown:
                failures.append(f"{label} 提到未注册的工具 {m}")
            print(f"    ❌ 未注册（模型会拿到「没有工具 xxx」）：{unknown}")
        if unavailable:
            for m in unavailable:
                failures.append(f"{label} 提到 {m}，但它不在这条路径的工具集里")
            print(f"    ❌ 已注册但**这条路径用不了**：{unavailable}")
        if not unknown and not unavailable:
            print(f"    ✅ 全部可用：{', '.join(mentions) if mentions else '（没有提到具体工具）'}")

    if total_mentions == 0:
        print("\n❌ 一处工具名都没提到——提取逻辑失效（而不是提示词很干净）")
        return 2

    # ---- ③ 顺手核对：非提示词来源里的工具名至少要是真的 ----
    print("\n③ 攻略文档与工具 docstring 里提到的 mc_* 至少必须真实注册")
    doc_sources: list[tuple[str, str]] = []
    for p in sorted((repo / "skills_docs").glob("*.md")):
        doc_sources.append((f"skills_docs/{p.name}", read_text(p)))
    for p in sorted(repo.glob("llm_tools_*.py")):
        doc_sources.append((p.name, read_text(p)))
    doc_bad: list[str] = []
    for name, text in doc_sources:
        for m in sorted(set(MENTION_RE.findall(text))):
            if m not in tools and m not in ("mc_version", "mc_persona_id"):
                doc_bad.append(f"{name} → {m}")
    if doc_bad:
        for b in doc_bad:
            print(f"  ❌ {b}")
            failures.append(f"文档/docstring 提到未注册的工具：{b}")
    else:
        print(f"  ✅ {len(doc_sources)} 个来源里提到的工具全部真实注册")

    # ---- 结果 ----
    print("\n=== 结果 ===")
    if failures:
        print(f"❌ {len(failures)} 个问题：")
        for f in failures:
            print(f"  ✗ {f}")
        print("\n  修法：要么把工具加进那条路径的工具集（EXCLUDED_TOOLS / PERCEPTION_TOOLS），")
        print("        要么把提示词里那句改成真实可用的工具。**提示词承诺了就必须给得出来。**")
        return 1
    print(f"✅ 通过：{len(tools)} 个工具、{total_mentions} 处提示词引用全部对得上")
    return 0


if __name__ == "__main__":
    sys.exit(main())
