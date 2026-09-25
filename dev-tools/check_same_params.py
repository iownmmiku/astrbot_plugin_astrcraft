#!/usr/bin/env python3
"""**检查「同类函数、同名参数、取值不一致」。**

    python dev-tools/check_same_params.py        # 有不一致 → exit 1

## 为什么加这个

`stairUpOne` 写的时候**抄丢了 `digStepUp` 的教训**：

    digStepUp:   nav.goTo({ ... range: 1.5 })   ← 0.6 放宽到 1.5 是实测换来的
    stairUpOne:  nav.goTo({ ... range: 1.2 })   ← 新写的，又回去了

症状：goTo 按 range 判「没走到」→ 抛异常 → 调用方 continue →
**根本走不到高度验证** → 表现成「垫了方块但上不去」，害我查了好几轮。
这类坑**靠「下次记得」防不住**（同一轮里我在 A 处学到、B 处又踩），
所以做成硬检查。

## 规则

**规则 A（家族一致性）**：名字带 `StepUp` / `UpOne` / `stepUp` 的函数
（爬升家族：`stepUpOne*` 三个 helper + 三个策略 Impl + 三个薄壳）里，
`range:` / `timeoutMs:` / `timeout:` **不许出现数字字面量** ——
必须用共享常量 `STEP_UP_RANGE` / `STEP_UP_TIMEOUT_MS`。
出现字面量 = 有人在某个策略里**又写了一份自己的值** = 重新分叉。

**规则 B（同名函数默认值）**：不同文件里定义了**同名函数**，
且同一个参数名的**数字默认值不同** → 报出来。
同名说明语义应当相同，默认值漂了就是隐患（maxSteps=24 vs 40 这种）。

**命中 → exit 1**（和 check_log_levels 一样是硬检查）。
"""

from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCAN_DIRS = ["engine"]
SKIP_DIRS = {"node_modules", ".testserver", ".git", "_out"}

# 规则 A：爬升家族
FAMILY = re.compile(r"StepUp|UpOne|stepUp")
RAW_PARAM = re.compile(r"\b(range|timeoutMs|timeout)\s*:\s*(-?\d+(?:\.\d+)?)\b")

# 规则 B：函数定义 + 数字默认参数
FUNC_DEF = re.compile(r"^(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)", re.M)
NUM_DEFAULT = re.compile(r"(\w+)\s*=\s*(-?\d+(?:\.\d+)?)\b")


def iter_js():
    for d in SCAN_DIRS:
        base = ROOT / d
        if not base.exists():
            continue
        for p in sorted(base.rglob("*.js")):
            if SKIP_DIRS & set(p.parts):
                continue
            yield p


def read_src(p: pathlib.Path) -> str:
    """**用 utf-8-sig 读** —— 踩过：PS 写的文件带 BOM，
    BOM 顶在第一行开头，`^function` 就匹配不上，
    **整个文件的函数一个都扫不到，而检查器还报「0 处」= 假绿**。"""
    try:
        return p.read_text(encoding="utf-8-sig", errors="replace")
    except OSError:
        return ""


# 家族下限：common.js 里至少有 stepUpOne / stepUpOnePrelude / stepUpOneGoTo /
# 三个 *Impl / 三个薄壳 —— 扫到的家族函数少于这个数，说明检查器自己瞎了
MIN_FAMILY = 5


def family_bodies(src: str):
    """按函数体切分：family 名字的函数，返回 (name, body)。"""
    out = []
    matches = list(FUNC_DEF.finditer(src))
    for i, m in enumerate(matches):
        name = m.group(1)
        if not FAMILY.search(name):
            continue
        end = matches[i + 1].start() if i + 1 < len(matches) else len(src)
        out.append((name, src[m.start():end]))
    return out


def main() -> int:
    fails: list[str] = []

    # ---- 规则 A ----
    family_seen = 0
    for p in iter_js():
        src = read_src(p)
        if not src:
            continue
        for name, body in family_bodies(src):
            family_seen += 1
            for m in RAW_PARAM.finditer(body):
                param, val = m.group(1), m.group(2)
                # 常量声明那行本身不算（STEP_UP_RANGE = 1.5 是定义处）
                line_start = body.rfind("\n", 0, m.start()) + 1
                line = body[line_start: body.find("\n", m.start())]
                if line.strip().startswith("const "):
                    continue
                lineno = src[: src.find(body[:40])].count("\n") + body[: max(m.start(), 0)].count("\n") + 1
                fails.append(
                    f"  规则A {p.relative_to(ROOT)}:{lineno} 函数 {name} 里 {param}: {val} 是**字面量** —— "
                    f"请用共享常量（range→STEP_UP_RANGE / timeoutMs→STEP_UP_TIMEOUT_MS）"
                )

    # ---- 规则 B ----
    defaults: dict[str, list[tuple[pathlib.Path, int, str, str]]] = {}
    for p in iter_js():
        src = read_src(p)
        if not src:
            continue
        for m in FUNC_DEF.finditer(src):
            name, params = m.group(1), m.group(2)
            lineno = src[: m.start()].count("\n") + 1
            for pm in NUM_DEFAULT.finditer(params):
                defaults.setdefault(name, []).append((p, lineno, pm.group(1), pm.group(2)))
    for name, entries in sorted(defaults.items()):
        by_param: dict[str, set[str]] = {}
        for _p, _ln, param, val in entries:
            by_param.setdefault(param, set()).add(val)
        for param, vals in by_param.items():
            if len(vals) > 1:
                where = "；".join(f"{p.name}:{ln}={v}" for p, ln, pa, v in entries if pa == param)
                fails.append(
                    f"  规则B 函数 {name} 的参数 {param} 默认值不一致：{'/'.join(sorted(vals))} —— {where}"
                )

    # **检查器的自我下限**：一个家族函数都没扫到 = 它自己瞎了（BOM/正则坏了），
    # 这时报「0 处」就是假绿 —— 必须失败，不许装通过。
    if family_seen < MIN_FAMILY:
        print(f"check_same_params: ❌ 只扫到 {family_seen} 个家族函数（下限 {MIN_FAMILY}）")
        print("  说明检查器自己没看到代码（BOM？路径？正则？）—— 这种情况不许报绿。")
        return 1

    if not fails:
        print(f"check_same_params: 0 处（家族 {family_seen} 个函数参数全走常量；同名函数默认值一致）")
        return 0
    print(f"check_same_params: {len(fails)} 处不一致：")
    for f in fails:
        print(f)
    print("  改法：同类函数共用一份常量/默认值，别各写各的（分叉过一次的坑不要再挖）。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
