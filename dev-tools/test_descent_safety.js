'use strict';

// Actual descent/relocation code; only world I/O and physics are simulated.
const assert = require('node:assert/strict');
const { vec3, CancelledError } = require('../engine/util');
const { canDigDownSafely, digStepUp, stairUpOne, climbToSurface } = require('../engine/skills/common');
const { digDownStaircase } = require('../engine/skills/mining');
const { relocate, digToward } = require('../engine/skills/wood');
const tests = [];
const test = (name, run) => tests.push({ name, run });
const key = (x, y, z) => `${x},${y},${z}`;
function world({ terrain = (p) => p.y < 1 ? 'stone' : 'air', move = true, fall = false } = {}) {
  const cells = new Map();
  const digs = [], moves = [];
  const bot = {
    entity: { position: vec3(0.5, 1, 0.5), onGround: true },
    blockAt(p) {
      const name = cells.has(key(p.x, p.y, p.z)) ? cells.get(key(p.x, p.y, p.z)) : terrain(p);
      if (name == null) return null;
      const empty = ['air', 'cave_air', 'lava', 'water', 'powder_snow'].includes(name);
      return { name, position: p, boundingBox: empty ? 'empty' : 'block', diggable: name !== 'bedrock' };
    },
  };
  const actions = { bot, async dig(p) {
    digs.push({ x: p.x, y: p.y, z: p.z });
    cells.set(key(p.x, p.y, p.z), 'air');
    if (fall && p.x === Math.floor(bot.entity.position.x) && p.z === Math.floor(bot.entity.position.z) &&
        p.y === Math.floor(bot.entity.position.y) - 1) bot.entity.position.y -= 1;
  } };
  const nav = { async goTo(p) {
    moves.push(p);
    if (move) bot.entity.position = vec3(p.x, p.y, p.z);
    return { arrived: true };
  } };
  const controller = new AbortController();
  const ctx = { signal: controller.signal, progress() {}, checkAborted() {
    if (controller.signal.aborted) throw new CancelledError('test cancellation');
  } };
  return { bot, actions, nav, ctx, cells, digs, moves, controller };
}

for (const name of ['lava', 'water', 'air', null, 'gravel', 'sand', 'magma_block', 'powder_snow']) {
  test(`reject landing ${name}`, () => {
    const w = world();
    w.cells.set(key(1, -1, 0), name);
    assert.equal(canDigDownSafely(w.bot, 1, 1, 0), false);
  });
}
test('bedrock remains a valid landing floor', () => {
  const w = world({ terrain: (p) => p.y === -1 ? 'bedrock' : p.y === 0 ? 'stone' : 'air' });
  assert.equal(canDigDownSafely(w.bot, 1, 1, 0), true);
});
test('waterlogged support is never removed', () => {
  const w = world(); const read = w.bot.blockAt;
  w.bot.blockAt = (p) => {
    const b = read(p);
    if (p.x === 1 && p.y === 0 && p.z === 0) b.getProperties = () => ({ waterlogged: true });
    return b;
  };
  assert.equal(canDigDownSafely(w.bot, 1, 1, 0), false);
});
for (const height of [1, 2]) {
  test(`clearing body cell avoids adjacent lava at height ${height}`, async () => {
    const w = world({ terrain: (p) => p.y < 3 ? 'stone' : 'air' });
    w.cells.set(key(2, height, 0), 'lava');
    await digDownStaircase({ ...w, layers: 1 });
    assert.equal(w.digs.some((p) => p.x === 1 && p.z === 0), false);
  });
}
for (const name of ['lava', 'water', null]) {
  test(`reject opening side ${name}`, () => {
    const w = world(); w.cells.set(key(2, 0, 0), name);
    assert.equal(canDigDownSafely(w.bot, 1, 1, 0), false);
  });
}
test('unsafe ground causes no digging and no reported descent', async () => {
  const w = world({ terrain: (p) => p.y === -1 ? 'lava' : p.y === 0 ? 'stone' : 'air' });
  assert.equal(await digDownStaircase({ ...w, layers: 1 }), false);
  assert.equal(w.digs.length, 0);
  assert.equal(w.moves.length, 0);
});
test('unknown ground causes no digging', async () => {
  const w = world({ terrain: (p) => p.y === -1 ? null : p.y === 0 ? 'stone' : 'air' });
  assert.equal(await digDownStaircase({ ...w, layers: 1 }), false);
  assert.equal(w.digs.length, 0);
});
test('skip lava direction and use the safe next direction', async () => {
  const w = world(); w.cells.set(key(1, -1, 0), 'lava');
  assert.equal(await digDownStaircase({ ...w, layers: 1 }), true);
  assert.deepEqual(w.digs, [{ x: 0, y: 0, z: 1 }]);
  assert.equal(w.bot.entity.position.y, 0);
  assert.equal(w.cells.has(key(0, 0, 0)), false, 'original support must remain');
  assert.equal(w.moves[0].segmented, false);
  assert.equal(w.moves[0].y, 0);
});
test('three staircase layers report three actual descents', async () => {
  const w = world(); const steps = [];
  assert.equal(await digDownStaircase({ ...w, layers: 3, steps }), true);
  assert.equal(w.bot.entity.position.y, -2);
  assert.equal(steps.length, 3);
  assert.match(steps[2], /3/);
});
test('navigation returning success without movement is not descent', async () => {
  const w = world({ move: false }); const steps = [];
  assert.equal(await digDownStaircase({ ...w, layers: 1, steps }), false);
  assert.equal(steps.length, 0);
  assert.equal(w.bot.entity.position.y, 1);
});
test('recheck ground after clearing blocks before digging support', async () => {
  const w = world({ terrain: (p) => p.y < 3 ? 'stone' : 'air' });
  const dig = w.actions.dig;
  w.actions.dig = async (p) => {
    await dig(p);
    if (p.y >= 1) w.cells.set(key(p.x, -1, p.z), 'lava');
  };
  assert.equal(await digDownStaircase({ ...w, layers: 1 }), false);
  assert.equal(w.digs.some((p) => p.y === 0), false);
});
test('falling ceiling rejects the direction before clearing it', async () => {
  const w = world({ terrain: (p) => p.y === 3 ? 'sand' : p.y < 3 ? 'stone' : 'air' });
  assert.equal(await digDownStaircase({ ...w, layers: 1 }), false);
  assert.equal(w.digs.length, 0);
});
test('vertical relocation refuses lava below its support', async () => {
  const w = world({ terrain: (p) => p.x === 0 && p.z === 0 ?
    (p.y === 0 ? 'stone' : p.y === -1 ? 'lava' : 'air') : 'air' });
  assert.equal(await relocate({ ...w, attempt: 1 }), false);
  assert.equal(w.digs.length, 0);
});
test('vertical relocation checks and confirms each actual layer', async () => {
  const w = world({ fall: true, terrain: (p) => p.y < 1 ?
    (p.x === 0 && p.z === 0 ? 'stone' : 'bedrock') : 'air' });
  assert.equal(await relocate({ ...w, attempt: 1 }), true);
  assert.equal(w.bot.entity.position.y, -3);
  assert.equal(w.digs.length, 4);
});
test('cancelled descent never edits terrain', async () => {
  const w = world(); w.controller.abort();
  await assert.rejects(digDownStaircase({ ...w }), CancelledError);
  assert.equal(w.digs.length, 0);
});

for (const name of ['NoToolError', 'PreparationBlockedError', 'ProtectedBlockError', 'ProtectedHomeError']) {
  test(`descent propagates ${name} instead of trying every direction`, async () => {
    const w = world({ terrain: (p) => p.y < 3 ? 'stone' : 'air' });
    let attempts = 0;
    const error = Object.assign(new Error('descent must hand back to its parent'), { name });
    w.actions.dig = async () => { attempts += 1; throw error; };
    await assert.rejects(digDownStaircase({ ...w, layers: 4 }), (caught) => caught === error);
    assert.equal(attempts, 1);
    assert.equal(w.moves.length, 0);
  });
}

test('tool exhaustion after one descent retains its accepted steps and stops immediately', async () => {
  const w = world(), steps = []; const dig = w.actions.dig;
  let attempts = 0;
  const error = Object.assign(new Error('last pickaxe broke'), { name: 'NoToolError' });
  w.actions.dig = async (p) => { if (++attempts > 1) throw error; await dig(p); };
  await assert.rejects(digDownStaircase({ ...w, layers: 4, steps }), (caught) => caught === error);
  assert.equal(attempts, 2);
  assert.equal(w.moves.length, 1);
  assert.equal(steps.length, 1);
  assert.equal(w.bot.entity.position.y, 0);
});

for (const landing of ['airborne', 'lava', 'unknown', 'waterlogged', 'blocked-footprint']) {
  test(`descent stops at an unverified ${landing} landing before opening another tunnel`, async () => {
    const w = world(), steps = []; const move = w.nav.goTo, read = w.bot.blockAt;
    let landed = false;
    w.bot.blockAt = (p) => {
      const block = read(p);
      if (landed && landing === 'waterlogged' && p.x === 1 && p.y === -1 && p.z === 0)
        block.getProperties = () => ({ waterlogged: true });
      return block;
    };
    w.nav.goTo = async (p) => {
      const result = await move(p); landed = true;
      if (landing === 'airborne') w.bot.entity.onGround = false;
      if (landing === 'lava' || landing === 'unknown')
        w.cells.set(key(1, 0, 0), landing === 'lava' ? 'lava' : null);
      if (landing === 'blocked-footprint') w.bot.entity.position.x -= 0.45;
      return result;
    };
    await assert.rejects(digDownStaircase({ ...w, layers: 4, steps }), /落地|落脚/);
    assert.equal(w.digs.length, 1);
    assert.equal(w.moves.length, 1);
    assert.equal(steps.length, 0);
  });
}
test('descent waits briefly for actual ground contact after navigation resolves', async () => {
  const w = world(), move = w.nav.goTo;
  w.nav.goTo = async (p) => {
    const result = await move(p); w.bot.entity.onGround = false;
    setTimeout(() => { w.bot.entity.onGround = true; }, 80);
    return result;
  };
  assert.equal(await digDownStaircase({ ...w, layers: 1 }), true);
  assert.equal(w.digs.length, 1);
  assert.equal(w.bot.entity.onGround, true);
});
test('cancellation interrupts the wait for descent ground contact', async () => {
  const w = world(), move = w.nav.goTo;
  w.nav.goTo = async (p) => {
    const result = await move(p); w.bot.entity.onGround = false;
    setTimeout(() => w.controller.abort(), 20);
    return result;
  };
  await assert.rejects(digDownStaircase({ ...w, layers: 4 }), CancelledError);
  assert.equal(w.digs.length, 1);
  assert.equal(w.moves.length, 1);
});
test('a navigation deviation stops descent before digging from the old grid coordinates', async () => {
  const w = world();
  w.nav.goTo = async (p) => {
    w.moves.push(p); w.bot.entity.position = vec3(3.5, 0, 0.5);
    return { arrived: true };
  };
  await assert.rejects(digDownStaircase({ ...w, layers: 4 }), /偏离|落地/);
  assert.equal(w.digs.length, 1); assert.equal(w.moves.length, 1);
});
test('descent can finish a short fall that begins above the target grid cell', async () => {
  const w = world();
  w.nav.goTo = async (p) => {
    w.moves.push(p); w.bot.entity.position = vec3(p.x, p.y + 1.01, p.z);
    w.bot.entity.onGround = false;
    setTimeout(() => { w.bot.entity.position.y = p.y; w.bot.entity.onGround = true; }, 80);
    return { arrived: true };
  };
  assert.equal(await digDownStaircase({ ...w, layers: 1 }), true);
  assert.equal(w.bot.entity.position.y, 0);
  assert.equal(w.bot.entity.onGround, true);
  assert.equal(w.digs.length, 1); assert.equal(w.moves.length, 1);
});

for (const name of ['lava', 'air', null, 'gravel', 'magma_block']) {
  test(`buried-target recovery never removes support over ${name}`, async () => {
    const w = world(); w.cells.set(key(0, -1, 0), name);
    assert.equal(await digToward({ ...w, target: { x: 0, y: -2, z: 0 } }), false);
    assert.equal(w.digs.length, 0);
  });
}
test('buried-target recovery opens a safe layer without chasing drops', async () => {
  const w = world(); const dig = w.actions.dig;
  w.actions.dig = async (params) => { assert.equal(params.collect, false); await dig(params); };
  assert.equal(await digToward({ ...w, target: { x: 0, y: -2, z: 0 } }), true);
  assert.deepEqual(w.digs, [{ x: 0, y: 0, z: 0 }]);
});

function ascentWorld() {
  const w = world({ terrain: (p) => p.y < 4 && (p.x !== 0 || p.z !== 0 || p.y < 1) ? 'stone' : 'air' });
  w.actions.countItem = () => 0;
  return w;
}
for (const obstacle of ['lava', 'water', null, 'gravel']) {
  test(`ascent rejects all directions with ${obstacle} behind the wall or ceiling`, async () => {
    for (const operation of [digStepUp, climbToSurface]) {
      const w = ascentWorld();
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        w.cells.set(key(dx * (obstacle === 'gravel' ? 1 : 2), obstacle === 'gravel' ? 4 : 2,
          dz * (obstacle === 'gravel' ? 1 : 2)), obstacle);
        // Also block the level side tunnel and its head.
        w.cells.set(key(dx * 2, 1, dz * 2), obstacle === 'gravel' ? 'lava' : obstacle);
      }
      w.cells.set(key(0, 4, 0), obstacle === 'gravel' ? obstacle : 'stone');
      const result = await operation({ ...w, bx: 0, by: 1, bz: 0, maxSteps: 1 });
      assert.equal(typeof result === 'object' ? result.ok : result, false);
      assert.equal(w.digs.length, 0);
      assert.equal(w.moves.length, 0);
    }
  });
}
test('ascent rechecks lava revealed after opening the first cell', async () => {
  const w = ascentWorld(); const dig = w.actions.dig;
  w.actions.dig = async (p) => {
    await dig(p);
    w.cells.set(key(p.x, p.y + 2, p.z), 'lava');
  };
  assert.equal(await digStepUp({ ...w, bx: 0, by: 1, bz: 0 }), false);
  assert.equal(w.digs.length, 4, 'only the first cell in each direction may open');
  assert.equal(w.moves.length, 0);
});
test('safe digging ascent opens two cells and lands on their support', async () => {
  const w = ascentWorld();
  assert.equal(await digStepUp({ ...w, bx: 0, by: 1, bz: 0 }), true);
  assert.equal(w.digs.length, 2);
  assert.equal(w.bot.entity.position.y, 2);
});
test('sand alone is not consumed as an unsupported escape platform', async () => {
  const w = world(); w.actions.countItem = (name) => name === 'sand' ? 8 : 0;
  w.actions.place = async () => { throw new Error('falling support must not be placed'); };
  assert.equal(await stairUpOne({ ...w, bx: 0, by: 1, bz: 0 }), false);
  assert.equal(w.moves.length, 0);
});

(async () => {
  let failed = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (err) { failed++; console.error(`FAIL ${name}\n${err.stack}`); }
  }
  console.log(`${tests.length - failed}/${tests.length} passed`);
  if (failed) process.exitCode = 1;
})();
