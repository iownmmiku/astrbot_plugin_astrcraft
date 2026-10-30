'use strict';
// Real farming/wood skill code; only game packets and physical movement are fixtures.
process.env.MC_ENGINE_LOG_LEVEL = 'error';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const { vec3, CancelledError } = require('../engine/util');
const { SkillContext } = require('../engine/skills/common');
const { Actions } = require('../engine/actions');
const { executionContext } = require('../engine/goals');
const farming = require('../engine/skills/farming');
const skills = require('../engine/skills');
const tests = [], test = (name, fn) => tests.push({ name, fn });
const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

function fixture(options = {}) {
  const counts = { wheat_seeds: 5, wooden_hoe: 1, ...options.inventory }, cells = new Map(), calls = [];
  const home = { server: 'fixture:25565', dimension: 'overworld', origin: { x: 0, y: 64, z: 0 }, size: 5, wall_height: 3 };
  const makeBlock = (name, p, props = {}) => ({ name, position: vec3(p.x, p.y, p.z),
    boundingBox: ['air', 'wheat', 'water', 'grass', 'tall_grass', 'short_grass'].includes(name) ? 'empty' : 'block',
    skyLight: options.dark ? 0 : 15, light: 0, getProperties: () => props });
  const put = (name, p, props) => cells.set(key(p), makeBlock(name, p, props));
  const water = { x: options.waterX ?? 9, y: 63, z: 2 };
  if (!options.noWater) put('water', water, { level: options.flowing ? 1 : 0 });
  for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) {
    put('cobblestone', { x, y: 63, z }); put('cobblestone', { x, y: 67, z });
    if (x === 0 || x === 4 || z === 0 || z === 4) for (let y = 64; y < 67; y++) put('cobblestone', { x, y, z });
  }
  if (options.grass) for (let z = -4; z <= 6; z++) put('short_grass', { x: 6, y: 64, z });
  const controller = new AbortController();
  const bot = new EventEmitter();
  bot.entity = { position: vec3(7.5, 64, 2.5), onGround: true };
  bot._client = new EventEmitter();
  Object.assign(bot._client, { state: 'play', socket: { remoteAddress: 'fixture', remotePort: 25565 } });
  Object.assign(bot, { game: { dimension: 'overworld' }, time: { timeOfDay: 1000 }, health: 20, food: 20,
    canSeeBlock: () => true, registry: { itemsByName: { wooden_hoe: { id: 1 } } } });
  let reads = 0;
  bot.blockAt = (p) => {
    reads++;
    if (options.unloaded || options.unloadedAt && key(p) === key(options.unloadedAt)) return null;
    return cells.get(key(p)) || makeBlock(p.y === 63 ? 'grass_block' : p.y < 63 ? 'stone' : 'air', p);
  };
  bot.findBlock = ({ matching }) => [...cells.values()].find((b) => typeof matching === 'function' ? matching(b) : false) || null;
  bot.activateBlock = async (soil) => {
    executionContext.getStore()?.preparationCheck?.();
    calls.push(['till', key(soil.position)]);
    assert.ok(['grass_block', 'dirt'].includes(soil.name)); assert.ok(bot.heldItem.name.endsWith('_hoe'));
    if (!options.rejectTill) put('farmland', soil.position, { moisture: 7 });
    if (options.abortTill) controller.abort();
  };
  bot.placeBlock = async (soil, face) => {
    executionContext.getStore()?.preparationCheck?.();
    assert.equal(soil.name, 'farmland'); assert.equal(face.y, 1); assert.equal(bot.heldItem.name, 'wheat_seeds');
    assert.ok(counts.wheat_seeds > 0); calls.push(['plant', key(soil.position)]);
    if (!options.rejectPlant) { counts.wheat_seeds--; put('wheat', soil.position.offset(0, 1, 0), { age: 0 }); }
    if (options.abortPlant) { options.abortPlant = false; controller.abort(); }
  };
  const actions = { bot, _config: { get: (name) => name === 'spawnProtectionRadius' ? options.protection || 0 : [] },
    inventoryMap: () => ({ ...counts }), countItem: (name) => counts[name] || 0,
    _raceAbort: Actions.prototype._raceAbort, stopCurrent() {},
    _spotInFront: () => ({ x: 7, y: 64, z: 7 }),
    _assertNotProtected(x, y, z, name) {
      calls.push(['protect', name]);
      if (options.protected) throw new Error('protected fixture');
      assert.ok(x < -1 || x > 5 || z < -1 || z > 5, 'home and walkway must remain intact');
    },
    async holdItem({ item }) {
      assert.ok(counts[item] > 0, `missing ${item}`);
      if (options.switchBody) { options.switchBody = false; bot.entity = { ...bot.entity }; }
      if (options.abortEquip) controller.abort();
      if (options.moveOnEquip) bot.entity.position = vec3(40, 64, 40);
      bot.heldItem = { name: item };
    },
    async craft({ item, count }) {
      executionContext.getStore()?.preparationCheck?.();
      calls.push(['craft', item]);
      if (item === 'oak_planks') { const n = Math.ceil(count / 4); assert.ok(counts.oak_log >= n); counts.oak_log -= n; counts.oak_planks = (counts.oak_planks || 0) + n * 4; }
      else if (item === 'stick') { assert.ok(counts.oak_planks >= 2); counts.oak_planks -= 2; counts.stick = (counts.stick || 0) + 4; }
      else if (item === 'crafting_table') { assert.ok(counts.oak_planks >= 4); counts.oak_planks -= 4; counts.crafting_table = 1; }
      else if (item === 'wooden_hoe') { assert.ok(counts.oak_planks >= 2 && counts.stick >= 2); counts.oak_planks -= 2; counts.stick -= 2; counts.wooden_hoe = 1; }
      else throw new Error(`unexpected craft ${item}`);
      return { ok: true, produced: count };
    },
    async place({ item, x, y, z }) { assert.ok(counts[item]); counts[item]--; put(item, { x, y, z }); return { ok: true }; },
    async dig(p) {
      executionContext.getStore()?.preparationCheck?.();
      const b = bot.blockAt(vec3(p.x, p.y, p.z)); calls.push(['dig', b.name]);
      if (b.name === 'wheat') { assert.equal(b.getProperties().age, 7); counts.wheat = (counts.wheat || 0) + 1; counts.wheat_seeds += options.noSeedDrop ? 0 : 2; }
      else { assert.ok(['short_grass', 'grass', 'tall_grass'].includes(b.name)); if (!options.noSeedDrop) counts.wheat_seeds++; }
      put('air', b.position);
      if (options.abortHarvest && b.name === 'wheat') { options.abortHarvest = false; controller.abort(); }
      return { block: b.name };
    },
  };
  const nav = { async goTo(p) {
    assert.equal(executionContext.getStore()?.allowTerrainDig, false);
    assert.equal(executionContext.getStore()?.allowTerrainPlace, false);
    calls.push(['move', p.x, p.z]);
    if (!options.noArrival) bot.entity.position = vec3(p.x, p.y, p.z);
  } };
  // Exercise the production before/after-await checks as well as fake server I/O.
  Actions.prototype._installControlGuards.call({ _bot: bot, _nav: nav, _guardWindow: Actions.prototype._guardWindow });
  const ctx = (signal = controller.signal) => new SkillContext({ signal, deadline: Date.now() + 10000 });
  const inspect = (farm = home.farm, plots = 4) => farming.inspectFarm({ actions, home, farm, plots });
  const scan = (farm = home.farm) => { let s; for (let i = 0; i < 20; i++) { s = inspect(farm); if (s.candidate_plots >= 4 || s.scan_complete) break; } return s; };
  const run = (farm = home.farm, signal = controller.signal, plots = 4) => skills.get('tend_farm').run({ actions, nav, ctx: ctx(signal),
    state: { nearbyEntities: () => [] }, params: { home, farm, plots } });
  const mature = (farm) => { for (const p of farm.plots) put('wheat', { ...p, y: p.y + 1 }, { age: 7 }); };
  return { actions, bot, home, counts, calls, cells, controller, options, inspect, scan, run, mature, put,
    get reads() { return reads; } };
}

test('natural terrain establishes four plots and two harvest/replant cycles retain real net food', async () => {
  const f = fixture({ grass: true, inventory: { wheat_seeds: 0, wooden_hoe: 0, oak_log: 4 } });
  assert.equal(f.scan().can_start, true);
  const built = await f.run(); assert.equal(built.ok, true, built.reason);
  assert.equal(built.farm.plots.length, 4); assert.ok(f.counts.wheat_seeds >= 1, 'keep one emergency replant seed');
  assert.ok(f.calls.some((call) => call[0] === 'craft' && call[1] === 'wooden_hoe'));
  for (let cycle = 0; cycle < 2; cycle++) {
    f.mature(built.farm);
    const harvest = await f.run(built.farm);
    assert.equal(harvest.ok, true, harvest.reason); assert.equal(harvest.produced.wheat, 4);
    assert.equal(harvest.farm_status.mature, 0); assert.equal(harvest.farm_status.planted, 4);
  }
  assert.equal(f.counts.wheat, 8);
});
test('immature farm reports waiting and never harvests seedlings', async () => {
  const f = fixture(); f.scan(); const result = await f.run();
  const st = f.inspect(result.farm); assert.equal(st.needs_work, false); assert.equal(st.can_start, false);
  assert.equal(st.mature, 0); assert.equal(st.planted, 4);
  assert.ok(st.scan_reads < 500, 'an established growing field does not scan the whole neighborhood');
});
test('empty inventory with no seed source does not turn soil', async () => {
  const f = fixture({ inventory: { wheat_seeds: 0, wooden_hoe: 0 } });
  assert.equal(f.scan().can_start, false); const result = await f.run();
  assert.equal(result.ok, false); assert.equal(f.calls.filter((c) => c[0] === 'till').length, 0);
});
test('a single seed without grass cannot authorize an empty field or repeat fruitless work', async () => {
  const f = fixture({ inventory: { wheat_seeds: 1 } });
  assert.equal(f.scan().can_start, false);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await f.run(); assert.equal(result.ok, false);
    assert.equal(result.farm_status.can_start, false); assert.equal(f.counts.wheat_seeds, 1);
  }
  assert.equal(f.calls.length, 0);
});
test('four available seeds establish three plots and keep the last seed for the next mature cycle', async () => {
  const f = fixture({ inventory: { wheat_seeds: 4 } }); f.scan();
  const partial = await f.run();
  assert.equal(partial.ok, false); assert.equal(partial.farm.plots.length, 3);
  assert.equal(partial.farm_status.planted, 3); assert.equal(f.counts.wheat_seeds, 1);
  assert.equal(f.scan(partial.farm).can_start, false);
  f.mature(partial.farm);
  assert.equal(f.inspect(partial.farm).can_start, true);
  const completed = await f.run(partial.farm);
  assert.equal(completed.ok, true, completed.reason); assert.equal(completed.produced.wheat, 3);
  assert.equal(completed.farm_status.planted, 4); assert.ok(f.counts.wheat_seeds >= 1);
});
test('low light, flowing water and absent water never authorize a farm', async () => {
  for (const option of [{ dark: true }, { flowing: true }, { noWater: true }]) {
    const f = fixture(option); assert.equal(f.scan().can_start, false);
    const result = await f.run(); assert.equal(result.ok, false); assert.equal(f.calls.length, 0);
  }
});
test('unloaded chunks remain unknown and bounded', async () => {
  const f = fixture({ unloaded: true }); const before = f.reads, st = f.inspect();
  assert.equal(st.condition, 'unknown'); assert.equal(st.can_start, false);
  assert.ok(f.reads - before <= farming.READ_BUDGET); assert.equal(st.scan_complete, false);
});
test('rotating snapshot search reaches distant source water without exceeding read budget', async () => {
  const f = fixture({ waterX: 23 }); let found = false;
  for (let i = 0; i < 20; i++) {
    const before = f.reads, st = f.inspect(); assert.ok(f.reads - before <= farming.READ_BUDGET);
    if (st.candidate_plots >= 4) { found = true; break; }
  }
  assert.equal(found, true);
});
test('an early unknown cell prevents a later scan batch claiming the whole area is unavailable', async () => {
  const f = fixture({ noWater: true, unloadedAt: { x: 2, y: 63, z: 2 } });
  for (let i = 0; i < 20; i++) {
    const st = f.inspect(); assert.equal(st.scan_complete, false); assert.notEqual(st.condition, 'unavailable');
  }
});
test('server rejected tilling is not reported as a planted farm', async () => {
  const f = fixture({ rejectTill: true }); f.scan(); const result = await f.run();
  assert.equal(result.ok, false); assert.equal(result.farm.plots.length, 0); assert.match(result.reason, /确认耕地/);
});
test('server rejected planting retains empty farmland for the next attempt', async () => {
  const f = fixture({ rejectPlant: true }); f.scan(); const result = await f.run();
  assert.equal(result.ok, false); assert.ok(result.farm.plots.length >= 1); assert.match(result.reason, /确认小麦/);
});
test('cancelled planting can be rediscovered without a result receipt', async () => {
  const f = fixture({ abortPlant: true }); f.scan(); await assert.rejects(f.run(), CancelledError);
  const resumed = await f.run(null, new AbortController().signal);
  assert.equal(resumed.ok, true, resumed.reason); assert.equal(resumed.farm_status.planted, 4);
});
test('cancelled harvest keeps the empty plot and replants on a fresh execution', async () => {
  const f = fixture(); f.scan(); const initial = await f.run(); f.mature(initial.farm); f.options.abortHarvest = true;
  await assert.rejects(f.run(initial.farm), CancelledError);
  const resumed = await f.run(initial.farm, new AbortController().signal);
  assert.equal(resumed.ok, true, resumed.reason); assert.equal(resumed.farm_status.planted, 4);
});
test('equipment cancellation and body replacement prevent tilling', async () => {
  for (const option of [{ abortEquip: true }, { switchBody: true }]) {
    const f = fixture(option); f.scan(); await assert.rejects(f.run(), CancelledError);
    assert.equal(f.calls.filter((c) => c[0] === 'till').length, 0);
  }
});
test('protected soil and failed navigation do not produce farming success', async () => {
  for (const option of [{ protected: true }, { noArrival: true }]) {
    const f = fixture(option); f.scan(); const result = await f.run();
    assert.equal(result.ok, false); assert.equal(f.calls.filter((c) => c[0] === 'till').length, 0);
  }
});
test('movement while equipping cannot send a late farming interaction out of reach', async () => {
  const f = fixture({ moveOnEquip: true }); f.scan(); const result = await f.run();
  assert.equal(result.ok, false); assert.equal(f.calls.filter((c) => c[0] === 'till').length, 0);
});
test('a hostile farm record never authorizes planting inside the home footprint', async () => {
  const f = fixture(); const forged = { kind: 'wheat', server: f.home.server, dimension: 'overworld',
    home_origin: f.home.origin, plots: [{ x: 2, y: 63, z: 2 }] };
  f.scan(forged); const result = await f.run(forged);
  assert.equal(result.ok, true, result.reason);
  assert.ok(result.farm.plots.every((p) => p.x < -1 || p.x > 5 || p.z < -1 || p.z > 5));
  assert.equal(f.bot.blockAt(vec3(2, 63, 2)).name, 'cobblestone');
});
test('foreign world farm records cannot authorize another world', async () => {
  const f = fixture(); f.home.server = 'other:25565';
  assert.equal(f.inspect().condition, 'other_world'); await assert.rejects(f.run(), /当前主世界/);
  assert.equal(f.calls.length, 0);
});
test('night and unknown or out-of-range time stop outdoor work', async () => {
  for (const time of [18000, -1, 24000, NaN]) {
    const f = fixture(); f.scan(); f.bot.time.timeOfDay = time;
    const result = await f.run(); assert.equal(result.ok, false); assert.equal(f.calls.length, 0);
  }
});
test('every mature harvest reserves a seed even when random drops contain none', async () => {
  const f = fixture({ noSeedDrop: true }); f.scan(); const built = await f.run(); f.mature(built.farm);
  f.counts.wheat_seeds = 0; const result = await f.run(built.farm);
  assert.equal(result.ok, false); assert.equal(result.farm_status.mature, 4);
  assert.equal(f.calls.filter((c) => c[0] === 'dig').length, 0);
});
test('zero seed drops preserve recoverable empty farmland and the final seed without claiming completion', async () => {
  const f = fixture({ noSeedDrop: true }); f.scan(); const built = await f.run(); f.mature(built.farm);
  assert.equal(f.counts.wheat_seeds, 1);
  const harvested = await f.run(built.farm);
  assert.equal(harvested.ok, false); assert.equal(harvested.farming_complete, false);
  assert.equal(harvested.produced.wheat, 4); assert.equal(f.counts.wheat_seeds, 1);
  assert.equal(harvested.farm.plots.length, 4); assert.equal(harvested.farm_status.empty, 4);
  assert.equal(harvested.farm_status.can_start, false);
  f.counts.wheat_seeds = 5;
  const resumed = await f.run(harvested.farm);
  assert.equal(resumed.ok, true, resumed.reason); assert.equal(f.counts.wheat_seeds, 1);
});

(async () => {
  let passed = 0, failed = 0;
  const started = performance.now();
  for (const { name, fn } of tests) {
    try { await fn(); console.log(`PASS ${name}`); passed++; }
    catch (err) { console.error(`FAIL ${name}: ${err.stack}`); failed++; }
  }
  console.log(`结果：${passed} 通过，${failed} 失败；${Math.round(performance.now() - started)}ms`);
  process.exitCode = failed ? 1 : 0;
})();
