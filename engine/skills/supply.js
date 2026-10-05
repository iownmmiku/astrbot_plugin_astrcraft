'use strict';

// Base food supply shares the existing physical home/door and verified window
// actions. It never manufactures food, opens an outside chest, or leaves home.
const { executionContext } = require('../goals');
const { skillResult, positiveOnly } = require('./common');
const building = require('./building');
const gathering = require('./gathering');
const wood = require('./wood');
const { vec3, distance, blockCenter, CancelledError, TimeoutError, describeFailure } = require('../util');

const ORDINARY_FOOD = Object.freeze(gathering.READY_FOOD.filter((name) => !['golden_apple', 'enchanted_golden_apple'].includes(name)));
const FOOD_SET = new Set(ORDINARY_FOOD);
const CONTAINERS = new Set(['chest', 'trapped_chest', 'barrel']);
const TRAVEL_MS = 20000, TRAVEL_DISTANCE = 128, REACH = 3.8;

function worldOf(bot) {
  const socket = bot?._client?.socket;
  return JSON.stringify([socket?.remoteAddress, socket?.remotePort, bot?.game?.dimension]);
}

function readBlock(bot, position) {
  try { return bot.blockAt(vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z))); }
  catch { return null; }
}

function safeStanding(bot, position) {
  const floor = readBlock(bot, { ...position, y: position.y - 1 });
  if (!floor || floor.boundingBox !== 'block' || /lava|water|magma|campfire|cactus|fire/.test(floor.name)) return false;
  return [0, 1].every((dy) => {
    const block = readBlock(bot, { ...position, y: position.y + dy });
    return block?.boundingBox === 'empty' && !/lava|water|fire|berry_bush|powder_snow/.test(block.name);
  });
}

async function resupplyFood({ actions, nav, state, ctx: parentCtx, config = null, home, count = 4 }) {
  parentCtx.checkAborted();
  const requested = Number(count);
  if (!Number.isFinite(requested) || requested < 1 || requested > 64) throw new Error('食物目标数量必须在 1 到 64 之间');
  const target = Math.ceil(requested), bot = actions.bot, entity = bot.entity, client = bot._client, world = worldOf(bot);
  const controller = new AbortController(), parentSignal = parentCtx.signal;
  const cancel = () => controller.abort();
  if (parentSignal?.aborted) cancel();
  parentSignal?.addEventListener('abort', cancel, { once: true });
  const lifecycleEvents = ['respawn', 'end', 'login', 'death'];
  for (const event of lifecycleEvents) bot.on?.(event, cancel);
  const ctx = Object.create(parentCtx); ctx.signal = controller.signal;
  try {
    return await executionContext.run({ ...executionContext.getStore(), signal: ctx.signal, allowTerrainDig: false }, async () => {
      const before = actions.inventoryMap(), confirmed = {}, steps = [], failures = [];
      const travelDeadline = Math.min(Date.now() + TRAVEL_MS, parentCtx.deadline || Infinity);
      let homeStatus = null;
      let candidateCount = 0, checkedContainers = 0, scanUnknown = false, stockError = false, initiallyFoundFood = false;
      const countReady = () => ORDINARY_FOOD.reduce((sum, name) => sum + actions.countItem(name), 0);
      const initiallyReady = countReady();
      const checkBody = () => {
        if (ctx.signal.aborted || parentSignal?.aborted || actions._stopped || actions.bot !== bot ||
            bot.entity !== entity || bot._client !== client || worldOf(bot) !== world) {
          cancel();
          throw new CancelledError('基地补给被取消、身体已重生或世界已切换');
        }
      };
      const check = () => { checkBody(); parentCtx.checkAborted(); };
      const inspect = () => {
        check();
        homeStatus = building.inspectHome({ actions, state, config, home });
        return homeStatus;
      };
      const remainingTravel = () => {
        check();
        const remaining = travelDeadline - Date.now();
        if (remaining <= 0) throw new TimeoutError('回基地取食物的寻找/行走预算已用完');
        return remaining;
      };
      const travelCtx = typeof ctx.child === 'function' ? ctx.child('resupply_food:return_home') : Object.create(ctx);
      travelCtx.deadline = travelDeadline;
      travelCtx.checkAborted = () => { remainingTravel(); };
      const finish = (reason = null, failed = false) => {
        checkBody();
        const delta = positiveOnly(wood.diffOf(before, actions.inventoryMap()));
        const produced = {};
        for (const [name, amount] of Object.entries(confirmed)) {
          const actual = Math.min(amount, delta[name] || 0);
          if (actual > 0) produced[name] = actual;
        }
        const total = Object.values(produced).reduce((sum, amount) => sum + amount, 0);
        const ready = countReady(), reached = ready >= target;
        const ok = !failed && homeStatus?.safe === true && (total > 0 || initiallyReady >= target && reached);
        // Prove emptiness conservatively from a complete, successful scan of
        // at most three actual containers that initially held no ordinary food.
        const stockEmpty = homeStatus?.safe === true && candidateCount > 0 && candidateCount <= 3 &&
          checkedContainers === candidateCount && !scanUnknown && !stockError && !initiallyFoundFood;
        return skillResult(ok, { steps, produced,
          note: `基地普通食物 ${ready}/${target} 份${total ? `，实际取到 ${total} 份` : ''}；当前留在屋内`,
          reason: reason || (reached && ok ? null : total && ok ? '仅取到部分普通食物，尚未补齐目标；先使用现有补给，再决定下一步' : '没有取到可确认的普通食物，保留基地与容器记录'),
          extra: { home, home_status: homeStatus, food_ready: ready, target_count: target, reached_target: reached,
            stayed_home: homeStatus?.safe === true, food_stock_checked: stockEmpty, food_stock_empty: stockEmpty } });
      };
      const propagateCancellation = (err) => {
        checkBody();
        if (err instanceof CancelledError || err?.name === 'CancelledError' || err?.name === 'AbortError') throw err;
      };
      try {
        const status = inspect();
        if (status.condition === 'other_world') return finish('基地属于其他服务器或维度，不能从这里取食物', true);
        if (status.distance > TRAVEL_DISTANCE) return finish('基地超过 128 格，当前先就近解决食物', true);
        if (status.condition === 'missing' || status.condition === 'unknown' && home.condition === 'missing') {
          return finish('基地结构已知受损，不能安全回家取食物', true);
        }
        const arrived = await building.returnHome({ actions, nav, state, ctx: travelCtx, config, home,
          sleep: false, waitSeconds: 0, timeoutMs: remainingTravel() });
        check();
        const actualHome = inspect();
        if (!arrived.ok || !actualHome.safe) return finish(arrived.reason || '尚未安全进屋并关闭基地门', true);
        steps.push('实际回基地进屋并确认门已关闭');
        if (countReady() >= target && initiallyReady >= target) return finish();

        const candidates = [];
        for (let dx = 1; dx < home.size - 1; dx += 1) for (let dz = 1; dz < home.size - 1; dz += 1) {
          for (let dy = 0; dy < home.wall_height; dy += 1) {
            const position = { x: home.origin.x + dx, y: home.origin.y + dy, z: home.origin.z + dz };
            const block = readBlock(bot, position);
            if (!block) scanUnknown = true;
            if (CONTAINERS.has(block?.name)) candidates.push(position);
          }
        }
        candidates.sort((a, b) => distance(bot.entity.position, blockCenter(a.x, a.y, a.z)) -
          distance(bot.entity.position, blockCenter(b.x, b.y, b.z)));
        candidateCount = candidates.length;
        if (!candidates.length) return finish(scanUnknown ? '基地屋内仍有未加载地形，不能确认食物库存' :
          '完整基地内没有确认到真实箱子或木桶，不能从屋外箱子替代取食物', true);
        for (const position of candidates.slice(0, 3)) {
          check();
          if (countReady() >= target) break;
          try {
            remainingTravel();
            if (!inspect().safe) return finish('取食物前基地不再安全，停止取物', true);
            const center = blockCenter(position.x, position.y, position.z);
            if (distance(bot.entity.position, center) > REACH) {
              const inside = (point) => point.x >= home.origin.x + 1 && point.x < home.origin.x + home.size - 1 &&
                point.z >= home.origin.z + 1 && point.z < home.origin.z + home.size - 1;
              const landings = [[-1, 0], [1, 0], [0, -1], [0, 1]].map(([dx, dz]) =>
                ({ x: position.x + dx + 0.5, y: home.origin.y, z: position.z + dz + 0.5 }))
                .filter((point) => inside(point) && safeStanding(bot, point))
                .sort((a, b) => distance(bot.entity.position, a) - distance(bot.entity.position, b));
              if (!landings.length) throw new Error('屋内箱子附近没有安全落脚点');
              await nav.goTo({ ...landings[0], range: 0.5, timeoutMs: remainingTravel(), segmented: false, signal: ctx.signal });
              remainingTravel();
              if (distance(bot.entity.position, center) > REACH || !safeStanding(bot, bot.entity.position)) {
                throw new Error('寻路返回后尚未实际走近屋内箱子的安全落脚点');
              }
            }
            if (!inspect().safe) return finish('走近箱子后基地不再安全，停止取物', true);
            const actual = readBlock(bot, position);
            if (!CONTAINERS.has(actual?.name)) throw new Error('屋内容器已改变或尚未加载');
            const opened = await actions.openContainer({ ...position, signal: ctx.signal, reach: false });
            let contents;
            try {
              check();
              if (opened.win !== bot.currentWindow) throw new Error('查看食物的容器窗口已切换');
              contents = opened.describe().items.filter((item) => FOOD_SET.has(item.name) && item.count > 0);
            } finally { opened.win.close(); }
            check();
            checkedContainers += 1;
            if (contents.length) initiallyFoundFood = true;
            if (!contents.length) { failures.push('屋内容器没有普通即食食物，生食与应急金苹果已保留'); continue; }
            for (const item of contents) {
              check();
              if (countReady() >= target) break;
              if (!inspect().safe) return finish('取物期间基地不再安全，停止取物', true);
              const requestedAmount = Math.min(target - countReady(), item.count);
              const result = await actions.withdraw({ ...position, item: item.name, count: requestedAmount,
                signal: ctx.signal, reach: false });
              for (const [name, amount] of Object.entries(result.taken || {})) {
                if (FOOD_SET.has(name) && Number.isFinite(amount) && amount > 0) confirmed[name] = (confirmed[name] || 0) + amount;
              }
              check();
              if (!inspect().safe) return finish('食物已取到，但取物后基地不再安全', true);
              if (!result.ok) failures.push(result.reason || '服务端没有确认食物实际转移');
              else steps.push(`从屋内 ${actual.name} 核验取得普通食物`);
            }
          } catch (err) {
            propagateCancellation(err);
            stockError = true;
            // A parent or travel budget expiration stops the chain while keeping
            // food already proved by Actions.withdraw and the final inventory.
            if (parentCtx.deadline && Date.now() > parentCtx.deadline || Date.now() >= travelDeadline) {
              return finish(`食物补给预算已用完：${describeFailure(err)}`, true);
            }
            failures.push(`屋内容器取食物失败：${describeFailure(err)}`);
          }
        }
        check();
        if (!inspect().safe) return finish('取食物后基地不再安全，停止后续操作', true);
        return finish(failures.length ? failures.join('；') : null);
      } catch (err) {
        propagateCancellation(err);
        return finish(`无法完成基地食物补给：${describeFailure(err)}`, true);
      }
    });
  } finally {
    parentSignal?.removeEventListener('abort', cancel);
    for (const event of lifecycleEvents) bot.removeListener?.(event, cancel);
  }
}

module.exports = { resupplyFood, ORDINARY_FOOD };
