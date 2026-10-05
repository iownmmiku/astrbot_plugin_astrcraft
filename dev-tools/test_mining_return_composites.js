#!/usr/bin/env node
'use strict';

// Run the actual collection/tool/recipe composites and their mining children.
// Only Minecraft block loading, digging, inventory, crafting and furnace I/O
// are simulated; no skill implementation or return result is replaced.
process.env.MC_ENGINE_LOG_LEVEL = 'error';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const wood = require('../engine/skills/wood');
const gathering = require('../engine/skills/gathering');
const { Actions, guessSmeltOutput } = require('../engine/actions');
const { SkillContext } = require('../engine/skills/common');
const { executionContext } = require('../engine/goals');
const { vec3, CancelledError } = require('../engine/util');
const mcData = require('../engine/node_modules/minecraft-data')('1.20.1');

const tests = [], test = (name, run) => tests.push({ name, run });
function fixture({ inventory = {}, ore = 'iron_ore', amount = 3, loseAfterDig = false,
  cancelAfterDig = false, craftHook = null, stations = ['crafting_table', 'furnace'], loseAfterDigAt = null } = {}) {
  const counts = { stone_pickaxe: 1, stick: 2, coal: 1, ...inventory };
  const cells = new Map(), calls = [], controller = new AbortController();
  let loaded = true;
  const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  const block = (name, p) => ({ name, position: vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
    boundingBox: name === 'air' ? 'empty' : 'block', diggable: !['air', 'bedrock'].includes(name) });
  for (let n = 0; n < amount; n += 1) {
    const p = vec3(3 + n, 1, 0); cells.set(key(p), block(ore, p));
  }
  for (const [n, name] of stations.entries()) {
    const p = vec3(n, 1, 0); cells.set(key(p), block(name, p));
  }
  const recipes = { iron_pickaxe: { iron_ingot: 3, stick: 2 }, stone_pickaxe: { cobblestone: 3, stick: 2 },
    furnace: { cobblestone: 8 }, torch: { coal: 1, stick: 1 }, bucket: { iron_ingot: 3 } };
  const bot = new EventEmitter();
  Object.assign(bot, { entity: { position: vec3(2.5, 1, 2.5), onGround: true }, health: 20, food: 20,
    game: { dimension: 'overworld' }, time: { timeOfDay: 6000 }, version: '1.20.1', entities: {},
    _client: { socket: { remoteAddress: '127.0.0.1', remotePort: 25566 } },
    inventory: { items: () => Object.entries(counts).filter(([, n]) => n > 0)
      .map(([name, count]) => ({ name, count, maxDurability: 1000, durabilityUsed: 0 })) },
    // Keep the actual nearby workstations usable while the surrounding surface
    // samples unload. That isolates the parent's unsafe-return stop decision.
    blockAt: (p) => !loaded && (Math.abs(p.x - bot.entity.position.x) >= 6 ||
      Math.abs(p.z - bot.entity.position.z) >= 6) ? null
      : cells.get(key(p)) || block(p.y < 1 ? 'bedrock' : 'air', p),
    findBlock: ({ matching, useExtraInfo = false }) => [...cells.values()].find((b) => matching(b) &&
      (typeof useExtraInfo !== 'function' || useExtraInfo(b))) || null,
    findBlocks: ({ matching, useExtraInfo = false, count = 16 }) => [...cells.values()].filter(matching)
      .filter((b) => typeof useExtraInfo !== 'function' || useExtraInfo(b))
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
      .slice(0, count).map((b) => b.position),
    canSeeBlock: () => true,
    recipesAll: (id) => {
      const name = mcData.items[id].name, inputs = recipes[name];
      if (!inputs) return [];
      return [{ result: { id, count: name === 'torch' ? 4 : 1 },
        delta: Object.entries(inputs).map(([item, count]) => ({ id: mcData.itemsByName[item].id, count: -count })) }];
    },
    clearControlStates: () => {},
  });
  const ctx = new SkillContext({ signal: controller.signal, deadline: Date.now() + 20000 });
  const actions = { bot, inventoryMap: () => ({ ...counts }), countItem: (name) => counts[name] || 0,
    _missingForRecipe: Actions.prototype._missingForRecipe,
    equipBestToolFor: async () => {},
    async dig(params) {
      ctx.checkAborted(); calls.push({ kind: 'dig', ...params });
      const found = cells.get(key(params)); assert.ok(found?.diggable, `unexpected dig ${key(params)}`);
      cells.delete(key(params));
      const item = { iron_ore: 'raw_iron', coal_ore: 'coal', stone: 'cobblestone' }[found.name] || found.name;
      counts[item] = (counts[item] || 0) + 1;
      if (calls.filter((c) => c.kind === 'dig').length === (loseAfterDigAt ?? amount)) {
        if (loseAfterDig) loaded = false;
        if (cancelAfterDig) controller.abort();
      }
      return { block: found.name, collected: { [item]: 1 } };
    },
    async craft(params) {
      ctx.checkAborted(); calls.push({ kind: 'craft', ...params });
      const hooked = await craftHook?.(params, counts, controller);
      if (hooked !== undefined) return hooked;
      const inputs = recipes[params.item]; assert.ok(inputs, `unexpected craft ${params.item}`);
      for (const [name, n] of Object.entries(inputs)) assert.ok(counts[name] >= n, `missing ${name}`);
      for (const [name, n] of Object.entries(inputs)) counts[name] -= n;
      const produced = params.item === 'torch' ? 4 : 1;
      counts[params.item] = (counts[params.item] || 0) + produced;
      return { ok: true, produced };
    },
    async smelt(params) {
      ctx.checkAborted(); calls.push({ kind: 'smelt', ...params });
      const amount = Math.min(params.count, counts[params.item] || 0); assert.ok(amount > 0);
      const output = guessSmeltOutput(params.item);
      counts[params.item] -= amount; counts[output] = (counts[output] || 0) + amount;
      return { ok: true, output, produced: amount };
    },
  };
  const nav = { goTo: async (p) => { calls.push({ kind: 'nav', ...p }); throw new Error('simulated route unavailable'); } };
  const state = { nearbyEntities: () => [] };
  return { counts, calls, cells, bot, controller, ctx, actions, nav, state,
    tools: (tier = 'iron') => wood.makeTools({ actions, nav, state, ctx, tier, kinds: ['pickaxe'] }),
    collect: (item, count = 1, maxAttempts = null) => gathering.collect({ actions, nav, state, ctx, item, count, maxAttempts }) };
}

function unsafe(result) {
  assert.equal(result.ok, false);
  assert.equal(result.return_status?.ok, false);
  assert.ok(result.return_status.reason);
}
function protectedStoneFixture({ outsideStone = true, wallMaterial = 'cobblestone' } = {}) {
  const f = fixture({ inventory: { stone_pickaxe: 0, wooden_pickaxe: 1 }, amount: 0,
    stations: [] });
  const home = { server: '127.0.0.1:25566', dimension: 'overworld',
    origin: { x: 0, y: 1, z: 0 }, size: 5, wall_height: 2 };
  f.bot.entity.position = vec3(5.5, 1, -2.5);
  for (let x = 0; x < 5; x += 1) for (let z = 0; z < 5; z += 1) {
    if (x !== 0 && x !== 4 && z !== 0 && z !== 4) continue;
    for (const y of [1, 2]) {
      const position = vec3(x, y, z);
      f.cells.set(`${x},${y},${z}`, { name: wallMaterial, position, diggable: true, boundingBox: 'block' });
    }
  }
  const position = vec3(15, 1, -4);
  f.cells.set('15,1,-4', { name: 'crafting_table', position, diggable: true, boundingBox: 'block' });
  if (outsideStone) for (let x = 10; x < 13; x += 1) {
    const position = vec3(x, 1, -2);
    f.cells.set(`${x},1,-2`, { name: 'stone', position, diggable: true, boundingBox: 'block' });
  }
  const originalWalls = [...f.cells.entries()].filter(([, block]) => block.name === wallMaterial &&
    block.position.x < 5 && block.position.z >= 0 && block.position.z < 5);
  return { ...f, home, assertWalls: () => {
    for (const [key, original] of originalWalls) assert.equal(f.cells.get(key), original, `home wall changed: ${key}`);
  } };
}
test('stone tools choose the farther natural outcrop and preserve all nearby home walls', async () => {
  const f = protectedStoneFixture();
  const r = await executionContext.run({ protectedHome: f.home }, () => f.tools('stone'));
  assert.equal(r.ok, true); assert.equal(f.counts.stone_pickaxe, 1);
  assert.deepEqual(f.calls.filter((c) => c.kind === 'dig').map(({ x, y, z }) => [x, y, z]),
    [[10, 1, -2], [11, 1, -2], [12, 1, -2]]);
  f.assertWalls();
});
test('natural stone is preferred over closer cobblestone even without a registered home', async () => {
  const f = protectedStoneFixture(); const r = await f.tools('stone'); assert.equal(r.ok, true);
  assert.deepEqual(f.calls.filter((c) => c.kind === 'dig').map(({ x }) => x), [10, 11, 12]);
  f.assertWalls();
});
test('a nearby home built from stone cannot fill the capped natural-stone candidate list', async () => {
  const f = protectedStoneFixture({ wallMaterial: 'stone' });
  const r = await executionContext.run({ protectedHome: f.home }, () => f.tools('stone'));
  assert.equal(r.ok, true); assert.deepEqual(f.calls.filter((c) => c.kind === 'dig').map(({ x }) => x), [10, 11, 12]);
  f.assertWalls();
});
test('when only registered home cobblestone exists no wall becomes mining material', async () => {
  const f = protectedStoneFixture({ outsideStone: false });
  const r = await executionContext.run({ protectedHome: f.home }, () => wood.mineSpecific({ ...f,
    blockNames: ['stone', 'cobblestone'], want: 3, itemName: 'cobblestone', allowSearch: false, maxAttempts: 1 }));
  assert.equal(r.ok, false); assert.deepEqual(r.produced, {});
  assert.equal(f.calls.some((c) => c.kind === 'dig'), false); f.assertWalls();
});
test('protected candidate recheck rejects a legacy finder that ignores useExtraInfo', async () => {
  const f = protectedStoneFixture({ outsideStone: false });
  f.bot.findBlocks = () => [vec3(4, 1, 0), vec3(4, 2, 0)];
  const found = executionContext.run({ protectedHome: f.home }, () => wood.findNearestDiggable(f.actions, ['cobblestone'], 40));
  assert.equal(found, null); f.assertWalls();
});
test('spatial candidate protection is applied after a positionless palette match', async () => {
  const f = protectedStoneFixture(); const originalFind = f.bot.findBlocks;
  f.bot.findBlocks = (options) => {
    assert.equal(options.matching({ name: 'stone', diggable: true }), true);
    assert.equal(options.useExtraInfo({ name: 'stone', diggable: true }), false);
    return originalFind(options);
  };
  const found = executionContext.run({ protectedHome: f.home }, () => wood.findNearestDiggable(f.actions, ['stone', 'cobblestone'], 40));
  assert.deepEqual(found, { x: 10, y: 1, z: -2, name: 'stone' });
});
test('iron tools stop before smelting and crafting when acquired ore cannot safely return', async () => {
  const f = fixture({ loseAfterDig: true }); const r = await f.tools(); unsafe(r);
  assert.equal(r.collection_ok, false); assert.equal(r.material_collection_ok, true);
  assert.deepEqual(r.produced, { raw_iron: 3 }); assert.equal(f.counts.raw_iron, 3);
  assert.deepEqual(f.calls.map((c) => c.kind), ['dig', 'dig', 'dig', 'nav']);
});
test('safe iron collection continues smelting and confirms the requested tool', async () => {
  const f = fixture(); const r = await f.tools(); assert.equal(r.ok, true);
  assert.equal(r.return_status.ok, true); assert.equal(r.collection_ok, true);
  assert.equal(f.counts.iron_pickaxe, 1); assert.equal(f.counts.raw_iron, 0);
  assert.deepEqual(f.calls.map((c) => c.kind), ['dig', 'dig', 'dig', 'smelt', 'craft']);
});
test('stone tools retain cobblestone and stop before crafting after unsafe return', async () => {
  const f = fixture({ inventory: { stone_pickaxe: 0, wooden_pickaxe: 1 }, ore: 'stone', loseAfterDig: true });
  const r = await f.tools('stone'); unsafe(r); assert.equal(r.collection_ok, false);
  assert.deepEqual(r.produced, { cobblestone: 3 }); assert.equal(f.counts.cobblestone, 3);
  assert.equal(f.calls.some((c) => c.kind === 'craft'), false);
});
test('safe strict stone collection continues to the requested stone tool', async () => {
  const f = fixture({ inventory: { stone_pickaxe: 0, wooden_pickaxe: 1 }, ore: 'stone' });
  const r = await f.tools('stone'); assert.equal(r.ok, true); assert.equal(f.counts.stone_pickaxe, 1);
  assert.equal(r.return_status.ok, true); assert.equal(r.collection_ok, true);
});
test('raw-iron wrapper keeps a completed inventory target unsafe after failed return', async () => {
  const f = fixture({ loseAfterDig: true }); const r = await f.collect('raw_iron', 3); unsafe(r);
  assert.equal(r.collection_ok, true); assert.deepEqual(r.produced, { raw_iron: 3 });
  assert.equal(f.calls.filter((c) => c.kind === 'dig').length, 3);
});
test('coal wrapper digs coal ore directly without an untracked fallback search', async () => {
  const f = fixture({ inventory: { coal: 0 }, ore: 'coal_ore', amount: 2, loseAfterDig: true });
  const r = await f.collect('coal', 2); unsafe(r); assert.equal(r.collection_ok, true);
  assert.deepEqual(r.produced, { coal: 2 }); assert.deepEqual(f.calls.map((c) => c.kind), ['dig', 'dig', 'nav']);
});
test('cobblestone wrapper uses strict mining and preserves unsafe actual inventory', async () => {
  const f = fixture({ ore: 'stone', loseAfterDig: true }); const r = await f.collect('cobblestone', 3); unsafe(r);
  assert.equal(r.collection_ok, true); assert.deepEqual(r.produced, { cobblestone: 3 });
});
test('ingot collection cannot smelt newly acquired ore at the stranded position', async () => {
  const f = fixture({ loseAfterDig: true }); const r = await f.collect('iron_ingot', 3); unsafe(r);
  assert.equal(r.collection_ok, false); assert.deepEqual(r.produced, { raw_iron: 3 });
  assert.equal(f.calls.some((c) => c.kind === 'smelt'), false);
});
test('safe ingot collection forwards verified return and confirms actual ingots', async () => {
  const f = fixture(); const r = await f.collect('iron_ingot', 3);
  assert.equal(r.ok, true); assert.equal(r.return_status.ok, true); assert.equal(r.collection_ok, true);
  assert.deepEqual(r.produced, { iron_ingot: 3 }); assert.equal(f.counts.iron_ingot, 3);
});
test('later unsafe furnace-material return cannot be overwritten by the earlier safe iron return', async () => {
  const f = fixture({ loseAfterDig: true, loseAfterDigAt: 11, stations: ['crafting_table'] });
  for (let n = 0; n < 8; n += 1) {
    const position = vec3(3 + n, 1, 1);
    f.cells.set(`${3 + n},1,1`, { name: 'stone', position, diggable: true, boundingBox: 'block' });
  }
  const r = await f.collect('iron_ingot', 3); unsafe(r); assert.equal(r.collection_ok, false);
  assert.deepEqual(r.produced, { raw_iron: 3, cobblestone: 8 });
  assert.equal(f.calls.filter((c) => c.kind === 'dig').length, 11);
  assert.equal(f.calls.some((c) => ['craft', 'smelt'].includes(c.kind)), false);
});
test('partial raw stock is processed first and only the remaining deficit is gathered', async () => {
  const f = fixture({ inventory: { raw_iron: 2 }, amount: 1 }); const r = await f.collect('iron_ingot', 3);
  assert.equal(r.ok, true); assert.equal(r.return_status.ok, true); assert.equal(f.counts.iron_ingot, 3);
  assert.deepEqual(f.calls.map((c) => c.kind), ['smelt', 'dig', 'smelt']);
  assert.equal(f.calls.filter((c) => c.kind === 'dig').length, 1);
});
test('missing furnace material failure cannot continue to smelt another iron variant', async () => {
  const f = fixture({ inventory: { raw_iron: 1, iron_ore: 1, deepslate_iron_ore: 1 },
    ore: 'stone', amount: 8, loseAfterDig: true, stations: ['crafting_table'] });
  const r = await f.tools(); unsafe(r); assert.equal(r.collection_ok, false);
  assert.deepEqual(r.produced, { cobblestone: 8 }); assert.equal(f.counts.cobblestone, 8);
  assert.equal(f.counts.raw_iron, 1); assert.equal(f.counts.iron_ore, 1); assert.equal(f.counts.deepslate_iron_ore, 1);
  assert.equal(f.calls.filter((c) => c.kind === 'dig').length, 8);
  assert.equal(f.calls.some((c) => ['craft', 'smelt'].includes(c.kind)), false);
});
test('food cooking stops its other raw-food and hunting dependencies after unsafe furnace stone', async () => {
  const f = fixture({ inventory: { beef: 2, porkchop: 2 }, ore: 'stone', amount: 8,
    loseAfterDig: true, stations: ['crafting_table'] });
  const r = await gathering.cookFood({ ...f, count: 4 }); unsafe(r); assert.equal(r.collection_ok, false);
  assert.deepEqual(r.produced, { cobblestone: 8 }); assert.equal(f.counts.beef, 2); assert.equal(f.counts.porkchop, 2);
  assert.equal(f.calls.filter((c) => c.kind === 'dig').length, 8);
  assert.equal(f.calls.some((c) => ['craft', 'smelt', 'attack'].includes(c.kind)), false);
});
test('partial recursive recipe stock still gathers the missing coal', async () => {
  const f = fixture({ inventory: { coal: 1 }, ore: 'coal_ore', amount: 1 });
  // Eight torches require two coal; the recursive total must stay two, not one.
  const originalCraft = f.actions.craft;
  f.actions.craft = async (params) => {
    if (params.item !== 'torch' || params.count !== 8) return originalCraft(params);
    f.calls.push({ kind: 'craft', ...params }); assert.ok(f.counts.coal >= 2);
    f.counts.coal -= 2; f.counts.stick -= 2; f.counts.torch = 8;
    return { ok: true, produced: 8 };
  };
  const r = await f.collect('torch', 8); assert.equal(r.ok, true); assert.equal(f.counts.torch, 8);
  assert.deepEqual(f.calls.map((c) => c.kind), ['dig', 'craft']);
});
test('direct collection preserves total-target semantics with existing coal', async () => {
  const f = fixture({ inventory: { coal: 2 }, ore: 'coal_ore', amount: 2 });
  const r = await f.collect('coal', 4); assert.equal(r.ok, true); assert.equal(r.collection_ok, true);
  assert.deepEqual(r.produced, { coal: 2 }); assert.equal(f.counts.coal, 4);
  assert.deepEqual(f.calls.map((c) => c.kind), ['dig', 'dig']);
});
test('strict cobblestone collection never substitutes andesite as target material', async () => {
  const f = fixture({ ore: 'andesite', amount: 3 }); const r = await f.collect('cobblestone', 3, 1);
  assert.equal(r.ok, false); assert.equal(r.collection_ok, false); assert.equal(r.return_status.ok, true);
  assert.equal(f.counts.cobblestone || 0, 0); assert.equal(f.counts.andesite || 0, 0);
  assert.equal(f.calls.some((c) => c.kind === 'dig'), false);
});
test('furnace recipe chain stops even though mining obtained all eight cobblestone', async () => {
  const f = fixture({ ore: 'stone', amount: 8, loseAfterDig: true });
  const r = await f.collect('furnace'); unsafe(r); assert.equal(r.collection_ok, false);
  assert.deepEqual(r.produced, { cobblestone: 8 }); assert.equal(f.calls.some((c) => c.kind === 'craft'), false);
});
test('recursive torch recipe cannot craft after the coal child fails its return', async () => {
  const f = fixture({ inventory: { coal: 0 }, ore: 'coal_ore', amount: 1, loseAfterDig: true });
  const r = await f.collect('torch'); unsafe(r); assert.equal(r.collection_ok, false);
  assert.deepEqual(r.produced, { coal: 1 }); assert.equal(f.calls.some((c) => c.kind === 'craft'), false);
});
test('safe recursive torch recipe confirms its output and forwards verified return', async () => {
  const f = fixture({ inventory: { coal: 0 }, ore: 'coal_ore', amount: 1 });
  const r = await f.collect('torch'); assert.equal(r.ok, true); assert.equal(r.return_status.ok, true);
  assert.equal(r.collection_ok, true); assert.equal(f.counts.torch, 4);
});
test('craft rejection fallback cannot retry crafting after unsafe material return', async () => {
  let first = true;
  const f = fixture({ inventory: { cobblestone: 8 }, ore: 'stone', amount: 8, loseAfterDig: true,
    craftHook: async (_p, counts) => {
      if (first) { first = false; counts.cobblestone = 0; throw new Error('server rejected stale craft'); }
    } });
  const r = await f.collect('furnace'); unsafe(r); assert.equal(r.collection_ok, false);
  assert.equal(f.counts.cobblestone, 8); assert.equal(f.counts.furnace || 0, 0);
  assert.equal(f.calls.filter((c) => c.kind === 'craft').length, 1);
});
test('cancelled iron collection propagates cancellation without smelting or crafting', async () => {
  const f = fixture({ cancelAfterDig: true }); await assert.rejects(f.tools(), CancelledError);
  assert.equal(f.counts.raw_iron, 3); assert.equal(f.calls.some((c) => c.kind !== 'dig'), false);
});
test('cancelled recipe material collection cannot become a normal false result', async () => {
  const f = fixture({ ore: 'stone', amount: 8, cancelAfterDig: true });
  await assert.rejects(f.collect('furnace'), CancelledError);
  assert.equal(f.counts.cobblestone, 8); assert.equal(f.calls.some((c) => c.kind === 'craft'), false);
});
test('fallback crafting propagates cancellation after an ordinary window error', async () => {
  let first = true;
  const f = fixture({ inventory: { cobblestone: 8 }, craftHook: async (_p, _counts, controller) => {
    if (first) { first = false; throw new Error('stale initial window'); }
    controller.abort(); throw new Error('late closed window');
  } });
  await assert.rejects(f.collect('furnace'), CancelledError);
  assert.equal(f.calls.filter((c) => c.kind === 'craft').length, 2);
});

module.exports = { fixture, protectedStoneFixture };
if (require.main === module) (async () => {
  let failed = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (err) { failed += 1; console.error(`FAIL ${name}: ${err.stack || err}`); }
  }
  console.log(`结果：${tests.length - failed} 通过，${failed} 失败`);
  process.exitCode = failed ? 1 : 0;
})();
