"""Real LifeLoop checks for compound dependencies across a closed base door."""
from __future__ import annotations

import asyncio
import copy
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_base_food as B
import test_supply_resume as S
import test_life_recovery as R
import test_plugin_control as P


def indoors(inventory=None, *, food=20, health=20, night=False, furniture=None):
    snapshot = B.state(food=food, health=health, inside=True)
    snapshot["inventory"] = dict(inventory if inventory is not None else {"bread": 4, "stone_pickaxe": 1})
    snapshot["is_night"] = night
    if furniture is not None:
        snapshot["home_status"]["furniture"] = {"bed": True, "chest": True, **furniture}
    return snapshot


class CompoundHomeTests(unittest.IsolatedAsyncioTestCase):
    def assert_work_params(self, actual, original, *, inside=False):
        """User goals survive the automatically added safe-search boundary."""
        for name, value in original.items():
            self.assertEqual(actual.get(name), False if inside and name == "allow_search" else value)
        self.assertTrue(actual.get("safe_search"))
        if inside:
            self.assertFalse(actual.get("allow_search"))
            self.assertEqual(actual["home"]["origin"], B.record()["origin"])
            self.assertEqual(actual["home"]["server"], B.record()["server"])

    def make_loop(self, snapshot):
        loop = S.SupplyResumeTests.make_loop(self, snapshot)
        loop.remember_home(B.record())
        # Empty shelf is verified in this fixture. Tests concern the compound's
        # own dependencies, rather than inserting another warehouse probe.
        loop.note_home_food(B.record(), {"food_stock_checked": True, "food_stock_empty": True})
        return loop

    def test_dependency_predicate_uses_actual_materials_and_requested_tools(self):
        sufficient = (
            ("make_tools", {"tier": "stone", "kinds": ["pickaxe"]},
             {"cobblestone": 3, "stick": 2, "crafting_table": 1}),
            ("make_tools", {"tier": "iron", "kinds": ["shovel"]},
             {"iron_ingot": 1, "stick": 2, "crafting_table": 1}),
            ("make_tools", {"tier": "wooden", "kinds": ["pickaxe"]},
             {"wooden_pickaxe": 1}),
            ("cook_food", {"count": 2}, {"wheat": 6, "crafting_table": 1}),
            ("cook_food", {"count": 2}, {"beef": 2, "furnace": 1, "coal": 1}),
            ("cook_food", {"count": 4}, {"wheat": 3, "crafting_table": 1}),
            ("cook_food", {"count": 4}, {"cod": 1, "furnace": 1, "coal": 1}),
            ("food_chain", {}, {"bread": 4, "stone_pickaxe": 1, "torch": 4}),
            ("food_chain", {}, {"bread": 4, "cobblestone": 3, "stick": 3,
                                 "coal": 1, "crafting_table": 1}),
            ("smelt", {"item": "raw_iron", "count": 2},
             {"raw_iron": 2, "furnace": 1, "coal": 1}),
        )
        for skill, params, inventory in sufficient:
            with self.subTest(skill=skill, params=params, inventory=inventory):
                snapshot = indoors(inventory)
                self.assertFalse(self.make_loop(snapshot)._skill_needs_outdoors(skill, params, snapshot))
        for skill, params, inventory in (
            ("make_tools", {"tier": "wooden", "kinds": ["pickaxe"]}, {}),
            ("make_tools", {"tier": "stone", "kinds": ["axe", "shovel"]},
             {"cobblestone": 3, "stick": 4, "crafting_table": 1, "wooden_pickaxe": 1}),
            ("cook_food", {"count": 2}, {}),
            ("cook_food", {"count": 2}, {"wheat": 6}),
            ("food_chain", {}, {"bread": 4, "coal": 1}),
            ("smelt", {"item": "raw_iron", "count": 2}, {"raw_iron": 2}),
        ):
            with self.subTest(skill=skill, inventory=inventory):
                snapshot = indoors(inventory)
                self.assertTrue(self.make_loop(snapshot)._skill_needs_outdoors(skill, params, snapshot))

    def test_loaded_internal_stations_override_historical_furniture(self):
        for skill, params, inventory, station in (
            ("cook_food", {"count": 2}, {"wheat": 6}, "crafting_table"),
            ("smelt", {"item": "raw_iron", "count": 1}, {"raw_iron": 1, "coal": 1}, "furnace"),
        ):
            snapshot = indoors(inventory, furniture={station: True})
            loop = self.make_loop(snapshot)
            self.assertFalse(loop._skill_needs_outdoors(skill, params, snapshot))
            snapshot["home_status"]["furniture"][station] = False
            loop._homes[0]["furnished"][station] = True
            self.assertTrue(loop._skill_needs_outdoors(skill, params, snapshot),
                            "historical furniture must not replace a loaded absent workstation")

    def test_disallowed_material_search_does_not_request_exit(self):
        snapshot = indoors({"bread": 4})
        loop = self.make_loop(snapshot)
        self.assertFalse(loop._skill_needs_outdoors("make_tools",
            {"tier": "wooden", "kinds": ["pickaxe"], "allow_search": False}, snapshot))
        self.assertFalse(loop._skill_needs_outdoors("smelt", {"item": "raw_iron", "count": 1}, snapshot),
                         "smelt does not mine an absent input")
        self.assertFalse(loop._skill_needs_outdoors("food_chain", {},
            indoors({"bread": 4, "stone_pickaxe": 1, "stick": 1})),
            "food_chain reports missing torch fuel; it does not automatically mine coal")

    def test_existing_iron_inputs_and_actual_compatible_furnaces_avoid_replacement_mining(self):
        snapshot = indoors({"bread": 4, "raw_iron": 1, "iron_ore": 1, "deepslate_iron_ore": 1,
                            "coal": 1, "oak_log": 1, "spruce_log": 2},
                           furniture={"crafting_table": True, "smoker": True, "blast_furnace": True})
        loop = self.make_loop(snapshot)
        params = {"tier": "iron", "kinds": ["pickaxe"]}
        self.assertFalse(loop._skill_needs_outdoors("make_tools", params, snapshot))
        snapshot["home_status"]["furniture"]["blast_furnace"] = False
        self.assertTrue(loop._skill_needs_outdoors("make_tools", params, snapshot), "a smoker cannot smelt iron")
        for fuel_item, amount, expected in (("acacia_planks", 1, False), ("dark_oak_log", 1, False),
                                           ("stick", 1, True), ("stick", 2, False), ("crimson_planks", 8, True)):
            with self.subTest(fuel=fuel_item, amount=amount):
                meal = indoors({"cod": 1, "furnace": 1, fuel_item: amount})
                self.assertEqual(self.make_loop(meal)._skill_needs_outdoors("cook_food", {"count": 1}, meal), expected)

    def test_actual_lit_compatible_station_can_be_tried_but_history_and_wrong_station_cannot(self):
        for skill, params, inventory, station in (
            ("cook_food", {"count": 2}, {"cod": 2}, "smoker"),
            ("smelt", {"item": "raw_iron", "count": 1}, {"raw_iron": 1}, "blast_furnace"),
            ("cook_food", {"count": 2}, {"beef": 2}, "furnace"),
        ):
            with self.subTest(skill=skill, station=station):
                snapshot = indoors(inventory, furniture={station: True, f"{station}_lit": True})
                loop = self.make_loop(snapshot)
                self.assertFalse(loop._skill_needs_outdoors(skill, params, snapshot))
                snapshot["home_status"]["furniture"][f"{station}_lit"] = False
                loop._homes[0]["furnished"][f"{station}_lit"] = True
                self.assertTrue(loop._skill_needs_outdoors(skill, params, snapshot))
                snapshot["home_status"]["furniture"].update(smoker=True, smoker_lit=True)
                if skill == "smelt":
                    self.assertTrue(loop._skill_needs_outdoors(skill, params, snapshot), "a lit smoker cannot smelt iron")

    async def test_daytime_shortage_exits_before_compound_and_keeps_exact_followup(self):
        for skill, params, inventory in (
            ("make_tools", {"tier": "wooden", "kinds": ["axe"], "allow_search": True}, {"bread": 4}),
            ("cook_food", {"count": 3}, {"bread": 1, "stone_pickaxe": 1}),
            ("food_chain", {}, {"bread": 4, "coal": 1}),
            ("smelt", {"item": "raw_iron", "count": 2}, {"bread": 4, "raw_iron": 2}),
        ):
            with self.subTest(skill=skill):
                snapshot = indoors(inventory)
                loop = self.make_loop(snapshot)
                plan = [{"skill": skill, "params": params},
                        {"skill": "mine_ores", "params": {"ore": "coal", "count": 5, "radius": 9}}]
                loop._set_plan(plan)
                submitted, complete = [], asyncio.Event()
                async def engine(method, payload=None, **kwargs):
                    if method == "task.list": return {"current": None, "queued": 0}
                    self.assertEqual(method, "skill.run")
                    submitted.append(copy.deepcopy(payload))
                    if payload["skill"] == "leave_home":
                        snapshot["home_status"].update(safe=False, inside=False)
                    else:
                        self.assertFalse(snapshot["home_status"]["inside"])
                        if payload["skill"] == "mine_ores":
                            complete.set(); loop._stopped = True
                    loop.note_task_result(payload["skill"], True); loop.wake()
                    return {"task_id": str(len(submitted))}
                loop._call = engine
                await S.SupplyResumeTests.run_until(self, loop, complete)
                self.assertEqual([p["skill"] for p in submitted], ["leave_home", skill, "mine_ores"])
                self.assert_work_params(submitted[1]["params"], params)
                B.assert_protected_params(self, submitted[2]["params"], plan[1]["params"])

    async def test_existing_materials_run_indoors_without_unnecessary_exit(self):
        for skill, params, inventory in (
            ("make_tools", {"tier": "stone", "kinds": ["pickaxe"]},
             {"bread": 4, "cobblestone": 3, "stick": 2, "crafting_table": 1}),
            ("cook_food", {"count": 2}, {"wheat": 6, "crafting_table": 1}),
            ("food_chain", {}, {"bread": 4, "stone_pickaxe": 1, "torch": 4}),
            ("smelt", {"item": "raw_iron", "count": 2},
             {"bread": 4, "raw_iron": 2, "furnace": 1, "coal": 1}),
        ):
            with self.subTest(skill=skill):
                snapshot = indoors(inventory)
                loop = self.make_loop(snapshot)
                loop._set_plan([{"skill": skill, "params": params}])
                submitted, complete = [], asyncio.Event()
                async def engine(method, payload=None, **kwargs):
                    if method == "task.list": return {"current": None, "queued": 0}
                    submitted.append(copy.deepcopy(payload))
                    self.assertTrue(snapshot["home_status"]["inside"])
                    complete.set(); loop._stopped = True
                    return {"task_id": "indoor-compound"}
                loop._call = engine
                await S.SupplyResumeTests.run_until(self, loop, complete)
                self.assertEqual([p["skill"] for p in submitted], [skill])
                self.assert_work_params(submitted[0]["params"], params, inside=True)

    async def test_food_chain_shares_pickaxe_and_torch_materials_before_selecting_exit(self):
        for planks, sticks, needs_exit in ((3, 2, True), (5, 2, False), (5, 0, False)):
            with self.subTest(planks=planks, sticks=sticks):
                snapshot = indoors({"bread": 4, "oak_planks": planks, "stick": sticks, "coal": 1},
                                   furniture={"crafting_table": True})
                loop = self.make_loop(snapshot)
                params = {"allow_search": True}
                self.assertEqual(loop._skill_needs_outdoors("food_chain", params, snapshot), needs_exit)
                loop._set_plan([{"skill": "food_chain", "params": params},
                                {"skill": "mine_stone", "params": {"count": 7}}])
                submitted, complete = [], asyncio.Event()
                async def engine(method, payload=None, **kwargs):
                    if method == "task.list": return {"current": None, "queued": 0}
                    submitted.append(copy.deepcopy(payload))
                    skill = payload["skill"]
                    if skill == "leave_home": snapshot["home_status"].update(safe=False, inside=False)
                    elif skill == "food_chain":
                        self.assertEqual(snapshot["home_status"]["inside"], not needs_exit)
                        self.assert_work_params(payload["params"], params, inside=not needs_exit)
                        snapshot["inventory"] = {"bread": 4, "wooden_pickaxe": 1, "torch": 4}
                    elif skill == "mine_stone":
                        B.assert_protected_params(self, payload["params"], {"count": 7})
                        self.assertFalse(snapshot["home_status"]["inside"])
                        complete.set(); loop._stopped = True
                    else: self.fail(skill)
                    loop.note_task_result(skill, True); loop.wake()
                    return {"task_id": str(len(submitted))}
                loop._call = engine
                await S.SupplyResumeTests.run_until(self, loop, complete)
                self.assertEqual([p["skill"] for p in submitted],
                    ["leave_home", "food_chain", "mine_stone"] if needs_exit
                    else ["food_chain", "leave_home", "mine_stone"])

    async def test_nighttime_existing_wheat_is_cooked_indoors_before_sleep(self):
        snapshot = indoors({"wheat": 6}, food=6, night=True, furniture={"crafting_table": True})
        loop = self.make_loop(snapshot)
        followup = {"skill": "make_tools", "params": {"tier": "stone", "kinds": ["pickaxe"]}}
        loop._set_plan([followup])
        submitted, complete = [], asyncio.Event()
        async def engine(method, payload=None, **kwargs):
            if method == "task.list": return {"current": None, "queued": 0}
            submitted.append(copy.deepcopy(payload))
            self.assertTrue(snapshot["home_status"]["inside"])
            if payload["skill"] == "cook_food": snapshot["inventory"] = {"bread": 2}
            elif payload["skill"] == "eat": snapshot["food"] = 20
            elif payload["skill"] == "sleep": complete.set(); loop._stopped = True
            else: self.fail(payload["skill"])
            loop.note_task_result(payload["skill"], True); loop.wake()
            return {"task_id": str(len(submitted))}
        loop._call = engine
        await S.SupplyResumeTests.run_until(self, loop, complete)
        self.assertEqual([p["skill"] for p in submitted], ["cook_food", "eat", "sleep"])
        self.assertEqual(loop._plan[0]["params"], followup["params"])

    async def test_nighttime_shortage_sleeps_then_exits_and_resumes_same_plan_at_dawn(self):
        snapshot = indoors({"bread": 4}, night=True)
        loop = self.make_loop(snapshot)
        plan = [{"skill": "make_tools", "params": {"tier": "wooden", "kinds": ["pickaxe"]}},
                {"skill": "mine_stone", "params": {"count": 7, "radius": 8}}]
        loop._set_plan(plan)
        submitted, complete = [], asyncio.Event()
        async def engine(method, payload=None, **kwargs):
            if method == "task.list": return {"current": None, "queued": 0}
            submitted.append(copy.deepcopy(payload))
            skill = payload["skill"]
            if skill == "sleep":
                self.assertEqual([p["params"] for p in loop._plan], [p["params"] for p in plan])
                snapshot["is_night"] = False
            elif skill == "leave_home":
                self.assertFalse(snapshot["is_night"])
                snapshot["home_status"].update(safe=False, inside=False)
            elif skill == "mine_stone": complete.set(); loop._stopped = True
            else: self.assertEqual(skill, "make_tools")
            loop.note_task_result(skill, True); loop.wake()
            return {"task_id": str(len(submitted))}
        loop._call = engine
        await S.SupplyResumeTests.run_until(self, loop, complete)
        self.assertEqual([p["skill"] for p in submitted], ["sleep", "leave_home", "make_tools", "mine_stone"])
        self.assert_work_params(submitted[-2]["params"], plan[0]["params"])
        B.assert_protected_params(self, submitted[-1]["params"], plan[1]["params"])

    async def test_critical_health_recovers_before_exit_without_discarding_dependencies(self):
        snapshot = indoors({"bread": 4}, health=6)
        loop = self.make_loop(snapshot)
        params = {"tier": "wooden", "kinds": ["pickaxe"]}
        loop._set_plan([{"skill": "make_tools", "params": params}])
        step = await loop._survival_step()
        self.assertEqual(step["skill"], "recover")
        self.assertEqual(loop._plan[0]["params"], params)
        snapshot["health"] = 12
        self.assertEqual((await loop._survival_step())["skill"], "leave_home")
        self.assertEqual(loop._plan[0]["params"], params)

    async def test_unknown_daylight_waits_without_losing_compound_plan(self):
        snapshot = indoors({"bread": 4}); snapshot["is_night"] = None
        loop = self.make_loop(snapshot)
        params = {"tier": "wooden", "kinds": ["axe"]}
        loop._set_plan([{"skill": "make_tools", "params": params}])
        submitted = []
        async def engine(method, payload=None, **kwargs):
            if method == "task.list": return {"current": None, "queued": 0}
            submitted.append(copy.deepcopy(payload)); loop._stopped = True
            return {"task_id": "must-not-leave"}
        loop._call = engine
        loop._wake.set(); loop.start()
        try:
            await asyncio.sleep(0.04)
            self.assertEqual(submitted, [])
            self.assertEqual(loop._plan[0]["params"], params)
        finally: await loop.stop()

    async def test_new_json_compound_first_step_obeys_exit_boundary_and_retains_metadata(self):
        snapshot = indoors({"bread": 4})
        loop, _ = R.make_loop()
        loop._state_provider = lambda: asyncio.sleep(0, result=copy.deepcopy(snapshot))
        loop.remember_home(B.record()); loop._decide_interval = 0.001
        submitted, model_calls, complete = [], [], asyncio.Event()
        params = {"tier": "wooden", "kinds": ["pickaxe"], "allow_search": True}
        async def model(prompt, system):
            model_calls.append(True)
            return json.dumps({"activity": "准备木镐", "skill": "make_tools", "params": params,
                               "reason": "缺木材时白天出门", "say": "去补木头"})
        async def engine(method, payload=None, **kwargs):
            if method == "task.list": return {"current": None, "queued": 0}
            submitted.append(copy.deepcopy(payload))
            if payload["skill"] == "leave_home": snapshot["home_status"].update(safe=False, inside=False)
            else:
                self.assertEqual(payload["skill"], "make_tools")
                self.assertFalse(snapshot["home_status"]["inside"])
                complete.set(); loop._stopped = True
            loop.note_task_result(payload["skill"], True); loop.wake()
            return {"task_id": str(len(submitted))}
        loop._llm, loop._call = model, engine
        await S.SupplyResumeTests.run_until(self, loop, complete)
        self.assertEqual([p["skill"] for p in submitted], ["leave_home", "make_tools"])
        self.assert_work_params(submitted[-1]["params"], params)
        self.assertEqual(len(model_calls), 1)
        self.assertEqual(loop.history[-1].activity, "准备木镐")
        self.assertEqual(loop.history[-1].say, "去补木头")

    async def test_owner_or_world_change_during_snapshot_prevents_stale_exit(self):
        for change in ("owner", "world"):
            with self.subTest(change=change):
                snapshot = indoors({"bread": 4})
                loop = self.make_loop(snapshot)
                loop._set_plan([{"skill": "make_tools", "params": {"tier": "wooden", "kinds": ["pickaxe"]}}])
                entered, release = asyncio.Event(), asyncio.Event()
                async def delayed():
                    entered.set(); await release.wait()
                    return copy.deepcopy(snapshot)
                loop._state_provider = delayed
                pending = asyncio.create_task(loop._survival_step())
                await entered.wait()
                if change == "owner": loop.note_owner_said("先留在屋里")
                else: loop.on_world_change()
                release.set()
                self.assertIsNone(await pending)
                self.assertIsNone(loop._rule_supply_candidate)

    async def test_direct_autonomous_skill_tool_rejoins_the_same_compound_boundary(self):
        snapshot = indoors({"bread": 4})
        loop = self.make_loop(snapshot); loop.note_unblocked()
        p = P.plugin(); p.life = loop; p._ensure_engine = AsyncMock(return_value=True)
        prematurely_submitted = []
        async def direct(skill, params):
            prematurely_submitted.append((skill, params)); return {"task_id": "premature"}
        p.engine.run_skill = direct
        event = SimpleNamespace(astrcraft_autonomous=True, plain_result=lambda text: text)
        params = {"tier": "wooden", "kinds": ["pickaxe"], "allow_search": True}
        result = await p._submit_skill(event, "make_tools", params, "准备木镐")
        self.assertEqual(prematurely_submitted, [])
        self.assertNotIn("error:", str(result))
        self.assertEqual(loop._pending_plan[0]["params"], params)
        submitted, complete = [], asyncio.Event()
        async def engine(method, payload=None, **kwargs):
            if method == "task.list": return {"current": None, "queued": 0}
            submitted.append(copy.deepcopy(payload))
            if payload["skill"] == "leave_home": snapshot["home_status"].update(safe=False, inside=False)
            else:
                self.assertEqual(payload["skill"], "make_tools")
                self.assertFalse(snapshot["home_status"]["inside"])
                complete.set(); loop._stopped = True
            loop.note_task_result(payload["skill"], True); loop.wake()
            return {"task_id": str(len(submitted))}
        loop._call = engine
        await S.SupplyResumeTests.run_until(self, loop, complete)
        self.assertEqual([p["skill"] for p in submitted], ["leave_home", "make_tools"])
        self.assert_work_params(submitted[-1]["params"], params)

    async def test_loop_cancelled_while_snapshot_pending_cannot_submit_old_exit(self):
        snapshot = indoors({"bread": 4})
        loop = self.make_loop(snapshot)
        loop._set_plan([{"skill": "make_tools", "params": {"tier": "wooden", "kinds": ["pickaxe"]}}])
        entered, release, submitted = asyncio.Event(), asyncio.Event(), []
        async def delayed():
            entered.set(); await release.wait()
            return copy.deepcopy(snapshot)
        async def engine(method, payload=None, **kwargs):
            if method == "task.list": return {"current": None, "queued": 0}
            submitted.append(payload); return {"task_id": "stale"}
        loop._state_provider, loop._call = delayed, engine
        loop._wake.set(); loop.start()
        await entered.wait(); await loop.stop(); release.set()
        await asyncio.sleep(0)
        self.assertEqual(submitted, [])
        self.assertTrue(loop._task.done())

    async def test_pause_in_activity_callback_prevents_queued_exit_submission(self):
        snapshot = indoors({"bread": 4})
        loop = self.make_loop(snapshot)
        loop._set_plan([{"skill": "make_tools", "params": {"tier": "wooden", "kinds": ["pickaxe"]}}])
        submitted = []
        async def engine(method, payload=None, **kwargs):
            submitted.append((method, payload)); return {"task_id": "stale"}
        async def activity(decision): loop.pause(reason="owner takes control", max_seconds=0)
        loop._call, loop._on_activity = engine, activity
        step = await loop._survival_step()
        self.assertEqual(step["skill"], "leave_home")
        await loop._act(loop._decision_from_step(step), allow_model_block=True)
        self.assertEqual(submitted, [])

    async def test_material_change_before_submission_restores_original_goal_before_followup(self):
        snapshot = indoors({"bread": 4, "cobblestone": 3, "stick": 2, "crafting_table": 1})
        loop = self.make_loop(snapshot)
        params = {"tier": "stone", "kinds": ["pickaxe"]}
        tail = {"skill": "mine_ores", "params": {"ore": "coal", "count": 3}}
        loop._set_plan([{"skill": "make_tools", "params": params}, tail])
        self.assertIsNone(await loop._survival_step())
        decision = loop._decision_from_step(loop._pop_plan_step())
        decision.activity, decision.say, decision.reason = "准备石镐", "先准备好镐", "保留原任务"
        submitted = []
        async def engine(method, payload=None, **kwargs):
            submitted.append((method, payload)); return {"task_id": "must-not-craft"}
        async def activity(current): snapshot["inventory"]["cobblestone"] = 0
        loop._call, loop._on_activity = engine, activity
        await loop._act(decision, allow_model_block=True)
        self.assertEqual(submitted, [])
        self.assertEqual([step["skill"] for step in loop._plan], ["make_tools", "mine_ores"])
        self.assertEqual(loop._plan[0]["params"], params)
        self.assertIs(loop._plan[0]["decision"], decision)
        self.assertEqual(loop._plan[1]["params"], tail["params"])
        self.assertEqual((await loop._survival_step())["skill"], "leave_home")

    async def test_missing_preflight_state_preserves_step_and_waits_without_failure_poison(self):
        snapshot = indoors({"bread": 4, "cobblestone": 3, "stick": 2, "crafting_table": 1})
        loop = self.make_loop(snapshot)
        params = {"tier": "stone", "kinds": ["pickaxe"]}
        loop._set_plan([{"skill": "make_tools", "params": params}])
        decision = loop._decision_from_step(loop._pop_plan_step())
        async def unavailable(): raise RuntimeError("fresh RPC unavailable")
        submitted = []
        async def engine(method, payload=None, **kwargs):
            submitted.append((method, payload)); return {"task_id": "must-not-start"}
        loop._state_provider, loop._call = unavailable, engine
        await loop._act(decision, allow_model_block=True)
        self.assertEqual(submitted, [])
        self.assertEqual(loop._plan[0]["params"], params)
        self.assertEqual(loop._failure_counts(), {})
        self.assertIsNone(await loop._survival_step())
        self.assertTrue(loop._rule_supply_wait_reason)
        self.assertEqual(loop._plan[0]["params"], params)

    async def test_missing_snapshot_uses_bounded_polling_and_fresh_wake_resumes_without_model(self):
        snapshot = indoors({"bread": 4, "cobblestone": 3, "stick": 2, "crafting_table": 1})
        loop = self.make_loop(snapshot)
        params = {"tier": "stone", "kinds": ["pickaxe"]}
        loop._set_plan([{"skill": "make_tools", "params": params}])
        state_calls, submitted, available, complete = [], [], False, asyncio.Event()
        async def provider():
            state_calls.append(True)
            return copy.deepcopy(snapshot) if available else {}
        async def engine(method, payload=None, **kwargs):
            if method == "task.list": return {"current": None, "queued": 0}
            submitted.append(copy.deepcopy(payload)); complete.set(); loop._stopped = True
            return {"task_id": "fresh-recovery"}
        loop._state_provider, loop._call = provider, engine
        loop._wake.set(); loop.start()
        try:
            await asyncio.sleep(0.06)
            self.assertEqual(len(state_calls), 1, "unknown state must not spin at the configured millisecond interval")
            self.assertEqual(submitted, [])
            self.assertEqual(loop._plan[0]["params"], params)
            available = True; loop.wake("fresh snapshot available")
            await asyncio.wait_for(complete.wait(), timeout=0.2)
            self.assertEqual([p["skill"] for p in submitted], ["make_tools"])
            self.assert_work_params(submitted[0]["params"], params, inside=True)
        finally: await loop.stop()

    async def test_owner_or_world_change_during_compound_preflight_prevents_submission(self):
        for change in ("owner", "world"):
            with self.subTest(change=change):
                snapshot = indoors({"bread": 4, "cobblestone": 3, "stick": 2, "crafting_table": 1})
                loop = self.make_loop(snapshot)
                loop._set_plan([{"skill": "make_tools", "params": {"tier": "stone", "kinds": ["pickaxe"]}}])
                decision = loop._decision_from_step(loop._pop_plan_step())
                entered, release, submitted = asyncio.Event(), asyncio.Event(), []
                async def delayed():
                    entered.set(); await release.wait()
                    return copy.deepcopy(snapshot)
                async def engine(method, payload=None, **kwargs):
                    submitted.append(payload); return {"task_id": "stale"}
                loop._state_provider, loop._call = delayed, engine
                pending = asyncio.create_task(loop._act(decision, allow_model_block=True))
                await entered.wait()
                if change == "owner": loop.note_owner_said("先别做工具")
                else: loop.on_world_change()
                release.set(); await pending
                self.assertEqual(submitted, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
