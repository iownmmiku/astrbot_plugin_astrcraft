"""Bounded local Paper regression: a real goal pauses twice and mines only its remaining coal.

Uses actual GoalManager, EngineClient, Mineflayer skills and server inventory.
No model is called. Only a random fixture player's inventory and isolated arena
are changed; global time, difficulty and gamerules remain untouched.
"""
from __future__ import annotations

import asyncio
import argparse
import json
import os
import random
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _paths
from lib.rcon import Rcon

_paths.require_astrbot("test_goal_resume_live")
bridge = _paths.plugin_module("bridge_client")
goals = _paths.plugin_module("goals")


async def main(collect_mode=False):
    rcon = Rcon.from_dir(_paths.REPO / ".testserver", int(os.environ.get("MC_RCON_PORT", "25576")))
    username = f"Resume{random.randrange(100000, 999999)}"
    x, z = random.randrange(26000, 27000), random.randrange(26000, 27000)
    area = f"{x-16} {z-16} {x+16} {z+16}"
    loaded = False
    manager = None
    submitted = []
    task_ids = []
    async def command(text):
        return await asyncio.to_thread(rcon.command, text)

    with tempfile.TemporaryDirectory(prefix="astrcraft-goal-resume-") as scratch:
        engine = bridge.EngineClient(bridge.EngineConfig(engine_dir=_paths.ENGINE_DIR,
            log_level="info", extra_env={"MC_DATA_DIR": scratch}))
        async def call(method, params=None, **kwargs):
            if method == "skill.run":
                submitted.append(dict(params))
                assert len(submitted) <= 3, submitted
                print(f"submit: {json.dumps(params, ensure_ascii=False)}", flush=True)
            result = await engine.call(method, params or {}, **kwargs)
            if method == "skill.run":
                task_ids.append(result["task_id"])
            return result
        async def wait_count(target, timeout=65):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                items = (await engine.call("inventory.get"))["items"]
                if items.get("coal", 0) >= target:
                    return items
                if manager and manager.status == goals.GOAL_FAILED:
                    raise AssertionError(manager.describe())
                await asyncio.sleep(0.1)
            raise AssertionError(f"coal did not reach {target}: {await engine.call('task.list')}")
        try:
            await engine.start()
            await engine.call("connect", {"host": "127.0.0.1", "port": int(os.environ.get("MC_PORT", "25566")),
                "version": "1.20.1", "username": username, "spawnProtectionRadius": 0,
                "autoMode": False, "autoEat": False, "autoDefend": False, "autoUnstuck": False,
                "autoTorch": False}, timeout=60)
            await command(f"forceload add {area}")
            loaded = True
            for text in [
                f"fill {x-16} 59 {z-16} {x+16} 63 {z+16} bedrock",
                f"fill {x-16} 64 {z-16} {x+16} 78 {z+16} air",
                f"fill {x+1} 64 {z+1} {x+12} 64 {z+1} coal_ore",
                f"fill {x+1} 64 {z-1} {x+12} 64 {z-1} coal_ore",
                f"tp {username} {x+0.5} 64 {z+0.5}", f"clear {username}",
                f"give {username} stone_pickaxe 1", f"give {username} coal 5",
                f"give {username} bread 4", f"effect give {username} saturation 120 10 true",
                f"effect give {username} resistance 120 4 true",
            ]:
                await command(text)
            await asyncio.sleep(1.5)
            before = (await engine.call("inventory.get"))["items"]
            assert before.get("coal") == 5, before
            state = await engine.call("state.get")
            assert state["mining_return_safety"]["safe"], state
            manager = goals.GoalManager(engine_call=call)
            skill = "collect" if collect_mode else "mine_ores"
            params = {"item": "coal", "count": 13} if collect_mode else {
                "ore": "coal", "count": 8, "radius": 24, "allow_search": False}
            await manager.start(plan=goals.GoalPlan("reach thirteen coal", [
                goals.GoalStep(skill, params, max_attempts=1)]))
            for target in (7, 10):
                reached = await wait_count(target)
                assert reached["coal"] < 13, reached
                original_id = manager.current_task_id
                assert original_id, manager.describe()
                await manager.pause()
                assert manager.status == goals.GOAL_PAUSED
                await asyncio.sleep(0.25)
                stopped = (await engine.call("inventory.get"))["items"]
                await asyncio.sleep(0.25)
                assert (await engine.call("inventory.get"))["items"] == stopped
                print(f"paused: {original_id}, coal={stopped['coal']}", flush=True)
                await manager.resume()
            await asyncio.wait_for(manager._task, timeout=90)
            after = (await engine.call("inventory.get"))["items"]
            final = await engine.call("task.status", {"task_id": task_ids[-1]})
            assert manager.status == goals.GOAL_DONE, manager.describe()
            assert after.get("coal") == 13, after
            assert len(submitted) == 3 and all(p.get("resume_task_id") for p in submitted[1:]), submitted
            assert sum(bool(entry.get("cancelled")) for entry in manager.log) == 2, manager.log
            result = final["result"]
            if collect_mode:
                assert result["collection_ok"] is True and result["have"] == 13, result
            else:
                assert result["gained"] == 8 and result["produced"]["coal"] == 8, result
            assert result["return_status"]["ok"] is True, result
            print(json.dumps({"skill": skill, "goal": manager.status, "coal_before": 5, "coal_after": after["coal"],
                "skill_submissions": len(submitted), "pause_interruptions": 2,
                "final_result": result}, ensure_ascii=False), flush=True)
            print("PASS actual Paper: two manual pauses preserve the eight-coal goal, inventory and return check")
        finally:
            if manager:
                await manager.stop()
            await engine.stop()
            if loaded:
                await command(f"forceload remove {area}")
            rcon.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--collect", action="store_true", help="Test collect's total inventory goal of 13 coal")
    asyncio.run(main(parser.parse_args().collect))
