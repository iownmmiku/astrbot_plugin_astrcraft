'use strict';

// Run the preparation scope, actual shelter inspection and dependency helpers.
// Only Minecraft block/inventory/recipe I/O is simulated.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Actions } = require('../engine/actions');
const { Config } = require('../engine/config');
const skills = require('../engine/skills');
const { executionContext } = require('../engine/goals');
const { withPreparation, assertPreparationSearch, isIndoorStation } = require('../engine/skills/preparation');
const { cookFood, collect, huntAnimal } = require('../engine/skills/gathering');
const { vec3, CancelledError } = require('../engine/util');
const { homeFixture } = require('./test_storage_memory');

const tests = [];
const test = (name, run) => tests.push({ name, run });
function fixture(initial = {}) {
  const f = homeFixture({ initial, chest: false });
  f.bot.entity.position = vec3(f.home.origin.x + 2.5, 1, 2.5);
  f.bot.health = 20; f.bot.time = { timeOfDay: 1000 }; f.bot.version = '1.20.1';
  f.bot.entities = {};
  f.bot.findBlock = ({ matching, useExtraInfo, maxDistance }) => [...f.cells.values()]
    .filter((block) => block.position.distanceTo(f.bot.entity.position) <= maxDistance && f.bot.blockAt(block.position) &&
      matching(block) && (typeof useExtraInfo !== 'function' || useExtraInfo(block)))
    .sort((a, b) => a.position.distanceTo(f.bot.entity.position) - b.position.distanceTo(f.bot.entity.position))[0] || null;
  f.bot.recipesAll = () => [];
  f.attackCalls = [];
  f.actions.attack = async (options) => { f.attackCalls.push(options); return { killed: true }; };
  f.cow = () => { f.bot.entities[2] = { id: 2, name: 'cow', position: vec3(42.5, 1, -3.5) }; };
  f.prepare = (run, overrides = {}) => withPreparation({ actions: f.actions, state: f.state,
    ctx: f.ctx, home: f.home, ...overrides }, run);
  f.food = (count = 1, overrides = {}) => f.prepare((ctx) => cookFood({ actions: f.actions,
    nav: f.nav, state: f.state, ctx, count }), overrides);
  f.breadCraft = () => {
    f.put('crafting_table', 41, 1, 1);
    f.actions.craft = async ({ item, count }) => {
      f.crafts.push(item); assert.equal(item, 'bread');
      const produced = Math.min(count, Math.floor((f.inventory.wheat || 0) / 3));
      f.inventory.wheat -= produced * 3; f.inventory.bread = (f.inventory.bread || 0) + produced;
      return { ok: produced > 0, produced };
    };
  };
  return f;
}

function packetFixture() {
  const f = fixture(), packets = [];
  // The shared fixture already installed guards before its I/O was exposed.
  // Install production guards again around an observable native write, rather
  // than replacing or stubbing the guard being verified.
  f.bot._client.write = (name, data) => packets.push({ name, data });
  delete f.bot._astrcraftControlGuard;
  f.actions = new Actions({ bot: f.bot, config: new Config(), navigator: f.nav });
  return { ...f, packets };
}

test('furniture comes from the real interior, excluding outside stations', async () => {
  const f = fixture();
  f.put('crafting_table', 39, 1, 2); f.put('smoker', 45, 1, 2);
  f.put('furnace', 41, 1, 1); f.put('blast_furnace', 43, 2, 3);
  const furniture = f.inspect().furniture;
  assert.equal(furniture.crafting_table, false); assert.equal(furniture.smoker, false);
  assert.equal(furniture.furnace, true); assert.equal(furniture.blast_furnace, true);
  assert.deepEqual(furniture.furnace_position, { x: 41, y: 1, z: 1 });
  assert.deepEqual(furniture.blast_furnace_position, { x: 43, y: 2, z: 3 });
});

test('actual lit properties report residual heat for each real indoor furnace kind', async () => {
  const f = fixture();
  for (const [name, x, z] of [['furnace', 41, 1], ['smoker', 43, 1], ['blast_furnace', 43, 3]]) {
    const position = f.put(name, x, 1, z);
    f.cells.get(`${position.x},${position.y},${position.z}`).getProperties = () => ({ lit: true });
  }
  const furniture = f.inspect().furniture;
  for (const name of ['furnace', 'smoker', 'blast_furnace']) {
    assert.equal(furniture[name], true); assert.equal(furniture[`${name}_lit`], true);
  }
});

test('missing, unknown, outside and historical furnace heat cannot authorize a warm station', async () => {
  const f = fixture(); f.home.furnished = { furnace: true, furnace_lit: true, smoker_lit: true, blast_furnace_lit: true };
  const outside = f.put('furnace', 39, 1, 2);
  f.cells.get(`${outside.x},${outside.y},${outside.z}`).getProperties = () => ({ lit: true });
  for (const name of ['furnace', 'smoker', 'blast_furnace']) assert.equal(f.inspect().furniture[`${name}_lit`], false);
  const inside = f.put('furnace', 41, 1, 1), key = `${inside.x},${inside.y},${inside.z}`;
  f.cells.get(key).getProperties = () => ({ lit: 'true' });
  assert.equal(f.inspect().furniture.furnace_lit, false);
  f.cells.get(key).getProperties = () => ({ lit: true });
  f.unloaded.add(key);
  assert.equal(f.inspect().furniture.furnace_lit, false);
  f.unloaded.delete(key); f.unloaded.add('42,3,2');
  assert.equal(f.inspect().condition, 'unknown');
  for (const name of ['furnace', 'smoker', 'blast_furnace']) assert.equal(f.inspect().furniture[`${name}_lit`], false);
});

test('interior coordinates exclude walls, roof and ground', async () => {
  const f = fixture();
  assert.equal(isIndoorStation({ x: 41, y: 1, z: 1 }, f.home), true);
  assert.equal(isIndoorStation({ x: 43, y: 2, z: 3 }, f.home), true);
  for (const p of [{ x: 40, y: 1, z: 1 }, { x: 44, y: 1, z: 2 }, { x: 41, y: 3, z: 1 },
    { x: 41, y: 0, z: 1 }, { x: 41, y: 1, z: 4 }, { x: NaN, y: 1, z: 1 }]) {
    assert.equal(isIndoorStation(p, f.home), false);
  }
});

test('an outside body cannot silently return home to start indoor preparation', async () => {
  const f = fixture(); f.bot.entity.position = vec3(42.5, 1, -1.5);
  let invoked = false;
  const result = await f.prepare(() => { invoked = true; return { ok: true }; });
  assert.equal(result.ok, false); assert.equal(invoked, false); assert.equal(f.moves.length, 0);
});

test('foreign world home cannot authorize indoor work', async () => {
  const f = fixture(); f.home.dimension = 'the_nether';
  const result = await f.prepare(() => { throw new Error('must not execute'); });
  assert.equal(result.ok, false); assert.equal(result.home_status.condition, 'other_world');
});

test('unknown roof cannot authorize indoor work', async () => {
  const f = fixture(); f.unloaded.add('42,3,2');
  const result = await f.prepare(() => { throw new Error('must not execute'); });
  assert.equal(result.ok, false); assert.equal(result.home_status.condition, 'unknown');
});

test('an open door cannot authorize indoor preparation', async () => {
  const f = fixture(); f.door(true);
  const result = await f.prepare(() => { throw new Error('must not execute'); });
  assert.equal(result.ok, false); assert.equal(result.home_status.door_closed, false);
});

test('ready food needs no outdoor dependency even with unknown server time', async () => {
  const f = fixture({ bread: 4 }); f.bot.time = null;
  const result = await f.food(4, { safeSearch: true });
  assert.equal(result.ok, true); assert.equal(f.crafts.length, 0); assert.equal(f.moves.length, 0);
});

test('real existing wheat and an inside table make bread without leaving shelter', async () => {
  const f = fixture({ wheat: 9 }); f.breadCraft(); f.bot.time.timeOfDay = 18000;
  const result = await f.food(3, { safeSearch: true });
  assert.equal(result.ok, true); assert.equal(f.inventory.bread, 3); assert.equal(f.inventory.wheat, 0);
  assert.deepEqual(result.produced, { bread: 3 }); assert.equal(f.moves.length, 0); assert.equal(f.inspect().safe, true);
});

test('existing raw food and fuel cook indoors through the real smelt helper', async () => {
  const f = fixture({ beef: 2, coal: 1 }); f.put('furnace', 41, 1, 1);
  f.actions.smelt = async ({ item, count }) => {
    assert.equal(item, 'beef'); assert.equal(count, 2);
    f.inventory.beef -= count; f.inventory.coal -= 1; f.inventory.cooked_beef = count;
    return { ok: true, output: 'cooked_beef', produced: count };
  };
  const result = await f.food(2);
  assert.equal(result.ok, true); assert.deepEqual(result.produced, { cooked_beef: 2 });
  assert.equal(f.moves.length, 0); assert.equal(f.inspect().safe, true);
});

test('missing wheat workstation cannot start a hidden tree search', async () => {
  const f = fixture({ wheat: 6 }); f.cow(); f.put('crafting_table', 39, 1, 2);
  const result = await f.food(2);
  assert.equal(result.ok, false); assert.equal(f.crafts.length, 0); assert.equal(f.attackCalls.length, 0);
  assert.equal(f.moves.length, 0); assert.match(result.reason, /不能|材料/);
});

test('server rejecting bread does not trigger an outside hunt', async () => {
  const f = fixture({ wheat: 6 }); f.put('crafting_table', 41, 1, 1); f.cow();
  const result = await f.food(2);
  assert.equal(result.ok, false); assert.deepEqual(f.crafts, ['bread']);
  assert.equal(f.inventory.wheat, 6); assert.equal(f.attackCalls.length, 0); assert.equal(f.moves.length, 0);
});

test('partial bread is honestly usable and never starts an outside dependency', async () => {
  const f = fixture({ wheat: 3 }); f.breadCraft(); f.cow();
  const result = await f.food(4);
  assert.equal(result.ok, true); assert.deepEqual(result.produced, { bread: 1 }); assert.equal(result.note, '现在有 1 份食物');
  assert.equal(f.inventory.bread, 1); assert.equal(f.attackCalls.length, 0);
});

test('collect of existing inventory never starts a gather dependency', async () => {
  const f = fixture({ coal: 3 });
  const result = await f.prepare((ctx) => collect({ actions: f.actions, nav: f.nav, state: f.state, ctx, item: 'coal', count: 3 }));
  assert.equal(result.ok, true); assert.equal(f.moves.length, 0);
});

test('collect of missing stone is blocked before digging or pathfinding', async () => {
  const f = fixture();
  const result = await f.prepare((ctx) => collect({ actions: f.actions, nav: f.nav, state: f.state, ctx, item: 'cobblestone', count: 3 }));
  assert.equal(result.ok, false); assert.equal(f.moves.length, 0);
});

test('direct hunt cannot attack an outdoor animal during indoor preparation', async () => {
  const f = fixture(); f.cow();
  const result = await f.prepare((ctx) => huntAnimal({ actions: f.actions, nav: f.nav, state: f.state, ctx, mob: 'cow' }));
  assert.equal(result.ok, false); assert.equal(f.attackCalls.length, 0); assert.equal(f.moves.length, 0);
});

test('the actual cook_food registration respects disabled search without a home', async () => {
  const f = fixture(); f.cow();
  const result = await skills.get('cook_food').run({ actions: f.actions, nav: f.nav,
    state: f.state, ctx: f.ctx, config: new Config(), params: { count: 2, allow_search: false } });
  assert.equal(result.ok, false); assert.equal(f.attackCalls.length, 0); assert.equal(f.moves.length, 0);
});

for (const [name, change] of [
  ['overworld night', (f) => { f.bot.time.timeOfDay = 18000; }],
  ['low health', (f) => { f.bot.health = 8; }],
  ['unknown health', (f) => { f.bot.health = null; }],
  ['unknown time', (f) => { f.bot.time = null; }],
]) test(`safe automatic dependency search refuses ${name}`, async () => {
  const f = fixture(); f.cow(); change(f);
  const result = await f.prepare((ctx) => huntAnimal({ actions: f.actions, nav: f.nav, state: f.state, ctx, mob: 'cow' }),
    { home: null, safeSearch: true });
  assert.equal(result.ok, false); assert.equal(f.attackCalls.length, 0); assert.equal(f.moves.length, 0);
});

test('ordinary explicitly requested work does not gain automatic night restrictions', async () => {
  const f = fixture(); f.bot.health = 5; f.bot.time.timeOfDay = 18000;
  const result = await f.prepare((ctx) => {
    assertPreparationSearch({ actions: f.actions, ctx, operation: '采集' }); return { ok: true };
  }, { home: null });
  assert.equal(result.ok, true);
});

test('disabled automatic search remains disabled in nested preparation scopes', async () => {
  const f = fixture();
  const result = await f.prepare((ctx) => withPreparation({ actions: f.actions, state: f.state, ctx, allowSearch: true },
    (child) => { assertPreparationSearch({ actions: f.actions, ctx: child }); return { ok: true }; }), { home: null, allowSearch: false });
  assert.equal(result.ok, false);
});

test('child contexts recheck actual shelter integrity before their next operation', async () => {
  const f = fixture(); let late = false;
  const result = await f.prepare(async (ctx) => {
    const child = ctx.child('dependency');
    f.put('air', 42, 3, 2); await Promise.resolve(); child.checkAborted(); late = true; return { ok: true };
  });
  assert.equal(result.ok, false); assert.equal(late, false); assert.equal(result.home_status.condition, 'missing');
});

test('completion detects displacement outside and preserves actual produced items', async () => {
  const f = fixture({ wheat: 3 }); f.breadCraft();
  const result = await f.prepare(async (ctx) => {
    await cookFood({ actions: f.actions, nav: f.nav, state: f.state, ctx, count: 1 });
    f.bot.entity.position = vec3(42.5, 1, -1.5); return { ok: true };
  });
  assert.equal(result.ok, false); assert.deepEqual(result.produced, { bread: 1 });
});

for (const [name, invalidate] of [
  ['parent cancellation', (f) => f.controller.abort()],
  ['respawn reusing the entity', (f) => f.bot.emit('respawn')],
  ['connection end', (f) => f.bot.emit('end')],
  ['dimension switch', (f) => { f.bot.game.dimension = 'the_nether'; }],
  ['server switch', (f) => { f.bot._client.socket.remoteAddress = 'other-server'; }],
  ['body replacement', (f) => { f.bot.entity = { position: vec3(42.5, 1, 2.5) }; }],
  ['client replacement', (f) => { f.bot._client = { ...f.bot._client }; }],
]) test(`preparation cannot act after ${name}`, async () => {
  const f = fixture(); let late = false;
  await assert.rejects(f.prepare(async (ctx) => {
    invalidate(f); await Promise.resolve(); ctx.child('late').checkAborted(); late = true; return { ok: true };
  }), (err) => err instanceof CancelledError);
  assert.equal(late, false); assert.equal(f.moves.length, 0); assert.equal(f.attackCalls.length, 0);
  assert.equal(f.bot.listenerCount('respawn'), 0);
});

test('client lifecycle invalidation rejects reused body before finish', async () => {
  const f = fixture(); f.bot._client = Object.assign(new EventEmitter(), f.bot._client);
  await assert.rejects(f.prepare(async () => { f.bot._client.emit('respawn'); await Promise.resolve(); return { ok: true }; }),
    (err) => err instanceof CancelledError);
  assert.equal(f.bot._client.listenerCount('respawn'), 0);
});

test('inherited queue context and indoor path restrictions survive dependency scope', async () => {
  const f = fixture(); const execution = { valid: true };
  await executionContext.run({ execution }, async () => {
    const result = await f.prepare((ctx) => {
      const scope = executionContext.getStore(); assert.equal(scope.execution, execution);
      assert.equal(scope.indoorHome, f.home); assert.equal(scope.allowTerrainDig, false);
      assert.equal(scope.allowTerrainPlace, false); assert.equal(scope.signal, ctx.signal);
      return { ok: true };
    }); assert.equal(result.ok, true);
  });
  assert.equal(executionContext.getStore(), undefined);
});

test('completed preparation revokes delayed continuations without cancelling its parent', async () => {
  const f = fixture(); let staleContext;
  const result = await f.prepare((ctx) => { staleContext = ctx.child('late'); return { ok: true }; });
  assert.equal(result.ok, true); assert.equal(f.controller.signal.aborted, false);
  assert.equal(staleContext.signal.aborted, true);
  assert.throws(() => staleContext.checkAborted(), (err) => err instanceof CancelledError);
});

test('a dependency cannot extend its shorter deadline using a parent scope', async () => {
  const f = fixture(); let late = false;
  await assert.rejects(f.prepare((ctx) => {
    const child = ctx.child('short'); child.deadline = Date.now() - 1;
    child.checkAborted(); late = true; return { ok: true };
  }), /预算/);
  assert.equal(late, false);
});

test('private interaction writes cannot escape a damaged indoor scope before any abort', async () => {
  const f = packetFixture();
  const result = await f.prepare(async (ctx) => {
    f.put('air', 42, 3, 2); await Promise.resolve();
    assert.equal(ctx.signal.aborted, false);
    for (const name of ['window_click', 'block_dig', 'block_place', 'use_item', 'use_entity', 'held_item_slot', 'arm_animation']) {
      f.bot._client.write(name, { obsolete: true });
    }
    f.bot._client.write('keep_alive', { keepAliveId: 7 });
    f.bot._client.write('close_window', { windowId: 1 });
    assert.equal(ctx.signal.aborted, false);
    return { ok: true };
  });
  assert.equal(result.ok, false);
  assert.deepEqual(f.packets.map(({ name }) => name), ['keep_alive', 'close_window']);
});

test('stale private writes stay blocked while a restored new preparation can write', async () => {
  const f = packetFixture(); let staleScope;
  const damaged = await f.prepare(async () => {
    staleScope = executionContext.getStore(); f.put('air', 42, 3, 2); await Promise.resolve();
    f.bot._client.write('window_click', { execution: 'damaged' }); return { ok: true };
  });
  assert.equal(damaged.ok, false); assert.equal(f.packets.length, 0);
  f.put('cobblestone', 42, 3, 2);
  const restored = await f.prepare(async () => {
    executionContext.run(staleScope, () => f.bot._client.write('window_click', { execution: 'stale' }));
    f.bot._client.write('window_click', { execution: 'restored' }); return { ok: true };
  });
  assert.equal(restored.ok, true);
  assert.deepEqual(f.packets, [{ name: 'window_click', data: { execution: 'restored' } }]);
  assert.equal(f.controller.signal.aborted, false);
});

(async () => {
  let passed = 0;
  for (const { name, run } of tests) {
    try { await run(); passed += 1; console.log(`PASS ${name}`); }
    catch (err) { console.error(`FAIL ${name}\n${err.stack}`); process.exitCode = 1; }
  }
  console.log(`Indoor preparation: ${passed}/${tests.length} passed`);
})().catch((err) => { console.error(err); process.exitCode = 1; });
