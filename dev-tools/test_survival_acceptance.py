"""Acceptance and multi-seed aggregation fixtures; no server/model access."""
from __future__ import annotations

import copy
import json
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from survival_acceptance import AcceptanceProfile, assess, seed_fingerprint, summarize_runs
from survival_eval import InterventionLog, SurvivalMetrics, build_fingerprint


def report(run_id="one", seed="1"):
    return {"run_id": run_id, "status": "completed", "real_model": True, "fixed_answers": False,
        "rules_modified": False, "supplies_granted": False,
        "successful_model_requests": 4, "requested_minutes": 60, "manual_log_complete": True,
        "natural_world_declared": True, "seed_fingerprint": seed_fingerprint(f"Seed: [{seed}]"),
        "model_fingerprint": "model", "build_fingerprint": "build",
        "rules": {"doDaylightCycle": True, "naturalRegeneration": True, "doMobSpawning": True,
                  "keepInventory": False, "difficulty": "normal"},
        "survival": {"observed_connected_seconds": 3500, "observed_vitals_seconds": 3500,
            "observed_day_cycles": 2, "manual_interventions": {}, "deaths": 0,
            "starving_seconds_food_zero": 0, "hungry_seconds_food_le_6": 100,
            "repeated_failures_after_third": 1, "skill_handoff_seconds": {"samples": 10, "p95": 2},
            "milestones": {"stone_or_better_pickaxe": True, "verified_shelter": True,
                "shelter_observation_complete": True, "carried_food_net_gain": 5,
                "final_inventory_observed": True}}}


def body(tod=6000, food=20, dimension="overworld", connected=True):
    return {"connected": connected, "ready": connected, "food": food, "health": 20,
        "server": "fixture", "dimension": dimension, "time_of_day": tod, "position": {"x": 0, "y": 64, "z": 0}}


class AcceptanceTests(unittest.TestCase):
    def test_complete_run_can_pass_but_completed_alone_cannot(self):
        self.assertEqual(assess(report())["status"], "passed")
        self.assertEqual(assess({"status": "completed"})["status"], "inconclusive")
        failed = report()
        failed["survival"]["deaths"] = 1
        self.assertEqual(assess(failed)["status"], "failed")
        altered = report()
        altered["supplies_granted"] = True
        self.assertEqual(assess(altered)["status"], "failed")

    def test_short_or_missing_observations_and_unverified_world_are_inconclusive(self):
        for field, value in (("observed_connected_seconds", 500), ("observed_vitals_seconds", 5),
                             ("observed_day_cycles", 1), ("skill_handoff_seconds", {"samples": 0, "p95": None})):
            with self.subTest(field=field):
                item = report()
                item["survival"][field] = value
                item["survival"]["hungry_seconds_food_le_6"] = 0
                self.assertEqual(assess(item)["status"], "inconclusive")
        for field, value in (("seed_fingerprint", None), ("manual_log_complete", False), ("natural_world_declared", False)):
            item = report()
            item[field] = value
            self.assertEqual(assess(item)["status"], "inconclusive")
        item = report()
        item["survival"].update(observed_connected_seconds=10, hungry_seconds_food_le_6=0)
        item["survival"]["milestones"].update(stone_or_better_pickaxe=False, verified_shelter=False, carried_food_net_gain=0)
        self.assertEqual(assess(item)["status"], "inconclusive", "a short sample cannot fail long-term growth milestones")

    def test_low_food_or_unmet_progress_and_real_rescue_fail(self):
        for milestone, value in (("stone_or_better_pickaxe", False), ("verified_shelter", False), ("carried_food_net_gain", 0)):
            item = report()
            item["survival"]["milestones"][milestone] = value
            self.assertEqual(assess(item)["status"], "failed")
        item = report()
        item["manual_log_complete"] = False
        item["survival"]["manual_interventions"] = {"rescue": 1}
        self.assertEqual(assess(item)["status"], "failed")

    def test_unknown_home_and_stale_final_inventory_not_success(self):
        for field in ("shelter_observation_complete", "final_inventory_observed"):
            item = report()
            item["survival"]["milestones"][field] = False
            self.assertEqual(assess(item)["status"], "inconclusive")

    def test_thresholds_validated_and_snapshot_reproducible(self):
        for data in ([], {"typo": 1}, {"maximum_deaths": True}, {"minimum_food_gain": .5},
                     {"maximum_hungry_ratio": 1.5}, {"minimum_observed_seconds": 0},
                     {"minimum_handoff_samples": 0}, {"require_stone_tool": 0},
                     {"maximum_starving_seconds": float("nan")}):
            with self.subTest(data=data), self.assertRaises(ValueError):
                AcceptanceProfile.parse(data)
        profile = AcceptanceProfile.parse({"minimum_food_gain": 6})
        result = assess(report(), profile)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["profile"]["minimum_food_gain"], 6)
        json.dumps(result, allow_nan=False)

    def test_seed_identity_is_server_derived_and_never_raw(self):
        expected = seed_fingerprint("Seed: [-1234]")
        self.assertEqual(len(expected), 64)
        self.assertNotEqual(expected, "-1234")
        self.assertEqual(seed_fingerprint("Seed: -1234"), expected)
        self.assertIsNone(seed_fingerprint("seed unavailable on port 25566"))

    def test_cross_seed_requires_independent_repetitions_and_same_build(self):
        items = [report(f"{seed}-{run}", str(seed)) for seed in range(3) for run in range(2)]
        self.assertEqual(summarize_runs(items)["status"], "passed")
        self.assertEqual(summarize_runs(items[:2])["status"], "inconclusive")
        self.assertEqual(summarize_runs(items + [copy.deepcopy(items[0])])["status"], "inconclusive")
        items[-1]["build_fingerprint"] = "other-build"
        self.assertEqual(summarize_runs(items)["status"], "inconclusive")
        items[-1]["survival"]["deaths"] = 1
        self.assertEqual(summarize_runs(items)["status"], "failed")

    def test_summary_recalculates_instead_of_trusting_pasted_pass(self):
        item = report()
        item["acceptance"] = {"status": "passed"}
        item["survival"]["deaths"] = 2
        self.assertEqual(summarize_runs([item], minimum_seeds=1, minimum_runs_per_seed=1)["status"], "failed")

    def test_cli_aggregates_existing_reports_without_network(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            inputs = []
            for seed in range(3):
                for run in range(2):
                    path = root / f"{seed}-{run}.json"
                    path.write_text(json.dumps(report(f"{seed}-{run}", str(seed))), encoding="utf-8")
                    inputs.append(str(path))
            output = root / "summary.json"
            command = [sys.executable, str(Path(__file__).with_name("survival_acceptance.py")), *inputs, "--output", str(output)]
            result = subprocess.run(command, capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            summary = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(summary["unique_seeds"], 3)
            self.assertEqual(summary["unique_runs"], 6)
            # A bad invocation must not overwrite its source evidence.
            original = Path(inputs[0]).read_bytes()
            command[-1] = inputs[0]
            self.assertNotEqual(subprocess.run(command, capture_output=True, timeout=15).returncode, 0)
            self.assertEqual(Path(inputs[0]).read_bytes(), original)


class EvidenceTests(unittest.TestCase):
    def test_build_fingerprint_includes_shared_budget_and_farming(self):
        import _paths
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            engine = root / "engine"
            (engine / "skills").mkdir(parents=True)
            budget = engine / "survival_budget.json"
            farm = engine / "skills" / "farming.js"
            budget.write_text('{"food":4}', encoding="utf-8")
            farm.write_text("// fixture farm", encoding="utf-8")
            with patch.object(_paths, "REPO", root), patch.object(_paths, "ENGINE_DIR", engine):
                original = build_fingerprint()
                budget.write_text('{"food":8}', encoding="utf-8")
                self.assertNotEqual(build_fingerprint(), original)
                second = build_fingerprint()
                farm.write_text("// changed fixture farm", encoding="utf-8")
                self.assertNotEqual(build_fingerprint(), second)

    def test_day_cycles_require_covered_overworld_day_night_day(self):
        metrics = SurvivalMetrics()
        for at, tod in enumerate((6000, 14000, 1000, 14000, 1000)):
            metrics.sample(at * 5, body(tod), {})
        self.assertEqual(metrics.observed_day_cycles, 2)
        for dim in ("the_nether", "the_end", ""):
            metrics = SurvivalMetrics()
            for at, tod in enumerate((6000, 14000, 1000)):
                metrics.sample(at * 5, body(tod, dimension=dim), {})
            self.assertEqual(metrics.observed_day_cycles, 0)
        metrics = SurvivalMetrics()
        metrics.sample(0, body(6000), {})
        metrics.sample(5, body(14000), {})
        metrics.sample(50, body(1000), {})
        self.assertEqual(metrics.observed_day_cycles, 0)

    def test_milestones_use_inventory_and_loaded_safe_house_not_task_success(self):
        metrics = SurvivalMetrics()
        metrics.sample(0, body(), {})
        metrics.task_finished({"task_id": "house", "kind": "skill", "status": "done", "result": {"ok": True}}, 1)
        metrics.sample(5, body(), {"golden_pickaxe": 1, "golden_apple": 8}, home_status={"safe": True, "loaded": False, "condition": "unknown"})
        metrics.finish(6)
        m = metrics.summary()["milestones"]
        self.assertFalse(m["stone_or_better_pickaxe"])
        self.assertFalse(m["verified_shelter"])
        self.assertEqual(m["carried_food_net_gain"], 0)
        metrics.sample(10, body(), {"stone_pickaxe": 1, "bread": 5}, home_status={"safe": True, "loaded": True, "condition": "intact"})
        metrics.finish(11)
        m = metrics.summary()["milestones"]
        self.assertTrue(m["stone_or_better_pickaxe"])
        self.assertTrue(m["verified_shelter"])
        self.assertTrue(m["final_inventory_observed"])
        self.assertEqual(m["carried_food_net_gain"], 5)
        metrics.finish(100)
        self.assertFalse(metrics.summary()["milestones"]["final_inventory_observed"])

    def test_missing_vitals_or_failed_read_cannot_hide_hunger(self):
        metrics = SurvivalMetrics()
        metrics.sample(0, body(food=None), {})
        metrics.sample(5, body(food=None), {})
        self.assertEqual(metrics.connected_seconds, 5)
        self.assertEqual(metrics.vitals_seconds, 0)
        metrics.sample_failed()
        metrics.sample(10, body(food=20), {})
        self.assertEqual(metrics.connected_seconds, 5)
        self.assertEqual(metrics.read_errors, 1)

    def test_manual_log_missing_rewritten_or_invalid_is_not_clean(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "manual.jsonl"
            metrics = SurvivalMetrics()
            log = InterventionLog(path, metrics)
            log.poll()
            self.assertFalse(log.complete)
            path.write_text("", encoding="utf-8")
            log = InterventionLog(path, metrics)
            log.poll()
            self.assertTrue(log.complete)
            path.write_text('{"kind":"rescue", "text":"private"}\n', encoding="utf-8")
            log.poll()
            log.poll()
            self.assertEqual(metrics.manual_interventions["rescue"], 1)
            self.assertNotIn("private", json.dumps(metrics.summary()))
            path.write_text("", encoding="utf-8")
            log.poll()
            self.assertFalse(log.complete)
            self.assertEqual(metrics.manual_interventions["changed_log"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
