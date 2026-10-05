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
import re
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


async def main(*, agent_mode=False, survival_mode=False, supplies_mode=False, base_food_mode=False,
               compound_home_mode=False, compound_shortage_mode=False, collection_mode=False):
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
    original_time = None
    original_daylight_cycle = None
    expected = ["chop_tree", "make_tools", "mine_stone"]
    if survival_mode:
        expected = ["cook_food", "eat", *expected]
    plan = [
        {"skill": "chop_tree", "params": {"count": 4}},
        {"skill": "make_tools", "params": {"tier": "wooden", "kinds": ["pickaxe"]}},
        {"skill": "mine_stone", "params": {"count": 4}},
    ]
    base_home = None
    if base_food_mode:
        expected = ["resupply_food", "eat", "leave_home", "mine_ores"]
        plan = [{"skill": "mine_ores", "params": {"ore": "coal", "count": 2, "radius": 16}}]
    if compound_home_mode:
        expected = ["cook_food", "make_tools", "leave_home", "mine_ores"]
        plan = [{"skill": "cook_food", "params": {"count": 6}},
                {"skill": "make_tools", "params": {"tier": "iron", "kinds": ["pickaxe"]}},
                {"skill": "mine_ores", "params": {"ore": "coal", "count": 2, "radius": 16}}]
        if compound_shortage_mode:
            expected = ["leave_home", "make_tools", "mine_ores"]
            plan = [{"skill": "make_tools", "params": {"tier": "stone", "kinds": ["pickaxe"]}},
                    {"skill": "mine_ores", "params": {"ore": "coal", "count": 2, "radius": 16}}]
    if collection_mode:
        expected = ["collect", "collect", "collect", "mine_ores"]
        plan = [{"skill": "collect", "params": {"item": "bucket", "count": 1}},
                {"skill": "collect", "params": {"item": "spruce_log", "count": 1}},
                {"skill": "collect", "params": {"item": "iron_ingot", "count": 3}},
                {"skill": "mine_ores", "params": {"ore": "iron", "count": 1, "radius": 16}}]
    with tempfile.TemporaryDirectory(prefix="astrcraft-autonomy-") as scratch:
        engine = bridge.EngineClient(bridge.EngineConfig(
            engine_dir=_paths.ENGINE_DIR,
            log_level="info",
            extra_env={"MC_DATA_DIR": scratch},
        ))

        async def compound_preflight(params):
            if compound_home_mode:
                before = await engine.call("home.inspect", {"home": base_home})
                assert before["condition"] == "intact" and before["door_closed"], before
                if params["skill"] in ("cook_food", "make_tools", "mine_ores"):
                    protected = params["params"]["protected_home"]
                    for field in ("server", "dimension", "origin", "size", "wall_height"):
                        assert protected[field] == base_home[field], params
                if not compound_shortage_mode and params["skill"] in ("cook_food", "make_tools"):
                    assert before["safe"], before
                    assert params["params"]["home"]["origin"] == base_home["origin"], params
                    assert params["params"]["allow_search"] is False and params["params"]["safe_search"] is True, params
                if compound_shortage_mode and params["skill"] == "make_tools":
                    assert not before["inside"], "缺料技能必须先实际出门"
                    assert params["params"]["safe_search"] is True, params
                if not compound_shortage_mode and params["skill"] == "leave_home":
                    prepared = (await engine.call("inventory.get"))["items"]
                    assert prepared.get("iron_pickaxe", 0) == 1 and prepared.get("cooked_cod", 0) == 2, prepared
                    assert prepared.get("oak_planks", 0) == 1 and prepared.get("spruce_planks", 0) == 0, prepared
                    assert prepared.get("coal", 0) == 0, prepared
                    print(f"室内成品已验收：{prepared}；三批铁料只用一份煤，余热复用且橡木板保留", flush=True)

        async def call(method, params=None, **kwargs):
            if method == "skill.run" and compound_home_mode:
                try:
                    await compound_preflight(params)
                except AssertionError as exc:
                    failures.append(f"派发前实物检查失败：{exc}")
                    life.pause(reason="测试前置失败", max_seconds=0)
                    done.set()
                    raise
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
            if collection_mode and skill == "mine_ores" and ok:
                if not (result.get("gained") == 1 and result.get("collection_ok") is True and
                        result.get("return_status", {}).get("ok") is True and
                        result.get("produced", {}).get("iron_pickaxe") == 1 and
                        result.get("consumed", {}).get("iron_ingot") == 3):
                    failures.append(f"采铁和工具替换结果字段没有对应实物：{result}")
            life.note_task_result(skill, ok, detail, result=result,
                                  task_id=payload.get("task_id") or payload.get("id"))
            life.wake(reason="task.finished")
            if not ok:
                failures.append(f"{skill}: {detail}")
            if failures or len(finished) == len(expected):
                life.pause(reason="测试结束", max_seconds=0)
                done.set()

        async def model(prompt, system):
            nonlocal model_calls
            assert not (base_food_mode or compound_home_mode or collection_mode), "既定计划衔接不应调用模型"
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

        async def finish_skill(name, params, budget=100, expected_status="done"):
            task = await engine.run_skill(name, params)
            deadline = time.monotonic() + budget
            while time.monotonic() < deadline:
                status = await engine.task_status(task["task_id"])
                if status.get("status") in ("done", "failed", "cancelled"):
                    assert status["status"] == expected_status, status
                    return status
                await asyncio.sleep(0.2)
            await engine.cancel_task(task["task_id"])
            raise AssertionError(f"{name} 超时")

        try:
            await engine.start()
            await engine.call("connect", {
                "host": "127.0.0.1", "port": port, "version": "1.20.1",
                "username": username, "spawnProtectionRadius": 0,
                "autoMode": True, "autoUnstuck": False,
            }, timeout=60)
            # This fixture verifies the daytime supply/work chain. Night shelter
            # and sleep have their own live test; the server clock must not turn
            # this into an unrelated house-construction scenario between runs.
            players = await command("list")
            assert "There are 1 of a max" in players, players
            time_reply = await command("time query daytime")
            time_match = re.search(r"(\d+)\s*$", time_reply)
            assert time_match, time_reply
            original_time = int(time_match[1])
            cycle_reply = await command("gamerule doDaylightCycle")
            cycle_match = re.search(r"(true|false)\s*$", cycle_reply)
            assert cycle_match, cycle_reply
            original_daylight_cycle = cycle_match[1]
            await command("gamerule doDaylightCycle false")
            await command("time set 6000")
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
            assert (await engine.call("state.get", {"detail": "normal"}))["time_of_day"] == 6000, "客户端须确认日间测试前提"
            if collection_mode:
                await engine.call("config.update", {"autoTorch": False, "autoUnstuck": False})
                # No existing workstation: carrying the furnace recipe plus its
                # four table planks must create both stations without a search.
                await command(f"fill {x-16} -44 {z-16} {x+16} -40 {z+16} bedrock")
                for item, count in [("raw_iron", 1), ("cobblestone", 8), ("oak_planks", 4),
                                    ("coal", 1), ("bread", 4)]:
                    await command(f"give {username} {item} {count}")
                await asyncio.sleep(0.4)
                prepared = await finish_skill("smelt", {"item": "raw_iron", "count": 1, "allow_search": False})
                actual = (await engine.call("inventory.get"))["items"]
                assert prepared["result"]["ok"] and actual.get("iron_ingot") == 1, prepared
                assert actual.get("raw_iron", 0) == actual.get("cobblestone", 0) == actual.get("oak_planks", 0) == 0, actual
                assert actual.get("crafting_table", 0) == actual.get("furnace", 0) == 0, actual
                print(f"无台无炉熔炼前置通过：只用现有材料实际做台、做炉并产出铁锭；{actual}", flush=True)
                await command(f"clear {username}")
                await command(f"tp {username} {x+0.5} -39 {z+0.5}")
                await command(f"fill {x-16} -39 {z-16} {x+16} -24 {z+16} air")
                # No initial tool or wood: a carried stone-tool recipe must
                # recover directly, and replace its consumed goal material.
                await command(f"fill {x-16} -44 {z-16} {x+16} -40 {z+16} bedrock")
                await command(f"setblock {x+2} -39 {z+1} crafting_table")
                for dx, dz in [(2, -2), (2, -3), (3, -2), (3, -3)]:
                    await command(f"setblock {x+dx} -39 {z+dz} stone")
                for item, count in [("cobblestone", 3), ("stick", 2), ("bread", 4)]:
                    await command(f"give {username} {item} {count}")
                await asyncio.sleep(0.5)
                status = await finish_skill("mine_stone", {
                    "count": 1, "radius": 16, "max_attempts": 8, "allow_search": False,
                }, budget=70)
                actual = (await engine.call("inventory.get"))["items"]
                assert actual.get("stone_pickaxe") == 1 and actual.get("cobblestone") == 4, actual
                assert actual.get("wooden_pickaxe", 0) == actual.get("oak_log", 0) == 0, actual
                result = status["result"]
                assert result["gained"] == 1 and result["collection_ok"] and result["return_status"]["ok"], result
                print(f"无镐采石前置通过：实际制作石镐并挖四格，库存圆石净增 1；{actual}", flush=True)
                await command(f"tp {username} {x+0.5} -39 {z+0.5}")
                await command(f"clear {username}")
                # A valid gold tool must not be discarded as "no pickaxe".
                await command(f"setblock {x+2} -39 {z-2} coal_ore")
                await command(f"give {username} golden_pickaxe 1")
                await command(f"give {username} bread 4")
                await asyncio.sleep(0.4)
                gold_tool = await finish_skill("mine_ores", {
                    "ore": "coal", "count": 1, "radius": 16, "allow_search": False,
                })
                actual = (await engine.call("inventory.get"))["items"]
                assert actual.get("golden_pickaxe") == 1 and actual.get("coal") == 1, actual
                assert gold_tool["result"]["gained"] == 1 and gold_tool["result"]["return_status"]["ok"], gold_tool
                assert not any(actual.get(f"{tier}_pickaxe", 0) for tier in ("wooden", "stone", "iron")), actual
                print(f"金镐采煤前置通过：真实掉落煤 1，没有制造其它镐；{actual}", flush=True)
                await command(f"tp {username} {x+0.5} -39 {z+0.5}")
                await command(f"clear {username}")
                # Only mixed raw material is carried: prepare iron on site,
                # then replace the raw iron spent as part of the net goal.
                await command(f"setblock {x-2} -39 {z+1} furnace")
                for dx, dz in [(2, -2), (3, -2)]:
                    await command(f"setblock {x+dx} -39 {z+dz} iron_ore")
                for item, count in [("raw_iron", 1), ("iron_ore", 1), ("deepslate_iron_ore", 1),
                                    ("coal", 1), ("stick", 2), ("bread", 4)]:
                    await command(f"give {username} {item} {count}")
                await asyncio.sleep(0.4)
                iron_tool = await finish_skill("mine_ores", {
                    "ore": "iron", "count": 1, "radius": 16, "allow_search": False,
                })
                actual = (await engine.call("inventory.get"))["items"]
                assert actual.get("iron_pickaxe") == 1 and actual.get("raw_iron") == 2, actual
                assert actual.get("iron_ore", 0) == actual.get("deepslate_iron_ore", 0) == 0, actual
                result = iron_tool["result"]
                assert result["gained"] == 1 and result["produced"]["iron_pickaxe"] == 1 and result["return_status"]["ok"], result
                print(f"库存混铁料补镐前置通过：实际炼铁做镐、挖两矿，粗铁由 1 净增至 2；{actual}", flush=True)
                await command(f"tp {username} {x+0.5} -39 {z+0.5}")
                await command(f"clear {username}")
                # A cold furnace must not burn the two handles needed by the
                # pending pickaxe. Surplus sticks can then fund the same recipe.
                await command(f"setblock {x-2} -39 {z+1} air")
                await command(f"setblock {x-2} -39 {z+1} furnace")
                for item, count in [("raw_iron", 3), ("stick", 2), ("bread", 4)]:
                    await command(f"give {username} {item} {count}")
                await asyncio.sleep(0.4)
                handles = await finish_skill("make_tools", {
                    "tier": "iron", "kinds": ["pickaxe"], "allow_search": False,
                }, expected_status="failed")
                actual = (await engine.call("inventory.get"))["items"]
                assert handles["result"]["ok"] is False, handles
                assert actual.get("raw_iron") == 3 and actual.get("stick") == 2, actual
                assert actual.get("iron_ingot", 0) == actual.get("iron_pickaxe", 0) == 0, actual
                print(f"冷炉木棍保留前置通过：未烧掉工具必需木棍、未消耗粗铁；{actual}", flush=True)
                await command(f"give {username} stick 6")
                await asyncio.sleep(0.4)
                spare = await finish_skill("make_tools", {
                    "tier": "iron", "kinds": ["pickaxe"], "allow_search": False,
                })
                actual = (await engine.call("inventory.get"))["items"]
                assert spare["result"]["ok"] is True, spare
                assert actual.get("iron_pickaxe") == 1, actual
                assert actual.get("raw_iron", 0) == actual.get("stick", 0) == actual.get("iron_ingot", 0) == 0, actual
                print(f"多余木棍燃料前置通过：实际烧 6 根、用保留 2 根制成铁镐；{actual}", flush=True)
                await command(f"tp {username} {x+0.5} -39 {z+0.5}")
                await command(f"clear {username}")
                for text in [f"fill {x-16} -44 {z-16} {x+16} -40 {z+16} bedrock",
                             f"setblock {x+2} -39 {z+1} crafting_table",
                             f"setblock {x-2} -39 {z+1} air",
                             f"setblock {x-2} -39 {z+1} furnace",
                             f"setblock {x+3} -39 {z+2} spruce_log",
                             f"setblock {x+2} -39 {z-2} iron_ore",
                             f"give {username} iron_pickaxe{{Damage:249}} 1"]:
                    await command(text)
                for item, count in [("raw_iron", 4), ("iron_ore", 1), ("deepslate_iron_ore", 1),
                                    ("coal", 1), ("stick", 2), ("bread", 4)]:
                    await command(f"give {username} {item} {count}")
                await asyncio.sleep(0.6)
                initial = (await engine.call("inventory.get"))["items"]
                assert initial.get("iron_ingot", 0) == 0 and initial["raw_iron"] == 4, initial
            if survival_mode or base_food_mode:
                difficulty_reply = await command("difficulty")
                original_difficulty = next((d for d in ("peaceful", "easy", "normal", "hard") if d in difficulty_reply.lower()), None)
                assert original_difficulty, difficulty_reply
                await command("difficulty normal")
                await engine.call("config.update", {"autoEat": False})  # 隔离验证生活循环的补给插步。
                await command(f"effect give {username} hunger 8 255 true")
                await asyncio.sleep(8.5)
                hungry = await engine.call("state.get", {"detail": "normal"})
                assert hungry["food"] <= 10, f"饥饿场景没有生效：{hungry['food']}"
                if not base_food_mode:
                    await command(f"give {username} wheat 12")
                    await asyncio.sleep(0.4)
                    print(f"计划前饱食度：{hungry['food']}；仅提供小麦，要求自己做饭吃饱再继续", flush=True)
            if base_food_mode or compound_home_mode:
                for text in [
                    f"fill {x} -39 {z} {x+4} -37 {z+4} cobblestone",
                    f"fill {x+1} -39 {z+1} {x+3} -38 {z+3} air",
                    f"setblock {x+2} -40 {z+2} glowstone",
                    f"setblock {x+2} -39 {z} oak_door[facing=south,half=lower,hinge=left,open=false,powered=false]",
                    f"setblock {x+2} -38 {z} oak_door[facing=south,half=upper,hinge=left,open=false,powered=false]",
                    f"setblock {x+1} -39 {z+1} chest",
                    f'data merge block {x+1} -39 {z+1} {{Items:[{{Slot:0b,id:"minecraft:bread",Count:8b}},{{Slot:1b,id:"minecraft:golden_apple",Count:1b}},{{Slot:2b,id:"minecraft:beef",Count:2b}}]}}',
                    f"setblock {x+8} -39 {z-3} coal_ore", f"setblock {x+9} -39 {z-3} coal_ore",
                    f"tp {username} {x+2.5} -39 {z-3.5}", f"give {username} stone_pickaxe 1",
                ]:
                    await command(text)
                await asyncio.sleep(1)
                body = await engine.call("state.get", {"detail": "normal"})
                base_home = {"server": body["server"], "dimension": body["dimension"],
                    "origin": {"x": x, "y": -39, "z": z}, "size": 5, "inner": 3, "wall_height": 2,
                    "door_position": {"x": x+2, "y": -39, "z": z}, "complete": True,
                    "has_roof": True, "has_door": True, "verified_at": time.time()*1000}
                actual = await engine.call("home.inspect", {"home": base_home})
                assert actual["condition"] == "intact" and not actual["inside"] and actual["door_closed"], actual
                base_home["furnished"] = actual["furniture"]
                assert actual["furniture"]["chest"] and actual["distance"] <= 8, actual
                print(f"基地补给起点：饥饿 {body['food']}，闭门粮仓已实测，原任务为采煤 2 个", flush=True)
                if compound_home_mode:
                    # This fixture isolates the preparation/door boundary. A
                    # fixed support floor and explicit visible quarry keep a
                    # later mining step from turning it into a pit escape test.
                    for text in [f"fill {x-16} -44 {z-16} {x+16} -40 {z+16} bedrock",
                                 f"clear {username}", f"setblock {x+1} -39 {z+1} air",
                                 f"setblock {x+8} -39 {z-3} air", f"setblock {x+9} -39 {z-3} air",
                                 f"setblock {x+2} -39 {z-3} coal_ore", f"setblock {x+2} -39 {z-4} coal_ore",
                                 f"tp {username} {x+2.5} -39 {z+2.5}",
                                 f"give {username} bread 4", f"effect give {username} saturation 1 10 true"]:
                        await command(text)
                    if compound_shortage_mode:
                        for dz in (-2, -3, -4):
                            await command(f"setblock {x+1} -39 {z+dz} stone")
                        supplies = [("wooden_pickaxe", 1), ("stick", 2), ("crafting_table", 1)]
                    else:
                        for text in [f"setblock {x+1} -39 {z+1} crafting_table",
                                     f"setblock {x+1} -39 {z+2} smoker",
                                     f"setblock {x+3} -39 {z+3} blast_furnace",
                                     # A closer incompatible station must not attract food/ore.
                                     f"setblock {x+2} -39 {z+3} smoker"]:
                            await command(text)
                        supplies = [("cod", 2), ("coal", 2), ("raw_iron", 1), ("iron_ore", 1),
                                    ("deepslate_iron_ore", 1), ("oak_planks", 1), ("spruce_planks", 2)]
                    for item, count in supplies:
                        await command(f"give {username} {item} {count}")
                    await asyncio.sleep(1)
                    actual = await engine.call("home.inspect", {"home": base_home})
                    assert actual["safe"], actual
                    for dz in (-3, -4):
                        ore = await engine.call("block.at", {"x": x+2, "y": -39, "z": z+dz})
                        assert ore["name"] == "coal_ore", ore
                    if compound_shortage_mode:
                        for dz in (-2, -3, -4):
                            stone = await engine.call("block.at", {"x": x+1, "y": -39, "z": z+dz})
                            assert stone["name"] == "stone", stone
                    base_home["furnished"] = actual["furniture"]
                    print("复合准备起点：实际关门屋内；" + ("缺圆石，须先出门" if compound_shortage_mode else "现有鱼、混木板、三种铁料和两份煤，须室内完成"), flush=True)
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
            if base_food_mode or compound_home_mode or collection_mode:
                if base_home:
                    assert life.remember_home(base_home)
                life._set_plan(plan)
                life.note_blocked("离线模型 fixture，验证规则补给", retry_after=300)
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
            assert model_calls == (0 if base_food_mode or compound_home_mode or collection_mode else 1), f"计划中间重复问模型：{model_calls} 次"
            gaps = [submitted[i + 1][1] - finished[i][1] for i in range(len(expected) - 1)]
            assert all(0 <= gap < 3.5 for gap in gaps), f"任务衔接过慢：{gaps}"
            inventory = (await engine.call("inventory.get")).get("items") or {}
            if collection_mode:
                assert inventory.get("bucket") == 1 and inventory.get("spruce_log") == 1, inventory
                assert inventory.get("oak_log", 0) == 0 and inventory.get("iron_pickaxe") == 2, inventory
                assert inventory.get("raw_iron") == 1 and inventory.get("iron_ingot", 0) == 0, inventory
                assert inventory.get("iron_ore", 0) == inventory.get("deepslate_iron_ore", 0) == 0, inventory
                assert inventory.get("coal", 0) == 0, inventory
                quarry = await engine.call("block.at", {"x": x+2, "y": -39, "z": z-2})
                assert quarry["name"] == "air", quarry
            elif compound_home_mode:
                tool = "stone_pickaxe" if compound_shortage_mode else "iron_pickaxe"
                assert inventory.get(tool, 0) == 1 and inventory.get("coal", 0) >= 2, inventory
                if not compound_shortage_mode:
                    # The subsequent mining return may legitimately use a plank
                    # to climb. Mixed-plank/heat accounting was checked before exit.
                    assert inventory.get("cooked_cod", 0) == 2, inventory
                    assert all(inventory.get(item, 0) == 0 for item in ("raw_iron", "iron_ore", "deepslate_iron_ore")), inventory
                actual = await engine.call("home.inspect", {"home": base_home})
                assert actual["condition"] == "intact" and not actual["inside"] and actual["door_closed"], actual
            elif base_food_mode:
                assert inventory.get("stone_pickaxe", 0) == 1 and inventory.get("coal", 0) >= 2, inventory
                actual = await engine.call("home.inspect", {"home": base_home})
                assert actual["condition"] == "intact" and not actual["inside"] and actual["door_closed"], actual
                stock = await command(f"data get block {x+1} -39 {z+1} Items")
                assert 'minecraft:bread' in stock and 'Count: 4b' in stock, stock
                assert 'minecraft:golden_apple' in stock and 'minecraft:beef' in stock, stock
            else:
                assert inventory.get("wooden_pickaxe", 0) >= 1, inventory
                assert inventory.get("cobblestone", 0) >= 4, inventory
            if survival_mode or base_food_mode:
                assert (await engine.call("state.get", {"detail": "normal"}))["food"] >= 18
            print(f"真实物品: {inventory}; 模型调用: {model_calls}; 衔接耗时: {[round(g, 3) for g in gaps]} 秒")
            if supplies_mode:
                await engine.call("config.update", {"autoEat": False})
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
            print("检查通过：自主计划实物产出、" + ("既定计划零模型调用" if collection_mode else "一次规划") +
                  "、即时衔接、急停/恢复" + ("、饥饿自动补给后接回原计划" if survival_mode else ""))
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
            if original_time is not None:
                await command(f"time set {original_time}")
            if original_daylight_cycle is not None:
                await command(f"gamerule doDaylightCycle {original_daylight_cycle}")
            rcon.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent", action="store_true", help="通过真实 ActionAgent、工具注册表和 mc_plan_do 排计划")
    parser.add_argument("--survival", action="store_true", help="真实饥饿状态：自动做面包、吃饱，再接回原计划")
    parser.add_argument("--supplies", action="store_true", help="追加实际生鱼烹饪与存箱保留工具/食物检查")
    parser.add_argument("--base-food", action="store_true", help="饥饿时自主返回闭门粮仓、取食吃饱、出门并接回既定采煤任务；模型不可用")
    parser.add_argument("--compound-home", action="store_true", help="关门屋内现有材料做饭、混木板做铁镐、三种铁料复用余热，再出门接回采煤；模型不可用")
    parser.add_argument("--compound-shortage", action="store_true", help="与--compound-home一起使用：屋内缺圆石时先出门做石镐，再接回采煤")
    parser.add_argument("--collection", action="store_true", help="库存粗铁做桶、指定云杉、混矿熔炼与磨损铁镐替换后采铁；模型不可用")
    args = parser.parse_args()
    if args.compound_shortage and not args.compound_home:
        parser.error("--compound-shortage 需要 --compound-home")
    if args.collection and any((args.agent, args.survival, args.supplies, args.base_food, args.compound_home, args.compound_shortage)):
        parser.error("--collection 单独使用")
    asyncio.run(main(agent_mode=args.agent, survival_mode=args.survival, supplies_mode=args.supplies,
                     base_food_mode=args.base_food, compound_home_mode=args.compound_home,
                     compound_shortage_mode=args.compound_shortage, collection_mode=args.collection))
