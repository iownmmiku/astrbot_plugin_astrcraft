'use strict';

// Run the real storage skill and Actions.deposit; replace only Minecraft I/O.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Actions } = require('../engine/actions');
const { Config } = require('../engine/config');
const { StationMemory } = require('../engine/stations');
const { SkillContext } = require('../engine/skills/common');
const { storeItems } = require('../engine/skills/gathering');
const { inspectHome, leaveHome } = require('../engine/skills/building');
const skills = require('../engine/skills');
const { executionContext } = require('../engine/goals');
const { vec3, distance, CancelledError } = require('../engine/util');
const { Recipe } = require('../engine/node_modules/prismarine-recipe')('1.20.1');
const data = require('../engine/node_modules/minecraft-data')('1.20.1');

const tests = [];
const test = (name, run) => tests.push({ name, run });
const key = (p) => `${p.x},${p.y},${p.z}`;

function fixture(initial = { cobblestone: 16 }) {
  const inventory = { ...initial };
  const types = new Map();
  const typeOf = (name) => {
    if (!types.has(name)) types.set(name, types.size + 1);
    return types.get(name);
  };
  const asItems = (counts, firstSlot = 27) => Object.entries(counts).filter(([, count]) => count > 0)
    .map(([name, count], index) => ({ name, count, type: typeOf(name), metadata: null, slot: firstSlot + index }));
  const cells = new Map(), containers = new Map(), unloaded = new Set();
  const moves = [], opens = [], crafts = [], places = [];
  const controller = new AbortController();
  const bot = new EventEmitter();
  Object.assign(bot, {
    entity: { position: vec3(0.5, 1, 0.5) }, game: { dimension: 'overworld' }, version: '1.20.1',
    _client: { socket: { remoteAddress: 'storage-test', remotePort: 25565 }, write() {} },
    inventory: { items: () => asItems(inventory) },
    currentWindow: null,
    blockAt(pos) {
      if (unloaded.has(key(pos)) || distance(bot.entity.position, pos) > 16) return null;
      return cells.get(key(pos)) || { name: 'air', position: pos, boundingBox: 'empty' };
    },
    findBlock({ matching, useExtraInfo, maxDistance }) {
      return [...cells.values()].filter((block) => distance(bot.entity.position, block.position) <= maxDistance &&
        bot.blockAt(block.position) && matching({ name: block.name }) &&
        (typeof useExtraInfo !== 'function' || useExtraInfo(block))).sort((a, b) =>
        distance(bot.entity.position, a.position) - distance(bot.entity.position, b.position))[0] || null;
    },
    openContainer: async (block) => {
      opens.push({ ...block.position });
      const container = containers.get(key(block.position));
      assert(container, 'only a real container can be opened');
      const win = {
        inventoryStart: 27, inventoryEnd: 63,
        items: () => asItems(inventory), inventoryItems: () => asItems(inventory),
        containerItems: () => asItems(container.items, 0),
        async deposit(type, metadata, requested) {
          const name = [...types.entries()].find(([, id]) => id === type)?.[0];
          assert(name);
          if (container.behavior) return container.behavior({ name, requested, inventory, container, controller, bot });
          const moved = Math.min(requested, container.capacity);
          if (!moved) throw new Error('container is full');
          inventory[name] -= moved;
          container.items[name] = (container.items[name] || 0) + moved;
          container.capacity -= moved;
          if (moved < requested) throw new Error('container became full after partial transfer');
        },
        close() { if (bot.currentWindow === win) bot.currentWindow = null; },
      };
      bot.currentWindow = win;
      bot.emit('windowOpen', win);
      return win;
    },
  });
  const nav = { stop() {}, async goTo(target) {
    assert.equal(executionContext.getStore()?.allowTerrainDig, false, 'storage travel cannot dig terrain');
    assert.equal(target.segmented, false, 'travel cannot silently extend its deadline');
    assert(target.timeoutMs > 0 && target.timeoutMs <= 20000);
    moves.push(target);
    bot.entity.position = vec3(target.x, target.y ?? bot.entity.position.y, target.z);
    return { arrived: true };
  } };
  const actions = new Actions({ bot, config: new Config(), navigator: nav });
  actions.stations = new StationMemory();
  actions.stations.bindScope(() => ({ server: `${bot._client.socket.remoteAddress}:${bot._client.socket.remotePort}`, dimension: bot.game.dimension }));
  actions.craft = async ({ item }) => { crafts.push(item); return { ok: false, produced: 0 }; };
  actions._spotInFront = () => ({ x: 2, y: 1, z: 0 });
  actions.place = async ({ x, y, z, item }) => {
    places.push({ x, y, z, item });
    inventory[item] -= 1;
    put(item, x, y, z);
    return { ok: true };
  };
  const ctx = new SkillContext({ signal: controller.signal });
  const put = (name, x, y = 1, z = 0, options = {}) => {
    const position = vec3(x, y, z);
    cells.set(key(position), { name, position, boundingBox: name === 'air' ? 'empty' : 'block' });
    if (['chest', 'barrel', 'trapped_chest'].includes(name)) {
      containers.set(key(position), { items: {}, capacity: Infinity, ...options });
    }
    return position;
  };
  const remember = (name, x, y = 1, z = 0) => actions.stations.remember(name, vec3(x, y, z));
  const state = { nearbyEntities: () => [] };
  const run = (options = {}) => storeItems({ actions, nav, ctx, state, ...options });
  return { bot, actions, nav, ctx, controller, inventory, cells, containers, unloaded,
    state, moves, opens, crafts, places, put, remember, run };
}

// Use the production home/door/storage chain; fake only server blocks and physics ticks.
function homeFixture({ x = 40, initial, chest = true } = {}) {
  const f = fixture(initial), stages = [], controls = {};
  const home = { server: 'storage-test:25565', dimension: 'overworld', origin: { x, y: 1, z: 0 },
    size: 5, wall_height: 2, door_position: { x: x + 2, y: 1, z: 0 } };
  for (let dx = -1; dx <= 5; dx += 1) for (let dz = -2; dz <= 5; dz += 1) f.put('stone', x + dx, 0, dz);
  for (let dx = 0; dx < 5; dx += 1) for (let dz = 0; dz < 5; dz += 1) {
    f.put('cobblestone', x + dx, 3, dz);
    if (dx === 0 || dz === 0 || dx === 4 || dz === 4) for (let y = 1; y <= 2; y += 1) f.put('cobblestone', x + dx, y, dz);
  }
  const door = (open, name = 'oak_door') => {
    for (let y = 1; y <= 2; y += 1) {
      const p = f.put(name, x + 2, y, 0), block = f.cells.get(key(p));
      block.getProperties = () => ({ half: y === 1 ? 'lower' : 'upper', open });
      block.shapes = [open ? [0, 0, 0, 0.1875, 1, 1] : [0, 0, 0, 1, 1, 0.1875]];
    }
  };
  door(false);
  if (chest) f.put('chest', x + 1, 1, 1);
  const inspect = () => inspectHome({ actions: f.actions, state: f.state, home });
  const originalGoTo = f.nav.goTo;
  f.nav.goTo = async (target) => {
    stages.push(inspect().inside ? 'walk-inside' : 'walk-outside');
    return originalGoTo(target);
  };
  let looking = null, timer = null;
  f.bot.entity.onGround = true;
  f.bot.lookAt = async (position) => { looking = position; };
  f.bot.setControlState = (name, value) => {
    controls[name] = value;
    if (name !== 'forward' || !value || timer) return;
    timer = setInterval(() => {
      if (!controls.forward || !looking || !f.bot.blockAt(vec3(x + 2, 1, 0))?.getProperties?.().open) return;
      const p = f.bot.entity.position, dx = looking.x - p.x, dz = looking.z - p.z, length = Math.hypot(dx, dz);
      if (length > 0) f.bot.entity.position = p.offset(dx / length * Math.min(0.2, length), 0,
        dz / length * Math.min(0.2, length));
    }, 5);
  };
  f.bot.clearControlStates = () => { Object.keys(controls).forEach((name) => { controls[name] = false; });
    clearInterval(timer); timer = null; };
  f.bot.activateBlock = async () => {
    const open = f.bot.blockAt(vec3(x + 2, 1, 0)).getProperties().open;
    stages.push(`${open ? 'close' : 'open'}-${inspect().inside ? 'inside' : 'outside'}`);
    door(!open);
  };
  f.actions.sleepInBed = async () => { throw new Error('store_items must not sleep'); };
  return { ...f, home, stages, controls, door, inspect,
    run: (options = {}) => f.run({ home, ...options }),
    leave: (options = {}) => leaveHome({ actions: f.actions, nav: f.nav, state: f.state, ctx: f.ctx, home, ...options }) };
}

test('nearby real barrel wins over a remembered distant chest', async () => {
  const f = fixture(); f.put('barrel', 3); f.put('chest', 48); f.remember('chest', 48);
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.equal(result.chest.x, 3);
  assert.equal(f.moves.length, 0);
  assert.deepEqual(result.consumed, { cobblestone: 16 });
  assert.equal(f.inventory.cobblestone, 0);
  assert.equal(f.containers.get('3,1,0').items.cobblestone, 16);
  assert.deepEqual(f.crafts, []);
});

test('an unloaded remembered chest is reached and verified before physical transfer', async () => {
  const f = fixture({ cobblestone: 16, coal: 8, cooked_beef: 4, iron_pickaxe: 1, white_bed: 1 });
  const position = f.put('chest', 48); f.remember('chest', 48);
  assert.equal(f.bot.blockAt(position), null);
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.equal(result.chest.x, 48);
  assert(f.moves.length > 1);
  assert(f.moves.every((move) => move.x <= 48));
  assert.deepEqual(result.consumed, { cobblestone: 16 });
  assert.equal(f.containers.get(key(position)).items.cobblestone, 16);
  assert.deepEqual(f.inventory, { cobblestone: 0, coal: 8, cooked_beef: 4, iron_pickaxe: 1, white_bed: 1 });
  assert.deepEqual(f.crafts, []);
});

test('a still-unloaded container is retained without creating another chest', async () => {
  const f = fixture({ cobblestone: 16, oak_planks: 16 });
  const position = f.put('chest', 48); f.remember('chest', 48); f.unloaded.add(key(position));
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.match(result.reason, /未加载/);
  assert.equal(f.actions.stations.all().length, 1);
  assert.deepEqual(f.opens, []);
  assert.deepEqual(f.crafts, []);
});

test('only actual arrival at a missing chest removes its memory', async () => {
  const f = fixture(); f.remember('chest', 40); f.put('barrel', 48); f.remember('barrel', 48);
  const forget = f.actions.stations.forget.bind(f.actions.stations);
  f.actions.stations.forget = (kind, position) => {
    assert(distance(f.bot.entity.position, position) <= 4);
    assert.equal(f.bot.blockAt(position).name, 'air');
    return forget(kind, position);
  };
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.equal(result.chest.x, 48);
  assert.deepEqual(f.actions.stations.all().map((entry) => entry.kind), ['barrel']);
});

test('a remembered chest replaced by a barrel updates its kind and remains usable', async () => {
  const f = fixture(); f.put('barrel', 48); f.remember('chest', 48);
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.deepEqual(f.actions.stations.all().map((entry) => entry.kind), ['barrel']);
});

test('an unreachable remembered container keeps its memory and cannot report success', async () => {
  const f = fixture(); f.put('chest', 48); f.remember('chest', 48);
  f.nav.goTo = async () => { throw new Error('no path'); };
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(f.actions.stations.all().length, 1);
  assert.equal(f.inventory.cobblestone, 16);
  assert.deepEqual(f.opens, []);
  assert.deepEqual(f.crafts, []);
});

test('a navigation success without actual movement is rejected', async () => {
  const f = fixture(); f.put('chest', 48); f.remember('chest', 48);
  f.nav.goTo = async () => ({ arrived: true });
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.match(result.reason, /未实际走近/);
  assert.equal(f.actions.stations.all().length, 1);
  assert.deepEqual(f.opens, []);
});

test('a full nearby chest can fall back to a remembered barrel within the same budget', async () => {
  const f = fixture(); f.put('chest', 3, 1, 0, { capacity: 0 }); f.remember('chest', 3);
  f.put('barrel', 48); f.remember('barrel', 48);
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.equal(result.chest.x, 48);
  assert.deepEqual(f.opens.map((position) => position.x), [3, 48, 48], 'available container is reopened for its authoritative snapshot');
  assert.equal(f.inventory.cobblestone, 0);
  assert.deepEqual(f.crafts, []);
});

test('all-full containers preserve inventory and return an honest failure', async () => {
  const f = fixture(); f.put('chest', 3, 1, 0, { capacity: 0 });
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.match(result.reason, /没有存入/);
  assert.equal(f.inventory.cobblestone, 16);
  assert.deepEqual(f.crafts, []);
});

test('a no-op deposit response does not claim items were stored', async () => {
  const f = fixture(); f.put('chest', 3, 1, 0, { behavior: async () => {} });
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(f.inventory.cobblestone, 16);
  assert.deepEqual(f.containers.get('3,1,0').items, {});
});

test('reopening reads the server rejection instead of accepting optimistic slot changes', async () => {
  const f = fixture(); f.put('chest', 3);
  const open = f.bot.openContainer;
  f.bot.openContainer = async (block) => {
    if (f.opens.length === 1) {
      // Simulate a server rejecting clicks after the client's optimistic update.
      f.inventory.cobblestone = 16;
      f.containers.get('3,1,0').items = {};
    }
    return open(block);
  };
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(f.inventory.cobblestone, 16);
  assert.equal(f.opens.length, 2, 'confirmation uses another server window snapshot');
});

test('a partial transfer followed by a full-container error reports only the actual amount', async () => {
  const f = fixture(); f.put('chest', 3, 1, 0, { capacity: 3 });
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.deepEqual(result.consumed, { cobblestone: 3 });
  assert.equal(f.inventory.cobblestone, 13);
  assert.equal(f.containers.get('3,1,0').items.cobblestone, 3);
  assert.match(result.note, /3 个物品/);
});

test('inventory loss without a matching container gain cannot count as storage', async () => {
  const f = fixture(); f.put('chest', 3, 1, 0, {
    behavior: async ({ name, inventory }) => { inventory[name] = 0; },
  });
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.deepEqual(f.containers.get('3,1,0').items, {});
});

test('container gain without a matching inventory loss cannot count as storage', async () => {
  const f = fixture(); f.put('chest', 3, 1, 0, {
    behavior: async ({ name, requested, container }) => { container.items[name] = requested; },
  });
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(f.inventory.cobblestone, 16);
});

test('default storage keeps survival supplies and stores ordinary materials', async () => {
  const supplies = { coal: 8, charcoal: 4, dried_kelp_block: 1, blaze_rod: 2, lava_bucket: 1, water_bucket: 1,
    iron_pickaxe: 1, netherite_helmet: 1, white_bed: 1, shield: 1, trident: 1, shears: 1,
    torch: 16, soul_torch: 4, stick: 8, wheat: 6, cooked_beef: 4, beef: 3, potato: 2,
    crafting_table: 1, furnace: 1, birch_door: 1, totem_of_undying: 1 };
  const f = fixture({ ...supplies, cobblestone: 32, oak_log: 8, raw_iron: 4 }); f.put('chest', 3);
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.deepEqual(result.consumed, { cobblestone: 32, oak_log: 8, raw_iron: 4 });
  for (const [name, count] of Object.entries(supplies)) assert.equal(f.inventory[name], count, name);
});

test('explicit items and keep lists can store supplies and match namespaced names', async () => {
  const f = fixture({ coal: 8, crafting_table: 1, furnace: 1, oak_door: 1, white_bed: 1, cobblestone: 16 }); f.put('chest', 3);
  const result = await f.run({ items: ['minecraft:coal', 'crafting_table', 'furnace', 'oak_door', 'white_bed'], keep: ['minecraft:white_bed'] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.consumed, { coal: 8, crafting_table: 1, furnace: 1, oak_door: 1 });
  assert.equal(f.inventory.white_bed, 1);
  assert.equal(f.inventory.cobblestone, 16);
});

test('explicit items without keep can store normally protected fuel', async () => {
  const f = fixture({ coal: 8, cooked_beef: 4, cobblestone: 16 }); f.put('chest', 3);
  const result = await f.run({ items: ['coal'] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.consumed, { coal: 8 });
  assert.equal(f.inventory.cooked_beef, 4);
  assert.equal(f.inventory.cobblestone, 16);
});

test('an explicit empty keep list stores all inventory without mandatory exceptions', async () => {
  const f = fixture({ coal: 8, crafting_table: 1, furnace: 1, oak_door: 1, white_bed: 1 }); f.put('chest', 3);
  const result = await f.run({ keep: [] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.consumed, { coal: 8, crafting_table: 1, furnace: 1, oak_door: 1, white_bed: 1 });
});

test('nothing eligible to store causes no travel, crafting, or container clicks', async () => {
  const f = fixture({ coal: 8, iron_pickaxe: 1 }); f.remember('chest', 48);
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.deepEqual(f.moves, []);
  assert.deepEqual(f.opens, []);
  assert.deepEqual(f.crafts, []);
});

test('container records from another dimension or server cannot be used', async () => {
  const f = fixture(); f.remember('chest', 48);
  f.bot.game.dimension = 'the_nether'; f.remember('barrel', 60);
  f.bot._client.socket.remoteAddress = 'other-server'; f.remember('chest', 80);
  f.bot.game.dimension = 'overworld';
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.deepEqual(f.moves, []);
  assert.deepEqual(f.opens, []);
});

test('records over 128 blocks away never cause distant travel', async () => {
  const f = fixture(); f.remember('chest', 300);
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.deepEqual(f.moves, []);
  assert.equal(f.actions.stations.all().length, 1);
});

test('at most three inaccessible remembered containers are attempted', async () => {
  const f = fixture(); for (const x of [40, 50, 60, 70, 80]) f.remember('chest', x);
  let attempts = 0;
  f.nav.goTo = async () => { attempts += 1; throw new Error('no path'); };
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(attempts, 3);
  assert.equal(f.actions.stations.all().length, 5);
});

test('all travel shares a 20 second deadline and cannot restart its budget', async () => {
  const f = fixture(); f.put('chest', 48); f.remember('chest', 48); f.remember('barrel', 60);
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  f.nav.goTo = async (target) => {
    f.moves.push(target); now += 21000;
    f.bot.entity.position = vec3(target.x, target.y ?? 1, target.z);
    return { arrived: true };
  };
  try {
    const result = await f.run();
    assert.equal(result.ok, false);
    assert.match(result.reason, /预算/);
    assert.equal(f.moves.length, 1);
    assert.deepEqual(f.opens, []);
    assert.deepEqual(f.crafts, []);
    assert.equal(f.actions.stations.all().length, 2);
  } finally { Date.now = realNow; }
});

test('travel cancellation propagates and retains the unverified record', async () => {
  const f = fixture(); f.remember('chest', 48);
  f.nav.goTo = async () => { f.controller.abort(); throw new Error('path cancelled'); };
  await assert.rejects(f.run(), CancelledError);
  assert.equal(f.actions.stations.all().length, 1);
  assert.deepEqual(f.crafts, []);
});

test('a dimension change during travel cannot delete or use old-world records', async () => {
  const f = fixture(); f.remember('chest', 48);
  f.nav.goTo = async (target) => {
    f.bot.game.dimension = 'the_nether';
    f.actions.stations.remember('chest', vec3(48, 1, 0));
    f.bot.entity.position = vec3(target.x, 1, target.z);
    return { arrived: true };
  };
  await assert.rejects(f.run(), CancelledError);
  assert.equal(f.actions.stations.all().length, 1);
  f.bot.game.dimension = 'overworld';
  assert.equal(f.actions.stations.all().length, 1);
  assert.deepEqual(f.opens, []);
});

test('deposit cancellation propagates rather than becoming an ordinary failure', async () => {
  const f = fixture(); f.put('chest', 3, 1, 0, {
    behavior: async ({ controller, bot }) => {
      controller.abort(); bot.currentWindow = null;
      throw new CancelledError('cancel deposit');
    },
  });
  await assert.rejects(f.run(), CancelledError);
  assert.equal(f.inventory.cobblestone, 16);
  assert.deepEqual(f.crafts, []);
});

test('chest crafting and placement cancellation both propagate', async () => {
  const crafting = fixture({ cobblestone: 16, oak_planks: 12 });
  crafting.actions.craft = async () => { throw new CancelledError('cancel craft'); };
  await assert.rejects(crafting.run(), CancelledError);
  const placing = fixture({ cobblestone: 16, chest: 1 });
  placing.actions.place = async () => { const error = new Error('cancel place'); error.name = 'AbortError'; throw error; };
  await assert.rejects(placing.run(), { name: 'AbortError' });
});

test('placing a chest without a real block cannot report storage success', async () => {
  const f = fixture({ cobblestone: 16, chest: 1 });
  f.actions.place = async () => ({ ok: true });
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.match(result.reason, /真实箱子/);
  assert.deepEqual(f.opens, []);
});

test('without a usable remembered container a held chest can be placed locally', async () => {
  const f = fixture({ cobblestone: 16, chest: 1, coal: 8 });
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.deepEqual(result.consumed, { cobblestone: 16 });
  assert.equal(f.inventory.coal, 8);
  assert.deepEqual(f.places.map((place) => place.item), ['chest']);
  assert.equal(f.actions.stations.all().length, 1);
});

test('creating a chest makes only the plank deficit from already-held wood', async () => {
  const f = fixture({ cobblestone: 16, oak_planks: 4, oak_log: 1 });
  f.put('crafting_table', 3, 1, 1);
  const crafted = [];
  f.actions.craft = async ({ item, count }) => {
    crafted.push({ item, count });
    if (item === 'oak_planks') {
      assert.equal(count, 4);
      f.inventory.oak_log -= 1;
      f.inventory.oak_planks += 4;
      return { ok: true, produced: 4 };
    }
    assert.equal(item, 'chest');
    assert.equal(f.inventory.oak_planks, 8);
    f.inventory.oak_planks -= 8;
    f.inventory.chest = 1;
    return { ok: true, produced: 1 };
  };
  const result = await f.run();
  assert.equal(result.ok, true);
  assert.deepEqual(crafted, [{ item: 'oak_planks', count: 4 }, { item: 'chest', count: 1 }]);
  assert.deepEqual(result.consumed, { cobblestone: 16 });
});

test('store_items catalog exposes home and resume_work, forwarding config through a child context', async () => {
  const definition = skills.get('store_items');
  assert.equal(definition.params.home.type, 'object');
  assert.equal(definition.params.home.def, null);
  assert.equal(definition.params.resume_work.def, false);
  const f = homeFixture(), building = require('../engine/skills/building');
  const config = new Config(), nativeReturn = building.returnHome;
  let invoked = false;
  building.returnHome = async (options) => {
    invoked = true;
    assert.equal(options.config, config);
    assert.equal(options.sleep, false);
    assert.equal(options.waitSeconds, 0);
    assert.equal(options.ctx.signal.aborted, false);
    assert.notDeepEqual(options.ctx._checkpointScope, f.ctx._checkpointScope);
    assert(options.ctx.deadline <= Date.now() + 20000);
    assert(options.timeoutMs > 0 && options.timeoutMs <= 20000);
    return nativeReturn(options);
  };
  try {
    const result = await definition.run({ actions: f.actions, nav: f.nav, state: f.state, ctx: f.ctx, config,
      params: { home: f.home, items: ['cobblestone'], keep: [] } });
    assert.equal(invoked, true);
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.home_status.safe, true);
    assert.equal(result.resumed_work, false);
  } finally { building.returnHome = nativeReturn; }
});

test('a closed known home wins over outside containers and stores only after confirmed entry and closing', async () => {
  const f = homeFixture(); f.put('barrel', 3); f.put('chest', 48); f.remember('chest', 48);
  const open = f.bot.openContainer;
  f.bot.openContainer = async (block) => {
    assert.equal(f.inspect().safe, true);
    assert.equal(block.position.x, 41);
    return open(block);
  };
  const result = await f.run();
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.chest.x, 41);
  assert.deepEqual(result.consumed, { cobblestone: 16 });
  assert.deepEqual(f.stages, ['walk-outside', 'open-outside', 'close-inside']);
  assert.equal(f.inspect().safe, true, 'explicit home storage stays sheltered by default');
  assert.equal(f.controls.forward, false);
  assert.deepEqual(f.crafts, []);
  assert.deepEqual(f.places, []);
});

test('resume_work exits through the same real door after storage and confirms both halves closed', async () => {
  const f = homeFixture();
  const click = f.bot.activateBlock;
  f.bot.activateBlock = async (...args) => {
    if (f.inspect().inside && f.stages.includes('walk-inside')) {
      assert.equal(f.inventory.cobblestone, 0);
      assert.equal(f.containers.get('41,1,1').items.cobblestone, 16);
    }
    return click(...args);
  };
  const result = await skills.get('store_items').run({ actions: f.actions, nav: f.nav, state: f.state, ctx: f.ctx,
    params: { home: f.home, resume_work: true } });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.resumed_work, true);
  assert.equal(result.left_home, true);
  assert.equal(result.home_status.inside, false);
  assert.equal(result.home_status.safe, false, 'outside body is not currently sheltered');
  assert.equal(result.home_status.door_closed, true);
  assert.deepEqual(f.stages, ['walk-outside', 'open-outside', 'close-inside', 'walk-inside', 'open-inside', 'close-outside']);
  assert.equal(f.controls.forward, false);
});

test('home storage rejects another server or dimension before travel or container interaction', async () => {
  for (const field of ['server', 'dimension']) {
    const f = homeFixture(); f.home[field] = 'other'; f.remember('chest', 41, 1, 1); f.put('barrel', 3);
    const result = await f.run();
    assert.equal(result.ok, false);
    assert.equal(result.home_status.condition, 'other_world');
    assert.deepEqual(f.moves, []);
    assert.deepEqual(f.opens, []);
    assert.deepEqual(f.crafts, []);
    assert.equal(f.actions.stations.all().length, 1);
  }
});

test('home storage is bounded to 128 blocks and rejects malformed records without fallback', async () => {
  const distant = homeFixture({ x: 140 }); distant.put('chest', 3);
  assert.match((await distant.run()).reason, /128/);
  assert.deepEqual(distant.moves, []);
  assert.deepEqual(distant.opens, []);
  const invalid = fixture({ cobblestone: 16, chest: 1 }); invalid.put('barrel', 3);
  const result = await invalid.run({ home: { origin: { x: 40, y: 1, z: 0 } } });
  assert.equal(result.ok, false);
  assert.match(result.reason, /基地记录/);
  assert.deepEqual(invalid.opens, []);
  assert.deepEqual(invalid.places, []);
});

test('a damaged home cannot store in an outside container or create a replacement chest', async () => {
  const f = homeFixture({ initial: { cobblestone: 16, chest: 1 } });
  f.cells.delete('42,3,2'); f.put('barrel', 3); f.remember('chest', 41, 1, 1);
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(result.home_status.condition, 'missing');
  assert.equal(f.inventory.cobblestone, 16);
  assert.deepEqual(f.opens, []);
  assert.deepEqual(f.places, []);
  assert.deepEqual(f.stages, ['walk-outside']);
  assert.equal(f.actions.stations.all().length, 1);
});

test('a home with no actual interior container fails and preserves its records', async () => {
  const f = homeFixture({ chest: false, initial: { cobblestone: 16, chest: 1 } });
  f.remember('chest', 41, 1, 1); f.put('barrel', 3);
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.match(result.reason, /没有确认到真实箱子/);
  assert.equal(result.home_status.safe, true);
  assert.deepEqual(f.opens, []);
  assert.deepEqual(f.places, []);
  assert.equal(f.actions.stations.all().length, 1);
});

test('still-unloaded home blocks remain unknown and cannot trigger a storage fallback', async () => {
  const f = homeFixture(); f.unloaded.add('42,3,2'); f.remember('chest', 41, 1, 1);
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(result.home_status.condition, 'unknown');
  assert.match(result.reason, /未加载/);
  assert.equal(f.actions.stations.all().length, 1);
  assert.deepEqual(f.opens, []);
  assert.deepEqual(f.crafts, []);
});

test('full interior storage cannot substitute an outside container', async () => {
  const f = homeFixture(); f.containers.get('41,1,1').capacity = 0; f.put('barrel', 3);
  const result = await f.run({ resumeWork: true });
  assert.equal(result.ok, false);
  assert.equal(f.inventory.cobblestone, 16);
  assert.deepEqual(f.opens.map((p) => p.x), [41]);
  assert.equal(f.inspect().safe, true);
  assert.equal(f.stages.includes('open-inside'), false);
});

test('a home barrel uses its actual kind even when home discovery recorded generic chest furniture', async () => {
  const f = homeFixture(); f.put('barrel', 41, 1, 1);
  const result = await f.run();
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.consumed, { cobblestone: 16 });
  assert.deepEqual(f.actions.stations.all().map((entry) => entry.kind), ['barrel']);
});

test('home navigation cannot claim arrival without actual body movement', async () => {
  const f = homeFixture(); f.nav.goTo = async () => ({ arrived: true });
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(result.home_status.inside, false);
  assert.deepEqual(f.opens, []);
  assert.equal(f.controls.forward, undefined);
});

test('returning home consumes the existing 20 second search and walking budget', async () => {
  const f = homeFixture(), realNow = Date.now;
  let now = realNow(); Date.now = () => now;
  f.nav.goTo = async (target) => { f.moves.push(target); now += 21000;
    f.bot.entity.position = vec3(target.x, target.y, target.z); return { arrived: true }; };
  try {
    const result = await f.run();
    assert.equal(result.ok, false);
    assert.match(result.reason, /预算|超时/);
    assert.equal(f.moves.length, 1);
    assert.deepEqual(f.opens, []);
    assert.equal(f.controls.forward, undefined);
  } finally { Date.now = realNow; }
});

test('a world change while returning home cancels before opening a new-world door', async () => {
  const f = homeFixture(); f.remember('chest', 41, 1, 1);
  f.nav.goTo = async (target) => { f.bot.entity.position = vec3(target.x, target.y, target.z);
    f.bot.game.dimension = 'the_nether'; return { arrived: true }; };
  await assert.rejects(f.run(), CancelledError);
  assert.deepEqual(f.opens, []);
  assert.equal(f.controls.forward, undefined);
  f.bot.game.dimension = 'overworld';
  assert.equal(f.actions.stations.all().length, 1);
});

test('cancellation while entering the home stops physical controls and cannot open its storage', async () => {
  const f = homeFixture(), original = f.bot.setControlState;
  f.bot.setControlState = (name, value) => { original(name, value);
    if (name === 'forward' && value) setTimeout(() => f.controller.abort(), 5); };
  await assert.rejects(f.run(), CancelledError);
  assert.equal(f.controls.forward, false);
  assert.deepEqual(f.opens, []);
  assert.equal(f.stages.includes('close-inside'), false);
});

test('storage damage after a physical transfer reports consumed items without a safe-home success', async () => {
  const f = homeFixture(), original = f.bot.openContainer;
  f.bot.openContainer = async (block) => {
    if (f.opens.length === 1) f.cells.delete('42,3,2');
    return original(block);
  };
  const result = await f.run({ resumeWork: true });
  assert.equal(result.ok, false);
  assert.deepEqual(result.consumed, { cobblestone: 16 });
  assert.equal(result.home_status.condition, 'missing');
  assert.equal(result.resumed_work, false);
  assert.equal(f.stages.includes('open-inside'), false);
});

test('safe exit failure after storage keeps the actual consumed amount and does not restart work', async () => {
  const f = homeFixture(), nativeMove = f.nav.goTo;
  f.nav.goTo = async (target) => {
    if (f.inventory.cobblestone === 0) throw new Error('inside path blocked');
    return nativeMove(target);
  };
  const result = await f.run({ resumeWork: true });
  assert.equal(result.ok, false);
  assert.deepEqual(result.consumed, { cobblestone: 16 });
  assert.match(result.reason, /无法安全出门/);
  assert.equal(result.resumed_work, false);
  assert.equal(f.inspect().safe, true);
});

test('safe exit uses only the travel budget left after entry and transfer', async () => {
  const f = homeFixture(), original = f.actions.deposit, realNow = Date.now;
  let now = realNow(); Date.now = () => now;
  f.actions.deposit = async (options) => { const stored = await original(options); now += 21000; return stored; };
  try {
    const result = await f.run({ resumeWork: true });
    assert.equal(result.ok, false);
    assert.deepEqual(result.consumed, { cobblestone: 16 });
    assert.match(result.reason, /预算|超时/);
    assert.equal(f.stages.includes('walk-inside'), false);
    assert.equal(f.stages.includes('open-inside'), false);
  } finally { Date.now = realNow; }
});

test('a parent context timeout after transfer preserves consumed and stops all later work', async () => {
  const f = homeFixture(), original = f.actions.deposit;
  f.actions.deposit = async (options) => { const result = await original(options);
    f.ctx.deadline = Date.now() - 1; return result; };
  const result = await f.run({ resumeWork: true });
  assert.equal(result.ok, false);
  assert.deepEqual(result.consumed, { cobblestone: 16 });
  assert.match(result.reason, /已存入|超时/);
  assert.deepEqual(f.opens.map((position) => position.x), [41, 41]);
  assert.equal(f.stages.includes('walk-inside'), false);
});

test('leaveHome cannot accept a crossing claim without real movement', async () => {
  const f = homeFixture(); assert.equal((await f.run()).ok, true);
  f.actions.enterDoor = async () => ({ ok: true });
  const result = await f.leave();
  assert.equal(result.ok, false);
  assert.match(result.reason, /实际走出/);
  assert.equal(result.home_status.inside, true);
  assert.equal(f.stages.includes('close-outside'), false);
});

test('cancellation during physical exit stops controls and never closes or resumes afterwards', async () => {
  const f = homeFixture(); assert.equal((await f.run()).ok, true);
  const original = f.bot.setControlState;
  f.bot.setControlState = (name, value) => { original(name, value);
    if (name === 'forward' && value) setTimeout(() => f.controller.abort(), 5); };
  await assert.rejects(f.leave(), CancelledError);
  assert.equal(f.controls.forward, false);
  assert.equal(f.stages.includes('close-outside'), false);
});

test('respawn during physical entry cancels the home chain and removes temporary listeners', async () => {
  const f = homeFixture(), original = f.bot.setControlState;
  const listeners = f.bot.listenerCount('respawn');
  f.bot.setControlState = (name, value) => { original(name, value);
    if (name === 'forward' && value) setTimeout(() => {
      f.bot.game.dimension = 'the_nether'; f.bot.emit('respawn');
    }, 5); };
  await assert.rejects(f.run(), CancelledError);
  assert.equal(f.controls.forward, false);
  assert.deepEqual(f.opens, []);
  assert.equal(f.stages.includes('close-inside'), false);
  assert.equal(f.bot.listenerCount('respawn'), listeners);
});

test('respawn during physical exit cancels the helper before closing in another world', async () => {
  const f = homeFixture(); assert.equal((await f.run()).ok, true);
  const original = f.bot.setControlState;
  f.bot.setControlState = (name, value) => { original(name, value);
    if (name === 'forward' && value) setTimeout(() => {
      f.bot.game.dimension = 'the_nether'; f.bot.emit('respawn');
    }, 5); };
  await assert.rejects(f.leave(), CancelledError);
  assert.equal(f.controls.forward, false);
  assert.equal(f.stages.includes('close-outside'), false);
  assert.equal(f.bot.listenerCount('respawn'), 0);
});

function nativeCrafting(f) {
  f.bot.version = '1.20.1';
  f.bot.recipesAll = (type) => Recipe.find(type, null);
  f.actions._syncInventoryWindow = async () => {};
  f.actions._clearCraftingGrid = async () => {};
  f.actions._closeWindowsAndSettle = async () => {};
  // Preserve production recipe selection, missing-material checks, table
  // discovery and verified inventory deltas; simulate only accepted game I/O.
  f.actions._craftBatch = async (bot, recipe, table, signal) => {
    if (signal?.aborted) throw new CancelledError('cancelled native crafting');
    if (recipe.requiresTable && !table) throw new Error('Recipe requires craftingTable, but one was not supplied');
    if (table) assert.equal(bot.blockAt(table.position)?.name, 'crafting_table');
    const item = data.items[recipe.result.id].name;
    f.crafts.push(item);
    for (const delta of recipe.delta) {
      const name = data.items[delta.id].name;
      f.inventory[name] = (f.inventory[name] || 0) + delta.count;
      assert(f.inventory[name] >= 0, `accepted recipe cannot consume absent ${name}`);
    }
  };
  f.actions.craft = Actions.prototype.craft.bind(f.actions);
  f.actions._spotInFront = () => {
    const p = f.bot.entity.position;
    return [[1, 0], [1, 1], [0, 1]].map(([dx, dz]) =>
      ({ x: Math.floor(p.x) + dx, y: Math.floor(p.y), z: Math.floor(p.z) + dz }))
      .find((point) => f.bot.blockAt(vec3(point.x, point.y, point.z))?.name === 'air') || null;
  };
  return f;
}

function tallHome() {
  const f = homeFixture({ chest: false });
  f.home.size = 8;
  for (let dx = -1; dx <= 8; dx += 1) for (let dz = -2; dz <= 8; dz += 1) f.put('stone', 40 + dx, 0, dz);
  for (let dx = 0; dx < 8; dx += 1) for (let dz = 0; dz < 8; dz += 1) {
    f.put('cobblestone', 40 + dx, 3, dz);
    for (let y = 1; y <= 2; y += 1) f.put(dx === 0 || dx === 7 || dz === 0 || dz === 7 ? 'cobblestone' : 'air', 40 + dx, y, dz);
  }
  f.door(false);
  f.put('stone', 46, 1, 6); f.put('barrel', 46, 2, 6);
  return f;
}

test('an elevated home barrel is discovered and used after physical entry', async () => {
  const f = homeFixture({ chest: false }); f.put('stone', 41, 1, 1); f.put('barrel', 41, 2, 1);
  const result = await f.run();
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.home_status.furniture.chest, true);
  assert.deepEqual(result.home_status.furniture.chest_position, { x: 41, y: 2, z: 1 });
  assert.deepEqual(result.chest, { x: 41, y: 2, z: 1 });
  assert.equal(f.containers.get('41,2,1').items.cobblestone, 16);
  assert.deepEqual(f.crafts, []); assert.deepEqual(f.places, []);
});

test('a distant elevated home barrel uses a real floor landing inside the home', async () => {
  const f = tallHome(), move = f.nav.goTo;
  f.nav.goTo = async (target) => {
    if (f.inspect().inside) {
      assert.equal(target.y, f.home.origin.y, 'do not stand in/on an elevated container');
      assert.equal(target.range, 0.5); assert.equal(target.segmented, false);
      assert.equal(f.bot.blockAt(vec3(Math.floor(target.x), target.y, Math.floor(target.z)))?.name, 'air');
      assert.equal(f.bot.blockAt(vec3(Math.floor(target.x), target.y + 1, Math.floor(target.z)))?.name, 'air');
    }
    return move(target);
  };
  const result = await f.run();
  assert.equal(result.ok, true, result.reason); assert.deepEqual(result.chest, { x: 46, y: 2, z: 6 });
  assert.equal(f.bot.entity.position.y, 1); assert.equal(f.inspect().safe, true);
  assert.equal(f.containers.get('46,2,6').items.cobblestone, 16);
});

test('an unreachable elevated home barrel cannot use outside storage or claim progress', async () => {
  const f = tallHome(), move = f.nav.goTo; f.put('barrel', 3);
  f.nav.goTo = async (target) => { if (f.inspect().inside) throw new Error('inside route is blocked'); return move(target); };
  const result = await f.run();
  assert.equal(result.ok, false); assert.match(result.reason, /inside route is blocked/);
  assert.equal(f.inventory.cobblestone, 16); assert.deepEqual(f.opens, []);
  assert.deepEqual(f.places, []); assert.equal(f.inspect().safe, true);
});

test('an unknown interior cell prevents a partial scan from authorizing home storage', async () => {
  const f = homeFixture({ chest: false }); f.put('stone', 41, 1, 1); f.put('barrel', 41, 2, 1);
  f.unloaded.add('43,2,3'); f.put('barrel', 3);
  const result = await f.run();
  assert.equal(result.ok, false); assert.match(result.reason, /未加载/);
  assert.equal(f.inventory.cobblestone, 16); assert.deepEqual(f.opens, []); assert.deepEqual(f.places, []);
});

test('unknown home structure cannot publish elevated container furniture or store items', async () => {
  const f = homeFixture({ chest: false }); f.put('barrel', 41, 2, 1); f.unloaded.add('42,3,2');
  const result = await f.run();
  assert.equal(result.ok, false); assert.equal(result.home_status.condition, 'unknown');
  assert.equal(result.home_status.furniture.chest, false); assert.deepEqual(f.opens, []);
});

test('twelve carried planks prepare a real table and chest before confirmed storage', async () => {
  const f = nativeCrafting(fixture({ oak_planks: 12, cobblestone: 16, bread: 4, stone_pickaxe: 1 }));
  const result = await f.run();
  assert.equal(result.ok, true, result.reason); assert.deepEqual(f.crafts, ['crafting_table', 'chest']);
  assert.deepEqual(f.places.map(({ item }) => item), ['crafting_table', 'chest']);
  assert.equal(f.inventory.oak_planks, 0); assert.equal(f.inventory.bread, 4); assert.equal(f.inventory.stone_pickaxe, 1);
  assert.deepEqual(result.consumed, { cobblestone: 16 });
  assert.equal(f.bot.blockAt(vec3(f.places[0].x, f.places[0].y, f.places[0].z)).name, 'crafting_table');
});

test('eight carried planks without a table stop before consuming wood or starting a search', async () => {
  const f = nativeCrafting(fixture({ oak_planks: 8, cobblestone: 16 }));
  const result = await f.run();
  assert.equal(result.ok, false); assert.match(result.reason, /12.*木板/);
  assert.deepEqual(f.inventory, { oak_planks: 8, cobblestone: 16 });
  assert.deepEqual(f.crafts, []); assert.deepEqual(f.places, []); assert.deepEqual(f.moves, []);
});

test('a nearby actual table removes only the table wood budget and is reused', async () => {
  const f = nativeCrafting(fixture({ oak_planks: 8, cobblestone: 16 })); f.put('crafting_table', 3, 1, 1);
  const result = await f.run();
  assert.equal(result.ok, true, result.reason); assert.deepEqual(f.crafts, ['chest']);
  assert.deepEqual(f.places.map(({ item }) => item), ['chest']); assert.equal(f.inventory.oak_planks, 0);
});

test('a remembered actual table is reached within the original budget before chest crafting', async () => {
  const f = nativeCrafting(fixture({ oak_planks: 8, cobblestone: 16 })); f.put('crafting_table', 48); f.remember('crafting_table', 48);
  const result = await f.run();
  assert.equal(result.ok, true, result.reason); assert.deepEqual(f.crafts, ['chest']);
  assert(f.moves.length > 1); assert(f.moves.every((target) => target.segmented === false && target.timeoutMs <= 20000));
  assert.deepEqual(f.places.map(({ item }) => item), ['chest']);
});

test('an unknown remembered table retains its record and cannot trigger duplicate manufacturing', async () => {
  const f = nativeCrafting(fixture({ oak_planks: 12, cobblestone: 16 })); f.put('crafting_table', 48); f.remember('crafting_table', 48);
  f.unloaded.add('48,1,0');
  const result = await f.run();
  assert.equal(result.ok, false); assert.match(result.reason, /工作台仍未加载/);
  assert.equal(f.inventory.oak_planks, 12); assert.deepEqual(f.crafts, []); assert.deepEqual(f.places, []);
  assert.equal(f.actions.stations.all().filter(({ kind }) => kind === 'crafting_table').length, 1);
});

test('independent cancellation while making the missing table stops before chest or placement', async () => {
  const f = nativeCrafting(fixture({ oak_planks: 12, cobblestone: 16 }));
  f.actions.craft = async () => { throw new CancelledError('cancel missing table'); };
  await assert.rejects(f.run(), CancelledError); assert.deepEqual(f.places, []); assert.equal(f.inventory.oak_planks, 12);
});

test('a preparation refusal cannot bypass the missing table and continue crafting a chest', async () => {
  const f = nativeCrafting(fixture({ oak_planks: 12, cobblestone: 16 }));
  f.actions.craft = async ({ item }) => { f.crafts.push(item); const error = new Error('preparation denied'); error.name = 'PreparationBlockedError'; throw error; };
  const result = await f.run();
  assert.equal(result.ok, false); assert.match(result.reason, /preparation denied/);
  assert.deepEqual(f.crafts, ['crafting_table']); assert.deepEqual(f.places, []);
});

test('a claimed table placement without a real block cannot authorize chest crafting', async () => {
  const f = nativeCrafting(fixture({ oak_planks: 12, cobblestone: 16 }));
  f.actions.place = async () => ({ ok: true });
  const result = await f.run();
  assert.equal(result.ok, false); assert.match(result.reason, /没有确认到实际工作台/);
  assert.deepEqual(f.crafts, ['crafting_table']); assert.equal(f.inventory.crafting_table, 1);
  assert.equal(f.inventory.oak_planks, 8); assert.deepEqual(f.opens, []);
});

module.exports = { fixture, homeFixture };
if (require.main === module) (async () => {
  let failures = 0;
  for (const { name, run } of tests) {
    try { await run(); process.stdout.write(`PASS ${name}\n`); }
    catch (error) { failures += 1; process.stderr.write(`FAIL ${name}\n${error.stack}\n`); }
  }
  process.stdout.write(`${tests.length - failures}/${tests.length} passed\n`);
  process.exitCode = failures ? 1 : 0;
})();
