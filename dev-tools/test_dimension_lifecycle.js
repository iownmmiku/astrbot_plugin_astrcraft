#!/usr/bin/env node
'use strict';

// Exercise the real mineflayer game/health packet handlers without a server.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { McEngine } = require('../engine/bot');
const { Actions } = require('../engine/actions');
const { vec3, delay } = require('../engine/util');
const injectGame = require('../engine/node_modules/mineflayer/lib/plugins/game');
const injectHealth = require('../engine/node_modules/mineflayer/lib/plugins/health');

const tests = [];
const test = (name, run) => tests.push({ name, run });
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeBot(dimension = 'overworld') {
  const bot = new EventEmitter();
  const client = new EventEmitter();
  Object.assign(bot, {
    username: 'test', version: '1.20.4', entity: { position: vec3(0, 64, 0), onGround: true },
    registry: require('../engine/node_modules/prismarine-registry')('1.20.4'),
    health: 20, food: 20, foodSaturation: 5, oxygenLevel: 20,
    inventory: { items: () => [] }, players: {}, entities: {}, controls: {}, packets: [],
    loadPlugin() {}, lookAt: async () => {},
    setControlState(key, value) { this.controls[key] = value; },
    clearControlStates() { this.controls = {}; }, stopDigging() {}, deactivateItem() {},
    pathfinder: { setGoal() {}, stop() {}, setMovements() {} },
    world: { getColumnAt: () => ({}) }, blockAt: () => ({ name: 'stone' }),
    supportFeature: (name) => ['customChannelIdentifier', 'dimensionIsAString'].includes(name),
    _client: client,
  });
  Object.assign(client, {
    write: (name, data) => bot.packets.push({ name, data }), registerChannel() {}, writeChannel() {},
  });
  // This is the same listener order as mineflayer's loader: game, then health.
  injectGame(bot, {});
  injectHealth(bot, { respawn: true });
  client.emit('login', { dimension: `minecraft:${dimension}`, gameMode: 0 });
  client.emit('update_health', { health: 20, food: 20, foodSaturation: 5 });
  return bot;
}

function fixture(bot = fakeBot()) {
  const events = [];
  const engine = new McEngine({ emit: (name, data) => events.push({ name, data }) });
  engine.bot = bot;
  engine.nav = { stop() {} };
  engine.actions = new Actions({ bot, config: engine.config, navigator: engine.nav });
  engine.actions.autoEquipArmor = async () => {};
  engine.config.update({ autoMlg: true, enableViewer: false, autoEquipArmor: false, settleDelayMs: 1 });
  engine._wireBotEvents(bot);
  return { bot, engine, events };
}

function respawn(bot, dimension = bot.game.dimension) {
  bot._client.emit('respawn', { dimension: `minecraft:${dimension}`, gameMode: 0 });
}
function restoreHealth(bot, health = 20) {
  bot._client.emit('update_health', { health, food: 20, foodSaturation: 5 });
}
const named = (events, name) => events.filter((event) => event.name === name);

test('native dimension packets cancel the old body and hold actions until real spawn', async () => {
  const { engine, bot, events } = fixture();
  let release, oldControlRejected = false, equipped = 0;
  const task = engine.submitAction({ name: 'old world', run: async () => {
    await new Promise((resolve) => { release = resolve; });
    try { bot.setControlState('forward', true); } catch { oldControlRejected = true; }
  } });
  await tick();
  const pending = engine.submitAction({ name: 'queued old world', run: async () => assert.fail('old queue ran') });
  bot.setControlState('forward', true);
  const oldAmbient = engine._ambientController.signal;
  engine.actions.autoEquipArmor = async () => { equipped += 1; };
  respawn(bot, 'the_nether');
  assert.equal(task.signal.aborted, true);
  assert.equal(pending.status, 'cancelled');
  assert.equal(oldAmbient.aborted, true);
  assert.deepEqual(bot.controls, {});
  assert.equal(engine.queue.pendingCount, 0);
  assert.equal(named(events, 'bot.world_changed').length, 1);
  assert.deepEqual(named(events, 'bot.world_changed')[0].data, {
    from_dimension: 'overworld', dimension: 'the_nether', position: { x: 0, y: 64, z: 0 },
    lifecycle_id: engine._bodyLifecycle, ready: false, death_respawn: false,
  });
  assert.throws(() => engine.assertCanAct(), /尚未就绪/);
  engine.safetyStop();
  engine.safetyResume();
  assert.throws(() => engine.assertCanAct(), /尚未就绪/, 'resume cannot bypass world readiness');
  await assert.rejects(() => engine.actions.openDoor({ x: 0, y: 64, z: 0 }),
    { name: 'CancelledError' }, 'wrapped body actions also respect the world transition');
  engine.actions.autoEquipArmor = async () => { equipped += 1; };
  bot.emit('spawn'); // Health from the old body is still positive, isAlive is false.
  await engine._reflexTick();
  await engine._mlgTick();
  assert.equal(named(events, 'bot.world_ready').length, 0);
  assert.equal(equipped, 0);
  bot.entity.position = vec3(12, 70, 5);
  restoreHealth(bot);
  assert.equal(named(events, 'bot.world_ready').length, 1);
  assert.deepEqual(named(events, 'bot.world_ready')[0].data.position, { x: 12, y: 70, z: 5 });
  assert.equal(named(events, 'bot.respawn').length, 0, 'portal travel does not announce revival');
  assert.doesNotThrow(() => engine.assertCanAct());
  assert.equal(equipped, 1);
  release();
  await tick();
  assert.equal(oldControlRejected, true, 'old continuation cannot reacquire the new body');
  assert.deepEqual(bot.controls, {});
});

test('same-dimension death requires a native respawn before resurrection', async () => {
  const { engine, bot, events } = fixture();
  restoreHealth(bot, 0);
  const deathId = named(events, 'bot.death')[0].data.lifecycle_id;
  restoreHealth(bot); // A late positive health packet by itself must not release death.
  assert.equal(named(events, 'bot.respawn').length, 0);
  assert.throws(() => engine.assertCanAct(), /尚未就绪/);
  respawn(bot);
  assert.ok(engine._bodyLifecycle > deathId);
  restoreHealth(bot);
  assert.equal(named(events, 'bot.respawn').length, 1);
  assert.equal(named(events, 'bot.respawn')[0].data.dimension, 'overworld');
  assert.equal(named(events, 'bot.respawn')[0].data.lifecycle_id, engine._bodyLifecycle);
  assert.equal(named(events, 'bot.world_changed').length, 0);
  bot.emit('spawn');
  assert.equal(named(events, 'bot.respawn').length, 1, 'duplicate spawn has no pending lifecycle');
});

test('cross-dimension death reports world readiness and actual revival while preserving safety stop', async () => {
  const { engine, bot, events } = fixture();
  let equipped = 0;
  engine.actions.autoEquipArmor = async () => { equipped += 1; };
  restoreHealth(bot, 0);
  engine.safetyStop();
  respawn(bot, 'the_nether');
  restoreHealth(bot);
  const ready = named(events, 'bot.world_ready')[0];
  const revived = named(events, 'bot.respawn')[0];
  assert.equal(ready.data.death_respawn, true);
  assert.equal(ready.data.lifecycle_id, revived.data.lifecycle_id);
  assert.ok(events.indexOf(ready) < events.indexOf(revived));
  assert.throws(() => engine.assertCanAct(), /急停/);
  assert.equal(engine.actions._stopped, true);
  assert.equal(engine.queue._paused, true);
  assert.equal(equipped, 0);
});

test('multiple pending dimension changes use only the newest matching body', async () => {
  const { engine, bot, events } = fixture();
  respawn(bot, 'the_nether');
  const firstId = engine._bodyLifecycle;
  respawn(bot, 'the_end');
  const finalId = engine._bodyLifecycle;
  assert.ok(finalId > firstId);
  bot.isAlive = true;
  bot.game.dimension = 'the_nether';
  bot.emit('spawn');
  assert.equal(named(events, 'bot.world_ready').length, 0, 'wrong world cannot satisfy current transition');
  bot.game.dimension = 'the_end';
  bot.isAlive = false;
  restoreHealth(bot);
  const ready = named(events, 'bot.world_ready');
  assert.equal(ready.length, 1);
  assert.equal(ready[0].data.lifecycle_id, finalId);
  assert.equal(ready[0].data.from_dimension, 'overworld');
  assert.equal(ready[0].data.dimension, 'the_end');
});

test('old connection events cannot cancel, revive, or disconnect the new connection', async () => {
  const { engine, bot: oldBot, events } = fixture();
  respawn(oldBot, 'the_nether');
  const oldId = engine._bodyLifecycle;
  engine._reconnect.enabled = false;
  oldBot.emit('end', 'reconnect test');
  const bot = fakeBot();
  engine.bot = bot;
  await engine._onSpawn(bot);
  engine._stopLoops();
  assert.ok(named(events, 'bot.spawn')[0].data.lifecycle_id > oldId);
  respawn(bot, 'the_end');
  const currentId = engine._bodyLifecycle;
  const eventCount = events.length;
  for (const name of ['death', 'respawn', 'spawn', 'health', 'end', 'error', 'kicked', 'whisper']) {
    oldBot.emit(name, new Error('late old event'));
  }
  assert.equal(engine.bot, bot);
  assert.equal(engine._bodyLifecycle, currentId);
  assert.equal(events.length, eventCount);
  assert.throws(() => engine.assertCanAct(), /尚未就绪/);
  restoreHealth(bot);
  assert.equal(named(events, 'bot.world_ready').at(-1).data.lifecycle_id, currentId);
  assert.doesNotThrow(() => engine.assertCanAct());
});

test('initial spawn stores dimension and delayed setup cannot equip a newer body', async () => {
  const bot = fakeBot();
  const events = [];
  const engine = new McEngine({ emit: (name, data) => events.push({ name, data }) });
  engine.bot = bot;
  engine.config.update({ autoEquipArmor: true, enableViewer: false, settleDelayMs: 20 });
  const spawned = engine._onSpawn(bot);
  let equipped = 0;
  engine.actions.autoEquipArmor = async () => { equipped += 1; };
  const initial = named(events, 'bot.spawn')[0].data;
  assert.equal(initial.dimension, 'overworld');
  assert.equal(initial.lifecycle_id, engine._bodyLifecycle);
  respawn(bot, 'the_nether');
  restoreHealth(bot);
  await spawned;
  engine._stopLoops();
  assert.equal(equipped, 1, 'only the current world-ready lifecycle may equip armor');
});

test('old chunk waits cannot mark the current world as ready', async () => {
  const { engine, bot } = fixture();
  bot.world.getColumnAt = () => null;
  const oldChunks = engine._waitForLocalChunks(bot);
  let release;
  engine._chunksPromise = new Promise((resolve) => { release = resolve; });
  const oldEnsure = engine.ensureChunks({ timeoutMs: 1000 });
  respawn(bot, 'the_nether');
  assert.equal(await engine.ensureChunks(), false);
  bot.world.getColumnAt = () => ({});
  restoreHealth(bot);
  assert.equal(engine._chunksReady, true);
  release(true);
  assert.equal(await oldEnsure, false, 'an old ensureChunks call cannot succeed on new-world chunks');
  assert.equal(await oldChunks, false);
});

(async () => {
  let passed = 0;
  for (const { name, run } of tests) {
    try { await run(); passed += 1; console.log(`PASS ${name}`); }
    catch (err) { console.error(`FAIL ${name}: ${err.stack}`); }
  }
  console.log(`${passed}/${tests.length} dimension lifecycle scenarios passed`);
  process.exitCode = passed === tests.length ? 0 : 1;
})().catch((err) => { console.error(err); process.exitCode = 1; });
