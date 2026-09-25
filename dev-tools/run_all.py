#!/usr/bin/env python3
"""**一条命令跑全部检查。**

## 为什么需要这个

仓库里有 **42 个** `check_*` / `test_*` 脚本（29 个 Python + 13 个 JS）。
在加这个脚本之前，"我的改动是对的吗？"这个问题**没有便宜的答案**：
你得自己知道该跑哪几个、哪些需要测试服、哪些本来就会偶发红。

后果是新人（以及半年后的作者）大概率**改完就提交**。

## 用法

    python dev-tools/run_all.py              # 只跑不需要服务器的（约 1 分钟）
    python dev-tools/run_all.py --full       # 全跑（需要测试服在 25566）
    python dev-tools/run_all.py --only life  # 只跑名字里带 life 的
    python dev-tools/run_all.py -v           # 把每个脚本的输出也打出来

## 三个设计（缺一不可）

**① 自己分类，不写死清单。**
   扫脚本内容里有没有 `Rcon.fromDir` / `call('connect')` 之类的标记，
   自动判定"要不要服务器"。**新增测试不用改这个脚本** ——
   写死清单的话，加一个测试就得记得来改这里，迟早会忘。

**② 明确说"跳过了什么"。**
   没起测试服时，20 个脚本会被跳过。**"跳过了"必须打出来**，
   否则"全绿"是假的 —— 你只是没测那些而已。

**③ 标出"已知会偶发红"的。**
   `test_survival_chain` 首次运行常 2/3（冷启动，区块没就绪），重跑即好。
   不标出来的话，新人会去追一个**不存在的 bug**。
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

REPO = Path(__file__).resolve().parents[1]
DEV = REPO / "dev-tools"

# ---------------------------------------------------------------- 配置

# **已知会偶发红、但不是功能问题**的脚本。
# 加进来的条件：你自己复现过"重跑就好"，并且知道原因。
KNOWN_FLAKY = {
    # **不是"功能坏了"，是已知的合成不稳定**（README 的「已知问题」里也记着：
    # "合成偶发失败，约 1/6 的运行里合成工作台这一步失败 ——
    #  mineflayer ↔ 服务端窗口状态机的固有脆弱点"）。
    # 实测：连跑时 [1] 挖矿和 [3] 盖房**都稳定通过**，红的总是 [2] 做工具，
    # 而它的错误就是"合成/容器操作没被服务器接受"。
    "test_survival_chain.js": "偶发 [2] 合成失败（mineflayer 窗口状态机，见 README「已知问题」）—— 实测修完平台/材料后 15+ 次里约 1 次（_sc_e2），重跑通常就好",
    # **pit 的失败集中在两个攀爬硬场景**（[1] 3 格坑垫高、[4] 10 格竖井），
    # 和用户最初报的「挖矿回不到地面」同源 —— 攀爬本身是概率性的
    # （多轮实测：3/3、3/5、4/5、5/5 都出现过，约 80~90% 通过）。
    # 不是断言写松了：失败时测试会打印引擎日志（这轮加的）供复查。
    "test_pit_escape.js": "偶发（约 4/5~5/5）：[1] 3 格坑垫高 / [4] 10 格竖井的攀爬硬场景，与用户原报的攀爬问题同源；失败自带引擎日志",
    # **mine_return 的攀爬偶发** —— 失败形态：「往旁边垫成功了 → 没上去
    # （goTo 无报错、高度不变）→ 三策略全灭」。**跨 4 轮实测**（3/3 ~ 1/3 波动）
    # 都见过，和 pit 是同一类**攀爬概率性问题**（用户原报 bug 的老地盘）。
    # 这是**已知清单里最值得再深挖的一条**：下一轮拿 `-v`+引擎日志看
    # goTo 的 arrived/距离，判断是「goTo 认为到了但高度没变」还是「根本没走到」。
    "test_mine_return.js": "攀爬偶发（垫好落脚点但上不去/goTo 无报错）——跨 4 轮实测波动，与 pit 同类；失败自带引擎日志",
    # **已修两个根因并 2/2 验证**（场景掉虚空 tunnelY 钳制 / 放置锚点选到容器
    # GUI 方块），保留观察：再红就说明还有第三种模式。
    "minetest.js": "旧偶发 12/13 已修两根因（掉虚空 / GUI 锚点），修复后 2/2 绿；保留观察",
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
DEFAULT_TIMEOUT = 300
TIMEOUTS = {
    "test_pathfinding.js": 420,
    "test_mine_return.js": 420,
    "test_pit_escape.js": 420,
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
    # SKIP（拿不到 AstrBot 运行时的脚本会这样）
    for l in reversed(lines):
        if "SKIP" in l or "跳过" in l:
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
    except FileNotFoundError as e:
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
            mark = "⚠️"
            note = f"  （已知偶发：{KNOWN_FLAKY[p.name]}）"
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
                print(f"       ⚠️ 但这个是**已知偶发**：{flaky}")
        print("\n  提示：加 -v 能看到完整输出")
    if other:
        print("\n超时/起不来的：")
        for r in other:
            print(f"  {r['name']} — {r['summary']}")

    # 已知偶发的失败**不算**总失败（否则每次都会红，就没人看了）
    real_fail = [r for r in fail if r["name"] not in KNOWN_FLAKY]
    if real_fail:
        print(f"\n❌ 有 {len(real_fail)} 个**真失败** —— 你的改动可能有问题")
        return 1
    if fail:
        print(f"\n⚠️ 只有 {len(fail)} 个**已知偶发**的失败，重跑一次看看")
        return 0
    print("\n✅ 全部通过" + ("（但有跳过的，见上）" if skipped else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
