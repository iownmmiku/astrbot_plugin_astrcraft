'use strict';
/**
 * **铺路与挖通**（B 批次，见 docs/ESCAPE_ABILITIES.md）。
 *
 * 用户反馈："她好像没有铺路，挖掘挡路的方块，以及从地下垫上来的能力"
 * 核对结果：三件事全都没有（或者藏在内部、她调不到）。这个模块补上后两件
 * （"从地下垫上来"已经在 A 批次通过 climb_out 暴露了）。
 *
 * ## 为什么这两件事必须她自己能做
 *
 * 之前的设计是"**走路不改动世界**"——`move.to` 永远不挖、不垫。
 * 那是对的（不能让寻路随手拆掉玩家的房子），但缺了另一半：
 * **她得有"主动改造地形"的工具**。否则遇到下面两种情况就只能干等：
 *   - 目标在 2 格高的台子上 → 跳不上去，也不会垫
 *   - 目标隔着一条沟/一片岩浆 → 走不过去，也不会搭桥
 * 而 `mc_plan_route` 只**描述**"要挖哪几格"，真正挖掘要靠 `mc_mine` 逐格——
 * 一轮 6 步最多挖几格，**她永远挖不通一条路**。
 */

const { skillResult, pillarUpOne, isDangerousBlock } = require('./common');
const { vec3, delay, distance } = require('../util');
const log = require('../log');

/** 她背包里能拿来垫的方块（按"舍得用"排序） */
const PAVE_BLOCKS = [
  'cobblestone',
  'stone',
  'dirt',
  'oak_planks',
  'spruce_planks',
  'birch_planks',
  'sand',
  'gravel',
  'netherrack',
  'andesite',
  'diorite',
  'granite',
];

function pickPaveBlock(actions, want) {
  if (want) {
    const n = String(want).replace(/^minecraft:/, '').toLowerCase();
    if (actions.countItem(n) > 0) return n;
    return null;
  }
  for (const n of PAVE_BLOCKS) {
    if (actions.countItem(n) > 0) return n;
  }
  return null;
}

const isAir = (b) => !!b && (b.boundingBox === 'empty' || b.name === 'air');

/**
 * **铺路 / 垫高**。
 *
 * @param direction 'forward'（往前铺，跨过坑/岩浆/水）| 'up'（垂直垫高自己）
 * @param count     铺几格
 */
async function pave({ actions, nav, ctx, direction = 'forward', count = 4, item = null }) {
  const bot = actions.bot;
  const dir = String(direction || 'forward').toLowerCase();
  const n = Math.max(1, Math.min(32, Number(count) || 4));

  if (dir === 'up') {
    // **垂直垫高**：复用 climbToSurface 里那个经过实测的垫脚上升。
    // 它的时序是踩过坑的：跳起来 → 等**真的离地 0.7 格以上** → 趁空中往脚下放。
    // （站地上放会被服务端拒绝："the block is still there"。）
    let done = 0;
    for (let i = 0; i < n; i += 1) {
      ctx.checkAborted();
      const p = bot.entity.position;
      const bx = Math.floor(p.x);
      const by = Math.floor(p.y);
      const bz = Math.floor(p.z);
      // 先把头顶腾出来（不然跳不起来）
      const head = bot.blockAt(vec3(bx, by + 2, bz));
      if (head && head.boundingBox === 'block') {
        if (!head.diggable || isDangerousBlock(head.name)) {
          return skillResult(done > 0, {
            note: `垫了 ${done} 格，头顶被 ${head.name} 挡住且挖不动`,
            reason: '头顶有挖不动的方块',
            extra: { paved: done, direction: 'up' },
          });
        }
        await actions.dig({ x: bx, y: by + 2, z: bz, signal: ctx.signal, collect: true });
      }
      const ok = await pillarUpOne({ actions, ctx, bx, by, bz });
      if (!ok) break;
      done += 1;
      ctx.progress(`垫高 ${done}/${n} 格`);
    }
    if (!done) {
      const have = pickPaveBlock(actions, item);
      return skillResult(false, {
        note: have
          ? '垫高失败（跳起来放方块没成，可能是头顶太矮或者位置不对）'
          : '垫高失败：**背包里没有能垫的方块**（石头/泥土/木板都行）',
        reason: have ? '垫脚上升没成功' : '没有方块可垫',
        extra: { paved: 0, direction: 'up' },
      });
    }
    return skillResult(true, {
      note: `垫高了 ${done} 格`,
      consumed: {},
      extra: { paved: done, direction: 'up' },
    });
  }

  // ---- 水平铺路：往她面朝的方向，逐格在"前方脚下那一层"放方块 ----
  const blockName = pickPaveBlock(actions, item);
  if (!blockName) {
    return skillResult(false, {
      note: '铺路失败：**背包里没有能垫的方块**（石头/泥土/木板都行，先去挖点）',
      reason: '没有方块',
      extra: { paved: 0, direction: 'forward' },
    });
  }
  let done = 0;
  let skippedDanger = 0;
  for (let i = 0; i < n; i += 1) {
    ctx.checkAborted();
    const p = bot.entity.position;
    const bx = Math.floor(p.x);
    const by = Math.floor(p.y);
    const bz = Math.floor(p.z);
    // 朝她看的方向走（玩家视角）
    const yaw = bot.entity.yaw || 0;
    const dx = Math.round(-Math.sin(yaw));
    const dz = Math.round(-Math.cos(yaw));
    if (dx === 0 && dz === 0) break;
    const tx = bx + dx;
    const tz = bz + dz;
    // **铺路要放在"她脚下的支撑层"（by - 1），不是她脚那一层（by）** ——
    // 这是我第一版写错的地方，实测后果：放了 1 块就走不过去（x 只动了 0.5）。
    //
    // 为什么：要站在 (tx, by) 这一格上，**下面 (tx, by-1) 必须是实心**。
    // 放在 `by` 等于把方块塞进她自己的身体高度——那一格本来是空的，
    // 填上之后她反而站不进去了（pathfinder 判"站不上去"）。
    // 真人搭桥也是这么做的：**往脚下的那一层垫**，然后走过去。
    const supportY = by - 1;
    const support = bot.blockAt(vec3(tx, supportY, tz));
    if (!support) break;
    if (support.boundingBox === 'block') {
      // 支撑层已经是实心的 → 这一格不用垫，直接走上去
      const feet = bot.blockAt(vec3(tx, by, tz));
      const head = bot.blockAt(vec3(tx, by + 1, tz));
      if (isAir(feet) && isAir(head)) {
        try {
          await nav.goTo({ x: tx, y: by, z: tz, range: 0.9, signal: ctx.signal, timeoutMs: 6000 });
          continue;
        } catch (err) {
          if (err && err.name === 'CancelledError') throw err;
          break;
        }
      }
      // 脚下被实心占着（比如 1 格台阶）→ 试着跳上去
      const up = bot.blockAt(vec3(tx, by + 1, tz));
      if (isAir(up)) {
        try {
          await nav.goTo({ x: tx, y: by + 1, z: tz, range: 0.9, signal: ctx.signal, timeoutMs: 6000 });
          continue;
        } catch (err) {
          if (err && err.name === 'CancelledError') throw err;
          break;
        }
      }
      break;
    }
    if (isDangerousBlock(support.name)) {
      // 支撑层是岩浆/水 —— 垫上去也站不住
      skippedDanger += 1;
      break;
    }
    // 她自己的身体高度那一格必须空着（不然放下去她会被卡住）
    const feetNow = bot.blockAt(vec3(tx, by, tz));
    const headNow = bot.blockAt(vec3(tx, by + 1, tz));
    if (!isAir(feetNow) || !isAir(headNow)) break;
    try {
      await actions.place({
        x: tx,
        y: supportY,
        z: tz,
        item: blockName,
        signal: ctx.signal,
        reach: true,
      });
      done += 1;
      ctx.progress(`铺路 ${done}/${n} 格`);
    } catch (err) {
      if (err && err.name === 'CancelledError') throw err;
      log.debug(`铺第 ${done + 1} 格失败：${err.message}`);
      break;
    }
    // 站到刚铺的那块上（她仍然在 by 这一层，只是脚下有东西了）
    try {
      await nav.goTo({ x: tx, y: by, z: tz, range: 0.9, signal: ctx.signal, timeoutMs: 6000 });
    } catch (err) {
      if (err && err.name === 'CancelledError') throw err;
      break;
    }
  }
  if (!done) {
    return skillResult(false, {
      note: skippedDanger
        ? '没能铺过去：前面是**岩浆/水**，垫上去也站不住'
        : '没能铺路（前面不是空的，或者放了没站上去）',
      reason: skippedDanger ? '前方是危险液体' : '铺路没有进展',
      extra: { paved: 0, direction: 'forward', danger: skippedDanger },
    });
  }
  return skillResult(true, {
    note: `往前铺了 ${done} 格（用 ${blockName}）`,
    consumed: { [blockName]: done },
    extra: { paved: done, direction: 'forward', item: blockName },
  });
}

/**
 * **挖通一条路**：把挡路的方块真的挖掉，再走过去。
 *
 * 为什么需要：`mc_plan_route` 只**描述**"要挖哪几格"（"挡路的大概是 stone×3"），
 * 真正的挖掘要靠 `mc_mine` 逐格——而一轮 6 步最多挖几格，
 * **她永远挖不通一条路**。这个技能一次把整条路挖通。
 *
 * @param max_blocks 最多挖几格（默认 8，防止她一次挖穿半座山）
 */
async function digPath({ actions, nav, ctx, x, y = null, z, maxBlocks = 8 }) {
  const bot = actions.bot;
  const limit = Math.max(1, Math.min(48, Number(maxBlocks) || 8));
  const me = bot.entity.position;
  const dx = Number(x) - me.x;
  const dz = Number(z) - me.z;
  const len = Math.hypot(dx, dz) || 1;
  const stepX = dx / len;
  const stepZ = dz / len;
  const by = Math.floor(me.y);

  const dug = [];
  const failed = [];
  // 沿直线往前看，把"脚和头那一层的实心方块"挖掉
  for (let i = 1; i <= limit && dug.length + failed.length < limit; i += 1) {
    ctx.checkAborted();
    const cx = Math.floor(me.x + stepX * i);
    const cz = Math.floor(me.z + stepZ * i);
    for (const cy of [by + 1, by]) {
      if (dug.length + failed.length >= limit) break;
      const b = bot.blockAt(vec3(cx, cy, cz));
      if (!b) continue;
      if (b.boundingBox !== 'block') continue; // 空的，不用挖
      if (isDangerousBlock(b.name)) {
        return skillResult(dug.length > 0, {
          note: `挖到 ${b.name} 就停了（危险方块，不能挖穿）`,
          reason: '前方是岩浆/水等危险方块',
          extra: { dug: dug.length, danger: b.name },
        });
      }
      if (!b.diggable) {
        failed.push({ x: cx, y: cy, z: cz, name: b.name });
        continue;
      }
      // 够不着就先走过去
      const dist = distance(bot.entity.position, { x: cx + 0.5, y: cy + 0.5, z: cz + 0.5 });
      if (dist > 4) {
        try {
          await nav.goTo({ x: cx, y: null, z: cz, range: 3, signal: ctx.signal, timeoutMs: 12000 });
        } catch (err) {
          if (err && err.name === 'CancelledError') throw err;
          failed.push({ x: cx, y: cy, z: cz, name: b.name, why: '走不过去' });
          continue;
        }
      }
      try {
        await actions.dig({ x: cx, y: cy, z: cz, signal: ctx.signal, collect: true });
        dug.push({ x: cx, y: cy, z: cz, name: b.name });
        ctx.progress(`挖通 ${dug.length}/${limit} 格（${b.name}）`);
      } catch (err) {
        if (err && err.name === 'CancelledError') throw err;
        failed.push({ x: cx, y: cy, z: cz, name: b.name, why: err.message.slice(0, 40) });
      }
    }
  }

  // 挖完试着走过去（这才是"挖通"的目的）
  let arrived = false;
  try {
    const r = await nav.goTo({
      x: Number(x),
      y: y === null || y === undefined ? null : Number(y),
      z: Number(z),
      range: 1.5,
      signal: ctx.signal,
      timeoutMs: 30000,
    });
    arrived = !!(r && r.arrived);
  } catch (err) {
    if (err && err.name === 'CancelledError') throw err;
    log.debug(`挖通后走过去失败：${err.message}`);
  }

  if (!dug.length) {
    return skillResult(false, {
      note: failed.length
        ? `没挖动：挡路的是 ${[...new Set(failed.map((f) => f.name))].join('、')}（挖不动或者走不过去）`
        : '这条路上没有需要挖的方块（可能是别的原因走不到）',
      reason: failed.length ? '方块挖不动' : '没有可挖的挡路方块',
      extra: { dug: 0, failed: failed.slice(0, 5), arrived },
    });
  }
  return skillResult(true, {
    note:
      `挖通了 ${dug.length} 格（${[...new Set(dug.map((d) => d.name))].join('、')}）` +
      (arrived ? '，已经走到目标了' : '，但还没走到目标'),
    extra: { dug: dug.length, blocks: [...new Set(dug.map((d) => d.name))], arrived },
  });
}

module.exports = { pave, digPath, PAVE_BLOCKS };
