"""Game chat observes without taking control; addressed actions have one owner."""
from __future__ import annotations

import asyncio
import copy
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _paths
import test_mining_return as R
from test_plugin_control import plugin

Inbox = _paths.plugin_module("inbox")
GameChatAgent = _paths.plugin_module("game_agent").GameChatAgent


class GameChatRoutingTests(unittest.IsolatedAsyncioTestCase):
    def make_plugin(self):
        p = plugin()
        state = R.snapshot()
        p.life = R.MiningReturnTests.make_loop(self, state)
        p.life._set_plan([{"skill": "make_tools", "params": {"tier": "stone"}}])
        R.MiningReturnTests.arm(self, p.life, state)
        self.assertIsNotNone(p.life._mining_return)
        p.life._wake.clear()
        p._get_brief = AsyncMock(return_value="underground, return pending")
        p._system_prompt_for_mc = AsyncMock(return_value="fixture")
        p._my_memory = AsyncMock(return_value="")
        p._llm = AsyncMock(return_value="收到")
        p.game_agent = SimpleNamespace(handle=AsyncMock(return_value="好的"), last_request_had_action=False)
        return p

    async def chat(self, p, message, sender="Alice"):
        await p._on_game_chat({"sender": sender, "message": message})
        await asyncio.gather(*list(p._background_tasks))

    def return_state(self, loop):
        return copy.deepcopy((loop._mining_return, loop._return_task_attempt, loop._plan,
                              loop._plan_revision, loop._return_control_generation,
                              loop._decision_owner_generation, loop._decision_retry_at))

    async def test_passive_chat_preserves_real_mining_return_across_config_matrix(self):
        for reply in (False, True):
            for actions in (False, True):
                for message in ("hello everyone", "AstrBot 帮我挖矿"):
                    if reply and actions and message.startswith("AstrBot"):
                        continue
                    with self.subTest(reply=reply, actions=actions, message=message):
                        p = self.make_plugin()
                        p.config.update(reply_in_game=reply, in_game_actions=actions)
                        before = self.return_state(p.life)
                        await self.chat(p, message)
                        self.assertEqual(self.return_state(p.life), before)
                        self.assertFalse(p.life._wake.is_set())
                        self.assertEqual(len(p.life.inbox), 1)
                        entry = p.life.inbox.entries[0]
                        self.assertEqual(entry.type, "game_chat")
                        spec = Inbox.type_of(entry.type)
                        self.assertIs(spec.delivery, Inbox.Delivery.FOLLOW_UP)
                        self.assertFalse(spec.from_owner)
                        self.assertFalse(entry.urgent)
                        self.assertFalse(p.life.inbox.has_delivery(Inbox.Delivery.STEER))
                        self.assertEqual(p.life._drain_steer_text(), "")
                        self.assertIn(message, p.life._take_follow_up_text())
                        self.assertEqual(self.return_state(p.life), before)
                        self.assertFalse(p.life._decision_owner_pending)
                        p.game_agent.handle.assert_not_awaited()
                        self.assertEqual(p._llm.await_count, int(reply and message.startswith("AstrBot")))

    async def test_bot_echo_is_filtered_before_observation_or_reply(self):
        p = self.make_plugin()
        before = self.return_state(p.life)
        await self.chat(p, "AstrBot 帮我挖矿", sender=" astrbot ")
        self.assertEqual(self.return_state(p.life), before)
        self.assertEqual(len(p.life.inbox), 0)
        p._notify_subscribers.assert_not_awaited()
        p.game_agent.handle.assert_not_awaited()

    async def test_addressed_chat_has_only_agent_ownership_until_it_requests_action(self):
        p = self.make_plugin()
        p.config["wake_words"] = ["纱雾"]
        before = self.return_state(p.life)
        await self.chat(p, "纱雾 早上好")
        p.game_agent.handle.assert_awaited_once_with("Alice", "纱雾 早上好")
        self.assertEqual(len(p.life.inbox), 0)
        self.assertEqual(self.return_state(p.life), before)
        self.assertFalse(p.life._wake.is_set())
        p._llm.assert_not_awaited()

    async def test_addressed_body_action_replaces_return_once_through_actual_agent(self):
        p = self.make_plugin()
        invoked = []

        async def follow(event, player=""):
            invoked.append(player)
            yield event.plain_result("已开始跟随")

        tool = SimpleNamespace(name="mc_follow", handler=follow)
        p.context = SimpleNamespace(provider_manager=SimpleNamespace(
            llm_tools=SimpleNamespace(get_func=lambda name: tool)))
        agent = GameChatAgent(p)

        async def handle(sender, message):
            from astrcraft_plugin.game_agent import GameEventShim
            return await agent._execute_tool("mc_follow", {"player": sender}, GameEventShim(sender))

        agent.handle = AsyncMock(side_effect=handle)
        p.game_agent = agent
        p.life.note_owner_said = Mock(wraps=p.life.note_owner_said)
        revision = p.life._plan_revision
        await self.chat(p, "AstrBot 跟着我")
        self.assertEqual(invoked, ["Alice"])
        self.assertIsNone(p.life._mining_return)
        self.assertEqual(p.life._plan, [])
        self.assertEqual(p.life._plan_revision, revision + 1)
        self.assertEqual(len(p.life.inbox), 0)
        p.life.note_owner_said.assert_not_called()
        p._llm.assert_not_awaited()

    async def test_unavailable_agent_transfers_addressed_action_to_life_once(self):
        for unavailable in (None, "no-provider", "failure", "timeout"):
            with self.subTest(unavailable=unavailable):
                p = self.make_plugin()
                if unavailable is None:
                    p.game_agent = None
                else:
                    p.game_agent.handle.return_value = None
                    if unavailable == "failure":
                        p.game_agent.handle.side_effect = RuntimeError("offline")
                    if unavailable == "timeout":
                        p.game_agent.handle.side_effect = asyncio.TimeoutError()
                revision = p.life._plan_revision
                await self.chat(p, "AstrBot 砍树")
                self.assertIsNone(p.life._mining_return)
                self.assertEqual(p.life._plan_revision, revision + 1)
                self.assertEqual([entry.type for entry in p.life.inbox.entries], ["owner"])
                self.assertTrue(p.life._wake.is_set())
                p._llm.assert_awaited_once()

    async def test_agent_failure_after_action_does_not_replay_through_life(self):
        p = self.make_plugin()
        p.game_agent.last_request_had_action = True
        p.game_agent.handle.side_effect = RuntimeError("model disconnected after action")
        p.life.note_owner_said = Mock(wraps=p.life.note_owner_said)
        await self.chat(p, "AstrBot 砍树")
        p.life.note_owner_said.assert_not_called()
        self.assertEqual(len(p.life.inbox), 0)
        p._llm.assert_not_awaited()
        p.engine.say.assert_awaited_once()

    async def test_disabled_actions_ignore_stale_agent_action_flag_for_text_reply(self):
        p = self.make_plugin()
        p.config["in_game_actions"] = False
        p.game_agent.last_request_had_action = True
        before = self.return_state(p.life)
        await self.chat(p, "AstrBot 你好")
        p.game_agent.handle.assert_not_awaited()
        p._llm.assert_awaited_once()
        p.engine.say.assert_awaited_once_with("收到")
        self.assertEqual(self.return_state(p.life), before)
        self.assertFalse(p.life._wake.is_set())


if __name__ == "__main__":
    unittest.main(verbosity=2)
