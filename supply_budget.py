"""Shared, bounded trip targets; these are reserves, not hunger estimates."""
import json
from pathlib import Path

BUDGETS = json.loads((Path(__file__).with_name("engine") / "survival_budget.json").read_text(encoding="utf-8"))
EMERGENCY_FOOD = {"golden_apple", "enchanted_golden_apple"}


def work_profile(skill: str | None, params: dict | None = None) -> str:
    params = params or {}
    if skill in ("mine_ores", "mine_stone", "dig_path"):
        return "mining"
    if skill in ("explore_nearby", "recover_drops", "pave", "hunt"):
        return "travel"
    if skill == "collect" and params.get("allow_search") is not False:
        return "travel"
    return "nearby"


def budget_for(profile: str = "nearby") -> dict:
    return dict(BUDGETS.get(profile, BUDGETS["nearby"]))
