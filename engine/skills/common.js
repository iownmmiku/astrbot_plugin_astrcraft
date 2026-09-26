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
      log.info(`${label} 第 ${attempts} 次尝试失败：${lastError}`);
      // **带调用栈，而且要用 warn 级别**。
      //
      // 这类"某个变量是 null"的报错只看消息定位不了是哪一行
      // （实测 "Cannot read properties of null (reading 'y')" 出现过 46 次）。
      // 第一次写成 debug，结果默认 info 级别下**根本没打出来**，
      // 白等了一轮复现。只打第一次，避免 4 次重试刷 4 条。
      if (fails === 1 && err && err.stack) {
        const frames = String(err.stack)
          .split('\n')
          .filter((l) => l.includes('skills/') || l.includes('skills\\') || l.includes('bot/') || l.includes('bot\\'))
          .slice(0, 3)
          .map((l) => l.trim());
        log.warn(`${label} 失败现场：${err.message}｜${frames.join(' ← ')}`);
      }
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
          log.info(`挖树冠 ${b.name} 失败：${err.message}`);
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
 * 她是否"需要往上爬才能出去"。
 *
 * **这个判据踩过一个很严重的坑，写清楚免得再犯。**
 *
 * 原来的定义是"头顶连续两格是实心"——那只能判"有天花板"的情况。
 * 而她真正被困的那种情形**恰恰头顶是空气**：她原地直挖出一个竖井
 * （日志里的"挖 18 格"），井壁是实心的、井口一直通到地表。
 * 于是 `isUnderground` 判定"不在地下" → `climbToSurface` 直接返回
 * `{ok:true, already:true}` **什么都不做** → 她永远留在井底。
 * 这就是"挖下去回不到地表"的根因。
 *
 * 正确的判据是"**靠走能不能出去**"，近似成两件事：
 *   ① 头顶被堵住（有天花板）→ 在地下
 *   ② 她比周围的地面低（在坑/竖井/矿洞里）→ 在地下
 * ② 用周围几列的"地表高度"来量：如果四个方向 6 格外的地表都比她高，
 * 说明她在下面，需要往上爬。
 */
function isUnderground(bot) {
  if (!bot || !bot.entity) return false;
  const p = bot.entity.position;
  const bx = Math.floor(p.x);
  const by = Math.floor(p.y);
  const bz = Math.floor(p.z);
  const solid = (b) => !!b && b.boundingBox === 'block';
  // ① 有天花板
  if (solid(blockAt(bot, bx, by + 2, bz)) && solid(blockAt(bot, bx, by + 3, bz))) return true;
  // ② 比周围地面低（竖井/坑/矿洞）
  // **采样要更远，而且要取"最高值"**（这一轮修的关键）。
  //
  // 原来只采 ±6 格、要求"四个方向里至少三个比她高" —— 而**挖矿挖出来的是宽洞**：
  // ±6 格以内也都被挖空了，于是"周围地面"变成了洞底、她就不算"在地下"，
  // 爬升提前结束。实测症状："爬到 -52 就停了，而平台在 -49"。
  //
  // 现在采三圈（±6 / ±12 / ±20），这样**宽洞外面那圈没被动过的地面**也能采到；
  // 判据改成"**附近最高的一处地面**比她高 2 格以上 → 她还在下面"。
  // 语义上也更对：只要附近还有比她高的地面，她就还没回到地表。
  let sampled = 0;
  let maxSurf = null;
  for (const r of [6, 12, 20]) {
    for (const [dx, dz] of [
      [r, 0],
      [-r, 0],
      [0, r],
      [0, -r],
    ]) {
      const surf = surfaceHeightAt(bot, bx + dx, bz + dz, by);
      if (surf === null) continue;
      sampled += 1;
      if (maxSurf === null || surf > maxSurf) maxSurf = surf;
    }
  }
  if (sampled === 0 || maxSurf === null) return false;
  return maxSurf >= by + 2;
}

/**
 * 找 (x,z) 那一列的**地表高度**（站得上去的那一层 y）。
 *
 * **必须从上往下扫。** 第一版我从她所在的高度往上扫，返回"第一块实心"——
 * 而实心柱子从她那一层开始就是实心的，于是永远返回她自己那层，
 * 判不出"周围地面比我高"，竖井照样检测不到（白改一轮）。
 * 从上往下扫，找到的最高那块实心才是地表。
 */
function surfaceHeightAt(bot, x, z, fromY) {
  const top = fromY + 40;
  for (let y = top; y >= fromY - 8; y -= 1) {
    const b = blockAt(bot, x, y, z);
    if (!b) return null; // 区块没加载
    if (b.boundingBox === 'block') return y + 1; // 站在这块上面
  }
  return null;
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
/**
 * **挖一级台阶上去**：往斜上方挖掉两格（脚+头），再走上去。
 *
 * ## 为什么必须补这个（用户实测反馈："还是不能从坑里面垫出来"）
 *
 * 这个函数的**设计一直写在 `climbToSurface` 的注释里**
 * （"真人下矿挖的是阶梯…往斜上方挖掉两格（脚+头），再走上去，
 * pathfinder 会自动跳 1 格台阶，重复到见天"），
 * **但实现里从来没有这一步** —— 只有"垫脚上升"和"往侧面开洞"两条。
 *
 * 后果（实测，见 `tools/test_pit_escape.js`）：
 *   · 背包里**有方块** → `pillarUpOne` 能把她垫出来 ✅
 *   · 背包里**有镐、没方块** → 只剩"往侧面开洞"，而 1 格宽的竖井里
 *     **开侧洞出不去**（洞是横的，人还在原来的高度）→ **爬 0 格就放弃** ❌
 *
 * 这就是"有镐却爬不出来"的根因。真人遇到这种情况是**挖阶梯**：
 * 斜上方挖两格，跳上去，重复。
 *
 * @returns true = 真的升上去了（会**验证高度**，不靠"走完了"就当成功）
 */
// ============ 「升一格」的共享地基（stepUpOne 三策略共用） ============
//
// 抽出来的理由：这三个策略**各自抄了一份**前置和验证，
// 于是每份都可能被抄漏 —— 实测代价：
//   · `stairUpOne` 抄丢了 `digStepUp` 的 range 教训（1.2 vs 1.5，害我查了几轮）
//   · `digStepUp` 抄丢了「等落地 + 刷新坐标」（pillar 注释里记着的坑：
//     调用方的 by 过期 → 往头顶放 → 服务端 "the block is still there"）
//   · 判据还不统一（dig 绝对层 / stair 相对高度）—— 同一个 bug 修两遍
// **从此只有一份，改这里三个策略同时生效。**
const STEP_UP_RANGE = 1.5; // 到达判据：0.6/1.2 会把「停在 1.58 格」判成没走到（实测）
// **3000（从 6000 砍的）**：竖井/台阶都是 1~2 格的挪动 —— pathfinder 要么很快找到路，
// 要么走不到；走不到时每条烧满超时 × 方向数 = 一轮几十秒（实测 f9：24~51 秒/attempt，
// 2 分钟只升 2 格，测试预算内爬不出去）。快速失败、快速换方向/换策略。
const STEP_UP_TIMEOUT_MS = 3000;

/**
 * 共享前置：**等落地 + 用「现在」的坐标**（返回刷新后的 {bx,by,bz}，落地失败返回 null）。
 *
 * 两个教训都写死在这里：
 * ① 跳跃/寻路都要求站在地上（下落中 jump 是空动作）；
 * ② 调用方的 bx/by/bz 可能是过期快照 —— pillar 实测踩过：
 *    目标格算成 (501,-53,0) 而她人在 -55 → 等于往头顶放 → 被服务端拒。
 */
async function stepUpOnePrelude({ actions, ctx, bx, by, bz, tag }) {
  const bot = actions.bot;
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    if (bot.entity && bot.entity.onGround) break;
    await delay(100, { signal: ctx.signal });
  }
  if (!bot.entity.onGround) {
    log.info(`${tag}：等了 4 秒还没落地，这次跳过`);
    return null;
  }
  const now = bot.entity.position;
  const fresh = { bx: Math.floor(now.x), by: Math.floor(now.y), bz: Math.floor(now.z) };
  if (fresh.bx !== bx || fresh.by !== by || fresh.bz !== bz) {
    log.info(
      `${tag}：位置变了（调用方给 ${bx},${by},${bz}，她现在在 ${fresh.bx},${fresh.by},${fresh.bz}）——按现在的算`,
    );
  }
  return fresh;
}

/**
 * **等落地后读真实高度** —— 跳跃弧线中段的 `floor(pos.y)` 会**虚高 1 格**。
 *
 * 实测现场（mine g10）：手动补位报「y -52 → -50」、第 7 轮读到 y=-50 判为
 * "已经出来了"（任务 done），**测试一量却是 -51.0** —— 全是没落地时读的位置。
 * 表现为「引擎说出来了、测试说还在井里」，根因在**读数时机**不在判据。
 *
 * 落地即返回（常态 0 等待）；最多等 maxMs，防悬挂。
 */
async function settleFloorY(bot, ctx, maxMs = 1500) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (bot.entity && bot.entity.onGround) break;
    await delay(100, { signal: ctx.signal });
  }
  return Math.floor(bot.entity.position.y);
}

/**
 * 共享的「走到目标层并验证」—— **range / 超时 / 验证标准只写这一份**。
 *
 * 三条教训（每条都真踩过，两处实现各踩一次）：
 * ① `range` 必须 1.5：站上 1×1 台阶很难停在格子中心（0.7 常态、1.58 出现过），
 *    range 小了 goTo 会**抛异常**，直接把调用方打到 continue、走不到验证；
 * ② **goTo 抛异常也要验高度**：她可能已经上去了，只是 goTo 觉得没到位；
 * ③ 判据是**绝对层 `afterY >= by + 1`**，不是「比刚才高」：
 *    上一个方向可能已经把她送上去，相对判据会把「已经到了」判成「没动」，
 *    四个方向全失败（dig 的注释里记着这个现场）。
 *
 * @returns true = 真的站到目标层了
 */
async function stepUpOneGoTo({ actions, nav, ctx, tag, nx, by, nz }) {
  let goToFailed = null;
  let goResult = null;
  try {
    goResult = await nav.goTo({ x: nx, y: by + 1, z: nz, range: STEP_UP_RANGE, signal: ctx.signal, timeoutMs: STEP_UP_TIMEOUT_MS });
  } catch (err) {
    if (err instanceof CancelledError) throw err;
    goToFailed = String(err.message).slice(0, 70);
  }
  // 落地后再读 —— 跳跃/走跳的弧线中段 floor 会虚高 1 格（g10 现场：
  // 引擎读 -50 判"出来了"，测试一量是 -51.0 —— 全是没落地时读的位置）
  const afterY = await settleFloorY(actions.bot, ctx, 800);
  if (afterY >= by + 1) {
    log.info(`${tag}：升上去了（现在 y=${afterY}）`);
    return true;
  }

  // **高度不够 → 手动补一步「朝落脚点走+跳」。**
  //
  // 失败现场（mine_return b6 日志）证实了机制：goTo 会
  //   · `arrived=true`（movement.js:465 的早期返回：水平 ≤1.5、高度差 ≤1.2 → 0ms 判到）
  //   · `arrived=true 距离=1.4`（GoalNear 的 3D 判据：站目标斜下 1 格 ≈1.22 ≤ 1.5）
  // 两种情况都**宣布到达却不发起移动** —— 于是从来没有人真的去跳那一步，
  // 高度永远停在原地 → 「垫好落脚点但上上去」。
  // （成功案例是 pathfinder 恰好按路径真走了 1.9 秒 —— 取决于站位，这就是它偶发的原因。）
  //
  // 修法：对两种"假到达"和"游走后回不来"统一兜底 —— 朝**落脚点实际坐标**走+跳。
  // 走跳上 1 格台阶是 MC 的基础动作，没有跳跃窗口问题（目标是旁边的方块，不是自己脚下）。
  const bot = actions.bot;
  // **只有「goTo 说到了」才补位** —— 实测教训：人在几格之外（no-path 失败）时
  // 朝远处台阶瞎跳 600ms，纯属噪音还可能把自己带偏（pit 的 [2] 挖爬 0 升就是这么来的）。
  // 人不在台阶旁边，这一步没有意义：交给下一轮/下一个方向。
  if (!goResult || !goResult.arrived) {
    const far = goResult && goResult.distance_to_target !== undefined ? `（隔 ${goResult.distance_to_target} 格）` : '';
    log.info(`${tag}：goTo 没走到${far}，跳过手动补位（人不在台阶旁）`);
  } else try {
    // **先停掉 pathfinder 的活动目标** —— 上一次 goTo 留下的目标可能还在驱动移动，
    // 和手动 forward/jump 打架（f6 现场：人在台阶旁、arrived=true 距离 0.707，
    // 手动 900ms 纹丝没上去的嫌疑之一）。
    try {
      bot.pathfinder.stop();
    } catch {
      /* 没有活动目标也无所谓 */
    }
    // **先朝落脚点转头** —— 加 arrived 门那次编辑把 lookAt 整行吃掉了（自踩）：
    // 不转头时 forward 朝着她原来面对的方向推，多半撞墙/原地跳 ——
    // 这就是「手动走跳也没上去」的直接原因（f6 现场）。
    await bot.lookAt(vec3(nx + 0.5, by + 0.5, nz + 0.5), true);
    bot.setControlState('forward', true);
    bot.setControlState('jump', true);
    await delay(600, { signal: ctx.signal });
    bot.setControlState('forward', false);
    bot.setControlState('jump', false);
    // **等落地再读** —— 300ms 后往往还在弧线里，floor 虚高 1 格会谎报成功
    // （g10 现场：「-52 → -50」实际落地 -51 → 后续轮次和测试读数全对不上）
    const afterY2 = await settleFloorY(bot, ctx, 1500);
    if (afterY2 >= by + 1) {
      log.info(`${tag}：手动走跳补位成功（y ${afterY} → ${afterY2}）`);
      return true;
    }
    log.info(`${tag}：手动走跳也没上去（y=${afterY2}）`);
  } catch (err) {
    if (err instanceof CancelledError) throw err;
    try {
      bot.setControlState('forward', false);
      bot.setControlState('jump', false);
    } catch {
      /* 复位失败不挡日志 */
    }
    log.info(`${tag}：手动走跳出错：${String(err.message).slice(0, 70)}`);
  }

  // **失败日志必须带 goTo 的 arrived/距离/note/用时** ——
  // 判据教训：失败现场的字段少一个，定性就慢一倍。
  // `note`/`elapsed_ms` 能分辨走了哪条路：
  //   「已在目标附近」+0ms   = movement.js:465 的**早期立即返回**（没动）
  //   「已到达」+几百ms      = pathfinder 的 goal_reached（真走过）
  const arrived = goResult ? `arrived=${goResult.arrived}` : 'goTo 无返回';
  let dist = '';
  if (goResult && goResult.distance_to_target !== undefined) dist = ` 距离=${goResult.distance_to_target}`;
  else if (goResult && goResult.distance !== undefined) dist = ` 距离=${goResult.distance}`;
  const note = goResult && goResult.note ? ` 「${goResult.note}」` : '';
  const elapsed = goResult && goResult.elapsed_ms !== undefined ? ` 用时=${goResult.elapsed_ms}ms` : '';
  log.info(
    `${tag}：没上去（还在 y=${afterY}，目标是 ${by + 1}）；${arrived}${dist}${note}${elapsed}` +
      (goToFailed ? `；goTo 说：${goToFailed}` : ''),
  );
  return false;
}

async function digStepUpImpl({ actions, nav, ctx, bx, by, bz }) {
  const bot = actions.bot;
  log.info(`挖台阶：开始试（我在 ${bx}, ${by}, ${bz}）`);
  // 共享前置：等落地 + 刷新坐标（原来 dig 没有这步 —— 抄丢了 pillar 的教训）
  const fresh0 = await stepUpOnePrelude({ actions, ctx, bx, by, bz, tag: '挖台阶' });
  if (!fresh0) return false;
  ({ bx, by, bz } = fresh0);
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (const [dx, dz] of dirs) {
    const nx = bx + dx;
    const nz = bz + dz;
    // 要挖的是**斜上方那两格**（脚+头），这样她跳上去有地方站
    const s1 = blockAt(bot, nx, by + 1, nz);
    const s2 = blockAt(bot, nx, by + 2, nz);
    if (!s1 || !s2) {
      log.info(`挖台阶：(${nx}, ${nz}) 斜上方读不到方块（s1=${s1 ? s1.name : 'null'} s2=${s2 ? s2.name : 'null'}）`);
      continue;
    }
    // 两格都得是实心且挖得动（已经是空气就不用挖，也算可用）
    const need = [s1, s2].filter((b) => b.boundingBox === 'block');
    if (need.some((b) => !b.diggable)) {
      log.info(`挖台阶：(${nx}, ${nz}) 那两格挖不动（${need.map((b) => b.name).join('/')}）`);
      continue;
    }
    if (need.some((b) => isDangerousBlock(b.name))) {
      log.info(`挖台阶：(${nx}, ${nz}) 是危险方块，跳过`);
      continue;
    }
    // 落脚点必须有支撑：她跳上去要站在 (nx, by+1)，下面是 (nx, by)
    //
    // **没有支撑就先放一块**（这一轮的关键修复，用户"挖矿后回不了地面"的答案）。
    //
    // 为什么这是正解：实测挖完矿之后她**不在 1x1 竖井里，而在一个挖宽的洞穴里**
    // ——周围那一层**四个方向全是空气**，所以"在旁边挖出台阶"这个思路
    // 前提就不成立（四个方向全被这条判据挡掉了，日志里看得很清楚）。
    //
    // 而"垫脚上升"（跳起来往**自己脚下**放）卡在几十毫秒的跳跃窗口里，
    // 服务端一直回 "the block is still there"。
    //
    // **往"旁边"放就没有时序问题**：那一格不归她占，站地上放就行，
    // 不需要跳、不需要赶时间。放好之后它就成了一个新的落脚点，
    // 再挖它上面两格、跳上去 —— 一级台阶就成了。
    let support = blockAt(bot, nx, by, nz);
    if (!support || support.boundingBox !== 'block') {
      const filler = ['cobblestone', 'stone', 'dirt', 'oak_planks', 'sand'].find(
        (n) => actions.countItem(n) > 0,
      );
      if (!filler) {
        log.info(`挖台阶：(${nx}, ${nz}) 落脚点没支撑，而且背包里没有方块可以垫`);
        continue;
      }
      // 那一格必须真的是空的（不然放不下去）
      if (support && support.boundingBox !== 'empty' && support.name !== 'air') {
        log.info(`挖台阶：(${nx}, ${nz}) 落脚点被 ${support.name} 占着，跳过`);
        continue;
      }
      ctx.progress(`先往旁边垫一块（(${nx}, ${by}, ${nz})），造一个落脚点`);
      try {
        await actions.place({ x: nx, y: by, z: nz, item: filler, signal: ctx.signal, reach: true });
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        log.info(`挖台阶：往 (${nx}, ${by}, ${nz}) 垫 ${filler} 失败：${String(err.message).slice(0, 60)}`);
        continue;
      }
      await delay(200, { signal: ctx.signal });
      support = blockAt(bot, nx, by, nz);
      if (!support || support.boundingBox !== 'block') {
        log.info(`挖台阶：垫了但读不到（(${nx}, ${by}, ${nz}) = ${support ? support.name : 'null'}）`);
        continue;
      }
      log.info(`挖台阶：往旁边垫成功了（(${nx}, ${by}, ${nz}) = ${support.name}），现在有落脚点了`);
    }

    ctx.progress(`挖一级台阶上去（往 (${nx}, ${by + 1}, ${nz})）`);
    for (const y of [by + 1, by + 2]) {
      const b = blockAt(bot, nx, y, nz);
      if (!b || b.boundingBox !== 'block') continue;
      try {
        await actions.dig({ x: nx, y, z: nz, signal: ctx.signal, collect: true });
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        log.info(`挖台阶 (${nx}, ${y}, ${nz}) 失败：${err.message}`);
      }
    }
    // 走过去并验证 —— goTo/range/判据都收在 stepUpOneGoTo（见那里的三条教训）
    if (await stepUpOneGoTo({ actions, nav, ctx, tag: '挖台阶', nx, by, nz })) return true;
  }
  return false;
}

/**
 * **头顶是不是真的开了**（= 已经回到地面/露天）。
 *
 * 为什么不能用 `isUnderground` 判"爬出来了"：那个函数看的是
 * "周围 ±6 格的中位地表高度"，而**在挖宽的洞穴里那个"地表"是洞底** ——
 * 于是她刚往上爬一两格就被判"不在地下了"，爬升提前结束。
 * 实测症状："爬到 -52 就停了，而平台在 -49"。
 *
 * 这个判据直接问"我头顶有没有盖"：上方连着 `need` 格都是空气 → 露天了。
 * 在竖井、宽洞、天然矿洞里都成立。
 */
function isOpenSky(bot, need = 3) {
  const p = bot.entity.position;
  const bx = Math.floor(p.x);
  const by = Math.floor(p.y);
  const bz = Math.floor(p.z);
  for (let i = 1; i <= need; i += 1) {
    const b = blockAt(bot, bx, by + i + 1, bz);
    if (!b) return false; // 读不到就别乱判
    if (b.boundingBox === 'block') return false;
  }
  return true;
}

/**
 * **螺旋阶梯上升：往旁边放一块，跳上去，重复。**
 *
 * ## 为什么要这个（用户实测反馈）
 *
 * 用户说："往高处垫的时候，还是做不到跳起来然后往脚下垫方块，
 * **很多时候只能往旁边放**。"
 *
 * 这句话点出了关键：**"往旁边放"是可靠的，"往自己脚下放"不是。**
 *
 * 为什么：
 *   · **往旁边放** —— 那一格不归她占，她**站在地上**放，服务端接受。
 *   · **往脚下放** —— 必须**趁跳跃的空中**把包发出去，而 MC 的跳跃全程只有
 *     约 0.5 秒、最高点在 ~0.25 秒。等放置包到达服务端时她**已经落回那一格**了，
 *     服务端回 `Server refused to place ... the block is still [occupied]`。
 *     （试过"起跳前先瞄准"省掉转头那次往返，也没解决。）
 *
 * ## 做法：既然"往旁边放"可靠，就用它来上升
 *
 *   ① 她站在实地上 `(bx, by, bz)`
 *   ② **往旁边那一格的地面位置放一块**（`(nx, by, nz)`）—— 站着放
 *   ③ **跳上那一块**（1 格台阶）→ 她现在在 `(nx, by+1, nz)`
 *   ④ 重复 ②③ → 高度 +1、+1、+1…**螺旋上升**
 *
 * **每一步都不涉及"往自己脚下放"** —— 所以没有那个时序窗口。
 *
 * @returns true = 真的升上去了（**验证高度**，不信 goTo 的返回值）
 */
async function stairUpOneImpl({ actions, nav, ctx, bx, by, bz }) {
  const bot = actions.bot;
  const CANDIDATES = ['cobblestone', 'stone', 'dirt', 'oak_planks', 'sand', 'netherrack'];
  const filler = CANDIDATES.find((n) => actions.countItem(n) > 0);
  if (!filler) return false;

  // 共享前置：等落地 + 刷新坐标（等落地 / 过期坐标两个坑都在 stepUpOnePrelude 里）
  const fresh0 = await stepUpOnePrelude({ actions, ctx, bx, by, bz, tag: '螺旋阶梯' });
  if (!fresh0) return false;
  ({ bx, by, bz } = fresh0);

  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  for (const [dx, dz] of dirs) {
    const nx = bx + dx;
    const nz = bz + dz;
    const foot = blockAt(bot, nx, by, nz); // 要放方块的那一格（她脚的高度）
    const stand = blockAt(bot, nx, by + 1, nz); // 跳上去之后站的位置
    const above = blockAt(bot, nx, by + 2, nz); // 头顶
    if (!foot || !stand || !above) continue;
    // 那一格得是空的才能放；站的位置和头顶也得是空的
    const empty = (b) => b.boundingBox === 'empty' || b.name === 'air';
    if (!empty(stand) || !empty(above)) continue;
    if (isDangerousBlock(stand.name) || isDangerousBlock(above.name)) continue;

    // **脚那一格已经有方块了 → 不用放，直接跳上去就行**
    const needPlace = empty(foot);
    if (needPlace) {
      if (!empty(foot)) continue;
      ctx.progress(`往旁边垫一块（(${nx}, ${by}, ${nz})），再跳上去`);
      try {
        // **站着放** —— 这是关键：没有跳跃窗口，服务端会接受
        await actions.place({ x: nx, y: by, z: nz, item: filler, signal: ctx.signal, reach: true });
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        log.info(`螺旋阶梯：往 (${nx}, ${by}, ${nz}) 放 ${filler} 失败：${String(err.message).slice(0, 60)}`);
        continue;
      }
      await delay(250, { signal: ctx.signal });
      const placed = blockAt(bot, nx, by, nz);
      if (!placed || placed.boundingBox !== 'block') {
        log.info(`螺旋阶梯：放了但读不到（(${nx}, ${by}, ${nz}) = ${placed ? placed.name : 'null'}）`);
        continue;
      }
    }

    // 跳上去并验证（共用 stepUpOneGoTo —— 顺带把判据从「相对高了」
    // 统一成 dig 注释里论证过的「绝对层 >= by+1」：上一个方向可能已经把她送上去，
    // 相对判据会把「已经到了」判成「没动」→ 四个方向全失败）
    if (await stepUpOneGoTo({ actions, nav, ctx, tag: '螺旋阶梯', nx, by, nz })) return true;
  }
  return false;
}

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
  // **连续"一级都没升上去"的次数**（这一轮加的）。
  //
  // 用来判"确实上不去了"，而不是靠 `isUnderground` 猜 —— 见下面的说明。
  let stalledRounds = 0;
  // **内联「向上挖阶梯」试过一次走不到就不再试** —— 实测（h15/j20）：
  // 这个策略在 1×1 竖井里四个方向**全部** `走不到`（pathfinder 磨到超时），
  // 每轮白烧 7~20 秒，而技能总预算只有 300 秒（挖矿还要吃 ~100 秒）——
  // j20 现场：她爬到 -51（只差 2 格）时测试先到点。
  // 走不到是几何结论，本轮试过就不会突然变通；活路在下面的
  // digStepUp（带垫支撑 + 手动补位，日志里成功案例全是它）。
  let inlineFutile = false;
  let lastY = Math.floor(bot.entity.position.y);

  for (let i = 0; i < maxSteps; i += 1) {
    ctx.checkAborted();

    // **每轮都打一条**（这一轮加的，为了不再靠猜）。
    // 一次就能看出"是循环提前退出了，还是四个方向都挖不动了" ——
    // 这两件事的修法完全不同，而之前我分不清。
    {
      const pp = bot.entity.position;
      log.info(
        `爬升第 ${i + 1}/${maxSteps} 轮：我在 y=${Math.floor(pp.y)}，` +
          `isUnderground=${isUnderground(bot)}`,
      );
    }

    // **退出判据**：不再单看"头顶有没有盖"。
    //
    // 试过 `isOpenSky`（上方连着 3 格空气就算出来），**在竖井里是错的** ——
    // 竖井本身就是一根通天的空气柱，于是她刚起步就被判"已经出来了"，
    // 实测直接报"已经爬回地面，挖了/垫了 0 格"，而她还在 -59。
    //
    // 真正的问题是 `isUnderground` 里"地表"的定义：
    // 它取周围 ±6 格的**中位数**，而**挖宽的洞穴里 ±6 格也都被挖空了**，
    // 于是"地表"变成了洞底、她就不算"在地下"了。
    // 已把那里改成**取最高值 + 取样更远**（见 isUnderground），
    // 所以这里可以放心用回它。
    if (!isUnderground(bot)) {
      log.info(`爬升：判为"已经出来"了（第 ${i + 1} 轮，y=${Math.floor(bot.entity.position.y)}，共爬 ${climbed} 格）`);
      return { ok: true, steps: climbed };
    }

    // 兜底：连续 3 轮高度没变化 → 确实上不去了，别空转到 maxSteps
    const nowY = Math.floor(bot.entity.position.y);
    if (nowY > lastY) {
      stalledRounds = 0;
      lastY = nowY;
    } else if (nowY < lastY) {
      // **掉了 → 停滞计数重新起算**（实测铁证，f7 现场）：
      // `lastY` 原来永远停在历史最高点 —— 掉下去之后每一轮都是 `nowY < lastY`
      // 全被记进 else 分支当「没进展」，3 轮就误杀。f7 的日志：
      //   第 8 轮 y=-55 → 第 9 轮 y=-54 → 第 10 轮 y=-53（**连升 3 轮**）
      //   紧接着却报「连续 3 轮都在 y=-53」—— 因为 lastY 卡在掉落前的 -52。
      // 掉落也是「动了」：给她 3 轮从新高度重新爬（硬上限还有 maxSteps 兜着，
      // 最坏情况也只是把 40 轮跑满，不会无限转）。
      log.info(`爬升：掉了 ${lastY - nowY} 格（${lastY} → ${nowY}），停滞计数重新起算`);
      stalledRounds = 0;
      lastY = nowY;
    } else {
      stalledRounds += 1;
      if (stalledRounds >= 3) {
        log.info(`爬升停滞（连续 3 轮都在 y=${nowY}），停下`);
        return { ok: false, steps: climbed, reason: `连着 3 轮都没能再往上（卡在 y=${nowY}）` };
      }
    }

    const p = bot.entity.position;
    const bx = Math.floor(p.x);
    const by = Math.floor(p.y);
    const bz = Math.floor(p.z);
    let advanced = false;

    // （inlineFutile 时 dirs 传空数组 = 本轮跳过内联尝试，直接落到 digStepUp）
    for (const [dx, dz] of (inlineFutile ? [] : dirs)) {
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
        //
        // **这里必须带上高度（y: by + 1），否则永远爬不上去。**
        // 踩过：原来写的是 `{x: tx, y: null, z: tz, range: 1}` —— 目标是"旁边那一格"，
        // 而她本来就在 1 格范围内，`goTo` **立刻判定"已到达"就返回了**，
        // 一次都没真的往上走。日志里就是"爬出矿道：24 格（ok=false）"：
        // 挖了 24 级台阶、一级都没踩上去。
        //
        // **超时 10000 → 1500**（这一轮砍两刀的第二刀）：
        // 第一刀 10000→3000 后实测每轮仍要 35~40 秒 —— 这个内联尝试在 1×1 竖井里
        // **四个方向全部走不到**（tigh 几何 pathfinder 秒判不了就磨到超时），
        // 每轮白烧 ~20 秒，而技能总预算 300 秒（含挖矿 ~100 秒），
        // 剩 ~200 秒 ÷ 35 秒/轮 = 只够 6 轮 —— h15 实测「共爬 6 格」后超时。
        // 真走得通的路径（1~2 格）都在 1 秒内出结果；1.5 秒走不到 = 这条几何走不到，
        // 快速让位给下面的 digStepUp（带垫支撑 + 手动补位，实测那条才是活路）。
        await nav.goTo({ x: tx, y: by + 1, z: tz, range: 0.9, signal: ctx.signal, timeoutMs: 1500 });
        // **用位置验证"真的升高了"，不信 goTo 的返回值。**
        // 它可能因为"附近有可站立点"之类的判断原地成功返回——
        // 实测那样会 24 级台阶一级都没踩上，而 climbed 却在涨。
        // （落地后再读：跳跃弧线中段 floor 虚高 1 格，同 settleFloorY 的理由）
        const nowY = await settleFloorY(bot, ctx, 800);
        if (nowY <= by) {
          log.debug(`挖了台阶但没上去（${by} → ${nowY}），换个方向或换办法`);
          continue;
        }
        climbed += 1;
        advanced = true;
        break;
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        log.info(`向上挖阶梯失败（换方向）：${err.message} —— 这条几何走不通，后续轮次跳过该策略`);
        inlineFutile = true;
      }
    }

    if (!advanced) {
      log.info(
        `爬升：第 ${i + 1} 轮四个方向都走不通（我在 y=${Math.floor(bot.entity.position.y)}，共爬 ${climbed} 格）`,
      );
      // **四个方向都挖不出阶梯——这是竖井（1 格宽）的典型情形。**
      //
      // 原来的做法是"原地往上挖两格再跳一下"，那**根本出不去**：
      // 跳起来只是暂时离地，落下来还是井底。真人有两个办法，这里都做：
      //   ① **垫脚上升**：挖掉头顶那格 → 跳 → 趁在空中往脚下那格放一块 → 站上去
      //   ② **先往侧面开一格**（挖出一个落脚点）→ 之后就有空间挖正常阶梯了
      // 先试 ①（快），没方块可垫就试 ②。
      const up1 = blockAt(bot, bx, by + 2, bz);
      if (up1 && up1.boundingBox === 'block' && up1.diggable && !isDangerousBlock(up1.name)) {
        try {
          await actions.dig({ x: bx, y: by + 2, z: bz, signal: ctx.signal, collect: true });
        } catch (err) {
          if (err instanceof CancelledError) throw err;
        }
      }
      // **先挖阶梯**（这一轮调换了顺序）。
      //
      // 为什么挖阶梯要在垫脚上升**前面**：
      //   · 挖阶梯**不依赖时序** —— 挖掉两格、走过去，随时都能做
      //   · 垫脚上升卡在**几十毫秒的跳跃窗口**里（要赶在落地前把包发出去），
      //     我在这上面来回好几轮了，服务端一直回 "the block is still there"
      //   · **真人下矿回来挖的就是阶梯** —— 能原路走回来，不需要方块
      // 所以：先试不依赖时序的，再试快的但脆的。
      if (await digStepUp({ actions, nav, ctx, bx, by, bz })) {
        climbed += 1;
        continue;
      }
      // **先试螺旋阶梯**（这一轮加的）。
      //
      // 为什么排在"垫脚上升"前面：用户实测"跳起来往脚下放"做不到，
      // **而"往旁边放"是可靠的** —— 螺旋阶梯只用到"往旁边放"，
      // 所以它没有那个几十毫秒的跳跃窗口。
      if (await stairUpOne({ actions, nav, ctx, bx, by, bz })) {
        climbed += 1;
        continue;
      }
      // 垫脚上升降级成备选：它有时能用（比如四周都被挡住、没地方放旁边）
      if (await pillarUpOne({ actions, ctx, bx, by, bz })) {
        climbed += 1;
        continue;
      }
      if (await widenShaft({ actions, nav, ctx, bx, by, bz })) {
        log.debug('竖井里没方块可垫，改成往侧面开一格，之后再挖阶梯');
        continue;
      }
      // 两条路都不行：**如实停下**，别假装在爬
      return {
        ok: false,
        steps: climbed,
        reason:
          '在竖井里往上爬失败：既没有方块可以垫脚（垫脚上升），' +
          '侧面的方块也挖不动（开侧洞）。可以让她先 mc_collect 拿点方块，或者直接放弃这个矿洞',
      };
    }
  }

  return { ok: !isUnderground(bot), steps: climbed, reason: '挖了很多格还没见到天' };
}

/**
 * **垫脚上升**：跳起来往自己脚下那格放一块，站上去。成功返回 true。
 *
 * 这是真人从 1 格宽竖井里出来的标准办法（"tower up"）：
 * 竖井里没有落脚点可挖，只能**自己造一个**。
 *
 * 要点：
 *   1. 得先有方块（背包里有石头/泥土都行）
 *   2. 必须**趁跳起来的时候**放——站在地上放，那格是她自己占着的，服务端会拒
 *   3. 放完要等一下让她落在那块上
 */
async function pillarUpOneImpl({ actions, ctx, bx, by, bz }) {
  const bot = actions.bot;
  const CANDIDATES = ['cobblestone', 'stone', 'dirt', 'oak_planks', 'sand', 'netherrack'];
  const block = CANDIDATES.find((n) => actions.countItem(n) > 0);
  if (!block) return false;

  // 共享前置：等落地 + 刷新坐标 —— 上面那段「过期坐标」的教训
  // 已经搬进 stepUpOnePrelude（原来这里有一份单独实现 + 一份长注释）
  const fresh0 = await stepUpOnePrelude({ actions, ctx, bx, by, bz, tag: '垫脚上升' });
  if (!fresh0) return false;
  ({ bx, by, bz } = fresh0);

  try {
    // **跳起来，然后等"她真的离地了"再放。**
    //
    // 踩过：只 `jump` 130ms 就放，那时她还在原地 —— 服务端直接拒
    // （"Server refused to place: the block is still…"），因为那一格被她自己占着。
    // 真人的手法是**跳到最高点附近**放，这时身体已经离开那一格了。
    //
    // **起跳前先瞄准正下方**（这一轮加的，用户实测"挖矿后回不了地面"的修复）。
    //
    // 为什么必须预瞄：`actions.place` 内部会 `lookAt`（force）—— 那是一次**网络往返**。
    // 而 MC 的跳跃全程只有约 0.5 秒、最高点在 ~0.25 秒；等"离地 0.7 格"的判据满足时
    // 已经过去 ~150ms，再花一次往返去转头，**包发出去时她已经落回那一格了**。
    // 实测报错正是这个：
    //   Server refused to place cobblestone at (498, -53, 0): the block is still…
    // 预先瞄准之后，`place` 里的 `lookAt` 发现"已经朝着那了"，**瞬间返回**，
    // 于是包能早 100~200ms 发出去，落在窗口里。
    try {
      await bot.lookAt(vec3(bx + 0.5, by + 0.5, bz + 0.5), true);
    } catch {
      /* 瞄不准也继续试 */
    }
    bot.setControlState('jump', true);
    let airborne = false;
    for (let i = 0; i < 12; i += 1) {
      await delay(50, { signal: ctx.signal });
      const p = bot.entity.position;
      // 离地 0.7 格以上，那一格就空出来了
      if (!bot.entity.onGround && p.y - by >= 0.7) {
        airborne = true;
        break;
      }
    }
    bot.setControlState('jump', false);
    if (!airborne) {
      log.info('垫脚上升：没跳起来（可能头顶被挡），改用别的办法');
      return false;
    }
    // 趁在空中往脚下那格放（reach:false —— 空中不能去寻路）
    //
    // **失败就立刻再试一次**：她可能还在空中，第二次（不用转头了）来得及。
    let placeErr = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await actions.place({ x: bx, y: by, z: bz, item: block, signal: ctx.signal, reach: false });
        placeErr = null;
        break;
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        placeErr = err;
        log.info(`垫脚上升：第 ${attempt + 1} 次放置被拒（${String(err.message).slice(0, 60)}），再试一次`);
      }
    }
    if (placeErr) throw placeErr;
    await delay(260, { signal: ctx.signal });
    // 验证真的站上去了：脚下那块应该是她刚放的那块
    const below = blockAt(bot, bx, by, bz);
    if (below && below.name === block) return true;
    log.info(`垫脚上升没成（脚下是 ${below ? below.name : '读不到'}，放的是 ${block}）`);
    return false;
  } catch (err) {
    if (err instanceof CancelledError) throw err;
    log.info(`垫脚上升失败：${err.message}`);
    return false;
  }
}

/**
 * **统一的「升一格」入口（带策略）。**
 *
 * 三个策略共享同一套前置（等落地+刷新坐标）、同一套
 * goTo/range/验证标准（stepUpOneGoTo / stepUpOnePrelude），
 * 只有「怎么动那一步」不同：
 *   · `dig`   —— 挖斜上方两级（顺带先给落脚点垫一块）
 *   · `stair` —— 往旁边放一块、跳上去（螺旋）
 *   · `pillar` —— 跳起来往自己脚下放（时机敏感，是 stair 的降级备选）
 *
 * 抽在这里的原因：**三个平行实现 = 同一个坑要踩三遍**（已实测两次）。
 * 调用点/导出名保持不变（`digStepUp` / `stairUpOne` / `pillarUpOne` 是下面的薄壳）。
 */
async function stepUpOne({ strategy, actions, nav, ctx, bx, by, bz }) {
  if (strategy === 'dig') return digStepUpImpl({ actions, nav, ctx, bx, by, bz });
  if (strategy === 'stair') return stairUpOneImpl({ actions, nav, ctx, bx, by, bz });
  if (strategy === 'pillar') return pillarUpOneImpl({ actions, ctx, bx, by, bz });
  throw new Error(`未知的 stepUpOne 策略：${String(strategy)}`);
}

// 薄壳：调用点（climbToSurface / traverse 的 pave）和 module.exports 名字都不用动
async function digStepUp(args) {
  return stepUpOne({ ...args, strategy: 'dig' });
}
async function stairUpOne(args) {
  return stepUpOne({ ...args, strategy: 'stair' });
}
async function pillarUpOne(args) {
  return stepUpOne({ ...args, strategy: 'pillar' });
}

/**
 * **开侧洞**：把竖井侧面挖一格，造出一个落脚点，之后就能挖正常阶梯了。
 *
 * 为什么需要：竖井里四个方向的"斜上方"那一格**下面没有地板**，
 * 走进去只会掉回来。先在**自己这一层**往侧面挖掉一格，那一格的地板
 * （井壁往下那块）是实心的 → 她就能站过去 → 从那里挖阶梯就成立。
 */
async function widenShaft({ actions, nav, ctx, bx, by, bz }) {
  const bot = actions.bot;
  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    const tx = bx + dx;
    const tz = bz + dz;
    const wall = blockAt(bot, tx, by, tz);
    const wallHead = blockAt(bot, tx, by + 1, tz);
    const floor = blockAt(bot, tx, by - 1, tz);
    // 要能挖，而且那一格**下面必须有地板**（否则站过去就掉下去）
    if (!wall || wall.boundingBox !== 'block' || !wall.diggable || isDangerousBlock(wall.name)) continue;
    if (!floor || floor.boundingBox !== 'block') continue;
    try {
      await actions.dig({ x: tx, y: by, z: tz, signal: ctx.signal, collect: true });
      if (wallHead && wallHead.boundingBox === 'block' && wallHead.diggable && !isDangerousBlock(wallHead.name)) {
        await actions.dig({ x: tx, y: by + 1, z: tz, signal: ctx.signal, collect: true });
      }
      // 站过去（同样要带高度，否则"已到达"就返回了，人没动）
      await nav.goTo({ x: tx, y: by, z: tz, range: 0.9, signal: ctx.signal, timeoutMs: 8000 });
      // 同样验证真的挪过去了
      const np = bot.entity.position;
      if (Math.abs(np.x - (tx + 0.5)) > 1.6 || Math.abs(np.z - (tz + 0.5)) > 1.6) {
        log.debug('开侧洞：挖开了但没挪过去，换个方向');
        continue;
      }
      return true;
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      log.info(`开侧洞失败（换方向）：${err.message}`);
    }
  }
  return false;
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
  // **垫脚上升要导出**（B 批次）：pave 的"垂直垫高"要复用它。
  // 不导出的话只能复制一份——而它的时序很讲究（跳起来、等真离地 0.7 格以上、
  // 趁空中往脚下放，站地上放会被服务端拒绝），复制一份必然会走样。
  pillarUpOne,
  stepUpOne,
  // **挖阶梯**（这一轮补的）：有镐没方块时唯一能出来的路。
  // 见 digStepUp 的注释——它的设计一直写在 climbToSurface 的文档里，
  // 但实现里从来没有，用户实测"有镐却爬不出来"就是这个原因。
  digStepUp,
  stairUpOne,
};
