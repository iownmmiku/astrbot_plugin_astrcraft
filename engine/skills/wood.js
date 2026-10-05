'use strict';
/**
 * 木材与工具链技能。
 *
 * 为什么把这些单独拿出来：Minecraft 生存的第一条链是固定的——
 *   原木 → 木板 → 工作台 / 木棍 → 木镐 → 石头 → 石镐 → 铁
 * 这条链走不通，后面所有事都免谈。所以它必须是**不依赖 LLM**的确定性代码，
 * LLM 只负责说"我要一套石制工具"。
 */

const log = require('../log');
const { delay, distance, CancelledError, describeFailure, vec3 } = require('../util');
const { skillResult, mergeCounts, positiveOnly, collectionCheckpoint, driveUntil, dropToGround, climbToSurface, canDigDownSafely } = require('./common');

/** 各类原木（含下界菌柄） */
const LOG_NAMES = [
  'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
  'mangrove_log', 'cherry_log', 'pale_oak_log', 'crimson_stem', 'warped_stem',
];

/** 方块 → 对应木板名 */
function planksOf(logName) {
  return `${String(logName).replace(/_log$|_stem$/, '')}_planks`;
}

/**
 * 砍树：找到最近的树，把树干整根挖掉，直到拿到 want 个原木。
 */
async function chopTree({ actions, nav, state, ctx, want = 8, radius = 48, maxAttempts = 24, logNames = LOG_NAMES }) {
  const steps = [];
  const have = () => logNames.reduce((s, n) => s + actions.countItem(n), 0);
  const checkpoint = collectionCheckpoint(ctx, ['chopTree', want, radius, maxAttempts, [...logNames].sort()],
    { have, want, inventory: () => actions.inventoryMap() });
  if (checkpoint.result) return checkpoint.result;
  require('./preparation').assertPreparationSearch({ actions, ctx, operation: '砍树取木材' });
  const before = checkpoint.before;
  const startHave = checkpoint.initialHave;

  ctx.progress(`开始砍树，目标 ${want} 根原木（当前 ${startHave}）`);
  log.info(`chopTree 开始：want=${want} radius=${radius} 当前原木=${startHave}`);

  // 先确认自己在地表。挖完矿她会待在洞里（实测 y=54 而地表 y=64），
  // 树都在地面上，不先爬出来就只会在洞里瞎转、报"附近找不到树"。
  const climb = await climbToSurface({ actions, nav, ctx });
  if (!climb.ok) return skillResult(false, {
    produced: positiveOnly(diffOf(before, actions.inventoryMap())),
    reason: climb.reason || '还未离开地下，先完成脱困再找树',
  });
  if (climb.steps > 0) {
    steps.push(`挖阶梯回到地表 ${climb.steps} 格`);
    log.info(`砍树前先爬出矿道：${climb.steps} 格（ok=${climb.ok}）`);
  }

  const result = await driveUntil({
    have,
    want: startHave + want,
    ctx,
    checkpoint,
    maxAttempts,
    label: '砍树',
    fetchOne: async (attempt) => {
      ctx.checkAborted();
      require('./preparation').assertPreparationSearch({ actions, ctx, operation: '砍树取木材' });
      const tree = await findLogBlock({ actions, state, radius, logNames });
      log.debug(`chopTree 第 ${attempt} 轮：findLogBlock → ${tree ? JSON.stringify(tree) : 'null'}`);
      if (!tree) {
        // 附近没有树：走远一点找
        const far = await wanderLookingFor(logNames, { actions, nav, ctx, radius });
        log.debug(`chopTree 第 ${attempt} 轮：wanderLookingFor → ${far ? JSON.stringify(far) : 'null'}`);
        if (!far) return false;
        require('./preparation').assertPreparationSearch({ actions, ctx, operation: '砍树取木材' });
        const r = await actions.dig({ x: far.x, y: far.y, z: far.z, signal: ctx.signal, collect: true, reach: true, safe: true });
        steps.push(`挖 ${r.block}`);
        return true;
      }
      require('./preparation').assertPreparationSearch({ actions, ctx, operation: '砍树取木材' });
      const r = await actions.dig({ x: tree.x, y: tree.y, z: tree.z, signal: ctx.signal, collect: true, reach: true, safe: true });
      steps.push(`挖 ${r.block} @(${tree.x},${tree.y},${tree.z})`);

      // 挖了但没拿到东西，最常见的原因是站在树冠上、掉落物掉到下面的树叶上了。
      // 真玩家会跳下去捡，所以这里也下去——否则砍树会永远停在 0/N。
      if (!r.collected || Object.keys(r.collected).length === 0) {
        ctx.progress('掉落物够不到，下到地面去捡');
        try {
          const drop = await dropToGround({ actions, nav, ctx, maxSegments: 6 });
          if (drop.ok) {
            const got = await actions.collectDrops({ signal: ctx.signal, timeoutMs: 6000 });
            if (Object.keys(got.gained || {}).length) {
              steps.push(`下到地面捡回掉落物`);
              return true;
            }
          }
        } catch (err) {
          if (err instanceof CancelledError) throw err;
          log.info(`为捡掉落物下树失败：${err.message}`);
        }
      }
      return true;
    },
  });

  const after = actions.inventoryMap();
  const produced = positiveOnly(diffOf(before, after));
  ctx.checkAborted();
  return (checkpoint.result = skillResult(result.reached, {
    steps,
    produced,
    note: result.reached
      ? `砍到 ${result.gained} 根原木`
      : `只砍到 ${result.gained} 根原木${result.lastError ? `（${result.lastError}）` : '（附近找不到足够的树）'}`,
    reason: result.reached ? null : result.lastError || '附近没有足够的树，可以换个方向或走远一点再试',
  }));
}

/**
 * 找最近的树干底部方块。
 *
 * 优化点（原始版本在这里踩过坑）：
 *   - **必须逐格扫描**：早期为了省时间用步长 2 扫描，会漏掉奇数坐标上的树干，
 *     现象是"附近明明有树却一直报找不到"。
 *   - 用单格 column 判断比"先找树顶再往下"便宜得多：从脚下高度往上/下各看一段，
 *     第一个原木就是树干上的某一段，再往下找到最低的那块。
 *   - 不遍历全部候选，找到就按距离择优返回。
 */
/**
 * 找最近的树干。
 *
 * **性能很关键**：这个函数在砍树的每一轮循环里都会被调用，
 * 而旧实现是"无序双重循环 + 全量扫描"，半径 48 时最多产生
 * 97×97 列 × 19 层 ≈ 13.7 万次 `blockAt`（每次都分配 Vec3）。
 * 实测后果：**Node 事件循环被阻塞 28 秒**——期间引擎收不到也回不了任何 RPC，
 * 表现就是"她在砍树时你问不到状态、急停也没反应"。
 *
 * 现在三点优化（都不改变"找最近的树"这个语义）：
 *   1. 半径收紧到 32（48 找到的树也常常走不到）
 *   2. **由近到远**扫描，找到第一棵就返回（附近有树时几乎瞬时）
 *   3. 每扫 400 列让出一次事件循环，最坏情况也能保持 RPC 可响应
 */
async function findLogBlock({ actions, state, radius, logNames = LOG_NAMES }) {
  const bot = actions.bot;
  const pos = bot.entity.position;
  const cx = Math.floor(pos.x);
  const cy = Math.floor(pos.y);
  const cz = Math.floor(pos.z);
  const r = Math.min(32, radius || 32);
  const logSet = new Set(logNames);

  // 先按水平距离把候选列排好序，之后由近到远扫
  const cols = [];
  for (let dx = -r; dx <= r; dx += 1) {
    for (let dz = -r; dz <= r; dz += 1) {
      const d = Math.hypot(dx, dz);
      if (d <= r) cols.push({ x: cx + dx, z: cz + dz, d });
    }
  }
  cols.sort((a, b) => a.d - b.d);

  let scanned = 0;
  for (const col of cols) {
    scanned += 1;
    // 每 60 列让出一次事件循环。
    // 早期是每 400 列——那一轮里要做约 7600 次同步方块查询，
    // 在真实服务器上足以把引擎卡住好几秒；引擎一卡，插件查状态就拿到过期数据，
    // LLM 会误判"她卡死了"并取消任务（实测就是这样把建房任务取消掉的）。
    if (scanned % 60 === 0) await delay(0);

    // 从脚下往上 10 格、往下 8 格内找这一列里的原木
    let topY = null;
    for (let y = cy + 10; y >= cy - 8; y -= 1) {
      const b = blockAt(bot, col.x, y, col.z);
      if (b && logSet.has(b.name)) {
        topY = y;
        break;
      }
    }
    if (topY === null) continue;

    // 顺树干往下找到最低的一块（站着挖最省事）
    let baseY = topY;
    while (baseY - 1 > cy - 10) {
      const b = blockAt(bot, col.x, baseY - 1, col.z);
      if (b && logSet.has(b.name)) baseY -= 1;
      else break;
    }
    const b = blockAt(bot, col.x, baseY, col.z);
    if (!b) continue;
    if (require('./mining_return').isProtectedHomePosition(bot, b.position || { x: col.x, y: baseY, z: col.z })) continue;

    // 关键过滤：最低块的高度必须是机器人站在地上能够得着的！
    // 丛林树冠的分支原木经常悬空在空中（比如离地 8-15 格高，下面全是空气或树叶）。
    // 如果选了这种悬空树枝，机器人走到树下也够不着，实测会报：
    // "走到跟前了仍相距十多格，够不到"（丛林服真实复现）。
    // 只有最低处的原木距离脚下不超过 3 格高时才选：这样站地上就能砍。
    if (baseY - cy > 3 || cy - baseY > 6) continue;

    // 就近优先：这是当前扫描到的最近一列，直接返回
    return { x: col.x, y: baseY, z: col.z, name: b.name };
  }
  return null;
}

/**
 * 附近找不到目标时，往随机方向走一段再找。
 *
 * 两个要点：
 *   1. 距离不要太大：20 格以内的目标寻路成功率远高于 40 格，
 *      而且在复杂地形里"走不到"会白白浪费时间。多试几次短距离比一次长距离更划算。
 *   2. 每次移动后都要重新找；找不到就换方向，而不是死磕同一个点。
 */
async function wanderLookingFor(names, { actions, nav, ctx, radius = 48, maxHops = 6 }) {
  const bot = actions.bot;
  for (let hop = 0; hop < maxHops; hop += 1) {
    ctx.checkAborted();
    require('./preparation').assertPreparationSearch({ actions, ctx, operation: '外出探索原料' });

    // The type matcher first receives positionless palette blocks. Check
    // height only in useExtraInfo, after Mineflayer reads the actual block.
    // Capture the body height before searching; respawn may replace the body.
    if (!bot.entity) throw new Error('她现在不在游戏里（可能正在重生），稍后再试');
    const hereY = bot.entity.position.y;
    const found = bot.findBlock({
      matching: (b) => b && names.includes(b.name),
      useExtraInfo: (b) => !!b?.position && Math.abs(b.position.y - hereY) <= 4 &&
        !require('./mining_return').isProtectedHomePosition(bot, b.position),
      maxDistance: radius,
    });
    if (found && !require('./mining_return').isProtectedHomePosition(bot, found.position)) {
      return { x: found.position.x, y: found.position.y, z: found.position.z, name: found.name };
    }

    const angle = Math.random() * Math.PI * 2;
    const dist = 12 + Math.random() * 10;
    const tx = bot.entity.position.x + Math.cos(angle) * dist;
    const tz = bot.entity.position.z + Math.sin(angle) * dist;
    ctx.progress(`附近没有目标，向 (${tx.toFixed(0)}, ${tz.toFixed(0)}) 方向探索`);
    try {
      await nav.goTo({ x: tx, y: null, z: tz, range: 3, signal: ctx.signal, timeoutMs: 12000 });
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      log.info(`探索移动失败（换方向继续）：${err.message}`);
    }
  }
  return null;
}

/** 把原木合成木板（自动处理"原木不够就先砍"的依赖） */
async function makePlanks({ actions, ctx, want = 8, reserveItems = {} }) {
  const steps = [];
  const before = actions.inventoryMap();
  const planksHave = () => {
    const map = actions.inventoryMap();
    return Object.entries(map)
      .filter(([n]) => n.endsWith('_planks'))
      .reduce((s, [, c]) => s + c, 0);
  };
  // want 是"要新增多少"，不是"最终要有多少"。
  // 早期按绝对值判断，手头已有 16 个木板时还会继续合成，白白消耗原木。
  const startHave = planksHave();
  const availableLogs = (name) => Math.max(0, actions.countItem(name) -
    Math.max(0, Math.ceil(Number(reserveItems?.[name] ?? reserveItems?.[`minecraft:${name}`]) || 0)));
  let guard = 0;

  while (planksHave() - startHave < want) {
    ctx.checkAborted();
    if (guard++ > 64) break; // 防御：避免任何计数异常导致死循环
    const logName = LOG_NAMES.find((n) => availableLogs(n) > 0);
    if (!logName) {
      const gained = planksHave() - startHave;
      return skillResult(false, {
        steps,
        produced: positiveOnly(diffOf(before, actions.inventoryMap())),
        note: gained > 0 ? `已做出 ${gained} 个木板` : null,
        reason: '没有未保留的原木可用了，先用 mc_chop_tree 砍点树',
      });
    }
    const deficit = want - (planksHave() - startHave);
    const need = Math.ceil(deficit / 4);
    const available = availableLogs(logName);
    const times = Math.min(need, available);
    try {
      // Actions.craft takes the desired number of output items, not recipe batches.
      const r = await actions.craft({ item: planksOf(logName), count: times * 4, signal: ctx.signal });
      steps.push(`${logName}×${times} → ${planksOf(logName)}×${r.produced}`);
    } catch (err) {
      if (err instanceof CancelledError || ['CancelledError', 'AbortError', 'PreparationBlockedError',
        'ProtectedBlockError', 'ProtectedHomeError'].includes(err?.name)) throw err;
      return skillResult(false, {
        steps,
        produced: positiveOnly(diffOf(before, actions.inventoryMap())),
        reason: `合成木板失败：${describeFailure(err)}`,
      });
    }
    ctx.progress(`木板 +${planksHave() - startHave}/${want}`);
  }
  // **必须验证真的做出来了**（这一轮修的"假成功"）。
  //
  // 原来这里**无条件** `return skillResult(true, ...)` —— 于是：
  //   · `actions.craft` 失败（比如工作台没放好、配方没匹配上）
  //   · 循环继续转，直到 `guard > 64` 才 break
  //   · **然后照样返回 ok: true**
  // 上游（`ensureCraftingTable`）以为木板够了，就去合成工作台 ——
  // 而实际木板还是 3 个，于是报 "合成工作台没有产出（检查木板是否够 4 个）"。
  //
  // 实测：`test_survival_chain` 的 [2] 就是这样红的，而且**背包里明明有 5 个原木**。
  //
  // 判据用**实际增量**，不信循环"跑完了"：
  // 跑完不等于做成 —— 这个坑我在 `_runPath` 的 `arrived` 上踩过一次，
  // 在 `make_tools` 上也踩过一次，这是第三次。
  const gained = planksHave() - startHave;
  if (gained < want) {
    return skillResult(false, {
      steps,
      produced: positiveOnly(diffOf(before, actions.inventoryMap())),
      note: gained > 0 ? `只做出 ${gained} 个木板（想要 ${want} 个）` : null,
      reason:
        gained > 0
          ? `只做出 ${gained}/${want} 个木板`
          : '一个木板都没做出来（可能工作台没放好、或者配方没匹配上）',
    });
  }
  return skillResult(true, {
    steps,
    produced: positiveOnly(diffOf(before, actions.inventoryMap())),
    note: `新增木板 ${gained} 个`,
  });
}

/** 合成木棍（木板不够时会自己补做木板，木板不够再找原木——完整自愈） */
async function makeSticks({ actions, nav, state, ctx, want = 4, allowSearch = true }) {
  if (typeof ctx.child === 'function') ctx = ctx.child(['makeSticks', want, allowSearch]);
  const steps = [];
  const before = actions.inventoryMap();
  const startHave = actions.countItem('stick');
  let guard = 0;

  while (actions.countItem('stick') - startHave < want) {
    ctx.checkAborted();
    if (guard++ > 32) break;

    // 木板不够就先补木板。这里必须自愈：
    // 做木镐会消耗掉木板，如果不补，"再做石镐"就会因为缺木棍而失败——
    // 真实场景里玩家会顺手再砍点木头，而不是停下来报错。
    if (countPlanks(actions) < 2) {
      const logName = LOG_NAMES.find((n) => actions.countItem(n) > 0);
      if (!logName) {
        if (allowSearch && totalLogs(actions) === 0) {
          const chop = await chopTree({ actions, nav, state, ctx, want: 2 });
          steps.push(...chop.steps);
        }
        if (countPlanks(actions) < 2 && totalLogs(actions) === 0) {
          const gained = actions.countItem('stick') - startHave;
          return skillResult(gained > 0, {
            steps,
            produced: positiveOnly(diffOf(before, actions.inventoryMap())),
            note: gained > 0 ? `已做出 ${gained} 根木棍` : null,
            reason: '木板不足，且没有原木可再做木板（需要 2 个木板才能做 4 根木棍）',
          });
        }
      }
      const pk = await makePlanks({ actions, ctx, want: 2 - countPlanks(actions) });
      steps.push(...pk.steps);
      if (countPlanks(actions) < 2) {
        const gained = actions.countItem('stick') - startHave;
        return skillResult(gained > 0, {
          steps,
          produced: positiveOnly(diffOf(before, actions.inventoryMap())),
          note: gained > 0 ? `已做出 ${gained} 根木棍` : null,
          reason: `补做木板失败：${pk.reason || '木板仍不足'}`,
        });
      }
    }

    const planks = findAnyPlanks(actions);
    if (!planks) {
      return skillResult(false, { steps, reason: '现有木板不足以完成木棍配方' });
    }
    const canMake = Math.floor(actions.countItem(planks) / 2) * 4;
    if (canMake <= 0) {
      const gained = actions.countItem('stick') - startHave;
      return skillResult(gained > 0, {
        steps,
        produced: positiveOnly(diffOf(before, actions.inventoryMap())),
        note: gained > 0 ? `已做出 ${gained} 根木棍` : null,
        reason: `木板不足（需要 2 个 ${planks} 才能做 4 根木棍，当前只有 ${actions.countItem(planks)} 个）`,
      });
    }
    const deficit = want - (actions.countItem('stick') - startHave);
    const times = Math.max(1, Math.min(Math.ceil(deficit / 4), Math.floor(actions.countItem(planks) / 2)));
    try {
      const r = await actions.craft({ item: 'stick', count: times * 4, signal: ctx.signal });
      steps.push(`木板 → 木棍×${r.produced}`);
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      const gained = actions.countItem('stick') - startHave;
      return skillResult(gained > 0, {
        steps,
        produced: positiveOnly(diffOf(before, actions.inventoryMap())),
        note: gained > 0 ? `已做出 ${gained} 根木棍` : null,
        reason: `合成木棍失败：${describeFailure(err)}`,
      });
    }
  }
  // **走到这里的前提是「真的做出了木棍」** —— craft 可以正常返回但 produced=0
  // （服务端忽略点击）。原来这里无条件 true，note 会写「新增木棍 0 根」却报成功。
  // 和 catch 分支用同一个标准：gained > 0 才算数。
  const finalGained = actions.countItem('stick') - startHave;
  if (finalGained <= 0) {
    return skillResult(false, {
      steps,
      produced: positiveOnly(diffOf(before, actions.inventoryMap())),
      reason: '木棍一个都没做出来（可能服务端没接受点击）',
    });
  }
  return skillResult(true, {
    steps,
    produced: positiveOnly(diffOf(before, actions.inventoryMap())),
    note: `新增木棍 ${actions.countItem('stick') - startHave} 根`,
  });
}

function findAnyPlanks(actions) {
  const map = actions.inventoryMap();
  const found = Object.entries(map).find(([n, c]) => n.endsWith('_planks') && c >= 2);
  return found ? found[0] : null;
}

const TIERS = ['wooden', 'stone', 'iron', 'diamond', 'netherite'];
const TOOL_KINDS = ['pickaxe', 'axe', 'shovel', 'sword'];

/**
 * 做一套工具。
 * @param {object} o
 * @param {'wooden'|'stone'|'iron'|'diamond'} o.tier
 * @param {string[]} o.kinds 默认 ['pickaxe','axe','sword','shovel']
 */
/** 统一的技能出口日志：技能"秒退"时这是唯一能定位到具体分支的手段 */
function finishTools(result, tier, t0) {
  log.info(
    `做${tier}工具结束（${Date.now() - t0}ms）：ok=${result.ok} note=${result.note || '-'} reason=${result.reason || '-'}`,
  );
  return result;
}

async function makeTools({ actions, nav, state, ctx, tier = 'stone', kinds = null, allowSearch = true, forceReplace = false }) {
  const requestedKinds = [...new Set(kinds && kinds.length ? kinds : ['pickaxe', 'axe', 'sword', 'shovel'])];
  if (typeof ctx.child === 'function') ctx = ctx.child(['makeTools', tier, [...requestedKinds].sort(), allowSearch, forceReplace]);
  const wantKinds = requestedKinds.filter((kind) => forceReplace || !hasTool(actions, `${tier}_${kind}`));
  const steps = [];
  const before = actions.inventoryMap();
  // 入口自检 + 日志：技能"秒退"是排查噩梦，所以每一步的耗时与判断都记下来
  const t0 = Date.now();
  let miningMetadata = {};
  if (!wantKinds.length) return finishTools(skillResult(true, {
    note: `已拥有：${requestedKinds.map((kind) => `${tier}_${kind}`).join('、')}`,
    extra: { made: [], failed: [], missing: [] },
  }), tier, t0);
  if (wantKinds.some((kind) => !TOOL_KINDS.includes(kind))) {
    return finishTools(skillResult(false, { reason: `工具类型仅支持 ${TOOL_KINDS.join(' / ')}` }), tier, t0);
  }
  log.info(
    `开始做${tier}工具（${wantKinds.join('/')}）；背包现状：${Object.entries(before).map(([k, v]) => `${k}×${v}`).join('、') || '空'}`,
  );
  const material = tierMaterial(tier);
  if (!material) {
    return finishTools(
      skillResult(false, { reason: `不认识的工具等级：${tier}（可用：wooden / stone / iron / diamond）` }),
      tier,
      t0,
    );
  }

  // Gather only the materials for missing tools, then prepare their 3×3 workstation.
  //
  // 材料需求量**按实际要做的工具种类算**，不要写死。
  // 早期版本固定要 11 个锭/圆石（那是做整套工具的用量），
  // 结果"只做一把铁镐"也会先去挖 12 个矿，白白多花一两分钟，
  // 甚至因为挖到石头层卡住。一把镐只需要 3 个材料。
  const materialCounts = { pickaxe: 3, axe: 3, sword: 2, shovel: 1 };
  const stickCounts = { pickaxe: 2, axe: 2, sword: 1, shovel: 2 };
  const materialNeeded = wantKinds.reduce((sum, kind) => sum + materialCounts[kind], 0);
  const sticksNeeded = wantKinds.reduce((sum, kind) => sum + stickCounts[kind], 0);

  const ensurePlanks = async (needed, scope) => {
    const supplyCtx = typeof ctx.child === 'function' ? ctx.child(['planks', scope]) : ctx;
    const deficit = Math.max(0, needed - countPlanks(actions));
    if (!deficit) return { ok: true };
    const logDeficit = Math.max(0, Math.ceil(deficit / 4) - totalLogs(actions));
    if (logDeficit > 0 && allowSearch) {
      const chop = await chopTree({ actions, nav, state, ctx: supplyCtx, want: logDeficit });
      steps.push(...chop.steps);
      if (!chop.ok && totalLogs(actions) < Math.ceil(deficit / 4)) return chop;
    }
    if (totalLogs(actions) < Math.ceil(deficit / 4)) {
      return { ok: false, reason: `还缺 ${deficit} 个木板，需要补 ${logDeficit} 根原木${allowSearch ? '' : '（已禁用自动找树）'}` };
    }
    const result = await makePlanks({ actions, ctx, want: deficit });
    steps.push(...result.steps);
    return countPlanks(actions) >= needed ? { ok: true } : result;
  };

  // Furnace fuel may be ordinary wood. Turn the tool's reserved wood into
  // sticks/a table before smelting; reserve the sticks below because they burn too.
  if (tier === 'iron' && actions.countItem('iron_ingot') < materialNeeded) {
    const missingSticks = Math.max(0, sticksNeeded - actions.countItem('stick'));
    const tablePlanks = findCraftingTable(actions) || actions.countItem('crafting_table') > 0 ? 0 : 4;
    const prepared = await ensurePlanks(Math.ceil(missingSticks / 4) * 2 + tablePlanks, 'beforeSmelting');
    if (!prepared.ok) return finishTools(skillResult(false, { steps, reason: prepared.reason }), tier, t0);
    if (missingSticks > 0) {
      const st = await makeSticks({ actions, nav, state, ctx, want: missingSticks, allowSearch });
      steps.push(...st.steps);
      if (!st.ok) return finishTools(skillResult(false, { steps, reason: st.reason }), tier, t0);
    }
    const table = await ensureCraftingTable({ actions, ctx, steps });
    if (!table.ok) return finishTools(skillResult(false, { steps, reason: table.reason }), tier, t0);
  }

  if (tier === 'wooden') {
    // The shared wood budget below includes planks, sticks and a table only if needed.
  } else if (tier === 'stone') {
    const stoneMaterial = ['cobblestone', 'cobbled_deepslate', 'blackstone']
      .find((name) => actions.countItem(name) >= materialNeeded) || 'cobblestone';
    if (!allowSearch && actions.countItem(stoneMaterial) < materialNeeded) {
      return finishTools(skillResult(false, { steps,
        reason: `圆石不足（需要 ${materialNeeded} 个，只有 ${actions.countItem('cobblestone')} 个；已禁用自动采料）` }), tier, t0);
    }
    // 石制工具需要圆石：先确保有木镐
    if (actions.countItem(stoneMaterial) < materialNeeded && !hasTool(actions, 'wooden_pickaxe') && !hasBetterPickaxe(actions, 'wooden')) {
      log.info('石制工具需要先有木镐，先做木镐');
      const r = await makeTools({ actions, nav, state, ctx, tier: 'wooden', kinds: ['pickaxe'], allowSearch });
      steps.push(...r.steps);
      if (!r.ok) {
        return finishTools(
          skillResult(false, { steps, reason: `需要木镐来挖石头，但做木镐失败：${r.reason}` }),
          tier,
          t0,
        );
      }
    }
    if (actions.countItem(stoneMaterial) < materialNeeded) {
      ctx.progress(`挖圆石准备石制工具（需要 ${materialNeeded} 个，现有 ${actions.countItem('cobblestone')}）`);
      const r = await require('./mining').mineStone({
        actions,
        nav,
        state,
        ctx,
        want: materialNeeded - actions.countItem('cobblestone'),
        radius: 40,
        strictOnly: true,
        allowSearch,
      });
      ctx.checkAborted();
      steps.push(...r.steps);
      if (r.return_status) miningMetadata = { return_status: r.return_status };
      if (r.return_status?.ok === false) {
        return finishTools(skillResult(false, {
          steps, produced: positiveOnly(diffOf(before, actions.inventoryMap())),
          reason: r.reason || r.return_status.reason || '采石后尚未安全返回，先完成脱困再做工具',
          extra: { collection_ok: false, material_collection_ok: r.collection_ok, return_status: r.return_status },
        }), tier, t0);
      }
      if (actions.countItem('cobblestone') < materialNeeded && !r.ok) {
        return finishTools(skillResult(false, { steps, reason: `挖圆石失败：${r.reason}`, extra: miningMetadata }), tier, t0);
      }
    }
  } else if (tier === 'iron') {
    if (actions.countItem('iron_ingot') < materialNeeded) {
      const mining = require('./mining');
      const ironInputs = ['raw_iron', 'iron_ore', 'deepslate_iron_ore'];
      let materialFailure = null;
      const stopUnsafeSmelting = (sm) => finishTools(skillResult(false, {
        steps, produced: positiveOnly(diffOf(before, actions.inventoryMap())),
        reason: sm.reason || sm.return_status.reason || '准备熔炉后尚未安全返回，先完成脱困再做工具',
        extra: { collection_ok: false, material_collection_ok: sm.material_collection_ok === true,
          return_status: sm.return_status },
      }), tier, t0);
      const smeltAvailable = async () => {
        for (const item of ironInputs) {
          ctx.checkAborted();
          const need = materialNeeded - actions.countItem('iron_ingot');
          const amount = Math.min(need, actions.countItem(item));
          if (amount <= 0) continue;
          ctx.progress(`先熔炼现有 ${item}×${amount}，补齐铁制工具材料`);
          const sm = await mining.smeltOres({ actions, nav, state, ctx, item, count: amount, allowSearch,
            reserveItems: { stick: sticksNeeded } });
          ctx.checkAborted();
          steps.push(...sm.steps);
          if (sm.return_status?.ok === false) return sm;
          if (!sm.ok || actions.countItem(item) > 0 && actions.countItem('iron_ingot') < materialNeeded) {
            materialFailure = sm.reason || sm.failed?.map((f) => f.error).join('；') || '现有铁矿还没有熔炼完成';
          }
        }
      };
      // Coarse iron and silk-touched ore already in the pack are an indoor
      // resource. Do not mine replacements for ore that merely needs a furnace.
      const initialSmelt = await smeltAvailable();
      if (initialSmelt?.return_status?.ok === false) return stopUnsafeSmelting(initialSmelt);
      if (allowSearch && actions.countItem('iron_ingot') < materialNeeded && !ironInputs.some((item) => actions.countItem(item) > 0)) {
        const needIngots = materialNeeded - actions.countItem('iron_ingot');
        ctx.progress(`现有铁料已用完，还需挖 ${needIngots} 个铁矿（做 ${wantKinds.join('/')}）`);
        const r = await mining.mineOre({ actions, nav, state, ctx, ore: 'iron', want: needIngots, allowSearch });
        ctx.checkAborted();
        steps.push(...r.steps);
        if (r.return_status) miningMetadata = { return_status: r.return_status };
        // Inventory can be sufficient while the body is still stranded. Stop
        // before opening a furnace or crafting at that unsafe position.
        if (r.return_status?.ok === false) {
          return finishTools(skillResult(false, {
            steps, produced: positiveOnly(diffOf(before, actions.inventoryMap())),
            reason: r.reason || r.return_status.reason || '采铁后尚未安全返回，先完成脱困再做工具',
            extra: { collection_ok: false, material_collection_ok: r.collection_ok, return_status: r.return_status },
          }), tier, t0);
        }
        if (!r.ok) materialFailure = r.reason;
        // A partial mining result can still leave useful ore in the pack.
        const gatheredSmelt = await smeltAvailable();
        if (gatheredSmelt?.return_status?.ok === false) return stopUnsafeSmelting(gatheredSmelt);
      }
      if (actions.countItem('iron_ingot') < materialNeeded) {
        const got = actions.countItem('iron_ingot');
        return finishTools(
          skillResult(false, { steps, produced: positiveOnly(diffOf(before, actions.inventoryMap())),
            reason: `铁锭不够做${wantKinds.join('/')}（需要 ${materialNeeded} 个，只有 ${got} 个）${materialFailure ? `：${materialFailure}` : ''}`,
            extra: miningMetadata }),
          tier,
          t0,
        );
      }
    }
  } else if (tier === 'diamond') {
    if (actions.countItem('diamond') < materialNeeded) {
      return finishTools(
        skillResult(false, {
          steps,
          reason: `钻石不足（需要 ${materialNeeded} 个，只有 ${actions.countItem('diamond')} 个）。建议先做出铁镐再挖钻石`,
        }),
        tier,
        t0,
      );
    }
  }

  // 木棍（木制工具也需要）。allow_search 要透传下去：
  // 否则在"已给材料、禁止找树"的定向测试里，它会跑出去找树。
  const missingSticks = Math.max(0, sticksNeeded - actions.countItem('stick'));
  const nearbyTable = findCraftingTable(actions);
  const tablePlanks = nearbyTable || actions.countItem('crafting_table') > 0 ? 0 : 4;
  const plankBudget = (tier === 'wooden' ? materialNeeded : 0) + Math.ceil(missingSticks / 4) * 2 + tablePlanks;
  const wood = await ensurePlanks(plankBudget, 'budget');
  if (!wood.ok) return finishTools(skillResult(false, { steps, reason: wood.reason }), tier, t0);
  if (missingSticks > 0) {
    const st = await makeSticks({ actions, nav, state, ctx, want: missingSticks, allowSearch });
    steps.push(...st.steps);
    if (!st.ok) return finishTools(skillResult(false, { steps, reason: st.reason }), tier, t0);
  }

  // 工作台：只有少数配方能在随身 2×2 合成栏完成（木板、木棍、火把、工作台本身）。
  // **工具一律需要 3×3**——连木镐也是（3 木板在上、2 木棍在下），
  // 这一点早期判断错了，导致"做木镐"永远卡在缺工作台。
  // 这里按 2×2 白名单判断，其余一律先确保有工作台。
  const CRAFTABLE_WITHOUT_TABLE = new Set([
    'stick', 'torch', 'crafting_table',
    'oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks',
    'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'crimson_planks', 'warped_planks',
    'pale_oak_planks', 'bamboo_planks',
  ]);
  const plannedNames = wantKinds.map((k) => `${tier}_${k}`);
  const needsTable = plannedNames.some((n) => !CRAFTABLE_WITHOUT_TABLE.has(n));
  if (needsTable) {
    const tableOk = await ensureCraftingTable({ actions, ctx, steps });
    if (!tableOk.ok) return finishTools(skillResult(false, { steps, reason: tableOk.reason }), tier, t0);
  }

  // 逐个合成
  const made = [];
  const failed = [];
  for (const kind of wantKinds) {
    ctx.checkAborted();
    const name = `${tier}_${kind}`;
    if (!forceReplace && hasTool(actions, name)) {
      made.push(name);
      continue;
    }

    // 每做一件之前补齐材料。
    // 关键：做第一件会消耗木板与木棍，不补的话第二件必然失败——
    // 实测"做木镐+木斧"时只出了镐子，斧头因为木板不够而失败，
    // 而背包里明明还有 6 根原木。真玩家会顺手再做点木板，这里也照做。
    if (actions.countItem('stick') < stickCounts[kind]) {
      const st = await makeSticks({ actions, nav, state, ctx, want: stickCounts[kind] - actions.countItem('stick'), allowSearch });
      steps.push(...st.steps);
    }
    if (tier === 'wooden' && countPlanks(actions) < materialCounts[kind]) {
      const pk = await ensurePlanks(materialCounts[kind], kind);
      if (!pk.ok) { failed.push({ name, error: pk.reason }); continue; }
    }

    try {
      const crafted = await actions.craft({ item: name, count: 1, signal: ctx.signal });
      const nowHave = forceReplace ? actions.countItem(name) > (before[name] || 0) : hasTool(actions, name);
      // 不能因为 craft 没抛异常就认为做成了：以背包里真的有这件工具为准。
      // 注意判断顺序：**先看背包**。crafted.ok 依赖"这次调用前后该物品的增量"，
      // 如果这件工具在调用前就已经在背包里（例如刚补过料、或上一轮部分成功），
      // 增量就是 0，crafted.ok 会是 false，但东西其实已经有了。
      if (nowHave) {
        made.push(name);
        steps.push(`合成 ${name}`);
        ctx.progress(`已合成 ${name}`);
      } else {
        failed.push({ name, error: crafted.note || `合成 ${name} 没有产出` });
        log.debug(`合成 ${name} 未产出：ok=${crafted.ok} produced=${crafted.produced} note=${crafted.note || '-'}`);
      }
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      failed.push({ name, error: describeFailure(err) });
    }
  }

  const after = actions.inventoryMap();
  const stillMissing = wantKinds.map((k) => `${tier}_${k}`).filter((n) =>
    forceReplace ? actions.countItem(n) <= (before[n] || 0) : !hasTool(actions, n));
  // 只要"至少一套里有一件"就算部分成功，但 note 必须如实说清缺什么
  const ok = stillMissing.length === 0;
  return finishTools(
    skillResult(ok, {
      steps,
      produced: positiveOnly(diffOf(before, after)),
      note: made.length > 0
        ? `已获得：${made.join('、')}${stillMissing.length ? `；还缺：${stillMissing.join('、')}` : ''}`
        : `一件工具都没做出来：${failed.map((f) => `${f.name}(${f.error})`).join('、') || '材料不足'}`,
      reason: ok ? null : failed.map((f) => f.error).join('；') || `材料不足以合成 ${wantKinds.join('/')}`,
      extra: { made, failed, missing: stillMissing, ...miningMetadata,
        ...(miningMetadata.return_status ? { collection_ok: ok } : {}) },
    }),
    tier,
    t0,
  );
}

/** 确保有工作台：有就放一个在脚边 */
async function ensureCraftingTable({ actions, ctx, steps = [] }) {
  const bot = actions.bot;
  const nearby = findCraftingTable(actions);
  if (nearby) return { ok: true, position: nearby.position, note: '附近已有工作台' };

  if (actions.countItem('crafting_table') > 0) {
    const pos = actions._spotInFront();
    if (pos) {
      try {
        await actions.place({ x: pos.x, y: pos.y, z: pos.z, item: 'crafting_table', signal: ctx.signal, reach: true });
        steps.push('放置工作台');
        return { ok: true, position: pos };
      } catch (err) {
        log.info(`放置工作台失败：${err.message}`);
        // 必须在这里返回：以前漏了 return，代码会继续往下走到"再合成一个工作台"，
        // 结果背包里明明有工作台，却报"材料不足"（真实踩过的坑）。
        return {
          ok: false,
          reason: `背包里有工作台但放不下去（${describeFailure(err)}）。可以找个平坦开阔的地方再试，或手动放一个`,
        };
      }
    }
    return { ok: false, reason: '背包里有工作台，但身边没有可以放置的位置（周围太挤或悬空）' };
  }

  // 没有任何工作台：用原木做木板再做
  if (countPlanks(actions) < 4) {
    if (totalLogs(actions) === 0) {
      return { ok: false, reason: '需要工作台，但既没有工作台也没有原木' };
    }
    const pk = await makePlanks({ actions, ctx, want: 4 - countPlanks(actions) });
    steps.push(...pk.steps);
    if (!pk.ok) return { ok: false, reason: `做木板失败：${pk.reason}` };
  }
  try {
    const crafted = await actions.craft({ item: 'crafting_table', count: 1, signal: ctx.signal });
    if (!crafted.ok || actions.countItem('crafting_table') === 0) {
      return { ok: false, reason: '合成工作台没有产出（检查木板是否够 4 个）' };
    }
    steps.push('合成工作台');
    const pos = actions._spotInFront();
    if (pos) {
      await actions.place({ x: pos.x, y: pos.y, z: pos.z, item: 'crafting_table', signal: ctx.signal, reach: true });
      steps.push('放置工作台');
      return { ok: true, position: pos };
    }
    return { ok: true, note: '工作台已在背包里' };
  } catch (err) {
    return { ok: false, reason: `合成/放置工作台失败：${describeFailure(err)}` };
  }
}

/**
 * 挖指定名字的方块直到拿到 want 个目标物品。
 * 这是 mineOre / collect 的共用底层。
 */
/**
 * 朝目标方向挖一格：目标在下方就往下挖，在侧面就横着挖。
 *
 * **为什么需要这个**：地表之下的石头/矿石是**被埋住的**，
 * `actions.dig({reach:true})` 会先尝试寻路走到方块旁边——
 * 而埋在岩石里的方块永远"走不到"，于是抛 noPath 错误。
 * 真玩家遇到这种情况就是**把上面的泥土挖开**，一路挖到目标。
 * 没有这步，挖石头会在 2 秒内失败四次然后报"连续多次没有进展"
 * （实测：她在真实服务器上因此永远挖不到石头，整条生存链锁死）。
 */
async function digToward({ actions, ctx, target }) {
  require('./preparation').assertPreparationSearch({ actions, ctx, operation: '挖掘原料通道' });
  const bot = actions.bot;
  const p = bot.entity.position;
  const bx = Math.floor(p.x);
  const by = Math.floor(p.y);
  const bz = Math.floor(p.z);
  const dx = Math.sign(target.x - bx);
  const dz = Math.sign(target.z - bz);
  const dy = target.y - by;

  // 候选顺序：目标在下方先往下挖；否则先横着靠近，最后再往下
  const cands = [];
  if (dy < 0) cands.push([0, -1, 0]);
  if (dx) cands.push([dx, 0, 0]);
  if (dz) cands.push([0, 0, dz]);
  cands.push([0, -1, 0]);

  for (const [ex, ey, ez] of cands) {
    ctx.checkAborted();
    require('./preparation').assertPreparationSearch({ actions, ctx, operation: '挖掘原料通道' });
    const x = bx + ex;
    const y = by + ey;
    const z = bz + ez;
    const b = blockAt(bot, x, y, z);
    if (!b) continue;
    if (!b.diggable || b.boundingBox !== 'block') continue;
    // 别挖到岩浆/水/基岩
    if (b.name === 'lava' || b.name === 'water' || b.name === 'bedrock') continue;
    const common = require('./common');
    if (ey < 0 ? !common.canDigDownSafely(bot, bx, by, bz) :
        !common.canOpenCellSafely(bot, x, y, z)) continue;
    try {
      // Keep the body on its support while opening a path. A drop-collection
      // path can otherwise walk into the newly opened cell before it is safe.
      await actions.dig({ x, y, z, signal: ctx.signal, collect: false, reach: false });
      return true;
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      log.info(`朝目标挖 (${x},${y},${z}) 失败：${err.message}`);
    }
  }
  return false;
}

/** 背包里耐久最多的镐子（没有则 null） */
function bestPickaxe(actions, minTier = 'wooden') {
  const bot = actions.bot;
  let best = null;
  let bestRemain = -1;
  for (const item of bot.inventory.items()) {
    if (!/_pickaxe$/.test(item.name)) continue;
    const tier = item.name.split('_')[0];
    const harvestTier = TIERS.indexOf(tier === 'golden' ? 'wooden' : tier);
    if (harvestTier < TIERS.indexOf(minTier)) continue;
    const remain = item.maxDurability ? item.maxDurability - (item.durabilityUsed || 0) : 9999;
    if (remain <= 0) continue;
    if (remain > bestRemain) {
      bestRemain = remain;
      best = item;
    }
  }
  return best ? { name: best.name, remain: bestRemain } : null;
}

/** Select a usable replacement from carried materials without mining dependencies. */
function carriedPickaxeTiers(actions, minTier = 'wooden', preferred = null) {
  // A worn wooden/golden pickaxe should upgrade to carried stone rather than
  // spend wood making another fragile pickaxe when a stone recipe is ready.
  if (preferred === 'wooden' || preferred === 'golden') preferred = null;
  const replacements = [preferred, 'stone', 'iron', 'diamond', 'wooden']
    .filter((tier, index, all) => tier && all.indexOf(tier) === index &&
      TIERS.indexOf(tier) >= TIERS.indexOf(minTier));
  return replacements.filter((tier) => {
    if (tier === 'stone') return ['cobblestone', 'cobbled_deepslate', 'blackstone']
      .some((name) => actions.countItem(name) >= 3);
    if (tier === 'wooden') return countPlanks(actions) >= 3 || totalLogs(actions) > 0;
    if (tier === 'iron') return ['iron_ingot', 'raw_iron', 'iron_ore', 'deepslate_iron_ore']
      .reduce((sum, name) => sum + actions.countItem(name), 0) >= 3;
    return tier === 'diamond' && actions.countItem('diamond') >= 3;
  }).sort((a, b) => Number(a === 'iron' && actions.countItem('iron_ingot') < 3) -
    Number(b === 'iron' && actions.countItem('iron_ingot') < 3));
}

function carriedPickaxeTier(actions, minTier = 'wooden', preferred = null) {
  return carriedPickaxeTiers(actions, minTier, preferred)[0] || null;
}

/** Replace a worn or broken pickaxe using only carried material and a real table. */
async function ensurePickaxeDurability({ actions, nav, state, ctx, need = 10, minTier = 'wooden' }) {
  const pick = bestPickaxe(actions, minTier);
  if (pick && pick.remain > need) return false;
  const tiers = carriedPickaxeTiers(actions, minTier, pick?.name.split('_')[0]);
  for (const tier of tiers) {
    try {
      ctx.checkAborted();
      ctx.progress(`${pick ? `镐子快坏了（剩 ${pick.remain}）` : '缺少可用镐'}，就地补一把 ${tier} 镐`);
      const r = await makeTools({
        actions,
        nav,
        state,
        ctx,
        tier,
        kinds: ['pickaxe'],
        allowSearch: false, // 不要为了做镐去满世界找树/挖矿，就地做
        forceReplace: true,
      });
      if (r && r.ok) {
        log.info(`已补做 ${tier} 镐${pick ? `（原 ${pick.name} 剩 ${pick.remain}）` : ''}`);
        return true;
      }
      if (r?.return_status?.ok === false) return false;
      log.info(`补做 ${tier} 镐没成功：${r && r.reason}`);
    } catch (err) {
      if (err instanceof CancelledError || ['PreparationBlockedError', 'ProtectedBlockError', 'ProtectedHomeError'].includes(err?.name)) throw err;
      log.info(`补做 ${tier} 镐失败：${err.message}`);
    }
  }
  return false;
}

async function mineSpecific({ actions, nav, state = null, ctx, blockNames, want, itemName = null, itemNames = null, radius = 40, maxAttempts = 40, allowSearch = true }) {
  const steps = [];
  // This helper also collects blocks such as obsidian. A stone replacement
  // cannot satisfy every target; use the installed version's harvest tools.
  let minTier = 'wooden';
  const data = actions.bot.registry?.blocksByName ? actions.bot.registry :
    (actions.bot.version ? require('minecraft-data')(actions.bot.version) : null);
  for (const name of blockNames) {
    const tiers = Object.keys(data?.blocksByName?.[name]?.harvestTools || {})
      .map((id) => data.items?.[id]?.name || '').filter((item) => item.endsWith('_pickaxe'))
      .map((item) => TIERS.indexOf(item.split('_')[0])).filter((index) => index >= 0);
    if (tiers.length) minTier = TIERS[Math.max(TIERS.indexOf(minTier), Math.min(...tiers))];
  }
  // **要数哪些物品**：早期只数 itemName 一个名字，导致"挖了 18 个石质方块却判定为
  // 一个都没挖到"——因为安山岩/闪长岩掉的是它们自己，不是圆石。
  // 现在支持传入多个可计数的产物名（石质方块各自的掉落物都算进度）。
  const counted = [...new Set(itemNames && itemNames.length ? itemNames : [itemName || blockNames[0]])];
  const target = counted.length === 1 ? counted[0] : counted.join('/');
  const have = () => counted.reduce((s, n) => s + actions.countItem(n), 0);
  const checkpoint = collectionCheckpoint(ctx,
    ['mineSpecific', [...blockNames].sort(), [...counted].sort(), want, radius, maxAttempts, allowSearch],
    { have, want, inventory: () => actions.inventoryMap() });
  if (checkpoint.result) return checkpoint.result;
  require('./preparation').assertPreparationSearch({ actions, ctx, operation: `采集 ${target}` });
  const before = checkpoint.before;
  const startHave = checkpoint.initialHave;

  const result = await driveUntil({
    have,
    want: startHave + want,
    ctx,
    checkpoint,
    maxAttempts,
    label: `挖${target}`,
    fetchOne: async (attempt) => {
      ctx.checkAborted();
      require('./preparation').assertPreparationSearch({ actions, ctx, operation: `采集 ${target}` });
      // 每轮检查一次镐子耐久：木镐只有 59 次，挖一组石头就会用掉几十次，
      // 等它碎了再补救就来不及（实测就是这样断掉整条链的）。够料就换成石镐。
      if (attempt > 1) {
        await ensurePickaxeDurability({ actions, nav, state, ctx, minTier });
      }
      const found = findNearestDiggable(actions, blockNames, radius);
      if (!found) {
        // allowSearch=false：只挖眼前能看到的，不四处找也不往下硬挖。
        // 用于"给定场景"的定向测试，避免在找不到目标时空挖几十秒。
        if (!allowSearch) return false;
        // 找不到就换地方找；挖矿时优先往下走（石头在下面）
        const moved = await relocate({ actions, nav, ctx, attempt });
        // **换地方继续找要算作"有进展"**，否则 driveUntil 会把它计成一次失败，
        // 连续 3 次就整体放弃。而地表（草地/泥土）到石头通常有 5~10 格，
        // 必须允许她挖好几轮才能碰到——早期这里返回 false，
        // 导致在丛林/森林地表**永远挖不到石头**，技能每次都报"连续多次没有进展"
        // （实测她在真实服务器里连续几十分钟重复这个失败）。
        return !!moved;
      }
      try {
        require('./preparation').assertPreparationSearch({ actions, ctx, operation: `采集 ${target}` });
        const r = await actions.dig({ x: found.x, y: found.y, z: found.z, signal: ctx.signal, collect: true, reach: true, safe: true });
        steps.push(`挖 ${r.block}`);
        return true;
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        if (err?.name === 'NoToolError' &&
            await ensurePickaxeDurability({ actions, nav, state, ctx, minTier })) return true;
        // **受保护方块必须往上抛**（与 mining.js 同一个理由）：
        // 白/黑名单与出生点保护是配置层面的拒绝，换个地方再挖 40 次也一样，
        // 吞掉它只会让技能报"附近没有找到足够的X"，把真正原因藏起来。
        if (['ProtectedBlockError', 'ProtectedHomeError', 'NoToolError'].includes(err?.name)) throw err;
        log.info(`挖 ${found.name} 失败：${err.message}`);
        // 够不到（典型情况：目标被埋在泥土/岩石下面，寻路走不过去）
        // → 朝目标挖一格，下一轮往往就能挖到了。这也是真玩家的做法。
        const toward = await digToward({ actions, ctx, target: found });
        return !!toward;
      }
    },
  });

  const after = actions.inventoryMap();
  const gained = have() - startHave;
  // 以"背包里真的多了这么多"为准，而不是以内部循环是否跑完为准。
  // 早期版本直接返回 result.reached，出现过"什么都没挖到却报成功"的假成功。
  const ok = gained >= want || (gained > 0 && result.reached);
  ctx.checkAborted();
  return (checkpoint.result = skillResult(ok, {
    steps,
    produced: positiveOnly(diffOf(before, after)),
    note: ok ? `已挖到 ${gained} 个 ${target}` : `只挖到 ${gained} 个 ${target}（目标 ${want}）`,
    reason: ok ? null : result.lastError || `附近没有找到足够的${target}（${blockNames.slice(0, 3).join('/')}…），可以换个方向、往下挖，或换一种材料`,
    extra: { item: target, gained, wanted: want },
  }));
}

/**
 * 这个方块"看得见"吗（中间没被别的方块挡住）。
 *
 * **为什么必须有这个检查**：早期只按距离选目标，于是她会**隔着墙挖**——
 * 玩家看到的是她对着墙猛敲、方块却在墙后面，非常不像人。
 * 真人只会挖自己看得见的方块（或者先把挡路的挖开）。
 *
 * 优先用 mineflayer 的 canSeeBlock（它做的是真正的射线检测）；
 * 拿不到就退化成"六个面里至少有一个是空气/透明"——那说明它至少露了一面。
 */
function canSeeBlock(bot, block) {
  try {
    if (typeof bot.canSeeBlock === 'function') {
      if (bot.canSeeBlock(block)) return true;
      // 射线检测可能因为方块中心被遮挡而失败（比如挖脚边的方块），
      // 这时再看有没有暴露的面作为兜底。
    }
  } catch {
    /* 退化到下面 */
  }
  try {
    const dirs = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    for (const [dx, dy, dz] of dirs) {
      const n = blockAt(bot, block.position.x + dx, block.position.y + dy, block.position.z + dz);
      if (!n) continue;
      if (n.boundingBox === 'empty' || n.name === 'air' || n.name === 'cave_air') return true;
    }
    return false;
  } catch {
    return true; // 判断不了就别拦（宁可让她挖，也不要因为探测失败而卡住）
  }
}

function findNearestDiggable(actions, names, radius) {
  const bot = actions.bot;
  const protection = require('./mining_return');
  const available = (block) => !!block?.position && !protection.isProtectedHomePosition(bot, block.position) &&
    canSeeBlock(bot, block) &&
    require('./common').canHarvestBlockSafely(bot, block.position);
  // Stone and cobblestone have the same requested drop. Prefer a natural stone
  // source before nearby built cobblestone; separate queries also stop the first
  // sixteen house blocks from hiding a slightly more distant stone outcrop.
  const groups = names.includes('stone') && names.includes('cobblestone')
    ? [['stone'], names.filter((name) => name !== 'stone')] : [names];
  for (const group of groups) {
    const want = new Set(group);
    const options = { matching: (b) => b && want.has(b.name) && b.diggable,
      // Mineflayer first matches positionless palette blocks, then reads the
      // real blocks for visibility and safety before applying the candidate cap.
      useExtraInfo: available, maxDistance: radius, count: 16 };
    let candidates = [];
    try { candidates = bot.findBlocks(options); }
    catch {
      const one = bot.findBlock(options);
      candidates = one ? [one.position] : [];
    }
    for (const pos of candidates) {
      // Recheck loaded blocks and the protected bounds even when a caller's
      // findBlocks implementation did not apply useExtraInfo.
      const check = blockAt(bot, pos.x, pos.y, pos.z);
      if (!check || !want.has(check.name) || !check.diggable || !available(check)) continue;
      return { x: check.position.x, y: check.position.y, z: check.position.z, name: check.name };
    }
  }
  return null;
}

/** 找不到目标时移动位置：以"往下挖"为主，偶尔横向探索 */
async function relocate({ actions, nav, ctx, attempt }) {
  require('./preparation').assertPreparationSearch({ actions, ctx, operation: '移动并探索原料' });
  const bot = actions.bot;
  // **只在每 5 次里游荡 1 次，其余全部往下挖。**
  // 原因：石头/矿石必然在地下；沙漠/沙岩/安山岩地带的地表根本看不到石头，
  // 横向游荡是纯浪费时间。实测：一半时间游荡时，沙漠里挖 196 秒只下降 7 格、
  // 一个圆石都没拿到，木镐还先挖坏了；而同一份代码在石头浅的地形 89 秒就挖到 28 个。
  if (attempt % 5 === 0) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 20 + Math.random() * 20;
    const tx = bot.entity.position.x + Math.cos(angle) * dist;
    const tz = bot.entity.position.z + Math.sin(angle) * dist;
    ctx.progress(`附近没有目标，向 (${tx.toFixed(0)}, ${tz.toFixed(0)}) 探索`);
    try {
      await nav.goTo({ x: tx, y: null, z: tz, range: 4, signal: ctx.signal, timeoutMs: 20000 });
      return true;
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      return false;
    }
  }

  // 往下挖：**挖成阶梯**，而不是竖井。
  //
  // 为什么必须是阶梯：竖井挖下去之后**爬不上来**——实测她挖到 y=54 后，
  // 后续"回地表砍树做工具"的任务直接失败（寻路爬不上 9 格垂直井，
  // 报"分段也没能走到…这一带地形可能把路堵死了"）。
  // 真人下矿也是挖阶梯，因为阶梯能原路走回来。
  // （延迟 require：mining.js 依赖 wood.js，顶部 require 会形成循环。）
  const { digDownStaircase } = require('./mining');
  const hereY = Math.floor(bot.entity.position.y);
  // **挖多深要看她在多高**：石头大致在 y=60 以下，
  // 站在山顶（实测 y=84）时挖 5 层根本碰不到石头，几轮之后就判定"没进展"放弃了。
  const layers = Math.max(4, Math.min(16, Math.ceil((hereY - 60) / 2)));
  const dug = await digDownStaircase({ actions, nav, ctx, steps: [], layers });
  if (dug) return true;

  // 阶梯挖不动时只允许逐层下降到已确认的实地，不能盲挖进洞穴或液体。
  let fell = 0;
  for (let i = 0; i < 4; i += 1) {
    ctx.checkAborted();
    require('./preparation').assertPreparationSearch({ actions, ctx, operation: '逐层下降寻找原料' });
    const p = bot.entity.position;
    const bx = Math.floor(p.x);
    const by = Math.floor(p.y);
    const bz = Math.floor(p.z);
    if (!canDigDownSafely(bot, bx, by, bz)) break;
    try {
      await actions.dig({ x: bx, y: by - 1, z: bz, signal: ctx.signal, collect: false });
      const deadline = Date.now() + 1500;
      while (Math.floor(bot.entity.position.y) === by && Date.now() < deadline) {
        ctx.checkAborted();
        await delay(50, { signal: ctx.signal });
      }
      if (Math.floor(bot.entity.position.y) !== by - 1) break;
      fell += 1;
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      break;
    }
  }
  return fell > 0;
}

// ---------------------------------------------------------------- 小工具

function diffOf(before, after) {
  const out = {};
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    const d = (after[k] || 0) - (before[k] || 0);
    if (d !== 0) out[k] = d;
  }
  return out;
}

function totalLogs(actions) {
  return LOG_NAMES.reduce((s, n) => s + actions.countItem(n), 0);
}

function findCraftingTable(actions) {
  if (typeof actions._findStationBlock === 'function') return actions._findStationBlock(['crafting_table']);
  const { executionContext } = require('../goals');
  const home = executionContext.getStore()?.indoorHome;
  const { isIndoorStation } = require('./preparation');
  return actions.bot.findBlock({ matching: (b) => b?.name === 'crafting_table',
    useExtraInfo: (b) => !home || isIndoorStation(b?.position, home), maxDistance: 24 });
}

function countPlanks(actions) {
  const map = actions.inventoryMap();
  return Object.entries(map)
    .filter(([n]) => n.endsWith('_planks'))
    .reduce((s, [, c]) => s + c, 0);
}

function hasTool(actions, name) {
  return actions.countItem(name) > 0;
}

function hasBetterPickaxe(actions, minTier) {
  return !!bestPickaxe(actions, minTier);
}

function tierMaterial(tier) {
  const map = {
    wooden: { planks: 3, stick: 2 },
    stone: { cobblestone: 3, stick: 2 },
    iron: { iron_ingot: 3, stick: 2 },
    diamond: { diamond: 3, stick: 2 },
  };
  return map[tier] || null;
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

module.exports = {
  chopTree,
  makePlanks,
  makeSticks,
  makeTools,
  ensureCraftingTable,
  mineSpecific,
  findLogBlock,
  wanderLookingFor,
  LOG_NAMES,
  planksOf,
  totalLogs,
  countPlanks,
  diffOf,
  findNearestDiggable,
  relocate,
  digToward,
  ensurePickaxeDurability,
  carriedPickaxeTier,
  bestPickaxe,
};
