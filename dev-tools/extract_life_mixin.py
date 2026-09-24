#!/usr/bin/env python3
"""把 `life.py` 里**只读的**方法搬进一个 mixin，缩小那个 2129 行的上帝文件。

> ## ⚠️ 当前状态：**还没成功，不要直接用**
>
> 方案是**对的**（mixin 不需要改调用点），dry-run 也漂亮
> （30 个方法 / 530 行 / 2129 → 约 1761 行），但**跑测试会红**。
>
> 已经修掉/发现的问题（都写在下面代码的注释里）：
>   1. **import 会漏** —— 手写补了 `time` 又漏 `Enum`。
>      改成 `std_imports()` **照抄 `life.py` 的 import 段**。✅ 已修
>   2. **`AnnAssign` 不是 `Assign`** —— `HOLD_RELEASE: dict["Hold", str] = {`
>      是带注解的赋值，只判断 `Assign` 会漏掉它，然后 ImportError。✅ 已修
>   3. **类 docstring 没闭合** —— 生成的 `PromptRenderMixin` 里那个
>      一行 docstring 把后面的 `def` 吞进字符串了，于是类体是空的、
>      `class LifeLoop(PromptRenderMixin)` 报
>      `AttributeError: 'function' object has no attribute '__mro__'`。
>      ❌ **还没修**
>
> **每次尝试都要跑一遍测试**（`test_life_rhythm` 是最敏感的那个），
> 不对就用 `git checkout -- life.py` 回滚（并删掉生成的两个文件）。


    python dev-tools/extract_life_mixin.py            # 真做
    python dev-tools/extract_life_mixin.py --dry-run  # 只看会搬什么

## 为什么用 mixin 而不是普通函数

这些方法都读 `self._xxx`。搬成普通函数的话，**每个调用点都要改**
（把状态当参数传进去）—— 几百处改动，风险远大于收益。

搬成 **mixin**：`class LifeLoop(PromptRenderMixin)` ——
方法还是方法，`self` 还是那个 `LifeLoop` 实例，**调用点一行都不用改**。

## 只搬"不改状态"的方法

判据：方法体里**没有 `self.xxx = ...` 赋值**（读多少都行）。
会改状态的（`decide` / `_loop` / `_act_via_agent`…）**不搬** ——
它们和状态绑得太紧，搬了就是真重构，风险和成本完全不同。

## 踩过的坑（写在这里免得重犯）

**缩进**：`life.py` 里的方法在 **4 空格**（`class LifeLoop:` 的类体），
新的 `PromptRenderMixin` 里**也是 4 空格** ——
所以**原样搬过去就行，不要加缩进**。
第一版我给每行加了 4 空格，结果方法变成 8 空格、语法直接错。

## 怎么保证没搬坏

1. AST 精确取源码切片（不是正则）
2. **搬之前确认它们真的不改状态**，有就中止
3. 搬完 `ast.parse` 验语法；不对就**整个回滚**
4. 跑测试（`run_all.py`）
"""

from __future__ import annotations

import ast
import pathlib
import re
import shutil
import sys

REPO = pathlib.Path(__file__).resolve().parents[1]
LIFE = REPO / "life.py"
OUT = REPO / "life_render.py"

# 要搬的方法：**读状态、产出文字或判断**这一类
# **顺便搬走的类型定义**。
#
# 为什么要单独一个文件：`life_render.py` 里的方法用到 `Hold` / `LifeDecision`，
# 而它们原来定义在 `life.py` —— 如果 `life_render` 反过来 import `life.py`，
# 就是**循环 import**（而且失败方式很隐蔽：`from __future__ import annotations`
# 会把注解里的 NameError 藏起来，看起来只是"循环莫名其妙不动了"）。
# 所以把它们放进一个**两边都能 import 的独立模块**。
TYPES_MOVE = ["LifeDecision", "Hold", "HOLD_RELEASE", "HOLD_WHY"]
TYPES_OUT = REPO / "life_types.py"

MOVE = [
    # 提示词渲染
    "_render_recent",
    "_render_progress_since",
    "render_todos",
    "todos",
    "failure_summary",
    "_failure_counts",
    # 状态说明（给 /mc状态 和提示词用）
    "current_hold",
    "hold_explain",
    "idle_explain",
    "describe",
    "paused",
    "running",
    # 输入队列的读取
    "inbox_summary",
    "_drain_steer_text",
    "_take_follow_up_text",
    "note_owner_said",
    "note_world_event",
    # 计划与技能的小判断
    "_skill_is_known",
    "_decision_from_step",
    "_pop_plan_step",
    "_death_recovery_todos",
    # 小工具
    "state_note",
    "_gather_state",
    "_engine_busy",
    "mark_todo_done",
    "_auto_resume_if_expired",
    "_schedule_lesson",
    "_fallback_decision",
    "_reconsider_if_looping",
    "_save_state",
]


def std_imports(src: str) -> str:
    """**照抄 `life.py` 的 import 段**（只取非相对的）。

    为什么这么做：手写 import 会一直漏 ——
    第一版漏了 `time`（`LifeDecision` 的 `default_factory=time.time`），
    补上之后又漏了 `Enum`（`Hold(Enum)`）。
    照抄就不会漏。

    **相对 import 要排除**（`from .xxx import ...`）—— 那些可能造成循环。
    """
    out = []
    for line in src.split("\n"):
        s = line.strip()
        if not s.startswith(("import ", "from ")):
            continue
        if s.startswith("from .") or s.startswith("from ."):
            continue  # 相对 import，排除
        if s.startswith("from __future__"):
            continue
        # 只保留标准库/第三方，不保留插件内部的绝对 import
        if s.startswith(("import ", "from ")) and "astrcraft" in s:
            continue
        out.append(s)
    # 去重保序
    seen = set()
    uniq = []
    for l in out:
        if l not in seen:
            seen.add(l)
            uniq.append(l)
    return "\n".join(uniq)


def collect(lines: list[str], loop: ast.ClassDef) -> dict[str, tuple[int, int, str]]:
    """取每个要搬的方法的源码切片（含装饰器和紧邻的注释）。"""
    found: dict[str, tuple[int, int, str]] = {}
    for n in loop.body:
        if not isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if n.name not in MOVE:
            continue
        start = n.lineno - 1
        for dec in getattr(n, "decorator_list", []):
            start = min(start, dec.lineno - 1)
        # 往上带上紧邻的注释（那些注释解释了"为什么"，必须一起搬）
        j = start - 1
        while j >= 0 and lines[j].strip().startswith("#"):
            # **遇到"分节横线"那种注释就停** —— 它是给整段看的，不属于某个方法
            if re.match(r"^\s*#\s*-{3,}", lines[j]):
                break
            start = j
            j -= 1
        found[n.name] = (start, n.end_lineno, "\n".join(lines[start : n.end_lineno]))
    return found


def main() -> int:
    dry = "--dry-run" in sys.argv
    if not LIFE.exists():
        print("  ❌ 找不到 life.py")
        return 1

    src = LIFE.read_text(encoding="utf-8")
    lines = src.split("\n")
    loop = next(
        (n for n in ast.parse(src).body if isinstance(n, ast.ClassDef) and n.name == "LifeLoop"),
        None,
    )
    if loop is None:
        print("  ❌ 找不到 class LifeLoop")
        return 1

    found = collect(lines, loop)
    missing = [m for m in MOVE if m not in found]
    if missing:
        print(f"  ⚠️ 没找到（跳过）：{missing}")
    if not found:
        print("  ❌ 一个都没找到")
        return 1

    total = sum(e - s for s, e, _ in found.values())
    print(f"  找到 {len(found)} 个方法，共 {total} 行")
    print(f"  life.py 现在 {len(lines)} 行 → 搬完约 {len(lines) - total} 行")
    print()

    # ---- 安全检查：确认真的不改状态 ----
    bad = [n for n, (_, _, t) in found.items() if re.search(r"self\.\w+\s*=[^=]", t)]
    if bad:
        print(f"  ❌ 这些会改状态，不能搬：{bad}")
        return 1
    print("  ✅ 都确认过：不改状态（没有 `self.xxx =` 赋值）")

    if dry:
        print()
        for name, (s, e, _) in sorted(found.items(), key=lambda kv: kv[1][0]):
            print(f"    {name:32} 行 {s + 1}-{e}")
        return 0

    # ---- 备份 ----
    bak = LIFE.with_suffix(".py.bak")
    shutil.copy2(LIFE, bak)

    STD = std_imports(src)
    print(f"  照抄 {len(STD.splitlines())} 行 import")

    # ---- 先搬类型定义到 life_types.py ----
    type_ranges = []
    type_texts = []
    for n in ast.parse(src).body:
        # **名字要在两个地方找**：
        #   · `class Hold:` / `class LifeDecision:` → `n.name`
        #   · `HOLD_RELEASE = {...}` → `n.targets[0].id`（Assign **没有** `.name`）
        #
        # 踩过：第一版把 Assign 的判断**嵌在** `getattr(n, "name", None) in TYPES_MOVE`
        # 里面 —— 而 Assign 没有 `.name`，那个条件永远是 False，
        # **于是两个 dict 一个都没搬到**，报"2 个定义"（应该是 4），
        # 然后 `from .life_types import HOLD_RELEASE` 直接 ImportError。
        names = []
        if isinstance(n, ast.ClassDef):
            names.append(n.name)
        elif isinstance(n, ast.Assign):
            # `X = {...}` —— 名字在 targets 里
            for tgt in n.targets:
                if isinstance(tgt, ast.Name):
                    names.append(tgt.id)
        elif isinstance(n, ast.AnnAssign):
            # **`X: dict[...] = {...}` —— 带注解的赋值是 AnnAssign，不是 Assign！**
            # 踩过：`HOLD_RELEASE: dict["Hold", str] = {` 就是这种，
            # 只判断 Assign 会漏掉它，然后 `from .life_types import HOLD_RELEASE` 直接 ImportError。
            if isinstance(n.target, ast.Name):
                names.append(n.target.id)
        if not any(nm in TYPES_MOVE for nm in names):
            continue
        s = n.lineno - 1
        j = s - 1
        while j >= 0 and lines[j].strip().startswith("#"):
            s = j
            j -= 1
        type_ranges.append((s, n.end_lineno))
        type_texts.append("\n".join(lines[s:n.end_lineno]))

    types_out = f'''"""**`life.py` 里的类型定义**（搬出来避免循环 import）。

`Hold` / `HOLD_RELEASE` / `HOLD_WHY` / `LifeDecision` 这几个名字，
`life.py` 和 `life_render.py` **都要用**。

放在 `life.py` 里的话，`life_render.py` 就得反过来 import `life.py` ——
**循环 import**。而且失败方式很隐蔽：`from __future__ import annotations`
会把注解里的 `NameError` 藏起来，看起来只是"循环莫名其妙不动了"。

所以放进这个独立模块，两边都从这里 import。
"""

from __future__ import annotations

{STD}

{chr(10).join(t.rstrip() for t in type_texts)}
'''
    TYPES_OUT.write_text(types_out, encoding="utf-8")
    print(f"  已生成 life_types.py（{len(type_texts)} 个定义）")

    # ---- 生成 mixin ----
    # **原样搬，不加缩进** —— 两边都是类体、都是 4 空格（踩过这个坑）
    body = "\n\n".join(text.rstrip() for _, _, text in found.values())
    header = f'''"""**`LifeLoop` 的只读渲染/查询方法**（从 `life.py` 搬出来的）。

## 为什么单独一个文件

`life.py` 原本 2129 行、65 个方法 —— 找东西要搜半天。
但**不能随便拆**：最大的几个方法（`decide` 256 行 / `_loop` 251 行 /
`_act_via_agent` 140 行）**都改状态**，和 `self` 绑得太紧。

所以这里只搬**不改状态**的那一类：**读状态、产出文字或判断**。
它们靠 mixin 注入 —— `class LifeLoop(PromptRenderMixin)` ——
所以**调用点一行都没改**，`self` 还是那个 `LifeLoop` 实例。

## 判据（往这里加方法前先看）

**可以搬**：方法体里没有 `self.xxx = ...` 赋值。
**不要搬**：会改状态的。那需要连状态一起搬，是真正的重构。

搬法是 `dev-tools/extract_life_mixin.py`（判据也写在那里面）。

## 这一批搬了什么

{chr(10).join("- `" + n + "`" for n in found)}
"""

from __future__ import annotations

{STD}

from .inbox import Inbox
from .life_types import HOLD_RELEASE, HOLD_WHY, Hold, LifeDecision


class PromptRenderMixin:
    """只读的渲染/查询方法。靠 mixin 注入 `LifeLoop`，所以调用点不用改。"""

{body}
'''
    OUT.write_text(header, encoding="utf-8")

    # ---- 从 life.py 删掉这些方法（从后往前，避免行号偏移）----
    ranges = sorted((s, e) for s, e, _ in found.values())
    merged: list[list[int]] = []
    for s, e in ranges:
        if merged and s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    # 类型定义的区间也要一起删
    all_ranges = merged + [list(r) for r in type_ranges]
    all_ranges.sort()
    merged2: list[list[int]] = []
    for s, e in all_ranges:
        if merged2 and s <= merged2[-1][1]:
            merged2[-1][1] = max(merged2[-1][1], e)
        else:
            merged2.append([s, e])
    new_lines = list(lines)
    for s, e in reversed(merged2):
        del new_lines[s:e]
    new_src = "\n".join(new_lines)

    # ---- 让 LifeLoop 继承 mixin + 加 import ----
    new_src = new_src.replace("class LifeLoop:", "class LifeLoop(PromptRenderMixin):", 1)
    # life.py 原来自己定义了那些类型，现在要从 life_types 拿回来
    if "from .life_types import" not in new_src:
        ends2 = [m.end() for m in re.finditer(r"^from \.[\w.]+ import .*$", new_src, re.M)]
        if ends2:
            new_src = (
                new_src[: ends2[-1]]
                + "\nfrom .life_types import HOLD_RELEASE, HOLD_WHY, Hold, LifeDecision"
                + new_src[ends2[-1] :]
            )
    if "from .life_render import PromptRenderMixin" not in new_src:
        ends = [m.end() for m in re.finditer(r"^from \.[\w.]+ import .*$", new_src, re.M)]
        if ends:
            idx = ends[-1]
            new_src = new_src[:idx] + "\nfrom .life_render import PromptRenderMixin" + new_src[idx:]
        else:
            print("  ⚠️ 找不到相对 import 的位置")

    # ---- 验语法，不对就回滚 ----
    try:
        ast.parse(new_src)
        ast.parse(header)
    except SyntaxError as e:
        print(f"  ❌ 语法错误（第 {e.lineno} 行）：{(e.text or '').strip()[:70]}")
        print("  正在回滚…")
        shutil.copy2(bak, LIFE)
        OUT.unlink(missing_ok=True)
        return 1

    LIFE.write_text(new_src, encoding="utf-8")
    bak.unlink(missing_ok=True)

    print("  ✅ 语法通过")
    print(f"  life.py:        {len(lines)} 行 → {len(new_lines)} 行（少了 {len(lines) - len(new_lines)}）")
    print(f"  life_render.py: {len(header.splitlines())} 行")
    return 0


if __name__ == "__main__":
    sys.exit(main())
