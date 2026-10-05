"""离线回归：实际生活循环的故障恢复、输入重规划与动作所有权。"""

from __future__ import annotations

import asyncio
import json
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _paths

_paths.require_astrbot("test_life_recovery")
_paths.load_plugin()
from astrcraft_plugin import life as L
from astrcraft_plugin.action_agent import ActionAgent
from astrcraft_plugin.game_agent import GameChatAgent, GameEventShim


class Memory:
    def remember(self, *args, **kwargs):
        pass

    def recall(self, *args, **kwargs):
        return []

    def render_for_prompt(self, *args, **kwargs):
        return ""


class Drives:
    def tick(self):
        pass

    def save(self):
        pass

    def suggest_activity(self):
        return {"activity": "砍树", "label": "收集", "level": 0.5, "voice": "收集木头", "drive": "gather"}

    def note_activity(self, **kwargs):
        pass


def make_loop():
    calls = []

    async def engine(method, params=None, **kwargs):
        calls.append((method, params))
        return {"current": None, "queued": 0} if method == "task.list" else {"task_id": "t1"}

    async def brief():
        return "血量20，饱食度20，位置0,64,0"

    async def system():
        return "你是 Minecraft 玩家"

    async def llm(prompt, system):
        return json.dumps({"activity": "砍树", "skill": "chop_tree"})

    loop = L.LifeLoop(
        engine_call=engine, memory=Memory(), drives=Drives(), brief_provider=brief,
        system_prompt_provider=system, llm=llm, is_connected=lambda: True,
        decide_interval=0.01,
    )
    return loop, calls


class RecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_completed_but_unchanged_food_preserves_return_and_resumes_exact_followup(self):
        import copy
        import test_mining_return as M
        for skill in ("eat", "recover"):
            with self.subTest(skill=skill):
                state = M.snapshot(food=0 if skill == "eat" else 20, health=6)
                state["inventory"].update(iron_ingot=3, stick=2, crafting_table=1)
                loop, _ = make_loop()
                async def snapshot():
                    return copy.deepcopy(state)
                async def no_model(*args, **kwargs):
                    raise AssertionError("no-progress food must still reach the established escape and plan")
                loop._state_provider, loop._llm = snapshot, no_model
                loop.note_blocked("模型离线", retry_after=120)
                follow = {"skill": "make_tools", "params": {"tier": "iron", "kinds": ["pickaxe"]}, "why": "原定补镐"}
                loop._set_plan([follow])
                M.MiningReturnTests.arm(self, loop, state)
                pending = loop._mining_return
                submitted, finished = [], asyncio.Event()

                async def engine(method, params=None, **kwargs):
                    if method == "task.list":
                        return {"current": None, "queued": 0}
                    submitted.append(copy.deepcopy(params))
                    task_id = f"completed-{len(submitted)}"
                    if params["skill"] == skill:
                        self.assertIs(loop._mining_return, pending)
                        self.assertEqual(loop._plan, [follow])
                        loop.note_task_result(skill, True, task_id=task_id)
                    elif params["skill"] == "climb_out":
                        self.assertIs(loop._mining_return, pending)
                        self.assertEqual(loop._plan, [follow])
                        self.assertEqual(loop._rule_supply_stalls[skill]["count"], 2)
                        self.assertEqual(loop._failure_counts()[skill], 1)
                        self.assertFalse(loop.skill_retry_ready(skill))
                        self.assertTrue(pending["awaiting"])
                        state["position"]["y"] = 64
                        state["mining_return_safety"].update(safe=True, underground=False)
                        # The next fresh body observation has recovered too;
                        # completing escape alone never authorizes hungry work.
                        state.update(food=20, health=20)
                        loop.note_task_result("climb_out", True, result=M.report(state, ok=True), task_id=task_id)
                    else:
                        self.assertEqual(params["skill"], follow["skill"])
                        self.assertEqual(params["params"], {**follow["params"], "safe_search": True})
                        self.assertIsNone(loop._mining_return)
                        finished.set()
                        loop._stopped = True
                    loop.wake()
                    return {"task_id": task_id}

                loop._call = engine
                loop._wake.set()
                loop.start()
                try:
                    await asyncio.wait_for(finished.wait(), timeout=1)
                    self.assertEqual([item["skill"] for item in submitted], [skill, skill, "climb_out", "make_tools"])
                finally:
                    await loop.stop()

    async def test_old_completed_food_proof_cannot_affect_owner_world_or_new_return(self):
        import copy
        import test_mining_return as M
        for change in ("owner", "world", "new_return"):
            with self.subTest(change=change):
                state = M.snapshot(food=0, health=6)
                loop, _ = make_loop()
                async def snapshot():
                    return copy.deepcopy(state)
                loop._state_provider = snapshot
                M.MiningReturnTests.arm(self, loop, state)
                old_pending = loop._mining_return

                async def engine(method, params=None, **kwargs):
                    loop.note_task_result("eat", True, task_id="old-completed-meal")
                    return {"task_id": "old-completed-meal"}

                loop._call = engine
                step = await loop._survival_step()
                await loop._act(loop._decision_from_step(step), allow_model_block=True)
                self.assertIs(loop._rule_supply_attempt["return_proof"]["supply_return"], old_pending)
                if change == "owner":
                    loop.note_owner_said("按新计划等我")
                elif change == "world":
                    loop.on_world_change()
                    state["dimension"] = "the_nether"
                    loop.on_world_ready()
                follow = {"skill": "chop_tree", "params": {"count": 7}, "why": "新的安排"}
                loop._set_plan([follow])
                if change == "new_return":
                    M.MiningReturnTests.arm(self, loop, state, task_id="new-mining")
                current_pending = loop._mining_return
                loop.note_task_result("eat", True, task_id="old-completed-meal")
                loop._return_boundary_state = dict(state)
                loop._observe_rule_supply(loop._supply_observation(state))
                self.assertIs(loop._mining_return, current_pending)
                self.assertIsNot(loop._mining_return, old_pending)
                self.assertEqual(loop._plan, [follow])
                self.assertNotIn("eat", loop._rule_supply_stalls)
                self.assertNotIn("eat", loop._failure_cooldowns)

    async def test_failed_urgent_meal_keeps_physical_return_and_real_loop_submits_rescue(self):
        import copy
        import test_mining_return as M
        for skill in ("eat", "recover"):
            for rpc_failure in (False, True):
                with self.subTest(skill=skill, rpc_failure=rpc_failure):
                    state = M.snapshot(food=0 if skill == "eat" else 20, health=6)
                    loop, _ = make_loop()
                    async def snapshot():
                        return copy.deepcopy(state)
                    async def no_model(*args, **kwargs):
                        raise AssertionError("uncompleted physical return must not need a model")
                    loop._state_provider, loop._llm = snapshot, no_model
                    loop.note_blocked("模型离线", retry_after=120)
                    follow = {"skill": "make_tools", "params": {"tier": "iron", "kinds": ["pickaxe"]}, "why": "保留原任务"}
                    loop._set_plan([follow])
                    M.MiningReturnTests.arm(self, loop, state)
                    pending = loop._mining_return
                    submitted, rescued = [], asyncio.Event()

                    async def engine(method, params=None, **kwargs):
                        if method == "task.list":
                            return {"current": None, "queued": 0}
                        submitted.append(params["skill"])
                        task_id = f"current-{len(submitted)}"
                        self.assertIs(loop._mining_return, pending)
                        self.assertEqual(loop._plan, [follow])
                        if params["skill"] == skill:
                            self.assertIs(loop._return_task_attempt["supply_return"], pending)
                            if rpc_failure:
                                raise RuntimeError("meal RPC unavailable")
                            loop.note_task_result(skill, False, "meal could not complete", task_id=task_id)
                            loop.wake()
                        else:
                            self.assertEqual(params["skill"], "climb_out")
                            self.assertEqual(loop._failure_counts()[skill], 2)
                            self.assertFalse(loop.skill_retry_ready(skill))
                            self.assertTrue(pending["awaiting"])
                            self.assertEqual(pending["attempts"], 1)
                            rescued.set()
                        return {"task_id": task_id}

                    loop._call = engine
                    loop._wake.set()
                    loop.start()
                    try:
                        await asyncio.wait_for(rescued.wait(), timeout=1)
                        self.assertEqual(submitted, [skill, skill, "climb_out"])
                        self.assertIs(loop._mining_return, pending)
                        self.assertEqual(loop._plan, [follow])
                        self.assertEqual(loop._return_task_attempt["skill"], "climb_out")
                        self.assertEqual(loop._return_task_attempt["task_id"], "current-3")
                    finally:
                        await loop.stop()

    async def test_late_meal_failure_after_owner_or_world_change_never_revives_old_return(self):
        import test_mining_return as M
        for change in ("owner", "world"):
            with self.subTest(change=change):
                state = M.snapshot(food=0, health=6)
                loop, _ = make_loop()
                loop._set_plan([{"skill": "make_tools", "params": {"tier": "iron"}}])
                M.MiningReturnTests.arm(self, loop, state)
                old_pending = loop._mining_return
                token = loop.register_task_submission("eat", state)
                loop.bind_task_submission(token, {"task_id": "old-meal"})
                if change == "owner":
                    loop.note_owner_said("先不要继续旧采矿任务")
                else:
                    loop.on_world_change()
                    state["dimension"] = "the_nether"
                    loop.on_world_ready()
                loop.note_task_result("eat", False, "late failed meal", task_id="old-meal")
                self.assertIsNone(loop._mining_return)
                self.assertIsNone(loop._return_task_attempt)
                self.assertEqual(loop._plan, [])
                self.assertIsNot(loop._mining_return, old_pending)

    async def test_old_meal_failure_cannot_clear_a_new_world_rescue_or_meal_submission(self):
        import test_mining_return as M
        for new_skill in ("eat", "climb_out"):
            with self.subTest(new_skill=new_skill):
                state = M.snapshot(food=0, health=6)
                loop, _ = make_loop()
                M.MiningReturnTests.arm(self, loop, state)
                old = loop.register_task_submission("eat", state)
                loop.bind_task_submission(old, {"task_id": "old-meal"})
                loop.on_world_change()
                state["dimension"] = "the_nether"
                loop.on_world_ready()
                follow = {"skill": "mine_stone", "params": {"count": 4}, "why": "新世界计划"}
                loop._set_plan([follow])
                M.MiningReturnTests.arm(self, loop, state, task_id="new-mining")
                pending = loop._mining_return
                current = loop.register_task_submission(new_skill, state)
                loop.bind_task_submission(current, {"task_id": "new-action"})
                loop.note_task_result("eat", False, "old-world timeout", task_id="old-meal")
                self.assertIs(loop._mining_return, pending)
                self.assertIs(loop._return_task_attempt, current)
                self.assertEqual(loop._plan, [follow])
                self.assertNotIn("eat", loop._recent_failures)

        # The real completion entry forwards old successful skill events too.
        # They must retain the food failure budget while climb_out is running.
        import copy
        import test_plugin_control as P
        for skill in ("eat", "recover"):
            with self.subTest(late_success=skill):
                state = M.snapshot(food=0 if skill == "eat" else 20, health=6)
                loop, _ = make_loop()
                async def snapshot():
                    return copy.deepcopy(state)
                loop._state_provider = snapshot
                follow = {"skill": "make_tools", "params": {"tier": "iron"}, "why": "原定任务"}
                loop._set_plan([follow])
                M.MiningReturnTests.arm(self, loop, state)

                async def engine(method, params=None, **kwargs):
                    task_id = f"failed-{len(loop._recent_failures.get(skill, []))}"
                    loop.note_task_result(skill, False, "food unavailable", task_id=task_id)
                    return {"task_id": task_id}

                loop._call = engine
                for _ in range(2):
                    step = await loop._survival_step()
                    await loop._act(loop._decision_from_step(step), allow_model_block=True)
                self.assertEqual((await loop._survival_step())["skill"], "climb_out")
                current = loop.register_task_submission("climb_out", state)
                loop.bind_task_submission(current, {"task_id": "active-rescue"})
                pending = loop._mining_return
                budget = copy.deepcopy(loop._rule_supply_failures[skill])
                cooldown = loop._failure_cooldowns[skill]
                plugin = P.plugin()
                plugin.life = loop
                plugin.config["announce_task_done"] = False
                await plugin._on_task_finished({"kind": "skill", "name": "旧补给任务", "meta": {"skill": skill},
                    "status": "done", "task_id": "old-meal-success", "result": {"ok": True}})
                self.assertEqual(loop._rule_supply_failures[skill], budget)
                self.assertEqual(loop._failure_cooldowns[skill], cooldown)
                self.assertEqual(loop._failure_counts()[skill], 2)
                self.assertIs(loop._return_task_attempt, current)
                self.assertIs(loop._mining_return, pending)
                self.assertEqual(loop._plan, [follow])
                self.assertIsNone(await loop._survival_step())
                self.assertIn("脱困任务仍等待", loop._rule_supply_wait_reason)

    async def test_owner_input_survives_provider_failure_and_blocks_rule_supply(self):
        loop, calls = make_loop()

        async def snapshot():
            return {"health": 20, "food": 0, "inventory": {"bread": 4}}

        class Agent:
            async def act(self, **kwargs):
                raise RuntimeError("provider offline")

        loop._state_provider = snapshot
        loop.action_agent = Agent()
        loop.note_owner_said("这些面包留着给我，不许吃")
        self.assertIsNone(await loop._survival_step())
        with self.assertRaises(RuntimeError):
            await loop._act_via_agent()
        loop._note_decision_failure("provider offline")
        self.assertEqual(len(loop.inbox), 0)
        self.assertTrue(loop._owner_steer_pending())
        self.assertIn("不许吃", loop._decision_input_text)
        self.assertIsNone(await loop._survival_step())
        await loop._act(L.LifeDecision(activity="吃面包", drive=None, skill="eat"), allow_model_block=True)
        self.assertFalse(any(method == "skill.run" for method, _ in calls))

    async def test_owner_input_prevents_legacy_fallback_after_invalid_response(self):
        loop, calls = make_loop()

        async def no_decision(prompt, system):
            return None

        loop._llm = no_decision
        loop.note_owner_said("原地等我，别采集")
        self.assertIsNone(await loop.decide())
        self.assertFalse(loop._decision_model_ok)
        self.assertTrue(loop._owner_steer_pending())
        self.assertFalse(any(method == "skill.run" for method, _ in calls))

    async def test_world_steer_does_not_acquire_pending_owner_barrier(self):
        loop, _ = make_loop()

        async def snapshot():
            return {"health": 6, "food": 0, "inventory": {"bread": 4}}

        loop._state_provider = snapshot
        loop.note_world_event("hurt", "挨打了", urgent=True)
        loop._decision_inputs()
        loop.note_blocked("provider offline")
        self.assertFalse(loop._owner_steer_pending())
        self.assertEqual((await loop._survival_step())["skill"], "eat")

    def test_consumed_owner_retry_is_not_a_permanent_cooldown_override(self):
        loop, _ = make_loop()
        with patch.object(L.time, "time", return_value=1000):
            for _ in range(3):
                loop.note_task_result("mine_stone", False, "没有镐")
            self.assertFalse(loop.skill_retry_ready("mine_stone"))
            # The owner arrives during preparation, after the loop's initial check.
            loop.note_owner_said("工具补好了，再试一次")
            loop._decision_inputs()
            self.assertTrue(loop.skill_retry_ready("mine_stone"))
            loop.note_task_result("mine_stone", False, "仍然没有镐")
            self.assertFalse(loop.skill_retry_ready("mine_stone"))
            self.assertTrue(loop._owner_steer_pending())

    async def test_new_owner_during_agent_failure_cannot_be_acknowledged_by_old_action(self):
        loop, _ = make_loop()
        count = 0

        class Provider:
            async def text_chat(self, **kwargs):
                nonlocal count
                count += 1
                if count == 1:
                    return SimpleNamespace(tools_call_name=["mc_equip"], tools_call_args=[{}],
                        tools_call_ids=["one"], to_openai_tool_calls_model=lambda: [])
                if count == 2:
                    loop.note_owner_said("留着面包，别吃")
                    return SimpleNamespace(tools_call_name=[], completion_text="旧总结")
                raise RuntimeError("provider offline")

        async def get_provider():
            return Provider()

        plugin = SimpleNamespace(life=loop, context=SimpleNamespace(get_using_provider_async=get_provider))
        agent = ActionAgent(plugin)
        agent._toolset = lambda: "test"

        async def execute(name, args, event):
            return "装备完成"

        agent._execute = execute
        loop.action_agent = agent
        self.assertTrue(await loop._act_via_agent())
        self.assertEqual(agent.last_timing["exit_reason"], "provider_failed_after_action")
        self.assertIn("别吃", loop._decision_input_text)
        self.assertFalse(loop._decision_model_ok)
        self.assertFalse(loop._acknowledge_decision_inputs(agent.last_timing["owner_generation"]))
        self.assertTrue(loop._owner_steer_pending())

    async def test_successful_owner_decision_releases_only_its_input_barrier(self):
        loop, _ = make_loop()
        loop.note_owner_said("先等一下")
        decision = await loop.decide()
        self.assertIsNotNone(decision)
        self.assertTrue(loop._decision_model_ok)
        self.assertTrue(loop._acknowledge_decision_inputs(loop._decision_model_owner_generation))
        self.assertFalse(loop._owner_steer_pending())
        self.assertEqual(loop._decision_input_text, "")

    async def test_world_change_discards_inflight_agent_action_and_preserves_holds(self):
        loop, _ = make_loop()
        called = []
        loop._todos = [{"text": "捡回死亡物品", "done": False}]
        loop.pause(reason="主人暂停", max_seconds=0)
        loop.note_blocked("模型离线", retry_after=120)
        retry_at = loop._decision_retry_at
        for _ in range(3):
            loop.note_task_result("mine_stone", False, "没有镐")
        loop.skill_retry_ready("mine_stone")
        cooldowns = dict(loop._failure_cooldowns)
        loop._set_plan([{"skill": "mine_stone"}])
        old_revision = loop._plan_revision
        loop.on_world_change()
        self.assertGreater(loop._plan_revision, old_revision)
        self.assertEqual(loop._plan, [])
        self.assertFalse(loop.may_act(allow_model_block=True))
        loop.on_world_ready()
        self.assertTrue(loop.paused)
        self.assertEqual(loop._blocked_reason, "模型离线")
        self.assertEqual(loop._decision_retry_at, retry_at)
        self.assertEqual(loop._failure_cooldowns, cooldowns)
        self.assertEqual(loop._todos[0]["text"], "捡回死亡物品")
        loop.resume()
        loop.note_unblocked()

        class Provider:
            async def text_chat(self, **kwargs):
                loop.on_world_change()
                loop.on_world_ready()
                return SimpleNamespace(tools_call_name=["mc_mine"], tools_call_args=[{"x": 20, "y": 64, "z": 20}])

        async def get_provider():
            return Provider()

        plugin = SimpleNamespace(life=loop, context=SimpleNamespace(get_using_provider_async=get_provider))
        agent = ActionAgent(plugin)
        agent._toolset = lambda: "test"

        async def execute(name, args, event):
            called.append(args)
            return "task_id=old-world"

        agent._execute = execute
        await agent.act(prompt="挖主世界旧坐标", system="玩家")
        self.assertEqual(called, [])
        self.assertEqual(agent.last_timing["exit_reason"], "state_changed")

    async def test_empty_plan_still_supplies_food_without_model(self):
        loop, calls = make_loop()

        async def snapshot():
            return {"health": 20, "food": 0, "inventory": {"wheat": 9, "oak_log": 2}}

        loop._state_provider = snapshot
        loop.note_blocked("模型离线", retry_after=120)
        deadline = loop._decision_retry_at
        self.assertEqual((await loop._survival_step())["skill"], "cook_food")
        self.assertEqual(loop._plan, [])
        self.assertEqual(calls, [])
        self.assertEqual(loop.current_hold(), L.Hold.BLOCKED)
        self.assertEqual(loop._decision_retry_at, deadline)

    async def test_survival_same_skill_refreshes_animal_and_quantity(self):
        loop, _ = make_loop()

        async def snapshot():
            return {"health": 20, "food": 0, "inventory": {},
                    "nearby_entities": [{"name": "pig", "distance": 3, "hostile": False}]}

        loop._state_provider = snapshot
        loop._set_plan([{"skill": "hunt", "params": {"mob": "cow", "count": 4}},
                        {"skill": "mine_stone", "params": {"count": 4}}])
        self.assertIsNone(await loop._survival_step())
        self.assertEqual(loop._pop_plan_step()["params"], {"mob": "pig", "count": 1})
        self.assertEqual(loop._plan[0]["skill"], "mine_stone")

    async def test_survival_same_skill_raises_eating_target(self):
        loop, _ = make_loop()

        async def snapshot():
            return {"health": 8, "food": 4, "inventory": {"bread": 4}}

        loop._state_provider = snapshot
        loop._set_plan([{"skill": "eat", "params": {"target_food": 8}}])
        self.assertIsNone(await loop._survival_step())
        self.assertEqual(loop._pop_plan_step()["params"], {"target_food": 20})

    async def _run_food_then_plan(self, *, model_blocked=False, failures=False):
        loop, calls = make_loop()
        state = {"health": 20, "food": 0, "inventory": {"wheat": 9, "oak_log": 2}}
        skills = []
        complete = asyncio.Event()

        async def snapshot():
            return state

        async def engine(method, params=None, **kwargs):
            calls.append((method, params))
            if method == "task.list":
                return {"current": None, "queued": 0}
            skill = params["skill"]
            skills.append(skill)
            if skill == "cook_food":
                state["inventory"] = {"bread": 3, "oak_log": 2}
            elif skill == "eat":
                state["food"] = 20
                state["inventory"]["bread"] = 1
            elif skill == "mine_stone":
                complete.set()
                loop._stopped = True
            else:
                raise AssertionError(f"unexpected skill: {skill}")
            loop.note_task_result(skill, True)
            loop.wake()
            return {"task_id": "t1"}

        async def no_model(*args, **kwargs):
            raise AssertionError("known survival and plan must not call a model")

        loop._call = engine
        loop._state_provider = snapshot
        loop._llm = no_model
        if failures:
            for _ in range(3):
                loop.note_task_result("mine_ores", False, "没有矿脉")
        if model_blocked:
            loop.note_blocked("模型离线", retry_after=120)
        deadline, blocked = loop._decision_retry_at, loop._blocked_reason
        loop._set_plan([{"skill": "mine_stone", "params": {"count": 4}}])
        loop._wake.set()
        loop.start()
        try:
            await asyncio.wait_for(complete.wait(), timeout=1)
            await asyncio.sleep(0)
            self.assertEqual(skills, ["cook_food", "eat", "mine_stone"])
            self.assertEqual(loop._decision_retry_at, deadline)
            self.assertEqual(loop._blocked_reason, blocked)
            if failures:
                self.assertFalse(loop.skill_retry_ready("mine_ores"))
                self.assertTrue(loop.skill_retry_ready("mine_stone"))
        finally:
            await loop.stop()

    async def test_model_outage_keeps_food_supply_and_existing_plan_moving(self):
        await self._run_food_then_plan(model_blocked=True)

    async def test_repaired_pick_break_keeps_completed_collection_followup_during_outage(self):
        loop, _ = make_loop()
        state = {"server": "recovery-fixture", "dimension": "overworld", "health": 20,
                 "food": 20, "inventory": {"stone_pickaxe": 1, "cobblestone": 4},
                 "is_night": False, "position": {"x": 0, "y": 64, "z": 0}}
        completed = asyncio.Event()
        submitted = []

        async def snapshot():
            return state

        async def engine(method, params=None, **kwargs):
            if method == "task.list":
                return {"current": None, "queued": 0}
            submitted.append(params["skill"])
            completed.set()
            loop._stopped = True
            return {"task_id": "next"}

        loop._call, loop._state_provider = engine, snapshot
        loop.note_blocked("模型离线", retry_after=120)
        loop._set_plan([{"skill": "build_shelter", "params": {"style": "small"}}])
        token = loop.register_task_submission("mine_stone", state)
        loop.bind_task_submission(token, {"task_id": "collect"})
        loop.note_world_event("tool_broken", "我的wooden_pickaxe用坏了")
        loop.note_task_result("mine_stone", True, result={"collection_ok": True,
            "return_status": {"required": False, "ok": True, "server": state["server"],
                              "dimension": state["dimension"]}}, task_id="collect")
        loop._wake.set()
        loop.start()
        try:
            await asyncio.wait_for(completed.wait(), timeout=1)
            self.assertEqual(submitted, ["build_shelter"])
            self.assertIn("wooden_pickaxe", loop._decision_input_text)
            self.assertTrue(loop._blocked_reason)
        finally:
            await loop.stop()

    async def test_pick_break_does_not_discard_required_mining_escape(self):
        loop, _ = make_loop()
        state = {"server": "recovery-fixture", "dimension": "overworld", "health": 20,
                 "food": 20, "inventory": {"coal": 2}, "is_night": False,
                 "position": {"x": 0, "y": 40, "z": 0},
                 "mining_return_safety": {"safe": False, "loaded": True, "on_ground": True,
                                          "underground": True}}
        completed = asyncio.Event()
        submitted = []

        async def snapshot():
            return state

        async def engine(method, params=None, **kwargs):
            if method == "task.list":
                return {"current": None, "queued": 0}
            submitted.append(params["skill"])
            completed.set()
            loop._stopped = True
            return {"task_id": "escape"}

        loop._call, loop._state_provider = engine, snapshot
        loop.note_blocked("模型离线", retry_after=120)
        follow = {"skill": "craft", "params": {"item": "torch", "count": 4}, "why": "照明"}
        loop._set_plan([follow])
        token = loop.register_task_submission("mine_ores", state)
        loop.bind_task_submission(token, {"task_id": "collect"})
        loop.note_world_event("player_near", "有人经过矿洞")
        loop.note_world_event("tool_broken", "我的stone_pickaxe用坏了")
        loop.note_world_event("hungry", "刚才采矿时饿了")
        loop.note_world_event("tool_broken", "我的wooden_pickaxe用坏了")
        loop.note_task_result("mine_ores", False, "返程失败", result={"collection_ok": True,
            "return_status": {"required": True, "ok": False, "server": state["server"],
                "dimension": state["dimension"], "position": dict(state["position"]),
                "target": {"x": 0, "y": 64, "z": 0}}}, task_id="collect")
        loop._wake.set()
        loop.start()
        try:
            await asyncio.wait_for(completed.wait(), timeout=1)
            self.assertEqual(submitted, ["climb_out"])
            self.assertEqual(loop._plan, [follow])
            self.assertIn("stone_pickaxe", loop._decision_input_text)
            self.assertIn("wooden_pickaxe", loop._decision_input_text)
            self.assertIn("有人经过矿洞", loop._decision_input_text)
        finally:
            await loop.stop()

    async def test_partial_collection_and_later_pick_break_still_preserve_escape(self):
        loop, _ = make_loop()
        state = {"server": "recovery-fixture", "dimension": "overworld", "health": 20,
                 "food": 20, "inventory": {"coal": 1}, "is_night": False,
                 "position": {"x": 0, "y": 40, "z": 0},
                 "mining_return_safety": {"safe": False, "loaded": True, "on_ground": True,
                                          "underground": True}}

        async def snapshot():
            return state

        loop._state_provider = snapshot
        loop._set_plan([{"skill": "craft", "params": {"item": "torch", "count": 4}}])
        token = loop.register_task_submission("mine_ores", state)
        loop.bind_task_submission(token, {"task_id": "partial"})
        loop.note_task_result("mine_ores", False, "工具损坏且返程失败", result={"collection_ok": False,
            "return_status": {"required": True, "ok": False, "server": state["server"],
                "dimension": state["dimension"], "position": dict(state["position"]),
                "target": {"x": 0, "y": 64, "z": 0}}}, task_id="partial")
        loop.note_world_event("tool_broken", "我的stone_pickaxe用坏了")
        self.assertTrue(await loop._resolve_completed_tool_breaks())
        self.assertEqual(loop._plan, [], "partial material must still invalidate dependent work")
        self.assertEqual((await loop._survival_step())["skill"], "climb_out")

    async def test_tool_break_resolution_requires_current_completion_and_new_tool(self):
        for invalid in ("missing_pick", "late_break", "partial", "other_world", "owner", "hurt", "sword"):
            with self.subTest(invalid=invalid):
                loop, _ = make_loop()
                state = {"server": "recovery-fixture", "dimension": "overworld", "health": 20,
                         "food": 20, "inventory": {"stone_pickaxe": 1}, "is_night": False}

                async def snapshot():
                    return state

                loop._state_provider = snapshot
                loop._set_plan([{"skill": "build_shelter"}])
                token = loop.register_task_submission("mine_stone", state)
                loop.bind_task_submission(token, {"task_id": "collect"})
                if invalid != "late_break":
                    loop.note_world_event("tool_broken", "我的iron_sword用坏了" if invalid == "sword"
                                          else "我的wooden_pickaxe用坏了")
                loop.note_task_result("mine_stone", invalid != "partial", result={"collection_ok": invalid != "partial",
                    "return_status": {"required": False, "ok": True, "server": state["server"],
                                      "dimension": state["dimension"]}}, task_id="collect")
                if invalid == "missing_pick":
                    state["inventory"] = {}
                elif invalid == "late_break":
                    loop.note_world_event("tool_broken", "我的stone_pickaxe用坏了")
                elif invalid == "other_world":
                    state["dimension"] = "the_nether"
                elif invalid == "owner":
                    loop.note_owner_said("别盖房子，等我")
                elif invalid == "hurt":
                    loop.note_world_event("hurt", "被僵尸攻击")
                before = loop.inbox.entries
                self.assertFalse(await loop._resolve_completed_tool_breaks())
                self.assertEqual(loop.inbox.entries, before)

    async def test_owner_arriving_during_pick_verification_keeps_input_barrier(self):
        loop, _ = make_loop()
        state = {"server": "recovery-fixture", "dimension": "overworld", "health": 20,
                 "food": 20, "inventory": {"stone_pickaxe": 1}, "is_night": False}

        async def snapshot():
            loop.note_owner_said("不要继续采矿，等我")
            return state

        loop._state_provider = snapshot
        token = loop.register_task_submission("mine_stone", state)
        loop.bind_task_submission(token, {"task_id": "collect"})
        loop.note_world_event("tool_broken", "我的wooden_pickaxe用坏了")
        loop.note_task_result("mine_stone", True, result={"collection_ok": True,
            "return_status": {"required": False, "ok": True, "server": state["server"],
                              "dimension": state["dimension"]}}, task_id="collect")
        self.assertFalse(await loop._resolve_completed_tool_breaks())
        self.assertTrue(loop._owner_steer_pending())
        self.assertTrue(loop.inbox.has_delivery(L.Delivery.STEER))

    async def test_mixed_fifo_notifications_preserve_repaired_collection_followup(self):
        loop, _ = make_loop()
        state = {"server": "recovery-fixture", "dimension": "overworld", "health": 20,
                 "food": 20, "inventory": {"iron_pickaxe": 1, "cobblestone": 4},
                 "is_night": False, "position": {"x": 0, "y": 64, "z": 0}}
        done = asyncio.Event()
        submitted = []

        async def snapshot():
            return state

        async def engine(method, params=None, **kwargs):
            if method == "task.list":
                return {"current": None, "queued": 0}
            submitted.append(params["skill"])
            done.set()
            loop._stopped = True
            return {"task_id": "next"}

        loop._call, loop._state_provider = engine, snapshot
        loop.note_blocked("模型离线", retry_after=120)
        loop._set_plan([{"skill": "build_shelter"}])
        token = loop.register_task_submission("mine_stone", state)
        loop.bind_task_submission(token, {"task_id": "collect"})
        loop.note_world_event("player_near", "附近有人经过")
        loop.note_world_event("tool_broken", "我的wooden_pickaxe用坏了")
        loop.note_world_event("hungry", "刚才挖矿时饿了")
        loop.note_world_event("tool_broken", "我的stone_pickaxe用坏了")
        loop.note_task_result("mine_stone", True, result={"collection_ok": True,
            "return_status": {"required": False, "ok": True, "server": state["server"],
                              "dimension": state["dimension"]}}, task_id="collect")
        loop.note_world_event("task_done", "采石完成")
        loop._wake.set()
        loop.start()
        try:
            await asyncio.wait_for(done.wait(), timeout=1)
            self.assertEqual(submitted, ["build_shelter"])
            for text in ("附近有人经过", "wooden_pickaxe", "刚才挖矿时饿了", "stone_pickaxe", "采石完成"):
                self.assertIn(text, loop._decision_input_text)
            self.assertEqual(loop.inbox.entries, [])
        finally:
            await loop.stop()

    async def test_mixed_fifo_does_not_hide_fresh_break_or_later_owner(self):
        for later in ("tool_broken", "owner"):
            with self.subTest(later=later):
                loop, _ = make_loop()
                state = {"server": "recovery-fixture", "dimension": "overworld", "health": 20,
                         "food": 20, "inventory": {"stone_pickaxe": 1}, "is_night": False}

                async def snapshot():
                    return state

                loop._state_provider = snapshot
                loop._set_plan([{"skill": "build_shelter"}])
                token = loop.register_task_submission("mine_stone", state)
                loop.bind_task_submission(token, {"task_id": "collect"})
                loop.note_world_event("player_near", "附近有人经过")
                loop.note_world_event("tool_broken", "我的wooden_pickaxe用坏了")
                loop.note_task_result("mine_stone", True, result={"collection_ok": True,
                    "return_status": {"required": False, "ok": True, "server": state["server"],
                                      "dimension": state["dimension"]}}, task_id="collect")
                loop.note_world_event("task_done", "采石完成")
                if later == "owner":
                    loop.note_owner_said("不要盖房子，等我")
                else:
                    loop.note_world_event("tool_broken", "我的stone_pickaxe用坏了")
                before = loop.inbox.entries
                self.assertFalse(await loop._resolve_completed_tool_breaks())
                self.assertEqual(loop.inbox.entries, before)
                self.assertEqual(loop._decision_input_text, "")
                if later == "owner":
                    self.assertTrue(loop._owner_steer_pending())

    async def test_resolved_fifo_exposes_control_before_followup_action(self):
        loop, _ = make_loop()
        state = {"server": "recovery-fixture", "dimension": "overworld", "health": 20,
                 "food": 20, "inventory": {"stone_pickaxe": 1}, "is_night": False}
        order = []
        done = asyncio.Event()
        run_control = loop._run_control

        async def snapshot():
            return state

        def control():
            order.append("compact")
            return run_control()

        async def engine(method, params=None, **kwargs):
            if method == "task.list":
                return {"current": None, "queued": 0}
            order.append(params["skill"])
            done.set()
            loop._stopped = True
            return {"task_id": "next"}

        loop._call, loop._state_provider, loop._run_control = engine, snapshot, control
        loop.note_blocked("模型离线", retry_after=120)
        loop._set_plan([{"skill": "build_shelter"}])
        token = loop.register_task_submission("mine_stone", state)
        loop.bind_task_submission(token, {"task_id": "collect"})
        loop.note_world_event("tool_broken", "我的wooden_pickaxe用坏了")
        loop.note_task_result("mine_stone", True, result={"collection_ok": True,
            "return_status": {"required": False, "ok": True, "server": state["server"],
                              "dimension": state["dimension"]}}, task_id="collect")
        loop.inbox.push("compact", "整理记忆")
        loop._wake.set()
        loop.start()
        try:
            await asyncio.wait_for(done.wait(), timeout=1)
            self.assertEqual(order, ["compact", "build_shelter"])
        finally:
            await loop.stop()

    async def test_other_skill_failure_cooldown_cannot_block_food_or_plan(self):
        await self._run_food_then_plan(failures=True)

    async def test_model_outage_empty_plan_stops_repeating_failed_supply(self):
        loop, calls = make_loop()
        attempts = 0

        async def snapshot():
            return {"health": 20, "food": 0, "is_night": False, "inventory": {"wheat": 9}}

        async def engine(method, params=None, **kwargs):
            nonlocal attempts
            calls.append((method, params))
            if method == "task.list":
                return {"current": None, "queued": 0}
            attempts += 1
            raise RuntimeError("没有可用工作台")

        loop._call = engine
        loop._state_provider = snapshot
        loop.note_blocked("模型离线", retry_after=120)
        loop._wake.set()
        loop.start()
        try:
            await asyncio.sleep(0.12)
            self.assertEqual(attempts, 2)
            self.assertEqual(loop._failure_counts(), {"cook_food": 2})
            self.assertEqual(loop.current_hold(), L.Hold.BLOCKED)
        finally:
            await loop.stop()

    async def test_rule_actions_keep_owner_dead_disconnect_and_engine_guards(self):
        for hold in ("pause", "dead", "disconnect", "engine"):
            with self.subTest(hold=hold):
                loop, calls = make_loop()
                loop.note_blocked("模型离线", retry_after=120)
                if hold == "pause":
                    loop.pause(reason="主人急停", max_seconds=0)
                elif hold == "dead":
                    loop.note_dead(True)
                elif hold == "disconnect":
                    loop._is_connected = lambda: False
                else:
                    loop.note_engine_up(False)
                await loop._act(L.LifeDecision(activity="补给", drive=None, skill="cook_food"), allow_model_block=True)
                self.assertEqual(calls, [])

    async def test_pause_during_rule_action_callback_prevents_submission(self):
        loop, calls = make_loop()
        loop.note_blocked("模型离线", retry_after=120)

        async def callback(decision):
            loop.pause(reason="主人急停", max_seconds=0)

        loop._on_activity = callback
        await loop._act(L.LifeDecision(activity="补给", drive=None, skill="cook_food"), allow_model_block=True)
        self.assertFalse(any(method == "skill.run" for method, _ in calls))
        self.assertTrue(loop.paused)

    async def test_hurt_input_supplies_before_model_but_preserves_event(self):
        loop, calls = make_loop()
        submitted = asyncio.Event()

        async def snapshot():
            return {"health": 8, "food": 0, "inventory": {"wheat": 9, "crafting_table": 1}}

        async def engine(method, params=None, **kwargs):
            calls.append((method, params))
            if method == "skill.run":
                submitted.set()
                loop._stopped = True
                return {"task_id": "t1"}
            return {"current": None, "queued": 0}

        loop._call = engine
        loop._state_provider = snapshot
        loop.note_blocked("模型离线", retry_after=120)
        loop.note_world_event("hurt", "被僵尸打了，剩8血", urgent=True)
        loop._wake.set()
        loop.start()
        try:
            await asyncio.wait_for(submitted.wait(), timeout=1)
            self.assertEqual([p["skill"] for m, p in calls if m == "skill.run"], ["cook_food"])
            self.assertIn("被僵尸打了", loop._decision_input_text)
            self.assertEqual(loop.current_hold(), L.Hold.BLOCKED)
        finally:
            await loop.stop()

    async def test_owner_input_remains_barrier_during_model_outage(self):
        loop, calls = make_loop()

        async def snapshot():
            return {"health": 20, "food": 0, "inventory": {"wheat": 9}}

        loop._state_provider = snapshot
        loop.note_blocked("模型离线", retry_after=120)
        loop.note_owner_said("Alice：先停下，回来")
        loop.start()
        try:
            await asyncio.sleep(0.04)
            self.assertFalse(any(method == "skill.run" for method, _ in calls))
            self.assertTrue(loop._owner_steer_pending())
        finally:
            await loop.stop()

    def test_skill_cooldown_restricts_only_failed_skill(self):
        loop, _ = make_loop()
        with patch.object(L.time, "time", return_value=1000):
            for _ in range(3):
                loop.note_task_result("mine_stone", False, "缺镐")
            self.assertFalse(loop.skill_retry_ready("mine_stone"))
            self.assertTrue(loop.skill_retry_ready("chop_tree"))
            self.assertTrue(loop.skill_retry_ready("cook_food"))
        with patch.object(L.time, "time", return_value=1031):
            self.assertTrue(loop.skill_retry_ready("mine_stone"))

    def test_world_urgency_does_not_reset_skill_cooldown(self):
        loop, _ = make_loop()
        with patch.object(L.time, "time", return_value=1000):
            for _ in range(3):
                loop.note_task_result("mine_stone", False, "缺镐")
            self.assertFalse(loop.skill_retry_ready("mine_stone"))
            for kind in ("hurt", "danger", "hungry", "tool_broken"):
                loop.note_world_event(kind, "世界情况变了", urgent=True)
                self.assertFalse(loop.skill_retry_ready("mine_stone"))
                self.assertTrue(loop.skill_retry_ready("cook_food"))
                self.assertEqual(loop._failure_cooldowns["mine_stone"], 1030)
            loop.note_owner_said("Alice：工具换好了，再挖一次")
            self.assertTrue(loop.skill_retry_ready("mine_stone"))

    async def test_survival_step_preserves_plan_and_resumes_after_eating(self):
        loop, calls = make_loop()
        state = {"inventory": {"bread": 3}, "food": 4, "health": 20}

        async def snapshot():
            return state

        loop._state_provider = snapshot
        loop._set_plan([{"skill": "mine_stone", "params": {"count": 4}}])
        step = await loop._survival_step()
        self.assertEqual(step["skill"], "eat")
        self.assertEqual([s["skill"] for s in loop._plan], ["mine_stone"])
        self.assertEqual(calls, [])  # 检查与插步不调用模型或偷偷提交身体动作。
        state["food"] = 19
        self.assertIsNone(await loop._survival_step())
        self.assertEqual(loop._pop_plan_step()["skill"], "mine_stone")

    async def test_snapshot_zeros_are_not_replaced_with_full_health(self):
        loop, _ = make_loop()
        advice = await loop._build_advice({"health": 0, "food": 0, "inventory": {"bread": 1}})
        self.assertEqual(advice.skill, "eat")
        self.assertTrue(any("血量只有 0" in w for w in advice.warnings))

    async def test_storage_intervention_precedes_gathering_and_preserves_crafting(self):
        loop, _ = make_loop()

        async def snapshot():
            return {"health": 20, "food": 20, "inventory": {"stone_pickaxe": 1}, "inventory_slots_used": 34}

        loop._state_provider = snapshot
        loop._set_plan([{"skill": "mine_stone"}])
        self.assertEqual((await loop._survival_step())["skill"], "store_items")
        self.assertEqual(loop._plan[0]["skill"], "mine_stone")
        loop._set_plan([{"skill": "make_tools", "params": {"tier": "stone", "kinds": ["pickaxe"]}}])
        self.assertIsNone(await loop._survival_step())

    async def test_missing_snapshot_does_not_invent_survival_tasks(self):
        loop, _ = make_loop()

        async def snapshot():
            return {"health": 2, "food": 0}

        loop._state_provider = snapshot
        loop._set_plan([{"skill": "mine_stone"}])
        self.assertIsNone(await loop._survival_step())
        self.assertEqual(loop._plan[0]["skill"], "mine_stone")

    async def test_owner_or_session_change_during_snapshot_discards_intervention(self):
        for change in ("pause", "reconnect", "steer"):
            loop, _ = make_loop()
            loop._set_plan([{"skill": "mine_stone"}])

            async def snapshot():
                if change == "pause":
                    loop.pause(reason="急停", max_seconds=0)
                elif change == "reconnect":
                    loop.on_session_start()
                else:
                    loop.note_owner_said("Alice：回来")
                return {"health": 20, "food": 0, "inventory": {"bread": 2}}

            loop._state_provider = snapshot
            self.assertIsNone(await loop._survival_step())

    async def test_failed_survival_intervention_replans_instead_of_repeating(self):
        loop, _ = make_loop()
        for _ in range(2):
            loop.note_task_result("cook_food", False, "没有食材")
        loop._set_plan([{"skill": "mine_stone"}])

        async def snapshot():
            return {"health": 20, "food": 8, "inventory": {}}

        loop._state_provider = snapshot
        self.assertIsNone(await loop._survival_step())
        self.assertEqual(loop._plan, [])

    def test_failure_batch_expires_without_renewal(self):
        loop, _ = make_loop()
        with patch.object(L.time, "time", return_value=1000):
            for _ in range(3):
                loop.note_task_result("mine_stone", False, "缺少镐子")
            self.assertTrue(loop._should_back_off())
            self.assertEqual(loop._backoff_until, 1030)
        with patch.object(L.time, "time", return_value=1031):
            self.assertFalse(loop._should_back_off())
        with patch.object(L.time, "time", return_value=1200):
            self.assertFalse(loop._should_back_off())
            loop.note_task_result("mine_stone", False, "仍缺少镐子")
            self.assertTrue(loop._should_back_off())
            loop.note_owner_said("Alice：先砍树做镐子")
            self.assertFalse(loop._should_back_off())

    def test_endpoint_retry_is_bounded(self):
        loop, _ = make_loop()
        with patch.object(L.time, "time", return_value=1000):
            deadlines = []
            for _ in range(6):
                loop._note_decision_failure("临时断线")
                deadlines.append(loop._decision_retry_at - 1000)
            self.assertEqual(deadlines, [8, 30, 60, 120, 120, 120])
            loop.note_unblocked()
            self.assertEqual(loop._decide_timeouts, 0)
            self.assertEqual(loop.current_hold(), L.Hold.NONE)

    async def test_loop_recovers_without_external_wake(self):
        loop, _ = make_loop()
        recovered = asyncio.Event()
        holds = []
        count = 0
        original_failure = loop._note_decision_failure

        def fast_failure(reason, **kwargs):
            original_failure(reason, **kwargs)
            holds.append(loop.current_hold())
            # 缩短等待以测试真实循环，生产延迟单独由上面的测试验证。
            loop._decision_retry_at = time.time() + 0.02

        async def agent_round():
            nonlocal count
            count += 1
            if count <= 2:
                raise RuntimeError("端点暂时失败")
            self.assertTrue(loop.may_act())
            loop._decision_model_ok = True
            recovered.set()
            loop._stopped = True
            return True

        loop._note_decision_failure = fast_failure
        loop._act_via_agent = agent_round
        loop.action_agent = object()
        loop._wake.set()  # 只用于首次进服，不再叫醒恢复过程。
        loop.start()
        try:
            await asyncio.wait_for(recovered.wait(), timeout=1)
            await asyncio.sleep(0)
            self.assertEqual(count, 3)
            self.assertIn(L.Hold.BLOCKED, holds)
            self.assertEqual(loop.current_hold(), L.Hold.NONE)
            self.assertEqual(loop._decide_timeouts, 0)
        finally:
            await loop.stop()

    async def test_inputs_survive_model_failure_and_fallback_path(self):
        loop, _ = make_loop()
        prompts = []

        async def unavailable(prompt, system):
            prompts.append(prompt)
            raise RuntimeError("暂时不可用")

        loop._llm = unavailable
        loop.note_owner_said("Alice：去取面包")
        with self.assertRaises(RuntimeError):
            await loop.decide()
        self.assertIn("去取面包", loop._decision_input_text)
        self.assertEqual(len(loop.inbox), 0)

        async def restored(prompt, system):
            prompts.append(prompt)
            return json.dumps({"activity": "取面包", "skill": "supply"})

        loop._llm = restored
        decision = await loop.decide()
        self.assertIn("去取面包", prompts[-1])
        self.assertEqual(decision.skill, "supply")

    async def test_steer_replans_but_task_done_keeps_plan(self):
        for event_type, expect_model in (("hurt", True), ("task_done", False)):
            loop, _ = make_loop()
            done = asyncio.Event()
            model_calls = 0
            executed = []

            async def agent_round():
                nonlocal model_calls
                model_calls += 1
                done.set()
                loop._stopped = True
                return True

            async def act(decision, **kwargs):
                executed.append(decision.skill)
                done.set()
                loop._stopped = True

            loop._plan = [{"skill": "mine_stone", "params": {}}]
            loop._act = act
            loop._act_via_agent = agent_round
            loop.action_agent = object()
            loop.note_world_event(event_type, "情况变化")
            loop._wake.set()
            loop.start()
            try:
                await asyncio.wait_for(done.wait(), 1)
                self.assertEqual(model_calls, int(expect_model))
                self.assertEqual(executed, [] if expect_model else ["mine_stone"])
            finally:
                await loop.stop()

    async def test_pause_while_deciding_prevents_submission(self):
        loop, calls = make_loop()

        async def pause_in_activity(decision):
            loop.pause(reason="急停", max_seconds=0)

        loop._on_activity = pause_in_activity
        await loop._act(L.LifeDecision(activity="砍树", drive=None, skill="chop_tree"))
        self.assertFalse(any(method == "skill.run" for method, _ in calls))
        loop._pending_plan = [{"skill": "mine_stone"}]
        loop.note_task_result("chop_tree", False, "材料不足")
        self.assertEqual(loop._pending_plan, [])

    async def test_agent_rereads_input_received_while_thinking(self):
        loop, _ = make_loop()
        executed = []

        class Provider:
            calls = 0

            async def text_chat(self, **kwargs):
                self.calls += 1
                if self.calls == 1:
                    loop.note_world_event("hurt", "被僵尸攻击")
                    return SimpleNamespace(tools_call_name=["mc_mine_stone"], tools_call_args=[{}])
                self.assert_prompt = kwargs["contexts"][-1].content
                return SimpleNamespace(tools_call_name=[], completion_text="先躲开")

        provider = Provider()

        async def get_provider():
            return provider

        plugin = SimpleNamespace(life=loop, context=SimpleNamespace(get_using_provider_async=get_provider))
        agent = ActionAgent(plugin)
        agent._toolset = lambda: "test"

        async def execute(name, args, event):
            executed.append(name)
            return "ok"

        agent._execute = execute
        summary, _ = await agent.act(prompt="去挖石头", system="玩家")
        self.assertEqual(summary, "先躲开")
        self.assertEqual(executed, [])
        self.assertIn("被僵尸攻击", provider.assert_prompt)

    async def test_emergency_guard_allows_reads_and_blocks_actions(self):
        loop, _ = make_loop()
        calls = []

        class Plugin:
            _emergency_stopped = True
            connected = True
            life = loop

            async def tool(self, event):
                calls.append("called")
                return "状态正常"

        plugin = Plugin()
        manager = SimpleNamespace(get_func=lambda name: SimpleNamespace(handler=plugin.tool))
        plugin.context = SimpleNamespace(provider_manager=SimpleNamespace(llm_tools=manager))
        for agent, execute in (
            (ActionAgent(plugin), "_execute"),
            (GameChatAgent(plugin), "_execute_tool"),
        ):
            call = getattr(agent, execute)
            self.assertTrue((await call("mc_mine", {}, GameEventShim("Alice"))).startswith("error:"))
            self.assertEqual(await call("mc_status", {}, GameEventShim("Alice")), "状态正常")
        self.assertEqual(len(calls), 2)
        self.assertFalse(loop.paused)

    async def test_rpc_completion_does_not_restore_busy_grace(self):
        loop, _ = make_loop()

        async def instant_finish(method, params=None, **kwargs):
            loop.wake("极短任务已完成")
            return {"task_id": "t1"}

        loop._call = instant_finish
        await loop._act(L.LifeDecision(activity="合成木板", drive=None, skill="craft"))
        self.assertEqual(loop._busy_until, 0.0)

    async def test_agent_receives_survival_advice_and_skill_whitelist(self):
        loop, _ = make_loop()

        async def skills():
            return {"skills": [{"skill": "chop_tree"}, {"skill": "make_tools"}]}

        class Agent:
            async def act(self, **kwargs):
                self.prompt = kwargs["prompt"]
                return "去收集木头", []

        agent = Agent()
        loop.action_agent = agent
        loop._skill_catalog = skills
        await loop._act_via_agent()
        self.assertIn("生存现状", agent.prompt)
        self.assertEqual(loop._known_skills, {"chop_tree", "make_tools"})
        self.assertFalse(loop.note_plan_from_agent(["unknown_skill"])["ok"])

    async def test_plan_submission_finishes_agent_without_duplicate_action(self):
        loop, _ = make_loop()
        called = []

        class Provider:
            calls = 0

            async def text_chat(self, **kwargs):
                self.calls += 1
                return SimpleNamespace(
                    tools_call_name=["mc_plan_do", "mc_chop_tree"],
                    tools_call_args=[{}, {}], tools_call_ids=["p1", "p2"],
                    completion_text="", to_openai_tool_calls_model=lambda: [],
                )

        provider = Provider()

        async def get_provider():
            return provider

        plugin = SimpleNamespace(life=loop, context=SimpleNamespace(get_using_provider_async=get_provider))
        agent = ActionAgent(plugin)
        agent._toolset = lambda: "test"

        async def execute(name, args, event):
            called.append(name)
            loop.note_plan_from_agent(["chop_tree", "make_tools"])
            return "记下了 2 步"

        agent._execute = execute
        _, used = await agent.act(prompt="先砍树再做工具", system="玩家")
        self.assertEqual(called, ["mc_plan_do"])
        self.assertEqual(used, ["mc_plan_do"])
        self.assertEqual(provider.calls, 1)
        self.assertEqual(len(loop._pending_plan), 2)

    async def test_player_plan_replaces_old_plan_only_after_acceptance(self):
        loop, _ = make_loop()
        loop._plan = [{"skill": "mine_stone", "params": {}}]

        class Plugin:
            _emergency_stopped = False
            connected = True
            life = loop

            async def plan(self, event, steps=""):
                if not steps:
                    return "没给步骤"
                loop.note_plan_from_agent([steps])
                return "记下了 1 步"

        plugin = Plugin()
        manager = SimpleNamespace(get_func=lambda name: SimpleNamespace(handler=plugin.plan))
        plugin.context = SimpleNamespace(provider_manager=SimpleNamespace(llm_tools=manager))
        agent = GameChatAgent(plugin)
        await agent._execute_tool("mc_plan_do", {}, GameEventShim("Alice"))
        self.assertEqual([step["skill"] for step in loop._plan], ["mine_stone"])
        await agent._execute_tool("mc_plan_do", {"steps": "chop_tree"}, GameEventShim("Alice"))
        self.assertEqual(loop._plan, [])
        self.assertEqual([step["skill"] for step in loop._pending_plan], ["chop_tree"])
        self.assertFalse(loop.paused)

    async def test_player_plan_arriving_during_model_request_wins(self):
        loop, _ = make_loop()
        called = []

        class Provider:
            async def text_chat(self, **kwargs):
                loop.note_plan_from_agent(["chop_tree"])
                return SimpleNamespace(tools_call_name=["mc_mine_stone"], tools_call_args=[{}])

        async def get_provider():
            return Provider()

        plugin = SimpleNamespace(life=loop, context=SimpleNamespace(get_using_provider_async=get_provider))
        agent = ActionAgent(plugin)
        agent._toolset = lambda: "test"

        async def execute(name, args, event):
            called.append(name)
            return "ok"

        agent._execute = execute
        await agent.act(prompt="去挖石头", system="玩家")
        self.assertEqual(called, [])
        self.assertEqual([step["skill"] for step in loop._pending_plan], ["chop_tree"])

    async def test_player_plan_replacing_selected_step_prevents_old_submission(self):
        loop, calls = make_loop()
        loop._plan = [{"skill": "mine_stone", "params": {}}]

        async def new_plan_during_activity(decision):
            loop.clear_plan("玩家重新安排")
            loop.note_plan_from_agent(["chop_tree"])

        loop._on_activity = new_plan_during_activity
        await loop._act(L.LifeDecision(activity="挖石头", drive=None, skill="mine_stone"))
        self.assertFalse(any(method == "skill.run" for method, _ in calls))
        self.assertEqual([step["skill"] for step in loop._pending_plan], ["chop_tree"])
        self.assertTrue(loop._wake.is_set())

    def test_new_session_clears_all_old_plans_and_keeps_emergency_pause(self):
        loop, _ = make_loop()
        loop._plan = [{"skill": "mine_stone", "params": {}}]
        loop.note_plan_from_agent(["chop_tree", "make_tools"])
        old_revision = loop._plan_revision
        loop.pause(reason="主人急停", max_seconds=0)
        loop.on_session_start()
        self.assertEqual(loop._plan, [])
        self.assertEqual(loop._pending_plan, [])
        self.assertGreater(loop._plan_revision, old_revision)
        self.assertTrue(loop.paused)
        self.assertFalse(loop.may_act())
        self.assertTrue(loop._wake.is_set())

    async def test_reconnect_during_selected_step_callback_blocks_submission(self):
        loop, calls = make_loop()

        async def reconnect(decision):
            loop.on_session_start()

        loop._on_activity = reconnect
        await loop._act(L.LifeDecision(activity="挖石头", drive=None, skill="mine_stone"))
        self.assertFalse(any(method == "skill.run" for method, _ in calls))

    async def test_reconnect_discards_inflight_agent_tools_and_plan(self):
        loop, _ = make_loop()
        thinking = asyncio.Event()
        release = asyncio.Event()
        called = []

        class Provider:
            async def text_chat(self, **kwargs):
                thinking.set()
                await release.wait()
                return SimpleNamespace(
                    tools_call_name=["mc_plan_do", "mc_mine_stone"],
                    tools_call_args=[{}, {}], tools_call_ids=["p1", "a1"],
                    completion_text="", to_openai_tool_calls_model=lambda: [],
                )

        async def get_provider():
            return Provider()

        plugin = SimpleNamespace(life=loop, context=SimpleNamespace(get_using_provider_async=get_provider))
        agent = ActionAgent(plugin)
        agent._toolset = lambda: "test"

        async def execute(name, args, event):
            called.append(name)
            if name == "mc_plan_do":
                loop.note_plan_from_agent(["mine_stone"])
            return "ok"

        agent._execute = execute
        task = asyncio.create_task(agent.act(prompt="旧会话挖矿", system="玩家"))
        await asyncio.wait_for(thinking.wait(), 1)
        loop.on_session_start()
        release.set()
        _, used = await asyncio.wait_for(task, 1)
        self.assertEqual(called, [])
        self.assertEqual(used, [])
        self.assertEqual(loop._pending_plan, [])

    async def test_reconnect_between_agent_tools_blocks_remaining_batch(self):
        loop, _ = make_loop()
        called = []

        class Provider:
            async def text_chat(self, **kwargs):
                return SimpleNamespace(
                    tools_call_name=["mc_status", "mc_mine_stone"],
                    tools_call_args=[{}, {}], tools_call_ids=["r1", "a1"],
                    completion_text="", to_openai_tool_calls_model=lambda: [],
                )

        async def get_provider():
            return Provider()

        plugin = SimpleNamespace(life=loop, context=SimpleNamespace(get_using_provider_async=get_provider))
        agent = ActionAgent(plugin)
        agent._toolset = lambda: "test"

        async def execute(name, args, event):
            called.append(name)
            loop.on_session_start()
            return "状态正常"

        agent._execute = execute
        _, used = await agent.act(prompt="检查然后挖矿", system="玩家")
        self.assertEqual(called, ["mc_status"])
        self.assertEqual(used, ["mc_status"])

    async def test_reconnect_discards_inflight_json_decision(self):
        loop, calls = make_loop()
        thinking = asyncio.Event()
        release = asyncio.Event()

        async def delayed_llm(prompt, system):
            thinking.set()
            await release.wait()
            return json.dumps({
                "activity": "继续旧会话挖矿", "intention": "造房子",
                "plan": [{"skill": "mine_stone"}, {"skill": "build_shelter"}],
            })

        loop._llm = delayed_llm
        task = asyncio.create_task(loop.decide())
        await asyncio.wait_for(thinking.wait(), 1)
        loop.on_session_start()
        release.set()
        decision = await asyncio.wait_for(task, 1)
        self.assertIsNone(decision)
        self.assertEqual(loop._plan, [])
        self.assertEqual(loop._pending_plan, [])
        self.assertEqual(loop._intention, "")
        self.assertFalse(any(method == "skill.run" for method, _ in calls))

    async def test_loop_reconnect_discard_replans_without_failure_backoff(self):
        loop, calls = make_loop()
        done = asyncio.Event()
        model_calls = 0

        async def model(prompt, system):
            nonlocal model_calls
            model_calls += 1
            if model_calls == 1:
                loop.on_session_start()
                loop._decision_input_text = "新会话要砍树"
                return json.dumps({
                    "activity": "旧会话挖矿",
                    "plan": [{"skill": "mine_stone"}, {"skill": "build_shelter"}],
                })
            self.assertEqual(loop._decide_timeouts, 0)
            self.assertEqual(loop._decision_retry_at, 0)
            self.assertIn("新会话要砍树", prompt)
            return json.dumps({"activity": "新会话砍树", "skill": "chop_tree"})

        async def engine(method, params=None, **kwargs):
            calls.append((method, params))
            if method == "skill.run":
                done.set()
                return {"task_id": "new-session-task"}
            return {"current": None, "queued": 0}

        loop._llm = model
        loop._call = engine
        loop._wake.set()
        loop.start()
        try:
            # 生产故障退避至少 8 秒；这里必须在 1 秒内重新决策并提交。
            await asyncio.wait_for(done.wait(), 1)
            submitted = [params["skill"] for method, params in calls if method == "skill.run"]
            self.assertEqual(submitted, ["chop_tree"])
            self.assertEqual(model_calls, 2)
            self.assertEqual(loop._decide_timeouts, 0)
            self.assertEqual(loop._decision_retry_at, 0)
        finally:
            await loop.stop()

    async def test_reconnect_during_agent_preparation_discards_old_context(self):
        loop, _ = make_loop()
        preparing = asyncio.Event()
        release = asyncio.Event()
        called = []

        async def delayed_system():
            preparing.set()
            await release.wait()
            return "旧会话提示词"

        class Agent:
            async def act(self, **kwargs):
                called.append(kwargs["prompt"])
                return "挖矿", []

        loop._system_prompt = delayed_system
        loop.action_agent = Agent()
        task = asyncio.create_task(loop._act_via_agent())
        await asyncio.wait_for(preparing.wait(), 1)
        loop.on_session_start()
        release.set()
        self.assertTrue(await asyncio.wait_for(task, 1))
        self.assertEqual(called, [])

    async def test_game_model_failure_after_short_action_keeps_outcome(self):
        loop, _ = make_loop()
        called = []

        class Plugin:
            _emergency_stopped = False
            connected = True
            life = loop

            async def tool(self, event):
                called.append("equipped")
                return "装备完成"

            async def _system_prompt_for_mc(self, **kwargs):
                return "玩家"

            async def _get_brief(self):
                return "正常"

            async def _my_memory(self, *args, **kwargs):
                return ""

        class Provider:
            calls = 0

            async def text_chat(self, **kwargs):
                self.calls += 1
                if self.calls > 1:
                    raise RuntimeError("端点断线")
                return SimpleNamespace(tools_call_name=["mc_equip"], tools_call_args=[{}], tools_call_ids=["t1"], completion_text="", to_openai_tool_calls_model=lambda: [])

        plugin = Plugin()
        provider = Provider()

        async def get_provider():
            return provider

        manager = SimpleNamespace(get_func=lambda name: SimpleNamespace(handler=plugin.tool))
        plugin.context = SimpleNamespace(get_using_provider_async=get_provider, provider_manager=SimpleNamespace(llm_tools=manager))
        agent = GameChatAgent(plugin)
        agent._mc_toolset = lambda: "test"
        reply = await agent.handle("Alice", "装备石镐")
        self.assertIsNotNone(reply)  # 主调用方不会再把原指令入队重放。
        self.assertEqual(called, ["equipped"])
        self.assertTrue(agent.last_request_had_action)
        self.assertFalse(loop.paused)

    async def test_player_prepare_ignores_unrelated_finish_and_releases_fast_task(self):
        from astrcraft_plugin.main import MinecraftPlugin

        loop, _ = make_loop()

        class Plugin:
            _emergency_stopped = False
            connected = True
            goals = None
            life = loop
            _cfg = staticmethod(lambda key, default=None: False if key == "announce_task_done" else default)
            _skill_name_from_task = staticmethod(MinecraftPlugin._skill_name_from_task)

            async def tool(self, event):
                self_test.assertEqual(self._player_action_inflight, 1)
                await MinecraftPlugin._on_task_finished(self, {"kind": "skill", "name": "旧任务", "status": "done"})
                self_test.assertTrue(loop.paused)
                return "新任务已开始，任务号 t-fast"

        self_test = self
        plugin = Plugin()
        manager = SimpleNamespace(get_func=lambda name: SimpleNamespace(handler=plugin.tool))
        plugin.context = SimpleNamespace(provider_manager=SimpleNamespace(llm_tools=manager))
        agent = GameChatAgent(plugin)
        await agent._execute_tool("mc_chop_tree", {}, GameEventShim("Alice"))
        self.assertEqual(plugin._player_action_inflight, 0)
        self.assertFalse(loop.paused)  # 队列已空，即使结果带任务号也必须立即归还。


if __name__ == "__main__":
    unittest.main(verbosity=2)
