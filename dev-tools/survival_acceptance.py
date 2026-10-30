"""Offline acceptance rules and cross-seed summaries; never connects to a server."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


@dataclass(frozen=True)
class AcceptanceProfile:
    # An initial baseline, not a claim that these limits prove open-world mastery.
    minimum_observed_seconds: float = 1800
    minimum_coverage_ratio: float = .9
    minimum_day_cycles: int = 2
    maximum_deaths: int = 0
    maximum_hungry_ratio: float = .1
    maximum_starving_seconds: float = 0
    maximum_repeated_failures: int = 5
    maximum_handoff_p95_seconds: float = 20
    minimum_handoff_samples: int = 5
    minimum_food_gain: int = 4
    require_stone_tool: bool = True
    require_verified_shelter: bool = True

    @classmethod
    def parse(cls, data=None):
        if data is None:
            return cls()
        if not isinstance(data, dict):
            raise ValueError("验收配置必须是 JSON 对象")
        defaults = asdict(cls())
        if set(data) - set(defaults):
            raise ValueError("验收配置包含未知字段")
        for key, value in data.items():
            default = defaults[key]
            if type(default) is bool:
                if type(value) is not bool:
                    raise ValueError(f"{key} 必须是布尔值")
            elif not finite(value) or value < 0 or (type(default) is int and type(value) is not int):
                raise ValueError(f"{key} 必须是有限非负{'整数' if type(default) is int else '数'}")
            if key.endswith("ratio") and value > 1:
                raise ValueError(f"{key} 必须在 0 到 1 之间")
            if key in ("minimum_observed_seconds", "minimum_handoff_samples") and value <= 0:
                raise ValueError(f"{key} 必须大于零")
        return cls(**data)

    def snapshot(self):
        return asdict(self)


def seed_fingerprint(reply):
    import re
    match = re.search(r"\bSeed:\s*\[?(-?\d+)\]?\s*$", reply, re.I)
    return hashlib.sha256(match[1].encode()).hexdigest() if match else None


def assess(report, profile=None):
    profile = profile or AcceptanceProfile()
    metrics = report.get("survival") if isinstance(report.get("survival"), dict) else {}
    criteria = []

    def check(name, value, predicate, *, known=True, requirement=None):
        criteria.append({"name": name, "status": ("passed" if predicate(value) else "failed") if known else "inconclusive",
                         "observed": value, "required": requirement})

    check("completed_run", report.get("status"), lambda v: v == "completed",
          known=report.get("status") in ("completed", "failed", "interrupted"), requirement="completed")
    check("real_model", report.get("real_model"), lambda v: v is True and report.get("fixed_answers") is False,
          known=type(report.get("real_model")) is bool and type(report.get("fixed_answers")) is bool, requirement=True)
    check("unmodified_survival", {"rules_modified": report.get("rules_modified"), "supplies_granted": report.get("supplies_granted")},
          lambda v: v["rules_modified"] is False and v["supplies_granted"] is False,
          known=type(report.get("rules_modified")) is bool and type(report.get("supplies_granted")) is bool,
          requirement={"rules_modified": False, "supplies_granted": False})
    calls = report.get("successful_model_requests")
    check("model_exercised", calls, lambda v: v > 0, known=finite(calls), requirement="> 0")
    declared = report.get("natural_world_declared")
    check("natural_world_declared", declared, lambda v: v is True, known=declared is True,
          requirement="operator declares a dedicated naturally generated world")
    check("seed_verified", bool(report.get("seed_fingerprint")), bool,
          known=isinstance(report.get("seed_fingerprint"), str) and len(report["seed_fingerprint"]) == 64,
          requirement="read-only server seed fingerprint")
    rules = report.get("rules") or {}
    check("natural_rules", rules, lambda v: all(v.get(k) is True for k in ("doDaylightCycle", "naturalRegeneration", "doMobSpawning"))
          and v.get("keepInventory") is False and v.get("difficulty") in ("easy", "normal", "hard"),
          known=isinstance(rules, dict) and all(k in rules for k in ("doDaylightCycle", "naturalRegeneration", "doMobSpawning", "keepInventory", "difficulty")),
          requirement="daylight/regen/mobs enabled, drops on death, non-peaceful")
    observed = metrics.get("observed_connected_seconds")
    duration = report.get("requested_minutes")
    check("observation_duration", observed, lambda v: v >= profile.minimum_observed_seconds,
          known=finite(observed), requirement=profile.minimum_observed_seconds)
    ratio = observed / (duration * 60) if finite(observed) and finite(duration) and duration > 0 else None
    check("observation_coverage", ratio, lambda v: v >= profile.minimum_coverage_ratio,
          known=finite(ratio), requirement=profile.minimum_coverage_ratio)
    vitals = metrics.get("observed_vitals_seconds")
    vital_coverage = vitals / observed if finite(vitals) and finite(observed) and observed > 0 else None
    check("vitals_coverage", vital_coverage, lambda v: v >= profile.minimum_coverage_ratio,
          known=finite(vital_coverage), requirement=profile.minimum_coverage_ratio)
    cycles = metrics.get("observed_day_cycles")
    check("day_cycles", cycles, lambda v: v >= profile.minimum_day_cycles,
          known=type(cycles) is int, requirement=profile.minimum_day_cycles)
    interventions = metrics.get("manual_interventions")
    complete_log = report.get("manual_log_complete") is True
    known_interventions = isinstance(interventions, dict) and all(type(v) is int and v >= 0 for v in interventions.values())
    total = sum(interventions.values()) if known_interventions else None
    # A known rescue fails even when other intervention evidence is unavailable.
    check("manual_interventions", total, lambda v: v == 0,
          known=known_interventions and (complete_log or total > 0), requirement=0)
    for name, limit in (("deaths", profile.maximum_deaths),
                        ("starving_seconds_food_zero", profile.maximum_starving_seconds),
                        ("repeated_failures_after_third", profile.maximum_repeated_failures)):
        value = metrics.get(name)
        check(name, value, lambda v, maximum=limit: 0 <= v <= maximum, known=finite(value), requirement=limit)
    hungry = metrics.get("hungry_seconds_food_le_6")
    hungry_ratio = hungry / observed if finite(hungry) and finite(observed) and observed > 0 else None
    check("hungry_ratio", hungry_ratio, lambda v: 0 <= v <= profile.maximum_hungry_ratio,
          known=finite(hungry_ratio), requirement=profile.maximum_hungry_ratio)
    handoffs = metrics.get("skill_handoff_seconds") or {}
    known_handoffs = isinstance(handoffs, dict) and finite(handoffs.get("p95")) and finite(handoffs.get("samples")) and handoffs["samples"] >= profile.minimum_handoff_samples
    check("handoff_p95_seconds", handoffs.get("p95") if isinstance(handoffs, dict) else None,
          lambda v: 0 <= v <= profile.maximum_handoff_p95_seconds, known=known_handoffs,
          requirement={"maximum": profile.maximum_handoff_p95_seconds, "minimum_samples": profile.minimum_handoff_samples})
    milestones = metrics.get("milestones") or {}
    if not isinstance(milestones, dict):
        milestones = {}
    if profile.require_stone_tool:
        value = milestones.get("stone_or_better_pickaxe")
        check("stone_tool", value, lambda v: v is True, known=type(value) is bool, requirement=True)
    if profile.require_verified_shelter:
        value = milestones.get("verified_shelter")
        check("verified_shelter", value, lambda v: v is True,
              known=type(value) is bool and milestones.get("shelter_observation_complete") is True, requirement=True)
    gain = milestones.get("carried_food_net_gain")
    check("carried_food_gain", gain, lambda v: v >= profile.minimum_food_gain,
          known=finite(gain) and milestones.get("final_inventory_observed") is True, requirement=profile.minimum_food_gain)
    # Missing/short observations are inconclusive, not a false failure of the bot.
    incomplete_names = {"observation_duration", "observation_coverage", "vitals_coverage", "day_cycles"}
    sufficient = all(item["status"] == "passed" for item in criteria if item["name"] in incomplete_names)
    for item in criteria:
        if item["status"] == "failed" and (item["name"] in incomplete_names or
                not sufficient and item["name"] in {"stone_tool", "verified_shelter", "carried_food_gain", "handoff_p95_seconds"}):
            item["status"] = "inconclusive"
    statuses = {item["status"] for item in criteria}
    status = "failed" if "failed" in statuses else "inconclusive" if "inconclusive" in statuses else "passed"
    return {"status": status, "profile": profile.snapshot(), "criteria": criteria,
            "interpretation": "有界基础生存验收；住所/工具为实物里程碑，食物增长仅计随身普通食物，不代表基地总库存或农业已可持续"}


def summarize_runs(reports, *, minimum_seeds=3, minimum_runs_per_seed=2, profile=None):
    if type(minimum_seeds) is not int or type(minimum_runs_per_seed) is not int or min(minimum_seeds, minimum_runs_per_seed) < 1:
        raise ValueError("种子数与每种子轮数必须为正整数")
    rows, seen, duplicates = [], set(), 0
    for report in reports:
        identifier = report.get("run_id")
        if not isinstance(identifier, str) or not identifier or identifier in seen:
            duplicates += 1
            continue
        seen.add(identifier)
        assessment = assess(report, profile)
        rows.append({"run_id": identifier, "seed": report.get("seed_fingerprint"),
                     "status": assessment["status"], "assessment": assessment,
                     "model": report.get("model_fingerprint"), "build": report.get("build_fingerprint")})
    groups = {}
    for row in rows:
        if isinstance(row["seed"], str) and len(row["seed"]) == 64:
            groups.setdefault(row["seed"], []).append(row)
    comparable = bool(rows) and all(row["model"] and row["build"] for row in rows) and len({(row["model"], row["build"]) for row in rows}) == 1
    enough = len(groups) >= minimum_seeds and all(len(group) >= minimum_runs_per_seed for group in groups.values())
    statuses = {row["status"] for row in rows}
    status = "failed" if "failed" in statuses else ("passed" if statuses == {"passed"} and enough and comparable and not duplicates else "inconclusive")
    return {"status": status, "unique_runs": len(rows), "unique_seeds": len(groups), "duplicate_or_missing_run_ids": duplicates,
            "minimum_seeds": minimum_seeds, "minimum_runs_per_seed": minimum_runs_per_seed,
            "enough_repetitions": enough, "same_model_and_build": comparable,
            "runs_per_seed": {key: len(value) for key, value in groups.items()}, "runs": rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reports", nargs="+", type=Path)
    parser.add_argument("--profile", type=Path, help="验收阈值 JSON；省略使用基础档")
    parser.add_argument("--minimum-seeds", type=int, default=3)
    parser.add_argument("--runs-per-seed", type=int, default=2)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.output.resolve() in {path.resolve() for path in args.reports}:
            raise ValueError("汇总输出不能覆盖输入报告")
        profile = AcceptanceProfile.parse(json.loads(args.profile.read_text(encoding="utf-8"))) if args.profile else AcceptanceProfile()
        reports = [json.loads(path.read_text(encoding="utf-8")) for path in args.reports]
        if not all(isinstance(item, dict) for item in reports):
            raise ValueError("每份报告必须是 JSON 对象")
        summary = summarize_runs(reports, minimum_seeds=args.minimum_seeds, minimum_runs_per_seed=args.runs_per_seed, profile=profile)
    except (OSError, ValueError, TypeError) as exc:
        parser.error(str(exc))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(summary, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    print(f"验收 {summary['status']}；{summary['unique_runs']} 轮 / {summary['unique_seeds']} 个种子")
    return 0 if summary["status"] == "passed" else 1 if summary["status"] == "failed" else 2


if __name__ == "__main__":
    raise SystemExit(main())
