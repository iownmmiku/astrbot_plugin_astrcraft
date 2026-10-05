'use strict';

// A compound preparation skill may craft from supplies while sheltering, but
// its dependencies must not silently start gathering through a closed door.
const { executionContext } = require('../goals');
const { skillResult } = require('./common');
const { CancelledError } = require('../util');

function blocked(message) {
  const err = new Error(message);
  err.name = 'PreparationBlockedError';
  return err;
}

function worldOf(bot) {
  const socket = bot?._client?.socket;
  return JSON.stringify([socket?.remoteAddress, socket?.remotePort,
    String(bot?.game?.dimension || '').replace(/^minecraft:/, '')]);
}

function isIndoorStation(position, home) {
  if (!position || !home?.origin || !Number.isInteger(home.size) || !Number.isInteger(home.wall_height) ||
      !['x', 'y', 'z'].every((key) => Number.isFinite(position[key]) && Number.isFinite(home.origin[key]))) return false;
  const p = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
  return p.x > home.origin.x && p.x < home.origin.x + home.size - 1 &&
    p.z > home.origin.z && p.z < home.origin.z + home.size - 1 &&
    p.y >= home.origin.y && p.y < home.origin.y + home.wall_height;
}

async function withPreparation({ actions, state = null, ctx: parentCtx, config = null,
  home = null, allowSearch = true, safeSearch = false }, run) {
  const inherited = executionContext.getStore() || {};
  const indoorHome = home || inherited.indoorHome || null;
  const bot = actions.bot, entity = bot?.entity, client = bot?._client, world = worldOf(bot);
  const controller = new AbortController(), parentSignal = parentCtx?.signal;
  const cancel = () => controller.abort();
  const before = typeof actions.inventoryMap === 'function' ? actions.inventoryMap() : {};
  let homeStatus = null;
  const checkBody = () => {
    if (controller.signal.aborted || parentSignal?.aborted || inherited.signal?.aborted || actions._stopped ||
        actions.bot !== bot || !entity || bot.entity !== entity || bot._client !== client || worldOf(bot) !== world ||
        typeof bot.health === 'number' && bot.health <= 0) {
      cancel();
      throw new CancelledError('准备任务被取消、身体已重生或世界已切换');
    }
  };
  const check = () => {
    checkBody();
    parentCtx?.checkAborted?.();
    inherited.preparationCheck?.();
    if (indoorHome) {
      // Require actual blocks and a closed door every time. History cannot
      // authorize crafting after a roof was removed or a body moved outside.
      homeStatus = require('./building').inspectHome({ actions, state, config, home: indoorHome });
      if (!homeStatus.safe) throw blocked('当前不在完整且关门的基地内，停止室内准备');
    }
  };
  const wrapContext = (base) => {
    const child = Object.create(base || {});
    child.signal = controller.signal;
    child.checkAborted = () => {
      check();
      if (child.deadline && Date.now() > child.deadline) throw new Error('准备依赖的执行预算已用完');
    };
    if (typeof base?.child === 'function') child.child = (scope) => {
      child.checkAborted();
      return wrapContext(base.child.call(child, scope));
    };
    return child;
  };
  const ctx = wrapContext(parentCtx);
  const events = ['respawn', 'death', 'login', 'end'];
  if (parentSignal?.aborted || inherited.signal?.aborted) cancel();
  parentSignal?.addEventListener('abort', cancel, { once: true });
  const inheritedSignal = inherited.signal !== parentSignal ? inherited.signal : null;
  inheritedSignal?.addEventListener('abort', cancel, { once: true });
  for (const event of events) bot?.on?.(event, cancel);
  for (const event of ['respawn', 'login', 'end']) client?.on?.(event, cancel);
  try {
    check();
    return await executionContext.run({ ...inherited, signal: ctx.signal,
      allowOutdoorSearch: inherited.allowOutdoorSearch !== false && allowSearch !== false,
      safeSearch: inherited.safeSearch === true || safeSearch === true,
      indoorHome, preparationCheck: check,
      ...(indoorHome ? { allowTerrainDig: false, allowTerrainPlace: false } : {}) }, async () => {
      const result = await run(ctx);
      check();
      return result;
    });
  } catch (err) {
    checkBody();
    if (err?.name !== 'PreparationBlockedError') throw err;
    const after = typeof actions.inventoryMap === 'function' ? actions.inventoryMap() : {};
    const produced = Object.fromEntries(Object.entries(after).filter(([name, amount]) => amount > (before[name] || 0))
      .map(([name, amount]) => [name, amount - (before[name] || 0)]));
    return skillResult(false, { produced, reason: err.message,
      extra: indoorHome ? { home: indoorHome, home_status: homeStatus } : {} });
  } finally {
    // Any private library continuation that retained this completed scope is
    // obsolete. The parent Task's signal and subsequent skills stay independent.
    cancel();
    parentSignal?.removeEventListener('abort', cancel);
    inheritedSignal?.removeEventListener('abort', cancel);
    for (const event of events) bot?.removeListener?.(event, cancel);
    for (const event of ['respawn', 'login', 'end']) client?.removeListener?.(event, cancel);
  }
}

function assertPreparationSearch({ actions, ctx, operation = '搜集原料' }) {
  ctx?.checkAborted?.();
  const scope = executionContext.getStore();
  scope?.preparationCheck?.();
  if (scope?.indoorHome || scope?.allowOutdoorSearch === false) {
    throw blocked(`室内准备或禁用自动搜料期间不能${operation}，请先补材料并实际出门`);
  }
  if (!scope?.safeSearch) return;
  const bot = actions.bot, health = bot?.health, time = bot?.time?.timeOfDay;
  if (typeof health !== 'number' || !Number.isFinite(health) || health <= 8) {
    throw blocked(`生命值不足或尚未确认，暂不能自动${operation}`);
  }
  if (typeof time !== 'number' || !Number.isFinite(time) || time < 0 || time >= 24000) {
    throw blocked(`服务器时间尚未确认，暂不能自动${operation}`);
  }
  const dimension = String(bot?.game?.dimension || '').replace(/^minecraft:/, '');
  if (!dimension || dimension === 'overworld' && time >= 12541 && time <= 23458) {
    throw blocked(`当前维度未知或主世界处于夜间，暂不能自动${operation}`);
  }
}

module.exports = { withPreparation, assertPreparationSearch, isIndoorStation };
