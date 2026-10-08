'use strict';
// Real crop selection, inventory contracts and interruption checkpoints;
// only Minecraft I/O is replaced by a deterministic field.
process.env.MC_ENGINE_LOG_LEVEL = 'error';
const assert = require('node:assert/strict');
const { SkillContext, isUnderground } = require('../engine/skills/common');
const { inspectReturnSafety } = require('../engine/skills/mining_return');
const { vec3, CancelledError } = require('../engine/util');
const { executionContext } = require('../engine/goals');
const { Actions } = require('../engine/actions');
const wood = require('../engine/skills/wood');
const gathering = require('../engine/skills/gathering');
const tests = [], test = (name, run) => tests.push({ name, run });
const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

function field(item = 'wheat', age = wood.CROPS[item].age, options = {}) {
  const spec = wood.CROPS[item], counts = { ...options.inventory }, cells = new Map(), calls = [];
  const controller = new AbortController(), checkpoints = new Map();
  const block = (name, p, props = {}) => ({ name, position: p, diggable: true,
    boundingBox: ['air', spec.block].includes(name) ? 'empty' : 'block', getProperties: () => props });
  const position = vec3(options.far ? 10 : 2, 65, 0);
  cells.set(key(position), block(spec.block, position, age === null ? {} : { age }));
  cells.set(key(position.offset(0, -1, 0)), block('farmland', position.offset(0, -1, 0)));
  const bot = { entity: { position: vec3(0.5, 65, 0.5), onGround: true, velocity: vec3(0, 0, 0) },
    _client: { state: 'play', socket: { remoteAddress: 'fixture', remotePort: 25565 } },
    game: { dimension: 'overworld' }, health: 20, food: 20, canSeeBlock: () => true,
    blockAt: (p) => cells.get(key(p)) || block(p.y < 65 ? 'stone' : 'air', p),
    findBlocks: ({ matching, useExtraInfo }) => [...cells.values()].filter((b) =>
      matching(b) && useExtraInfo(b)).map((b) => b.position),
    async placeBlock(soil, face) {
      calls.push({ kind: 'plant', item: bot.heldItem?.name });
      if (options.rejected) return;
      assert.equal(soil.name, 'farmland'); assert.equal(face.y, 1);
      assert.ok(counts[spec.seed] >= 1);
      counts[spec.seed]--;
      cells.set(key(soil.position.plus(face)), block(spec.block, soil.position.plus(face), { age: 0 }));
    },
  };
  const actions = { bot, inventoryMap: () => ({ ...counts }), countItem: (name) => counts[name] || 0,
    _raceAbort: Actions.prototype._raceAbort, stopCurrent() {},
    async holdItem({ item: name }) { bot.heldItem = { name }; },
    async dig(params) {
      if (options.abortBeforeDig) {
        options.abortBeforeDig = false; controller.abort(); throw new CancelledError('cancelled before harvest packet');
      }
      if (options.changeBeforeDig) cells.set(key(position), block(spec.block, position, { age: 0 }));
      executionContext.getStore()?.preparationCheck?.();
      calls.push({ kind: 'dig', ...params });
      const actual = cells.get(key(params)); assert.ok(actual); assert.equal(actual.name, spec.block);
      assert.equal(actual.getProperties().age, spec.age, 'only mature crops may be dug');
      cells.delete(key(params));
      counts[item] = (counts[item] || 0) + (item === spec.seed ? 3 : 1);
      if (item !== spec.seed && !options.noSeed) counts[spec.seed] = (counts[spec.seed] || 0) + 1;
      if (options.abortAfterDig) controller.abort();
      if (options.throwAfterDig) { controller.abort(); throw new CancelledError('cancelled after server accepted harvest'); }
      return { block: spec.block };
    },
  };
  const nav = { async goTo(params) {
    calls.push({ kind: 'nav', ...params, allowTerrainDig: executionContext.getStore()?.allowTerrainDig });
    if (options.changeOnApproach) cells.set(key(position), block(spec.block, position, { age: 0 }));
    bot.entity.position = vec3(params.x, params.y === null ? 65 : params.y, params.z);
    return { arrived: true };
  } };
  const context = (signal = controller.signal) => new SkillContext({ signal, checkpoints, deadline: Date.now() + 10000 });
  return { bot, actions, nav, counts, calls, cells, position, checkpoints, controller, context,
    collect: (ctx = context(), extra = {}) => gathering.collect({ actions, nav, ctx, item, count: 1, maxAttempts: 1, ...extra }) };
}

for (const item of Object.keys(wood.CROPS)) {
  test(`${item}: leave immature plants intact`, async () => {
    const f = field(item, wood.CROPS[item].age - 1); const result = await f.collect();
    assert.equal(result.ok, false); assert.equal(f.calls.filter((c) => c.kind === 'dig').length, 0);
    assert.equal(f.cells.get(key(f.position)).name, wood.CROPS[item].block);
    assert.equal(f.calls[0]?.allowTerrainDig, false);
  });
  test(`${item}: mature harvest reserves seed and confirms a new plant`, async () => {
    const f = field(item); const result = await f.collect();
    assert.equal(result.ok, true); assert.equal(result.replant_ok, true);
    assert.equal(f.counts[item], ['carrot', 'potato'].includes(item) ? 2 : 1);
    assert.equal(f.cells.get(key(f.position)).getProperties().age, 0);
    assert.equal(f.calls.filter((c) => c.kind === 'dig').length, 1);
    assert.equal(f.calls.filter((c) => c.kind === 'plant').length, 1);
  });
}
test('missing maturity data never permits a harvest', async () => {
  const f = field('wheat', null); await f.collect();
  assert.equal(f.calls.filter((c) => c.kind === 'dig').length, 0);
});
test('maturity is checked again after walking to the field', async () => {
  const f = field('wheat', 7, { far: true, changeOnApproach: true }); await f.collect();
  assert.equal(f.calls.filter((c) => c.kind === 'dig').length, 0);
  assert.equal(f.calls[0].allowTerrainDig, false);
});
test('the native action scope refuses a young crop installed during equipment awaits', async () => {
  const f = field('wheat', 7, { changeBeforeDig: true }); const result = await f.collect();
  assert.equal(result.ok, false); assert.equal(f.calls.filter((c) => c.kind === 'dig').length, 0);
  assert.equal(f.cells.get(key(f.position)).getProperties().age, 0);
});
test('a refused replant cannot report success merely because wheat was obtained', async () => {
  const f = field('wheat', 7, { rejected: true }); const result = await f.collect();
  assert.equal(result.ok, false); assert.equal(result.collection_ok, true); assert.equal(result.replant_ok, false);
  assert.equal(result.produced.wheat, 1); assert.equal(result.pending_replant.length, 1);
});
test('no seeds reports the pending field position and keeps the actual harvest', async () => {
  const f = field('wheat', 7, { noSeed: true }); const result = await f.collect();
  assert.equal(result.ok, false); assert.match(result.reason, /wheat_seeds/);
  assert.equal(result.produced.wheat, 1); assert.equal(result.pending_replant.length, 1);
});
test('preempted harvest replants on replay even when inventory is already sufficient', async () => {
  const f = field('wheat', 7, { abortAfterDig: true }); await assert.rejects(f.collect(), CancelledError);
  assert.equal(f.counts.wheat, 1); assert.equal(f.cells.has(key(f.position)), false);
  const result = await f.collect(f.context(new AbortController().signal));
  assert.equal(result.ok, true); assert.equal(f.calls.filter((c) => c.kind === 'dig').length, 1);
  assert.equal(f.cells.get(key(f.position)).getProperties().age, 0);
});
test('a cancelled dig acknowledgement retains the obligation to replant on replay', async () => {
  const f = field('wheat', 7, { throwAfterDig: true }); await assert.rejects(f.collect(), CancelledError);
  const result = await f.collect(f.context(new AbortController().signal));
  assert.equal(result.ok, true); assert.equal(f.calls.filter((c) => c.kind === 'dig').length, 1);
  assert.equal(f.cells.get(key(f.position)).getProperties().age, 0);
});
test('cancellation before harvesting does not count the untouched crop as a new planting', async () => {
  const f = field('wheat', 7, { abortBeforeDig: true }); await assert.rejects(f.collect(), CancelledError);
  const result = await f.collect(f.context(new AbortController().signal));
  assert.equal(result.ok, true); assert.equal(f.calls.filter((c) => c.kind === 'plant').length, 1);
  assert.equal(result.steps.filter((step) => step.startsWith('已确认补种')).length, 1);
});
test('surface search never delegates to downward mining and cannot count claimed motion', async () => {
  const f = field('wheat', 0); f.nav.goTo = async (params) => {
    assert.equal(params.y, null); assert.equal(executionContext.getStore().allowTerrainDig, false);
    return { arrived: true };
  };
  const result = await f.collect(); assert.equal(result.ok, false); assert.equal(f.calls.length, 0);
});
test('a target already in inventory does not destroy or seek more plants', async () => {
  const f = field('wheat', 7, { inventory: { wheat: 5 } }); const result = await f.collect();
  assert.equal(result.ok, true); assert.equal(f.calls.length, 0);
});

function terrain(kind, y = 65) {
  const bot = { entity: { position: vec3(0.5, y, 0.5), onGround: true, velocity: vec3(0, 0, 0) },
    _client: { state: 'play', socket: { remoteAddress: 'fixture', remotePort: 25565 } },
    game: { dimension: 'overworld' },
    blockAt(p) {
      const x = Math.floor(p.x), z = Math.floor(p.z);
      if (kind === 'unknown' && (Math.abs(x) > 3 || Math.abs(z) > 3)) return null;
      const tree = kind === 'forest' && (Math.abs(x) === 12 && z === 0 || Math.abs(z) === 12 && x === 0) && p.y >= 65 && p.y <= 74;
      const slope = kind === 'slope' && x >= 6 && p.y <= 69;
      const valley = kind.startsWith('valley') && (x >= 6 || Math.abs(z) >= 6) && p.y <= 69;
      if (kind === 'valley-unknown' && x === -4 && z === 0) return null;
      const escapeBlock = kind === 'valley-wall' && x === -3 && z === 0 && p.y >= 65 && p.y <= 66;
      const escapeFluid = kind === 'valley-fluid' && x === -2 && z === 0 && p.y === 65;
      const rim = ['shaft', 'wide'].includes(kind) && (Math.abs(x) > (kind === 'wide' ? 8 : 0) || Math.abs(z) > (kind === 'wide' ? 8 : 0)) && p.y <= 70;
      const ceiling = kind === 'roof' && p.y >= 67 && p.y <= 70 || kind === 'valley-roof' && p.y === 73;
      const solid = p.y <= 64 || tree || slope || valley || rim || ceiling || escapeBlock;
      return { name: escapeFluid ? 'water' : tree ? (p.y >= 72 ? 'oak_leaves' : 'oak_log') : solid ? 'stone' : 'air',
        position: p, boundingBox: solid ? 'block' : 'empty', getProperties: () => ({}) };
    } };
  return bot;
}
for (const kind of ['flat', 'forest', 'slope', 'valley']) {
  test(`${kind}: loaded stable surface remains a safe return position`, () => {
    const bot = terrain(kind); assert.equal(isUnderground(bot), false); assert.equal(inspectReturnSafety(bot).safe, true);
  });
}
for (const kind of ['valley-unknown', 'valley-wall', 'valley-fluid', 'valley-roof']) {
  test(`${kind}: an unsafe or covered corridor cannot prove an open surface`, () => {
    assert.equal(isUnderground(terrain(kind)), true);
  });
}
for (const kind of ['shaft', 'wide', 'roof']) {
  test(`${kind}: still requires climbing despite loaded support and clear feet`, () => {
    const bot = terrain(kind); assert.equal(isUnderground(bot), true); assert.equal(inspectReturnSafety(bot).safe, false);
  });
}
test('a broad pit stays underground until standing on the actual rim', () => {
  assert.equal(isUnderground(terrain('wide', 70)), true);
  assert.equal(isUnderground(terrain('wide', 71)), false);
});
test('unknown surrounding chunks cannot verify a safe surface', () => {
  const safety = inspectReturnSafety(terrain('unknown'));
  assert.equal(safety.loaded, false); assert.equal(safety.safe, false);
});

(async () => {
  let failed = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (err) { failed++; console.error(`FAIL ${name}: ${err.stack || err}`); }
  }
  console.log(`${tests.length - failed}/${tests.length} crop and terrain cases passed`);
  process.exitCode = failed ? 1 : 0;
})();
