#!/usr/bin/env node
'use strict';

// Real McEngine.submitSkill, TaskQueue and collection skills; Minecraft I/O is
// a small deterministic world. No server, account or network is required.
if (require.main === module) process.env.MC_ENGINE_LOG_LEVEL = 'error';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { McEngine } = require('../engine/bot');
const { PRIORITY } = require('../engine/goals');
const { SkillContext } = require('../engine/skills/common');
const { vec3, delay, CancelledError } = require('../engine/util');
const wood = require('../engine/skills/wood');
const mining = require('../engine/skills/mining');

const tests = [];
const test = (name, run) => tests.push({ name, run });
const keyOf = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

function world({ inventory = {}, blocks = [], preemptAt = [] } = {}) {
  const engine = new McEngine({ emit: () => {} });
  const counts = { ...inventory };
  const cells = new Map();
  const bot = new EventEmitter();
  const block = (name, p, diggable = true) => ({
    name, position: p, diggable, boundingBox: name === 'air' ? 'empty' : 'block',
  });
  blocks.forEach((name, index) => {
    const p = vec3(1 + index % 6, 1, 1 + Math.floor(index / 6));
    cells.set(keyOf(p), block(name, p));
  });
  Object.assign(bot, {
    username: 'test', version: '1.20.4',
    entity: { position: vec3(0.5, 1, 0.5), onGround: true },
    food: 20, health: 20, entities: {},
    inventory: { items: () => Object.entries(counts).filter(([, count]) => count > 0)
      .map(([name, count]) => ({ name, count, maxDurability: 9999 })) },
    blockAt: (p) => cells.get(keyOf(p)) || block(p.y <= 0 ? 'bedrock' : 'air', p, false),
    findBlocks: ({ matching, count = 16 }) => [...cells.values()].filter(matching).slice(0, count).map((b) => b.position),
    findBlock: ({ matching }) => [...cells.values()].find(matching) || null,
    canSeeBlock: () => true,
    clearControlStates() {}, stopDigging() {}, deactivateItem() {},
    pathfinder: { setGoal() {}, stop() {} },
  });
  let digs = 0;
  const crafted = [];
  const actions = {
    bot, inventoryMap: () => ({ ...counts }), countItem: (name) => counts[name] || 0,
    stopCurrent() {},
    equipBestToolFor: async () => {},
    async dig({ x, y, z, signal }) {
      if (signal && signal.aborted) throw new CancelledError('test interrupted');
      const k = keyOf({ x, y, z });
      const b = cells.get(k);
      if (!b || !b.diggable) throw new Error('no diggable test block');
      const ore = Object.values(mining.ORES).find((spec) => spec.blocks.includes(b.name));
      const item = ore ? ore.item : b.name === 'stone' ? 'cobblestone' : b.name;
      cells.delete(k);
      counts[item] = (counts[item] || 0) + 1;
      digs += 1;
      if (preemptAt.includes(digs)) {
        engine.queue.submit({ name: `critical-${digs}`, priority: PRIORITY.CRITICAL,
          run: async () => ({ ok: true }) });
      }
      await delay(1, { signal });
      return { block: b.name, collected: { [item]: 1 } };
    },
    async craft({ item, signal }) {
      if (signal && signal.aborted) throw new CancelledError('test interrupted');
      const material = { wooden_pickaxe: 'oak_planks', stone_pickaxe: 'cobblestone', iron_pickaxe: 'iron_ingot' }[item];
      assert.ok(material, `unexpected test recipe ${item}`);
      assert.ok((counts[material] || 0) >= 3);
      assert.ok((counts.stick || 0) >= 2);
      counts[material] -= 3;
      counts.stick -= 2;
      counts[item] = (counts[item] || 0) + 1;
      crafted.push(item);
      return { ok: true, produced: 1 };
    },
  };
  engine.bot = bot;
  engine.actions = actions;
  engine.nav = { stop() {}, goTo: async () => {} };
  engine.ensureChunks = async () => ({ ready: true });
  return { engine, actions, counts, crafted, cells, get digs() { return digs; } };
}

function customSkill(w, run) {
  return w.engine.queue.submit({ name: 'composite-test', kind: 'skill', priority: PRIORITY.SKILL,
    run: ({ signal, task }) => {
      task._skillCheckpoints = task._skillCheckpoints || new Map();
      const ctx = new SkillContext({ signal, checkpoints: task._skillCheckpoints });
      return run(ctx);
    } });
}

test('every ore counts its actual item only once, including existing stock', async () => {
  for (const [ore, spec] of Object.entries(mining.ORES)) {
    const w = world({ inventory: { [spec.item]: 5 }, blocks: Array(10).fill(spec.blocks[0]) });
    const result = await mining.mineOre({ actions: w.actions, nav: w.engine.nav,
      ctx: new SkillContext({ signal: null }), ore, want: 8, autoTool: false, allowSearch: false });
    assert.equal(result.ok, true, ore);
    assert.equal(w.digs, 8, ore);
    assert.equal(w.counts[spec.item], 13, ore);
    assert.equal(result.gained, 8, ore);
    assert.equal(result.produced[spec.item], 8, ore);
    assert.match(result.note, /8/);
  }
});

test('iron resumes the original eight-item goal after two critical preemptions', async () => {
  const w = world({ inventory: { stone_pickaxe: 1, raw_iron: 5, iron_ingot: 7 },
    blocks: Array(16).fill('iron_ore'), preemptAt: [2, 5] });
  const task = w.engine.submitSkill({ skill: 'mine_ores', params: { ore: 'iron', count: 8 } });
  const result = await task.promise;
  assert.equal(task.status, 'done');
  assert.equal(task.preemptCount, 2);
  assert.equal(w.digs, 8);
  assert.equal(w.counts.raw_iron, 13);
  assert.equal(w.counts.iron_ingot, 7);
  assert.equal(result.gained, 8);
  assert.deepEqual(result.produced, { raw_iron: 8 });
  assert.equal(w.engine.queue.stats.cancelled, 0);
});

test('coal combines correct counting and restoration', async () => {
  const w = world({ inventory: { stone_pickaxe: 1, coal: 4 },
    blocks: Array(16).fill('coal_ore'), preemptAt: [2, 5] });
  const task = w.engine.submitSkill({ skill: 'mine_ores', params: { ore: 'coal', count: 8 } });
  const result = await task.promise;
  assert.equal(task.preemptCount, 2);
  assert.equal(w.digs, 8);
  assert.equal(w.counts.coal, 12);
  assert.deepEqual(result.produced, { coal: 8 });
});

test('preemption after the final drop does not harvest another full batch', async () => {
  const w = world({ inventory: { stone_pickaxe: 1 },
    blocks: Array(16).fill('coal_ore'), preemptAt: [8] });
  const task = w.engine.submitSkill({ skill: 'mine_ores', params: { ore: 'coal', count: 8 } });
  const result = await task.promise;
  assert.equal(task.preemptCount, 1);
  assert.equal(w.digs, 8);
  assert.equal(result.gained, 8);
  assert.deepEqual(result.produced, { coal: 8 });
});

test('partial ore output is retained but cannot complete an eight-item goal', async () => {
  const w = world({ inventory: { stone_pickaxe: 1 }, blocks: Array(2).fill('coal_ore') });
  const task = customSkill(w, (ctx) => mining.mineOre({ actions: w.actions, nav: w.engine.nav,
    ctx, ore: 'coal', want: 8, allowSearch: false }));
  const result = await task.promise;
  assert.equal(task.status, 'failed');
  assert.equal(result.ok, false);
  assert.equal(result.gained, 2);
  assert.deepEqual(result.produced, { coal: 2 });
  assert.match(result.note, /只获得 2.*目标 8/);
});

test('tree harvesting resumes remaining logs and reports all eight', async () => {
  const w = world({ inventory: { oak_log: 3 }, blocks: Array(16).fill('oak_log'), preemptAt: [2, 5] });
  const task = w.engine.submitSkill({ skill: 'chop_tree', params: { count: 8 } });
  const result = await task.promise;
  assert.equal(task.preemptCount, 2);
  assert.equal(w.digs, 8);
  assert.equal(w.counts.oak_log, 11);
  assert.deepEqual(result.produced, { oak_log: 8 });
  assert.match(result.note, /8 根原木/);
});

test('mine_stone resumes an original cobblestone goal', async () => {
  const w = world({ inventory: { stone_pickaxe: 1, cobblestone: 4 },
    blocks: Array(16).fill('stone'), preemptAt: [2, 5] });
  const task = w.engine.submitSkill({ skill: 'mine_stone', params: { count: 8 } });
  const result = await task.promise;
  assert.equal(task.preemptCount, 2);
  assert.equal(w.digs, 8);
  assert.equal(w.counts.cobblestone, 12);
  assert.equal(result.gained, 8);
  assert.deepEqual(result.produced, { cobblestone: 8 });
});

test('mineSpecific deduplicates itemNames and resumes all requested items', async () => {
  const w = world({ inventory: { stone_pickaxe: 1, cobblestone: 2 },
    blocks: Array(16).fill('stone'), preemptAt: [2, 5] });
  const task = customSkill(w, (ctx) => wood.mineSpecific({ actions: w.actions, nav: w.engine.nav,
    ctx, blockNames: ['stone'], itemNames: ['cobblestone', 'cobblestone'], want: 8, allowSearch: false }));
  const result = await task.promise;
  assert.equal(task.preemptCount, 2);
  assert.equal(w.digs, 8);
  assert.equal(w.counts.cobblestone, 10);
  assert.equal(result.gained, 8);
  assert.deepEqual(result.produced, { cobblestone: 8 });
});

test('a new Task has a new baseline even for an identical collection request', async () => {
  const w = world({ inventory: { stone_pickaxe: 1, coal: 3 }, blocks: Array(24).fill('coal_ore') });
  for (let i = 0; i < 2; i += 1) {
    const result = await w.engine.submitSkill({ skill: 'mine_ores', params: { ore: 'coal', count: 8 } }).promise;
    assert.equal(result.gained, 8);
    assert.deepEqual(result.produced, { coal: 8 });
  }
  assert.equal(w.digs, 16);
  assert.equal(w.counts.coal, 19);
});

test('different quantities and identical repeated substeps do not share checkpoints', async () => {
  for (const quantities of [[2, 4], [2, 2]]) {
    const w = world({ inventory: { stone_pickaxe: 1 }, blocks: Array(16).fill('coal_ore'), preemptAt: [3] });
    const task = customSkill(w, async (ctx) => {
      const parts = [];
      for (const want of quantities) {
        parts.push(await mining.mineOre({ actions: w.actions, nav: w.engine.nav,
          ctx, ore: 'coal', want, allowSearch: false }));
      }
      return { ok: parts.every((r) => r.ok), parts };
    });
    const result = await task.promise;
    assert.equal(task.preemptCount, 1);
    assert.equal(w.digs, quantities[0] + quantities[1]);
    assert.deepEqual(result.parts.map((r) => r.gained), quantities);
    assert.deepEqual(result.parts.map((r) => r.produced.coal), quantities);
  }
});

test('dependency scopes separate equal target parameters when earlier stages are skipped', async () => {
  const w = world({ inventory: { stone_pickaxe: 1 }, blocks: Array(16).fill('coal_ore'), preemptAt: [3] });
  let firstDone = false;
  const task = customSkill(w, async (ctx) => {
    if (!firstDone) {
      await mining.mineOre({ actions: w.actions, nav: w.engine.nav,
        ctx: ctx.child('first-material'), ore: 'coal', want: 2, allowSearch: false });
      firstDone = true;
    }
    return mining.mineOre({ actions: w.actions, nav: w.engine.nav,
      ctx: ctx.child('second-material'), ore: 'coal', want: 2, allowSearch: false });
  });
  const result = await task.promise;
  assert.equal(w.digs, 4);
  assert.equal(result.gained, 2);
  assert.deepEqual(result.produced, { coal: 2 });
});

test('different resource targets inside a replay remain independent', async () => {
  const w = world({ inventory: { stone_pickaxe: 1 },
    blocks: [...Array(8).fill('coal_ore'), ...Array(8).fill('iron_ore')], preemptAt: [3] });
  const task = customSkill(w, async (ctx) => {
    const coal = await mining.mineOre({ actions: w.actions, nav: w.engine.nav, ctx, ore: 'coal', want: 2, allowSearch: false });
    const iron = await mining.mineOre({ actions: w.actions, nav: w.engine.nav, ctx, ore: 'iron', want: 4, allowSearch: false });
    return { ok: coal.ok && iron.ok, coal, iron };
  });
  const result = await task.promise;
  assert.equal(w.digs, 6);
  assert.equal(w.counts.coal, 2);
  assert.equal(w.counts.raw_iron, 4);
  assert.equal(result.coal.gained, 2);
  assert.equal(result.iron.gained, 4);
});

test('two-stage stone gathering accounts for partial cobblestone and resumes its fallback', async () => {
  const w = world({ inventory: { stone_pickaxe: 1 },
    blocks: [...Array(2).fill('stone'), ...Array(8).fill('andesite')], preemptAt: [4] });
  const task = w.engine.submitSkill({ skill: 'mine_stone', params: { count: 8, max_attempts: 8 } });
  const result = await task.promise;
  assert.equal(result.ok, true);
  assert.equal(w.digs, 8);
  assert.equal(w.counts.cobblestone, 2);
  assert.equal(w.counts.andesite, 6);
  assert.equal(result.gained, 8);
  assert.deepEqual(result.produced, { cobblestone: 2, andesite: 6 });
  assert.match(result.note, /圆石 2 个；其它石质方块 6 个/);
});

test('repeated identical composite skills keep their own child checkpoints', async () => {
  const w = world({ inventory: { stone_pickaxe: 1 }, blocks: Array(24).fill('stone'), preemptAt: [9] });
  const task = customSkill(w, async (ctx) => {
    const parts = [];
    for (let i = 0; i < 2; i += 1) {
      parts.push(await mining.mineStone({ actions: w.actions, nav: w.engine.nav, ctx, want: 8 }));
    }
    return { ok: parts.every((r) => r.ok), parts };
  });
  const result = await task.promise;
  assert.equal(task.preemptCount, 1);
  assert.equal(w.digs, 16);
  assert.equal(w.counts.cobblestone, 16);
  assert.deepEqual(result.parts.map((r) => r.gained), [8, 8]);
  assert.deepEqual(result.parts.map((r) => r.produced.cobblestone), [8, 8]);
});

test('no pickaxe automatically crafts the required tier before mining', async () => {
  for (const [ore, material, expected] of [['coal', 'oak_planks', 'wooden_pickaxe'], ['iron', 'cobblestone', 'stone_pickaxe']]) {
    const w = world({ inventory: { [material]: 3, stick: 2 },
      blocks: ['crafting_table', ...Array(4).fill(mining.ORES[ore].blocks[0])] });
    if (ore === 'iron') w.counts.wooden_pickaxe = 1;
    const result = await w.engine.submitSkill({ skill: 'mine_ores', params: { ore, count: 2 } }).promise;
    assert.equal(result.ok, true, ore);
    assert.deepEqual(w.crafted, [expected], ore);
    assert.equal(w.digs, 2, ore);
  }
});

test('insufficient replacement tier never claims it can harvest ancient debris', async () => {
  const w = world({ inventory: { stone_pickaxe: 1, iron_ingot: 3, stick: 2 },
    blocks: ['crafting_table', 'ancient_debris'] });
  const result = await w.engine.submitSkill({ skill: 'mine_ores', params: { ore: 'ancient_debris', count: 1 } }).promise;
  assert.equal(result.ok, false);
  assert.equal(w.digs, 0);
  assert.deepEqual(w.crafted, []);
  assert.equal(w.counts.iron_ingot, 3, 'an unusable replacement must not waste carried iron');
  assert.match(result.reason, /diamond/);
});

test('stone preparation cost survives a critical preemption without another pickaxe', async () => {
  const w = world({ inventory: { cobblestone: 3, stick: 2 },
    blocks: ['crafting_table', ...Array(8).fill('stone')], preemptAt: [3] });
  const task = w.engine.submitSkill({ skill: 'mine_stone', params: { count: 2, allow_search: false } });
  const result = await task.promise;
  assert.equal(result.ok, true); assert.equal(task.preemptCount, 1);
  assert.equal(w.digs, 5); assert.equal(w.counts.cobblestone, 5); assert.equal(result.gained, 2);
  assert.deepEqual(w.crafted, ['stone_pickaxe']);
});

test('a broken-pickaxe replacement and its net goal survive a later critical preemption', async () => {
  const w = world({ inventory: { stone_pickaxe: 1, cobblestone: 3, stick: 2 },
    blocks: ['crafting_table', ...Array(8).fill('stone')], preemptAt: [2] });
  const acceptedDig = w.actions.dig;
  w.actions.dig = async (params) => {
    const result = await acceptedDig(params);
    if (w.digs === 1) w.counts.stone_pickaxe = 0;
    return result;
  };
  const task = w.engine.submitSkill({ skill: 'mine_stone', params: { count: 2, allow_search: false } });
  const result = await task.promise;
  assert.equal(result.ok, true); assert.equal(task.preemptCount, 1);
  assert.equal(w.digs, 5); assert.equal(w.counts.cobblestone, 5); assert.equal(result.gained, 2);
  assert.deepEqual(w.crafted, ['stone_pickaxe']);
});

test('an aborted stale context cannot create or overwrite Task checkpoints', async () => {
  const controller = new AbortController();
  const checkpoints = new Map();
  const stale = new SkillContext({ signal: controller.signal, checkpoints });
  controller.abort();
  assert.throws(() => stale.collectionCheckpoint('late', {
    have: () => 4, want: 8, inventory: () => ({ coal: 4 }),
  }), CancelledError);
  assert.equal(checkpoints.size, 0);
});

// Reuse the deterministic Minecraft I/O fixture in the queue resume regression.
module.exports = { world };

if (require.main === module) (async () => {
  let failures = 0;
  for (const { name, run } of tests) {
    try {
      await run();
      process.stdout.write(`PASS ${name}\n`);
    } catch (err) {
      failures += 1;
      process.stderr.write(`FAIL ${name}\n${err.stack}\n`);
    }
  }
  process.stdout.write(`${tests.length - failures}/${tests.length} passed\n`);
  process.exitCode = failures ? 1 : 0;
})();
