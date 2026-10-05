'use strict';

// Collection and returning to a usable body position are separate obligations.
// The fixed checkpoint also survives composite skills that discard child fields.
const { executionContext } = require('../goals');
const { CancelledError, delay, distance, vec3, describeFailure } = require('../util');
const common = require('./common');

const RETURN_STATUS_KEY = 'mining:return_status';
const HAZARDS = new Set(['water', 'lava', 'bubble_column', 'fire', 'soul_fire', 'magma_block',
  'cactus', 'campfire', 'soul_campfire', 'sweet_berry_bush', 'wither_rose', 'powder_snow']);
const FALLING = new Set(['sand', 'red_sand', 'gravel', 'anvil', 'chipped_anvil', 'damaged_anvil']);

function positionOf(bot) {
  const p = bot?.entity?.position;
  return p && ['x', 'y', 'z'].every((axis) => Number.isFinite(p[axis]))
    ? { x: p.x, y: p.y, z: p.z } : null;
}

function worldOf(bot) {
  const client = bot?._client, socket = client?.socket;
  const host = socket?.remoteAddress || client?.host;
  const port = socket?.remotePort || client?.port;
  return { server: host ? `${host}${port ? `:${port}` : ''}` : null,
    dimension: bot?.game?.dimension ? String(bot.game.dimension).replace(/^minecraft:/, '') : null };
}

function protectedHomeError(message) {
  const error = new Error(message);
  error.name = 'ProtectedHomeError';
  return error;
}

function validProtectedHome(home) {
  return !!home && typeof home.server === 'string' && !!home.server &&
    typeof home.dimension === 'string' && !!home.dimension && !!home.origin &&
    ['x', 'y', 'z'].every((axis) => Number.isInteger(home.origin[axis]) && Math.abs(home.origin[axis]) < 32000000) &&
    Number.isInteger(home.size) && home.size >= 4 && home.size <= 8 &&
    Number.isInteger(home.wall_height) && home.wall_height >= 2 && home.wall_height <= 4;
}

function homeMatchesWorld(bot, home) {
  const world = worldOf(bot);
  return home.server === world.server && home.dimension.replace(/^minecraft:/, '') === world.dimension;
}

/** Protect the complete structure, including its foundation and roof. */
function isProtectedHomePosition(bot, point) {
  const home = executionContext.getStore()?.protectedHome;
  if (!validProtectedHome(home) || !homeMatchesWorld(bot, home) || !point ||
      !['x', 'y', 'z'].every((axis) => Number.isFinite(point[axis]))) return false;
  const p = { x: Math.floor(point.x), y: Math.floor(point.y), z: Math.floor(point.z) };
  return p.x >= home.origin.x && p.x < home.origin.x + home.size &&
    p.z >= home.origin.z && p.z < home.origin.z + home.size &&
    p.y >= home.origin.y - 1 && p.y <= home.origin.y + home.wall_height;
}

function assertProtectedHomeDig(bot, point) {
  if (isProtectedHomePosition(bot, point)) {
    throw protectedHomeError('自动采集和返程不能挖掘受保护基地的地基、墙、家具或屋顶');
  }
}

/** The same world-bound structure lease follows every implicit dependency. */
async function withProtectedHome(options, run) {
  const inherited = executionContext.getStore() || {};
  const explicit = options.params?.protected_home;
  const home = explicit === undefined || explicit === null ? inherited.protectedHome : explicit;
  if (home === undefined || home === null) return run(options.ctx);
  if (!validProtectedHome(home)) throw protectedHomeError('受保护基地缺少有效世界、坐标或结构尺寸');
  if (!homeMatchesWorld(options.actions.bot, home)) {
    throw protectedHomeError('受保护基地不属于当前服务器或维度，停止自动采集');
  }
  // Freeze a copy so a later plan edit cannot move the bounds of an active job.
  const protectedHome = Object.freeze({ server: home.server,
    dimension: home.dimension.replace(/^minecraft:/, ''),
    origin: Object.freeze({ ...home.origin }), size: home.size, wall_height: home.wall_height });
  return withMiningBody(options, (ctx) => executionContext.run({ ...executionContext.getStore(), protectedHome,
    allowTerrainDig: false },
    () => run(ctx)));
}

function blockAt(bot, p) {
  try { return bot.blockAt(vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))); }
  catch { return null; }
}

function hazardous(block) {
  if (!block) return true;
  const name = String(block.name || '').replace(/^minecraft:/, '');
  if (HAZARDS.has(name)) return true;
  try { return block.getProperties?.()?.waterlogged === true; }
  catch { return true; }
}

/** A known stable support, a clear body volume, and enough loaded surface data. */
function inspectReturnSafety(bot) {
  const p = positionOf(bot);
  const result = { safe: false, loaded: false, on_ground: bot?.entity?.onGround === true, underground: null };
  if (!p || bot._client?.state && bot._client.state !== 'play' || bot._client?.socket?.destroyed) return result;
  const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
  const open = (b) => b && b.boundingBox === 'empty' && !hazardous(b);
  // A player's 0.6-block body can rest on the edge of a block while its
  // centre lies over the adjacent air cell. Validate the actual footprint;
  // onGround alone or a claimed navigation result is still insufficient.
  const halfWidth = 0.3 - 1e-6;
  let stable = true, supported = false, loaded = true;
  for (let bx = Math.floor(p.x - halfWidth); bx <= Math.floor(p.x + halfWidth); bx++) {
    for (let bz = Math.floor(p.z - halfWidth); bz <= Math.floor(p.z + halfWidth); bz++) {
      const support = blockAt(bot, { x: bx, y: y - 1, z: bz });
      const feet = blockAt(bot, { x: bx, y, z: bz }), head = blockAt(bot, { x: bx, y: y + 1, z: bz });
      const name = String(support?.name || '').replace(/^minecraft:/, '');
      if (!support || !feet || !head) loaded = false;
      if (!open(feet) || !open(head) || hazardous(support) || FALLING.has(name) || name.endsWith('_concrete_powder')) stable = false;
      if (support?.boundingBox === 'block' && !hazardous(support) && !FALLING.has(name) &&
          !name.endsWith('_concrete_powder')) supported = true;
    }
  }
  stable = stable && supported;
  // Also reject standing at a fluid or damage boundary. Unknown neighbours are
  // not evidence of a safe landing, particularly immediately after chunk reload.
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const adjacent = blockAt(bot, { x: x + dx, y, z: z + dz });
    if (!adjacent) loaded = false;
    if (hazardous(adjacent)) stable = false;
  }
  let samples = 0;
  for (const [dx, dz] of [[6, 0], [-6, 0], [0, 6], [0, -6]]) {
    for (let sy = y + 40; sy >= y - 8; sy -= 1) {
      const b = blockAt(bot, { x: x + dx, y: sy, z: z + dz });
      if (!b) break;
      if (b.boundingBox === 'block') { samples += 1; break; }
    }
  }
  result.loaded = loaded && samples >= 3;
  if (result.loaded) result.underground = common.isUnderground(bot);
  result.safe = result.loaded && stable && result.on_ground && result.underground === false &&
    (!Number.isFinite(bot.entity.velocity?.y) || Math.abs(bot.entity.velocity.y) <= 0.12);
  return result;
}

function safePosition(bot) { return inspectReturnSafety(bot).safe; }

function captureReturnTarget(checkpoint, actions) {
  if (Object.hasOwn(checkpoint, 'returnTarget')) return checkpoint.returnTarget;
  const bot = actions.bot;
  checkpoint.returnWorld = worldOf(bot);
  // Store null as well: a replay that happens to be standing in a newly dug
  // tunnel must never redefine that tunnel as the original mine entrance.
  checkpoint.returnTarget = safePosition(bot) ? positionOf(bot) : null;
  return checkpoint.returnTarget;
}

function publishReturn(ctx, status) {
  const previous = ctx?._checkpoints?.get(RETURN_STATUS_KEY);
  // A second dependency that happens to start underground cannot erase the
  // first dependency's obligation. A verified safe final position can clear it.
  if (status.ok || !previous || previous.ok !== false) ctx?._checkpoints?.set(RETURN_STATUS_KEY, status);
  else if (previous?.ok === false) ctx?._checkpoints?.set(RETURN_STATUS_KEY,
    { ...status, target: status.target || previous.target, required: true });
  return status;
}

function rethrowControl(err, ctx, actions) {
  if (ctx?.signal?.aborted || actions._stopped || err instanceof CancelledError ||
      err?.name === 'CancelledError' || err?.name === 'AbortError') {
    throw err instanceof CancelledError ? err : new CancelledError(err?.message || '采矿被取消');
  }
}

/** Cancel every retained continuation when the body, connection or world changes. */
async function withMiningBody({ actions, ctx: parentCtx }, run) {
  const inherited = executionContext.getStore() || {};
  const bot = actions.bot, entity = bot?.entity, client = bot?._client;
  const world = JSON.stringify(worldOf(bot));
  const controller = new AbortController(), cancel = () => controller.abort();
  const signals = [...new Set([parentCtx?.signal, inherited.signal].filter(Boolean))];
  const checkBody = () => {
    if (controller.signal.aborted || signals.some((s) => s.aborted) || actions._stopped ||
        actions.bot !== bot || !entity || bot.entity !== entity || bot._client !== client ||
        JSON.stringify(worldOf(bot)) !== world || typeof bot.health === 'number' && bot.health <= 0 ||
        client && client.state && client.state !== 'play' || client?.socket?.destroyed) {
      cancel();
      throw new CancelledError('采矿返程被取消、身体已重生或世界已切换');
    }
  };
  const check = () => { checkBody(); parentCtx?.checkAborted?.(); inherited.preparationCheck?.(); };
  const wrap = (base) => {
    const ctx = Object.create(base || {});
    ctx.signal = controller.signal;
    ctx.checkAborted = check;
    if (typeof base?.child === 'function') ctx.child = (scope) => {
      ctx.checkAborted(); return wrap(base.child.call(ctx, scope));
    };
    return ctx;
  };
  const ctx = wrap(parentCtx);
  const botEvents = ['death', 'respawn', 'login', 'end'];
  const clientEvents = ['respawn', 'login', 'end'];
  for (const signal of signals) signal.addEventListener('abort', cancel, { once: true });
  for (const event of botEvents) bot?.on?.(event, cancel);
  for (const event of clientEvents) client?.on?.(event, cancel);
  try {
    check();
    return await executionContext.run({ ...inherited, signal: ctx.signal, preparationCheck: check },
      async () => { const result = await run(ctx); checkBody(); return result; });
  } catch (err) { checkBody(); throw err; }
  finally {
    cancel();
    for (const signal of signals) signal.removeEventListener('abort', cancel);
    for (const event of botEvents) bot?.removeListener?.(event, cancel);
    for (const event of clientEvents) client?.removeListener?.(event, cancel);
  }
}

/** Try the remembered open route before spending blocks or making new tunnels. */
async function returnFromMining({ actions, nav, ctx, checkpoint = null, target = null,
  maxSteps = 40, reserveItems = {}, routeTimeoutMs = 8000 }) {
  const bot = actions.bot, world = worldOf(bot);
  const saved = checkpoint?.returnTarget || target;
  const returnTarget = saved && ['x', 'y', 'z'].every((axis) => Number.isFinite(saved[axis]))
    ? { x: saved.x, y: saved.y, z: saved.z } : null;
  const expectedWorld = checkpoint?.returnWorld || world;
  const status = { required: !safePosition(bot) || !!returnTarget && distance(positionOf(bot), returnTarget) > 0.9,
    ok: false, target: returnTarget, reason: null, position: positionOf(bot), ...world };
  const finish = (ok, reason = null, extra = {}) => {
    rethrowControl(null, ctx, actions);
    status.ok = ok; status.reason = reason; status.position = positionOf(bot);
    return { ...extra, return_status: publishReturn(ctx, status) };
  };
  if (expectedWorld.server !== world.server || expectedWorld.dimension !== world.dimension) {
    throw new CancelledError('矿洞入口属于不同服务器或维度，停止返程');
  }
  // No material action is needed when she is still at the safe entry cell.
  if (safePosition(bot) && (!returnTarget || distance(positionOf(bot), returnTarget) <= 0.9)) {
    return finish(true, null, { climbed: 0, note: '' });
  }
  let routeFailure = null;
  if (returnTarget && distance(positionOf(bot), returnTarget) <= 128 && typeof nav?.goTo === 'function') {
    try {
      ctx.checkAborted();
      ctx.progress('先沿可通行的原路返回矿洞入口');
      const remaining = ctx.deadline ? ctx.deadline - Date.now() : routeTimeoutMs;
      if (remaining <= 0) throw new Error('采矿预算已用完，尚未完成返程');
      await executionContext.run({ ...executionContext.getStore(), allowTerrainDig: false, allowTerrainPlace: false }, () =>
        nav.goTo({ ...returnTarget, range: 0.6, signal: ctx.signal,
          timeoutMs: Math.max(1, Math.min(routeTimeoutMs, remaining)), segmented: false }));
      ctx.checkAborted();
      if (distance(positionOf(bot), returnTarget) <= 0.9 && safePosition(bot)) {
        return finish(true, null, { climbed: 0, note: '（已沿原路安全返回矿洞入口）' });
      }
      routeFailure = '寻路结束但未实际回到加载且安全的矿洞入口';
    } catch (err) {
      rethrowControl(err, ctx, actions);
      routeFailure = describeFailure(err);
    }
  }
  let climbed = 0;
  try {
    ctx.checkAborted();
    // Mining may just have removed the support. Do not attempt a jump while
    // falling; preserve the original deadline and parent cancellation.
    const settleDeadline = Date.now() + Math.min(6000,
      ctx.deadline ? Math.max(0, ctx.deadline - Date.now()) : 6000);
    while (!bot.entity.onGround && Date.now() < settleDeadline) {
      ctx.checkAborted(); await delay(100, { signal: ctx.signal });
    }
    ctx.checkAborted();
    if (!bot.entity.onGround) throw new Error('还未稳定落地，停止冒险爬升');
    ctx.progress('原路返回受阻，尝试安全爬回地面');
    const result = await common.climbToSurface({ actions, nav, ctx, maxSteps, reserveItems });
    ctx.checkAborted(); climbed = result?.steps || 0;
    // A resolved navigation call or an unloaded sky is never proof of rescue.
    if (safePosition(bot)) return finish(true, null,
      { climbed, note: `（已经安全爬回地面，挖了/垫了 ${climbed} 格）` });
    return finish(false, result?.reason || routeFailure || '仍在地下，或落点未加载、不稳定或有危险',
      { climbed, note: `（还未安全返程，爬了 ${climbed} 格）` });
  } catch (err) {
    rethrowControl(err, ctx, actions);
    return finish(false, describeFailure(err), { climbed, note: '（采集结束，但安全返程尚未完成）' });
  }
}

module.exports = { RETURN_STATUS_KEY, positionOf, worldOf, inspectReturnSafety, safePosition, captureReturnTarget,
  publishReturn, rethrowControl, withMiningBody, returnFromMining,
  isProtectedHomePosition, assertProtectedHomeDig, withProtectedHome };
