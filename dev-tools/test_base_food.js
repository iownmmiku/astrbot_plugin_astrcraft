'use strict';

// Production returnHome / entry / door / Actions.withdraw / leaveHome, replacing
// only server blocks, movement ticks and authoritative container I/O.
const assert = require('node:assert/strict');
const { homeFixture } = require('./test_storage_memory');
const { resupplyFood, ORDINARY_FOOD } = require('../engine/skills/supply');
const skills = require('../engine/skills');
const { Config } = require('../engine/config');
const { vec3, delay, CancelledError } = require('../engine/util');
const { executionContext } = require('../engine/goals');

const tests = [];
const test = (name, run) => tests.push({ name, run });
const key = (position) => `${position.x},${position.y},${position.z}`;

function fixture({ initial = {}, x = 40, chest = true, contents = { bread: 8 } } = {}) {
  const f = homeFixture({ initial, x, chest }), taken = [], inspected = [];
  if (chest) f.containers.get(`${x + 1},1,1`).items = { ...contents };
  const nativeOpen = f.bot.openContainer;
  f.bot.openContainer = async (block) => {
    assert.equal(f.inspect().safe, true, 'no container I/O before real entry and closing the door');
    assert(block.position.x > x && block.position.x < x + f.home.size - 1 && block.position.z > 0 && block.position.z < f.home.size - 1,
      'only a home interior container is authorized');
    if (f.onOpen) await f.onOpen(block);
    const win = await nativeOpen(block);
    const container = f.containers.get(key(block.position));
    const nativeContents = win.containerItems;
    win.containerItems = () => { inspected.push(key(block.position)); return nativeContents(); };
    win.withdraw = async (type, metadata, requested) => {
      assert.equal(f.inspect().safe, true);
      const name = win.containerItems().find((item) => item.type === type)?.name;
      assert(name, 'requested real item must be present in the opened window');
      taken.push({ name, requested, position: { ...block.position } });
      if (container.take) return container.take({ name, requested, inventory: f.inventory, container, bot: f.bot });
      const moved = Math.min(requested, container.items[name] || 0, container.takeLimit ?? Infinity);
      f.inventory[name] = (f.inventory[name] || 0) + moved;
      container.items[name] -= moved;
      if (moved < requested) throw new Error('simulated partial server transfer');
    };
    f.actions._guardWindow(win);
    return win;
  };
  return Object.assign(f, { taken, inspected,
    resupply: (options = {}) => resupplyFood({ actions: f.actions, nav: f.nav, state: f.state, ctx: f.ctx,
      config: new Config(), home: f.home, ...options }),
    leaveSkill: (params = {}) => skills.get('leave_home').run({ actions: f.actions, nav: f.nav, state: f.state,
      ctx: f.ctx, config: new Config(), params: { home: f.home, ...params } }),
  });
}

function enlarge(f) {
  const x = f.home.origin.x, size = 8;
  f.home.size = size;
  for (let dx = -1; dx <= size; dx++) for (let dz = -2; dz <= size; dz++) f.put('stone', x + dx, 0, dz);
  for (let dx = 0; dx < size; dx++) for (let dz = 0; dz < size; dz++) {
    f.put('cobblestone', x + dx, 3, dz);
    for (let y = 1; y <= 2; y++) f.put(dx === 0 || dx === size - 1 || dz === 0 || dz === size - 1 ? 'cobblestone' : 'air', x + dx, y, dz);
  }
  f.door(false);
  f.put('barrel', x + 6, 1, 6, { items: { bread: 8 } });
  return f;
}

test('catalog exposes required home, bounded count and a thin bounded leave_home wrapper', async () => {
  assert.equal(skills.get('resupply_food').params.home.required, true);
  assert.deepEqual(skills.get('resupply_food').params.count, { type: 'number', min: 1, max: 64, def: 4 });
  assert.equal(skills.get('leave_home').params.home.required, true);
  assert.deepEqual(skills.get('leave_home').params.timeout_seconds, { type: 'number', min: 1, max: 20, def: 20 });
  const f = fixture();
  const result = await skills.get('resupply_food').run({ actions: f.actions, nav: f.nav, state: f.state,
    ctx: f.ctx, config: new Config(), params: { home: f.home, count: 4 } });
  assert.equal(result.ok, true, result.reason); assert.deepEqual(result.produced, { bread: 4 });
  await assert.rejects(f.leaveSkill({ timeout_seconds: 21 }), /不能大于 20/);
  await assert.rejects(f.leaveSkill({ timeout_seconds: 0 }), /不能小于 1/);
});

test('closed remote home is entered physically, food is verified and the body remains behind a closed door', async () => {
  const f = fixture({ initial: { stone_pickaxe: 1, coal: 2 } });
  const result = await f.resupply();
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.produced, { bread: 4 }); assert.equal(result.food_ready, 4);
  assert.equal(result.reached_target, true); assert.equal(result.stayed_home, true);
  assert.equal(result.home_status.safe, true); assert.equal(f.inspect().door_closed, true);
  assert.deepEqual(f.stages, ['walk-outside', 'open-outside', 'close-inside']);
  assert.equal(f.inventory.stone_pickaxe, 1); assert.equal(f.inventory.coal, 2);
  assert.equal(f.containers.get('41,1,1').items.bread, 4);
  assert.equal(f.opens.length, 3, 'contents check plus native transfer and fresh confirmation snapshot');
  assert.equal(f.controls.forward, false); assert.deepEqual(f.crafts, []); assert.deepEqual(f.places, []);
});

test('withdraw requests only the total food deficit across different normal food kinds', async () => {
  const f = fixture({ initial: { carrot: 1 }, contents: { bread: 1, apple: 8, cooked_beef: 8 } });
  const result = await f.resupply();
  assert.equal(result.ok, true); assert.equal(result.food_ready, 4);
  assert.deepEqual(f.taken.map(({ name, requested }) => ({ name, requested })), [{ name: 'bread', requested: 1 }, { name: 'apple', requested: 2 }]);
  assert.deepEqual(result.produced, { bread: 1, apple: 2 });
  assert.equal(f.containers.get('41,1,1').items.cooked_beef, 8);
});

test('already-held normal supplies remain unchanged and still finish sheltered', async () => {
  const f = fixture({ initial: { bread: 4 }, contents: { bread: 8 } });
  const result = await f.resupply();
  assert.equal(result.ok, true); assert.equal(result.reached_target, true); assert.equal(result.stayed_home, true);
  assert.deepEqual(result.produced, {}); assert.deepEqual(f.opens, []); assert.deepEqual(f.taken, []);
  assert.equal(f.inventory.bread, 4); assert.equal(f.inspect().safe, true);
  assert.equal(result.food_stock_checked, false);
});

test('emergency apples and raw ingredients are never taken or counted toward ordinary food targets', async () => {
  const f = fixture({ initial: { golden_apple: 4 }, contents: { golden_apple: 8, enchanted_golden_apple: 3, beef: 8, wheat: 12, bread: 4 } });
  const result = await f.resupply();
  assert.equal(result.ok, true); assert.deepEqual(result.produced, { bread: 4 }); assert.equal(result.food_ready, 4);
  assert.equal(f.inventory.golden_apple, 4); assert.equal(f.inventory.enchanted_golden_apple, undefined);
  assert.deepEqual(f.taken.map((entry) => entry.name), ['bread']);
  assert.equal(ORDINARY_FOOD.includes('golden_apple'), false); assert.equal(ORDINARY_FOOD.includes('enchanted_golden_apple'), false);
  assert.equal(f.containers.get('41,1,1').items.beef, 8);
});

test('all truly checked empty-food containers provide a conservative negative stock proof', async () => {
  const f = fixture({ contents: { golden_apple: 3, wheat: 9 } });
  f.put('barrel', 41, 1, 2, { items: {} });
  const result = await f.resupply();
  assert.equal(result.ok, false); assert.deepEqual(result.produced, {}); assert.equal(result.food_ready, 0);
  assert.equal(result.reached_target, false); assert.equal(result.home_status.safe, true);
  assert.equal(result.food_stock_checked, true); assert.equal(result.food_stock_empty, true);
  assert.equal(f.opens.length, 2); assert.deepEqual(f.taken, []);
});

test('partial authoritative food gain succeeds honestly without claiming the target is reached', async () => {
  const f = fixture(); f.containers.get('41,1,1').takeLimit = 2;
  const result = await f.resupply();
  assert.equal(result.ok, true, result.reason); assert.equal(result.reached_target, false);
  assert.deepEqual(result.produced, { bread: 2 }); assert.equal(result.food_ready, 2);
  assert.match(result.reason, /部分/); assert.equal(result.food_stock_checked, false);
  assert.equal(f.inventory.bread, 2); assert.equal(f.containers.get('41,1,1').items.bread, 6);
});

test('an exhausted first food source continues with the next actual interior container', async () => {
  const f = fixture({ contents: { bread: 1 } });
  f.put('barrel', 41, 1, 2, { items: { apple: 8 } });
  const result = await f.resupply();
  assert.equal(result.ok, true, result.reason); assert.equal(result.reached_target, true);
  assert.deepEqual(result.produced, { bread: 1, apple: 3 }); assert.equal(result.food_ready, 4);
  assert.equal(f.containers.get('41,1,2').items.apple, 5);
});

test('only three actual interior containers are inspected and a fourth cannot prove an empty warehouse', async () => {
  const f = fixture({ contents: {} });
  f.put('barrel', 41, 1, 2); f.put('trapped_chest', 43, 1, 1); f.put('barrel', 43, 1, 2, { items: { bread: 8 } });
  const result = await f.resupply();
  assert.equal(result.ok, false); assert.deepEqual(result.produced, {});
  assert.equal(new Set(f.opens.map(key)).size, 3);
  assert.equal(result.food_stock_checked, false); assert.equal(result.food_stock_empty, false);
});

test('outside chests never substitute for an absent interior container', async () => {
  const f = fixture({ chest: false }); f.put('chest', 39, 1, 1, { items: { bread: 8 } });
  const result = await f.resupply();
  assert.equal(result.ok, false); assert.match(result.reason, /屋外/);
  assert.deepEqual(f.opens, []); assert.deepEqual(f.taken, []); assert.deepEqual(result.produced, {});
  assert.equal(f.inspect().safe, true); assert.equal(result.food_stock_checked, false);
});

test('large home seeks a safe actual floor landing near its interior supply barrel', async () => {
  const f = enlarge(fixture({ chest: false }));
  const result = await f.resupply();
  assert.equal(result.ok, true, result.reason); assert.deepEqual(result.produced, { bread: 4 });
  assert.equal(f.moves.length, 2, 'entry and separate interior approach both physically change position');
  assert.equal(f.moves[1].y, f.home.origin.y);
  assert.equal(f.bot.blockAt(f.bot.entity.position.floored()).name, 'air', 'cannot pretend to stand inside a barrel');
  assert.equal(f.inspect().safe, true);
  assert(f.opens.every((position) => key(position) === '46,1,6'));
});

test('claimed interior navigation without body movement cannot open a distant barrel', async () => {
  const f = enlarge(fixture({ chest: false })), move = f.nav.goTo;
  f.nav.goTo = async (target) => target.x > 44 ? { arrived: true } : move(target);
  const result = await f.resupply();
  assert.equal(result.ok, false); assert.match(result.reason, /尚未实际走近/);
  assert.deepEqual(f.opens, []); assert.equal(result.food_stock_checked, false);
});

test('seeking an interior container receives only the travel time left after entry', async () => {
  const f = enlarge(fixture({ chest: false })), close = f.actions.closeDoor, move = f.nav.goTo, realNow = Date.now;
  let now = realNow(); Date.now = () => now;
  f.actions.closeDoor = async (options) => { const result = await close(options); now += 15000; return result; };
  f.nav.goTo = async (target) => {
    if (target.x > 44) { assert(target.timeoutMs > 0 && target.timeoutMs <= 5000); const result = await move(target); now += 6000; return result; }
    return move(target);
  };
  try {
    const result = await f.resupply();
    assert.equal(result.ok, false); assert.match(result.reason, /预算/);
    assert.deepEqual(f.opens, []); assert.equal(result.food_stock_checked, false);
  } finally { Date.now = realNow; }
});

test('foreign server and dimension are rejected before travel or food interaction', async () => {
  for (const field of ['server', 'dimension']) {
    const f = fixture(); f.home[field] = 'other';
    const result = await f.resupply();
    assert.equal(result.ok, false); assert.equal(result.home_status.condition, 'other_world');
    assert.deepEqual(f.moves, []); assert.deepEqual(f.opens, []); assert.deepEqual(result.produced, {});
  }
});

test('distant and historically damaged unloaded homes do not start travel', async () => {
  for (const options of [{ x: 140 }, {}]) {
    const f = fixture(options);
    if (!options.x) f.home.condition = 'missing';
    const result = await f.resupply();
    assert.equal(result.ok, false); assert.match(result.reason, options.x ? /128/ : /受损/);
    assert.deepEqual(f.moves, []); assert.deepEqual(f.opens, []);
  }
});

test('known damaged loaded home cannot claim sheltered supply', async () => {
  const f = fixture({ x: 8 }); f.put('air', 10, 3, 2);
  const result = await f.resupply();
  assert.equal(result.ok, false); assert.equal(result.home_status.condition, 'missing');
  assert.deepEqual(f.moves, []); assert.deepEqual(f.opens, []);
});

test('unloaded roof after arrival stops before opening any food container', async () => {
  const f = fixture(); f.unloaded.add('42,3,2');
  const result = await f.resupply();
  assert.equal(result.ok, false); assert.equal(result.home_status.condition, 'unknown');
  assert.deepEqual(f.opens, []); assert.equal(result.food_stock_checked, false);
});

test('an unreadable interior cell cannot support a negative warehouse cache', async () => {
  const f = fixture({ contents: {} }); f.unloaded.add('43,2,3');
  const result = await f.resupply();
  assert.equal(result.ok, false); assert.deepEqual(f.taken, []);
  assert.equal(result.home_status.condition, 'intact'); assert.equal(result.food_stock_checked, false);
  assert.equal(result.food_stock_empty, false);
});

test('an actual container read rejection cannot be mistaken for an empty stock scan', async () => {
  const f = fixture({ contents: {} }); f.onOpen = () => { throw new Error('server refused container'); };
  const result = await f.resupply();
  assert.equal(result.ok, false); assert.match(result.reason, /server refused/);
  assert.equal(result.food_stock_checked, false); assert.equal(result.food_stock_empty, false);
  assert.deepEqual(result.produced, {});
});

test('no-effect container transfer never fabricates food or successful resupply', async () => {
  const f = fixture(); f.containers.get('41,1,1').take = async () => {};
  const result = await f.resupply();
  assert.equal(result.ok, false); assert.deepEqual(result.produced, {});
  assert.equal(result.food_ready, 0); assert.match(result.reason, /没有确认|未确认/);
  assert.equal(result.food_stock_checked, false);
});

test('one-sided inventory gain cannot become a verified base food transfer', async () => {
  const f = fixture(); f.containers.get('41,1,1').take = async ({ name, requested, inventory }) => {
    inventory[name] = (inventory[name] || 0) + requested;
  };
  const result = await f.resupply();
  assert.equal(result.ok, false); assert.deepEqual(result.produced, {});
  assert.equal(result.food_ready, 4, 'observed inventory is described separately from verified transfer');
  assert.equal(f.containers.get('41,1,1').items.bread, 8);
});

test('optimistic food slots rolled back on fresh opening are not accepted as supply', async () => {
  const f = fixture();
  f.onOpen = () => {
    if (f.opens.length === 2) { f.inventory.bread = 0; f.containers.get('41,1,1').items.bread = 8; }
  };
  const result = await f.resupply();
  assert.equal(result.ok, false); assert.deepEqual(result.produced, {}); assert.equal(result.food_ready, 0);
  assert.equal(f.opens.length, 3);
});

test('an exaggerated taken count is clipped by the final actual inventory difference', async () => {
  const f = fixture(); f.containers.get('41,1,1').takeLimit = 1;
  const withdraw = f.actions.withdraw;
  f.actions.withdraw = async (params) => { const result = await withdraw(params); return { ...result, taken: { bread: 999 } }; };
  const result = await f.resupply();
  assert.equal(result.ok, true); assert.deepEqual(result.produced, { bread: 1 }); assert.equal(result.reached_target, false);
});

test('structure damage after actual withdrawal preserves food and blocks all later container actions', async () => {
  const f = fixture({ contents: { bread: 1, apple: 8 } }), withdraw = f.actions.withdraw;
  f.actions.withdraw = async (params) => { const result = await withdraw(params); f.put('air', 42, 3, 2); return result; };
  const result = await f.resupply();
  assert.equal(result.ok, false); assert.deepEqual(result.produced, { bread: 1 });
  assert.equal(result.home_status.condition, 'missing'); assert.match(result.reason, /不再安全/);
  assert.deepEqual(f.taken.map((entry) => entry.name), ['bread']); assert.equal(f.inventory.bread, 1);
  assert.equal(result.food_stock_checked, false);
});

test('parent budget expiring after verified withdrawal keeps produced food without a second transfer', async () => {
  const f = fixture({ contents: { bread: 1, apple: 8 } }), withdraw = f.actions.withdraw;
  f.actions.withdraw = async (params) => { const result = await withdraw(params); f.ctx.deadline = Date.now() - 1; return result; };
  const result = await f.resupply();
  assert.equal(result.ok, false); assert.deepEqual(result.produced, { bread: 1 }); assert.match(result.reason, /预算|超时/);
  assert.deepEqual(f.taken.map((entry) => entry.name), ['bread']);
});

test('entry plus seeking uses one twenty-second travel budget, not a new full budget per phase', async () => {
  const f = fixture(), nativeMove = f.nav.goTo, realNow = Date.now;
  let now = realNow(); Date.now = () => now;
  f.nav.goTo = async (target) => { assert(target.timeoutMs <= 20000); const result = await nativeMove(target); now += 21000; return result; };
  try {
    const result = await f.resupply();
    assert.equal(result.ok, false); assert.match(result.reason, /预算|超时/); assert.deepEqual(f.opens, []);
  } finally { Date.now = realNow; }
});

test('cancelled physical entry stops forward movement and never opens a food container', async () => {
  const f = fixture(), controls = f.bot.setControlState;
  f.bot.setControlState = (name, value) => { controls(name, value);
    if (name === 'forward' && value) setTimeout(() => f.controller.abort(), 5); };
  await assert.rejects(f.resupply(), CancelledError);
  assert.equal(f.controls.forward, false); assert.deepEqual(f.opens, []);
  assert.equal(f.stages.includes('close-inside'), false);
  assert.equal(f.bot.listenerCount('respawn'), 0); assert.equal(f.bot.listenerCount('end'), 0);
});

test('respawn and end during physical entry invalidate the full supply chain and remove listeners', async () => {
  for (const event of ['respawn', 'end']) {
    const f = fixture(), controls = f.bot.setControlState;
    f.bot.setControlState = (name, value) => { controls(name, value);
      if (name === 'forward' && value) setTimeout(() => f.bot.emit(event), 5); };
    await assert.rejects(f.resupply(), CancelledError);
    assert.equal(f.controls.forward, false); assert.deepEqual(f.opens, []);
    assert.equal(f.bot.listenerCount('respawn'), 0); assert.equal(f.bot.listenerCount('end'), 0);
  }
});

test('server and dimension changes without an event stop the next owned action', async () => {
  for (const change of [(f) => { f.bot.game.dimension = 'the_nether'; },
    (f) => { f.bot._client.socket.remoteAddress = 'new-server'; }]) {
    const f = fixture(), nativeMove = f.nav.goTo;
    f.nav.goTo = async (target) => { const result = await nativeMove(target); change(f); return result; };
    await assert.rejects(f.resupply(), CancelledError); assert.deepEqual(f.opens, []);
    assert.equal(f.stages.includes('open-outside'), false);
  }
});

test('world transition during verified food transfer cannot start a second container action', async () => {
  const f = fixture({ contents: { bread: 1, apple: 8 } }), withdraw = f.actions.withdraw;
  f.actions.withdraw = async (params) => { const result = await withdraw(params); f.bot.emit('respawn'); return result; };
  await assert.rejects(f.resupply(), CancelledError);
  assert.deepEqual(f.taken.map((entry) => entry.name), ['bread']);
  assert.equal(f.bot.listenerCount('respawn'), 0);
});

test('later leave_home traverses the same real doorway and closes both halves after sheltering', async () => {
  const f = fixture(); assert.equal((await f.resupply()).ok, true);
  const result = await f.leaveSkill();
  assert.equal(result.ok, true, result.reason); assert.equal(result.left_home, true);
  assert.equal(f.inspect().inside, false); assert.equal(f.inspect().door_closed, true);
  assert.deepEqual(f.stages, ['walk-outside', 'open-outside', 'close-inside', 'walk-inside', 'open-inside', 'close-outside']);
  assert.equal(f.inventory.bread, 4); assert.equal(f.controls.forward, false);
});

test('leave_home refuses an unsheltered body and obeys physical crossing cancellation', async () => {
  const outside = fixture(); assert.equal((await outside.leaveSkill()).ok, false);
  const f = fixture(); assert.equal((await f.resupply()).ok, true);
  const controls = f.bot.setControlState;
  f.bot.setControlState = (name, value) => { controls(name, value);
    if (name === 'forward' && value) setTimeout(() => f.controller.abort(), 5); };
  await assert.rejects(f.leaveSkill(), CancelledError);
  assert.equal(f.controls.forward, false); assert.equal(f.stages.includes('close-outside'), false);
});

(async () => {
  let failures = 0;
  for (const { name, run } of tests) {
    try { await run(); process.stdout.write(`PASS ${name}\n`); }
    catch (error) { failures += 1; process.stderr.write(`FAIL ${name}\n${error.stack}\n`); }
  }
  assert.equal(executionContext.getStore(), undefined);
  process.stdout.write(`${tests.length - failures}/${tests.length} base food scenarios passed\n`);
  process.exitCode = failures ? 1 : 0;
})();
