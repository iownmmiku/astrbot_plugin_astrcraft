#!/usr/bin/env node
'use strict';

// Real mineflayer bed plugin, local server events and recorded packets only.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Actions } = require('../engine/actions');
const { executionContext } = require('../engine/goals');
const { vec3, delay, CancelledError } = require('../engine/util');
const { Config } = require('../engine/config');
const { SkillContext } = require('../engine/skills/common');
const { returnHome } = require('../engine/skills/building');
const injectBed = require('../engine/node_modules/mineflayer/lib/plugins/bed');
const registry = require('../engine/node_modules/prismarine-registry')('1.20.4');
const Block = require('../engine/node_modules/prismarine-block')(registry);

const tests = [];
const test = (name, run) => tests.push({ name, run });

function fixture({ wake = null } = {}) {
  const bot = new EventEmitter();
  const packets = [];
  const bed = Block.fromProperties('red_bed', { facing: 'south', occupied: false, part: 'head' }, 0);
  bed.position = vec3(0, 64, 0);
  Object.assign(bot, {
    version: '1.20.4', registry,
    supportFeature: (name) => registry.supportFeature(name),
    _client: new EventEmitter(), entity: { id: 8, position: vec3(0.5, 64, 0.5) },
    game: { dimension: 'overworld', gameMode: 'survival' }, time: { timeOfDay: 13000 },
    entities: {}, health: 20, isAlive: true, inventory: { items: () => [] },
    findBlock: () => bed, blockAt: () => bed, canDigBlock: () => true,
    setControlState() {}, clearControlStates() {}, stopDigging() {}, deactivateItem() {},
  });
  bot._client.write = (name, data) => {
    packets.push({ name, data });
    if (name === 'entity_action' && data.actionId === 2) setImmediate(() => bot.emit('entityWake', bot.entity));
  };
  injectBed(bot);
  if (wake) bot.wake = () => wake(bot);
  const sleep = () => bot.emit('entitySleep', bot.entity);
  const awake = (time) => {
    if (time !== undefined) bot.time.timeOfDay = time;
    bot.emit('entityWake', bot.entity);
  };
  bot.activateBlock = () => setImmediate(sleep);
  let stopped = 0;
  const nav = { stop() { stopped += 1; }, goTo: async () => {} };
  const config = new Config();
  const actions = new Actions({ bot, config, navigator: nav });
  const wakes = () => packets.filter((p) => p.name === 'entity_action' && p.data.actionId === 2);
  return { bot, bed, packets, sleep, awake, actions, nav, config, wakes, stopped: () => stopped };
}

async function until(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('fixture did not reach expected state');
    await delay(1);
  }
}

test('a complete native sleep/wake before promise resumption confirms dawn', async () => {
  const f = fixture();
  f.bot.activateBlock = () => { f.sleep(); f.awake(0); };
  const result = await f.actions.sleepInBed({ timeoutMs: 200 });
  assert.equal(result.ok, true);
  assert.equal(result.slept, true);
  assert.equal(result.day_confirmed, true);
  assert.equal(result.woke_at, 0);
  assert.equal(f.wakes().length, 0);
  assert.equal(f.actions._sleepSession, null);
});

test('wake preceding the time packet waits briefly for actual dawn', async () => {
  const f = fixture();
  f.bot.activateBlock = () => { f.sleep(); f.awake(); setTimeout(() => { f.bot.time.timeOfDay = 0; }, 15); };
  const result = await f.actions.sleepInBed({ timeoutMs: 200 });
  assert.equal(result.ok, true);
  assert.equal(result.woke_at, 0);
});

test('being woken in the night never reports a successful night skip', async () => {
  const f = fixture();
  f.bot.activateBlock = () => { f.sleep(); f.awake(); };
  const start = Date.now();
  const result = await f.actions.sleepInBed({ timeoutMs: 40 });
  assert.equal(result.ok, false);
  assert.equal(result.slept, true);
  assert.equal(result.day_confirmed, false);
  assert.match(result.note, /尚未确认天亮/);
  assert(Date.now() - start < 200);
});

test('an absent server clock after waking is not treated as time zero', async () => {
  for (const value of [undefined, null, '', NaN]) {
    const f = fixture();
    f.bot.activateBlock = () => { f.sleep(); f.awake(); f.bot.time = { timeOfDay: value }; };
    const result = await f.actions.sleepInBed({ timeoutMs: 20 });
    assert.equal(result.ok, false);
    assert.equal(result.day_confirmed, false);
    assert.equal(result.woke_at, null);
  }
});

test('a sub-second budget bounds sleep and requests wake without claiming its acknowledgement', async () => {
  const f = fixture();
  const start = Date.now();
  const result = await f.actions.sleepInBed({ timeoutMs: 30 });
  assert(Date.now() - start < 200);
  assert.equal(result.ok, false);
  assert.equal(result.timed_out, true);
  assert.equal(result.slept, true);
  assert.equal(result.day_confirmed, false);
  assert.equal(f.wakes().length, 1);
  await until(() => !f.bot.isSleeping);
});

test('already sleeping is awaited and can be cancelled instead of immediately succeeding', async () => {
  const f = fixture(); f.sleep();
  const controller = new AbortController();
  const run = f.actions.sleepInBed({ signal: controller.signal, timeoutMs: 200 });
  controller.abort();
  await assert.rejects(run, CancelledError);
  assert.equal(f.wakes().length, 1);
  await until(() => !f.bot.isSleeping);
});

test('cancellation on the native sleep event remains CancelledError and wakes once', async () => {
  const f = fixture();
  const controller = new AbortController();
  f.bot.once('sleep', () => controller.abort());
  await assert.rejects(f.actions.sleepInBed({ signal: controller.signal, timeoutMs: 200 }), CancelledError);
  assert.equal(f.wakes().length, 1);
  await until(() => !f.bot.isSleeping);
  assert.equal(executionContext.getStore(), undefined);
});

test('setStopped alone interrupts the wait and wakes the current owned body', async () => {
  const f = fixture();
  const run = f.actions.sleepInBed({ timeoutMs: 200 });
  await until(() => f.bot.isSleeping);
  f.actions.setStopped(true);
  f.actions.stopCurrent();
  await assert.rejects(run, CancelledError);
  assert.equal(f.wakes().length, 1);
  await until(() => !f.bot.isSleeping);
});

test('a bed request accepted after cancellation is cleaned up before allowing another sleep', async () => {
  const f = fixture();
  f.bot.activateBlock = () => {};
  const controller = new AbortController();
  const run = f.actions.sleepInBed({ signal: controller.signal, timeoutMs: 200 });
  await until(() => f.actions._sleepSession?.requestPending);
  controller.abort();
  await assert.rejects(run, CancelledError);
  assert.equal(f.wakes().length, 0);
  const other = await f.actions.sleepInBed({ timeoutMs: 200 });
  assert.equal(other.ok, false);
  assert.equal(other.already, true);
  f.sleep();
  await until(() => f.actions._sleepSession === null);
  assert.equal(f.wakes().length, 1);
  await until(() => !f.bot.isSleeping);
});

for (const transition of ['same-dimension native respawn', 'dimension change', 'entity replacement', 'old connection end']) {
  test(`${transition} invalidates cleanup before emergency stop can wake a new body`, async () => {
    const f = fixture();
    f.bot.on('respawn', () => f.actions.stopCurrent());
    const run = f.actions.sleepInBed({ timeoutMs: 200 });
    await until(() => f.bot.isSleeping);
    if (transition === 'dimension change') f.bot.game.dimension = 'the_nether';
    if (transition === 'entity replacement') f.bot.entity = { id: 8, position: vec3(0.5, 64, 0.5) };
    if (transition === 'old connection end') f.bot._client.emit('end');
    else if (transition === 'same-dimension native respawn') {
      f.bot._client.emit('respawn', {});
      f.bot.emit('respawn');
    }
    f.actions.setStopped(true);
    await assert.rejects(run, CancelledError);
    assert.equal(f.wakes().length, 0);
    assert.equal(f.bot.isSleeping, true, 'the new body is untouched');
  });
}

test('replacing the Actions bot prevents old cleanup from waking either connection', async () => {
  const f = fixture();
  const fresh = fixture();
  const run = f.actions.sleepInBed({ timeoutMs: 200 });
  await until(() => f.bot.isSleeping);
  f.actions._bot = fresh.bot;
  fresh.sleep();
  f.actions.stopCurrent();
  await assert.rejects(run, CancelledError);
  assert.equal(f.wakes().length, 0);
  assert.equal(fresh.wakes().length, 0);
});

test('a second sleep cycle on the same body is not owned by the first wait', async () => {
  const f = fixture();
  const run = f.actions.sleepInBed({ timeoutMs: 200 });
  await until(() => f.bot.isSleeping);
  f.awake(); f.sleep();
  await assert.rejects(run, CancelledError);
  assert.equal(f.wakes().length, 0);
  assert.equal(f.bot.isSleeping, true);
});

test('a delayed private cleanup wake packet is dropped after body ownership changes', async () => {
  let finishWake;
  const gate = new Promise((resolve) => { finishWake = resolve; });
  const f = fixture({ wake: async (bot) => {
    await gate;
    bot._client.write('entity_action', { entityId: bot.entity.id, actionId: 2, jumpBoost: 0 });
  } });
  const controller = new AbortController();
  const run = f.actions.sleepInBed({ signal: controller.signal, timeoutMs: 200 });
  await until(() => f.bot.isSleeping);
  controller.abort();
  await assert.rejects(run, CancelledError);
  f.bot.entity = { id: 88, position: vec3(0.5, 64, 0.5) };
  finishWake();
  await delay(5);
  assert.equal(f.wakes().length, 0);
});

test('an old aborted ALS continuation cannot directly wake a newer sleep', async () => {
  const f = fixture();
  const controller = new AbortController(); controller.abort();
  f.sleep();
  await assert.rejects(executionContext.run({ signal: controller.signal }, async () => f.bot.wake()), CancelledError);
  assert.equal(f.wakes().length, 0);
});

test('the bed approach consumes the same budget and stops navigation on timeout', async () => {
  const f = fixture(); f.bot.entity.position = vec3(30, 64, 0);
  let navigationBudget;
  f.nav.goTo = async ({ timeoutMs }) => { navigationBudget = timeoutMs; await new Promise(() => {}); };
  let bedClicks = 0; f.bot.activateBlock = () => { bedClicks += 1; };
  const start = Date.now();
  const result = await f.actions.sleepInBed({ timeoutMs: 25 });
  assert(Date.now() - start < 200);
  assert(navigationBudget <= 25);
  assert.equal(result.timed_out, true);
  assert.equal(bedClicks, 0);
  assert.equal(f.stopped(), 1);
});

function homeFixture() {
  const f = fixture();
  const world = new Map();
  const key = (p) => `${p.x},${p.y},${p.z}`;
  const put = (x, y, z, name, properties = {}) => {
    const block = { name, position: vec3(x, y, z), boundingBox: 'block', getProperties: () => properties };
    world.set(key(block.position), block);
    return block;
  };
  for (let x = 0; x < 5; x += 1) for (let z = 0; z < 5; z += 1) {
    put(x, 0, z, 'stone'); put(x, 3, z, 'cobblestone');
    if ([0, 4].includes(x) || [0, 4].includes(z)) for (let y = 1; y <= 2; y += 1) put(x, y, z, 'cobblestone');
  }
  put(2, 1, 0, 'oak_door', { half: 'lower', open: false });
  put(2, 2, 0, 'oak_door', { half: 'upper', open: false });
  f.bed.position = vec3(2, 1, 2); world.set(key(f.bed.position), f.bed);
  put(1, 1, 1, 'chest');
  f.bot.blockAt = (p) => world.get(key(p)) || { name: 'air', boundingBox: 'empty', position: p };
  f.bot._client.socket = { remoteAddress: 'test', remotePort: 25565 };
  f.bot.entity.position = vec3(2.5, 1, 2.5);
  const home = { server: 'test:25565', dimension: 'overworld', origin: { x: 0, y: 1, z: 0 }, size: 5,
    inner: 3, wall_height: 2, door_position: { x: 2, y: 1, z: 0 }, complete: true, has_roof: true };
  const ctx = new SkillContext({ signal: new AbortController().signal });
  const state = { nearbyEntities: () => [] };
  const run = (params = {}) => returnHome({ actions: f.actions, nav: f.nav, config: f.config,
    state, ctx, home, timeoutMs: 40, ...params });
  return { ...f, run, ctx, world, key };
}

test('returnHome preserves safe arrival but exposes an unsuccessful night sleep', async () => {
  const f = homeFixture();
  f.bot.activateBlock = () => { f.sleep(); f.awake(); };
  const start = Date.now();
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.equal(result.home_status.safe, true);
  assert.equal(result.slept, false);
  assert.equal(result.sleep_result.slept, true);
  assert.equal(result.sleep_result.day_confirmed, false);
  assert.match(result.note, /尚未确认天亮/);
  assert(Date.now() - start < 200);
});

test('returnHome successful sleep exposes actual dawn and rechecks safety', async () => {
  const f = homeFixture();
  f.bot.activateBlock = () => { f.sleep(); f.awake(0); };
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.equal(result.slept, true);
  assert.equal(result.sleep_result.day_confirmed, true);
});

test('returnHome without a bed caps shelter waiting to its caller budget', async () => {
  const f = homeFixture(); f.world.delete(f.key(f.bed.position));
  const start = Date.now();
  const result = await f.run({ sleep: false, waitSeconds: 30 });
  assert.equal(result.ok, true);
  assert(result.waited_ms > 0 && result.waited_ms < 150);
  assert(Date.now() - start < 200);
});

(async () => {
  for (const { name, run } of tests) {
    await run();
    process.stdout.write(`PASS ${name}\n`);
  }
  process.stdout.write(`${tests.length}/${tests.length} sleep control scenarios passed\n`);
  process.exit(0);
})().catch((err) => { process.stderr.write(`${err.stack}\n`); process.exit(1); });
