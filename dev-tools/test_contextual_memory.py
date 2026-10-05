"""Relevant experience selection uses the real memory store and prompt mixin."""
from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import _paths

_paths.require_astrbot("test_contextual_memory")
MemoryStore = _paths.plugin_module("memory").MemoryStore
PromptRenderMixin = _paths.plugin_module("life_render").PromptRenderMixin


def main():
    with tempfile.TemporaryDirectory() as folder:
        memory = MemoryStore(Path(folder))
        memory.remember("place", "安全粮仓 (10,64,10)，箱内有面包", tags=["粮食"],
                        context={"server": "A", "dimension": "overworld"})
        memory.remember("death", "上次掉进熔岩，装备全丢了", weight=9)
        memory.remember("place", "另一服务器的粮仓 (900,64,900)", weight=9,
                        context={"server": "B", "dimension": "overworld"})
        memory.remember("place", "下界粮仓 (300,70,300)", weight=9,
                        context={"server": "A", "dimension": "the_nether"})
        obj = SimpleNamespace(memory=memory, _intention="", _last_advice=SimpleNamespace(
            skill="cook_food", why="先准备食物", params={"count": 4}))
        prompt = PromptRenderMixin._contextual_memories(obj, {
            "server": "A", "dimension": "overworld", "food": 0, "health": 20})
        assert "安全粮仓 (10,64,10)" in prompt
        assert "装备全丢了" not in prompt
        assert "900" not in prompt and "300" not in prompt
        assert memory.recall("", relevant_only=True) == []
        assert len(memory.recall("粮仓", limit=1, relevant_only=True)) == 1
        assert len(memory.recall("", limit=5)) == 4, "general browsing keeps existing behavior"
        obj._last_advice = SimpleNamespace(skill="make_tools", why="做石镐", params={})
        assert PromptRenderMixin._contextual_memories(obj, {"health": 20, "food": 20}) == ""
        print("PASS contextual memories preserve coordinates, exclude irrelevant trauma and other worlds")

        async def prompt_path():
            from test_life_recovery import make_loop
            loop, _ = make_loop()
            loop.memory = memory
            async def snapshot():
                return {"server": "A", "dimension": "overworld", "food": 0, "health": 20,
                        "inventory": {"wheat": 9, "oak_log": 2}}
            loop._state_provider = snapshot
            captured = {}
            class Agent:
                last_timing = {"provider_seconds": 0.08, "tool_seconds": 0.30,
                               "provider_calls": 1, "tool_calls": 1}
                async def act(self, **kwargs):
                    captured.update(kwargs)
                    return "", ["mc_status"]
            loop.action_agent = Agent()
            log_lines = []
            module = _paths.plugin_module("life")
            with patch.object(module.logger, "info", side_effect=lambda msg, *args: log_lines.append(msg % args if args else msg)):
                assert await loop._act_via_agent()
            assert "安全粮仓 (10,64,10)" in captured["prompt"]
            assert "装备全丢了" not in captured["prompt"]
            timing_log = next(line for line in log_lines if "决策耗时" in line)
            assert "模型 80ms/1 轮" in timing_log
            assert "工具执行 300ms/1 次" in timing_log
            print("PASS real LifeLoop action prompt injects memories and separates model/tool timing")
        asyncio.run(prompt_path())


if __name__ == "__main__":
    main()
