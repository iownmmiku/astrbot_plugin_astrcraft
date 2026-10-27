"""Actual LLM plan parsing and completion must retain every required step."""
from __future__ import annotations

import asyncio
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _paths

_paths.require_astrbot("test_goal_completion")
G = _paths.plugin_module("goals")
_sleep = asyncio.sleep


class GoalCompletionTests(unittest.IsolatedAsyncioTestCase):
    async def manager(self, items):
        async def catalog(method, params, **kwargs):
            self.assertEqual(method, "skill.list")
            return {"names": ["chop_tree", "blueprint"], "skills": ["chop_tree", "blueprint"]}
        async def model(*args):
            return json.dumps(items)
        manager = G.GoalManager(engine_call=catalog, llm_planner=model)
        manager.plan = await manager._plan_with_llm("custom landmark")
        return manager

    async def run_plan(self, manager, failed_skill=None):
        seen, events = [], []
        async def execute(step, interruption):
            seen.append(step.skill)
            return {"ok": step.skill != failed_skill, "reason": "missing materials"}
        async def emit(event, data):
            events.append(event)
        async def quick_sleep(seconds):
            await _sleep(0)
        manager._execute_step, manager._emit = execute, emit
        manager.status = G.GOAL_RUNNING
        with patch.object(G.asyncio, "sleep", quick_sleep):
            await manager._run_loop(manager._run_generation, manager.plan)
        return seen, events

    async def test_failed_later_core_step_fails_entire_goal(self):
        manager = await self.manager([{"skill": "chop_tree"}, {"skill": "blueprint"}])
        self.assertTrue(all(step.required for step in manager.plan.steps))
        seen, events = await self.run_plan(manager, "blueprint")
        self.assertEqual(seen, ["chop_tree", "blueprint", "blueprint"])
        self.assertEqual(manager.status, G.GOAL_FAILED)
        self.assertIn("goal.failed", events)
        self.assertNotIn("goal.done", events)

    async def test_all_steps_successfully_complete(self):
        manager = await self.manager([{"skill": "chop_tree"}, {"skill": "blueprint"}])
        seen, events = await self.run_plan(manager)
        self.assertEqual(seen, ["chop_tree", "blueprint"])
        self.assertEqual(manager.status, G.GOAL_DONE)
        self.assertEqual(events[-1], "goal.done")

    async def test_unknown_malformed_or_oversized_plan_is_not_silently_shortened(self):
        for items in ([{"skill": "chop_tree"}, {"skill": "missing_skill"}],
                      [{"skill": "chop_tree"}, None], [{"skill": "chop_tree"}] * 7):
            with self.subTest(items=items):
                self.assertIsNone((await self.manager(items)).plan)

    async def test_explicit_optional_template_step_stays_optional(self):
        manager = await self.manager([{"skill": "chop_tree"}, {"skill": "blueprint"}])
        manager.plan.steps[-1].required = False
        _, events = await self.run_plan(manager, "blueprint")
        self.assertEqual(manager.status, G.GOAL_DONE)
        self.assertEqual(events[-1], "goal.done")

    async def test_malformed_params_are_rejected_without_default_action(self):
        for params in ([], "count=64", 64, None):
            with self.subTest(params=params):
                self.assertIsNone((await self.manager([{"skill": "chop_tree", "params": params}])).plan)


if __name__ == "__main__":
    unittest.main(verbosity=2)
