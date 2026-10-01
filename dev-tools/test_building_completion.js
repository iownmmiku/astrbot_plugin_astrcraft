#!/usr/bin/env node
'use strict';

// Exercise the actual shelter, wood, mining and SkillContext implementations.
// Only Minecraft world/inventory updates and navigation I/O are simulated.
process.env.MC_ENGINE_LOG_LEVEL = 'error';
const assert = require('node:assert/strict');
const { buildShelter } = require('../engine/skills/building');
const { SkillContext } = require('../engine/skills/common');
const { vec3, CancelledError } = require('../engine/util');

const tests = [];
const test = (name, run) => tests.push({ name, run });
const key = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;

function worldIO(initial, options = {}) {
  const inventory = { stone_pickaxe: 1, ...initial };
  const world = new Map();
  const placements = [], digs = [], crafts = [], moves = [];
  const controller = new AbortController();
  let successes = 0;
  const setBlock = (x, y, z, name, props = {}) => world.set(key(x, y, z), { name, props });
  const blockAt = (position) => {
    const { x, y, z } = position.floored();
    const repeatingHole = options.repeatHoles && y === 0 && options.holes.some((h) =>
      ((x % 5) + 5) % 5 === h.x && ((z % 5) + 5) % 5 === h.z);
    const value = world.get(key(x, y, z)) || { name: repeatingHole ? 'air' : y <= 0 ? 'stone' : 'air', props: {} };
    const empty = value.name === 'air' || value.name === 'torch' || value.name.endsWith('_door');
    return { name: value.name, position: vec3(x, y, z), boundingBox: empty ? 'empty' : 'block',
      diggable: value.name !== 'air', getProperties: () => ({ ...value.props }) };
  };
  if (options.table !== false) setBlock(-2, 1, 0, 'crafting_table');
  if (options.placedTorch) setBlock(1, 1, 0, 'torch');
  if (options.tree) {
    setBlock(-3, 1, 0, 'oak_log');
    setBlock(-3, 2, 0, 'oak_log');
    setBlock(-3, 3, 0, 'oak_log');
  }
  if (options.noDrops) {
    // Both real mineStone phases have visible targets, so their retry limits can be observed
    // without the unrelated relocation fallback excavating the ground in search of variants.
    for (let x = -13; x >= -17; x -= 1) {
      for (let z = 0; z < 8; z += 1) setBlock(x, 0, z, 'andesite');
    }
  }
  for (const cell of options.holes || []) setBlock(cell.x, 0, cell.z, 'air');
  const bot = {
    entity: { position: vec3(0.5, 1, 0.5), onGround: true },
    inventory: { items: () => Object.entries(inventory).filter(([, count]) => count > 0)
      .map(([name, count]) => ({ name, count, maxDurability: name.endsWith('_pickaxe') ? 131 : 0 })) },
    blockAt,
    findBlocks: ({ matching, count = 16 }) => {
      const found = [];
      // Quarry outside the chosen 5 x 5 shelter; mining must not count foundation holes as free material.
      for (let x = -8; x >= -17 && found.length < count; x -= 1) {
        for (let z = 0; z < 8 && found.length < count; z += 1) {
          const block = blockAt(vec3(x, 0, z));
          if (matching(block)) found.push(block.position);
        }
      }
      return found;
    },
    findBlock: ({ matching }) => {
      for (const [position] of world) {
        const block = blockAt(vec3(...position.split(',').map(Number)));
        if (matching(block)) return block;
      }
      return null;
    },
    canSeeBlock: () => true,
  };
  const actions = {
    bot,
    inventoryMap: () => ({ ...inventory }),
    countItem: (name) => inventory[name] || 0,
    _spotInFront: () => ({ x: -2, y: 1, z: 0 }),
    lookAtPoint: async () => { if (options.cancelOnLook) controller.abort(); },
    dig: async ({ x, y, z }) => {
      const block = blockAt(vec3(x, y, z));
      digs.push({ x, y, z, name: block.name });
      setBlock(x, y, z, 'air');
      const name = block.name === 'stone' ? 'cobblestone' : block.name;
      const collected = {};
      if (name !== 'air' && !options.noDrops) {
        inventory[name] = (inventory[name] || 0) + 1;
        collected[name] = 1;
      }
      return { ok: true, block: block.name, collected };
    },
    craft: async ({ item, count = 1 }) => {
      crafts.push({ item, count });
      let inputs, output;
      if (item.endsWith('_planks')) {
        inputs = { [item.replace('_planks', '_log')]: 1 };
        output = 4;
      } else if (item.endsWith('_door')) {
        assert.ok(bot.findBlock({ matching: (b) => b.name === 'crafting_table' }), 'door requires a real table');
        inputs = { [item.replace('_door', '_planks')]: 6 };
        output = 3;
      } else if (item === 'crafting_table' || item === 'chest') {
        const plank = Object.keys(inventory).find((n) => n.endsWith('_planks') && inventory[n] >= (item === 'chest' ? 8 : 4));
        assert.ok(plank, `${item} requires enough planks`);
        inputs = { [plank]: item === 'chest' ? 8 : 4 };
        output = 1;
      } else throw new Error(`Unsupported fixture recipe ${item}`);
      const batches = Math.ceil(count / output);
      for (const [name, amount] of Object.entries(inputs)) assert.ok((inventory[name] || 0) >= amount * batches, `${item} needs ${amount * batches} ${name}`);
      for (const [name, amount] of Object.entries(inputs)) inventory[name] -= amount * batches;
      inventory[item] = (inventory[item] || 0) + batches * output;
      return { ok: true, produced: batches * output };
    },
    place: async (request) => {
      const { x, y, z, item } = request;
      placements.push({ x, y, z, item });
      if (options.checkReach) assert.ok(bot.entity.position.distanceTo(vec3(x + 0.5, y + 0.5, z + 0.5)) <= 4,
        'builder must stand within reach before placing');
      if (options.cancelAfter && placements.length >= options.cancelAfter) controller.abort();
      if (controller.signal.aborted) throw new CancelledError('fixture cancelled');
      if (options.expireOnPlace) ctx.deadline = Date.now() - 1;
      if (options.limitSuccesses !== undefined && successes >= options.limitSuccesses) return { ok: false };
      if (options.skipCell && x === options.skipCell.x && y === options.skipCell.y && z === options.skipCell.z) return { ok: false };
      if (options.failFurniture && (item === 'chest' || item.endsWith('_bed'))) return { ok: true };
      if (options.noWorldUpdates) return { ok: true };
      if (options.failLastStack === item && inventory[item] === 1) {
        inventory[item] = 0;
        throw new Error(`fixture late inventory update: ${item} exhausted`);
      }
      assert.ok(inventory[item] > 0, `placing ${item} requires inventory`);
      inventory[item] -= 1;
      successes += 1;
      if (item.endsWith('_door')) {
        setBlock(x, y, z, item, { half: options.badDoorHalves ? 'upper' : 'lower' });
        if (!options.lowerDoorOnly) setBlock(x, y + 1, z, item, { half: 'upper' });
      } else setBlock(x, y, z, item);
      return { ok: true };
    },
  };
  const nav = {
    approach: async ({ x, z }) => { bot.entity.position = vec3(x + 1.5, 1, z + 1.5); },
    goTo: async (request) => {
      moves.push(request);
      if (options.failNavigation) throw new Error('fixture unreachable');
      const { x, z } = request;
      bot.entity.position = vec3(x, 1, z);
    },
  };
  const ctx = new SkillContext({ signal: controller.signal, deadline: Date.now() + 5000 });
  const run = (params = {}) => buildShelter({ actions, nav, ctx, state: {}, torch: false, ...params });
  return { run, world, inventory, placements, digs, crafts, moves, ctx, controller, blockAt };
}

function assertCompleteWorld(fixture, result) {
  const { origin, size } = result.shelter;
  const door = result.shelter.door_position;
  for (let dx = 0; dx < size; dx += 1) {
    for (let dz = 0; dz < size; dz += 1) {
      const x = origin.x + dx, z = origin.z + dz;
      assert.equal(fixture.blockAt(vec3(x, origin.y - 1, z)).boundingBox, 'block', 'floor cell missing');
      if (dx === 0 || dz === 0 || dx === size - 1 || dz === size - 1) {
        if (door && x === door.x && z === door.z) {
          assert.match(fixture.blockAt(vec3(x, origin.y, z)).name, /_door$/);
          assert.equal(fixture.blockAt(vec3(x, origin.y, z)).getProperties().half, 'lower');
          assert.equal(fixture.blockAt(vec3(x, origin.y + 1, z)).getProperties().half, 'upper');
        } else {
          assert.equal(fixture.blockAt(vec3(x, origin.y, z)).boundingBox, 'block', 'first wall layer missing');
          assert.equal(fixture.blockAt(vec3(x, origin.y + 1, z)).boundingBox, 'block', 'second wall layer missing');
        }
      }
      if (result.shelter.has_roof) assert.equal(fixture.blockAt(vec3(x, origin.y + 2, z)).boundingBox, 'block', 'roof cell missing');
    }
  }
  assert.equal(result.shelter.missing_floor.length, 0);
  assert.equal(result.shelter.missing_walls.length, 0);
  assert.equal(result.shelter.missing_roof.length, 0);
}

test('one accepted wall cannot report a finished roof or door', async () => {
  const fixture = worldIO({ cobblestone: 55, oak_door: 1 }, { limitSuccesses: 1 });
  const result = await fixture.run();
  assert.equal(result.ok, false);
  assert.equal(result.shelter.complete, false);
  assert.equal(result.shelter.has_roof, false);
  assert.equal(result.shelter.has_door, false);
  assert.equal(result.shelter.missing_walls.length, 29);
  assert.equal(result.shelter.missing_roof.length, 25);
  assert.deepEqual(result.consumed, { cobblestone: 1 });
  assert.ok(fixture.placements.length <= 3 * 55 + 1, 'placement retries must be bounded');
  assert.doesNotMatch(result.note || '', /建好了/);
});

test('an ok placement response without world updates cannot fake success', async () => {
  const fixture = worldIO({ cobblestone: 55, oak_door: 1 }, { noWorldUpdates: true });
  const result = await fixture.run();
  assert.equal(result.ok, false);
  assert.deepEqual(result.consumed, {});
  assert.equal(result.shelter.missing_walls.length, 30);
  assert.equal(result.shelter.missing_roof.length, 25);
});

test('existing ground plus 55 mixed blocks make the complete 5 x 5 shelter without mining', async () => {
  const fixture = worldIO({ cobblestone: 25, dirt: 30, oak_door: 1 });
  const result = await fixture.run();
  assert.equal(result.ok, true, result.reason);
  assertCompleteWorld(fixture, result);
  assert.equal(fixture.digs.length, 0, 'existing foundation must not require extra mining');
  assert.equal(fixture.placements.filter((p) => p.y === 0).length, 0);
  assert.deepEqual(result.consumed, { cobblestone: 25, dirt: 30 });
  assert.equal(result.shelter.has_roof, true);
  assert.equal(result.shelter.has_door, true);
});

test('existing logs become wall materials before any extra mining', async () => {
  const fixture = worldIO({ dirt: 47, oak_log: 2, oak_door: 1 });
  const result = await fixture.run();
  assert.equal(result.ok, true, result.reason);
  assertCompleteWorld(fixture, result);
  assert.equal(fixture.digs.length, 0);
  assert.equal(fixture.inventory.oak_log, 0);
  assert.deepEqual(fixture.crafts, [{ item: 'oak_planks', count: 8 }]);
  assert.deepEqual(result.consumed, { dirt: 47, oak_planks: 8 });
});

test('a delayed exhausted stack switches to the remaining material for the same cell', async () => {
  const fixture = worldIO({ cobblestone: 25, dirt: 31, oak_door: 1 }, { failLastStack: 'cobblestone', checkReach: true });
  const result = await fixture.run();
  assert.equal(result.ok, true, result.reason);
  assertCompleteWorld(fixture, result);
  assert.deepEqual(result.consumed, { cobblestone: 24, dirt: 31 });
});

test('48 existing blocks trigger exactly seven mined blocks, then complete all walls and roof', async () => {
  const fixture = worldIO({ dirt: 48, oak_door: 1 }, { checkReach: true });
  const result = await fixture.run();
  assert.equal(result.ok, true, result.reason);
  assertCompleteWorld(fixture, result);
  assert.equal(fixture.digs.length, 7);
  assert.deepEqual(result.consumed, { cobblestone: 7, dirt: 48 });
  assert.ok(fixture.moves[0].x < result.shelter.origin.x - 3, 'quarry must be outside the foundation');
  assert.ok(fixture.moves.some((m) => m.x === result.shelter.origin.x + 2.5 && m.z === result.shelter.origin.z + 2.5),
    'builder must return to the interior before closing the walls');
});

test('foundation holes are included in actual material demand', async () => {
  const fixture = worldIO({ cobblestone: 55, oak_door: 1 },
    { holes: [{ x: 1, z: 1 }, { x: 3, z: 3 }], repeatHoles: true, checkReach: true });
  const result = await fixture.run();
  assert.equal(result.ok, true, result.reason);
  assertCompleteWorld(fixture, result);
  assert.equal(fixture.digs.length, 2);
  assert.equal(fixture.placements.filter((p) => p.y === 0).length, 2);
  assert.deepEqual(result.consumed, { cobblestone: 57 });
});

test('an intact nearby platform is preferred over the previous mine holes', async () => {
  const fixture = worldIO({ cobblestone: 55, oak_door: 1 }, { holes: [{ x: 1, z: 1 }, { x: 3, z: 3 }], checkReach: true });
  const result = await fixture.run();
  assert.equal(result.ok, true, result.reason);
  assertCompleteWorld(fixture, result);
  assert.equal(fixture.digs.length, 0);
  assert.equal(fixture.placements.filter((p) => p.y === 0).length, 0);
});

test('construction avoids an existing lamp instead of trying to build over it', async () => {
  const fixture = worldIO({ cobblestone: 55, oak_door: 1 }, { placedTorch: true, checkReach: true });
  const result = await fixture.run();
  assert.equal(result.ok, true, result.reason);
  assertCompleteWorld(fixture, result);
  assert.equal(fixture.digs.filter((d) => d.name === 'torch').length, 0);
  assert.equal(fixture.blockAt(vec3(1, 1, 0)).name, 'torch');
});

test('an unreachable construction position stops before placing remote blocks', async () => {
  const fixture = worldIO({ cobblestone: 55, oak_door: 1 }, { failNavigation: true });
  await assert.rejects(fixture.run(), /fixture unreachable/);
  assert.equal(fixture.moves.length, 3);
  assert.equal(fixture.placements.length, 0);
});

test('door crafting reserves six matching planks before selecting wall materials', async () => {
  const fixture = worldIO({ dirt: 51, oak_planks: 10 });
  const result = await fixture.run();
  assert.equal(result.ok, true, result.reason);
  assertCompleteWorld(fixture, result);
  assert.deepEqual(fixture.crafts, [{ item: 'oak_door', count: 1 }]);
  assert.equal(fixture.inventory.oak_door, 2, 'Minecraft produces three doors from six planks');
  assert.equal(fixture.digs.length, 0);
  assert.deepEqual(result.consumed, { dirt: 51, oak_planks: 4 });
});

test('one existing log acquires only the missing wood and prepares the missing crafting table', async () => {
  const fixture = worldIO({ dirt: 53, oak_log: 1 }, { table: false, tree: true });
  const result = await fixture.run();
  assert.equal(result.ok, true, result.reason);
  assertCompleteWorld(fixture, result);
  assert.equal(fixture.digs.filter((d) => d.name === 'oak_log').length, 2);
  assert.deepEqual(fixture.crafts, [
    { item: 'oak_planks', count: 12 }, { item: 'crafting_table', count: 1 }, { item: 'oak_door', count: 1 },
  ]);
  assert.equal(fixture.inventory.oak_log, 0);
  assert.equal(fixture.inventory.oak_planks, 0);
  assert.deepEqual(result.consumed, { dirt: 53, oak_planks: 2 });
});

test('six planks of different species acquire a compatible log before crafting a door', async () => {
  const fixture = worldIO({ dirt: 51, oak_planks: 3, birch_planks: 3 }, { tree: true });
  const result = await fixture.run();
  assert.equal(result.ok, true, result.reason);
  assertCompleteWorld(fixture, result);
  assert.equal(fixture.digs.filter((d) => d.name === 'oak_log').length, 1);
  assert.deepEqual(fixture.crafts, [{ item: 'oak_planks', count: 4 }, { item: 'oak_door', count: 1 }]);
  assert.deepEqual(result.consumed, { dirt: 51, oak_planks: 1, birch_planks: 3 });
});

test('a missing roof cell and incomplete door halves fail structural acceptance', async () => {
  const roof = worldIO({ cobblestone: 55, oak_door: 1 }, { skipCell: { x: 2, y: 3, z: 2 } });
  const roofResult = await roof.run();
  assert.equal(roofResult.ok, false);
  assert.equal(roofResult.shelter.has_roof, false);
  assert.deepEqual(roofResult.shelter.missing_roof, [{ x: 2, y: 3, z: 2 }]);
  for (const option of [{ lowerDoorOnly: true }, { badDoorHalves: true }]) {
    const door = worldIO({ cobblestone: 55, oak_door: 1 }, option);
    const result = await door.run();
    assert.equal(result.ok, false);
    assert.equal(result.shelter.has_door, false);
    assert.equal(result.shelter.has_roof, true);
  }
});

test('optional furniture failure reports false flags without rejecting the complete structure', async () => {
  const fixture = worldIO({ cobblestone: 55, oak_door: 1, chest: 1, white_bed: 1 }, { failFurniture: true });
  const result = await fixture.run();
  assert.equal(result.ok, true, result.reason);
  assertCompleteWorld(fixture, result);
  assert.equal(result.shelter.furnished.chest, false);
  assert.equal(result.shelter.furnished.bed, false);
  assert.doesNotMatch(result.note, /有箱子|有床/);
});

test('collecting no material terminates instead of starting a partial house', async () => {
  const fixture = worldIO({ cobblestone: 48, oak_door: 1 }, { noDrops: true });
  const result = await fixture.run();
  assert.equal(result.ok, false);
  assert.equal(fixture.placements.length, 0);
  assert.ok(fixture.digs.length <= 80, 'real mineStone retry budget must remain bounded');
});

test('cancellation and expired deadline stop further physical writes', async () => {
  const cancelled = worldIO({ cobblestone: 55, oak_door: 1 }, { cancelAfter: 2 });
  await assert.rejects(cancelled.run(), CancelledError);
  assert.equal(cancelled.placements.length, 2);
  const expired = worldIO({ cobblestone: 55, oak_door: 1 }, { expireOnPlace: true });
  await assert.rejects(expired.run(), /技能执行超时/);
  assert.equal(expired.placements.length, 1);
  const doorLook = worldIO({ cobblestone: 55, oak_door: 1 }, { cancelOnLook: true });
  await assert.rejects(doorLook.run(), CancelledError);
  assert.equal(doorLook.placements.filter((p) => p.item.endsWith('_door')).length, 0);
});

test('roof omitted explicitly is reported absent while the requested walls and door are complete', async () => {
  const fixture = worldIO({ cobblestone: 30, oak_door: 1 });
  const result = await fixture.run({ roof: false });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.shelter.has_roof, false);
  assert.equal(result.shelter.has_door, true);
  assertCompleteWorld(fixture, result);
  assert.equal(fixture.placements.length, 31);
});

(async () => {
  let passed = 0;
  for (const { name, run } of tests) {
    try { await run(); passed += 1; console.log(`PASS ${name}`); }
    catch (err) { console.error(`FAIL ${name}: ${err.stack}`); }
  }
  console.log(`${passed}/${tests.length} building completion scenarios passed`);
  process.exitCode = passed === tests.length ? 0 : 1;
})().catch((err) => { console.error(err); process.exitCode = 1; });
