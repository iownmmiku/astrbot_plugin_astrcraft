'use strict';
const assert = require('node:assert/strict');
const { homeFixture } = require('./test_storage_memory');
const { exploreNearby } = require('../engine/skills/exploration');
const { executionContext } = require('../engine/goals');
const { vec3, distance } = require('../engine/util');
const tests = [], test = (name, run) => tests.push({ name, run });
function fixture() {
  const f = homeFixture({ x: 0 });
  f.bot.entity.position = vec3(2.5, 1, -2.5);
  f.bot.health = 20; f.bot.food = 20; f.bot.time = { timeOfDay: 1000 };
  for (let x = -24; x <= 24; x++) for (let z = -24; z <= 24; z++) f.put('stone', x, 0, z);
  const run = (overrides = {}) => exploreNearby({ actions: f.actions, nav: f.nav, state: f.state, ctx: f.ctx, home: f.home, ...overrides });
  return { ...f, run };
}
test('reaches safe loaded land without editing terrain and chooses a different point next time', async () => {
  const f = fixture(), original = f.nav.goTo;
  f.nav.goTo = async (target) => {
    assert.equal(executionContext.getStore().allowTerrainDig, false);
    assert.equal(executionContext.getStore().allowTerrainPlace, false);
    assert.equal(target.segmented, false); assert(target.timeoutMs <= 15000);
    return original(target);
  };
  const first = await f.run(), second = await f.run();
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  assert.notDeepEqual(first.position, second.position);
  assert(distance(second.position, { x: 2.5, y: 1, z: 2.5 }) <= 24);
});
test('world mismatch and unknown base never authorize movement', async () => {
  const f = fixture();
  assert.equal((await f.run({ home: { ...f.home, server: 'other:25565' } })).ok, false);
  f.unloaded.add('0,1,0');
  assert.equal((await f.run()).ok, false);
  assert.equal(f.moves.length, 0);
});
test('pathfinding success without actual arrival cannot count as exploration', async () => {
  const f = fixture(); f.nav.goTo = async () => ({ arrived: true });
  assert.equal((await f.run()).ok, false);
});
test('new body during path cancels and does not claim progress', async () => {
  const f = fixture();
  f.nav.goTo = async () => { f.bot.entity = { position: vec3(3, 1, -4) }; return {}; };
  await assert.rejects(f.run(), (err) => err.name === 'CancelledError');
});
test('over-radius detour aborts the native movement signal', async () => {
  const f = fixture();
  f.nav.goTo = async (target) => {
    f.bot.entity.position = vec3(100, 1, 0); target.onTick();
    assert.equal(target.signal.aborted, true);
  };
  await assert.rejects(f.run(), (err) => err.name === 'CancelledError');
});
test('nightfall and starvation interrupt voluntary exploration', async () => {
  for (const cause of ['food', 'night']) {
    const f = fixture();
    f.nav.goTo = async (target) => {
      if (cause === 'food') f.bot.food = 4; else f.bot.time.timeOfDay = 14000;
      f.bot.emit('physicsTick'); assert.equal(target.signal.aborted, true);
    };
    await assert.rejects(f.run(), (err) => err.name === 'CancelledError');
    assert.equal(f.bot.listenerCount('physicsTick'), 0);
  }
});
test('unknown state, dusk, dawn and water/fire never authorize exploration', async () => {
  const changes = [
    ...[undefined, NaN, -1, 24000, 12541, 12999, 23001, 23458].map((time) => (bot) => { bot.time = { timeOfDay: time }; }),
    ...['health', 'food'].flatMap((name) => [undefined, NaN].map((value) => (bot) => { bot[name] = value; })),
    ...['isInWater', 'isInLava', 'isOnFire'].map((name) => (bot) => { bot.entity[name] = true; }),
  ];
  for (const change of changes) {
    const f = fixture(); change(f.bot);
    await assert.rejects(f.run(), (err) => err.name === 'CancelledError');
    assert.equal(f.moves.length, 0); assert.equal(f.bot.listenerCount('physicsTick'), 0);
  }
});
test('last daylight and first dawn ticks remain usable', async () => {
  for (const time of [12540, 23459]) {
    const f = fixture(); f.bot.time.timeOfDay = time;
    assert.equal((await f.run()).ok, true);
  }
});
test('new unknown state or water/fire interrupts an active navigation signal', async () => {
  for (const change of [(bot) => { bot.food = NaN; }, (bot) => { bot.time.timeOfDay = 12541; },
    ...['isInWater', 'isInLava', 'isOnFire'].map((name) => (bot) => { bot.entity[name] = true; })]) {
    const f = fixture();
    f.nav.goTo = async (target) => { change(f.bot); f.bot.emit('physicsTick'); assert.equal(target.signal.aborted, true); };
    await assert.rejects(f.run(), (err) => err.name === 'CancelledError');
    assert.equal(f.bot.listenerCount('physicsTick'), 0);
  }
});
test('pre-cancelled requests do not issue a navigation command', async () => {
  const f = fixture(); f.controller.abort();
  await assert.rejects(f.run(), (err) => err.name === 'CancelledError');
  assert.equal(f.moves.length, 0);
});
(async () => {
  let failed = 0;
  for (const { name, run } of tests) try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}\n${error.stack}`); }
  console.log(`${tests.length - failed}/${tests.length} passed`); process.exitCode = failed ? 1 : 0;
})();
