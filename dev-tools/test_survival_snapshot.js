'use strict';
const assert = require('node:assert/strict');
const { survivalSnapshot } = require('../engine/survival_snapshot');
const building = require('../engine/skills/building');
const farming = require('../engine/skills/farming');
const { McEngine } = require('../engine/bot');

async function main() {
  let passed = 0;
  const counts = { bread: 4 };
  const engine = { _bodyLifecycle: 2, bot: { inventory: { slots: [
    { name: 'stone_pickaxe', count: 1, maxDurability: 100, durabilityUsed: 25 }] } },
    actions: { inventoryMap: () => ({ ...counts }) },
    state: { snapshot: () => ({ connected: true, ready: true, health: 0, food: 0,
      server: 'test:25566', dimension: 'minecraft:overworld' }) } };
  const first = survivalSnapshot(engine);
  assert.equal(first.health, 0); assert.equal(first.food, 0);
  assert.deepEqual(first.inventory_items, { bread: 4 });
  assert.equal(first.inventory_slots[0].durability_pct, 75);
  assert.equal(first.lifecycle_id, 2); assert.ok(first.observation_ms >= 0); passed++;
  counts.bread = 1;
  assert.equal(survivalSnapshot(engine).inventory_items.bread, 1);
  assert.equal(first.inventory_items.bread, 4); passed++;
  engine._bodyTransition = {};
  assert.deepEqual(Object.keys(survivalSnapshot(engine)).sort(), ['connected', 'lifecycle_id', 'observed_at', 'ready']);
  engine._bodyTransition = null; passed++;
  const homeInspect = building.inspectHome, farmInspect = farming.inspectFarm;
  const used = [];
  try {
    building.inspectHome = ({ home }) => { used.push(home.origin.x); return { condition: 'intact', safe: false }; };
    farming.inspectFarm = ({ farm }) => ({ loaded: true, mature: farm?.mature || 0 });
    const homes = [{ server: 'other:25566', dimension: 'overworld', origin: { x: 99 }, verified_at: 999 },
      { server: 'test:25566', dimension: 'overworld', origin: { x: 1 }, verified_at: 1 },
      { server: 'test:25566', dimension: 'overworld', origin: { x: 2 }, verified_at: 2, farm: { mature: 3 } }];
    const next = survivalSnapshot(engine, homes);
    assert.deepEqual(used, [2]); assert.equal(next.farm_status.mature, 3); assert.equal(next.home_status.safe, false); passed++;
  } finally { building.inspectHome = homeInspect; farming.inspectFarm = farmInspect; }
  try {
    const home = { server: 'test:25566', dimension: 'overworld', verified_at: 1,
      origin: { x: 0, y: 64, z: 0 }, size: 5, wall_height: 3,
      door_position: { x: 'bad', y: 65, z: 0 } };
    // Real building validation rejects the bad door; farm inspection stays independent.
    farming.inspectFarm = () => ({ loaded: true, mature: 2 });
    const damaged = survivalSnapshot(engine, [home]);
    assert.equal(damaged.home_status.condition, 'unknown');
    assert.match(damaged.home_status.reason, /基地门坐标无效/);
    assert.equal(damaged.home_status.safe, false);
    assert.equal(damaged.health, 0); assert.equal(damaged.inventory_items.bread, 1);
    assert.equal(damaged.farm_status.mature, 2); passed++;
    building.inspectHome = () => ({ condition: 'intact', loaded: true, safe: true });
    farming.inspectFarm = () => { throw new Error('unavailable farm'); };
    const unavailable = survivalSnapshot(engine, [home]);
    assert.equal(unavailable.home_status.safe, true);
    assert.equal(unavailable.farm_status.condition, 'unknown');
    assert.equal(unavailable.farm_status.can_start, false);
    assert.equal(unavailable.food, 0); assert.equal(unavailable.inventory_items.bread, 1); passed++;
  } finally { building.inspectHome = homeInspect; farming.inspectFarm = farmInspect; }
  // Exercise the production queue callback: metrics must get an actual start notice.
  const events = [], live = new McEngine({ emit: (event, data) => events.push({ event, data }) });
  const task = live.queue.submit({ name: 'offline completed work', kind: 'skill', run: async () => ({ ok: true }) });
  await task.promise;
  const start = events.find(e => e.event === 'task.started'), end = events.find(e => e.event === 'task.finished');
  assert.ok(start && end); assert.equal(start.data.task_id, end.data.task_id);
  assert.equal(start.data.status, 'running'); assert.equal(start.data.kind, 'skill');
  assert.ok(start.data.started_at > 0); passed++;
  console.log(`结果：${passed} 通过，0 失败`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
