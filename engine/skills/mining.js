'use strict';
/**
 * 采矿与熔炼技能。
 *
 * 采矿是"像玩家一样的游玩"里最考验工程的部分，原因是它同时涉及：
 *   - 工具依赖（没镐挖不了石头，没石镐挖不了铁）
 *   - 三维搜索（矿在地下，得往下走）
 *   - 安全（岩浆、水、沙砾塌方、挖穿洞摔死）
 * 这里的策略是：**先保证活着，再保证挖到**。
 */

const log = require('../log');
const { delay, CancelledError, describeFailure, distance, vec3 } = require('../util');
const { skillResult, positiveOnly, driveUntil } = require('./common');
const wood = require('./wood');

/**
 * 矿石定义表。
 * 关键信息：方块变体、需要的工具等级、产物名、工具不够时的提示。
 */
const ORES = {
  coal: {
    blocks: ['coal_ore', 'deepslate_coal_ore'],
    item: 'coal',
    minTier: 'wooden',
    yHint: '常见于 y=0–190 之间的任何高度，露天矿洞也很多',
  },
  iron: {
    blocks: ['iron_ore', 'deepslate_iron_ore'],
    item: 'raw_iron',
    minTier: 'stone',
    yHint: 'y=0–70 最常见，y=15 附近最密集；深板岩层也大量分布',
  },
  copper: {
    blocks: ['copper_ore', 'deepslate_copper_ore'],
    item: 'raw_copper',
    minTier: 'stone',
    yHint: 'y=0–112',
  },
  gold: {
    blocks: ['gold_ore', 'deepslate_gold_ore', 'nether_gold_ore'],
    item: 'raw_gold',
    minTier: 'iron',
    yHint: '主世界 y=-64–32，下界金矿更方便',
  },
  redstone: { blocks: ['redstone_ore', 'deepslate_redstone_ore'], item: 'redstone', minTier: 'iron', yHint: 'y=-64–16' },
  lapis: { blocks: ['lapis_ore', 'deepslate_lapis_ore'], item: 'lapis_lazuli', minTier: 'stone', yHint: 'y=-64–64' },
  diamond: { blocks: ['diamond_ore', 'deepslate_diamond_ore'], item: 'diamond', minTier: 'iron', yHint: 'y=-64–16，越深越好' },
  emerald: { blocks: ['emerald_ore', 'deepslate_emerald_ore'], item: 'emerald', minTier: 'iron', yHint: '只在山地生物群系 y=-16–320' },
  quartz: { blocks: ['nether_quartz_ore'], item: 'quartz', minTier: 'wooden', yHint: '下界' },
  ancient_debris: { blocks: ['ancient_debris'], item: 'ancient_debris', minTier: 'diamond', yHint: '下界 y=8–22，极稀有' },
};

/** 石头类方块：用来取圆石、挖通道 */
const STONE_BLOCKS = ['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'andesite', 'granite', 'diorite', 'tuff'];

/**
 * 其它石质方块（不是圆石，做不了石制工具，但可以当建材）。
 * 与它们的真实掉落物一一对应，供 mineStone 第二阶段按真实产出计数。
 */
const STONE_VARIANTS = ['andesite', 'granite', 'diorite', 'tuff', 'deepslate'];
const STONE_VARIANT_DROPS = ['andesite', 'granite', 'diorite', 'tuff', 'cobbled_deepslate'];

const TIER_INDEX = { wooden: 0, stone: 1, iron: 2, diamond: 3, netherite: 4 };

/**
 * 挖矿：确保工具 → 找矿 → 挖 → 捡，直到拿到 want 个产物。
 */
async function mineOre({ actions, nav, state, ctx, ore = 'iron', want = 10, radius = 40, autoTool = true, allowSearch = true }) {
  const steps = [];
  const spec = ORES[ore] || ORES[String(ore).toLowerCase()];
  if (!spec) {
    return skillResult(false, {
      reason: `不认识的矿石：${ore}。可用的有：${Object.keys(ORES).join(' / ')}`,
    });
  }

  // 1) 工具依赖
  if (autoTool) {
    const haveTier = bestPickaxeTier(actions);
    if (TIER_INDEX[haveTier] < TIER_INDEX[spec.minTier]) {
      ctx.progress(`挖${ore}需要${spec.minTier}级镐，当前只有${haveTier || '没有镐'}，先去弄一把`);
      const made = await wood.makeTools({ actions, nav, state, ctx, tier: spec.minTier === 'diamond' ? 'iron' : spec.minTier, kinds: ['pickaxe'] });
      steps.push(...made.steps);
      if (!made.ok) {
        return skillResult(false, {
          steps,
          reason: `没有可用的${spec.minTier}级镐，做工具失败：${made.reason}`,
          extra: { ore, required_tier: spec.minTier },
        });
      }
      // 装备新镐：用一个"需要镐"的假方块来触发工具选择逻辑
      await actions.equipBestToolFor({ name: 'stone', diggable: true, harvestTools: true }, { signal: ctx.signal }).catch(() => {});
    }
  }

  // 2) 先看看附近有没有现成的
  const before = actions.inventoryMap();
  const have = () => {
    // 生矿与锭都算（如果已经熔炼过）
    const raw = actions.countItem(spec.item);
    const ingot = actions.countItem(ingotOf(spec.item));
    return raw + ingot;
  };
  const startHave = have();

  ctx.progress(`开始挖${ore}，目标 ${want} 个（当前 ${startHave}）`);

  const result = await driveUntil({
    have,
    want: startHave + want,
    ctx,
    maxAttempts: 40,
    label: `挖${ore}`,
    fetchOne: async (attempt) => {
      ctx.checkAborted();
      const found = wood.findNearestDiggable(actions, spec.blocks, radius);
      if (!found) {
        // allowSearch=false：只挖眼前能看到的矿，不往下硬挖也不四处游荡。
        // 用于"给定矿脉"的定向测试——否则找不到会白挖几十秒石头。
        if (!allowSearch) return false;
        // 找不到：先往下探索（矿在地下），偶尔水平探索找矿洞
        const deepFirst = shouldDigDown(actions, spec);
        if (deepFirst) {
          const descended = await digDownStaircase({ actions, nav, ctx, steps, layers: 4 });
          if (descended) {
            // 挖下去的通道里可能顺便出矿，再找一次
            const again = wood.findNearestDiggable(actions, spec.blocks, radius);
            if (again) {
              try {
                const r = await actions.dig({ x: again.x, y: again.y, z: again.z, signal: ctx.signal, collect: true, reach: true });
                steps.push(`挖 ${r.block}`);
                return true;
              } catch (err) {
                if (err instanceof CancelledError) throw err;
              }
            }
            return false;
          }
        }
        return wood.relocate({ actions, nav, ctx, attempt });
      }

      try {
        const r = await actions.dig({ x: found.x, y: found.y, z: found.z, signal: ctx.signal, collect: true, reach: true });
        steps.push(`挖 ${r.block} @(${found.x},${found.y},${found.z})`);
        return true;
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        log.debug(`挖 ${found.name} 失败：${err.message}`);
        return false;
      }
    },
  });

  const after = actions.inventoryMap();
  const produced = positiveOnly(wood.diffOf(before, after));
  // 以背包里真的多了多少为准，而不是以内部循环跑没跑完为准：
  // 早期版本直接返回 result.reached，出现过"什么都没挖到却报成功"的假成功。
  const gained = have() - startHave;
  const ok = gained > 0;
  return skillResult(ok, {
    steps,
    produced,
    note: ok ? `已获得 ${gained} 个 ${spec.item}` : `一个 ${spec.item} 都没挖到（${spec.yHint}）`,
    reason: ok ? null : result.lastError || `附近没有找到${ore}。${spec.yHint}`,
    extra: { ore, hint: spec.yHint, gained, wanted: want },
  });
}

/**
 * 挖石取圆石（石制工具的前置）。
 */
/**
 * 挖石头拿建材。
 *
 * **两阶段**，这里有个真实踩过的坑：
 * 地表附近除了石头，还常有安山岩/闪长岩/花岗岩/凝灰岩。它们看起来都是"石质方块"，
 * 但**掉落的是它们自己，不是圆石**——而石制工具只能用圆石（或黑石/深板岩圆石）做。
 * 早期把八种方块混在一个列表里"就近挖"，结果实测出现：
 * 她挖了 18 个方块（安山岩×9、闪长岩×9），技能却判定"一个圆石都没挖到"，
 * 白忙 94 秒，整条生存链还是卡住。
 *
 * 所以：
 *   第一阶段只挖真正掉圆石的（stone/cobblestone）——这是做工具和盖房的主力
 *   第二阶段才接受其它石质方块（它们是不错的建材，只是做不了石制工具）
 */
async function mineStone({ actions, nav, state, ctx, want = 20 }) {
  const strict = await wood.mineSpecific({
    actions,
    nav,
    state,
    ctx,
    blockNames: ['stone', 'cobblestone'],
    want,
    itemName: 'cobblestone',
    radius: 40,
  });
  if (strict.ok) return strict;

  // 附近只有其它石质方块时，退而挖它们（按各自的真实掉落物计数）
  const gainedStrict = (strict.extra && strict.extra.gained) || 0;
  const stillWant = Math.max(1, want - gainedStrict);
  const loose = await wood.mineSpecific({
    actions,
    nav,
    state,
    ctx,
    blockNames: STONE_VARIANTS,
    want: stillWant,
    itemNames: STONE_VARIANT_DROPS,
    radius: 40,
  });

  // 两阶段合并报告：只要任一段有产出就算部分成功
  if (loose.ok || gainedStrict > 0) {
    return {
      ...loose,
      ok: loose.ok || gainedStrict >= want,
      steps: [...(strict.steps || []), ...(loose.steps || [])],
      note: `圆石 ${gainedStrict} 个${loose.ok ? `；其它石质方块 ${(loose.extra && loose.extra.gained) || 0} 个` : ''}`,
      reason: loose.ok || gainedStrict >= want ? null : strict.reason || loose.reason,
    };
  }
  return strict;
}

/**
 * 向下挖阶梯：这是真玩家下矿的标准手法（挖 1 格走 1 格，能走回来）。
 * 每一步都会检查脚下的方块，遇到岩浆/水就换方向——摔死和烫死是最蠢的死法。
 */
async function digDownStaircase({ actions, nav, ctx, steps = [], layers = 4 }) {
  const bot = actions.bot;
  let dug = 0;
  const startY = Math.floor(bot.entity.position.y);

  for (let i = 0; i < layers; i += 1) {
    ctx.checkAborted();
    const p = bot.entity.position;
    const bx = Math.floor(p.x);
    const by = Math.floor(p.y);
    const bz = Math.floor(p.z);

    // 选一个方向作为阶梯前进方向，尝试四个方向直到有安全的
    const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    let advanced = false;
    for (const [dx, dz] of dirs) {
      const tx = bx + dx;
      const tz = bz + dz;
      const feet = blockAt(bot, tx, by, tz);
      const head = blockAt(bot, tx, by + 1, tz);
      const floor = blockAt(bot, tx, by - 1, tz);
      if (!feet || !head || !floor) continue;
      // 安全判定
      if (isDangerous(feet.name) || isDangerous(head.name)) continue;
      // 目标位置的脚下不能是空气（会掉进洞里）
      if (floor.boundingBox !== 'block' || isDangerous(floor.name)) continue;
      if (!feet.diggable && feet.boundingBox === 'block') continue;
      if (!head.diggable && head.boundingBox === 'block') continue;

      try {
        ctx.progress(`向下挖阶梯（第 ${i + 1}/${layers} 层）`);
        // 先挖掉脚下这一格，站到下一层
        if (feet.boundingBox === 'block') {
          await actions.dig({ x: tx, y: by, z: tz, signal: ctx.signal, collect: true });
        }
        if (head.boundingBox === 'block') {
          await actions.dig({ x: tx, y: by + 1, z: tz, signal: ctx.signal, collect: true });
        }
        // 走过去并下到下一层
        await nav.goTo({ x: tx, y: null, z: tz, range: 1, signal: ctx.signal, timeoutMs: 10000 });
        // 再挖掉新脚下的方块，形成阶梯
        const p2 = bot.entity.position;
        const b2x = Math.floor(p2.x);
        const b2y = Math.floor(p2.y);
        const b2z = Math.floor(p2.z);
        const below = blockAt(bot, b2x, b2y - 1, b2z);
        if (below && below.diggable && !isDangerous(below.name) && below.boundingBox === 'block') {
          await actions.dig({ x: b2x, y: b2y - 1, z: b2z, signal: ctx.signal, collect: true });
        }
        dug += 1;
        advanced = true;
        steps.push(`向下挖 ${startY - Math.floor(bot.entity.position.y)} 格`);
        break;
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        log.debug(`阶梯挖掘方向 (${dx},${dz}) 失败：${err.message}`);
      }
    }
    if (!advanced) {
      log.debug('四个方向都无法安全向下挖，停止');
      break;
    }
    // 别一口气挖到基岩：最多 32 格
    if (startY - Math.floor(bot.entity.position.y) >= 32) break;
  }
  return dug > 0;
}

function shouldDigDown(actions, spec) {
  const y = Math.floor(actions.bot.entity.position.y);
  // 钻石/红石/金/铁这类深矿，y 高于 40 就该往下走
  if (['diamond', 'redstone', 'gold', 'lapis', 'iron', 'emerald'].includes(spec.item === 'raw_iron' ? 'iron' : spec.item)) {
    return y > 30;
  }
  return false;
}

function isDangerous(name) {
  const n = String(name);
  return n === 'lava' || n === 'water' || n === 'flowing_lava' || n === 'flowing_water' || n === 'bedrock' || n === 'fire' || n === 'magma_block' || n === 'cactus' || n === 'powder_snow';
}

/**
 * 熔炼矿石：把 raw_iron 之类烧成锭。
 * 会自动补熔炉、补燃料。
 */
async function smeltOres({ actions, nav, state, ctx, item = null, count = null }) {
  const steps = [];
  const targets = [];
  const candidates = ['raw_iron', 'raw_gold', 'raw_copper', 'sand', 'cobblestone', 'porkchop', 'beef', 'chicken', 'mutton', 'cod', 'salmon', 'potato', 'ancient_debris'];
  if (item) {
    targets.push({ from: String(item).replace(/^minecraft:/, ''), amount: count || actions.countItem(item) });
  } else {
    for (const c of candidates) {
      const have = actions.countItem(c);
      if (have > 0) targets.push({ from: c, amount: have });
    }
  }
  if (!targets.length) {
    return skillResult(false, { reason: '背包里没有可以熔炼的东西（需要原矿、沙子、生肉之类）' });
  }

  // 确保熔炉
  if (actions.countItem('furnace') === 0 && !actions.bot.findBlock({ matching: (b) => b && b.name.includes('furnace'), maxDistance: 24 })) {
    ctx.progress('没有熔炉，先做一个');
    if (actions.countItem('cobblestone') < 8) {
      const st = await mineStone({ actions, nav, state, ctx, want: 8 - actions.countItem('cobblestone') });
      steps.push(...st.steps);
    }
    try {
      await actions.craft({ item: 'furnace', count: 1, signal: ctx.signal });
      steps.push('合成熔炉');
    } catch (err) {
      return skillResult(false, { steps, reason: `合成熔炉失败：${describeFailure(err)}（需要 8 个圆石）` });
    }
  }

  const produced = {};
  const failed = [];
  for (const t of targets) {
    ctx.checkAborted();
    const amount = Math.min(t.amount || 1, actions.countItem(t.from));
    if (amount <= 0) continue;
    // 熔炼需要燃料：没有就先弄点木头做木炭/木板
    if (!hasFuel(actions)) {
      ctx.progress('没有燃料，先去弄点木头');
      const chop = await wood.chopTree({ actions, nav, state, ctx, want: 3 });
      steps.push(...chop.steps);
    }
    try {
      ctx.progress(`熔炼 ${t.from}×${amount}`);
      const r = await actions.smelt({ item: t.from, count: amount, signal: ctx.signal });
      steps.push(`熔炼 ${t.from} → ${r.output}×${r.produced}`);
      produced[r.output] = (produced[r.output] || 0) + r.produced;
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      failed.push({ item: t.from, error: describeFailure(err) });
    }
  }

  return skillResult(Object.keys(produced).length > 0, {
    steps,
    produced,
    note: Object.keys(produced).length
      ? `熔炼完成：${Object.entries(produced).map(([k, v]) => `${k}×${v}`).join('、')}`
      : '什么都没熔炼出来',
    reason: Object.keys(produced).length ? null : failed.map((f) => `${f.item}: ${f.error}`).join('；') || '没有可熔炼的材料',
    extra: { failed },
  });
}

function hasFuel(actions) {
  return ['coal', 'charcoal', 'oak_planks', 'birch_planks', 'spruce_planks', 'oak_log', 'birch_log', 'spruce_log', 'stick', 'dried_kelp_block', 'blaze_rod', 'lava_bucket'].some(
    (n) => actions.countItem(n) > 0,
  );
}

function bestPickaxeTier(actions) {
  let best = null;
  for (const t of ['netherite', 'diamond', 'iron', 'stone', 'wooden']) {
    if (actions.countItem(`${t}_pickaxe`) > 0) {
      best = t;
      break;
    }
  }
  return best;
}

function ingotOf(rawItem) {
  const map = { raw_iron: 'iron_ingot', raw_gold: 'gold_ingot', raw_copper: 'copper_ingot' };
  return map[rawItem] || rawItem;
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
  mineOre,
  mineStone,
  smeltOres,
  digDownStaircase,
  ORES,
  STONE_BLOCKS,
  isDangerous,
  bestPickaxeTier,
  hasFuel,
};
