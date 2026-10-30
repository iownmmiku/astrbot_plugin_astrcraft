'use strict';
const { vec3, distance, CancelledError, describeFailure } = require('../util');
const { skillResult, isStableSupport, canOpenCellSafely } = require('./common');
const { executionContext } = require('../goals');
const visits = new WeakMap();

async function exploreNearby({ actions, nav, state, ctx, config = null, home, radius = 24 }) {
  if (!Number.isInteger(radius) || radius < 8 || radius > 32) throw new Error('探索半径必须为 8–32 格');
  const bot = actions.bot, entity = bot.entity, client = bot._client, dimension = bot.game?.dimension;
  const building = require('./building');
  let status = building.inspectHome({ actions, state, config, home });
  if (status.condition !== 'intact' || !status.loaded) return skillResult(false, { reason: '基地尚未实际确认完整，先走近核验再探索' });
  const center = { x: home.origin.x + home.size / 2, y: home.origin.y, z: home.origin.z + home.size / 2 };
  if (distance(bot.entity.position, center) > radius) return skillResult(false, { reason: '已超出本次基地探索半径，先返回基地附近' });
  const controller = new AbortController();
  const abort = () => controller.abort();
  const check = () => {
    ctx.checkAborted();
    if (controller.signal.aborted || actions._stopped || actions.bot !== bot || bot.entity !== entity ||
        bot._client !== client || bot.game?.dimension !== dimension) throw new CancelledError('探索被取消或身体已改变');
    if (distance(bot.entity.position, center) > radius) { abort(); throw new CancelledError('探索路线越过基地半径'); }
    const time = bot.time?.timeOfDay;
    if (!Number.isFinite(bot.health) || bot.health <= 8 || !Number.isFinite(bot.food) || bot.food <= 10 ||
        !Number.isFinite(time) || time < 0 || time >= 24000 || time >= 12541 && time <= 23458 ||
        entity.isInWater || entity.isInLava || entity.isOnFire ||
        state?.nearbyEntities?.({ radius: 12, limit: 1, hostileOnly: true })?.length) {
      abort(); throw new CancelledError('探索条件改变，先处理危险、饥饿或夜晚');
    }
  };
  const tick = () => { try { check(); } catch { abort(); } };
  ctx.signal?.addEventListener('abort', abort, { once: true });
  for (const event of ['end', 'respawn']) bot.on?.(event, abort);
  bot.on?.('physicsTick', tick);
  const local = Object.create(ctx); local.signal = controller.signal; local.checkAborted = check;
  const key = JSON.stringify([home.server, home.dimension, home.origin]);
  let records = visits.get(actions);
  if (!records) { records = new Map(); visits.set(actions, records); }
  let seen = records.get(key);
  if (!seen) { seen = new Map(); records.set(key, seen); }
  while (records.size > 8) records.delete(records.keys().next().value);
  const now = Date.now();
  for (const [point, at] of seen) if (now - at > 600000) seen.delete(point);
  const block = (p) => bot.blockAt(vec3(p.x, p.y, p.z));
  const safe = (p) => {
    const feet = block(p), head = block({ ...p, y: p.y + 1 });
    return feet?.boundingBox === 'empty' && head?.boundingBox === 'empty' &&
      isStableSupport(block({ ...p, y: p.y - 1 })) && canOpenCellSafely(bot, p.x, p.y, p.z) && canOpenCellSafely(bot, p.x, p.y + 1, p.z);
  };
  try {
    return await executionContext.run({ ...executionContext.getStore(), signal: controller.signal,
      allowTerrainDig: false, allowTerrainPlace: false }, async () => {
      check();
      if (status.inside) {
        const left = await building.leaveHome({ actions, nav, state, ctx: local, config, home, timeoutMs: 12000 });
        check();
        if (!left.ok) return skillResult(false, { reason: left.reason || '尚未实际出基地，暂不探索' });
      }
      const candidates = [];
      for (const ring of [Math.min(radius - 2, 18), Math.min(radius - 2, 10), 6]) {
        for (let i = 0; i < 16; i++) for (const dy of [0, 1, -1, 2, -2]) {
          const angle = i * Math.PI / 8;
          const point = { x: Math.floor(center.x + Math.cos(angle) * ring), y: home.origin.y + dy, z: Math.floor(center.z + Math.sin(angle) * ring) };
          const id = JSON.stringify(point);
          if (seen.has(id) || distance(bot.entity.position, point) < 4 || distance(center, point) > radius - 1) continue;
          if (point.x >= home.origin.x && point.x < home.origin.x + home.size && point.z >= home.origin.z && point.z < home.origin.z + home.size) continue;
          if (safe(point)) candidates.push({ point, id });
        }
      }
      if (!candidates.length) return skillResult(false, { reason: '当前半径内没有新的已加载安全落点，保留基地位置，稍后观察其它方向' });
      // One destination per task; failed routes are not retried indefinitely.
      candidates.sort((a, b) => distance(bot.entity.position, a.point) - distance(bot.entity.position, b.point));
      const { point, id } = candidates[0];
      seen.set(id, now);
      while (seen.size > 128) seen.delete(seen.keys().next().value);
      ctx.progress(`在基地 ${radius} 格内探索已加载安全地面`);
      await nav.goTo({ x: point.x + .5, y: point.y, z: point.z + .5, range: .8, segmented: false,
        timeoutMs: Math.max(1, Math.min(15000, (ctx.deadline || Date.now() + 15000) - Date.now())),
        signal: controller.signal, onTick: tick });
      check();
      const actual = bot.entity.position;
      if (distance(actual, { x: point.x + .5, y: point.y, z: point.z + .5 }) > 1.5 ||
          !safe({ x: Math.floor(actual.x), y: Math.floor(actual.y), z: Math.floor(actual.z) })) {
        return skillResult(false, { reason: '寻路返回后未实际抵达安全落点，不计为探索成功' });
      }
      return skillResult(true, { note: '已实际到达基地附近的新安全落点', extra: { position: { x: actual.x, y: actual.y, z: actual.z },
        home, radius, visited: seen.size } });
    });
  } catch (error) {
    if (controller.signal.aborted || error instanceof CancelledError || error?.name === 'AbortError') throw new CancelledError(error.message);
    return skillResult(false, { reason: `有限探索未完成：${describeFailure(error)}` });
  } finally {
    ctx.signal?.removeEventListener('abort', abort);
    for (const event of ['end', 'respawn']) bot.removeListener?.(event, abort);
    bot.removeListener?.('physicsTick', tick);
  }
}

module.exports = { exploreNearby };
