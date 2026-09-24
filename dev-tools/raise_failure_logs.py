#!/usr/bin/env python3
"""把**失败路径**上的 `log.debug` / `logger.debug` 提到 `info` / `warning`。

    python dev-tools/raise_failure_logs.py --dry-run   # 只看会改什么
    python dev-tools/raise_failure_logs.py             # 真改

## 为什么

默认日志级别是 `info` —— `debug` 写的东西**用户看不到**。
在成功路径上这是好事（不刷屏），在失败路径上等于"出错了但没人知道为什么"。

实测的代价：
  · `pillarUpOne` 失败时说"没跳起来（可能头顶被挡）"，真因是"服务端拒绝放置"，
    那句话在 debug 里 → 我来回猜了好几轮
  · `life.py` 里一个 `AttributeError` 被静默吞掉 → "她不动了"，日志里一个字都没有

## 改哪一级：**统一用 `info`**

一开始我想"`except` 块里用 `warning`、其他用 `info`"，看了 dry-run 之后改了主意：

那一批里大多是**预期内的失败** —— "装备失败"/"看向失败"/"存入失败"…
一个经常失败的机器人，每次 `warning` 会很吵，**吵到最后就没人看了**。

**`info` 就够了**：默认级别可见（这是唯一的目的），但不刺眼。

**`warning` 留给规则 A**（`except: pass`）—— 那才是真的"异常被吞掉"，
值得报警。

  · **成功路径不动** —— 这个脚本只碰"文案里有失败字样"的那些

## 不动什么（白名单）

文案里带 `（忽略）` / `（不影响` / `（不致命` 的，以及心跳/轮询/进度回调 ——
这些是**高频且预期内**的，刷屏比看不见更糟。
判据和白名单都在 `check_log_levels.py` 里（单一来源，不重复维护）。

## 安全

  · 只改**日志级别**（`debug` → `info`/`warning`），**一个字都不动文案**
  · 支持 `--dry-run` 先看
  · 改完请跑 `python dev-tools/run_all.py`
"""

from __future__ import annotations

import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import check_log_levels as C  # noqa: E402

REPO = C.REPO


def main() -> int:
    dry = "--dry-run" in sys.argv
    rule_a, rule_b = C.scan()

    print(f"=== 规则 B：{len(rule_b)} 处要提级 ===")
    print(f"=== 规则 A：{len(rule_a)} 处 `except: pass`（这个脚本不动它们）===")
    print()

    if not rule_b:
        print("  ✅ 没有要改的")
        return 0

    # 按文件分组
    by_file: dict[str, list[tuple[int, str]]] = {}
    for rel, ln, text, _ in rule_b:
        by_file.setdefault(rel, []).append((ln, text))

    # 找出哪些在 except/catch 块里 → 用 warning，其余用 info
    changed = 0
    for rel, items in sorted(by_file.items()):
        p = REPO / rel
        if not p.exists():
            print(f"  ⚠️ 找不到 {rel}")
            continue
        src = p.read_text(encoding="utf-8")
        lines = src.split("\n")

        # 这个文件里哪些行在 except/catch 块里
        is_py = rel.endswith(".py")
        exc_re = C.EXC_PY if is_py else C.EXC_JS
        blocks = C._except_blocks(lines, exc_re)
        in_exc = set()
        for s, e in blocks:
            in_exc.update(range(s, e))

        for ln, text in sorted(items, reverse=True):
            idx = ln - 1
            if idx < 0 or idx >= len(lines):
                continue
            old = lines[idx]
            if "debug" not in old:
                continue
            # **统一用 info**（见文件头的说明：warning 太吵，吵到最后没人看）
            level = "info"
            new = old.replace(".debug(", f".{level}(", 1)
            if new == old:
                continue
            lines[idx] = new
            changed += 1
            if dry:
                print(f"  {rel}:{ln}")
                print(f"      - {old.strip()[:86]}")
                print(f"      + {new.strip()[:86]}")

        if not dry:
            p.write_text("\n".join(lines), encoding="utf-8")

    print()
    if dry:
        print(f"  （dry-run）会改 {changed} 处")
    else:
        print(f"  ✅ 改了 {changed} 处")
        print("  现在跑：python dev-tools/run_all.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
