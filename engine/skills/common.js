'use strict';
/**
 * 技能层的公共工具。
 *
 * 技能（skill）与原子动作（action）的区别：
 *   - action 是"挖这个方块"，一次调用一件事
 *   - skill 是"弄到 10 个铁矿"，包含寻路、找矿、做工具、挖、捡、失败换目标等一整条链
 *
 * 技能是**可以失败也可以继续**的：这里统一用进度回调把"我现在在干嘛"报上去，
 * 插件侧会把它写进状态简报，LLM 才不会以为机器人在发呆。
 */

const log = require('../log');
const { delay, distance, distanceXZ, CancelledError, describeFailure, vec3 } = require('../util');
const { smoothLook } = require('../humanize');

/** 读某个坐标的方块（坐标必须是 Vec3，mineflayer 不接受普通对象） */
function blockAt(bot, x, y, z) {
  try {
    if (!bot || typeof bot.blockAt !== 'function') return null;
    return bot.blockAt(vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
  } catch {
    return null;
  }
}

/** 技能执行上下文：统一处理取消、进度、预算 */
class SkillContext {
  constructor({ signal, onProgress = null, deadline = null, deps = {} }) {
    this.signal = signal;
    this._onProgress = onProgress;
    this.deadline = deadline;
    this.deps = deps;
    this._lastReport = 0;
    this.notes = [];
  }

  /** 进度上报（节流：同一秒内只发一次，避免刷屏） */
  progress(text, extra = {}) {
    this.notes.push({ at: Date.now(), text });
    if (this.notes.length > 20) this.notes.shift();
    const now = Date.now();
    if (now - this._lastReport < 900) return;
    this._lastReport = now;
    if (this._onProgress) {
      try {
        this._onProgress(text, extra);
      } catch (err) {
        log.debug(`进度回调异常：${err.message}`);
      }
    }
  }

  checkAborted() {
    if (this.signal && this.signal.aborted) throw new CancelledError('技能被取消');
    if (this.deadline && Date.now() > this.deadline) {
      throw new Error('技能执行超时（可能是目标太远或地形太难）');
    }
  }

  get aborted() {
    return !!(this.signal && this.signal.aborted);
  }
}

/** 技能返回值的统一形状 */
function skillResult(ok, { steps = [], produced = {}, consumed = {}, note = null, reason = null, extra = {} } = {}) {
  return {
    ok,
    steps,
    produced,
    consumed,
    note,
    reason,
    ...extra,
  };
}

/** 合并两个产物统计 */
function mergeCounts(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = (out[k] || 0) + v;
  return out;
}

/** 只保留正数的背包差分（产物） */
function positiveOnly(delta) {
  const out = {};
  for (const [k, v] of Object.entries(delta || {})) {
    if (v > 0) out[k] = v;
  }
  return out;
}

/**
 * 通用"收集某物品到指定数量"的驱动器。
 * 传入一个 fetchOne 回调（返回 true 表示这一轮有进展），循环到数量达标或重试耗尽。
 */
async function driveUntil({ have, want, fetchOne, ctx, maxAttempts = 12, label = '收集' }) {
  let attempts = 0;
  let fails = 0;
  let lastError = null;
  const before = have();
  while (have() < want) {
    ctx.checkAborted();
    if (attempts >= maxAttempts) break;
    attempts += 1;
    try {
      const progressed = await fetchOne(attempts);
      if (progressed) {
        fails = 0;
      } else {
        fails += 1;
        if (fails >= 3) {
          lastError = lastError || '连续多次没有进展';
          break;
        }
      }
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      fails += 1;
      lastError = describeFailure(err);
      log.debug(`${label} 第 ${attempts} 次尝试失败：${lastError}`);
      if (fails >= 4) break;
      await delay(400, { signal: ctx.signal });
    }
    ctx.progress(`${label} ${have()}/${want}`);
  }
  const gained = have() - before;
  return { reached: have() >= want, attempts, gained, lastError, current: have() };
}

/**
 * 短距离直接走过去：不经过 pathfinder。
 *
 * 为什么需要：在树冠/狭窄空间里 pathfinder 会直接判定"无路可走"，
 * 但玩家其实只要迈两步就行。给它一个不依赖寻路的走法，这类场景才不会卡死。
 * 只在几格距离内使用；远距离仍然交给 pathfinder。
 *
 * @returns {Promise<boolean>} 是否走到了
 */
async function walkDirect({ bot, ctx, x, z, timeoutMs = 6000, tolerance = 1.2 }) {
  const deadline = Date.now() + timeoutMs;
  let lastDist = Infinity;
  let noProgressRounds = 0;

  while (Date.now() < deadline) {
    if (ctx && ctx.aborted) throw new CancelledError('已取消');
    const pos = bot.entity.position;
    const dx = x - pos.x;
    const dz = z - pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist <= tolerance) {
      bot.setControlState('forward', false);
      bot.setControlState('sprint', false);
      return true;
    }
    if (dist < lastDist - 0.15) {
      noProgressRounds = 0;
    } else {
      noProgressRounds += 1;
    }
    lastDist = dist;

    // 连续没进展：可能是被方块挡住，跳一下试试；再不行就放弃（交由调用方处理）
    if (noProgressRounds >= 8) {
      bot.setControlState('forward', false);
      bot.setControlState('sprint', false);
      return false;
    }
    if (noProgressRounds === 4 && bot.entity.onGround) {
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 200);
    }

    try {
      // 渐进转头（而不是瞬间对准），走路时再加一点轻微扫视——
      // 短距离走动是玩家最常看到她的场景，机械感在这里最刺眼。
      const targetYaw = Math.atan2(-dx, -dz);
      if (typeof smoothLook === 'function') {
        await smoothLook(bot, targetYaw, Math.sin(Date.now() / 3400) * 0.05, { durationMs: 90 });
      } else {
        await bot.look(targetYaw, 0, true);
      }
    } catch {
      /* ignore */
    }
    bot.setControlState('forward', true);
    bot.setControlState('sprint', dist > 6 && Math.random() < 0.6);
    await delay(100, { signal: ctx ? ctx.signal : null });
  }

  bot.setControlState('forward', false);
  bot.setControlState('sprint', false);
  return false;
}

/** 树叶/原木：站在这上面算"在树冠上"，寻路器不会从这么高跳下去 */
const VEGETATION = /(_leaves|_log|_stem|_wood|_hyphae|bamboo|vine|cave_vines|mangrove_roots|azalea|shroomlight|wart_block|nether_wart_block)$/;

/**
 * 在附近找一根"最容易下去"的柱子：往下看，统计到实心地面之间需要挖穿几层植被。
 * 返回代价最小的一根。真玩家在树冠上也会先走到叶子的缝里再下去。
 */
function findBestDescentColumn(bot, { radius = 4, maxScan = 40 } = {}) {
  const p = bot.entity.position;
  const cx = Math.floor(p.x);
  const cy = Math.floor(p.y);
  const cz = Math.floor(p.z);
  let best = null;

  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      const x = cx + dx;
      const z = cz + dz;
      let vegetation = 0;
      let groundY = null;
      for (let dy = 1; dy <= maxScan; dy += 1) {
        const b = bot.blockAt(vec3(x, cy - dy, z));
        if (!b) break;
        if (b.boundingBox === 'block') {
          if (VEGETATION.test(b.name)) {
            vegetation += 1;
          } else {
            groundY = cy - dy + 1; // 站在它上面
            break;
          }
        }
      }
      if (groundY === null) continue; // 下面是虚空/水，不考虑
      const drop = cy - groundY;
      if (drop <= 0) continue;
      // 代价：挖穿的植被层数权重很高（每层都是一次 dig），水平距离次之
      const cost = vegetation * 10 + Math.hypot(dx, dz) * 1.5 + drop * 0.05;
      if (!best || cost < best.cost) {
        best = { x, z, groundY, vegetation, drop, cost, distance: Math.hypot(dx, dz) };
      }
    }
  }
  return best;
}

/**
 * 从树冠降到地面。
 *
 * 为什么必须做：出生点常常是丛林树冠，此时
 *   1) pathfinder 的 maxDropDown 是 3，不会从 30 格高的树冠往下走 → 直接报 noPath
 *   2) 即使勉强走，也会在树叶之间乱转，看起来像"卡住"
 * 真玩家的做法是找叶子的缝隙钻下去，所以这里先挑一根最好下的柱子走过去，再分段下落，
 * 每段不超过 3 格以避免摔伤。
 *
 * @returns {Promise<{ok:boolean, dropped:number, note:string}>}
 */
async function dropToGround({ actions, nav, ctx, maxSegments = 16, minDrop = 2 }) {
  const bot = actions.bot;
  if (!bot || !bot.entity) return { ok: false, dropped: 0, note: '机器人未进服' };

  const startY = Math.floor(bot.entity.position.y);
  let dropped = 0;

  for (let seg = 0; seg < maxSegments; seg += 1) {
    if (ctx && ctx.aborted) throw new CancelledError('已取消');

    const p = bot.entity.position;
    const bx = Math.floor(p.x);
    const by = Math.floor(p.y);
    const bz = Math.floor(p.z);
    const below = bot.blockAt(vec3(bx, by - 1, bz));
    const belowName = below ? below.name : 'unknown';

    // 脚下不是植被 → 已经站在真地面上，收工
    if (below && !VEGETATION.test(belowName)) {
      return { ok: true, dropped, note: `已落地，脚下 ${belowName}（从 y=${startY} 降到 y=${by}）` };
    }

    // 挑一根最好下的柱子；挑不到就用当前这格硬挖
    const column = findBestDescentColumn(bot, { radius: 4 }) || { x: bx, z: bz, groundY: by - 3 };
    // 门槛：只为很小的落差下树不值得——白白打断当前技能。
    // 真玩家站在树枝上也会直接在树上干活，不会为了 1 格高度跳下去。
    if (seg === 0 && column.groundY !== undefined && by - column.groundY < minDrop) {
      return { ok: true, dropped: 0, note: `离地面只差 ${by - column.groundY} 格，不必下树` };
    }
    if (ctx) {
      ctx.progress(`在树冠上，前往 (${column.x}, ${column.z}) 往下走`);
    }

    // 走过去（**直接走，不用 pathfinder**：树冠里寻路会直接判无路，但实际迈两步就到）
    if (column.x !== bx || column.z !== bz) {
      const arrived = await walkDirect({
        bot,
        ctx,
        x: column.x + 0.5,
        z: column.z + 0.5,
        timeoutMs: 6000,
      });
      if (!arrived) {
        log.debug('没能走到理想的下落柱，改用当前位置下降');
      }
    }

    // 分段下降：每段最多 3 格，避免摔伤
    const segTarget = Math.max(column.groundY, by - 3);
    for (let y = by - 1; y >= segTarget; y -= 1) {
      const b = bot.blockAt(vec3(Math.floor(bot.entity.position.x), y, Math.floor(bot.entity.position.z)));
      if (b && b.boundingBox === 'block' && VEGETATION.test(b.name) && b.diggable) {
        try {
          await actions.dig({
            x: b.position.x,
            y: b.position.y,
            z: b.position.z,
            signal: ctx ? ctx.signal : null,
            collect: false,
          });
        } catch (err) {
          if (err instanceof CancelledError) throw err;
          log.debug(`挖树冠 ${b.name} 失败：${err.message}`);
        }
      }
    }

    // 等物理把玩家放下去
    const targetY = segTarget;
    const deadline = Date.now() + 3500;
    while (Date.now() < deadline && bot.entity.position.y > targetY + 0.1) {
      await delay(120, { signal: ctx ? ctx.signal : null });
    }
    const nowY = Math.floor(bot.entity.position.y);
    const delta = by - nowY;
    if (delta <= 0 && seg > 0) {
      // 连续两段没有下降 → 判断为无法继续
      const stillBelow = bot.blockAt(vec3(Math.floor(bot.entity.position.x), nowY - 1, Math.floor(bot.entity.position.z)));
      if (stillBelow && VEGETATION.test(stillBelow.name)) {
        return { ok: false, dropped, note: `卡在 ${stillBelow.name} 上无法继续下降` };
      }
      return { ok: true, dropped, note: `已落地，脚下 ${stillBelow ? stillBelow.name : '未知'}` };
    }
    dropped += Math.max(0, delta);
  }
  return { ok: false, dropped, note: `下降 ${dropped} 格后仍未到地面` };
}

/**
 * 落地稳定：确保机器人踩在实地上再开始干活。
 *
 * 服务器会把玩家放在出生点最高处，丛林地形经常是**树冠**（脚下是树叶）。
 * 站在树冠上时 pathfinder 找不到通往地面的路（maxDropDown 限制），
 * 表现为"寻路立刻失败：找不到路径"。真玩家会自己打叶子下来，所以这里也让它下来。
 *
 * @returns {Promise<{settled:boolean, note:string}>}
 */
async function settle({ actions, nav, ctx, maxWaitMs = 6000 }) {
  const bot = actions.bot;
  if (!bot || !bot.entity) return { settled: false, note: '机器人未进服' };

  // 先确保脚下区块加载好：出生瞬间区块可能还没到，
  // 此时所有 blockAt 都返回 null，会误判成"悬空"。
  if (ctx && typeof ctx.ensureChunks === 'function') {
    await ctx.ensureChunks({ timeoutMs: 10000 });
  }

  // 第一步：等物理把它放到某个平面上（出生瞬间可能在自由落体）
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (ctx && ctx.aborted) throw new CancelledError('已取消');
    if (bot.entity.onGround) break;
    if (ctx) ctx.progress('正在落地');
    await delay(200, { signal: ctx ? ctx.signal : null });
  }

  const pos = bot.entity.position;
  const bx = Math.floor(pos.x);
  const by = Math.floor(pos.y);
  const bz = Math.floor(pos.z);
  const below = bot.blockAt(vec3(bx, by - 1, bz));
  const belowName = below ? below.name : 'unknown';

  // 第二步：如果踩在树冠上、而且离地面确实很高，就降落到地面。
  // 只差一两格时不折腾：真玩家站在低树枝上会直接在树上干活。
  if (below && VEGETATION.test(belowName)) {
    const column = findBestDescentColumn(bot, { radius: 4 });
    const dropDistance = column ? by - column.groundY : 0;
    if (dropDistance >= 3) {
      if (ctx) ctx.progress(`站在 ${belowName} 上，离地面 ${dropDistance} 格，准备下去`);
      const r = await dropToGround({ actions, nav, ctx, minDrop: 3 });
      if (r.ok) {
        const nowPos = bot.entity.position;
        const nowBelow = bot.blockAt(vec3(Math.floor(nowPos.x), Math.floor(nowPos.y) - 1, Math.floor(nowPos.z)));
        return {
          settled: true,
          note: `已从树冠下到地面（下降 ${r.dropped} 格，脚下 ${nowBelow ? nowBelow.name : '?'}）`,
        };
      }
      return { settled: false, note: r.note };
    }
    return { settled: true, note: `站在 ${belowName} 上，离地面仅 ${dropDistance} 格，就地作业` };
  }

  if (!below) {
    return { settled: false, note: '读不到脚下方块（区块可能未加载）' };
  }
  return { settled: true, note: belowName };
}

// ---------------------------------------------------------------- 垂直脱困

/** 危险方块（掉进去会死、挖了会淹/会烧） */
const DANGEROUS = new Set([
  'lava', 'flowing_lava', 'water', 'flowing_water', 'fire', 'magma_block',
  'cactus', 'powder_snow', 'bedrock', 'barrier',
]);

function isDangerousBlock(name) {
  return DANGEROUS.has(String(name || '').replace(/^minecraft:/, ''));
}

/**
 * 她是否在地下（头顶连续两格是实心）。
 * 只判一格不够——站在树下或屋檐下也会"头顶有方块"，那不是地下。
 */
function isUnderground(bot) {
  if (!bot || !bot.entity) return false;
  const p = bot.entity.position;
  const bx = Math.floor(p.x);
  const by = Math.floor(p.y);
  const bz = Math.floor(p.z);
  const solid = (b) => !!b && b.boundingBox === 'block';
  return solid(blockAt(bot, bx, by + 2, bz)) && solid(blockAt(bot, bx, by + 3, bz));
}

/**
 * 在地下时，挖一条阶梯回到地表。
 *
 * **为什么必须有这个**：挖矿是往下走的，挖完她就待在自己挖的洞里
 * （实测：挖到 y=54，而地表在 y=64）。之后任何"需要地表"的事
 * ——砍树做工具、盖庇护所——都会因为**爬不上那 9 格竖井**而失败：
 * 实测报错是"分段也没能走到 (66, -252)：还差 7.7 格。这一带地形可能把路堵死了"。
 * 于是"挖矿 → 做工具 → 盖房"这条链在第二步就断了。
 *
 * 真人下矿挖的是**阶梯**，因为阶梯能原路走回来。这里照做：
 * 往斜上方挖掉两格（脚+头），再走上去（pathfinder 会自动跳 1 格台阶），重复到见天。
 */
async function climbToSurface({ actions, nav, ctx, maxSteps = 24 }) {
  const bot = actions.bot;
  if (!isUnderground(bot)) return { ok: true, steps: 0, already: true };

  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  let climbed = 0;

  for (let i = 0; i < maxSteps; i += 1) {
    ctx.checkAborted();
    if (!isUnderground(bot)) return { ok: true, steps: climbed };

    const p = bot.entity.position;
    const bx = Math.floor(p.x);
    const by = Math.floor(p.y);
    const bz = Math.floor(p.z);
    let advanced = false;

    for (const [dx, dz] of dirs) {
      const tx = bx + dx;
      const tz = bz + dz;
      const feet = blockAt(bot, tx, by + 1, tz);
      const head = blockAt(bot, tx, by + 2, tz);
      if (!feet || !head) continue;
      if (feet.boundingBox === 'block' && (!feet.diggable || isDangerousBlock(feet.name))) continue;
      if (head.boundingBox === 'block' && (!head.diggable || isDangerousBlock(head.name))) continue;
      try {
        ctx.progress(`向上挖阶梯（第 ${climbed + 1} 格）`);
        if (feet.boundingBox === 'block') {
          await actions.dig({ x: tx, y: by + 1, z: tz, signal: ctx.signal, collect: true });
        }
        if (head.boundingBox === 'block') {
          await actions.dig({ x: tx, y: by + 2, z: tz, signal: ctx.signal, collect: true });
        }
        // 走进去：pathfinder 会自动跳上这 1 格台阶
        await nav.goTo({ x: tx, y: null, z: tz, range: 1, signal: ctx.signal, timeoutMs: 10000 });
        climbed += 1;
        advanced = true;
        break;
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        log.debug(`向上挖阶梯失败（换方向）：${err.message}`);
      }
    }

    if (!advanced) {
      // 四个方向都不通：原地往上挖两格再跳（垂直脱困）
      try {
        const up1 = blockAt(bot, bx, by + 2, bz);
        const up2 = blockAt(bot, bx, by + 3, bz);
        if (up1 && up1.boundingBox === 'block' && up1.diggable && !isDangerousBlock(up1.name)) {
          await actions.dig({ x: bx, y: by + 2, z: bz, signal: ctx.signal, collect: true });
          if (up2 && up2.boundingBox === 'block' && up2.diggable && !isDangerousBlock(up2.name)) {
            await actions.dig({ x: bx, y: by + 3, z: bz, signal: ctx.signal, collect: true });
          }
          await nav.jump();
          climbed += 1;
          continue;
        }
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        log.debug(`垂直脱困失败：${err.message}`);
      }
      return {
        ok: false,
        steps: climbed,
        reason: '四个方向都挖不动（可能被基岩/岩浆/领地保护挡住）',
      };
    }
  }

  return { ok: !isUnderground(bot), steps: climbed, reason: '挖了很多格还没见到天' };
}

module.exports = {
  SkillContext,
  skillResult,
  mergeCounts,
  positiveOnly,
  driveUntil,
  settle,
  dropToGround,
  walkDirect,
  findBestDescentColumn,
  climbToSurface,
  isUnderground,
  isDangerousBlock,
};
