'use strict';
/**
 * 拟人化动作层：让她的动作不像机器。
 *
 * ## 机器人最容易被一眼看穿的三个破绽
 *
 * 1. **瞬间转头**。mineflayer 的 `bot.look()` 一次就把整个角度转完——
 *    传 `force=true/false` 只影响"是否等服务器确认"，**不会**让它渐进旋转。
 *    真人转头是有过程的（100~200 毫秒，起手快收尾慢）。
 * 2. **永远在冲刺**。真人只在赶路时冲刺，走近了会换成走，累了会停一下。
 * 3. **走得像尺子量过**。真人走路会左右看、会为看点东西停半秒。
 *
 * 这一层只做"表现层"的润色，不改变任何决策与安全性：
 * 该到哪还是到哪，该挖的方块照挖，只是过程看起来像人在操作。
 *
 * 用法上都是"可降级"的：任何一步失败都不抛错，最差退化成原来的机械动作。
 */

const log = require('./log');
const { delay, CancelledError } = require('./util');

/** 两个角度之间的最短差值（处理 ±π 环绕） */
function shortestAngle(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * 渐进转头：把一次大角度旋转拆成若干小步，每步发一次视角包。
 *
 * @param {object} bot mineflayer bot
 * @param {number} yaw 目标偏航（弧度）
 * @param {number} pitch 目标俯仰（弧度）
 * @param {object} [o]
 * @param {number} [o.durationMs] 总时长，默认按角度大小自适应（小角度更快）
 * @param {object} [o.signal] 取消信号
 * @param {boolean} [o.easeOut] 是否用"起手快、收尾慢"的曲线（默认开）
 */
async function smoothLook(bot, yaw, pitch, { durationMs = null, signal = null, easeOut = true } = {}) {
  if (!bot || !bot.entity) return false;
  const startYaw = bot.entity.yaw;
  const startPitch = bot.entity.pitch;
  const dYaw = shortestAngle(startYaw, yaw);
  const dPitch = pitch - startPitch;
  const magnitude = Math.abs(dYaw) + Math.abs(dPitch) * 0.5;

  // 小角度转得快、大角度转得慢——真人也是这样
  const total = durationMs !== null ? durationMs : Math.min(320, 70 + magnitude * 90);
  const steps = Math.max(2, Math.min(10, Math.round(total / 35)));
  const stepMs = total / steps;

  for (let i = 1; i <= steps; i += 1) {
    if (signal && signal.aborted) return false;
    const t = i / steps;
    const e = easeOut ? 1 - (1 - t) * (1 - t) : t;
    try {
      await bot.look(startYaw + dYaw * e, startPitch + dPitch * e, true);
    } catch (err) {
      log.debug(`渐进转头失败：${err.message}`);
      return false;
    }
    if (i < steps) await delay(stepMs, { signal });
  }
  return true;
}

/** 平滑地看向某个世界坐标（点的上方一点，像人在看"人"而不是看脚） */
async function smoothLookAt(bot, point, { durationMs = null, signal = null, eyeOffset = 0 } = {}) {
  if (!bot || !bot.entity || !point) return false;
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0);
  const dx = point.x - eye.x;
  const dy = (point.y + eyeOffset) - eye.y;
  const dz = point.z - eye.z;
  const ground = Math.hypot(dx, dz);
  if (ground < 0.05 && Math.abs(dy) < 0.05) return true;
  const yaw = Math.atan2(-dx, -dz);
  const pitch = Math.atan2(dy, ground);
  return smoothLook(bot, yaw, pitch, { durationMs, signal });
}

/**
 * 走路时的"头部微动"：在朝向前方的基础上加一点小偏移。
 *
 * 真人走路不是死死盯着正前方——会略微左右扫视。
 * 偏移很小（±8°以内）且平滑变化，不会影响寻路（寻路用的是自己的朝向逻辑）。
 */
class WalkGaze {
  constructor(bot, { amplitude = 0.14, periodMs = 2600 } = {}) {
    this._bot = bot;
    this._amp = amplitude;
    this._period = periodMs;
    this._phase = Math.random() * Math.PI * 2;
    this._t0 = Date.now();
  }

  /** 当前应该叠加的偏航偏移量 */
  offset() {
    const t = (Date.now() - this._t0) / this._period;
    return Math.sin(this._phase + t * Math.PI * 2) * this._amp;
  }
}

/**
 * 人味微停：偶尔停下来半秒左右（看一眼周围、像在判断方向）。
 * 返回是否真的停了（便于调用方决定要不要跳过这一轮）。
 */
function maybeIdlePause({ chance = 0.06 } = {}) {
  return Math.random() < chance;
}

/** 停顿的时长（毫秒）：短促但可感知 */
function idlePauseMs() {
  return 260 + Math.floor(Math.random() * 520);
}

/**
 * 速度选择：真人不会一直冲刺。
 * 距离远、且"有精神"时才冲刺；靠近目标、或心情悠闲时就走着去。
 *
 * **"心情"来自她的真实状态，不是随机数。**
 * 原来是 `Math.random() < 0.35` 决定"悠闲还是正常"——那只是随机抖动，
 * 和她此刻想干什么完全无关。现在插件会把她的动机水位（悠闲欲 / 探索欲…）
 * 推下来，走路节奏就跟着心情变：
 *   - 悠闲欲高 → 走得慢、常停、很少冲
 *   - 探索欲高 → 爱跑、停顿少
 * 拿不到心情时退回随机（保持原来的观感，不会变机械）。
 */
class Gait {
  constructor() {
    this._mood = Math.random() < 0.35 ? 'leisurely' : 'normal';
    this._moodUntil = Date.now() + 20000 + Math.random() * 40000;
    /** 外部推下来的心情：{label, drive, intensity, urgency} */
    this._external = null;
  }

  /**
   * 接收她的真实心情（由引擎在 config.update 时调用）。
   * @param {{label?:string, drive?:string, intensity?:number, urgency?:number}} mood
   */
  setMood(mood) {
    this._external = mood && typeof mood === 'object' ? mood : null;
    if (!this._external) return;
    // 心情直接决定基调：悠闲欲高就是"leisurely"，其余按强度分档
    const drive = String(this._external.drive || '');
    const urgency = Number(this._external.urgency);
    if (Number.isFinite(urgency) && urgency > 0.7) this._mood = 'hurried';
    else if (/悠闲|leisure/.test(drive) || /悠闲/.test(String(this._external.label || ''))) {
      this._mood = 'leisurely';
    } else if (/探索|explore/.test(drive)) this._mood = 'normal';
    else this._mood = 'normal';
    // 有真实心情时就不再随机切换，直到心情被清掉
    this._moodUntil = Date.now() + 120000;
  }

  refresh() {
    if (this._external) return; // 真实心情优先，不随机
    if (Date.now() > this._moodUntil) {
      this._mood = Math.random() < 0.35 ? 'leisurely' : 'normal';
      this._moodUntil = Date.now() + 20000 + Math.random() * 40000;
    }
  }

  /** 是否该冲刺 */
  shouldSprint(distance) {
    this.refresh();
    if (distance < 5) return false; // 近了就不冲了，真人也是
    if (this._mood === 'leisurely') return Math.random() < 0.25; // 悠闲时偶尔小跑一下
    if (this._mood === 'hurried') return distance > 8 ? Math.random() < 0.95 : Math.random() < 0.7;
    return distance > 12 ? Math.random() < 0.85 : Math.random() < 0.5;
  }

  get mood() {
    this.refresh();
    return this._mood;
  }
}

/**
 * 空闲时的"环顾四周"：随机转一个小角度，像人在等的时候东张西望。
 * 只在小范围内动（±40°以内），不会把身体带偏。
 */
async function idleLookAround(bot, { signal = null, maxYaw = 0.7 } = {}) {
  if (!bot || !bot.entity) return false;
  const yaw = bot.entity.yaw + (Math.random() * 2 - 1) * maxYaw;
  const pitch = (Math.random() * 2 - 1) * 0.22; // 略微抬头/低头
  try {
    return await smoothLook(bot, yaw, pitch, { signal, durationMs: 220 + Math.random() * 260 });
  } catch (err) {
    if (err instanceof CancelledError) throw err;
    return false;
  }
}

module.exports = {
  smoothLook,
  smoothLookAt,
  WalkGaze,
  Gait,
  maybeIdlePause,
  idlePauseMs,
  idleLookAround,
  shortestAngle,
};
