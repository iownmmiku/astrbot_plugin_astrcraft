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

const { skillResult, pillarUpOne, stairUpOne, isDangerousBlock } = require('./common');
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
      // 先把头顶腾出来（不然跳不起来）。
      //
      // **挖不动也要继续试**（这一轮修的）：实测"有 32 个圆石、没镐"时，
      // 头顶是石头 → `actions.dig` 抛"挖 cobblestone 需要一把镐" →
      // **整个 pave up 直接失败**，而她其实只要垫脚就能出去。
      // 清头顶只是"让她跳得起来"，不是必须成功的一步。
      const head = bot.blockAt(vec3(bx, by + 2, bz));
      if (head && head.boundingBox === 'block') {
        if (isDangerousBlock(head.name)) {
          return skillResult(done > 0, {
            note: `垫了 ${done} 格，头顶是 ${head.name}（危险方块，不能挖）`,
            reason: '头顶是危险方块',
            extra: { paved: done, direction: 'up' },
          });
        }
        if (head.diggable) {
          try {
            await actions.dig({ x: bx, y: by + 2, z: bz, signal: ctx.signal, collect: true });
          } catch (err) {
            if (err && err.name === 'CancelledError') throw err;
            // **不因为挖不动就放弃**：接着试垫脚上升（可能照样能上去）
            log.info(`清头顶失败（继续试垫脚）：${err.message.slice(0, 60)}`);
          }
        }
      }
      // **先试螺旋阶梯**（这一轮加的）。
      //
      // 用户实测："往高处垫的时候，还是做不到跳起来然后往脚下垫方块，
      // **很多时候只能往旁边放**。"
      //
      // 这句话就是答案：**"往旁边放"可靠，"往脚下放"不可靠**。
      // 螺旋阶梯 = 往旁边放一块 → 跳上去 → 重复，**全程站着放**，
      // 所以没有那个"要趁跳跃空中发包"的窗口。
      //
      // `pillarUpOne`（跳起来往脚下放）降级成备选：它在四周被挡住、
      // 没地方放旁边时还有用。
      let ok = await stairUpOne({ actions, nav, ctx, bx, by, bz });
      if (!ok) {
        ok = await pillarUpOne({ actions, ctx, bx, by, bz });
      }
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
  // **先打一条日志**（排查用）：上一轮实测失败时 `why` 是空的，
  // 连"有没有进到这个分支"都不知道，只能靠读代码猜。
  log.info(`铺路 forward：进入分支（count=${n}，item=${item || '自动'}）`);
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
  // **"往前走过去了"也算进展**（原来只数"垫了几块"，
  // 于是"地面本来就是实的、她走过去了"会被算成"没进展"→ 报失败）
  let walked = 0;
  /** **每一步为什么停**——失败信息必须说清断在哪，不能只有一句笼统的话 */
  const why = [];
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
    // **每一步都打日志**（排查用）：能直接看到"读到什么、往哪放、放了没"
    log.info(
      `铺路 forward 第 ${i + 1}/${n} 次：我在 (${bx}, ${by}, ${bz}) yaw=${yaw.toFixed(2)} → 方向 (${dx}, ${dz})`,
    );
    if (dx === 0 && dz === 0) {
      why.push('朝向算不出方向（yaw 异常）');
      break;
    }
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
    const feetNow0 = bot.blockAt(vec3(tx, by, tz));
    const headNow0 = bot.blockAt(vec3(tx, by + 1, tz));
    // **把分支判断的输入全打出来**（排查用）：上一轮只知道"循环跑了 5 次、
    // 5 毫秒就结束、why 是空的"，看不出走了哪条路。现在能直接看到
    // support 是什么、脚/头是什么、于是走了哪个分支。
    log.info(
      `  目标 (${tx}, ${by}, ${tz})：support(${supportY})=${support ? `${support.name}/${support.boundingBox}` : 'null'}` +
        ` feet=${feetNow0 ? `${feetNow0.name}/${feetNow0.boundingBox}` : 'null'}` +
        ` head=${headNow0 ? `${headNow0.name}/${headNow0.boundingBox}` : 'null'}`,
    );
    // **每一步都要能说清"断在哪"**（这一轮加的）。
    // 之前所有 `break` 共用一句"前面不是空的，或者放了没站上去"——
    // 实测排查时**根本看不出是哪一步断的**，只能靠猜。
    // 这和之前治过的"报错误导"是同一类问题，我自己又犯了一次。
    if (!support) {
      why.push(`读不到前方那一格 (${tx}, ${supportY}, ${tz})（区块可能没加载）`);
      break;
    }
    if (support.boundingBox === 'block') {
      // 支撑层已经是实心的 → 这一格不用垫，直接走上去
      const feet = bot.blockAt(vec3(tx, by, tz));
      const head = bot.blockAt(vec3(tx, by + 1, tz));
      if (isAir(feet) && isAir(head)) {
        // **走完必须验证"她真的挪了"** ——
        // 这里踩过一个和 climbToSurface 里一模一样的坑：
        // 目标格只有 1 格远，而 `range: 0.9` 会**判"已到达"、goTo 瞬间返回**，
        // 于是循环空转 N 次、她一步没动，最后报"原因不明"。
        // 实测日志：5 次迭代全在 5 毫秒内完成（说明根本没 await 到东西）。
        const before = { x: bot.entity.position.x, z: bot.entity.position.z };
        try {
          await nav.goTo({ x: tx, y: by, z: tz, range: 0.5, signal: ctx.signal, timeoutMs: 6000 });
        } catch (err) {
          if (err && err.name === 'CancelledError') throw err;
          why.push(`支撑层已实心，但走不过去：${err.message.slice(0, 50)}`);
          break;
        }
        const after = bot.entity.position;
        const moved = Math.hypot(after.x - before.x, after.z - before.z);
        if (moved < 0.4) {
          why.push(
            `支撑层已实心，但没能走过去（只挪了 ${moved.toFixed(2)} 格；` +
              `目标 (${tx}, ${by}, ${tz})，可能被挡住或者寻路判"已到达"）`,
          );
          break;
        }
        walked += 1; // **走过去也算进展**（原来只数"垫了几块"，走过去不算 → 报"没进展"）
        ctx.progress(`往前走了 ${walked} 格（地面本来就是实的）`);
        continue;
      }
      // 脚下被实心占着（比如 1 格台阶）→ 试着跳上去
      const up = bot.blockAt(vec3(tx, by + 1, tz));
      if (isAir(up)) {
        try {
          await nav.goTo({ x: tx, y: by + 1, z: tz, range: 0.5, signal: ctx.signal, timeoutMs: 6000 });
        } catch (err) {
          if (err && err.name === 'CancelledError') throw err;
          why.push(`想跳上 1 格台阶但没上去：${err.message.slice(0, 50)}`);
          break;
        }
        const np = bot.entity.position;
        if (Math.floor(np.y) <= by) {
          why.push(`想跳上 1 格台阶但没上去（还在 y=${by}）`);
          break;
        }
        walked += 1;
        continue;
      }
      why.push(
        `前方 (${tx}, ${by}, ${tz}) 被 ${feet && feet.name} 占着，上面 (${by + 1}) 也被 ${up && up.name} 占着——没有落脚点`,
      );
      break;
    }
    if (isDangerousBlock(support.name)) {
      // 支撑层是岩浆/水 —— 垫上去也站不住
      skippedDanger += 1;
      why.push(`前方支撑层是 ${support.name}（岩浆/水），垫上去也站不住`);
      break;
    }
    // 她自己的身体高度那一格必须空着（不然放下去她会被卡住）
    const feetNow = bot.blockAt(vec3(tx, by, tz));
    const headNow = bot.blockAt(vec3(tx, by + 1, tz));
    if (!isAir(feetNow) || !isAir(headNow)) {
      why.push(
        `她的身体高度 (${tx}, ${by}) 不是空的（脚=${feetNow && feetNow.name} 头=${headNow && headNow.name}）`,
      );
      break;
    }
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
      why.push(`在 (${tx}, ${supportY}, ${tz}) 放 ${blockName} 失败：${err.message.slice(0, 70)}`);
      break;
    }
    // 站到刚铺的那块上（她仍然在 by 这一层，只是脚下有东西了）
    const bp = { x: bot.entity.position.x, z: bot.entity.position.z };
    try {
      await nav.goTo({ x: tx, y: by, z: tz, range: 0.5, signal: ctx.signal, timeoutMs: 6000 });
    } catch (err) {
      if (err && err.name === 'CancelledError') throw err;
      why.push(
        `铺好了但走不上去（目标 (${tx}, ${by}, ${tz})）：${err.message.slice(0, 60)}`,
      );
      break;
    }
    // 同样验证"真的挪了"（goTo 可能判"已到达"就返回，见上面的说明）
    const ap = bot.entity.position;
    if (Math.hypot(ap.x - bp.x, ap.z - bp.z) < 0.4) {
      why.push(
        `铺好了但没能走过去（只挪了 ${Math.hypot(ap.x - bp.x, ap.z - bp.z).toFixed(2)} 格）`,
      );
      break;
    }
  }
  // **只要"垫了"或者"走过去了"都算有进展**
  if (!done && !walked) {
    return skillResult(false, {
      note: `没能铺路：${why.length ? why[why.length - 1] : '原因不明'}`,
      reason: why.length ? why[why.length - 1] : '铺路没有进展',
      extra: { paved: 0, direction: 'forward', danger: skippedDanger, why },
    });
  }
  return skillResult(true, {
    note:
      (done ? `往前铺了 ${done} 格（用 ${blockName}）` : `往前走了 ${walked} 格（地面本来就是实的）`) +
      (why.length ? `；再往前时停了：${why[why.length - 1]}` : ''),
    consumed: { [blockName]: done },
    extra: { paved: done, walked, direction: 'forward', item: blockName, why },
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
    log.info(`挖通后走过去失败：${err.message}`);
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
