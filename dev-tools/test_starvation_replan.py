"""A starving body must reach observation/replanning without unsafe gathering."""
from __future__ import annotations

import asyncio
import copy
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_life_recovery as R
import test_supply_resume as S


class StarvationReplanTests(unittest.IsolatedAsyncioTestCase):
    def snapshot(self, **changes):
        return {"health": 6, "food": 0, "inventory": {"stone_pickaxe": 1},
                "is_night": False, "server": "test:25565", "dimension": "overworld",
                "nearby_entities": [], **changes}

    async def test_no_food_releases_impossible_rest_and_unrelated_work(self):
        for night in (False, True, None):
            with self.subTest(night=night):
                state = self.snapshot(is_night=night)
                loop = S.SupplyResumeTests.make_loop(self, state)
                loop._set_plan([{"skill": "mine_ores", "params": {"ore": "iron", "count": 8}}])
                for _ in range(3):
                    self.assertIsNone(await loop._survival_step())
                    self.assertFalse(loop._rule_supply_wait_reason)
                self.assertEqual(loop._plan, [])
                self.assertIn("等待不能恢复生命", loop._last_state_note)

    async def test_explicit_route_to_shelter_is_not_discarded(self):
        state = self.snapshot()
        loop = S.SupplyResumeTests.make_loop(self, state)
        route = {"skill": "return_home", "params": {"home": {"origin": {"x": 2, "y": 64, "z": 2}}}}
        loop._set_plan([route])
        self.assertIsNone(await loop._survival_step())
        self.assertFalse(loop._rule_supply_wait_reason)
        self.assertEqual(loop._pop_plan_step()["params"], route["params"])

    async def test_existing_food_and_prepared_bread_are_still_used(self):
        for inventory, expected in (({"bread": 1}, "eat"), ({"beef": 1}, "eat"),
                                    ({"wheat": 3, "crafting_table": 1}, "cook_food")):
            with self.subTest(inventory=inventory):
                loop = S.SupplyResumeTests.make_loop(self, self.snapshot(inventory=inventory))
                self.assertEqual((await loop._survival_step())["skill"], expected)

    async def test_fed_body_recovers_and_healthy_body_can_wait_for_dawn(self):
        loop = S.SupplyResumeTests.make_loop(self, self.snapshot(food=18))
        self.assertEqual((await loop._survival_step())["skill"], "recover")
        loop = S.SupplyResumeTests.make_loop(self, self.snapshot(health=20, is_night=True))
        self.assertIsNone(await loop._survival_step())
        self.assertTrue(loop._rule_supply_wait_reason)

    async def test_pause_is_not_overridden_by_starvation(self):
        loop = S.SupplyResumeTests.make_loop(self, self.snapshot())
        loop._set_plan([{"skill": "mine_stone", "params": {"count": 4}}])
        loop.pause(reason="owner pause", max_seconds=0)
        self.assertIsNone(await loop._survival_step())
        self.assertEqual(loop._plan[0]["skill"], "mine_stone")

    async def test_real_model_collect_submits_bounded_harvest_then_eats_actual_food(self):
        import test_home_awareness as H
        for item in ("wheat", "carrot", "potato", "beetroot"):
            with self.subTest(item=item):
                inventory = {"stone_pickaxe": 1, **({"crafting_table": 1} if item == "wheat" else {})}
                state = self.snapshot(inventory=inventory)
                loop, _ = R.make_loop()
                loop._state_provider = lambda: asyncio.sleep(0, result=copy.deepcopy(state))
                loop.remember_home(H.home())
                loop._set_plan([{"skill": "mine_stone", "params": {"count": 4}}])
                eaten, prompts, submitted = asyncio.Event(), [], []

                async def model(prompt, system):
                    prompts.append(prompt)
                    self.assertEqual(len(prompts), 1, "the concrete meal must survive the next boundary")
                    return json.dumps({"activity": "收一点近处成熟作物应急", "plan": [
                        {"skill": "collect", "params": {"item": "minecraft:" + item, "count": 64,
                            "radius": 96, "max_attempts": 40, "allow_search": True,
                            "nearby": True, "home": {"origin": {"x": 999, "y": 0, "z": 999}}}},
                        *([{"skill": "cook_food", "params": {"count": 1}}] if item == "wheat" else []),
                        {"skill": "eat", "params": {"target_food": 18}},
                    ]})

                async def engine(method, params=None, **kwargs):
                    if method == "task.list":
                        return {"current": None, "queued": 0}
                    self.assertEqual(method, "skill.run")
                    submitted.append(copy.deepcopy(params))
                    skill = params["skill"]
                    if skill == "collect":
                        protected = params["params"]["protected_home"]
                        self.assertEqual(protected, {**H.home(), "condition": "intact"})
                        self.assertEqual({k: v for k, v in params["params"].items() if k != "protected_home"},
                            {"item": item, "count": 3, "radius": 3, "max_attempts": 2, "allow_search": False})
                        state["inventory"][item] = 3
                    elif skill == "cook_food":
                        self.assertEqual(item, "wheat")
                        self.assertEqual(state["inventory"].pop("wheat"), 3)
                        state["inventory"]["bread"] = 1
                    else:
                        self.assertEqual(skill, "eat")
                        self.assertGreater(state["inventory"].get("bread" if item == "wheat" else item, 0), 0)
                        state["food"] = 20
                        eaten.set()
                        loop._stopped = True
                    loop.note_task_result(skill, True)
                    loop.wake("real meal progress")
                    return {"task_id": f"meal-{len(submitted)}"}

                loop._llm, loop._call = model, engine
                loop._wake.set()
                loop.start()
                try:
                    await asyncio.wait_for(eaten.wait(), timeout=1)
                finally:
                    await loop.stop()
                self.assertEqual(len(prompts), 1)
                self.assertIn("等待不能恢复生命", prompts[0])
                self.assertEqual([p["skill"] for p in submitted],
                    ["collect", *(["cook_food"] if item == "wheat" else []), "eat"])
                self.assertEqual(state["food"], 20)

    async def test_claimed_nearby_crop_never_overrides_actual_unsafe_state(self):
        for changes in ({"is_night": True}, {"is_night": None}, {"nearby_entities": None},
                        {"nearby_entities": [{"name": "zombie", "hostile": True, "distance": 2}]},
                        {"home_status": {"inside": True, "safe": True}}, {"in_lava": True}):
            with self.subTest(changes=changes):
                loop = S.SupplyResumeTests.make_loop(self, self.snapshot(**changes))
                loop._set_plan([{"skill": "collect", "params": {"item": "carrot", "nearby": True}}])
                self.assertIsNone(await loop._survival_step())
                self.assertEqual(loop._plan, [])
                self.assertIsNone(loop._rule_supply_candidate)
        for item in ("beef", "sweet_berries", "oak_log"):
            loop = S.SupplyResumeTests.make_loop(self, self.snapshot())
            loop._set_plan([{"skill": "collect", "params": {"item": item, "nearby": True}}])
            self.assertIsNone(await loop._survival_step())
            self.assertEqual(loop._plan, [])

    async def test_crop_cooldown_preserves_meal_and_pause_blocks_it(self):
        loop = S.SupplyResumeTests.make_loop(self, self.snapshot())
        loop._set_plan([{"skill": "collect", "params": {"item": "carrot", "count": 2}}])
        for _ in range(3):
            loop.note_task_result("collect", False, "no mature crop")
        loop._set_plan([{"skill": "collect", "params": {"item": "carrot", "count": 2}}])
        self.assertIsNone(await loop._survival_step())
        self.assertTrue(loop._rule_supply_wait_reason)
        self.assertEqual(loop._plan[0]["skill"], "collect")
        deadline = loop._failure_cooldowns["collect"]
        with patch.object(S.L.time, "time", return_value=deadline + 1):
            loop.pause(reason="owner pause", max_seconds=0)
            self.assertIsNone(await loop._survival_step())
            self.assertNotIn("radius", loop._plan[0]["params"])
            loop.resume()
            self.assertIsNone(await loop._survival_step())
            self.assertFalse(loop._rule_supply_wait_reason)
            self.assertEqual(loop._plan[0]["params"],
                {"item": "carrot", "count": 2, "radius": 3, "max_attempts": 2, "allow_search": False})

    async def test_submit_rechecks_threat_after_activity_callback(self):
        state = self.snapshot()
        loop, calls = R.make_loop()
        loop._state_provider = lambda: asyncio.sleep(0, result=copy.deepcopy(state))
        loop._set_plan([{"skill": "collect", "params": {"item": "carrot"}}])
        self.assertIsNone(await loop._survival_step())
        decision = loop._decision_from_step(loop._pop_plan_step())

        async def threat(_):
            state["nearby_entities"] = [{"name": "creeper", "hostile": True, "distance": 1}]

        loop._on_activity = threat
        await loop._act(decision, allow_model_block=True)
        self.assertFalse(any(method == "skill.run" for method, _ in calls))
        self.assertIsNone(loop._rule_supply_candidate)
        self.assertGreater(loop._decision_retry_at, 0)

    async def test_real_loop_claimed_harvest_without_food_gets_two_attempts_then_cooldown(self):
        state = self.snapshot()
        loop, _ = R.make_loop()
        loop._state_provider = lambda: asyncio.sleep(0, result=copy.deepcopy(state))
        submitted, prompts = [], []

        async def model(prompt, system):
            prompts.append(prompt)
            return json.dumps({"activity": "近处收点作物", "skill": "collect", "params": {"item": "carrot"}})

        async def engine(method, params=None, **kwargs):
            if method == "task.list":
                return {"current": None, "queued": 0}
            submitted.append(copy.deepcopy(params))
            loop.note_task_result("collect", True)
            loop.wake("claimed harvest without an inventory change")
            return {"task_id": f"unchanged-{len(submitted)}"}

        loop._llm, loop._call = model, engine
        loop._wake.set()
        loop.start()
        try:
            await asyncio.sleep(0.12)
            self.assertEqual(len(submitted), 2)
            self.assertEqual(len(prompts), 2)
            self.assertFalse(loop.skill_retry_ready("collect"))
            self.assertGreater(loop._decision_retry_at, S.L.time.time())
        finally:
            await loop.stop()

    async def test_real_loop_empty_farm_failures_replan_only_until_normal_cooldown(self):
        state = self.snapshot()
        loop, _ = R.make_loop()
        loop._state_provider = lambda: asyncio.sleep(0, result=copy.deepcopy(state))
        submitted, prompts = [], []

        async def model(prompt, system):
            prompts.append(prompt)
            return json.dumps({"activity": "看看身边成熟作物", "skill": "collect",
                "params": {"item": "carrot", "nearby": True}})

        async def engine(method, params=None, **kwargs):
            if method == "task.list":
                return {"current": None, "queued": 0}
            submitted.append(copy.deepcopy(params))
            self.assertEqual(params["params"],
                {"item": "carrot", "count": 3, "radius": 3, "max_attempts": 2, "allow_search": False})
            loop.note_task_result("collect", False, "附近没有成熟作物")
            loop.wake("empty farm verified by native harvest")
            return {"task_id": f"empty-{len(submitted)}"}

        loop._llm, loop._call = model, engine
        loop._wake.set()
        loop.start()
        try:
            await asyncio.sleep(0.12)
            self.assertEqual(len(submitted), 3)
            self.assertEqual(len(prompts), 3)
            self.assertFalse(loop.skill_retry_ready("collect"))
            self.assertGreater(loop._decision_retry_at, S.L.time.time())
            self.assertEqual(state["inventory"], {"stone_pickaxe": 1})
        finally:
            await loop.stop()

    async def test_default_action_agent_collect_boundary_and_actual_meal(self):
        from astrbot.core.provider.func_tool_manager import FunctionToolManager
        from astrcraft_plugin.action_agent import ActionAgent
        from astrcraft_plugin.llm_tools_skills import McSkillTools
        from test_plugin_control import plugin

        for outcome, expected_submissions in (("food", 1), ("empty", 3), ("unchanged", 2), ("changed_count", 2)):
            with self.subTest(outcome=outcome):
                state = self.snapshot(inventory={})
                p = plugin()
                p.config["announce_task_done"] = False
                loop, _ = R.make_loop()
                p.life = loop
                reads = AsyncMock(side_effect=lambda: copy.deepcopy(state))
                loop._state_provider = reads
                p._ensure_engine = AsyncMock(return_value=True)
                submitted, model_calls = [], []
                eaten = asyncio.Event()

                async def chat(**kwargs):
                    model_calls.append(kwargs)
                    return SimpleNamespace(tools_call_name=["mc_collect"],
                        tools_call_args=[{"item": "carrot", "count": 1 if outcome == "changed_count" and len(model_calls) == 1 else 64}], tools_call_ids=["crop"],
                        completion_text="", usage=None, to_openai_tool_calls_model=lambda: [])

                manager = FunctionToolManager()
                manager.add_func(name="mc_collect", func_args=[], desc="收割", handler=McSkillTools.tool_mc_collect)
                async def provider():
                    return SimpleNamespace(text_chat=chat)
                p.context = SimpleNamespace(get_using_provider_async=provider,
                    provider_manager=SimpleNamespace(llm_tools=manager))
                loop.action_agent = ActionAgent(p)

                async def collect(skill, params):
                    self.assertEqual(skill, "collect")
                    self.assertEqual(params, {"item": "carrot", "count": 1 if outcome == "changed_count" and not submitted else 3, "radius": 3,
                        "allow_search": False, "max_attempts": 2})
                    self.assertIsNotNone(loop._rule_supply_attempt)
                    task_id = f"agent-crop-{len(submitted)}"
                    submitted.append(copy.deepcopy(params))
                    if outcome == "food":
                        state["inventory"]["carrot"] = 3
                    await p._on_task_finished({"kind": "skill", "name": "收集 carrot", "task_id": task_id,
                        "meta": {"skill": "collect"}, "status": "failed" if outcome == "empty" else "done",
                        "error": "没有成熟作物" if outcome == "empty" else "",
                        "result": {"ok": outcome != "empty"}})
                    return {"task_id": task_id}

                async def engine(method, params=None, **kwargs):
                    if method == "task.list":
                        return {"current": None, "queued": 0}
                    self.assertEqual((method, params["skill"]), ("skill.run", "eat"))
                    self.assertEqual(state["inventory"]["carrot"], 3)
                    state["food"] = 20
                    state["inventory"]["carrot"] = 0
                    eaten.set()
                    loop._stopped = True
                    loop.wake("已吃到实际收获的食物")
                    return {"task_id": "eat-crop"}

                p.engine.run_skill = collect
                loop._call = engine
                loop._wake.set()
                loop.start()
                try:
                    if outcome == "food":
                        await asyncio.wait_for(eaten.wait(), timeout=2)
                        self.assertEqual(state["food"], 20)
                    else:
                        await asyncio.sleep(0.15)
                        self.assertFalse(loop.skill_retry_ready("collect"))
                        self.assertGreater(loop._decision_retry_at, S.L.time.time())
                        self.assertEqual(state["inventory"], {})
                    self.assertEqual(len(submitted), expected_submissions)
                    self.assertEqual(len(model_calls), expected_submissions)
                    self.assertGreaterEqual(reads.await_count, expected_submissions)
                finally:
                    await loop.stop()

    async def test_direct_autonomous_collection_checks_body_without_known_home(self):
        from astrcraft_plugin.action_agent import _ActionEvent
        from test_plugin_control import plugin
        for changes, skill, params in (({"nearby_entities": [{"hostile": True}]}, "collect", {"item": "carrot"}),
                                      ({"is_night": True}, "collect", {"item": "carrot"}),
                                      ({}, "collect", {"item": "beef"}),
                                      ({}, "mine_stone", {"count": 4}),
                                      ({"health": None}, "collect", {"item": "carrot"})):
            with self.subTest(changes=changes, skill=skill):
                p = plugin()
                p.life, _ = R.make_loop()
                p.life._state_provider = AsyncMock(return_value=self.snapshot(**changes))
                p._ensure_engine = AsyncMock(return_value=True)
                p.engine.run_skill = AsyncMock(return_value={"task_id": "unsafe"})
                reply = await p._submit_skill(_ActionEvent(), skill, params, "工作")
                self.assertTrue(str(reply).startswith("error:"))
                p.engine.run_skill.assert_not_awaited()
                p.life._state_provider.assert_awaited_once()

    async def test_direct_emergency_submission_rejections_cool_down_without_polluting_new_owner(self):
        from astrcraft_plugin.action_agent import _ActionEvent
        from astrcraft_plugin.bridge_client import EngineError
        from test_plugin_control import plugin
        p = plugin()
        p.life, _ = R.make_loop()
        p.life._state_provider = AsyncMock(return_value=self.snapshot())
        p._ensure_engine = AsyncMock(return_value=True)
        p.engine.run_skill = AsyncMock(side_effect=EngineError("queue unavailable"))
        for _ in range(3):
            reply = await p.tool_mc_collect(_ActionEvent(), item="carrot", count=64)
            self.assertIn("没能开始", str(reply))
        self.assertFalse(p.life.skill_retry_ready("collect"))
        reply = await p.tool_mc_collect(_ActionEvent(), item="carrot", count=64)
        self.assertIn("冷却", str(reply))
        self.assertEqual(p.engine.run_skill.await_count, 3)

        p.life._recent_failures.clear()
        p.life._failure_cooldowns.clear()
        p.life._failure_backoff_seen.clear()
        async def superseded(*args):
            p.life.note_owner_said("先停止应急收割")
            raise EngineError("old request rejected after takeover")
        p.engine.run_skill = superseded
        await p.tool_mc_collect(_ActionEvent(), item="carrot", count=64)
        self.assertEqual(p.life._recent_failures, {})
        self.assertIsNone(p.life._return_task_attempt)


if __name__ == "__main__":
    unittest.main(verbosity=2)
