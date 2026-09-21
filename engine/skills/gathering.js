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
const { delay, CancelledError, describeFailure } = require('../util');
const { skillResult, positiveOnly } = require('./common');
const wood = require('./wood');
const mining = require('./mining');

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
  stone: { type: 'mine', ore: 'stone' },
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
async function collect({ actions, nav, state, ctx, item, count = 1, autoDomain = true, maxAttempts = null }) {
  // **null 表示"不覆盖"**：委派给 chop_tree / mine_ores / mine_stone 时，
  // 让它们各自用自己的默认重试次数（那三个的默认值并不一样：24 / 40 / 30）。
  // 硬塞一个数字会悄悄改掉其中两条路的行为。
  const attempts = Number(maxAttempts) > 0 ? Number(maxAttempts) : undefined;
  const want = String(item || '').replace(/^minecraft:/, '').toLowerCase();
  const target = Math.max(1, Math.min(256, Number(count) || 1));
  const steps = [];
  const before = actions.inventoryMap();

  const already = actions.countItem(want);
  if (already >= target) {
    return skillResult(true, { steps, note: `背包里已经有 ${already} 个 ${want}，不需要再收集` });
  }

  // 1) 先看是不是"某个配方可以直接做出来的"，先试便宜的路径
  const plan = planFor({ actions, want, deficit: target - already });

  ctx.progress(`收集 ${want}×${target - already}：计划走 ${plan.type}${plan.detail ? `（${plan.detail}）` : ''}`);

  let result;
  switch (plan.type) {
    case 'have':
      result = skillResult(true, { steps, note: `已有 ${already} 个 ${want}` });
      break;
    case 'chop':
      result = await wood.chopTree({ actions, nav, state, ctx, want: (target - already) * 2, maxAttempts: attempts });
      steps.push(...result.steps);
      break;
    case 'mine': {
      const blockNames = BLOCK_ALIASES[plan.ore] || [plan.ore];
      result = await wood.mineSpecific({ actions, nav, ctx, blockNames, want: target - already, itemName: want, radius: 40, maxAttempts: attempts });
      steps.push(...result.steps);
      if (!result.ok && plan.type === 'mine' && mining.ORES[plan.ore]) {
        // 普通挖掘失败时退回完整挖矿流程（带工具依赖与下挖）
        const r2 = await mining.mineOre({ actions, nav, state, ctx, ore: plan.ore, want: target - already, maxAttempts: attempts });
        steps.push(...r2.steps);
        result = r2;
      }
      break;
    }
    case 'craft': {
      // 先确保中间材料
      const chain = await ensureCraftChain({ actions, nav, state, ctx, steps, item: plan.recipe, craftTimes: target - already });
      if (!chain.ok) {
        result = skillResult(false, { steps, reason: chain.reason });
        break;
      }
      try {
        const r = await actions.craft({ item: plan.recipe, count: target - already, signal: ctx.signal });
        steps.push(`合成 ${plan.recipe}×${r.produced}`);
        result = skillResult(true, { steps, produced: { [plan.recipe]: r.produced } });
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        // 合成失败时退回"收集原材料"（例如缺原木就先去砍树）
        const fallback = await collectFallbackMaterials({ actions, nav, state, ctx, steps, item: plan.recipe, count: target - already });
        result = fallback || skillResult(false, { steps, reason: `合成 ${plan.recipe} 失败：${describeFailure(err)}` });
      }
      break;
    }
    case 'smelt': {
      // 先搞到原料
      const rawNeeded = (target - already) * (plan.ratio || 1);
      const rawHave = actions.countItem(plan.from);
      if (rawHave < rawNeeded) {
        const got = await collect({ actions, nav, state, ctx, item: plan.from, count: rawNeeded - rawHave });
        steps.push(...got.steps);
        if (!got.ok && actions.countItem(plan.from) < rawNeeded) {
          result = skillResult(false, { steps, reason: `没有足够的${plan.from}来熔炼：${got.reason}` });
          break;
        }
      }
      result = await mining.smeltOres({ actions, nav, state, ctx, item: plan.from, count: rawNeeded });
      steps.push(...result.steps);
      break;
    }
    case 'hunt': {
      result = await huntAnimal({ actions, nav, state, ctx, mob: plan.mob, want: target - already });
      steps.push(...result.steps);
      break;
    }
    case 'mine_any': {
      // 未知物品：尝试按方块名直接挖（很多物品名和方块名一致）
      result = await wood.mineSpecific({ actions, nav, ctx, blockNames: [want], want: target - already, itemName: want, radius: 40 });
      steps.push(...result.steps);
      break;
    }
    default:
      result = skillResult(false, {
        reason: `不知道该去哪里弄 ${want}。可以试试：mc_scan 看看附近有什么，或换一个我会做的目标（木头、石头、铁矿、食物）`,
      });
  }

  const after = actions.inventoryMap();
  const produced = positiveOnly(wood.diffOf(before, after));
  const now = actions.countItem(want);
  const ok = now >= target || (result && result.ok);
  return skillResult(ok, {
    steps: [...steps, ...(result && result.steps ? [] : [])],
    produced,
    note: `现有 ${want}×${now}${ok ? '' : `（目标 ${target}）`}`,
    reason: ok ? null : (result && result.reason) || `没能收集到足够的 ${want}`,
    extra: { item: want, have: now, wanted: target, inner: result && result.note },
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
  recipes.sort((a, b) => Number(!isShapeless(a)) - Number(!isShapeless(b)));
  const recipe = recipes[0];

  // 检查每样材料，缺什么补什么
  const missing = actions._missingForRecipe(recipe, craftTimes, mcData);
  for (const m of missing) {
    ctx.checkAborted();
    const deficit = m.need - m.have;
    // 关键中间产物：木板与木棍，走专用技能（它们自己会处理"没原木就砍树"）
    if (m.name.endsWith('_planks')) {
      const pk = await wood.makePlanks({ actions, ctx, want: m.need });
      steps.push(...pk.steps);
      if (!pk.ok) return { ok: false, reason: pk.reason };
      continue;
    }
    if (m.name === 'stick') {
      const st = await wood.makeSticks({ actions, ctx, want: m.need });
      steps.push(...st.steps);
      if (!st.ok) return { ok: false, reason: st.reason };
      continue;
    }
    if (m.name.endsWith('_log') || m.name.endsWith('_stem')) {
      const chop = await wood.chopTree({ actions, nav, state, ctx, want: deficit + 2 });
      steps.push(...chop.steps);
      if (!chop.ok && wood.totalLogs(actions) < deficit) return { ok: false, reason: `需要原木，但砍树失败：${chop.reason}` };
      continue;
    }
    if (m.name === 'cobblestone' || m.name === 'stone') {
      const st = await mining.mineStone({ actions, nav, state, ctx, want: deficit });
      steps.push(...st.steps);
      if (actions.countItem('cobblestone') < deficit) return { ok: false, reason: `需要圆石，但挖矿失败：${st.reason}` };
      continue;
    }
    if (m.name === 'iron_ingot' || m.name === 'gold_ingot' || m.name === 'copper_ingot') {
      const oreName = { iron_ingot: 'iron', gold_ingot: 'gold', copper_ingot: 'copper' }[m.name];
      const r = await mining.mineOre({ actions, nav, state, ctx, ore: oreName, want: deficit + 2 });
      steps.push(...r.steps);
      if (!r.ok) return { ok: false, reason: r.reason };
      continue;
    }
    // 其它材料：递归收集
    const got = await collect({ actions, nav, state, ctx, item: m.name, count: deficit });
    steps.push(...got.steps);
    if (!got.ok && actions.countItem(m.name) < deficit) {
      return { ok: false, reason: `缺少 ${m.name}（需要 ${m.need}，只有 ${actions.countItem(m.name)}）：${got.reason || ''}` };
    }
  }
  return { ok: true };
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
  if (!chain.ok) return skillResult(false, { steps, reason: chain.reason });
  try {
    const r = await actions.craft({ item, count, signal: ctx.signal });
    steps.push(`合成 ${item}×${r.produced}`);
    return skillResult(true, { steps, produced: { [item]: r.produced } });
  } catch (err) {
    return null;
  }
}

/** 打猎：找到动物、打死、捡肉 */
async function huntAnimal({ actions, nav, state, ctx, mob = 'cow', want = 1 }) {
  const steps = [];
  let kills = 0;
  const before = actions.inventoryMap();
  const dropsOf = { cow: 'beef', pig: 'porkchop', chicken: 'chicken', sheep: 'mutton', rabbit: 'rabbit' };
  const dropName = dropsOf[mob] || mob;

  for (let i = 0; i < want * 2 + 2 && kills < want; i += 1) {
    ctx.checkAborted();
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
        await delay(300, { signal: ctx.signal });
        await actions.collectDrops({ signal: ctx.signal, timeoutMs: 3000 });
      } else {
        log.debug(`打${mob}未成功：${r.reason}`);
        break;
      }
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      log.debug(`打猎失败：${err.message}`);
      break;
    }
  }

  const after = actions.inventoryMap();
  return skillResult(kills > 0, {
    steps,
    produced: positiveOnly(wood.diffOf(before, after)),
    note: kills > 0 ? `猎杀 ${kills} 只${mob}` : `没有打到${mob}`,
    reason: kills > 0 ? null : `附近找不到${mob}，可以走远一点或换个目标（牛/猪/鸡/羊都行）`,
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

/**
 * 把东西存起来：找最近的箱子，没有就做一个放下来。
 */
async function storeItems({ actions, nav, state, ctx, items = null, keep = ['torch', 'crafting_table'] }) {
  const steps = [];
  const bot = actions.bot;
  let chest = bot.findBlock({ matching: (b) => b && (b.name === 'chest' || b.name === 'barrel' || b.name === 'trapped_chest'), maxDistance: 32 });

  if (!chest) {
    ctx.progress('没有找到箱子，试着做一个');
    if (actions.countItem('chest') === 0) {
      // 箱子需要 8 个木板
      if (wood.countPlanks(actions) < 8) {
        const pk = await wood.makePlanks({ actions, ctx, want: 8 });
        steps.push(...pk.steps);
        if (!pk.ok) return skillResult(false, { steps, reason: `做箱子需要 8 个木板：${pk.reason}` });
      }
      try {
        await actions.craft({ item: 'chest', count: 1, signal: ctx.signal });
        steps.push('合成箱子');
      } catch (err) {
        return skillResult(false, { steps, reason: `合成箱子失败：${describeFailure(err)}` });
      }
    }
    const pos = actions._spotInFront();
    if (!pos) return skillResult(false, { steps, reason: '身边没有可放箱子的位置' });
    try {
      await actions.place({ x: pos.x, y: pos.y, z: pos.z, item: 'chest', signal: ctx.signal, reach: true });
      steps.push('放置箱子');
      chest = bot.blockAt(pos);
    } catch (err) {
      return skillResult(false, { steps, reason: `放置箱子失败：${describeFailure(err)}` });
    }
  }
  if (!chest) return skillResult(false, { steps, reason: '找不到也做不出箱子' });

  try {
    const r = await actions.deposit({
      x: chest.position.x,
      y: chest.position.y,
      z: chest.position.z,
      items,
      keep: [...(keep || []), 'crafting_table', 'furnace', 'oak_door'],
      signal: ctx.signal,
      reach: true,
    });
    steps.push(`存入 ${Object.keys(r.stored).length} 种物品`);
    return skillResult(true, {
      steps,
      consumed: r.stored,
      note: `已把 ${r.total} 个物品存进箱子 (${chest.position.x}, ${chest.position.y}, ${chest.position.z})：${Object.entries(r.stored).map(([k, v]) => `${k}×${v}`).join('、') || '无'}`,
      extra: { chest: { x: chest.position.x, y: chest.position.y, z: chest.position.z } },
    });
  } catch (err) {
    return skillResult(false, { steps, reason: `存东西失败：${describeFailure(err)}` });
  }
}

/**
 * 弄点吃的：优先打猎 + 烤熟，退而求其次找苹果/小麦。
 */
async function cookFood({ actions, nav, state, ctx, count = 4 }) {
  const steps = [];
  const before = actions.inventoryMap();

  // 已经有熟食就直接返回
  const cookedHave = ['cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'bread', 'baked_potato'].reduce(
    (s, n) => s + actions.countItem(n),
    0,
  );
  if (cookedHave >= count) {
    return skillResult(true, { steps, note: `已经有 ${cookedHave} 份熟食，够吃了` });
  }

  // 打猎获取生肉
  for (const mob of ['cow', 'pig', 'chicken', 'sheep']) {
    if (ctx.aborted) throw new CancelledError('已取消');
    if (actions.countItem('cooked_beef') + actions.countItem('cooked_porkchop') + actions.countItem('cooked_chicken') + actions.countItem('cooked_mutton') >= count) break;
    const rawName = { cow: 'beef', pig: 'porkchop', chicken: 'chicken', sheep: 'mutton' }[mob];
    const need = count - actions.countItem(`cooked_${rawName}`);
    const r = await huntAnimal({ actions, nav, state, ctx, mob, want: Math.max(1, need) });
    steps.push(...r.steps);
    // 顺手熔炼刚打到的生肉
    if (actions.countItem(rawName) > 0) {
      const sm = await mining.smeltOres({ actions, nav, state, ctx, item: rawName, count: actions.countItem(rawName) });
      steps.push(...sm.steps);
    }
  }

  // 不够就用面包补
  if (actions.countItem('bread') < count && actions.countItem('wheat') >= 3) {
    try {
      await actions.craft({ item: 'bread', count: Math.floor(actions.countItem('wheat') / 3), signal: ctx.signal });
      steps.push('烤面包');
    } catch (err) {
      log.debug(`做面包失败：${err.message}`);
    }
  }

  const after = actions.inventoryMap();
  const produced = positiveOnly(wood.diffOf(before, after));
  const foodNow = ['cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'bread', 'apple', 'carrot', 'baked_potato'].reduce(
    (s, n) => s + actions.countItem(n),
    0,
  );
  return skillResult(foodNow > 0, {
    steps,
    produced,
    note: `现在有 ${foodNow} 份食物`,
    reason: foodNow > 0 ? null : '附近没有动物也没有农作物，可以换个地方或先种地',
  });
}

module.exports = { collect, storeItems, cookFood, huntAnimal, SOURCES };
