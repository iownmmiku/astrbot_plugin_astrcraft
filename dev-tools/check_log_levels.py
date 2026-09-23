#!/usr/bin/env python3
"""**失败路径不该用 debug 级日志。**

## 为什么需要这条检查

默认日志级别是 `info` —— 所以 `log.debug` / `logger.debug` 写的东西
**用户根本看不到**。

这在成功路径上是好事（不刷屏），但在**失败路径上是灾难**：
等于"出错了，但没人知道为什么"。

实测的代价（这个检查器就是被它逼出来的）：
  · `pillarUpOne` 失败时打的是 `debug`："没跳起来（可能头顶被挡）"，
    而**真因是"服务端拒绝放置，因为她已经落回那一格了"**。
    我为此来回猜了好几轮，直到把它提成 `info` —— **一次就定位了**。
  · `life.py` 里 `except Exception: logger.debug("XX失败")` 吞掉了一个
    `AttributeError`，表现是"她不动了"，**日志里一个字都没有**。

## 判据（两条，规则写在这里而不是靠人记）

**规则 A**：`except` 块里**只有 `pass`**（连注释都没有）—— 最明确的"静默吞掉"。
   —— 出了问题**日志里一个字都没有**。实测踩过：`life.py` 里一个
   `AttributeError` 被这样吞掉，表现是"她不动了"，查了很久。

**规则 B**：失败原因记了，但级别是 `debug`（默认看不见）。
   —— 比 A 好（至少写了），但用户依然看不到。建议提到 `info`/`warning`。
   这一档**不算失败** —— 否则一次报 100 多条，就没人会看了。

## 白名单：什么样的失败**可以**用 debug

**高频且预期内**的失败不该刷屏。符合下面任一条件的**豁免**：

  · 文案里有 `（忽略）` / `（不影响` / `（不致命` —— 作者已明确标注"不致命"
  · 心跳 / 轮询 / 进度回调 —— 每秒都可能触发
  · 纯"回退到备选方案"且备选方案会成功（比如"整段寻路失败，改为分段推进"）

**注意白名单是"文案约定"而不是"文件清单"** ——
所以新增代码只要照这个约定写（标注"忽略/不影响"），就不会被误报。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _paths  # noqa: E402

REPO = _paths.REPO
ENGINE = _paths.ENGINE_DIR

FAIL_WORDS = r"失败|错误|拒绝|放弃|不能|无法|不成功|没成|超时|异常|中断|坏了|卡住|找不到|没找到"

# ---- 白名单：文案里带这些标记的失败，允许留在 debug ----
# 这是"作者明确说过它不致命"的约定。
BENIGN_MARKERS = [
    "（忽略）",
    "(忽略)",
    "（不影响",
    "(不影响",
    "（不致命",
    "(不致命)",
]

# ---- 白名单：这些是高频率的，本来就该 debug ----
# 按"日志文案里出现的关键词"匹配，不按文件 —— 这样新代码也能照约定豁免。
HIGH_FREQ = [
    "心跳",
    "轮询",
    "进度回调",
    "回显工具调用",
    "记录用量",
    "设置移动状态",
    "设置怪物规避",
    "设置心情",
    "窗口状态同步",
    "放下光标物品",
    "清理合成格",
    "关窗收敛",
    "等背包更新",
]

JS_CALL = re.compile(r"^\s*log\.debug\(")
PY_CALL = re.compile(r"^\s*logger\.debug\(")
EXC_JS = re.compile(r"catch\s*\(")
EXC_PY = re.compile(r"^\s*except\b")


def is_benign(line: str) -> bool:
    if any(m in line for m in BENIGN_MARKERS):
        return True
    return any(k in line for k in HIGH_FREQ)


def _except_blocks(lines: list[str], exc_re) -> list[tuple[int, int]]:
    """找出所有 except/catch 块的行号范围（起, 止）。"""
    out = []
    for i, line in enumerate(lines):
        if not exc_re.search(line):
            continue
        indent = len(line) - len(line.lstrip())
        # 往下找到第一个"缩进 <= 当前"的非空行，就是块尾
        j = i + 1
        end = len(lines)
        while j < len(lines):
            s = lines[j]
            if s.strip() and (len(s) - len(s.lstrip())) <= indent:
                end = j
                break
            j += 1
        out.append((i, end))
    return out


def scan() -> tuple[list[tuple], list[tuple]]:
    """返回 (规则A违规=真静默, 规则B违规=记了但级别低)。"""
    rule_a, rule_b = [], []

    def scan_file(p: Path, call_re, exc_re, is_py: bool):
        try:
            lines = p.read_text(encoding="utf-8", errors="ignore").splitlines()
        except OSError:
            return
        rel = p.relative_to(REPO).as_posix()

        # ---- 规则 A：except 块里没有任何日志 ----
        for start, end in _except_blocks(lines, exc_re):
            body = lines[start + 1 : end]
            # 块里有没有任何日志调用
            has_log = any(
                ("logger." in s or "log." in s)
                and any(lv in s for lv in (".debug", ".info", ".warning", ".warn", ".error"))
                for s in body
            )
            if has_log:
                continue
            # **只认"块体就是 pass"** —— 这是唯一无歧义的"静默吞掉"。
            #
            # 为什么收得这么窄：第一版把"块里没有日志"都算上，报了 169 处，
            # 但里面大量是**误报**：
            #   · `except TypeError: return handler` —— 类型检查回退，不是吞错
            #   · `except: brief = "（状态读取失败）"` —— **失败已经写进字符串了**，
            #     调用方看得到，不算静默
            # 静态判断"是不是静默"取决于调用方怎么用，很难做对。
            # 所以只抓最明确的一种：**吞了、什么都没做**。
            meaningful = [
                s.strip()
                for s in body
                if s.strip() and not s.strip().startswith(("#", "//"))
            ]
            if meaningful != ["pass"]:
                continue
            # 但如果上面有注释解释了"为什么可以吞"，就放过（作者想过这件事了）
            has_reason = any(
                s.strip().startswith(("#", "//"))
                for s in lines[max(0, start - 3) : end]
            )
            if has_reason:
                continue
            rule_a.append((rel, start + 1, "except 块里只有 pass，连注释都没写", ""))

        # ---- 规则 B：except 块里记了但级别是 debug ----
        for start, end in _except_blocks(lines, exc_re):
            for k in range(start + 1, end):
                line = lines[k]
                if call_re.match(line) and re.search(FAIL_WORDS, line) and not is_benign(line):
                    rule_b.append((rel, k + 1, line.strip(), ""))

        # ---- 规则 B 之二：非 except 块里的"XX失败"用 debug ----
        in_block = set()
        for start, end in _except_blocks(lines, exc_re):
            in_block.update(range(start, end))
        for i, line in enumerate(lines):
            if i in in_block:
                continue
            if not call_re.match(line) or not re.search(FAIL_WORDS, line):
                continue
            if is_benign(line):
                continue
            rule_b.append((rel, i + 1, line.strip(), ""))

    for p in sorted(REPO.glob("*.py")):
        scan_file(p, PY_CALL, EXC_PY, True)
    for p in sorted(ENGINE.rglob("*.js")):
        if "node_modules" in p.parts:
            continue
        scan_file(p, JS_CALL, EXC_JS, False)

    # 去重（同一行可能被两条规则各抓一次）
    seen = set()
    uniq_b = []
    for item in rule_b:
        key = (item[0], item[1])
        if key in seen:
            continue
        seen.add(key)
        uniq_b.append(item)
    return rule_a, uniq_b


def main() -> int:
    _paths.ensure_utf8_stdout()
    print("=== 失败路径的日志级别检查 ===")
    print()
    print("默认日志级别是 info —— log.debug / logger.debug 写的东西用户看不到。")
    print("失败路径用 debug = 「出错了，但没人知道为什么」。")
    print()

    rule_a, rule_b = scan()

    if rule_a:
        print(f"⚠️  规则 A：{len(rule_a)} 处 —— except 块里只有 pass（吞了、什么都没做）")
        print("   出了问题日志里一个字都没有。要么加日志，要么写一行注释说明为什么可以吞。")
        print()
        for rel, ln, text, _ in rule_a:
            print(f"   {rel}:{ln}")
            print(f"       {text[:92]}")
        print()
    else:
        print("✅ 规则 A：没有 except/catch 块用 debug 记失败")
        print()

    if rule_b:
        print(f"ℹ️  规则 B：{len(rule_b)} 处 —— 失败原因记了，但级别是 debug（默认看不见）")
        print("   比 A 好（至少写了），但默认级别看不见。建议逐步提到 info。")
        print()
        # 按文件分组，只列前几个，避免刷屏
        by_file: dict[str, list] = {}
        for rel, ln, text, _ in rule_b:
            by_file.setdefault(rel, []).append((ln, text))
        for rel, items in sorted(by_file.items(), key=lambda kv: -len(kv[1])):
            print(f"   {rel}  （{len(items)} 处）")
            for ln, text in items[:2]:
                print(f"       :{ln}  {text[:84]}")
            if len(items) > 2:
                print(f"       …还有 {len(items) - 2} 处")
        print()
    else:
        print("✅ 规则 B：没有失败原因被写成 debug")
        print()

    print("=" * 60)
    # **两条规则都不让脚本失败** —— 这是个"提示性检查"，不是门禁。
    #
    # 为什么不让它红：规则 B 有 100 多处，一次报 100 条红的，
    # 结果就是**没人会看这个检查器** —— 那还不如不写。
    # 它的价值在于"跑 run_all 时提醒你还有多少处没提级别"，
    # 以及"新写的代码别再这样"。
    if rule_a:
        print(f"⚠️  {len(rule_a)} 处静默吞掉（规则 A）—— 建议加上日志或写明为什么可以吞")
    if rule_b:
        print(f"ℹ️  {len(rule_b)} 处失败原因用了 debug（规则 B）—— 建议逐步提到 info")
    if not rule_a and not rule_b:
        print("✅ 没有发现")
    return 0


if __name__ == "__main__":
    sys.exit(main())
