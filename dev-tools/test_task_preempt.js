#!/usr/bin/env node
/**
 * **被抢占的任务不算失败**（P4）的回归测试。
 *
 * ## 它钉住的是什么
 *
 * 抢占的实现是"取消 + 回队头重排"——被抢的任务**马上会重跑**。
 * 但原来抢占走的是 `Task.cancel()`，而 `cancel()` 对 `pending` 状态的任务会
 * `this._reject(new CancelledError(reason))`。`engine/bot.js` 那边是：
 *
 *     task.promise.then(() => hooks.onDone()).catch((err) => hooks.onFailed(err))
 *
 * 于是**一个还会重跑的本能被记成"失败了"**。onFailed 的实现基本都带副作用
 * （`_unstuckFailures` 计数、降频 60 秒、退避、甚至 `bot.chat` 喊一句
 * "我卡住了"）——结果是"被抢了几次之后，她自己把自己降频了"，
 * 从日志上看还以为是能力问题。
 *
 * ## 为什么这个测试不需要 node_modules
 *
 * `engine/goals.js` 只依赖 `./log` 与 `./util`，都是纯 stdlib 的。
 * 所以这条逻辑可以在本机离线跑真代码（不是复制一份来测）。
 *
 * 用法：node dev-tools/test_task_preempt.js
 */

'use strict';

const path = require('path');

const REPO = path.join(__dirname, '..');
const { TaskQueue, PRIORITY } = require(path.join(REPO, 'engine', 'goals.js'));

let passed = 0;
let failed = 0;

function ok(msg, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✅ ${msg}${detail ? ' — ' + detail : ''}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${msg}${detail ? ' — ' + detail : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 模拟 bot.js 的 hooks 接线方式（见 engine/bot.js 的 _enqueue） */
function wireHooks(task, hooks) {
  task.promise
    .then(() => {
      hooks.done = (hooks.done || 0) + 1;
    })
    .catch((err) => {
      const name = err && err.name;
      if (name === 'CancelledError' || name === 'AbortError') {
        hooks.cancelled = (hooks.cancelled || 0) + 1;
        return;
      }
      hooks.failed = (hooks.failed || 0) + 1;
    });
}

async function main() {
  console.log('=== P4：被抢占的任务不算失败 ===\n');

  const queue = new TaskQueue();
  // 关掉防抖动三件套，否则"刚开跑 1.5 秒内不许被抢"会让抢占根本不发生。
  // （那条逻辑本身是对的，这里只是不想在测试里等 1.5 秒。）
  queue.minOccupancyMs = 0;
  queue.preemptCooldownMs = 0;

  const hooks = {};
  let victimRuns = 0;
  let victimSawAbort = 0;

  // ---- 被抢的任务：第一次跑会一直等到被 abort；第二次跑直接成功 ----
  const victim = queue.submit({
    name: 'victim_skill',
    priority: PRIORITY.USER,
    run: async ({ signal }) => {
      victimRuns += 1;
      if (victimRuns === 1) {
        // 模拟"长任务跑到一半被抢占"：一直等到 signal 被 abort
        await new Promise((resolve) => {
          if (signal.aborted) {
            victimSawAbort += 1;
            resolve();
            return;
          }
          signal.addEventListener('abort', () => {
            victimSawAbort += 1;
            resolve();
          });
        });
        // 真代码里技能会在这里抛 CancelledError（例如 actions.dig 的 _raceAbort）
        const err = new Error('被更高优先级任务抢占');
        err.name = 'CancelledError';
        throw err;
      }
      return { ok: true, note: '第二次跑成功了' };
    },
  });
  wireHooks(victim, hooks);

  await sleep(30); // 让它真正开跑
  ok('被抢的任务已经在跑', victimRuns === 1, `victimRuns=${victimRuns}`);

  // ---- 高优先级任务抢占它 ----
  const preemptor = queue.submit({
    name: 'critical_reflex',
    priority: PRIORITY.CRITICAL,
    run: async () => {
      await sleep(20);
      return { ok: true };
    },
  });
  wireHooks(preemptor, {});

  await sleep(120); // 让抢占、重排、重跑都发生完

  console.log('\n--- 抢占之后的状态 ---');
  ok('确实发生了抢占', queue.stats.preempted >= 1, `preempted=${queue.stats.preempted}`);
  ok('被抢的任务被打上了重排标记', victim.preemptCount >= 1, `preemptCount=${victim.preemptCount}`);
  ok('abort 信号真的传下去了', victimSawAbort >= 1, `victimSawAbort=${victimSawAbort}`);
  ok('被抢的任务**重跑了**（不是被丢弃）', victimRuns >= 2, `victimRuns=${victimRuns}`);

  console.log('\n--- promise 的结算（这是本测试的核心）---');
  ok(
    '被抢占时**没有**触发 onFailed 等价物',
    (hooks.failed || 0) === 0,
    `hooks.failed=${hooks.failed || 0}`,
  );
  ok(
    '被抢占时也**没有**触发 onDone（它还没结束）',
    (hooks.done || 0) === 1,
    `hooks.done=${hooks.done || 0}（应为 1：只有"真的跑完"那一次）`,
  );
  ok('统计里没有失败', queue.stats.failed === 0, `stats.failed=${queue.stats.failed}`);
  ok('统计里也没有把它算成取消', queue.stats.cancelled === 0, `stats.cancelled=${queue.stats.cancelled}`);

  console.log('\n--- 它最终真的成功了 ---');
  ok('任务最终状态是 done', victim.status === 'done', `status=${victim.status}`);
  ok(
    '任务最终结果带回了第二次的产出',
    victim.result && victim.result.note === '第二次跑成功了',
    `result=${JSON.stringify(victim.result)}`,
  );
  ok(
    '历史里只有一条记录（没有留下中间态）',
    queue.history.filter((h) => h.name === 'victim_skill').length === 1,
    `history=${JSON.stringify(queue.history.filter((h) => h.name === 'victim_skill').map((h) => h.status))}`,
  );

  // ---- 对照实验：**真失败**仍然要报 onFailed ----
  console.log('\n--- 对照：真正的失败仍然要算失败 ---');
  const failHooks = {};
  const failing = queue.submit({
    name: 'really_failing',
    priority: PRIORITY.USER,
    run: async () => {
      throw new Error('这个是真失败');
    },
  });
  wireHooks(failing, failHooks);
  await sleep(60);
  ok('真失败触发了 onFailed', (failHooks.failed || 0) === 1, `failed=${failHooks.failed || 0}`);
  ok('真失败计进了 stats.failed', queue.stats.failed === 1, `stats.failed=${queue.stats.failed}`);

  // ---- 对照实验：用户主动取消也不算"失败" ----
  console.log('\n--- 对照：用户取消（/mc急停）不算失败 ---');
  const cancelHooks = {};
  const cancellable = queue.submit({
    name: 'cancelled_by_user',
    priority: PRIORITY.USER,
    run: async () => {
      await sleep(500);
      return { ok: true };
    },
  });
  wireHooks(cancellable, cancelHooks);
  await sleep(30);
  queue.cancel(cancellable.id, { reason: '用户取消' });
  await sleep(60);
  ok(
    '被用户取消**没有**触发 onFailed',
    (cancelHooks.failed || 0) === 0,
    `failed=${cancelHooks.failed || 0}`,
  );

  // ---- 对抗性场景：技能内部有**不响应 signal 的 await** ----
  //
  // 这是 P4 第二版修法的验收条件（第一版用布尔标记 `_requeued`，会被
  // `_pump` 在重跑开始时重置，于是"旧执行收尾"看到的是"我没事"，
  // 替重跑那次把 promise 结算掉了）。
  //
  // 时间轴**刻意排成"旧执行先收尾"**，也就是真实报障时观察到的那个顺序：
  //
  //   t=0     run#1 开始（故意不理会 signal，1200ms 后才返回）
  //   t=50    提交抢占者 → run#1 被 requeue（令牌作废）
  //   t≈70    run#2 开始（要跑 1500ms，t≈1570 才返回）
  //   t=1200  run#1 返回 ← **旧执行先收尾**
  //   t≈1570  run#2 返回 ← 重跑的结果
  //
  // 布尔标记版本会在这里错：t=1200 时它看到 `_requeued` 已被清成 false，
  // 于是用 STALE-run1 把 promise 结算掉，run#2 的真实结果被丢弃。
  console.log('\n--- 对抗：技能不理会 signal，**旧执行先收尾** ---');
  const q2 = new TaskQueue();
  q2.minOccupancyMs = 0;
  q2.preemptCooldownMs = 0;

  const settles = [];
  let adversarialRuns = 0;
  const slow = q2.submit({
    name: 'ignores_signal',
    priority: PRIORITY.USER,
    run: async () => {
      adversarialRuns += 1;
      if (adversarialRuns === 1) {
        // **故意不理会 signal**：模拟"裸 await"，1.2 秒后才返回
        await sleep(1200);
        return { ok: true, note: 'STALE-run1' };
      }
      await sleep(1500);
      return { ok: true, note: 'run2' };
    },
  });
  slow.promise
    .then((r) => settles.push(['resolved', r && r.note]))
    .catch((e) => settles.push(['rejected', e && e.name]));

  await sleep(50);
  q2.submit({
    name: 'critical_2',
    priority: PRIORITY.CRITICAL,
    run: async () => {
      await sleep(20);
      return { ok: true };
    },
  });

  // 跑到"旧执行已经收尾、重跑还没收尾"的那一刻
  await sleep(1300);
  ok('旧执行（run#1）已经收尾了', adversarialRuns >= 2, `adversarialRuns=${adversarialRuns}`);
  ok(
    '**旧执行收尾时没有结算 promise**（promise 必须还是 pending）',
    settles.length === 0,
    `settles=${JSON.stringify(settles)}（布尔标记版本这里会变成 [["resolved","STALE-run1"]]）`,
  );
  ok(
    '旧执行没有把 status 写成 done',
    slow.status !== 'done',
    `status=${slow.status}（重跑还在跑，写 done 就是说谎）`,
  );

  await sleep(700); // 等重跑收尾
  ok(
    '**promise 最终用的是重跑的结果**',
    settles.length === 1 && settles[0][1] === 'run2',
    `settles=${JSON.stringify(settles)}`,
  );
  ok('重跑跑完时 status 是 done', slow.status === 'done', `status=${slow.status}`);
  ok(
    '结果里没有 STALE-run1 的痕迹',
    slow.result && slow.result.note === 'run2',
    `result=${JSON.stringify(slow.result)}`,
  );
  ok(
    '历史里只有重跑那一条',
    q2.history.filter((h) => h.name === 'ignores_signal').length === 1,
    `history=${JSON.stringify(q2.history.filter((h) => h.name === 'ignores_signal').map((h) => h.status))}`,
  );
  ok(
    '统计没有多记（重跑 1 次 + 抢占者 1 次 = 2；若是 3 就说明旧执行也记了一笔）',
    q2.stats.completed === 2 && q2.stats.failed === 0,
    `completed=${q2.stats.completed} failed=${q2.stats.failed}`,
  );

  console.log(`\n=== 结果：${passed} 通过，${failed} 失败 ===`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('测试自身异常：', err);
  process.exit(1);
});
