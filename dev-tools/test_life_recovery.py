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
        loop._set_plan([{"skill": "make_tools", "params": {"tier": "stone"}}])
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

            async def act(decision):
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
