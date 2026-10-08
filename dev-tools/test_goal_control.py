"""GoalManager and plugin control regressions with deterministic engine I/O."""
from __future__ import annotations

import asyncio
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _paths

_paths.require_astrbot("test_goal_control")
goals = _paths.plugin_module("goals")
from test_plugin_control import plugin

_sleep = asyncio.sleep


async def fast_sleep(seconds):
    await _sleep(min(seconds, 0.01))


class EngineIO:
    def __init__(self):
        self.tasks = {}
        self.submitted = []
        self.entered = asyncio.Event()
        self.done_after_resume = False
        self.submit_release = None

    async def __call__(self, method, params, **kwargs):
        if method == "skill.list":
            return {"skills": ["chop_tree(count=8)"], "names": ["chop_tree"]}
        if method == "skill.run":
            self.submitted.append(params)
            task_id = f"task-{len(self.submitted)}"
            self.tasks[task_id] = "done" if self.done_after_resume and len(self.submitted) > 1 else "running"
            self.entered.set()
            if self.submit_release:
                await self.submit_release.wait()
            return {"task_id": task_id}
        if method == "task.cancel":
            for key in self.tasks:
                if not params.get("task_id") or key == params["task_id"]:
                    self.tasks[key] = "cancelled"
            return {"ok": True}
        if method == "task.status":
            return {"status": self.tasks[params["task_id"]], "result": {"ok": True}}
        return {"ok": True}


class GoalControlTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.sleep_patch = patch.object(goals.asyncio, "sleep", fast_sleep)
        self.sleep_patch.start()
        self.managers = []

    async def asyncTearDown(self):
        for manager in self.managers:
            await manager.stop()
        self.sleep_patch.stop()

    def manager(self, rpc, planner=None):
        manager = goals.GoalManager(engine_call=rpc, llm_planner=planner)
        self.managers.append(manager)
        return manager

    def test_stone_goal_uses_registered_stone_skill(self):
        for text in ("挖5个圆石", "挖5个石头", "挖5个stone"):
            with self.subTest(text=text):
                plan = goals.plan_from_text(text)
                self.assertEqual(plan.steps[0].skill, "mine_stone")
                self.assertEqual(plan.steps[0].params, {"count": 5})
        iron = goals.plan_from_text("挖5个铁矿")
        self.assertEqual(iron.steps[0].skill, "mine_ores")
        self.assertEqual(iron.steps[0].params, {"ore": "iron", "count": 5})

    async def slow_plan(self, manager, rpc, release):
        entered = asyncio.Event()
        async def planner(*args):
            entered.set()
            await release.wait()
            return json.dumps([{"skill": "chop_tree", "params": {"count": 8}}])
        manager._llm_planner = planner
        task = asyncio.create_task(manager.start("custom goal without a template"))
        await entered.wait()
        return task

    async def test_latest_start_wins_when_old_model_returns_last(self):
        rpc, release = EngineIO(), asyncio.Event()
        manager = self.manager(rpc)
        old = await self.slow_plan(manager, rpc, release)
        await manager.start(plan=goals.GoalPlan("new", [goals.GoalStep("chop_tree", {"count": 3})]))
        new_runner = manager._task
        await rpc.entered.wait()
        release.set()
        self.assertIn("取消", await old)
        self.assertEqual(manager.plan.goal, "new")
        self.assertIs(manager._task, new_runner)
        self.assertEqual([p["params"]["count"] for p in rpc.submitted], [3])

    async def test_model_ignoring_cancellation_cannot_overwrite_new_plan(self):
        rpc = EngineIO()
        entered, release, cancelled = asyncio.Event(), asyncio.Event(), asyncio.Event()
        async def planner(*args):
            entered.set()
            try:
                await release.wait()
            except asyncio.CancelledError:
                cancelled.set()
                await release.wait()
            return '[{"skill":"chop_tree","params":{"count":8}}]'
        manager = self.manager(rpc, planner)
        old = asyncio.create_task(manager.start("custom unknown goal"))
        await entered.wait()
        await manager.start(plan=goals.GoalPlan("new", [goals.GoalStep("chop_tree", {"count": 3})]))
        await cancelled.wait()
        new_runner = manager._task
        release.set()
        self.assertIn("取消", await old)
        self.assertIs(manager._task, new_runner)
        self.assertEqual(manager.plan.goal, "new")
        self.assertEqual([p["params"]["count"] for p in rpc.submitted], [3])

    async def test_pending_plan_invalidated_without_existing_plan(self):
        for action in ("pause", "abandon", "stop"):
            with self.subTest(action=action):
                rpc, release = EngineIO(), asyncio.Event()
                manager = self.manager(rpc)
                pending = await self.slow_plan(manager, rpc, release)
                await getattr(manager, action)()
                release.set()
                self.assertIn("取消", await pending)
                self.assertIsNone(manager.plan)
                self.assertEqual(rpc.submitted, [])

    async def test_cancelled_start_does_not_leave_runner(self):
        rpc, release = EngineIO(), asyncio.Event()
        manager = self.manager(rpc)
        pending = await self.slow_plan(manager, rpc, release)
        pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)
        release.set()
        self.assertIsNone(manager._task)

    async def test_abandon_releases_pending_model_without_waiting_for_response(self):
        rpc, release = EngineIO(), asyncio.Event()
        manager = self.manager(rpc)
        pending = await self.slow_plan(manager, rpc, release)
        await manager.abandon()
        self.assertIn("取消", await asyncio.wait_for(pending, 0.5))
        self.assertFalse(release.is_set())
        self.assertEqual(manager._planning_tasks, set())

    async def test_rapid_resume_pause_keeps_previous_checkpoint_reference(self):
        rpc = EngineIO()
        manager = self.manager(rpc)
        await manager.start(plan=goals.GoalPlan("logs", [goals.GoalStep("chop_tree", {"count": 8}, max_attempts=1)]))
        await rpc.entered.wait()
        await manager.pause()
        await fast_sleep(1)
        task_id = manager._resume_task_id
        await manager.resume()
        await manager.pause()
        self.assertEqual(manager._resume_task_id, task_id)
        rpc.done_after_resume = True
        await manager.resume()
        await asyncio.wait_for(manager._task, 2)
        self.assertEqual(manager.status, goals.GOAL_DONE)
        self.assertEqual(rpc.submitted[-1]["resume_task_id"], task_id)

    async def test_repeated_pauses_preserve_attempt_budget_and_checkpoint(self):
        rpc = EngineIO()
        manager = self.manager(rpc)
        await manager.start(plan=goals.GoalPlan("eight logs", [goals.GoalStep("chop_tree", {"count": 8}, max_attempts=1)]))
        await rpc.entered.wait()
        for index in range(3):
            task_id = manager.current_task_id
            await manager.pause()
            await fast_sleep(1)
            self.assertEqual(manager.attempt, 0)
            self.assertEqual(manager.status, goals.GOAL_PAUSED)
            self.assertIsNone(manager.last_error)
            rpc.entered.clear()
            if index == 2:
                rpc.done_after_resume = True
            await manager.resume()
            await rpc.entered.wait()
            self.assertEqual(rpc.submitted[-1]["resume_task_id"], task_id)
        await asyncio.wait_for(manager._task, 2)
        self.assertEqual(manager.status, goals.GOAL_DONE)
        self.assertEqual(sum(e.get("cancelled", False) for e in manager.log), 3)

    async def test_pause_while_skill_submission_waits_cancels_returned_task(self):
        rpc = EngineIO()
        rpc.submit_release = asyncio.Event()
        manager = self.manager(rpc)
        await manager.start(plan=goals.GoalPlan("logs", [goals.GoalStep("chop_tree", {"count": 8}, max_attempts=1)]))
        await rpc.entered.wait()
        await manager.pause()
        rpc.submit_release.set()
        await fast_sleep(1)
        self.assertEqual(rpc.tasks["task-1"], "cancelled")
        self.assertEqual(manager.attempt, 0)
        rpc.done_after_resume = True
        await manager.resume()
        await asyncio.wait_for(manager._task, 2)
        self.assertEqual(manager.status, goals.GOAL_DONE)
        self.assertEqual(rpc.submitted[-1]["resume_task_id"], "task-1")

    async def test_actual_failure_still_exhausts_single_attempt(self):
        rpc = EngineIO()
        manager = self.manager(rpc)
        await manager.start(plan=goals.GoalPlan("logs", [goals.GoalStep("chop_tree", max_attempts=1)]))
        await rpc.entered.wait()
        rpc.tasks["task-1"] = "failed"
        await asyncio.wait_for(manager._task, 2)
        self.assertEqual(manager.status, goals.GOAL_FAILED)
        self.assertFalse(manager.log[0].get("cancelled"))

    async def test_verify_cannot_be_overridden_by_payload_ok(self):
        rpc = EngineIO()
        manager = self.manager(rpc)
        await manager.start(plan=goals.GoalPlan("verified", [goals.GoalStep("chop_tree", verify=lambda _: False, max_attempts=1)]))
        await rpc.entered.wait()
        rpc.tasks["task-1"] = "done"
        await asyncio.wait_for(manager._task, 2)
        self.assertEqual(manager.status, goals.GOAL_FAILED)

    async def test_player_controls_invalidate_model_plan_before_any_skill(self):
        for action in ("_do_disconnect", "_pause_play", "_emergency_stop", "_abandon_goal"):
            with self.subTest(action=action):
                p, rpc = plugin(), EngineIO()
                entered, release = asyncio.Event(), asyncio.Event()
                async def planner(*args):
                    entered.set()
                    await release.wait()
                    return '[{"skill":"chop_tree","params":{"count":8}}]'
                p.engine.call = rpc
                p.goals = self.manager(p._engine_call, planner)
                pending = asyncio.create_task(p._start_player_goal("custom goal without a template"))
                await entered.wait()
                await getattr(p, action)()
                release.set()
                with self.assertRaises(RuntimeError):
                    await pending
                self.assertFalse(p.goals.active)
                self.assertEqual(rpc.submitted, [])
                self.assertEqual(p._player_action_inflight, 0)
                if action != "_abandon_goal":
                    self.assertTrue(p.life.paused)

    async def test_pause_then_resume_does_not_resurrect_old_model_request(self):
        p, rpc = plugin(), EngineIO()
        entered, release = asyncio.Event(), asyncio.Event()
        async def planner(*args):
            entered.set()
            await release.wait()
            return '[{"skill":"chop_tree","params":{"count":8}}]'
        p.engine.call = rpc
        p.goals = self.manager(p._engine_call, planner)
        pending = asyncio.create_task(p._start_player_goal("custom goal without a template"))
        await entered.wait()
        await p._pause_play()
        await p._resume_play()
        release.set()
        with self.assertRaisesRegex(RuntimeError, "取消"):
            await pending
        self.assertEqual(rpc.submitted, [])
        self.assertFalse(p.goals.active)

    async def test_fast_reconnect_does_not_restore_pre_disconnect_plan(self):
        p, rpc = plugin(), EngineIO()
        entered, release = asyncio.Event(), asyncio.Event()
        async def planner(*args):
            entered.set()
            await release.wait()
            return '[{"skill":"chop_tree","params":{"count":8}}]'
        p.engine.call = rpc
        p.goals = self.manager(p._engine_call, planner)
        pending = asyncio.create_task(p._start_player_goal("custom goal without a template"))
        await entered.wait()
        await p._do_disconnect()
        p._manual_disconnect_requested = False
        p.connected = True
        release.set()
        with self.assertRaisesRegex(RuntimeError, "取消"):
            await pending
        self.assertEqual(rpc.submitted, [])
        self.assertFalse(p.goals.active)

    async def test_respawn_after_manual_reconnect_releases_only_disconnect_pause(self):
        for held in (None, "_owner_paused", "_emergency_stopped"):
            with self.subTest(held=held):
                p = plugin()
                p.life.running = True
                p.life.on_session_start = Mock()
                p._push_engine_settings = AsyncMock()
                if held:
                    setattr(p, held, True)
                await p._do_disconnect()
                self.assertTrue(p.life.paused)
                p._manual_disconnect_requested = False
                await p._on_bot_spawn({"username": "test", "version": "1.20.1", "lifecycle_id": 2})
                self.assertEqual(p.life.paused, bool(held))
                p.life.on_session_start.assert_called_once()

    async def test_invalid_restore_reference_never_falls_back_to_new_batch(self):
        rpc = EngineIO()
        original = rpc.__call__
        async def rejecting_restore(method, params, **kwargs):
            if method == "skill.run" and params.get("resume_task_id"):
                raise RuntimeError("old body invalidated")
            return await original(method, params, **kwargs)
        manager = self.manager(rejecting_restore)
        await manager.start(plan=goals.GoalPlan("logs", [goals.GoalStep("chop_tree", {"count": 8}, max_attempts=3)]))
        await rpc.entered.wait()
        await manager.pause()
        await manager.resume()
        await asyncio.wait_for(manager._task, 2)
        self.assertEqual(manager.status, goals.GOAL_FAILED)
        self.assertEqual(len(rpc.submitted), 1)
        self.assertIn("old body invalidated", manager.last_error)

    async def test_completed_noncollection_step_does_not_repeat_side_effect(self):
        rpc = EngineIO()
        manager = self.manager(rpc)
        await manager.start(plan=goals.GoalPlan("craft", [goals.GoalStep("craft", {"item": "torch", "count": 8}, max_attempts=1)]))
        await rpc.entered.wait()
        await manager.pause()
        # The server completed before observing the cancellation packet.
        rpc.tasks["task-1"] = "done"
        await manager.resume()
        await asyncio.wait_for(manager._task, 2)
        self.assertEqual(manager.status, goals.GOAL_DONE)
        self.assertEqual(len(rpc.submitted), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
