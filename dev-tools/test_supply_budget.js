'use strict';
const assert = require('node:assert/strict');
const { fixture } = require('./test_storage_memory');
const { storageBudget, preferredTools } = require('../engine/supply_budget');
const tests = [], test = (name, run) => tests.push({ name, run });

test('default storage deposits excess food/fuel/tools but keeps seeds', async () => {
  const f = fixture({ coal: 64, bread: 20, wheat_seeds: 20, beetroot_seeds: 2, iron_pickaxe: 1, stone_pickaxe: 3 });
  f.put('chest', 3);
  const r = await f.run();
  assert.equal(r.ok, true);
  assert.deepEqual(r.consumed, { coal: 56, bread: 16, wheat_seeds: 12, stone_pickaxe: 3 });
  assert.deepEqual(f.inventory, { coal: 8, bread: 4, wheat_seeds: 8, beetroot_seeds: 2, iron_pickaxe: 1, stone_pickaxe: 0 });
});
test('mining profile retains material/torch/food quantities across actual transfer', async () => {
  const f = fixture({ cobblestone: 64, bread: 16, coal: 64, torch: 64 }); f.put('chest', 3);
  assert.equal((await f.run({ profile: 'mining' })).ok, true);
  assert.deepEqual(f.inventory, { cobblestone: 32, bread: 8, coal: 16, torch: 16 });
});
test('explicit items and keep retain owner semantics', async () => {
  const f = fixture({ bread: 16, wheat_seeds: 20, coal: 64 }); f.put('chest', 3);
  await f.run({ items: ['wheat_seeds'], keep: ['bread'] });
  assert.equal(f.inventory.wheat_seeds, 0);
  assert.equal(f.inventory.bread, 16);
  assert.equal(f.inventory.coal, 64);
});
test('low durability upgrade does not replace a usable pick; duplicate variants retain healthiest one', async () => {
  const tools = [
    { name: 'diamond_pickaxe', type: 1, count: 1, maxDurability: 1561, durabilityUsed: 1560, nbt: { damage: 1560 } },
    { name: 'iron_pickaxe', type: 2, count: 1, maxDurability: 250, durabilityUsed: 140, nbt: { damage: 140 } },
    { name: 'iron_pickaxe', type: 2, count: 1, maxDurability: 250, durabilityUsed: 10, nbt: { damage: 10 } },
  ];
  assert.equal(preferredTools(tools)[0], tools[2]);
  const f = fixture(), stored = [], inventory = [...tools];
  const win = {
    items: () => inventory,
    containerItems: () => stored,
    async deposit(type, metadata, count, nbt) {
      const index = inventory.findIndex((it) => it.type === type && JSON.stringify(it.nbt) === JSON.stringify(nbt));
      assert(index >= 0, 'exact durable item NBT is required');
      stored.push(...inventory.splice(index, 1));
    },
    close() { f.bot.currentWindow = null; },
  };
  f.actions.openContainer = async () => { f.bot.currentWindow = win; return { win }; };
  const r = await f.actions.deposit({ x: 0, y: 1, z: 0, keepCounts: {}, keepBestTools: true });
  assert.equal(r.total, 2);
  assert.deepEqual(inventory, [tools[2]]);
});

test('real component-based tools keep the selected durable pick using its exact source slot', async () => {
  const Item = require('../engine/node_modules/prismarine-item')('1.21.1');
  const data = require('../engine/node_modules/minecraft-data')('1.21.1');
  const make = (damage) => Item.fromNotch({ present: true, itemId: data.itemsByName.iron_pickaxe.id,
    itemCount: 1, components: [{ type: 'damage', data: damage }], removeComponents: [] });
  const good = make(10), worn = make(240);
  const win = require('../engine/node_modules/prismarine-windows')('1.21.1')
    .createWindow(1, 'minecraft:generic_9x3', 'supply test');
  win.updateSlot(27, good); win.updateSlot(28, worn);
  const f = fixture(); let exactTransfers = 0;
  const transfer = ({ itemType, metadata, count, nbt, sourceStart, sourceEnd }) => {
    const item = win.findItemRange(sourceStart, sourceEnd, itemType, metadata, false, nbt);
    assert.equal(count, 1); assert(item);
    win.updateSlot(item.slot, null); win.updateSlot(win.firstEmptySlotRange(0, win.inventoryStart), item);
  };
  // Use the actual library's matching: null NBT selects the first matching type,
  // so merely adding components to a variant key cannot pass this regression.
  win.deposit = async (itemType, metadata, count, nbt) => transfer({ itemType, metadata, count, nbt,
    sourceStart: win.inventoryStart, sourceEnd: win.inventoryEnd });
  f.bot.transfer = async (options) => {
    exactTransfers++; assert.equal(options.sourceEnd, options.sourceStart + 1); transfer(options);
  };
  win.close = () => { f.bot.currentWindow = null; };
  f.actions.openContainer = async () => { f.bot.currentWindow = win; return { win }; };
  assert.equal(preferredTools(win.items())[0], good);
  const result = await f.actions.deposit({ x: 0, y: 1, z: 0, keepCounts: {}, keepBestTools: true });
  assert.equal(result.total, 1); assert.equal(exactTransfers, 1);
  assert.deepEqual(win.items(), [good]); assert.deepEqual(win.containerItems(), [worn]);
});

test('legacy null NBT cannot wildcard-deposit the protected named tool', async () => {
  const Item = require('../engine/node_modules/prismarine-item')('1.20.1');
  const data = require('../engine/node_modules/minecraft-data')('1.20.1');
  const make = (nbtData) => Item.fromNotch({ present: true, itemId: data.itemsByName.iron_pickaxe.id, itemCount: 1, nbtData });
  const good = make({ type: 'compound', value: { Damage: { type: 'int', value: 0 },
    display: { type: 'compound', value: { Name: { type: 'string', value: 'Keeper' } } } } });
  const spare = make(null);
  const win = require('../engine/node_modules/prismarine-windows')('1.20.1')
    .createWindow(1, 'minecraft:generic_9x3', 'supply test');
  win.updateSlot(27, good); win.updateSlot(28, spare);
  const f = fixture();
  const transfer = ({ itemType, metadata, count, nbt, sourceStart, sourceEnd }) => {
    const item = win.findItemRange(sourceStart, sourceEnd, itemType, metadata, false, nbt);
    assert.equal(count, 1); assert(item);
    win.updateSlot(item.slot, null); win.updateSlot(win.firstEmptySlotRange(0, win.inventoryStart), item);
  };
  win.deposit = async (itemType, metadata, count, nbt) => transfer({ itemType, metadata, count, nbt,
    sourceStart: win.inventoryStart, sourceEnd: win.inventoryEnd });
  f.bot.transfer = async (options) => transfer(options);
  win.close = () => { f.bot.currentWindow = null; };
  f.actions.openContainer = async () => { f.bot.currentWindow = win; return { win }; };
  const result = await f.actions.deposit({ x: 0, y: 1, z: 0, keepCounts: {}, keepBestTools: true });
  assert.equal(result.total, 1); assert.deepEqual(win.items(), [good]); assert.deepEqual(win.containerItems(), [spare]);
});
test('shared reserve is bounded, includes seeds and does not count golden apples as ordinary food', () => {
  const counts = storageBudget({ golden_apple: 1, bread: 64, wheat_seeds: 2, beetroot_seeds: 64 });
  assert.deepEqual({ bread: counts.bread, wheat: counts.wheat_seeds, beet: counts.beetroot_seeds }, { bread: 4, wheat: 2, beet: 8 });
  assert.equal(counts.golden_apple, 1);
});

(async () => {
  let failed = 0;
  for (const { name, run } of tests) try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
  console.log(`${tests.length - failed}/${tests.length} passed`); process.exitCode = failed ? 1 : 0;
})();
