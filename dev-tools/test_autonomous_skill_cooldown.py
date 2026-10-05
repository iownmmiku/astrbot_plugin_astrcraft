"""Actual skill-tool entry distinguishes autonomous retries from player commands."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import _paths

_paths.require_astrbot("test_autonomous_skill_cooldown")
Tools = _paths.plugin_module("llm_tools_skills").McSkillTools
ActionEvent = _paths.plugin_module("action_agent")._ActionEvent


async def main():
    from test_life_recovery import make_loop
    life, _ = make_loop()
    for _ in range(3):
        life.note_task_result("mine_stone", False, "没有镐")
    engine = SimpleNamespace(run_skill=AsyncMock(return_value={"task_id": "t1"}))
    plugin = SimpleNamespace(_ensure_engine=AsyncMock(return_value=True), connected=True,
                             engine=engine, life=life, _emergency_stopped=False)
    result = await Tools._submit_skill(plugin, ActionEvent(), "mine_stone", {}, "挖石头")
    assert "冷却" in result and engine.run_skill.await_count == 0
    result = await Tools._submit_skill(plugin, ActionEvent(), "chop_tree", {"count": 2}, "砍树")
    assert "任务号" in result and engine.run_skill.await_count == 1
    player = SimpleNamespace(plain_result=lambda text: text)
    result = await Tools._submit_skill(plugin, player, "mine_stone", {}, "挖石头")
    assert "任务号" in result and engine.run_skill.await_count == 2
    life.pause()
    result = await Tools._submit_skill(plugin, ActionEvent(), "chop_tree", {}, "砍树")
    assert "不能自主行动" in result and engine.run_skill.await_count == 2
    print("PASS autonomous failed skill cools down, other skills and player commands remain usable, pause remains authoritative")


if __name__ == "__main__":
    asyncio.run(main())
