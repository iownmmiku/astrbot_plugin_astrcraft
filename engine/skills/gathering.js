'use strict';
/**
 * 通用收集技能：mc_collect 的实现。
 *
 * 这是 LLM 最常用的技能——"弄点木头"、"弄 5 个圆石"都走这里。
 * 它的价值在于**不需要 LLM 知道配方**：给定物品名和数量，
 * 由这张依赖表自动决定是去挖、去砍、去合成还是去熔炼。
 *
 * 表里没有的物品会被诚实拒绝，而不是假装成功。
 */

const log = require('../log');
const { delay, CancelledError, TimeoutError, describeFailure, vec3, distance, blockCenter } = require('../util');
const { skillResult, positiveOnly, collectionCheckpoint } = require('./common');
const wood = require('./wood');
const mining = require('./mining');
const { assertPreparationSearch, isIndoorStation } = require('./preparation');

// Recipe wrappers must retain the physical return contract: having the target
// item in the pack does not mean that the body has safely left the mine.
function miningReturn(result) {
  return result?.return_status ? { return_status: result.return_status,
    collection_ok: result.collection_ok,
    ...(typeof result.material_collection_ok === 'boolean' ? { material_collection_ok: result.material_collection_ok } : {}) } : {};
}

function unsafeMiningReturn(result) {
  return result?.return_status?.ok === false;
}

/** 物品 → 获取方式。这是"配方知识"的压缩版，只覆盖生存前期真正常用的东西 */
const SOURCES = {
  // 木材
  oak_log: { type: 'chop', want: 1 },
  birch_log: { type: 'chop', want: 1 },
  spruce_log: { type: 'chop', want: 1 },
  jungle_log: { type: 'chop', want: 1 },
  acacia_log: { type: 'chop', want: 1 },
  dark_oak_log: { type: 'chop', want: 1 },
  stick: { type: 'craft', recipe: 'stick' },
  crafting_table: { type: 'craft', recipe: 'crafting_table' },
  furnace: { type: 'craft', recipe: 'furnace' },
  chest: { type: 'craft', recipe: 'chest' },
  torch: { type: 'craft', recipe: 'torch' },
  ladder: { type: 'craft', recipe: 'ladder' },
  bucket: { type: 'craft', recipe: 'bucket' },

  // 石头与矿物
  cobblestone: { type: 'mine', ore: 'stone' },
  stone: { type: 'smelt', from: 'cobblestone' },
  coal: { type: 'mine', ore: 'coal' },
  charcoal: { type: 'smelt', from: 'oak_log' },
  iron_ingot: { type: 'smelt', from: 'raw_iron' },
  gold_ingot: { type: 'smelt', from: 'raw_gold' },
  copper_ingot: { type: 'smelt', from: 'raw_copper' },
  raw_iron: { type: 'mine', ore: 'iron' },
  raw_gold: { type: 'mine', ore: 'gold' },
  raw_copper: { type: 'mine', ore: 'copper' },
  diamond: { type: 'mine', ore: 'diamond' },
  redstone: { type: 'mine', ore: 'redstone' },
  lapis_lazuli: { type: 'mine', ore: 'lapis' },
  emerald: { type: 'mine', ore: 'emerald' },
  quartz: { type: 'mine', ore: 'quartz' },

  // 直接挖的方块
  dirt: { type: 'mine', ore: 'dirt' },
  sand: { type: 'mine', ore: 'sand' },
  gravel: { type: 'mine', ore: 'gravel' },
  clay_ball: { type: 'mine', ore: 'clay' },
  glass: { type: 'smelt', from: 'sand' },
  obsidian: { type: 'mine', ore: 'obsidian' },

  // 食物
  bread: { type: 'craft', recipe: 'bread' },
  wheat: { type: 'mine', ore: 'wheat' },
  apple: { type: 'mine', ore: 'apple' },
  cooked_beef: { type: 'smelt', from: 'beef' },
  beef: { type: 'hunt', mob: 'cow' },
  cooked_porkchop: { type: 'smelt', from: 'porkchop' },
  porkchop: { type: 'hunt', mob: 'pig' },
  cooked_chicken: { type: 'smelt', from: 'chicken' },
  chicken: { type: 'hunt', mob: 'chicken' },
  cooked_mutton: { type: 'smelt', from: 'mutton' },
  mutton: { type: 'hunt', mob: 'sheep' },
  wool: { type: 'hunt', mob: 'sheep' },
  white_wool: { type: 'hunt', mob: 'sheep' },
  leather: { type: 'hunt', mob: 'cow' },
  feather: { type: 'hunt', mob: 'chicken' },
};

/** 方块直挖表：物品名 → 实际方块名列表 */
const BLOCK_ALIASES = {
  stone: ['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'andesite', 'granite', 'diorite', 'tuff'],
  dirt: ['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium'],
  sand: ['sand', 'red_sand'],
  gravel: ['gravel'],
  clay: ['clay'],
  obsidian: ['obsidian'],
  wheat: ['wheat'],
  apple: ['oak_leaves', 'dark_oak_leaves'],
};

/**
 * 通用收集入口。
 * @param {object} o
 * @param {string} o.item 目标物品
 * @param {number} o.count 数量
 */
async function collect(options) {
  const { executionContext } = require('../goals');
  const scope = executionContext.getStore() || {};
  const name = String(options.item || '').replace(/^minecraft:/, '').toLowerCase();
  const stack = scope.collectionStack || [];
  if (stack.includes(name) || stack.length >= 16) {
    return skillResult(false, { reason: `收集依赖重复或过深：${[...stack, name].join(' → ')}` });
  }
  return executionContext.run({ ...scope, collectionStack: [...stack, name] }, () => collectItem(options));
}

function countCollectedItem(actions, name) {
  return name === 'wool' ? Object.entries(actions.inventoryMap())
    .filter(([item]) => item.endsWith('_wool')).reduce((sum, [, n]) => sum + n, 0) : actions.countItem(name);
}

async function collectItem({ actions, nav, state, ctx, item, count = 1, autoDomain = true, maxAttempts = null }) {
  ctx.checkAborted();
  // **null 表示"不覆盖"**：委派给 chop_tree / mine_ores / mine_stone 时，
  // 让它们各自用自己的默认重试次数（那三个的默认值并不一样：24 / 40 / 30）。
  // 硬塞一个数字会悄悄改掉其中两条路的行为。
  const attempts = Number(maxAttempts) > 0 ? Number(maxAttempts) : undefined;
  const want = String(item || '').replace(/^minecraft:/, '').toLowerCase();
  const target = Math.max(1, Math.min(256, Number(count) || 1));
  const steps = [];

  if (wood.CROPS[want]) {
    // Crops always use surface search and verified replanting, including a
    // resumed harvest whose inventory target was reached before interruption.
    return wood.harvestCrops({ actions, nav, ctx, itemName: want, count: target,
      radius: 40, maxAttempts: attempts });
  }

  const haveTarget = () => countCollectedItem(actions, want);
  const checkpoint = collectionCheckpoint(ctx, ['collectItem', want, target, attempts || null],
    { have: haveTarget, want: Math.max(0, target - haveTarget()), inventory: () => actions.inventoryMap() });
  const before = checkpoint.before;
  const already = haveTarget();
  if (already >= target && !checkpoint.gather) {
    return skillResult(true, { steps, note: `背包里已经有 ${already} 个 ${want}，不需要再收集`, extra: { collection_ok: true } });
  }

  // 1) 先看是不是"某个配方可以直接做出来的"，先试便宜的路径
  const plan = checkpoint.gather?.plan || planFor({ actions, want, deficit: target - already });
  // collect's count is a total inventory target. Its direct gathering child
  // receives an additional amount, whose original value also identifies the
  // child's checkpoint and mine entrance. Keep that amount when replaying;
  // even a final accepted drop can precede cancellation and safe return.
  if (['chop', 'mine', 'mine_any'].includes(plan.type) && !checkpoint.gather) {
    checkpoint.gather = { plan: { ...plan }, want: target - already };
  }
  const gatherWant = checkpoint.gather?.want ?? target - already;

  ctx.progress(`收集 ${want}×${Math.max(0, target - already)}：计划走 ${plan.type}${plan.detail ? `（${plan.detail}）` : ''}`);

  let result;
  switch (plan.type) {
    case 'have':
      result = skillResult(true, { steps, note: `已有 ${already} 个 ${want}` });
      break;
    case 'chop':
      assertPreparationSearch({ actions, ctx, operation: '砍树收集木材' });
      result = await wood.chopTree({ actions, nav, state, ctx, want: gatherWant,
        logNames: [want], maxAttempts: attempts });
      steps.push(...result.steps);
      break;
    case 'mine': {
      assertPreparationSearch({ actions, ctx, operation: '挖掘原料' });
      const blockNames = BLOCK_ALIASES[plan.ore] || [plan.ore];
      result = mining.ORES[plan.ore]
        ? await mining.mineOre({ actions, nav, state, ctx, ore: plan.ore,
          want: gatherWant, maxAttempts: attempts })
        : want === 'cobblestone'
        ? await mining.mineStone({ actions, nav, state, ctx, want: gatherWant,
          strictOnly: true, radius: 40, maxAttempts: attempts })
        : await wood.mineSpecific({ actions, nav, ctx, blockNames, want: gatherWant, itemName: want, radius: 40, maxAttempts: attempts });
      ctx.checkAborted();
      steps.push(...result.steps);
      break;
    }
    case 'craft': {
      // 先确保中间材料
      const chain = await ensureCraftChain({ actions, nav, state, ctx, steps, item: plan.recipe, craftTimes: target - already });
      if (!chain.ok) {
        result = skillResult(false, { steps, reason: chain.reason, extra: miningReturn(chain) });
        break;
      }
      try {
        const r = await actions.craft({ item: plan.recipe, count: target - already, signal: ctx.signal });
        steps.push(`合成 ${plan.recipe}×${r.produced}`);
        // **按目标状态判，不看「调用没抛异常」**（和 makePlanks 那次修复同一个标准）。
        // craft 可以 ok:false（服务端忽略点击/材料不够时它正常返回），
        // 原来这里无条件 true → 上面那句 `ok = now >= target || result.ok` 就被内层 true
        // 盖过去了，**目标没到也报成功**。
        {
          const nowHave = actions.countItem(want);
          const reached = nowHave >= target;
          result = skillResult(reached, {
            steps,
            produced: { [plan.recipe]: r.produced },
            note: reached ? null : `只做出 ${r.produced} 个，现有 ${want}×${nowHave}（目标 ${target}）`,
            reason: reached ? null : `合成 ${plan.recipe} 没做到目标（现有 ${nowHave}/${target}）`,
            extra: miningReturn(chain),
          });
        }
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        // 合成失败时退回"收集原材料"（例如缺原木就先去砍树）
        const fallback = await collectFallbackMaterials({ actions, nav, state, ctx, steps, item: plan.recipe, count: target - already });
        result = fallback || skillResult(false, { steps, reason: `合成 ${plan.recipe} 失败：${describeFailure(err)}` });
      }
      break;
    }
    case 'smelt': {
      const variants = { iron_ingot: ['raw_iron', 'iron_ore', 'deepslate_iron_ore'],
        gold_ingot: ['raw_gold', 'gold_ore', 'deepslate_gold_ore'],
        copper_ingot: ['raw_copper', 'copper_ore', 'deepslate_copper_ore'],
        glass: ['sand', 'red_sand'],
        charcoal: wood.LOG_NAMES.filter((name) => name.endsWith('_log')) };
      const inputs = variants[want] || [plan.from];
      let metadata = {}, failure = null, unsafe = false;
      const processInput = async (from) => {
        const amount = Math.min(target - actions.countItem(want), actions.countItem(from));
        if (amount <= 0) return;
        const smelted = await mining.smeltOres({ actions, nav, state, ctx, item: from, count: amount });
        ctx.checkAborted(); steps.push(...smelted.steps);
        if (smelted.return_status) metadata = miningReturn(smelted);
        if (unsafeMiningReturn(smelted)) { unsafe = true; failure = smelted.reason; return; }
        // An unprocessed input is a furnace/fuel failure, not a reason to mine
        // duplicates. Keep actual products and let the next plan fix the cause.
        if (actions.countItem(want) < target && actions.countItem(from) > 0) {
          failure = smelted.reason || smelted.failed?.map((f) => f.error).join('；') || '已有原料尚未加工完';
        }
      };
      for (const from of inputs) {
        await processInput(from);
        if (unsafe || failure || actions.countItem(want) >= target) break;
      }
      if (!unsafe && !failure && actions.countItem(want) < target) {
        const rawNeeded = actions.countItem(plan.from) + target - actions.countItem(want);
        const gathered = await collect({ actions, nav, state, ctx, item: plan.from, count: rawNeeded });
        ctx.checkAborted(); steps.push(...gathered.steps);
        if (gathered.return_status) metadata = miningReturn(gathered);
        if (unsafeMiningReturn(gathered)) { unsafe = true; failure = gathered.reason; }
        else if (!gathered.ok && actions.countItem(plan.from) === 0) failure = gathered.reason;
        else await processInput(plan.from);
      }
      result = skillResult(!unsafe && actions.countItem(want) >= target,
        { reason: failure, extra: metadata });
      break;
    }
    case 'hunt': {
      result = await huntAnimal({ actions, nav, state, ctx, mob: plan.mob, want: target - already,
        targetItem: want, targetCount: target });
      steps.push(...result.steps);
      break;
    }
    case 'mine_any': {
      assertPreparationSearch({ actions, ctx, operation: '挖掘原料' });
      // 未知物品：尝试按方块名直接挖（很多物品名和方块名一致）
      result = await wood.mineSpecific({ actions, nav, ctx, blockNames: [want], want: gatherWant, itemName: want, radius: 40 });
      steps.push(...result.steps);
      break;
    }
    default:
      result = skillResult(false, {
        reason: `不知道该去哪里弄 ${want}。可以试试：mc_scan 看看附近有什么，或换一个我会做的目标（木头、石头、铁矿、食物）`,
      });
  }

  const after = actions.inventoryMap();
  ctx.checkAborted();
  const produced = positiveOnly(wood.diffOf(before, after));
  const now = haveTarget();
  const collectionOk = now >= target;
  const ok = collectionOk && !unsafeMiningReturn(result);
  return skillResult(ok, {
    steps: [...steps, ...(result && result.steps ? [] : [])],
    produced,
    consumed: positiveOnly(wood.diffOf(after, before)),
    note: `现有 ${want}×${now}${ok ? '' : `（目标 ${target}）`}`,
    reason: ok ? null : (result && result.reason) || `没能收集到足够的 ${want}`,
    extra: { item: want, have: now, wanted: target, inner: result && result.note,
      ...miningReturn(result), collection_ok: collectionOk },
  });
}

/** 决定怎么弄到这个物品 */
function planFor({ actions, want, deficit }) {
  const src = SOURCES[want];
  if (src) {
    if (src.type === 'chop') return { type: 'chop', detail: '砍树' };
    if (src.type === 'mine') return { type: 'mine', ore: src.ore, detail: `挖 ${src.ore}` };
    if (src.type === 'craft') return { type: 'craft', recipe: src.recipe, detail: `合成 ${src.recipe}` };
    if (src.type === 'smelt') return { type: 'smelt', from: src.from, detail: `熔炼 ${src.from}` };
    if (src.type === 'hunt') return { type: 'hunt', mob: src.mob, detail: `打猎 ${src.mob}` };
  }
  // 物品名以 _log 结尾 → 砍树
  if (/_log$|_stem$/.test(want)) return { type: 'chop', detail: '砍树' };
  if (/_planks$/.test(want)) return { type: 'craft', recipe: want, detail: `合成 ${want}` };
  if (/(_pickaxe|_axe|_shovel|_sword|_hoe|_helmet|_chestplate|_leggings|_boots)$/.test(want)) {
    return { type: 'craft', recipe: want, detail: `合成 ${want}` };
  }
  if (/_ore$|^raw_/.test(want)) return { type: 'mine_any', detail: `尝试挖 ${want}` };
  return { type: 'unknown' };
}

/** 合成前的依赖补齐：递归处理常见中间产物 */
async function ensureCraftChain({ actions, nav, state, ctx, steps, item, craftTimes = 1 }) {
  const name = String(item).replace(/^minecraft:/, '');
  const mcData = require('minecraft-data')(actions.bot.version);
  const itemData = mcData.itemsByName[name];
  if (!itemData) return { ok: false, reason: `游戏里没有叫 ${name} 的物品（检查一下名字）` };

  const recipes = actions.bot.recipesAll(itemData.id, null, true);
  if (!recipes || !recipes.length) return { ok: false, reason: `${name} 不能合成（只能通过挖掘/熔炼/交易获得）` };
  const inventory = actions.inventoryMap();
  const score = (recipe) => {
    const missing = actions._missingForRecipe(recipe, craftTimes, mcData);
    const derives = (name) => name === 'stick' ? wood.countPlanks(actions) >= 2 || wood.totalLogs(actions) > 0 :
      name.endsWith('_planks') && (inventory[`${name.slice(0, -7)}_log`] || inventory[`${name.slice(0, -7)}_stem`]);
    return [Number(missing.length > 0), missing.reduce((n, m) => n + (derives(m.name) ? 0 : m.need - m.have), 0),
      missing.reduce((n, m) => n + m.need - m.have, 0), Number(!isShapeless(recipe))];
  };
  const scores = new Map(recipes.map((recipe) => [recipe, score(recipe)]));
  recipes.sort((a, b) => { const x = scores.get(a), y = scores.get(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  });
  const recipe = recipes[0];

  // 检查每样材料，缺什么补什么
  const missing = actions._missingForRecipe(recipe, craftTimes, mcData);
  let returnMetadata = {};
  for (const m of missing) {
    ctx.checkAborted();
    const deficit = m.need - m.have;
    // 关键中间产物：木板与木棍，走专用技能（它们自己会处理"没原木就砍树"）
    if (m.name === 'stick') {
      const st = await wood.makeSticks({ actions, nav, state, ctx, want: deficit });
      ctx.checkAborted();
      steps.push(...st.steps);
      if (actions.countItem('stick') < m.need) return { ok: false, reason: st.reason || '木棍数量仍不足' };
      continue;
    }
    // 其它材料：递归收集
    const got = await collect({ actions, nav, state, ctx, item: m.name, count: m.need });
    ctx.checkAborted();
    steps.push(...got.steps);
    if (unsafeMiningReturn(got)) return { ok: false, reason: got.reason || got.return_status.reason, ...miningReturn(got) };
    if (got.return_status) returnMetadata = miningReturn(got);
    if (actions.countItem(m.name) < m.need) {
      return { ok: false, reason: `缺少 ${m.name}（需要 ${m.need}，只有 ${actions.countItem(m.name)}）：${got.reason || ''}` };
    }
  }
  return { ok: true, ...returnMetadata };
}

function isShapeless(recipe) {
  return !!(recipe && recipe.inShape === undefined);
}

/** 合成失败时的兜底：把配方里的基础材料都收一遍 */
async function collectFallbackMaterials({ actions, nav, state, ctx, steps, item, count }) {
  const mcData = require('minecraft-data')(actions.bot.version);
  const itemData = mcData.itemsByName[String(item).replace(/^minecraft:/, '')];
  if (!itemData) return null;
  const recipes = actions.bot.recipesAll(itemData.id, null, true);
  if (!recipes || !recipes.length) return null;
  const chain = await ensureCraftChain({ actions, nav, state, ctx, steps, item, craftTimes: count });
  if (!chain.ok) return skillResult(false, { steps, reason: chain.reason, extra: miningReturn(chain) });
  try {
    const r = await actions.craft({ item, count, signal: ctx.signal });
    steps.push(`合成 ${item}×${r.produced}`);
    // craft 可以正常返回但一个都没产出（服务端忽略点击时它返回 ok:false）
    // —— 一个都没做出来就不能报成功（和 makePlanks 那次修复同一个标准）
    if (!r.ok) {
      return skillResult(false, { steps, reason: `合成 ${item} 一个都没做出来（服务端可能没接受点击）` });
    }
    return skillResult(true, { steps, produced: { [item]: r.produced }, extra: miningReturn(chain) });
  } catch (err) {
    if (err instanceof CancelledError) throw err;
    ctx.checkAborted();
    return null;
  }
}

/** 打猎：找到动物、打死、捡肉 */
async function huntAnimal({ actions, nav, state, ctx, mob = 'cow', want = 1,
  targetItem = null, targetCount = want }) {
  assertPreparationSearch({ actions, ctx, operation: '外出打猎' });
  const steps = [];
  let kills = 0;
  const before = actions.inventoryMap();
  const reached = () => targetItem ? countCollectedItem(actions, targetItem) >= targetCount : kills >= want;

  for (let i = 0; i < want * 2 + 2 && !reached(); i += 1) {
    ctx.checkAborted();
    assertPreparationSearch({ actions, ctx, operation: '外出打猎' });
    const target = findAnimal(actions, mob);
    if (!target) {
      ctx.progress(`附近没有${mob}，换个地方找`);
      const moved = await wood.relocate({ actions, nav, ctx, attempt: i });
      if (!moved) break;
      continue;
    }
    try {
      ctx.progress(`攻击${mob}`);
      const r = await actions.attack({ target, signal: ctx.signal, maxAttacks: 30 });
      if (r.killed) {
        kills += 1;
        steps.push(`猎杀 ${mob}`);
        await delay(300, { signal: ctx.signal });
        await actions.collectDrops({ signal: ctx.signal, timeoutMs: 3000 });
      } else {
        log.debug(`打${mob}未成功：${r.reason}`);
        break;
      }
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      log.info(`打猎失败：${err.message}`);
      break;
    }
  }

  const after = actions.inventoryMap();
  ctx.checkAborted();
  const ok = reached();
  return skillResult(ok, {
    steps,
    produced: positiveOnly(wood.diffOf(before, after)),
    note: kills > 0 ? `猎杀 ${kills} 只${mob}` : `没有打到${mob}`,
    reason: ok ? null : targetItem ? `没有收集到足够的 ${targetItem}（现有 ${countCollectedItem(actions, targetItem)}/${targetCount}）` :
      `猎杀 ${kills}/${want} 只${mob}，附近没有足够的目标`,
  });
}

function findAnimal(actions, mob) {
  const bot = actions.bot;
  const me = bot.entity.position;
  let best = null;
  let bestD = Infinity;
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    if (!e || !e.position || e === bot.entity) continue;
    const name = String(e.name || e.displayName || '').replace(/^minecraft:/, '').toLowerCase();
    if (name !== mob) continue;
    const d = Math.hypot(e.position.x - me.x, e.position.y - me.y, e.position.z - me.z);
    if (d < bestD && d < 48) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

const STORAGE_NAMES = new Set(['chest', 'barrel', 'trapped_chest']);
const STORAGE_NEAR_DISTANCE = 32;
const STORAGE_MEMORY_DISTANCE = 128;
const STORAGE_MAX_CANDIDATES = 3;
const STORAGE_TRAVEL_MS = 20000;
const STORAGE_TRAVEL_STEP = 10;
const STORAGE_REACH = 4;

function storageSupplies(inventory) {
  return Object.keys(inventory).filter((name) =>
    /_(pickaxe|axe|shovel|sword|hoe|helmet|chestplate|leggings|boots|bed|door|bucket)$/.test(name) ||
    ['bow', 'crossbow', 'arrow', 'spectral_arrow', 'tipped_arrow', 'shield', 'trident', 'mace', 'elytra',
      'bucket', 'torch', 'soul_torch', 'lantern', 'soul_lantern', 'crafting_table', 'furnace',
      'coal', 'charcoal', 'dried_kelp_block', 'blaze_rod', 'stick', 'wheat',
      'flint_and_steel', 'shears', 'fishing_rod', 'compass', 'recovery_compass', 'totem_of_undying'].includes(name) ||
    READY_FOOD.includes(name) || Object.hasOwn(COOKABLE, name));
}

function rethrowStorageCancellation(err, actions, ctx) {
  if (err instanceof CancelledError || err?.name === 'CancelledError' || err?.name === 'AbortError') throw err;
  if (ctx.signal?.aborted || actions._stopped) throw new CancelledError('存东西被取消');
}

function storageBlock(bot, pos) {
  try { return bot.blockAt(vec3(pos.x, pos.y, pos.z)); }
  catch { return null; }
}

function storageWorld(bot) {
  const socket = bot?._client?.socket;
  return JSON.stringify([socket?.remoteAddress, socket?.remotePort, bot?.game?.dimension]);
}

function checkStorageContext(actions, ctx, world) {
  ctx.checkAborted();
  if (actions._stopped) throw new CancelledError('引擎已急停');
  if (storageWorld(actions.bot) !== world) throw new CancelledError('存东西期间世界已切换');
}

/** Travel in short, verified steps: Navigator's own segmented fallback extends its timeout. */
async function reachStorage({ actions, nav, ctx, position, deadline, world, reach = STORAGE_REACH }) {
  const bot = actions.bot;
  const center = blockCenter(position.x, position.y, position.z);
  for (let step = 0; step < 32; step += 1) {
    checkStorageContext(actions, ctx, world);
    const before = distance(bot.entity.position, center);
    if (before <= reach) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new TimeoutError('寻找记忆箱子的行走预算已用完');
    if (!nav || typeof nav.goTo !== 'function') throw new Error('没有可用的寻路器');
    const from = bot.entity.position;
    const horizontal = Math.hypot(position.x - from.x, position.z - from.z);
    const finalStep = horizontal <= STORAGE_TRAVEL_STEP;
    const ratio = finalStep ? 1 : STORAGE_TRAVEL_STEP / horizontal;
    await nav.goTo({
      x: from.x + (position.x - from.x) * ratio,
      y: finalStep ? position.y : null,
      z: from.z + (position.z - from.z) * ratio,
      range: 2, signal: ctx.signal, timeoutMs: remaining, segmented: false,
    });
    checkStorageContext(actions, ctx, world);
    if (Date.now() > deadline) throw new TimeoutError('寻找记忆箱子的行走预算已用完');
    const after = distance(bot.entity.position, center);
    if (after <= reach) return;
    if (finalStep || after >= before - 0.5) throw new Error('寻路返回后仍未实际走近箱子');
  }
  throw new Error('寻找记忆箱子的行走次数已用完');
}

/** Use a verified home when requested; otherwise prefer nearby and remembered containers. */
async function storeItems(options) {
  const { executionContext } = require('../goals');
  if (options.home === null || options.home === undefined) {
    return executionContext.run({ ...executionContext.getStore(), allowTerrainDig: false }, () => storeItemsInWorld(options));
  }
  // A respawn can replace the body or dimension during physical door crossing.
  // Cancel the complete home chain so its delayed actions cannot use the new world.
  const controller = new AbortController(), parentSignal = options.ctx.signal, bot = options.actions.bot;
  const cancel = () => controller.abort();
  if (parentSignal?.aborted) cancel();
  parentSignal?.addEventListener('abort', cancel, { once: true });
  for (const event of ['respawn', 'end']) bot.on?.(event, cancel);
  const ctx = Object.create(options.ctx);
  ctx.signal = controller.signal;
  try {
    return await executionContext.run({ ...executionContext.getStore(), signal: ctx.signal, allowTerrainDig: false },
      () => storeItemsInWorld({ ...options, ctx }));
  } finally {
    parentSignal?.removeEventListener('abort', cancel);
    for (const event of ['respawn', 'end']) bot.removeListener?.(event, cancel);
  }
}

async function storeItemsInWorld({ actions, nav, state, ctx, config = null, home = null, resumeWork = false, items = null, keep = null }) {
  ctx.checkAborted();
  if (actions._stopped) throw new CancelledError('引擎已急停');
  const steps = [];
  const bot = actions.bot;
  const world = storageWorld(bot);
  const supplies = keep !== null ? keep : items !== null ? [] : storageSupplies(actions.inventoryMap());
  const keepSet = new Set(supplies.map((name) => String(name).replace(/^minecraft:/, '')));
  const wanted = items !== null ? new Set(items.map((name) => String(name).replace(/^minecraft:/, ''))) : null;
  if (!Object.entries(actions.inventoryMap()).some(([name, count]) => count > 0 && !keepSet.has(name) && (!wanted || wanted.has(name)))) {
    return skillResult(false, { reason: '没有可存的物品，检查指定物品与保留清单' });
  }

  const origin = bot.entity.position.clone ? bot.entity.position.clone() : { ...bot.entity.position };
  const travelDeadline = Math.min(Date.now() + STORAGE_TRAVEL_MS, ctx.deadline || Infinity);
  const visited = new Set();
  const key = (pos) => `${pos.x},${pos.y},${pos.z}`;
  const failures = [];
  const remembered = actions.stations?.all().filter((entry) => STORAGE_NAMES.has(entry.kind) &&
    [entry.x, entry.y, entry.z].every(Number.isFinite) && distance(origin, entry) <= STORAGE_MEMORY_DISTANCE)
    .sort((a, b) => distance(origin, a) - distance(origin, b)) || [];
  let homeStatus = null;
  const homeContext = (scope) => {
    const child = typeof ctx.child === 'function' ? ctx.child(scope) : Object.create(ctx);
    child.deadline = travelDeadline;
    child.checkAborted = () => {
      checkStorageContext(actions, ctx, world);
      if (Date.now() > travelDeadline) throw new TimeoutError('回基地存物的寻找/行走预算已用完');
    };
    return child;
  };
  const inspectStorageHome = () => {
    checkStorageContext(actions, ctx, world);
    homeStatus = require('./building').inspectHome({ actions, state, config, home });
    return homeStatus;
  };
  if (home !== null) {
    try {
      const status = inspectStorageHome();
      if (status.condition === 'other_world') return skillResult(false, {
        reason: '存物基地属于其他服务器或维度', extra: { home, home_status: status },
      });
      if (status.distance > STORAGE_MEMORY_DISTANCE) return skillResult(false, {
        reason: '存物基地超过 128 格，当前不能走去存物', extra: { home, home_status: status },
      });
      // The entry route must share storage's budget, signal and world checks.
      // A child scope keeps any future dependency checkpoints separate.
      const entryCtx = homeContext('store_items:return_home');
      const returned = await require('./building').returnHome({ actions, nav, state, ctx: entryCtx, config, home,
        sleep: false, waitSeconds: 0, timeoutMs: Math.max(1, travelDeadline - Date.now()) });
      checkStorageContext(actions, ctx, world);
      const verified = inspectStorageHome();
      if (!returned.ok || !verified.safe) return skillResult(false, {
        steps, reason: returned.reason || '尚未进入完整基地并确认关门，不能在基地存物',
        extra: { home, home_status: verified },
      });
      if (Date.now() >= travelDeadline) return skillResult(false, {
        steps, reason: '回基地存物的寻找/行走预算已用完', extra: { home, home_status: verified },
      });
      steps.push('已进入基地并确认房屋完整、门已关闭');
    } catch (err) {
      rethrowStorageCancellation(err, actions, ctx);
      return skillResult(false, { steps, reason: `无法回基地存物：${describeFailure(err)}`,
        extra: { home, home_status: homeStatus } });
    }
  }

  const use = async (candidate, rememberedKind = null) => {
    visited.add(key(candidate));
    let storedAlready = null;
    try {
      ctx.progress(rememberedKind ? `回到记忆中的${rememberedKind}，到达后检查是否还在` : '走近附近的箱子或木桶');
      if (home !== null && distance(bot.entity.position, blockCenter(candidate.x, candidate.y, candidate.z)) > STORAGE_REACH) {
        // An elevated barrel is a target to reach, never a floor to stand on.
        const { isStableSupport, canOpenCellSafely } = require('./common');
        const standing = (point) => {
          const cell = { x: Math.floor(point.x), y: Math.floor(point.y), z: Math.floor(point.z) };
          return isStableSupport(storageBlock(bot, { ...cell, y: cell.y - 1 })) &&
            [0, 1].every((dy) => storageBlock(bot, { ...cell, y: cell.y + dy })?.boundingBox === 'empty' &&
              canOpenCellSafely(bot, cell.x, cell.y + dy, cell.z));
        };
        const landings = [];
        for (let dx = 1; dx < home.size - 1; dx += 1) for (let dz = 1; dz < home.size - 1; dz += 1) {
          const point = { x: home.origin.x + dx + 0.5, y: home.origin.y, z: home.origin.z + dz + 0.5 };
          if (standing(point) && distance(point, blockCenter(candidate.x, candidate.y, candidate.z)) <= STORAGE_REACH - 0.5) landings.push(point);
        }
        landings.sort((a, b) => distance(bot.entity.position, a) - distance(bot.entity.position, b));
        if (!landings.length) throw new Error('屋内容器附近没有安全落脚点');
        const remaining = travelDeadline - Date.now();
        if (remaining <= 0) throw new TimeoutError('寻找基地容器的行走预算已用完');
        await nav.goTo({ ...landings[0], range: 0.5, timeoutMs: remaining, segmented: false, signal: ctx.signal });
        checkStorageContext(actions, ctx, world);
        if (Date.now() >= travelDeadline) throw new TimeoutError('寻找基地容器的行走预算已用完');
        if (distance(bot.entity.position, blockCenter(candidate.x, candidate.y, candidate.z)) > STORAGE_REACH ||
            !standing(bot.entity.position)) throw new Error('尚未实际走到屋内容器附近的安全落脚点');
      } else {
        await reachStorage({ actions, nav, ctx, position: candidate, deadline: travelDeadline, world });
      }
      checkStorageContext(actions, ctx, world);
      if (home !== null && !inspectStorageHome().safe) throw new Error('存物前已不在关门且完整的基地内');
      const actual = storageBlock(bot, candidate);
      if (!actual) {
        failures.push(`(${key(candidate)}) 地形仍未加载，保留容器记忆`);
        return null;
      }
      if (!STORAGE_NAMES.has(actual.name)) {
        // A distant or unloaded lookup cannot prove that a remembered chest was removed.
        if (actions.stations) for (const memory of remembered.filter((entry) => key(entry) === key(candidate))) {
          actions.stations.forget(memory.kind, candidate);
        }
        steps.push(`到达 (${key(candidate)}) 后确认容器已不在`);
        return null;
      }
      // returnHome may have just discovered furniture; normalize its kind too.
      if (actions.stations) for (const memory of actions.stations.all().filter((entry) =>
        STORAGE_NAMES.has(entry.kind) && key(entry) === key(candidate) && entry.kind !== actual.name)) {
        actions.stations.forget(memory.kind, candidate);
      }
      if (actions.stations) actions.stations.remember(actual.name, actual.position || candidate);
      // reachStorage already verified the distance; opening must not start another walk.
      const r = await actions.deposit({ ...candidate, items, keep: supplies, signal: ctx.signal, reach: false });
      const stored = positiveOnly(r.stored || {});
      const total = Object.values(stored).reduce((sum, count) => sum + count, 0);
      if (total) storedAlready = stored;
      checkStorageContext(actions, ctx, world);
      if (!total) {
        failures.push(`(${key(candidate)}) 没有存入任何物品，容器可能已满或转移未被接受`);
        return null;
      }
      steps.push(`存入 ${Object.keys(stored).length} 种物品`);
      const safe = home === null || inspectStorageHome().safe;
      let left = null;
      if (safe && home !== null && resumeWork) {
        left = await require('./building').leaveHome({ actions, nav, state, ctx: homeContext('store_items:leave_home'),
          config, home, timeoutMs: Math.max(1, travelDeadline - Date.now()) });
        checkStorageContext(actions, ctx, world);
        homeStatus = left.home_status || inspectStorageHome();
        if (left.ok) steps.push('已实际出门并确认基地门已关闭，准备继续工作');
      }
      return skillResult(safe && (!left || left.ok), {
        steps, consumed: stored,
        note: `已把 ${total} 个物品存进${actual.name} (${candidate.x}, ${candidate.y}, ${candidate.z})：${Object.entries(stored).map(([name, count]) => `${name}×${count}`).join('、')}`,
        reason: !safe ? '物品已存入，但存物后基地不再安全' : left && !left.ok ?
          `物品已存入，但无法安全出门继续工作：${left.reason || '未确认出门关门'}` : null,
        extra: { chest: { x: candidate.x, y: candidate.y, z: candidate.z },
          ...(home !== null ? { home, home_status: homeStatus, resumed_work: !!left?.ok, left_home: !!left?.ok } : {}) },
      });
    } catch (err) {
      rethrowStorageCancellation(err, actions, ctx);
      if (storedAlready) return skillResult(false, { steps, consumed: storedAlready,
        reason: `物品已存入，但尚未确认基地安全或恢复工作：${describeFailure(err)}`,
        extra: { chest: { x: candidate.x, y: candidate.y, z: candidate.z },
          ...(home !== null ? { home, home_status: homeStatus, resumed_work: false, left_home: false } : {}) },
      });
      failures.push(`(${key(candidate)}) 存东西失败：${describeFailure(err)}`);
      return null;
    }
  };

  if (home !== null) {
    // Read the actual interior; a nearby outside container cannot stand in for home storage.
    const candidates = [];
    let unknown = false;
    for (let dx = 1; dx < home.size - 1; dx += 1) for (let dz = 1; dz < home.size - 1; dz += 1) {
      for (let dy = 0; dy < home.wall_height; dy += 1) {
        const position = { x: home.origin.x + dx, y: home.origin.y + dy, z: home.origin.z + dz };
        const block = storageBlock(bot, position);
        if (!block) unknown = true;
        if (STORAGE_NAMES.has(block?.name) && distance(origin, position) <= STORAGE_MEMORY_DISTANCE) candidates.push(position);
      }
    }
    if (unknown) return skillResult(false, { steps, reason: '基地屋内仍有未加载地形，暂不能完整检查存物容器',
      extra: { home, home_status: homeStatus } });
    const preferred = homeStatus.furniture.chest_position;
    candidates.sort((a, b) => Number(key(b) === key(preferred || {})) - Number(key(a) === key(preferred || {})) ||
      distance(bot.entity.position, a) - distance(bot.entity.position, b));
    for (const position of candidates.slice(0, STORAGE_MAX_CANDIDATES)) {
      checkStorageContext(actions, ctx, world);
      if (Date.now() >= travelDeadline) break;
      const result = await use(position);
      if (result) return result;
    }
    return skillResult(false, { steps,
      reason: failures.join('；') || (Date.now() >= travelDeadline ? '寻找基地箱子的行走预算已用完' :
        '基地内没有确认到真实箱子或木桶，保留基地与容器记录，不能完成回家存物'),
      extra: { home, home_status: homeStatus },
    });
  }

  for (let attempt = 0; attempt < STORAGE_MAX_CANDIDATES; attempt += 1) {
    ctx.checkAborted();
    // Palette matching receives only type/name, not the real block position.
    const nearby = bot.findBlock({ matching: (block) => block && STORAGE_NAMES.has(block.name),
      useExtraInfo: (block) => block?.position && !visited.has(key(block.position)), maxDistance: STORAGE_NEAR_DISTANCE });
    if (!nearby?.position) break;
    const result = await use(nearby.position);
    if (result) return result;
    if (Date.now() >= travelDeadline) break;
  }
  for (const entry of remembered.filter((candidate) => !visited.has(key(candidate))).slice(0, STORAGE_MAX_CANDIDATES)) {
    ctx.checkAborted();
    if (Date.now() >= travelDeadline) break;
    const result = await use({ x: entry.x, y: entry.y, z: entry.z }, entry.kind);
    if (result) return result;
  }
  // An unreachable, unloaded or full container is not a reason to endlessly make new ones.
  if (failures.length) return skillResult(false, { steps, reason: failures.join('；') });
  if (Date.now() >= travelDeadline) return skillResult(false, { steps, reason: '寻找箱子的行走预算已用完' });

  let chest;
  {
    ctx.progress('没有找到箱子，试着做一个');
    if (actions.countItem('chest') === 0) {
      try {
        const buildCtx = homeContext('store_items:make_chest');
        buildCtx.checkAborted();
        let table = typeof actions._findStationBlock === 'function' ? actions._findStationBlock(['crafting_table']) :
          bot.findBlock({ matching: (block) => block?.name === 'crafting_table', maxDistance: 24 });
        // Remembered stations share storage's finite walking budget. Unknown or
        // inaccessible records cannot justify making another workstation.
        if (!table) {
          const memories = actions.stations?.all().filter((entry) => entry.kind === 'crafting_table' &&
            [entry.x, entry.y, entry.z].every(Number.isFinite) && distance(bot.entity.position, entry) <= STORAGE_MEMORY_DISTANCE)
            .sort((a, b) => distance(bot.entity.position, a) - distance(bot.entity.position, b)) || [];
          for (const memory of memories.slice(0, STORAGE_MAX_CANDIDATES)) {
            await reachStorage({ actions, nav, ctx: buildCtx, position: memory, deadline: travelDeadline, world, reach: 2.5 });
            buildCtx.checkAborted();
            const actual = storageBlock(bot, memory);
            if (!actual) return skillResult(false, { steps, reason: '记忆中的工作台仍未加载，保留记录，暂不能制造箱子' });
            if (actual.name === 'crafting_table') { table = actual; break; }
            actions.stations.forget('crafting_table', memory);
          }
        }
        const tableWood = table || actions.countItem('crafting_table') > 0 ? 0 : 4;
        const neededPlanks = 8 + tableWood;
        if (wood.countPlanks(actions) + wood.totalLogs(actions) * 4 < neededPlanks) {
          return skillResult(false, { steps, reason: `制造箱子${tableWood ? '和缺少的工作台' : ''}需要 ${neededPlanks} 个木板，现有木材不足；本次仅使用随身材料` });
        }
        if (wood.countPlanks(actions) < neededPlanks) {
          const pk = await wood.makePlanks({ actions, ctx: buildCtx, want: neededPlanks - wood.countPlanks(actions) });
          buildCtx.checkAborted();
          steps.push(...pk.steps);
          if (!pk.ok) return skillResult(false, { steps, reason: `做箱子材料不足：${pk.reason}` });
        }
        if (table) {
          // Keep Actions.craft within native table reach so it cannot start a
          // second walk with a fresh timeout after this bounded preparation.
          await reachStorage({ actions, nav, ctx: buildCtx, position: table.position, deadline: travelDeadline, world, reach: 2.5 });
          buildCtx.checkAborted();
          if (storageBlock(bot, table.position)?.name !== 'crafting_table') {
            return skillResult(false, { steps, reason: '走近后没有确认到实际工作台，不能制造箱子' });
          }
        } else {
          if (!actions.countItem('crafting_table')) {
            const made = await actions.craft({ item: 'crafting_table', count: 1, signal: buildCtx.signal });
            buildCtx.checkAborted();
            if (!made.ok || !actions.countItem('crafting_table')) return skillResult(false, { steps, reason: '制造箱子的工作台没有实际产出' });
            steps.push('合成工作台');
          }
          const tablePos = actions._spotInFront();
          if (!tablePos) return skillResult(false, { steps, reason: '缺少安全位置放置制造箱子的工作台' });
          await actions.place({ ...tablePos, item: 'crafting_table', signal: buildCtx.signal, reach: true });
          buildCtx.checkAborted();
          if (storageBlock(bot, tablePos)?.name !== 'crafting_table') return skillResult(false, { steps, reason: '放置后没有确认到实际工作台，不能制造箱子' });
          steps.push('放置工作台');
          await reachStorage({ actions, nav, ctx: buildCtx, position: tablePos, deadline: travelDeadline, world, reach: 2.5 });
          buildCtx.checkAborted();
          if (storageBlock(bot, tablePos)?.name !== 'crafting_table') return skillResult(false, { steps, reason: '走近后没有确认到实际工作台，不能制造箱子' });
        }
        const chestR = await actions.craft({ item: 'chest', count: 1, signal: buildCtx.signal });
        buildCtx.checkAborted();
        if (!chestR.ok) return skillResult(false, { steps, reason: '合成箱子失败：一个箱子都没做出来（服务端可能没接受点击）' });

        steps.push('合成箱子');
      } catch (err) {
        rethrowStorageCancellation(err, actions, ctx);
        return skillResult(false, { steps, reason: `合成箱子失败：${describeFailure(err)}` });
      }
    }
    const pos = actions._spotInFront();
    if (!pos) return skillResult(false, { steps, reason: '身边没有可放箱子的位置' });
    try {
      await actions.place({ x: pos.x, y: pos.y, z: pos.z, item: 'chest', signal: ctx.signal, reach: true });
      checkStorageContext(actions, ctx, world);
      steps.push('放置箱子');
      chest = bot.blockAt(vec3(pos.x, pos.y, pos.z));
    } catch (err) {
      rethrowStorageCancellation(err, actions, ctx);
      return skillResult(false, { steps, reason: `放置箱子失败：${describeFailure(err)}` });
    }
  }
  checkStorageContext(actions, ctx, world);
  if (!chest?.position || !STORAGE_NAMES.has(chest.name)) return skillResult(false, { steps, reason: '放置后没有确认到真实箱子' });
  const result = await use(chest.position);
  return result || skillResult(false, { steps, reason: failures.join('；') || '没有存入任何物品' });
}

const READY_FOOD = [
  'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit', 'cooked_cod', 'cooked_salmon',
  'bread', 'apple', 'carrot', 'baked_potato', 'golden_carrot', 'golden_apple', 'enchanted_golden_apple',
  'rabbit_stew', 'mushroom_stew', 'beetroot_soup', 'pumpkin_pie', 'cookie', 'melon_slice', 'sweet_berries',
  'glow_berries', 'dried_kelp', 'beetroot',
];
const COOKABLE = { beef: 'cooked_beef', porkchop: 'cooked_porkchop', chicken: 'cooked_chicken',
  mutton: 'cooked_mutton', rabbit: 'cooked_rabbit', cod: 'cooked_cod', salmon: 'cooked_salmon',
  potato: 'baked_potato', kelp: 'dried_kelp' };

/**
 * 弄点吃的：先利用现有小麦与生食，再逐只猎取附近可见动物。
 */
async function cookFood({ actions, nav, state, ctx, count = 4 }) {
  ctx.checkAborted();
  const steps = [];
  const failures = [];
  let unsafeReturn = null;
  const before = actions.inventoryMap();

  const haveFood = () => READY_FOOD.reduce((n, name) => n + actions.countItem(name), 0);
  const cookedHave = haveFood();
  if (cookedHave >= count) {
    return skillResult(true, { steps, note: `已经有 ${cookedHave} 份熟食，够吃了` });
  }

  // 先用背包里已有的原料：小麦比重新打猎和生炉子便宜。
  if (actions.countItem('wheat') >= 3) {
    try {
      const indoorHome = require('../goals').executionContext.getStore()?.indoorHome;
      const nearbyTable = typeof actions._findStationBlock === 'function' ? actions._findStationBlock(['crafting_table']) :
        actions.bot.findBlock({ matching: (b) => b && b.name === 'crafting_table', maxDistance: 24,
          useExtraInfo: (b) => !indoorHome || isIndoorStation(b.position, indoorHome) });
      if (!nearbyTable) {
        if (!actions.countItem('crafting_table') && wood.countPlanks(actions) < 4 && wood.totalLogs(actions) === 0) {
          assertPreparationSearch({ actions, ctx, operation: '砍树准备工作台' });
          ctx.progress('做面包缺工作台，先就近取一根木头');
          const logs = await wood.chopTree({ actions, nav, state, ctx, want: 1, radius: 24, maxAttempts: 4 });
          steps.push(...logs.steps);
          if (!logs.ok) throw new Error(logs.reason || '没有做工作台的木材');
        }
        const table = await wood.ensureCraftingTable({ actions, ctx, steps });
        if (!table.ok) throw new Error(table.reason || '工作台没准备好');
      }
      const breadR = await actions.craft({ item: 'bread', count: Math.min(count - haveFood(), Math.floor(actions.countItem('wheat') / 3)), signal: ctx.signal });
      ctx.checkAborted();
      if (breadR.ok) { steps.push('烤面包'); } else {
        log.info('烤面包没做出来（craft 返回 ok=false）'); failures.push('合成面包未实际产出');
      }
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      ctx.checkAborted();
      log.info(`做面包失败：${err.message}`);
      failures.push(`做面包失败：${describeFailure(err)}`);
    }
  }

  const cookExisting = async () => {
    for (const raw of Object.keys(COOKABLE)) {
      ctx.checkAborted();
      const needed = count - haveFood();
      if (needed <= 0) break;
      if (actions.countItem(raw) <= 0) continue;
      const sm = await mining.smeltOres({ actions, nav, state, ctx, item: raw, count: Math.min(needed, actions.countItem(raw)) });
      ctx.checkAborted();
      steps.push(...sm.steps);
      if (unsafeMiningReturn(sm)) { unsafeReturn = sm; return; }
      if (!sm.ok) { const reason = sm.reason || `无法烹饪 ${raw}`; steps.push(reason); failures.push(reason); }
    }
  };
  await cookExisting();

  // 只追踪当前看得见的动物，逐只补齐；别为不存在的牛、猪各绕一整圈。
  for (let i = 0; !unsafeReturn && i < count && haveFood() < count; i += 1) {
    ctx.checkAborted();
    const preparation = require('../goals').executionContext.getStore();
    if (preparation?.indoorHome || preparation?.allowOutdoorSearch === false) break;
    const candidates = ['cow', 'pig', 'sheep', 'chicken', 'rabbit'].map((mob) => ({ mob, entity: findAnimal(actions, mob) }))
      .filter((t) => t.entity).sort((a, b) => a.entity.position.distanceTo(actions.bot.entity.position) - b.entity.position.distanceTo(actions.bot.entity.position));
    if (!candidates.length || actions.bot.health <= 8) break;
    assertPreparationSearch({ actions, ctx, operation: '外出打猎补食物' });
    const r = await huntAnimal({ actions, nav, state, ctx, mob: candidates[0].mob, want: 1 });
    steps.push(...r.steps);
    if (!r.ok) break;
    await cookExisting();
  }

  const after = actions.inventoryMap();
  ctx.checkAborted();
  const produced = positiveOnly(wood.diffOf(before, after));
  const foodNow = haveFood();
  const ok = !unsafeReturn && (foodNow >= count || READY_FOOD.some((n) => produced[n] > 0));
  return skillResult(ok, {
    steps,
    produced,
    consumed: positiveOnly(wood.diffOf(after, before)),
    note: `现在有 ${foodNow} 份食物`,
    reason: ok ? null : unsafeReturn?.reason || failures.join('；') || '没有补充到可吃的食物；先检查熔炉/燃料，或寻找动物和农作物，避免原地重复做饭',
    extra: miningReturn(unsafeReturn),
  });
}

module.exports = { collect, storeItems, cookFood, huntAnimal, SOURCES, READY_FOOD };
