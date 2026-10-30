"""Offline integration: observed farmland, Python scheduling and persisted task results."""
from __future__ import annotations

import copy
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

import _paths
from test_life_recovery import make_loop
from test_plugin_control import plugin

_paths.require_astrbot("test_farm_lifecycle")
advise = _paths.plugin_module("advisor").advise

HOME = {"server": "fixture:25565", "dimension": "overworld",
        "origin": {"x": 0, "y": 64, "z": 0}, "size": 5, "wall_height": 3,
        "complete": True, "has_roof": True, "condition": "intact"}
HOME_STATUS = {"condition": "intact", "loaded": True, "inside": False, "safe": False,
               "distance": 4, "furniture": {"chest": True}}
INVENTORY = {"iron_pickaxe": 1, "iron_ingot": 16, "bread": 8, "torch": 16,
             "wheat_seeds": 5, "wooden_hoe": 1}

# Use the production Node observer: a natural water source and existing dirt
# must be sufficient evidence even before any farm record has been persisted.
OBSERVE = r"""
const { vec3 } = require('./engine/util');
const { inspectFarm } = require('./engine/skills/farming');
const home = JSON.parse(process.argv[1]), inv = JSON.parse(process.argv[2]);
let phase = 'natural', sites = [];
const bot = { _client: { socket: {remoteAddress:'fixture',remotePort:25565} },
  game: {dimension:'overworld'}, blockAt(p) {
    const site = sites.find(q => q.x === p.x && q.z === p.z);
    let name = p.y < 63 ? 'stone' : p.y === 63 ? 'grass_block' : 'air';
    if (p.x === 9 && p.y === 63 && p.z === 2) name = 'water';
    if (phase !== 'natural' && site && p.y === 63) name = 'farmland';
    if (phase !== 'natural' && site && p.y === 64) name = 'wheat';
    return { name, position: vec3(p.x,p.y,p.z), skyLight:15, light:0,
      boundingBox:['air','wheat','water'].includes(name)?'empty':'block',
      getProperties:()=>({level:0, age:phase === 'mature' ? 7 : 0}) };
  } };
const actions = {bot, countItem:n=>inv[n]||0, inventoryMap:()=>({...inv})};
let natural;
for(let n=0;n<20;n++) { natural=inspectFarm({actions,home}); if(natural.candidate_plots>=4) break; }
sites=natural.candidate_positions;
const farm={kind:'wheat',server:home.server,dimension:home.dimension,home_origin:home.origin,plots:sites};
phase='growing'; const growing=inspectFarm({actions,home,farm});
phase='mature'; const mature=inspectFarm({actions,home,farm});
process.stdout.write(JSON.stringify({natural,growing,mature,farm}));
"""


class FarmLifecycleTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        run = subprocess.run(["node", "-e", OBSERVE, json.dumps(HOME), json.dumps(INVENTORY)],
                             cwd=_paths.REPO, capture_output=True, text=True, encoding="utf-8", timeout=15)
        if run.returncode:
            raise AssertionError(run.stderr)
        cls.observed = json.loads(run.stdout)

    def loop_with_state(self, **changes):
        state = {"health": 20, "food": 20, "is_night": False, "inventory": copy.deepcopy(INVENTORY),
                 "inventory_slots_used": 7, "server": HOME["server"], "dimension": HOME["dimension"],
                 "home_status": copy.deepcopy(HOME_STATUS), "farm_status": copy.deepcopy(self.observed["natural"])}
        state.update(copy.deepcopy(changes))
        loop, _ = make_loop()
        loop.remember_home(HOME)
        async def snapshot():
            return copy.deepcopy(state)
        loop._state_provider = snapshot
        return loop, state

    async def test_natural_water_candidate_reaches_first_farm_plan_and_exit_boundary(self):
        natural = self.observed["natural"]
        self.assertEqual(natural["plots"], [], "observed dirt is not already a completed farm")
        self.assertTrue(natural["can_start"] and natural["needs_work"])
        loop, state = self.loop_with_state()
        advice = await loop._build_advice(state)
        self.assertEqual(advice.skill, "tend_farm")
        self.assertIsNone(advice.params["farm"])
        decision = loop._fallback_decision({"drive": "gather"}, advice)
        self.assertEqual(decision.skill, "tend_farm")
        original = {"skill": decision.skill, "params": decision.params, "why": advice.why}
        loop._set_plan([original])
        state["home_status"].update(inside=True, safe=True)
        self.assertEqual((await loop._survival_step())["skill"], "leave_home")
        self.assertEqual(loop._plan, [original])
        state["home_status"].update(inside=False, safe=False)
        self.assertIsNone(await loop._survival_step())
        self.assertEqual(loop._plan, [original])

    async def test_failed_partial_farm_uses_meta_home_and_survives_reload(self):
        loop, state = self.loop_with_state()
        host = plugin(); host.life = loop; host.config["announce_task_done"] = False
        partial = {**copy.deepcopy(self.observed["farm"]), "plots": self.observed["farm"]["plots"][:1]}
        with tempfile.TemporaryDirectory(prefix="astrcraft-farm-") as directory:
            loop.bind_data_dir(Path(directory))
            await host._on_task_finished({"kind": "skill", "name": "照料小麦田", "status": "failed",
                "task_id": "partial-farm", "meta": {"skill": "tend_farm", "params": {"home": HOME, "plots": 4}},
                "result": {"ok": False, "farm": partial, "reason": "planting not confirmed"}})
            self.assertEqual(loop.home_for_world(state)["farm"], partial)
            disk = json.loads((Path(directory) / "life.json").read_text(encoding="utf-8"))
            self.assertEqual(disk["homes"][0]["farm"], partial)
            restarted, _ = make_loop(); restarted.bind_data_dir(Path(directory))
            self.assertEqual(restarted.home_for_world(state)["farm"], partial)
            advice = await restarted._build_advice(state)
            self.assertEqual(advice.skill, "tend_farm")
            self.assertEqual(advice.params["farm"], partial)

    async def test_cancelled_empty_and_foreign_results_do_not_replace_record(self):
        loop, state = self.loop_with_state()
        original = copy.deepcopy(self.observed["farm"])
        self.assertTrue(loop.note_home_farm(HOME, original))
        host = plugin(); host.life = loop; host.config["announce_task_done"] = False
        for status, farm in (("cancelled", {**original, "plots": original["plots"][:1]}),
                             ("failed", {**original, "plots": []}),
                             ("done", {**original, "server": "foreign:25565"})):
            await host._on_task_finished({"kind": "skill", "status": status, "name": "照料小麦田",
                "meta": {"skill": "tend_farm", "params": {"home": HOME}}, "result": {"farm": farm}})
            self.assertEqual(loop.home_for_world(state)["farm"], original)

    async def test_growing_field_yields_to_exploration_and_maturity_reopens_work(self):
        loop, state = self.loop_with_state()
        loop.note_home_farm(HOME, self.observed["farm"])
        state["farm_status"] = self.observed["growing"]
        self.assertFalse(state["farm_status"]["needs_work"])
        self.assertEqual((await loop._build_advice(state)).skill, "explore_nearby")
        state["farm_status"] = self.observed["mature"]
        self.assertEqual(state["farm_status"]["mature"], 4)
        self.assertEqual((await loop._build_advice(state)).skill, "tend_farm")
        state["food"] = 4
        self.assertEqual((await loop._build_advice(state)).skill, "eat")

    async def test_verified_empty_shelf_does_not_loop_predeparture_resupply(self):
        loop, state = self.loop_with_state(inventory={"iron_pickaxe": 1, "bread": 1})
        original = {"skill": "mine_ores", "params": {"ore": "iron", "count": 3}, "why": "original mining"}
        loop._set_plan([original])
        self.assertEqual((await loop._survival_step())["skill"], "resupply_food")
        loop._rule_supply_attempt = copy.deepcopy(loop._rule_supply_candidate)
        host = plugin(); host.life = loop; host.config["announce_task_done"] = False
        await host._on_task_finished({"kind": "skill", "status": "failed", "name": "回基地取食物",
            "meta": {"skill": "resupply_food"}, "result": {"ok": False, "home": HOME,
                "home_status": {**HOME_STATUS, "inside": True, "safe": True},
                "food_stock_checked": True, "food_stock_empty": True}})
        for _ in range(4):
            self.assertIsNone(await loop._survival_step())
        self.assertEqual(loop._plan, [original])
        self.assertEqual(loop._failure_counts(), {})

    async def test_unchanged_torch_success_is_bounded_and_does_not_unlock_work(self):
        loop, state = self.loop_with_state(inventory={"iron_pickaxe": 1, "bread": 8, "coal": 4, "stick": 4})
        original = {"skill": "mine_ores", "params": {"ore": "iron", "count": 3}, "why": "original mining"}
        loop._set_plan([original])
        for _ in range(2):
            self.assertEqual((await loop._survival_step())["skill"], "craft")
            loop._rule_supply_attempt = copy.deepcopy(loop._rule_supply_candidate)
            loop.note_task_result("craft", True)
        self.assertIsNone(await loop._survival_step())
        self.assertEqual(loop._rule_supply_stalls["craft"]["count"], 2)
        self.assertEqual(loop._plan, [])
        loop._failure_cooldowns["craft"] = 0
        loop._set_plan([original])
        self.assertIsNone(await loop._survival_step())
        self.assertEqual(loop._plan, [])

    def test_distant_or_failed_base_is_not_a_confirmed_predeparture_food_source(self):
        for home_status, failures in (({**HOME_STATUS, "distance": 100}, {}),
                                      (HOME_STATUS, {"resupply_food": 2})):
            with self.subTest(home_status=home_status, failures=failures):
                advice = advise({"iron_pickaxe": 1, "bread": 1}, home=HOME, home_status=home_status,
                    recent_failures=failures, next_work={"skill": "mine_ores", "params": {"ore": "iron"}})
                self.assertNotEqual(advice.priority, "survival", "a known but unusable shelf cannot trigger blind reserve hunting")


if __name__ == "__main__":
    unittest.main(verbosity=2)
