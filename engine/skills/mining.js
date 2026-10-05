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
const {
  skillResult,
  collectionCheckpoint,
  positiveOnly,
  driveUntil,
  canDigDownSafely,
  canOpenCellSafely,
  isStableSupport,
  isDangerousBlock,
} = require('./common');
const wood = require('./wood');
const miningReturn = require('./mining_return');

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

function oreSpec(actions, ore) {
  const name = String(ore).toLowerCase();
  const spec = ORES[name];
  const dimension = String(actions.bot?.game?.dimension || '').replace(/^minecraft:/, '');
  if (name === 'gold' && ['the_nether', 'nether'].includes(dimension)) {
    return { ...spec, blocks: ['nether_gold_ore'], item: 'gold_nugget', minTier: 'wooden', yHint: '下界金矿产出金粒' };
  }
  return spec;
}

/**
 * 挖矿：确保工具 → 找矿 → 挖 → 捡，直到拿到 want 个产物。
 */

async function mineOreCollection({ actions, nav, state, ctx, checkpoint, ore = 'iron', want = 10, radius = 40, maxAttempts = 40, autoTool = true, allowSearch = true }) {
  const steps = [];
  const spec = oreSpec(actions, ore);
  if (!spec) {
    return skillResult(false, {
      reason: `不认识的矿石：${ore}。可用的有：${Object.keys(ORES).join(' / ')}`,
    });
  }

  require('./preparation').assertPreparationSearch({ actions, ctx, operation: `挖 ${ore} 矿` });

  // 1) 工具依赖
  if (autoTool) {
    const haveTier = bestPickaxeTier(actions);
    if (!wood.bestPickaxe(actions, spec.minTier)) {
      ctx.progress(`挖${ore}需要${spec.minTier}级镐，当前只有${haveTier || '没有镐'}，先去弄一把`);
      const toolCtx = typeof ctx.child === 'function' ? ctx.child(['mineOre.tool', spec.item, want]) : ctx;
      const tier = wood.carriedPickaxeTier(actions, spec.minTier) || spec.minTier;
      const made = await wood.makeTools({ actions, nav, state, ctx: toolCtx, tier, kinds: ['pickaxe'], allowSearch, forceReplace: true });
      steps.push(...made.steps);
      if (!made.ok) {
        return skillResult(false, {
          steps,
          reason: `没有可用的${spec.minTier}级镐，做工具失败：${made.reason}`,
          extra: { ore, required_tier: spec.minTier },
        });
      }
      if (!wood.bestPickaxe(actions, spec.minTier)) {
        return skillResult(false, {
          steps, reason: `仍缺少${spec.minTier}级镐，不能挖${ore}`,
          extra: { ore, required_tier: spec.minTier },
        });
      }
      // 装备新镐：用一个"需要镐"的假方块来触发工具选择逻辑
      await actions.equipBestToolFor({ name: 'stone', diggable: true, harvestTools: true }, { signal: ctx.signal }).catch(() => {});
    }
  }

  // 2) 先看看附近有没有现成的
  // Only the requested mining drop advances this goal. Tool preparation can
  // consume carried ingots; that must not erase newly collected raw ore.
  const have = () => actions.countItem(spec.item);
  const before = checkpoint.before;
  const startHave = checkpoint.initialHave;

  ctx.progress(`开始挖${ore}，目标 ${want} 个（当前 ${startHave}）`);

  const result = await driveUntil({
    have,
    want: startHave + want,
    ctx,
    checkpoint,
    maxAttempts,
    label: `挖${ore}`,
    fetchOne: async (attempt) => {
      ctx.checkAborted();
      require('./preparation').assertPreparationSearch({ actions, ctx, operation: `挖 ${ore} 矿` });
      await wood.ensurePickaxeDurability({ actions, nav, state, ctx, minTier: spec.minTier });
      ctx.checkAborted();
      if (autoTool && !wood.bestPickaxe(actions, spec.minTier)) {
        const { NoToolError } = require('../actions');
        throw new NoToolError(`缺少可用的${spec.minTier}级镐，就地补做未成功，停止采矿并检查返程`);
      }
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
                require('./preparation').assertPreparationSearch({ actions, ctx, operation: `挖 ${ore} 矿` });
                const r = await actions.dig({ x: again.x, y: again.y, z: again.z, signal: ctx.signal, collect: true, reach: true, safe: true });
                steps.push(`挖 ${r.block}`);
                return true;
              } catch (err) {
                if (err instanceof CancelledError) throw err;
                if (err?.name === 'NoToolError' && await wood.ensurePickaxeDurability({ actions,
                  nav, state, ctx, minTier: spec.minTier })) return true;
                if (['ProtectedBlockError', 'ProtectedHomeError', 'NoToolError'].includes(err?.name)) throw err;
              }
            }
            return false;
          }
        }
        return wood.relocate({ actions, nav, ctx, attempt });
      }

      try {
        require('./preparation').assertPreparationSearch({ actions, ctx, operation: `挖 ${ore} 矿` });
        const r = await actions.dig({ x: found.x, y: found.y, z: found.z, signal: ctx.signal, collect: true, reach: true, safe: true });
        steps.push(`挖 ${r.block} @(${found.x},${found.y},${found.z})`);
        return true;
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        if (err?.name === 'NoToolError' && await wood.ensurePickaxeDurability({ actions,
          nav, state, ctx, minTier: spec.minTier })) return true;
        if (['ProtectedBlockError', 'ProtectedHomeError', 'NoToolError'].includes(err?.name)) throw err;
        log.info(`挖 ${found.name} 失败：${err.message}`);
        return false;
      }
    },
  });

  const after = actions.inventoryMap();
  const produced = positiveOnly(wood.diffOf(before, after));
  // 以背包里真的多了多少为准，而不是以内部循环跑没跑完为准：
  // 早期版本直接返回 result.reached，出现过"什么都没挖到却报成功"的假成功。
  const gained = have() - startHave;
  const ok = gained >= want && result.reached;
  return skillResult(ok, {
    steps,
    produced,
    note:
      (ok ? `已获得 ${gained} 个 ${spec.item}` : gained > 0
        ? `只获得 ${gained} 个 ${spec.item}（目标 ${want}）`
        : `一个 ${spec.item} 都没挖到（${spec.yHint}）`),
    reason: ok ? null : result.lastError || `附近没有找到足够的${ore}（获得 ${gained}/${want}）。${spec.yHint}`,
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
async function mineStoneCollection({ actions, nav, state, ctx, checkpoint, want, radius, maxAttempts,
  strictOnly, allowSearch }) {
  if (!wood.bestPickaxe(actions)) {
    const tier = wood.carriedPickaxeTier(actions) || 'wooden';
    const tool = await wood.makeTools({ actions, nav, state, ctx, tier, kinds: ['pickaxe'], allowSearch, forceReplace: true });
    ctx.checkAborted();
    if (!tool.ok || !wood.bestPickaxe(actions)) return skillResult(false,
      { steps: tool.steps, reason: tool.reason || '采石前没有可用镐' });
  }
  // Tool preparation may consume the very stone requested by this task. Keep
  // that cost in the original inventory goal, including after a preemption.
  const counted = strictOnly ? ['cobblestone'] : ['cobblestone', ...STONE_VARIANT_DROPS];
  if (checkpoint.strictWant == null) checkpoint.strictWant = want + Math.max(0,
    checkpoint.initialHave - counted.reduce((sum, name) => sum + actions.countItem(name), 0));
  const strict = checkpoint.strictResult || await wood.mineSpecific({
    actions, nav, state, ctx, blockNames: ['stone', 'cobblestone'], want: checkpoint.strictWant,
    itemName: 'cobblestone', radius, maxAttempts, allowSearch,
  });
  ctx.checkAborted();
  checkpoint.strictResult = strict;
  if (strict.ok || strictOnly) return strict;
  const gainedStrict = strict.gained || 0;
  if (checkpoint.looseWant == null) checkpoint.looseWant = Math.max(1,
    checkpoint.initialHave + want - counted.reduce((sum, name) => sum + actions.countItem(name), 0));
  const loose = checkpoint.looseResult || await wood.mineSpecific({
    actions, nav, state, ctx, blockNames: STONE_VARIANTS,
    want: checkpoint.looseWant, itemNames: STONE_VARIANT_DROPS,
    radius, maxAttempts, allowSearch,
  });
  ctx.checkAborted();
  checkpoint.looseResult = loose;
  const gained = counted.reduce((sum, name) => sum + actions.countItem(name), 0) - checkpoint.initialHave;
  if (gained > 0) return { ...loose, ok: gained >= want,
    steps: [...(strict.steps || []), ...(loose.steps || [])],
    produced: positiveOnly(wood.diffOf(checkpoint.before, actions.inventoryMap())), gained, wanted: want,
    note: `圆石 ${gainedStrict} 个；其它石质方块 ${loose.gained || 0} 个`,
    reason: gained >= want ? null : strict.reason || loose.reason };
  return strict;
}

async function finishMining({ actions, nav, ctx, checkpoint, collect, have, want, reserveItems = {} }) {
  // An earlier completed substep is replayed before later substeps resume. Its
  // inventory report must not absorb the later substep's already accepted drop.
  if (checkpoint.result) return checkpoint.result;
  miningReturn.captureReturnTarget(checkpoint, actions);
  let collected = checkpoint.collectionResult;
  if (!collected) {
    try {
      collected = await collect();
      ctx.checkAborted();
    } catch (err) {
      miningReturn.rethrowControl(err, ctx, actions);
      // Timeouts, missing tools and ordinary failures retain accepted drops and
      // still create a return obligation. Preparation barriers remain failures.
      collected = skillResult(false, { reason: describeFailure(err) });
    }
    const gained = Math.max(0, have() - checkpoint.initialHave);
    collected = { ...collected, gained, wanted: want,
      collection_ok: collected.ok === true && gained >= want };
    checkpoint.collectionResult = collected;
  }
  if (typeof reserveItems === 'function') reserveItems = reserveItems();
  const back = await miningReturn.returnFromMining({ actions, nav, ctx, checkpoint, reserveItems });
  miningReturn.rethrowControl(null, ctx, actions);
  const ok = collected.collection_ok && back.return_status.ok;
  const result = { ...collected, ok,
    produced: positiveOnly(wood.diffOf(checkpoint.before, actions.inventoryMap())),
    consumed: positiveOnly(wood.diffOf(actions.inventoryMap(), checkpoint.before)),
    note: `${collected.note || ''}${back.note || ''}`,
    reason: !back.return_status.ok ? `安全返程尚未完成：${back.return_status.reason}` : collected.reason,
    return_status: back.return_status };
  if (back.return_status.ok) checkpoint.result = result;
  return result;
}

async function mineOre(options) {
  return miningReturn.withMiningBody(options, async (ctx) => {
    const { actions, nav, ore = 'iron', want = 10, radius = 40, maxAttempts = 40,
      autoTool = true, allowSearch = true } = options;
    const spec = oreSpec(actions, ore);
    if (!spec) return skillResult(false, { reason: `不认识的矿石：${ore}` });
    require('./preparation').assertPreparationSearch({ actions, ctx, operation: `挖 ${ore} 矿` });
    const have = () => actions.countItem(spec.item);
    const checkpoint = collectionCheckpoint(ctx,
      ['mineOre', spec.item, want, radius, maxAttempts, autoTool, allowSearch],
      { have, want, inventory: () => actions.inventoryMap() });
    return finishMining({ actions, nav, ctx, checkpoint, have, want,
      collect: () => mineOreCollection({ ...options, ctx, checkpoint }) });
  });
}

async function mineStone(options) {
  return miningReturn.withMiningBody(options, async (ctx) => {
    const { actions, nav, want = 20, radius = 32, maxAttempts = 40,
      strictOnly = false, allowSearch = true } = options;
    if (typeof ctx.child === 'function') ctx = ctx.child(['mineStone', want, radius, maxAttempts, strictOnly, allowSearch]);
    require('./preparation').assertPreparationSearch({ actions, ctx, operation: '挖石头补材料' });
    const counted = strictOnly ? ['cobblestone'] : ['cobblestone', ...STONE_VARIANT_DROPS];
    const have = () => counted.reduce((sum, name) => sum + actions.countItem(name), 0);
    const checkpoint = collectionCheckpoint(ctx, 'total',
      { have, want, inventory: () => actions.inventoryMap() });
    // Preserve requested materials; climbing may use only genuinely spare stock.
    const reserveItems = () => Object.fromEntries(counted.map((name) => [name,
      name === 'cobblestone' ? (checkpoint.before[name] || 0) + want : actions.countItem(name)]));
    return finishMining({ actions, nav, ctx, checkpoint, have, want, reserveItems,
      collect: () => mineStoneCollection({ ...options, actions, nav, ctx, checkpoint, want,
        radius, maxAttempts, strictOnly, allowSearch }) });
  });
}

/**
 * 向下挖阶梯：这是真玩家下矿的标准手法（挖 1 格走 1 格，能走回来）。
 * 先验证挖后的落脚点，再从旁边挖出下一层；未知地形或危险地形换方向。
 */
async function waitForDescentLanding({ bot, ctx, x, y, z }) {
  // Pathfinder can resolve while the one-block fall is still in progress.
  // Allow a short physics window, checking terrain on every sample.
  const deadline = Date.now() + 800;
  for (;;) {
    ctx.checkAborted();
    const p = bot.entity.position;
    if (Math.floor(p.x) !== x || Math.floor(p.z) !== z || p.y < y - 0.15 || p.y > y + 1.3) return false;
    let supported = false;
    const halfWidth = 0.3 - 1e-6;
    for (let bx = Math.floor(p.x - halfWidth); bx <= Math.floor(p.x + halfWidth); bx++) {
      for (let bz = Math.floor(p.z - halfWidth); bz <= Math.floor(p.z + halfWidth); bz++) {
        const support = blockAt(bot, bx, y - 1, bz);
        const feet = blockAt(bot, bx, y, bz), head = blockAt(bot, bx, y + 1, bz);
        if (!support || !feet || !head || feet.boundingBox !== 'empty' || head.boundingBox !== 'empty' ||
            !canOpenCellSafely(bot, bx, y, bz) || !canOpenCellSafely(bot, bx, y + 1, bz)) return false;
        const actualY = Math.floor(p.y);
        if (actualY !== y) {
          const currentFeet = blockAt(bot, bx, actualY, bz), currentHead = blockAt(bot, bx, actualY + 1, bz);
          if (!currentFeet || !currentHead || currentFeet.boundingBox !== 'empty' || currentHead.boundingBox !== 'empty' ||
              !canOpenCellSafely(bot, bx, actualY, bz) || !canOpenCellSafely(bot, bx, actualY + 1, bz)) return false;
        }
        if (isStableSupport(support)) supported = true;
        else if (support.boundingBox === 'block' || isDangerousBlock(support.name) ||
            typeof support.getProperties === 'function' && (support.getProperties() || {}).waterlogged) return false;
      }
    }
    if (!supported) return false;
    if (bot.entity.onGround === true && Math.abs(p.y - y) <= 0.15 &&
        (!Number.isFinite(bot.entity.velocity?.y) || Math.abs(bot.entity.velocity.y) <= 0.12)) return true;
    if (Date.now() >= deadline) return false;
    await delay(50, { signal: ctx.signal });
  }
}

async function digDownStaircase({ actions, nav, ctx, steps = [], layers = 4 }) {
  const bot = actions.bot;
  let dug = 0;
  const startY = Math.floor(bot.entity.position.y);

  for (let i = 0; i < layers; i += 1) {
    ctx.checkAborted();
    require('./preparation').assertPreparationSearch({ actions, ctx, operation: '下挖搜集原料' });
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
      const ceiling = blockAt(bot, tx, by + 2, tz);
      if (!feet || !head || !floor) continue;
      if (!ceiling || isDangerous(ceiling.name) || ['sand', 'red_sand', 'gravel'].includes(ceiling.name) ||
          ceiling.name.endsWith('_concrete_powder')) continue;
      // 安全判定
      if (isDangerous(feet.name) || isDangerous(head.name)) continue;
      // 目标位置的脚下不能是空气（会掉进洞里）
      if (floor.boundingBox !== 'block' || isDangerous(floor.name)) continue;
      if (!canDigDownSafely(bot, tx, by, tz)) continue;
      if (!canOpenCellSafely(bot, tx, by, tz) || !canOpenCellSafely(bot, tx, by + 1, tz)) continue;
      if (!feet.diggable && feet.boundingBox === 'block') continue;
      if (!head.diggable && head.boundingBox === 'block') continue;

      try {
        ctx.progress(`向下挖阶梯（第 ${i + 1}/${layers} 层）`);
        // 从当前安全位置清理下一格，采集掉落物不能提前把她带进通道。
        if (feet.boundingBox === 'block') {
          require('./preparation').assertPreparationSearch({ actions, ctx, operation: '下挖搜集原料' });
          await actions.dig({ x: tx, y: by, z: tz, signal: ctx.signal, collect: false });
        }
        if (head.boundingBox === 'block') {
          require('./preparation').assertPreparationSearch({ actions, ctx, operation: '下挖搜集原料' });
          await actions.dig({ x: tx, y: by + 1, z: tz, signal: ctx.signal, collect: false });
        }
        ctx.checkAborted();
        if (!canDigDownSafely(bot, tx, by, tz) || !canOpenCellSafely(bot, tx, by, tz) ||
            !canOpenCellSafely(bot, tx, by + 1, tz)) continue;
        require('./preparation').assertPreparationSearch({ actions, ctx, operation: '下挖搜集原料' });
        await actions.dig({ x: tx, y: by - 1, z: tz, signal: ctx.signal, collect: false });
        // 明确要求到下一层；不能把“还站在原地但离目标一格”视为下降。
        const { executionContext } = require('../goals');
        await executionContext.run({ ...executionContext.getStore(), allowTerrainDig: false }, () =>
          nav.goTo({ x: tx + 0.5, y: by - 1, z: tz + 0.5, range: 0.6,
            signal: ctx.signal, timeoutMs: 10000, segmented: false }));
        const p2 = bot.entity.position;
        if (Math.floor(p2.x) !== tx || Math.floor(p2.z) !== tz) {
          // A resolved route that never moved can try another direction. A
          // displaced body must not keep opening cells from the old origin.
          if (Math.floor(p2.x) === bx && Math.floor(p2.z) === bz && Math.floor(p2.y) === by &&
              bot.entity.onGround === true) continue;
          const error = new Error('阶梯下降寻路偏离落脚点，停止开通道并检查返程');
          error.name = 'UnsafeDescentError';
          throw error;
        }
        if (!await waitForDescentLanding({ bot, ctx, x: tx, y: by - 1, z: tz })) {
          const error = new Error('阶梯下降后未确认安全落地，停止开通道并检查返程');
          error.name = 'UnsafeDescentError';
          throw error;
        }
        dug += 1;
        advanced = true;
        steps.push(`沿阶梯下降 ${startY - Math.floor(bot.entity.position.y)} 格`);
        break;
      } catch (err) {
        ctx.checkAborted();
        // These failures describe the mining body's controls or preparation,
        // rather than a blocked direction. Let the parent stop collection and
        // preserve its return obligation instead of trying four more tunnels.
        if (err instanceof CancelledError || ['CancelledError', 'AbortError', 'NoToolError',
          'PreparationBlockedError', 'ProtectedBlockError', 'ProtectedHomeError', 'UnsafeDescentError'].includes(err?.name)) throw err;
        log.info(`阶梯挖掘方向 (${dx},${dz}) 失败：${err.message}`);
      }
    }
    if (!advanced) {
      log.info('四个方向都无法安全向下挖，停止');
      break;
    }
    // 别一口气挖到基岩：最多 32 格
    if (startY - Math.floor(bot.entity.position.y) >= 32) break;
  }
  return dug > 0;
}

function shouldDigDown(actions, spec) {
  const y = Math.floor(actions.bot.entity.position.y);
  // Match resource outputs, not their display aliases. Emeralds favour high
  // mountain terrain; following a generic deep-mining rule makes that worse.
  if (['diamond', 'redstone', 'raw_gold', 'lapis_lazuli', 'raw_iron'].includes(spec.item)) {
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
async function smeltOres({ actions, nav, state, ctx, item = null, count = null, allowSearch = true, reserveItems = {} }) {
  const steps = [];
  const before = actions.inventoryMap();
  const targets = [];
  const candidates = ['raw_iron', 'iron_ore', 'deepslate_iron_ore', 'raw_gold', 'raw_copper', 'sand', 'cobblestone', 'porkchop', 'beef', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon', 'potato', 'kelp', 'ancient_debris'];
  if (item) {
    const from = String(item).replace(/^minecraft:/, '');
    targets.push({ from, amount: count || actions.countItem(from) });
  } else {
    for (const c of candidates) {
      const have = actions.countItem(c);
      if (have > 0) targets.push({ from: c, amount: have });
    }
  }
  if (!targets.length) {
    return skillResult(false, { reason: '背包里没有可以熔炼的东西（需要原矿、沙子、生肉之类）' });
  }

  const { guessSmeltOutput, canSmeltInFurnace, MissingItemError } = require('../actions');
  const outputs = [...new Set(targets.map((t) => guessSmeltOutput(t.from)))];
  const failed = [];
  const actualProduced = () => {
    const after = actions.inventoryMap();
    return Object.fromEntries(outputs.map((name) => [name, Math.max(0, (after[name] || 0) - (before[name] || 0))])
      .filter(([, gained]) => gained > 0));
  };
  const finish = () => {
    const produced = actualProduced();
    const ok = Object.keys(produced).length > 0;
    return skillResult(ok, { steps, produced,
      note: ok ? `熔炼完成：${Object.entries(produced).map(([k, v]) => `${k}×${v}`).join('、')}` : '什么都没熔炼出来',
      reason: ok ? null : failed.map((f) => `${f.item}: ${f.error}`).join('；') || '没有可熔炼的材料',
      extra: { failed } });
  };
  const rethrowControl = (err) => {
    ctx.checkAborted();
    if (err instanceof CancelledError || err?.name === 'CancelledError' || err?.name === 'AbortError') throw err;
    if (actions._stopped) throw new CancelledError('熔炼被急停');
  };
  // Furnace/table dependencies must not consume the stock requested as input.
  // The same stock may already have an explicit reserve: retain the larger
  // requirement rather than counting it twice.
  const preparationReserves = {};
  for (const [name, amount] of Object.entries(reserveItems || {})) {
    const key = name.replace(/^minecraft:/, '');
    preparationReserves[key] = Math.max(preparationReserves[key] || 0, Math.max(0, Math.ceil(Number(amount) || 0)));
  }
  for (const target of targets) {
    const retained = Math.min(actions.countItem(target.from), Math.max(0, Math.ceil(Number(target.amount) || 0)));
    preparationReserves[target.from] = Math.max(preparationReserves[target.from] || 0, retained);
  }
  const available = (name) => Math.max(0, actions.countItem(name) - (preparationReserves[name] || 0));
  const availableLogs = () => wood.LOG_NAMES.reduce((sum, name) => sum + available(name), 0);
  const availablePlanks = () => Object.keys(actions.inventoryMap()).filter((name) => name.endsWith('_planks'))
    .reduce((sum, name) => sum + available(name), 0);
  const stationNames = ['furnace', 'blast_furnace', 'smoker'];
  const usableStation = targets.every((t) => {
    if (actions.countItem(t.from) <= 0) return true;
    if (typeof actions._findStationBlock === 'function') {
      return !!actions._findStationBlock(stationNames, { input: t.from });
    }
    const { executionContext } = require('../goals');
    const home = executionContext.getStore()?.indoorHome;
    const { isIndoorStation } = require('./preparation');
    return !!actions.bot.findBlock({ matching: (b) => b && stationNames.includes(b.name) &&
      canSmeltInFurnace(b.name, t.from),
      useExtraInfo: (b) => !home || isIndoorStation(b?.position, home), maxDistance: 24 });
  });

  // 确保熔炉
  if (actions.countItem('furnace') === 0 && !usableStation) {
    ctx.progress('没有熔炉，先做一个');
    if (available('cobblestone') < 8) {
      if (!allowSearch) {
        failed.push({ item: 'furnace', error: `没有可用熔炉，未保留的圆石不足 8 个（只有 ${available('cobblestone')} 个）；保留待熔炼原料，本次禁止外出搜索材料` });
        return finish();
      }
      try {
        const st = await mineStone({ actions, nav, state, ctx, want: 8 - available('cobblestone'), allowSearch });
        ctx.checkAborted();
        steps.push(...st.steps);
        if (st.return_status?.required === true && st.return_status.ok === false) {
          const after = actions.inventoryMap();
          return skillResult(false, { steps, produced: positiveOnly(wood.diffOf(before, after)),
            consumed: positiveOnly(wood.diffOf(after, before)),
            reason: `熔炉材料已保留，先完成安全返程：${st.return_status.reason || st.reason}`,
            extra: { collection_ok: false, material_collection_ok: st.collection_ok === true,
              return_status: st.return_status } });
        }
        if (available('cobblestone') < 8) {
          failed.push({ item: 'furnace', error: '新增炉材尚不足 8 个，保留待熔炼圆石，不能制造熔炉' });
          return finish();
        }
      } catch (err) {
        rethrowControl(err);
        if (['PreparationBlockedError', 'ProtectedBlockError', 'ProtectedHomeError'].includes(err?.name)) throw err;
        failed.push({ item: 'furnace', error: describeFailure(err) });
        return finish();
      }
    }
    try {
      // A furnace is a 3x3 recipe. Carrying its eight stones is not enough
      // when no table exists; prepare that dependency before consuming them.
      const { executionContext } = require('../goals');
      const indoorHome = executionContext.getStore()?.indoorHome;
      const { isIndoorStation } = require('./preparation');
      let table = typeof actions._findStationBlock === 'function' ? actions._findStationBlock(['crafting_table']) :
        actions.bot.findBlock({ matching: (b) => b?.name === 'crafting_table', maxDistance: 24,
          useExtraInfo: (b) => !indoorHome || isIndoorStation(b?.position, indoorHome) });
      if (!table && actions.stations && typeof actions._rememberedStation === 'function') {
        table = await actions._rememberedStation('crafting_table', { signal: ctx.signal, allowTravel: allowSearch });
        ctx.checkAborted();
      }
      if (!table && actions.countItem('crafting_table') === 0) {
        // Native table recipes choose a wood variant. Until that recipe API
        // supports ingredient reserves, do not risk choosing retained planks
        // even when another wood variant has four free planks.
        if (Object.entries(preparationReserves).some(([name, amount]) =>
          name.endsWith('_planks') && amount > 0 && actions.countItem(name) > 0)) {
          throw new MissingItemError('不与保留木板冲突的工作台', '现有木板含保留材料，先提供现成或携带工作台再熔炼');
        }
        const deficit = Math.max(0, 4 - availablePlanks());
        if (availableLogs() * 4 < deficit) {
          if (!allowSearch) throw new MissingItemError('工作台木材', '现有木料不足以制作工作台；本次禁止外出搜索材料');
          require('./preparation').assertPreparationSearch({ actions, ctx, operation: '砍树准备熔炉工作台' });
          const logNeed = Math.ceil(deficit / 4) - availableLogs();
          const logs = await wood.chopTree({ actions, nav, state, ctx, want: logNeed, radius: 24, maxAttempts: 4 });
          ctx.checkAborted(); steps.push(...logs.steps);
          if (availableLogs() * 4 < deficit) throw new MissingItemError('工作台木材', logs.reason || '仍缺制作工作台的木材');
        }
        if (deficit > 0) {
          const planks = await wood.makePlanks({ actions, ctx, want: deficit, reserveItems: preparationReserves });
          ctx.checkAborted(); steps.push(...planks.steps);
          if (availablePlanks() < 4) throw new MissingItemError('工作台木板', planks.reason || '木板未实际补齐');
        }
        await actions.craft({ item: 'crafting_table', count: 1, signal: ctx.signal });
        ctx.checkAborted();
        if (actions.countItem('crafting_table') <= 0) throw new MissingItemError('工作台', '服务端未确认合成工作台');
        steps.push('为熔炉准备工作台');
      }
      if (!table) {
        if (typeof actions._ensureCraftingTable === 'function') {
          table = await actions._ensureCraftingTable({ signal: ctx.signal, allowTravel: allowSearch, want: 'furnace' });
        } else {
          const prepared = await wood.ensureCraftingTable({ actions, ctx, steps });
          if (!prepared.ok) throw new MissingItemError('工作台', prepared.reason);
        }
        ctx.checkAborted();
      }
      const furnaceR = await actions.craft({ item: 'furnace', count: 1, signal: ctx.signal });
      ctx.checkAborted();
      if (actions.countItem('furnace') <= 0) {
        failed.push({ item: 'furnace', error: furnaceR.note || '合成熔炉失败：一个熔炉都没做出来（需要 8 个圆石）' });
        return finish();
      }

      steps.push('合成熔炉');
    } catch (err) {
      rethrowControl(err);
      if (['PreparationBlockedError', 'ProtectedBlockError', 'ProtectedHomeError'].includes(err?.name)) throw err;
      failed.push({ item: 'furnace', error: `合成熔炉失败：${describeFailure(err)}（需要 8 个圆石）` });
      return finish();
    }
  }

  for (const t of targets) {
    ctx.checkAborted();
    const amount = Math.min(t.amount || 1, actions.countItem(t.from));
    if (amount <= 0) continue;
    const output = guessSmeltOutput(t.from);
    const initialOutput = actions.countItem(output);
    try {
      ctx.progress(`熔炼 ${t.from}×${amount}`);
      let r;
      try {
        // An empty fuel slot in the backpack does not mean a cold furnace:
        // previous fuel may still be burning. Inspect and try the real furnace.
        r = await actions.smelt({ item: t.from, count: amount, signal: ctx.signal, reserveItems: preparationReserves });
      } catch (err) {
        rethrowControl(err);
        const what = typeof err?.data?.what === 'string' && err.data.what ? err.data.what : err?.message;
        if (!(err instanceof MissingItemError) || !/燃料|\bfuel\b/i.test(String(what || ''))) throw err;
        const gained = Math.max(0, actions.countItem(output) - initialOutput);
        const retryAmount = Math.min(amount - gained, actions.countItem(t.from));
        if (retryAmount > 0) {
          if (!allowSearch) throw err;
          require('./preparation').assertPreparationSearch({ actions, ctx, operation: '砍树补熔炼燃料' });
          ctx.progress('实际熔炉已确认缺燃料，先补木材再重试一次');
          const fuelCtx = typeof ctx.child === 'function' ? ctx.child(['smeltFuel', t.from, amount]) : ctx;
          const chop = await wood.chopTree({ actions, nav, state, ctx: fuelCtx, want: 3 });
          ctx.checkAborted();
          steps.push(...chop.steps);
          r = await actions.smelt({ item: t.from, count: retryAmount, signal: ctx.signal, reserveItems: preparationReserves });
        } else {
          r = { note: err.message };
        }
      }
      ctx.checkAborted();
      const gained = Math.max(0, actions.countItem(output) - initialOutput);
      if (gained > 0) steps.push(`熔炼 ${t.from} → ${output}×${gained}`);
      if (gained < amount) failed.push({ item: t.from,
        error: gained > 0 ? `只确认产出 ${output}×${gained}/${amount}` : r.note || '熔炼没有实际成品新增' });
    } catch (err) {
      rethrowControl(err);
      failed.push({ item: t.from, error: describeFailure(err) });
    }
  }
  ctx.checkAborted();
  return finish();
}

function hasFuel(actions) {
  const { fuelSmeltCapacity } = require('../actions');
  return Object.entries(actions.inventoryMap()).some(([name, count]) => count > 0 && fuelSmeltCapacity(name) > 0);
}

function bestPickaxeTier(actions) {
  let best = null;
  for (const t of ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']) {
    if (actions.countItem(`${t}_pickaxe`) > 0) {
      best = t;
      break;
    }
  }
  return best;
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
  shouldDigDown,
};
