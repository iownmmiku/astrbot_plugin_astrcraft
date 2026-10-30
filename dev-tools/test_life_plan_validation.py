"""Offline checks: reject incomplete autonomous plans before queuing actions."""

from __future__ import annotations

import copy
import json
import time
import unittest
from types import SimpleNamespace

from test_life_recovery import make_loop


class LifePlanValidationTests(unittest.IsolatedAsyncioTestCase):
    def loop(self):
        loop, calls = make_loop()
        loop._known_skills = {"chop_tree", "make_tools", "mine_stone"}
        return loop, calls

    def test_json_invalid_step_rejects_entire_dependency_chain(self):
        for invalid in (None, 12, {}, "unknown_skill", {"skill": "unknown_skill"},
                        {"skill": 42}, {"skill": "make_tools", "params": []},
                        {"skill": "make_tools", "params": None},
                        {"skill": "make_tools", "params": "tier=stone"},
                        {"skill": "make_tools", "params": 8}):
            with self.subTest(invalid=invalid):
                loop, _ = self.loop()
                old = [{"skill": "chop_tree", "params": {"count": 2}, "why": "previous"}]
                loop._pending_plan = copy.deepcopy(old)
                decision = loop._parse_decision(json.dumps({"activity": "备好工具再采石", "plan": [
                    {"skill": "chop_tree"}, invalid, {"skill": "mine_stone"},
                ]}), {})
                self.assertIsNone(decision)
                self.assertEqual(loop._pending_plan, old)

    def test_single_action_invalid_params_never_become_defaults(self):
        for invalid in (None, [], "count=2", 4, False):
            with self.subTest(params=invalid):
                loop, _ = self.loop()
                self.assertIsNone(loop._parse_decision(json.dumps({
                    "activity": "砍树", "skill": "chop_tree", "params": invalid,
                }), {}))

    def test_malformed_plan_does_not_fall_back_to_top_level_skill(self):
        for invalid in ({}, "make_tools", None, 8, False):
            with self.subTest(plan=invalid):
                loop, _ = self.loop()
                self.assertIsNone(loop._parse_decision(json.dumps({
                    "activity": "做工具", "skill": "make_tools", "plan": invalid,
                }), {}))

    def test_agent_rejection_keeps_previous_plan_and_never_raises(self):
        for invalid in (None, "chop_tree", {"skill": "chop_tree"}, [],
                        ["chop_tree", "unknown_skill", "mine_stone"],
                        ["chop_tree", 2, "mine_stone"],
                        [{"skill": "chop_tree", "params": "count=2"}],
                        [{"skill": "chop_tree", "params": [["count", 2]]}],
                        [{"skill": "chop_tree", "params": None}],
                        ["chop_tree"] * 7):
            with self.subTest(steps=invalid):
                loop, _ = self.loop()
                old = [{"skill": "mine_stone", "params": {"count": 3}, "why": "existing"}]
                loop._plan = copy.deepcopy(old)
                loop._pending_plan = copy.deepcopy(old)
                result = loop.note_plan_from_agent(invalid)
                self.assertIs(result["ok"], False)
                self.assertEqual(loop._pending_plan, old)
                self.assertEqual(loop._plan, old)

    def test_overlong_json_plan_is_rejected_instead_of_truncated(self):
        loop, _ = self.loop()
        self.assertIsNone(loop._parse_decision(json.dumps({
            "activity": "连续采集", "plan": ["chop_tree"] * 7,
        }), {}))

    def test_internal_plan_install_does_not_drop_a_dependency(self):
        for invalid in ([{"skill": "chop_tree"}, {"skill": "unknown_skill"}, {"skill": "mine_stone"}],
                        [{"skill": "make_tools", "params": []}],
                        [{"skill": "chop_tree"}] * 7):
            with self.subTest(plan=invalid):
                loop, _ = self.loop()
                loop._set_plan([{"skill": "mine_stone", "params": {"count": 3}}])
                old = copy.deepcopy(loop._plan)
                loop._set_plan(invalid)
                self.assertEqual(loop._plan, old)

    def test_empty_plan_omitted_params_and_valid_six_steps_still_work(self):
        loop, _ = self.loop()
        idle = loop._parse_decision('{"activity":"休息", "plan":[]}', {})
        self.assertIsNotNone(idle)
        self.assertIsNone(idle.skill)
        single = loop._parse_decision('{"activity":"砍树", "skill":"chop_tree"}', {})
        self.assertEqual(single.params, {})
        self.assertTrue(loop.note_plan_from_agent(["chop_tree"] * 6)["ok"])
        loop._set_plan(loop._pending_plan)
        self.assertEqual(len(loop._plan), 6)
        loop._set_plan([])
        self.assertEqual(loop._plan, [])
        plan = loop._parse_decision(json.dumps({"activity": "采集", "plan": ["chop_tree"] * 6}), {})
        self.assertEqual(plan.skill, "chop_tree")
        self.assertEqual(len(loop._pending_plan), 5)

    async def test_invalid_json_does_not_enqueue_later_action_in_real_decision_path(self):
        loop, calls = self.loop()
        async def bad_plan(*args):
            return json.dumps({"activity": "做工具然后挖石头", "plan": [
                {"skill": "make_tools", "params": []}, {"skill": "mine_stone"},
            ]})
        loop._llm = bad_plan
        await loop.decide()
        self.assertFalse(loop._decision_model_ok)
        self.assertEqual(loop._plan, [])
        self.assertEqual(calls, [])

    async def test_failed_reconsideration_keeps_original_first_step_and_tail(self):
        loop, _ = self.loop()
        first = loop._parse_decision(json.dumps({"activity": "取木做工具", "plan": [
            {"skill": "chop_tree", "params": {"count": 4}}, {"skill": "make_tools"},
        ]}), {})
        tail = copy.deepcopy(loop._pending_plan)
        loop._recent_failures["chop_tree"] = [time.time()] * 3
        async def invalid_reconsideration(*args):
            return json.dumps({"activity": "换方法采石", "plan": [
                {"skill": "unknown_skill"}, {"skill": "mine_stone"},
            ]})
        loop._llm = invalid_reconsideration
        self.assertIs(await loop._reconsider_if_looping(first, "", "", {}), first)
        self.assertEqual(loop._pending_plan, tail)

    async def test_rule_replacement_discards_steps_depending_on_rejected_first_step(self):
        for fallback_skill in ("chop_tree", "unknown_skill"):
            with self.subTest(fallback=fallback_skill):
                loop, _ = self.loop()
                raw = json.dumps({"activity": "采石制作工具", "plan": [
                    {"skill": "mine_stone", "params": {"count": 8}},
                    {"skill": "make_tools", "params": {"tier": "stone"}},
                ]})
                first = loop._parse_decision(raw, {})
                loop._recent_failures["mine_stone"] = [time.time()] * 5
                loop._last_advice = SimpleNamespace(skill=fallback_skill, params={"count": 4}, why="先找木头")
                async def insist(*args):
                    return raw
                loop._llm = insist
                result = await loop._reconsider_if_looping(first, "", "", {})
                self.assertEqual(result.skill, "chop_tree" if fallback_skill == "chop_tree" else None)
                self.assertEqual(loop._pending_plan, [], "unexecuted mining cannot supply the dependent stone tools")

    async def test_superseded_reconsideration_cannot_replace_new_owner_plan(self):
        loop, _ = self.loop()
        raw = json.dumps({"activity": "采石制作工具", "plan": [
            {"skill": "mine_stone"}, {"skill": "make_tools"},
        ]})
        loop._recent_failures["mine_stone"] = [time.time()] * 3
        model_calls = 0
        async def new_owner_plan_during_reconsideration(*args):
            nonlocal model_calls
            model_calls += 1
            if model_calls == 2:
                loop.clear_plan("主人刚刚指定了新计划")
                loop.note_plan_from_agent([{"skill": "chop_tree", "params": {"count": 2}}])
            return raw
        loop._llm = new_owner_plan_during_reconsideration
        self.assertIsNone(await loop.decide())
        self.assertEqual(model_calls, 2)
        self.assertEqual(loop._pending_plan, [{"skill": "chop_tree", "params": {"count": 2}, "why": ""}])


if __name__ == "__main__":
    unittest.main()
