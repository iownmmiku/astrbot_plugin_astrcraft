#!/usr/bin/env python3
"""**一条命令跑全部检查。**

## 为什么需要这个

仓库中的 `check_*` / `test_*` 脚本包括 Python 与 JavaScript 检查。
在加这个脚本之前，"我的改动是对的吗？"这个问题**没有便宜的答案**：
你得自己知道该跑哪几个、哪些需要测试服、哪些本来就会偶发红。

后果是新人（以及半年后的作者）大概率**改完就提交**。

## 用法

    python dev-tools/run_all.py              # 只跑不需要服务器的（通常数分钟）
    python dev-tools/run_all.py --full       # 全跑（需要测试服在 25566）
    python dev-tools/run_all.py --only life  # 只跑名字里带 life 的
    python dev-tools/run_all.py -v           # 把每个脚本的输出也打出来

## 三个设计（缺一不可）

**① 自己分类，不写死清单。**
   扫脚本内容里有没有 `Rcon.fromDir` / `call('connect')` 之类的标记，
   自动判定"要不要服务器"。**新增测试不用改这个脚本** ——
   写死清单的话，加一个测试就得记得来改这里，迟早会忘。

**② 明确说"跳过了什么"。**
   默认运行时，需要服务器的脚本会被跳过。**"跳过了"必须打出来**，
   否则"全绿"是假的 —— 你只是没测那些而已。

**③ 展示历史偶发记录，但所有失败都报红。**
   `test_survival_chain` 首次运行常 2/3（冷启动，区块没就绪），重跑即好。
   记录给排查提供线索；同一脚本也可能出现新问题，不能凭名字把失败算成通过。
"""

from __future__ import annotations

import argparse
import os
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

# **输出编码自愈** —— 踩过：控制台是 GBK 时（尤其**忘了设 PYTHONIOENCODING**），
# 打印 ⏭️/✅ 这类字符直接 `UnicodeEncodeError`，**整个 run_all 当场崩**，
# 看起来像测试全炸、其实一个测试都还没跑。做成自愈而不是依赖调用方的环境变量。
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001 —— 自愈失败就退回原行为，不挡主流程
        pass

REPO = Path(__file__).resolve().parents[1]
DEV = REPO / "dev-tools"

# ---------------------------------------------------------------- 配置

# 有历史偶发失败记录的脚本；这些记录只用于展示，不影响最终退出码。
# 加进来的条件：你自己复现过"重跑就好"，并且知道原因。
KNOWN_FLAKY = {
    "test_survival_chain.js": "历史记录：旧合成流程偶发失败；当前逐次确认服务端窗口，任何失败仍须排查",
    "minetest.js": "历史记录：曾因越过世界高度和 GUI 放置锚点失败；再次出现按真实失败处理",
}

# **需要服务器/引擎**的判据。用正则扫脚本内容，不写死清单。
SERVER_MARKERS = [
    r"Rcon\.fromDir",
    r"""call\(\s*['"]connect['"]""",
    r"""spawn\(\s*process\.execPath""",  # 起引擎子进程
]

# 默认的测试服地址（和 dev-tools/README.md 里写的一致）
SERVER_HOST = "127.0.0.1"
SERVER_PORT = int(os.environ.get("MC_PORT", "25566"))
RCON_PORT = int(os.environ.get("MC_RCON_PORT", "25576"))

# 每个脚本的超时（秒）。默认给宽一点，慢的单独调。
# **预算必须 > 实测 p95 + 余量**：被看门狗截杀就是检查未完成，必须非 0 退出。
DEFAULT_TIMEOUT = 300
TIMEOUTS = {
    "test_pathfinding.js": 420,
    # mine 实测 205~354 秒（420 只剩 66 秒余量）→ 600
    "test_mine_return.js": 600,
    # pit 实测 6~10 分钟（300 秒耐心 + 逐场景 setup）→ 720
    "test_pit_escape.js": 720,
    "test_survival_chain.js": 900,  # 盖房那步最长 420 秒
    "test_blueprint.js": 420,
    "test_integration.py": 420,
    "test_all_tools.py": 420,
    "soaktest.js": 900,
    "survivaltest.js": 900,
}

# ---------------------------------------------------------------- 工具


def _read(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return ""


def needs_server(p: Path) -> bool:
    """扫内容判断要不要服务器 —— 不写死清单，新增脚本自动归类。"""
    t = _read(p)
    return any(re.search(m, t) for m in SERVER_MARKERS)


def port_open(port: int, host: str = SERVER_HOST) -> bool:
    with socket.socket() as s:
        s.settimeout(0.6)
        return s.connect_ex((host, port)) == 0


def discover() -> list[Path]:
    """找出所有要跑的脚本（按名字排序，保证输出稳定）。"""
    out = []
    for p in sorted(DEV.glob("*.py")) + sorted(DEV.glob("*.js")):
        if p.name in ("run_all.py", "_paths.py"):
            continue
        if re.match(r"^(check_|test_)", p.name):
            out.append(p)
    return out


def parse_result(text: str, code: int) -> tuple[str, str]:
    """从输出里抽一句结果摘要。

    判据**以退出码为准**（脚本都实现了"有失败就非 0 退出"），
    摘要只是给人看的。抓不到摘要也不算错。
    """
    clean = re.sub(r"\x1b\[[0-9;]*m", "", text)
    lines = [l.strip() for l in clean.splitlines() if l.strip()]

    # 优先找"结果：N 通过，M 失败"
    for l in reversed(lines):
        m = re.search(r"结果：\s*(\d+)\s*通过[，,]\s*(\d+)\s*失败", l)
        if m:
            return f"{m.group(1)} 通过 / {m.group(2)} 失败", l
    for l in reversed(lines):
        m = re.search(r"通过\s*(\d+)\s*项[，,]\s*失败\s*(\d+)\s*项", l)
        if m:
            return f"{m.group(1)} 通过 / {m.group(2)} 失败", l
    # "全部通过（N 项断言）" / "检查通过：..."
    for l in reversed(lines):
        if "全部通过" in l or "检查通过" in l or "所有承诺都兑现" in l:
            return l[:60], l
        m = re.search(r"\b(\d+)/(\d+)\s+passed\b", l)
        if m:
            return f"{m.group(1)}/{m.group(2)} passed", l
    # SKIP（拿不到 AstrBot 运行时的脚本会这样）
    for l in reversed(lines):
        if re.search(r"(?:^|\]\s)(?:⏭️?\s*)?(?:SKIP\b|(?:已)?跳过(?:[:：]|进服测试))", l):
            return "SKIP", l
    return ("(无摘要)" if code == 0 else "(失败，无摘要)"), lines[-1] if lines else ""


def run_one(p: Path, timeout: int) -> dict:
    cmd = (
        [sys.executable, str(p)]
        if p.suffix == ".py"
        else ["node", str(p)]
    )
    env = dict(os.environ)
    env.setdefault("PYTHONIOENCODING", "utf-8")
    # 从仓库根跑：很多脚本用相对路径找 `.testserver`
    t0 = time.time()
    try:
        r = subprocess.run(
            cmd,
            cwd=str(REPO),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            env=env,
        )
        out = (r.stdout or "") + (r.stderr or "")
        code = r.returncode
    except subprocess.TimeoutExpired:
        return {
            "name": p.name,
            "status": "timeout",
            "summary": f"超过 {timeout} 秒",
            "detail": "",
            "output": "",
            "secs": time.time() - t0,
        }
    except OSError as e:
        return {
            "name": p.name,
            "status": "error",
            "summary": f"起不来：{e}",
            "detail": "",
            "output": "",
            "secs": time.time() - t0,
        }

    summary, detail = parse_result(out, code)
    if code == 0:
        status = "skip" if summary == "SKIP" else "ok"
    else:
        status = "fail"
    return {
        "name": p.name,
        "status": status,
        "summary": summary,
        "detail": detail,
        "output": out,
        "secs": time.time() - t0,
    }


# ---------------------------------------------------------------- 主流程


def main() -> int:
    ap = argparse.ArgumentParser(
        description="一条命令跑全部检查",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--full", action="store_true", help="连需要测试服的也跑")
    ap.add_argument("--only", default="", help="只跑名字里含这个子串的")
    ap.add_argument("-v", "--verbose", action="store_true", help="打印每个脚本的完整输出")
    args = ap.parse_args()

    scripts = discover()
    if args.only:
        scripts = [p for p in scripts if args.only in p.name]

    server_up = port_open(SERVER_PORT) and port_open(RCON_PORT)
    will_skip_server = not (args.full and server_up)

    todo, skipped = [], []
    for p in scripts:
        if needs_server(p) and will_skip_server:
            skipped.append(p)
        else:
            todo.append(p)

    print("=" * 62)
    print("  跑全部检查")
    print("=" * 62)
    print(f"  仓库：{REPO}")
    print(f"  找到 {len(scripts)} 个脚本：要跑 {len(todo)} 个，跳过 {len(skipped)} 个")
    if skipped:
        why = (
            "没加 --full"
            if not args.full
            else f"没检测到测试服（{SERVER_HOST}:{SERVER_PORT} / RCON {RCON_PORT}）"
        )
        print(f"  ⏭️  跳过 {len(skipped)} 个需要服务器的：{why}")
        print("      —— 这些没测！要测的话：先起测试服，再 python dev-tools/run_all.py --full")
    print()

    results = []
    t_all = time.time()
    for i, p in enumerate(todo, 1):
        print(f"[{i}/{len(todo)}] {p.name} … ", end="", flush=True)
        r = run_one(p, TIMEOUTS.get(p.name, DEFAULT_TIMEOUT))
        results.append(r)
        mark = {"ok": "✅", "fail": "❌", "skip": "⏭️", "timeout": "⏰", "error": "💥"}[r["status"]]
        note = ""
        if r["status"] == "fail" and p.name in KNOWN_FLAKY:
            note = f"  （历史偶发记录，需核对本次错误：{KNOWN_FLAKY[p.name]}）"
        elif r["status"] == "ok" and p.name in KNOWN_FLAKY:
            note = "  （这个脚本已知会偶发红，这次是好的）"
        print(f"{mark} {r['summary']}  {r['secs']:.0f}s{note}")
        if args.verbose and r["output"]:
            for l in r["output"].splitlines()[-25:]:
                print(f"      {l}")

    # ---------------- 汇总
    ok = [r for r in results if r["status"] == "ok"]
    fail = [r for r in results if r["status"] == "fail"]
    other = [r for r in results if r["status"] in ("timeout", "error")]
    skips = [r for r in results if r["status"] == "skip"]

    print()
    print("=" * 62)
    print(f"  ✅ 通过 {len(ok)}    ❌ 失败 {len(fail)}    ⏰/💥 {len(other)}    ⏭️ 跳过 {len(skips)}")
    if skipped:
        print(f"  ⏭️  另有 {len(skipped)} 个需要服务器的**没跑**（见上面说明）")
    print(f"  耗时 {time.time() - t_all:.0f} 秒")
    print("=" * 62)

    if fail:
        print("\n失败的：")
        for r in fail:
            flaky = KNOWN_FLAKY.get(r["name"])
            print(f"  ❌ {r['name']} — {r['summary']}")
            if r["detail"]:
                print(f"       {r['detail'][:100]}")
            if flaky:
                print(f"       ⚠️ 历史偶发记录（不能据此排除本次的新问题）：{flaky}")
        print("\n  提示：加 -v 能看到完整输出")
    if other:
        print("\n超时/起不来的：")
        for r in other:
            print(f"  {r['name']} — {r['summary']}")

    # 名字在偶发清单里不代表本次是同一原因；失败、超时和启动错误都必须报红。
    if fail or other:
        print(f"\n❌ 检查未通过：{len(fail)} 个失败，{len(other)} 个未完成；请检查输出后重跑")
        return 1
    print("\n✅ 已执行检查全部通过" + ("（另有跳过的，见上）" if skipped or skips else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
