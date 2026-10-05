"""插件控制状态回归：急停、恢复、主动退服和聊天串行处理。"""
from __future__ import annotations

import asyncio
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _paths

_paths.require_astrbot("test_plugin_control")
Plugin = _paths.plugin_module("main").MinecraftPlugin


class Event:
    def __init__(self, message_str=""):
        self.message_str = message_str

    def plain_result(self, text):
        return text


class Life:
    def __init__(self):
        self.paused = False
        self.pause_until = None
        self.owners = []
        self.task_results = []
        self._dead = False
        self.deaths = []
        self.wakes = []

    def pause(self, *, reason="", max_seconds=600):
        self.paused = True
        self.pause_until = max_seconds

    def resume(self):
        self.paused = False

    def wake(self, **kwargs):
        self.wakes.append(kwargs)

    def note_dead(self, value):
        self._dead = value

    def note_death(self, position):
        self.deaths.append(position)

    async def share_event(self, **kwargs):
        pass

    def retry_decision_now(self):
        pass

    def note_owner_said(self, text):
        self.owners.append(text)

    def note_world_event(self, *args, **kwargs):
        pass

    def note_task_result(self, *args):
        self.task_results.append(args)

    def note_engine_up(self, value):
        pass


class Engine:
    def __init__(self):
        self.running = True
        self.connected = True
        self.stopped = False
        self.connect_count = 0
        self.say = AsyncMock()

    async def call(self, method, params=None, **kwargs):
        if method == "disconnect":
            self.connected = False
        if method == "safety.resume":
            self.stopped = False
        return {"ok": True}

    async def safety_stop(self):
        self.stopped = True
        return {"cancelled": ["running-task"]}

    async def ping(self):
        return True

    async def status(self):
        return {"connected": self.connected}

    async def start(self):
        self.running = True

    async def connect_game(self, **kwargs):
        self.connect_count += 1
        self.connected = True


def plugin():
    p = object.__new__(Plugin)
    p.config = {"auto_connect": True}
    p.engine = Engine()
    p.life = Life()
    p.goals = None
    p.memory = None
    p.drives = None
    p.connected = True
    p._manual_disconnect_requested = False
    p._emergency_stopped = False
    p._last_connect_attempt = 0
    p._engine_ping_failures = 0
    p._engine_ping_fail_limit = 3
    p._connect_lock = asyncio.Lock()
    p._game_reply_lock = asyncio.Lock()
    p._background_tasks = set()
    p._last_brief = ""
    p._last_brief_at = 0.0
    p._notify_subscribers = AsyncMock()
    return p


async def results(generator):
    return [item async for item in generator]


class ControlTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancelled_skill_is_interruption_without_failure_backoff(self):
        from test_life_recovery import make_loop
        p = plugin()
        loop, _ = make_loop()
        p.life = loop
        p.config["announce_task_done"] = False
        loop._set_plan([{"skill": "mine_stone"}, {"skill": "make_tools"}])
        for reason in ("主人叫停了", "紧急后撤抢占", "新目标替换旧动作"):
            await p._on_task_finished({"kind": "skill", "name": "挖石头", "status": "cancelled",
                                       "error": reason, "meta": {"skill": "mine_stone"}})
        self.assertEqual(loop._failure_counts(), {})
        self.assertFalse(loop._should_back_off())
        self.assertEqual(loop._plan, [])
        self.assertTrue(all(e.get("cancelled") for e in loop._recent_outcomes))
        self.assertTrue(all(e.type == "task_cancelled" for e in loop.inbox.entries))
        self.assertIn("→ 中断", loop._render_recent())
        self.assertNotIn("→ 没做成", loop._render_recent())
        self.assertEqual(loop._render_progress_since(time.time() - 60), "")

    async def test_true_failed_skill_still_builds_failure_memory(self):
        from test_life_recovery import make_loop
        p = plugin()
        loop, _ = make_loop()
        p.life = loop
        p.config["announce_task_done"] = False
        for _ in range(3):
            await p._on_task_finished({"kind": "skill", "name": "挖石头", "status": "failed",
                                       "error": "没有镐子", "meta": {"skill": "mine_stone"}})
        self.assertEqual(loop._failure_counts(), {"mine_stone": 3})
        self.assertFalse(loop.skill_retry_ready("mine_stone"))
        self.assertTrue(loop.skill_retry_ready("cook_food"))

    async def test_survival_snapshot_preserves_zero_and_observed_animals(self):
        p = plugin()

        async def call(method, params=None, **kwargs):
            if method == "state.get":
                return {"health": 0, "food": 0, "time_of_day": 14000,
                        "nearby_entities": [{"name": "pig", "distance": 3}],
                        "inventory_summary": {"used_slots": 34}}
            return {"items": {"bread": 2}}

        p.engine.call = call
        st = await p._life_state_snapshot()
        self.assertEqual(st["health"], 0)
        self.assertEqual(st["food"], 0)
        self.assertEqual(st["nearby_entities"][0]["name"], "pig")
        self.assertEqual(st["inventory_slots_used"], 34)

    async def test_skill_metadata_is_used_for_survival_result_memory(self):
        p = plugin()
        p.config["announce_task_done"] = False
        await p._on_task_finished({"kind": "skill", "name": "吃饱", "status": "done", "meta": {"skill": "eat"}})
        self.assertEqual(p.life.task_results[-1][0], "eat")

    async def test_mining_physical_return_result_and_task_id_reach_real_loop(self):
        from test_life_recovery import make_loop
        p = plugin()
        loop, _ = make_loop()
        p.life = loop
        p.config["announce_task_done"] = False
        received = []
        loop.note_task_result = lambda *args, **kwargs: received.append((args, kwargs))
        status = {"required": True, "ok": False, "target": None, "position": {"x": 0, "y": 60, "z": 0},
                  "server": "127.0.0.1:25566", "dimension": "overworld", "reason": "井壁不可挖"}
        result = {"ok": False, "collection_ok": True, "produced": {"coal": 2}, "return_status": status}
        await p._on_task_finished({"kind": "skill", "task_id": "mine-return-1", "name": "挖矿", "status": "failed",
                                   "meta": {"skill": "mine_ores"}, "result": result, "error": status["reason"]})
        self.assertEqual(received[0][0][0], "mine_ores")
        self.assertIs(received[0][1]["result"], result)
        self.assertEqual(received[0][1]["task_id"], "mine-return-1")

    async def test_survival_snapshot_forwards_fresh_return_safety(self):
        p = plugin()
        safety = {"safe": False, "loaded": True, "on_ground": True, "underground": True}

        async def call(method, params=None, **kwargs):
            return {"mining_return_safety": safety, "position": {"x": 0, "y": 60, "z": 0}} if method == "state.get" else {"items": {"coal": 2}}

        p.engine.call = call
        state = await p._life_state_snapshot()
        self.assertIs(state["mining_return_safety"], safety)
        self.assertEqual(state["position"]["y"], 60)

    async def test_disconnected_cached_terrain_is_not_fresh_return_evidence(self):
        p = plugin()
        for field in ("connected", "ready"):
            async def call(method, params=None, **kwargs):
                return {field: False, "health": 20, "food": 20, "position": {"x": 0, "y": 64, "z": 0},
                        "mining_return_safety": {"safe": True, "loaded": True, "on_ground": True, "underground": False}}

            p.engine.call = call
            state = await p._life_state_snapshot()
            self.assertNotIn("position", state)
            self.assertNotIn("mining_return_safety", state)

    async def test_respawn_releases_dead_before_delayed_death_notice_finishes(self):
        p = plugin()
        p._emergency_stopped = True
        p.life.pause(reason="急停", max_seconds=0)
        notifying, release = asyncio.Event(), asyncio.Event()

        async def notify(text):
            notifying.set()
            await release.wait()

        p._notify_subscribers = notify
        p._last_brief, p._last_brief_at = "死前的工具和位置", time.time()
        death = asyncio.create_task(p._on_bot_death({"position": {"x": 1, "y": 2, "z": 3}}))
        await asyncio.wait_for(notifying.wait(), timeout=1)
        self.assertTrue(p.life._dead)
        self.assertEqual(p.life.deaths, [{"x": 1, "y": 2, "z": 3}])
        self.assertEqual(p._last_brief, "")
        await p._on_bot_respawn({"position": {"x": 10}})
        self.assertFalse(p.life._dead)
        self.assertTrue(p.life.paused)
        self.assertTrue(p._emergency_stopped)
        release.set()
        await death
        await asyncio.gather(*list(p._background_tasks))
        self.assertFalse(p.life._dead, "晚到死亡通知不能重新锁住已经重生的机器人")
        self.assertEqual(len(p.life.deaths), 1)
        self.assertTrue(p.life.wakes)

    async def test_world_lifecycle_rejects_stale_ready_respawn_and_death(self):
        from test_life_recovery import make_loop

        p = plugin()
        p.life, _ = make_loop()
        p.life._todos = [{"text": "补回死亡物品", "done": False}]
        p.life.pause(reason="主人暂停", max_seconds=0)
        p.life.note_blocked("模型离线", retry_after=120)
        p.life._set_plan([{"skill": "mine_ores", "params": {"ore": "iron"}}])
        old_revision = p.life._plan_revision
        await p._on_bot_world_changed({"lifecycle_id": 2, "from_dimension": "overworld", "dimension": "the_nether"})
        self.assertGreater(p.life._plan_revision, old_revision)
        self.assertEqual(p.life._plan, [])
        self.assertTrue(p.life._world_changing)
        self.assertFalse(p.life.may_act(allow_model_block=True))
        await p._on_bot_world_ready({"lifecycle_id": 1, "dimension": "overworld"})
        self.assertTrue(p.life._world_changing)
        await p._on_bot_respawn({"lifecycle_id": 1})
        self.assertTrue(p.life._world_changing)
        await p._on_bot_world_ready({"lifecycle_id": 2, "dimension": "the_nether"})
        self.assertFalse(p.life._world_changing)
        self.assertTrue(p.life.paused)
        self.assertEqual(p.life._blocked_reason, "模型离线")
        self.assertEqual(p.life._todos[0]["text"], "补回死亡物品")
        self.assertFalse(p.life._dead)
        await p._on_bot_death({"lifecycle_id": 1})
        self.assertFalse(p.life._dead)
        p.life.note_dead(True)
        await p._on_bot_respawn({"lifecycle_id": 1})
        self.assertTrue(p.life._dead)
        await p._on_bot_respawn({"lifecycle_id": 3})
        self.assertFalse(p.life._dead)

    async def test_brief_cache_refreshes_on_respawn_and_disconnect(self):
        p = plugin()
        p.engine.state_brief = AsyncMock(return_value="新位置、新背包")
        p._last_brief, p._last_brief_at = "旧位置、旧背包", time.time()
        self.assertEqual(await p._get_brief(), "旧位置、旧背包")
        p.engine.state_brief.assert_not_awaited()
        await p._on_bot_respawn({})
        self.assertEqual(await p._get_brief(), "新位置、新背包")
        p.engine.state_brief.return_value = "【Bot 未进服】"
        await p._on_bot_disconnect({"manual": True})
        self.assertEqual(await p._get_brief(), "【Bot 未进服】")
        p.engine.running = False
        self.assertEqual(await p._get_brief(), "【引擎未运行】")

    async def test_inflight_brief_cannot_restore_old_session_cache(self):
        p = plugin()
        started, release = asyncio.Event(), asyncio.Event()
        calls = 0

        async def brief(goal):
            nonlocal calls
            calls += 1
            if calls == 1:
                started.set()
                await release.wait()
                return "死前的背包"
            return "重生后的空背包"

        p.engine.state_brief = brief
        reading = asyncio.create_task(p._get_brief())
        await started.wait()
        await p._on_bot_respawn({})
        release.set()
        self.assertEqual(await reading, "重生后的空背包")
        self.assertEqual(p._last_brief, "重生后的空背包")
        self.assertEqual(calls, 2)

    async def test_repeated_brief_changes_are_bounded(self):
        p = plugin()
        calls = 0

        async def brief(goal):
            nonlocal calls
            calls += 1
            p._invalidate_brief()
            return "过期状态"

        p.engine.state_brief = brief
        self.assertEqual(await p._get_brief(), "【状态正在变化，请重新观察】")
        self.assertEqual(calls, 2)
        self.assertEqual(p._last_brief, "")

    async def test_goal_preparation_keeps_autonomy_paused_after_old_task_finishes(self):
        for entry in ("command", "tool"):
            with self.subTest(entry=entry):
                p = plugin()
                p.config["announce_task_done"] = False
                preparing = asyncio.Event()
                release = asyncio.Event()

                class Goals:
                    active = False

                    async def start(self, goal):
                        preparing.set()
                        await release.wait()
                        self.active = True
                        return "目标已开始"

                p.goals = Goals()

                async def call(method, params=None, **kwargs):
                    if method == "task.cancel":
                        await p._on_task_finished({"name": "move", "kind": "action", "status": "cancelled"})
                    return {"ok": True}

                p.engine.call = call
                request = (p.cmd_goal(Event("/mc目标 盖个房子")) if entry == "command"
                           else p.tool_mc_set_goal(Event(), goal="盖个房子"))
                task = asyncio.create_task(results(request))
                try:
                    await asyncio.wait_for(preparing.wait(), timeout=2)
                    self.assertTrue(p.life.paused, "取消旧任务的完成回调不能释放目标准备期间的暂停")
                    self.assertEqual(p.life.pause_until, 0, "长期目标不能在十分钟后自动归还自主权")
                    await p._on_task_finished({"name": "move", "kind": "action", "status": "done"})
                    self.assertTrue(p.life.paused)
                    await p._on_goal_event("goal.done", {"goal": "旧目标"})
                    self.assertTrue(p.life.paused, "旧目标完成也不能释放新目标的准备暂停")
                finally:
                    release.set()
                    await task
                self.assertTrue(p.goals.active)
                self.assertTrue(p.life.paused)
                self.assertEqual(p._player_action_inflight, 0)

    async def test_goal_failure_restores_autonomy_for_both_entry_points(self):
        for entry in ("command", "tool"):
            with self.subTest(entry=entry):
                p = plugin()

                class Goals:
                    active = False

                    async def start(self, goal):
                        self.prepared_paused = p.life.paused
                        raise ValueError("无法规划目标")

                p.goals = Goals()
                reply = await results(p.cmd_goal(Event("/mc目标 未知目标")) if entry == "command"
                                      else p.tool_mc_set_goal(Event(), goal="未知目标"))
                self.assertTrue(p.goals.prepared_paused)
                self.assertIn("无法规划目标", reply[0])
                self.assertFalse(p.life.paused)
                self.assertEqual(p._player_action_inflight, 0)

    async def test_delayed_old_goal_notification_cannot_resume_new_goal(self):
        for event in ("goal.done", "goal.failed"):
            with self.subTest(event=event):
                p = plugin()
                notified = asyncio.Event()
                release = asyncio.Event()

                async def notify(text):
                    notified.set()
                    await release.wait()

                class Goals:
                    active = False

                    async def start(self, goal):
                        self.active = True
                        return "目标已开始"

                p.goals = Goals()
                p._notify_subscribers = notify
                task = asyncio.create_task(p._on_goal_event(event, {"goal": "旧目标"}))
                await asyncio.wait_for(notified.wait(), timeout=2)
                await p._start_player_goal("新目标")
                release.set()
                await task
                self.assertTrue(p.goals.active)
                self.assertTrue(p.life.paused)

    async def test_tool_cancel_all_pauses_before_rpc_and_resists_completion(self):
        p = plugin()
        p.config["announce_task_done"] = False

        async def stop():
            self.assertTrue(p._emergency_stopped)
            self.assertTrue(p.life.paused)
            self.assertEqual(p.life.pause_until, 0)
            await p._on_task_finished({"name": "move", "kind": "action", "status": "cancelled"})
            return {"cancelled": ["old-task"]}

        p.engine.safety_stop = stop
        reply = await results(p.tool_mc_task_cancel(Event()))
        self.assertIn("/mc继续", reply[0])
        self.assertTrue(p._emergency_stopped)
        self.assertTrue(p.life.paused)

    async def test_tool_cancel_all_without_engine_still_pauses_autonomy(self):
        p = plugin()
        p.engine.running = False
        await results(p.tool_mc_task_cancel(Event()))
        self.assertTrue(p._emergency_stopped)
        self.assertTrue(p.life.paused)
        self.assertEqual(p.life.pause_until, 0)

    async def test_goal_tools_cannot_bypass_emergency_stop(self):
        p = plugin()
        p.goals = type("Goals", (), {"start": AsyncMock(), "resume": AsyncMock(), "pause": AsyncMock(), "active": False})()
        await results(p.cmd_stop(Event()))
        for tool in (p.tool_mc_set_goal(Event(), goal="砍树"), p.tool_mc_goal_resume(Event())):
            reply = await results(tool)
            self.assertIn("急停", reply[0])
        p.goals.start.assert_not_awaited()
        p.goals.resume.assert_not_awaited()
        self.assertTrue(p.life.paused)

    async def test_emergency_during_goal_preparation_keeps_new_goal_paused(self):
        p = plugin()
        preparing = asyncio.Event()
        release = asyncio.Event()

        class Goals:
            active = False
            pause_calls = 0

            async def start(self, goal):
                preparing.set()
                await release.wait()
                self.active = True
                return "目标已开始"

            async def pause(self):
                self.pause_calls += 1
                return "目标已暂停"

        p.goals = Goals()
        task = asyncio.create_task(results(p.tool_mc_set_goal(Event(), goal="盖房子")))
        await asyncio.wait_for(preparing.wait(), timeout=2)
        await results(p.cmd_stop(Event()))
        release.set()
        reply = await task
        self.assertIn("急停", reply[0])
        self.assertEqual(p.goals.pause_calls, 2)
        self.assertTrue(p.life.paused)
        self.assertTrue(p._emergency_stopped)
        self.assertEqual(p._player_action_inflight, 0)

    async def test_manual_disconnect_is_not_reconnected(self):
        p = plugin()
        await p._do_disconnect()
        await p._supervise_tick()
        self.assertFalse(p.connected)
        self.assertEqual(p.engine.connect_count, 0)
        self.assertTrue(p._manual_disconnect_requested)

    async def test_unload_cancels_callbacks_and_rejects_late_work(self):
        p = plugin()
        p._supervise_task = None
        p.life.stop = AsyncMock()
        p.engine.stop = AsyncMock()
        task = p._spawn_background(asyncio.sleep(60), name="test-delayed-work")
        await asyncio.sleep(0)
        await p.terminate()
        self.assertTrue(task.cancelled())
        self.assertEqual(p._background_tasks, set())
        self.assertIsNone(p._spawn_background(asyncio.sleep(60), name="test-too-late"))

    async def test_emergency_pause_survives_task_and_goal_callbacks(self):
        p = plugin()
        await results(p.cmd_stop(Event()))
        await p._on_task_finished({"name": "move", "kind": "action", "status": "cancelled"})
        await p._on_goal_event("goal.done", {"goal": "test"})
        self.assertTrue(p.life.paused)
        self.assertEqual(p.life.pause_until, 0)
        self.assertTrue(p._emergency_stopped)
        self.assertTrue(p.engine.stopped)

    async def test_resume_without_goal_restores_autonomy(self):
        p = plugin()
        await results(p.cmd_stop(Event()))
        reply = await results(p.cmd_resume(Event()))
        self.assertFalse(p._emergency_stopped)
        self.assertFalse(p.engine.stopped)
        self.assertFalse(p.life.paused)
        self.assertIn("自主游玩", reply[0])

    async def test_reflex_result_does_not_resume_or_fail_plan(self):
        p = plugin()
        p.life.pause(reason="玩家正在安排动作")
        for status in ("done", "failed", "cancelled"):
            await p._on_task_finished({"name": "吃东西", "kind": "reflex", "status": status})
            self.assertTrue(p.life.paused)
            self.assertEqual(p.life.task_results, [])

    async def test_old_skill_result_does_not_release_player_preparation(self):
        p = plugin()
        p.config["announce_task_done"] = False
        p.life.pause(reason="玩家正在安排动作")
        p._player_action_inflight = 1
        await p._on_task_finished({"name": "砍树", "kind": "skill", "status": "done"})
        self.assertTrue(p.life.paused)

    async def test_restart_reapplies_emergency_stop(self):
        p = plugin()
        p.config["auto_connect"] = False
        await results(p.cmd_stop(Event()))
        p.engine.running = False
        p.engine.stopped = False
        await p._supervise_tick()
        self.assertTrue(p.engine.stopped)
        self.assertTrue(p.life.paused)

    async def test_resume_failure_keeps_control_stopped(self):
        p = plugin()
        await results(p.cmd_stop(Event()))
        class Goals:
            async def resume(self):
                raise RuntimeError("cannot restore goal")
        p.goals = Goals()
        await results(p.cmd_resume(Event()))
        self.assertTrue(p._emergency_stopped)
        self.assertTrue(p.life.paused)
        self.assertTrue(p.engine.stopped)

    async def test_busy_reply_does_not_drop_second_instruction(self):
        p = plugin()
        started = asyncio.Event()
        release = asyncio.Event()
        handled = []
        class Agent:
            async def handle(self, sender, message):
                handled.append(message)
                if message == "first":
                    started.set()
                    await release.wait()
                return message
        p.game_agent = Agent()
        first = asyncio.create_task(p._reply_in_game("Alice", "first"))
        await started.wait()
        second = asyncio.create_task(p._reply_in_game("Alice", "second"))
        await asyncio.sleep(0)
        self.assertFalse(second.done())
        release.set()
        await asyncio.gather(first, second)
        self.assertEqual(handled, ["first", "second"])
        self.assertEqual([call.args[0] for call in p.engine.say.call_args_list], ["first", "second"])

    async def test_addressed_chat_has_one_execution_owner(self):
        p = plugin()
        p._reply_in_game = AsyncMock()
        await p._on_game_chat({"sender": "Alice", "message": "AstrBot 砍树"})
        await asyncio.gather(*list(p._background_tasks))
        self.assertEqual(p.life.owners, [])
        p._reply_in_game.assert_awaited_once()
        await p._on_game_chat({"sender": "Alice", "message": "附近发现了一棵树"})
        self.assertEqual(len(p.life.owners), 1)

    async def test_failed_reply_after_action_does_not_replay_instruction(self):
        p = plugin()
        class Agent:
            last_request_had_action = True

            async def handle(self, sender, message):
                raise RuntimeError("模型在动作提交后断开")
        p.game_agent = Agent()
        await p._reply_in_game("Alice", "砍四根木头")
        self.assertEqual(p.life.owners, [])
        p.engine.say.assert_awaited_once()


if __name__ == "__main__":
    unittest.main(verbosity=2)
