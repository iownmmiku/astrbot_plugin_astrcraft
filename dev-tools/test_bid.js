'use strict';
/**
 * 身体层 S2 的测试：统一出价入口 + 抢占语义（见 docs/BODY_LAYER.md）。
 *
 * 钉住三件事：
 *   1. **出价表**：本能名 → 出价 → 队列优先级，映射正确
 *      （溺水/岩浆必须比"捡掉落物"更优先）
 *   2. **抢占语义没写反**：`preemptible` 的意思是"允许被出价更高的抢"。
 *      原来写的是 `preemptible: level === 'critical'` —— **反了**：
 *      critical 本能反而能被抢，而 normal 本能**不能被任何东西抢**，
 *      于是一个低优先级的普通反射会把 critical 本能挡在外面。
 *      这个测试就是专门盯这一条的。
 *   3. 出价日志能回答"刚才谁拿了身体"
 *
 * 不需要服务器：用假队列和假引擎直接测。
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

// 把 McEngine 原型上的三个方法借过来测（不构造整个引擎）
const { McEngine } = (() => {
  // bot.js 是 CommonJS，导出的类名要看文件末尾
  const m = require(path.join(__dirname, '..', 'engine', 'bot.js'));
  return m && m.McEngine ? { McEngine: m.McEngine } : { McEngine: null };
})();

if (!McEngine) {
  console.log('  ❌ 拿不到 McEngine（bot.js 的导出变了？）');
  process.exit(1);
}

/** 造一个只有出价相关字段的"假引擎" */
function makeEngine() {
  const e = Object.create(McEngine.prototype);
  e.queue = new TaskQueue();
  e._bidLog = [];
  return e;
}

console.log('=== 出价表映射 ===');
{
  const e = makeEngine();
  const cases = [
    ['浮上水面换气', 9, '溺水'],
    ['岩浆里了，赶紧出来', 8, '岩浆'],
    ['反击 zombie', 7, '反击'],
    ['血量过低，后撤', 6, '低血'],
    ['吃 cooked_beef', 5, '进食'],
    ['挖开卡住自己的方块', 4, '脱困'],
    ['捡起附近的掉落物', 0, '捡东西'],
    ['这里太黑了，插个火把', 0, '插火把'],
  ];
  for (const [name, want, label] of cases) {
    const got = e._bidOf(name);
    ok(`${label} → 出价 ${want}`, got === want, `实际 ${got}`);
  }
}

console.log('\n=== 出价 → 队列优先级（数值越小越优先）===');
{
  const e = makeEngine();
  const drown = e._priorityForBid(9);
  const eat = e._priorityForBid(5);
  const task = e._priorityForBid(1);
  const idle = e._priorityForBid(0);
  ok('溺水比进食优先', drown < eat, `${drown} < ${eat}`);
  ok('进食比 LLM 任务优先', eat < task, `${eat} < ${task}`);
  ok('LLM 任务比捡东西优先', task < idle, `${task} < ${idle}`);
  ok('溺水拿到最高档', drown === PRIORITY.CRITICAL, `priority=${drown}`);
}

console.log('\n=== 抢占语义没写反（这是重点）===');
(async () => {
  const e = makeEngine();
  // **关掉防抖动**：这一节要测"抢占语义没写反"，
  // 而 S4 的防抖动会**故意**拦下抢占（最小占用时间/冷却/次数上限）
  // ——那是它的正确行为。要测抢占本身就得先关掉它。
  e.queue.minOccupancyMs = 0;
  e.queue.preemptCooldownMs = 0;
  e.queue.maxPreemptsPerTask = 99;
  // 先提交一个"低出价的普通反射"（捡掉落物，出价 0）
  //
  // **假任务要理会取消信号**：抢占是"软取消"——被抢的任务从 await 点解开才让出。
  // 我第一版让它傻等 3 秒、不看 signal，于是抢占日志打出来了、
  // 但 current 一直没变（因为任务还在跑）。真任务都是检查 signal 的。
  let ran = 0;
  const low = e._submitReflex('捡起附近的掉落物', async ({ signal } = {}) => {
    ran += 1;
    for (let i = 0; i < 30; i += 1) {
      if (signal && signal.aborted) throw new Error('被抢占');
      await new Promise((r) => setTimeout(r, 50));
    }
  });
  ok('低出价反射已提交', !!low);
  // 队列的 pump 是**异步调度**的（_schedule → 微任务），要等一拍才有 current
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const cur = e.queue.current;
  ok('低出价反射真的开始跑了', !!cur, `current=${cur ? cur.name : '无'}`);
  ok(
    '正在跑的普通反射**允许被抢**（原来写反了，这里 false 就说明又错了）',
    cur && cur.preemptible === true,
    `preemptible=${cur ? cur.preemptible : '?'}`,
  );
  // 再提交一个"高出价的 critical 本能"（溺水，出价 9）
  const high = e._submitReflex(
    '浮上水面换气',
    async () => {
      ran += 1;
      // 跑久一点，好让断言能查到"当前是它"（瞬时任务会在查之前就跑完，
      // 我第一版就是这样：抢占成功了但 current 已经空了）
      await new Promise((r) => setTimeout(r, 800));
    },
    'critical',
  );
  ok('高出价本能被接受了', !!high);
  // 抢占是**异步**发生的：被抢的任务要先从 await 点解开（cancel 是软中断）。
  await new Promise((r) => setTimeout(r, 400));
  ok(
    '高出价本能抢到了身体（当前任务变成了它）',
    e.queue.current && String(e.queue.current.name).includes('水面'),
    `当前=${e.queue.current ? e.queue.current.name : '无'}`,
  );

  console.log('\n=== 出价日志（能回答"刚才谁拿了身体"）===');
  {
    const e2 = makeEngine();
    e2._submitReflex('吃 cooked_beef', async () => {});
    ok('日志记了一笔', (e2._bidLog || []).length === 1, JSON.stringify((e2._bidLog || [])[0] || {}));
    const entry = (e2._bidLog || [])[0] || {};
    ok('日志里有名字/出价/优先级', entry.name && entry.bid === 5 && typeof entry.priority === 'number');
  }

  console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
  process.exit(fail > 0 ? 1 : 0);
})();
