'use strict';

// Production Actions.smelt. Only authoritative furnace/slot I/O is simulated.
process.env.MC_ENGINE_LOG_LEVEL = 'error';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Actions, MissingItemError, guessSmeltOutput } = require('../engine/actions');
const { vec3, CancelledError } = require('../engine/util');
const { executionContext } = require('../engine/goals');
const { SkillContext } = require('../engine/skills/common');
const { smeltOres } = require('../engine/skills/mining');
const data = require('../engine/node_modules/minecraft-data')('1.20.1');
const { Recipe } = require('../engine/node_modules/prismarine-recipe')('1.20.1');
const tests = [], test = (name, run) => tests.push({ name, run });

function fixture(inventory, { stations = ['furnace'], heat = 0, rawHeatTicks = null, stored = null,
  existingInput = null, existingOutput = null, rejectOutput = false, stacks = {} } = {}) {
  const counts = { ...inventory }, calls = [], bot = new EventEmitter();
  const item = (name, count) => name && count > 0 ? { name, count, type: data.itemsByName[name].id,
    stackSize: data.itemsByName[name].stackSize } : null;
  Object.assign(bot, { entity: { position: vec3(0, 64, 0) }, version: '1.20.1', health: 20,
    game: { dimension: 'overworld' }, _client: new EventEmitter(),
    inventory: { items: () => Object.entries(counts).flatMap(([name, count]) => {
      if (!stacks[name]) return [item(name, count)].filter(Boolean);
      let left = count;
      const items = stacks[name].map((size) => { const take = Math.min(size, left); left -= take; return item(name, take); });
      if (left > 0) items.push(item(name, left));
      return items.filter(Boolean);
    }) },
    findBlock: ({ matching, useExtraInfo }) => stations.map((name, n) => ({ name, position: vec3(1 + n, 64, 0) }))
      .find((block) => matching({ name: block.name, type: data.blocksByName[block.name].id }) && matching(block) &&
        (typeof useExtraInfo !== 'function' || useExtraInfo(block))) || null,
    clearControlStates() {}, closeWindow(win) { if (this.currentWindow === win) this.currentWindow = null; },
  });
  bot._client.write = () => {};
  let window;
  bot.openFurnace = async (block) => {
    calls.push({ operation: 'open', station: block.name });
    let input = existingInput, output = existingOutput, fuel = stored;
    let inserted = null;
    window = { id: 7, fuelSeconds: heat,
      inputItem: () => input, outputItem: () => output, fuelItem: () => fuel,
      async putInput(type, _metadata, count) {
        const name = data.items[type].name;
        assert.ok(counts[name] >= count); counts[name] -= count;
        inserted = { name, count }; input = item(name, count);
        calls.push({ operation: 'input', name, count });
        if (heat > 0 || rawHeatTicks > 0 || stored) complete();
      },
      async putFuel(type, _metadata, count) {
        const name = data.items[type].name;
        assert.ok(count <= data.items[type].stackSize, 'fuel transfer must fit in the one furnace slot');
        assert.ok(counts[name] >= count); counts[name] -= count;
        calls.push({ operation: 'fuel', name, count }); complete();
      },
      async takeOutput() {
        calls.push({ operation: 'output' });
        if (!rejectOutput) { counts[output.name] = (counts[output.name] || 0) + output.count; output = null; }
      },
      async takeInput() { counts[input.name] = (counts[input.name] || 0) + input.count; input = null; calls.push({ operation: 'return-input' }); },
      async takeFuel() { counts[fuel.name] = (counts[fuel.name] || 0) + fuel.count; fuel = null; },
      close() { if (bot.currentWindow === window) bot.currentWindow = null; calls.push({ operation: 'close' }); },
    };
    function complete() {
      output = item(guessSmeltOutput(inserted.name), inserted.count);
      input = null;
    }
    if (rawHeatTicks !== null) bot._client.emit('craft_progress_bar', { windowId: window.id, property: 0, value: rawHeatTicks });
    bot.currentWindow = window; return window;
  };
  const actions = new Actions({ bot, config: { get: () => false }, navigator: { goTo() { throw new Error('unexpected travel'); }, stop() {} } });
  return { actions, bot, counts, calls, get window() { return window; },
    run: (itemName = 'raw_iron', count = 3, options = {}) => actions.smelt({ item: itemName, count, ...options }) };
}

test('one plank only admits one input and leaves the other raw material in inventory', async () => {
  const f = fixture({ raw_iron: 3, oak_planks: 1 }); const result = await f.run();
  assert.equal(result.produced, 1); assert.equal(f.counts.raw_iron, 2);
  assert.deepEqual(f.calls.filter((c) => c.operation === 'fuel'), [{ operation: 'fuel', name: 'oak_planks', count: 1 }]);
});
test('two planks admit three inputs with correct fractional fuel accounting', async () => {
  const f = fixture({ raw_iron: 4, oak_planks: 2 }); const result = await f.run('raw_iron', 4);
  assert.equal(result.produced, 3); assert.equal(f.counts.raw_iron, 1); assert.equal(f.counts.oak_planks, 0);
});
test('one stick cannot consume an input that it cannot finish', async () => {
  const f = fixture({ raw_iron: 1, stick: 1 }); await assert.rejects(f.run('raw_iron', 1), MissingItemError);
  assert.equal(f.counts.raw_iron, 1); assert.equal(f.counts.stick, 1);
  assert.equal(f.calls.some((c) => c.operation === 'input'), false); assert.equal(f.bot.currentWindow, null);
});
test('two sticks are sufficient for exactly one item', async () => {
  const f = fixture({ raw_iron: 2, stick: 2 }); const result = await f.run('raw_iron', 2);
  assert.equal(result.produced, 1); assert.equal(f.counts.raw_iron, 1); assert.equal(f.counts.stick, 0);
});

test('reserved tool sticks limit both input and actual inserted fuel', async () => {
  const f = fixture({ raw_iron: 3, stick: 4 });
  const result = await f.run('raw_iron', 3, { reserveItems: { stick: 2 } });
  assert.equal(result.produced, 1); assert.equal(f.counts.raw_iron, 2); assert.equal(f.counts.stick, 2);
  assert.deepEqual(f.calls.filter((c) => c.operation === 'input'), [{ operation: 'input', name: 'raw_iron', count: 1 }]);
  assert.deepEqual(f.calls.filter((c) => c.operation === 'fuel'), [{ operation: 'fuel', name: 'stick', count: 2 }]);
});

test('explicit stick fuel cannot bypass the reserved tool sticks', async () => {
  const f = fixture({ raw_iron: 3, stick: 4 });
  const result = await f.run('raw_iron', 3, { fuel: 'stick', reserveItems: { stick: 2 } });
  assert.equal(result.produced, 1); assert.equal(f.counts.stick, 2); assert.equal(f.counts.raw_iron, 2);
  assert.equal(f.calls.find((c) => c.operation === 'fuel').count, 2);
});

test('a cold furnace with fully reserved fuel never moves raw material or fuel', async () => {
  const f = fixture({ raw_iron: 3, stick: 4 });
  await assert.rejects(f.run('raw_iron', 3, { reserveItems: { stick: 4 } }), MissingItemError);
  assert.equal(f.counts.stick, 4); assert.equal(f.counts.raw_iron, 3);
  assert.equal(f.calls.some((c) => ['input', 'fuel'].includes(c.operation)), false);
  assert.equal(f.bot.currentWindow, null);
  assert.equal(f.bot._client.listenerCount('craft_progress_bar'), 0);
});

test('fully reserved backpack fuel still allows confirmed furnace heat', async () => {
  const f = fixture({ raw_iron: 3, stick: 4 }, { heat: 35 });
  const result = await f.run('raw_iron', 3, { reserveItems: { stick: 4 } });
  assert.equal(result.produced, 3); assert.equal(f.counts.stick, 4); assert.equal(f.counts.raw_iron, 0);
  assert.equal(f.calls.some((c) => c.operation === 'fuel'), false);
});

test('fully reserved explicit fuel still allows fuel already in the furnace', async () => {
  const f = fixture({ raw_iron: 3, stick: 4 }, { stored: { name: 'coal', count: 1 } });
  const result = await f.run('raw_iron', 3, { fuel: 'stick', reserveItems: { stick: 4 } });
  assert.equal(result.produced, 3); assert.equal(f.counts.stick, 4);
  assert.equal(f.calls.some((c) => c.operation === 'fuel'), false);
});

test('ordinary smelting keeps the previous unreserved stick behavior', async () => {
  const f = fixture({ raw_iron: 3, stick: 4 });
  assert.equal((await f.run()).produced, 2); assert.equal(f.counts.stick, 0); assert.equal(f.counts.raw_iron, 1);
});

test('same-name fuel stacks share one reserve and all free fuel remains usable', async () => {
  const f = fixture({ raw_iron: 3, stick: 6 }, { stacks: { stick: [3, 3] } });
  const result = await f.run('raw_iron', 3, { reserveItems: { stick: 2 } });
  assert.equal(result.produced, 2); assert.equal(f.counts.stick, 2); assert.equal(f.counts.raw_iron, 1);
  assert.equal(f.calls.find((c) => c.operation === 'fuel').count, 4);
});

test('explicit multi-stack fuel cannot subtract a reserve separately from each stack', async () => {
  const f = fixture({ raw_iron: 10, coal: 67 }, { stacks: { coal: [64, 3] } });
  const result = await f.run('raw_iron', 10, { fuel: 'coal', reserveItems: { coal: 65 } });
  assert.equal(result.produced, 10); assert.equal(f.counts.coal, 65);
  assert.equal(f.calls.find((c) => c.operation === 'fuel').count, 2);
});

test('explicit multi-stack fuel reduces its batch when only one unreserved item remains', async () => {
  const f = fixture({ raw_iron: 10, coal: 67 }, { stacks: { coal: [64, 3] } });
  const result = await f.run('raw_iron', 10, { fuel: 'coal', reserveItems: { coal: 66 } });
  assert.equal(result.produced, 8); assert.equal(f.counts.coal, 66); assert.equal(f.counts.raw_iron, 2);
  assert.equal(f.calls.find((c) => c.operation === 'fuel').count, 1);
});

test('aggregated fuel cannot overfill the single furnace slot', async () => {
  const f = fixture({ raw_iron: 40, stick: 128 }, { stacks: { stick: [64, 64] } });
  const result = await f.run('raw_iron', 40, { reserveItems: { stick: 2 } });
  assert.equal(result.produced, 32); assert.equal(f.counts.stick, 64); assert.equal(f.counts.raw_iron, 8);
  assert.equal(f.calls.find((c) => c.operation === 'fuel').count, 64);
});

test('inventory changes during furnace opening cannot spend the reserved remainder', async () => {
  const f = fixture({ raw_iron: 3, coal: 3 });
  const open = f.bot.openFurnace;
  f.bot.openFurnace = async (...args) => { const win = await open(...args); f.counts.coal = 1; return win; };
  await assert.rejects(f.run('raw_iron', 3, { reserveItems: { coal: 1 } }), MissingItemError);
  assert.equal(f.counts.coal, 1); assert.equal(f.counts.raw_iron, 3);
  assert.equal(f.calls.some((c) => ['input', 'fuel'].includes(c.operation)), false);
});

test('fully reserved preferred fuel falls back to another available fuel', async () => {
  const f = fixture({ raw_iron: 3, coal: 4, oak_planks: 2 });
  const result = await f.run('raw_iron', 3, { reserveItems: { coal: 4 } });
  assert.equal(result.produced, 3); assert.equal(f.counts.coal, 4); assert.equal(f.counts.oak_planks, 0);
  assert.equal(f.calls.find((c) => c.operation === 'fuel').name, 'oak_planks');
});
test('other overworld planks are usable and nether planks are excluded', async () => {
  const f = fixture({ raw_iron: 1, crimson_planks: 8, acacia_planks: 1 }); const result = await f.run('raw_iron', 1);
  assert.equal(result.produced, 1); assert.equal(f.counts.crimson_planks, 8); assert.equal(f.counts.acacia_planks, 0);
});
test('ore skips a closer smoker and uses the compatible furnace', async () => {
  const f = fixture({ raw_iron: 1, coal: 1 }, { stations: ['smoker', 'furnace'] }); await f.run('raw_iron', 1);
  assert.equal(f.calls[0].station, 'furnace');
});
test('food skips a closer blast furnace and uses a smoker', async () => {
  const f = fixture({ cod: 1, coal: 1 }, { stations: ['blast_furnace', 'smoker'] }); const result = await f.run('cod', 1);
  assert.equal(f.calls[0].station, 'smoker'); assert.equal(result.output, 'cooked_cod');
});
test('existing furnace output cannot masquerade as this batch', async () => {
  const f = fixture({ raw_iron: 1, coal: 1 }, { existingOutput: { name: 'iron_ingot', count: 8 } });
  await assert.rejects(f.run('raw_iron', 1), /已有原料或成品/);
  assert.equal(f.counts.iron_ingot || 0, 0); assert.equal(f.counts.raw_iron, 1); assert.equal(f.counts.coal, 1);
});
test('a busy input is preserved without merging a new batch', async () => {
  const f = fixture({ raw_iron: 1, coal: 1 }, { existingInput: { name: 'raw_gold', count: 2 } });
  await assert.rejects(f.run('raw_iron', 1), /已有原料或成品/); assert.equal(f.counts.raw_iron, 1);
});
test('actual remaining heat can finish another batch with no backpack fuel', async () => {
  const f = fixture({ iron_ore: 1 }, { heat: 25 }); const result = await f.run('iron_ore', 1);
  assert.equal(result.produced, 1); assert.equal(f.calls.some((c) => c.operation === 'fuel'), false);
});
test('stored furnace fuel is usable without collecting more', async () => {
  const f = fixture({ raw_iron: 1 }, { stored: { name: 'coal', count: 1 } }); const result = await f.run('raw_iron', 1);
  assert.equal(result.produced, 1); assert.equal(f.calls.some((c) => c.operation === 'fuel'), false);
});
test('remaining-fuel packet before the library denominator still proves actual heat', async () => {
  const f = fixture({ iron_ore: 1, oak_planks: 1 }, { heat: 0, rawHeatTicks: 500 });
  const result = await f.run('iron_ore', 1);
  assert.equal(result.produced, 1); assert.equal(f.counts.oak_planks, 1);
  assert.equal(f.calls.some((c) => c.operation === 'fuel'), false);
  assert.equal(f.bot._client.listenerCount('craft_progress_bar'), 0);
});
test('cold empty furnace reports missing fuel and leaves the input untouched', async () => {
  const f = fixture({ raw_iron: 1 }); await assert.rejects(f.run('raw_iron', 1), MissingItemError);
  assert.equal(f.counts.raw_iron, 1); assert.equal(f.bot.currentWindow, null);
});

function runSkill(f, options = {}) {
  f.bot.blockAt = (position) => ({ name: position.y < 64 ? 'bedrock' : 'air', position,
    boundingBox: position.y < 64 ? 'block' : 'empty', diggable: false });
  f.bot.findBlocks = () => { f.calls.push({ operation: 'resource-search' }); throw new Error('unexpected resource search'); };
  return smeltOres({ actions: f.actions, nav: { stop() {}, async goTo() {
    f.calls.push({ operation: 'travel' }); throw new Error('unexpected travel');
  } }, state: { nearbyEntities: () => [] },
  ctx: new SkillContext({ deadline: Date.now() + 3000 }), item: 'raw_iron', count: 3,
  allowSearch: false, ...options });
}

function furnacePreparation(inventory, { table = false, rejectTable = false } = {}) {
  const f = fixture(inventory, { stations: [] }), cells = new Map();
  const key = (p) => `${p.x},${p.y},${p.z}`;
  const block = (name, p) => ({ name, position: p, type: data.blocksByName[name]?.id,
    boundingBox: name === 'air' ? 'empty' : 'block', diggable: false });
  if (table) cells.set('1,64,0', block('crafting_table', vec3(1, 64, 0)));
  f.bot.blockAt = (p) => cells.get(key(p)) || block(p.y < 64 ? 'bedrock' : 'air', p);
  f.bot.findBlock = ({ matching, useExtraInfo }) => [...cells.values()].find((b) => matching(b) &&
    (typeof useExtraInfo !== 'function' || useExtraInfo(b))) || null;
  f.bot.findBlocks = () => { throw new Error('restricted preparation cannot search for resources'); };
  f.bot.recipesAll = (type) => Recipe.find(type, null);
  f.bot.craft = async (recipe, times, actualTable) => {
    if (recipe.requiresTable && !actualTable) throw new Error('Recipe requires craftingTable');
    const name = data.items[recipe.result.id].name;
    f.calls.push({ operation: 'craft', name });
    for (const delta of recipe.delta) {
      const input = data.items[delta.id].name;
      f.counts[input] = (f.counts[input] || 0) + delta.count * times;
      assert.ok(f.counts[input] >= 0, `native recipe consumed missing ${input}`);
    }
  };
  // The production recipe selection, table dependency and inventory result
  // checks remain active. Only accepted crafting-grid I/O is simulated.
  f.actions._syncInventoryWindow = async () => {};
  f.actions._clearCraftingGrid = async () => {};
  f.actions._spotInFront = () => vec3(cells.size + 1, 64, 0);
  f.actions.place = async ({ x, y, z, item }) => {
    if (rejectTable && item === 'crafting_table') throw new Error('table placement rejected');
    assert.ok(f.counts[item] > 0); f.counts[item]--;
    const p = vec3(x, y, z); cells.set(key(p), block(item, p));
    f.calls.push({ operation: 'place', name: item }); return { ok: true };
  };
  f.skill = (options = {}) => smeltOres({ actions: f.actions, nav: f.actions._nav,
    state: { nearbyEntities: () => [] }, ctx: new SkillContext({ deadline: Date.now() + 6000 }),
    item: 'raw_iron', count: 3, allowSearch: false, ...options });
  f.cells = cells;
  return f;
}

test('missing furnace prepares its real crafting table from existing planks before smelting', async () => {
  const f = furnacePreparation({ raw_iron: 3, cobblestone: 8, oak_planks: 4, coal: 1 });
  const r = await f.skill();
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(f.counts.iron_ingot, 3);
  assert.deepEqual(f.calls.filter((c) => c.operation === 'craft').map((c) => c.name), ['crafting_table', 'furnace']);
  assert.equal(f.counts.oak_planks, 0); assert.equal(f.counts.cobblestone, 0);
});

test('missing furnace may turn one carried log into its crafting table', async () => {
  const f = furnacePreparation({ raw_iron: 3, cobblestone: 8, spruce_log: 1, coal: 1 });
  assert.equal((await f.skill()).ok, true); assert.equal(f.counts.iron_ingot, 3);
  assert.deepEqual(f.calls.filter((c) => c.operation === 'craft').map((c) => c.name),
    ['spruce_planks', 'crafting_table', 'furnace']);
});

test('existing or carried table lets furnace construction use no extra wood', async () => {
  for (const carried of [false, true]) {
    const f = furnacePreparation({ raw_iron: 3, cobblestone: 8, coal: 1, crafting_table: Number(carried) }, { table: !carried });
    assert.equal((await f.skill()).ok, true);
    assert.deepEqual(f.calls.filter((c) => c.operation === 'craft').map((c) => c.name), ['furnace']);
  }
});

test('restricted furnace preparation with insufficient table wood preserves ore and stone', async () => {
  const f = furnacePreparation({ raw_iron: 3, cobblestone: 8, oak_planks: 3, coal: 1 });
  const r = await f.skill(); assert.equal(r.ok, false);
  assert.equal(f.counts.raw_iron, 3); assert.equal(f.counts.cobblestone, 8); assert.equal(f.counts.oak_planks, 3);
  assert.equal(f.calls.some((c) => ['place', 'input', 'fuel', 'craft'].includes(c.operation)), false);
  assert.match(r.reason, /工作台/);
});

test('a rejected table placement cannot continue crafting a furnace or consuming ore', async () => {
  const f = furnacePreparation({ raw_iron: 3, cobblestone: 8, oak_planks: 4, coal: 1 }, { rejectTable: true });
  const r = await f.skill(); assert.equal(r.ok, false);
  assert.equal(f.counts.crafting_table, 1); assert.equal(f.counts.raw_iron, 3); assert.equal(f.counts.cobblestone, 8);
  assert.deepEqual(f.calls.filter((c) => c.operation === 'craft').map((c) => c.name), ['crafting_table']);
});

test('furnace construction reuses a verified remembered table instead of making another', async () => {
  const f = furnacePreparation({ raw_iron: 3, cobblestone: 8, coal: 1 });
  f.actions.stations = { remember() {} };
  let visited = 0;
  f.actions._rememberedStation = async (kind) => {
    if (kind === 'furnace') return null;
    assert.equal(kind, 'crafting_table'); visited++;
    const p = vec3(1, 64, 0), table = { name: 'crafting_table', position: p, boundingBox: 'block' };
    f.cells.set('1,64,0', table); return table;
  };
  assert.equal((await f.skill()).ok, true); assert.equal(visited, 1);
  assert.deepEqual(f.calls.filter((c) => c.operation === 'craft').map((c) => c.name), ['furnace']);
});

test('table preparation cancellation propagates without making a furnace', async () => {
  const f = furnacePreparation({ raw_iron: 3, cobblestone: 8, oak_planks: 4, coal: 1 });
  const cancelled = new CancelledError('table preparation superseded');
  f.bot.craft = async () => { throw cancelled; };
  await assert.rejects(f.skill(), (err) => err === cancelled);
  assert.equal(f.counts.cobblestone, 8); assert.equal(f.counts.raw_iron, 3);
  assert.equal(f.calls.some((c) => ['input', 'fuel', 'place'].includes(c.operation)), false);
});

test('table preparation keeps its preparation barrier instead of downgrading it to ordinary failure', async () => {
  const f = furnacePreparation({ raw_iron: 3, cobblestone: 8, crafting_table: 1, coal: 1 });
  const blocked = new Error('the closed home changed'); blocked.name = 'PreparationBlockedError';
  f.actions._ensureCraftingTable = async () => { throw blocked; };
  await assert.rejects(f.skill(), (err) => err === blocked);
  assert.equal(f.counts.cobblestone, 8); assert.equal(f.counts.raw_iron, 3);
  assert.equal(f.calls.length, 0);
});

test('restricted charcoal preparation retains its only requested log instead of turning it into a table', async () => {
  const f = furnacePreparation({ oak_log: 1, cobblestone: 8, coal: 1 });
  const r = await f.skill({ item: 'oak_log', count: 1 });
  assert.equal(r.ok, false); assert.match(r.reason, /工作台木材/);
  assert.equal(f.counts.oak_log, 1); assert.equal(f.counts.cobblestone, 8);
  assert.equal(f.counts.charcoal || 0, 0); assert.deepEqual(f.calls, []);
});

test('one surplus log makes a table without consuming the log requested as charcoal', async () => {
  const f = furnacePreparation({ oak_log: 2, cobblestone: 8, coal: 1 });
  const r = await f.skill({ item: 'oak_log', count: 1 });
  assert.equal(r.ok, true, r.reason); assert.deepEqual(r.produced, { charcoal: 1 });
  assert.equal(f.counts.oak_log, 0);
  assert.deepEqual(f.calls.filter((c) => c.operation === 'craft').map((c) => c.name), ['oak_planks', 'crafting_table', 'furnace']);
  assert.deepEqual(f.calls.filter((c) => c.operation === 'input').map(({ name, count }) => ({ name, count })), [{ name: 'oak_log', count: 1 }]);
});

test('table planks use another carried tree species while retaining the requested log', async () => {
  const f = furnacePreparation({ oak_log: 1, spruce_log: 1, cobblestone: 8, coal: 1 });
  const r = await f.skill({ item: 'oak_log', count: 1 });
  assert.equal(r.ok, true, r.reason); assert.deepEqual(r.produced, { charcoal: 1 });
  assert.deepEqual(f.calls.filter((c) => c.operation === 'craft').map((c) => c.name), ['spruce_planks', 'crafting_table', 'furnace']);
  assert.equal(f.calls.some((c) => c.operation === 'craft' && c.name === 'oak_planks'), false);
});

test('the charcoal input and same-name explicit log reserve are not added twice', async () => {
  const f = furnacePreparation({ oak_log: 2, cobblestone: 8, coal: 1 });
  const r = await f.skill({ item: 'oak_log', count: 1, reserveItems: { 'minecraft:oak_log': 1 } });
  assert.equal(r.ok, true, r.reason); assert.deepEqual(r.produced, { charcoal: 1 });
  assert.equal(f.calls.filter((c) => c.operation === 'craft' && c.name === 'oak_planks').length, 1);
});

test('a request beyond carried logs still retains every existing requested log for smelting', async () => {
  const f = furnacePreparation({ oak_log: 1, cobblestone: 8, coal: 1 });
  const r = await f.skill({ item: 'oak_log', count: 3 });
  assert.equal(r.ok, false); assert.equal(f.counts.oak_log, 1); assert.equal(f.counts.cobblestone, 8); assert.deepEqual(f.calls, []);
});

test('a separately reserved spare tree species cannot be consumed to prepare the table', async () => {
  const f = furnacePreparation({ oak_log: 1, spruce_log: 1, cobblestone: 8, coal: 1 });
  const r = await f.skill({ item: 'oak_log', count: 1, reserveItems: { spruce_log: 1 } });
  assert.equal(r.ok, false); assert.equal(f.counts.oak_log, 1); assert.equal(f.counts.spruce_log, 1); assert.deepEqual(f.calls, []);
});

test('a real existing table needs no spare log beyond the requested charcoal input', async () => {
  const f = furnacePreparation({ oak_log: 1, cobblestone: 8, coal: 1 }, { table: true });
  const r = await f.skill({ item: 'oak_log', count: 1 });
  assert.equal(r.ok, true, r.reason); assert.deepEqual(r.produced, { charcoal: 1 });
  assert.deepEqual(f.calls.filter((c) => c.operation === 'craft').map((c) => c.name), ['furnace']);
});

test('restricted stone preparation does not spend its requested cobblestone as furnace material', async () => {
  const f = furnacePreparation({ cobblestone: 8, oak_planks: 4, coal: 1 });
  const r = await f.skill({ item: 'cobblestone', count: 8 });
  assert.equal(r.ok, false); assert.match(r.reason, /未保留.*圆石/);
  assert.equal(f.counts.cobblestone, 8); assert.equal(f.counts.oak_planks, 4); assert.deepEqual(f.calls, []);
});

test('eight surplus cobblestones construct a furnace while all requested stone inputs are processed', async () => {
  const f = furnacePreparation({ cobblestone: 16, oak_planks: 4, coal: 1 });
  const r = await f.skill({ item: 'cobblestone', count: 8 });
  assert.equal(r.ok, true, r.reason); assert.deepEqual(r.produced, { stone: 8 });
  assert.equal(f.counts.cobblestone, 0);
  assert.deepEqual(f.calls.filter((c) => c.operation === 'input').map(({ name, count }) => ({ name, count })), [{ name: 'cobblestone', count: 8 }]);
});

test('stone input and its same-name explicit reserve share one furnace preparation budget', async () => {
  const f = furnacePreparation({ cobblestone: 16, oak_planks: 4, coal: 1 });
  const r = await f.skill({ item: 'cobblestone', count: 8, reserveItems: { cobblestone: 8 } });
  assert.equal(r.ok, true, r.reason); assert.deepEqual(r.produced, { stone: 8 });
});

test('an existing cold furnace cannot use its only requested charcoal log as fuel', async () => {
  const f = fixture({ oak_log: 1 });
  const r = await runSkill(f, { item: 'oak_log', count: 1 });
  assert.equal(r.ok, false); assert.match(r.reason, /燃料/);
  assert.equal(f.counts.oak_log, 1); assert.equal(f.counts.charcoal || 0, 0);
  assert.equal(f.calls.some((c) => ['input', 'fuel', 'resource-search', 'travel'].includes(c.operation)), false);
});

test('surplus same-name wood can fuel the requested charcoal input without borrowing it', async () => {
  const f = fixture({ oak_log: 2 });
  const r = await runSkill(f, { item: 'oak_log', count: 1, reserveItems: { oak_log: 1 } });
  assert.equal(r.ok, true, r.reason); assert.deepEqual(r.produced, { charcoal: 1 });
  assert.equal(f.counts.oak_log, 0);
  assert.deepEqual(f.calls.filter((c) => ['input', 'fuel'].includes(c.operation)).map(({ operation, name, count }) =>
    ({ operation, name, count })), [{ operation: 'input', name: 'oak_log', count: 1 }, { operation: 'fuel', name: 'oak_log', count: 1 }]);
});

test('three carried logs separately cover a table, charcoal input and same-name fuel', async () => {
  const f = furnacePreparation({ oak_log: 3, cobblestone: 8 });
  const r = await f.skill({ item: 'oak_log', count: 1 });
  assert.equal(r.ok, true, r.reason); assert.deepEqual(r.produced, { charcoal: 1 });
  assert.equal(f.counts.oak_log, 0);
  assert.equal(f.calls.filter((c) => c.operation === 'craft' && c.name === 'oak_planks').length, 1);
  assert.equal(f.calls.filter((c) => c.operation === 'input')[0].count, 1);
  assert.equal(f.calls.filter((c) => c.operation === 'fuel')[0].count, 1);
});

function resources(f, names) {
  const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  names.forEach((name, index) => {
    const position = vec3(1 + index, 64, 2);
    f.cells.set(key(position), { name, position, type: data.blocksByName[name].id, boundingBox: 'block', diggable: true });
  });
  f.bot.entity.onGround = true;
  f.bot.findBlocks = ({ matching, useExtraInfo, count = 16 }) => [...f.cells.values()]
    .filter((b) => matching(b) && (typeof useExtraInfo !== 'function' || useExtraInfo(b))).slice(0, count).map((b) => b.position);
  f.actions.dig = async (params) => {
    const block = f.cells.get(key(params)); assert.ok(block?.diggable);
    f.cells.delete(key(params));
    const item = block.name === 'stone' ? 'cobblestone' : block.name;
    f.counts[item] = (f.counts[item] || 0) + 1;
    f.calls.push({ operation: 'dig', name: block.name });
    return { block: block.name, collected: { [item]: 1 } };
  };
  return f;
}

test('permitted table search gathers one extra log and keeps the requested charcoal input', async () => {
  const f = resources(furnacePreparation({ oak_log: 1, cobblestone: 8, coal: 1 }), ['oak_log']);
  const r = await f.skill({ item: 'oak_log', count: 1, allowSearch: true });
  assert.equal(r.ok, true, r.reason); assert.deepEqual(r.produced, { charcoal: 1 });
  assert.equal(f.calls.filter((c) => c.operation === 'dig').length, 1);
});

test('permitted furnace search acquires eight extra stones without spending requested input', async () => {
  const f = resources(furnacePreparation({ cobblestone: 8, oak_planks: 4, coal: 1, stone_pickaxe: 1 }), Array(8).fill('stone'));
  const r = await f.skill({ item: 'cobblestone', count: 8, allowSearch: true });
  assert.equal(r.ok, true, r.reason); assert.deepEqual(r.produced, { stone: 8 });
  assert.equal(f.calls.filter((c) => c.operation === 'dig').length, 8);
});

test('table material acquisition respects the inherited no-search preparation barrier', async () => {
  const f = resources(furnacePreparation({ oak_log: 1, cobblestone: 8, coal: 1 }), ['oak_log']);
  await assert.rejects(executionContext.run({ allowOutdoorSearch: false },
    () => f.skill({ item: 'oak_log', count: 1, allowSearch: true })), (err) => err.name === 'PreparationBlockedError');
  assert.equal(f.counts.oak_log, 1); assert.equal(f.counts.cobblestone, 8); assert.deepEqual(f.calls, []);
});

test('indoor furnace preparation cannot search outside for an extra table log', async () => {
  const f = resources(furnacePreparation({ oak_log: 1, cobblestone: 8, coal: 1 }), ['oak_log']);
  await assert.rejects(executionContext.run({ indoorHome: { origin: { x: 0, y: 64, z: 0 }, size: 5, wall_height: 2 } },
    () => f.skill({ item: 'oak_log', count: 1, allowSearch: true })), (err) => err.name === 'PreparationBlockedError');
  assert.equal(f.counts.oak_log, 1); assert.equal(f.counts.cobblestone, 8); assert.deepEqual(f.calls, []);
});

test('extra furnace stone acquisition keeps an inherited preparation barrier', async () => {
  const f = resources(furnacePreparation({ cobblestone: 8, oak_planks: 4, coal: 1, stone_pickaxe: 1 }), Array(8).fill('stone'));
  await assert.rejects(executionContext.run({ allowOutdoorSearch: false },
    () => f.skill({ item: 'cobblestone', count: 8, allowSearch: true })), (err) => err.name === 'PreparationBlockedError');
  assert.equal(f.counts.cobblestone, 8); assert.equal(f.counts.oak_planks, 4); assert.deepEqual(f.calls, []);
});

test('retained plank variants stop table construction before any ingredient is consumed', async () => {
  const f = furnacePreparation({ raw_iron: 3, cobblestone: 8, oak_planks: 4, spruce_planks: 4, coal: 1 });
  const r = await f.skill({ reserveItems: { oak_planks: 4 } });
  assert.equal(r.ok, false); assert.match(r.reason, /保留木板|保留材料/);
  assert.equal(f.counts.oak_planks, 4); assert.equal(f.counts.spruce_planks, 4); assert.equal(f.counts.cobblestone, 8);
  assert.deepEqual(f.calls, []);
});

test('existing or carried tables can be used even while a plank variant is reserved', async () => {
  for (const carried of [false, true]) {
    const f = furnacePreparation({ raw_iron: 3, cobblestone: 8, oak_planks: 4, coal: 1, crafting_table: Number(carried) }, { table: !carried });
    const r = await f.skill({ reserveItems: { oak_planks: 4 } });
    assert.equal(r.ok, true, r.reason); assert.equal(f.counts.oak_planks, 4);
    assert.deepEqual(f.calls.filter((c) => c.operation === 'craft').map((c) => c.name), ['furnace']);
  }
});

for (const name of ['CancelledError', 'AbortError', 'PreparationBlockedError', 'ProtectedBlockError', 'ProtectedHomeError']) {
  test(`plank preparation retains an independent ${name} without making a table or furnace`, async () => {
    const f = furnacePreparation({ raw_iron: 3, cobblestone: 8, spruce_log: 1, coal: 1 });
    const error = new Error(`independent ${name}`); error.name = name;
    f.actions.craft = async ({ item }) => { assert.equal(item, 'spruce_planks'); throw error; };
    await assert.rejects(f.skill(), (err) => err === error);
    assert.equal(f.counts.spruce_log, 1); assert.equal(f.counts.cobblestone, 8); assert.deepEqual(f.calls, []);
  });
}
test('restricted smelting reports missing furnace stock before crafting or resource search', async () => {
  const f = fixture({ raw_iron: 3 }, { stations: [] });
  f.actions.craft = async () => { f.calls.push({ operation: 'craft' }); throw new Error('missing furnace materials'); };
  const r = await runSkill(f);
  assert.equal(r.ok, false); assert.equal(f.counts.raw_iron, 3);
  assert.match(r.reason, /熔炉|furnace/);
  assert.equal(f.calls.some((c) => ['craft', 'resource-search', 'travel'].includes(c.operation)), false);
});
test('restricted cold-furnace smelting preserves inputs and never searches for fuel', async () => {
  const f = fixture({ raw_iron: 3 }); const r = await runSkill(f);
  assert.equal(r.ok, false); assert.equal(f.counts.raw_iron, 3);
  assert.match(r.reason, /燃料/);
  assert.equal(f.calls.some((c) => ['resource-search', 'travel', 'input'].includes(c.operation)), false);
  assert.equal(f.calls.filter((c) => c.operation === 'open').length, 1);
});
test('restricted smelting still uses actual remaining heat without backpack fuel', async () => {
  const f = fixture({ raw_iron: 3 }, { heat: 35 }); const r = await runSkill(f);
  assert.equal(r.ok, true); assert.deepEqual(r.produced, { iron_ingot: 3 });
  assert.equal(f.counts.raw_iron, 0);
  assert.equal(f.calls.some((c) => ['resource-search', 'travel', 'fuel'].includes(c.operation)), false);
});
test('restricted smelting still uses fuel already in the real furnace', async () => {
  const f = fixture({ raw_iron: 3 }, { stored: { name: 'coal', count: 1 } }); const r = await runSkill(f);
  assert.equal(r.ok, true); assert.deepEqual(r.produced, { iron_ingot: 3 });
  assert.equal(f.calls.some((c) => ['resource-search', 'travel', 'fuel'].includes(c.operation)), false);
});
test('unaccepted takeOutput cannot claim success', async () => {
  const f = fixture({ raw_iron: 1, coal: 1 }, { rejectOutput: true }); const result = await f.run('raw_iron', 1);
  assert.equal(result.ok, false); assert.equal(result.produced, 0);
});
test('cancellation interrupts a server that never opens the furnace', async () => {
  const f = fixture({ raw_iron: 1, coal: 1 }); f.bot.openFurnace = async () => new Promise(() => {});
  // Reinstalling a method here only simulates unavailable server I/O. The real
  // action's deadline/cancellation race remains under test.
  const controller = new AbortController(); setTimeout(() => controller.abort(), 15);
  await assert.rejects(f.run('raw_iron', 1, { signal: controller.signal }), CancelledError);
  assert.equal(f.counts.raw_iron, 1);
});
test('preparation checks run again before furnace inventory transfer', async () => {
  const f = fixture({ raw_iron: 1, coal: 1 }); let valid = true;
  const open = f.bot.openFurnace;
  f.bot.openFurnace = async (...args) => { const win = await open(...args); valid = false; return win; };
  await assert.rejects(executionContext.run({ preparationCheck() { if (!valid) throw new Error('shelter changed'); } },
    () => f.run('raw_iron', 1)), /shelter changed/);
  assert.equal(f.counts.raw_iron, 1); assert.equal(f.counts.coal, 1);
});

(async () => {
  let passed = 0;
  for (const { name, run } of tests) {
    try { await run(); passed++; console.log(`PASS ${name}`); }
    catch (err) { console.error(`FAIL ${name}\n${err.stack}`); process.exitCode = 1; }
  }
  console.log(`Smelt control: ${passed}/${tests.length} passed`);
})().catch((err) => { console.error(err); process.exitCode = 1; });
