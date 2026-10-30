"""Fresh unified observations, concurrent reader isolation and honest wait status."""
from __future__ import annotations

import asyncio
import unittest
from unittest.mock import AsyncMock

from test_plugin_control import plugin
from test_home_awareness import home
from test_life_recovery import make_loop
from astrcraft_plugin.runtime_status import RuntimeMetrics, waiting_status


class ObservationTests(unittest.IsolatedAsyncioTestCase):
    def setup_plugin(self):
        p = plugin()
        p.engine.engine_info = {"features": ["survival_snapshot_v1"]}
        p.life, _ = make_loop()
        p.life.remember_home(home())
        self.addAsyncCleanup(self.cleanup, p)
        return p

    async def cleanup(self, p):
        for task in list(p._background_tasks):
            task.cancel()
        await asyncio.gather(*p._background_tasks, return_exceptions=True)

    def payload(self):
        return {"connected": True, "ready": True, "server": "test:25565", "dimension": "overworld",
                "health": 0, "food": 0, "time_of_day": 14000, "inventory_items": {"bread": 2},
                "inventory_slots": [{"name": "stone_pickaxe", "slot": 9, "count": 1, "durability_pct": 80}],
                "home": home(), "home_status": {"condition": "intact", "loaded": True, "safe": False},
                "farm_status": {"kind": "wheat", "mature": 2, "loaded": True},
                "mining_return_safety": {"safe": False}, "observed_at": 100.0}

    async def test_one_call_observes_body_inventory_home_and_farm(self):
        p = self.setup_plugin()
        p.engine.call = AsyncMock(return_value=self.payload())
        observed = await p._life_state_snapshot()
        p.engine.call.assert_awaited_once_with("state.survival", {"homes": p.life._homes}, timeout=8.0)
        self.assertEqual(observed["health"], 0)
        self.assertEqual(observed["food"], 0)
        self.assertEqual(observed["inventory"], {"bread": 2})
        self.assertEqual(observed["farm_status"]["mature"], 2)
        self.assertFalse(observed["has_shelter"])
        self.assertEqual(observed["inventory_slots"][0]["durability_pct"], 80)

    async def test_concurrent_reads_share_only_inflight_work_not_old_results(self):
        p = self.setup_plugin()
        entered, release = asyncio.Event(), asyncio.Event()
        calls = 0
        async def read(*args, **kwargs):
            nonlocal calls
            calls += 1
            entered.set()
            await release.wait()
            return {**self.payload(), "health": calls}
        p.engine.call = read
        first = asyncio.create_task(p._life_state_snapshot())
        await entered.wait()
        second = asyncio.create_task(p._life_state_snapshot())
        await asyncio.sleep(0)
        release.set()
        a, b = await asyncio.gather(first, second)
        self.assertEqual(calls, 1)
        self.assertEqual(a, b)
        self.assertEqual((await p._life_state_snapshot())["health"], 2)
        self.assertEqual(p._runtime_metrics().shared_reads, 1)

    async def test_cancelled_reader_does_not_cancel_another_reader(self):
        p = self.setup_plugin()
        entered, release = asyncio.Event(), asyncio.Event()
        async def read(*args, **kwargs):
            entered.set()
            await release.wait()
            return self.payload()
        p.engine.call = read
        first = asyncio.create_task(p._life_state_snapshot())
        await entered.wait()
        second = asyncio.create_task(p._life_state_snapshot())
        await asyncio.sleep(0)
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first
        release.set()
        self.assertEqual((await second)["inventory"], {"bread": 2})

    async def test_superseded_body_discards_result_before_home_side_effects(self):
        p = self.setup_plugin()
        entered, release = asyncio.Event(), asyncio.Event()
        p.life.note_home_status = AsyncMock()  # Must not even be invoked.
        async def read(*args, **kwargs):
            entered.set()
            await release.wait()
            return self.payload()
        p.engine.call = read
        task = asyncio.create_task(p._life_state_snapshot())
        await entered.wait()
        p._bot_lifecycle_id = 9
        release.set()
        self.assertEqual(await task, {"has_shelter": False})
        p.life.note_home_status.assert_not_called()

    async def test_changed_inventory_starts_new_read_while_old_one_waits(self):
        p = self.setup_plugin()
        entered, release = asyncio.Event(), asyncio.Event()
        calls = 0
        async def read(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                entered.set()
                await release.wait()
            return self.payload()
        p.engine.call = read
        old = asyncio.create_task(p._life_state_snapshot())
        await entered.wait()
        p._observation_revision = 1
        current = await p._life_state_snapshot()
        release.set()
        self.assertEqual(await old, {"has_shelter": False})
        self.assertEqual(current["inventory"], {"bread": 2})
        self.assertEqual(calls, 2)


class RuntimeStatusTests(unittest.TestCase):
    def test_waiting_status_does_not_invent_automatic_resume(self):
        life, _ = make_loop()
        life.pause(reason="owner", max_seconds=0)
        status = waiting_status(life, now=100)
        self.assertIsNone(status["retry_at"])
        self.assertEqual(status["release_when"], "主人继续游玩")
        self.assertEqual(waiting_status(life, emergency=True)["kind"], "emergency")

    def test_real_retry_deadline_and_supply_reason_are_exposed(self):
        life, _ = make_loop()
        life._decision_retry_at, life._decide_timeouts = 130, 2
        self.assertEqual(waiting_status(life, now=100)["retry_at"], 130)
        life._rule_supply_wait_reason = "等白天再出门"
        status = waiting_status(life, now=100)
        self.assertEqual(status["kind"], "supply")
        self.assertIsNone(status["retry_at"])

    def test_handoff_samples_exclude_reflexes_duplicates_and_pauses(self):
        m = RuntimeMetrics()
        finish = {"task_id": "a", "kind": "skill", "status": "done"}
        m.task_event("task.finished", finish, continuing=True, now=10)
        m.task_event("task.finished", finish, continuing=True, now=11)
        m.task_event("bot.inventory", {"items": {"bread": 4}}, continuing=True, now=11)
        m.task_event("task.started", {"task_id": "reflex", "kind": "reflex"}, continuing=True, now=11)
        m.task_event("task.started", {"task_id": "b", "kind": "skill"}, continuing=True, now=12)
        self.assertEqual(m.snapshot()["handoff_ms"], {"samples": 1, "last": 2000, "p95": 2000})
        m.task_event("task.finished", {**finish, "task_id": "b"}, continuing=True, now=13)
        m.reset_handoff()
        m.task_event("task.started", {"task_id": "c"}, continuing=True, now=100)
        self.assertEqual(len(m.handoffs), 1)
        for n in range(1000):
            m.observations.append(n)
        self.assertEqual(m.snapshot()["observation_ms"]["samples"], 100)

    def test_failed_results_and_manual_actions_do_not_form_skill_handoffs(self):
        m = RuntimeMetrics()
        finish = {"task_id": "a", "kind": "skill", "status": "done", "result": {"ok": False}}
        m.task_event("task.finished", finish, continuing=True, now=10)
        m.task_event("task.started", {"task_id": "b", "kind": "skill"}, continuing=True, now=12)
        m.task_event("task.finished", {**finish, "task_id": "b", "result": {"ok": True}}, continuing=True, now=13)
        m.task_event("task.started", {"task_id": "manual", "kind": "action"}, continuing=True, now=14)
        m.task_event("task.finished", {"task_id": "manual", "kind": "action", "status": "done"}, continuing=True, now=15)
        m.task_event("task.started", {"task_id": "c", "kind": "skill"}, continuing=True, now=16)
        self.assertEqual(m.snapshot()["handoff_ms"]["samples"], 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
