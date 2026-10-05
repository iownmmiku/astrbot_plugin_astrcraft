'use strict';
/**
 * 身体层 S3 的测试：**抢占之后不白费**（见 docs/BODY_LAYER.md）。
 *
 * 队列用"取消 + 重新排队"重跑技能；技能必须保留同一任务的原始目标，
 * 才不会把恢复时的背包重新当作起点、多收集一整批。
 *
 * 这个测试钉住四件事：
 *   1. 被抢的任务**放回队头**（不是丢掉），而且**真的会重跑**
 *   2. 被抢的次数被记下来（preemptCount / preemptedBy）
 *   3. **重跑不白费**：真实技能被抢占后只完成原始剩余数量，产出如实报告
 *   4. blueprint 那种"逐格放"的技能会**跳过已经放好的**（可续建）
 *
 * 不需要服务器。
 */

const path = require('path');
const { TaskQueue, PRIORITY } = require(path.join(__dirname, '..', 'engine', 'goals'));

let pass = 0;
let fail = 0;
const ok = (m, c, d = '') => {
  if (c) {
    pass += 1;
    console.log(`  ✅ ${m}${d ? ` — ${d}` : ''}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${m}${d ? ` — ${d}` : ''}`);
  }
};

const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('=== 被抢的任务放回队头，而且会重跑 ===');
  {
    const q = new TaskQueue();
    // **把防抖动阈值清零**：这一节要测的是"抢占后不白费"，
    // 而 S4 的防抖动（最小占用时间/冷却）会**故意**拦下抢占
    // ——那是它的正确行为，不是 bug。要测抢占本身就得先关掉它。
    q.minOccupancyMs = 0;
    q.preemptCooldownMs = 0;
    q.maxPreemptsPerTask = 99;
    let lowRuns = 0;
    const low = q.submit({
      name: '长任务',
      priority: PRIORITY.SKILL,
      preemptible: true,
      run: async ({ signal }) => {
        lowRuns += 1;
        // 真任务会检查 signal（抢占是软取消）
        for (let i = 0; i < 40; i += 1) {
          if (signal && signal.aborted) throw new Error('被抢占');
          await sleep(25);
        }
      },
    });
    await tick();
    await tick();
    ok('长任务开始跑了', lowRuns === 1, `跑了 ${lowRuns} 次`);

    // 高出价的本能来抢
    const high = q.submit({
      name: '溺水换气',
      priority: PRIORITY.CRITICAL,
      preemptible: true,
      run: async () => {
        await sleep(150);
      },
    });
    await sleep(120);
    ok('长任务被记了一次抢占', low.preemptCount === 1, `preemptCount=${low.preemptCount}`);
    ok('记下了是谁抢的', low.preemptedBy === '溺水换气', `preemptedBy=${low.preemptedBy}`);
    ok('抢占统计 +1', q.stats.preempted === 1, `stats.preempted=${q.stats.preempted}`);

    // 等本能做完，被抢的任务应该**重新跑起来**
    await high.promise;
    await low.promise;
    await tick();
    ok(
      '被抢的长任务**重新跑起来了**（不是被丢掉）',
      lowRuns >= 2,
      `长任务一共跑了 ${lowRuns} 次（>=2 说明重跑了）`,
    );
    const inHistory = (q.history || []).some((t) => t.task_id === low.id && t.status === 'done');
    ok('重跑确实完成且记入历史，没有把中断记成失败', inHistory && low.status === 'done' && q.stats.cancelled === 0,
      `history 命中=${inHistory}，status=${low.status}`);
    ok(
      '**重跑不白费的前提成立**：被抢的任务会重新执行同一段 run',
      lowRuns >= 2,
      `run 被调用了 ${lowRuns} 次`,
    );
    await q.cancelAll({ reason: '测试结束' });
  }

  console.log('\n=== 重跑不白费：技能按"已经做到哪"算差值 ===');
  {
    // Execute McEngine.submitSkill -> TaskQueue -> actual skills with deterministic
    // world I/O. Source spelling cannot prove that a replay keeps its original goal.
    const { world } = require('./test_collection_progress');
    const scenarios = [
      { label: '砍树', skill: 'chop_tree', params: { count: 8 }, inventory: { oak_log: 3 },
        block: 'oak_log', item: 'oak_log', expectedStock: 11, expectedDigs: 8, preemptAt: [2, 5] },
      { label: '煤矿', skill: 'mine_ores', params: { ore: 'coal', count: 8 }, inventory: { stone_pickaxe: 1, coal: 4 },
        block: 'coal_ore', item: 'coal', expectedStock: 12, expectedDigs: 8, preemptAt: [2, 5] },
      { label: '铁矿', skill: 'mine_ores', params: { ore: 'iron', count: 8 }, inventory: { stone_pickaxe: 1, raw_iron: 5, iron_ingot: 7 },
        block: 'iron_ore', item: 'raw_iron', expectedStock: 13, expectedDigs: 8, preemptAt: [2, 5] },
      { label: '收集圆石', skill: 'collect', params: { item: 'cobblestone', count: 8 }, inventory: { stone_pickaxe: 1, cobblestone: 4 },
        block: 'stone', item: 'cobblestone', expectedStock: 8, expectedDigs: 4, preemptAt: [2] },
    ];
    for (const scenario of scenarios) {
      const w = world({ inventory: scenario.inventory, blocks: Array(16).fill(scenario.block), preemptAt: scenario.preemptAt });
      const task = w.engine.submitSkill({ skill: scenario.skill, params: scenario.params });
      const result = await task.promise;
      ok(`${scenario.label}实际被抢占后完成，而不是丢弃`, task.status === 'done' && task.preemptCount === scenario.preemptAt.length);
      ok(`${scenario.label}只补原始剩余量，不按恢复时背包重新加一批`, w.digs === scenario.expectedDigs && w.counts[scenario.item] === scenario.expectedStock,
        `挖掘 ${w.digs} 次，库存 ${w.counts[scenario.item]}`);
      if (scenario.skill !== 'collect') {
        ok(`${scenario.label}报告包含抢占前后的完整实际产出`, result.produced[scenario.item] === scenario.expectedDigs);
      }
    }
  }

  console.log('\n=== 逐格放置的技能会跳过已经放好的（blueprint）===');
  {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'skills', 'blueprint.js'), 'utf8');
    ok(
      'blueprint 有"已经是目标方块就跳过"',
      /cur\.name === cell\.name/.test(src) && /skipped\.push/.test(src),
    );
    ok('报告里会说"跳过 N 块（已经是了）"', /跳过 \$\{skipped\.length\} 块/.test(src));
  }

  console.log('\n=== S4 防抖动三件套 ===');
  {
    // ① 最小占用时间：刚开跑的任务不许被抢
    const q = new TaskQueue();
    q.minOccupancyMs = 1500;
    q.preemptCooldownMs = 0;
    q.maxPreemptsPerTask = 99;
    let lowRuns = 0;
    q.submit({
      name: '刚开跑的长任务',
      priority: PRIORITY.SKILL,
      preemptible: true,
      run: async ({ signal }) => {
        lowRuns += 1;
        for (let i = 0; i < 60; i += 1) {
          if (signal && signal.aborted) throw new Error('被抢占');
          await sleep(50);
        }
      },
    });
    await tick();
    await tick();
    ok('长任务跑起来了', lowRuns === 1);
    const high1 = q.submit({
      name: '普通生存反射',
      priority: PRIORITY.SURVIVAL,
      preemptible: true,
      run: async () => {
        await sleep(50);
      },
    });
    await sleep(200);
    ok(
      '① 最小占用时间内**不许抢**（任务没被掐死在起跑线上）',
      q.current && q.current.name === '刚开跑的长任务',
      `当前=${q.current ? q.current.name : '无'}（应该是长任务，不是普通生存反射）`,
    );
    ok('被拦下的高优先级任务**排队等**，不是被丢掉', q.pendingCount >= 1, `排队 ${q.pendingCount} 个`);
    await q.cancelAll({ reason: '测试结束' });
    void high1;
  }
  {
    // ② 抢占冷却：同一个本能别连着抢
    const q = new TaskQueue();
    q.minOccupancyMs = 0;
    q.preemptCooldownMs = 5000; // 很长，好观察
    q.maxPreemptsPerTask = 99;
    q.submit({
      name: '长任务2',
      priority: PRIORITY.SKILL,
      preemptible: true,
      run: async ({ signal }) => {
        for (let i = 0; i < 60; i += 1) {
          if (signal && signal.aborted) throw new Error('被抢占');
          await sleep(50);
        }
      },
    });
    await tick();
    await tick();
    // 第一次抢占应该成功（冷却表里还没有它）
    //
    // 使用 SURVIVAL 级来测：REFLEX 会被“普通反射不得打断用户/技能任务”拦下，
    // CRITICAL 则必须绕过防抖救命。这里检查的是普通生存反射的冷却。
    const firstReflex = q.submit({
      name: '普通生存反射',
      priority: PRIORITY.SURVIVAL,
      preemptible: true,
      run: async () => {
        await sleep(200);
      },
    });
    await sleep(80);
    const afterFirst = q.stats.preempted;
    ok('第一次抢占成功（冷却表里还没有它）', afterFirst === 1, `preempted=${afterFirst}`);
    await firstReflex.promise;
    await tick();
    ok('冷却测试前长任务重新取得身体', q.current && q.current.name === '长任务2');
    // 立刻再来一次同名的（冷却应该拦下）
    q.submit({
      name: '普通生存反射',
      priority: PRIORITY.SURVIVAL,
      preemptible: true,
      run: async () => {
        await sleep(200);
      },
    });
    await sleep(120);
    ok(
      '② 同一个本能连着抢会被冷却拦下',
      q.stats.preempted === afterFirst,
      `第一次后 preempted=${afterFirst}，第二次后=${q.stats.preempted}`,
    );
    ok('冷却中的反射只排队一次', q.pendingCount === 1);
    await q.cancelAll({ reason: '测试结束' });
  }
  {
    // ③ 抢占次数上限：被抢太多次就不再让位，而且标记要如实报告
    const q = new TaskQueue();
    q.minOccupancyMs = 0;
    q.preemptCooldownMs = 0;
    q.maxPreemptsPerTask = 2;
    const low = q.submit({
      name: '老被抢的任务',
      priority: PRIORITY.SKILL,
      preemptible: true,
      run: async ({ signal }) => {
        for (let i = 0; i < 60; i += 1) {
          if (signal && signal.aborted) throw new Error('被抢占');
          await sleep(50);
        }
      },
    });
    // 手工把它标成"已经被抢 2 次"，再让一个高优先级来抢
    low.preemptCount = 2;
    await tick();
    await tick();
    q.submit({
      name: '普通生存反射',
      priority: PRIORITY.SURVIVAL,
      preemptible: true,
      run: async () => {
        await sleep(50);
      },
    });
    await sleep(200);
    ok(
      '③ 达到抢占上限后**不再让位**',
      q.current && q.current.name === '老被抢的任务',
      `当前=${q.current ? q.current.name : '无'}`,
    );
    ok('标记了 reportThrashed（供上层如实报告"我被反复打断"）', low.reportThrashed === true);
    await q.cancelAll({ reason: '测试结束' });
  }

  console.log('\n=== CRITICAL 绕过普通防抖救命 ===');
  {
    const q = new TaskQueue();
    q.minOccupancyMs = 1500;
    q.preemptCooldownMs = 5000;
    q.maxPreemptsPerTask = 2;
    q._lastPreemptByName.set('溺水换气', Date.now());
    const low = q.submit({ name: '正在挖矿', priority: PRIORITY.SKILL, run: async ({ signal }) => {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      throw Object.assign(new Error('被抢占'), { name: 'CancelledError' });
    } });
    low.preemptCount = 2;
    await tick();
    let saved = false;
    const critical = q.submit({ name: '溺水换气', priority: PRIORITY.CRITICAL, run: async () => { saved = true; } });
    await critical.promise;
    ok('致命反射绕过最小占用、冷却和次数上限', saved && q.stats.preempted === 1);
    ok('救命抢占没有误报防抖降级', !low.reportThrashed);
    q.cancelAll({ reason: '测试结束' });
  }

  console.log('\n=== 抢占次数会露到任务结果里（可见性）===');
  {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'bot.js'), 'utf8');
    ok('task.finished 的载荷里有 preempt_count', /preempt_count: task\.preemptCount/.test(src));
    ok('也带上了是谁抢的', /preempted_by: task\.preemptedBy/.test(src));
  }

  console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
  process.exit(fail > 0 ? 1 : 0);
})();
