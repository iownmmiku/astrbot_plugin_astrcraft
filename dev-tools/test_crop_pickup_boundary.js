'use strict';
// Exercise the real dig / pickup / replant chain. Only server packets and
// navigation are replaced; a far unrelated drop must not widen emergency work.
process.env.MC_ENGINE_LOG_LEVEL = 'error';
const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const { Actions } = require('../engine/actions');
const { harvestCrops } = require('../engine/skills/wood');
const { SkillContext } = require('../engine/skills/common');
const { vec3, delay, CancelledError } = require('../engine/util');
const tests = [], test = (name, run) => tests.push({ name, run });
const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

function field(options = {}) {
  const counts = { ...options.inventory }, cells = new Map(), moves = [], packets = [], timers = [];
  const block = (name, p, age = 0) => ({ name, position: p, diggable: true,
    boundingBox: ['air', 'wheat'].includes(name) ? 'empty' : 'block', getProperties: () => ({ age }) });
  const crop = vec3(options.near ? 0 : 2, 65, 0);
  cells.set(key(crop), block('wheat', crop, 7));
  cells.set(key(crop.offset(0, -1, 0)), block('farmland', crop.offset(0, -1, 0)));
  const grantCrop = () => {
    counts.wheat = (counts.wheat || 0) + 1;
    counts.wheat_seeds = (counts.wheat_seeds || 0) + 1;
    delete bot.entities[1];
  };
  const bot = {
    entity: { position: vec3(0.5, 65, 0.5), onGround: true, velocity: vec3(0, 0, 0) }, health: 5, food: 5,
    _client: { state: 'play', socket: { remoteAddress: 'fixture', remotePort: 25565 } }, game: { dimension: 'overworld' },
    inventory: { items: () => Object.entries(counts).filter(([, count]) => count > 0).map(([name, count]) => ({ name, count })) },
    entities: { 99: { id: 99, name: 'item', position: vec3(12, 65, 0) } }, canSeeBlock: () => true,
    blockAt: (p) => cells.get(key(p)) || block(p.y < 65 ? 'stone' : 'air', p),
    findBlocks: ({ matching, useExtraInfo, maxDistance }) => [...cells.values()]
      .filter((b) => matching(b) && useExtraInfo(b) && (options.ignoreScanRadius || b.position.distanceTo(bot.entity.position) <= maxDistance))
      .map((b) => b.position),
    canDigBlock: () => true, async lookAt() {}, stopDigging() {},
    async dig(b) {
      packets.push({ kind: 'dig', position: b.position.clone() }); cells.delete(key(b.position));
      if (options.noPickup || options.delayedPickup) {
        bot.entities[1] = { id: 1, name: 'item', position: options.near ? vec3(0.6, 65, 0.5) : crop.clone() };
        if (options.delayedPickup) timers.push(setTimeout(grantCrop, 600));
      } else grantCrop();
      if (options.moveAfterDig) bot.entity.position = vec3(10, 65, 0);
    },
    async placeBlock(soil, face) {
      packets.push({ kind: 'plant', position: soil.position.plus(face) });
      assert.ok(counts.wheat_seeds > 0); counts.wheat_seeds--;
      cells.set(key(soil.position.plus(face)), block('wheat', soil.position.plus(face)));
    },
  };
  const nav = { async goTo(p) {
    moves.push({ x: p.x, y: p.y, z: p.z }); bot.entity.position = vec3(p.x, p.y ?? 65, p.z);
    if (p.x === 12) { delete bot.entities[99]; counts.coal = (counts.coal || 0) + 1; }
    if (bot.entities[1] && bot.entity.position.distanceTo(bot.entities[1].position) <= 0.6) grantCrop();
    return { arrived: true };
  } };
  const actions = new Actions({ bot, navigator: nav, config: { get: (name) => name === 'humanize' ? false : undefined } });
  actions.holdItem = async ({ item }) => {
    bot.heldItem = { name: item };
    if (options.moveDuringHold) bot.entity.position = vec3(10, 65, 0);
  };
  const context = (extra = {}) => new SkillContext({ deadline: Date.now() + 6000, ...extra });
  return { bot, actions, nav, counts, moves, packets, crop, context,
    run: (params = {}, ctx = context()) => harvestCrops({ actions, nav, ctx,
      itemName: 'wheat', count: 1, radius: 3, maxAttempts: 2, allowSearch: false, ...params }),
    cleanup: () => timers.forEach(clearTimeout) };
}

test('reach-only harvest ignores a far unrelated item through real dig and pickup', async () => {
  const f = field(); const origin = f.bot.entity.position.clone();
  try {
    const result = await f.run();
    assert.equal(result.ok, true); assert.equal(result.replant_ok, true);
    assert.deepEqual(result.produced, { wheat: 1 });
    assert.deepEqual(f.packets.map(({ kind }) => kind), ['dig', 'plant']);
    assert.deepEqual(f.moves, []); assert.deepEqual(f.bot.entity.position, origin);
    assert.ok(f.bot.entities[99]); assert.equal(f.counts.coal, undefined);
  } finally { f.cleanup(); }
});

test('reach-only pickup waits for actual delayed near-body inventory confirmation', async () => {
  const f = field({ near: true, delayedPickup: true });
  try {
    const result = await f.run();
    assert.equal(result.ok, true); assert.equal(result.replant_ok, true);
    assert.deepEqual(result.produced, { wheat: 1 });
    assert.deepEqual(f.moves, []); assert.ok(f.bot.entities[99]); assert.equal(f.bot.entities[1], undefined);
  } finally { f.cleanup(); }
});

test('breaking a crop without physical pickup cannot report food collected', async () => {
  const f = field({ noPickup: true, inventory: { wheat_seeds: 1 } });
  try {
    const result = await f.run();
    assert.equal(result.ok, false); assert.equal(result.collection_ok, false); assert.equal(result.replant_ok, true);
    assert.deepEqual(result.produced, {}); assert.equal(f.actions.countItem('wheat'), 0);
    assert.deepEqual(f.moves, []); assert.ok(f.bot.entities[1]);
  } finally { f.cleanup(); }
});

test('an unpicked seed leaves the real planting obligation without walking for it', async () => {
  const f = field({ noPickup: true });
  try {
    const result = await f.run();
    assert.equal(result.ok, false); assert.equal(result.collection_ok, false); assert.equal(result.replant_ok, false);
    assert.deepEqual(result.pending_replant, [{ x: 2, y: 65, z: 0 }]);
    assert.deepEqual(f.moves, []); assert.deepEqual(f.packets.map(({ kind }) => kind), ['dig']);
  } finally { f.cleanup(); }
});

for (const option of ['moveAfterDig', 'moveDuringHold']) {
  test(`reach-only replant never navigates after ${option}`, async () => {
    const f = field({ [option]: true });
    try {
      const result = await f.run();
      assert.equal(result.ok, false); assert.equal(result.collection_ok, true); assert.equal(result.replant_ok, false);
      assert.deepEqual(result.pending_replant, [{ x: 2, y: 65, z: 0 }]);
      assert.deepEqual(f.moves, []); assert.deepEqual(f.packets.map(({ kind }) => kind), ['dig']);
    } finally { f.cleanup(); }
  });
}

test('reach-only harvest rechecks actual distance even if the scan ignores its radius', async () => {
  const f = field({ ignoreScanRadius: true }); f.bot.entity.position = vec3(8, 65, 0);
  try {
    const result = await f.run(); assert.equal(result.ok, false);
    assert.deepEqual(f.moves, []); assert.deepEqual(f.packets, []);
  } finally { f.cleanup(); }
});

for (const params of [{ radius: 6 }, { allowSearch: true }]) {
  test(`ordinary crop pickup retains movement with ${JSON.stringify(params)}`, async () => {
    const f = field();
    try {
      const result = await f.run(params); assert.equal(result.ok, true);
      assert.deepEqual(f.moves.map(({ x }) => x), [12, 2]);
      assert.deepEqual(result.produced, { wheat: 1, coal: 1 });
    } finally { f.cleanup(); }
  });
}

test('stationary pickup remains cancellable during its bounded late-spawn wait', async () => {
  const f = field(), controller = new AbortController(); f.bot.entities = {};
  try {
    const waiting = f.actions.collectDrops({ allowMovement: false, expectIncrease: true, timeoutMs: 1600, signal: controller.signal });
    await delay(425); controller.abort();
    await assert.rejects(waiting, CancelledError);
    assert.deepEqual(f.moves, []); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  } finally { controller.abort(); f.cleanup(); }
});

(async () => {
  let failed = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (err) { failed++; console.error(`FAIL ${name}: ${err.stack || err}`); }
  }
  console.log(`${tests.length - failed}/${tests.length} crop pickup boundary cases passed`);
  process.exitCode = failed ? 1 : 0;
})();
