"""**决策延迟审计**：量出"她每次停下来思考"到底花在哪。

用户反馈："每次停下来思考的时间太长了，动作也不够流畅"

## 为什么先量再改

"想得慢"有好几个可能的原因，改错地方等于白干：
  · 提示词太大 → 每次模型往返的首字延迟（TTFT）长
  · 步数太多 → 一次决策要过好几轮模型（MAX_STEPS 轮）
  · 工具表太大 → 62 个工具的 schema 每次都发一遍
  · 技能内部动作之间有等待（settle/走路/挖方块）

这个脚本把**能离线量的部分**量出来：各段提示词的字符数、工具数、
以及"一次决策最多要过几轮模型"。

（模型本身的响应时间量不了——那取决于 provider。但"发过去多少东西"
是决定 TTFT 的主要因素之一，而且是我们能控制的。）
"""

from __future__ import annotations

import re
import sys
import pathlib

_HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))
from _paths import ENGINE_DIR, REPO  # noqa: E402

# **仓库根就是插件本体**；Node 引擎在 <repo>/engine/。
# 历史脚本找的是不存在的 <repo>/plugin/ 和 <repo>/bot/——于是每段都量到 0 字符，
# 而脚本照样退出 0（"全 0 的成功"是最坏的失败模式，见 main() 末尾的兜底）。
ROOT = REPO
PLUGIN = REPO
BOT = ENGINE_DIR


def _read(p: pathlib.Path) -> str:
    try:
        return p.read_text(encoding="utf-8")
    except Exception:
        return ""


def section(name: str, chars: int, note: str = "") -> tuple[str, int]:
    print(f"  {name:<34} {chars:>7} 字符" + (f"   {note}" if note else ""))
    return name, chars


def main() -> int:
    print("=== ① 系统提示（每次往返都发，且理论上应该字节级稳定）===")
    total_sys = 0

    aa = _read(PLUGIN / "action_agent.py")
    m = re.search(r'ACTION_PROMPT = """(.*?)"""', aa, re.S)
    action_prompt = m.group(1) if m else ""
    action_prompt = action_prompt.replace("{{MAX_STEPS}}", "6")
    _, n = section("ACTION_PROMPT（操作规则）", len(action_prompt))
    total_sys += n

    # **兜底闸门**：量到 0 字符只能说明"这个审计脚本自己找错了地方"，
    # 绝不能当成"提示词很小、延迟很低"然后退出 0 通过。
    if not action_prompt:
        print(f"\n❌ 量不到 ACTION_PROMPT（在 {PLUGIN / 'action_agent.py'} 里没匹配到）。")
        print("   这是审计脚本自己坏了——0 字符的结论没有意义，退出非零而不是静默通过。")
        return 1

    # 人设/system prompt 来自插件配置，这里量不了；技能表能量
    skills_src = _read(BOT / "skills" / "index.js")
    skill_count = len(re.findall(r"^\s{2}[a-z_]+: \{", skills_src, re.M))
    section("技能注册表里的技能数", 0, f"{skill_count} 个技能")

    print("\n=== ② 用户提示（每次决策重新拼，每一轮往返都发一遍）===")
    total_user = 0
    life = _read(PLUGIN / "life.py")

    # 从 _act_via_agent 的 f-string 里数各段
    parts = [
        ("当前状态简报（brief）", "引擎返回，含背包/血量/附近方块"),
        ("插话（steer）", "主人的话 + 世界事件，有才发"),
        ("打算（intention）", "含 W5 加的累计进展"),
        ("任务清单（todos）", "她自己写的"),
        ("学到的经验（learned）", "知识库检索出来的几条"),
        ("近期经历（recent）", "最近 5 条 + 死亡提示"),
        ("生存建议（advice）", "生存顾问的输出"),
        ("心情（drives）", "驱动力建议"),
    ]
    for name, note in parts:
        # 这些是运行期才有的，离线量不到具体值；列出结构让人知道有几段
        section(name, 0, note + "（运行期）")

    print("\n=== ③ 工具表（62 个工具的 schema，每次往返都发）===")
    tool_files = sorted(PLUGIN.glob("llm_tools_*.py"))
    if not tool_files:
        print(f"\n❌ 一个 llm_tools_*.py 都没扫到（找的是 {PLUGIN}）——")
        print("   检查器自己坏了：工具表 0 字符不是「延迟很低」，退出非零而不是静默通过。")
        return 1

    total_tool_chars = 0
    total_tool_count = 0
    for p in tool_files:
        src = _read(p)
        # 数 docstring 的长度——schema 里 description 主要来自它
        docs = re.findall(r'"""(.*?)"""', src, re.S)
        n = sum(len(d) for d in docs)
        total_tool_chars += n
        count = len(re.findall(r"@filter.llm_tool", src))
        total_tool_count += count
        section(f"  {p.name}", n, f"{count} 个工具")

    if total_tool_count == 0:
        print(f"\n❌ 扫到了 {len(tool_files)} 个 llm_tools_*.py，但里面一个 @filter.llm_tool 都没有——")
        print("   检查器自己坏了（注册写法变了？），退出非零而不是静默通过。")
        return 1

    print("\n=== ④ 一次决策最多要过几轮模型 ===")
    m = re.search(r"^MAX_STEPS = (\d+)", aa, re.M)
    steps = int(m.group(1)) if m else 0
    print(f"  MAX_STEPS = {steps}  → 一次决策最多 {steps} 次模型往返")
    print("  （每轮往返的耗时取决于 provider；但**轮数 × 单轮耗时**就是她站着的时长）")

    print("\n=== ⑤ 技能内部的固定等待（量得到的部分）===")
    common = _read(BOT / "skills" / "common.js")
    # settle 的等待
    for label, pat in [
        ("settle 落地稳定（每个技能开头都调）", r"async function settle"),
        ("pillarUpOne 跳起等待", r"for \(let i = 0; i < 12"),
        ("climbToSurface 每级 goTo 超时", r"timeoutMs: 10000"),
    ]:
        found = bool(re.search(pat, common))
        print(f"  {'✅' if found else '—'} {label}")

    print("\n=== 小结 ===")
    print(f"  · 工具表 description 合计 {total_tool_chars} 字符（{total_tool_count} 个工具，每次往返都发）")
    print(f"  · ACTION_PROMPT {len(action_prompt)} 字符（每次往返都发，应该缓存命中）")
    print(f"  · 一次决策最多 {steps} 轮模型往返")
    print("  · 用户提示有 8 段（运行期拼），其中 brief/learned/advice 是可变的")
    print("\n  **最大的两个可优化点**：")
    print("    1. 轮数：一次决策 6 轮 × 单轮耗时 = 她站着的时长（能不能少几轮？）")
    print("    2. 工具表：62 个工具的 schema 每轮都发一遍（能不能按需给？）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
