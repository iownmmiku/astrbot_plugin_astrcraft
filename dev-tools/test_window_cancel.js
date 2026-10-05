#!/usr/bin/env node
'use strict';

// Real mineflayer inventory/transfer/window closures and the real action queue.
// Minecraft packets are recorded locally; this test does not connect to a server.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Actions } = require('../engine/actions');
const { TaskQueue, executionContext } = require('../engine/goals');
const { vec3, delay, CancelledError } = require('../engine/util');
const injectInventory = require('../engine/node_modules/mineflayer/lib/plugins/inventory');
const registry = require('../engine/node_modules/prismarine-registry')('1.20.4');
const windows = require('../engine/node_modules/prismarine-windows')('1.20.4');
const Item = require('../engine/node_modules/prismarine-item')(registry);

function item(name, count) { return new Item(registry.itemsByName[name].id, count); }

function fixture() {
  const bot = new EventEmitter();
  const packets = [];
  Object.assign(bot, {
    version: '1.20.4', registry,
    supportFeature: (name) => registry.supportFeature(name),
    _client: new EventEmitter(), entity: { position: vec3(0, 64, 0) },
    controls: {},
    setControlState(key, value) { this.controls[key] = value; },
    clearControlStates() { this.controls = {}; },
    stopDigging() {},
    blockAt: (position) => ({ name: 'chest', position }),
  });
  bot._client.write = (name, data) => packets.push({ name, data });
  injectInventory(bot, { hideErrors: false });
  bot.activateBlock = () => {};
  const makeWindow = async (id, type = 'minecraft:generic_9x3') => {
    const opening = bot.openBlock({});
    const window = windows.createWindow(id, type, 'test');
    bot.currentWindow = window;
    bot.emit('windowOpen', window);
    return opening;
  };
  return { bot, packets, makeWindow };
}

async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('fixture did not reach expected state');
    await delay(1);
  }
}

async function cancelledPrivateTransferPreservesNewWindow() {
  const { bot, packets, makeWindow } = fixture();
  const oldWindow = await makeWindow(1, 'minecraft:generic_9x6');
  oldWindow.updateSlot(40, item('bread', 2));
  oldWindow.updateSlot(oldWindow.inventoryStart, item('gold_ingot', 1));
  // Real mineflayer delays quick-bar clicks after digging. A double chest's
  // slot 40 hits this branch, leaving its private transfer pending across cancellation.
  bot.QUICK_BAR_START = 36;
  bot.lastDigTime = Date.now();
  let opened = 0;
  bot.openContainer = async () => {
    if (opened++ === 0) return oldWindow;
    return makeWindow(2);
  };
  const actions = new Actions({ bot, config: { get: () => false }, navigator: { stop() {} } });
  const queue = new TaskQueue({ onTaskAborted: () => actions.stopCurrent() });
  queue.cancelGraceMs = 10;
  let oldWindowClosed = 0;
  oldWindow.once('close', () => { oldWindowClosed += 1; });
  const oldTask = queue.submit({ name: 'old withdraw', run: () => actions.withdraw({
    x: 1, y: 64, z: 0, item: 'bread', count: 1,
  }) });
  await until(() => opened === 1);
  await delay(5);
  queue.cancel(oldTask.id);
  let finishNew;
  let newWindow;
  const newTask = queue.submit({ name: 'new container', run: async () => {
    const container = await actions.openContainer({ x: 2, y: 64, z: 0 });
    newWindow = container.win;
    newWindow.updateSlot(40, item('diamond', 3));
    bot.inventory.updateSlot(bot.inventory.inventoryStart, item('diamond', 3));
    bot.setControlState('jump', true);
    await new Promise((resolve) => { finishNew = resolve; });
    bot.setControlState('jump', false);
  } });
  await until(() => finishNew);
  assert.equal(oldWindowClosed, 1, 'cancel must notify the old window cleanup listeners');
  // Allow the real, uncancellable private click delay to finish in the old ALS context.
  await delay(600);
  assert.equal(bot.currentWindow, newWindow, 'old finally must not clear the new window');
  assert.equal(newWindow.slots[40].name, 'diamond', 'stale private click must not move a new slot');
  assert.equal(newWindow.slots[40].count, 3);
  assert.equal(newWindow.selectedItem, null);
  assert.equal(bot.inventory.slots[bot.inventory.inventoryStart].name, 'diamond',
    'old window.close must not copy an obsolete inventory over the new inventory');
  assert.equal(bot.controls.jump, true, 'new execution must remain allowed after the old context aborts');
  assert.equal(packets.filter((p) => p.name === 'window_click').length, 0);
  finishNew();
  await newTask.promise;
  await assert.rejects(oldTask.promise, CancelledError);
  assert.equal(newTask.status, 'done');
  assert.equal(bot.controls.jump, false);
  assert.equal(executionContext.getStore(), undefined);
  newWindow.close();
}

async function supersededWindowCloseIsHarmless() {
  const { bot, makeWindow } = fixture();
  bot.openContainer = () => makeWindow(1);
  new Actions({ bot, config: { get: () => false }, navigator: { stop() {} } });
  const oldWindow = await bot.openContainer();
  oldWindow.updateSlot(oldWindow.inventoryStart, item('gold_ingot', 1));
  const newWindow = await makeWindow(2);
  bot.inventory.updateSlot(bot.inventory.inventoryStart, item('diamond', 3));
  oldWindow.close();
  bot.closeWindow(oldWindow);
  assert.equal(bot.currentWindow, newWindow);
  assert.equal(bot.inventory.slots[bot.inventory.inventoryStart].name, 'diamond');
  let closed = 0;
  newWindow.once('close', () => { closed += 1; });
  newWindow.close();
  assert.equal(bot.currentWindow, null);
  assert.equal(closed, 1);
}

async function cancelledWindowOpeningDoesNotWaitForTheServer() {
  const { bot, makeWindow } = fixture();
  bot.openContainer = () => bot.openBlock({}); // Native windowOpen wait: no server reply yet.
  const actions = new Actions({ bot, config: { get: () => false }, navigator: { stop() {} } });
  const controller = new AbortController();
  const start = Date.now();
  const opening = actions.openContainer({ x: 1, y: 64, z: 0, signal: controller.signal });
  const rejected = assert.rejects(opening, CancelledError);
  await delay(5); controller.abort(); await rejected;
  assert(Date.now() - start < 150, 'cancellation cannot wait for the native 20-second window timeout');
  // The old private promise resumes on the same windowOpen event. It cannot
  // operate on or close the new task's live window after its signal aborted.
  const fresh = await makeWindow(2);
  await delay(5);
  assert.equal(bot.currentWindow, fresh);
  fresh.close();
}

(async () => {
  await cancelledPrivateTransferPreservesNewWindow();
  process.stdout.write('PASS cancelled private transfer preserves new window, slots and execution context\n');
  await supersededWindowCloseIsHarmless();
  process.stdout.write('PASS superseded close is harmless and active close notifies cleanup\n');
  await cancelledWindowOpeningDoesNotWaitForTheServer();
  process.stdout.write('PASS cancelled native window opening returns promptly and preserves the new window\n');
  process.stdout.write('3/3 window cancellation scenarios passed\n');
  process.exit(0);
})().catch((err) => { process.stderr.write(`${err.stack}\n`); process.exit(1); });
