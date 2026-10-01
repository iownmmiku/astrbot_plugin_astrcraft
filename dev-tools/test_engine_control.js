#!/usr/bin/env node
'use strict';

// Real queue/action/reflex implementations, fake Minecraft I/O only.
const assert = require('node:assert/strict');
const { EventEmitter, getEventListeners } = require('node:events');
const { Actions } = require('../engine/actions');
const { McEngine } = require('../engine/bot');
const { Navigator } = require('../engine/movement');
const { TaskQueue, PRIORITY, executionContext } = require('../engine/goals');
const { vec3, delay, CancelledError } = require('../engine/util');
const wood = require('../engine/skills/wood');
const gathering = require('../engine/skills/gathering');
const mining = require('../engine/skills/mining');
const skills = require('../engine/skills');
const { stairUpOne, digStepUp, pillarUpOne, isUnderground } = require('../engine/skills/common');

const tests = [];
const test = (name, run) => tests.push({ name, run });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const config = { get: (key) => ({ humanize: false, spawnProtectionRadius: 0, digBlacklist: [], digWhitelist: [] })[key] };
function fakeBot() {
  const bot = new EventEmitter();
  Object.assign(bot, {
    username: 'test', version: '1.20.4', entity: { position: vec3(0, 1, 0), onGround: true },
    food: 10, health: 20, oxygenLevel: 20, inventory: { items: () => [] },
    heldItem: null, controls: {}, packets: [],
    lookAt: async () => {},
    setControlState(key, value) { this.controls[key] = value; },
    clearControlStates() { this.controls = {}; },
    stopDigging() {}, deactivateItem() {},
    pathfinder: { setGoal() {}, stop() {} },
  });
  bot._client = { write: (name, data) => bot.packets.push({ name, data }) };
  return bot;
}
function engineWithBot(bot = fakeBot()) {
  const engine = new McEngine({ emit: () => {} });
  engine.bot = bot;
  engine.nav = { stop() {} };
  engine.actions = new Actions({ bot, config, navigator: engine.nav });
  engine.config.update({ autoEat: true, autoUnstuck: false, autoDefend: false, autoMlg: false,
    autoCollectDrops: false, autoTorch: false });
  return engine;
}

test('workstation placement skips occupied torch and door cells', async () => {
  const bot = fakeBot();
  bot.entity.yaw = 0;
  bot.blockAt = (p) => ({ name: p.y === 0 ? 'stone' : p.x === 0 && p.z === 1 ? 'torch' :
    p.x === 1 && p.z === 0 ? 'oak_door' : 'air', boundingBox: p.y === 0 ? 'block' : 'empty' });
  const actions = new Actions({ bot, config, navigator: { stop() {} } });
  assert.deepEqual(actions._spotInFront(), { x: -1, y: 1, z: 0 });
});

test('navigation recovery cannot dig terrain during shelter furnishing', async () => {
  const bot = fakeBot();
  let dug = 0;
  const navigator = Object.create(Navigator.prototype);
  navigator._bot = bot;
  navigator._actions = { dig: async () => { dug += 1; } };
  bot.blockAt = () => ({ name: 'cobblestone', boundingBox: 'block', diggable: true });
  const result = await executionContext.run({ allowTerrainDig: false }, () => navigator._digOut());
  assert.equal(result, false);
  assert.equal(dug, 0);
  assert.equal(executionContext.getStore(), undefined, 'the restriction must stay local to this operation');
  const path = executionContext.run({ allowTerrainDig: false }, () => navigator._runPath({}, {
    x: 4, y: 1, z: 0, range: 1, timeout: 1000, t0: Date.now(),
  }));
  // 原生 physics/path 事件在操作上下文之外发射。
  bot.emit('path_update', { status: 'noPath' });
  await assert.rejects(path, /找不到/);
  assert.equal(dug, 0, 'the event callback must retain the terrain restriction');
});

test('jump placement uses a prepared hand but still equips a mismatched item', async () => {
  for (const prepared of [true, false]) {
    const bot = fakeBot();
    const item = { name: 'cobblestone', type: 14, count: 4 };
    bot.registry = { blocksByName: { cobblestone: {} } };
    bot.inventory.items = () => [item];
    bot.heldItem = prepared ? item : { name: 'stone_pickaxe', count: 1 };
    let placed = false;
    let equips = 0;
    bot.blockAt = (p) => ({ name: p.y === 0 ? 'stone' : placed ? 'cobblestone' : 'air',
      boundingBox: p.y === 0 || placed ? 'block' : 'empty', position: p });
    bot.placeBlock = async () => { assert.equal(bot.heldItem.name, 'cobblestone'); placed = true; };
    const actions = new Actions({ bot, config, navigator: { stop() {} } });
    actions.holdItem = async () => { equips += 1; bot.heldItem = item; };
    const result = await actions.place({ x: 0, y: 1, z: 0, item: 'cobblestone', fast: true });
    assert.equal(result.ok, true);
    assert.equal(equips, prepared ? 0 : 1);
  }
});

test('crafting drains delayed window corrections and accepts only the server result', async () => {
  const registry = require('../engine/node_modules/prismarine-registry')('1.20.4');
  const windows = require('../engine/node_modules/prismarine-windows')('1.20.4');
  const Item = require('../engine/node_modules/prismarine-item')(registry);
  const Recipe = require('../engine/node_modules/prismarine-recipe')(registry).Recipe;
  const logId = registry.itemsByName.oak_log.id;
  const planksId = registry.itemsByName.oak_planks.id;
  const recipe = Recipe.find(planksId, null)[0];
  for (const mode of ['normal', 'wrong_output', 'refused_cursor', 'blocked_cursor']) {
    const wrongOutput = mode === 'wrong_output';
    const bot = fakeBot();
    const server = windows.createWindow(0, 'minecraft:inventory', 'server');
    bot.inventory = windows.createWindow(0, 'minecraft:inventory', 'client');
    server.updateSlot(9, new Item(logId, 2));
    const clone = (item) => item ? new Item(item.type, item.count, item.metadata, item.nbt) : null;
    const snapshot = () => ({ slots: server.slots.map(clone), cursor: clone(server.selectedItem) });
    const apply = (s) => {
      s.slots.forEach((item, slot) => bot.inventory.updateSlot(slot, clone(item)));
      bot.inventory.selectedItem = clone(s.cursor);
    };
    apply(snapshot());
    let correction = null;
    let resultClicks = 0;
    let refused = 0;
    bot.supportFeature = (name) => name === 'stateIdUsed';
    bot._syncWindow = async () => {
      if (correction) { apply(correction); correction = null; }
      else apply(snapshot());
    };
    bot.clickWindow = async (slot, mouseButton, clickMode) => {
      correction = snapshot(); // A prior full-window correction may arrive before the sync response.
      if (slot >= 9 && server.selectedItem &&
          (mode === 'blocked_cursor' || mode === 'refused_cursor' && refused === 0)) {
        refused += 1;
        return;
      }
      server.acceptClick({ slot, mouseButton, mode: clickMode, windowId: 0, item: server.slots[slot] });
      if (slot === 0) {
        resultClicks += 1;
        server.updateSlot(1, null);
      }
      const id = wrongOutput ? registry.itemsByName.oak_button.id : planksId;
      server.updateSlot(0, server.slots[1]?.type === logId ? new Item(id, wrongOutput ? 1 : 4) : null);
    };
    bot.craft = () => { throw new Error('must not trust native predicted crafting output'); };
    const actions = new Actions({ bot, config, navigator: { stop() {} } });
    if (mode === 'blocked_cursor') {
      await assert.rejects(actions._craftBatch(bot, recipe, null, null), /没有确认收回/);
      assert.equal(refused, 3, 'persistent rejection must stop after bounded retries');
      assert.equal(resultClicks, 0);
    } else if (wrongOutput) {
      await assert.rejects(actions._craftBatch(bot, recipe, null, null), /产出不符/);
      assert.equal(resultClicks, 0, 'a wrong server result must remain uncollected');
    } else {
      await actions._craftBatch(bot, recipe, null, null);
      await actions._craftBatch(bot, recipe, null, null);
      assert.equal(bot.inventory.count(planksId, null), 8);
      assert.equal(server.count(logId, null), 0);
      assert.equal(resultClicks, 2);
      assert.equal(server.selectedItem, null);
      if (mode === 'refused_cursor') assert.equal(refused, 1, 'one corrected rejection must recover');
    }
  }
});

test('respawn notification waits for restored life and preserves emergency stop', async () => {
  const bot = fakeBot();
  const engine = engineWithBot(bot);
  const events = [];
  engine._emit = (name, data) => events.push({ name, data });
  let equipped = 0;
  engine.actions.autoEquipArmor = async () => { equipped += 1; };
  engine._wireBotEvents(bot);
  bot.health = 0;
  bot.emit('respawn');
  assert.equal(events.filter((e) => e.name === 'bot.respawn').length, 0);
  bot.health = 20;
  bot.emit('spawn');
  assert.equal(events.filter((e) => e.name === 'bot.respawn').length, 1);
  assert.equal(equipped, 1);
  engine._safetyStopped = true;
  bot.emit('respawn');
  bot.emit('spawn');
  assert.equal(events.filter((e) => e.name === 'bot.respawn').length, 2);
  assert.equal(equipped, 1, 'emergency stop also prevents respawn armor actions');
});

test('navigation resumes its goal after one serialized stuck recovery', async () => {
  const bot = fakeBot();
  const nav = Object.create(Navigator.prototype);
  nav._bot = bot;
  let checks, release;
  let escapes = 0, goalsSet = 0;
  nav._escapeStuck = async () => { escapes += 1; await new Promise((r) => { release = r; }); return true; };
  bot.pathfinder.setGoal = (goal) => {
    if (goal === null) return;
    goalsSet += 1;
    if (goalsSet === 2) {
      bot.entity.position = vec3(10, 1, 0);
      bot.emit('goal_reached');
    }
  };
  const interval = global.setInterval;
  global.setInterval = (fn) => { checks = fn; return interval(() => {}, 100000); };
  let walking;
  try { walking = nav._runPath({}, { x: 10, y: 1, z: 0, range: 1, timeout: 500, t0: Date.now() }); }
  finally { global.setInterval = interval; }
  checks(); checks();
  assert.equal(escapes, 1);
  checks(); checks();
  assert.equal(escapes, 1, 'an in-flight recovery cannot start another recovery');
  release();
  const result = await walking;
  assert.equal(goalsSet, 2, 'stopped navigation must restore its original goal');
  assert.equal(result.arrived, true);
});

test('navigation finishes at the requested position without waiting for a goal event', async () => {
  const bot = fakeBot();
  const nav = Object.create(Navigator.prototype);
  nav._bot = bot;
  let stopped = 0, finished = false;
  bot.pathfinder.setGoal = (goal) => { if (goal === null) stopped += 1; };
  const moving = nav._runPath({}, { x: 5.5, y: 1, z: 0.5, range: 0.7,
    timeout: 1000, signal: null, t0: Date.now() }).then((r) => { finished = true; return r; });
  bot.entity.position = vec3(5.5, -3, 0.5);
  bot.emit('physicsTick');
  await tick();
  assert.equal(finished, false, 'the same horizontal position at the wrong height is not an arrival');
  bot.entity.position = vec3(5.5, 1, 0.5);
  bot.emit('physicsTick');
  const result = await moving;
  assert.equal(result.arrived, true);
  assert.equal(stopped, 1);
  assert.equal(bot.listenerCount('physicsTick'), 0);
  assert.equal(bot.listenerCount('goal_reached'), 0);
});

test('navigation cannot accept a false arrival as a completed move', async () => {
  const nav = Object.create(Navigator.prototype);
  nav._bot = fakeBot();
  nav._goToOnce = async () => ({ arrived: false, distance_to_target: 6.5 });
  let retried = false;
  nav._goToSegmented = async () => { retried = true; return { arrived: true }; };
  await assert.rejects(nav.goTo({ x: 10, z: 0, segmented: false }), /未到目标/);
  assert.equal(retried, false);
  assert.equal((await nav.goTo({ x: 10, z: 0 })).arrived, true);
  assert.equal(retried, true);
});

test('stopping a real pathfinder cannot cancel its immediately following goal', async () => {
  const bot = fakeBot();
  bot.registry = require('../engine/node_modules/prismarine-registry')('1.20.4');
  require('../engine/node_modules/mineflayer-pathfinder').pathfinder(bot);
  const nav = Object.create(Navigator.prototype);
  nav._bot = bot;
  const { GoalBlock } = require('../engine/node_modules/mineflayer-pathfinder').goals;
  bot.pathfinder.setGoal(new GoalBlock(5, 1, 0));
  nav.stop();
  assert.equal(bot.pathfinder.goal, null);
  const next = new GoalBlock(0, 1, 5);
  bot.pathfinder.setGoal(next);
  assert.equal(bot.pathfinder.goal, next, 'a delayed stop must not clear the next submitted goal');
});

test('guarded preemption enqueues one task and finishes it once', async () => {
  const queue = new TaskQueue();
  let finish;
  const first = queue.submit({ name: 'user', run: () => new Promise((r) => { finish = r; }) });
  await tick();
  let runs = 0;
  const second = queue.submit({ name: 'survival', priority: PRIORITY.SURVIVAL, run: async () => { runs += 1; } });
  assert.equal(queue.pendingCount, 1);
  finish();
  await Promise.all([first.promise, second.promise]);
  await tick();
  assert.equal(runs, 1);
  assert.equal(queue.stats.completed, 2);
  assert.equal(queue.history.filter((t) => t.task_id === second.id).length, 1);
});

test('fatal reactions bypass occupancy/cooldown/preemptibility and await cleanup', async () => {
  const queue = new TaskQueue();
  const order = [];
  let runs = 0;
  const user = queue.submit({ name: 'user', preemptible: false, run: async ({ signal }) => {
    runs += 1;
    if (runs > 1) return;
    try { await delay(5000, { signal }); }
    finally { await delay(20); order.push('cleaned'); }
  } });
  await tick();
  const critical = queue.submit({ name: 'air', priority: PRIORITY.CRITICAL, run: async () => { order.push('critical'); } });
  await Promise.all([user.promise, critical.promise]);
  assert.deepEqual(order, ['cleaned', 'critical']);
  assert.equal(queue.stats.preempted, 1);
  assert.equal(queue.stats.cancelled, 0);
});

test('cancelled dig stops the underlying block mutation', async () => {
  const bot = fakeBot();
  let removed = false;
  let stops = 0;
  let digTimer;
  let rejectDig;
  bot.blockAt = (position) => ({ name: removed ? 'air' : 'stone', type: removed ? 0 : 1,
    position, diggable: true, boundingBox: 'block' });
  bot.canDigBlock = () => true;
  bot.dig = () => new Promise((resolve, reject) => {
    rejectDig = reject;
    digTimer = setTimeout(() => { removed = true; resolve(); }, 80);
  });
  bot.stopDigging = () => { stops += 1; clearTimeout(digTimer); if (rejectDig) rejectDig(new Error('Digging aborted')); };
  const actions = new Actions({ bot, config, navigator: { stop() {} } });
  actions.equipBestToolFor = async () => {};
  const controller = new AbortController();
  const digging = actions.dig({ x: 1, y: 1, z: 0, collect: false, signal: controller.signal });
  await delay(10);
  controller.abort();
  await assert.rejects(digging, CancelledError);
  await delay(100);
  assert.equal(stops, 1);
  assert.equal(removed, false);
  await assert.rejects(actions.dig({ x: 1, y: 1, z: 0, collect: false, signal: controller.signal }), CancelledError);
  assert.equal(stops, 1);
});

test('timeout cancels late interaction packets and clears its timer/listener', async () => {
  const bot = fakeBot();
  const actions = new Actions({ bot, config, navigator: { stop() {} } });
  let cancelled = 0;
  await assert.rejects(actions._raceAbort(async () => {
    await delay(60);
    bot._client.write('window_click', {});
  }, null, 10, 'timeout', () => { cancelled += 1; }), { name: 'TimeoutError' });
  await delay(80);
  assert.equal(cancelled, 1);
  assert.equal(bot.packets.length, 0);
  const controller = new AbortController();
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  let timeout;
  let cleared = false;
  global.setTimeout = (...args) => { timeout = realSetTimeout(...args); return timeout; };
  global.clearTimeout = (id) => { if (id === timeout) cleared = true; return realClearTimeout(id); };
  try { assert.equal(await actions._raceAbort(() => Promise.resolve(42), controller.signal, 30000, 'timeout'), 42); }
  finally { global.setTimeout = realSetTimeout; global.clearTimeout = realClearTimeout; }
  assert.equal(cleared, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('stale bare await cannot modify the body after bounded cancellation', async () => {
  const bot = fakeBot();
  const engine = engineWithBot(bot);
  let sawCancellation = false;
  let runs = 0;
  const victim = engine.submitAction({ name: 'slow', run: async () => {
    runs += 1;
    if (runs > 1) return { ok: true };
    await delay(180);
    try { bot.setControlState('forward', true); }
    catch (err) { sawCancellation = err instanceof CancelledError; }
    bot._client.write('window_click', {});
    return { ok: true };
  } });
  await tick();
  const critical = engine.queue.submit({ name: 'fatal', priority: PRIORITY.CRITICAL, run: async () => {
    bot.setControlState('jump', true);
    await delay(150);
    bot.setControlState('jump', false);
  } });
  await Promise.all([victim.promise, critical.promise]);
  assert.equal(sawCancellation, true);
  assert.equal(bot.controls.forward, undefined);
  assert.equal(bot.packets.length, 0);
  assert.equal(engine.queue.stats.completed, 2);
});

test('empty-handed eating equips food and raw meat uses real Minecraft IDs', async () => {
  const bot = fakeBot();
  const bread = { name: 'bread', count: 2, type: 1 };
  bot.inventory.items = () => [bread];
  let equips = 0;
  bot.equip = async (item) => { equips += 1; bot.heldItem = item; };
  bot.consume = async () => { assert.equal(bot.heldItem.name, 'bread'); bot.food = 16; };
  const actions = new Actions({ bot, config, navigator: { stop() {} } });
  const result = await actions.eat();
  assert.equal(result.food_after, 16);
  assert.equal(equips, 1);
  bot.inventory.items = () => [{ name: 'beef', count: 1 }];
  assert.equal(actions._pickBestFood().name, 'beef');
});

test('normal reflexes deduplicate pending work and recheck stale hunger', async () => {
  const bot = fakeBot();
  bot.inventory.items = () => [{ name: 'bread', count: 2 }];
  const engine = engineWithBot(bot);
  let finish;
  const user = engine.submitAction({ name: 'user', run: () => new Promise((r) => { finish = r; }) });
  await tick();
  let eaten = 0;
  engine.actions.eat = async () => { eaten += 1; };
  for (let i = 0; i < 10; i += 1) await engine._reflexTick();
  assert.equal(engine.queue.pendingCount, 1);
  const reflex = engine.queue._queue[0];
  bot.food = 20;
  finish();
  await Promise.all([user.promise, reflex.promise]);
  assert.equal(eaten, 0);
  assert.equal(reflex.result.skipped, true);
});

test('wounded players eat before the ordinary hunger threshold', async () => {
  const engine = engineWithBot();
  engine.bot.food = 16;
  engine.bot.health = 10;
  engine.bot.inventory.items = () => [{ name: 'bread', count: 2 }];
  let submitted;
  engine._submitReflex = (name) => { submitted = name; };
  await engine._reflexTick();
  assert.equal(submitted, '吃 bread');
  assert.equal(engine._reflexNeeded(submitted), true);
  engine.bot.food = 18;
  assert.equal(engine._reflexNeeded(submitted), false);
});

test('critical retreat takes priority over food and long work', async () => {
  const engine = engineWithBot();
  engine.bot.health = 6;
  engine.bot.inventory.items = () => [{ name: 'bread', count: 2 }];
  engine.state.nearbyEntities = () => [{ name: 'zombie', position: { x: 2, y: 1, z: 0 }, distance: 2 }];
  let submitted;
  engine._submitReflex = (name, run, level) => { submitted = { name, level }; };
  await engine._reflexTick();
  assert.deepEqual(submitted, { name: '血量过低，后撤', level: 'critical' });
});

test('ordinary meals preserve emergency golden apples', async () => {
  const engine = engineWithBot();
  engine.bot.inventory.items = () => [{ name: 'golden_apple', count: 2 }, { name: 'bread', count: 1 }];
  assert.equal(engine.actions._pickBestFood().name, 'bread');
  engine.bot.health = 6;
  assert.equal(engine.actions._pickBestFood().name, 'golden_apple');
});

test('eating without a confirmed food increase is reported as failure', async () => {
  const bot = fakeBot();
  bot.heldItem = { name: 'bread', count: 1 };
  bot.inventory.items = () => [bot.heldItem];
  const actions = new Actions({ bot, config, navigator: { stop() {} } });
  const originalNow = Date.now;
  let clock = 1000;
  Date.now = () => clock;
  bot.consume = async () => { clock += 9000; };
  try { await assert.rejects(actions.eat(), /服务器没有确认饱食度恢复/); }
  finally { Date.now = originalNow; }
  assert.equal(actions._eating, false);
});

test('recovery stops on threats and confirms actual restored health', async () => {
  const bot = fakeBot();
  bot.health = 6; bot.food = 20;
  const ctx = new skills.SkillContext({ signal: null });
  const state = { nearbyEntities: () => [{ name: 'zombie' }] };
  const blocked = await skills.get('recover').run({ actions: { bot }, state, ctx, params: {} });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /威胁/);
  state.nearbyEntities = () => [];
  const regeneration = setTimeout(() => { bot.health = 12; }, 20);
  try {
    const result = await skills.get('recover').run({ actions: { bot }, state, ctx, params: {} });
    assert.equal(result.ok, true);
    assert.equal(bot.health, 12);
  } finally { clearTimeout(regeneration); }
});

test('eat skill eats enough without repeating a full stomach action', async () => {
  const bot = fakeBot();
  bot.food = 6;
  let eaten = 0;
  const actions = { bot, eat: async () => { eaten += 1; bot.food = Math.min(20, bot.food + 5); return { ate: 'bread' }; } };
  const ctx = new skills.SkillContext({ signal: null });
  const r = await skills.get('eat').run({ actions, ctx, params: { target_food: 18 } });
  assert.equal(bot.food, 20);
  assert.equal(eaten, 3);
  assert.equal(r.reached_target, true);
  await skills.get('eat').run({ actions, ctx, params: {} });
  assert.equal(eaten, 3);
});

test('cookFood uses existing wheat before looking for animals', async () => {
  const bot = fakeBot();
  bot.entities = {};
  bot.findBlock = () => ({ name: 'crafting_table', position: vec3(1, 1, 0) });
  const inv = { wheat: 6 };
  const actions = { bot, inventoryMap: () => ({ ...inv }), countItem: (n) => inv[n] || 0,
    craft: async ({ item, count }) => { assert.equal(item, 'bread'); assert.equal(count, 2); inv.wheat -= count * 3; inv.bread = count; return { ok: true }; } };
  const r = await gathering.cookFood({ actions, ctx: new skills.SkillContext({ signal: null }), count: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.produced.bread, 2);
});

test('cookFood processes existing fish without blind hunting and bounds quantities', async () => {
  const bot = fakeBot();
  bot.entities = {};
  const inv = { salmon: 7 };
  const actions = { bot, inventoryMap: () => ({ ...inv }), countItem: (n) => inv[n] || 0 };
  const original = mining.smeltOres;
  mining.smeltOres = async ({ item, count }) => {
    assert.equal(item, 'salmon'); assert.equal(count, 2);
    inv.salmon -= count; inv.cooked_salmon = count;
    return { ok: true, steps: ['烤鱼'] };
  };
  try {
    const r = await gathering.cookFood({ actions, ctx: new skills.SkillContext({ signal: null }), count: 2 });
    assert.equal(r.produced.cooked_salmon, 2);
    assert.equal(inv.salmon, 5);
  } finally { mining.smeltOres = original; }
});

test('food preparation without new supplies cannot pretend to make progress', async () => {
  const bot = fakeBot();
  bot.entities = {};
  const inv = { apple: 1 };
  const actions = { bot, inventoryMap: () => ({ ...inv }), countItem: (n) => inv[n] || 0 };
  const r = await gathering.cookFood({ actions, ctx: new skills.SkillContext({ signal: null }), count: 4 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /没有补充/);
});

test('default storage keeps tools and food but explicit item selection is honored', async () => {
  for (const items of [null, ['stone_pickaxe']]) {
    const bot = fakeBot();
    bot.findBlock = () => ({ name: 'chest', position: vec3(1, 1, 0) });
    const inv = { stone_pickaxe: 1, bread: 4, cobblestone: 64 };
    const actions = { bot, inventoryMap: () => inv, deposit: async ({ keep }) => {
      assert.equal(keep.includes('stone_pickaxe'), items === null);
      assert.equal(keep.includes('bread'), items === null);
      assert.equal(keep.includes('cobblestone'), false);
      return { stored: { cobblestone: 64 }, total: 64 };
    } };
    assert.equal((await gathering.storeItems({ actions, items, ctx: new skills.SkillContext({ signal: null }) })).ok, true);
  }
});

test('low oxygen uses bot.oxygenLevel and escapes before stuck backoff', async () => {
  const engine = engineWithBot();
  engine.bot.entity.isInWater = true;
  engine.bot.oxygenLevel = 2;
  engine.config.update({ autoUnstuck: true });
  engine._unstuckGiveUpUntil = Date.now() + 60000;
  engine._blockingSelf = () => [{ name: 'stone', x: 0, y: 1, z: 0 }];
  let submitted;
  engine._submitReflex = (name, run, level) => { submitted = { name, level }; };
  await engine._reflexTick();
  assert.deepEqual(submitted, { name: '浮上水面换气', level: 'critical' });
});

test('safety stop persists, stops reflexes, guards all actions, and preserves config', async () => {
  const engine = engineWithBot();
  const autoEat = engine.config.get('autoEat');
  const controller = engine._ambientController;
  engine.safetyStop();
  assert.equal(controller.signal.aborted, true);
  assert.equal(engine.config.get('autoEat'), autoEat);
  assert.throws(() => engine.submitAction({ name: 'move', run: async () => {} }), /急停/);
  await assert.rejects(engine.actions.eat(), /急停/);
  let called = false;
  engine._submitImmediateSurvival = () => { called = true; return true; };
  await engine._reflexTick();
  await engine._mlgTick();
  assert.equal(called, false);
  assert.equal(engine.queue.pendingCount, 0);
  engine.safetyResume();
  const task = engine.submitAction({ name: 'resumed', run: async () => ({ ok: true }) });
  assert.deepEqual(await task.promise, { ok: true });
  assert.equal(engine.config.get('autoEat'), autoEat);
});

test('toPlayer refreshes a moving destination and returns on arrival', async () => {
  const bot = fakeBot();
  const target = { position: vec3(8, 1, 0) };
  const nav = Object.create(Navigator.prototype);
  nav._bot = bot;
  nav._resolveEntity = () => target;
  let trips = 0;
  nav.stop = () => {};
  nav.goTo = async ({ x }) => {
    trips += 1;
    bot.entity.position = vec3(x - 2, 1, 0);
    if (trips === 1) target.position = vec3(12, 1, 0);
  };
  const result = await nav.toPlayer('Alice', { timeoutMs: 1000 });
  assert.equal(result.arrived, true);
  assert.equal(trips, 2);
  assert.equal(result.distance_to_target, 2);
});

test('withdraw finds a nearby chest and keeps explicit coordinates valid', async () => {
  const bot = fakeBot();
  const engine = engineWithBot(bot);
  bot.findBlock = ({ maxDistance }) => { assert.equal(maxDistance, 16); return { position: vec3(2, 1, 0) }; };
  let opened;
  let closed = 0;
  engine.actions.openContainer = async (opts) => {
    opened = opts;
    return { win: { containerItems: () => [{ name: 'bread', type: 1, count: 4 }],
      withdraw: async () => {}, close: () => { closed += 1; } } };
  };
  assert.deepEqual((await engine.actions.withdraw({ item: 'bread', count: 2 })).taken, { bread: 2 });
  assert.equal(opened.x, 2);
  await engine.actions.withdraw({ x: 5, y: 1, z: 0, item: 'bread' });
  assert.equal(opened.x, 5);
  await assert.rejects(engine.actions.withdraw({ x: 5, item: 'bread' }), /完整/);
  assert.equal(closed, 2);
});

function materialActions(initial) {
  const inventory = { ...initial };
  const crafts = [];
  let table = !!inventory._table;
  delete inventory._table;
  const recipes = {
    oak_planks: { output: 4, inputs: { oak_log: 1 } },
    stick: { output: 4, inputs: { oak_planks: 2 } },
    crafting_table: { output: 1, inputs: { oak_planks: 4 } },
    wooden_pickaxe: { output: 1, inputs: { oak_planks: 3, stick: 2 } },
    wooden_axe: { output: 1, inputs: { oak_planks: 3, stick: 2 } },
    wooden_shovel: { output: 1, inputs: { oak_planks: 1, stick: 2 } },
    wooden_sword: { output: 1, inputs: { oak_planks: 2, stick: 1 } },
    stone_shovel: { output: 1, inputs: { cobblestone: 1, stick: 2 } },
  };
  const actions = {
    bot: { findBlock: () => table ? { name: 'crafting_table', position: vec3(1, 1, 0) } : null },
    inventoryMap: () => ({ ...inventory }),
    countItem: (name) => inventory[name] || 0,
    _spotInFront: () => ({ x: 1, y: 1, z: 0 }),
    place: async () => { assert.ok(inventory.crafting_table); inventory.crafting_table -= 1; table = true; return { ok: true }; },
    craft: async ({ item, count }) => {
      const recipe = recipes[item];
      assert.ok(recipe, item);
      const batches = Math.ceil(count / recipe.output);
      for (const [input, amount] of Object.entries(recipe.inputs)) assert.ok((inventory[input] || 0) >= amount * batches, `${item} needs ${input}`);
      for (const [input, amount] of Object.entries(recipe.inputs)) inventory[input] -= amount * batches;
      const produced = batches * recipe.output;
      inventory[item] = (inventory[item] || 0) + produced;
      crafts.push({ item, count, produced });
      return { ok: true, produced };
    },
  };
  return { actions, inventory, crafts };
}
const materialContext = { signal: new AbortController().signal, checkAborted() {}, progress() {} };

test('one-block ascent targets the next level without segmented detours', async () => {
  const bot = fakeBot();
  bot.entity.position = vec3(0.5, 1, 0.5);
  const placed = new Set();
  bot.blockAt = (p) => ({ name: p.y === 0 || placed.has(`${p.x},${p.y},${p.z}`) ? 'stone' : 'air',
    boundingBox: p.y === 0 || placed.has(`${p.x},${p.y},${p.z}`) ? 'block' : 'empty' });
  const requests = [];
  const actions = { bot, countItem: (name) => name === 'cobblestone' ? 4 : 0,
    place: async ({ x, y, z }) => placed.add(`${x},${y},${z}`) };
  const nav = { goTo: async (options) => {
    requests.push(options);
    bot.entity.position = vec3(options.x + 0.5, options.y, options.z + 0.5);
    return { arrived: true };
  } };
  assert.equal(await stairUpOne({ actions, nav, ctx: materialContext, bx: 0, by: 1, bz: 0 }), true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].y, 2);
  assert.equal(requests[0].segmented, false);
  assert.ok(requests[0].range < 1, 'standing beside and below the step must not count as arrival');
  assert.equal(bot.entity.position.y, 2);
});

test('climbing remains underground one block below the actual surface', () => {
  const bot = fakeBot();
  bot.blockAt = (p) => ({ name: (p.x !== 0 || p.z !== 0) && p.y <= 10 ? 'stone' : 'air',
    boundingBox: (p.x !== 0 || p.z !== 0) && p.y <= 10 ? 'block' : 'empty' });
  bot.entity.position = vec3(0.5, 10, 0.5);
  assert.equal(isUnderground(bot), true, 'a clear shaft is still below its rim');
  bot.entity.position.y = 11;
  assert.equal(isUnderground(bot), false, 'standing at the surface completes the climb');
});

test('all ascent strategies preserve reserved mining output', async () => {
  const bot = fakeBot();
  bot.entity.position = vec3(0.5, 1, 0.5);
  bot.blockAt = (p) => ({ name: p.y === 0 ? 'stone' : 'air',
    boundingBox: p.y === 0 ? 'block' : 'empty', diggable: true });
  const actions = { bot, countItem: (name) => name === 'cobblestone' ? 8 : 0,
    place: async () => { throw new Error('reserved blocks must not be placed'); },
    holdItem: async () => { throw new Error('reserved blocks must not be held for placement'); } };
  const options = { actions, ctx: materialContext, bx: 0, by: 1, bz: 0,
    reserveItems: { cobblestone: 8 }, nav: { goTo: async () => { throw new Error('no supported step'); } } };
  assert.equal(await pillarUpOne(options), false);
  assert.equal(await stairUpOne(options), false);
  assert.equal(await digStepUp(options), false);
});

test('digging ascent clears the step without chasing drops off its support', async () => {
  const bot = fakeBot();
  bot.entity.position = vec3(0.5, 1, 0.5);
  const cleared = new Set();
  const key = (p) => `${p.x},${p.y},${p.z}`;
  bot.blockAt = (p) => {
    const solid = p.y <= 3 && (p.x !== 0 || p.z !== 0 || p.y < 1) && !cleared.has(key(p));
    return { name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty', diggable: true };
  };
  const digs = [];
  const actions = { bot, countItem: () => 0, dig: async (options) => {
    digs.push(options); cleared.add(key(options));
    assert.equal(options.collect, false, 'collectDrops must not move the body while opening a step');
  } };
  const nav = { goTo: async (options) => {
    assert.equal(options.segmented, false);
    bot.entity.position = vec3(options.x + 0.5, options.y, options.z + 0.5);
    return { arrived: true };
  } };
  assert.equal(await digStepUp({ actions, nav, ctx: materialContext, bx: 0, by: 1, bz: 0 }), true);
  assert.equal(digs.length, 2);
  assert.equal(bot.entity.position.y, 2);
});

test('four logs make one wooden pickaxe with minimal materials and no search', async () => {
  const { actions, inventory, crafts } = materialActions({ oak_log: 4 });
  const result = await wood.makeTools({ actions, ctx: materialContext, tier: 'wooden', kinds: ['pickaxe'], allowSearch: false });
  assert.equal(result.ok, true, result.reason);
  assert.equal(inventory.wooden_pickaxe, 1);
  assert.equal(inventory.oak_log, 1);
  assert.equal(inventory.oak_planks, 3);
  assert.equal(inventory.stick, 2);
  assert.deepEqual(crafts.map(({ item, count }) => [item, count]),
    [['oak_planks', 12], ['stick', 4], ['crafting_table', 1], ['wooden_pickaxe', 1]]);
});

test('tool dependencies use existing planks/sticks/tools and exact shovel materials', async () => {
  const existing = materialActions({ oak_planks: 3, stick: 2, _table: true });
  const result = await wood.makeTools({ actions: existing.actions, ctx: materialContext, tier: 'wooden', kinds: ['pickaxe'], allowSearch: false });
  assert.equal(result.ok, true, result.reason);
  assert.equal(existing.crafts.length, 1);
  const repeated = await wood.makeTools({ actions: existing.actions, ctx: materialContext, tier: 'wooden', kinds: ['pickaxe'], allowSearch: false });
  assert.equal(repeated.ok, true);
  assert.equal(existing.crafts.length, 1);
  const shovel = materialActions({ cobblestone: 1, stick: 2, wooden_pickaxe: 1, _table: true });
  assert.equal((await wood.makeTools({ actions: shovel.actions, ctx: materialContext, tier: 'stone', kinds: ['shovel'], allowSearch: false })).ok, true);
  assert.equal(shovel.inventory.stone_shovel, 1);
});

test('wood helpers request output items and add only the missing material', async () => {
  const plank = materialActions({ oak_log: 2 });
  assert.equal((await wood.makePlanks({ actions: plank.actions, ctx: materialContext, want: 8 })).ok, true);
  assert.deepEqual(plank.crafts.map(({ count }) => count), [8]);
  assert.equal(plank.inventory.oak_log, 0);
  const stick = materialActions({ oak_planks: 1, oak_log: 1 });
  assert.equal((await wood.makeSticks({ actions: stick.actions, ctx: materialContext, want: 2, allowSearch: false })).ok, true);
  assert.equal(stick.inventory.stick, 4);
  assert.equal(stick.inventory.oak_planks, 3);
});

test('batch crafting confirms each server result before the next batch', async () => {
  const bot = fakeBot();
  const data = require('../engine/node_modules/minecraft-data')('1.20.4');
  const logId = data.itemsByName.oak_log.id;
  const plankId = data.itemsByName.oak_planks.id;
  const recipe = { result: { id: plankId, count: 4 }, delta: [{ id: logId, count: -1 }, { id: plankId, count: 4 }] };
  let server = { oak_log: 2, oak_planks: 0 };
  let local = { ...server };
  let serverUpdate = Promise.resolve();
  let batches = 0;
  bot.inventory.items = () => Object.entries(local).filter(([, count]) => count > 0).map(([name, count]) => ({ name, count, type: data.itemsByName[name].id }));
  bot.recipesAll = () => [recipe];
  bot._syncWindow = async () => { await serverUpdate; local = { ...server }; };
  bot.craft = async () => {
    assert.equal(server.oak_planks, batches * 4, 'previous batch must be confirmed');
    batches += 1;
    local.oak_log -= 1;
    local.oak_planks += 4;
    serverUpdate = delay(30).then(() => { server = { oak_log: server.oak_log - 1, oak_planks: server.oak_planks + 4 }; });
  };
  const actions = new Actions({ bot, config, navigator: { stop() {} } });
  const result = await actions.craft({ item: 'oak_planks', count: 8 });
  assert.equal(result.produced, 8);
  assert.equal(server.oak_planks, 8);
  assert.equal(server.oak_log, 0);
  assert.equal(batches, 2);
});

(async () => {
  let passed = 0;
  for (const { name, run } of tests) {
    try { await run(); passed += 1; console.log(`PASS ${name}`); }
    catch (err) { console.error(`FAIL ${name}: ${err.stack}`); }
  }
  console.log(`${passed}/${tests.length} engine control scenarios passed`);
  process.exitCode = passed === tests.length ? 0 : 1;
})().catch((err) => { console.error(err); process.exitCode = 1; });
