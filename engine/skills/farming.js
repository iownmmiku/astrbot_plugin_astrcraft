'use strict';

// Small wheat plots beside existing source water. No irrigation, terrain
// excavation, remote search or waiting in place for random growth ticks.
const { vec3, distance, delay, CancelledError, describeFailure } = require('../util');
const { skillResult, positiveOnly } = require('./common');
const { executionContext } = require('../goals');
const { withProtectedHome, worldOf, assertProtectedHomeDig } = require('./mining_return');
const wood = require('./wood');

const RADIUS = 24, READ_BUDGET = 2048, MAX_PLOTS = 8, MAX_GRASS = 24;
const AIR = new Set(['air', 'cave_air']);
const GRASS = new Set(['grass', 'short_grass', 'tall_grass']);
const SOIL = new Set(['grass_block', 'dirt', 'farmland']);
const HOES = ['netherite_hoe', 'diamond_hoe', 'iron_hoe', 'stone_hoe', 'wooden_hoe', 'golden_hoe'];
const scans = new WeakMap();
const key = (p) => `${p.x},${p.y},${p.z}`;
const point = (p) => ({ x: p.x, y: p.y, z: p.z });

function validPoint(p) {
  return p && ['x', 'y', 'z'].every((axis) => Number.isInteger(p[axis]) && Math.abs(p[axis]) < 32000000);
}
function checkedHome(bot, home) {
  if (!home || typeof home.server !== 'string' || typeof home.dimension !== 'string' || !validPoint(home.origin) ||
      !Number.isInteger(home.size) || home.size < 4 || home.size > 8 ||
      !Number.isInteger(home.wall_height) || home.wall_height < 2 || home.wall_height > 4) {
    throw new Error('农田需要当前世界的有效基地记录');
  }
  const world = worldOf(bot);
  if (home.server !== world.server || home.dimension.replace(/^minecraft:/, '') !== world.dimension || world.dimension !== 'overworld') {
    throw new Error('农田基地不属于当前主世界');
  }
  return { x: home.origin.x + Math.floor(home.size / 2), y: home.origin.y - 1,
    z: home.origin.z + Math.floor(home.size / 2) };
}
function outsideHome(p, home) {
  // Keep a one-block walkway clear, including the entrance and foundation.
  return !(p.x >= home.origin.x - 1 && p.x <= home.origin.x + home.size &&
    p.z >= home.origin.z - 1 && p.z <= home.origin.z + home.size);
}
function withinFarm(p, center, home) {
  return validPoint(p) && Math.hypot(p.x - center.x, p.z - center.z) <= RADIUS &&
    Math.abs(p.y - center.y) <= 3 && outsideHome(p, home);
}
function reader(bot, budget = READ_BUDGET) {
  const cache = new Map();
  let reads = 0, exhausted = false;
  return { get reads() { return reads; }, get exhausted() { return exhausted; },
    read(p) {
      const id = key(p);
      if (cache.has(id)) return cache.get(id);
      if (reads >= budget) { exhausted = true; return null; }
      reads++;
      let block = null;
      try { block = bot.blockAt(vec3(p.x, p.y, p.z)); } catch { /* Unloaded is unknown. */ }
      cache.set(id, block);
      return block;
    } };
}
function sourceWater(block) {
  if (block?.name !== 'water') return false;
  try { return block.getProperties?.().level === 0; } catch { return false; }
}
function lit(block) {
  return block && Math.max(Number.isFinite(block.skyLight) ? block.skyLight : -1,
    Number.isFinite(block.light) ? block.light : -1) >= 9;
}
function stateFor(bot, home, center) {
  const id = JSON.stringify([home.server, home.dimension, home.origin, home.size]);
  let state = scans.get(bot);
  if (!state || state.id !== id) {
    const positions = [];
    for (let radius = 0; radius <= RADIUS; radius++) {
      for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius || Math.hypot(dx, dz) > RADIUS) continue;
        for (const dy of [0, -1, 1, -2, 2, -3, 3]) positions.push({ x: center.x + dx, y: center.y + dy, z: center.z + dz });
      }
    }
    state = { id, cursor: 0, positions, water: [], soil: [], grass: [], hadUnknown: false };
    scans.set(bot, state);
  }
  return state;
}
function addUnique(list, p, max) {
  if (list.length < max && !list.some((other) => key(other) === key(p))) list.push(point(p));
}
function readPlot(read, p, home, center, waters = null) {
  if (!withinFarm(p, center, home)) return { usable: false, loaded: true };
  const soil = read(p), crop = read({ ...p, y: p.y + 1 }), head = read({ ...p, y: p.y + 2 });
  if (!soil || !crop || !head) return { usable: false, loaded: false };
  if (!SOIL.has(soil.name) || !AIR.has(head.name) || !(AIR.has(crop.name) || soil.name === 'farmland' && crop.name === 'wheat') || !lit(crop)) {
    return { usable: false, loaded: true, soil, crop };
  }
  let watered = false, waterUnknown = false;
  const waterPositions = waters || Array.from({ length: 81 }, (_, i) => ({
    x: p.x + i % 9 - 4, y: p.y, z: p.z + Math.floor(i / 9) - 4 }));
  for (const w of waterPositions) {
    if (w.y === p.y && Math.abs(w.x - p.x) <= 4 && Math.abs(w.z - p.z) <= 4) {
      const water = read(w);
      if (!water) waterUnknown = true;
      if (sourceWater(water)) { watered = true; break; }
    }
  }
  if (!watered) return { usable: false, loaded: !waterUnknown, soil, crop };
  let age = null;
  try { age = crop.getProperties?.().age; } catch { /* Unknown maturity never authorizes harvest. */ }
  return { usable: true, loaded: true, soil, crop, planted: crop.name === 'wheat', mature: crop.name === 'wheat' && age === 7 };
}
function validFarm(farm, home, center) {
  if (!farm || farm.kind !== 'wheat' || farm.server !== home.server ||
      String(farm.dimension).replace(/^minecraft:/, '') !== home.dimension.replace(/^minecraft:/, '') ||
      !validPoint(farm.home_origin) || key(farm.home_origin) !== key(home.origin) ||
      !Array.isArray(farm.plots) || farm.plots.length > MAX_PLOTS) return [];
  const plots = [];
  for (const p of farm.plots) if (withinFarm(p, center, home)) addUnique(plots, p, MAX_PLOTS);
  return plots;
}
function canMakeHoe(actions) {
  const inv = actions.inventoryMap();
  const planks = wood.countPlanks(actions) + wood.totalLogs(actions) * 4;
  // Reserve a whole table when none is carried; a nearby real table can only
  // improve this conservative material check.
  return planks >= 2 + (actions.countItem('stick') >= 2 ? 0 : 2) + (actions.countItem('crafting_table') ? 0 : 4);
}

function inspectFarm({ actions, home, farm = home?.farm || null, plots = 4 }) {
  const result = { kind: 'wheat', loaded: false, condition: 'unknown', plots: [], planted: 0, mature: 0,
    empty: 0, damaged: 0, candidate_plots: 0, candidate_positions: [], nearby_grass: 0, grass_positions: [],
    seeds_available: actions.countItem('wheat_seeds'), hoe_available: HOES.some((n) => actions.countItem(n)),
    can_start: false, needs_work: false, scan_reads: 0, scan_complete: false, scan_pending: false, reason: '' };
  let center;
  try { center = checkedHome(actions.bot, home); }
  catch (err) { result.condition = 'other_world'; result.reason = err.message; return result; }
  const target = Number.isInteger(plots) && plots >= 1 && plots <= MAX_PLOTS ? plots : 4;
  const scan = stateFor(actions.bot, home, center), view = reader(actions.bot), read = (p) => view.read(p);
  const remembered = validFarm(farm, home, center);
  const chosen = [], infos = new Map();
  let unknown = false;
  const consider = (p, waters) => {
    if (chosen.length >= Math.max(target, remembered.length) || infos.has(key(p))) return;
    const info = readPlot(read, p, home, center, waters);
    unknown ||= !info.loaded;
    infos.set(key(p), info);
    if (info.usable) { addUnique(chosen, p, MAX_PLOTS); addUnique(scan.soil, p, 24); }
  };
  for (const p of remembered) consider(p, null);
  for (const p of scan.soil) consider(p, null);
  const nearWater = (w) => {
    if (!sourceWater(read(w))) return;
    addUnique(scan.water, w, 16);
    for (let r = 1; r <= 4 && chosen.length < Math.max(target, remembered.length) && !view.exhausted; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        consider({ x: w.x + dx, y: w.y, z: w.z + dz }, [w]);
      }
    }
  };
  for (const w of scan.water) nearWater(w);
  // A cheap rotating scan advances between snapshots. Missing chunks and an
  // exhausted budget are never presented as proof that no site exists.
  const fullyGrowing = chosen.length >= target && chosen.every((p) => infos.get(key(p)).planted && !infos.get(key(p)).mature);
  const needSeeds = !fullyGrowing && result.seeds_available <
    (chosen.some((p) => infos.get(key(p)).mature) ? 1 : target + 1);
  for (const p of scan.grass) {
    if (GRASS.has(read(p)?.name)) addUnique(result.grass_positions, p, MAX_GRASS);
  }
  while (scan.cursor < scan.positions.length && !view.exhausted &&
      (chosen.length < Math.max(target, remembered.length) || needSeeds && result.grass_positions.length < MAX_GRASS)) {
    const p = scan.positions[scan.cursor++], block = read(p);
    if (!block) { unknown = true; continue; }
    if (sourceWater(block)) nearWater(p);
    if (GRASS.has(block.name) && withinFarm({ ...p, y: p.y - 1 }, center, home)) {
      addUnique(scan.grass, p, MAX_GRASS); addUnique(result.grass_positions, p, MAX_GRASS);
    }
  }
  for (const p of remembered) {
    const info = infos.get(key(p));
    if (info?.loaded && !info.usable) result.damaged++;
  }
  for (const p of chosen) {
    const info = infos.get(key(p));
    if (info.planted) { result.planted++; if (info.mature) result.mature++; result.plots.push(point(p)); }
    else { result.empty++; if (info.soil.name === 'farmland') result.plots.push(point(p)); }
  }
  result.candidate_positions = chosen;
  result.candidate_plots = chosen.length;
  result.nearby_grass = result.grass_positions.length;
  result.scan_reads = view.reads;
  scan.hadUnknown ||= unknown;
  result.scan_complete = scan.cursor >= scan.positions.length && !scan.hadUnknown && !view.exhausted;
  result.scan_pending = !result.scan_complete && chosen.length < target;
  if (scan.cursor >= scan.positions.length) { scan.cursor = 0; scan.hadUnknown = false; }
  result.loaded = chosen.length > 0 && !remembered.some((p) => infos.get(key(p))?.loaded === false);
  result.needs_work = result.mature > 0 || result.empty > 0;
  const seedMinimum = result.mature > 0 ? 1 : 2;
  result.can_start = result.loaded && result.needs_work &&
    (result.seeds_available >= seedMinimum || result.nearby_grass > 0) &&
    (result.mature > 0 || result.empty === 0 || result.hoe_available || canMakeHoe(actions) ||
      chosen.some((p) => infos.get(key(p)).soil.name === 'farmland' && !infos.get(key(p)).planted));
  result.condition = result.loaded ? 'ready' : result.scan_complete ? 'unavailable' : 'unknown';
  result.reason = result.needs_work && result.seeds_available < seedMinimum && !result.nearby_grass ?
    '种子不足以保留一粒备用种，附近尚未确认可取种的草' :
    result.mature ? `${result.mature} 株小麦成熟，可收割并补种` :
    result.planted >= target && !result.empty ? '农田仍在生长，先做其他工作' :
    !chosen.length ? '尚未找到已加载、明亮且靠近天然水源的可用地块' :
    !result.seeds_available && !result.nearby_grass ? '缺少小麦种子，附近尚未确认可取种的草' :
    !result.can_start ? '缺少可用锄头或现成制锄材料' : '已有可建小田的位置和种植材料';
  return result;
}

function farmRecord(home, plots) {
  return { kind: 'wheat', server: home.server, dimension: home.dimension.replace(/^minecraft:/, ''),
    home_origin: point(home.origin), plots: plots.map(point).slice(0, MAX_PLOTS) };
}
function assertUseProtection(actions, p, name) {
  assertProtectedHomeDig(actions.bot, p);
  const config = actions._config;
  if ((config?.get('digBlacklist') || []).includes(name)) throw new Error(`${name} 在禁止修改名单中`);
  const radius = Number(config?.get('spawnProtectionRadius')) || 0;
  if (radius && distance(p, actions.bot.spawnPoint || { x: 0, y: 64, z: 0 }) < radius) throw new Error('农田位于出生保护范围内');
}
function assertDaylight(actions, state, ctx) {
  ctx.checkAborted();
  require('./preparation').assertPreparationSearch({ actions, ctx, operation: '照料农田' });
  const bot = actions.bot, time = bot.time?.timeOfDay;
  if (!Number.isFinite(bot.health) || bot.health <= 8 || !Number.isFinite(time) || time < 0 || time >= 24000 ||
      time >= 12541 && time <= 23458 ||
      bot.entity.isInWater || bot.entity.isInLava || bot.entity.isOnFire ||
      state?.nearbyEntities?.({ radius: 12, limit: 1, hostileOnly: true }).length) {
    throw new Error('当前身体、光照时段或附近威胁不适合照料农田');
  }
}
function assertReach(actions, p) {
  if (actions.bot.entity.onGround !== true || distance(actions.bot.entity.position, p) > 4.5) {
    throw new Error('身体已离开农田操作距离，停止迟到交互');
  }
}
async function withCellGuard(check, run) {
  const inherited = executionContext.getStore();
  return executionContext.run({ ...inherited, preparationCheck: () => {
    inherited?.preparationCheck?.(); check();
  } }, run);
}
async function approach({ actions, nav, ctx, position, home, center }) {
  ctx.checkAborted();
  const bot = actions.bot;
  let stand = null;
  const view = reader(bot, 64);
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
    const p = { x: position.x + dx, y: position.y, z: position.z + dz };
    const support = view.read(p), feet = view.read({ ...p, y: p.y + 1 }), head = view.read({ ...p, y: p.y + 2 });
    if (withinFarm(p, center, home) && support?.boundingBox === 'block' &&
        !['farmland', 'sand', 'gravel', 'magma_block', 'cactus', 'campfire'].includes(support.name) &&
        AIR.has(feet?.name) && AIR.has(head?.name)) { stand = { x: p.x + .5, y: p.y + 1, z: p.z + .5 }; break; }
  }
  if (!stand) throw new Error('农田旁没有已加载的安全站位，停止踩入耕地');
  await nav.goTo({ ...stand, range: .5, signal: ctx.signal, timeoutMs: 10000 });
  ctx.checkAborted();
  if (distance(bot.entity.position, stand) > 1.25 || bot.entity.onGround !== true || distance(bot.entity.position, position) > 4.5) {
    throw new Error('没有实际到达农田的安全操作距离');
  }
}
async function confirm(actions, ctx, read) {
  for (let attempt = 0; attempt < 12; attempt++) {
    ctx.checkAborted();
    if (read()) return true;
    await delay(100, { signal: ctx.signal });
  }
  ctx.checkAborted();
  return false;
}
async function ensureHoe({ actions, nav, state, ctx }) {
  let hoe = HOES.find((n) => actions.countItem(n));
  if (hoe) return hoe;
  if (!canMakeHoe(actions)) throw new Error('缺少现成制锄材料，保留农田候选，不外出盲目搜料');
  const missingSticks = Math.max(0, 2 - actions.countItem('stick'));
  const needed = 2 + (missingSticks ? 2 : 0) + (actions.countItem('crafting_table') ? 0 : 4);
  if (wood.countPlanks(actions) < needed) await wood.makePlanks({ actions, ctx, want: needed - wood.countPlanks(actions) });
  if (missingSticks) await wood.makeSticks({ actions, nav, state, ctx, want: missingSticks, allowSearch: false });
  const table = await wood.ensureCraftingTable({ actions, ctx });
  if (!table.ok) throw new Error(table.reason || '无法准备制锄工作台');
  await actions.craft({ item: 'wooden_hoe', count: 1, signal: ctx.signal });
  ctx.checkAborted();
  hoe = HOES.find((n) => actions.countItem(n));
  if (!hoe) throw new Error('服务端未确认锄头制作完成');
  return hoe;
}

async function tendFarm({ actions, nav, state = null, ctx, config = null, home, farm = home?.farm || null, plots = 4 }) {
  if (!Number.isInteger(plots) || plots < 1 || plots > MAX_PLOTS) throw new Error('农田格数必须为 1 到 8 的整数');
  const center = checkedHome(actions.bot, home);
  if (distance(actions.bot.entity.position, center) > 48) throw new Error('农田只在当前基地附近照料，先返回基地附近');
  return withProtectedHome({ actions, ctx, params: { protected_home: home } }, (bodyCtx) =>
    executionContext.run({ ...executionContext.getStore(), allowTerrainDig: false, allowTerrainPlace: false },
      () => tendFarmOwned({ actions, nav, state, ctx: bodyCtx, config, home, farm, plots, center })));
}
async function tendFarmOwned({ actions, nav, state, ctx, config, home, farm, plots, center }) {
  const before = actions.inventoryMap(), visited = validFarm(farm, home, center), steps = [];
  let seedAttempts = 0;
  let failure = null;
  try {
    assertDaylight(actions, state, ctx);
    const house = require('./building').inspectHome({ actions, state, config, home });
    if (house.inside) {
      const left = await require('./building').leaveHome({ actions, nav, state, ctx, config, home });
      ctx.checkAborted();
      if (!left.ok) throw new Error(left.reason || '尚未实际出门，暂不开始农田工作');
    }
    const inspection = inspectFarm({ actions, home, farm, plots });
    if (!inspection.candidate_plots) throw new Error(inspection.reason);
    if (inspection.needs_work && !inspection.can_start) throw new Error(inspection.reason);
    // Gather only enough seed for this small field, from already observed grass.
    for (const grass of inspection.grass_positions) {
      if (actions.countItem('wheat_seeds') >= Math.max(1, plots - inspection.planted + 1) || seedAttempts >= MAX_GRASS) break;
      assertDaylight(actions, state, ctx);
      if (!GRASS.has(reader(actions.bot, 4).read(grass)?.name)) continue;
      await approach({ actions, nav, ctx, position: { ...grass, y: grass.y - 1 }, home, center });
      seedAttempts++;
      await withCellGuard(() => {
        assertReach(actions, grass);
        const b = reader(actions.bot, 1).read(grass);
        if (!b || !(GRASS.has(b.name) || AIR.has(b.name))) throw new Error('取种前草丛已改变');
      }, () => actions.dig({ ...grass, signal: ctx.signal, reach: false, safe: true, collect: true, collectMovement: false }));
      ctx.checkAborted();
    }
    // Harvest available mature crops before attempting empty cells: a partial
    // field must not let its seed-poor empty cell block the remaining harvest.
    const maturity = (p) => { const view = reader(actions.bot, 96); return readPlot((q) => view.read(q), p, home, center).mature; };
    const positions = inspection.candidate_positions.map((p) => ({ p, mature: maturity(p) }))
      .sort((a, b) => Number(b.mature) - Number(a.mature)).map(({ p }) => p);
    for (const p of positions) {
      assertDaylight(actions, state, ctx);
      const actual = () => { const view = reader(actions.bot, 96); return readPlot((q) => view.read(q), p, home, center); };
      let info = actual();
      if (!info.usable) throw new Error('农田土壤、水源、光照或占用情况已改变');
      if (info.planted && !info.mature) { addUnique(visited, p, MAX_PLOTS); continue; }
      if (actions.countItem('wheat_seeds') < (info.mature ? 1 : 2)) {
        failure = '种子不足以保留一粒备用种，保留植株或耕地'; continue;
      }
      await approach({ actions, nav, ctx, position: p, home, center });
      info = actual();
      if (!info.usable || info.planted && !info.mature) throw new Error('抵达后作物或地块已改变');
      if (info.mature) {
        const crop = { ...p, y: p.y + 1 };
        await withCellGuard(() => {
          assertReach(actions, p);
          const current = actual();
          if (!current.usable || current.planted && !current.mature) throw new Error('收割前作物已改变或尚未成熟');
        }, () => actions.dig({ ...crop, signal: ctx.signal, reach: false, safe: true, collect: true, collectMovement: false }));
        ctx.checkAborted();
        addUnique(visited, p, MAX_PLOTS);
        steps.push('收割成熟小麦');
        info = actual();
      }
      if (!info.usable || info.planted) throw new Error('收割后地块未确认空出，停止重复交互');
      if (actions.countItem('wheat_seeds') < 2) {
        failure = '收割后没有多余种子可补种，保留空田与一粒备用种'; continue;
      }
      if (info.soil.name !== 'farmland') {
        const hoe = await ensureHoe({ actions, nav, state, ctx });
        await actions.holdItem({ item: hoe, signal: ctx.signal });
        assertDaylight(actions, state, ctx);
        info = actual();
        if (!info.usable || info.planted || !['grass_block', 'dirt'].includes(info.soil.name)) throw new Error('装备锄头后土壤已改变');
        actions._assertNotProtected(p.x, p.y, p.z, info.soil.name);
        if (actions.bot.heldItem?.name !== hoe) throw new Error('手持锄头未确认');
        await withCellGuard(() => {
          assertReach(actions, p);
          const current = actual();
          if (!current.usable || current.planted) throw new Error('耕地前目标已改变');
          assertUseProtection(actions, p, current.soil.name);
        }, () => actions._raceAbort(() => actions.bot.activateBlock(info.soil, vec3(0, 1, 0)), ctx.signal, 3000, '耕地交互超时'));
        if (!await confirm(actions, ctx, () => actual().soil?.name === 'farmland')) throw new Error('服务器未确认耕地');
        addUnique(visited, p, MAX_PLOTS);
        steps.push('确认耕地');
      }
      await actions.holdItem({ item: 'wheat_seeds', signal: ctx.signal });
      assertDaylight(actions, state, ctx);
      info = actual();
      if (!info.usable || info.planted || info.soil.name !== 'farmland' || actions.bot.heldItem?.name !== 'wheat_seeds' ||
          actions.countItem('wheat_seeds') < 2) {
        throw new Error('播种前耕地或手持种子已改变');
      }
      assertUseProtection(actions, p, 'farmland');
      await withCellGuard(() => {
        assertReach(actions, p);
        const current = actual();
        if (!current.usable || current.soil.name !== 'farmland' ||
            actions.countItem('wheat_seeds') < (current.planted ? 1 : 2)) throw new Error('播种前目标或备用种已改变');
        assertUseProtection(actions, p, 'farmland');
      }, () => actions._raceAbort(() => actions.bot.placeBlock(info.soil, vec3(0, 1, 0)), ctx.signal, 3000, '播种交互超时'));
      if (!await confirm(actions, ctx, () => actual().planted === true)) throw new Error('服务器未确认小麦播种');
      addUnique(visited, p, MAX_PLOTS);
      steps.push('确认播种小麦');
    }
  } catch (err) {
    ctx.checkAborted();
    if (err instanceof CancelledError || err?.name === 'AbortError') throw err;
    failure = describeFailure(err);
  }
  ctx.checkAborted();
  const record = farmRecord(home, visited), status = inspectFarm({ actions, home, farm: record, plots });
  for (const p of status.plots) addUnique(visited, p, MAX_PLOTS);
  const ok = !failure && status.loaded && status.planted >= plots && status.empty === 0 && status.mature === 0;
  return skillResult(ok, { steps, produced: positiveOnly(wood.diffOf(before, actions.inventoryMap())),
    consumed: positiveOnly(wood.diffOf(actions.inventoryMap(), before)),
    note: `小麦田已确认种植 ${status.planted}/${plots} 格，成熟 ${status.mature} 格`,
    reason: ok ? null : failure || '农田尚未全部播种或补种完成',
    extra: { farm: farmRecord(home, visited), farm_status: status, seed_attempts: seedAttempts,
      farming_complete: ok, growing: ok && status.mature === 0 } });
}

module.exports = { inspectFarm, tendFarm, validFarm, READ_BUDGET, RADIUS };
