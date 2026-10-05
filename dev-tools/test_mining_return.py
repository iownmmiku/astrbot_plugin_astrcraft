"""Real LifeLoop checks for collected material followed by a verified safe return."""
from __future__ import annotations

import asyncio
import copy
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_supply_resume as S
import test_base_food as B

L = S.L


def snapshot(**changes):
    return {"server": "return-fixture", "dimension": "overworld", "health": 20, "food": 20,
            "inventory": {"bread": 4, "stone_pickaxe": 1, "coal": 2},
            "position": {"x": 0, "y": 40, "z": 0}, "is_night": False,
            "mining_return_safety": {"safe": False, "loaded": True, "on_ground": True, "underground": True},
            **changes}


def report(state, *, ok=False, collection_ok=True, target=None, **status_changes):
    return {"ok": ok, "collection_ok": collection_ok, "produced": {"coal": 2 if collection_ok else 1},
            "return_status": {"required": True, "ok": ok,
                "target": {"x": 0, "y": 64, "z": 0} if target is None else target,
                "reason": None if ok else "return route blocked", "position": copy.deepcopy(state["position"]),
                "server": state["server"], "dimension": state["dimension"], **status_changes}}


class MiningReturnTests(unittest.IsolatedAsyncioTestCase):
    def make_loop(self, state):
        return S.SupplyResumeTests.make_loop(self, state)

    def arm(self, loop, state, *, collection_ok=True, name="mine_ores", task_id="mine-1", result=None):
        token = loop.register_task_submission(name, state)
        loop.bind_task_submission(token, {"task_id": task_id})
        loop.note_task_result(name, False, "return blocked", result=result or report(state, collection_ok=collection_ok),
                              task_id=task_id)

    async def rescue_result(self, loop, state, *, ok=False, result=None, task_id="rescue"):
        step = await loop._survival_step()
        self.assertEqual(step["skill"], "climb_out")
        token = loop.register_task_submission("climb_out", state)
        loop.bind_task_submission(token, {"task_id": task_id})
        loop.note_task_result("climb_out", ok, "" if ok else "blocked", result=result or report(state, ok=ok),
                              task_id=task_id)
        return step

    async def test_production_loop_rescues_and_resumes_exact_followup_without_model(self):
        state = snapshot()
        loop = self.make_loop(state)
        follow = {"skill": "make_tools", "params": {"tier": "stone", "kinds": ["axe"]}, "why": "next"}
        state["inventory"].update(cobblestone=3, stick=2, crafting_table=1)
        loop._set_plan([{"skill": "mine_ores", "params": {"ore": "coal", "count": 2}}, follow])
        submitted, done = [], asyncio.Event()
        async def engine(method, payload=None, **kwargs):
            if method == "task.list": return {"current": None, "queued": 0}
            submitted.append(copy.deepcopy(payload))
            task_id = f"task-{len(submitted)}"
            skill = payload["skill"]
            if skill == "mine_ores":
                loop.note_task_result(skill, False, "return blocked", result=report(state), task_id=task_id)
                self.assertIsNone(loop._mining_return, "must bind the actual task before accepting early events")
            elif skill == "climb_out":
                self.assertEqual(loop._plan, [follow])
                state["position"]["y"] = 64
                state["mining_return_safety"].update(safe=True, underground=False)
                loop.note_task_result(skill, True, result=report(state, ok=True), task_id=task_id)
            else:
                done.set(); loop._stopped = True
                loop.note_task_result(skill, True, task_id=task_id)
            loop.wake()
            return {"task_id": task_id}
        loop._call = engine
        await S.SupplyResumeTests.run_until(self, loop, done)
        self.assertEqual([p["skill"] for p in submitted], ["mine_ores", "climb_out", "make_tools"])
        self.assertEqual(submitted[-1]["params"], {**follow["params"], "safe_search": True})
        self.assertEqual(loop._recent_outcomes[0]["produced"], {"coal": 2})

    async def test_partial_collection_clears_dependencies_but_still_rescues(self):
        state, loop = snapshot(), self.make_loop(snapshot())
        loop._set_plan([{"skill": "make_tools", "params": {"tier": "iron"}}])
        self.arm(loop, state, collection_ok=False)
        self.assertEqual(loop._plan, [])
        self.assertEqual(loop._recent_outcomes[-1]["produced"], {"coal": 1})
        self.assertEqual((await loop._survival_step())["skill"], "climb_out")

    async def test_nested_compound_return_preserves_followup(self):
        state = snapshot()
        loop = self.make_loop(state)
        loop._set_plan([{"skill": "mine_ores", "params": {"ore": "iron", "count": 3}}])
        self.arm(loop, state, name="make_tools")
        self.assertEqual((await loop._survival_step())["skill"], "climb_out")
        self.assertEqual(len(loop._plan), 1)

    async def test_real_food_chain_dependency_result_is_rescued_by_life_loop(self):
        script = """
const { fixture } = require('./dev-tools/test_mining_return_composites');
const skills = require('./engine/skills');
(async () => {
  const f = fixture({ inventory: { beef: 4, torch: 4 }, ore: 'stone', amount: 8,
    loseAfterDig: true, stations: ['crafting_table'] });
  const result = await skills.get('food_chain').run({ ...f, params: {} });
  process.stdout.write(JSON.stringify({ result, inventory: f.counts,
    position: f.bot.entity.position }));
})().catch((error) => { process.stderr.write(String(error.stack)); process.exitCode = 1; });
"""
        proc = await asyncio.create_subprocess_exec("node", "-e", script, cwd=str(S._paths.REPO),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout=15)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.communicate()
            raise
        self.assertEqual(proc.returncode, 0, err.decode("utf-8", errors="replace"))
        actual = json.loads(out)
        result = actual["result"]
        state = snapshot(server="127.0.0.1:25566", inventory=actual["inventory"], position=actual["position"])
        loop = self.make_loop(state)
        loop._set_plan([{"skill": "make_tools", "params": {"tier": "iron", "kinds": ["pickaxe"]}}])
        self.arm(loop, state, name="food_chain", result=result)
        self.assertIsNotNone(loop._mining_return)
        self.assertEqual(loop._plan, [], "unfinished food cannot unlock work dependent on complete supplies")
        self.assertEqual(loop._recent_outcomes[-1]["produced"], {"cobblestone": 8})
        step = await loop._survival_step()
        self.assertEqual(step["skill"], "climb_out")
        self.assertEqual(step["params"]["return_target"], result["return_status"]["target"])
        self.assertEqual(state["inventory"]["beef"], 4)

    async def test_existing_eat_and_recover_precede_escape(self):
        state = snapshot(food=0, health=6)
        loop = self.make_loop(state)
        self.arm(loop, state)
        self.assertEqual((await loop._survival_step())["skill"], "eat")
        state["food"] = 20
        self.assertEqual((await loop._survival_step())["skill"], "recover")
        state["health"] = 20
        self.assertEqual((await loop._survival_step())["skill"], "climb_out")

    async def test_first_failed_rescue_preserves_plan_second_stall_replans(self):
        state = snapshot()
        loop = self.make_loop(state)
        loop._set_plan([{"skill": "mine_stone", "params": {"count": 8}}])
        self.arm(loop, state)
        await self.rescue_result(loop, state, task_id="rescue-1")
        self.assertEqual(len(loop._plan), 1)
        await self.rescue_result(loop, state, task_id="rescue-2")
        self.assertIsNone(await loop._survival_step())
        self.assertIsNone(loop._mining_return)
        self.assertEqual(loop._plan, [])
        self.assertIn("重试上限", loop._recent_outcomes[-1]["detail"])

    async def test_real_progress_reassesses_but_four_attempts_remain_bounded(self):
        state = snapshot()
        loop = self.make_loop(state)
        self.arm(loop, state)
        for index in range(4):
            step = await loop._survival_step()
            self.assertEqual(step["skill"], "climb_out")
            token = loop.register_task_submission("climb_out", state)
            loop.bind_task_submission(token, {"task_id": str(index)})
            state["position"]["y"] += 1
            loop.note_task_result("climb_out", False, result=report(state), task_id=str(index))
        self.assertIsNone(await loop._survival_step())
        self.assertIsNone(loop._mining_return)

    async def test_success_requires_fresh_safe_world_and_position(self):
        for corrupt in ("height-only", "unsafe", "underground", "not-loaded", "not-grounded", "position", "world"):
            with self.subTest(corrupt=corrupt):
                state = snapshot()
                loop = self.make_loop(state)
                loop._set_plan([{"skill": "mine_stone", "params": {"count": 8}}])
                self.arm(loop, state)
                step = await loop._survival_step()
                token = loop.register_task_submission("climb_out", state)
                loop.bind_task_submission(token, {"task_id": "rescue"})
                state["position"]["y"] = 64
                state["mining_return_safety"].update(safe=True, underground=False)
                result = report(state, ok=True)
                if corrupt == "height-only":
                    state["position"]["x"] = 20; result["return_status"]["position"]["x"] = 20
                    state["mining_return_safety"].update(safe=False, underground=True)
                elif corrupt == "unsafe": state["mining_return_safety"]["safe"] = False
                elif corrupt == "underground": state["mining_return_safety"]["underground"] = True
                elif corrupt == "not-loaded": state["mining_return_safety"]["loaded"] = False
                elif corrupt == "not-grounded": state["mining_return_safety"]["on_ground"] = False
                elif corrupt == "position": result["return_status"]["position"]["y"] = 50
                elif corrupt == "world": result["return_status"]["dimension"] = "the_nether"
                loop.note_task_result("climb_out", True, result=result, task_id="rescue")
                self.assertEqual((await loop._survival_step())["skill"], "climb_out")
                self.assertEqual(len(loop._plan), 1)

    async def test_missing_target_needs_real_safe_standpoint_and_omits_target_param(self):
        state = snapshot()
        loop = self.make_loop(state)
        result = report(state, target={})
        self.arm(loop, state, result=result)
        step = await self.rescue_result(loop, state, ok=True, result=report(state, ok=True, target={}))
        self.assertEqual(step["params"], {"max_steps": 40})
        self.assertIsNotNone(loop._mining_return)
        self.assertEqual((await loop._survival_step())["skill"], "climb_out")

    async def test_reported_success_does_not_unblock_before_fresh_snapshot(self):
        state = snapshot(position={"x": 0, "y": 64, "z": 0},
            mining_return_safety={"safe": True, "loaded": True, "on_ground": True, "underground": False})
        loop = self.make_loop(state)
        self.arm(loop, state, result=report(state, ok=True))
        self.assertIsNotNone(loop._mining_return)
        await loop._survival_step()
        self.assertIsNone(loop._mining_return)

    async def test_incomplete_snapshot_blocks_normal_work(self):
        state = snapshot()
        loop = self.make_loop(state)
        self.arm(loop, state)
        del state["inventory"]
        self.assertIsNone(await loop._survival_step())
        self.assertTrue(loop._rule_supply_wait_reason)
        self.assertIsNotNone(loop._mining_return)

    async def test_old_and_unregistered_completion_cannot_reinstate_plan(self):
        state = snapshot()
        loop = self.make_loop(state)
        loop._set_plan([{"skill": "mine_stone", "params": {"count": 8}}])
        token = loop.register_task_submission("mine_ores", state)
        loop.bind_task_submission(token, {"task_id": "current"})
        loop.note_task_result("mine_ores", False, result=report(state), task_id="old")
        self.assertIsNone(loop._mining_return)
        loop.clear_plan("owner replaced it")
        loop._set_plan([{"skill": "follow_player", "params": {"player": "owner"}}])
        loop.note_task_result("mine_ores", False, result=report(state), task_id="current")
        self.assertIsNone(loop._mining_return)
        self.assertEqual(loop._plan[0]["skill"], "follow_player")

    async def test_early_old_same_skill_is_filtered_by_rpc_binding(self):
        state = snapshot()
        loop = self.make_loop(state)
        token = loop.register_task_submission("mine_ores", state)
        loop.note_task_result("mine_ores", False, result=report(state), task_id="old")
        loop.bind_task_submission(token, {"task_id": "current"})
        self.assertIsNone(loop._mining_return)
        loop.note_task_result("mine_ores", False, result=report(state), task_id="current")
        self.assertIsNotNone(loop._mining_return)

    async def test_control_and_body_changes_discard_rescue_and_late_completion(self):
        for change in ("pause", "death", "engine", "world", "session", "owner"):
            with self.subTest(change=change):
                state = snapshot()
                loop = self.make_loop(state)
                loop._set_plan([{"skill": "mine_stone", "params": {"count": 8}}])
                self.arm(loop, state)
                token = loop.register_task_submission("climb_out", state)
                loop.bind_task_submission(token, {"task_id": "rescue"})
                if change == "pause": loop.pause(reason="owner", max_seconds=0); loop.resume()
                elif change == "death": loop.note_dead(True); loop.note_dead(False)
                elif change == "engine": loop.note_engine_up(False); loop.note_engine_up(True)
                elif change == "world": loop.on_world_change(); loop.on_world_ready()
                elif change == "session": loop.on_session_start()
                elif change == "owner": loop.note_owner_said("come here")
                loop.note_task_result("climb_out", True, result=report(state, ok=True), task_id="rescue")
                self.assertIsNone(await loop._survival_step())
                self.assertIsNone(loop._mining_return)

    async def test_owner_generation_change_and_state_fetch_race_do_not_submit_rescue(self):
        state = snapshot()
        loop = self.make_loop(state)
        self.arm(loop, state)
        async def snapshot_race():
            loop._decision_owner_generation += 1
            return copy.deepcopy(state)
        loop._state_provider = snapshot_race
        self.assertIsNone(await loop._survival_step())
        self.assertIsNone(loop._mining_return)

    async def test_no_physical_return_evidence_cannot_count_as_rescue_success(self):
        state = snapshot()
        loop = self.make_loop(state)
        self.arm(loop, state)
        token = loop.register_task_submission("climb_out", state)
        loop.bind_task_submission(token, {"task_id": "rescue"})
        loop.note_task_result("climb_out", True, "I'm out", task_id="rescue")
        self.assertEqual((await loop._survival_step())["skill"], "climb_out")

    async def test_ordinary_early_completion_is_also_bound_to_real_task(self):
        state = snapshot()
        loop = self.make_loop(state)
        token = loop.register_task_submission("mine_ores", state)
        loop.note_task_result("mine_ores", False, "old failure", task_id="old")
        self.assertIs(loop._return_task_attempt, token)
        loop.bind_task_submission(token, {"task_id": "new"})
        self.assertEqual(loop._recent_outcomes, [])
        loop.note_task_result("mine_ores", False, result=report(state), task_id="new")
        self.assertIsNotNone(loop._mining_return)

    async def test_unknown_legacy_rescue_completion_cannot_affect_active_wait(self):
        state = snapshot()
        loop = self.make_loop(state)
        self.arm(loop, state)
        before = copy.deepcopy(loop._mining_return)
        loop.note_task_result("climb_out", False, "an old task", task_id="old")
        self.assertEqual(loop._mining_return, before)
        self.assertNotIn("climb_out", loop._recent_failures)

    async def test_actual_safe_base_releases_rescue_but_unknown_or_broken_house_does_not(self):
        for condition in ("intact", "unknown", "missing", "unloaded", "historical", "other-world"):
            with self.subTest(condition=condition):
                home = B.record()
                state = snapshot(server=home["server"], dimension=home["dimension"])
                loop = self.make_loop(state)
                loop.remember_home(home)
                self.arm(loop, state)
                state["position"] = {k: home["origin"][k] + 1 for k in ("x", "y", "z")}
                state["home_status"] = {"condition": "intact", "safe": True, "loaded": True, "inside": True}
                if condition in ("unknown", "missing"): state["home_status"]["condition"] = condition
                elif condition == "unloaded": state["home_status"]["loaded"] = False
                elif condition == "historical": state.pop("home_status")
                elif condition == "other-world": state["dimension"] = "the_nether"
                step = await loop._survival_step()
                if condition == "intact": self.assertIsNone(loop._mining_return)
                elif condition == "other-world": self.assertIsNone(loop._mining_return)
                else: self.assertEqual(step["skill"], "climb_out")

    async def test_different_verified_surface_exit_can_finish_return(self):
        state = snapshot()
        loop = self.make_loop(state)
        self.arm(loop, state)
        await loop._survival_step()
        token = loop.register_task_submission("climb_out", state)
        loop.bind_task_submission(token, {"task_id": "rescue"})
        state["position"].update(x=30, y=68)
        state["mining_return_safety"].update(safe=True, underground=False)
        loop.note_task_result("climb_out", True, result=report(state, ok=True), task_id="rescue")
        await loop._survival_step()
        self.assertIsNone(loop._mining_return)

    async def test_failed_rescue_submission_is_counted_and_does_not_clear_first_plan(self):
        state = snapshot()
        loop = self.make_loop(state)
        loop._set_plan([{"skill": "mine_stone", "params": {"count": 8}}])
        self.arm(loop, state)
        for index in range(2):
            self.assertEqual((await loop._survival_step())["skill"], "climb_out")
            token = loop.register_task_submission("climb_out", state)
            loop.bind_task_submission(token, None)
            if index == 0: self.assertEqual(len(loop._plan), 1)
        self.assertIsNone(await loop._survival_step())
        self.assertIsNone(loop._mining_return)

    async def test_old_same_skill_cancellation_cannot_clear_current_rescue(self):
        state = snapshot()
        loop = self.make_loop(state)
        loop._set_plan([{"skill": "mine_stone", "params": {"count": 8}}])
        self.arm(loop, state)
        token = loop.register_task_submission("climb_out", state)
        loop.bind_task_submission(token, {"task_id": "current-rescue"})
        pending = copy.deepcopy(loop._mining_return)
        loop.note_task_cancelled("climb_out", "old cancellation", task_id="old-rescue")
        self.assertEqual(loop._mining_return, pending)
        self.assertEqual(len(loop._plan), 1)
        self.assertIs(loop._return_task_attempt, token)
        loop.note_task_cancelled("climb_out", "current cancellation", task_id="current-rescue")
        self.assertIsNone(loop._mining_return)
        self.assertEqual(loop._plan, [])
        self.assertIsNone(loop._recent_outcomes[-1]["ok"])
        self.assertTrue(loop._recent_outcomes[-1]["cancelled"])

    async def test_early_cancellation_waits_for_rpc_id_and_remains_cancellation(self):
        for cancelled_id in ("current", "old"):
            with self.subTest(cancelled_id=cancelled_id):
                state = snapshot()
                loop = self.make_loop(state)
                loop._set_plan([{"skill": "mine_stone", "params": {"count": 8}}])
                token = loop.register_task_submission("mine_ores", state)
                loop.note_task_cancelled("mine_ores", "owner interrupted", task_id=cancelled_id)
                self.assertEqual(len(loop._plan), 1)
                self.assertEqual(loop._recent_outcomes, [])
                loop.bind_task_submission(token, {"task_id": "current"})
                if cancelled_id == "current":
                    self.assertEqual(loop._plan, [])
                    self.assertTrue(loop._recent_outcomes[-1]["cancelled"])
                    self.assertIsNone(loop._recent_outcomes[-1]["ok"])
                    self.assertNotIn("mine_ores", loop._recent_failures)
                else:
                    self.assertEqual(len(loop._plan), 1)
                    self.assertEqual(loop._recent_outcomes, [])

    async def test_outdoor_work_protects_same_world_home_without_mutating_the_plan(self):
        for condition in ("intact", "missing", "other-world"):
            with self.subTest(condition=condition):
                home = B.record()
                state = snapshot(server=home["server"], dimension=home["dimension"])
                state["home_status"] = {"condition": condition, "safe": False, "loaded": True, "inside": False}
                if condition == "other-world": state["dimension"] = "the_nether"
                loop = self.make_loop(state)
                loop.remember_home(home)
                original = {"count": 8, "radius": 9}
                loop._set_plan([{"skill": "mine_stone", "params": original}])
                payloads, done = [], asyncio.Event()
                async def engine(method, payload=None, **kwargs):
                    if method == "task.list": return {"current": None, "queued": 0}
                    payloads.append(copy.deepcopy(payload))
                    loop.note_task_result("mine_stone", True, task_id="protected-work")
                    done.set(); loop._stopped = True; loop.wake()
                    return {"task_id": "protected-work"}
                loop._call = engine
                await S.SupplyResumeTests.run_until(self, loop, done)
                self.assertEqual(original, {"count": 8, "radius": 9})
                self.assertEqual(loop.history[-1].params, original)
                actual = payloads[0]["params"]
                self.assertEqual({key: actual[key] for key in original}, original)
                if condition == "other-world": self.assertNotIn("protected_home", actual)
                else: self.assertEqual(actual["protected_home"]["origin"], home["origin"])

    async def test_preparation_submission_uses_its_fresh_world_for_return_events(self):
        state = snapshot(inventory={"bread": 4, "cobblestone": 3, "stick": 2, "crafting_table": 1})
        loop = self.make_loop(state)
        loop._return_boundary_state = snapshot(server="stale-cache", dimension="the_nether")
        payloads = []
        async def engine(method, payload=None, **kwargs):
            payloads.append(copy.deepcopy(payload))
            return {"task_id": "fresh-preparation"}
        loop._call = engine
        params = {"tier": "stone", "kinds": ["pickaxe"]}
        await loop._act(L.LifeDecision(activity="准备镐", drive="survival", skill="make_tools", params=params), allow_model_block=True)
        self.assertEqual(loop._return_task_attempt["world"], (state["server"], state["dimension"]))
        loop.note_task_result("make_tools", False, "返程受阻", result=report(state), task_id="fresh-preparation")
        self.assertEqual(loop._mining_return["world"], (state["server"], state["dimension"]))
        self.assertEqual(params, {"tier": "stone", "kinds": ["pickaxe"]})
        self.assertEqual(payloads[0]["skill"], "make_tools")


if __name__ == "__main__":
    unittest.main()
