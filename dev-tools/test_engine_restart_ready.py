#!/usr/bin/env python3
"""**重启引擎后必须等新的 engine.ready，不能拿旧进程的就绪信息充数**（P3）。

## 它钉住的是什么

`bridge_client.py` 里，`_wait_ready()` 判断"引擎已就绪"的**唯一**依据是
`self._engine_info` 非空：

    if self._engine_info:
        return self._engine_info

而 `stop()` 原来**没有清空它**。于是"引擎崩溃 → 重启"这条路：

  1. 旧进程留下 `_engine_info = {version: '4.39.0', skills: [...21 个], pid: 1234}`
  2. 崩溃 → 重启 → `start()` 派生新进程
  3. `_wait_ready()` **立刻**返回旧的那份（因为非空）
  4. `start()` 打印"引擎就绪：v4.39.0，21 个技能"——**全是上一个进程的**，
     而新进程的 `engine.ready` 可能根本还没到、甚至新进程已经起不来了

与 P2 的"假死重启"叠加时尤其误导：日志上看起来重启成功了，实际什么都没起来。

## 怎么测

不需要真的起进程：`EngineClient` 的 `running` 是 `_proc` 的派生属性，
用一个 `returncode = None` 的假进程对象就能把状态造出来，
`stop()` 在没有真进程时也会走完"清状态"那段（`proc is None` 时提前返回）。

用法：
    $env:PYTHONPATH='<AstrBot>/backend/app'
    & '<AstrBot>/backend/python/python.exe' dev-tools/test_engine_restart_ready.py
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _paths  # noqa: E402

_paths.require_astrbot("test_engine_restart_ready")
_paths.load_plugin()

from astrcraft_plugin.bridge_client import EngineClient, EngineConfig  # noqa: E402

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


class FakeProc:
    """够 `running` 属性与 `stop()` 用。

    `running` 的判据是 `_proc is not None and _proc.returncode is None`；
    `stop()` 还会 await `proc.wait()`，所以这里得给一个。
    """

    def __init__(self, returncode=None):
        self.returncode = returncode
        self.stdin = None
        self.waited = 0

    async def wait(self):
        self.waited += 1
        if self.returncode is None:
            self.returncode = 0
        return self.returncode

    def kill(self):  # pragma: no cover - 只有超时路径才会走到
        self.returncode = -9


OLD_READY = {"version": "0.0.1-OLD", "skills": ["old_a", "old_b"], "pid": 111}


def new_client() -> EngineClient:
    return EngineClient(EngineConfig(engine_dir=_paths.ENGINE_DIR))


def main() -> int:
    print("=== P3：重启后必须等新的 engine.ready ===\n")

    # ---- ① stop() 必须清掉就绪信息 ----
    print("① stop() 清掉 _engine_info")
    c = new_client()
    c._engine_info = dict(OLD_READY)
    c._proc = FakeProc(returncode=None)
    ok("先造出「旧引擎已就绪」的状态", bool(c._engine_info) and c.running, f"{c._engine_info}")
    asyncio.run(c.stop())
    ok(
        "**stop() 之后 _engine_info 是空的**",
        c._engine_info == {},
        f"_engine_info={c._engine_info}",
    )
    ok("进程引用也清掉了", c._proc is None and not c.running)

    # ---- ② 清掉之后 _wait_ready 不会立刻说"就绪" ----
    print("\n② 清掉之后 _wait_ready 必须等（而不是立刻返回旧的）")
    c = new_client()
    c._engine_info = {}  # 模拟"新进程已派生、但 engine.ready 还没到"
    c._proc = FakeProc(returncode=None)  # 进程在跑
    ready = asyncio.run(c._wait_ready(timeout=0.4))
    ok(
        "新进程还没就绪时，_wait_ready 返回 None（而不是旧数据）",
        ready is None,
        f"返回了 {ready}",
    )

    # ---- ③ 对照：就绪信息到了就要立刻返回 ----
    print("\n③ 对照：新的 ready 到了就返回它")
    c = new_client()
    c._proc = FakeProc(returncode=None)
    NEW_READY = {"version": "9.9.9-NEW", "skills": ["chop_tree", "craft"], "pid": 222}

    async def arrive_soon():
        await asyncio.sleep(0.1)
        c._engine_info = dict(NEW_READY)

    async def both():
        asyncio.ensure_future(arrive_soon())
        return await c._wait_ready(timeout=1.0)

    ready = asyncio.run(both())
    ok("拿到的是**新**进程的 ready", ready == NEW_READY, f"ready={ready}")

    # ---- ④ 完整的"崩溃 → 重启"序列：不允许出现旧版本号 ----
    print("\n④ 完整序列：旧引擎就绪 → 崩溃 → 重启")
    c = new_client()
    c._engine_info = dict(OLD_READY)
    c._proc = FakeProc(returncode=None)
    # 崩溃
    c._proc.returncode = 1
    ok("崩溃后 running 变 False", not c.running)
    asyncio.run(c.stop())  # 崩溃路径通常也会走 stop/清理
    ok("清理后 _engine_info 为空", c._engine_info == {}, f"{c._engine_info}")
    # 重启：新进程起来了但还没 ready
    c._proc = FakeProc(returncode=None)
    ready = asyncio.run(c._wait_ready(timeout=0.3))
    ok(
        "**重启等待期间绝不会报出旧进程的版本号**",
        ready is None or ready.get("version") != OLD_READY["version"],
        f"ready={ready}",
    )

    # ---- ⑤ 源码层面：start() 也要清一次（异常退出不走 stop） ----
    print("\n⑤ start() 在派生新进程前也要清一次（异常退出不走 stop）")
    src = (_paths.REPO / "bridge_client.py").read_text(encoding="utf-8")
    start_body = src.split("async def start(self)")[1].split("async def _wait_ready")[0]
    stop_body = src.split("async def stop(self")[1].split("async def _read_loop")[0]
    ok(
        "start() 里在派生进程前清空了 _engine_info",
        "self._engine_info = {}" in start_body,
        "否则被外部杀掉的进程会留下一份永远不会被清的就绪信息",
    )
    ok("stop() 里也清空了 _engine_info", "self._engine_info = {}" in stop_body)
    ok(
        "清空发生在派生进程之前",
        start_body.index("self._engine_info = {}") < start_body.index("create_subprocess_exec"),
        "顺序反了就等于没清",
    )

    print(f"\n=== 结果：{passed} 通过，{failed} 失败 ===")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
