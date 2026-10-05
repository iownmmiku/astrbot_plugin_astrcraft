#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StationMemory } = require('../engine/stations');
const { Actions } = require('../engine/actions');
const { Config } = require('../engine/config');
const { inspectHome } = require('../engine/skills/building');
const skills = require('../engine/skills');
const { vec3, CancelledError, delay } = require('../engine/util');
const { executionContext } = require('../engine/goals');

const tests = [];
const test = (name, run) => tests.push({ name, run });
function fixture() {
  const world = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  const put = (x, y, z, name, half = null, open = false) => world.set(key(x, y, z), {
    name, position: vec3(x, y, z), boundingBox: 'block', getProperties: () => half ? { half, open } : {},
    shapes: half ? [open ? [0, 0, 0, 0.1875, 1, 1] : [0, 0, 0, 1, 1, 0.1875]] : [[0, 0, 0, 1, 1, 1]],
  });
  for (let x = -6; x <= 10; x += 1) for (let z = -6; z <= 10; z += 1) put(x, 0, z, 'stone');
  for (let x = 0; x < 5; x += 1) for (let z = 0; z < 5; z += 1) {
    put(x, 0, z, 'stone'); put(x, 3, z, 'cobblestone');
    if (x === 0 || z === 0 || x === 4 || z === 4) for (let y = 1; y <= 2; y += 1) put(x, y, z, 'cobblestone');
  }
  const door = (open, name = 'oak_door') => { put(2, 1, 0, name, 'lower', open); put(2, 2, 0, name, 'upper', open); };
  door(false);
  put(2, 1, 2, 'white_bed'); put(1, 1, 1, 'chest');
  const home = { server: 'test:25565', dimension: 'overworld', origin: { x: 0, y: 1, z: 0 },
    size: 5, inner: 3, wall_height: 2, door_position: { x: 2, y: 1, z: 0 }, complete: true, has_roof: true };
  const bot = new EventEmitter();
  let loaded = true;
  let lookTarget = null, walkingTimer = null;
  const controls = {};
  Object.assign(bot, { entity: { position: vec3(50, 1, 0), onGround: true }, game: { dimension: 'overworld' },
    time: { timeOfDay: 13000 }, inventory: { items: () => [] }, heldItem: null,
    _client: { socket: { remoteAddress: 'test', remotePort: 25565 }, write() {} },
    findBlock: ({ matching }) => [...world.values()].find(matching) || null,
    blockAt: (p) => !loaded ? null : world.get(key(p.x, p.y, p.z)) || { name: 'air', boundingBox: 'empty', position: p },
    lookAt: async (p) => { lookTarget = p; },
    setControlState: (name, value) => {
      controls[name] = value;
      if (name !== 'forward' || !value || walkingTimer) return;
      walkingTimer = setInterval(() => {
        const pair = [0, 1].map((dy) => bot.blockAt(vec3(home.door_position.x, home.door_position.y + dy, home.door_position.z)));
        if (!controls.forward || !lookTarget || !pair.every((b) => b?.getProperties?.().open === true)) return;
        const p = bot.entity.position, dx = lookTarget.x - p.x, dz = lookTarget.z - p.z, length = Math.hypot(dx, dz);
        if (length > 0) bot.entity.position = p.offset(dx / length * Math.min(0.2, length), 0, dz / length * Math.min(0.2, length));
      }, 10);
    },
    clearControlStates: () => { Object.keys(controls).forEach((k) => { controls[k] = false; }); clearInterval(walkingTimer); walkingTimer = null; },
    stopDigging() {}, deactivateItem() {},
    pathfinder: { setGoal() {}, stop() {} },
    activateBlock: async () => door(!bot.blockAt(vec3(2, 1, 0)).getProperties().open),
    sleep: async () => { bot.isSleeping = true; setTimeout(() => { bot.isSleeping = false; bot.time.timeOfDay = 0; }, 10); },
  });
  const config = new Config();
  const movements = { getBlock: (position, dx, dy, dz) => {
    const b = bot.blockAt(position.offset(dx, dy, dz));
    return { ...b, safe: b?.boundingBox === 'empty', physical: b?.boundingBox === 'block' };
  } };
  const nav = { stop() {}, movements, goTo: async (target) => {
    loaded = true;
    const inside = (p) => p.x >= 1 && p.x < 4 && p.z >= 1 && p.z < 4;
    if (!inside(bot.entity.position) && inside(target)) {
      assert.equal(movements.getBlock(vec3(2, 1, 0), 0, 0, 0).safe, true, 'closed lower door blocks real entry');
      assert.equal(movements.getBlock(vec3(2, 1, 0), 0, 1, 0).safe, true, 'closed upper door blocks real entry');
    }
    bot.entity.position = vec3(target.x, target.y, target.z);
  } };
  const actions = new Actions({ bot, config, navigator: nav });
  actions.stations = new StationMemory();
  const state = { nearbyEntities: () => [] };
  const ctx = new skills.SkillContext({ signal: new AbortController().signal });
  const inspect = () => inspectHome({ actions, state, config, home });
  const run = (params = {}) => skills.get('return_home').run({ actions, nav, state, config, ctx, params: { home, ...params } });
  return { world, bot, home, actions, config, nav, ctx, state, inspect, run,
    put, door, controls, remove: (x, y, z) => world.delete(key(x, y, z)), unload: () => { loaded = false; }, load: () => { loaded = true; } };
}

test('owning an intact home does not mean current position is sheltered', async () => {
  const f = fixture();
  const status = f.inspect();
  assert.equal(status.condition, 'intact');
  assert.equal(status.safe, false);
  assert.equal(status.inside, false);
  assert(status.distance > 40);
});

test('return_home enters, verifies structure and sleeps in its real bed', async () => {
  const f = fixture();
  f.nav.goTo = async (target) => {
    assert.equal(executionContext.getStore().allowTerrainDig, false);
    f.bot.entity.position = vec3(target.x, target.y, target.z);
  };
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.equal(result.home_status.safe, true);
  assert.equal(result.slept, true);
  assert.equal(f.actions.stations.all().filter((s) => s.kind === 'bed').length, 1);
  assert.equal(f.actions.stations.all().filter((s) => s.kind === 'chest').length, 1);
});

test('unloaded home is unknown and verified after traveling, not declared demolished', async () => {
  const f = fixture(); f.unload();
  assert.equal(f.inspect().condition, 'unknown');
  const result = await f.run({ sleep: false });
  assert.equal(result.ok, true);
  assert.equal(result.home_status.condition, 'intact');
});

test('return_home closes the door opened during navigation and verifies the real state', async () => {
  const f = fixture();
  f.door(true);
  assert.equal(f.inspect().door_closed, false);
  let clicks = 0;
  f.bot.activateBlock = async () => { clicks += 1; f.door(false); };
  const result = await f.run({ sleep: false });
  assert.equal(result.ok, true);
  assert.equal(result.home_status.door_closed, true);
  assert.equal(clicks, 1);
});

test('an unconfirmed door click cannot produce a safe-home success', async () => {
  const f = fixture(); f.door(true);
  let clicks = 0; f.bot.activateBlock = async () => { clicks += 1; };
  const result = await f.run({ sleep: false });
  assert.equal(result.ok, false);
  assert.equal(result.home_status.safe, false);
  assert.equal(clicks, 1);
});

test('cancellation while closing a door prevents a safe-home success', async () => {
  const f = fixture(); f.door(true);
  const controller = new AbortController(); f.ctx.signal = controller.signal;
  f.bot.activateBlock = async () => { controller.abort(); };
  await assert.rejects(f.run({ sleep: false }), CancelledError);
});

test('removed roof makes arrival fail even if navigation says arrived', async () => {
  const f = fixture(); f.remove(2, 3, 2);
  const result = await f.run({ sleep: false });
  assert.equal(result.ok, false);
  assert.equal(result.home_status.condition, 'missing');
});

test('a hostile inside the structure prevents a safe-home report', async () => {
  const f = fixture();
  f.state.nearbyEntities = () => [{ name: 'zombie', position: vec3(2, 1, 2) }];
  const result = await f.run({ sleep: false });
  assert.equal(result.ok, false);
  assert.equal(result.home_status.condition, 'intact');
  assert.equal(result.home_status.safe, false);
});

test('sleep completion rechecks a roof removed while resting', async () => {
  const f = fixture();
  f.bot.sleep = async () => { f.bot.isSleeping = true; setTimeout(() => {
    f.remove(2, 3, 2); f.bot.isSleeping = false; f.bot.time.timeOfDay = 0;
  }, 10); };
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(result.slept, true);
  assert.equal(result.home_status.condition, 'missing');
});

test('return rejects another server or dimension without walking or sleeping', async () => {
  for (const field of ['server', 'dimension']) {
    const f = fixture(); f.home[field] = 'other';
    f.nav.goTo = async () => { throw Error('must not move'); };
    const result = await f.run();
    assert.equal(result.ok, false);
    assert.equal(result.home_status.condition, 'other_world');
  }
});

test('known home farther than 256 blocks stops without a long journey', async () => {
  const f = fixture(); f.bot.entity.position = vec3(300, 1, 0);
  f.nav.goTo = async () => { throw Error('must not move'); };
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.match(result.reason, /256/);
});

test('return cannot report entering a home when the body did not move', async () => {
  const f = fixture(); f.nav.goTo = async () => ({ arrived: true });
  const result = await f.run({ sleep: false });
  assert.equal(result.ok, false);
  assert.equal(result.home_status.inside, false);
});

test('cancellation stops return_home without hiding it as a route failure', async () => {
  const f = fixture();
  const controller = new AbortController(); f.ctx.signal = controller.signal;
  f.nav.goTo = async ({ signal }) => { controller.abort(); await delay(1, { signal }); };
  await assert.rejects(f.run(), CancelledError);
});

test('closed-door entry uses a safe outside waypoint, confirmed opening, physical crossing and closing', async () => {
  const f = fixture(), stages = [], originalGoTo = f.nav.goTo, originalClick = f.bot.activateBlock;
  f.nav.goTo = async (target) => {
    assert.equal(executionContext.getStore().allowTerrainDig, false);
    assert.equal(target.segmented, false, 'a failed entry must not restart a longer segmented budget');
    assert.deepEqual([target.x, target.y, target.z], [2.5, 1, -0.5]);
    stages.push('outside'); return originalGoTo(target);
  };
  f.bot.activateBlock = async () => {
    stages.push(f.inspect().inside ? 'close-inside' : 'open-outside');
    return originalClick();
  };
  const result = await f.run({ sleep: false });
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(stages, ['outside', 'open-outside', 'close-inside']);
  assert.equal(result.home_status.inside, true);
  assert.equal(result.home_status.door_closed, true);
  assert.equal(result.home_status.safe, true);
  assert.equal(f.controls.forward, false);
  assert.equal(f.bot.blockAt(vec3(0, 1, 2)).name, 'cobblestone');
});

test('an opening click without a server state update cannot start crossing or claim arrival', async () => {
  const f = fixture(); let clicks = 0;
  f.bot.activateBlock = async () => { clicks += 1; };
  const result = await f.run({ sleep: false });
  assert.equal(result.ok, false);
  assert.equal(result.home_status.inside, false);
  assert.equal(result.home_status.safe, false);
  assert.equal(clicks, 1);
  assert.equal(f.controls.forward, undefined);
});

test('door confirmation rejects missing, mismatched, unknown or inconsistent halves', async () => {
  const damages = [
    (f) => f.remove(2, 2, 0),
    (f) => f.put(2, 2, 0, 'birch_door', 'upper', false),
    (f) => { f.bot.blockAt(vec3(2, 2, 0)).getProperties = () => ({ half: 'upper' }); },
    (f) => f.put(2, 2, 0, 'oak_door', 'upper', true),
  ];
  for (const damage of damages) {
    const f = fixture(); f.bot.entity.position = vec3(2.5, 1, -0.5); damage(f);
    let clicks = 0; f.bot.activateBlock = async () => { clicks += 1; };
    assert.equal((await f.actions.openDoor({ x: 2, y: 1, z: 0 })).ok, false);
    f.bot.entity.position = vec3(2.5, 1, 2.5);
    assert.equal(f.inspect().safe, false, 'closed lower half alone cannot shelter the body');
    assert.equal(clicks, 0);
  }
});

test('direct door calls normalize the selected upper half and confirm both halves', async () => {
  const f = fixture(); f.bot.entity.position = vec3(2.5, 1, -0.5);
  assert.equal((await f.actions.openDoor({ x: 2, y: 2, z: 0 })).ok, true);
  assert([1, 2].every((y) => f.bot.blockAt(vec3(2, y, 0)).getProperties().open === true));
  assert.equal((await f.actions.closeDoor({ x: 2, y: 2, z: 0 })).ok, true);
  assert([1, 2].every((y) => f.bot.blockAt(vec3(2, y, 0)).getProperties().open === false));
});

test('closed and open iron doors cannot produce a manually secured home arrival', async () => {
  for (const open of [false, true]) {
    const f = fixture(); f.door(open, 'iron_door');
    let clicks = 0; f.bot.activateBlock = async () => { clicks += 1; };
    const result = await f.run({ sleep: false });
    assert.equal(result.ok, false);
    assert.equal(result.home_status.inside, false);
    assert.equal(clicks, 0);
  }
});

test('entry direction comes from each footprint wall and preserves the door shape corridor', async () => {
  for (const [x, z, inwardX] of [[2, 0, false], [2, 4, false], [0, 2, true], [4, 2, true]]) {
    const f = fixture();
    f.put(2, 1, 0, 'cobblestone'); f.put(2, 2, 0, 'cobblestone');
    f.home.door_position = { x, y: 1, z };
    const setDoor = (open) => {
      for (const y of [1, 2]) {
        f.put(x, y, z, 'oak_door', y === 1 ? 'lower' : 'upper', open);
        f.bot.blockAt(vec3(x, y, z)).shapes = [inwardX === open ? [0, 0, 0, 1, 1, 0.1875] : [0, 0, 0, 0.1875, 1, 1]];
      }
    };
    setDoor(false);
    f.bot.activateBlock = async () => setDoor(!f.bot.blockAt(vec3(x, 1, z)).getProperties().open);
    const result = await f.run({ sleep: false });
    assert.equal(result.ok, true, `wall ${x},${z}: ${result.reason}`);
    assert.equal(result.home_status.safe, true);
  }
});

test('door records off the wall, at a corner or at the wrong height cannot start travel', async () => {
  for (const position of [{ x: 2, y: 1, z: 2 }, { x: 0, y: 1, z: 0 }, { x: 2, y: 2, z: 0 }, { x: 20, y: 1, z: 0 }]) {
    const f = fixture(); f.home.door_position = position;
    f.nav.goTo = async () => { throw Error('must not navigate with an invalid doorway'); };
    const result = await f.run({ sleep: false });
    assert.equal(result.ok, false);
    assert.match(result.reason, /有效入口/);
  }
});

test('unsafe exterior or blocked inner landing fails without clicking, digging or placing', async () => {
  for (const damage of [(f) => f.remove(2, 0, -1), (f) => f.put(2, 1, -1, 'water'), (f) => f.put(2, 2, 1, 'cobblestone')]) {
    const f = fixture(); damage(f);
    let mutations = 0; f.bot.activateBlock = f.bot.dig = f.bot.placeBlock = async () => { mutations += 1; };
    const result = await f.run({ sleep: false });
    assert.equal(result.ok, false);
    assert.equal(result.home_status.inside, false);
    assert.equal(mutations, 0);
  }
});

test('an open door with shapes across the entrance cannot start physical crossing', async () => {
  const f = fixture(); f.door(true);
  for (const y of [1, 2]) f.bot.blockAt(vec3(2, y, 0)).shapes = [[0, 0, 0, 1, 1, 0.1875]];
  const result = await f.run({ sleep: false });
  assert.equal(result.ok, false);
  assert.match(result.reason, /朝向挡住/);
  assert.equal(f.controls.forward, undefined);
});

test('a crossing result without actual body movement cannot claim a safe home', async () => {
  const f = fixture(); f.actions.enterDoor = async () => ({ ok: true });
  const result = await f.run({ sleep: false });
  assert.equal(result.ok, false);
  assert.equal(result.home_status.inside, false);
  assert.equal(result.home_status.safe, false);
});

test('physical crossing times out and clears controls when the body cannot move', async () => {
  const f = fixture(); f.door(true); f.bot.entity.position = vec3(2.5, 1, -0.5);
  f.bot.setControlState = (name, value) => { f.controls[name] = value; };
  const start = Date.now();
  const result = await f.actions.enterDoor({ x: 2, y: 1, z: 0, target: { x: 2.5, y: 1, z: 1.5 }, timeoutMs: 80 });
  assert.equal(result.ok, false);
  assert(Date.now() - start < 500);
  assert.equal(f.controls.forward, false);
});

test('cancellation while opening does not continue to crossing or closing', async () => {
  const f = fixture(), controller = new AbortController(); f.ctx.signal = controller.signal;
  let clicks = 0; f.bot.activateBlock = async () => { clicks += 1; controller.abort(); };
  await assert.rejects(f.run({ sleep: false }), CancelledError);
  assert.equal(clicks, 1);
  assert.equal(f.controls.forward, undefined);
});

test('cancellation during physical entry stops the body and never clicks the door again', async () => {
  const f = fixture(), controller = new AbortController(); f.ctx.signal = controller.signal;
  const original = f.bot.setControlState, originalClick = f.bot.activateBlock;
  let clicks = 0;
  f.bot.activateBlock = async () => { clicks += 1; return originalClick(); };
  f.bot.setControlState = (name, value) => { original(name, value); if (name === 'forward' && value) setTimeout(() => controller.abort(), 15); };
  await assert.rejects(f.run({ sleep: false }), CancelledError);
  const stopped = f.bot.entity.position.clone(); await delay(40);
  assert.equal(f.bot.entity.position.distanceTo(stopped), 0);
  assert.equal(f.controls.forward, false);
  assert.equal(clicks, 1, 'cancelled execution cannot perform a final closing click');
});

test('emergency stop during physical entry cancels instead of reporting arrival', async () => {
  const f = fixture(), original = f.bot.setControlState;
  f.bot.setControlState = (name, value) => { original(name, value); if (name === 'forward' && value) setTimeout(() => {
    f.actions.setStopped(true); f.actions.stopCurrent();
  }, 15); };
  await assert.rejects(f.run({ sleep: false }), CancelledError);
  assert.equal(f.controls.forward, false);
  assert.equal(f.inspect().inside, false);
});

test('a door closed or support removed mid-crossing fails and clears forward control', async () => {
  for (const damage of [(f) => f.door(false), (f) => f.remove(2, 0, -1), (f) => f.put(2, 2, 1, 'cobblestone')]) {
    const f = fixture(), original = f.bot.setControlState;
    f.bot.setControlState = (name, value) => { original(name, value); if (name === 'forward' && value) setTimeout(() => damage(f), 15); };
    const result = await f.run({ sleep: false });
    assert.equal(result.ok, false);
    assert.equal(result.home_status.inside, false);
    assert.equal(f.controls.forward, false);
  }
});

test('an old crossing continuation cannot clear a newer execution control after stopCurrent', async () => {
  const f = fixture(); f.door(true); f.bot.entity.position = vec3(2.5, 1, -0.5);
  let release;
  f.bot.lookAt = () => new Promise((resolve) => { release = resolve; });
  const pending = f.actions.enterDoor({ x: 2, y: 1, z: 0, target: { x: 2.5, y: 1, z: 1.5 } });
  await delay(1); f.actions.stopCurrent();
  f.bot.setControlState('forward', true); release();
  await assert.rejects(pending, CancelledError);
  assert.equal(f.controls.forward, true, 'old finally must not clear control acquired after its stop');
  f.bot.clearControlStates();
});

test('outside travel and opening share the remaining entry budget rather than restarting it', async () => {
  const f = fixture(); f.ctx.deadline = Date.now() + 80;
  f.nav.goTo = async (target) => { assert.equal(target.segmented, false); await delay(35); f.bot.entity.position = vec3(target.x, target.y, target.z); };
  f.actions.openDoor = async ({ timeoutMs }) => { assert(timeoutMs <= 50); await delay(70); f.door(true); return { ok: true }; };
  const result = await f.run({ sleep: false });
  assert.equal(result.ok, false);
  assert.equal(result.home_status.inside, false);
  assert.equal(f.controls.forward, undefined);
});

test('sleeping is rejected in explosive-bed dimensions before interaction', async () => {
  const f = fixture(); f.bot.game.dimension = 'the_nether';
  f.bot.sleep = async () => { throw Error('must not sleep'); };
  await assert.rejects(f.actions.sleepInBed(), /爆炸/);
});

test('a roofed but flooded home is not considered currently safe', async () => {
  const f = fixture(); f.bot.entity.isInWater = true;
  const result = await f.run({ sleep: false });
  assert.equal(result.ok, false);
  assert.equal(result.home_status.condition, 'intact');
  assert.equal(result.home_status.safe, false);
});

test('night shelter waiting is bounded and ends when morning arrives', async () => {
  const f = fixture(); f.remove(2, 1, 2); f.bot.entity.position = vec3(2.5, 1, 2.5);
  const start = Date.now();
  setTimeout(() => { f.bot.time.timeOfDay = 0; }, 10);
  const result = await f.run({ sleep: false, wait_seconds: 1 });
  assert.equal(result.ok, true);
  assert(result.waited_ms > 0 && result.waited_ms <= 1200);
  assert(Date.now() - start < 1200);
});

test('cancelled shelter waiting does not continue after owner input', async () => {
  const f = fixture(); f.remove(2, 1, 2); f.bot.entity.position = vec3(2.5, 1, 2.5);
  const controller = new AbortController(); f.ctx.signal = controller.signal;
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(f.run({ sleep: false, wait_seconds: 1 }), CancelledError);
});

test('nearby threats stop night waiting as a failure instead of an immediate success loop', async () => {
  const f = fixture(); f.remove(2, 1, 2); f.bot.entity.position = vec3(2.5, 1, 2.5);
  f.state.nearbyEntities = () => [{ name: 'zombie', position: vec3(2, 1, -2) }];
  const result = await f.run({ sleep: false, wait_seconds: 1 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /威胁/);
});

test('explicit sleeping uses the verified home bed rather than another nearby bed', async () => {
  const f = fixture(); f.bot.entity.position = vec3(2.5, 1, 2.5);
  f.put(3, 1, 2, 'red_bed');
  f.bot.findBlock = () => f.bot.blockAt(vec3(3, 1, 2));
  let sleptIn;
  f.bot.sleep = async (bed) => { sleptIn = bed.position; f.bot.isSleeping = true;
    setTimeout(() => { f.bot.isSleeping = false; f.bot.time.timeOfDay = 0; }, 10); };
  const r = await f.actions.sleepInBed({ bed_position: { x: 2, y: 1, z: 2 } });
  assert.equal(r.ok, true);
  assert.equal(sleptIn.x, 2);
});

test('station scope keeps beds and chests separate across servers and dimensions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astrcraft-home-'));
  assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
  try {
    const file = path.join(dir, 'stations.json');
    const s = new StationMemory({ file });
    s.remember('chest', { x: 90, y: 1, z: 0 }); // Old unscoped history cannot be assigned to a world.
    let world = { server: 'test:25565', dimension: 'overworld' };
    s.bindScope(() => world);
    assert.equal(s.all().length, 0);
    s.remember('white_bed', { x: 2, y: 1, z: 2 });
    s.remember('chest', { x: 1, y: 1, z: 1 });
    world = { server: 'test:25565', dimension: 'the_nether' };
    assert.equal(s.all().length, 0);
    world = { server: 'other:25565', dimension: 'overworld' };
    assert.equal(s.all().length, 0);
    world = { server: 'test:25565', dimension: 'minecraft:overworld' };
    const reloaded = new StationMemory({ file }); reloaded.bindScope(() => world);
    assert.equal(reloaded.all().length, 2);
    assert.equal(reloaded.nearest('bed', { x: 0, y: 1, z: 0 }).x, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('unloaded station travels to verify; a loaded replacement is forgotten', async () => {
  const f = fixture();
  // This station-memory fixture exercises loading/verification, independently of home entry.
  f.nav.goTo = async () => f.load();
  f.actions.stations.remember('chest', { x: 1, y: 1, z: 1 }); f.unload();
  const chest = await f.actions._rememberedStation('chest');
  assert.equal(chest.name, 'chest');
  assert.equal(f.actions.stations.all().length, 1);
  f.remove(1, 1, 1);
  assert.equal(await f.actions._rememberedStation('chest'), null);
  assert.equal(f.actions.stations.all().length, 0);
});

test('unknown station stays remembered after failed travel', async () => {
  const f = fixture();
  f.actions.stations.remember('chest', { x: 1, y: 1, z: 1 }); f.unload();
  f.nav.goTo = async () => { throw Error('temporarily unreachable'); };
  assert.equal(await f.actions._rememberedStation('chest'), null);
  assert.equal(f.actions.stations.all().length, 1);
});

(async () => {
  let failed = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (err) { failed += 1; console.error(`FAIL ${name}: ${err.stack}`); }
  }
  console.log(`${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
