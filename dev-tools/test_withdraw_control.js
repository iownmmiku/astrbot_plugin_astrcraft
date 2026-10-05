#!/usr/bin/env node
'use strict';

// Real Mineflayer inventory/transfer/window routines with independent server
// windows. Only Minecraft I/O is simulated; no game server is needed.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Actions } = require('../engine/actions');
const { executionContext } = require('../engine/goals');
const { vec3, delay, CancelledError } = require('../engine/util');
const injectInventory = require('../engine/node_modules/mineflayer/lib/plugins/inventory');
const registry = require('../engine/node_modules/prismarine-registry')('1.20.4');
const windows = require('../engine/node_modules/prismarine-windows')('1.20.4');
const Item = require('../engine/node_modules/prismarine-item')(registry);

function item(name, count) { return new Item(registry.itemsByName[name].id, count); }
function copy(value) { return value ? Item.fromNotch(Item.toNotch(value)) : null; }
function countIn(list, name) { return list.reduce((sum, value) => sum + (value?.name === name ? value.count : 0), 0); }

function fixture({ contents = [['bread', 8]], inventory = [], slots = 27, accept = true, rejectClick = null } = {}) {
  const bot = new EventEmitter(), packets = [];
  const server = windows.createWindow(1, slots === 54 ? 'minecraft:generic_9x6' : 'minecraft:generic_9x3', 'server');
  contents.forEach(([name, count, slot = 0]) => server.updateSlot(slot, item(name, count)));
  inventory.forEach(([name, count, offset]) => server.updateSlot(server.inventoryStart + offset, item(name, count)));
  Object.assign(bot, {
    version: '1.20.4', registry, supportFeature: (name) => registry.supportFeature(name),
    _client: new EventEmitter(), entity: { position: vec3(0, 64, 0) },
    blockAt: (position) => ({ name: 'chest', position }),
    findBlock: () => ({ name: 'chest', position: vec3(1, 64, 0) }),
    clearControlStates() {}, stopDigging() {},
  });
  let opened = 0, clicked = 0;
  bot._client.write = (name, data) => {
    packets.push({ name, data });
    if (name === 'window_click') {
      clicked += 1;
      if (rejectClick?.({ clicked, data, server })) throw new Error('simulated server transfer failure');
      if (accept) server.acceptClick({ ...data, item: server.slots[data.slot] || null });
    } else if (name === 'close_window' && server.selectedItem) {
      // On window close the simulated server returns any untouched cursor
      // remainder to its source. It never copies optimistic client slots.
      const source = server.slots[0];
      server.updateSlot(0, item(server.selectedItem.name, (source?.count || 0) + server.selectedItem.count));
      server.selectedItem = null;
    }
  };
  injectInventory(bot, { hideErrors: false });
  for (let i = 0; i < 36; i++) bot.inventory.updateSlot(bot.inventory.inventoryStart + i, copy(server.slots[server.inventoryStart + i]));
  bot.activateBlock = () => queueMicrotask(() => {
    const id = ++opened;
    server.id = id;
    bot._client.emit('window_items', { windowId: id, stateId: id, items: server.slots.map((value) => Item.toNotch(copy(value))), carriedItem: Item.toNotch(server.selectedItem) });
    bot._client.emit('open_window', { windowId: id, inventoryType: server.type, windowTitle: 'fixture chest' });
  });
  bot.openContainer = (block) => bot.openBlock(block);
  const actions = new Actions({ bot, config: { get: () => false }, navigator: { stop() {} } });
  return { bot, server, actions, packets, get opened() { return opened; }, get clicked() { return clicked; },
    run: (options = {}) => actions.withdraw({ x: 1, y: 64, z: 0, item: 'bread', count: 8, ...options }) };
}

const tests = [];
function test(name, run) { tests.push({ name, run }); }

test('native transfers count actual confirmed gain across existing inventory and multiple stacks', async () => {
  const f = fixture({ contents: [['bread', 3, 0], ['bread', 5, 1]], inventory: [['bread', 2, 0]] });
  const result = await f.run();
  assert.deepEqual(result, { ok: true, taken: { bread: 8 }, total: 8 });
  assert.equal(countIn(f.server.items(), 'bread'), 10);
  assert.equal(countIn(f.server.containerItems(), 'bread'), 0);
  assert.equal(countIn(f.bot.inventory.items(), 'bread'), 10);
  assert.equal(f.opened, 2, 'success needs a fresh server window snapshot');
  assert.equal(f.bot.currentWindow, null);
});

test('a registered item request cannot take a different wood species with a matching substring', async () => {
  const f = fixture({ contents: [['dark_oak_log', 8]] });
  await assert.rejects(f.run({ item: 'oak_log', count: 4 }), /缺少.*oak_log/);
  assert.equal(f.clicked, 0); assert.equal(countIn(f.server.containerItems(), 'dark_oak_log'), 8);
});

test('exact coal cannot be replaced by charcoal or a coal block', async () => {
  const f = fixture({ contents: [['charcoal', 8, 0], ['coal_block', 3, 1]] });
  await assert.rejects(f.run({ item: 'minecraft:coal', count: 2 }), /缺少.*coal/);
  assert.equal(f.clicked, 0);
});

test('partial exact wood stock cannot be padded by another species', async () => {
  const f = fixture({ contents: [['dark_oak_log', 8, 0], ['oak_log', 2, 1]] });
  const result = await f.run({ item: 'oak_log', count: 4 });
  assert.deepEqual(result, { ok: true, taken: { oak_log: 2 }, total: 2 });
  assert.equal(countIn(f.server.containerItems(), 'dark_oak_log'), 8);
});

test('a raw food request cannot silently withdraw its cooked product', async () => {
  const f = fixture({ contents: [['cooked_beef', 4]] });
  await assert.rejects(f.run({ item: 'beef', count: 1 }), /缺少.*beef/);
  assert.equal(f.clicked, 0);
});

test('explicit item names normalize namespace and case before exact transfer', async () => {
  const f = fixture({ contents: [['dark_oak_log', 8, 0], ['oak_log', 3, 1]] });
  assert.deepEqual(await f.run({ item: 'minecraft:OAK_LOG', count: 2 }),
    { ok: true, taken: { oak_log: 2 }, total: 2 });
});

test('unregistered category shorthand keeps its existing matching behavior', async () => {
  const f = fixture({ contents: [['oak_log', 2, 0], ['spruce_log', 2, 1]] });
  assert.deepEqual(await f.run({ item: 'log', count: 3 }),
    { ok: true, taken: { oak_log: 2, spruce_log: 1 }, total: 3 });
});

test('optimistic native clicks rejected by the server cannot report successful withdrawal', async () => {
  const f = fixture({ accept: false });
  const result = await f.run();
  assert.deepEqual(result, { ok: false, taken: {}, total: 0,
    reason: '服务端没有确认背包增加与容器减少，请重新查看容器和背包后再取物' });
  assert.equal(countIn(f.server.containerItems(), 'bread'), 8);
  assert.equal(countIn(f.bot.inventory.items(), 'bread'), 0);
  assert(f.clicked > 0, 'real native click routines ran before server rejection');
  assert.equal(f.opened, 2);
});

test('a full slot layout can still receive food into an existing stack', async () => {
  const inventory = Array.from({ length: 36 }, (_, offset) => [offset === 0 ? 'bread' : 'cobblestone', offset === 0 ? 60 : 64, offset]);
  const f = fixture({ inventory });
  assert.equal(f.bot.inventory.emptySlotCount(), 0);
  const result = await f.run();
  assert.deepEqual(result, { ok: true, taken: { bread: 4 }, total: 4 });
  assert.equal(countIn(f.server.items(), 'bread'), 64);
  assert.equal(countIn(f.server.containerItems(), 'bread'), 4);
  assert.equal(f.server.selectedItem, null);
  assert.equal(f.bot.inventory.emptySlotCount(), 0);
});

test('an entirely full backpack reports no transfer without touching the cursor', async () => {
  const f = fixture({ inventory: Array.from({ length: 36 }, (_, offset) => ['cobblestone', 64, offset]) });
  const result = await f.run();
  assert.deepEqual(result, { ok: false, taken: {}, total: 0,
    reason: '背包没有可容纳 bread 的空位或堆叠空间，先整理背包再取物' });
  assert.equal(f.clicked, 0);
  assert.equal(countIn(f.server.containerItems(), 'bread'), 8);
  assert.equal(f.server.selectedItem, null);
});

test('ordinary failure after partial native transfer preserves only server-confirmed progress', async () => {
  const inventory = Array.from({ length: 35 }, (_, offset) => [offset === 0 ? 'bread' : 'cobblestone', offset === 0 ? 60 : 64, offset]);
  const f = fixture({ inventory, rejectClick: ({ data, server }) => data.slot === server.inventoryStart + 35 });
  const result = await f.run();
  assert.deepEqual(result, { ok: true, taken: { bread: 4 }, total: 4 });
  assert.equal(countIn(f.server.items(), 'bread'), 64);
  assert.equal(countIn(f.server.containerItems(), 'bread'), 4);
  assert.equal(countIn(f.bot.inventory.items(), 'bread'), 64);
  assert.equal(f.bot.currentWindow, null);
});

test('a server snapshot with only one changed side rejects an optimistic success', async () => {
  const f = fixture();
  const activate = f.bot.activateBlock;
  f.bot.activateBlock = (...args) => {
    if (f.opened === 1) f.server.updateSlot(0, item('bread', 8));
    return activate(...args);
  };
  const result = await f.run();
  assert.deepEqual(result, { ok: false, taken: {}, total: 0,
    reason: '服务端没有确认背包增加与容器减少，请重新查看容器和背包后再取物' });
  assert.equal(countIn(f.bot.inventory.items(), 'bread'), 8, 'inventory gain alone is not a verified container transfer');
});

test('empty or nonmatching containers keep their explicit missing-item failure', async () => {
  for (const contents of [[], [['coal', 3]]]) {
    const f = fixture({ contents });
    await assert.rejects(f.run(), /缺少.*箱子/);
    assert.equal(f.bot.currentWindow, null);
    assert.equal(f.clicked, 0);
  }
});

test('decimal and nonfinite requests never send fractional or unbounded transfer counts', async () => {
  for (const [request, expected] of [[2.9, 2], [Infinity, 1], [NaN, 1], [0, 1], [-5, 1]]) {
    const f = fixture();
    const result = await f.run({ count: request });
    assert.deepEqual(result, { ok: true, taken: { bread: expected }, total: expected });
  }
});

test('cancelled native private transfer returns promptly and cannot corrupt a newer window', async () => {
  const f = fixture({ contents: [['bread', 8, 40]], slots: 54 });
  f.bot.QUICK_BAR_START = 36;
  f.bot.lastDigTime = Date.now();
  const controller = new AbortController();
  const pending = f.run({ signal: controller.signal });
  const rejected = assert.rejects(pending, CancelledError);
  while (f.opened === 0) await delay(1);
  await delay(5);
  const started = Date.now();
  controller.abort();
  await rejected;
  assert(Date.now() - started < 150, 'withdraw must race cancellation while native click is awaiting its private delay');
  const newer = await f.actions.openContainer({ x: 2, y: 64, z: 0 });
  newer.win.updateSlot(newer.win.inventoryStart, item('diamond', 3));
  f.bot.inventory.updateSlot(f.bot.inventory.inventoryStart, item('diamond', 3));
  await delay(600);
  assert.equal(f.bot.currentWindow, newer.win);
  assert.equal(newer.win.slots[newer.win.inventoryStart].name, 'diamond');
  assert.equal(newer.win.slots[newer.win.inventoryStart].count, 3);
  assert.equal(f.bot.inventory.items()[0].name, 'diamond');
  assert.equal(f.clicked, 0, 'old private clicks must never reach simulated Minecraft I/O');
  newer.win.close();
});

test('cancelled server confirmation cannot claim taken items or close a new task window', async () => {
  const f = fixture(), nativeActivate = f.bot.activateBlock;
  let confirmationPending = false, holdConfirmation = true;
  f.bot.activateBlock = (...args) => {
    if (f.opened === 1 && holdConfirmation) {
      holdConfirmation = false;
      confirmationPending = true;
      return;
    }
    return nativeActivate(...args);
  };
  const controller = new AbortController();
  const pending = f.run({ signal: controller.signal });
  const rejected = assert.rejects(pending, CancelledError);
  while (!confirmationPending) await delay(1);
  controller.abort();
  await rejected;
  const fresh = await f.actions.openContainer({ x: 2, y: 64, z: 0 });
  // The cancelled native openBlock's windowOpen listener also receives the
  // new task's event. Its old action must not continue verification or close it.
  await delay(5);
  assert.equal(f.bot.currentWindow, fresh.win);
  fresh.win.close();
  assert.equal(executionContext.getStore(), undefined);
});

test('consecutive production container openings space native interaction requests', async () => {
  const f = fixture(), nativeActivate = f.bot.activateBlock, activatedAt = [];
  f.bot.activateBlock = (...args) => { activatedAt.push(Date.now()); return nativeActivate(...args); };
  const first = await f.actions.openContainer({ x: 1, y: 64, z: 0 });
  first.win.close();
  const second = await f.actions.openContainer({ x: 1, y: 64, z: 0 });
  assert.equal(activatedAt.length, 2);
  assert(activatedAt[1] - activatedAt[0] >= 60,
    `actual native interaction spacing ${activatedAt[1] - activatedAt[0]}ms must avoid a Paper interaction burst`);
  assert.equal(f.opened, 2);
  second.win.close();
});

test('container pacing completes even when the wall clock stops advancing', async () => {
  const f = fixture(), realNow = Date.now, frozen = realNow(), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  Date.now = () => frozen;
  try {
    const first = await f.actions.openContainer({ x: 1, y: 64, z: 0, signal: controller.signal });
    first.win.close();
    const second = await f.actions.openContainer({ x: 1, y: 64, z: 0, signal: controller.signal });
    assert.equal(f.opened, 2, 'request pacing must use a monotonic clock');
    second.win.close();
  } finally { Date.now = realNow; clearTimeout(timer); }
});

test('cancellation during interaction throttling sends no new native request or late window', async () => {
  const f = fixture(), nativeActivate = f.bot.activateBlock;
  let activated = 0;
  f.bot.activateBlock = (...args) => { activated += 1; return nativeActivate(...args); };
  const first = await f.actions.openContainer({ x: 1, y: 64, z: 0 });
  first.win.close();
  const controller = new AbortController();
  const pending = f.actions.openContainer({ x: 1, y: 64, z: 0, signal: controller.signal });
  const rejected = assert.rejects(pending, CancelledError);
  await delay(5);
  const started = Date.now();
  controller.abort();
  await rejected;
  assert(Date.now() - started < 50, 'throttling cancellation must not wait for the interaction timer');
  await delay(100);
  assert.equal(activated, 1, 'cancelled throttling must never reach native Minecraft interaction');
  assert.equal(f.opened, 1);
  assert.equal(f.bot.currentWindow, null);
  const fresh = await f.actions.openContainer({ x: 2, y: 64, z: 0 });
  assert.equal(activated, 2, 'the next independent task still opens its own window');
  assert.equal(f.bot.currentWindow, fresh.win);
  fresh.win.close();
});

(async () => {
  for (const { name, run } of tests) {
    await run();
    process.stdout.write(`PASS ${name}\n`);
  }
  process.stdout.write(`${tests.length}/${tests.length} withdraw control scenarios passed\n`);
  process.exit(0);
})().catch((err) => { process.stderr.write(`${err.stack}\n`); process.exit(1); });
