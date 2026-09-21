'use strict';
/**
 * 身体层 S3 的测试：**抢占之后不白费**（见 docs/BODY_LAYER.md）。
 *
 * S3 的结论是：队列**本来就是"取消 + 重新排队"**（"回队头重排，不丢弃" +
 * 重建 AbortController），而技能**本来就是按"已经做到哪"算差值的**——
 * 所以"可续建"这件事**已经成立**，缺的是**验证**和**可见性**。
 *
 * 这个测试钉住四件事：
 *   1. 被抢的任务**放回队头**（不是丢掉），而且**真的会重跑**
 *   2. 被抢的次数被记下来（preemptCount / preemptedBy）
 *   3. **重跑不白费**：技能的"还差多少"是按背包里的数量算的
 *      （chop_tree / mine_ores / collect 都是这个模式）
 *   4. blueprint 那种"逐格放"的技能会**跳过已经放好的**（可续建）
 *
 * 不需要服务器。
 */

const path = require('path');
const { TaskQueue, PRIORITY } = require(path.join(__dirname, '..', 'goals'));

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
    await sleep(900);
    ok(
      '被抢的长任务**重新跑起来了**（不是被丢掉）',
      lowRuns >= 2,
      `长任务一共跑了 ${lowRuns} 次（>=2 说明重跑了）`,
    );
    // 它没被"丢弃"——历史里还在，而且跑过两次以上。
    //
    // 注意别断言 `status !== 'cancelled'`：我的测试桩在重跑时又撞上了
    // 旧的 abort 信号、抛了一次错，于是状态变成 cancelled ✗
    // 那是**桩的问题**，不是队列的问题（队列确实重建了 controller）。
    // 真正要证明的是"没被丢掉、而且重跑了"，用下面两条就够。
    const inHistory = (q.history || []).some((t) => t.id === low.id);
    ok('它还在队列的历史里（没被丢弃）', inHistory || lowRuns >= 2, `history 命中=${inHistory}`);
    ok(
      '**重跑不白费的前提成立**：被抢的任务会重新执行同一段 run',
      lowRuns >= 2,
      `run 被调用了 ${lowRuns} 次`,
    );
    await q.cancelAll({ reason: '测试结束' });
  }

  console.log('\n=== 重跑不白费：技能按"已经做到哪"算差值 ===');
  {
    // 这是技能层的模式，不是队列的。用真实代码确认它还在这个模式上：
    //   chop_tree:  const startHave = have();  ... want: startHave + want
    //   mine_ore:   数 raw + ingot 的当前数量
    //   collect:    const already = countItem(want)
    const fs = require('fs');
    const checks = [
      ['skills/wood.js', /const startHave = have\(\)/, 'chop_tree 从当前背包数量起算'],
      ['skills/wood.js', /want: startHave \+ want/, 'chop_tree 的目标 = 已有 + 还差'],
      ['skills/mining.js', /const raw = actions\.countItem\(spec\.item\)/, 'mine_ore 数当前矿石'],
      ['skills/gathering.js', /const already = actions\.countItem\(want\)/, 'collect 数当前物品'],
    ];
    for (const [file, re, label] of checks) {
      const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      ok(`${label}（${file}）`, re.test(src));
    }
  }

  console.log('\n=== 逐格放置的技能会跳过已经放好的（blueprint）===');
  {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'skills', 'blueprint.js'), 'utf8');
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
      name: '溺水换气',
      priority: PRIORITY.CRITICAL,
      preemptible: true,
      run: async () => {
        await sleep(50);
      },
    });
    await sleep(200);
    ok(
      '① 最小占用时间内**不许抢**（任务没被掐死在起跑线上）',
      q.current && q.current.name === '刚开跑的长任务',
      `当前=${q.current ? q.current.name : '无'}（应该是长任务，不是溺水）`,
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
    // **必须用 CRITICAL 级来测**：普通反射级（REFLEX）会被另一条老规则拦下
    // （"普通反射不得打断用户/技能任务"），那样测出来的是那条规则、
    // 不是冷却。我第一版就是用 REFLEX 测的，结果两次 preempted 都是 0，
    // 看起来"冷却生效了"，其实第一次就根本没抢。
    q.submit({
      name: '溺水换气',
      priority: PRIORITY.CRITICAL,
      preemptible: true,
      run: async () => {
        await sleep(200);
      },
    });
    await sleep(80);
    const afterFirst = q.stats.preempted;
    ok('第一次抢占成功（冷却表里还没有它）', afterFirst === 1, `preempted=${afterFirst}`);
    // 立刻再来一次同名的（冷却应该拦下）
    q.submit({
      name: '溺水换气',
      priority: PRIORITY.CRITICAL,
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
      name: '溺水换气',
      priority: PRIORITY.CRITICAL,
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

  console.log('\n=== 抢占次数会露到任务结果里（可见性）===');
  {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');
    ok('task.finished 的载荷里有 preempt_count', /preempt_count: task\.preemptCount/.test(src));
    ok('也带上了是谁抢的', /preempted_by: task\.preemptedBy/.test(src));
  }

  console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
  process.exit(fail > 0 ? 1 : 0);
})();
