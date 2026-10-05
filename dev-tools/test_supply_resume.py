"""Offline real-loop checks for rule supply, plan resumption and stalled completion."""

from __future__ import annotations

import asyncio
import copy
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _paths

_paths.require_astrbot("test_supply_resume")
L = _paths.plugin_module("life")


class Memory:
    def remember(self, *args, **kwargs):
        pass


class Drives:
    def tick(self):
        pass

    def save(self):
        pass

    def note_activity(self, **kwargs):
        pass


class SupplyResumeTests(unittest.IsolatedAsyncioTestCase):
    def make_loop(self, state):
        async def snapshot():
            return {"is_night": False, **copy.deepcopy(state)}

        async def text():
            return "offline fixture"

        async def no_model(*args, **kwargs):
            raise AssertionError("supply and established plan must not call a model")

        async def idle(method, params=None, **kwargs):
            return {"current": None, "queued": 0}

        loop = L.LifeLoop(
            engine_call=idle, memory=Memory(), drives=Drives(),
            brief_provider=text, system_prompt_provider=text, llm=no_model,
            state_provider=snapshot, is_connected=lambda: True, decide_interval=0.001,
        )
        loop.note_blocked("offline fixture", retry_after=120)
        return loop

    async def run_until(self, loop, complete, timeout=1):
        loop._wake.set()
        loop.start()
        try:
            await asyncio.wait_for(complete.wait(), timeout=timeout)
            await asyncio.sleep(0)
        finally:
            await loop.stop()

    async def test_food_recovery_and_storage_resume_exact_original_steps(self):
        state = {"health": 6, "food": 0, "inventory": {"wheat": 9, "oak_log": 2},
                 "inventory_slots_used": 34, "server": "fixture", "dimension": "overworld"}
        loop = self.make_loop(state)
        for _ in range(3):
            loop.note_task_result("mine_ores", False, "no reachable ore")
        self.assertFalse(loop.skill_retry_ready("mine_ores"))
        plan = [{"skill": "mine_stone", "params": {"count": 7}},
                {"skill": "make_tools", "params": {"tier": "stone", "kinds": ["pickaxe"]}}]
        loop._set_plan(plan)
        deadline = loop._decision_retry_at
        submitted, complete = [], asyncio.Event()

        async def engine(method, params=None, **kwargs):
            if method == "task.list":
                return {"current": None, "queued": 0}
            self.assertEqual(method, "skill.run")
            submitted.append(copy.deepcopy(params))
            skill = params["skill"]
            if skill == "cook_food":
                state["inventory"] = {"bread": 3, "oak_log": 2}
            elif skill == "eat":
                state["food"] = 20
                state["inventory"]["bread"] = 1
            elif skill == "recover":
                state["health"] = 12
            elif skill == "store_items":
                state["inventory_slots_used"] = 28
            elif skill == "make_tools":
                complete.set()
                loop._stopped = True
            elif skill != "mine_stone":
                self.fail(f"unexpected skill {skill}")
            # Completion can precede the RPC response; grace must stay cleared.
            loop.note_task_result(skill, True)
            loop.wake("finished before RPC response")
            await asyncio.sleep(0)
            return {"task_id": f"t{len(submitted)}"}

        loop._call = engine
        await self.run_until(loop, complete)
        self.assertEqual([p["skill"] for p in submitted],
                         ["cook_food", "eat", "recover", "store_items", "mine_stone", "make_tools"])
        self.assertEqual(submitted[-2], {"skill": plan[0]["skill"], "params": plan[0]["params"]})
        self.assertEqual(submitted[-1], {"skill": plan[1]["skill"],
            "params": {**plan[1]["params"], "safe_search": True}})
        self.assertEqual(loop._plan, [])
        self.assertEqual(loop._busy_until, 0)
        self.assertEqual(loop._decision_retry_at, deadline)
        self.assertEqual(loop.current_hold(), L.Hold.BLOCKED)
        self.assertFalse(loop.skill_retry_ready("mine_ores"))

    async def test_refreshed_same_skill_runs_once_then_resumes_after_early_completion(self):
        state = {"health": 20, "food": 0, "inventory": {},
                 "nearby_entities": [{"name": "pig", "distance": 3, "hostile": False}]}
        loop = self.make_loop(state)
        loop._set_plan([{"skill": "hunt", "params": {"mob": "cow", "count": 4}},
                        {"skill": "mine_stone", "params": {"count": 5}}])
        submitted, complete = [], asyncio.Event()

        async def engine(method, params=None, **kwargs):
            if method == "task.list":
                return {"current": None, "queued": 0}
            submitted.append(copy.deepcopy(params))
            if params["skill"] == "hunt":
                state["inventory"] = {"porkchop": 1}
                state["nearby_entities"] = []
            elif params["skill"] == "eat":
                state["food"] = 12
                state["inventory"] = {}
            else:
                self.assertEqual(params, {"skill": "mine_stone", "params": {"count": 5}})
                complete.set()
                loop._stopped = True
            loop.note_task_result(params["skill"], True)
            loop.wake("immediate completion")
            await asyncio.sleep(0.002)
            return {"task_id": "fixture"}

        loop._call = engine
        await self.run_until(loop, complete)
        self.assertEqual(submitted, [
            {"skill": "hunt", "params": {"mob": "pig", "count": 1}},
            {"skill": "eat", "params": {"item": "porkchop", "target_food": 12}},
            {"skill": "mine_stone", "params": {"count": 5}},
        ])
        self.assertEqual(loop._busy_until, 0)

    async def test_two_completed_but_unchanged_supplies_stay_bounded_with_empty_plan(self):
        state = {"health": 20, "food": 4, "inventory": {"wheat": 9}}
        loop = self.make_loop(state)
        loop._set_plan([{"skill": "mine_stone", "params": {"count": 4}}])
        attempts = []

        async def engine(method, params=None, **kwargs):
            if method == "task.list":
                return {"current": None, "queued": 0}
            attempts.append(params["skill"])
            loop.note_task_result(params["skill"], True)
            loop.wake("reported done without state improvement")
            # Fail boundedly before the production fix, instead of spinning.
            if len(attempts) >= 4:
                loop._stopped = True
            return {"task_id": "unchanged"}

        loop._call = engine
        loop._wake.set()
        loop.start()
        try:
            await asyncio.sleep(0.07)
            self.assertEqual(attempts, ["cook_food", "cook_food"])
            self.assertEqual(loop._plan, [])
            self.assertEqual(loop.current_hold(), L.Hold.BLOCKED)
            self.assertFalse(loop.skill_retry_ready("cook_food"))
            # Further empty-plan ticks must not recreate the stalled rule.
            await asyncio.sleep(0.04)
            self.assertEqual(len(attempts), 2)
            with patch.object(L.time, "time", return_value=loop._failure_cooldowns["cook_food"] + 1):
                self.assertTrue(loop.skill_retry_ready("cook_food"))
                self.assertIsNone(await loop._survival_step())
                self.assertEqual(len(attempts), 2)
                # Worsening hunger is not evidence that this strategy now works.
                state["food"] = 2
                self.assertIsNone(await loop._survival_step())
                # A newly planned remedy must not be erased by the blocked rule.
                remedy = {"skill": "collect", "params": {"item": "wheat", "count": 3}}
                loop._set_plan([remedy])
                self.assertIsNone(await loop._survival_step())
                self.assertEqual(loop._pop_plan_step()["params"], remedy["params"])
        finally:
            await loop.stop()

    async def test_partial_eating_progress_does_not_become_a_stalled_rule(self):
        state = {"health": 20, "food": 0, "inventory": {"sweet_berries": 10}}
        loop = self.make_loop(state)
        loop._set_plan([{"skill": "mine_stone", "params": {"count": 3}}])
        attempted, complete = [], asyncio.Event()

        async def engine(method, params=None, **kwargs):
            if method == "task.list":
                return {"current": None, "queued": 0}
            skill = params["skill"]
            attempted.append(skill)
            if skill == "eat":
                # Partial success need not reach the requested target of 18.
                state["food"] += 2
                state["inventory"]["sweet_berries"] -= 1
            else:
                self.assertEqual(skill, "mine_stone")
                complete.set()
                loop._stopped = True
            loop.note_task_result(skill, True)
            loop.wake()
            return {"task_id": "partial"}

        loop._call = engine
        await self.run_until(loop, complete)
        self.assertEqual(attempted, ["eat"] * 6 + ["mine_stone"])
        self.assertEqual(loop._rule_supply_stalls, {})
        self.assertTrue(loop.skill_retry_ready("eat"))

    async def test_stalled_food_does_not_resume_unrelated_mining_in_real_loop(self):
        state = {"health": 20, "food": 2, "inventory": {"wheat": 9}}
        loop = self.make_loop(state)
        loop._rule_supply_stalls["cook_food"] = {
            "count": 2, "state": loop._supply_observation(state), "params": {"count": 3},
        }
        loop._set_plan([{"skill": "mine_ores", "params": {"ore": "iron", "count": 6}}])
        submitted = []

        async def engine(method, params=None, **kwargs):
            if method == "task.list":
                return {"current": None, "queued": 0}
            submitted.append(copy.deepcopy(params))
            loop._stopped = True
            return {"task_id": "must-not-mine-while-hungry"}

        loop._call = engine
        loop._wake.set()
        loop.start()
        try:
            await asyncio.sleep(0.04)
            self.assertEqual(submitted, [])
            self.assertEqual(loop._plan, [])
            self.assertEqual(loop.current_hold(), L.Hold.BLOCKED)
        finally:
            await loop.stop()

    async def test_stalled_cooking_permits_only_related_material_and_safety_steps(self):
        state = {"health": 20, "food": 6, "inventory": {"beef": 2}}
        loop = self.make_loop(state)
        remedies = [
            {"skill": "collect", "params": {"item": "wheat", "count": 3}},
            {"skill": "mine_ores", "params": {"ore": "coal", "count": 2}},
            {"skill": "mine_stone", "params": {"count": 8}},
            {"skill": "craft", "params": {"item": "furnace", "count": 1}},
            {"skill": "chop_tree", "params": {"count": 2}},
            {"skill": "make_tools", "params": {"tier": "wooden", "kinds": ["pickaxe"]}},
            {"skill": "make_tools", "params": {"tier": "STONE", "kinds": ["pickaxe"]}},
            {"skill": "return_home", "params": {"home": {"origin": {"x": 0, "y": 64, "z": 0}}}},
        ]
        unrelated = [
            {"skill": "mine_ores", "params": {"ore": "iron", "count": 6}},
            {"skill": "collect", "params": {"item": "diamond", "count": 1}},
            {"skill": "make_tools", "params": {"tier": "iron", "kinds": ["pickaxe"]}},
            {"skill": "cook_food", "params": {"count": 2}},
        ]
        for step in remedies + unrelated:
            with self.subTest(step=step):
                loop._rule_supply_stalls["cook_food"] = {
                    "count": 2, "state": loop._supply_observation(state), "params": {"count": 2},
                }
                loop._set_plan([step])
                self.assertIsNone(await loop._survival_step())
                if step in remedies:
                    self.assertEqual(loop._pop_plan_step()["params"], step["params"])
                else:
                    self.assertEqual(loop._plan, [])
        # Coal is a cooking dependency only while usable fuel is actually missing.
        for fuel in ("coal", "oak_log", "stick", "lava_bucket"):
            state["inventory"] = {"beef": 2, fuel: 2}
            loop._rule_supply_stalls["cook_food"] = {
                "count": 2, "state": loop._supply_observation(state), "params": {"count": 2},
            }
            loop._set_plan([{"skill": "mine_ores", "params": {"ore": "coal", "count": 2}}])
            self.assertIsNone(await loop._survival_step())
            self.assertEqual(loop._plan, [])

    async def test_stalled_recovery_can_eat_to_full_hunger_before_waiting_again(self):
        state = {"health": 6, "food": 18, "inventory": {"bread": 1}}
        loop = self.make_loop(state)
        loop._rule_supply_stalls["recover"] = {
            "count": 2, "state": loop._supply_observation(state),
            "params": {"target_health": 12, "timeout_seconds": 20},
        }
        remedy = {"skill": "eat", "params": {"target_food": 20}}
        loop._set_plan([remedy])
        self.assertIsNone(await loop._survival_step())
        self.assertEqual(loop._pop_plan_step()["params"], remedy["params"])

    async def test_stalled_bread_can_complete_table_materials_and_convert_existing_logs(self):
        for inventory, remedy in (
            ({"wheat": 9, "oak_planks": 1}, {"skill": "chop_tree", "params": {"count": 1}}),
            ({"wheat": 9, "oak_planks": 1}, {"skill": "collect", "params": {"item": "oak_planks", "count": 4}}),
            ({"wheat": 9, "oak_log": 1}, {"skill": "craft", "params": {"item": "oak_planks", "count": 4}}),
        ):
            with self.subTest(inventory=inventory, remedy=remedy):
                state = {"health": 20, "food": 6, "inventory": inventory}
                loop = self.make_loop(state)
                loop._rule_supply_stalls["cook_food"] = {
                    "count": 2, "state": loop._supply_observation(state), "params": {"count": 3},
                }
                loop._set_plan([remedy])
                self.assertIsNone(await loop._survival_step())
                self.assertEqual(loop._pop_plan_step()["params"], remedy["params"])

    async def test_partial_storage_reduces_items_before_a_slot_is_freed(self):
        state = {"health": 20, "food": 20, "inventory": {"dirt": 64, "stone_pickaxe": 1},
                 "inventory_slots_used": 34}
        loop = self.make_loop(state)
        loop._set_plan([{"skill": "mine_stone", "params": {"count": 2}}])
        attempted, complete = [], asyncio.Event()

        async def engine(method, params=None, **kwargs):
            if method == "task.list":
                return {"current": None, "queued": 0}
            skill = params["skill"]
            attempted.append(skill)
            if skill == "store_items":
                state["inventory"]["dirt"] -= 10
                if attempted.count("store_items") == 3:
                    state["inventory_slots_used"] = 31
            else:
                self.assertEqual(skill, "mine_stone")
                complete.set()
                loop._stopped = True
            loop.note_task_result(skill, True)
            loop.wake()
            return {"task_id": "partial-storage"}

        loop._call = engine
        await self.run_until(loop, complete)
        self.assertEqual(attempted, ["store_items"] * 3 + ["mine_stone"])
        self.assertEqual(loop._rule_supply_stalls, {})
        self.assertTrue(loop.skill_retry_ready("store_items"))

    async def perform_supply(self, loop):
        step = await loop._survival_step()
        if step is None:
            step = loop._pop_plan_step()
        self.assertIsNotNone(step)
        await loop._act(loop._decision_from_step(step), allow_model_block=True)

    async def test_cancelled_supply_is_not_a_completed_no_progress_attempt(self):
        state = {"health": 20, "food": 0, "inventory": {"wheat": 9}}
        loop = self.make_loop(state)
        attempts = 0

        async def engine(method, params=None, **kwargs):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                loop.note_task_cancelled(params["skill"], "owner interrupted")
            else:
                loop.note_task_result(params["skill"], True)
            loop.wake()
            return {"task_id": "cancel-fixture"}

        loop._call = engine
        await self.perform_supply(loop)
        await self.perform_supply(loop)
        self.assertIsNotNone(await loop._survival_step())
        self.assertEqual(loop._rule_supply_stalls["cook_food"]["count"], 1)
        self.assertEqual(loop._failure_counts(), {})
        self.assertTrue(loop.skill_retry_ready("cook_food"))

    async def test_real_new_resources_can_retry_after_cooldown_without_bypassing_owner(self):
        state = {"health": 20, "food": 0, "inventory": {"wheat": 9}}
        loop = self.make_loop(state)
        submitted = []

        async def engine(method, params=None, **kwargs):
            submitted.append(params["skill"])
            loop.note_task_result(params["skill"], True)
            loop.wake()
            return {"task_id": "restock-fixture"}

        loop._call = engine
        await self.perform_supply(loop)
        await self.perform_supply(loop)
        self.assertIsNone(await loop._survival_step())
        state["inventory"]["coal"] = 4
        self.assertIsNone(await loop._survival_step())  # Resources don't bypass the cooldown.
        expiry = loop._failure_cooldowns["cook_food"] + 1
        with patch.object(L.time, "time", return_value=expiry):
            self.assertEqual((await loop._survival_step())["skill"], "cook_food")
            loop.note_owner_said("这些食材留给我，先别做饭")
            self.assertIsNone(await loop._survival_step())
            loop._decision_inputs()
            self.assertIsNone(await loop._survival_step())
            await loop._act(L.LifeDecision(activity="补给", drive=None, skill="cook_food"),
                            allow_model_block=True)
        self.assertEqual(submitted, ["cook_food", "cook_food"])
        self.assertTrue(loop._owner_steer_pending())

    async def test_dimension_change_after_supply_observation_discards_old_action(self):
        state = {"health": 20, "food": 0, "inventory": {"wheat": 9},
                 "server": "fixture", "dimension": "overworld"}
        loop = self.make_loop(state)
        loop._set_plan([{"skill": "mine_stone", "params": {"count": 4}}])
        submitted = []

        async def changed(decision):
            loop.on_world_change()
            state["dimension"] = "the_nether"
            loop.on_world_ready()

        async def engine(method, params=None, **kwargs):
            submitted.append(params)
            return {"task_id": "must-not-submit"}

        loop._call = engine
        loop._on_activity = changed
        step = await loop._survival_step()
        await loop._act(loop._decision_from_step(step), allow_model_block=True)
        self.assertEqual(submitted, [])
        self.assertEqual(loop._plan, [])
        self.assertIsNone(loop._rule_supply_attempt)
        self.assertEqual(loop._rule_supply_stalls, {})
        self.assertEqual(loop.current_hold(), L.Hold.BLOCKED)

    async def test_real_failed_supplies_require_new_materials_and_keep_bounded_retry_history(self):
        state = {"health": 20, "food": 6, "inventory": {},
                 "server": "fixture", "dimension": "overworld"}
        loop = self.make_loop(state)
        submitted = []

        async def engine(method, params=None, **kwargs):
            submitted.append(params["skill"])
            loop.note_task_result(params["skill"], False, "食材或合成条件不足")
            loop.wake()
            return {"task_id": f"failed-{len(submitted)}"}

        loop._call = engine
        await self.perform_supply(loop)
        await self.perform_supply(loop)
        self.assertIsNone(await loop._survival_step())
        deadline = loop._failure_cooldowns["cook_food"] + 1
        state["food"] = 2
        state["inventory"] = {"wheat": 9, "crafting_table": 1}
        with patch.object(L.time, "time", return_value=deadline - 15):
            self.assertIsNone(await loop._survival_step())  # New supplies still await the cooldown.
        state["inventory"] = {}
        with patch.object(L.time, "time", return_value=deadline):
            self.assertTrue(loop.skill_retry_ready("cook_food"))
            self.assertIsNone(await loop._survival_step())
        state["inventory"] = {"wheat": 9, "crafting_table": 1}
        with patch.object(L.time, "time", return_value=deadline):
            await self.perform_supply(loop)
            self.assertEqual(loop._failure_counts()["cook_food"], 3)
            self.assertIsNone(await loop._survival_step())
            next_deadline = loop._failure_cooldowns["cook_food"] + 1
        with patch.object(L.time, "time", return_value=next_deadline):
            await self.perform_supply(loop)
            self.assertIsNone(await loop._survival_step())
            self.assertEqual(loop._failure_counts()["cook_food"], 4)
        with patch.object(L.time, "time", return_value=next_deadline + 1801):
            self.assertIsNone(await loop._survival_step())  # Time alone never renews a failed recipe.
            loop._set_plan([{"skill": "cook_food", "params": {"count": 1}}])
            self.assertIsNone(await loop._survival_step())
            self.assertEqual(loop._plan, [])  # A different requested count isn't a new supply.
        self.assertEqual(submitted, ["cook_food"] * 4)

    async def test_failed_supply_refresh_keeps_owner_pause_and_unknown_world_barriers(self):
        for barrier in ("owner", "pause", "unknown_world"):
            with self.subTest(barrier=barrier):
                state = {"health": 20, "food": 6, "inventory": {},
                         "server": "fixture", "dimension": "overworld"}
                loop = self.make_loop(state)

                async def engine(method, params=None, **kwargs):
                    loop.note_task_result(params["skill"], False, "缺食材")
                    return {"task_id": "failed"}

                loop._call = engine
                await self.perform_supply(loop)
                await self.perform_supply(loop)
                state["inventory"] = {"wheat": 9, "crafting_table": 1}
                if barrier == "owner":
                    loop.note_owner_said("这些小麦留给我")
                elif barrier == "pause":
                    loop.pause()
                else:
                    state["dimension"] = None
                with patch.object(L.time, "time", return_value=loop._failure_cooldowns["cook_food"] + 1):
                    self.assertIsNone(await loop._survival_step())
                    self.assertEqual(loop._rule_supply_failures["cook_food"]["count"], 2)

    async def test_fresh_verified_world_can_renew_a_failed_rule_after_its_cooldown(self):
        state = {"health": 20, "food": 6, "inventory": {},
                 "server": "fixture", "dimension": "overworld"}
        loop = self.make_loop(state)

        async def engine(method, params=None, **kwargs):
            loop.note_task_result(params["skill"], False, "旧世界没有食材")
            return {"task_id": "failed"}

        loop._call = engine
        await self.perform_supply(loop)
        await self.perform_supply(loop)
        deadline = loop._failure_cooldowns["cook_food"] + 1
        loop.on_world_change()
        state["dimension"] = "the_nether"
        with patch.object(L.time, "time", return_value=deadline):
            self.assertIsNone(await loop._survival_step())
            loop.on_world_ready()
            self.assertEqual((await loop._survival_step())["skill"], "cook_food")
            self.assertEqual(loop._failure_counts()["cook_food"], 2)

    async def test_failed_eating_recovery_and_storage_share_the_bounded_refresh_contract(self):
        for skill in ("eat", "recover", "store_items"):
            with self.subTest(skill=skill):
                state = {"health": 6 if skill == "recover" else 20,
                         "food": 18 if skill == "recover" else 6 if skill == "eat" else 20,
                         "inventory": {"bread": 1, "dirt": 64}, "inventory_slots_used": 34 if skill == "store_items" else 2,
                         "server": "fixture", "dimension": "overworld"}
                loop = self.make_loop(state)

                async def engine(method, params=None, **kwargs):
                    self.assertEqual(params["skill"], skill)
                    loop.note_task_result(skill, False, "当前补给条件不可用")
                    return {"task_id": "failed"}

                loop._call = engine
                for _ in range(2):
                    if skill == "store_items":
                        loop._set_plan([{"skill": "mine_stone", "params": {"count": 2}}])
                    await self.perform_supply(loop)
                deadline = loop._failure_cooldowns[skill] + 1
                if skill == "recover":
                    state["food"] = 20
                elif skill == "store_items":
                    state["inventory"]["chest"] = 1
                    loop._set_plan([{"skill": "mine_stone", "params": {"count": 2}}])
                else:
                    state["inventory"]["bread"] = 2
                with patch.object(L.time, "time", return_value=deadline):
                    self.assertEqual((await loop._survival_step())["skill"], skill)
                    self.assertEqual(loop._failure_counts()[skill], 2)

    async def test_verified_placed_station_can_refresh_cooking_but_disappearing_animals_cannot(self):
        import test_home_awareness as H
        state = {"health": 20, "food": 6, "inventory": {"wheat": 9},
                 "server": "fixture", "dimension": "overworld",
                 "nearby_entities": [{"name": "cow", "distance": 3}]}
        loop = self.make_loop(state)
        home = H.home()
        home["server"] = "fixture"
        loop.remember_home(home)

        async def engine(method, params=None, **kwargs):
            loop.note_task_result(params["skill"], False, "没有可用工作台")
            return {"task_id": "failed"}

        loop._call = engine
        await self.perform_supply(loop)
        await self.perform_supply(loop)
        deadline = loop._failure_cooldowns["cook_food"] + 1
        state["nearby_entities"] = []
        with patch.object(L.time, "time", return_value=deadline):
            self.assertIsNone(await loop._survival_step())
            state["home_status"] = {"loaded": False, "condition": "unknown", "safe": True, "inside": True,
                                    "furniture": {"crafting_table": True}}
            self.assertIsNone(await loop._survival_step())
            state["home_status"].update(loaded=True, condition="intact")
            self.assertEqual((await loop._survival_step())["skill"], "cook_food")
            state["dimension"] = None
            self.assertIsNone(await loop._survival_step())  # An earlier refresh never authorizes an unknown current world.

    def stalled_home_remedy(self, *, night=False, health=20):
        import test_home_awareness as H
        home = H.home()
        home["furnished"]["chest"] = True
        state = {"health": health, "food": 6, "inventory": {"wheat": 9, "oak_planks": 1},
                 "server": home["server"], "dimension": home["dimension"], "is_night": night,
                 "home_status": {"condition": "intact", "loaded": True, "distance": 0,
                                 "safe": True, "inside": True, "furniture": home["furnished"]}}
        loop = self.make_loop(state)
        loop.remember_home(home)
        loop.note_home_food(home, {"food_stock_checked": True, "food_stock_empty": True})
        loop._rule_supply_stalls["cook_food"] = {
            "count": 2, "state": loop._supply_observation(state), "params": {"count": 3}}
        remedy = {"skill": "chop_tree", "params": {"count": 1}}
        loop._set_plan([remedy])
        return loop, state, remedy

    async def test_stalled_supply_remedy_waits_inside_home_at_night_or_critical_health(self):
        for night, health in ((True, 20), (False, 6)):
            with self.subTest(night=night, health=health):
                loop, state, remedy = self.stalled_home_remedy(night=night, health=health)
                submitted = []

                async def engine(method, params=None, **kwargs):
                    if method == "task.list":
                        return {"current": None, "queued": 0}
                    submitted.append(params)
                    return {"task_id": "must-not-leave"}

                loop._call = engine
                loop._wake.set()
                loop.start()
                try:
                    await asyncio.sleep(0.04)
                    self.assertEqual(submitted, [])
                    self.assertEqual(loop._plan[0]["params"], remedy["params"])
                    self.assertTrue(loop._rule_supply_wait_reason)
                    self.assertTrue(state["home_status"]["inside"])
                finally:
                    await loop.stop()

    async def test_stalled_supply_remedy_exits_home_before_gathering_its_exact_material_goal(self):
        loop, state, remedy = self.stalled_home_remedy()
        submitted, complete = [], asyncio.Event()

        async def engine(method, params=None, **kwargs):
            if method == "task.list":
                return {"current": None, "queued": 0}
            submitted.append(copy.deepcopy(params))
            if params["skill"] == "leave_home":
                state["home_status"].update(inside=False, safe=False)
            else:
                self.assertEqual(params["skill"], "chop_tree")
                self.assertFalse(state["home_status"]["inside"])
                self.assertEqual({k: v for k, v in params["params"].items() if k != "protected_home"}, remedy["params"])
                complete.set()
                loop._stopped = True
            loop.note_task_result(params["skill"], True)
            loop.wake()
            return {"task_id": f"remedy-{len(submitted)}"}

        loop._call = engine
        await self.run_until(loop, complete)
        self.assertEqual([item["skill"] for item in submitted], ["leave_home", "chop_tree"])

    async def test_stalled_outdoor_remedy_keeps_its_plan_when_the_clock_is_unknown(self):
        loop, state, remedy = self.stalled_home_remedy()
        state["is_night"] = None
        state["home_status"].update(inside=False, safe=False)
        self.assertIsNone(await loop._survival_step())
        self.assertTrue(loop._rule_supply_wait_reason)
        self.assertEqual(loop._plan[0]["params"], remedy["params"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
