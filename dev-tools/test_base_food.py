"""Actual advisor/LifeLoop/plugin integration for base food and closed-door work resumption."""
from __future__ import annotations

import asyncio
import copy
import json
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_supply_resume as S
import test_home_awareness as H
import test_plugin_control as P
import test_life_recovery as R
from astrcraft_plugin import advisor


def record():
    home = H.home()
    home["furnished"]["chest"] = True
    return home


def assert_protected_params(testcase, actual, original):
    """Work retains its goal and carries a separately verified base boundary."""
    remaining = dict(actual)
    protected = remaining.pop("protected_home")
    testcase.assertEqual(remaining, original)
    testcase.assertEqual(protected["origin"], record()["origin"])
    testcase.assertEqual(protected["server"], record()["server"])
    testcase.assertEqual(protected["dimension"], record()["dimension"])


def state(*, food=6, health=20, inside=False):
    home = record()
    return {"inventory": {"stone_pickaxe": 1}, "food": food, "health": health,
            "server": home["server"], "dimension": home["dimension"], "is_night": False,
            "home_status": {"condition": "intact", "loaded": True, "distance": 5,
                            "safe": inside, "inside": inside, "furniture": home["furnished"]}}


class BaseFoodTests(unittest.IsolatedAsyncioTestCase):
    def make_loop(self, snapshot):
        loop = S.SupplyResumeTests.make_loop(self, snapshot)
        loop.remember_home(record())
        return loop

    def advice(self, snapshot, home=None, **extra):
        return advisor.advise(snapshot["inventory"], food=snapshot["food"], health=snapshot["health"],
            home=home or record(), home_status=snapshot["home_status"], **extra)

    def test_short_base_route_precedes_food_search(self):
        advice = self.advice(state())
        self.assertEqual(advice.skill, "resupply_food")
        self.assertEqual(advice.params["count"], 4)
        self.assertEqual(advice.priority, "survival")

    def test_current_ingredients_outside_but_shelf_check_inside(self):
        for ingredient in ("wheat", "beef"):
            for inside in (False, True):
                with self.subTest(ingredient=ingredient, inside=inside):
                    snapshot = state(inside=inside)
                    snapshot["inventory"][ingredient] = 6
                    self.assertEqual(self.advice(snapshot).skill, "resupply_food" if inside else "cook_food")

    def test_existing_food_and_safe_emergency_raw_are_immediate(self):
        for item, food in (("bread", 6), ("beef", 2)):
            snapshot = state(food=food)
            snapshot["inventory"][item] = 2
            self.assertEqual(self.advice(snapshot).skill, "eat")

    def test_hunger_and_health_bound_trip_and_real_absent_chest_wins(self):
        for food, health, distance, condition, chest in (
                (2, 20, 9, "intact", True), (6, 6, 9, "intact", True),
                (6, 20, 49, "intact", True), (6, 20, -1, "intact", True),
                (6, 20, float("nan"), "intact", True), (6, 20, 5, "missing", True),
                (6, 20, 5, "other_world", True), (6, 20, 5, "intact", False)):
            snapshot = state(food=food, health=health)
            snapshot["home_status"].update(distance=distance, condition=condition, furniture={"chest": chest})
            self.assertNotEqual(self.advice(snapshot).skill, "resupply_food")
        self.assertNotEqual(self.advice(state(), recent_failures={"resupply_food": 2}).skill, "resupply_food")

    def test_unknown_chunks_keep_only_short_historical_probe(self):
        snapshot = state()
        snapshot["home_status"] = {"condition": "unknown", "safe": False, "distance": 20}
        self.assertEqual(self.advice(snapshot).skill, "resupply_food")
        damaged = record(); damaged["condition"] = "missing"
        self.assertNotEqual(self.advice(snapshot, damaged).skill, "resupply_food")

    def test_empty_stock_expires_and_future_timestamp_is_not_permanent(self):
        home = record(); home.update(food_stock_empty=True, food_stock_checked_at=100)
        with patch.object(advisor.time, "time", return_value=110):
            self.assertNotEqual(self.advice(state(), home).skill, "resupply_food")
        for now in (220, 90):
            with patch.object(advisor.time, "time", return_value=now):
                self.assertEqual(self.advice(state(), home).skill, "resupply_food")

    async def test_real_loop_resupplies_eats_recovers_exits_and_resumes_exact_plan(self):
        snapshot = state(food=0, health=6)
        loop = self.make_loop(snapshot)
        plan = [{"skill": "mine_stone", "params": {"count": 7, "radius": 9}}]
        loop._set_plan(plan)
        complete, submitted = asyncio.Event(), []
        async def engine(method, params=None, **kwargs):
            if method == "task.list": return {"current": None, "queued": 0}
            self.assertEqual(method, "skill.run")
            submitted.append(copy.deepcopy(params))
            skill = params["skill"]
            if skill == "resupply_food":
                snapshot["inventory"]["bread"] = 4
                snapshot["home_status"].update(safe=True, inside=True)
            elif skill == "eat":
                self.assertTrue(snapshot["home_status"]["safe"])
                snapshot["food"] = 20; snapshot["inventory"]["bread"] = 1
            elif skill == "recover":
                self.assertTrue(snapshot["home_status"]["safe"])
                snapshot["health"] = 12
            elif skill == "leave_home": snapshot["home_status"].update(safe=False, inside=False)
            elif skill == "mine_stone":
                self.assertFalse(snapshot["home_status"]["inside"])
                complete.set(); loop._stopped = True
            else: self.fail(skill)
            loop.note_task_result(skill, True); loop.wake()
            return {"task_id": str(len(submitted))}
        loop._call = engine
        await S.SupplyResumeTests.run_until(self, loop, complete)
        self.assertEqual([p["skill"] for p in submitted], ["resupply_food", "eat", "recover", "leave_home", "mine_stone"])
        assert_protected_params(self, submitted[-1]["params"], plan[0]["params"])
        self.assertEqual(loop._rule_supply_stalls, {})

    async def test_partial_stock_is_used_before_new_supply_decision(self):
        snapshot = state(food=2)
        loop = self.make_loop(snapshot)
        first = await loop._survival_step()
        self.assertEqual(first["skill"], "resupply_food")
        snapshot["inventory"]["bread"] = 1
        snapshot["home_status"].update(safe=True, inside=True)
        second = await loop._survival_step()
        self.assertEqual(second["skill"], "eat")

    async def test_empty_shelf_falls_back_to_ingredients_without_repeated_return(self):
        snapshot = state(inside=True)
        snapshot["home_status"]["furniture"]["crafting_table"] = True
        snapshot["inventory"]["wheat"] = 6
        loop = self.make_loop(snapshot)
        loop._set_plan([{"skill": "mine_stone", "params": {"count": 7}}])
        self.assertEqual((await loop._survival_step())["skill"], "resupply_food")
        loop.note_home_food(record(), {"food_stock_checked": True, "food_stock_empty": True})
        step = await loop._survival_step()
        self.assertEqual(step["skill"], "cook_food")
        self.assertEqual(step["params"], {"count": 2})
        self.assertEqual(loop._plan[0]["skill"], "mine_stone")

    async def test_empty_shelf_plugin_event_keeps_matching_rule_plan_without_failure_poison(self):
        snapshot = state(inside=True)
        snapshot["home_status"]["furniture"]["crafting_table"] = True
        snapshot["inventory"]["wheat"] = 6
        loop = self.make_loop(snapshot)
        loop._set_plan([{"skill": "mine_stone", "params": {"count": 7}}])
        await loop._survival_step()
        loop._rule_supply_attempt = copy.deepcopy(loop._rule_supply_candidate)
        p = P.plugin(); p.life = loop; p.config["announce_task_done"] = False
        await p._on_task_finished({"kind": "skill", "name": "回基地取食物", "meta": {"skill": "resupply_food"},
            "status": "failed", "result": {"ok": False, "home": record(), "home_status": snapshot["home_status"],
                                            "food_stock_checked": True, "food_stock_empty": True}})
        self.assertEqual(loop._plan[0]["params"], {"count": 7})
        self.assertEqual(loop._failure_counts(), {})
        self.assertEqual((await loop._survival_step())["skill"], "cook_food")

    async def test_empty_base_real_loop_cooks_eats_exits_then_keeps_original_mining(self):
        snapshot = state(inside=True)
        snapshot["home_status"]["furniture"]["crafting_table"] = True
        snapshot["inventory"]["wheat"] = 6
        loop = self.make_loop(snapshot)
        loop._set_plan([{"skill": "mine_stone", "params": {"count": 7}}])
        p = P.plugin(); p.life = loop; p.config["announce_task_done"] = False
        complete, submitted = asyncio.Event(), []
        async def engine(method, params=None, **kwargs):
            if method == "task.list": return {"current": None, "queued": 0}
            skill = params["skill"]; submitted.append(skill)
            result = {"ok": True}
            if skill == "resupply_food":
                result = {"ok": False, "home": record(), "home_status": snapshot["home_status"],
                          "food_stock_checked": True, "food_stock_empty": True}
            elif skill == "cook_food": snapshot["inventory"] = {"bread": 2, "stone_pickaxe": 1}
            elif skill == "eat": snapshot["food"] = 20; snapshot["inventory"]["bread"] = 0
            elif skill == "leave_home": snapshot["home_status"].update(safe=False, inside=False)
            elif skill == "mine_stone":
                assert_protected_params(self, params["params"], {"count": 7})
                complete.set(); loop._stopped = True
            else: self.fail(skill)
            await p._on_task_finished({"kind": "skill", "name": skill, "meta": {"skill": skill},
                "status": "done" if result["ok"] else "failed", "result": result})
            loop.wake()
            return {"task_id": str(len(submitted))}
        loop._call = engine
        await S.SupplyResumeTests.run_until(self, loop, complete)
        self.assertEqual(submitted, ["resupply_food", "cook_food", "eat", "leave_home", "mine_stone"])
        self.assertEqual(loop._failure_counts(), {})

    async def test_empty_shelf_daytime_search_exits_first_but_critical_body_stays(self):
        for health in (20, 6):
            snapshot = state(inside=True, health=health)
            loop = self.make_loop(snapshot)
            loop.note_home_food(record(), {"food_stock_checked": True, "food_stock_empty": True})
            loop._set_plan([{"skill": "mine_stone", "params": {"count": 7}}])
            step = await loop._survival_step()
            self.assertEqual(step["skill"] if step else None, "leave_home" if health == 20 else None)
            self.assertTrue(loop._plan, "critical body waits indoors without forgetting its established work")

    async def test_sleep_wait_then_dawn_exit_keeps_original_work(self):
        snapshot = state(food=20, inside=True)
        loop = self.make_loop(snapshot)
        loop._set_plan([{"skill": "mine_ores", "params": {"ore": "iron", "count": 5}}])
        snapshot["is_night"] = True
        self.assertEqual((await loop._survival_step())["skill"], "sleep")
        snapshot["is_night"] = False
        self.assertEqual((await loop._survival_step())["skill"], "leave_home")
        self.assertEqual(loop._plan[0]["params"], {"ore": "iron", "count": 5})

    async def test_new_json_first_step_passes_door_boundary_and_keeps_decision_metadata(self):
        snapshot = state(food=20, inside=True)
        snapshot["inventory"]["bread"] = 4
        loop, _ = R.make_loop()
        loop._state_provider = lambda: asyncio.sleep(0, result=copy.deepcopy(snapshot))
        loop.remember_home(record())
        loop._decide_interval = 0.001
        submitted, model_calls, complete = [], [], asyncio.Event()
        async def model(prompt, system):
            model_calls.append(True)
            return json.dumps({"activity": "采集基地外的煤", "skill": "mine_ores",
                               "params": {"ore": "coal", "count": 2, "radius": 9},
                               "say": "吃饱了，去找煤", "reason": "出门继续生存"})
        async def engine(method, params=None, **kwargs):
            if method == "task.list": return {"current": None, "queued": 0}
            submitted.append(copy.deepcopy(params))
            if params["skill"] == "leave_home":
                snapshot["home_status"].update(inside=False, safe=False)
            else:
                self.assertEqual(params["skill"], "mine_ores")
                self.assertFalse(snapshot["home_status"]["inside"])
                complete.set(); loop._stopped = True
            loop.note_task_result(params["skill"], True); loop.wake()
            return {"task_id": str(len(submitted))}
        loop._llm, loop._call = model, engine
        await S.SupplyResumeTests.run_until(self, loop, complete)
        self.assertEqual([p["skill"] for p in submitted], ["leave_home", "mine_ores"])
        assert_protected_params(self, submitted[-1]["params"], {"ore": "coal", "count": 2, "radius": 9})
        self.assertEqual(len(model_calls), 1)
        self.assertEqual(loop.history[-1].activity, "采集基地外的煤")
        self.assertEqual(loop.history[-1].say, "吃饱了，去找煤")
        self.assertEqual(loop.history[-1].drive, "gather")

    async def test_failed_exit_cannot_pop_outdoor_mining_behind_closed_door(self):
        snapshot = state(food=20, inside=True)
        loop = self.make_loop(snapshot)
        loop._set_plan([{"skill": "mine_stone", "params": {"count": 7}}])
        for _ in range(2): loop.note_task_result("leave_home", False, "door blocked")
        self.assertIsNone(await loop._survival_step())
        self.assertEqual(loop._plan, [])

    async def test_two_noop_exit_successes_stop_instead_of_looping(self):
        snapshot = state(food=20, inside=True)
        loop = self.make_loop(snapshot)
        loop._set_plan([{"skill": "mine_stone", "params": {"count": 7}}])
        for _ in range(2):
            step = await loop._survival_step()
            self.assertEqual(step["skill"], "leave_home")
            loop._rule_supply_attempt = copy.deepcopy(loop._rule_supply_candidate)
            loop.note_task_result("leave_home", True)
        self.assertIsNone(await loop._survival_step())
        self.assertEqual(loop._plan, [])

    async def test_pause_owner_steer_and_foreign_home_prevent_stale_actions(self):
        snapshot = state(food=20, inside=True)
        loop = self.make_loop(snapshot)
        loop._set_plan([{"skill": "mine_stone", "params": {"count": 7}}])
        loop.pause(reason="owner control")
        self.assertIsNone(await loop._survival_step())
        loop.resume(); loop._decision_owner_pending = True
        self.assertIsNone(await loop._survival_step())
        loop._decision_owner_pending = False
        snapshot["server"] = "other:25565"; snapshot["home"] = record()
        self.assertIsNone(await loop._survival_step())

    def test_stock_memory_requires_verified_empty_and_exact_world_origin(self):
        loop = self.make_loop(state())
        for report in ({"food_stock_checked": False, "food_stock_empty": True}, {"reason": "read failed"}):
            loop.note_home_food(record(), report)
            self.assertNotIn("food_stock_empty", loop._homes[0])
        for altered in ({"server": "other"}, {"dimension": "the_nether"}, {"origin": {"x": 20, "y": 1, "z": 0}}):
            loop.note_home_food({**record(), **altered}, {"food_stock_checked": True, "food_stock_empty": True})
            self.assertNotIn("food_stock_empty", loop._homes[0])
        loop.note_home_food(record(), {"food_stock_checked": True, "food_stock_empty": True})
        self.assertTrue(loop._homes[0]["food_stock_empty"])
        self.assertLess(abs(loop._homes[0]["food_stock_checked_at"] - time.time()), 1)
        loop.note_home_food(record(), {"produced": {"bread": 1}})
        self.assertFalse(loop._homes[0]["food_stock_empty"])

    async def test_plugin_records_failed_empty_check_but_not_cancelled_result(self):
        loop = self.make_loop(state())
        p = P.plugin(); p.life = loop; p.config["announce_task_done"] = False
        report = {"ok": False, "home": record(), "home_status": state(inside=True)["home_status"],
                  "food_stock_checked": True, "food_stock_empty": True}
        for status in ("cancelled", "failed"):
            await p._on_task_finished({"kind": "skill", "name": "回基地取食物", "meta": {"skill": "resupply_food"},
                                      "status": status, "result": report})
            self.assertEqual(loop._homes[0].get("food_stock_empty"), True if status == "failed" else None)


class AgentHomeTests(unittest.IsolatedAsyncioTestCase):
    def make_plugin(self, snapshot):
        from unittest.mock import AsyncMock
        p = P.plugin()
        p.life = S.SupplyResumeTests.make_loop(self, snapshot)
        p.life.remember_home(record())
        p.life.note_unblocked()
        p.engine.run_skill = AsyncMock(return_value={"task_id": "direct"})
        return p

    def auto_event(self):
        from astrcraft_plugin.action_agent import _ActionEvent
        return _ActionEvent()

    async def test_direct_agent_outdoor_skill_passes_home_boundary_before_original_task(self):
        snapshot = state(food=20, inside=True)
        p = self.make_plugin(snapshot)
        original = {"ore": "iron", "count": 7, "radius": 9}
        result = await p._submit_skill(self.auto_event(), "mine_ores", original, "挖铁")
        self.assertIn("已保留", str(result))
        p.engine.run_skill.assert_not_awaited()
        self.assertEqual(p.life._pending_plan[0]["params"], original)
        completed, skills = asyncio.Event(), []
        async def engine(method, params=None, **kwargs):
            if method == "task.list": return {"current": None, "queued": 0}
            self.assertEqual(method, "skill.run")
            skills.append(copy.deepcopy(params))
            if params["skill"] == "leave_home":
                snapshot["home_status"].update(safe=False, inside=False)
            elif params["skill"] == "mine_ores":
                self.assertFalse(snapshot["home_status"]["inside"])
                completed.set(); p.life._stopped = True
            else: self.fail(params["skill"])
            p.life.note_task_result(params["skill"], True); p.life.wake()
            return {"task_id": str(len(skills))}
        p.life._call = engine
        await S.SupplyResumeTests.run_until(self, p.life, completed)
        self.assertEqual([item["skill"] for item in skills], ["leave_home", "mine_ores"])
        assert_protected_params(self, skills[-1]["params"], original)

    async def test_direct_agent_task_waits_for_night_and_critical_health_rules(self):
        for night, health, expected in ((True, 20, "sleep"), (False, 6, "recover")):
            with self.subTest(night=night, health=health):
                snapshot = state(food=20, health=health, inside=True)
                snapshot["is_night"] = night
                p = self.make_plugin(snapshot)
                await p._submit_skill(self.auto_event(), "mine_stone", {"count": 5}, "挖石头")
                p.life._set_plan(p.life._pending_plan, source="agent"); p.life._pending_plan = []
                step = await p.life._survival_step()
                self.assertEqual(step["skill"], expected)
                self.assertEqual(p.life._plan[0]["params"], {"count": 5})
                p.engine.run_skill.assert_not_awaited()

    async def test_owner_skill_and_outdoor_agent_skill_keep_direct_execution(self):
        for autonomous, inside in ((False, True), (True, False)):
            with self.subTest(autonomous=autonomous, inside=inside):
                snapshot = state(food=20, inside=inside)
                p = self.make_plugin(snapshot)
                event = self.auto_event() if autonomous else P.Event()
                await p._submit_skill(event, "mine_stone", {"count": 5}, "挖石头")
                expected = {"count": 5}
                if autonomous:
                    expected["protected_home"] = p.life._home_for_state(snapshot)
                p.engine.run_skill.assert_awaited_once_with("mine_stone", expected)
                self.assertEqual(p.life._pending_plan, [])

    async def test_foreign_world_safe_status_cannot_defer_to_wrong_home(self):
        snapshot = state(food=20, inside=True)
        snapshot["home"] = record(); snapshot["server"] = "other:25565"
        p = self.make_plugin(snapshot)
        await p._submit_skill(self.auto_event(), "mine_stone", {"count": 5}, "挖石头")
        p.engine.run_skill.assert_awaited_once_with("mine_stone", {"count": 5})
        self.assertEqual(p.life._pending_plan, [])

    async def test_existing_plan_and_owner_pending_are_not_overwritten(self):
        for barrier in ("plan", "pending_plan", "owner"):
            with self.subTest(barrier=barrier):
                p = self.make_plugin(state(food=20, inside=True))
                saved = [{"skill": "chop_tree", "params": {"count": 3}, "why": ""}]
                if barrier == "plan": p.life._set_plan(saved)
                elif barrier == "pending_plan": p.life._pending_plan = copy.deepcopy(saved)
                else: p.life._decision_owner_pending = True
                result = await p._submit_skill(self.auto_event(), "mine_stone", {"count": 5}, "挖石头")
                self.assertTrue(str(result).startswith("error:"))
                p.engine.run_skill.assert_not_awaited()
                if barrier == "plan": self.assertEqual(p.life._plan, saved)
                elif barrier == "pending_plan": self.assertEqual(p.life._pending_plan, saved)

    async def test_world_owner_or_new_plan_change_during_snapshot_discards_old_tool(self):
        for change in ("world", "owner", "plan", "emergency"):
            with self.subTest(change=change):
                snapshot = state(food=20, inside=True)
                p = self.make_plugin(snapshot)
                saved = [{"skill": "chop_tree", "params": {"count": 3}}]
                async def changed():
                    if change == "world": p.life.on_world_change()
                    elif change == "owner": p.life._decision_owner_pending = True
                    elif change == "plan": p.life._pending_plan = copy.deepcopy(saved)
                    else: p._emergency_stopped = True
                    return copy.deepcopy(snapshot)
                p.life._state_provider = changed
                result = await p._submit_skill(self.auto_event(), "mine_stone", {"count": 5}, "挖石头")
                self.assertTrue(str(result).startswith("error:"))
                p.engine.run_skill.assert_not_awaited()
                self.assertEqual(p.life._pending_plan, saved if change == "plan" else [])

    async def test_agent_stops_tool_batch_as_soon_as_direct_skill_becomes_pending_plan(self):
        from types import SimpleNamespace
        from astrcraft_plugin.action_agent import ActionAgent, MAX_STEPS
        snapshot = state(food=20, inside=True)
        p = self.make_plugin(snapshot)
        calls, provider_calls = [], []
        async def chat(**kwargs):
            provider_calls.append(kwargs)
            return SimpleNamespace(tools_call_name=["mc_mine_ores", "mc_collect"],
                tools_call_args=[{"ore": "iron", "count": 7}, {"item": "oak_log", "count": 4}],
                tools_call_ids=["first", "second"], completion_text="",
                to_openai_tool_calls_model=lambda: [])
        async def get_provider(): return SimpleNamespace(text_chat=chat)
        p.context = SimpleNamespace(get_using_provider_async=get_provider)
        agent = ActionAgent.__new__(ActionAgent)
        agent.plugin = p; agent.max_steps = MAX_STEPS; agent._toolset = lambda: "fixture"
        async def execute(name, args, event):
            calls.append(name)
            return await p._submit_skill(event, "mine_ores" if name == "mc_mine_ores" else "collect", args, name)
        agent._execute = execute
        summary, used = await agent.act(prompt="test", system="test")
        self.assertEqual(calls, ["mc_mine_ores"])
        self.assertEqual(used, calls)
        self.assertEqual(len(provider_calls), 1)
        self.assertEqual(agent.last_timing["exit_reason"], "plan_ready")
        self.assertEqual(p.life._pending_plan[0]["params"], {"ore": "iron", "count": 7})
        p.engine.run_skill.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
