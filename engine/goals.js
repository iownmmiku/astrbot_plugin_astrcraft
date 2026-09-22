'use strict';
/**
 * 动作队列：引擎侧的统一调度点。
 *
 * 设计要点（这几条决定了机器人会不会"抽风"）：
 *   1. 串行执行：Minecraft 的身体只有一个，两个动作并行必然互相打架（一个在走、一个在挖）
 *   2. 优先级 + 抢占：反射层（掉血、溺水）必须能立刻打断 LLM 派的闲活
 *   3. 被抢占的任务不丢弃，回到队头重排，避免"走到一半被打断就永远到不了"
 *   4. 每个任务有 task_id，插件侧可查询/取消；取消通过 AbortController 真正传导到底层动作
 */

const log = require('./log');
const { CancelledError, delay } = require('./util');

/** 优先级：数值越小越先执行 */
const PRIORITY = {
  /**
   * 致命反射：溺水、岩浆、着火。
   * 这些必须在毫秒级抢占一切——再重要的任务也不值得淹死。
   */
  CRITICAL: -10,
  /**
   * 普通反射：饿、血量偏低、被怪近身。
   * 注意它**不抢占**正在执行的用户任务：真玩家不会砍树砍一半突然跑去吃东西，
   * 而是做完手上的事再吃。如果这些也抢占，用户会看到
   * "我让它砍树，它去吃了口饭，砍树任务就没了"——这属于设计缺陷，不是安全。
   */
  REFLEX: 0,
  SURVIVAL: 10, // 生存层：撤离、夜间避难
  USER: 20, // 用户/LLM 明确指令
  SKILL: 30, // 技能链的子步骤
  AUTONOMY: 40, // 自主层的长期目标
  IDLE: 50, // 空闲行为
};

/** 不可被普通反射抢占的优先级门槛：用户指令及以上 */
const PROTECTED_FROM_REFLEX = PRIORITY.USER;

let taskSeq = 0;
function nextTaskId(prefix = 't') {
  taskSeq += 1;
  return `${prefix}${Date.now().toString(36)}${taskSeq.toString(36)}`;
}

class Task {
  /**
   * @param {object} o
   * @param {string} o.name        展示名，会进简报
   * @param {Function} o.run       async (ctx: {signal, task}) => any
   * @param {number} o.priority
   * @param {boolean} o.preemptible 是否允许被更高优先级抢占
   */
  constructor({ name, run, priority = PRIORITY.USER, preemptible = true, kind = 'action', meta = {} }) {
    this.id = nextTaskId(kind === 'skill' ? 's' : 't');
    this.name = name;
    this.run = run;
    this.priority = priority;
    this.preemptible = preemptible;
    this.kind = kind;
    this.meta = meta;

    this.status = 'pending'; // pending | running | done | failed | cancelled
    this.result = null;
    this.error = null;
    this.createdAt = Date.now();
    this.startedAt = null;
    this.finishedAt = null;
    this.controller = new AbortController();
    this.progress = '';
    /**
     * **"这一次执行"的身份令牌**（P4，见 requeue()）。
     *
     * `_pump()` 每开始一轮就 +1，`requeue()` 也 +1（把正在跑的那一次作废）。
     * 收尾时只有 `task._runToken === myToken` 才允许结算 promise / 写状态。
     *
     * 为什么不能用布尔标记：技能内部**并非每处 await 都响应 signal**
     * （`settle()`、部分 `delay(ms)`、若干库调用都可能是裸等待），所以
     * "旧执行收尾"完全可能晚于"重跑开始"。而布尔标记会在重跑开始时被重置，
     * 旧执行收尾时看到的就成了"我没事"——于是**替重跑那次把 promise 结算掉**，
     * 重跑的真实结果被丢弃，`status` 也跟着说谎。
     * 令牌只会递增，旧执行永远认不出自己。
     */
    this._runToken = 0;
    this._resolve = null;
    this._reject = null;
    this.promise = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
    // 没人 await 的任务被取消时不要产生 unhandledRejection
    this.promise.catch(() => {});
  }

  get signal() {
    return this.controller.signal;
  }

  cancel(reason = '被取消') {
    if (this.status === 'done' || this.status === 'failed' || this.status === 'cancelled') return false;
    this.controller.abort();
    if (this.status === 'pending') {
      // 还没开始跑，直接结算
      this.status = 'cancelled';
      this.error = reason;
      this.finishedAt = Date.now();
      this._reject(new CancelledError(reason));
    }
    return true;
  }

  /**
   * **被抢占后的"重排"**（P4）：放弃当前这次执行，但**不结算 promise**。
   *
   * 与 `cancel()` 的区别只有一点，但很关键：`cancel()` 对 `pending` 的任务会
   * `this._reject(new CancelledError(reason))`——那是"这件事结束了、而且没做成"。
   * 而抢占的语义是"**让一让，等下接着做**"：任务马上会被放回队头重跑。
   *
   * 原来抢占走的是 `cancel()`，于是这个 promise 被 reject 一次 →
   * `engine/bot.js` 的 `.catch(err => hooks.onFailed(err))` 把**一个还会重跑的
   * 本能记成"失败了"**。而 onFailed 的实现基本都带副作用（计数、降频、退避、
   * 甚至 `bot.chat` 喊一句"我卡住了"）——结果是"被抢了几次之后，她自己把自己
   * 降频了"，从日志上看还以为是能力问题。
   *
   * 这里做两件事：
   *   ① abort 信号，让正在跑的 `run()` 尽快退出；
   *   ② **递增 `_runToken`**，把"正在跑的那一次"作废——它随后收尾时
   *      `_pump` 会发现令牌对不上，于是**不结算、不写状态、不进历史**。
   *      promise 保持 pending，等真正跑完的那一次再 resolve/reject。
   */
  requeue(reason = '被抢占') {
    this._requeueReason = reason;
    // **先作废身份，再 abort**：abort 之后 run() 可能同步就抛出来，
    // 顺序反了会有一瞬间"旧执行还以为自己是当前那次"。
    this._runToken += 1;
    this.controller.abort();
    return true;
  }

  toJSON() {
    return {
      task_id: this.id,
      name: this.name,
      kind: this.kind,
      status: this.status,
      priority: this.priority,
      progress: this.progress,
      detail: this._detail(),
      created_at: this.createdAt,
      started_at: this.startedAt,
      finished_at: this.finishedAt,
      elapsed_ms: this.startedAt ? (this.finishedAt || Date.now()) - this.startedAt : 0,
      error: this.error ? String(this.error.message || this.error) : null,
      result: this.result,
      meta: this.meta,
    };
  }

  /** 子类/调用方可覆盖，给插件侧更丰富的进度描述 */
  _detail() {
    return this._detailText || null;
  }

  setDetail(text) {
    this._detailText = text;
    return this;
  }
}

class TaskQueue {
  constructor({ onTaskFinished = null, onTaskStarted = null } = {}) {
    /** @type {Task[]} */
    this._queue = [];
    /** @type {Task|null} */
    this._current = null;
    this._history = [];
    this._onTaskFinished = onTaskFinished;
    this._onTaskStarted = onTaskStarted;
    this._pumpScheduled = false;
    this._paused = false;
    this._stats = { submitted: 0, completed: 0, failed: 0, cancelled: 0, preempted: 0 };

    // **防抖动三件套的阈值**（身体层设计 S4，见 docs/BODY_LAYER.md）。
    // 想调就改这里，或者构造时传进来。
    /** 一个任务刚开始这么多毫秒内不许被抢（避免被掐死在起跑线上） */
    this.minOccupancyMs = 1500;
    /** 同一个本能两次抢占之间至少隔这么久 */
    this.preemptCooldownMs = 2000;
    /** 一个任务被抢超过这么多次就不再让位，改为如实报告"我被反复打断" */
    this.maxPreemptsPerTask = 5;
    /** 本能名 → 上次抢占时间（冷却用） */
    this._lastPreemptByName = new Map();
  }

  get current() {
    return this._current;
  }

  get pendingCount() {
    return this._queue.length;
  }

  get stats() {
    return { ...this._stats };
  }

  /**
   * **防抖动三件套**（身体层设计 S4，见 docs/BODY_LAYER.md）。
   *
   * 返回 true = 这次抢占被拦下（新任务排队等，不抢）。
   *
   * 为什么需要：抢占本身会抖动——本能反复抢、任务反复重启，
   * 从外面看就是"她一直在原地折腾"。三条防护：
   *
   *   ① **最小占用时间**：一个任务刚开始 N 毫秒内不许被抢。
   *      否则一个"每秒检查一次"的本能会把每个任务都掐死在起跑线上。
   *   ② **抢占冷却**：同一个本能两次抢占之间至少隔 M 毫秒。
   *      避免"抢了又失败、失败了又抢"的死循环。
   *   ③ **抢占次数上限**：一个任务被抢超过 K 次就不再让它被抢，
   *      而且**如实报告**"我被反复打断"——而不是无限重启。
   *      这一条用的是 S3 加的 preemptCount。
   */
  _thrashGuard(task) {
    const now = Date.now();
    const cur = this._current;
    if (!cur) return false;

    // ① 最小占用时间：刚开跑的任务先让它跑一会儿
    const held = cur.startedAt ? now - cur.startedAt : 0;
    if (held < this.minOccupancyMs) {
      log.debug(
        `防抖动：${cur.name} 才跑了 ${held}ms（< ${this.minOccupancyMs}ms），${task.name} 先排队`,
      );
      return true;
    }

    // ② 抢占冷却：同一个本能别连着抢
    const last = this._lastPreemptByName.get(task.name) || 0;
    if (now - last < this.preemptCooldownMs) {
      log.debug(
        `防抖动：${task.name} 上次抢占才过 ${now - last}ms` +
          `（< ${this.preemptCooldownMs}ms），这次先排队`,
      );
      return true;
    }

    // ③ 抢占次数上限：被抢太多次就别再抢了，如实说
    if ((cur.preemptCount || 0) >= this.maxPreemptsPerTask) {
      log.warn(
        `防抖动：「${cur.name}」已经被抢 ${cur.preemptCount} 次（上限 ${this.maxPreemptsPerTask}），` +
          `这次不再让位——${task.name} 排队等它做完。` +
          `（如果它一直做不完，说明它自己卡住了，该看的是它，不是继续抢）`,
      );
      cur.reportThrashed = true;
      return true;
    }

    this._lastPreemptByName.set(task.name, now);
    return false;
  }

  /**
   * 提交任务。会立刻返回 Task 对象（含 task_id），不等待执行完成。
   *
   * @param {object} spec
   * @param {number} [spec.preempt] 抢占阈值：当前任务优先级 > 该值时抢占它（默认用 spec.priority 比较）
   */
  submit(spec) {
    const task = spec instanceof Task ? spec : new Task(spec);
    this._stats.submitted += 1;

    // 判断是否需要抢占当前任务。
    // 关键规则：普通反射（REFLEX）不得打断用户/技能任务——
    // 只有当"新任务优先级 < 当前任务优先级" **且** 新任务确实是致命级（CRITICAL）
    // 或当前任务本身优先级更低时才抢占。
    const newPriority = task.priority;
    const curPriority = this._current ? this._current.priority : Infinity;
    const isReflexLevel = newPriority >= PRIORITY.REFLEX && newPriority < PRIORITY.SURVIVAL;
    const currentIsProtected = this._current && this._current.priority >= PROTECTED_FROM_REFLEX;

    if (this._current && newPriority < curPriority && this._current.preemptible) {
      if (isReflexLevel && currentIsProtected) {
        // 普通反射遇上用户指令：不抢占，排到后面去做
        log.debug(`反射任务 ${task.name} 让位于正在执行的用户任务 ${this._current.name}`);
      } else if (this._thrashGuard(task)) {
        // **防抖动（身体层设计 S4）拦下了这次抢占**，新任务排队等
        // （_thrashGuard 里已经打了日志说明原因）
        this._queue.push(task);
        this._sortQueue();
        this._schedule();
      } else {
        log.info(`任务 ${task.name}(${task.id}) 抢占 ${this._current.name}(${this._current.id})`);
        this._stats.preempted += 1;
        const victim = this._current;
        // **记一次"被抢"，用于可见性与防抖动**（身体层设计 S3/S4，见 docs/BODY_LAYER.md）。
        //
        // 为什么需要：抢占是"取消 + 重新排队"，被抢的任务**会接着重跑**。
        // 而技能大多是按"背包里已有的数量"算差值的（chop_tree / mine_ores /
        // collect 都是），所以重跑**不会白费**——这一点原来完全不可见，
        // 从外面看就是"任务莫名其妙重启了一次"。
        // 记下来之后：任务结果里会带 preempt_count，被抢太多次就能如实报告
        // "我被反复打断"（S4 的上限判断要用它）。
        victim.preemptCount = (victim.preemptCount || 0) + 1;
        victim.preemptedBy = task.name;
        victim.lastPreemptAt = Date.now();
        task.startedAt = task.startedAt || Date.now();
        log.warn(
          `「${victim.name}」被「${task.name}」抢走身体（第 ${victim.preemptCount} 次），` +
            `已放回队头——重新跑会从"已经做到哪"接着做，不会白费`,
        );
        // 回队头重排，不丢弃。
        //
        // **顺序很关键，别改**：
        //   ① 先 `requeue()` —— 它 abort 的是**当前正在跑的那次执行**持有的
        //      controller（见下面 ②）。用 requeue 而不是 cancel：cancel 对
        //      pending 任务会 reject 一次 promise，而 `engine/bot.js` 的
        //      `.catch` 会把它当成真失败调 onFailed（计数/降频/退避）。
        //      被抢占的任务**马上会重跑**，把它记成失败是错的（P4）。
        //   ② 再换一个新的 controller 给"重跑的那一次"用。
        //
        // **这里原来是反的**（先换 controller、再 cancel），后果是：
        // `cancel()` abort 的是**刚装上去的新 controller**，而正在跑的
        // `run()` 手里握着的是旧的那个 —— **旧 signal 永远没人 abort**，
        // 于是"抢占"根本没有打断正在执行的动作：她会一边继续挖/走，
        // 一边又被排进队列再跑一遍。`dev-tools/test_task_preempt.js`
        // 的「abort 信号真的传下去了」那条断言就是为这个加的。
        victim.status = 'pending';
        victim.startedAt = null;
        victim.requeue(`被更高优先级任务 ${task.name} 抢占`);
        // 给"重跑的那一次"准备一个干净的 AbortController
        victim.controller = new AbortController();
        this._queue.push(victim);
        this._sortQueue();
        // requeue 只 abort、不改 status；显式写清楚意图
        victim.status = 'pending';
        victim.error = null;
        this._current = null;
      }
    }

    this._queue.push(task);
    this._sortQueue();
    this._schedule();
    return task;
  }

  /** 只入队不自动执行（技能链内部按顺序提交时用） */
  _sortQueue() {
    this._queue.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
  }

  _schedule() {
    if (this._pumpScheduled) return;
    this._pumpScheduled = true;
    setImmediate(() => {
      this._pumpScheduled = false;
      this._pump().catch((err) => log.error('任务泵异常', err));
    });
  }

  async _pump() {
    if (this._current || this._paused) return;
    const task = this._queue.shift();
    if (!task) return;
    if (task.status === 'cancelled') {
      this._schedule();
      return;
    }

    this._current = task;
    task.status = 'running';
    task.startedAt = Date.now();
    // **记下"这一次执行"的身份**（P4）。
    //
    // 每开始一轮就 +1：被抢占重排之后，旧执行的 `myToken` 就不再等于
    // `task._runToken`，于是它收尾时**什么都不要碰**（不结算、不改状态、
    // 不进历史、不触发回调）。用一个只增不减的令牌，而不是一个会被
    // 重置的布尔标记——后者在重跑开始时就被清掉，旧执行收尾时看到的
    // 是"我没事"，于是替重跑那次把 promise 结算了。
    task._runToken = (task._runToken || 0) + 1;
    const myToken = task._runToken;
    if (this._onTaskStarted) {
      try {
        this._onTaskStarted(task);
      } catch (err) {
        log.warn('onTaskStarted 回调异常', err.message);
      }
    }

    try {
      const result = await task.run({ signal: task.signal, task });
      if (task._runToken !== myToken) {
        // **这次执行已经被作废**（被抢占后回队头重排了）→ 这次不算结束。
        // promise 保持 pending，既不 resolve（会报假成功、onDone 误触发），
        // 也不 reject（会报假失败）。等它重跑完的那一次再结算。
        log.debug(`${task.name}(${task.id}) 被抢占后已重排，本次不结算 promise`);
      } else if (task.status !== 'cancelled') {
        // 关键：技能可能"正常返回"但业务上失败（skillResult(false, {...})）。
        // 如果一律记成 done，上层就会看到"任务成功但什么都没发生"的假成功——
        // 这个坑真实出现过（make_tools 内部失败却报 done）。
        // 所以：返回值里显式 ok === false 时，任务状态记为 failed。
        const businessFailed = result && typeof result === 'object' && result.ok === false;
        if (businessFailed) {
          task.status = 'failed';
          task.result = result;
          task.error = new Error(result.reason || result.note || '动作未成功');
          this._stats.failed += 1;
          log.info(`任务未成功 ${task.name}(${task.id})：${task.error.message}`);
          task._resolve(task.result);
        } else {
          task.status = 'done';
          task.result = result === undefined ? null : result;
          this._stats.completed += 1;
          task._resolve(task.result);
        }
      } else {
        task._resolve(task.result);
      }
    } catch (err) {
      const cancelled = err instanceof CancelledError || err.name === 'CancelledError' || task.signal.aborted;
      if (task._runToken !== myToken) {
        // **被抢占后已重排 → 既不算取消也不算失败**（P4）。
        // 不 reject（否则 bot.js 的 .catch 会调 onFailed 记一笔假失败），
        // 也不计 cancelled 统计（它没被取消，只是让了让）。
        log.debug(`${task.name}(${task.id}) 被抢占后已重排，本次不结算 promise`);
      } else if (cancelled) {
        task.status = 'cancelled';
        task.error = task.error || err;
        this._stats.cancelled += 1;
        task._reject(err);
      } else {
        task.status = 'failed';
        task.error = err;
        this._stats.failed += 1;
        log.warn(`任务失败 ${task.name}(${task.id})：${err.message}`);
        task._reject(err);
      }
    } finally {
      // **收尾也必须按令牌判定**（P4）。
      //
      // 技能内部并非每处 await 都响应 signal（`settle()`、部分 `delay(ms)`、
      // 若干库调用都可能是裸等待），所以旧执行完全可能晚于重跑才收尾。
      // 令牌对不上就**一个字段都不要碰**——否则它会把重跑那次的
      // `_current` / 历史 / 回调全部搅乱。
      if (task._runToken !== myToken) {
        log.debug(`${task.name}(${task.id}) 的旧执行收尾（已被重排取代），不碰任何状态`);
      } else {
        task.finishedAt = Date.now();
        // **只清掉"确实是自己"的那一份**。
        //
        // 被抢占的任务已经回队头了，而它的 `run()` 可能还在收尾（abort 到真正
        // 抛出之间有几十毫秒）。这段时间里 `_current` 很可能已经是**抢占者**了；
        // 无条件 `this._current = null` 会把后来者的登记抹掉，
        // 于是 `_pump` 认为"没人在跑"，又去队列里拿一个 ——
        // **两个任务同时跑**，而"串行执行"是整个队列存在的前提。
        if (this._current === task) this._current = null;
        this._remember(task);
        if (this._onTaskFinished) {
          try {
            this._onTaskFinished(task);
          } catch (err) {
            log.warn('onTaskFinished 回调异常', err.message);
          }
        }
        this._schedule();
      }
    }
  }

  _remember(task) {
    this._history.push({
      task_id: task.id,
      name: task.name,
      status: task.status,
      started_at: task.startedAt,
      finished_at: task.finishedAt,
      error: task.error ? String(task.error.message || task.error) : null,
      // **结果也要存**（见 describe 的说明）：不存的话事后查不到"它到底做了什么、
      // 为什么没做成"——而 `task.finished` 通知里是有的，两边不一致会误导排查。
      result: task.result === undefined ? null : task.result,
      detail: task._detail ? task._detail() : null,
      meta: task.meta || {},
    });
    if (this._history.length > 50) this._history.splice(0, this._history.length - 50);
  }

  /** 查任务：当前 / 排队 / 最近历史都能查到 */
  find(taskId) {
    if (this._current && this._current.id === taskId) return this._current;
    const inQueue = this._queue.find((t) => t.id === taskId);
    if (inQueue) return inQueue;
    return null;
  }

  /**
   * 查任务：当前 / 排队 / 最近历史都能查到。
   *
   * **历史里也要能查到结果**——这一点踩过坑：
   * 原来 `_remember` 只存了 task_id/name/status/时间/error，**没存 result**，
   * 而 `describe` 在命中历史时**硬编码 `result: null`** ✗
   * 后果：同一个任务，`task.finished` 通知里**带着完整结果**
   * （`note`/`reason`/`extra` 都有），而事后 `task.status` 查出来 `result` 是 null ✗
   * 排查时我据此两次误判（以为技能没返回东西、以为 `|| {}` 把 null 变空了）。
   * 现在两边都带上 result/detail/meta。
   */
  describe(taskId) {
    const t = this.find(taskId);
    if (t) return t.toJSON();
    const h = [...this._history].reverse().find((x) => x.task_id === taskId);
    if (h) {
      return {
        ...h,
        detail: h.detail ?? null,
        // **不要硬编码 null**：历史里存了什么就返回什么
        result: h.result === undefined ? null : h.result,
        meta: h.meta || {},
      };
    }
    return null;
  }

  /** 取消任务；cancelAll=true 时连排队一起清 */
  cancel(taskId, { reason = '用户取消' } = {}) {
    const t = this.find(taskId);
    if (!t) {
      // 可能是刚完成的历史任务
      const h = this._history.find((x) => x.task_id === taskId);
      if (h) return { ok: false, reason: `任务已结束（${h.status}），无法取消` };
      return { ok: false, reason: `找不到任务 ${taskId}` };
    }
    const ok = t.cancel(reason);
    if (t === this._current && ok) {
      // 当前任务已经在跑，等它自己响应 abort 退出
      log.info(`已请求取消当前任务 ${t.name}(${t.id})`);
    }
    return { ok, reason: ok ? '已请求取消' : '任务已结束' };
  }

  /** 取消当前与所有排队任务（急停用） */
  cancelAll({ reason = '急停' } = {}) {
    const cancelled = [];
    if (this._current) {
      if (this._current.cancel(reason)) cancelled.push(this._current.id);
    }
    for (const t of this._queue) {
      if (t.cancel(reason)) cancelled.push(t.id);
    }
    this._queue.length = 0;
    return cancelled;
  }

  /** 急停后短暂暂停调度，避免反射层立刻又塞任务进来 */
  async pause(ms = 500) {
    this._paused = true;
    await delay(ms);
    this._paused = false;
    this._schedule();
  }

  get currentInfo() {
    if (!this._current) return null;
    return {
      task_id: this._current.id,
      name: this._current.name,
      detail: this._current._detail(),
      elapsed_ms: Date.now() - (this._current.startedAt || Date.now()),
    };
  }

  get queueInfo() {
    return this._queue.map((t) => ({ task_id: t.id, name: t.name, priority: t.priority, status: t.status }));
  }

  get history() {
    return [...this._history];
  }
}

module.exports = { TaskQueue, Task, PRIORITY, nextTaskId, PROTECTED_FROM_REFLEX };
