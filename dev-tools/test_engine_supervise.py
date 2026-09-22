#!/usr/bin/env python3
"""**引擎"活着但不响应 ping"必须被判定假死并重启**（P2）的回归测试。

## 它钉住的是什么

`main.py` 的监管循环原来长这样：

    if self.engine.running and await self.engine.ping():   → 处理并 continue
    if not self.engine.running:                             → 重新拉起

**ping 失败时两个分支都不进**，循环里没有任何处理 → **永久空转**。
而 `self.connected` 还是 True，`/mc状态` 显示"运行中/已连接"，
用户看到的是"她在服里但什么都不做"，日志里一行都没有。

这条路径是**已知会发生的**：`docs/MODULE_MAP.md` 的「同步扫描会冻结整个引擎」
一节记载长任务会把 Node 事件循环整个占住（期间收不到也回不了任何 RPC），
A5 把 `pathThinkTimeoutMs` 从 4000 压到 1800 正是为了减少这种阻塞。

## 怎么测

`_supervise_loop` 里包着 `await asyncio.sleep(20)`，等不起，所以真正的
一轮逻辑被抽成了 `MinecraftPlugin._supervise_tick()`。这个测试直接调它，
用一个假 engine 驱动各种探活结果——**不需要引擎、不需要 node_modules、
不需要服务端**。

用法：
    $env:PYTHONPATH='<AstrBot>/backend/app'
    & '<AstrBot>/backend/python/python.exe' dev-tools/test_engine_supervise.py
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _paths  # noqa: E402

_paths.require_astrbot("test_engine_supervise")
_paths.load_plugin()

from astrcraft_plugin.main import MinecraftPlugin  # noqa: E402

passed = 0
failed = 0


def ok(msg: str, cond: bool, detail: str = "") -> None:
    global passed, failed
    if cond:
        passed += 1
        print(f"  ✅ {msg}" + (f" — {detail}" if detail else ""))
    else:
        failed += 1
        print(f"  ❌ {msg}" + (f" — {detail}" if detail else ""))


class FakeEngine:
    """够 `_supervise_tick` 用就行：running / ping / stop / start / status。"""

    def __init__(self, *, running=True, ping_results=None):
        self.running = running
        self._ping_results = list(ping_results or [])
        self.stopped = 0
        self.started = 0
        self.status_calls = 0
        # start() 之后进程就算起来了
        self._start_result = True

    async def ping(self, *, timeout=5.0):
        if self._ping_results:
            return self._ping_results.pop(0)
        return True

    async def stop(self, **kw):
        self.stopped += 1
        self.running = False

    async def start(self):
        self.started += 1
        self.running = self._start_result
        return {"version": "9.9.9", "skills": ["chop_tree"]}

    async def status(self):
        self.status_calls += 1
        return {"connected": True}


class FakeLife:
    def __init__(self):
        self.engine_up_calls: list[bool] = []

    def note_engine_up(self, up: bool) -> None:
        self.engine_up_calls.append(up)


class FakePlugin:
    """`_supervise_tick` 需要的那几个属性。"""

    def __init__(self, engine, *, auto_connect=False):
        self.engine = engine
        self.connected = True
        self.life = FakeLife()
        self._auto_connect_calls: list[str] = []
        self._last_connect_attempt = 0.0
        self._engine_ping_failures = 0
        self._engine_ping_fail_limit = 3
        self._auto_connect_cfg = auto_connect
        self.mood_pushes = 0

    def _cfg(self, key, default=None):
        if key == "auto_connect":
            return self._auto_connect_cfg
        return default

    async def _auto_connect(self, reason=""):
        self._auto_connect_calls.append(reason)

    async def push_mood(self):
        self.mood_pushes += 1


def tick(plugin):
    return asyncio.run(MinecraftPlugin._supervise_tick(plugin))


def main() -> int:
    print("=== P2：引擎假死（活着但不回 ping）必须被重启 ===\n")

    # ---- ① 探活正常：什么都不该发生 ----
    print("① 探活正常")
    eng = FakeEngine(running=True, ping_results=[True])
    p = FakePlugin(eng)
    p._engine_ping_failures = 2  # 之前攒了 2 次，这次好了就该清零
    tick(p)
    ok("不重启", eng.stopped == 0 and eng.started == 0, f"stop={eng.stopped} start={eng.started}")
    ok("连续失败计数被清零", p._engine_ping_failures == 0, f"failures={p._engine_ping_failures}")
    ok("照常推心情", p.mood_pushes == 1)

    # ---- ② 连续失败但没到阈值：只计数、不重启 ----
    print("\n② 连续失败 1~2 次（阈值 3）：先别急着重启")
    eng = FakeEngine(running=True, ping_results=[False, False])
    p = FakePlugin(eng)
    tick(p)
    ok("第 1 次失败只计数", p._engine_ping_failures == 1, f"failures={p._engine_ping_failures}")
    ok("第 1 次失败不重启", eng.stopped == 0 and eng.started == 0)
    tick(p)
    ok("第 2 次失败累计到 2", p._engine_ping_failures == 2, f"failures={p._engine_ping_failures}")
    ok("第 2 次失败仍不重启", eng.stopped == 0 and eng.started == 0)
    ok("这两轮都没推心情（引擎没响应就别推）", p.mood_pushes == 0)

    # ---- ③ 达到阈值：判定假死 → 停牌 + 停进程 + 重启 ----
    print("\n③ 第 3 次失败达到阈值：判定假死并重启")
    eng = FakeEngine(running=True, ping_results=[False])
    p = FakePlugin(eng)
    p._engine_ping_failures = 2
    p.connected = True
    tick(p)
    ok("**停掉了假死的进程**", eng.stopped == 1, f"stop={eng.stopped}")
    ok("**重新拉起了引擎**", eng.started == 1, f"start={eng.started}")
    ok("重启后计数清零（下一次从 0 开始攒）", p._engine_ping_failures == 0)
    ok("连接标记被显式置 False", p.connected is False, f"connected={p.connected}")
    ok(
        "life 收到「引擎下线」再收到「引擎上线」",
        p.life.engine_up_calls == [False, True],
        f"note_engine_up 调用序列={p.life.engine_up_calls}",
    )

    # ---- ④ 假死重启后按 auto_connect 重连 ----
    print("\n④ 假死重启后按配置重连")
    eng = FakeEngine(running=True, ping_results=[False])
    p = FakePlugin(eng, auto_connect=True)
    p._engine_ping_failures = 2
    tick(p)
    ok("auto_connect=True 时真的去重连了", len(p._auto_connect_calls) == 1, f"{p._auto_connect_calls}")
    eng2 = FakeEngine(running=True, ping_results=[False])
    p2 = FakePlugin(eng2, auto_connect=False)
    p2._engine_ping_failures = 2
    tick(p2)
    ok("auto_connect=False 时不重连", not p2._auto_connect_calls)

    # ---- ⑤ 进程真的没了：走原来的重启路径（不经过假死计数） ----
    print("\n⑤ 进程真的没了（running=False）")
    eng = FakeEngine(running=False)
    p = FakePlugin(eng)
    tick(p)
    ok("直接重启，不计假死", eng.started == 1 and p._engine_ping_failures == 0, f"start={eng.started}")
    ok("不调用 stop（进程已经没了）", eng.stopped == 0)
    ok("life 收到引擎下线再上线", p.life.engine_up_calls == [False, True], f"{p.life.engine_up_calls}")

    # ---- ⑥ 探活正常时不会误判（回归：别把"偶发一次超时"攒成重启） ----
    print("\n⑥ 失败一次之后又好了：计数必须清零，不能攒着")
    eng = FakeEngine(running=True, ping_results=[False, True, False, True])
    p = FakePlugin(eng)
    tick(p)
    ok("第 1 次失败 → 1", p._engine_ping_failures == 1)
    tick(p)
    ok("好了 → 清零", p._engine_ping_failures == 0, f"failures={p._engine_ping_failures}")
    tick(p)
    ok("再失败一次 → 又是 1（不是 2）", p._engine_ping_failures == 1, f"failures={p._engine_ping_failures}")
    ok("全程没有重启", eng.stopped == 0 and eng.started == 0)

    # ---- ⑦ 阈值是可配的，而且 /mc状态 会读它 ----
    print("\n⑦ 阈值可配 + 状态里看得见")
    eng = FakeEngine(running=True, ping_results=[False])
    p = FakePlugin(eng)
    p._engine_ping_fail_limit = 1
    tick(p)
    ok("把阈值调成 1 时，一次失败就重启", eng.started == 1, f"start={eng.started}")
    src = (_paths.REPO / "main.py").read_text(encoding="utf-8")
    ok(
        "cmd_status 里暴露了连续失败次数",
        "_engine_ping_failures" in src.split("async def cmd_status")[1][:2000],
        "否则假死时「运行中」三个字是骗人的",
    )

    print(f"\n=== 结果：{passed} 通过，{failed} 失败 ===")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
