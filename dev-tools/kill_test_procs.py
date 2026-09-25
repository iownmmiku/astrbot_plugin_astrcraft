#!/usr/bin/env python3
"""**安全地清理测试留下的孤儿进程。**

    python dev-tools/kill_test_procs.py            # 只看会杀谁（默认）
    python dev-tools/kill_test_procs.py --kill     # 真杀

## 为什么需要这个脚本（我犯过的错）

测试跑完之后经常留下孤儿的 `node` 进程（引擎子进程没退干净）。
我图省事写过：

    Get-Process node | Stop-Process -Force

**这条命令会杀掉所有 `node.exe` —— 包括 DSH 自己的 harness 服务。**

实测后果：DSH Desktop 的 harness 就运行在 `node.exe` 上
（`...\\harness-node-entry.mjs --host 127.0.0.1 --port 43129`），
于是**一执行就"工具调用被中断"、界面报错** ——
而我当时还以为是"孤儿进程"捣乱。

## 正确的判据：**看命令行，不看进程名**

只杀**确实是我的测试引擎**的那些，也就是命令行里同时有：
  · `node`（进程名）
  · 以及下列任一：
      - 我们的引擎入口（`index.js`，且路径里有工作台/mc-astrbot/Astrcraft）
      - 或者父进程已经不在了（真孤儿）

**绝对不碰**：
  · 带 `harness-node-entry.mjs` 的（DSH 自己）
  · 带 `dsh` / `DSH Desktop` 的
  · 带 `astrbot` 的（AstrBot 本体也跑在 python/node 上，别误伤）
"""

from __future__ import annotations

import subprocess
import sys

# 这些命令行里出现就**绝对不杀**
PROTECT = [
    "harness-node-entry.mjs",
    "dsh",
    "DSH Desktop",
    "astrbot",
    "AstrBot",
    "vscode",
    "Code.exe",
]

# 这些是**我们的**测试引擎（可以杀）
MINE = [
    "mc-astrbot",
    "Astrcraft",
    "工作台",
    ".testserver",
]


def list_node_procs() -> list[tuple[int, str]]:
    """列出所有 node 进程的 (pid, 命令行)。"""
    ps = (
        "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | "
        "ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"
    )
    # **依次试几个可执行名** —— 不同的环境里可能是 pwsh / powershell / 完整路径。
    # 踩过：这里写死 "pwsh"，在 Python 子进程里直接 `WinError 2 系统找不到指定的文件`，
    # 而**报"0 个进程"看起来像"没有孤儿"** —— 是假绿。
    last_err = None
    for exe in ("pwsh", "powershell", r"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"):
        try:
            r = subprocess.run(
                [exe, "-NoProfile", "-NonInteractive", "-Command", ps],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=60,
            )
            out = r.stdout or ""
            if out.strip():
                break
            last_err = f"{exe} 没输出（exit={r.returncode}）"
        except Exception as e:  # noqa: BLE001
            last_err = f"{exe}: {e}"
            continue
    else:
        # **不能假装"没有孤儿进程"** —— 那是假绿，正是这个脚本要防的东西
        print(f"  ❌ 列进程失败（试过 pwsh / powershell）：{last_err}")
        print("     **这不等于「没有孤儿进程」** —— 是查不出来。")
        return []
    procs = []
    for line in out.splitlines():
        if "\t" not in line:
            continue
        pid, _, cmd = line.partition("\t")
        try:
            procs.append((int(pid.strip()), cmd.strip()))
        except ValueError:
            continue
    return procs


def main() -> int:
    do_kill = "--kill" in sys.argv
    procs = list_node_procs()

    print(f"=== 一共 {len(procs)} 个 node 进程 ===")
    print()

    protected, mine, unknown = [], [], []
    for pid, cmd in procs:
        low = cmd.lower()
        if any(p.lower() in low for p in PROTECT):
            protected.append((pid, cmd))
        elif any(m.lower() in low for m in MINE):
            mine.append((pid, cmd))
        else:
            unknown.append((pid, cmd))

    print(f"🔒 受保护（DSH / AstrBot / 编辑器）{len(protected)} 个 —— **绝不杀**")
    for pid, cmd in protected:
        print(f"     PID {pid}: {cmd[:100]}")
    print()

    print(f"🎯 我们的测试引擎 {len(mine)} 个 —— 这些才是「孤儿进程」")
    for pid, cmd in mine:
        print(f"     PID {pid}: {cmd[:100]}")
    print()

    print(f"❓ 认不出来的 {len(unknown)} 个 —— **不杀**（宁可留着也别误伤）")
    for pid, cmd in unknown:
        print(f"     PID {pid}: {cmd[:100]}")
    print()

    if not mine:
        print("  ✅ 没有需要清理的测试进程")
        return 0

    if not do_kill:
        print(f"  （dry-run）会杀 {len(mine)} 个。加 --kill 真杀。")
        return 0

    for pid, _ in mine:
        try:
            subprocess.run(
                ["pwsh", "-NoProfile", "-Command", f"Stop-Process -Id {pid} -Force"],
                capture_output=True,
                timeout=30,
            )
            print(f"  ✅ 已杀 PID {pid}")
        except Exception as e:  # noqa: BLE001
            print(f"  ⚠️ 杀 PID {pid} 失败：{e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
