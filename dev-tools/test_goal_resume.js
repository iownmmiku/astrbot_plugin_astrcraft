#!/usr/bin/env node
'use strict';

process.env.MC_ENGINE_LOG_LEVEL = 'error';
const assert = require('node:assert/strict');
const { world } = require('./test_collection_progress');
const { delay, vec3 } = require('../engine/util');
const miningReturn = require('../engine/skills/mining_return');

const tests = [];
const test = (name, run) => tests.push({ name, run });

async function pausedCollection({ skill = 'mine_ores', params = { ore: 'coal', count: 8 },
  inventory = { stone_pickaxe: 1, coal: 5 }, blocks = Array(18).fill('coal_ore'), pauseAt = 2 } = {}) {
  const w = world({ inventory, blocks });
  const originalDig = w.actions.dig;
  let paused = false;
  w.actions.dig = async (options) => {
    const result = await originalDig(options);
    if (!paused && w.digs === pauseAt) {
      paused = true;
      w.engine.queue.cancel(w.engine.queue.current.id);
    }
    return result;
  };
  const task = w.engine.submitSkill({ skill, params });
  await assert.rejects(task.promise);
  await delay(1);
  assert.equal(task.status, 'cancelled');
  assert.equal(w.digs, pauseAt);
  return { w, task, skill, params };
}

test('manual pause resumes original eight coal, including existing five', async () => {
  const { w, task, skill, params } = await pausedCollection();
  const resumed = w.engine.submitSkill({ skill, params: { ...params }, resumeTaskId: task.id });
  const result = await resumed.promise;
  assert.equal(result.ok, true);
  assert.equal(result.gained, 8);
  assert.equal(w.counts.coal, 13);
  assert.equal(w.digs, 8);
  assert.deepEqual(result.produced, { coal: 8 });
  assert.equal(result.return_status.ok, true);
  assert.throws(() => w.engine.submitSkill({ skill, params, resumeTaskId: task.id }), /失效/);
});

test('manual pause of log harvesting resumes remaining six logs', async () => {
  const { w, task, skill, params } = await pausedCollection({ skill: 'chop_tree', params: { count: 8 },
    inventory: { oak_log: 5 }, blocks: Array(18).fill('oak_log') });
  const result = await w.engine.submitSkill({ skill, params, resumeTaskId: task.id }).promise;
  assert.equal(result.ok, true);
  assert.equal(w.counts.oak_log, 13);
  assert.equal(w.digs, 8);
  assert.deepEqual(result.produced, { oak_log: 8 });
});

test('manual pause of building stone resumes original material obligation', async () => {
  const { w, task, skill, params } = await pausedCollection({ skill: 'mine_stone', params: { count: 8 },
    inventory: { stone_pickaxe: 1, cobblestone: 5 }, blocks: Array(18).fill('stone') });
  const result = await w.engine.submitSkill({ skill, params, resumeTaskId: task.id }).promise;
  assert.equal(result.ok, true);
  assert.equal(w.counts.cobblestone, 13);
  assert.equal(w.digs, 8);
  assert.deepEqual(result.produced, { cobblestone: 8 });
  assert.equal(result.return_status.ok, true);
});

for (const [item, block] of [['coal', 'coal_ore'], ['cobblestone', 'stone']]) {
  for (const pauseAt of [1, 3]) {
    test(`collect ${item} resumes its total inventory goal and original return after drop ${pauseAt}`, async () => {
      const w = world({ inventory: { stone_pickaxe: 1, [item]: 5 }, blocks: Array(10).fill(block) });
      const originalDig = w.actions.dig, originalBlockAt = w.engine.bot.blockAt;
      const entrance = { x: 0.5, y: 1, z: 0.5 }, returns = [];
      let inMine = false, paused = false;
      w.engine.bot.blockAt = (p) => inMine && p.y >= -3 && p.y <= -2
        ? { name: 'air', position: p, diggable: false, boundingBox: 'empty' }
        : originalBlockAt(p);
      w.engine.nav.goTo = async (p) => {
        returns.push({ x: p.x, y: p.y, z: p.z });
        w.engine.bot.entity.position = vec3(p.x, p.y, p.z);
      };
      w.actions.dig = async (p) => {
        const result = await originalDig(p);
        inMine = true;
        w.engine.bot.entity.position = vec3(0.5, -3, 0.5);
        if (!paused && w.digs === pauseAt) {
          paused = true;
          w.engine.queue.cancel(w.engine.queue.current.id);
        }
        return result;
      };
      const params = { item, count: 8 };
      const task = w.engine.submitSkill({ skill: 'collect', params });
      await assert.rejects(task.promise);
      await delay(1);
      assert.equal(task.status, 'cancelled');
      assert.equal(w.counts[item], 5 + pauseAt);
      assert.equal(miningReturn.safePosition(w.engine.bot), false);
      assert.equal(task._skillCheckpoints.has(miningReturn.RETURN_STATUS_KEY), false,
        'cancellation may precede publishing a return result');

      w.engine.queue.setPaused(true);
      const resumed = w.engine.submitSkill({ skill: 'collect', params: { ...params }, resumeTaskId: task.id });
      // The original cancelled coroutine must not be able to change the new
      // collect wrapper's saved child quantity, inventory baseline or entrance.
      const wrapper = [...task._skillCheckpoints.values()].find((entry) => entry?.gather);
      assert.equal(wrapper.gather.want, 3);
      wrapper.gather.want = 9999;
      wrapper.before[item] = 9999;
      [...task._skillCheckpoints.values()].find((entry) => entry?.returnTarget).returnTarget.y = -99;
      w.engine.queue.setPaused(false);
      const result = await resumed.promise;
      assert.equal(result.ok, true);
      assert.equal(w.counts[item], 8, 'collect count is total stock, not eight additional items');
      assert.equal(w.digs, 3, 'already accepted drops must not be gathered again');
      assert.deepEqual(result.produced, { [item]: 3 });
      assert.equal(result.return_status.ok, true);
      assert.deepEqual(result.return_status.target, entrance);
      assert.deepEqual(returns, [entrance]);
      assert.equal(miningReturn.safePosition(w.engine.bot), true);
    });
  }
}

test('pause after final collected drop does not collect a second batch', async () => {
  const { w, task, skill, params } = await pausedCollection({ pauseAt: 8 });
  const result = await w.engine.submitSkill({ skill, params, resumeTaskId: task.id }).promise;
  assert.equal(result.ok, true);
  assert.equal(w.counts.coal, 13);
  assert.equal(w.digs, 8);
  assert.equal(result.return_status.ok, true);
});

test('continuation checkpoints are isolated from late cancelled context writes', async () => {
  const { w, task, skill, params } = await pausedCollection();
  const old = task._skillCheckpoints;
  const original = [...old.values()].find((entry) => Number.isFinite(entry?.initialHave));
  assert.ok(original);
  w.engine.queue.setPaused(true);
  const resumed = w.engine.submitSkill({ skill, params, resumeTaskId: task.id });
  original.initialHave = 9999;
  old.set('late-cancelled-key', { want: 9999 });
  w.engine.queue.setPaused(false);
  const result = await resumed.promise;
  assert.equal(result.ok, true);
  assert.equal(w.digs, 8);
  assert.equal(resumed._skillCheckpoints.has('late-cancelled-key'), false);
});

test('resume reference rejects changed skill or params and unknown task', async () => {
  const { w, task, skill, params } = await pausedCollection();
  assert.throws(() => w.engine.submitSkill({ skill, params, resumeTaskId: 'foreign-task' }), /失效/);
  assert.throws(() => w.engine.submitSkill({ skill: 'mine_stone', params, resumeTaskId: task.id }), /失效/);
  assert.throws(() => w.engine.submitSkill({ skill, params: { ...params, count: 9 }, resumeTaskId: task.id }), /失效/);
  const result = await w.engine.submitSkill({ skill, params, resumeTaskId: task.id }).promise;
  assert.equal(result.ok, true, 'rejected references must not consume the valid continuation');
});

test('resume reference rejects death, respawn, reconnect, dimension and socket changes', async () => {
  for (const change of [
    (w) => { w.engine.bot.health = 0; },
    (w) => { w.engine._bodyLifecycle += 1; },
    (w) => { w.engine.bot.entity = { ...w.engine.bot.entity }; },
    (w) => { w.engine.bot = { ...w.engine.bot }; },
    (w) => { w.engine.bot.game = { dimension: 'the_nether' }; },
    (w) => { w.engine.bot._client = { socket: { destroyed: false } }; },
    (w) => { w.engine._manualDisconnect = true; },
  ]) {
    const { w, task, skill, params } = await pausedCollection();
    change(w);
    assert.throws(() => w.engine.submitSkill({ skill, params, resumeTaskId: task.id }), /失效/);
    assert.equal(w.digs, 2);
  }
});

test('non-collection cancelled tasks cannot advertise checkpoint restoration', async () => {
  const w = world();
  w.engine.queue.setPaused(true);
  const task = w.engine.submitSkill({ skill: 'craft', params: { item: 'torch', count: 8 } });
  w.engine.queue.cancel(task.id);
  await assert.rejects(task.promise);
  assert.throws(() => w.engine.submitSkill({ skill: 'craft', params: { item: 'torch', count: 8 },
    resumeTaskId: task.id }), /失效/);
});

(async () => {
  let failures = 0;
  for (const { name, run } of tests) {
    try { await run(); process.stdout.write(`PASS ${name}\n`); }
    catch (err) { failures++; process.stderr.write(`FAIL ${name}\n${err.stack}\n`); }
  }
  process.stdout.write(`${tests.length - failures}/${tests.length} passed\n`);
  process.exitCode = failures ? 1 : 0;
})();
