"""真服自主循环：一次模型计划，空背包砍树→做木镐→挖圆石。

模型回复固定，用于隔离验证计划执行与结果反馈；世界、物品、动作、
Python LifeLoop、EngineClient 和 Node 技能全部是真实实现。
仅连接项目测试服（默认 Minecraft 25566 / RCON 25576）。
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
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _paths
from lib.rcon import Rcon

_paths.require_astrbot("test_autonomy_live")
bridge = _paths.plugin_module("bridge_client")
LifeLoop = _paths.plugin_module("life").LifeLoop
MemoryStore = _paths.plugin_module("memory").MemoryStore
DriveSystem = _paths.plugin_module("drives").DriveSystem
Plugin = _paths.plugin_module("main").MinecraftPlugin
ActionAgent = _paths.plugin_module("action_agent").ActionAgent


async def main(*, agent_mode=False, survival_mode=False, supplies_mode=False):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    port = int(os.environ.get("MC_PORT", "25566"))
    rcon = Rcon.from_dir(_paths.REPO / ".testserver", int(os.environ.get("MC_RCON_PORT", "25576")))
    username = "Life" + str(random.randrange(100000, 999999))
    x, z = random.randrange(18000, 19000), random.randrange(18000, 19000)
    done = asyncio.Event()
    submitted, finished, failures = [], [], []
    by_id = {}
    model_calls = 0
    life = None
    arena_loaded = False
    original_difficulty = None
    expected = ["chop_tree", "make_tools", "mine_stone"]
    if survival_mode:
        expected = ["cook_food", "eat", *expected]
    plan = [
        {"skill": "chop_tree", "params": {"count": 4}},
        {"skill": "make_tools", "params": {"tier": "wooden", "kinds": ["pickaxe"]}},
        {"skill": "mine_stone", "params": {"count": 4}},
    ]
    with tempfile.TemporaryDirectory(prefix="astrcraft-autonomy-") as scratch:
        engine = bridge.EngineClient(bridge.EngineConfig(
            engine_dir=_paths.ENGINE_DIR,
            log_level="info",
            extra_env={"MC_DATA_DIR": scratch},
        ))

        async def call(method, params=None, **kwargs):
            result = await engine.call(method, params or {}, **kwargs)
            if method == "skill.run":
                skill = params["skill"]
                submitted.append((skill, time.monotonic()))
                by_id[result["task_id"]] = skill
                print(f"提交 {len(submitted)}/{len(expected)}: {skill}", flush=True)
            return result

        def task_finished(payload):
            skill = by_id.get(payload.get("id") or payload.get("task_id"))
            if not skill:
                return
            result = payload.get("result") or {}
            ok = payload.get("status") == "done" and result.get("ok", True)
            detail = str(payload.get("error") or result.get("note") or "")
            finished.append((skill, time.monotonic()))
            print(f"结束 {len(finished)}/{len(expected)}: {skill}, ok={ok}, {detail}", flush=True)
            life.note_task_result(skill, ok, detail)
            life.wake(reason="task.finished")
            if not ok:
                failures.append(f"{skill}: {detail}")
            if failures or len(finished) == len(expected):
                life.pause(reason="测试结束", max_seconds=0)
                done.set()

        async def model(prompt, system):
            nonlocal model_calls
            assert not agent_mode, "正常工具代理退回了旧 JSON 决策路径"
            model_calls += 1
            return json.dumps({
                "activity": "从零开始获取基础工具和圆石",
                "intention": "砍树、做木镐，然后挖圆石",
                "plan": plan,
            }, ensure_ascii=False)

        async def system_prompt():
            return "你是一个自主游玩 Minecraft 的生存玩家。"

        async def command(text):
            return await asyncio.to_thread(rcon.command, text)

        try:
            await engine.start()
            await engine.call("connect", {
                "host": "127.0.0.1", "port": port, "version": "1.20.1",
                "username": username, "spawnProtectionRadius": 0,
                "autoMode": True, "autoUnstuck": False,
            }, timeout=60)
            await command(f"forceload add {x-16} {z-16} {x+16} {z+16}")
            arena_loaded = True
            await command(f"fill {x-16} -44 {z-16} {x+16} -40 {z+16} stone")
            await command(f"fill {x-16} -39 {z-16} {x+16} -24 {z+16} air")
            for dx, dz in [(4, 0), (0, 5), (-5, 0)]:
                await command(f"fill {x+dx} -39 {z+dz} {x+dx} -36 {z+dz} oak_log")
            await command(f"tp {username} {x+0.5} -39 {z+0.5}")
            await command(f"clear {username}")
            await command(f"effect give {username} saturation 1 10 true")
            await asyncio.sleep(2)
            await engine.call("config.update", {"autoUnstuck": True})
            initial_inventory = (await engine.call("inventory.get")).get("items")
            assert initial_inventory == {}, f"测试起点应为空背包：{initial_inventory}"
            if survival_mode:
                difficulty_reply = await command("difficulty")
                original_difficulty = next((d for d in ("peaceful", "easy", "normal", "hard") if d in difficulty_reply.lower()), None)
                assert original_difficulty, difficulty_reply
                await command("difficulty normal")
                await engine.call("config.update", {"autoEat": False})  # 隔离验证生活循环的补给插步。
                await command(f"effect give {username} hunger 8 255 true")
                await asyncio.sleep(8.5)
                hungry = await engine.call("state.get", {"detail": "normal"})
                assert hungry["food"] <= 10, f"饥饿场景没有生效：{hungry['food']}"
                await command(f"give {username} wheat 12")
                await asyncio.sleep(0.4)
                print(f"计划前饱食度：{hungry['food']}；仅提供小麦，要求自己做饭吃饱再继续", flush=True)
            host = object.__new__(Plugin)
            host.engine, host.connected, host.life = engine, True, None
            life = LifeLoop(
                engine_call=call,
                memory=MemoryStore(Path(scratch)), drives=DriveSystem(Path(scratch)),
                brief_provider=engine.state_brief, llm=model,
                system_prompt_provider=system_prompt,
                skill_catalog_provider=engine.skills,
                state_provider=host._life_state_snapshot, is_connected=lambda: engine.running,
                decide_interval=90,
            )
            host.life = life
            if agent_mode:
                from astrbot.core.provider.func_tool_manager import FunctionToolManager

                class Provider:
                    async def text_chat(self, **kwargs):
                        nonlocal model_calls
                        model_calls += 1
                        return SimpleNamespace(
                            tools_call_name=["mc_plan_do"],
                            tools_call_args=[{"steps": json.dumps(plan), "why": "从零获取基础物资"}],
                            tools_call_ids=["plan-1"], usage=None, completion_text="",
                            to_openai_tool_calls_model=lambda: [],
                        )

                provider = Provider()

                async def get_provider():
                    return provider

                manager = FunctionToolManager()
                manager.add_func(name="mc_plan_do", func_args=[], desc="连续生存计划", handler=Plugin.tool_plan_do)
                host.context = SimpleNamespace(
                    get_using_provider_async=get_provider,
                    provider_manager=SimpleNamespace(llm_tools=manager),
                )
                life.action_agent = ActionAgent(host)
            print("自主链模式:", "ActionAgent + 真实计划工具" if agent_mode else "JSON 决策", flush=True)
            engine.on("task.finished", task_finished)
            life.start()
            life.wake(reason="测试区已加载")
            await asyncio.wait_for(done.wait(), timeout=260)
            assert not failures, failures
            assert [s for s, _ in submitted] == expected, submitted
            assert [s for s, _ in finished] == expected, finished
            assert model_calls == 1, f"计划中间重复问模型：{model_calls} 次"
            gaps = [submitted[i + 1][1] - finished[i][1] for i in range(len(expected) - 1)]
            assert all(0 <= gap < 3.5 for gap in gaps), f"任务衔接过慢：{gaps}"
            inventory = (await engine.call("inventory.get")).get("items") or {}
            assert inventory.get("wooden_pickaxe", 0) >= 1, inventory
            assert inventory.get("cobblestone", 0) >= 4, inventory
            if survival_mode:
                assert (await engine.call("state.get", {"detail": "normal"}))["food"] >= 18
            print(f"真实物品: {inventory}; 模型调用: {model_calls}; 衔接耗时: {[round(g, 3) for g in gaps]} 秒")
            if supplies_mode:
                await engine.call("config.update", {"autoEat": False})
                async def finish_skill(name, params):
                    task = await engine.run_skill(name, params)
                    deadline = time.monotonic() + 100
                    while time.monotonic() < deadline:
                        status = await engine.task_status(task["task_id"])
                        if status.get("status") in ("done", "failed", "cancelled"):
                            assert status["status"] == "done", status
                            return status
                        await asyncio.sleep(0.2)
                    await engine.cancel_task(task["task_id"])
                    raise AssertionError(f"{name} 超时")

                await command(f"tp {username} {x+0.5} -39 {z+0.5}")
                await command(f"setblock {x+1} -39 {z+1} furnace")
                await command(f"setblock {x-1} -39 {z+1} chest")
                await command(f"clear {username}")
                for item, count in [("salmon", 2), ("coal", 2), ("stone_pickaxe", 1)]:
                    await command(f"give {username} {item} {count}")
                await asyncio.sleep(0.5)
                await finish_skill("cook_food", {"count": 2})
                cooked = (await engine.call("inventory.get"))["items"]
                assert cooked.get("cooked_salmon", 0) == 2 and cooked.get("salmon", 0) == 0, cooked
                for item, count in [("bread", 4), ("cobblestone", 16)]:
                    await command(f"give {username} {item} {count}")
                await asyncio.sleep(0.4)
                await finish_skill("store_items", {})
                kept = (await engine.call("inventory.get"))["items"]
                assert kept.get("stone_pickaxe", 0) == 1 and kept.get("bread", 0) == 4 and kept.get("cooked_salmon", 0) == 2, kept
                assert kept.get("cobblestone", 0) == 0, kept
                chest = await engine.call("container.open", {"x": x-1, "y": -39, "z": z+1, "reach": True})
                assert sum(i["count"] for i in chest.get("items", []) if i["name"] == "cobblestone") == 16, chest
                print(f"现有生鱼烹饪与存箱通过：{kept}", flush=True)
            await engine.safety_stop()
            stopped = await engine.status()
            assert stopped.get("emergency_stopped") is True, stopped
            try:
                await engine.run_skill("mine_stone", {"count": 1})
            except bridge.EngineError:
                pass
            else:
                raise AssertionError("急停后仍接受动作任务")
            await engine.call("safety.resume")
            assert not (await engine.status()).get("emergency_stopped")
            print("检查通过：自主计划实物产出、一次规划、即时衔接、急停/恢复" + ("、饥饿自动补给后接回原计划" if survival_mode else ""))
        except Exception:
            if engine.running:
                try:
                    print("失败时背包:", await engine.call("inventory.get"), flush=True)
                    print("失败时队列:", await engine.call("task.list"), flush=True)
                except bridge.EngineError as exc:
                    print("读取失败现场:", exc, flush=True)
            print("引擎日志尾部:\n" + "\n".join(engine._last_stderr[-60:]), flush=True)
            raise
        finally:
            if life:
                await life.stop()
            await engine.stop()
            if arena_loaded:
                await command(f"forceload remove {x-16} {z-16} {x+16} {z+16}")
            if original_difficulty:
                await command(f"difficulty {original_difficulty}")
            rcon.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent", action="store_true", help="通过真实 ActionAgent、工具注册表和 mc_plan_do 排计划")
    parser.add_argument("--survival", action="store_true", help="真实饥饿状态：自动做面包、吃饱，再接回原计划")
    parser.add_argument("--supplies", action="store_true", help="追加实际生鱼烹饪与存箱保留工具/食物检查")
    args = parser.parse_args()
    asyncio.run(main(agent_mode=args.agent, survival_mode=args.survival, supplies_mode=args.supplies))
