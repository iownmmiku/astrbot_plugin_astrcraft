'use strict';
/**
 * 通用工具：日志、超时、坐标、错误信息翻译、随机数。
 *
 * 坐标约定（整个引擎必须遵守，这是最容易反复出错的地方）：
 *   - `pos`（实体/世界位置）是浮点位置，玩家站在方块上的 y 通常是整数 + 0 到 1 之间
 *   - `block`（方块坐标）是整数，方块占据 [x, x+1) x [y, y+1) x [z, z+1)
 *   - 方块中心 = 方块坐标 + 0.5
 *   - pathfinder 的目标位置必须是方块中心（+0.5），否则会停在方块边缘导致"差一点到不了"
 *   所有换算一律走本文件的 vec3 / blockCenter / blockOf，禁止在业务代码里裸算。
 */

const log = require('./log');

/** 阻塞 ms 毫秒 */
function delay(ms, { signal = null } = {}) {
  if (!signal) return new Promise((r) => setTimeout(r, ms));
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new CancelledError('已取消'));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError('已取消'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

class CancelledError extends Error {
  constructor(message = '已取消') {
    super(message);
    this.name = 'CancelledError';
  }
}

/**
 * 把任意 Promise 包上超时。超时抛 TimeoutError。
 * 注意：这只是"放弃等待"，不会真正中止底层动作；需要真正中止请配合 AbortController。
 */
function withTimeout(promise, ms, message = '动作超时') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class TimeoutError extends Error {
  constructor(message = '动作超时') {
    super(message);
    this.name = 'TimeoutError';
  }
}

/** 轮询等待条件成立：cond() 返回真值即返回该值，超时抛错 */
async function waitFor(cond, { timeoutMs = 10000, intervalMs = 50, message = '等待条件超时', signal = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal && signal.aborted) throw new CancelledError();
    const v = cond();
    if (v) return v;
    if (Date.now() >= deadline) throw new TimeoutError(message);
    await delay(intervalMs, { signal });
  }
}

// ---------------------------------------------------------------- 坐标

/**
 * 构造真正的 Vec3。
 *
 * 为什么必须用它而不是 `{x, y, z}`：mineflayer 内部大量调用 Vec3 的方法
 * （`.floored()` 在 blockAt 里、`.offset()` 在攻击瞄准里），传普通对象会直接
 * 抛 "pos.floored is not a function"。这类错误只在真实运行时才暴露，
 * 所以所有要交给 mineflayer 的坐标一律从这里构造。
 */
function vec3(x, y, z) {
  const { Vec3 } = require('vec3');
  return new Vec3(Number(x) || 0, Number(y) || 0, Number(z) || 0);
}

/** 方块坐标 → 方块中心浮点坐标（Vec3） */
function blockCenter(x, y, z) {
  return vec3(x + 0.5, y + 0.5, z + 0.5);
}

/** 浮点坐标 → 所在方块坐标 */
function blockOf(x, y, z) {
  return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
}

function fmtVec(v, digits = 1) {
  if (!v) return '未知';
  return `(${round(v.x, digits)}, ${round(v.y, digits)}, ${round(v.z, digits)})`;
}

function fmtBlock(b) {
  if (!b) return '未知';
  return `(${b.x}, ${b.y}, ${b.z})`;
}

function round(v, digits = 1) {
  const p = 10 ** digits;
  return Math.round((Number(v) || 0) * p) / p;
}

function distance(a, b) {
  if (!a || !b) return Infinity;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function distanceXZ(a, b) {
  if (!a || !b) return Infinity;
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

// ---------------------------------------------------------------- 错误翻译

/**
 * mineflayer / pathfinder 的报错多为英文且信息量低。这里翻译成"人话 + 下一步建议"，
 * 因为这段文字最终会被塞进 LLM 的上下文，它决定了模型能不能换策略而不是死循环。
 */
function humanizeError(err) {
  const raw = err && err.message ? String(err.message) : String(err);
  const lower = raw.toLowerCase();

  if (lower.includes('path was stopped before it could be completed')) {
    return { reason: '寻路被中断（可能是被挡住或目标不可达）', hint: '可以尝试绕行、先挖开挡路的方块，或换一个更近的目标' };
  }
  // 注意：这里必须限定在**寻路相关**的超时上。
  // 早期版本写成 `|| lower.includes('timeout')`，结果**任何**含 timeout 的错误
  // 都被报成"寻路超时"，还附带"拆成几段短距离移动"的建议——
  // 合成超时、开窗超时、动作超时全被误译成寻路问题，
  // 排查时被严重带偏（实测：合成卡住却一直以为是机器人走不过去）。
  if (
    lower.includes('took to long to decide path to goal') ||
    lower.includes('took too long to decide path to goal') ||
    (lower.includes('path') && (lower.includes('timeout') || lower.includes('timed out')))
  ) {
    return { reason: '寻路超时（目标太远或地形太复杂）', hint: '拆成几段短距离移动，或先靠近再重新移动' };
  }
  if (lower.includes('no path to the goal') || lower.includes('nopath')) {
    return { reason: '找不到通往目标的路径', hint: '目标可能被完全封死或在未加载区域，需要先挖通道或换目标' };
  }
  if (lower.includes('goal was changed')) {
    return { reason: '目标被新的移动指令替换', hint: '这是正常的抢占，重试当前目标即可' };
  }
  if (lower.includes('digging aborted') || lower.includes('block update')) {
    return { reason: '挖掘被中断（方块被替换或距离太远）', hint: '重新靠近目标方块再试' };
  }
  if (lower.includes('did not find') && lower.includes('recipe')) {
    return { reason: '合成配方不存在或材料不足', hint: '先用 mc_inventory 确认材料，必要时先合成中间产物（如木板、木棍）' };
  }
  if (lower.includes('missing ingredient') || lower.includes('not enough')) {
    return { reason: '材料不足', hint: '先补齐材料再合成' };
  }
  // 合成窗口/点击相关的失败：这些最容易表现为"没有产出"，
  // 而真实原因往往是服务端没接受点击（状态不同步）
  // 注意：这里用 'window' / 'slot' 这类明确的窗口词，**不要**匹配 'craft'——
  // 物品名 crafting_table 本身就含 craft，会把所有工作台相关的错误
  // 都误报成"窗口状态不同步"，那和之前'寻路超时'的误译是同一类问题。
  if (
    lower.includes('window') ||
    lower.includes('slot') ||
    lower.includes('click') ||
    lower.includes('selecteditem')
  ) {
    return {
      reason: '合成/容器操作没被服务器接受',
      hint: '通常是窗口状态不同步所致，会自动清空合成格并重试；若持续失败可先停下再试',
    };
  }
  // 通用超时（放在寻路判定**之后**，且不再冒充寻路问题）
  if (lower.includes('timed out') || lower.includes('timeout') || raw.includes('超时')) {
    return { reason: '操作超时（服务器响应慢或动作没完成）', hint: '可以重试一次；反复超时说明服务器负载高或网络不稳' };
  }
  if (lower.includes('no item') || lower.includes('nothing to equip')) {
    return { reason: '背包里没有这件物品', hint: '先获取该物品' };
  }
  if (lower.includes('out of reach') || lower.includes('too far')) {
    return { reason: '目标超出交互距离（约 4.5 格）', hint: '先用 mc_goto 靠近再操作' };
  }
  if (lower.includes('was kicked') || lower.includes('disconnect')) {
    return { reason: '被服务器断开', hint: '检查服务器是否开启正版验证、是否被踢出或封禁' };
  }
  if (lower.includes('unsupported protocol') || lower.includes('version')) {
    return { reason: '协议版本不匹配', hint: '确认服务器版本与配置项 version 一致' };
  }
  if (err instanceof CancelledError) {
    return { reason: '动作被取消', hint: '这是你或系统主动取消的' };
  }
  return { reason: raw, hint: null };
}

/** 组装成插件侧可直接展示、也可直接喂给 LLM 的失败描述 */
function describeFailure(err) {
  const { reason, hint } = humanizeError(err);
  return hint ? `${reason}；建议：${hint}` : reason;
}

// ---------------------------------------------------------------- 杂项

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/** 数组去重（按 key 函数） */
function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const k = keyFn(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

/** 可中断的 sleep 组合器：把多个 AbortSignal 合成一个 */
function anySignal(signals) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) {
      controller.abort();
      break;
    }
    s.addEventListener('abort', onAbort, { once: true });
  }
  return controller.signal;
}

/** 简单的并发闸门：限制同时执行的异步任务数 */
class Semaphore {
  constructor(limit) {
    this._limit = Math.max(1, limit);
    this._active = 0;
    this._waiters = [];
  }

  async acquire() {
    if (this._active < this._limit) {
      this._active += 1;
      return;
    }
    await new Promise((resolve) => this._waiters.push(resolve));
    this._active += 1;
  }

  release() {
    this._active -= 1;
    const next = this._waiters.shift();
    if (next) next();
  }

  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

module.exports = {
  log,
  delay,
  withTimeout,
  waitFor,
  CancelledError,
  TimeoutError,
  vec3,
  blockCenter,
  blockOf,
  fmtVec,
  fmtBlock,
  round,
  distance,
  distanceXZ,
  humanizeError,
  describeFailure,
  pick,
  clamp,
  uniqBy,
  anySignal,
  Semaphore,
};
