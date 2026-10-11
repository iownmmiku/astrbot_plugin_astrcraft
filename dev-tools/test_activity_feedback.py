"""Drive feedback follows a matching actual completion, not model prose."""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_life_recovery as R
from astrcraft_plugin import drives as D
from astrcraft_plugin.action_agent import _ActionEvent
from test_plugin_control import plugin


class ActivityFeedbackTests(unittest.IsolatedAsyncioTestCase):
    def loop(self, drive="gather"):
        loop, _ = R.make_loop()
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        loop.drives = D.DriveSystem(Path(directory.name), drives=[D.Drive(key=drive, label=drive,
            level=0.7, drop_on_satisfy=0.6, rise_per_hour=0)])
        return loop

    def level(self, loop):
        return next(iter(loop.drives._drives.values())).level

    async def submit(self, loop, *, fail=False, early=False):
        async def engine(method, params=None, **kwargs):
            if fail:
                raise RuntimeError("engine rejected submission")
            if early:
                loop.note_task_result("chop_tree", True, task_id="task-1", result={"ok": True})
            return {"task_id": "task-1"}
        loop._call = engine
        await loop._act(R.L.LifeDecision(activity="收集木材", drive="gather", skill="chop_tree", params={"count": 1}))

    async def test_rejected_and_queued_actions_do_not_satisfy_drive(self):
        for fail in (True, False):
            with self.subTest(fail=fail):
                loop = self.loop()
                await self.submit(loop, fail=fail)
                self.assertEqual(self.level(loop), 0.7)

    async def test_matching_success_satisfies_once_and_failed_result_does_not(self):
        loop = self.loop()
        await self.submit(loop)
        loop.note_task_result("chop_tree", True, task_id="task-1", result={"ok": True})
        self.assertAlmostEqual(self.level(loop), 0.1)
        loop.note_task_result("chop_tree", True, task_id="task-1", result={"ok": True})
        self.assertAlmostEqual(self.level(loop), 0.1)
        loop = self.loop()
        await self.submit(loop)
        loop.note_task_result("chop_tree", False, "blocked", task_id="task-1")
        self.assertEqual(self.level(loop), 0.7)

    async def test_early_success_is_bound_before_credit(self):
        loop = self.loop()
        await self.submit(loop, early=True)
        self.assertAlmostEqual(self.level(loop), 0.1)

    async def test_wrong_id_cancel_or_new_owner_cannot_credit_old_work(self):
        for kind in ("wrong_id", "cancel", "owner"):
            with self.subTest(kind=kind):
                loop = self.loop()
                await self.submit(loop)
                if kind == "cancel":
                    loop.note_task_cancelled("chop_tree", "owner", task_id="task-1")
                elif kind == "owner":
                    loop.note_owner_said("stop that")
                loop.note_task_result("chop_tree", True, task_id="old-id" if kind == "wrong_id" else "task-1")
                self.assertEqual(self.level(loop), 0.7)

    async def test_failed_move_does_not_satisfy_exploration(self):
        loop = self.loop("explore")
        async def reject(*args, **kwargs):
            raise RuntimeError("no route")
        loop._call = reject
        await loop._act(R.L.LifeDecision(activity="探索", drive="explore", skill="move.goto"))
        self.assertEqual(self.level(loop), 0.7)

    async def test_queued_movement_credits_only_actual_arrival(self):
        for arrived in (False, True):
            with self.subTest(arrived=arrived):
                loop = self.loop("explore")
                async def engine(*args, **kwargs):
                    return {"task_id": "move-1", "status": "queued"}
                loop._call = engine
                await loop._act(R.L.LifeDecision(activity="探索河边", drive="explore", skill="move.to",
                                                params={"x": 12, "z": 4}))
                self.assertIsNotNone(loop._return_task_attempt)
                self.assertEqual(self.level(loop), 0.7)
                loop.note_task_result("move.to", True, task_id="move-1", result={"arrived": arrived})
                self.assertAlmostEqual(self.level(loop), 0.1 if arrived else 0.7)

    async def test_real_goto_tool_and_task_handler_match_movement_completion(self):
        for drive, method, kwargs in (("explore", "move.to", {"x": 12, "z": 4}),
                                      ("social", "move.to_player", {"player": "Alice"})):
            for outcome in ("done", "early", "failed", "cancelled", "old_id", "owner"):
                with self.subTest(drive=drive, outcome=outcome):
                    p = plugin()
                    loop = p.life = self.loop(drive)
                    p._ensure_engine = AsyncMock(return_value=True)
                    loop._active_agent_activity = {"drive": drive, "activity": "去河边"}
                    completion = {"kind": "action", "name": "移动到河边", "status": "done",
                                  "meta": {"rpc": method}, "task_id": "move-1", "result": {"arrived": True}}
                    async def engine(actual_method, params, **unused):
                        self.assertEqual(actual_method, method)
                        if outcome == "early":
                            await p._on_task_finished(completion)
                            self.assertEqual(self.level(loop), 0.7)
                        return {"task_id": "move-1", "status": "queued"}
                    p.engine.call = engine
                    output = [text async for text in p.tool_mc_goto(_ActionEvent(), **kwargs)]
                    self.assertTrue(output)
                    if outcome != "early":
                        self.assertEqual(self.level(loop), 0.7)
                        if outcome == "owner":
                            loop.note_owner_said("先停下")
                        if outcome == "old_id":
                            completion["task_id"] = "old-move"
                        if outcome in ("failed", "cancelled"):
                            completion.update(status=outcome, result={})
                        await p._on_task_finished(completion)
                    self.assertAlmostEqual(self.level(loop), 0.1 if outcome in ("done", "early") else 0.7)
                    await p._on_task_finished(completion)
                    self.assertAlmostEqual(self.level(loop), 0.1 if outcome in ("done", "early") else 0.7)

    async def test_rejected_autonomous_goto_releases_submission(self):
        from astrcraft_plugin.bridge_client import EngineError
        p = plugin()
        p.life = self.loop("explore")
        p._ensure_engine = AsyncMock(return_value=True)
        p.engine.call = AsyncMock(side_effect=EngineError("no route", code=-32000))
        p.life._active_agent_activity = {"drive": "explore", "activity": "探索"}
        output = [text async for text in p.tool_mc_goto(_ActionEvent(), x=12, z=4)]
        self.assertIn("移动指令没能下达", str(output))
        self.assertIsNone(p.life._return_task_attempt)
        self.assertEqual(self.level(p.life), 0.7)

    async def test_pause_during_goto_precheck_prevents_autonomous_submission(self):
        p = plugin()
        p.life = self.loop("explore")
        async def ensure():
            p.life.pause(reason="owner pause", max_seconds=0)
            return True
        p._ensure_engine = ensure
        p.engine.call = AsyncMock(return_value={"task_id": "unwanted"})
        output = [text async for text in p.tool_mc_goto(_ActionEvent(), x=12, z=4)]
        self.assertIn("error:", str(output))
        p.engine.call.assert_not_awaited()
        self.assertEqual(self.level(p.life), 0.7)

    async def test_new_world_steer_during_goto_precheck_blocks_without_owner_pending(self):
        p = plugin()
        p.life = self.loop("explore")
        async def ensure():
            p.life.note_world_event("hurt", "突然受伤，先看清周围", urgent=True)
            return True
        p._ensure_engine = ensure
        p.engine.call = AsyncMock(return_value={"task_id": "unsafe-after-hurt"})
        output = [text async for text in p.tool_mc_goto(_ActionEvent(), x=12, z=4)]
        self.assertIn("error:", str(output))
        self.assertFalse(p.life._decision_owner_pending)
        p.engine.call.assert_not_awaited()
        self.assertIsNone(p.life._return_task_attempt)

    async def test_agent_summary_alone_has_no_drive_feedback(self):
        loop = self.loop()
        async def act(**kwargs):
            return "I have explored the area", ["mc_status"]
        loop.action_agent = SimpleNamespace(act=act, last_timing={})
        self.assertTrue(await loop._act_via_agent())
        self.assertEqual(self.level(loop), 0.7)
        self.assertIsNone(loop._active_agent_activity)

    async def test_agent_task_credit_requires_corresponding_actual_activity(self):
        for drive, expected in (("gather", 0.1), ("explore", 0.7)):
            with self.subTest(drive=drive):
                loop = self.loop(drive)
                loop._active_agent_activity = {"drive": drive, "activity": "collect wood"}
                token = loop.register_task_submission("chop_tree")
                loop.bind_task_submission(token, {"task_id": "actual"})
                loop.note_task_result("chop_tree", True, task_id="actual", result={"ok": True})
                self.assertAlmostEqual(self.level(loop), expected)

    async def test_accepted_owner_response_can_submit_and_credit_before_ack_but_new_input_wins(self):
        from astrbot.core.provider.func_tool_manager import FunctionToolManager
        from astrcraft_plugin.action_agent import ActionAgent
        for tool_name, drive, args in (("mc_goto", "explore", {"x": 12, "z": 4}),
                                       ("mc_collect", "gather", {"item": "carrot", "count": 64})):
            for change in (None, "owner", "hurt", "pause"):
                with self.subTest(tool=tool_name, change=change):
                    p = plugin()
                    p.config["announce_task_done"] = False
                    loop = p.life = self.loop(drive)
                    loop.note_owner_said("请按新路线行动")
                    prompt = loop._decision_inputs()
                    self.assertTrue(loop._decision_owner_pending)
                    loop._active_agent_activity = {"drive": drive, "activity": "执行已读的主人安排"}
                    state = {"health": 6, "food": 0, "inventory": {}, "is_night": False,
                        "nearby_entities": [], "server": "test:25565", "dimension": "overworld"}
                    loop._state_provider = AsyncMock(return_value=state)
                    called = []
                    async def ensure():
                        if change == "owner": loop.note_owner_said("换个安排")
                        elif change == "hurt": loop.note_world_event("hurt", "有近敌", urgent=True)
                        elif change == "pause": loop.pause(reason="主人暂停", max_seconds=0)
                        return True
                    p._ensure_engine = ensure
                    async def execute(method, params, **kwargs):
                        called.append((method, params))
                        name = "move.to" if tool_name == "mc_goto" else "collect"
                        await p._on_task_finished({"kind": "action" if name.startswith("move.") else "skill",
                            "name": "按主人安排", "task_id": "accepted-owner", "status": "done",
                            "meta": {"rpc": name} if name.startswith("move.") else {"skill": name},
                            "result": {"arrived": True, "ok": True}})
                        self.assertEqual(self.level(loop), 0.7, "unbound early result must wait for the task id")
                        return {"task_id": "accepted-owner"}
                    p.engine.call = execute
                    p.engine.run_skill = execute
                    async def chat(**kwargs):
                        return SimpleNamespace(tools_call_name=[tool_name], tools_call_args=[args],
                            tools_call_ids=["owner-tool"], completion_text="", usage=None,
                            to_openai_tool_calls_model=lambda: [])
                    async def provider(): return SimpleNamespace(text_chat=chat)
                    manager = FunctionToolManager()
                    manager.add_func(name=tool_name, func_args=[], desc="回归", handler=getattr(type(p), "tool_" + tool_name))
                    p.context = SimpleNamespace(get_using_provider_async=provider,
                        provider_manager=SimpleNamespace(llm_tools=manager))
                    agent = ActionAgent(p)
                    agent.max_steps = 1
                    await agent.act(prompt=prompt, system="执行主人安排")
                    self.assertEqual(len(called), 1 if change is None else 0)
                    self.assertAlmostEqual(self.level(loop), 0.1 if change is None else 0.7)
                    self.assertTrue(loop._decision_owner_pending)


if __name__ == "__main__":
    unittest.main(verbosity=2)
