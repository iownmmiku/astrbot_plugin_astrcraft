'use strict';

// Production collection, material preparation and maintenance. Recipe data is
// the installed Minecraft registry; only accepted game I/O is simulated.
process.env.MC_ENGINE_LOG_LEVEL = 'error';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Recipe } = require('../engine/node_modules/prismarine-recipe')('1.20.1');
const data = require('../engine/node_modules/minecraft-data')('1.20.1');
const { Actions, guessSmeltOutput, fuelSmeltCapacity, MissingItemError, NoToolError, ProtectedBlockError } = require('../engine/actions');
const { SkillContext } = require('../engine/skills/common');
const { executionContext } = require('../engine/goals');
const { vec3, CancelledError } = require('../engine/util');
const gathering = require('../engine/skills/gathering');
const mining = require('../engine/skills/mining');
const wood = require('../engine/skills/wood');
const skills = require('../engine/skills');
const tests = [], test = (name, run) => tests.push({ name, run });

function fixture(inventory = {}, { blocks = [], smeltHook = null, craftHook = null, worn = null } = {}) {
  const counts = { stone_pickaxe: 1, coal: 4, stick: 2, ...inventory };
  const cells = new Map(), calls = [], controller = new AbortController();
  const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  const block = (name, position) => ({ name, position, type: data.blocksByName[name]?.id,
    boundingBox: name === 'air' ? 'empty' : 'block', diggable: name !== 'bedrock' && name !== 'air' });
  for (const [n, name] of ['crafting_table', 'furnace', ...blocks].entries()) {
    const p = vec3(n + 3, 1, 2); cells.set(key(p), block(name, p));
  }
  const bot = new EventEmitter();
  Object.assign(bot, { entity: { position: vec3(0.5, 1, 0.5), onGround: true },
    game: { dimension: 'overworld' }, health: 20, food: 20, time: { timeOfDay: 6000 }, version: '1.20.1', entities: {},
    _client: { state: 'play', socket: { remoteAddress: '127.0.0.1', remotePort: 25566 } },
    inventory: { items: () => Object.entries(counts).filter(([, n]) => n > 0).flatMap(([name, count]) =>
      Array.from({ length: name.endsWith('_pickaxe') ? count : Math.ceil(count / 64) }, (_, index) =>
        ({ name, count: name.endsWith('_pickaxe') ? 1 : Math.min(64, count - index * 64), type: data.itemsByName[name]?.id,
        maxDurability: name.endsWith('_pickaxe') ? 100 : undefined,
        durabilityUsed: worn && index === 0 && name === worn ? 99 : 0 }))) },
    blockAt: (p) => cells.get(key(p)) || block(p.y < 1 ? 'bedrock' : 'air', p),
    findBlocks: ({ matching, useExtraInfo, count = 16 }) => [...cells.values()]
      .filter((b) => matching(b) && (typeof useExtraInfo !== 'function' || useExtraInfo(b))).slice(0, count).map((b) => b.position),
    findBlock: ({ matching, useExtraInfo }) => [...cells.values()].find((b) => matching(b) &&
      (typeof useExtraInfo !== 'function' || useExtraInfo(b))) || null,
    recipesAll: (type) => Recipe.find(type, null), canSeeBlock: () => true,
    clearControlStates() {},
  });
  const ctx = new SkillContext({ signal: controller.signal, deadline: Date.now() + 15000 });
  const actions = { bot, _bot: bot, inventoryMap: () => ({ ...counts }), countItem: (name) => counts[name] || 0,
    _findItem: (name) => bot.inventory.items().find((item) => item.name === name) || null,
    _availableFuelItem: Actions.prototype._availableFuelItem,
    _missingForRecipe: Actions.prototype._missingForRecipe, _spotInFront: () => ({ x: 1, y: 1, z: 0 }),
    equipBestToolFor: async () => {},
    async craft(params) {
      ctx.checkAborted(); calls.push({ kind: 'craft', ...params });
      if (craftHook) { const result = await craftHook(params, counts, controller); if (result) return result; }
      const recipe = Recipe.find(data.itemsByName[params.item]?.id, null)
        .find((r) => actions._missingForRecipe(r, params.count, data).length === 0);
      if (!recipe) throw new MissingItemError(params.item, '游戏未接受缺料配方');
      const batches = Math.ceil(params.count / recipe.result.count);
      for (const delta of recipe.delta) {
        const name = data.items[delta.id].name;
        counts[name] = (counts[name] || 0) + delta.count * batches;
        assert.ok(counts[name] >= 0, `game consumed absent ${name}`);
      }
      return { ok: true, produced: recipe.result.count * batches };
    },
    async smelt(params) {
      ctx.checkAborted(); calls.push({ kind: 'smelt', ...params });
      if (smeltHook) { const result = await smeltHook(params, counts); if (result) return result; }
      assert.ok(counts[params.item] >= params.count);
      counts[params.item] -= params.count;
      const output = guessSmeltOutput(params.item); counts[output] = (counts[output] || 0) + params.count;
      return { ok: true, produced: params.count, output };
    },
    async dig(params) {
      ctx.checkAborted(); calls.push({ kind: 'dig', ...params });
      const cell = cells.get(key(params)); assert.ok(cell?.diggable);
      const item = { stone: 'cobblestone', coal_ore: 'coal', iron_ore: 'raw_iron', diamond_ore: 'diamond', nether_gold_ore: 'gold_nugget' }[cell.name] || cell.name;
      cells.delete(key(params)); counts[item] = (counts[item] || 0) + 1;
      return { block: cell.name, collected: { [item]: 1 } };
    },
    async place({ x, y, z, item }) {
      assert.ok(counts[item] > 0); counts[item]--;
      const p = vec3(x, y, z); cells.set(key(p), block(item, p));
      return { ok: true };
    },
    async attack({ target }) {
      calls.push({ kind: 'attack' }); delete bot.entities[target.id];
      counts.beef = (counts.beef || 0) + 1; return { killed: true };
    },
    async collectDrops() { return { gained: {} }; },
  };
  const nav = { goTo: async () => { calls.push({ kind: 'nav' }); throw new Error('fixture has no further resources'); } };
  const state = {};
  return { counts, calls, cells, actions, bot, nav, state, ctx, controller,
    collect: (item, count = 1) => gathering.collect({ actions, nav, state, ctx, item, count, maxAttempts: 1 }) };
}

test('an actual cow kill with beef cannot satisfy missing leather', async () => {
  const f = fixture(); f.bot.entities[1] = { id: 1, name: 'cow', position: vec3(1, 1, 0) };
  const result = await f.collect('leather', 3);
  assert.equal(result.ok, false); assert.equal(result.collection_ok, false);
  assert.equal(f.counts.beef, 1); assert.equal(result.produced.beef, 1);
});
test('named spruce logs do not become nearby oak logs or doubled stock', async () => {
  const f = fixture({}, { blocks: ['oak_log', 'spruce_log'] });
  const result = await f.collect('spruce_log');
  assert.equal(result.ok, true, JSON.stringify({ result, calls: f.calls })); assert.equal(f.counts.spruce_log, 1); assert.equal(f.counts.oak_log || 0, 0);
  assert.equal(f.calls.filter((c) => c.kind === 'dig').length, 1);
});
test('hunting stops at actual meat quantity instead of killing surplus animals', async () => {
  const f = fixture();
  for (const id of [1, 2, 3]) f.bot.entities[id] = { id, name: 'cow', position: vec3(id, 1, 0) };
  f.actions.attack = async ({ target }) => {
    f.calls.push({ kind: 'attack' }); delete f.bot.entities[target.id]; f.counts.beef = (f.counts.beef || 0) + 3;
    return { killed: true };
  };
  assert.equal((await f.collect('beef', 3)).ok, true);
  assert.equal(f.calls.filter((c) => c.kind === 'attack').length, 1);
  assert.equal(Object.keys(f.bot.entities).length, 2);
});
test('a zero-leather cow cannot stop collection while another cow has leather', async () => {
  const f = fixture();
  for (const id of [1, 2]) f.bot.entities[id] = { id, name: 'cow', position: vec3(id, 1, 0) };
  f.actions.attack = async ({ target }) => {
    f.calls.push({ kind: 'attack' }); delete f.bot.entities[target.id];
    if (target.id === 2) f.counts.leather = 1;
    return { killed: true };
  };
  assert.equal((await f.collect('leather')).ok, true); assert.equal(f.counts.leather, 1);
  assert.equal(f.calls.filter((c) => c.kind === 'attack').length, 2);
});
test('generic wool accepts the actual colored wool dropped by a sheep', async () => {
  const f = fixture(); f.bot.entities[1] = { id: 1, name: 'sheep', position: vec3(1, 1, 0) };
  f.actions.attack = async ({ target }) => { delete f.bot.entities[target.id]; f.counts.blue_wool = 1; return { killed: true }; };
  const result = await f.collect('wool'); assert.equal(result.ok, true); assert.equal(result.produced.blue_wool, 1);
});
test('one missing plank for a table uses one log and leaves three planks', async () => {
  const f = fixture({ oak_planks: 3, oak_log: 1 });
  const result = await f.collect('crafting_table');
  assert.equal(result.ok, true); assert.equal(f.counts.oak_log, 0); assert.equal(f.counts.oak_planks, 3);
  assert.deepEqual(f.calls.map(({ kind, item, count }) => [kind, item, count]),
    [['craft', 'oak_planks', 1], ['craft', 'crafting_table', 1]]);
});
test('mixed wood recipe selects existing spruce instead of gathering oak', async () => {
  const f = fixture({ oak_planks: 1, spruce_planks: 3 });
  const result = await f.collect('stick', 4);
  assert.equal(result.ok, true); assert.equal(f.counts.stick, 6); assert.equal(f.counts.spruce_planks, 1);
  assert.equal(f.counts.oak_planks, 1); assert.equal(f.calls.length, 1);
});
test('four existing sticks and one log satisfy eight sticks with one batch', async () => {
  const f = fixture({ stick: 4, oak_log: 1 });
  const result = await f.collect('stick', 8);
  assert.equal(result.ok, true); assert.equal(f.counts.stick, 8); assert.equal(f.counts.oak_planks, 2);
  assert.equal(f.calls.filter((c) => c.kind === 'craft' && c.item === 'stick').length, 1);
});
test('bucket dependencies smelt three existing raw iron before crafting', async () => {
  const f = fixture({ raw_iron: 3 }); const result = await f.collect('bucket');
  assert.equal(result.ok, true); assert.equal(f.counts.bucket, 1); assert.equal(f.counts.raw_iron, 0);
  assert.equal(result.consumed.raw_iron, 3);
  assert.deepEqual(f.calls.map((c) => c.kind), ['smelt', 'craft']);
});
test('mixed existing iron variants become ingots without mining replacements', async () => {
  const f = fixture({ raw_iron: 1, iron_ore: 1, deepslate_iron_ore: 1 });
  const result = await f.collect('iron_ingot', 3);
  assert.equal(result.ok, true); assert.equal(f.counts.iron_ingot, 3);
  assert.deepEqual(f.calls.map((c) => c.item), ['raw_iron', 'iron_ore', 'deepslate_iron_ore']);
});
test('stone collection actually smelts cobblestone into the requested stone', async () => {
  const f = fixture({ cobblestone: 4 }); const result = await f.collect('stone', 3);
  assert.equal(result.ok, true); assert.equal(f.counts.stone, 3); assert.equal(f.counts.cobblestone, 1);
  assert.deepEqual(f.calls.map((c) => c.kind), ['smelt']);
});
test('missing furnace fuel keeps raw material and does not gather duplicates', async () => {
  const f = fixture({ raw_iron: 3 }, { smeltHook: async () => ({ ok: false, note: '燃料不够', produced: 0 }) });
  const result = await f.collect('iron_ingot', 3);
  assert.equal(result.ok, false); assert.equal(f.counts.raw_iron, 3);
  assert.equal(f.calls.some((c) => c.kind === 'dig'), false);
});
test('a cyclic crafting dependency returns a bounded failure', async () => {
  const f = fixture(); const id = data.itemsByName.oak_planks.id;
  f.bot.recipesAll = () => [{ result: { id, count: 4 }, delta: [{ id, count: -1 }], ingredients: [] }];
  const result = await f.collect('oak_planks', 4);
  assert.equal(result.ok, false); assert.match(result.reason, /重复|过深/); assert.equal(f.calls.length, 0);
});
test('cancelled gathering cannot turn into partial normal success', async () => {
  const f = fixture({ raw_iron: 3 }, { smeltHook: async () => { f.controller.abort(); throw new CancelledError(); } });
  await assert.rejects(f.collect('bucket'), CancelledError);
  assert.equal(f.counts.raw_iron, 3); assert.equal(f.counts.bucket || 0, 0);
});
for (const material of ['cobblestone', 'cobbled_deepslate', 'blackstone']) {
  test(`worn stone pickaxe is actually replaced using ${material}`, async () => {
    const f = fixture({ [material]: 3 }, { worn: 'stone_pickaxe' });
    assert.equal(await wood.ensurePickaxeDurability(f), true);
    assert.equal(f.counts.stone_pickaxe, 2); assert.equal(f.counts[material], 0);
    assert.equal(f.calls.filter((c) => c.kind === 'craft').length, 1);
  });
}

test('stone fallback replaces preparation cost before accepting other building stone', async () => {
  const f = fixture({ stone_pickaxe: 0, cobblestone: 3 }, { blocks: ['stone', 'andesite', 'andesite', 'andesite'] });
  const result = await mining.mineStone({ ...f, want: 1, allowSearch: false, maxAttempts: 5 });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.gained, 1);
  assert.equal(f.counts.cobblestone, 1); assert.equal(f.counts.andesite, 3);
});
test('failed replacement craft cannot count the old worn pickaxe as new', async () => {
  const f = fixture({ cobblestone: 3 }, { worn: 'stone_pickaxe', craftHook: async () => ({ ok: false, produced: 0 }) });
  assert.equal(await wood.ensurePickaxeDurability(f), false); assert.equal(f.counts.stone_pickaxe, 1);
});
test('diamond mining never treats a stone replacement as sufficient', async () => {
  const f = fixture({ stone_pickaxe: 0, iron_pickaxe: 1, cobblestone: 3 }, { worn: 'iron_pickaxe' });
  assert.equal(await wood.ensurePickaxeDurability({ ...f, minTier: 'iron' }), false);
  assert.equal(f.calls.length, 0); assert.equal(f.counts.iron_pickaxe, 1);
});
test('ore miner replaces a worn iron pickaxe before its next ore', async () => {
  const f = fixture({ stone_pickaxe: 0, iron_pickaxe: 1, iron_ingot: 3 }, { worn: 'iron_pickaxe', blocks: ['iron_ore'] });
  const result = await mining.mineOre({ ...f, ore: 'iron', want: 1, allowSearch: false });
  assert.equal(result.ok, true, JSON.stringify({ result, calls: f.calls })); assert.equal(f.counts.iron_pickaxe, 2);
  assert.deepEqual(f.calls.map((c) => c.kind), ['craft', 'dig']);
});
test('stone mining prepares a wooden pickaxe using carried materials', async () => {
  const f = fixture({ stone_pickaxe: 0, oak_log: 2 }, { blocks: ['stone'] });
  const result = await mining.mineStone({ ...f, want: 1, strictOnly: true, allowSearch: false });
  assert.equal(result.ok, true); assert.equal(f.counts.wooden_pickaxe, 1); assert.equal(f.counts.cobblestone, 1);
});

for (const material of ['cobblestone', 'cobbled_deepslate', 'blackstone']) {
  test(`stone mining starts without a pickaxe using carried ${material}`, async () => {
    const f = fixture({ stone_pickaxe: 0, [material]: 3 }, { blocks: Array(4).fill('stone') });
    const result = await mining.mineStone({ ...f, want: 1, strictOnly: true, allowSearch: false });
    assert.equal(result.ok, true, JSON.stringify({ result, calls: f.calls }));
    assert.equal(f.counts.stone_pickaxe, 1);
    assert.equal(result.gained, 1);
    assert.equal(f.calls.some((c) => c.kind === 'nav'), false);
  });
}

test('an iron vein continues after the pickaxe breaks using carried replacement material', async () => {
  const f = fixture({ iron_ingot: 3 }, { blocks: ['iron_ore', 'iron_ore'] });
  const acceptedDig = f.actions.dig; let mined = 0;
  f.actions.dig = async (params) => {
    if (!f.counts.stone_pickaxe && !f.counts.iron_pickaxe) throw new NoToolError('铁矿需要可用镐');
    const result = await acceptedDig(params);
    if (++mined === 1) f.counts.stone_pickaxe = 0;
    return result;
  };
  const result = await mining.mineOre({ ...f, ore: 'iron', want: 2, allowSearch: false });
  assert.equal(result.ok, true, JSON.stringify({ result, calls: f.calls }));
  assert.equal(f.counts.raw_iron, 2); assert.equal(f.counts.iron_pickaxe, 1);
  assert.deepEqual(f.calls.map((c) => c.kind), ['dig', 'craft', 'dig']);
});

for (const skill of ['ore', 'stone']) {
  test(`${skill} collection can repair a tool exhausted while approaching the target`, async () => {
    const f = fixture({ iron_ingot: 3 }, { blocks: ['stone', 'iron_ore'] });
    const acceptedDig = f.actions.dig; let attempts = 0;
    f.actions.dig = async (params) => {
      if (++attempts === 1) { f.counts.stone_pickaxe = 0; throw new NoToolError('开通道时镐耗尽'); }
      return acceptedDig(params);
    };
    const result = await (skill === 'ore' ? mining.mineOre({ ...f, ore: 'iron', want: 1, allowSearch: false }) :
      mining.mineStone({ ...f, want: 1, strictOnly: true, allowSearch: false }));
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(attempts, 2);
    assert.equal(f.counts.iron_pickaxe, 1);
    assert.deepEqual(f.calls.map((c) => c.kind), ['craft', 'dig']);
  });
}

test('shared block collection repairs at the actual obsidian harvest tier', async () => {
  const f = fixture({ diamond: 3 }, { blocks: ['obsidian'] });
  const acceptedDig = f.actions.dig;
  f.actions.dig = async (params) => {
    if (!f.counts.diamond_pickaxe) throw new NoToolError('黑曜石需要钻石镐');
    return acceptedDig(params);
  };
  const result = await wood.mineSpecific({ ...f, blockNames: ['obsidian'], itemName: 'obsidian', want: 1, allowSearch: false });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.counts.diamond_pickaxe, 1);
  assert.equal(f.counts.obsidian, 1); assert.equal(f.counts.diamond, 0);
});

test('stone collection recovers a broken pickaxe while preserving its net quantity goal', async () => {
  const f = fixture({ cobblestone: 3 }, { blocks: Array(5).fill('stone') });
  const acceptedDig = f.actions.dig; let mined = 0;
  f.actions.dig = async (params) => {
    if (!f.counts.stone_pickaxe) throw new NoToolError('石头需要可用镐');
    const result = await acceptedDig(params);
    if (++mined === 1) f.counts.stone_pickaxe = 0;
    return result;
  };
  const result = await mining.mineStone({ ...f, want: 2, strictOnly: true, allowSearch: false });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.counts.cobblestone, 5); assert.equal(f.counts.stone_pickaxe, 1);
  assert.equal(f.calls.filter((c) => c.kind === 'dig').length, 5);
});

test('a broken pickaxe without replacement material stops digging and retains partial ore', async () => {
  const f = fixture({}, { blocks: ['iron_ore', 'iron_ore'] });
  const acceptedDig = f.actions.dig; let attempts = 0;
  f.actions.dig = async (params) => {
    attempts++;
    if (!f.counts.stone_pickaxe) throw new NoToolError('铁矿需要可用镐，当前已损坏');
    const result = await acceptedDig(params); f.counts.stone_pickaxe = 0; return result;
  };
  const result = await mining.mineOre({ ...f, ore: 'iron', want: 2, allowSearch: false });
  assert.equal(result.ok, false); assert.equal(result.gained, 1); assert.equal(f.counts.raw_iron, 1);
  assert.match(result.reason, /镐|工具/); assert.ok(attempts <= 2, `retried missing tool ${attempts} times`);
  assert.equal(f.calls.some((c) => c.kind === 'nav'), false);
});

test('ore tool preparation respects disabled search even when no material is carried', async () => {
  const f = fixture({ stone_pickaxe: 0 }, { blocks: ['oak_log', 'stone', 'iron_ore'] });
  const result = await mining.mineOre({ ...f, ore: 'iron', want: 1, allowSearch: false });
  assert.equal(result.ok, false); assert.equal(f.calls.length, 0, JSON.stringify(f.calls));
  assert.match(result.reason, /禁用|不足/);
});

for (const skill of ['mine_ores', 'mine_stone']) {
  test(`registered ${skill} preserves disabled-search policy through its tool dependency`, async () => {
    const f = fixture({ stone_pickaxe: 0 }, { blocks: ['oak_log', 'stone', 'iron_ore'] });
    const result = await skills.get(skill).run({ ...f, params: {
      ore: 'iron', count: 1, radius: 16, max_attempts: 2, allow_search: false,
    } });
    assert.equal(result.ok, false); assert.equal(f.calls.length, 0, JSON.stringify(f.calls));
  });
}

test('cancellation during broken-pickaxe replacement preserves the accepted ore', async () => {
  const f = fixture({ iron_ingot: 3 }, { blocks: ['iron_ore', 'iron_ore'],
    craftHook: async () => { f.controller.abort(); throw new CancelledError(); } });
  const acceptedDig = f.actions.dig;
  f.actions.dig = async (params) => {
    const result = await acceptedDig(params); f.counts.stone_pickaxe = 0; return result;
  };
  await assert.rejects(mining.mineOre({ ...f, ore: 'iron', want: 2, allowSearch: false }), CancelledError);
  assert.equal(f.counts.raw_iron, 1); assert.equal(f.counts.iron_ingot, 3);
});

test('an exhausted pickaxe still in an inventory snapshot cannot skip replacement', async () => {
  const f = fixture({ cobblestone: 3 }, { blocks: Array(4).fill('stone') });
  const snapshot = f.bot.inventory.items;
  f.bot.inventory.items = () => snapshot().map((item, index) =>
    item.name === 'stone_pickaxe' && index === 0 ? { ...item, durabilityUsed: 100 } : item);
  const result = await mining.mineStone({ ...f, want: 1, strictOnly: true, allowSearch: false });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.counts.stone_pickaxe, 2);
  assert.equal(f.calls.filter((c) => c.kind === 'craft').length, 1);
});

test('a broken iron pickaxe cannot be replaced with stone for a diamond vein', async () => {
  const f = fixture({ stone_pickaxe: 0, iron_pickaxe: 1, cobblestone: 3 }, { blocks: ['diamond_ore', 'diamond_ore'] });
  const acceptedDig = f.actions.dig;
  f.actions.dig = async (params) => { const result = await acceptedDig(params); f.counts.iron_pickaxe = 0; return result; };
  const result = await mining.mineOre({ ...f, ore: 'diamond', want: 2, allowSearch: false });
  assert.equal(result.ok, false); assert.equal(result.gained, 1); assert.equal(f.counts.diamond, 1);
  assert.equal(f.counts.cobblestone, 3); assert.equal(f.calls.filter((c) => c.kind === 'craft').length, 0);
  assert.match(result.reason, /iron.*镐/);
});
test('ancient debris prepares a diamond pickaxe rather than another iron pickaxe', async () => {
  const f = fixture({ stone_pickaxe: 0, iron_pickaxe: 1, diamond: 3 }, { blocks: ['ancient_debris'] });
  const result = await mining.mineOre({ ...f, ore: 'ancient_debris', want: 1, allowSearch: false });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(f.counts.diamond_pickaxe, 1);
  assert.equal(f.counts.ancient_debris, 1); assert.equal(f.counts.diamond, 0);
});
test('nether gold counts real nuggets and accepts a wooden pickaxe', async () => {
  const f = fixture({ stone_pickaxe: 0, wooden_pickaxe: 1 }, { blocks: ['nether_gold_ore'] });
  f.bot.game.dimension = 'minecraft:the_nether';
  const result = await mining.mineOre({ ...f, ore: 'gold', want: 1, allowSearch: false });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.produced.gold_nugget, 1);
  assert.equal(result.gained, 1); assert.equal(f.calls.some((c) => c.kind === 'craft'), false);
});

for (const [ore, block, dimension, item] of [
  ['coal', 'coal_ore', 'overworld', 'coal'],
  ['gold', 'nether_gold_ore', 'minecraft:the_nether', 'gold_nugget'],
]) {
  test(`a carried golden pickaxe can harvest ${ore} without gathering a wooden replacement`, async () => {
    const f = fixture({ stone_pickaxe: 0, golden_pickaxe: 1 }, { blocks: [block] });
    f.bot.game.dimension = dimension;
    const result = await mining.mineOre({ ...f, ore, want: 1, allowSearch: false });
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.gained, 1);
    assert.equal(result.produced[item], 1);
    assert.equal(f.calls.filter((c) => c.kind === 'craft').length, 0);
  });
}

test('a golden pickaxe alone never satisfies the iron harvesting requirement', async () => {
  const f = fixture({ stone_pickaxe: 0, golden_pickaxe: 1 }, { blocks: ['iron_ore'] });
  const result = await mining.mineOre({ ...f, ore: 'iron', want: 1, allowSearch: false });
  assert.equal(result.ok, false); assert.equal(f.calls.length, 0); assert.equal(f.counts.golden_pickaxe, 1);
});

for (const inventory of [
  { raw_iron: 3 }, { iron_ore: 3 },
  { raw_iron: 1, iron_ore: 1, deepslate_iron_ore: 1 }, { iron_ingot: 1, raw_iron: 2 },
]) {
  test(`missing pickaxe can be rebuilt from carried iron inputs ${JSON.stringify(inventory)}`, async () => {
    const f = fixture({ stone_pickaxe: 0, ...inventory });
    assert.equal(await wood.ensurePickaxeDurability({ ...f, minTier: 'stone' }), true);
    assert.equal(f.counts.iron_pickaxe, 1); assert.equal(f.counts.iron_ingot, 0);
    for (const input of ['raw_iron', 'iron_ore', 'deepslate_iron_ore']) assert.equal(f.counts[input] || 0, 0);
    assert.equal(f.calls.some((c) => c.kind === 'dig' || c.kind === 'nav'), false);
  });
}

test('ore used for a replacement pickaxe stays part of the original net mining goal', async () => {
  const f = fixture({ raw_iron: 3 }, { blocks: Array(5).fill('iron_ore') });
  const acceptedDig = f.actions.dig; let mined = 0;
  f.actions.dig = async (params) => {
    if (!f.counts.stone_pickaxe && !f.counts.iron_pickaxe) throw new NoToolError('缺镐');
    const result = await acceptedDig(params);
    if (++mined === 1) f.counts.stone_pickaxe = 0;
    return result;
  };
  const result = await mining.mineOre({ ...f, ore: 'iron', want: 2, allowSearch: false });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.gained, 2);
  assert.equal(f.counts.raw_iron, 5); assert.equal(f.counts.iron_pickaxe, 1);
  assert.equal(f.calls.filter((c) => c.kind === 'dig').length, 5);
  assert.equal(f.calls.find((c) => c.kind === 'smelt').count, 3);
});

test('cancelled smelting for a replacement cannot continue crafting or mining', async () => {
  const f = fixture({ stone_pickaxe: 0, raw_iron: 3 }, {
    smeltHook: async () => { f.controller.abort(); throw new CancelledError(); },
  });
  await assert.rejects(wood.ensurePickaxeDurability({ ...f, minTier: 'stone' }), CancelledError);
  assert.equal(f.counts.raw_iron, 3);
  assert.equal(f.calls.some((c) => c.kind === 'craft' || c.kind === 'dig'), false);
});

test('iron replacement with disabled search cannot mine stone for a missing furnace', async () => {
  const f = fixture({ stone_pickaxe: 0, wooden_pickaxe: 1, raw_iron: 3 }, { blocks: Array(8).fill('stone') });
  for (const [key, b] of f.cells) if (b.name === 'furnace') f.cells.delete(key);
  assert.equal(await wood.ensurePickaxeDurability({ ...f, minTier: 'stone' }), false);
  assert.equal(f.counts.raw_iron, 3); assert.equal(f.calls.length, 0);
});

test('iron replacement with disabled search cannot chop logs for missing fuel', async () => {
  const f = fixture({ stone_pickaxe: 0, raw_iron: 3, coal: 0 }, { blocks: Array(4).fill('oak_log'),
    smeltHook: async () => { throw new MissingItemError('燃料'); } });
  assert.equal(await wood.ensurePickaxeDurability({ ...f, minTier: 'stone' }), false);
  assert.equal(f.counts.raw_iron, 3); assert.deepEqual(f.calls.map((c) => c.kind), ['smelt']);
});

test('iron replacement can use confirmed furnace heat without backpack coal', async () => {
  const f = fixture({ stone_pickaxe: 0, raw_iron: 3, coal: 0 });
  assert.equal(await wood.ensurePickaxeDurability({ ...f, minTier: 'stone' }), true);
  assert.equal(f.counts.iron_pickaxe, 1); assert.equal(f.counts.raw_iron, 0);
  assert.deepEqual(f.calls.map((c) => c.kind), ['smelt', 'craft']);
});

test('a worn wooden pickaxe upgrades using ready stone without consuming spare planks', async () => {
  const f = fixture({ stone_pickaxe: 0, wooden_pickaxe: 1, oak_planks: 3, cobblestone: 3 }, { worn: 'wooden_pickaxe' });
  assert.equal(await wood.ensurePickaxeDurability(f), true);
  assert.equal(f.counts.stone_pickaxe, 1); assert.equal(f.counts.wooden_pickaxe, 1); assert.equal(f.counts.oak_planks, 3);
});

test('ready stone replacement outranks raw iron that cannot be smelted here', async () => {
  const f = fixture({ stone_pickaxe: 0, iron_pickaxe: 1, raw_iron: 3, cobblestone: 3, coal: 0 }, { worn: 'iron_pickaxe' });
  for (const [key, b] of f.cells) if (b.name === 'furnace') f.cells.delete(key);
  assert.equal(await wood.ensurePickaxeDurability({ ...f, minTier: 'stone' }), true);
  assert.equal(f.counts.stone_pickaxe, 1); assert.equal(f.counts.raw_iron, 3);
  assert.deepEqual(f.calls.map((c) => c.kind), ['craft']);
});

test('ready stone replacement preserves planks for sticks instead of burning them for iron', async () => {
  const f = fixture({ stone_pickaxe: 0, iron_pickaxe: 1, raw_iron: 3, cobblestone: 3,
    stick: 0, oak_planks: 2, coal: 0 }, { worn: 'iron_pickaxe', smeltHook: async (_params, counts) => {
      counts.oak_planks -= 2; counts.raw_iron = 0; counts.iron_ingot = 3; return { ok: true, produced: 3 };
    } });
  assert.equal(await wood.ensurePickaxeDurability({ ...f, minTier: 'stone' }), true);
  assert.equal(f.counts.stone_pickaxe, 1); assert.equal(f.counts.raw_iron, 3); assert.equal(f.counts.stick, 2);
  assert.equal(f.calls.some((c) => c.kind === 'smelt'), false);
});

function acceptedFuelSmelt(f, params, counts) {
  const fuel = Actions.prototype._findFuel.call(f.actions, params.reserveItems);
  if (!fuel) throw new MissingItemError('燃料');
  const capacity = fuelSmeltCapacity(fuel.name);
  const put = Math.min(params.count, counts[params.item], Math.floor(capacity * fuel.count));
  assert.ok(put > 0);
  counts[fuel.name] -= Math.ceil(put / capacity);
  counts[params.item] -= put;
  const output = guessSmeltOutput(params.item);
  counts[output] = (counts[output] || 0) + put;
  return { ok: true, produced: put, output };
}

test('required iron replacement cannot burn the last two handle sticks', async () => {
  const f = fixture({ stone_pickaxe: 0, iron_pickaxe: 1, raw_iron: 3, stick: 2, coal: 0 }, {
    worn: 'iron_pickaxe', smeltHook: async (params, counts) => acceptedFuelSmelt(f, params, counts),
  });
  assert.equal(await wood.ensurePickaxeDurability({ ...f, minTier: 'iron' }), false);
  assert.equal(f.counts.raw_iron, 3); assert.equal(f.counts.iron_ingot || 0, 0); assert.equal(f.counts.stick, 2);
  assert.equal(f.calls.find((c) => c.kind === 'smelt').reserveItems.stick, 2);
});

test('required iron replacement preserves handles after crafting sticks from its last wood', async () => {
  const f = fixture({ stone_pickaxe: 0, iron_pickaxe: 1, raw_iron: 3, stick: 0, oak_planks: 2, coal: 0 }, {
    worn: 'iron_pickaxe', smeltHook: async (params, counts) => acceptedFuelSmelt(f, params, counts),
  });
  assert.equal(await wood.ensurePickaxeDurability({ ...f, minTier: 'iron' }), false);
  assert.equal(f.counts.raw_iron, 2); assert.equal(f.counts.iron_ingot, 1); assert.equal(f.counts.stick, 2);
  assert.equal(f.counts.oak_planks, 0);
});

test('iron replacement may burn genuinely spare sticks and still craft its handles', async () => {
  const f = fixture({ stone_pickaxe: 0, raw_iron: 3, stick: 8, coal: 0 }, {
    smeltHook: async (params, counts) => acceptedFuelSmelt(f, params, counts),
  });
  assert.equal(await wood.ensurePickaxeDurability({ ...f, minTier: 'iron' }), true);
  assert.equal(f.counts.iron_pickaxe, 1); assert.equal(f.counts.raw_iron, 0); assert.equal(f.counts.stick, 0);
});

test('one iron tool batch protects handles for both its pickaxe and axe', async () => {
  const f = fixture({ stone_pickaxe: 0, raw_iron: 6, stick: 4, coal: 0 }, {
    smeltHook: async (params, counts) => acceptedFuelSmelt(f, params, counts),
  });
  const result = await wood.makeTools({ ...f, tier: 'iron', kinds: ['pickaxe', 'axe'], allowSearch: false });
  assert.equal(result.ok, false); assert.equal(f.counts.raw_iron, 6); assert.equal(f.counts.stick, 4);
  assert.equal(f.calls.find((c) => c.kind === 'smelt').reserveItems.stick, 4);
});
test('a protected ore keeps its configuration refusal instead of a missing-ore diagnosis', async () => {
  const f = fixture({}, { blocks: ['iron_ore'] }); let attempts = 0;
  f.actions.dig = async () => { attempts++; throw new ProtectedBlockError('挖掘黑名单拦截 iron_ore'); };
  const result = await mining.mineOre({ ...f, ore: 'iron', want: 1, allowSearch: false });
  assert.equal(result.ok, false); assert.match(result.reason, /黑名单/); assert.equal(attempts, 1);
  assert.equal(result.collection_ok, false); assert.equal(f.counts.raw_iron || 0, 0);
});
test('deep mining matches gold and lapis outputs but does not dig down for emerald', () => {
  const f = fixture(); f.bot.entity.position.y = 64;
  for (const ore of ['iron', 'gold', 'lapis', 'diamond', 'redstone']) assert.equal(mining.shouldDigDown(f.actions, mining.ORES[ore]), true);
  assert.equal(mining.shouldDigDown(f.actions, mining.ORES.emerald), false);
});
test('newer overworld logs have real charcoal outputs', () => {
  for (const log of ['mangrove_log', 'cherry_log', 'pale_oak_log']) assert.equal(guessSmeltOutput(log), 'charcoal');
});
test('visible ore beside lava is skipped in favor of a safe vein', async () => {
  const f = fixture({}, { blocks: ['iron_ore', 'iron_ore'] });
  const p = vec3(5, 1, 3); f.cells.set('5,1,3', { name: 'lava', position: p, boundingBox: 'empty', diggable: false });
  const result = await mining.mineOre({ ...f, ore: 'iron', want: 1, allowSearch: false });
  assert.equal(result.ok, true); assert.equal(f.calls.find((c) => c.kind === 'dig').x, 6);
  assert.equal(f.cells.get('5,1,2').name, 'iron_ore');
});

test('nearby sealed ore cannot hide the visible vein after the candidate limit', async () => {
  const f = fixture({}, { blocks: Array(17).fill('iron_ore') });
  const originalBlockAt = f.bot.blockAt;
  f.bot.blockAt = (p) => {
    const b = originalBlockAt(p);
    return b.name === 'air' && p.x >= 4 && p.x <= 21 && p.y >= 1 && p.y <= 2 && p.z >= 1 && p.z <= 3
      ? { name: 'stone', position: p, boundingBox: 'block', diggable: true } : b;
  };
  f.bot.canSeeBlock = (b) => b.position.x === 21;
  const result = await mining.mineOre({ ...f, ore: 'iron', want: 1, allowSearch: false });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.calls.find((c) => c.kind === 'dig').x, 21);
});
test('safe harvest rechecks a new fluid hazard after equipment and look awaits', async () => {
  const f = fixture(); let digs = 0;
  f.cells.set('1,1,0', { name: 'iron_ore', position: vec3(1, 1, 0), boundingBox: 'block', diggable: true });
  f.bot.lookAt = async () => f.cells.set('1,1,1', { name: 'lava', position: vec3(1, 1, 1), boundingBox: 'empty' });
  f.bot.canDigBlock = () => true;
  f.bot.dig = async () => { digs++; };
  const config = { get: (key) => ({ humanize: false, spawnProtectionRadius: 0, digBlacklist: [], digWhitelist: [] })[key] };
  const actions = new Actions({ bot: f.bot, config, navigator: f.nav });
  actions.equipBestToolFor = async () => {};
  await assert.rejects(actions.dig({ x: 1, y: 1, z: 0, safe: true, collect: false }), /液体|风险/);
  assert.equal(digs, 0);
});

function toolActions(items, held = items[0]) {
  const f = fixture(); f.bot.registry = data; f.bot.heldItem = held;
  f.bot.inventory.items = () => items;
  f.bot.equip = async (item) => { f.bot.heldItem = item; };
  f.bot.unequip = async () => { f.bot.heldItem = null; };
  const config = { get: (key) => ({ humanize: false, spawnProtectionRadius: 0, digBlacklist: [], digWhitelist: [] })[key] };
  return { bot: f.bot, actions: new Actions({ bot: f.bot, config, navigator: f.nav }) };
}
const tool = (name, slot, used = 0) => ({ name, slot, count: 1, type: data.itemsByName[name].id,
  maxDurability: data.itemsByName[name].maxDurability, durabilityUsed: used });
test('a newly made same-name pickaxe is equipped rather than the old worn one', async () => {
  const old = tool('iron_pickaxe', 36, 249), fresh = tool('iron_pickaxe', 10);
  const f = toolActions([old, fresh]);
  await f.actions.equipBestToolFor(data.blocksByName.iron_ore);
  assert.equal(f.bot.heldItem, fresh);
});
test('an incompatible diamond axe cannot outrank a worn but valid iron pickaxe', async () => {
  const wrong = tool('diamond_axe', 36), valid = tool('iron_pickaxe', 10, 249);
  const f = toolActions([wrong, valid]);
  await f.actions.equipBestToolFor(data.blocksByName.iron_ore);
  assert.equal(f.bot.heldItem, valid);
});
test('chopping without an axe puts away the worn mining pickaxe', async () => {
  const old = tool('iron_pickaxe', 36, 249);
  const f = toolActions([old, { name: 'bread', count: 4, slot: 10 }]);
  await f.actions.equipBestToolFor(data.blocksByName.spruce_log);
  assert.equal(f.bot.heldItem.name, 'bread'); assert.equal(old.durabilityUsed, 249);
});
test('chopping with only an unsuitable pickaxe uses an empty hand', async () => {
  const f = toolActions([tool('iron_pickaxe', 36, 249)]);
  await f.actions.equipBestToolFor(data.blocksByName.spruce_log);
  assert.equal(f.bot.heldItem, null);
});

(async () => {
  let failed = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (err) { failed++; console.error(`FAIL ${name}\n${err.stack}`); }
  }
  console.log(`结果：${tests.length - failed} 通过，${failed} 失败`);
  process.exitCode = failed ? 1 : 0;
})();
