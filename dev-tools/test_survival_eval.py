"""持续生存评测汇总逻辑离线回归，不连接 Minecraft 或模型端点。"""
from __future__ import annotations

import asyncio
import copy
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import _paths
from survival_eval import EvaluationLifecycle, SurvivalMetrics, build_host, distribution, model_environment, run


def body(food=20, health=20, x=0, connected=True, daytime=6000):
    return {"connected": connected, "ready": connected, "food": food, "health": health,
            "position": {"x": x, "y": 64, "z": 0}, "time_of_day": daytime}


class MetricsTests(unittest.TestCase):
    def test_unknown_data_does_not_become_zero(self):
        report = SurvivalMetrics().summary()
        self.assertIsNone(report["minimum_food"])
        self.assertIsNone(report["minimum_health"])
        self.assertIsNone(report["skill_handoff_seconds"]["mean"])
        json.dumps(report, allow_nan=False)

    def test_hunger_coverage_uses_previous_valid_sample(self):
        metrics = SurvivalMetrics()
        metrics.sample(0, body(food=5, health=7), {}, model_waiting=True)
        metrics.sample(5, body(food=0, health=6), {}, model_waiting=False)
        metrics.sample(10, body(food=20, health=20), {})
        report = metrics.summary()
        self.assertEqual(report["observed_connected_seconds"], 10)
        self.assertEqual(report["hungry_seconds_food_le_6"], 10)
        self.assertEqual(report["starving_seconds_food_zero"], 5)
        self.assertEqual(report["sampled_model_wait_seconds"], 5)
        self.assertEqual(report["minimum_health"], 6)

    def test_disconnected_and_missing_samples_not_inferred(self):
        metrics = SurvivalMetrics()
        metrics.sample(0, body(food=0), {})
        metrics.sample(5, body(food=0, connected=False), {})
        metrics.sample(10, body(food=0), {})
        metrics.sample(30, body(food=0), {})
        self.assertEqual(metrics.summary()["starving_seconds_food_zero"], 0)
        self.assertEqual(metrics.summary()["observed_connected_seconds"], 0)

    def test_stationary_work_candidates_only_once_per_episode(self):
        metrics = SurvivalMetrics(stationary_seconds=10)
        for at in (0, 5, 10, 15):
            metrics.sample(at, body(), {}, working=True)
        self.assertEqual(metrics.stationary_work_episodes, 1)
        metrics.sample(20, body(x=1), {}, working=True)
        for at in (25, 30, 35):
            metrics.sample(at, body(x=1), {}, working=True)
        self.assertEqual(metrics.stationary_work_episodes, 2)

    def test_new_inventory_and_idle_break_stationary_episode(self):
        metrics = SurvivalMetrics(stationary_seconds=10)
        metrics.sample(0, body(), {}, working=True)
        metrics.sample(5, body(), {}, working=True)
        metrics.sample(10, body(), {"oak_log": 1}, working=True)
        metrics.sample(15, body(), {"oak_log": 1}, working=False)
        self.assertEqual(metrics.stationary_work_episodes, 0)

    def test_terminal_events_deduplicated_and_reflex_excluded(self):
        metrics = SurvivalMetrics()
        result = {"task_id": "a", "status": "done", "kind": "skill", "duration_ms": 1200}
        metrics.task_finished(result, 2)
        metrics.task_finished(result, 2.1)
        metrics.task_finished({**result, "task_id": "reflex", "kind": "reflex"}, 3)
        self.assertEqual(metrics.tasks["done"], 1)
        self.assertEqual(metrics.task_durations, [1.2])

    def test_skill_receipt_and_handoff_gap(self):
        metrics = SurvivalMetrics()
        metrics.task_submitted("first", 0)
        metrics.task_finished({"task_id": "first", "status": "done", "kind": "skill"}, 10)
        metrics.task_submitted("second", 12)
        metrics.task_submitted("second", 12.1)
        self.assertEqual(metrics.tasks["submitted"], 2)
        self.assertEqual(metrics.task_gaps, [2])

    def test_cancelled_and_nested_failure_counted_without_error_text(self):
        metrics = SurvivalMetrics()
        metrics.task_finished({"task_id": "cancel", "status": "cancelled", "kind": "skill"}, 0)
        metrics.task_finished({"task_id": "false_ok", "status": "done", "kind": "skill",
                               "result": {"ok": False}, "error": "private-error-text"}, 1)
        self.assertEqual(metrics.tasks["cancelled"], 1)
        self.assertEqual(metrics.tasks["failed"], 1)
        self.assertNotIn("private-error-text", json.dumps(metrics.summary()))

    def test_three_same_failures_flag_repetition_then_success_resets(self):
        metrics = SurvivalMetrics()
        for index in range(4):
            metrics.task_finished({"task_id": str(index), "kind": "skill", "status": "failed",
                                   "meta": {"skill": "chop_tree"}}, index)
        self.assertEqual(metrics.repeated_failures, 2)
        metrics.task_finished({"task_id": "success", "kind": "skill", "status": "done"}, 5)
        metrics.task_finished({"task_id": "again", "kind": "skill", "status": "failed",
                               "meta": {"skill": "chop_tree"}}, 6)
        self.assertEqual(metrics.repeated_failures, 2)

    def test_arbitrary_task_name_and_error_never_reported(self):
        metrics = SurvivalMetrics()
        metrics.task_finished({"task_id": "id", "kind": "action", "status": "failed",
                               "name": "private-task-title", "meta": {"skill": "bad-secret/value"},
                               "error": "private-error"}, 0)
        report = json.dumps(metrics.summary())
        self.assertNotIn("private", report)
        self.assertNotIn("secret", report)
        self.assertEqual(metrics.failures["other"], 1)

    def test_observed_daylight_progress(self):
        metrics = SurvivalMetrics()
        metrics.sample(0, body(daytime=23999), {})
        metrics.sample(5, body(daytime=99), {})
        self.assertTrue(metrics.summary()["daylight_changed"])

    def test_percentile_deterministic(self):
        self.assertEqual(distribution([5, 1, 3]), {"samples": 3, "mean": 3, "p95": 5, "max": 5})

    def test_model_configuration_only_explicit_environment(self):
        names = ("ASTRCRAFT_EVAL_ENDPOINT", "ASTRCRAFT_EVAL_MODEL", "ASTRCRAFT_EVAL_API_KEY")
        with patch.dict(os.environ, {name: "" for name in names}):
            values, missing = model_environment()
        self.assertEqual(values, ["", "", ""])
        self.assertEqual(missing, list(names))

    @unittest.skipUnless(_paths.astrbot_available(), "需要 AstrBot 运行时验证生产组件接线")
    def test_real_component_assembly_without_model_or_server_requests(self):
        # 加载真实装饰器 schema；只组装，不启动 Node 或发请求。
        _paths.plugin_module("main")
        from astrbot.core.provider.func_tool_manager import FunctionToolManager
        from astrbot.core.star.register.star_handler import llm_tools

        manager = FunctionToolManager()
        manager.func_list = [copy.copy(tool) for tool in llm_tools.func_list
                             if getattr(tool, "name", "").startswith("mc_")]
        context = SimpleNamespace(provider_manager=SimpleNamespace(llm_tools=manager))
        args = SimpleNamespace(test_host="explicit-test-host", test_port=25566)
        with tempfile.TemporaryDirectory(prefix="eval-wiring-") as scratch:
            host = build_host(context, scratch, args)
            self.assertIsInstance(host.life, _paths.plugin_module("life").LifeLoop)
            self.assertIsInstance(host.life.action_agent, _paths.plugin_module("action_agent").ActionAgent)
            self.assertIsInstance(host.engine, _paths.plugin_module("bridge_client").EngineClient)
            self.assertFalse(host.engine.running)
            self.assertIsNotNone(host.life.action_agent._toolset())
            self.assertIsNotNone(host.life.perception._toolset())
            self.assertIs(manager.get_func("mc_plan_do").handler.args[0], host)
            self.assertEqual(host.engine._cfg.extra_env["MC_DATA_DIR"], scratch)
            asyncio.run(host.life.stop())


@unittest.skipUnless(_paths.astrbot_available(), "需要 AstrBot 运行时验证生产生命周期")
class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from astrbot.core.provider.func_tool_manager import FunctionToolManager

        self.scratch = tempfile.TemporaryDirectory(prefix="eval-lifecycle-")
        self.args = SimpleNamespace(test_host="explicit-test-host", test_port=25566)
        context = SimpleNamespace(provider_manager=SimpleNamespace(llm_tools=FunctionToolManager()))
        self.host = build_host(context, self.scratch.name, self.args)
        self.host.life.start = Mock()
        self.host.life.share_event = AsyncMock()
        self.host._on_game_chat = AsyncMock()
        self.host.engine.safety_stop = AsyncMock()
        self.current = {**body(), "gamemode": "survival"}
        self.inventory = {"items": {}}

        async def call(method, params=None, **kwargs):
            if method == "state.get":
                return self.current
            if method == "inventory.get":
                return self.inventory
            return {}

        self.host.engine.call = AsyncMock(side_effect=call)
        self.lifecycle = EvaluationLifecycle(self.host)

    async def asyncTearDown(self):
        self.lifecycle.close()
        await self.host.life.stop()
        for task in list(self.host._background_tasks):
            task.cancel()
        if self.host._background_tasks:
            await asyncio.gather(*self.host._background_tasks, return_exceptions=True)
        self.scratch.cleanup()

    async def emit(self, event, payload):
        for callback in self.host.engine._handlers.get(event, []):
            await callback(payload)

    async def activate(self):
        await self.emit("bot.spawn", {"lifecycle_id": 1, "position": {}, "username": "Eval"})
        await self.lifecycle.start_verified(self.current, self.inventory)

    async def test_spawn_and_chat_cannot_start_before_initial_verification(self):
        # 模拟真正能触发回复的点名，回调被初始化门闩挡住。
        await self.emit("bot.spawn", {"lifecycle_id": 1, "position": {}})
        await self.emit("chat", {"sender": "owner", "message": f"{self.host._cfg('bot_username')} 继续并砍树"})
        self.assertFalse(self.lifecycle.ready)
        self.assertTrue(self.host._emergency_stopped)
        self.assertTrue(self.host.life.paused)
        self.assertFalse(self.host._cfg("enable_life_loop"))
        self.host.life.start.assert_not_called()
        self.host._on_game_chat.assert_not_awaited()
        self.assertEqual(self.host.engine.call.await_count, 0)

        with patch.object(self.host.life, "on_session_start", wraps=self.host.life.on_session_start) as session:
            await self.lifecycle.start_verified(self.current, self.inventory)
        session.assert_called_once()
        self.host.life.start.assert_called_once()
        self.assertTrue(self.lifecycle.ready)
        self.assertFalse(self.host._emergency_stopped)
        self.assertFalse(self.host.life.paused)
        self.assertEqual(self.host._bot_lifecycle_id, 1)
        self.assertEqual(sum(call.args[0] == "safety.resume" for call in self.host.engine.call.await_args_list), 1)

    async def test_death_disconnect_then_spawn_clears_dead_and_old_session(self):
        await self.activate()
        await self.emit("bot.death", {"lifecycle_id": 2, "position": {"x": 0, "y": 64, "z": 0}})
        self.assertTrue(self.host.life._dead)
        await self.emit("bot.disconnect", {"reason": "test", "manual": False})
        self.assertFalse(self.host.connected)
        self.host.life._intention = "旧身体的打算"
        revision = self.host.life._plan_revision
        await self.emit("bot.spawn", {"lifecycle_id": 3, "position": {}, "username": "Eval"})
        self.assertTrue(self.host.connected)
        self.assertFalse(self.host.life._dead)
        self.assertEqual(self.host.life._intention, "")
        self.assertGreater(self.host.life._plan_revision, revision)
        self.assertEqual(self.host._bot_lifecycle_id, 3)

    async def test_respawn_preserves_owner_pause_and_engine_disconnect_updates_host(self):
        await self.activate()
        await self.emit("bot.death", {"lifecycle_id": 2, "position": {}})
        self.host._owner_paused = True
        self.host.life.pause(reason="主人暂停", max_seconds=0)
        await self.emit("bot.respawn", {"lifecycle_id": 3})
        self.assertFalse(self.host.life._dead)
        self.assertTrue(self.host.life.paused)
        await self.host.engine.on_disconnected("test engine stopped")
        self.assertFalse(self.host.connected)
        self.assertEqual(self.host._last_brief, "")

    async def test_initial_inventory_or_body_change_cannot_release_emergency(self):
        await self.emit("bot.spawn", {"lifecycle_id": 1, "position": {}})
        with self.assertRaisesRegex(RuntimeError, "fresh_survival_player_required"):
            await self.lifecycle.start_verified(self.current, {"items": {"bread": 1}})
        self.host.life.start.assert_not_called()
        self.assertTrue(self.host._emergency_stopped)

        real_spawn = self.host._on_bot_spawn

        async def changing_spawn(data):
            await real_spawn(data)
            await self.emit("bot.death", {"lifecycle_id": 2, "position": {}})

        self.host._on_bot_spawn = changing_spawn
        with self.assertRaisesRegex(RuntimeError, "body_changed_during_initial_verification"):
            await self.lifecycle.start_verified(self.current, {"items": {}})
        self.host.life.start.assert_not_called()
        self.assertFalse(self.lifecycle.ready)
        self.assertFalse(any(call.args[0] == "safety.resume" for call in self.host.engine.call.await_args_list))

    async def test_initial_failure_and_cancel_cleanup_real_host_without_requests(self):
        # 跑实际 run() 的失败/取消出口，替换的只有外部服务器、模型与子进程。
        from astrbot.core.provider.sources import openai_source
        from lib import rcon

        class FixtureEngine:
            def __init__(self, mode):
                self._handlers = {}
                self.on_disconnected = None
                self.running = False
                self.mode = mode
                self.safety_stop = AsyncMock()
                self.stop_calls = 0
                self.resume_calls = 0

            def on(self, event, callback):
                self._handlers.setdefault(event, []).append(callback)

            def off_all(self):
                self._handlers.clear()

            async def start(self):
                self.running = True

            async def stop(self):
                self.stop_calls += 1
                self.running = False

            async def call(self, method, params=None, **kwargs):
                if method == "connect":
                    for callback in self._handlers.get("bot.spawn", []):
                        await callback({"lifecycle_id": 1, "position": {}, "username": "Eval"})
                    return {}
                if method == "state.get":
                    if self.mode == "cancel":
                        raise asyncio.CancelledError()
                    return {**body(), "gamemode": "survival"}
                if method == "inventory.get":
                    return {"items": {"bread": 1}}
                if method == "safety.resume":
                    self.resume_calls += 1
                return {}

        for mode, status in (("invalid_inventory", "failed"), ("cancel", "interrupted")):
            with self.subTest(mode=mode):
                provider = SimpleNamespace(text_chat=AsyncMock(), terminate=AsyncMock())
                wire = SimpleNamespace(command=lambda cmd: ("normal" if cmd == "difficulty" else
                    "false" if cmd == "gamerule keepInventory" else "true"), close=Mock())
                engine = FixtureEngine(mode)
                captured = []

                def fixture_host(context, scratch, args):
                    host = build_host(context, scratch, args)
                    host.engine = engine
                    host.life.start = Mock()
                    captured.append(host)
                    return host

                with tempfile.TemporaryDirectory(prefix="eval-failure-") as output:
                    args = SimpleNamespace(test_host="explicit-test-host", test_port=25566, rcon_port=25576,
                        minutes=.01, poll_seconds=5, stationary_seconds=120, model_timeout=120,
                        interventions=None, mc_version="1.20.1", report=Path(output) / "report.json")
                    with patch.dict(os.environ, {"ASTRCRAFT_EVAL_RCON_PASSWORD": "fixture"}), \
                            patch.object(openai_source, "ProviderOpenAIOfficial", return_value=provider), \
                            patch.object(rcon, "Rcon", return_value=wire), \
                            patch("survival_eval.build_host", side_effect=fixture_host):
                        exit_code = await run(args, ["https://fixture.invalid/v1", "fixture", "fixture"])
                    report = json.loads(args.report.read_text(encoding="utf-8"))
                self.assertEqual(exit_code, 1)
                self.assertEqual(report["status"], status)
                self.assertEqual(report["model"]["calls"], 0)
                captured[0].life.start.assert_not_called()
                self.assertEqual(engine.stop_calls, 1)
                self.assertEqual(engine.resume_calls, 0)
                self.assertFalse(engine.running)
                self.assertEqual(engine._handlers, {})
                self.assertIsNone(engine.on_disconnected)
                provider.terminate.assert_awaited_once()
                wire.close.assert_called_once()


if __name__ == "__main__":
    unittest.main(verbosity=2)
