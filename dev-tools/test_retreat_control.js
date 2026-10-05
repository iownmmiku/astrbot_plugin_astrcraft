#!/usr/bin/env node
'use strict';

// Actual reflex tick, StateTracker, Actions guards and TaskQueue; Minecraft I/O is simulated.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { McEngine } = require('../engine/bot');
const { Actions } = require('../engine/actions');
const { PRIORITY, executionContext } = require('../engine/goals');
const { vec3, delay } = require('../engine/util');

const tests = [];
const fixtures = [];
const test = (name, run) => tests.push({ name, run });
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture({ health = 6, enemyX = 1, food = 10, items = [] } = {}) {
  const events = [];
  const engine = new McEngine({ emit: (name, data) => events.push({ name, data }) });
  fixtures.push(engine);
  const bot = new EventEmitter();
  const enemy = { id: 1, name: 'zombie', type: 'mob', position: vec3(enemyX, 1, 0) };
  Object.assign(bot, {
    username: 'test', health, food, oxygenLevel: 20, version: '1.20.1', heldItem: null,
    entity: { position: vec3(0, 1, 0), onGround: true }, entities: { 1: enemy },
    inventory: { items: () => items }, controls: {},
    blockAt: (p) => ({ name: p.y === 0 ? 'stone' : 'air', boundingBox: p.y === 0 ? 'block' : 'empty', position: p }),
    look: async () => {}, lookAt: async () => {},
    equip: async (item) => { bot.heldItem = item; },
    consume: async () => { bot.food = Math.min(20, bot.food + 4); },
    setControlState(key, value) { bot.controls[key] = value; },
    clearControlStates() { bot.controls = {}; }, stopDigging() {}, deactivateItem() {},
    pathfinder: { setGoal() {}, stop() {} },
  });
  engine.bot = bot;
  engine.state.attach(bot);
  engine.nav = { stop() {}, goTo: async ({ x, y, z }) => { bot.entity.position = vec3(x, y, z); } };
  engine.actions = new Actions({ bot, config: engine.config, navigator: engine.nav });
  engine.config.update({ autoEat: false, autoUnstuck: false, autoDefend: false, autoMlg: false,
    autoCollectDrops: false, autoTorch: false });
  engine.queue.minOccupancyMs = 0;
  engine.queue.preemptCooldownMs = 0;
  return { engine, bot, enemy, events };
}
async function submitRetreat(engine) {
  await engine._reflexTick();
  const task = engine.queue.find(engine.queue.queueInfo.find((t) => t.name.includes('后撤')).task_id);
  return { task, result: await task.promise };
}

test('blocked straight route tries a side route and verifies real clearance', async () => {
  const { engine, bot } = fixture();
  const paths = [];
  engine.nav.goTo = async (target) => {
    paths.push(target);
    assert.equal(executionContext.getStore().allowTerrainDig, false);
    assert.equal(target.segmented, false);
    assert(target.timeoutMs <= 2500);
    if (paths.length === 1) throw new Error('wall');
    bot.entity.position = vec3(target.x, target.y, target.z);
  };
  const { task, result } = await submitRetreat(engine);
  assert.equal(task.status, 'done');
  assert.equal(result.ok, true);
  assert.equal(paths.length, 2);
  assert.notEqual(paths[0].z, paths[1].z);
  assert(result.distance_after >= 6 && result.distance_after >= result.distance_before + 2);
  assert(engine._lastRetreatAt > 0);
});

test('navigation success without actual movement is a failed retreat, with bounded retry', async () => {
  const { engine } = fixture();
  let calls = 0;
  engine.nav.goTo = async () => { calls += 1; return { arrived: true }; };
  const { task, result } = await submitRetreat(engine);
  assert.equal(task.status, 'failed');
  assert.equal(result.ok, false);
  assert.equal(calls, 5);
  assert.equal(result.retry_ms, 1000);
  assert.equal(engine._lastRetreatAt, 0);
  for (let i = 0; i < 20; i += 1) await engine._reflexTick();
  assert.equal(engine.queue.stats.submitted, 1, 'failed retreat must not spin every tick');
  for (let i = 0; i < 3; i += 1) {
    engine._retreatRetryAt = Date.now() - 1;
    const retry = await submitRetreat(engine);
    assert(retry.result.retry_ms <= 4000);
    assert(retry.result.attempts <= 5);
  }
  assert.equal(calls, 20);
});

test('unsafe or unloaded landing cells never enter navigation', async () => {
  for (const danger of ['lava', 'water', 'magma_block', 'cactus', 'powder_snow', null]) {
    const { engine, bot } = fixture();
    bot.blockAt = (p) => !danger ? null : { name: danger, boundingBox: 'block', position: p };
    let calls = 0;
    engine.nav.goTo = async () => { calls += 1; };
    const { task, result } = await submitRetreat(engine);
    assert.equal(task.status, 'failed');
    assert.equal(result.attempts, 0);
    assert.equal(calls, 0, danger || 'unloaded');
  }
});

test('moving away from one enemy toward another is not a successful retreat', async () => {
  const { engine, bot } = fixture();
  bot.entities[2] = { id: 2, name: 'skeleton', type: 'mob', position: vec3(-7, 1, 0) };
  engine.nav.goTo = async () => { bot.entity.position = vec3(-6, 1, 0); };
  const { result } = await submitRetreat(engine);
  assert.equal(result.ok, false);
  assert.equal(result.distance_after, 1);
});

test('new close pursuit bypasses successful-retreat cooldown', async () => {
  const { engine, bot, enemy } = fixture();
  await submitRetreat(engine);
  enemy.position = bot.entity.position.offset(1, 0, 0);
  assert(engine._retreatRetryAt > Date.now());
  await submitRetreat(engine);
  assert.equal(engine.queue.stats.submitted, 2);
});

test('distance gain while falling is not reported as a safe escape', async () => {
  const { engine, bot } = fixture();
  engine.nav.goTo = async ({ x, y, z }) => {
    bot.entity.position = vec3(x, y, z);
    bot.entity.onGround = false;
  };
  const { result } = await submitRetreat(engine);
  assert.equal(result.ok, false);
});

test('a disappearing enemy is rechecked before trying more routes', async () => {
  const { engine, bot } = fixture();
  let calls = 0;
  engine.nav.goTo = async () => { calls += 1; delete bot.entities[1]; throw new Error('route changed'); };
  const { result } = await submitRetreat(engine);
  assert.equal(result.ok, true);
  assert.equal(result.distance_after, null);
  assert.equal(calls, 1);
});

test('blocked retreat can consume an emergency apple without claiming escape', async () => {
  const { engine, bot } = fixture({ items: [{ name: 'golden_apple', type: 322, count: 1 }] });
  engine.config.update({ autoEat: true });
  bot.blockAt = () => null;
  const { task, result } = await submitRetreat(engine);
  assert.equal(task.status, 'failed');
  assert.equal(result.ok, false);
  assert.equal(result.ate, 'golden_apple');
  assert.equal(bot.food, 14);
});

test('a confirmed retreat leaves room to eat before restarting long work', async () => {
  const { engine, bot } = fixture({ items: [{ name: 'bread', type: 297, count: 2 }] });
  await submitRetreat(engine);
  engine.config.update({ autoEat: true });
  const work = engine.queue.submit({ name: 'long work', priority: PRIORITY.USER,
    run: async ({ signal }) => { await delay(50, { signal }); return { ok: true }; } });
  await tick();
  await engine._reflexTick();
  const meal = engine.queue.find(engine.queue.queueInfo.find((t) => t.name.startsWith('吃 ')).task_id);
  assert.equal(work.preemptCount, 1);
  assert.equal(meal.priority, PRIORITY.CRITICAL + 5);
  await meal.promise;
  await work.promise;
  assert.equal(bot.food, 14);
});

test('queued recovery meal skips when a pursuer closes the gap again', async () => {
  const { engine, bot, enemy } = fixture({ items: [{ name: 'bread', type: 297, count: 2 }] });
  await submitRetreat(engine);
  engine.config.update({ autoEat: true });
  engine.queue.setPaused(true);
  await engine._reflexTick();
  const meal = engine.queue.find(engine.queue.queueInfo[0].task_id);
  enemy.position = bot.entity.position.offset(1, 0, 0);
  engine.queue.setPaused(false);
  const result = await meal.promise;
  assert.equal(result.skipped, true);
  assert.equal(bot.food, 10);
});

test('cancelling retreat propagates through navigation without trying more routes', async () => {
  const { engine } = fixture();
  let calls = 0;
  engine.nav.goTo = async ({ signal }) => { calls += 1; await delay(1000, { signal }); };
  await engine._reflexTick();
  const task = engine.queue.find(engine.queue.queueInfo[0].task_id);
  await tick();
  engine.queue.cancel(task.id);
  await assert.rejects(task.promise, /取消/);
  assert.equal(calls, 1);
  assert.equal(task.status, 'cancelled');
  assert.equal(engine._retreatFailures, 0);
  assert.equal(engine._retreatRetryAt, 0);
});

test('connection replacement discards old retreat continuations', async () => {
  const { engine } = fixture();
  let calls = 0;
  engine.nav.goTo = async () => { calls += 1; engine.bot = new EventEmitter(); };
  await engine._reflexTick();
  const task = engine.queue.find(engine.queue.queueInfo[0].task_id);
  await assert.rejects(task.promise, /取消/);
  assert.equal(task.status, 'cancelled');
  assert.equal(calls, 1);
  assert.equal(engine._retreatFailures, 0);
});

test('paused queue leaves retreat pending until its owner resumes', async () => {
  const { engine } = fixture();
  let calls = 0;
  engine.nav.goTo = async () => { calls += 1; };
  engine.queue.setPaused(true);
  await engine._reflexTick();
  await tick();
  assert.equal(calls, 0);
  assert.equal(engine.queue.current, null);
  const task = engine.queue.find(engine.queue.queueInfo[0].task_id);
  engine.queue.setPaused(false);
  await task.promise;
  assert(calls > 0);
});

test('emergency stop cancels running retreat and suppresses fresh reflexes', async () => {
  const { engine } = fixture();
  let calls = 0;
  engine.nav.goTo = async ({ signal }) => { calls += 1; await delay(1000, { signal }); };
  await engine._reflexTick();
  const task = engine.queue.find(engine.queue.queueInfo[0].task_id);
  await tick();
  engine.safetyStop();
  await assert.rejects(task.promise, /急停|取消/);
  await engine._reflexTick();
  assert.equal(calls, 1);
  assert.equal(engine.queue.pendingCount, 0);
  assert.equal(engine._retreatFailures, 0);
});

async function workFixture(enemyX) {
  const f = fixture({ health: 20, enemyX });
  f.engine.config.update({ autoDefend: true });
  let release = false;
  let attacks = 0;
  f.engine.actions.attack = async () => { attacks += 1; return { killed: true }; };
  const work = f.engine.queue.submit({ name: 'player work', kind: 'skill', priority: PRIORITY.USER,
    run: async ({ signal }) => { while (!release) await delay(20, { signal }); return { ok: true }; } });
  await tick();
  return { ...f, work, attacks: () => attacks, release: () => { release = true; } };
}

test('far defense waits for player work and preserves its execution', async () => {
  const f = await workFixture(5);
  await f.engine._reflexTick();
  await tick();
  assert.equal(f.engine.queue.current, f.work);
  assert.equal(f.work.preemptCount || 0, 0);
  const defense = f.engine.queue.find(f.engine._defendTaskId);
  assert.equal(defense.meta.bid, 3);
  assert.equal(defense.status, 'pending');
  assert.equal(f.attacks(), 0);
  f.release();
  await f.work.promise;
  await defense.promise;
  assert.equal(f.attacks(), 1);
});

test('close defense immediately preempts long work', async () => {
  const f = await workFixture(2);
  await f.engine._reflexTick();
  const defense = f.engine.queue.find(f.engine._defendTaskId);
  assert.equal(defense.meta.bid, 7);
  assert.equal(f.work.preemptCount, 1);
  f.release();
  await defense.promise;
  await f.work.promise;
  assert.equal(f.attacks(), 1);
});

test('far queued defense upgrades immediately when its enemy comes close', async () => {
  const f = await workFixture(5);
  await f.engine._reflexTick();
  const far = f.engine.queue.find(f.engine._defendTaskId);
  f.enemy.position = vec3(2, 1, 0);
  await f.engine._reflexTick();
  const close = f.engine.queue.find(f.engine._defendTaskId);
  assert.notEqual(close.id, far.id);
  assert.equal(far.status, 'cancelled');
  assert.equal(close.meta.bid, 7);
  assert.equal(f.work.preemptCount, 1);
  f.release();
  await close.promise;
  await f.work.promise;
  assert.equal(f.attacks(), 1);
});

test('stale queued defense skips its departed enemy', async () => {
  const f = await workFixture(5);
  await f.engine._reflexTick();
  const defense = f.engine.queue.find(f.engine._defendTaskId);
  delete f.bot.entities[1];
  f.release();
  await f.work.promise;
  const result = await defense.promise;
  assert.equal(result.skipped, true);
  assert.equal(f.attacks(), 0);
});

(async () => {
  let failed = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (err) { failed += 1; console.error(`FAIL ${name}: ${err.stack}`); }
    finally {
      for (const engine of fixtures.splice(0)) engine.queue.cancelAll({ reason: 'test cleanup' });
      await tick();
    }
  }
  console.log(`${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
