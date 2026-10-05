'use strict';

// Production compound skill, cooking and tool dependencies; simulated Minecraft
// recipe acceptance changes real fixture inventory rather than skill results.
const assert = require('node:assert/strict');
const skills = require('../engine/skills');
const { SkillContext } = require('../engine/skills/common');
const { vec3, CancelledError } = require('../engine/util');

const tests = [];
const test = (name, run) => tests.push({ name, run });
function fixture(inventory = {}, { craftHook = null } = {}) {
  const counts = { ...inventory }, calls = [], controller = new AbortController();
  const table = { name: 'crafting_table', position: vec3(1, 1, 0), boundingBox: 'block' };
  const bot = {
    entity: { position: vec3(0.5, 1, 0.5), onGround: true }, entities: {}, health: 20, food: 20,
    inventory: { items: () => Object.entries(counts).filter(([, n]) => n > 0).map(([name, count]) => ({ name, count })) },
    findBlock: ({ matching }) => matching(table) ? table : null,
    findBlocks: () => [],
    blockAt: (p) => ({ name: p.y < 1 ? 'stone' : 'air', boundingBox: p.y < 1 ? 'block' : 'empty', position: p }),
  };
  const recipes = {
    bread: { wheat: 3 }, stick: { oak_planks: 2 },
    wooden_pickaxe: { oak_planks: 3, stick: 2 }, stone_pickaxe: { cobblestone: 3, stick: 2 },
    torch: { coal: 1, stick: 1 },
  };
  const actions = {
    bot, inventoryMap: () => ({ ...counts }), countItem: (name) => counts[name] || 0,
    async craft(params) {
      calls.push({ item: params.item, count: params.count });
      if (params.signal?.aborted) throw new CancelledError('fixture cancelled');
      if (craftHook) {
        const intercepted = await craftHook(params, counts, controller);
        if (intercepted !== undefined) return intercepted;
      }
      const recipe = recipes[params.item]; assert.ok(recipe, `unexpected recipe ${params.item}`);
      const output = ['stick', 'torch'].includes(params.item) ? 4 : 1;
      const times = Math.min(Math.ceil((params.count || 1) / output), ...Object.entries(recipe)
        .map(([name, n]) => Math.floor((counts[name] || 0) / n)));
      for (const [name, n] of Object.entries(recipe)) counts[name] = (counts[name] || 0) - n * times;
      counts[params.item] = (counts[params.item] || 0) + output * times;
      return { ok: times > 0, produced: output * times };
    },
  };
  const ctx = new SkillContext({ signal: controller.signal, deadline: Date.now() + 5000 });
  return { counts, calls, actions, controller, ctx,
    run: () => skills.get('food_chain').run({ actions, ctx, params: {},
      nav: { goTo: async () => {} }, state: { nearbyEntities: () => [] } }) };
}

test('no food cannot report ready or consume fuel making unrelated gear', async () => {
  const f = fixture({ stone_pickaxe: 1, coal: 2, stick: 2 });
  const r = await f.run();
  assert.equal(r.ok, false); assert(r.missing.includes('food'));
  assert.equal(r.food_ready, 0); assert.deepEqual(r.produced, {});
  assert.deepEqual(f.calls, []); assert.equal(f.counts.coal, 2);
});
test('three existing portions are not enough for the four portion departure target', async () => {
  const f = fixture({ bread: 3, stone_pickaxe: 1, torch: 4 });
  const r = await f.run();
  assert.equal(r.ok, false); assert.equal(r.food_ready, 3); assert(r.missing.includes('food'));
});
test('all supplies already present succeed without manufacturing or fabricated output', async () => {
  const f = fixture({ bread: 4, iron_pickaxe: 1, torch: 4 });
  const r = await f.run();
  assert.equal(r.ok, true); assert.deepEqual(r.produced, {}); assert.deepEqual(f.calls, []);
  assert.deepEqual(r.missing, []); assert.equal(r.pickaxe_tier, 'iron');
});
test('partial cooking preserves actual bread and stops before making a pick', async () => {
  const f = fixture({ wheat: 6, oak_planks: 3, stick: 2, torch: 4 });
  const r = await f.run();
  assert.equal(r.ok, false); assert.equal(r.food_ready, 2);
  assert.deepEqual(r.produced, { bread: 2 }); assert.deepEqual(r.consumed, { wheat: 6 });
  assert.deepEqual(f.calls.map((c) => c.item), ['bread']);
});
test('existing cobblestone makes just a stone pick without wasting a wooden pick', async () => {
  const f = fixture({ bread: 4, cobblestone: 3, stick: 2, torch: 4 });
  const r = await f.run();
  assert.equal(r.ok, true, r.reason); assert.equal(r.pickaxe_tier, 'stone');
  assert.deepEqual(f.calls.map((c) => c.item), ['stone_pickaxe']);
  assert.deepEqual(r.produced, { stone_pickaxe: 1 });
  assert.deepEqual(r.consumed, { cobblestone: 3, stick: 2 });
});
test('early gear creates only the required wooden pick and actual food', async () => {
  const f = fixture({ wheat: 12, oak_planks: 3, stick: 2, torch: 4 });
  const r = await f.run();
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(f.calls.map((c) => c.item), ['bread', 'wooden_pickaxe']);
  assert.deepEqual(r.produced, { bread: 4, wooden_pickaxe: 1 });
  assert.deepEqual(r.consumed, { wheat: 12, oak_planks: 3, stick: 2 });
});
test('a rejected pick craft cannot report departure readiness or move to torches', async () => {
  const f = fixture({ bread: 4, oak_planks: 3, stick: 2, coal: 2 }, {
    craftHook: ({ item }) => item === 'wooden_pickaxe' ? { ok: true, produced: 1 } : undefined,
  });
  const r = await f.run();
  assert.equal(r.ok, false); assert(r.missing.includes('pickaxe'));
  assert.deepEqual(r.produced, {}); assert.deepEqual(f.calls.map((c) => c.item), ['wooden_pickaxe']);
});
test('one coal makes four actual torches without claiming eight or accepting a claimed count', async () => {
  const f = fixture({ bread: 4, stone_pickaxe: 1, coal: 1, stick: 1 }, {
    craftHook: ({ item }, counts) => {
      if (item !== 'torch') return;
      counts.coal -= 1; counts.stick -= 1; counts.torch = 4;
      return { ok: true, produced: 999 };
    },
  });
  const r = await f.run();
  assert.equal(r.ok, true); assert.deepEqual(r.produced, { torch: 4 });
  assert.equal(r.torch_count, 4); assert.equal(f.calls[0].count, 4);
});
test('no fuel leaves a precise incomplete result rather than saying supplies complete', async () => {
  const f = fixture({ bread: 4, stone_pickaxe: 1 });
  const r = await f.run();
  assert.equal(r.ok, false); assert.deepEqual(r.missing, ['torch']);
  assert.match(r.reason, /燃料/); assert.deepEqual(f.calls, []);
});
test('missing sticks use available planks and report the final inventory difference', async () => {
  const f = fixture({ bread: 4, stone_pickaxe: 1, coal: 1, oak_planks: 2 });
  const r = await f.run();
  assert.equal(r.ok, true, r.reason); assert.deepEqual(f.calls.map((c) => c.item), ['stick', 'torch']);
  assert.deepEqual(r.produced, { stick: 3, torch: 4 });
  assert.deepEqual(r.consumed, { oak_planks: 2, coal: 1 });
});
test('a silent no-effect torch craft remains incomplete', async () => {
  const f = fixture({ bread: 4, stone_pickaxe: 1, coal: 1, stick: 1 }, {
    craftHook: () => ({ ok: true, produced: 4 }),
  });
  const r = await f.run();
  assert.equal(r.ok, false); assert.deepEqual(r.produced, {}); assert.equal(r.torch_count, 0);
});
test('ordinary torch rejection reports failure and retains supplies', async () => {
  const f = fixture({ bread: 4, stone_pickaxe: 1, coal: 1, stick: 1 }, {
    craftHook: () => { throw new Error('server rejected recipe'); },
  });
  const r = await f.run();
  assert.equal(r.ok, false); assert.match(r.reason, /server rejected recipe/);
  assert.deepEqual(r.produced, {});
});
test('cancellation during torch crafting propagates instead of becoming successful completion', async () => {
  const f = fixture({ bread: 4, stone_pickaxe: 1, coal: 1, stick: 1 }, {
    craftHook: (_params, _counts, controller) => { controller.abort(); throw new CancelledError('cancel during torches'); },
  });
  await assert.rejects(f.run(), CancelledError);
});
test('abort accepted together with a late craft reply stops the compound skill', async () => {
  const f = fixture({ bread: 4, stone_pickaxe: 1, coal: 1, stick: 1 }, {
    craftHook: (_params, counts, controller) => { counts.torch = 4; controller.abort(); return { ok: true, produced: 4 }; },
  });
  await assert.rejects(f.run(), CancelledError);
});
test('an expired parent budget is not swallowed in optional crafting', async () => {
  let f;
  f = fixture({ bread: 4, stone_pickaxe: 1, coal: 1, stick: 1 }, {
    craftHook: () => { f.ctx.deadline = Date.now() - 1; throw new Error('late reply'); },
  });
  await assert.rejects(f.run(), /超时/);
});

(async () => {
  let failed = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failed += 1; console.error(`FAIL ${name}: ${error.stack || error}`); }
  }
  console.log(`结果：${tests.length - failed} 通过，${failed} 失败`);
  process.exitCode = failed ? 1 : 0;
})();
