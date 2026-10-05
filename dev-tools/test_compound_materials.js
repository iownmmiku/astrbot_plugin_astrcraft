#!/usr/bin/env node
'use strict';

// Production material dependencies and search restrictions; only Minecraft
// crafting, digging and inventory acceptance are simulated.
process.env.MC_ENGINE_LOG_LEVEL = 'error';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const wood = require('../engine/skills/wood');
const mining = require('../engine/skills/mining');
const { guessSmeltOutput, MissingItemError } = require('../engine/actions');
const { executionContext } = require('../engine/goals');
const { SkillContext } = require('../engine/skills/common');
const { withPreparation } = require('../engine/skills/preparation');
const { vec3, CancelledError } = require('../engine/util');

const tests = [], test = (name, run) => tests.push({ name, run });
const home = { origin: { x: 0, y: 1, z: 0 }, size: 5, wall_height: 2 };
function fixture(inventory = {}, { stations = ['crafting_table', 'furnace'], ore = 0, logs = 0,
  smeltHook = null, craftHook = null, digHook = null } = {}) {
  const counts = { ...inventory }, calls = [], cells = new Map(), controller = new AbortController();
  const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  const block = (name, position) => ({ name, position, diggable: true,
    boundingBox: name === 'air' ? 'empty' : 'block' });
  stations.forEach((name, index) => {
    const position = vec3(1 + index, 1, 1);
    cells.set(key(position), block(name, position));
  });
  for (let n = 0; n < ore; n += 1) {
    const position = vec3(3 + n, 1, 0);
    cells.set(key(position), block('iron_ore', position));
  }
  for (let n = 0; n < logs; n += 1) {
    const position = vec3(1 + n, 1, 0);
    cells.set(key(position), block('oak_log', position));
  }
  const bot = new EventEmitter();
  Object.assign(bot, { entity: { position: vec3(2.5, 1, 2.5), onGround: true },
    health: 20, food: 20, game: { dimension: 'overworld' }, time: { timeOfDay: 6000 },
    version: '1.20.1', entities: {},
    inventory: { items: () => Object.entries(counts).filter(([, n]) => n > 0)
      .map(([name, count]) => ({ name, count, maxDurability: 1000 })) },
    blockAt: (p) => cells.get(key(p)) || block(p.y < 1 ? 'bedrock' : 'air', p),
    findBlock: ({ matching, useExtraInfo = false }) => {
      const blocks = [...cells.values()];
      // Mineflayer skips a chunk section when no positionless palette block
      // matches, then applies spatial filters only to loaded real blocks.
      if (!blocks.some(({ name, type }) => matching({ name, type }))) return null;
      return blocks.find((b) => matching(b) &&
        (typeof useExtraInfo !== 'function' || useExtraInfo(b))) || null;
    },
    findBlocks: ({ matching, count = 16 }) => [...cells.values()].filter(matching).slice(0, count).map((b) => b.position),
    canSeeBlock: () => true,
  });
  const recipe = { iron_pickaxe: { iron_ingot: 3, stick: 2 }, stone_pickaxe: { cobblestone: 3, stick: 2 },
    crafting_table: { oak_planks: 4 }, furnace: { cobblestone: 8 }, stick: { oak_planks: 2 } };
  const actions = { bot, inventoryMap: () => ({ ...counts }), countItem: (name) => counts[name] || 0,
    _spotInFront: () => ({ x: 1, y: 1, z: 2 }), equipBestToolFor: async () => {},
    async craft(params) {
      calls.push({ kind: 'craft', ...params });
      if (craftHook) {
        const r = await craftHook(params, counts, controller);
        if (r !== undefined) return r;
      }
      const usablePlanks = params.item === 'stick' && Object.keys(counts).find((name) =>
        name.endsWith('_planks') && counts[name] >= 2);
      const inputs = usablePlanks ? { [usablePlanks]: 2 } : recipe[params.item];
      assert.ok(inputs, `unexpected craft ${params.item}`);
      for (const [name, n] of Object.entries(inputs)) assert.ok((counts[name] || 0) >= n, `missing ${name}`);
      for (const [name, n] of Object.entries(inputs)) counts[name] -= n;
      const produced = params.item === 'stick' ? 4 : 1;
      counts[params.item] = (counts[params.item] || 0) + produced;
      return { ok: true, produced };
    },
    async place({ x, y, z, item }) {
      assert.ok(counts[item] > 0); counts[item] -= 1;
      const position = vec3(x, y, z); cells.set(key(position), block(item, position));
      return { ok: true };
    },
    async dig(params) {
      calls.push({ kind: 'dig', ...params });
      const found = cells.get(key(params)); assert.ok(found?.diggable);
      cells.delete(key(params));
      const name = found.name === 'iron_ore' ? 'raw_iron' : found.name === 'stone' ? 'cobblestone' : found.name;
      counts[name] = (counts[name] || 0) + 1;
      await digHook?.(params, counts, bot);
      return { block: found.name, collected: { [name]: 1 } };
    },
    async smelt(params) {
      calls.push({ kind: 'smelt', ...params });
      if (smeltHook) {
        const r = await smeltHook(params, counts, controller);
        if (r !== undefined) return r;
      }
      const amount = Math.min(params.count, counts[params.item] || 0);
      assert.ok(amount > 0);
      if (!(counts.coal >= Math.ceil(amount / 8))) throw new MissingItemError('足够的熔炼燃料', '模拟熔炉已无可用热量');
      counts[params.item] -= amount; counts.coal -= Math.ceil(amount / 8);
      const output = guessSmeltOutput(params.item);
      counts[output] = (counts[output] || 0) + amount;
      return { ok: true, output, produced: amount };
    },
  };
  const ctx = new SkillContext({ signal: controller.signal, deadline: Date.now() + 5000 });
  const nav = { goTo: async () => { throw new Error('unexpected navigation'); } };
  const state = { nearbyEntities: () => [] };
  return { actions, bot, counts, calls, cells, controller, ctx, nav, state,
    smelt: (item = 'raw_iron', count = 3) => mining.smeltOres({ actions, nav, state, ctx, item, count }),
    tools: (params = {}) => wood.makeTools({ actions, nav, state, ctx, tier: 'iron', kinds: ['pickaxe'], ...params }) };
}

test('zero output and forged success cannot report smelting complete', async () => {
  for (const reply of [{ ok: false, output: 'iron_ingot', produced: 0 },
    { ok: true, output: 'iron_ingot', produced: 99 }]) {
    const f = fixture({ raw_iron: 3, coal: 1, iron_ingot: 12 }, { smeltHook: async () => reply });
    const r = await f.smelt(); assert.equal(r.ok, false); assert.deepEqual(r.produced, {});
    assert.equal(f.counts.iron_ingot, 12); assert.match(r.reason, /实际成品/);
  }
});
test('actual accepted output is retained even when the reply claims zero', async () => {
  const f = fixture({ raw_iron: 3, coal: 1 }, { smeltHook: async (_p, counts) => {
    counts.raw_iron -= 1; counts.iron_ingot = 1;
    return { ok: false, output: 'diamond', produced: 0 };
  } });
  const r = await f.smelt(); assert.equal(r.ok, true); assert.deepEqual(r.produced, { iron_ingot: 1 });
  assert.match(r.failed[0].error, /1\/3/);
});
test('late ordinary rejection preserves actual partial output', async () => {
  const f = fixture({ raw_iron: 3, coal: 1 }, { smeltHook: async (_p, counts) => {
    counts.raw_iron -= 1; counts.iron_ingot = 1; throw new Error('server window rejected');
  } });
  const r = await f.smelt(); assert.equal(r.ok, true); assert.deepEqual(r.produced, { iron_ingot: 1 });
  assert.match(r.failed[0].error, /服务器|server/);
});
test('an unrelated inventory item cannot become the claimed smelted product', async () => {
  const f = fixture({ raw_iron: 3, coal: 1 }, { smeltHook: async (_p, counts) => {
    counts.diamond = 1; return { ok: true, output: 'diamond', produced: 1 };
  } });
  const r = await f.smelt(); assert.equal(r.ok, false); assert.deepEqual(r.produced, {});
});
test('a later missing dependency retains the earlier confirmed batch', async () => {
  const f = fixture({ raw_iron: 3, beef: 2, coal: 1 });
  const r = await executionContext.run({ indoorHome: home, allowOutdoorSearch: false }, () => f.smelt(null, null));
  assert.equal(r.ok, true); assert.deepEqual(r.produced, { iron_ingot: 3 });
  assert.equal(f.counts.beef, 2); assert.equal(f.calls.filter((c) => c.kind === 'smelt').length, 2);
  assert.match(r.failed[0].error, /出门|室内/);
});
test('aborted late output propagates cancellation', async () => {
  const f = fixture({ raw_iron: 3, coal: 1 }, { smeltHook: async (_p, counts, controller) => {
    counts.iron_ingot = 3; controller.abort(); return { ok: true, output: 'iron_ingot', produced: 3 };
  } });
  await assert.rejects(f.smelt(), CancelledError);
});
test('a claimed furnace craft without inventory confirmation fails', async () => {
  const f = fixture({ raw_iron: 3, cobblestone: 8, coal: 1 }, { stations: ['crafting_table'],
    craftHook: async () => ({ ok: true, produced: 1 }) });
  const r = await f.smelt(); assert.equal(r.ok, false); assert.deepEqual(r.produced, {});
  assert.equal(f.calls.filter((c) => c.kind === 'smelt').length, 0);
});
test('a smoker cooks existing food without mining or building another furnace', async () => {
  const f = fixture({ beef: 3, coal: 1 }, { stations: ['smoker'] });
  const r = await f.smelt('beef'); assert.equal(r.ok, true); assert.deepEqual(r.produced, { cooked_beef: 3 });
  assert.deepEqual(f.calls.map((c) => c.kind), ['smelt']);
});
test('an incompatible blast furnace is not mistaken for a food cooker', async () => {
  const f = fixture({ beef: 3, coal: 1, cobblestone: 8 }, { stations: ['crafting_table', 'blast_furnace'] });
  const r = await f.smelt('beef'); assert.equal(r.ok, true);
  assert.deepEqual(f.calls.map((c) => [c.kind, c.item]), [['craft', 'furnace'], ['smelt', 'beef']]);
});
test('actual furnace residual heat works with no backpack fuel and no harvesting', async () => {
  let fuelSeconds = 30;
  const f = fixture({ raw_iron: 3 }, { smeltHook: async (params, counts) => {
    const amount = Math.min(params.count, counts[params.item]);
    assert.ok(fuelSeconds >= amount * 10);
    fuelSeconds -= amount * 10; counts[params.item] -= amount; counts.iron_ingot = amount;
    return { ok: true, output: 'iron_ingot', produced: amount };
  } });
  const r = await executionContext.run({ indoorHome: home, allowOutdoorSearch: false }, () => f.smelt());
  assert.equal(r.ok, true); assert.deepEqual(r.produced, { iron_ingot: 3 });
  assert.deepEqual(f.calls.map((c) => c.kind), ['smelt']); assert.equal(fuelSeconds, 0);
});
test('one coal supplies residual heat across three different iron input batches', async () => {
  let fuelSeconds = 0;
  const f = fixture({ raw_iron: 1, iron_ore: 1, deepslate_iron_ore: 1, coal: 1, stick: 2 }, {
    smeltHook: async (params, counts) => {
      const amount = Math.min(params.count, counts[params.item]);
      if (fuelSeconds < amount * 10 && counts.coal > 0) { counts.coal -= 1; fuelSeconds += 80; }
      if (fuelSeconds < amount * 10) throw new MissingItemError('熔炼燃料', '实际余热也已耗尽');
      fuelSeconds -= amount * 10; counts[params.item] -= amount;
      counts.iron_ingot = (counts.iron_ingot || 0) + amount;
      return { ok: true, output: 'iron_ingot', produced: amount };
    },
  });
  const r = await executionContext.run({ indoorHome: home, allowOutdoorSearch: false }, () => f.tools());
  assert.equal(r.ok, true, r.reason); assert.equal(f.counts.iron_pickaxe, 1); assert.equal(f.counts.coal, 0);
  assert.equal(f.calls.filter((c) => c.kind === 'smelt').length, 3);
  assert.equal(f.calls.filter((c) => c.kind === 'dig').length, 0); assert.equal(fuelSeconds, 50);
});
test('a real missing-fuel error gathers wood and retries the furnace only once', async () => {
  const f = fixture({ raw_iron: 3 }, { logs: 3, smeltHook: async (params, counts) => {
    if (!(counts.oak_log >= 2)) throw new MissingItemError('足够的熔炼燃料', '没有剩余燃烧时间');
    counts.oak_log -= 2; counts[params.item] -= params.count; counts.iron_ingot = params.count;
    return { ok: true, output: 'iron_ingot', produced: params.count };
  } });
  const r = await executionContext.run({ safeSearch: true }, () => f.smelt());
  assert.equal(r.ok, true, r.reason); assert.deepEqual(r.produced, { iron_ingot: 3 });
  assert.deepEqual(f.calls.map((c) => c.kind), ['smelt', 'dig', 'dig', 'dig', 'smelt']);
  assert.equal(f.counts.oak_log, 1);
});
test('a second missing-fuel response cannot start another wood gathering cycle', async () => {
  const f = fixture({ raw_iron: 3 }, { logs: 6,
    smeltHook: async () => { throw new MissingItemError('燃料', '服务端尚未接受燃料'); } });
  const r = await executionContext.run({ safeSearch: true }, () => f.smelt());
  assert.equal(r.ok, false); assert.deepEqual(r.produced, {});
  assert.equal(f.calls.filter((c) => c.kind === 'smelt').length, 2);
  assert.equal(f.calls.filter((c) => c.kind === 'dig').length, 3);
});
test('zero-output responses and other missing items never trigger blind fuel gathering', async () => {
  for (const error of [null, new Error('fuel window refused'),
    new MissingItemError('熔炉', '并非缺少燃料，而是没有熔炉')]) {
    const f = fixture({ raw_iron: 3 }, { logs: 3, smeltHook: async () => {
      if (error) throw error;
      return { ok: false, output: 'iron_ingot', produced: 0, note: '没有产出' };
    } });
    const r = await executionContext.run({ safeSearch: true }, () => f.smelt());
    assert.equal(r.ok, false); assert.deepEqual(r.produced, {});
    assert.deepEqual(f.calls.map((c) => c.kind), ['smelt']);
  }
});
test('partial accepted output reduces the retry input instead of smelting a new full batch', async () => {
  let first = true;
  const f = fixture({ raw_iron: 5 }, { logs: 3, smeltHook: async (params, counts) => {
    if (first) {
      first = false; counts.raw_iron -= 1; counts.iron_ingot = 1;
      throw new MissingItemError('熔炼燃料', '剩余燃料不足');
    }
    counts.raw_iron -= params.count; counts.iron_ingot += params.count;
    return { ok: true, output: 'iron_ingot', produced: params.count };
  } });
  const r = await executionContext.run({ safeSearch: true }, () => f.smelt());
  assert.equal(r.ok, true); assert.deepEqual(r.produced, { iron_ingot: 3 }); assert.equal(f.counts.raw_iron, 2);
  assert.deepEqual(f.calls.filter((c) => c.kind === 'smelt').map((c) => c.count), [3, 2]);
});
test('existing raw iron makes an iron pick indoors without mining replacements', async () => {
  const f = fixture({ raw_iron: 3, coal: 1, stick: 2 });
  const r = await executionContext.run({ indoorHome: home, allowOutdoorSearch: false }, () => f.tools());
  assert.equal(r.ok, true, r.reason); assert.equal(f.counts.iron_pickaxe, 1);
  assert.deepEqual(f.calls.map((c) => [c.kind, c.item]), [['smelt', 'raw_iron'], ['craft', 'iron_pickaxe']]);
});
test('silk touched iron variants are also usable indoor stock', async () => {
  const f = fixture({ raw_iron: 1, iron_ore: 1, deepslate_iron_ore: 1, coal: 3, stick: 2 });
  const r = await executionContext.run({ indoorHome: home, allowOutdoorSearch: false }, () => f.tools());
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(f.calls.filter((c) => c.kind === 'smelt').map((c) => [c.item, c.count]),
    [['raw_iron', 1], ['iron_ore', 1], ['deepslate_iron_ore', 1]]);
});
test('iron conversion stops at the actual tool deficit', async () => {
  const f = fixture({ iron_ingot: 2, raw_iron: 8, coal: 1, stick: 2 });
  const r = await f.tools(); assert.equal(r.ok, true); assert.equal(f.counts.raw_iron, 7);
  assert.equal(f.calls[0].count, 1);
});
test('existing iron is used before collecting only the missing ore', async () => {
  const f = fixture({ raw_iron: 2, coal: 2, stick: 2, stone_pickaxe: 1 }, { ore: 4 });
  const r = await executionContext.run({ safeSearch: true }, () => f.tools());
  assert.equal(r.ok, true, r.reason); assert.equal(f.calls.filter((c) => c.kind === 'dig').length, 1);
  assert.deepEqual(f.calls.filter((c) => c.kind === 'smelt').map((c) => c.count), [2, 1]);
});
test('failed ore conversion does not trigger mining substitute raw material', async () => {
  const f = fixture({ raw_iron: 3, coal: 1, stick: 2, stone_pickaxe: 1 }, { ore: 4,
    smeltHook: async () => ({ ok: true, output: 'iron_ingot', produced: 3 }) });
  const r = await f.tools(); assert.equal(r.ok, false); assert.deepEqual(r.produced, {});
  assert.equal(f.calls.filter((c) => c.kind === 'dig').length, 0);
});
test('disabled searching keeps partial ingots and never mines the remaining deficit', async () => {
  const f = fixture({ raw_iron: 2, coal: 1, stick: 2, stone_pickaxe: 1 }, { ore: 4 });
  const r = await f.tools({ allowSearch: false }); assert.equal(r.ok, false);
  assert.deepEqual(r.produced, { iron_ingot: 2 }); assert.equal(f.calls.filter((c) => c.kind === 'dig').length, 0);
});
test('disabled searching also forbids stone tool material gathering', async () => {
  const f = fixture({ stick: 2, wooden_pickaxe: 1 });
  const r = await f.tools({ tier: 'stone', allowSearch: false }); assert.equal(r.ok, false);
  assert.deepEqual(f.calls, []);
});
test('mixed wood stock uses a complete plank pair instead of the first singleton', async () => {
  const f = fixture({ oak_planks: 1, spruce_planks: 2 }, { stations: [] });
  const r = await executionContext.run({ indoorHome: home, allowOutdoorSearch: false }, () =>
    wood.makeSticks({ actions: f.actions, ctx: f.ctx, nav: f.nav, state: f.state, want: 4 }));
  assert.equal(r.ok, true, r.reason); assert.equal(f.counts.stick, 4);
  assert.equal(f.counts.oak_planks, 1); assert.equal(f.counts.spruce_planks, 0);
  assert.deepEqual(r.produced, { stick: 4 });
  assert.deepEqual(f.calls.map((c) => [c.kind, c.item]), [['craft', 'stick']]);
});
test('palette filtering still selects real indoor tables and furnaces over outside ones', async () => {
  const f = fixture({ raw_iron: 1, coal: 1 }, { stations: [] });
  const table = vec3(3, 1, 3), furnace = vec3(2, 1, 3);
  for (const [name, position] of [['crafting_table', vec3(0, 1, 0)], ['furnace', vec3(0, 1, 1)],
    ['crafting_table', table], ['furnace', furnace]]) {
    f.cells.set(`${position.x},${position.y},${position.z}`, { name, type: name === 'furnace' ? 1 : 2,
      position, boundingBox: 'block' });
  }
  await executionContext.run({ indoorHome: home, allowOutdoorSearch: false }, async () => {
    const workbench = await wood.ensureCraftingTable({ actions: f.actions, ctx: f.ctx });
    assert.equal(workbench.ok, true); assert.deepEqual(workbench.position, table);
    const r = await f.smelt('raw_iron', 1); assert.equal(r.ok, true, r.reason);
    assert.deepEqual(r.produced, { iron_ingot: 1 });
  });
  assert.deepEqual(f.calls.map((c) => c.kind), ['smelt']);
});
test('tree search applies height only after its positionless palette match', async () => {
  const f = fixture({}, { stations: [] });
  const high = vec3(3, 10, 3), reachable = vec3(3, 1, 5);
  for (const position of [high, reachable]) f.cells.set(`${position.x},${position.y},${position.z}`, {
    name: 'oak_log', type: 3, position, diggable: true, boundingBox: 'block' });
  const result = await executionContext.run({ safeSearch: true }, () => wood.wanderLookingFor(['oak_log'],
    { actions: f.actions, ctx: f.ctx, nav: f.nav, radius: 16, maxHops: 1 }));
  assert.deepEqual(result, { x: reachable.x, y: reachable.y, z: reachable.z, name: 'oak_log' });
  assert.deepEqual(f.calls, []);
});
test('all gathering entries refuse to dig from inside a closed base', async () => {
  const entries = [
    (f) => wood.chopTree({ ...f, want: 1 }),
    (f) => wood.mineSpecific({ ...f, blockNames: ['iron_ore'], itemName: 'raw_iron', want: 1 }),
    (f) => mining.mineOre({ ...f, ore: 'iron', want: 1, autoTool: false }),
    (f) => mining.mineStone({ ...f, want: 1 }),
  ];
  for (const run of entries) {
    const f = fixture({ stone_pickaxe: 1 }, { ore: 3 });
    await assert.rejects(executionContext.run({ indoorHome: home }, () => run(f)), { name: 'PreparationBlockedError' });
    assert.deepEqual(f.calls, []);
  }
});
test('night, low health and unknown time block automatic gathering before body actions', async () => {
  for (const patch of [{ health: 8 }, { time: { timeOfDay: 13000 } }, { time: {} }]) {
    const f = fixture({ stone_pickaxe: 1 }, { ore: 3 }); Object.assign(f.bot, patch);
    await assert.rejects(executionContext.run({ safeSearch: true }, () =>
      mining.mineOre({ ...f, ore: 'iron', want: 1 })), { name: 'PreparationBlockedError' });
    assert.deepEqual(f.calls, []);
  }
});
test('automatic gathering stops when night begins between two accepted drops', async () => {
  const f = fixture({ stone_pickaxe: 1 }, { ore: 4,
    digHook: async (_p, _counts, bot) => { bot.time.timeOfDay = 13000; } });
  const r = await withPreparation({ actions: f.actions, ctx: f.ctx, safeSearch: true }, (ctx) =>
    mining.mineOre({ ...f, ctx, ore: 'iron', want: 3 }));
  assert.equal(r.ok, false); assert.deepEqual(r.produced, { raw_iron: 1 });
  assert.equal(f.calls.filter((c) => c.kind === 'dig').length, 1);
});
test('an outside workstation is excluded from an indoor material decision', async () => {
  const f = fixture({ cobblestone: 3, stick: 2 }, { stations: [] });
  const position = vec3(0, 1, 0);
  f.cells.set('0,1,0', { name: 'crafting_table', position, boundingBox: 'block' });
  await assert.rejects(executionContext.run({ indoorHome: home }, () => f.tools({ tier: 'stone' })),
    { name: 'PreparationBlockedError' });
  assert.deepEqual(f.calls, []);
});

(async () => {
  let failed = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (err) { failed += 1; console.error(`FAIL ${name}: ${err.stack || err}`); }
  }
  console.log(`结果：${tests.length - failed} 通过，${failed} 失败`);
  process.exitCode = failed ? 1 : 0;
})();
