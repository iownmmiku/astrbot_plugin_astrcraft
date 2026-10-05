#!/usr/bin/env node
'use strict';
process.env.MC_ENGINE_LOG_LEVEL = 'error';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { McEngine } = require('../engine/bot');
const { SkillContext } = require('../engine/skills/common');
const common = require('../engine/skills/common');
const mining = require('../engine/skills/mining');
const helper = require('../engine/skills/mining_return');
const registry = require('../engine/skills');
const { executionContext } = require('../engine/goals');
const { vec3, CancelledError, delay } = require('../engine/util');

const tests = [], test = (name, run) => tests.push({ name, run });
const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
function world({ inventory = {}, blocks = ['coal_ore'], startY = 1, afterDig = null,
  goTo = null, checkpoints = new Map(), controller = new AbortController() } = {}) {
  const counts = { wooden_pickaxe: 1, ...inventory }, cells = new Map(), calls = [];
  const block = (name, position) => ({ name, position, diggable: name !== 'bedrock',
    boundingBox: ['air', 'cave_air', 'water', 'lava'].includes(name) ? 'empty' : 'block' });
  blocks.forEach((name, n) => { const p = vec3(2 + n, 1, 0); cells.set(key(p), block(name, p)); });
  const client = new EventEmitter();
  Object.assign(client, { state: 'play', socket: { remoteAddress: '127.0.0.1', remotePort: 25565 } });
  const bot = new EventEmitter();
  Object.assign(bot, { username: 'return-test', version: '1.20.4', _client: client,
    entity: { position: vec3(0.5, startY, 0.5), onGround: true, velocity: vec3(0, 0, 0) },
    health: 20, food: 20, game: { dimension: 'minecraft:overworld' }, entities: {},
    inventory: { items: () => Object.entries(counts).filter(([, n]) => n > 0)
      .map(([name, count]) => ({ name, count, maxDurability: 9999 })) },
    blockAt: (p) => cells.get(key(p)) || block(p.y <= 0 ? 'bedrock' : 'air', p),
    findBlock: ({ matching }) => [...cells.values()].find(matching) || null,
    findBlocks: ({ matching, count = 16 }) => [...cells.values()].filter(matching).slice(0, count).map((b) => b.position),
    canSeeBlock: () => true, clearControlStates() {}, stopDigging() {}, deactivateItem() {},
    pathfinder: { stop() {}, setGoal() {} },
  });
  const actions = { bot, inventoryMap: () => ({ ...counts }), countItem: (name) => counts[name] || 0,
    stopCurrent() {}, equipBestToolFor: async () => {},
    async dig(params) {
      if (params.signal?.aborted) throw new CancelledError('dig cancelled');
      helper.assertProtectedHomeDig(bot, params);
      const b = cells.get(key(params)); assert.ok(b);
      cells.delete(key(params));
      const spec = Object.values(mining.ORES).find((s) => s.blocks.includes(b.name));
      const item = spec?.item || (b.name === 'stone' ? 'cobblestone' : b.name);
      counts[item] = (counts[item] || 0) + 1; calls.push({ kind: 'dig', ...params });
      await afterDig?.({ bot, counts, calls, controller, params });
      return { block: b.name, collected: { [item]: 1 } };
    },
  };
  const ctx = new SkillContext({ signal: controller.signal, checkpoints, deadline: Date.now() + 5000 });
  const nav = { stop() {}, async goTo(params) {
    calls.push({ kind: 'goTo', ...params, scope: executionContext.getStore() });
    if (goTo) return goTo({ params, bot, counts, calls, controller });
    bot.entity.position = vec3(params.x, params.y, params.z);
    return { arrived: true };
  } };
  const state = { nearbyEntities: () => [] };
  return { bot, actions, nav, ctx, state, counts, calls, cells, block, checkpoints, controller,
    mine: (options = {}) => mining.mineOre({ actions, nav, state, ctx, ore: 'coal', want: 1,
      autoTool: false, allowSearch: false, ...options }),
    stone: (options = {}) => mining.mineStone({ actions, nav, state, ctx, want: 1,
      allowSearch: false, ...options }) };
}
async function withClimb(run, climb = async () => ({ ok: false, steps: 0, reason: 'fixture climb blocked' })) {
  const original = common.climbToSurface; common.climbToSurface = climb;
  try { return await run(); } finally { common.climbToSurface = original; }
}

test('actual ore collected but failed return is a failed skill with retained drops', async () => {
  const f = world({ afterDig: ({ bot }) => { bot.entity.position = vec3(0.5, -3, 0.5); },
    goTo: async () => ({ arrived: true }) });
  const r = await withClimb(() => f.mine());
  assert.equal(r.ok, false); assert.equal(r.collection_ok, true);
  assert.deepEqual(r.produced, { coal: 1 }); assert.equal(r.return_status.ok, false);
  assert.equal(r.return_status.required, true); assert.deepEqual(r.return_status.target, { x: 0.5, y: 1, z: 0.5 });
  assert.equal(r.return_status.server, '127.0.0.1:25565'); assert.equal(r.return_status.dimension, 'overworld');
  assert.equal(f.checkpoints.get(helper.RETURN_STATUS_KEY), r.return_status);
});

test('zero ore collected still attempts rescue and does not fake collection success', async () => {
  const f = world({ blocks: [], startY: -3 }); let climbs = 0;
  const r = await withClimb(() => f.mine(), async () => {
    climbs += 1; f.bot.entity.position = vec3(0.5, 1, 0.5); return { ok: true, steps: 4 };
  });
  assert.equal(climbs, 1); assert.equal(r.ok, false); assert.equal(r.collection_ok, false);
  assert.equal(r.return_status.ok, true); assert.deepEqual(r.produced, {});
});

test('zero stone collected also attempts rescue', async () => {
  const f = world({ blocks: [], startY: -3 }); let climbs = 0;
  const r = await withClimb(() => f.stone(), async () => {
    climbs += 1; f.bot.entity.position = vec3(0.5, 1, 0.5); return { ok: true, steps: 4 };
  });
  assert.equal(climbs, 1); assert.equal(r.collection_ok, false); assert.equal(r.return_status.ok, true);
});

test('original route is preferred and accepted only at the actual safe entry', async () => {
  const f = world({ afterDig: ({ bot }) => { bot.entity.position = vec3(0.5, -3, 0.5); } });
  const r = await withClimb(() => f.mine(), async () => { throw new Error('must not climb'); });
  assert.equal(r.ok, true); assert.equal(r.return_status.ok, true);
  const walk = f.calls.find((c) => c.kind === 'goTo'); assert.ok(walk);
  assert.equal(walk.scope.allowTerrainDig, false); assert.equal(walk.scope.allowTerrainPlace, false);
  assert.equal(walk.segmented, false); assert.ok(walk.timeoutMs <= 8000);
  assert.deepEqual(r.return_status.position, r.return_status.target);
});

test('a fake resolved route and fake successful climb cannot prove arrival', async () => {
  const f = world({ afterDig: ({ bot }) => { bot.entity.position = vec3(0.5, -3, 0.5); },
    goTo: async () => ({ arrived: true, final_position: { x: 0.5, y: 1, z: 0.5 } }) });
  const r = await withClimb(() => f.mine(), async () => ({ ok: true, steps: 10 }));
  assert.equal(r.ok, false); assert.equal(r.return_status.position.y, -3);
});

for (const hazard of ['lava', 'water', 'magma_block', 'cactus', 'powder_snow', 'gravel']) {
  test(`a landing on ${hazard} cannot pass return validation`, async () => {
    const f = world({ afterDig: ({ bot }) => { bot.entity.position = vec3(0.5, -3, 0.5); },
      goTo: async () => ({ arrived: true }) });
    const r = await withClimb(() => f.mine(), async () => {
      f.bot.entity.position = vec3(0.5, 1, 0.5);
      const p = vec3(0, 0, 0); f.cells.set(key(p), f.block(hazard, p));
      return { ok: true, steps: 4 };
    });
    assert.equal(r.return_status.ok, false); assert.equal(r.collection_ok, true);
  });
}

test('unloaded landing and surface columns cannot be mistaken for safe sky', async () => {
  const f = world({ afterDig: ({ bot }) => { bot.entity.position = vec3(0.5, -3, 0.5); },
    goTo: async () => ({ arrived: true }) });
  const r = await withClimb(() => f.mine(), async () => {
    f.bot.entity.position = vec3(0.5, 1, 0.5); f.bot.blockAt = () => null;
    return { ok: true, steps: 4 };
  });
  assert.equal(r.return_status.ok, false);
  assert.deepEqual(helper.inspectReturnSafety(f.bot),
    { safe: false, loaded: false, on_ground: true, underground: null });
});

test('loaded ground with unknown surrounding surface remains unverified', async () => {
  const f = world(); const original = f.bot.blockAt;
  f.bot.blockAt = (p) => Math.abs(p.x) > 3 || Math.abs(p.z) > 3 ? null : original(p);
  assert.equal(helper.inspectReturnSafety(f.bot).safe, false);
  assert.equal(helper.inspectReturnSafety(f.bot).loaded, false);
});

function edgeLanding() {
  const f = world({ blocks: [], startY: 2 });
  f.bot.entity.position = vec3(-0.05, 2, -0.05);
  const support = vec3(0, 1, 0); f.cells.set(key(support), f.block('furnace', support));
  return f;
}
test('a physically grounded block-edge landing uses the full player footprint', () => {
  const f = edgeLanding();
  assert.equal(f.bot.blockAt(vec3(-1, 1, -1)).name, 'air');
  assert.equal(helper.inspectReturnSafety(f.bot).safe, true);
});
test('an edge support without actual ground contact cannot prove a safe landing', () => {
  const f = edgeLanding(); f.bot.entity.onGround = false;
  assert.equal(helper.inspectReturnSafety(f.bot).safe, false);
});
test('a fluid under another corner of the footprint remains unsafe', () => {
  const f = edgeLanding(), p = vec3(-1, 1, 0); f.cells.set(key(p), f.block('lava', p));
  assert.equal(helper.inspectReturnSafety(f.bot).safe, false);
});
test('an unknown footprint corner remains unverified despite a known support', () => {
  const f = edgeLanding(), read = f.bot.blockAt;
  f.bot.blockAt = (p) => key(p) === '-1,1,-1' ? null : read(p);
  assert.equal(helper.inspectReturnSafety(f.bot).safe, false);
  assert.equal(helper.inspectReturnSafety(f.bot).loaded, false);
});

test('cached safe terrain is never live return evidence after connection ends', async () => {
  for (const reason of ['state', 'socket']) {
    const f = world(); assert.equal(helper.inspectReturnSafety(f.bot).safe, true);
    if (reason === 'state') f.bot._client.state = 'disconnected';
    else f.bot._client.socket.destroyed = true;
    assert.deepEqual(helper.inspectReturnSafety(f.bot),
      { safe: false, loaded: false, on_ground: true, underground: null });
  }
});

test('preemption replays keep the original entrance and do not mine another batch', async () => {
  const shared = new Map(); let stopped = false;
  const f = world({ checkpoints: shared, afterDig: ({ bot, controller }) => {
    bot.entity.position = vec3(0.5, -3, 0.5);
    if (!stopped) { stopped = true; controller.abort(); }
  } });
  await assert.rejects(f.mine(), CancelledError);
  const fresh = new SkillContext({ signal: new AbortController().signal, checkpoints: shared });
  const r = await mining.mineOre({ actions: f.actions, nav: f.nav, state: f.state, ctx: fresh,
    ore: 'coal', want: 1, autoTool: false, allowSearch: false });
  assert.equal(r.ok, true); assert.deepEqual(r.return_status.target, { x: 0.5, y: 1, z: 0.5 });
  assert.equal(f.calls.filter((c) => c.kind === 'dig').length, 1); assert.deepEqual(r.produced, { coal: 1 });
});

test('an initially underground checkpoint never overwrites its null entrance on replay', async () => {
  const f = world({ blocks: [], startY: -3 }); const checkpoint = {};
  assert.equal(helper.captureReturnTarget(checkpoint, f.actions), null);
  f.bot.entity.position = vec3(0.5, 1, 0.5);
  assert.equal(helper.captureReturnTarget(checkpoint, f.actions), null);
});

test('strict stone mode ignores variants and preserves the original material goal', async () => {
  const f = world({ blocks: ['andesite'], inventory: { andesite: 8 } });
  const r = await f.stone({ strictOnly: true });
  assert.equal(r.collection_ok, false); assert.equal(r.return_status.ok, true);
  assert.equal(f.calls.filter((c) => c.kind === 'dig').length, 0); assert.deepEqual(r.produced, {});
});

test('partial accepted stone and timeout retain actual output and return obligation', async () => {
  const f = world({ blocks: ['stone', 'stone'], afterDig: ({ bot }) => {
    bot.entity.position = vec3(0.5, -3, 0.5); f.ctx.deadline = Date.now() - 1;
  } });
  const r = await f.stone({ strictOnly: true, want: 2 });
  assert.equal(r.ok, false); assert.equal(r.collection_ok, false); assert.equal(r.return_status.ok, false);
  assert.deepEqual(r.produced, { cobblestone: 1 }); assert.match(r.return_status.reason, /超时|预算/);
});

test('a pickaxe exhausted in an exploration staircase retains drops and the original return obligation', async () => {
  const f = world({ blocks: [], startY: 33, inventory: { iron_pickaxe: 1 },
    goTo: async ({ params, bot }) => {
      if (params.y < 33) bot.entity.position = vec3(params.x, params.y, params.z);
      return { arrived: true };
    } });
  f.bot.blockAt = (p) => f.cells.get(key(p)) || f.block(p.y < 33 ? 'stone' : 'air', p);
  const dig = f.actions.dig; let attempts = 0;
  f.actions.dig = async (params) => {
    if (++attempts > 1) throw new (require('../engine/actions').NoToolError)('last pickaxe broke in the staircase');
    f.cells.set(key(params), f.bot.blockAt(vec3(params.x, params.y, params.z)));
    const result = await dig(params);
    // This fixture models the authoritative post-dig cell update as well as
    // the inventory drop. Do not leave the removed terrain in its default map.
    f.cells.set(key(params), f.block('air', vec3(params.x, params.y, params.z)));
    return result;
  };
  const r = await withClimb(() => f.mine({ ore: 'iron', want: 1, allowSearch: true }));
  assert.equal(attempts, 2);
  assert.equal(r.ok, false); assert.equal(r.collection_ok, false);
  assert.deepEqual(r.produced, { cobblestone: 1 });
  const checkpoint = [...f.checkpoints.values()].find((saved) => saved?.collectionResult);
  assert.match(checkpoint.collectionResult.reason, /last pickaxe broke/);
  assert.match(r.reason, /返程/); assert.match(f.checkpoints.get(helper.RETURN_STATUS_KEY).reason, /返程|返回|fixture/);
  assert.equal(r.return_status.required, true); assert.equal(r.return_status.ok, false);
  assert.deepEqual(r.return_status.target, { x: 0.5, y: 33, z: 0.5 });
  assert.equal(f.checkpoints.get(helper.RETURN_STATUS_KEY), r.return_status);
  assert.equal(f.calls.filter((c) => c.kind === 'dig').length, 1);
});

test('a golden pickaxe is reported below stone without being treated as a stone-grade tool', () => {
  const f = world({ inventory: { wooden_pickaxe: 0, golden_pickaxe: 1 } });
  assert.equal(mining.bestPickaxeTier(f.actions), 'golden');
  f.counts.stone_pickaxe = 1;
  assert.equal(mining.bestPickaxeTier(f.actions), 'stone');
});

test('climb_out rescue uses a remembered target and publishes a verified clear', async () => {
  const f = world({ blocks: [], startY: -3 });
  f.checkpoints.set(helper.RETURN_STATUS_KEY, { required: true, ok: false,
    target: { x: 0.5, y: 1, z: 0.5 }, reason: 'old pending' });
  const r = await registry.get('climb_out').run({ ...f,
    params: { return_target: { x: 0.5, y: 1, z: 0.5 }, max_steps: 4 } });
  assert.equal(r.ok, true); assert.equal(r.return_status.ok, true);
  assert.equal(f.checkpoints.get(helper.RETURN_STATUS_KEY).ok, true);
});

test('default climb_out still accepts a body already on safe ground', async () => {
  const f = world({ blocks: [] });
  const r = await registry.get('climb_out').run({ ...f, params: {} });
  assert.equal(r.ok, true); assert.equal(r.climbed, 0); assert.equal(r.return_status.required, false);
});

for (const event of ['death', 'respawn', 'login', 'end']) {
  test(`a ${event} body transition cancels instead of returning a false success`, async () => {
    const f = world({ afterDig: ({ bot }) => bot.emit(event) });
    await assert.rejects(f.mine(), CancelledError);
    assert.equal(f.counts.coal, 1); assert.equal(f.bot.listenerCount(event), 0);
    assert.equal(f.checkpoints.has(helper.RETURN_STATUS_KEY), false);
  });
}

for (const mutation of ['body', 'client', 'dimension', 'server']) {
  test(`changed ${mutation} during collection cannot regain the body for rescue`, async () => {
    const f = world({ afterDig: ({ bot }) => {
      if (mutation === 'body') bot.entity = { ...bot.entity };
      if (mutation === 'client') bot._client = { ...bot._client };
      if (mutation === 'dimension') bot.game.dimension = 'the_nether';
      if (mutation === 'server') bot._client.socket.remotePort = 25566;
    } });
    await assert.rejects(f.mine(), CancelledError);
    assert.equal(f.calls.filter((c) => c.kind === 'goTo').length, 0);
  });
}

test('parent abort while returning stops the child navigation and all later rescue actions', async () => {
  const f = world({ afterDig: ({ bot }) => { bot.entity.position = vec3(0.5, -3, 0.5); },
    goTo: async ({ params, controller }) => { controller.abort(); await delay(1, { signal: params.signal }); } });
  let climbs = 0;
  await withClimb(async () => assert.rejects(f.mine(), CancelledError), async () => { climbs += 1; });
  assert.equal(climbs, 0);
});

test('a later failed dependency cannot forget the previous mine entrance', async () => {
  const f = world({ blocks: [], startY: -3 });
  const previous = { required: true, ok: false, target: { x: 0.5, y: 1, z: 0.5 }, reason: 'pending' };
  f.checkpoints.set(helper.RETURN_STATUS_KEY, previous);
  await withClimb(() => f.mine());
  assert.deepEqual(f.checkpoints.get(helper.RETURN_STATUS_KEY).target, previous.target);
});

test('McEngine rejects a parent composite that discards the failed child return fields', async () => {
  const f = world({ afterDig: ({ bot }) => { bot.entity.position = vec3(0.5, -3, 0.5); },
    goTo: async () => ({ arrived: true }) });
  const engine = new McEngine({ emit: () => {} });
  engine.bot = f.bot; engine.actions = f.actions; engine.nav = f.nav;
  engine.ensureChunks = async () => ({ ready: true });
  const definition = registry.get('craft'), original = definition.run;
  definition.run = async ({ ctx }) => {
    const child = await mining.mineOre({ ...f, ctx, ore: 'coal', want: 1, autoTool: false, allowSearch: false });
    return { ok: true, produced: child.produced, note: 'parent dropped return fields' };
  };
  try {
    const task = engine.submitSkill({ skill: 'craft', params: {} });
    const r = await withClimb(() => task.promise);
    assert.equal(task.status, 'failed'); assert.equal(r.ok, false);
    assert.equal(r.return_status.ok, false); assert.deepEqual(r.produced, { coal: 1 });
  } finally { definition.run = original; }
});

const protectedHome = { server: '127.0.0.1:25565', dimension: 'overworld',
  origin: { x: 10, y: 1, z: 10 }, size: 5, wall_height: 3 };
test('same-world protection covers foundation, walls, interior furniture and roof only within its bounds', async () => {
  const f = world();
  await helper.withProtectedHome({ ...f, params: { protected_home: protectedHome } }, async (ctx) => {
    for (const p of [{ x: 10, y: 0, z: 10 }, { x: 14.9, y: 1, z: 14.9 },
      { x: 12, y: 2, z: 12 }, { x: 10, y: 4, z: 14 }]) {
      assert.equal(helper.isProtectedHomePosition(f.bot, p), true);
      assert.throws(() => helper.assertProtectedHomeDig(f.bot, p), { name: 'ProtectedHomeError' });
    }
    for (const p of [{ x: 9, y: 1, z: 10 }, { x: 15, y: 1, z: 10 },
      { x: 10, y: -1, z: 10 }, { x: 10, y: 5, z: 10 }, { x: 10, y: 1, z: 15 }]) {
      assert.equal(helper.isProtectedHomePosition(f.bot, p), false);
      helper.assertProtectedHomeDig(f.bot, p);
    }
    assert.equal(executionContext.getStore().allowTerrainDig, false);
    const child = ctx.child('material'); child.checkAborted();
    assert.equal(helper.isProtectedHomePosition(f.bot, { x: 12, y: 1, z: 12 }), true);
  });
  assert.equal(helper.isProtectedHomePosition(f.bot, { x: 12, y: 1, z: 12 }), false);
});

test('invalid or unknown explicit homes stop gathering before any body action', async () => {
  const f = world();
  for (const home of [false, 0, {}, { ...protectedHome, server: null },
    { ...protectedHome, dimension: '' }, { ...protectedHome, origin: { x: Infinity, y: 1, z: 10 } },
    { ...protectedHome, origin: { x: 10.5, y: 1, z: 10 } },
    { ...protectedHome, size: 3 }, { ...protectedHome, size: 9 },
    { ...protectedHome, wall_height: 1 }, { ...protectedHome, wall_height: 5 }]) {
    let entered = false;
    await assert.rejects(helper.withProtectedHome({ ...f, params: { protected_home: home } },
      async () => { entered = true; }), { name: 'ProtectedHomeError' });
    assert.equal(entered, false);
  }
  assert.deepEqual(f.calls, []);
});

test('an explicit home on another server or dimension cannot authorize this collection', async () => {
  const f = world();
  for (const home of [{ ...protectedHome, server: '127.0.0.1:25566' },
    { ...protectedHome, dimension: 'the_nether' }]) {
    await assert.rejects(helper.withProtectedHome({ ...f, params: { protected_home: home } },
      async () => assert.fail('other-world home entered')), { name: 'ProtectedHomeError' });
  }
  await executionContext.run({ protectedHome: { ...protectedHome, dimension: 'the_nether' } }, async () => {
    assert.equal(helper.isProtectedHomePosition(f.bot, { x: 10, y: 1, z: 10 }), false);
  });
});

test('dependencies inherit a frozen home even when their original plan object is edited', async () => {
  const f = world(); const home = { ...protectedHome, origin: { ...protectedHome.origin } };
  await helper.withProtectedHome({ ...f, params: { protected_home: home } }, async (ctx) => {
    home.origin.x = 100; home.size = 8;
    await helper.withProtectedHome({ ...f, ctx: ctx.child('tools'), params: {} }, async () => {
      assert.equal(helper.isProtectedHomePosition(f.bot, { x: 10, y: 1, z: 10 }), true);
      assert.equal(helper.isProtectedHomePosition(f.bot, { x: 100, y: 1, z: 10 }), false);
    });
  });
});

test('a changed world cancels the protected job and never borrows the old structure coordinates', async () => {
  const f = world();
  await assert.rejects(helper.withProtectedHome({ ...f, params: { protected_home: protectedHome } }, async (ctx) => {
    f.bot.game.dimension = 'the_nether';
    assert.equal(helper.isProtectedHomePosition(f.bot, { x: 10, y: 1, z: 10 }), false);
    ctx.checkAborted();
  }), CancelledError);
});

test('ordinary requests without a protected home retain their original terrain scope', async () => {
  const f = world();
  await helper.withProtectedHome({ ...f, params: {} }, async (ctx) => {
    assert.equal(ctx, f.ctx); assert.equal(executionContext.getStore()?.protectedHome, undefined);
    assert.equal(executionContext.getStore()?.allowTerrainDig, undefined);
  });
  assert.equal(registry.get('build_shelter').params.protected_home, undefined);
  assert.equal(registry.get('blueprint').params.protected_home, undefined);
  for (const skill of ['chop_tree', 'mine_stone', 'mine_ores', 'collect', 'hunt', 'make_tools',
    'cook_food', 'food_chain', 'smelt', 'craft', 'climb_out']) {
    assert.equal(registry.get(skill).params.protected_home.def, null, skill);
  }
});

test('strict stone mining keeps its result while avoiding protected wall and foundation blocks', async () => {
  const f = world({ blocks: ['cobblestone', 'cobblestone', 'stone'] });
  const home = { ...protectedHome, origin: { x: 2, y: 1, z: 0 }, size: 4, wall_height: 2 };
  // The genuine quarry is beyond the protected home; two nearer wall blocks
  // remain eligible by block name, so the spatial filter must reject them.
  const natural = f.cells.get('4,1,0'); f.cells.delete('4,1,0');
  natural.position = vec3(7, 1, 0); f.cells.set('7,1,0', natural);
  const r = await registry.get('mine_stone').run({ ...f,
    params: { count: 1, max_attempts: 1, protected_home: home } });
  assert.equal(r.ok, true); assert.equal(r.collection_ok, true);
  assert.deepEqual(r.produced, { cobblestone: 1 });
  assert.equal(f.cells.get('2,1,0').name, 'cobblestone');
  assert.equal(f.cells.get('3,1,0').name, 'cobblestone');
  assert.deepEqual(f.calls.filter((c) => c.kind === 'dig').map((c) => c.x), [7]);
});

(async () => {
  let failures = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (err) { failures += 1; console.error(`FAIL ${name}\n${err.stack}`); }
  }
  console.log(`${tests.length - failures}/${tests.length} passed`);
  process.exitCode = failures ? 1 : 0;
})();
