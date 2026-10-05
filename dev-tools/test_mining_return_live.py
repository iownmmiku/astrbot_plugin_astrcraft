"""Local Paper: mined goods survive a failed return, rescue precedes the next task.

The shaft, ore, inventory, physics, LifeLoop and task event bridge are real.
Supplying blocks after the failed return isolates the recovery transition.
"""
from __future__ import annotations

import asyncio
import json
import os
import random
import re
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _paths
from lib.rcon import Rcon

_paths.require_astrbot("test_mining_return_live")
bridge = _paths.plugin_module("bridge_client")
LifeLoop = _paths.plugin_module("life").LifeLoop
MemoryStore = _paths.plugin_module("memory").MemoryStore
DriveSystem = _paths.plugin_module("drives").DriveSystem
Plugin = _paths.plugin_module("main").MinecraftPlugin


async def main():
    rcon = Rcon.from_dir(_paths.REPO / ".testserver", int(os.environ.get("MC_RCON_PORT", "25576")))
    username = f"Return{random.randrange(100000, 999999)}"
    x, z = random.randrange(21000, 22000), random.randrange(21000, 22000)
    area = f"{x-24} {z-24} {x+24} {z+24}"
    loaded = False
    original_time = original_cycle = None
    life = None
    submitted, results = [], []
    errors = []
    finished = asyncio.Event()
    model_calls = 0

    async def command(text):
        return await asyncio.to_thread(rcon.command, text)

    with tempfile.TemporaryDirectory(prefix="astrcraft-return-") as scratch:
        engine = bridge.EngineClient(bridge.EngineConfig(
            engine_dir=_paths.ENGINE_DIR, log_level="info", extra_env={"MC_DATA_DIR": scratch}))
        host = object.__new__(Plugin)
        host.engine, host.life, host.connected = engine, None, True
        host.config = {"announce_task_done": False}
        host.goals = None
        host._emergency_stopped = False
        host._last_task_announce = 0
        host._last_brief, host._last_brief_at = "", 0.0

        async def call(method, params=None, **kwargs):
            if method == "skill.run":
                skill = params["skill"]
                assert len(submitted) < 3, f"unbounded recovery: {submitted}"
                expected = ["mine_ores", "climb_out", "craft"][len(submitted)]
                assert skill == expected, (skill, expected)
                if skill == "climb_out":
                    items = (await engine.call("inventory.get"))["items"]
                    assert items.get("coal") == 2, items
                    assert [step["skill"] for step in life._plan] == ["craft"], life._plan
                    assert life._plan[0]["params"] == {"item": "torch", "count": 4}
                    assert not (await engine.call("state.get"))["mining_return_safety"]["safe"]
                    # The first return had no usable building blocks. Give actual
                    # blocks only when the rule-based rescue is about to start.
                    await command(f"give {username} cobblestone 8")
                    await asyncio.sleep(0.25)
                if skill == "craft":
                    state = await engine.call("state.get")
                    assert state["mining_return_safety"]["safe"], state
                    assert state["position"]["y"] >= 63.9, state
                submitted.append((skill, time.monotonic()))
                print(f"submit {skill}", flush=True)
            return await engine.call(method, params or {}, **kwargs)

        async def task_finished(payload):
            try:
                skill = (payload.get("meta") or {}).get("skill")
                if skill not in ("mine_ores", "climb_out", "craft"):
                    return
                result = payload.get("result") or {}
                results.append((skill, payload, time.monotonic()))
                print(f"finish {skill}: {payload['status']}; {json.dumps(result, ensure_ascii=False)}", flush=True)
                if skill == "mine_ores":
                    assert payload["status"] == "failed", payload
                    assert result["collection_ok"] is True and result["produced"].get("coal") == 2, result
                    assert result["return_status"]["ok"] is False, result
                    assert result["return_status"]["target"] is None, result
                else:
                    assert payload["status"] == "done" and result.get("ok") is True, payload
                # Exercise the plugin's actual event-to-LifeLoop result handling.
                await host._on_task_finished(payload)
                if skill == "mine_ores":
                    assert [step["skill"] for step in life._plan] == ["craft"], life._plan
                if skill == "craft":
                    life.pause(reason="return fixture complete", max_seconds=0)
                    finished.set()
            except Exception as exc:
                errors.append(repr(exc))
                if life:
                    life.pause(reason="return fixture failed", max_seconds=0)
                finished.set()

        async def model(prompt, system):
            nonlocal model_calls
            model_calls += 1
            raise AssertionError("known mining/rescue/craft plan must not request a model")

        async def system():
            return "Minecraft survival player"

        try:
            await engine.start()
            await engine.call("connect", {
                "host": "127.0.0.1", "port": int(os.environ.get("MC_PORT", "25566")),
                "version": "1.20.1", "username": username, "spawnProtectionRadius": 0,
                "autoMode": True, "autoUnstuck": False, "autoTorch": False,
            }, timeout=60)
            assert "There are 1 of a max" in await command("list"), "requires an exclusive local test server"
            reply = await command("time query daytime")
            original_time = int(re.search(r"(\d+)\s*$", reply)[1])
            reply = await command("gamerule doDaylightCycle")
            original_cycle = re.search(r"(true|false)\s*$", reply)[1]
            await command("gamerule doDaylightCycle false")
            await command("time set 6000")
            await command(f"forceload add {area}")
            loaded = True
            # A four-block shaft with indestructible walls and no exit. The
            # surrounding platform is known to the client at the real rim.
            for text in [
                f"fill {x-24} 59 {z-24} {x+24} 63 {z+24} bedrock",
                f"fill {x-24} 64 {z-24} {x+24} 76 {z+24} air",
                f"fill {x} 60 {z} {x} 63 {z} air",
                f"setblock {x+1} 60 {z} coal_ore", f"setblock {x-1} 60 {z} coal_ore",
                f"tp {username} {x+0.5} 60 {z+0.5}", f"clear {username}",
                f"give {username} stone_pickaxe 1", f"give {username} bread 4",
                f"give {username} stick 1", f"effect give {username} saturation 1 10 true",
            ]:
                await command(text)
            await asyncio.sleep(1.5)
            initial = await engine.call("state.get")
            assert initial["on_ground"] and initial["position"]["y"] == 60, initial
            assert initial["mining_return_safety"]["loaded"] and not initial["mining_return_safety"]["safe"], initial
            life = LifeLoop(
                engine_call=call, memory=MemoryStore(Path(scratch)), drives=DriveSystem(Path(scratch)),
                brief_provider=engine.state_brief, llm=model, system_prompt_provider=system,
                skill_catalog_provider=engine.skills, state_provider=host._life_state_snapshot,
                is_connected=lambda: engine.running, decide_interval=90)
            host.life = life
            life._set_plan([
                {"skill": "mine_ores", "params": {"ore": "coal", "count": 2, "radius": 8, "max_attempts": 3}},
                {"skill": "craft", "params": {"item": "torch", "count": 4}},
            ])
            life.note_blocked("fixture model unavailable", retry_after=300)
            engine.on("task.finished", task_finished)
            life.start()
            life.wake(reason="shaft ready")
            await asyncio.wait_for(finished.wait(), timeout=160)
            assert not errors, errors
            assert [s for s, _ in submitted] == ["mine_ores", "climb_out", "craft"], submitted
            assert [s for s, _, _ in results] == ["mine_ores", "climb_out", "craft"], results
            assert model_calls == 0, model_calls
            inventory = (await engine.call("inventory.get"))["items"]
            assert inventory.get("torch") == 4 and inventory.get("coal") == 1, inventory
            final = await engine.call("state.get")
            assert final["mining_return_safety"]["safe"] and final["position"]["y"] >= 63.9, final
            gaps = [submitted[i+1][1] - results[i][2] for i in range(2)]
            assert all(0 <= gap < 4 for gap in gaps), gaps
            print(f"检查通过：真实采煤2个后返程失败，先独立脱困到井口，再接回火把计划；模型0次，衔接{gaps}，背包{inventory}")
        except Exception:
            print("engine log tail:\n" + "\n".join(engine._last_stderr[-50:]), flush=True)
            raise
        finally:
            if life:
                await life.stop()
            await engine.stop()
            if loaded:
                await command(f"forceload remove {area}")
            if original_time is not None:
                await command(f"time set {original_time}")
            if original_cycle is not None:
                await command(f"gamerule doDaylightCycle {original_cycle}")
            rcon.close()


if __name__ == "__main__":
    asyncio.run(main())
