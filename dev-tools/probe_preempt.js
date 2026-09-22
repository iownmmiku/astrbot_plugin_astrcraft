'use strict';
/**
 * 抢占语义探针：定位 `test_bid.js` 那条断言为什么在改动后失败。
 *
 * 断言是："高出价本能抢到了身体（当前任务变成了它）"
 * 现在的结果是 `当前=捡起附近的掉落物`（旧的、被抢的那个）——**没换**。
 *
 * 这个探针把每一步的 `_current` / 队列状态打出来，看抢占到底走到哪一步断了。
 */

const path = require('path');
const { TaskQueue, PRIORITY } = require(path.join(__dirname, '..', 'engine', 'goals'));

const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const q = new TaskQueue();
  q.minOccupancyMs = 0;
  q.preemptCooldownMs = 0;
  q.maxPreemptsPerTask = 99;

  const show = (label) => {
    const c = q.current;
    console.log(
      `  ${label}: current=${c ? `${c.name}(${c.status})` : 'null'}` +
        ` 队列=${q.pendingCount} 抢占次数=${q.stats.preempted}`,
    );
  };

  let lowRuns = 0;
  // **这里就是关键差异**：上一版探针用 `PRIORITY.REFLEX`(0) 是**通过的**，
  // 而 `test_bid.js` 走 `_bid()` 得到的是 `PRIORITY.IDLE`(50)。
  // 改成 50 看能不能复现那条失败断言。
  const LOW_PRIORITY = Number(process.env.LOW_PRIORITY || PRIORITY.IDLE);
  console.log(`  （低任务优先级 = ${LOW_PRIORITY}）`);
  const low = q.submit({
    name: '捡起附近的掉落物',
    priority: LOW_PRIORITY,
    preemptible: true,
    run: async ({ signal }) => {
      lowRuns += 1;
      for (let i = 0; i < 40; i += 1) {
        if (signal && signal.aborted) throw new Error('被抢占');
        await sleep(25);
      }
    },
  });
  await tick();
  await tick();
  show('① 低出价任务已启动');
  console.log(`     它的 preemptible=${low.preemptible}，run 被调用 ${lowRuns} 次`);

  const high = q.submit({
    name: '浮上水面换气',
    priority: PRIORITY.CRITICAL,
    preemptible: true,
    run: async () => {
      await sleep(800);
    },
  });
  show('② 高出价任务提交后（立刻）');
  await tick();
  await tick();
  show('③ 两拍之后');
  await sleep(120);
  show('④ 120ms 后');
  console.log(`     低任务的 preemptCount=${low.preemptCount} preemptedBy=${low.preemptedBy}`);
  console.log(`     低任务的 status=${low.status}（requeue 的设计是"只 abort 不改 status"）`);
  await sleep(400);
  show('⑤ 400ms 后（test_bid 就是在这里断言）');
  await sleep(600);
  show('⑥ 1 秒后');
  console.log(`     低任务 run 被调用 ${lowRuns} 次（>1 说明它被重新排队后重跑了）`);

  await q.cancelAll({ reason: '探针结束' });
  process.exit(0);
})();
