#!/usr/bin/env python3
"""成本控制与可靠性的回归测试（离线，不需要服务器、不起引擎）。

1. 没活干时的退避：连续空闲时，两次模型决策的间隔逐轮翻倍（原来固定约 6 秒）。
2. 每小时调用上限：到了上限就不再发起自主决策和主动分享；主人的话照常处理。
3. 工具范围：mc_* 工具只在用得上的会话里随请求发出（原来附在每个会话的每次请求里）。
4. 订阅存档：/mc订阅 落盘，重载插件后恢复（原来只在内存里，重启就全丢）。
5. 心情状态：循环里最多每分钟写一次盘，且原子写入（原来约 2 秒一次、直接覆盖）。
6. 引擎首次启动失败：监管照样启动，按退避间隔重试（原来直接 return，再也不自动恢复）。
7. 推送合并：一个窗口内的消息合成一条发（原来逐条发，容易刷屏）。
8. 进服 / 退服 / 订阅只给管理员；退订不限。
9. 引擎输出读取：一次切完缓冲区，半行留到下一块，行不丢不乱。
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _paths  # noqa: E402

_paths.ensure_utf8_stdout()
_paths.require_astrbot("成本控制与订阅存档测试")

from astrbot.api.event import AstrMessageEvent  # noqa: E402
from astrbot.core.agent.tool import ToolSet  # noqa: E402

L = _paths.plugin_module("life")
tokens = _paths.plugin_module("tokens")
main = _paths.plugin_module("main")
Plugin = main.MinecraftPlugin


# ---------------------------------------------------------------- 自主循环夹具
class _Mem:
    def remember(self, *a, **k):
        return None

    def recall(self, *a, **k):
        return []

    def render_for_prompt(self, *a, **k):
        return ""


class _Drv:
    def tick(self):
        return None

    def save(self):
        return None

    def suggest_activity(self):
        return {"activity": "发呆", "label": "悠闲", "level": 0.5, "voice": "", "drive": "leisure"}

    def note_activity(self, **k):
        return None


async def _engine_call(method, params=None, **kw):
    return {"current": None, "queued": 0} if method == "task.list" else {"ok": True}


async def _text(*a, **k):
    return "状态"


async def _state():
    return {"inventory": {}, "health": 20, "food": 20}


def make_loop(**kwargs):
    loop = L.LifeLoop(
        engine_call=_engine_call, memory=_Mem(), drives=_Drv(), brief_provider=_text,
        llm=AsyncMock(return_value=None), system_prompt_provider=_text, state_provider=_state,
        decide_interval=0.05, **kwargs,
    )
    loop._survival_step = AsyncMock(return_value=None)  # 不让规则补给插进来，只看模型决策
    calls = []

    async def decide():
        calls.append(time.monotonic())
        return None  # "想不出该做什么"

    loop.decide = decide
    return loop, calls


async def run_for(loop, seconds: float):
    loop.start()
    loop.wake(reason="测试开始")  # 跳过进服后的 20 秒宽限
    await asyncio.sleep(seconds)
    await loop.stop()


class IdleBackoffTests(unittest.IsolatedAsyncioTestCase):
    def test_wait_doubles_and_caps(self):
        loop, _ = make_loop(idle_max_wait=120)
        loop._decide_interval = 20
        waits = []
        for rounds in (1, 2, 3, 4, 5, 6, 10):
            loop._idle_rounds = rounds
            waits.append(loop._idle_backoff_wait())
        self.assertEqual(waits, [6, 12, 24, 48, 96, 120, 120])
        loop._idle_rounds = 0
        loop._note_busy_round()
        loop._idle_rounds += 1
        self.assertEqual(loop._idle_backoff_wait(), 6)  # 做成一件事就清零

    async def test_idle_loop_asks_model_less_and_less(self):
        tokens.reset()
        loop, calls = make_loop()
        await run_for(loop, 1.7)
        # 间隔 0.05 → 0.1 → 0.2 → 0.4 → 0.8：1.7 秒内大约 5~6 次。原来固定 0.05 秒一次，会有 30 次左右
        self.assertGreaterEqual(len(calls), 3, calls)
        self.assertLessEqual(len(calls), 8, f"空闲时没有退避：1.7 秒问了 {len(calls)} 次模型")
        gaps = [b - a for a, b in zip(calls, calls[1:])]
        self.assertGreater(gaps[-1], gaps[0] * 3, f"间隔没有拉长：{gaps}")

    async def test_wake_interrupts_backoff(self):
        tokens.reset()
        loop, calls = make_loop()
        loop._idle_rounds = 5  # 已经退避到很长的等待
        loop.start()
        loop.wake(reason="测试开始")
        await asyncio.sleep(0.3)
        before = len(calls)
        loop.wake(reason="主人说话了")
        await asyncio.sleep(0.2)
        after = len(calls)
        await loop.stop()
        self.assertGreater(after, before, "唤醒应该立刻打断退避等待")


class ModelBudgetTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        tokens.reset()

    def test_ledger_window_counts_by_kind(self):
        led = tokens.ledger()
        for kind in ("autonomous", "perception", "chat", "planning"):
            led.record(None, kind=kind)
        count, oldest = led.calls_within(3600, ("autonomous", "perception"))
        self.assertEqual(count, 2)
        self.assertIsNotNone(oldest)
        led._window.insert(0, (time.time() - 4000, "autonomous"))  # 一小时以前的不算
        self.assertEqual(led.calls_within(3600, ("autonomous",))[0], 1)

    def test_budget_wait(self):
        loop, _ = make_loop(model_calls_per_hour=2)
        loop.state_note = Mock()
        self.assertEqual(loop._model_budget_wait(), 0.0)
        tokens.ledger().record(None, kind="autonomous")
        tokens.ledger().record(None, kind="chat")  # 聊天不算
        self.assertEqual(loop._model_budget_wait(), 0.0)
        tokens.ledger().record(None, kind="perception")
        wait = loop._model_budget_wait()
        self.assertGreater(wait, 3500)
        loop._model_budget_wait()
        loop.state_note.assert_called_once()  # 只说一次，不刷屏
        unlimited, _ = make_loop(model_calls_per_hour=0)
        self.assertEqual(unlimited._model_budget_wait(), 0.0)

    async def test_loop_stops_asking_model_when_budget_used(self):
        loop, calls = make_loop(model_calls_per_hour=2)
        for _ in range(2):
            tokens.ledger().record(None, kind="autonomous")
        await run_for(loop, 0.6)
        self.assertEqual(calls, [], "额度用完后不应再发起自主决策")

    async def test_owner_input_bypasses_budget(self):
        loop, calls = make_loop(model_calls_per_hour=1)
        tokens.ledger().record(None, kind="autonomous")
        loop._decision_owner_pending = True  # 主人的话还没处理
        await run_for(loop, 0.4)
        self.assertGreaterEqual(len(calls), 1, "主人的话必须能被处理")

    async def test_share_skipped_when_budget_used(self):
        loop, _ = make_loop(model_calls_per_hour=1)
        loop._last_share_at = 0.0
        loop._share_cooldown = 0
        tokens.ledger().record(None, kind="autonomous")
        self.assertFalse(await loop.share_event(kind="discovery", text="看到了竹林"))
        loop._llm.assert_not_awaited()


# ---------------------------------------------------------------- 工具范围
class FakeEvent(AstrMessageEvent):
    def __init__(self, umo: str = "aiocqhttp:GroupMessage:1", role: str = "member"):  # noqa: D107 - 刻意不调父类
        self.unified_msg_origin = umo
        self.role = role


def request_with_tools():
    ts = ToolSet()
    for name in ("mc_status", "mc_chop_tree", "web_search", "mc_say", "reminder"):
        ts.add_tool(SimpleNamespace(name=name, active=True))
    return SimpleNamespace(func_tool=ts)


def scope_plugin(config=None, connected=True, subscribers=()):
    p = object.__new__(Plugin)
    p.config = dict(config or {})
    p.connected = connected
    p._subscribers = set(subscribers)
    return p


class ToolScopeTests(unittest.IsolatedAsyncioTestCase):
    async def names_after(self, p, event):
        req = request_with_tools()
        await p._scope_mc_tools(event, req)
        return sorted(req.func_tool.names())

    async def test_auto_scope(self):
        others = ["reminder", "web_search"]
        mc_all = sorted(["mc_status", "mc_chop_tree", "mc_say"] + others)
        # 不在服里：谁都不带
        p = scope_plugin(connected=False, subscribers=["aiocqhttp:GroupMessage:1"])
        self.assertEqual(await self.names_after(p, FakeEvent(role="admin")), others)
        # 在服里：无关群的普通成员不带，别的插件的工具不受影响
        p = scope_plugin(connected=True)
        self.assertEqual(await self.names_after(p, FakeEvent("aiocqhttp:GroupMessage:9")), others)
        # 订阅过的会话、管理员：带
        p = scope_plugin(connected=True, subscribers=["aiocqhttp:GroupMessage:1"])
        self.assertEqual(await self.names_after(p, FakeEvent("aiocqhttp:GroupMessage:1")), mc_all)
        self.assertEqual(await self.names_after(p, FakeEvent("aiocqhttp:FriendMessage:7", role="admin")), mc_all)

    async def test_other_scopes(self):
        others = ["reminder", "web_search"]
        mc_all = sorted(["mc_status", "mc_chop_tree", "mc_say"] + others)
        p = scope_plugin({"llm_tool_scope": "all"}, connected=False)
        self.assertEqual(await self.names_after(p, FakeEvent()), mc_all)
        p = scope_plugin({"llm_tool_scope": "connected"}, connected=True)
        self.assertEqual(await self.names_after(p, FakeEvent("aiocqhttp:GroupMessage:9")), mc_all)
        p = scope_plugin({"llm_tool_scope": "connected"}, connected=False)
        self.assertEqual(await self.names_after(p, FakeEvent("aiocqhttp:GroupMessage:9")), others)

    async def test_original_toolset_is_not_mutated(self):
        p = scope_plugin(connected=False)
        req = request_with_tools()
        original = req.func_tool
        await p._scope_mc_tools(FakeEvent(), req)
        self.assertIn("mc_status", original.names())  # 换成新集合，不改原来的
        req_none = SimpleNamespace(func_tool=None)
        await p._scope_mc_tools(FakeEvent(), req_none)  # 没有工具时不报错
        self.assertIsNone(req_none.func_tool)


# ---------------------------------------------------------------- 订阅存档
class SubscriptionTests(unittest.IsolatedAsyncioTestCase):
    def plugin_in(self, directory):
        p = object.__new__(Plugin)
        p._data_dir = Path(directory)
        p._subscribers = set()
        return p

    async def subscribe(self, p, umo, command="cmd_subscribe"):
        event = SimpleNamespace(unified_msg_origin=umo,
                                plain_result=lambda text: SimpleNamespace(text=text))
        return [r async for r in getattr(p, command)(event)][-1].text

    async def test_survives_reload(self):
        with tempfile.TemporaryDirectory() as d:
            p = self.plugin_in(d)
            text = await self.subscribe(p, "aiocqhttp:GroupMessage:1")
            self.assertNotIn("没能存盘", text)
            await self.subscribe(p, "aiocqhttp:GroupMessage:2")
            await self.subscribe(p, "aiocqhttp:GroupMessage:2", "cmd_unsubscribe")
            restored = self.plugin_in(d)
            restored._load_subscribers()
            self.assertEqual(restored._subscribers, {"aiocqhttp:GroupMessage:1"})
            self.assertFalse(list(Path(d).glob("*.tmp")), "不应留下临时文件")

    def test_bad_file_is_left_alone(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "subscribers.json"
            path.write_text("{坏掉的", encoding="utf-8")
            p = self.plugin_in(d)
            p._load_subscribers()
            self.assertEqual(p._subscribers, set())
            self.assertEqual(path.read_text(encoding="utf-8"), "{坏掉的")

    async def test_no_data_dir_reports_unsaved(self):
        p = object.__new__(Plugin)
        p._subscribers = set()
        text = await self.subscribe(p, "aiocqhttp:GroupMessage:1")
        self.assertIn("没能存盘", text)
        self.assertEqual(p._subscribers, {"aiocqhttp:GroupMessage:1"})


# ---------------------------------------------------------------- 5. 心情状态写盘
class CountingDrives(_Drv):
    def __init__(self):
        self.saves = 0

    def save(self):
        self.saves += 1


class DriveSaveTests(unittest.IsolatedAsyncioTestCase):
    async def test_loop_saves_at_most_once_a_minute(self):
        tokens.reset()
        loop, calls = make_loop()
        loop.drives = CountingDrives()
        loop._idle_max_wait = 6.0
        await run_for(loop, 0.8)
        self.assertGreaterEqual(len(calls), 3, "循环应该转了好几圈")
        self.assertEqual(loop.drives.saves, 1, f"0.8 秒内写了 {loop.drives.saves} 次盘")

    def test_save_is_atomic_and_leaves_no_temp(self):
        drives_mod = _paths.plugin_module("drives")
        with tempfile.TemporaryDirectory() as d:
            ds = drives_mod.DriveSystem(Path(d))
            ds.save()
            ds.save()
            files = sorted(p.name for p in Path(d).iterdir())
            self.assertEqual(files, ["drives.json"])
            data = json.loads((Path(d) / "drives.json").read_text(encoding="utf-8"))
            self.assertIn("drives", data)


# ---------------------------------------------------------------- 6. 引擎启动重试
bridge = _paths.plugin_module("bridge_client")


class FailingEngine:
    def __init__(self):
        self.running = False
        self.starts = 0
        self.fail = True

    async def start(self):
        self.starts += 1
        if self.fail:
            raise bridge.EngineUnavailable("找不到 node")
        self.running = True

    async def ping(self):
        return self.running


def supervise_plugin(engine):
    p = object.__new__(Plugin)
    p.config = {}
    p.engine = engine
    p.life = None
    p.connected = False
    p._engine_ping_failures = 0
    p._engine_ping_fail_limit = 3
    return p


class EngineRetryTests(unittest.IsolatedAsyncioTestCase):
    async def test_failed_start_backs_off_then_recovers(self):
        eng = FailingEngine()
        p = supervise_plugin(eng)
        await p._supervise_tick()
        self.assertEqual(eng.starts, 1)
        first_delay = p._engine_retry_at - time.time()
        self.assertTrue(15 < first_delay <= 20, first_delay)
        await p._supervise_tick()  # 还在退避期：不重试、不刷错误
        self.assertEqual(eng.starts, 1)
        p._engine_retry_at = 0.0
        await p._supervise_tick()
        self.assertEqual(eng.starts, 2)
        self.assertTrue(35 < p._engine_retry_at - time.time() <= 40)  # 翻倍
        for _ in range(10):
            p._engine_retry_at = 0.0
            await p._supervise_tick()
        self.assertLessEqual(p._engine_retry_at - time.time(), 600)  # 封顶 10 分钟
        eng.fail = False
        p._engine_retry_at = 0.0
        await p._supervise_tick()
        self.assertTrue(eng.running)
        self.assertEqual((p._engine_start_failures, p._engine_retry_at), (0, 0.0))

    def test_initialize_keeps_supervising_after_failed_start(self):
        import ast

        tree = ast.parse((_paths.REPO / "main.py").read_text(encoding="utf-8"))
        init = next(n for n in ast.walk(tree)
                    if isinstance(n, ast.AsyncFunctionDef) and n.name == "initialize")
        for node in ast.walk(init):
            if isinstance(node, ast.ExceptHandler) and "EngineUnavailable" in ast.unparse(node.type or ast.Pass()):
                self.assertFalse(any(isinstance(x, ast.Return) for x in ast.walk(node)),
                                 "引擎启动失败时不能直接 return（监管循环会启动不了）")
        self.assertIn("_supervise_loop", ast.unparse(init))


# ---------------------------------------------------------------- 7. 推送合并
def push_plugin(config):
    p = object.__new__(Plugin)
    p.config = dict(config)
    p._subscribers = {"aiocqhttp:GroupMessage:1"}
    p._background_tasks = set()
    p._terminating = False
    p.context = SimpleNamespace(send_message=AsyncMock())
    return p


def sent_texts(p):
    return [call.args[1].get_plain_text() for call in p.context.send_message.await_args_list]


class PushMergeTests(unittest.IsolatedAsyncioTestCase):
    async def test_messages_in_window_are_merged(self):
        p = push_plugin({"push_merge_seconds": 0.05})
        for i in range(20):
            await p._notify_subscribers(f"第 {i} 条")
        p.context.send_message.assert_not_awaited()  # 不再逐条立即发
        await asyncio.sleep(0.15)
        texts = sent_texts(p)
        self.assertEqual(len(texts), 1, texts)
        self.assertIn("第 0 条", texts[0])
        self.assertIn("第 14 条", texts[0])
        self.assertNotIn("第 15 条", texts[0])
        self.assertIn("还有 5 条", texts[0])

    async def test_later_messages_go_out_in_next_window(self):
        p = push_plugin({"push_merge_seconds": 0.05})
        await p._notify_subscribers("先来的")
        await asyncio.sleep(0.08)
        await p._notify_subscribers("后来的")
        await asyncio.sleep(0.15)
        self.assertEqual(sent_texts(p), ["先来的", "后来的"])
        await asyncio.gather(*list(p._background_tasks))  # 没有新消息时合并任务自己结束

    async def test_zero_window_sends_immediately(self):
        p = push_plugin({"push_merge_seconds": 0})
        await p._notify_subscribers("马上发")
        self.assertEqual(sent_texts(p), ["马上发"])

    async def test_no_subscribers_no_buffering(self):
        p = push_plugin({"push_merge_seconds": 0.05})
        p._subscribers = set()
        await p._notify_subscribers("没人听")
        self.assertEqual(p._background_tasks, set())


# ---------------------------------------------------------------- 8. 指令权限
class CommandPermissionTests(unittest.TestCase):
    def decorators(self, name):
        import ast

        tree = ast.parse((_paths.REPO / "main.py").read_text(encoding="utf-8"))
        func = next(n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef) and n.name == name)
        return " ".join(ast.unparse(d) for d in func.decorator_list)

    def test_admin_only_commands(self):
        for name in ("cmd_connect", "cmd_disconnect", "cmd_subscribe"):
            self.assertIn("PermissionType.ADMIN", self.decorators(name), name)
        # 退订不限：谁都能让自己所在的会话不再收推送；急停也一样
        self.assertNotIn("PermissionType.ADMIN", self.decorators("cmd_unsubscribe"))
        self.assertNotIn("PermissionType.ADMIN", self.decorators("cmd_stop"))


# ---------------------------------------------------------------- 9. 引擎输出读取
class FakeProc:
    def __init__(self, chunks):
        self.stdout = asyncio.StreamReader()
        for chunk in chunks:
            self.stdout.feed_data(chunk)
        self.stdout.feed_eof()
        self.returncode = 0


class ReadLoopTests(unittest.IsolatedAsyncioTestCase):
    async def test_lines_split_across_chunks(self):
        payload = b"".join(json.dumps({"id": i}).encode() + b"\n" for i in range(300))
        # 切成大小不一的块，行会被拦腰截断
        chunks = [payload[i:i + 37] for i in range(0, len(payload), 37)]
        proc = FakeProc(chunks)
        client = object.__new__(bridge.EngineClient)
        client._proc = proc
        client._closing = True
        client.on_disconnected = None
        client._engine_info = {}
        client._fail_pending = lambda reason: None
        seen = []
        client._handle_line = lambda line: seen.append(json.loads(line)["id"])
        await client._read_loop(proc)
        self.assertEqual(seen, list(range(300)))


if __name__ == "__main__":
    unittest.main(verbosity=2)
