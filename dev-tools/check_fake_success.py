#!/usr/bin/env python3
"""**粗筛「假成功」的高危写法：调了动作不判返回值 / 无条件报成功。**

    python dev-tools/check_fake_success.py            # 有未复核的候选 → exit 1
    python dev-tools/check_fake_success.py --list     # 只列清单，不判退出码

## 为什么加这个

「假成功」是这个项目**反复出现的病类**，一轮里人工撞见 3 次：
`makePlanks` 无条件 true（实测 5 原木只出 3 木板还报成功）、
`make_tools` 内部失败报 done、`_runPath` 的 `arrived` 硬编码。
**共同点：判据是「调用没抛异常 / 循环跑完了」，不是「目标状态真的变了」。**

## 判据（粗筛，不是定罪）

  规则 A：`await actions.craft/placeBlock/equip(...)` 作为整条语句、返回值没人接
  规则 B：`skillResult(true, ...)` 字面量 true

**命中不等于有 bug，是「要人看一眼」。**
复核过的进 EXEMPT（**每条写明为什么没事**）；没复核的 → exit 1。

## EXEMPT 的匹配方式（改过两版，记下原因）

第一版键 = `文件 + 归一化(该行)`：**多行写法 `return skillResult(true, {`
在 index.js 里 7 处完全相同** —— 一个豁免把 7 处全放过（键撞车 = 豁免失效）。
第二版键带上一行：仍有 wood.js 两处同形返回的问题。
**现在用「子串匹配 + 可选排除词」**：每条豁免给一个**只在目标那处出现的**
特征子串（多行返回就取它 `note:` 里的独特文本），可选排除词表示
「块内**不许**含某词」（wood.js 两处同形返回就靠「有没有『新增木棍』」区分）。

## 诚实约束

**不许把没看过的嫌疑塞进 EXEMPT。** 每条理由都要能说出
「为什么这里不判返回值」或「true 是在哪判出来的」。
以下 22 条是**逐条读了上下文/契约**后写的（含 actions.craft 的
`{ok: produced>0}` 契约、deposit 的「失败必抛」契约、各函数的 false 分支条件）。
"""

from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCAN_DIRS = ["engine"]
ACTION_CALL = re.compile(r"await\s+actions\.(craft|placeBlock|equip)\s*\(")
RESULT_TRUE = re.compile(r"skillResult\(\s*true")
KEEP = 92

# (规则, 文件名, 块内须含子串, 块内须不含子串或空) → 复核理由
# 「块」= 命中行 + 其后 3 行（多行 skillResult 的 note/param 都在这个范围里）
EXEMPT: dict[tuple[str, str, str, str], str] = {
    # ============ 规则 A：动作返回值没人接（2 条，都是「故意不接、用状态判」的正例） ============
    ("A", "building.js", "item: 'chest', count: 1", ""):
        "下一行 chestCount=countItem('chest') 验产出、steps.ok=chestCount>0 —— 判据是实际状态，故意不接返回值",
    ("A", "building.js", "_bed`", ""):
        "下一行 bed=BEDS.find(countItem>0) 验产出、steps.ok=!!bed —— 同上，状态判据",

    # ============ 规则 B：skillResult(true)（20 条） ============
    ("B", "building.js", "庇护所建好了", ""):
        "逐项失败在前面各自 return false / 记入 out.skipped；extras 由 door/chest/bed 的实际状态拼出 —— note 如实列「有什么」",

    ("B", "gathering.js", "背包里已经有", ""):
        "上 3 行 if (already >= target) 才 return —— countItem 实数 >= 目标",
    ("B", "gathering.js", "已有 ${already} 个 ${want}", ""):
        "死分支：planFor 从不返回 type=have（只有 chop/mine/craft/smelt/hunt/mine_any/unknown）—— unreachable，不是谎报（可顺手删）",
    ("B", "gathering.js", "[item]: r.produced", ""):
        "上一块是本轮加的 if (!r.ok) return false —— craft 静默不产出（ok:false）时到不了这",
    ("B", "gathering.js", "已把 ${r.total} 个物品存进箱子", ""):
        "deposit 契约：失败必抛（catch→false）；actions.js:1965 只有 return {ok:true,stored,total} —— note/consumed 是它报的真实数字（存 0 个也如实写 0）",
    ("B", "gathering.js", "已经有 ${cookedHave} 份熟食", ""):
        "上一行 cookedHave=countItem 求和后 >= count 才 return",

    ("B", "index.js", "她已经在地面上了", ""):
        "上一行 if (res && res.already && !steppedOut) —— res.already 是爬升循环报的实况",
    ("B", "index.js", "爬出来了（挖了/垫了", ""):
        "上一块 if (!res || !res.ok) return false —— climbToSurface 按高度判 ok，true 只在它之后",
    ("B", "index.js", "别去了：掉落物已经过了", ""):
        "劝退分支：note 写明「别去了」、extra.went=false —— 如实说明没去，不是谎报捡到",
    ("B", "index.js", "别去了：距离约", ""):
        "劝退分支（eta 走不到）：同上，went:false、距离/耗时都写明",
    ("B", "index.js", "走到了，但地上已经没有掉落物了", ""):
        "gained:{} + arrived:true 如实说明「走到了但没捡到」",
    ("B", "index.js", "捡回来了：", ""):
        "produced=got 来自实际拾取计数（空集合走上一条「走到了但没捡到」分支）",
    ("B", "index.js", "补给完成", ""):
        "produced 的每个数字都来自已验证的子流程：makeTools 自验产出、火把本轮加了 if (!torchR8.ok) 判据",
    ("B", "index.js", "action: 'interact'", ""):
        "actions.interactEntity 失败必抛 ActionError（无目标/距离>3/中断，actions.js:1830）—— true 只在正常返回后；note 是真实结果",
    ("B", "index.js", "action: 'shield'", ""):
        "actions.raiseShield 失败必抛（没盾 MissingItemError / 失败 ActionError，actions.js:1498,1507）；成功才 return {ok:true}",

    ("B", "traverse.js", "垫高了 ${done} 格", ""):
        "上一块 if (!done) return false —— true 要求真垫上去至少 1 格",
    ("B", "traverse.js", "往前铺了", ""):
        "上一块 if (!done && !walked) return false —— 有进展才 true；note 区分「铺了 N 格」和「地面本来就是实的」",
    ("B", "traverse.js", "挖通了 ${dug.length}", ""):
        "上一块 if (!dug.length) return false —— 真挖了才 true；note 带 dug.length 和 arrived",

    ("B", "wood.js", "positiveOnly(diffOf(before, actions.inventoryMap()))", "!新增木棍"):
        "makePlanks：上面 gained < want 的分支已先 return —— true 只在 gained >= want 到达（上上轮 makePlanks 修复的判据）",
    ("B", "wood.js", "新增木棍", ""):
        "makeSticks：上一块是本轮加的 if (finalGained <= 0) return false —— 和 catch 分支同一标准 gained>0",
}


def norm_line(s: str) -> str:
    return re.sub(r"\s+", " ", s.strip())


def iter_js():
    for d in SCAN_DIRS:
        base = ROOT / d
        if not base.exists():
            continue
        for p in sorted(base.rglob("*.js")):
            if "node_modules" in p.parts:
                continue
            yield p


def collect():
    """→ (规则A候选, 规则B候选)，候选 = (rule, path, no, 该行, 块内后3行)。"""
    rule_a, rule_b = [], []
    for p in iter_js():
        try:
            lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for no, line in enumerate(lines, 1):
            stripped = line.strip()
            if stripped.startswith("//") or stripped.startswith("*"):
                continue
            block = [lines[j] for j in range(no - 1, min(no + 3, len(lines)))]
            if ACTION_CALL.search(line):
                prefix = line.split("await", 1)[0]
                if "=" not in prefix:
                    rule_a.append(("A", p, no, stripped, block))
            if RESULT_TRUE.search(line):
                rule_b.append(("B", p, no, stripped, block))
    return rule_a, rule_b


def find_exempt(cand) -> str | None:
    rule, p, no, stripped, block = cand
    joined = "\n".join(block)
    for (r, fname, must, must_not), reason in EXEMPT.items():
        if r != rule or p.name != fname:
            continue
        if must not in joined:
            continue
        if must_not and must_not in joined:
            continue
        return reason
    return None


def main() -> int:
    list_only = "--list" in sys.argv
    rule_a, rule_b = collect()

    def report(items, label):
        if not items:
            return []
        unreviewed = []
        for c in items:
            reason = find_exempt(c)
            rule, p, no, stripped, _block = c
            if reason is None:
                unreviewed.append(c)
            elif list_only:
                print(f"    [已复核] {p.relative_to(ROOT)}:{no}: {stripped[:KEEP]}")
        if unreviewed:
            print(f"  {label} —— 没复核过的 {len(unreviewed)} 处：")
            for _r, p, no, stripped, _b in unreviewed:
                print(f"    {p.relative_to(ROOT)}:{no}: {stripped[:KEEP]}")
        return unreviewed

    print(f"check_fake_success: 规则A={len(rule_a)} 处，规则B={len(rule_b)} 处（EXEMPT {len(EXEMPT)} 条）")
    ua = report(rule_a, "规则 A（动作返回值没人接）")
    ub = report(rule_b, "规则 B（skillResult(true)）")

    if list_only:
        print("  （--list：只列清单，不判退出码）")
        return 0
    if not ua and not ub:
        print("  全部候选都复核过（EXEMPT 每条都有理由）")
        return 0
    total = len(ua) + len(ub)
    print(f"  ❌ {total} 处候选**还没人看过** —— 逐个核对：真 bug 就修，没事的进 EXEMPT 并写明理由")
    return 1


if __name__ == "__main__":
    sys.exit(main())
