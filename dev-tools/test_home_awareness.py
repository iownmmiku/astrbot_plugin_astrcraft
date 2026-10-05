"""Actual advisor, LifeLoop persistence and plugin result/snapshot integration; no game server."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_life_recovery import make_loop
from test_plugin_control import plugin
from astrcraft_plugin import advisor


def home(server="test:25565", dimension="overworld"):
    return {"server": server, "dimension": dimension, "origin": {"x": 0, "y": 1, "z": 0},
            "size": 5, "inner": 3, "wall_height": 2, "door_position": {"x": 2, "y": 1, "z": 0},
            "complete": True, "has_roof": True, "has_door": True,
            "furnished": {"bed": True, "bed_position": {"x": 2, "y": 1, "z": 2}}, "verified_at": 10}


class HomeTests(unittest.IsolatedAsyncioTestCase):
    def test_full_inventory_uses_current_world_home_chest(self):
        record = home()
        status = {"condition": "intact", "safe": False, "distance": 50, "furniture": {"chest": True}}
        advice = advisor.advise({"iron_pickaxe": 1, "bread": 4}, inventory_slots_used=34,
                                home=record, home_status=status)
        self.assertEqual(advice.skill, "store_items")
        self.assertEqual(advice.priority, "maintenance")
        self.assertEqual(advice.params["home"]["origin"], record["origin"])
        self.assertEqual(advice.params["home"]["server"], record["server"])
        self.assertTrue(advice.params["resume_work"])

    def test_unloaded_house_uses_remembered_chest_but_loaded_absence_overrides_it(self):
        record = home(); record["furnished"]["chest"] = True
        status = {"condition": "unknown", "distance": 60, "furniture": {"chest": False}}
        advice = advisor.advise({"bread": 4}, inventory_slots_used=34, home=record, home_status=status)
        self.assertIn("home", advice.params, "unknown chunks must not erase useful base furniture memory")
        status["condition"] = "intact"
        advice = advisor.advise({"bread": 4}, inventory_slots_used=34, home=record, home_status=status)
        self.assertNotIn("home", advice.params, "actual absent chest overrides historical furniture")

    def test_invalid_or_repeatedly_failed_home_storage_does_not_force_another_trip(self):
        for condition, distance, failures in (
            ("missing", 30, {}), ("other_world", 30, {}), ("intact", 129, {}),
            ("intact", None, {}), ("intact", float("nan"), {}), ("intact", 30, {"store_items": 2}),
        ):
            advice = advisor.advise({"bread": 4}, inventory_slots_used=34, home=home(),
                home_status={"condition": condition, "distance": distance, "furniture": {"chest": True}},
                recent_failures=failures)
            self.assertEqual(advice.skill, "store_items")
            self.assertNotIn("home", advice.params)

    def test_home_storage_cannot_override_food_or_critical_recovery(self):
        status = {"condition": "intact", "distance": 30, "furniture": {"chest": True}}
        for health, food, expected in ((20, 4, "eat"), (4, 20, "recover")):
            advice = advisor.advise({"bread": 4}, health=health, food=food, inventory_slots_used=34,
                                    home=home(), home_status=status)
            self.assertEqual(advice.skill, expected)
            self.assertEqual(advice.priority, "survival")

    async def test_storage_home_hint_preserves_original_plan_and_is_passed_to_engine(self):
        loop, _ = make_loop(); record = home(); loop.remember_home(record)
        async def state():
            return {"inventory": {"bread": 4}, "food": 20, "health": 20, "inventory_slots_used": 34,
                "server": record["server"], "dimension": record["dimension"],
                "home_status": {"condition": "intact", "distance": 30, "furniture": {"chest": True}}}
        loop._state_provider = state
        loop._set_plan([{"skill": "mine_stone", "params": {"count": 8}}])
        submitted = []
        async def call(method, params=None, **kwargs):
            submitted.append((method, params)); return {"task_id": "home-storage"}
        loop._call = call
        step = await loop._survival_step()
        self.assertEqual(step["skill"], "store_items")
        await loop._act(loop._decision_from_step(step), allow_model_block=True)
        self.assertEqual(submitted[-1][1]["params"]["home"]["origin"], record["origin"])
        self.assertTrue(submitted[-1][1]["params"]["resume_work"])
        self.assertEqual(loop._plan[0]["skill"], "mine_stone")

    def test_completed_home_survives_restart_with_world_and_furniture(self):
        loop, _ = make_loop()
        with tempfile.TemporaryDirectory(prefix="astrcraft-home-") as folder:
            loop._data_dir = Path(folder)
            self.assertTrue(loop.remember_home(home()))
            restarted, _ = make_loop()
            restarted._data_dir = Path(folder)
            restarted._load_state()
            record = restarted.home_for_world({"server": "test:25565", "dimension": "minecraft:overworld"})
            self.assertEqual(record["origin"], {"x": 0, "y": 1, "z": 0})
            self.assertTrue(record["furnished"]["bed"])
            self.assertFalse(restarted._has_shelter, "historical ownership cannot prove current safety")

    def test_incomplete_report_and_old_boolean_do_not_create_safe_home(self):
        loop, _ = make_loop()
        report = home(); report["complete"] = False
        self.assertFalse(loop.remember_home(report))
        report = home(); report.pop("server")
        self.assertFalse(loop.remember_home(report))
        with tempfile.TemporaryDirectory(prefix="astrcraft-home-") as folder:
            loop._data_dir = Path(folder)
            (loop._data_dir / "life.json").write_text(json.dumps({"has_shelter": True}), encoding="utf-8")
            loop._load_state()
            self.assertFalse(loop._has_shelter)
            self.assertEqual(loop._homes, [])

    def test_other_world_has_no_matching_home(self):
        loop, _ = make_loop(); loop.remember_home(home())
        self.assertIsNone(loop.home_for_world({"server": "other:25565", "dimension": "overworld"}))
        self.assertIsNone(loop.home_for_world({"server": "test:25565", "dimension": "the_nether"}))
        self.assertIsNone(loop.home_for_world({}))

    def test_home_status_preserves_unknown_location_and_marks_real_damage(self):
        loop, _ = make_loop(); loop.remember_home(home())
        loop.note_home_status(home(), {"condition": "unknown", "loaded": False})
        self.assertEqual(loop._homes[0]["condition"], "unknown")
        self.assertTrue(loop._homes[0]["furnished"]["bed"])
        loop.note_home_status(home(), {"condition": "missing", "loaded": True, "furniture": {"bed": False}})
        self.assertEqual(loop._homes[0]["condition"], "missing")
        self.assertFalse(loop._homes[0]["furnished"]["bed"])

    def test_historical_damage_cannot_be_overridden_by_unknown_or_missing_inspection(self):
        record = home(); record["condition"] = "missing"; record["furnished"]["chest"] = True
        for condition in ("unknown", None):
            status = {"distance": 30, "safe": False, "furniture": {"chest": True}}
            if condition is not None:
                status["condition"] = condition
            with self.subTest(condition=condition):
                advice = advisor.advise({"bread": 4}, home=record, home_status=status, inventory_slots_used=34)
                self.assertEqual(advice.skill, "store_items")
                self.assertNotIn("home", advice.params)
                self.assertNotIn("resume_work", advice.params)
                advice = advisor.advise({"bread": 4}, home=record, home_status=status, is_night=True)
                self.assertEqual(advice.skill, "build_shelter")

    async def test_damage_then_unloaded_status_survives_restart_without_home_routing(self):
        loop, _ = make_loop(); record = home(); record["furnished"]["chest"] = True
        status = {"condition": "unknown", "safe": False, "loaded": False, "distance": 30,
                  "furniture": {"bed": False, "chest": False}}
        state = {"inventory": {"bread": 4}, "health": 20, "food": 20, "inventory_slots_used": 34,
                 "server": record["server"], "dimension": record["dimension"], "home_status": status}
        with tempfile.TemporaryDirectory(prefix="astrcraft-home-damage-") as folder:
            loop._data_dir = Path(folder)
            self.assertTrue(loop.remember_home(record))
            loop.note_home_status(record, {"condition": "missing", "loaded": True, "furniture": record["furnished"]})
            loop.note_home_status(record, status)
            restarted, _ = make_loop(); restarted._data_dir = Path(folder); restarted._load_state()
            for current in (loop, restarted):
                saved = current.home_for_world(state)
                self.assertEqual(saved["condition"], "missing")
                self.assertEqual(saved["origin"], record["origin"])
                self.assertEqual(saved["furnished"], record["furnished"])
                advice = await current._build_advice(state)
                self.assertEqual(advice.skill, "store_items")
                self.assertNotIn("home", advice.params)
                advice = await current._build_advice({**state, "is_night": True})
                self.assertEqual(advice.skill, "build_shelter")

    async def test_loaded_intact_inspection_restores_a_previously_damaged_home(self):
        loop, _ = make_loop(); record = home(); record["furnished"]["chest"] = True
        loop.remember_home(record)
        loop.note_home_status(record, {"condition": "missing", "loaded": True, "furniture": record["furnished"]})
        status = {"condition": "intact", "safe": False, "loaded": True, "distance": 30,
                  "furniture": record["furnished"]}
        state = {"inventory": {"bread": 4}, "health": 20, "food": 20, "inventory_slots_used": 34,
                 "server": record["server"], "dimension": record["dimension"], "home_status": status}
        advice = await loop._build_advice(state)
        self.assertEqual(advice.params["home"]["origin"], record["origin"])
        self.assertTrue(advice.params["resume_work"])
        loop.note_home_status(record, status)
        self.assertEqual(loop.home_for_world(state)["condition"], "intact")
        advice = await loop._build_advice({**state, "is_night": True})
        self.assertEqual(advice.skill, "return_home")
        loop.note_home_status(record, {"condition": "unknown", "loaded": False})
        self.assertEqual(loop.home_for_world(state)["condition"], "unknown")
        advice = await loop._build_advice({**state, "home_status": {**status, "condition": "unknown", "loaded": False}})
        self.assertTrue(advice.params["resume_work"])

    def test_damage_and_unloaded_updates_are_isolated_by_home_origin_and_world(self):
        loop, _ = make_loop(); record = home(); record["furnished"]["chest"] = True
        elsewhere = home(); elsewhere["origin"] = {"x": 32, "y": 1, "z": 0}
        records = [record, elsewhere, home(server="other:25565"), home(dimension="the_nether")]
        for current in records:
            self.assertTrue(loop.remember_home(current))
        loop.note_home_status({**record, "dimension": "minecraft:overworld"},
                              {"condition": "missing", "loaded": True, "furniture": record["furnished"]})
        loop.note_home_status(record, {"condition": "unknown", "loaded": False})
        for saved in loop._homes:
            same_home = (saved["server"] == record["server"] and saved["dimension"] == record["dimension"]
                         and saved["origin"] == record["origin"])
            self.assertEqual(saved["condition"], "missing" if same_home else "intact")
        self.assertEqual(len(loop._homes), 4)

    async def test_night_away_from_base_recommends_return_and_keeps_world_in_params(self):
        loop, _ = make_loop(); loop.remember_home(home())
        advice = await loop._build_advice({"inventory": {"iron_pickaxe": 1, "bread": 4}, "food": 20, "health": 20,
            "server": "test:25565", "dimension": "overworld", "is_night": True, "has_shelter": False,
            "home_status": {"condition": "unknown", "safe": False, "distance": 50}})
        self.assertEqual(advice.skill, "return_home")
        self.assertEqual(advice.priority, "survival")
        self.assertEqual(advice.params["home"]["server"], "test:25565")

    def test_sleep_requires_real_safe_home_and_bed(self):
        advice = advisor.advise({"iron_pickaxe": 1}, home=home(), is_night=True,
            home_status={"condition": "intact", "safe": True, "furniture": {"bed": True}})
        self.assertEqual(advice.skill, "sleep")
        advice = advisor.advise({"iron_pickaxe": 1}, home=home(), is_night=True,
            home_status={"condition": "missing", "safe": False, "furniture": {"bed": True}})
        self.assertEqual(advice.skill, "build_shelter")
        self.assertEqual(advice.params["size"], 2)

    def test_failed_or_far_home_route_chooses_limited_temporary_shelter(self):
        for state, failures in (({"distance": 300}, {}), ({"distance": 50}, {"return_home": 2})):
            advice = advisor.advise({"iron_pickaxe": 1}, home=home(), home_status=state,
                                    recent_failures=failures, is_night=True)
            self.assertEqual(advice.skill, "build_shelter")
            self.assertEqual(advice.params, {"size": 2})

    def test_night_in_safe_home_without_bed_does_not_resume_outdoor_mining(self):
        advice = advisor.advise({"iron_pickaxe": 1}, home=home(), is_night=True,
            home_status={"condition": "intact", "safe": True, "furniture": {"bed": False}})
        self.assertEqual(advice.skill, "return_home")
        self.assertEqual(advice.priority, "survival")
        self.assertEqual(advice.params["wait_seconds"], 20)

    def test_night_home_routing_does_not_override_critical_health_recovery(self):
        advice = advisor.advise({"iron_pickaxe": 1}, home=home(), is_night=True,
            health=4, food=20, home_status={"condition": "unknown", "safe": False, "distance": 50})
        self.assertEqual(advice.skill, "recover")
        self.assertEqual(advice.priority, "survival")

    async def test_plugin_records_only_successful_world_verified_build(self):
        p = plugin(); loop, _ = make_loop(); p.life = loop; p.config["announce_task_done"] = False
        for status, complete in (("failed", True), ("done", False)):
            report = home(); report["complete"] = complete
            await p._on_task_finished({"kind": "skill", "name": "建庇护所", "meta": {"skill": "build_shelter"},
                "status": status, "result": {"ok": status == "done", "shelter": report}})
            self.assertEqual(loop._homes, [])
        await p._on_task_finished({"kind": "skill", "name": "建庇护所", "meta": {"skill": "build_shelter"},
            "status": "done", "result": {"ok": True, "shelter": home()}})
        self.assertEqual(len(loop._homes), 1)

    async def test_plugin_records_storage_damage_and_outside_success_without_claiming_shelter(self):
        p = plugin(); loop, _ = make_loop(); p.life = loop; p.config["announce_task_done"] = False
        record = home(); record["furnished"]["chest"] = True; loop.remember_home(record)
        for outcome, condition in (("failed", "missing"), ("done", "intact")):
            with self.subTest(outcome=outcome):
                await p._on_task_finished({"kind": "skill", "name": "存东西", "meta": {"skill": "store_items"},
                    "status": outcome, "result": {"ok": outcome == "done", "home": record,
                        "consumed": {"cobblestone": 16},
                        "home_status": {"condition": condition, "loaded": True, "safe": False, "inside": False,
                                        "furniture": record["furnished"]}}})
                saved = loop.home_for_world({"server": record["server"], "dimension": record["dimension"]})
                self.assertEqual(saved["condition"], condition)
                self.assertEqual(saved["furnished"], record["furnished"])
                self.assertFalse(loop._has_shelter, "storage outside a home cannot prove the body is sheltered")

    async def test_snapshot_rechecks_real_base_instead_of_historical_flag(self):
        p = plugin(); loop, _ = make_loop(); p.life = loop; loop.remember_home(home()); loop._has_shelter = True
        inspected = []
        async def call(method, params=None, **kwargs):
            if method == "state.get":
                return {"server": "test:25565", "dimension": "overworld", "position": {"x": 50, "y": 1, "z": 0},
                        "health": 20, "food": 20, "time_of_day": 14000}
            if method == "inventory.get": return {"items": {"bread": 4}}
            if method == "home.inspect":
                inspected.append(params["home"])
                return {"condition": "intact", "safe": False, "inside": False, "loaded": True, "distance": 50}
            return {"ok": True}
        p.engine.call = call
        state = await p._life_state_snapshot()
        self.assertFalse(state["has_shelter"])
        self.assertTrue(state["is_night"])
        self.assertEqual(len(inspected), 1)
        self.assertEqual((await loop._build_advice(state)).skill, "return_home")


if __name__ == "__main__":
    unittest.main(verbosity=2)
