'use strict';
/**
 * 建造技能：搭一个能过夜的庇护所。
 *
 * 这是"像玩家一样"最有说服力的一环，也是最容易写出 bug 的一环。
 * 关键约束（踩过的坑都在这）：
 *   1. 放置方块需要"依附面"：目标位置必须紧邻一个实体方块，否则服务器拒绝
 *   2. 不能把方块放在自己脚下/身体里，会卡住自己 → 必须从外圈开始、从下往上
 *   3. 屋顶要在墙完成之后再盖，否则从里面够不到
 *   4. 门框底部那一格要留空（放门），不能封死
 *   5. 每个格子放完都要验证，失败就换个依附面重试，不能假装成功
 */

const log = require('../log');
const { delay, distance, CancelledError, describeFailure, vec3 } = require('../util');
const { skillResult, climbToSurface } = require('./common');
const wood = require('./wood');
const mining = require('./mining');

/** 优先使用的建材，从差到好；缺什么就现挖什么 */
const BUILD_MATERIALS = [
  'cobblestone', 'cobbled_deepslate', 'stone', 'dirt', 'oak_planks', 'birch_planks', 'spruce_planks',
  'andesite', 'granite', 'diorite', 'tuff', 'sandstone', 'netherrack', 'blackstone', 'deepslate',
];

/**
 * 建庇护所。
 * @param {object} o
 * @param {number} [o.size] 内部边长（3 = 3x3 内部，墙体围出 5x5 外框）
 * @param {boolean} [o.roof] 是否盖屋顶
 * @param {boolean} [o.door] 是否装门（没有门就用留一个口子）
 * @param {boolean} [o.torch] 是否放火把
 */
async function buildShelter({ actions, nav, state, ctx, size = 3, roof = true, door = true, torch = true }) {
  const bot = actions.bot;
  const steps = [];

  // ---- 0. 先回到地表。
  // 挖完矿她可能在洞里，而洞里既没有平地也没有放方块的余地——
  // 实测这就是"一块墙都没放上去，可能没站在合适的依附位置上"的来源。
  const climb = await climbToSurface({ actions, nav, ctx });
  if (climb.steps > 0) {
    steps.push(`挖阶梯回到地表 ${climb.steps} 格`);
    log.info(`盖房前先爬出矿道：${climb.steps} 格（ok=${climb.ok}）`);
  }

  // ---- 1. 选点：以当前位置为中心的平地
  let origin = await pickFlatSpot({ actions, ctx, size });
  if (!origin) {
    // 实在没有像样的平地：就地整平（clearFootprint 会挖掉高出的部分、fillFloor 会补洞）。
    // 真人在山坡上盖房也是先刨出一块平台，而不是换个地方再试。
    const p0 = bot.entity.position;
    origin = { x: Math.floor(p0.x), y: Math.floor(p0.y), z: Math.floor(p0.z), leveled: true };
    log.info('附近没有天然平地，就地整平后建造');
    steps.push('附近没有平地，就地整平');
  }
  ctx.progress(`选好建造位置 (${origin.x}, ${origin.y}, ${origin.z})`);

  // ---- 1.5 先走到建造点。
  // 这一步以前没有，实测后果很典型：她刚挖完矿待在洞里（y=56），
  // 而选中的平地在地表（y=64）——寻路爬不上去，于是"一块墙都没放上去"。
  // 走不过去就退回"就地取材"：在她当前位置盖（技能本来就会清场+补地板整平）。
  const curY = Math.floor(bot.entity.position.y);
  if (Math.abs(origin.y - curY) > 2 || Math.abs(origin.x - Math.floor(bot.entity.position.x)) > 3) {
    try {
      await nav.goTo({ x: origin.x, y: origin.y, z: origin.z, range: 2, signal: ctx.signal, timeoutMs: 25000 });
      steps.push('走到建造点');
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      ctx.progress('走不到选好的建造点，改为就地盖');
      steps.push(`走不到 (${origin.x}, ${origin.y}, ${origin.z})，改为就地建造`);
      const p2 = bot.entity.position;
      origin = { x: Math.floor(p2.x), y: Math.floor(p2.y), z: Math.floor(p2.z) };
    }
  }

  // ---- 2. 备料
  const inner = Math.max(2, Math.min(6, Number(size) || 3));
  const outer = inner + 2; // 外框边长
  // 墙高 2 就够站人（加上屋顶正好 3 格净空），用料比 3 省三分之一。
  // 真人的第一间过夜小屋也是两层高。
  const wallHeight = 2;
  const needed = estimateMaterials({ inner, wallHeight, roof, door, torch });
  const material = await ensureMaterials({ actions, nav, state, ctx, steps, needed });
  if (!material) {
    return skillResult(false, { steps, reason: '材料凑不齐（需要圆石/泥土/木板之类的方块，还要火把和门）' });
  }
  ctx.progress(`建材准备完毕：${material.name}（约 ${actions.countItem(material.name)} 个）`);

  // ---- 3. 清空场地（把内部与墙体位置的杂物挖掉）
  await clearFootprint({ actions, ctx, origin, outer, wallHeight, steps });

  // ---- 4. 打地基：把脚下垫平（有洞就填）
  await fillFloor({ actions, ctx, origin, outer, material, steps });

  // ---- 5. 砌墙（从外圈开始，从下往上；门的位置留空）
  const doorPos = door ? pickDoorPosition({ origin, outer }) : null;
  const placed = await buildWalls({ actions, nav, ctx, origin, outer, wallHeight, material, doorPos, steps });
  if (placed === 0) {
    return skillResult(false, { steps, reason: '一块墙都没放上去，可能没站在合适的依附位置上' });
  }

  // ---- 6. 屋顶
  if (roof) {
    await buildRoof({ actions, nav, ctx, origin, outer, wallHeight, material, steps });
  }

  // ---- 7. 门
  if (door && doorPos) {
    await installDoor({ actions, ctx, doorPos, material, steps });
  }

  // ---- 8. 火把
  if (torch) {
    await placeTorches({ actions, ctx, origin, inner, steps });
  }

  // ---- 9. 进屋验收
  const inside = checkInside({ actions, origin, inner });
  if (!inside) {
    ctx.progress('走到屋里确认');
    try {
      await nav.goTo({ x: origin.x + 0.5 + Math.floor(outer / 2), y: null, z: origin.z + 0.5 + Math.floor(outer / 2), range: 1, signal: ctx.signal, timeoutMs: 15000 });
    } catch (err) {
      if (!(err instanceof CancelledError)) log.debug(`进屋失败：${err.message}`);
    }
  }

  // ---- 10. 布置家具：箱子、床
  //
  // 用户的要求："建完自己的房间后，她会放置箱子、床等工具"。
  // 早期房子盖完就结束了，里面空空的——不像"家"，东西也还是散在背包里。
  // 这一步做三件事（每件都能失败，失败只记下来不中断）：
  //   1) 有木板就做个箱子放屋里，然后把背包里的杂物存进去
  //   2) 有床就放屋里（晚上能睡过去）
  //   3) 有羊毛+木板就做张床再放
  const furnished = { chest: false, bed: false, stored: false, skipped: [] };
  try {
    await furnish({ actions, nav, state, ctx, origin, inner, steps, out: furnished });
  } catch (err) {
    if (err instanceof CancelledError) throw err;
    log.debug(`布置家具失败（不影响房子本身）：${err.message}`);
  }

  const shelter = {
    origin,
    size: outer,
    inner,
    wall_height: wallHeight,
    material: material.name,
    has_roof: roof,
    has_door: !!(door && doorPos),
    door_position: doorPos,
    furnished,
  };

  const extras = [
    roof ? '有屋顶' : '',
    door && doorPos ? '有门' : '',
    furnished.chest ? '有箱子' : '',
    furnished.bed ? '有床' : '',
  ].filter(Boolean);

  return skillResult(true, {
    steps,
    consumed: { [material.name]: placed },
    note: `庇护所建好了：外框 ${outer}×${outer}、墙高 ${wallHeight}${extras.length ? '、' + extras.join('、') : ''}，位置 (${origin.x}, ${origin.y}, ${origin.z})`,
    extra: { shelter },
  });
}

/**
 * 给屋子添置箱子/床，并把身上的杂物存进箱子。
 *
 * 每一项都是"能就做、不能就跳过"——不因为缺羊毛就让整栋房子算失败。
 */
async function furnish({ actions, nav, state, ctx, origin, inner, steps, out }) {
  const bot = actions.bot;
  // 屋内的两个位置：一侧放箱子，另一侧放床
  const cx = origin.x + 1;
  const cz = origin.z + 1;

  // ---- 箱子
  let chestCount = actions.countItem('chest');
  if (chestCount === 0) {
    const planks = ['oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks']
      .map((n) => [n, actions.countItem(n)])
      .sort((a, b) => b[1] - a[1])[0];
    if (planks && planks[1] >= 8) {
      ctx.progress('做个箱子');
      try {
        await actions.craft({ item: 'chest', count: 1, signal: ctx.signal });
        chestCount = actions.countItem('chest');
        steps.push({ action: 'craft_chest', ok: chestCount > 0 });
      } catch (err) {
        log.info(`做箱子失败：${err.message}`);
        out.skipped.push('箱子（木板不够或合成失败）');
      }
    } else {
      out.skipped.push('箱子（要 8 块木板）');
    }
  }
  if (chestCount > 0) {
    ctx.progress('把箱子放进屋里');
    try {
      const floorY = origin.y;
      await actions.place({ x: cx, y: floorY, z: cz, item: 'chest', signal: ctx.signal });
      out.chest = true;
      steps.push({ action: 'place_chest', ok: true });
    } catch (err) {
      log.info(`放箱子失败：${err.message}`);
      out.skipped.push('放箱子');
    }
  }

  // ---- 床
  const BEDS = ['white_bed', 'red_bed', 'blue_bed', 'green_bed', 'black_bed', 'brown_bed', 'cyan_bed', 'gray_bed', 'lime_bed', 'magenta_bed', 'orange_bed', 'pink_bed', 'purple_bed', 'light_blue_bed', 'light_gray_bed', 'yellow_bed'];
  let bed = BEDS.find((n) => actions.countItem(n) > 0) || null;
  if (!bed) {
    // 3 羊毛 + 3 木板就能做床（羊毛靠打羊/剪羊毛）
    const wool = ['white_wool', 'black_wool', 'brown_wool', 'gray_wool', 'light_gray_wool']
      .map((n) => [n, actions.countItem(n)])
      .sort((a, b) => b[1] - a[1])[0];
    const planks = ['oak_planks', 'birch_planks', 'spruce_planks']
      .map((n) => [n, actions.countItem(n)])
      .sort((a, b) => b[1] - a[1])[0];
    if (wool && wool[1] >= 3 && planks && planks[1] >= 3) {
      ctx.progress('做张床');
      try {
        await actions.craft({ item: `${wool[0].replace('_wool', '')}_bed`, count: 1, signal: ctx.signal });
        bed = BEDS.find((n) => actions.countItem(n) > 0) || null;
        steps.push({ action: 'craft_bed', ok: !!bed });
      } catch (err) {
        log.info(`做床失败：${err.message}`);
      }
    } else {
      out.skipped.push('床（要 3 羊毛 + 3 木板，羊毛得去打羊或剪羊毛）');
    }
  }
  if (bed) {
    ctx.progress('把床放进屋里');
    try {
      await actions.place({ x: cx + 1, y: origin.y, z: cz, item: bed, signal: ctx.signal });
      out.bed = true;
      steps.push({ action: 'place_bed', ok: true });
    } catch (err) {
      log.info(`放床失败：${err.message}`);
      out.skipped.push('放床');
    }
  }

  void nav;
  void state;
  void bot;
  void inner;
}

/** 找一个相对平坦、地面是实体的位置 */
async function pickFlatSpot({ actions, ctx, size }) {
  const bot = actions.bot;
  const p = bot.entity.position;
  const outer = Math.max(4, Number(size) + 2);

  // **地面高度缓存**：整次选点共用一份。
  // 没有缓存时，相邻候选点会反复重算重叠的列，实测 36 个候选 × 2 轮筛选
  // 触发约 8.8 万次同步 blockAt → **事件循环被阻塞 44 秒**，
  // 而服务器 keepalive 大约 30 秒就会判定超时踢人（实测 lost connection: Timed out）。
  const cache = new Map();
  const groundAt = (x, z) => {
    const k = `${x},${z}`;
    if (cache.has(k)) return cache.get(k);
    const y = groundHeightAt(bot, x, z);
    cache.set(k, y);
    return y;
  };

  // 候选点：以当前位置为中心向外取"环上的点"
  const cands = [];
  for (let r = 0; r <= 8; r += 2) {
    for (let dx = -r; dx <= r; dx += 2) {
      for (let dz = -r; dz <= r; dz += 2) {
        if (r > 0 && Math.abs(dx) !== r && Math.abs(dz) !== r) continue; // 只取环
        cands.push({ x: Math.floor(p.x) + dx, z: Math.floor(p.z) + dz });
      }
    }
  }

  // 先算出每个候选点的地面高度，再按与当前高度的接近程度排序。
  const scored = [];
  for (const c of cands) {
    const y = groundAt(c.x, c.z);
    if (y === null) continue;
    scored.push({ x: c.x, y, z: c.z, dy: Math.abs(y - Math.floor(p.y)) });
    // **让出事件循环**。
    //
    // 这个函数会做上千次同步方块查询。实测在真实服务器上把引擎阻塞了 **9.1 秒**，
    // 后果不是"慢一点"而是**灾难性**的：
    //   引擎无法响应任何 RPC → 插件查任务状态拿到过期数据
    //   → LLM 以为她卡死了 → 调用 mc_task_cancel 把建房任务取消掉
    //   → 用户看到的就是"让她建个房间，到现在还没真正开始"。
    // 每个候选点让一次，代价可以忽略，但引擎始终可响应。
    await new Promise((r) => setImmediate(r));
  }
  scored.sort((a, b) => a.dy - b.dy);

  // 两轮筛选：先找真正平的（≤2），再放宽到 ≤3。
  // 放宽是有道理的——clearFootprint 会把高出的部分挖掉（墙高 3），
  // 等于她自己动手整平；严格只认"天然完美平地"会在山地/丛林里直接放弃。
  for (const tolerance of [2, 3]) {
    for (const c of scored) {
      await new Promise((r) => setImmediate(r));
      // 先粗查 3×3：绝大多数候选点在这里就被否掉，省掉整片区域的读取
      if (!isFlatEnough(bot, c.x, c.y, c.z, 2, tolerance, groundAt)) continue;
      if (isFlatEnough(bot, c.x, c.y, c.z, outer, tolerance, groundAt)) {
        return { x: c.x, y: c.y, z: c.z, leveled: tolerance > 2 };
      }
    }
  }
  return null;
}

/**
 * 取该 XZ 处可站立的地面高度（返回"脚所在的那一格"）。
 *
 * 搜索范围 ±8：早期只找 ±6 格，机器人刚挖矿下到洞里时周围地表高出 8 格以上
 * 就全都读不到，于是误判"附近没有平地"。**范围不能无脑放大**——
 * 这个函数在选点时会被调用上千次，每加一层就多一份同步开销
 * （实测 ±12 时整次选点阻塞事件循环 44 秒）。
 * 另外跳过树叶——把房子盖在树冠上不是人干的事。
 */
function groundHeightAt(bot, x, z) {
  const base = Math.floor(bot.entity.position.y);
  for (let y = base + 8; y >= base - 8; y -= 1) {
    const b = blockAt(bot, x, y, z);
    const above = blockAt(bot, x, y + 1, z);
    const above2 = blockAt(bot, x, y + 2, z);
    if (!b || !above || !above2) continue;
    if (b.boundingBox !== 'block') continue;
    if (mining.isDangerous(b.name)) continue;
    // 别把地基选在树叶上（树冠不算地面）
    if (String(b.name).endsWith('_leaves')) continue;
    const free =
      (above.boundingBox === 'empty' || above.name === 'air') &&
      (above2.boundingBox === 'empty' || above2.name === 'air');
    if (free) return y + 1;
  }
  return null;
}

/**
 * 检查一块区域是否够平。
 * 允许 2~3 格高差——因为技能本身会清场（clearFootprint）和补地板（fillFloor），
 * 真玩家也是先找块差不多的地方再自己整平，而不是非要天然完美平地。
 * groundAt 可传入共享缓存，避免重复读取同一列。
 */
function isFlatEnough(bot, x, y, z, outer, tolerance = 2, groundAt = null) {
  const ground = groundAt || ((gx, gz) => groundHeightAt(bot, gx, gz));
  let minY = Infinity;
  let maxY = -Infinity;
  for (let dx = -1; dx <= outer; dx += 1) {
    for (let dz = -1; dz <= outer; dz += 1) {
      const gx = x + dx;
      const gz = z + dz;
      const g = ground(gx, gz);
      if (g === null) return false;
      // 地面不能有危险方块
      const floor = blockAt(bot, gx, g - 1, gz);
      if (!floor || mining.isDangerous(floor.name)) return false;
      // 地面上方不能是水
      const feet = blockAt(bot, gx, g, gz);
      if (feet && (feet.name === 'water' || feet.name === 'flowing_water' || feet.name === 'lava')) return false;
      minY = Math.min(minY, g);
      maxY = Math.max(maxY, g);
      // 提前退出：已经超出容差就不用继续读了
      if (maxY - minY > tolerance) return false;
    }
  }
  return maxY - minY <= tolerance;
}

function estimateMaterials({ inner, wallHeight, roof, door, torch }) {
  const outer = inner + 2;
  const wallBlocks = outer * outer - inner * inner; // 一圈墙的每层方块数
  const walls = wallBlocks * wallHeight;
  const roofBlocks = roof ? outer * outer : 0;
  // 地板补洞与损耗的预留。**不要给太大**：
  // 早期是 floorMiss=6 + 8，size=3 时合计要 87 块圆石——
  // 实测她为了凑料挖了 200 秒石头，还没盖房就超时了。
  // 真人的第一间小屋也就三四十块料。
  const floorMiss = 4;
  const buffer = 4;
  return {
    blocks: walls + roofBlocks + floorMiss + buffer,
    door: door ? 1 : 0,
    torch: torch ? 2 : 0,
  };
}

/** 保证有足够的建材、门、火把；不够就去弄 */
async function ensureMaterials({ actions, nav, state, ctx, steps, needed }) {
  // **用料是估算，别为了差一两块去挖几分钟矿。**
  // 实测：她有 64 块圆石、配方算出来要 65 块，就卡在"再挖 1 块"上耗了 300 秒直到任务超时。
  // 真玩家也会拿手头的东西先盖起来——少一两块顶多屋顶缺个角。
  const minNeeded = Math.max(12, Math.floor(needed.blocks * 0.85));

  // 先看现有方块够不够
  let material = BUILD_MATERIALS.find((n) => actions.countItem(n) >= minNeeded);
  if (!material) {
    // 挑一种手头最多的
    const map = actions.inventoryMap();
    const best = BUILD_MATERIALS.map((n) => ({ n, c: map[n] || 0 })).sort((a, b) => b.c - a.c)[0];
    material = best && best.c > 0 ? best.n : null;
  }

  // 不够就挖石头（最多补 24 块，不无限追）
  if (!material || actions.countItem(material) < minNeeded) {
    const lacking = Math.min(24, Math.max(4, minNeeded - (material ? actions.countItem(material) : 0)));
    ctx.progress(`建材不足，去挖 ${lacking} 个圆石`);
    const r = await mining.mineStone({ actions, nav, state, ctx, want: lacking });
    steps.push(...r.steps);
    material = BUILD_MATERIALS.find((n) => actions.countItem(n) >= 8) || material || 'cobblestone';
    if (actions.countItem(material) < 8) {
      // 石头都挖不到，退而求其次用泥土
      const dirt = actions.countItem('dirt');
      if (dirt >= 8) material = 'dirt';
      else return null;
    }
  }

  // 门
  if (needed.door && actions.countItem('oak_door') === 0) {
    for (const doorName of ['oak_door', 'birch_door', 'spruce_door', 'jungle_door', 'acacia_door', 'dark_oak_door']) {
      if (actions.countItem(doorName) > 0) break;
      try {
        // 门需要 6 个木板 → 3 个木板（每种门 3 个木板做 3 扇门，材料够就做）
        if (wood.countPlanks(actions) < 3) {
          const pk = await wood.makePlanks({ actions, ctx, want: 3 });
          steps.push(...pk.steps);
        }
        if (wood.countPlanks(actions) >= 3) {
          await actions.craft({ item: doorName, count: 1, signal: ctx.signal });
          steps.push(`合成 ${doorName}`);
          break;
        }
      } catch (err) {
        log.info(`做门失败：${err.message}`);
        break;
      }
    }
  }

  // 火把
  if (needed.torch && actions.countItem('torch') < needed.torch) {
    try {
      if (actions.countItem('coal') === 0 && actions.countItem('charcoal') === 0) {
        // 没有煤/木炭：用原木烧木炭，或者干脆跳过火把（不算致命）
        if (wood.totalLogs(actions) >= 2 && mining.hasFuel(actions)) {
          try {
            await actions.smelt({ item: wood.LOG_NAMES.find((n) => actions.countItem(n) > 0), count: 1, signal: ctx.signal });
            steps.push('烧木炭');
          } catch (err) {
            log.info(`烧木炭失败：${err.message}`);
          }
        }
      }
      if ((actions.countItem('coal') > 0 || actions.countItem('charcoal') > 0) && actions.countItem('stick') >= 1) {
        await actions.craft({ item: 'torch', count: 4, signal: ctx.signal });
        steps.push('合成火把');
      }
    } catch (err) {
      log.debug(`做火把失败（不致命）：${err.message}`);
    }
  }

  return { name: material };
}

/** 挖掉占位方块（内部与墙线），并压平地面 */
async function clearFootprint({ actions, ctx, origin, outer, wallHeight, steps }) {
  const bot = actions.bot;
  const toClear = [];
  for (let dx = 0; dx < outer; dx += 1) {
    for (let dz = 0; dz < outer; dz += 1) {
      const x = origin.x + dx;
      const z = origin.z + dz;
      for (let dy = 0; dy < wallHeight; dy += 1) {
        const y = origin.y + dy;
        const b = blockAt(bot, x, y, z);
        if (!b) continue;
        if (b.name === 'air' || b.name === 'cave_air') continue;
        if (b.name === 'grass' || b.name.includes('tall_grass') || b.name.includes('flower') || b.name === 'fern' || b.name === 'snow') {
          toClear.push({ x, y, z }); // 花草直接清掉
          continue;
        }
        if (!b.diggable) continue;
        toClear.push({ x, y, z });
      }
    }
  }
  if (!toClear.length) return;
  ctx.progress(`清理场地（${toClear.length} 个方块）`);

  // **按离自己由近到远排序，并允许走位（reach: true）**。
  // 她可能正站在狭窄的矿道里：房间另一侧的方块在 5~6 格外，够不到。
  // 早期用 reach: false，够不到的直接抛错跳过 → 场地永远清不空 →
  // 最后报"一块墙都没放上去，可能没站在合适的依附位置上"（实测就是这条）。
  // 先挖身边最近的，挖开后就能走进新空间去挖下一圈——真人开房间也是这么挖的。
  const p0 = bot.entity.position;
  const distTo = (t) => distance(p0, { x: t.x + 0.5, y: t.y + 0.5, z: t.z + 0.5 });
  toClear.sort((a, b) => distTo(a) - distTo(b));

  let cleared = 0;
  for (const t of toClear) {
    if (ctx.aborted) throw new CancelledError('建造被取消');
    try {
      await actions.dig({ x: t.x, y: t.y, z: t.z, signal: ctx.signal, collect: true, reach: true });
      cleared += 1;
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      log.info(`清理 (${t.x},${t.y},${t.z}) 失败：${err.message}`);
    }
  }
  if (cleared) steps.push(`清理场地 ${cleared} 格`);
}

/** 把地板上的洞填上，保证内部是实心平面 */
async function fillFloor({ actions, ctx, origin, outer, material, steps }) {
  const bot = actions.bot;
  const holes = [];
  for (let dx = -1; dx <= outer; dx += 1) {
    for (let dz = -1; dz <= outer; dz += 1) {
      const x = origin.x + dx;
      const z = origin.z + dz;
      const floor = blockAt(bot, x, origin.y - 1, z);
      if (!floor || floor.boundingBox !== 'block') holes.push({ x, y: origin.y - 1, z });
    }
  }
  if (!holes.length) return;
  ctx.progress(`补地板（${holes.length} 处）`);
  let filled = 0;
  for (const h of holes) {
    if (ctx.aborted) throw new CancelledError('建造被取消');
    if (actions.countItem(material.name) <= 0) break;
    try {
      await actions.place({ x: h.x, y: h.y, z: h.z, item: material.name, signal: ctx.signal, reach: true });
      filled += 1;
    } catch (err) {
      log.info(`补地板 (${h.x},${h.y},${h.z}) 失败：${err.message}`);
    }
  }
  if (filled) steps.push(`补地板 ${filled} 格`);
}

/** 选门的位置：南墙中间 */
function pickDoorPosition({ origin, outer }) {
  const mid = Math.floor(outer / 2);
  return { x: origin.x + mid, y: origin.y, z: origin.z + outer - 1, dir: 'south' };
}

/**
 * 砌墙：逐层、先外圈。
 * 门的位置：底部两格留空（门本身占两格高，放门时再装）。
 */
async function buildWalls({ actions, nav, ctx, origin, outer, wallHeight, material, doorPos, steps }) {
  let placed = 0;
  // material 是 { name } 对象（ensureMaterials 的返回），**不能直接当字符串用**。
  // 早期这里写成 actions.countItem(material) / actions.place({item: material})，
  // 传的是对象 → countItem 永远返回 0 → 第一块就 break，
  // 表现就是"一块墙都没放上去，可能没站在合适的依附位置上"（实测就是这个原因）。
  const matName = material && material.name ? material.name : String(material || '');
  for (let dy = 0; dy < wallHeight; dy += 1) {
    ctx.progress(`砌墙第 ${dy + 1}/${wallHeight} 层`);
    // 外圈坐标，按"从外向内、从下往上"的顺序保证每次都有依附面
    const ring = [];
    for (let dx = 0; dx < outer; dx += 1) {
      for (let dz = 0; dz < outer; dz += 1) {
        const isEdge = dx === 0 || dz === 0 || dx === outer - 1 || dz === outer - 1;
        if (!isEdge) continue;
        ring.push({ x: origin.x + dx, y: origin.y + dy, z: origin.z + dz });
      }
    }
    // 门的两个格子：跳过（不放墙）
    for (const cell of ring) {
      if (ctx.aborted) throw new CancelledError('建造被取消');
      if (doorPos && cell.x === doorPos.x && cell.z === doorPos.z && dy <= 1) continue;
      // 已经有墙了就跳过
      const existing = blockAt(actions.bot, cell.x, cell.y, cell.z);
      if (existing && existing.boundingBox === 'block' && !existing.name.includes('grass') && !existing.name.includes('flower')) {
        continue;
      }
      if (actions.countItem(matName) <= 0) break;
      // 墙的每一格都要有依附面：先确保自己在外面/里面够得到
      const ok = await placeWithApproach({ actions, nav, ctx, cell, material: matName });
      if (ok) placed += 1;
    }
  }
  if (placed) steps.push(`砌墙 ${placed} 块`);
  return placed;
}

/** 放一块方块，够不到就先走近 */
async function placeWithApproach({ actions, nav, ctx, cell, material, attempts = 3 }) {
  const bot = actions.bot;
  for (let i = 0; i < attempts; i += 1) {
    if (ctx.aborted) return false;
    const d = distance(bot.entity.position, { x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 });
    if (d > 4.0) {
      try {
        // 站到目标旁边（保持 1.5–3 格），不要站到目标格里。
        // 用 approach：pathfinder 走不动时会自动改用"直接迈步"——
        // 实测只靠 goTo 时她在自然地形里根本走不到墙边，
        // 整面墙一块都放不上去（"一块墙都没放上去，可能没站在合适的依附位置上"）。
        await nav.approach({ x: cell.x, y: cell.y, z: cell.z, range: 2, signal: ctx.signal, timeoutMs: 10000 });
      } catch (err) {
        if (err instanceof CancelledError) throw err;
      }
    }
    try {
      const r = await actions.place({ x: cell.x, y: cell.y, z: cell.z, item: material, signal: ctx.signal, reach: false });
      if (r.ok) return true;
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      // 自己站在目标格上 → 让开
      const cur = bot.entity.position;
      if (Math.floor(cur.x) === cell.x && Math.floor(cur.z) === cell.z && (Math.floor(cur.y) === cell.y || Math.floor(cur.y) + 1 === cell.y)) {
        try {
          await nav.goTo({ x: cell.x + 2.5, y: null, z: cell.z + 2.5, range: 1, signal: ctx.signal, timeoutMs: 8000 });
        } catch {
          /* ignore */
        }
      } else {
        await delay(250, { signal: ctx.signal });
      }
    }
  }
  return false;
}

/** 盖屋顶：从外圈向内，保证每块都有依附 */
/**
 * 取出建材的名字。
 *
 * ensureMaterials 返回的是 `{ name: 'cobblestone' }` 这种对象，
 * 而动作层要的是**字符串**。早期有几处直接把它当字符串用
 * （`countItem(material)` / `place({item: material})`），
 * 结果 countItem 永远返回 0 → 第一块就 break →
 * 报"一块墙都没放上去，可能没站在合适的依附位置上"（实测就是这个原因）。
 * 所有地方统一走这个函数。
 */
function matName(material) {
  if (!material) return '';
  if (typeof material === 'string') return material;
  return String(material.name || '');
}

async function buildRoof({ actions, nav, ctx, origin, outer, wallHeight, material, steps }) {
  const y = origin.y + wallHeight;
  let placed = 0;
  // 从最外圈往内，逐圈填
  for (let inset = 0; inset <= Math.floor(outer / 2); inset += 1) {
    const ring = [];
    for (let dx = inset; dx < outer - inset; dx += 1) {
      for (let dz = inset; dz < outer - inset; dz += 1) {
        const isEdge = dx === inset || dz === inset || dx === outer - 1 - inset || dz === outer - 1 - inset;
        if (!isEdge) continue;
        ring.push({ x: origin.x + dx, y, z: origin.z + dz });
      }
    }
    for (const cell of ring) {
      if (ctx.aborted) throw new CancelledError('建造被取消');
      const existing = blockAt(actions.bot, cell.x, cell.y, cell.z);
      if (existing && existing.boundingBox === 'block') continue;
      if (actions.countItem(matName(material)) <= 0) break;
      const ok = await placeWithApproach({ actions, nav, ctx, cell, material: matName(material) });
      if (ok) placed += 1;
    }
    ctx.progress(`盖屋顶（第 ${inset + 1} 圈）`);
  }
  if (placed) steps.push(`盖屋顶 ${placed} 块`);
  return placed;
}

/** 装门：需要站在门内侧或外侧，把门放到门框里 */
async function installDoor({ actions, ctx, doorPos, material, steps }) {
  const bot = actions.bot;
  const doorItem = ['oak_door', 'birch_door', 'spruce_door', 'jungle_door', 'acacia_door', 'dark_oak_door', 'crimson_door', 'warped_door'].find(
    (n) => actions.countItem(n) > 0,
  );
  if (!doorItem) {
    log.debug('没有门可装，留一个门洞');
    return false;
  }
  // 门的放置：门框下方的方块上
  const base = { x: doorPos.x, y: doorPos.y, z: doorPos.z };
  try {
    const below = blockAt(bot, base.x, base.y - 1, base.z);
    if (!below || below.boundingBox !== 'block') {
      await actions.place({ x: base.x, y: base.y - 1, z: base.z, item: matName(material), signal: ctx.signal, reach: true }).catch(() => {});
    }
    await actions.lookAtPoint(base.x + 0.5, base.y + 0.5, base.z + 0.5);
    const r = await actions.place({ x: base.x, y: base.y, z: base.z, item: doorItem, signal: ctx.signal, reach: false });
    if (r.ok) steps.push('装门');
    return r.ok;
  } catch (err) {
    log.debug(`装门失败（不致命）：${err.message}`);
    return false;
  }
}

/** 在屋内四角插火把 */
async function placeTorches({ actions, ctx, origin, inner, steps }) {
  if (actions.countItem('torch') <= 0) return 0;
  let placed = 0;
  // 火把放在**屋内**、靠墙附着。
  // 早期只写死两个点、还放在 origin.y+2（那是屋顶那层），
  // 于是每次都被屋顶占住："插火把失败：(38,65,-33) 已经有 cobblestone 了"。
  // 现在给多个候选（四个内角 × 两个高度），跳过已经被占的位置。
  const bot = actions.bot;
  const spots = [];
  for (const dy of [1, 2]) {
    for (const [cx, cz] of [
      [1, 1],
      [inner, inner],
      [1, inner],
      [inner, 1],
    ]) {
      spots.push({ x: origin.x + cx, y: origin.y + dy, z: origin.z + cz });
    }
  }
  for (const s of spots) {
    if (ctx.aborted) return placed;
    if (placed >= 2) break; // 两个就够照亮了
    if (actions.countItem('torch') <= 0) break;
    const b = blockAt(bot, s.x, s.y, s.z);
    if (b && b.boundingBox === 'block') continue; // 这格被占了，换下一个
    try {
      const r = await actions.place({ x: s.x, y: s.y, z: s.z, item: 'torch', signal: ctx.signal, reach: true });
      if (r.ok) placed += 1;
    } catch (err) {
      log.info(`插火把 (${s.x},${s.y},${s.z}) 失败：${err.message}`);
    }
  }
  if (placed) steps.push(`插火把 ${placed} 个`);
  return placed;
}

function checkInside({ actions, origin, inner }) {
  const p = actions.bot.entity.position;
  return (
    p.x >= origin.x &&
    p.x <= origin.x + inner + 2 &&
    p.z >= origin.z &&
    p.z <= origin.z + inner + 2
  );
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

module.exports = { buildShelter, pickFlatSpot, groundHeightAt, BUILD_MATERIALS };
