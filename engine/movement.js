'use strict';
/**
 * 移动与寻路。用的是 mineflayer-pathfinder 的 A*，它与 prismarine-physics 配合，
 * 走、跳、上下台阶、落地的行为与原版玩家一致——这正是旧版自研协议栈做不到的地方。
 *
 * 几个踩过的坑写在这里，改代码前先看：
 *   1. 目标坐标必须是"方块中心"（+0.5），否则 pathfinder 会判定"差一点到不了"而反复抖动
 *   2. 目标如果不可站立（比如是石头内部），要用 GoalNear 而不是 GoalBlock
 *   3. 监听 goal_reached 必须配套 removeListener，否则任务多了会内存泄漏 + 重复 resolve
 *   4. 停止寻路要同时 bot.pathfinder.stop() 和清掉自制监听，只做一半会导致"取消了但还在走"
 */

const { goals } = require('mineflayer-pathfinder');
const log = require('./log');
const { delay, distance, distanceXZ, blockOf, fmtVec, CancelledError, TimeoutError, describeFailure, vec3 } = require('./util');
const {
  smoothLook,
  smoothLookAt,
  WalkGaze,
  Gait,
  maybeIdlePause,
  idlePauseMs,
  idleLookAround,
} = require('./humanize');

/** 判定"到达"的容差：目标点周围这么多格内有可站立位置就算到 */
const ARRIVE_RADIUS = 1;

/** 软植被：寻路时可以蹭掉的方块（树叶、藤蔓、草、花之类），不算"拆建筑" */
const SOFT_VEGETATION_EXACT = new Set([
  'vine', 'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'snow',
  'bamboo', 'sugar_cane', 'wheat', 'lily_pad', 'moss_carpet', 'moss_block',
  'azalea', 'flowering_azalea', 'cave_vines', 'cave_vines_plant',
  'weeping_vines', 'weeping_vines_plant', 'twisting_vines', 'twisting_vines_plant',
  'glow_lichen', 'hanging_roots', 'big_dripleaf', 'small_dripleaf',
  'spore_blossom', 'sweet_berry_bush', 'nether_sprouts', 'warped_roots',
  'crimson_roots', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass',
  'sea_pickle', 'brown_mushroom', 'red_mushroom', 'pumpkin_stem',
  'melon_stem', 'carrots', 'potatoes', 'beetroots', 'torchflower_crop',
  'pitcher_crop', 'cocoa', 'chorus_flower', 'chorus_plant', 'sculk_vein',
]);

function isSoftVegetation(name) {
  const n = String(name || '').replace(/^minecraft:/, '');
  if (!n) return false;
  if (n.endsWith('_leaves')) return true;
  if (n.endsWith('_sapling')) return true;
  if (n.endsWith('_flower') || n.endsWith('_tulip') || n.endsWith('_bush')) return true;
  if (n.endsWith('_roots') || n.endsWith('_sprouts')) return true;
  if (n.endsWith('_vines') || n.endsWith('_vines_plant')) return true;
  if (n.endsWith('_carpet')) return true;
  if (n.endsWith('_mushroom')) return true;
  if (n.endsWith('_grass')) return true;
  return SOFT_VEGETATION_EXACT.has(n);
}

function setupPathfinder(bot, config) {
  const { Movements } = require('mineflayer-pathfinder');
  const mcData = require('minecraft-data')(bot.version);
  const movements = new Movements(bot, mcData);

  // **走路默认不改世界，但"软植被"是例外。**
  //
  // 我一度把 canDig 整个关掉（为了治"乱挖"），结果在**真实服务器**上撞了墙：
  // 她的出生点在一棵云杉树冠里，20 秒只挪了 1.1 格——因为树叶挡住了她，
  // 而走路不挖世界就等于"被树叶困死"。真人穿过树叶是不会停下来的。
  //
  // 真正造成"乱挖"的两个原因**已经单独修掉了**，跟这里无关：
  //   1. `_blockingSelf` 会返回她根本挖不动的方块 → 反射层反复重试（已修：只挖挖得动的）
  //   2. `_climbTowardLevel` 在任何寻路失败时都会挖（已删：那是我自己加的兜底）
  // 而且寻路**只在路径确实需要时才挖**那一格，不会乱挖一气；
  // 其它 896 种方块仍然在 blocksCantBreak 里（墙、地板、别人的房子都不动）。
  //
  // 想要完全不动世界可以设 MC_ALLOW_SOFT_DIG=0。
  const allowSoftDig = process.env.MC_ALLOW_SOFT_DIG !== '0';
  movements.canDig = allowSoftDig ? true : !!config.get('allowDigInPath');
  movements.canOpenDoors = true;
  movements.allow1by1towers = !!config.get('allowPlaceInPath');
  movements.allowParkour = !config.get('slowMode'); // 慢速模式关掉跑酷，反作弊更容易接受
  movements.allowSprinting = !config.get('slowMode');
  movements.allowFreeMotion = false;
  movements.maxDropDown = 3; // 允许跳下 3 格：再多容易被摔伤
  movements.dontCreateFlow = true; // 不走进水流，避免被冲走
  movements.dontMineUnderFallingBlock = true;
  movements.liquidCost = 30; // 让寻路尽量绕开水

  // **让寻路主动绕开敌对生物。**
  // 用户反馈"不会躲避敌对生物"——寻路默认不认识怪物，
  // 于是她会直直地从僵尸/苦力怕身边走过去。
  // 把这些名字加进 entitiesToAvoid，pathfinder 就会把它们当成障碍绕开
  // （这也是"躲避"最自然的实现：不是逃跑，而是别往危险里走）。
  try {
    const HOSTILE = [
      'zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'bogged',
      'creeper', 'spider', 'cave_spider', 'enderman', 'witch', 'slime', 'magma_cube',
      'blaze', 'ghast', 'piglin', 'piglin_brute', 'hoglin', 'zoglin', 'wither_skeleton',
      'guardian', 'elder_guardian', 'shulker', 'silverfish', 'endermite', 'phantom',
      'pillager', 'vindicator', 'evoker', 'ravager', 'vex', 'warden', 'wither', 'ender_dragon',
    ];
    movements.entitiesToAvoid = new Set(HOSTILE);
    log.info(`寻路：会绕开 ${HOSTILE.length} 种敌对生物`);
  } catch (err) {
    log.debug(`设置怪物规避失败（不影响其它功能）：${err.message}`);
  }
  // 稍微偏向"少挖少放"，真玩家不会随手拆墙
  movements.digCost = 12;
  movements.placeCost = 10;

  // ---- 只允许挖"软植被"，其它方块一律不许挖 ----
  //
  // **为什么必须开 canDig**：丛林/森林里树叶和藤蔓到处都是，canDig=false 时
  // pathfinder 把它们当成实心墙 → 她会原地卡死，实测 100 秒内触发 14 次"移动卡住"，
  // 连 0.4 格外的目标都走不到（挖矿任务因此 240 秒只拿到 1-3 个圆石）。
  // 真人穿过树林时本来就会蹭掉树叶和草丛。
  //
  // **为什么同时要拉黑名单**：canDig=true 是"什么都能挖"，那样她寻路时可能
  // 随手拆掉玩家的房子/箱子/机器。所以把除软植被以外的方块全部列进
  // blocksCantBreak（这个版本的正确属性名，不是 blocksToAvoidBreaking）——
  // 效果就是"只能蹭掉草和树叶，绝不拆建筑"。
  try {
    if (!allowSoftDig) throw new Error('诊断开关已关闭软植被挖路');
    const avoid = new Set();
    // 注意：blocksCantBreak 里放的是**方块类型 ID（数字）**，不是名字。
    // pathfinder 内部判定是 `!this.blocksCantBreak.has(block.type)`。
    for (const info of Object.values(mcData.blocksByName || {})) {
      if (!info || typeof info.id !== 'number') continue;
      if (!isSoftVegetation(info.name)) avoid.add(info.id);
    }
    movements.blocksCantBreak = avoid;
    log.info(`寻路：允许蹭掉软植被，其余 ${avoid.size} 种方块禁止挖除`);
  } catch (err) {
    // 兜底：拿不到方块表就退回"不挖路"
    movements.canDig = !!config.get('allowDigInPath');
  }

  bot.pathfinder.setMovements(movements);
  if (typeof bot.pathfinder.setGoal === 'function') {
    // **关键：thinkTimeout ≠ 行走超时，两者必须分开。**
    //
    // thinkTimeout 是**单次 A* 搜索的同步时间预算**。搜索期间 mineflayer-pathfinder
    // 会把 Node 事件循环**完全占住**——期间引擎收不到也回不了任何 RPC。
    // 早期这里错误地把它设成了 pathTimeoutMs（30 秒），实测后果：
    // 长任务运行中 `ping` 要等 25~27 秒才回（它本身是纯同步函数，不可能自己慢），
    // 也就是"她在干活时你既问不到状态、也喊不停她"。
    //
    // 现在：搜索预算压到几秒（事件循环最多被占这么久），
    // 而"允许走多久"仍由 pathTimeoutMs 控制（见 goTo 里的整体超时），
    // 远距离靠已有的分段寻路兜底（_goToSegmented）。
    // 搜索预算 4000 → **1800 毫秒**（权威值在 config.js 的
    // DEFAULTS.pathThinkTimeoutMs；插件侧可用 path_think_timeout_ms 覆盖）。
    //
    // 实测真实服务器上出现过"事件循环被阻塞 9.3 秒"（86 次里 50 次超过 6 秒），
    // 而且 **70 次发生在"当时空闲"**——说明触发者不是技能任务，而是空闲期的
    // 自动捡东西/自动插火把之类的反射，它们会反复触发寻路。
    // A* 是同步的，预算给多大就可能卡多久，所以这里压到 1.8 秒：
    // 远距离走不通会由分段寻路兜底（本来就是为这个场景写的），
    // 但引擎始终能响应 RPC——这比"一次算完一条长路"重要得多。
    //
    // **不要再写 `|| 1800` 这类兜底**：DEFAULTS 永远提供值，`||` 右边永远不可达，
    // 结果就是"注释说 1800、实际跑 4000"——这次修复的第一版就是这么失效的。
    // 只在配置项确实缺失/非法时才兜底，所以这里显式判有限正数。
    const thinkTimeout = Number(config.get('pathThinkTimeoutMs'));
    bot.pathfinder.thinkTimeout = Number.isFinite(thinkTimeout) && thinkTimeout > 0 ? thinkTimeout : 1800;
    if ('tickTimeout' in bot.pathfinder) bot.pathfinder.tickTimeout = 20;
    // 搜索半径 48 → 32：A* 的开销随半径超线性增长，32 格已经够覆盖
    // "看得见的附近目标"，更远的交给分段推进。
    if ('searchRadius' in bot.pathfinder) bot.pathfinder.searchRadius = 32;
  }
  return movements;
}

class Navigator {
  constructor(bot, config) {    this._bot = bot;
    this._config = config;
    this.movements = setupPathfinder(bot, config);
    this._activeResolve = null;
    this._lastGoal = null;
    // 拟人化状态：走路时的轻微扫视、以及"什么时候冲刺"的节奏
    this._gaze = new WalkGaze(bot);
    this._gait = new Gait();
    this._gazePitchValue = 0;
  }

  /**
   * 走到接近 (x,z) 的位置，并且尽量接近给定 y。
   *
   * 带**分段兜底**：一步到不了就分几段走。
   * 复杂地形（丛林树冠、峡谷、洞穴）里 A* 常常一次规划不出全程，
   * 但走 8–10 格通常没问题；真玩家迷路时也是"先往那个方向挪一段再说"。
   * 这样把"找不到路"从硬失败变成"慢一点但能到"。
   *
   * @param {object} o
   * @param {number} o.x
   * @param {number} [o.y] 不给就用当前高度，避免为了对齐高度而挖地/搭塔
   * @param {number} o.z
   * @param {number} [o.range] 到达容差（格）
   * @param {AbortSignal} [o.signal]
   * @param {number} [o.timeoutMs]
   * @param {boolean} [o.segmented] 是否启用分段兜底（默认启用）
   */
  async goTo({ x, y = null, z, range = ARRIVE_RADIUS, signal = null, timeoutMs = null, onTick = null, segmented = true, xzOnly = false }) {
    const bot = this._bot;
    if (!bot || !bot.entity) throw new Error('机器人尚未进入服务器');
    const targetY = y === null || y === undefined ? null : y;

    try {
      return await this._goToOnce({ x, y: targetY, z, range, signal, timeoutMs, onTick, xzOnly });
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      if (!segmented || (signal && signal.aborted)) throw err;
      // 只有"找不到路/超时"这类寻路失败才值得分段重试；
      // 其它错误（例如未连接）直接上抛，否则会掩盖真问题。
      if (!(err instanceof PathError) && err.name !== 'PathError') throw err;
      log.debug(`整段寻路失败（${err.message}），改为分段推进`);
    }

    return this._goToSegmented({ x, y: targetY, z, range, signal, timeoutMs, onTick, xzOnly });
  }

  /**
   * 分段推进：每次先试着往目标方向挪一段，走不动就换更小的步长。
   * 关键点：**每一段都朝最终目标前进**（不是随机方向），
   * 所以只要地形不是完全封死，最终能蹭到目标附近。
   */
  async _goToSegmented({ x, y, z, range, signal, timeoutMs, onTick, xzOnly = false }) {
    const bot = this._bot;
    const t0 = Date.now();
    const totalTimeout = (timeoutMs || this._config.derived().pathTimeoutMs) * 2;
    const deadline = t0 + totalTimeout;
    const stepSizes = [10, 6, 3];
    // 只在最后尝试一次"挖台阶爬上去"，避免反复挖
    let climbTried = false;

    for (const step of stepSizes) {
      let stalled = 0;
      while (Date.now() < deadline) {
        if (signal && signal.aborted) throw new CancelledError();
        const pos = bot.entity.position;
        const remain = distanceXZ(pos, { x, z });
        if (remain <= range) {
          return {
            arrived: true,
            segmented: true,
            note: `分段走到位（用了步长 ${step}）`,
            final_position: { x: Number(pos.x.toFixed(1)), y: Number(pos.y.toFixed(1)), z: Number(pos.z.toFixed(1)) },
            distance_to_target: Number(remain.toFixed(2)),
            elapsed_ms: Date.now() - t0,
          };
        }

        // 朝目标方向取一个中间点（保持方向性，不偏离最终目标）
        const ratio = Math.min(1, step / remain);
        const wx = pos.x + (x - pos.x) * ratio;
        const wz = pos.z + (z - pos.z) * ratio;
        const before = distanceXZ(bot.entity.position, { x, z });

        try {
          await this._goToOnce({ x: wx, y: null, z: wz, range: 2, signal, timeoutMs: 20000, onTick });
          // 位置没有实质前进就计一次停滞，避免在同一处空转
          const after = distanceXZ(bot.entity.position, { x, z });
          stalled = after > before - 0.5 ? stalled + 1 : 0;
        } catch (err) {
          if (err instanceof CancelledError) throw err;
          log.debug(`分段推进（步长 ${step}）到 (${wx.toFixed(0)}, ${wz.toFixed(0)}) 失败：${err.message}`);
          stalled += 1;
        }
        if (stalled >= 3) break; // 这个步长推不动了，换更小的
      }
    }

    // **绝不自动挖出去。**
    //
    // 这里曾经有一段"走不到就挖台阶爬上去/横向挖穿一条路"的自动恢复。
    // 它违背了**走路不改世界**这条规则：
    // 实测它在平地上也会被触发（任何一次普通寻路失败都会），
    // 于是她到处挖方块、四处乱走（用户原话"寻路经常乱跑，挖掘也经常乱挖"），
    // 还把合成任务一起搞坏了（crafttest 从 8/8 掉到 5/8）。
    //
    // 现在的做法：走不到就**如实失败**，并把"需要挖哪几格"写进错误信息，
    // 由 LLM 决定要不要真的去挖（它手上就有 dig 工具）。
    void climbTried;

    const pos = bot.entity.position;
    const remain = distanceXZ(pos, { x, z });
    // 已经站在目标附近就必须算成功，哪怕分段过程一路报失败。
    if (remain <= Math.max(range || 0, ARRIVE_RADIUS)) {
      log.info(`分段推进最后停在了目标附近（还差 ${remain.toFixed(2)} 格），按到达处理`);
      return {
        arrived: true,
        final_position: {
          x: Number(pos.x.toFixed(1)),
          y: Number(pos.y.toFixed(1)),
          z: Number(pos.z.toFixed(1)),
        },
        distance_to_target: Number(remain.toFixed(2)),
        elapsed_ms: Date.now() - t0,
      };
    }
    // **失败要"带价签"**：不只是说走不到，还要说清楚"要挖开哪几格才能过去"。
    //
    // 这是"带价签的候选路线"的做法——"没有干净的路时，它会列出几条带价签的候选路线
    // （各要挖什么、放什么）"，让模型自己决定值不值得动世界。
    // 只报"地形把路堵死了"的话，模型除了放弃没有别的选择。
    const needs = this._describeRouteNeeds(pos, { x, z });
    // **高度差必须说在最前面，而且要说人话。**
    //
    // 实测踩过的坑（很严重）：她在 y=51 的地下，目标工作台在 y=122 的地表，
    // 但原来的消息只报水平距离——
    //   "走不到 (-67, 122)：停在 (-55.5, 51, 119)，还差 11.9 格"
    // 模型看到"还差 11.9 格"以为快到了，于是**每 2 分钟重试一次，永远出不来**。
    // 真实情况是：目标在她头顶 71 格，需要挖阶梯上去——而这句话原来的消息里
    // 一个字都没提。
    const dy = Number.isFinite(Number(y)) && y !== null && y !== undefined ? Number(y) - pos.y : null;
    let vertical = '';
    if (dy !== null && Math.abs(dy) >= 4) {
      vertical =
        dy > 0
          ? `**目标在你上方 ${Math.round(dy)} 格**（你 y=${pos.y.toFixed(0)}，目标 y=${Number(y).toFixed(0)}）——` +
            `先想办法上去：挖阶梯向上（mc_mine 挖脚下的方块往上走）、或者找洞/水/梯子。` +
            `**在地底是走不到地表的，这不是"再走几步"的事。**`
          : `**目标在你下方 ${Math.round(-dy)} 格**——要先往下挖（挖阶梯，不要直挖竖井）。`;
    }
    // **同一个目标反复失败要说出来**：不然模型会一直重试同一个动作。
    const tries = this._noteFailedGoal({ x, y, z });
    const repeat =
      tries >= 3
        ? `**这已经是第 ${tries} 次尝试走到这里失败了**——别再重复同样的做法，换个思路：` +
          `挖开路 / 换个更近的目标 / 或者干脆做别的事。`
        : '';
    throw new PathError(
      `走不到 (${x}, ${z})：停在 ${fmtVec(pos)}，水平还差 ${remain.toFixed(1)} 格。` +
        (vertical ? `\n${vertical}` : '') +
        (repeat ? `\n${repeat}` : '') +
        (needs
          ? `\n挡路的大概是 ${needs}。要过去得先挖开它们（用 dig 工具），或者换一个目标。`
          : `\n这一带可能完全被堵死，换个更近的目标或先自己挖条路。`),
    );
  }

  /**
   * 记一次"走到这个目标失败"，返回累计次数。
   *
   * 为什么需要：她原来会**对着同一个走不到的目标每 2 分钟重试一次**，
   * 因为每次的报错看起来都是"新的一次失败"，没有任何东西告诉她"这已经是第 5 次了"。
   * 现在把次数报进错误消息里，模型才有依据换做法。
   */
  _noteFailedGoal(target) {
    const key = `${Math.round(Number(target.x) || 0)},${Math.round(Number(target.z) || 0)}`;
    const now = Date.now();
    if (!this._failedGoals) this._failedGoals = new Map();
    // 10 分钟没再试同一个目标就忘掉（避免永久拉黑一个地方）
    for (const [k, v] of this._failedGoals) {
      if (now - v.at > 600000) this._failedGoals.delete(k);
    }
    const prev = this._failedGoals.get(key);
    const entry = { at: now, count: (prev ? prev.count : 0) + 1 };
    this._failedGoals.set(key, entry);
    return entry.count;
  }

  /**
   * 朝目标方向看几格，报告"挡路的都是什么方块"。
   * 只读，不改世界——把决定权留给 LLM。
   */
  _describeRouteNeeds(from, target) {
    const bot = this._bot;
    if (!bot || !bot.entity) return null;
    const dx = target.x - from.x;
    const dz = target.z - from.z;
    const len = Math.hypot(dx, dz) || 1;
    const stepX = dx / len;
    const stepZ = dz / len;
    const by = Math.floor(from.y);
    const names = new Map();
    // 沿直线看 4 格，每格检查脚、头、脚下
    for (let i = 1; i <= 4; i += 1) {
      const cx = Math.floor(from.x + stepX * i);
      const cz = Math.floor(from.z + stepZ * i);
      for (const cy of [by + 1, by]) {
        const b = blockAt(bot, cx, cy, cz);
        if (b && b.boundingBox === 'block') {
          names.set(b.name, (names.get(b.name) || 0) + 1);
        }
      }
    }
    if (!names.size) return null;
    return [...names.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([n, c]) => `${n}×${c}`)
      .join('、');
  }

  /**
   * **障碍审计**：把"她周围被当成障碍的格子"连同**判据**一起列出来。
   *
   * 为什么要这个：用户反馈"火把这种方块似乎会被当成实体方块挡路"，
   * 但我用三种办法都复现不出来——穿过一排火把没问题、她不会挖自己的火把、
   * 代码里所有占位判断用的都是 `boundingBox === 'block'`（火把是 'empty'）。
   * 与其继续猜，不如让**下一次真的发生时能一眼看清**：
   * 到底是哪一格、被谁判成了障碍、判据是什么。
   *
   * 只读，不改世界。
   */
  auditObstacles(radius = 3) {
    const bot = this._bot;
    if (!bot || !bot.entity) return { ok: false, reason: '没连接' };
    const p = bot.entity.position;
    const cx = Math.floor(p.x);
    const cy = Math.floor(p.y);
    const cz = Math.floor(p.z);
    const r = Math.max(1, Math.min(6, Number(radius) || 3));
    const rows = [];
    for (let dy = -1; dy <= 2; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        for (let dz = -r; dz <= r; dz += 1) {
          let b = null;
          try {
            b = blockAt(bot, cx + dx, cy + dy, cz + dz);
          } catch {
            continue;
          }
          if (!b) continue;
          const bbox = String(b.boundingBox || '?');
          // 只报告"不是空气"的格子——空气不用看
          if (bbox === 'empty' && b.name === 'air') continue;
          rows.push({
            x: cx + dx,
            y: cy + dy,
            z: cz + dz,
            name: b.name,
            bounding_box: bbox,
            // **判据**：我的代码是拿 boundingBox === 'block' 当"实体挡路"的。
            // 这里如实标出来，这样"火把到底算不算挡路"一眼可见。
            counts_as_solid: bbox === 'block',
            diggable: !!b.diggable,
          });
        }
      }
    }
    const solids = rows.filter((r2) => r2.counts_as_solid);
    const nonSolid = rows.filter((r2) => !r2.counts_as_solid);
    return {
      ok: true,
      position: { x: cx, y: cy, z: cz },
      radius: r,
      counts_as_solid: solids,
      non_solid_but_present: nonSolid,
      verdict:
        `${rows.length} 个非空气格里，${solids.length} 个被当成实体挡路、` +
        `${nonSolid.length} 个不算（火把/草/按钮这类 bounding_box=empty 的东西在这里）`,
      note: '判据是 bounding_box === "block"。如果这里有 torch 被算进 counts_as_solid，那才是真 bug',
    };
  }

  /** 单次寻路：一次 A* 规划 */
  async _goToOnce({ x, y, z, range = ARRIVE_RADIUS, signal = null, timeoutMs = null, onTick = null, xzOnly = false }) {
    const bot = this._bot;
    const t0 = Date.now();
    const timeout = timeoutMs || this._config.derived().pathTimeoutMs;
    const targetY = y === null || y === undefined ? null : y;

    // 已经在目标附近就直接返回，避免为了 0.3 格来回蹭
    const cur = bot.entity.position;
    if (distanceXZ(cur, { x, z }) <= range && (xzOnly || targetY === null || Math.abs(cur.y - targetY) <= 1.2)) {
      return { arrived: true, distance: distanceXZ(cur, { x, z }), elapsed_ms: 0, note: '已在目标附近' };
    }

    this._lastGoal = { x, y: targetY, z, range };

    // **xzOnly：只要求水平靠近，不管高度**。
    // 用于"走到某个方块旁边去挖它"这类目标——那种目标常常埋在地下/在陡坡上，
    // 按高度匹配的可站立点会和实际能站的位置差 1~2 格，于是**目标永远无法满足**：
    // 实测日志里出现"寻路超时，停在 (49.5,63,-15.7)，距目标 0.4 格"却走不完，
    // 然后被判定卡住、反复自救、整个挖矿任务 240 秒只拿到 1~3 个圆石。
    // GoalNearXZ 只比较水平距离，正好符合"走到附近就能挖"的语义。
    if (xzOnly) {
      return this._runPath(new goals.GoalNearXZ(x, z, Math.max(1, range)), {
        x,
        y: targetY,
        z,
        range,
        timeout,
        signal,
        t0,
        onTick,
      });
    }

    // 站不住的目标（比如悬空/墙里）——先找附近能站的地方，再退回"靠近就行"。
    // 这里必须用找到的那个格子的真实 y：如果目标点在空中而地面在 20 格外的高度，
    // 继续按请求的 y 寻路会去找一个根本站不住的方块，必然失败。
    const standable = this._findStandableNear(x, targetY, z, Math.max(2, range));
    const finalGoal = standable
      ? (range > 1 ? new goals.GoalNear(standable.x, standable.y, standable.z, range) : new goals.GoalBlock(standable.x, standable.y, standable.z))
      : new goals.GoalNear(x, targetY === null ? Math.floor(cur.y) : targetY, z, range);
    if (standable && targetY !== null && Math.abs(standable.y - targetY) > 2) {
      log.debug(`目标高度 ${targetY} 无法站立，改用附近可站立点 y=${standable.y}`);
    }

    return this._runPath(finalGoal, { x, y: targetY, z, range, timeout, signal, t0, onTick });
  }

  _makeGoal(x, y, z, range) {
    // 目标是"进入 range 格以内"，不要求精确落在同一格，避免永远到不了
    return new goals.GoalNear(x, y === null ? undefined : y, z, range);
  }

  /** 在目标周围找一个可站立的位置（脚下是实体方块、身体两格是空气） */
  _findStandableNear(x, y, z, r) {
    const bot = this._bot;
    const cx = Math.floor(x);
    const cz = Math.floor(z);
    const baseY = y === null || y === undefined ? Math.floor(bot.entity.position.y) : Math.floor(y);
    let best = null;
    let bestD = Infinity;
    for (let dy = 2; dy >= -3; dy -= 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        for (let dz = -r; dz <= r; dz += 1) {
          const bx = cx + dx;
          const by = baseY + dy;
          const bz = cz + dz;
          if (!this._isStandable(bx, by, bz)) continue;
          const d = Math.hypot(dx, dz) + Math.abs(dy) * 0.5;
          if (d < bestD) {
            bestD = d;
            best = { x: bx, y: by, z: bz };
          }
        }
      }
    }
    return best;
  }

  _isStandable(x, y, z) {
    const bot = this._bot;
    try {
      const below = blockAt(bot, x, y - 1, z);
      const feet = blockAt(bot, x, y, z);
      const head = blockAt(bot, x, y + 1, z);
      if (!below || !feet || !head) return false;
      const solidBelow = below.boundingBox === 'block' && !below.name.includes('water') && !below.name.includes('lava');
      const freeFeet = feet.boundingBox === 'empty' || feet.name === 'air';
      const freeHead = head.boundingBox === 'empty' || head.name === 'air';
      return solidBelow && freeFeet && freeHead;
    } catch {
      return false;
    }
  }

  /** 统一的寻路执行 + 监听清理 + 卡住检测 */
  async _runPath(goal, { x, y, z, range = ARRIVE_RADIUS, timeout, signal, t0, onTick }) {
    const bot = this._bot;
    const pathfinder = bot.pathfinder;

    await new Promise((resolve, reject) => {
      let settled = false;
      let stuckTimer = null;
      let timeoutTimer = null;
      let lastPos = bot.entity.position.clone ? bot.entity.position.clone() : { ...bot.entity.position };
      let stuckRounds = 0;
      let dugOutTried = false;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (stuckTimer) clearInterval(stuckTimer);
        bot.removeListener('goal_reached', onReached);
        bot.removeListener('path_update', onPathUpdate);
        if (signal) signal.removeEventListener('abort', onAbort);
        this._activeResolve = null;
      };

      const finish = (err, value) => {
        if (settled) return;
        cleanup();
        if (err) reject(err);
        else resolve(value);
      };

      const onReached = () => finish(null, buildResult(true, '已到达'));
      // 注意：**不能**把 goal_updated 当成"到达"。
      // setGoal() 之后 goal 会被内部立刻更新一次，若在这里 resolve，
      // 任务会在出发前就报"成功"——这是最危险的一类 bug（假成功），
      // 表现为"说到了其实没动"。真正的结束条件只有：goal_reached / 超时 / 卡住 / 取消。
      const onPathUpdate = (r) => {
        if (r && r.status === 'noPath') {
          // 目标就在附近（8 格内）却"找不到路" → 多半是中间隔着一堵墙。
          // 真玩家这时会直接挖穿（而不是绕整个山）。远处不做这件事，
          // 免得她在别人的建筑里乱挖——那种情况交给分段推进去绕。
          const near = distanceXZ(bot.entity.position, { x, z }) <= 8;
          if (near && !dugOutTried) {
            dugOutTried = true;
            this._digOut({ signal })
              .then((dug) => {
                if (settled) return;
                if (dug) {
                  log.info('目标就在附近但被挡住：挖开了挡路的方块，重新尝试');
                  try {
                    pathfinder.setGoal(goal);
                  } catch {
                    finish(new PathError('找不到通往目标的路径'));
                  }
                  return;
                }
                finish(new PathError('找不到通往目标的路径'));
              })
              .catch(() => {
                if (!settled) finish(new PathError('找不到通往目标的路径'));
              });
            return;
          }
          finish(new PathError('找不到通往目标的路径'));
        }
      };
      const onAbort = () => {
        try {
          pathfinder.stop();
        } catch {
          /* ignore */
        }
        finish(new CancelledError('移动被取消'));
      };

      const buildResult = (arrived, note) => {
        const pos = bot.entity.position;
        return {
          arrived,
          note,
          final_position: { x: Number(pos.x.toFixed(1)), y: Number(pos.y.toFixed(1)), z: Number(pos.z.toFixed(1)) },
          distance_to_target: Number(distanceXZ(pos, { x, z }).toFixed(2)),
          elapsed_ms: Date.now() - t0,
        };
      };

      bot.on('goal_reached', onReached);
      bot.on('path_update', onPathUpdate);
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }

      timeoutTimer = setTimeout(() => {
        try {
          pathfinder.stop();
        } catch {
          /* ignore */
        }
        const pos = bot.entity.position;
        finish(
          new PathError(
            `寻路超时（${(timeout / 1000).toFixed(0)} 秒），停在 ${fmtVec(pos)}，距目标 ${distanceXZ(pos, { x, z }).toFixed(1)} 格`,
          ),
        );
      }, timeout);

      // 卡住检测：2.5 秒位置几乎没变就计数，连续两次认为是真卡住
      stuckTimer = setInterval(() => {
        const pos = bot.entity.position;
        const moved = distanceXZ(pos, lastPos);
        if (moved < 0.5) {
          stuckRounds += 1;
          if (stuckRounds >= 2) {
            try {
              pathfinder.stop();
            } catch {
              /* ignore */
            }
            // 卡住后先**自救**再报错。
            // 实测她会在 1 格深的坑里 / 墙角落彻底卡死：反复报"移动卡住…附近 5 秒内
            // 几乎没有前进"，连 0.4 格外的目标都到不了，挖出来的掉落物也捡不到，
            // 整轮挖矿 240 秒只拿到 1 个圆石。真人卡住会先跳一下再挪。
            // 这里在 finish 之前给她一次机会，成功就继续走完这条路径。
            this._escapeStuck({ signal })
              .then((escaped) => {
                if (settled) return;
                if (escaped) {
                  stuckRounds = 0;
                  lastPos = bot.entity.position.clone
                    ? bot.entity.position.clone()
                    : { ...bot.entity.position };
                  return; // 脱困成功：让 pathfinder 继续
                }
                finish(
                  new PathError(
                    `移动卡住：${fmtVec(pos)} 附近 5 秒内几乎没有前进，可能是被方块挡住或目标不可达`,
                  ),
                );
              })
              .catch(() => {
                if (!settled) {
                  finish(new PathError(`移动卡住：${fmtVec(pos)} 附近无法前进`));
                }
              });
          }
        } else {
          stuckRounds = 0;
        }
        lastPos = pos.clone ? pos.clone() : { ...pos };
        if (onTick) {
          try {
            onTick({ position: { x: pos.x, y: pos.y, z: pos.z }, elapsed_ms: Date.now() - t0 });
          } catch {
            /* 进度回调不应影响导航 */
          }
        }
      }, 2500);

      try {
        pathfinder.setGoal(goal);
      } catch (err) {
        finish(new PathError(describeFailure(err)));
      }
    });

    const pos = this._bot.entity.position;
    const remain = distanceXZ(pos, { x, z });
    // **`arrived` 必须按调用方要的 `range` 判，不能硬编码**（B 批次查出来的）。
    //
    // 原来这里写的是 `arrived: remain <= 2.5` —— 而两个调用方都在 options 里
    // **传了 `range`**（`_runPath(goal, { ..., range, ... })`），签名却没接收它 ✗
    // 后果：调用方要 `range: 1`、寻路在 2.4 格处放弃，这里却报 `arrived: true` ✗
    // 上层据此认为"到了"，于是出现**假成功**——
    // 实测 `test_pathfinding` 的"绕过贴身的墙"就是这样：任务报 `done`，
    // 而人还在离目标 3.5~4.7 格的地方。
    // 假成功比假失败更糟：模型会以为做到了，不会重试，也不会换办法。
    //
    // 留 0.5 格容差（寻路停下来的位置本来就有零点几格的抖动）。
    const tolerance = Number(range) + 0.5;
    return {
      arrived: remain <= tolerance,
      final_position: { x: Number(pos.x.toFixed(1)), y: Number(pos.y.toFixed(1)), z: Number(pos.z.toFixed(1)) },
      distance_to_target: Number(remain.toFixed(2)),
      elapsed_ms: Date.now() - t0,
    };
  }

  /**
   * 跟随玩家/实体。动态目标，会一直跟着直到被 stop()。
   *
   * ## 为什么不用 pathfinder 的 GoalFollow
   *
   * 早期实现是每 600ms `pathfinder.setGoal(new GoalFollow(...), true)`。
   * 实测用户的原话是"**跟着我的时候是一顿一顿地动**"——原因就是这个：
   * 每次重设目标，pathfinder 都会停下手上的移动、重算路径、再重新起步，
   * 于是走两步停一下，看着非常机械。
   *
   * ## 真人是怎么跟的
   *
   * 真人跟着你的时候是**持续朝你走**、并且一直看着你——
   * 走近了就停下，你走远了再跟上。整个过程是连续的，没有"重新规划"。
   *
   * 所以这里改成：
   *   - 主模式：**直接朝目标走**（每 120ms 修正一次朝向，方向键一直按着）
   *   - 距离控制带迟滞：近了就停、远了一点才动（避免在临界距离上抖）
   *   - 一直平滑地看着对方的头部（不是脚）
   *   - 只有"卡住了走不过去"时才临时交给 pathfinder 绕一小段，绕过去继续直接走
   */
  async follow(target, { distance: dist = 3, signal = null, onTick = null } = {}) {
    const bot = this._bot;
    const entity = this._resolveEntity(target);
    if (!entity) throw new Error(`找不到要跟随的目标：${target}`);

    const pathfinder = bot.pathfinder;
    const TICK = 120;
    // 距离控制用**迟滞**（避免在临界距离上抖），但**不能有死区**：
    // 早期写成"近了停、远到 resumeAt 才动"，于是初始距离落在两者之间时
    // 她既不停也不动——实测跟随任务起来后她 6 秒一步没挪。
    // 正确写法：
    //   正在走 → 一直走到 stopAt 以内才停
    //   停着   → 超过 startAt（比 stopAt 稍大）就开始走
    const stopAt = Math.max(1.2, dist - 0.6);
    const startAt = stopAt + 0.8;
    const resumeAt = dist + 1.2; // 兼容旧语义：明显拉开距离时直接跟上
    let moving = false;
    let lostSince = 0;
    let noProgress = 0;
    let lastDist = Infinity;
    let lastDetourAt = 0;
    let facing = null;

    try {
      while (true) {
        if (signal && signal.aborted) throw new CancelledError('已停止跟随');
        const cur = this._resolveEntity(target);
        if (!cur || !cur.position) {
          if (!lostSince) lostSince = Date.now();
          // 短暂不可见不放弃（跨区块/传送/视距边缘很常见），连续 12 秒找不到才结束
          if (Date.now() - lostSince > 12000) {
            return { stopped: true, reason: '目标已离开视野或下线（超过 12 秒找不到）' };
          }
          this._setMove(bot, false, false);
          moving = false;
          await delay(TICK, { signal });
          continue;
        }
        lostSince = 0;

        const me = bot.entity.position;
        const d = distance(me, cur.position);
        if (onTick) {
          try {
            onTick({ distance: d });
          } catch {
            /* 进度回调不应影响跟随 */
          }
        }

        // ---- 平滑地看着对方（看头部，不是脚）
        const eyeY = cur.position.y + (cur.height ? cur.height * 0.85 : 1.5);
        const wantYaw = Math.atan2(-(cur.position.x - me.x), -(cur.position.z - me.z));
        try {
          await smoothLook(bot, wantYaw, Math.atan2(eyeY - (me.y + 1.62), Math.hypot(cur.position.x - me.x, cur.position.z - me.z)), {
            durationMs: 90,
            signal,
          });
        } catch {
          /* 视角失败不致命 */
        }

        // ---- 距离控制（迟滞，但无死区）
        if (d <= stopAt) {
          if (moving) {
            this._setMove(bot, false, false);
            moving = false;
          }
        } else if (moving || d >= startAt || d >= resumeAt) {
          // 持续朝目标走（不寻路）
          const before = { x: me.x, z: me.z };
          this._setMove(bot, true, d > 6.5);
          moving = true;

          // 卡住检测：1.5 秒内没靠近，就交给 pathfinder 绕一小段
          if (d < lastDist - 0.25) {
            noProgress = 0;
          } else {
            noProgress += 1;
          }
          lastDist = d;
          if (noProgress >= 12 && Date.now() - lastDetourAt > 6000) {
            lastDetourAt = Date.now();
            noProgress = 0;
            this._setMove(bot, false, false);
            moving = false;
            log.debug(`跟随时被挡住（${d.toFixed(1)} 格外），临时用寻路绕一下`);
            try {
              await this.goTo({
                x: cur.position.x,
                y: null,
                z: cur.position.z,
                range: Math.max(2, dist),
                signal,
                timeoutMs: 6000,
                segmented: false,
                xzOnly: true,
              });
            } catch (err) {
              if (err instanceof CancelledError) throw err;
              log.debug(`绕行失败（继续直接跟）：${err.message}`);
            }
          }
          void before;
        }

        await delay(TICK, { signal });
      }
    } finally {
      this._setMove(bot, false, false);
      void facing;
      void pathfinder;
    }
  }

  /** 统一的"移动控制"设置（前进/冲刺），带异常保护 */
  _setMove(bot, forward, sprint) {
    try {
      bot.setControlState('forward', !!forward);
      bot.setControlState('sprint', !!sprint);
    } catch (err) {
      log.debug(`设置移动状态失败：${err.message}`);
    }
  }

  _resolveEntity(target) {
    const bot = this._bot;
    if (!target) return null;
    if (typeof target === 'object' && target.position) return target;
    const name = String(target).replace(/^minecraft:/, '').toLowerCase();

    // 1. 优先使用 mineflayer 的原生 findPlayer（它检查全部玩家实体上的 username）
    if (typeof bot.findPlayer === 'function') {
      const found = bot.findPlayer(name);
      if (found && found.position) return found;
    }

    // 2. 检查 bot.players（带大小写不敏感匹配）
    for (const [uname, p] of Object.entries(bot.players || {})) {
      if (uname.toLowerCase() === name && p && p.entity && p.entity.position) {
        return p.entity;
      }
    }

    // 3. 在所有实体中按 username（玩家实体）或 name/displayName 匹配
    const me = bot.entity ? bot.entity.position : null;
    let best = null;
    let bestD = Infinity;
    for (const e of Object.values(bot.entities || {})) {
      if (!e || !e.position || e === bot.entity) continue;
      // 关键：玩家实体的实际名称在 e.username（e.name 只是固定字符串 'player'，displayName 是 'Player'）
      const matchPlayer = e.type === 'player' && e.username && e.username.toLowerCase() === name;
      const matchEntity = String(e.name || e.displayName || '').replace(/^minecraft:/, '').toLowerCase() === name;
      if (!matchPlayer && !matchEntity) continue;

      const d = me ? distance(e.position, me) : 0;
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  stop() {
    try {
      this._bot.pathfinder.setGoal(null);
      this._bot.pathfinder.stop();
    } catch (err) {
      log.debug(`停止寻路时出错（可忽略）：${err.message}`);
    }
  }

  /**
   * 短距离接近的统一入口：先用 pathfinder，走不动就改用"直接迈步"。
   *
   * 为什么要封装：自然地形里 pathfinder 做两三格的接近时经常算不出路或原地不动
   * （实测"距目标 0.4 格"却走不完，然后被判卡住）。而真人这时就是朝目标走两步。
   * 挖方块、放方块、捡东西都属于这种短距离场景，统一走这里。
   */
  async approach({ x, y = null, z, range = 2.5, signal = null, timeoutMs = 8000 }) {
    try {
      await this.goTo({ x, y, z, range, signal, timeoutMs, segmented: false, xzOnly: true });
      return true;
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      const ok = await this.stepToward({ x, z, signal, timeoutMs: 6000, tolerance: range + 0.5 });
      if (!ok) log.debug(`接近 (${x}, ${z}) 失败：${err.message}`);
      return ok;
    }
  }

  /** 走路时叠加的俯仰微动（很小，只在 ±3° 内） */
  _gazePitch() {
    return Math.sin(Date.now() / 3400) * 0.05;
  }

  /**
   * 短距离直接迈步：不走 pathfinder，只是"朝那个方向走过去"。
   *
   * 用途：挖方块前的两三格接近。用 pathfinder 做这件事属于杀鸡用牛刀，
   * 而且实测在自然地形里它经常算不出路/原地不动，导致她卡住反复自救
   * （挖矿 240 秒只拿到 1~3 个圆石）。真人这时就是**朝目标走两步**。
   * 被挡住会自己跳一下；长时间没进展就老实返回 false，交给调用方。
   */
  /**
   * 朝 (dx,dz) 方向再走一格，会掉多深？
   *
   * 返回落差格数（0 = 前方有地面，可以直接走；负数表示前方比她还高）。
   * 只读，不改世界。
   */
  _dropAhead(dx, dz, lookahead = 1) {
    const bot = this._bot;
    if (!bot || !bot.entity) return 0;
    const p = bot.entity.position;
    const len = Math.hypot(dx, dz) || 1;
    const tx = Math.floor(p.x + (dx / len) * lookahead);
    const tz = Math.floor(p.z + (dz / len) * lookahead);
    const by = Math.floor(p.y);
    // 从上往下找第一块能站的地面（最多看她脚下 6 格，够判断"这是不是悬崖"）
    for (let dy = 1; dy <= 6; dy += 1) {
      const b = blockAt(bot, tx, by - dy, tz);
      if (b && b.boundingBox === 'block') return dy - 1;
    }
    return 6; // 6 格内都没有地面 → 当成深坑
  }

  async stepToward({ x, z, signal = null, timeoutMs = 6000, tolerance = 2.0 }) {
    const bot = this._bot;
    if (!bot || !bot.entity) return false;
    const deadline = Date.now() + timeoutMs;
    let lastDist = Infinity;
    let noProgress = 0;

    try {
      while (Date.now() < deadline) {
        if (signal && signal.aborted) throw new CancelledError('移动被取消');
        const pos = bot.entity.position;
        const dx = x - pos.x;
        const dz = z - pos.z;
        const dist = Math.hypot(dx, dz);
        if (dist <= tolerance) return true;

        if (dist < lastDist - 0.15) noProgress = 0;
        else noProgress += 1;
        lastDist = dist;

        if (noProgress >= 10) break; // 真的过不去
        if (noProgress === 4 && bot.entity.onGround) {
          bot.setControlState('jump', true);
          await delay(200, { signal });
          bot.setControlState('jump', false);
        }

        // **悬崖保护：下一步会掉下去就别走。**
        //
        // 寻路层有 maxDropDown=3 兜着，但这条"直接朝目标走"的路是自己推方向键的，
        // 完全绕过寻路——实测她会在山崖/洞口边上径直走出去。
        // 真人走到崖边会停下（或者小心地往下挪一格）。
        const drop = this._dropAhead(dx, dz);
        if (drop > 3) {
          log.warn(`前面是 ${drop} 格的落差，停住不走（免得摔下去）`);
          bot.setControlState('forward', false);
          bot.setControlState('sprint', false);
          break;
        }

        try {
          // **渐进转头 + 走路时的轻微扫视**，而不是瞬间对准。
          // mineflayer 的 look 一次就把角度转完，瞬间对准是最明显的"机器人"特征。
          const targetYaw = Math.atan2(-dx, -dz) + this._gaze.offset();
          await smoothLook(bot, targetYaw, this._gazePitch(), { durationMs: 90, signal });
        } catch {
          /* 视角失败不致命 */
        }
        bot.setControlState('forward', true);
        // 速度像人：近了不冲，远了才冲，偶尔一路悠闲地走
        bot.setControlState('sprint', this._gait.shouldSprint(dist));
        await delay(100, { signal });

        // 偶尔停半秒（像在确认方向）——真人不会一路匀速走到底
        if (dist > 3 && maybeIdlePause({ chance: 0.035 })) {
          bot.setControlState('forward', false);
          bot.setControlState('sprint', false);
          const pause = idlePauseMs();
          await delay(pause, { signal });
          // 停的时候顺手看一眼旁边（人味最足的一步）
          await idleLookAround(bot, { signal, maxYaw: 0.5 }).catch(() => {});
        }
      }
    } finally {
      for (const c of ['forward', 'sprint', 'jump']) {
        try {
          bot.setControlState(c, false);
        } catch {
          /* ignore */
        }
      }
    }
    const pos = bot.entity.position;
    return Math.hypot(x - pos.x, z - pos.z) <= tolerance;
  }

  /**
   * 把动作层接进来，供"被困时挖墙脱困"使用。
   * 不接也能跑，只是卡在岩壁前时少一条出路。
   */
  attachActions(actions) {
    this._actions = actions;
  }

  /**
   * 卡住自救：跳一下 → 换方向走一小步 → **挖开挡路的方块** → 反复几次。
   *
   * 最常见的卡死场景：
   *   1. 站在自己刚挖的 1 格深坑里（跳一下就出来了）
   *   2. 顶在墙角/树叶堆里（横着挪一下就好）
   *   3. **被夹在岩壁和断崖之间**——四周只有石头和致命落差，
   *      这时只有"朝岩壁挖进去"才能出去（实测：她在这种地形上
   *      连 0.1 格都动不了，整个任务原地失败，日志只有"移动 0.0 格"）
   */
  async _escapeStuck({ signal = null, rounds = 4 } = {}) {
    const bot = this._bot;
    if (!bot || !bot.entity) return false;

    // **移动困境断路器**：反复自救无效时停下来，别再无限挣扎。
    //
    // 用户的原话是"她现在大部分时间都在无意义地走来走去和跳一跳"——
    // 这正是"卡住 → 自救（跳+横移）→ 再卡住 → 再自救"的死循环。
    // 实测日志里"确认被 X 卡住"每 11~13 秒一次、连着十几分钟。
    // 真人在一个地方反复卡住时会**放弃这件事、去干别的**，而不是原地抖。
    //
    // 规则：5 分钟内自救超过 5 次，就静默 5 分钟——期间不再自救，
    // 让寻路如实失败，上层（过日子循环 / LLM）就能看到失败并换个任务。
    const now = Date.now();
    if (now < (this._escapeGiveUpUntil || 0)) return false;
    this._escapeTimes = (this._escapeTimes || []).filter((t) => now - t <= 300000);
    if (this._escapeTimes.length >= 5) {
      this._escapeGiveUpUntil = now + 300000;
      this._escapeTimes = [];
      log.warn('5 分钟内自救 5 次都没脱身，静默 5 分钟（让上层换个任务，别再原地挣扎）');
      return false;
    }
    this._escapeTimes.push(now);

    const start = bot.entity.position.clone ? bot.entity.position.clone() : { ...bot.entity.position };

    for (let i = 0; i < rounds; i += 1) {
      if (signal && signal.aborted) return false;
      try {
        // 1) 跳：1 格台阶/浅坑最有效的脱困方式
        bot.setControlState('jump', true);
        await delay(220, { signal });
        bot.setControlState('jump', false);
        // 2) 朝一个方向短距离挪（不走 pathfinder，直接推方向键，
        //    因为 pathfinder 正是刚才失败的那个东西）
        const dirs = ['forward', 'back', 'left', 'right'];
        const dir = dirs[i % dirs.length];
        bot.setControlState(dir, true);
        await delay(500, { signal });
        bot.setControlState(dir, false);
        await delay(120, { signal });
      } catch {
        /* 单次尝试失败不算错 */
      } finally {
        try {
          for (const d of ['forward', 'back', 'left', 'right', 'jump']) {
            bot.setControlState(d, false);
          }
        } catch {
          /* ignore */
        }
      }
      const moved = distance(bot.entity.position, start);
      if (moved > 1.0) {
        log.info(`卡住自救成功（移动了 ${moved.toFixed(1)} 格，第 ${i + 1} 次尝试）`);
        return true;
      }

      // 3) 跳和挪都没用 → 挖开挡路的方块（岩壁脱困）
      const dug = await this._digOut({ signal });
      if (dug) {
        log.info(`卡住自救：挖开了挡路的方块（第 ${i + 1} 次尝试）`);
        // 挖开后立刻试着走进去
        try {
          await this.stepToward({
            x: bot.entity.position.x + (bot.entity.yaw !== undefined ? -Math.sin(bot.entity.yaw) * 2 : 0),
            z: bot.entity.position.z + (bot.entity.yaw !== undefined ? -Math.cos(bot.entity.yaw) * 2 : 0),
            signal,
            timeoutMs: 2500,
            tolerance: 1.5,
          });
        } catch {
          /* ignore */
        }
        const moved2 = distance(bot.entity.position, start);
        if (moved2 > 1.0) return true;
      }
    }
    log.warn('卡住自救失败：跳、挪、挖都没能脱身（可能被完全围住或领地保护）');
    return false;
  }

  /**
   * 朝四个方向找一格"挖得动、又不是致命方块"的墙，挖掉它。
   * 这是被困在岩壁前时唯一的出路。
   *
   * **先检查"头被方块卡住"**：这是实测最常见的死法——
   * 她挖矿时把自己封在洞里（脚下那层是 2 格通道、头顶那层却全是实心），
   * 于是任何寻路都失败（日志里她连着一小时喊"路被堵死了走不过去"），
   * 而她原来的脱困逻辑只看四个水平方向，压根没想过要挖头顶。
   */
  async _digOut({ signal = null } = {}) {
    const actions = this._actions;
    const bot = this._bot;
    if (!actions || !bot || !bot.entity) return false;
    const p = bot.entity.position;
    const bx = Math.floor(p.x);
    const by = Math.floor(p.y);
    const bz = Math.floor(p.z);

    // ---- 0) 头被卡住 / 整个人被埋住 → 先把脚和头两格挖通
    // 判定标准：她所在的格子或头顶那格不是空气。
    const blocked = [];
    for (const ty of [by + 1, by]) {
      const b = bot.blockAt(vec3(bx, ty, bz));
      if (b && b.boundingBox === 'block' && b.diggable) {
        if (!['lava', 'water', 'flowing_lava', 'flowing_water', 'bedrock', 'barrier'].includes(b.name)) {
          blocked.push({ x: bx, y: ty, z: bz, name: b.name });
        }
      }
    }
    for (const cell of blocked) {
      try {
        log.info(`脱困：先挖开卡住自己的 ${cell.name}(${cell.x},${cell.y},${cell.z})`);
        await actions.dig({ x: cell.x, y: cell.y, z: cell.z, signal, collect: true });
        return true;
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        log.debug(`挖开卡住自己的方块失败：${err.message}`);
      }
    }

    // ---- 1) 四个水平方向：打通脚+头两层
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    for (const [dx, dz] of dirs) {
      const tx = bx + dx;
      const tz = bz + dz;
      // 脚和头两层都要打通，不然还是过不去
      for (const ty of [by, by + 1]) {
        const b = bot.blockAt(vec3(tx, ty, tz));
        if (!b) continue;
        if (b.boundingBox !== 'block') continue; // 已经是空的
        if (!b.diggable) continue;
        if (['lava', 'water', 'flowing_lava', 'flowing_water', 'bedrock', 'barrier'].includes(b.name)) continue;
        try {
          await actions.dig({ x: tx, y: ty, z: tz, signal, collect: true });
          return true;
        } catch (err) {
          if (err instanceof CancelledError) throw err;
          log.debug(`脱困挖掘 (${tx},${ty},${tz}) 失败：${err.message}`);
        }
      }
    }
    return false;
  }

  /** 小跳一下：用于脱离 1 格台阶卡住、或作为动作的一部分让行为更像玩家 */
  async jump() {
    const bot = this._bot;
    if (!bot || !bot.entity) return;
    if (bot.entity.onGround) {
      bot.setControlState('jump', true);
      await delay(180);
      bot.setControlState('jump', false);
    }
  }

  /** 转视角（角度制）——渐进转头，不再瞬间对准 */
  async look(yawDeg, pitchDeg, { signal = null } = {}) {
    const bot = this._bot;
    if (!bot || !bot.entity) return;
    if (this._config.get('humanize') === false) {
      await bot.look((yawDeg * Math.PI) / 180, (pitchDeg * Math.PI) / 180, true);
      return;
    }
    await smoothLook(bot, (yawDeg * Math.PI) / 180, (pitchDeg * Math.PI) / 180, { signal });
  }

  /** 看向坐标（渐进；终点角度与瞬间对准完全一致，不影响挖掘/放置的朝向判定） */
  async lookAtPoint(x, y, z, { force = true, signal = null } = {}) {
    const bot = this._bot;
    if (!bot || !bot.entity) return;
    if (this._config.get('humanize') === false) {
      await bot.lookAt(vec3(x, y, z), force);
      return;
    }
    await smoothLookAt(bot, { x, y, z }, { signal });
  }

  /** 设置行走速度倍率（慢速反作弊模式下用） */
  applySpeedMultiplier() {
    const mult = this._config.derived().moveSpeedMultiplier;
    try {
      this._bot.physics && (this._bot.physics.scaling = mult);
    } catch {
      /* ignore */
    }
  }

  /** 溺水/岩浆自救：这两个是反射层动作，不需要 LLM */
  async escapeLiquid({ signal = null } = {}) {
    const bot = this._bot;
    if (!bot || !bot.entity) return false;
    const inLava = !!bot.entity.isInLava;
    if (inLava) {
      // 岩浆里靠游泳没用，往上冲 + 找最近的安全点
      bot.setControlState('jump', true);
      await delay(300, { signal });
      bot.setControlState('jump', false);
      return true;
    }
    if (bot.entity.isInWater) {
      bot.setControlState('jump', true);
      await delay(200, { signal });
      bot.setControlState('jump', false);
      return true;
    }
    return false;
  }

  /** 跳下/落下时的安全判定：给技能层判断能不能跳 */
  canSafelyDrop(fallDistance) {
    return fallDistance <= 3;
  }
}

class PathError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PathError';
  }
}


/**
 * 构造 Vec3 后调用 blockAt。
 * 直接传 {x,y,z} 会抛 "pos.floored is not a function"（mineflayer 内部用 Vec3 方法），
 * 所以这个文件里所有方块查询都必须走这里。
 */
function blockAt(bot, x, y, z) {
  try {
    return bot.blockAt(vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
  } catch {
    return null;
  }
}

module.exports = { Navigator, PathError, setupPathfinder, ARRIVE_RADIUS };
