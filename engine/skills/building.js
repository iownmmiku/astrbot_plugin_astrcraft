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
const { delay, distance, CancelledError, TimeoutError, describeFailure, vec3 } = require('../util');
const { skillResult, climbToSurface } = require('./common');
const wood = require('./wood');
const mining = require('./mining');

/** 优先使用的建材，从差到好；缺什么就现挖什么 */
const BUILD_MATERIALS = [
  'cobblestone', 'cobbled_deepslate', 'stone', 'dirt', 'oak_planks', 'birch_planks', 'spruce_planks',
  'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks',
  'pale_oak_planks', 'crimson_planks', 'warped_planks',
  'andesite', 'granite', 'diorite', 'tuff', 'sandstone', 'netherrack', 'blackstone', 'deepslate',
];
const DOOR_NAMES = BUILD_MATERIALS.filter((n) => n.endsWith('_planks')).map((n) => n.replace('_planks', '_door'));

function checkBudget(ctx) {
  if (typeof ctx.checkAborted === 'function') ctx.checkAborted();
  else if (ctx.aborted) throw new CancelledError('建造被取消');
}

function solidSafe(block) {
  return !!block && block.boundingBox === 'block' && !['lava', 'water', 'magma_block', 'cactus', 'fire', 'powder_snow'].includes(block.name);
}

function nextMaterial(actions, material) {
  return (material.names || [matName(material)]).find((n) => actions.countItem(n) > 0) || null;
}

function recordPlacement(material, name) {
  if (material.consumed) material.consumed[name] = (material.consumed[name] || 0) + 1;
}

/**
 * 建庇护所。
 * @param {object} o
 * @param {number} [o.size] 内部边长（3 = 3x3 内部，墙体围出 5x5 外框）
 * @param {boolean} [o.roof] 是否盖屋顶
 * @param {boolean} [o.door] 是否装门（没有门就用留一个口子）
 * @param {boolean} [o.torch] 是否放火把
 */
async function buildShelter({ actions, nav, state, ctx, config = null, size = 3, roof = true, door = true, torch = true }) {
  const bot = actions.bot;
  const steps = [];
  const inner = Math.max(2, Math.min(6, Math.floor(Number(size) || 3)));
  const outer = inner + 2;
  const wallHeight = 2;
  checkBudget(ctx);

  // ---- 0. 先回到地表。
  // 挖完矿她可能在洞里，而洞里既没有平地也没有放方块的余地——
  // 实测这就是"一块墙都没放上去，可能没站在合适的依附位置上"的来源。
  const climb = await climbToSurface({ actions, nav, ctx });
  if (climb.steps > 0) {
    steps.push(`挖阶梯回到地表 ${climb.steps} 格`);
    log.info(`盖房前先爬出矿道：${climb.steps} 格（ok=${climb.ok}）`);
  }

  // ---- 1. 选点：以当前位置为中心的平地
  let origin = await pickFlatSpot({ actions, ctx, size: inner });
  if (!origin) {
    // 实在没有像样的平地：就地整平（clearFootprint 会挖掉高出的部分、fillFloor 会补洞）。
    // 真人在山坡上盖房也是先刨出一块平台，而不是换个地方再试。
    const p0 = bot.entity.position;
    origin = { x: Math.floor(p0.x), y: Math.floor(p0.y), z: Math.floor(p0.z), leveled: true };
    log.info('附近没有天然平地，就地整平后建造');
    steps.push('附近没有平地，就地整平');
  }
  ctx.progress(`选好建造位置 (${origin.x}, ${origin.y}, ${origin.z})`);
  log.info(`建造选址 (${origin.x},${origin.y},${origin.z})，当前位置 (${bot.entity.position.x.toFixed(1)},${bot.entity.position.y.toFixed(2)},${bot.entity.position.z.toFixed(1)})`);
  checkBudget(ctx);

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

  checkBudget(ctx);
  // 清场后按真实缺格备料；地板本来完整时无需另挖地板预留量。
  await clearFootprint({ actions, ctx, origin, outer, wallHeight, steps });
  const doorPos = door ? pickDoorPosition({ origin, outer }) : null;
  const inspect = () => inspectShelter({ actions, origin, outer, wallHeight, roof, doorPos });
  const needed = { door: door ? 1 : 0, torch: torch ? 2 : 0, blocks: () => inspect().missing_blocks.length };
  const material = await ensureMaterials({ actions, nav, state, ctx, steps, needed, origin, outer });
  if (!material) {
    return skillResult(false, {
      steps, reason: '材料凑不齐，停止建造以免留下无法过夜的半栋屋子',
      extra: { shelter: shelterReport({ origin, inner, outer, wallHeight, material: null, doorPos, inspection: inspect() }) },
    });
  }
  ctx.progress(`建材准备完毕：共 ${material.names.reduce((n, name) => n + actions.countItem(name), 0)} 个可用方块`);
  checkBudget(ctx);

  // 取材可能把人带回矿坑。先回到有地板的施工位置，再围墙，避免把自己封在外面。
  await moveToBuildPosition({ actions, nav, ctx, origin, outer });
  // ---- 4. 打地基：把脚下垫平（有洞就填）
  await fillFloor({ actions, nav, ctx, origin, outer, material, steps });
  await moveToBuildPosition({ actions, nav, ctx, origin, outer });

  // ---- 5. 砌墙（从外圈开始，从下往上；门的位置留空）
  await buildWalls({ actions, nav, ctx, origin, outer, wallHeight, material, doorPos, steps });

  // ---- 6. 屋顶
  if (roof) {
    await buildRoof({ actions, nav, ctx, origin, outer, wallHeight, material, steps });
  }

  // ---- 7. 门
  if (door && doorPos) {
    await installDoor({ actions, nav, ctx, doorPos, material, steps });
  }

  // ---- 8. 火把
  if (torch) {
    await placeTorches({ actions, ctx, origin, inner, steps });
  }

  // 任务成功必须来自世界验收，不能把 roof/door 请求参数当作建成结果。
  checkBudget(ctx);
  let inspection = inspect();
  if (!inspection.complete) {
    return skillResult(false, {
      steps, consumed: material.consumed,
      reason: `庇护所未完成：地板缺 ${inspection.missing_floor.length} 格、墙缺 ${inspection.missing_walls.length} 格、屋顶缺 ${inspection.missing_roof.length} 格${doorPos && !inspection.has_door ? '、门未装好' : ''}`,
      extra: { shelter: shelterReport({ origin, inner, outer, wallHeight, material, doorPos, inspection }) },
    });
  }

  // 房屋已成形，后续进屋和家具操作不能通过自动挖墙寻路破坏它。
  const { executionContext } = require('../goals');
  return executionContext.run({ ...executionContext.getStore(), allowTerrainDig: false }, async () => {
    // ---- 9. 进屋验收
    const inside = checkInside({ actions, origin, inner });
    if (!inside) {
      ctx.progress('走到屋里确认');
      try {
        await nav.goTo({ x: origin.x + 0.5 + Math.floor(outer / 2), y: origin.y, z: origin.z + 0.5 + Math.floor(outer / 2), range: 0.7, signal: ctx.signal, timeoutMs: 15000, segmented: false });
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        checkBudget(ctx);
        log.info(`进屋失败：${err.message}`);
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
    checkBudget(ctx);
    try {
      await furnish({ actions, nav, state, ctx, origin, inner, steps, out: furnished });
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      log.debug(`布置家具失败（不影响房子本身）：${err.message}`);
    }

    checkBudget(ctx);
    inspection = inspect();
    const shelter = { ...shelterReport({ origin, inner, outer, wallHeight, material, doorPos, inspection }), furnished,
      ...homeScope(bot, config), verified_at: Date.now() };

    const extras = [
      shelter.has_roof ? '有屋顶' : '',
      shelter.has_door ? '有门' : '',
      furnished.chest ? '有箱子' : '',
      furnished.bed ? '有床' : '',
    ].filter(Boolean);

    return skillResult(inspection.complete, {
      steps,
      consumed: material.consumed,
      note: `${inspection.complete ? '庇护所建好了' : '庇护所尚未完整'}：外框 ${outer}×${outer}、墙高 ${wallHeight}${extras.length ? '、' + extras.join('、') : ''}，位置 (${origin.x}, ${origin.y}, ${origin.z})`,
      extra: { shelter },
      reason: inspection.complete ? null : '验收时结构已发生变化，庇护所尚未完整',
    });
  });
}

/**
 * 给屋子添置箱子/床，并把身上的杂物存进箱子。
 *
 * 每一项都是"能就做、不能就跳过"——不因为缺羊毛就让整栋房子算失败。
 */
async function furnish({ actions, nav, state, ctx, origin, inner, steps, out }) {
  checkBudget(ctx);
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
        if (err instanceof CancelledError) throw err;
        checkBudget(ctx);
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
      out.chest = blockAt(bot, cx, floorY, cz)?.name === 'chest';
      if (out.chest) out.chest_position = { x: cx, y: floorY, z: cz };
      steps.push({ action: 'place_chest', ok: out.chest });
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      checkBudget(ctx);
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
        if (err instanceof CancelledError) throw err;
        checkBudget(ctx);
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
      out.bed = blockAt(bot, cx + 1, origin.y, cz)?.name === bed;
      if (out.bed) out.bed_position = { x: cx + 1, y: origin.y, z: cz };
      steps.push({ action: 'place_bed', ok: out.bed });
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      checkBudget(ctx);
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
    checkBudget(ctx);
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

  // 先选没有高差的地面。附近有完整平台时，不把刚挖过的矿坑当作首选地基。
  // 放宽是有道理的——clearFootprint 会把高出的部分挖掉（墙高 3），
  // 等于她自己动手整平；严格只认"天然完美平地"会在山地/丛林里直接放弃。
  for (const tolerance of [0, 1, 2, 3]) {
    for (const c of scored) {
      checkBudget(ctx);
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
      // 已放置的工作站和灯具另选位置避开，避免清场被白名单拦截后仍在占用格上砌墙。
      for (const dy of [0, 1]) {
        const name = blockAt(bot, gx, y + dy, gz)?.name || '';
        if (['crafting_table', 'furnace', 'blast_furnace', 'smoker', 'chest', 'trapped_chest',
          'barrel', 'ender_chest', 'torch', 'wall_torch', 'lantern', 'soul_torch', 'soul_wall_torch', 'soul_lantern'].includes(name) ||
          name.endsWith('_door') || name.endsWith('_bed') || name.endsWith('_shulker_box')) return false;
      }
      minY = Math.min(minY, g);
      maxY = Math.max(maxY, g);
      // 提前退出：已经超出容差就不用继续读了
      if (maxY - minY > tolerance) return false;
    }
  }
  return maxY - minY <= tolerance;
}

function inspectShelter({ actions, origin, outer, wallHeight, roof, doorPos }) {
  const bot = actions.bot;
  let unknown = 0;
  const read = (x, y, z) => { const b = blockAt(bot, x, y, z); if (!b) unknown += 1; return b; };
  const missing_floor = [], missing_walls = [], missing_roof = [];
  for (let dx = 0; dx < outer; dx += 1) {
    for (let dz = 0; dz < outer; dz += 1) {
      const x = origin.x + dx, z = origin.z + dz;
      const floor = { x, y: origin.y - 1, z };
      if (!solidSafe(read(x, floor.y, z))) missing_floor.push(floor);
      if (dx === 0 || dz === 0 || dx === outer - 1 || dz === outer - 1) {
        if (!doorPos || x !== doorPos.x || z !== doorPos.z) {
          for (let dy = 0; dy < wallHeight; dy += 1) {
            const cell = { x, y: origin.y + dy, z };
            if (!solidSafe(read(x, cell.y, z))) missing_walls.push(cell);
          }
        }
      }
      if (roof) {
        const cell = { x, y: origin.y + wallHeight, z };
        if (!solidSafe(read(x, cell.y, z))) missing_roof.push(cell);
      }
    }
  }
  let has_door = false;
  if (doorPos) {
    const lower = read(doorPos.x, doorPos.y, doorPos.z);
    const upper = read(doorPos.x, doorPos.y + 1, doorPos.z);
    const half = (b) => typeof b?.getProperties === 'function' ? b.getProperties().half : null;
    has_door = !!lower && !!upper && lower.name.endsWith('_door') && lower.name === upper.name &&
      (!half(lower) || half(lower) === 'lower') && (!half(upper) || half(upper) === 'upper');
  }
  return {
    unknown,
    missing_floor, missing_walls, missing_roof,
    missing_blocks: [...missing_floor, ...missing_walls, ...missing_roof],
    has_roof: !!roof && missing_roof.length === 0, has_door,
    complete: missing_floor.length === 0 && missing_walls.length === 0 && missing_roof.length === 0 && (!doorPos || has_door),
  };
}

function homeScope(bot, config = null) {
  const socket = bot?._client?.socket;
  return { server: socket ? `${socket.remoteAddress}:${socket.remotePort}` :
    config ? `${config.get('host')}:${config.get('port')}` : null,
  dimension: bot?.game?.dimension ? String(bot.game.dimension).replace(/^minecraft:/, '') : null };
}

function validateHome(home) {
  if (!home || !home.server || !home.dimension || !home.origin ||
      !['x', 'y', 'z'].every((k) => Number.isInteger(home.origin[k])) ||
      !Number.isInteger(home.size) || home.size < 4 || home.size > 8 ||
      !Number.isInteger(home.wall_height) || home.wall_height < 2 || home.wall_height > 4) {
    throw new Error('基地记录缺少有效世界、坐标或结构尺寸');
  }
  if (home.door_position && !['x', 'y', 'z'].every((k) => Number.isInteger(home.door_position[k]))) {
    throw new Error('基地门坐标无效');
  }
  return home;
}

function inspectHome({ actions, state = null, config = null, home }) {
  validateHome(home);
  const scope = homeScope(actions.bot, config);
  const sameWorld = home.server === scope.server && String(home.dimension).replace(/^minecraft:/, '') === scope.dimension;
  if (!sameWorld) return { condition: 'other_world', safe: false, inside: false, loaded: false };
  const inspection = inspectShelter({ actions, origin: home.origin, outer: home.size,
    wallHeight: home.wall_height, roof: true, doorPos: home.door_position || null });
  const p = actions.bot.entity.position;
  const center = { x: home.origin.x + home.size / 2, y: home.origin.y, z: home.origin.z + home.size / 2 };
  const inside = p.x >= home.origin.x + 1 && p.x < home.origin.x + home.size - 1 &&
    p.z >= home.origin.z + 1 && p.z < home.origin.z + home.size - 1 && Math.abs(p.y - home.origin.y) < 1.2;
  const condition = inspection.unknown ? 'unknown' : inspection.complete ? 'intact' : 'missing';
  const doorPair = home.door_position ? [0, 1].map((dy) => blockAt(actions.bot,
    home.door_position.x, home.door_position.y + dy, home.door_position.z)) : [];
  const doorClosed = !home.door_position || doorPair.every((b, i) => b?.name?.endsWith('_door') &&
    b.name === doorPair[0].name && typeof b.getProperties === 'function' &&
    b.getProperties().half === (i ? 'upper' : 'lower') && b.getProperties().open === false);
  const furniture = { bed: false, chest: false, crafting_table: false, furnace: false, smoker: false, blast_furnace: false,
    furnace_lit: false, smoker_lit: false, blast_furnace_lit: false };
  if (!inspection.unknown) {
    for (let dx = 1; dx < home.size - 1; dx += 1) for (let dz = 1; dz < home.size - 1; dz += 1) {
      const b = blockAt(actions.bot, home.origin.x + dx, home.origin.y, home.origin.z + dz);
      if (b?.name?.endsWith('_bed')) { furniture.bed = true; furniture.bed_position = { x: b.position.x, y: b.position.y, z: b.position.z }; }
      for (let dy = 0; dy < home.wall_height; dy += 1) {
        const station = blockAt(actions.bot, home.origin.x + dx, home.origin.y + dy, home.origin.z + dz);
        if (['chest', 'trapped_chest', 'barrel'].includes(station?.name)) {
          furniture.chest = true;
          furniture.chest_position = { x: station.position.x, y: station.position.y, z: station.position.z };
        }
        if (['crafting_table', 'furnace', 'smoker', 'blast_furnace'].includes(station?.name)) {
          furniture[station.name] = true;
          furniture[`${station.name}_position`] = { x: station.position.x, y: station.position.y, z: station.position.z };
          if (['furnace', 'smoker', 'blast_furnace'].includes(station.name)) {
            let lit = false;
            try { lit = station.getProperties?.().lit === true; } catch { /* Unknown block properties prove no heat. */ }
            furniture[`${station.name}_lit`] ||= lit;
          }
        }
      }
    }
  }
  const intruder = state && state.nearbyEntities({ radius: 12, limit: 12, hostileOnly: true }).some((e) =>
    e.position.x > home.origin.x && e.position.x < home.origin.x + home.size &&
    e.position.z > home.origin.z && e.position.z < home.origin.z + home.size && Math.abs(e.position.y - home.origin.y) < 3);
  const hazard = actions.bot.entity.isInWater || actions.bot.entity.isInLava || actions.bot.entity.isOnFire;
  return { condition, loaded: !inspection.unknown, complete: condition === 'intact', inside,
    safe: inside && condition === 'intact' && doorClosed && !intruder && !hazard,
    door_closed: doorClosed, distance: distance(p, center), furniture, unknown_blocks: inspection.unknown };
}

// Infer the two sides from the recorded footprint, not a stale facing/heading.
function homeEntrance(home) {
  const door = home.door_position, { origin, size } = home;
  if (!door || door.y !== origin.y) return null;
  const middleX = door.x > origin.x && door.x < origin.x + size - 1;
  const middleZ = door.z > origin.z && door.z < origin.z + size - 1;
  const inward = middleX && door.z === origin.z ? { x: 0, z: 1 } :
    middleX && door.z === origin.z + size - 1 ? { x: 0, z: -1 } :
    middleZ && door.x === origin.x ? { x: 1, z: 0 } :
    middleZ && door.x === origin.x + size - 1 ? { x: -1, z: 0 } : null;
  if (!inward) return null;
  const side = (sign) => ({ x: door.x + inward.x * sign + 0.5, y: door.y,
    z: door.z + inward.z * sign + 0.5 });
  return { outside: side(-1), inside: side(1), inward };
}

function safeHomeLanding(bot, position) {
  return solidSafe(blockAt(bot, position.x, position.y - 1, position.z)) && [0, 1].every((dy) => {
    const b = blockAt(bot, position.x, position.y + dy, position.z);
    return b?.boundingBox === 'empty' && !mining.isDangerous(b.name) && !['water', 'flowing_water'].includes(b.name);
  });
}

async function returnHome({ actions, nav, state, ctx, config, home, sleep = true, timeoutMs = 60000, waitSeconds = 0 }) {
  validateHome(home);
  let status = inspectHome({ actions, state, config, home });
  if (status.condition === 'other_world') return skillResult(false, { reason: '基地属于其他服务器或维度', extra: { home, home_status: status } });
  if (status.distance > 256) return skillResult(false, { reason: '基地超过 256 格，当前先安排附近临时住处或分段旅行', extra: { home, home_status: status } });
  const { executionContext } = require('../goals');
  return executionContext.run({ ...executionContext.getStore(), allowTerrainDig: false }, async () => {
    const entryDeadline = Math.min(Date.now() + Math.min(60000, Math.max(1, Number(timeoutMs) || 60000)), ctx.deadline || Infinity);
    const remaining = () => {
      ctx.checkAborted();
      if (actions._stopped) throw new CancelledError('引擎已急停');
      const ms = entryDeadline - Date.now();
      if (ms <= 0) throw new TimeoutError('回基地进屋超时');
      return ms;
    };
    const travel = async (target) => {
      await nav.goTo({ ...target, range: 0.5, signal: ctx.signal, timeoutMs: remaining(), segmented: false });
      remaining();
    };
    if (!status.inside) {
      ctx.progress('回基地，走近后检查房屋');
      try {
        const entrance = homeEntrance(home);
        if (!entrance) throw new Error('基地记录没有位于墙边的有效入口');
        if (status.loaded && !safeHomeLanding(actions.bot, entrance.outside)) throw new Error('基地门外没有安全落脚点');
        await travel(entrance.outside);
        status = inspectHome({ actions, state, config, home });
        if (distance(actions.bot.entity.position, entrance.outside) > 1 || !safeHomeLanding(actions.bot, entrance.outside)) {
          throw new Error('尚未实际到达基地门外安全落脚点');
        }
        if (status.condition !== 'intact') throw new Error(status.condition === 'unknown' ? '基地地形仍未加载' : '基地结构被改变或拆除');
        if (!safeHomeLanding(actions.bot, entrance.inside)) throw new Error('基地门内入口被挡住或不安全');
        const door = blockAt(actions.bot, home.door_position.x, home.door_position.y, home.door_position.z);
        if (door?.name === 'iron_door') throw new Error('铁门不能手动打开并关闭，当前不能安全进屋');
        ctx.progress('在基地门外确认木门，打开后再进屋');
        const opened = await actions.openDoor({ ...home.door_position, signal: ctx.signal, timeoutMs: remaining() });
        remaining();
        if (!opened.ok) throw new Error(opened.note);
        ctx.progress('基地门已确认打开，正在从入口进屋');
        // Pathfinder postProcessPath targets the top of a door shape even when
        // it is open. Cross only this verified two-block opening with real physics.
        const entered = await actions.enterDoor({ ...home.door_position, target: entrance.inside,
          signal: ctx.signal, timeoutMs: remaining() });
        remaining();
        if (!entered.ok) throw new Error(entered.note);
      } catch (err) {
        if (err instanceof CancelledError || err.name === 'CancelledError' || err.name === 'AbortError') throw err;
        status = inspectHome({ actions, state, config, home });
        return skillResult(false, { reason: `暂时走不到基地：${describeFailure(err)}`, extra: { home, home_status: status } });
      }
    }
    remaining();
    status = inspectHome({ actions, state, config, home });
    if (status.inside && status.condition === 'intact' && !status.door_closed && home.door_position) {
      try {
        const closed = await actions.closeDoor({ ...home.door_position, signal: ctx.signal, timeoutMs: remaining() });
        remaining();
        status = inspectHome({ actions, state, config, home });
        if (!closed.ok) return skillResult(false, { reason: closed.note, extra: { home, home_status: status } });
      } catch (err) {
        if (err instanceof CancelledError || err.name === 'CancelledError' || err.name === 'AbortError') throw err;
        status = inspectHome({ actions, state, config, home });
        return skillResult(false, { reason: `无法安全关上基地门：${describeFailure(err)}`, extra: { home, home_status: status } });
      }
    }
    if (!status.safe) return skillResult(false, { reason: status.condition === 'unknown' ? '基地地形仍未加载，位置保留，暂不能确认安全' :
      status.condition === 'missing' ? '基地结构被改变或拆除，当前不能安全居住' : '尚未安全进入基地', extra: { home, home_status: status } });
    if (actions.stations) for (const kind of ['bed', 'chest']) {
      if (status.furniture[`${kind}_position`]) actions.stations.remember(kind, status.furniture[`${kind}_position`]);
    }
    const tod = Number(actions.bot.time?.timeOfDay || 0);
    let slept = false;
    let sleepResult = null;
    let note = '已回到基地并确认房屋完整';
    if (sleep && status.furniture.bed && String(home.dimension).replace(/^minecraft:/, '') === 'overworld' && tod >= 12541 && tod <= 23458) {
      sleepResult = await actions.sleepInBed({ signal: ctx.signal, timeoutMs: remaining(), bed_position: status.furniture.bed_position });
      ctx.checkAborted();
      if (actions._stopped) throw new CancelledError('引擎已急停');
      slept = !!sleepResult.ok && sleepResult.day_confirmed === true;
      note += `；${sleepResult.note || (slept ? '已确认睡到天亮' : '暂时不能睡到天亮')}`;
    }
    // 没有床时有限留家避夜；计划在下一次生存检查之前不应立刻带她又出门。
    const waitUntil = Math.min(entryDeadline, Date.now() + Math.min(30000, Math.max(0, waitSeconds * 1000)));
    let waitedMs = 0;
    let waitingThreat = false;
    const startedWaiting = Date.now();
    if (!status.furniture.bed && String(home.dimension).replace(/^minecraft:/, '') === 'overworld') {
      while (Date.now() < waitUntil) {
        ctx.checkAborted();
        const nowTime = Number(actions.bot.time?.timeOfDay || 0);
        waitingThreat = !!state?.nearbyEntities({ radius: 6, limit: 1, hostileOnly: true }).length;
        if (nowTime < 12541 || nowTime > 23458 || typeof actions.bot.food === 'number' && actions.bot.food <= 10 || waitingThreat) break;
        await delay(Math.min(500, waitUntil - Date.now()), { signal: ctx.signal });
      }
      waitedMs = Date.now() - startedWaiting;
      ctx.checkAborted();
      status = inspectHome({ actions, state, config, home });
      if (!status.safe) return skillResult(false, { reason: '留家期间基地不再安全', extra: { home, home_status: status, waited_ms: waitedMs } });
      if (waitingThreat) return skillResult(false, { reason: '屋旁有威胁，先处理危险再决定如何过夜', extra: { home, home_status: status, waited_ms: waitedMs } });
      if (waitedMs) note += '；在屋里暂避夜晚';
    }
    ctx.checkAborted();
    if (actions._stopped) throw new CancelledError('引擎已急停');
    status = inspectHome({ actions, state, config, home });
    if (!status.safe) return skillResult(false, { reason: '休息后基地不再安全', extra: { home, home_status: status, slept, sleep_result: sleepResult, waited_ms: waitedMs } });
    return skillResult(true, { note, extra: { home, home_status: status, slept, sleep_result: sleepResult, waited_ms: waitedMs } });
  });
}

/** Leave a verified home through its real doorway, then confirm it is closed. */
async function leaveHome({ actions, nav, state, ctx, config = null, home, timeoutMs = 20000 }) {
  const parentSignal = ctx.signal, controller = new AbortController(), parentCtx = ctx;
  const cancel = () => controller.abort();
  if (parentSignal?.aborted) cancel();
  parentSignal?.addEventListener('abort', cancel, { once: true });
  for (const event of ['respawn', 'end']) actions.bot.on?.(event, cancel);
  ctx = Object.create(parentCtx);
  ctx.signal = controller.signal;
  try {
    return await leaveHomeInWorld({ actions, nav, state, ctx, config, home, timeoutMs });
  } finally {
    parentSignal?.removeEventListener('abort', cancel);
    for (const event of ['respawn', 'end']) actions.bot.removeListener?.(event, cancel);
  }
}

async function leaveHomeInWorld({ actions, nav, state, ctx, config, home, timeoutMs }) {
  ctx.checkAborted();
  validateHome(home);
  let status = inspectHome({ actions, state, config, home });
  if (!status.safe) return skillResult(false, { reason: '尚未在完整且关门的基地内，不能安全继续工作',
    extra: { home, home_status: status } });
  const scope = JSON.stringify(homeScope(actions.bot, config));
  const { executionContext } = require('../goals');
  return executionContext.run({ ...executionContext.getStore(), signal: ctx.signal, allowTerrainDig: false }, async () => {
    const deadline = Math.min(Date.now() + Math.min(60000, Math.max(1, Number(timeoutMs) || 20000)), ctx.deadline || Infinity);
    const remaining = () => {
      ctx.checkAborted();
      if (actions._stopped) throw new CancelledError('引擎已急停');
      if (JSON.stringify(homeScope(actions.bot, config)) !== scope) throw new CancelledError('出基地期间世界已切换');
      const ms = deadline - Date.now();
      if (ms <= 0) throw new TimeoutError('出基地继续工作超时');
      return ms;
    };
    try {
      remaining();
      const entrance = homeEntrance(home);
      if (!entrance) throw new Error('基地记录没有位于墙边的有效入口');
      if (!safeHomeLanding(actions.bot, entrance.inside) || !safeHomeLanding(actions.bot, entrance.outside)) {
        throw new Error('基地门内或门外没有安全落脚点');
      }
      ctx.progress('存物后走到基地门内，检查出门路线');
      await nav.goTo({ ...entrance.inside, range: 0.5, signal: ctx.signal, timeoutMs: remaining(), segmented: false });
      remaining();
      status = inspectHome({ actions, state, config, home });
      if (!status.safe || distance(actions.bot.entity.position, entrance.inside) > 1 ||
          !safeHomeLanding(actions.bot, entrance.inside) || !safeHomeLanding(actions.bot, entrance.outside)) {
        throw new Error('尚未实际到达基地门内安全落脚点');
      }
      const opened = await actions.openDoor({ ...home.door_position, signal: ctx.signal, timeoutMs: remaining() });
      remaining();
      if (!opened.ok) throw new Error(opened.note || '服务器未确认基地门打开');
      // enterDoor checks a two-block doorway symmetrically: the opposite target
      // makes its starting side the inside and its verified target the outside.
      const crossed = await actions.enterDoor({ ...home.door_position, target: entrance.outside,
        signal: ctx.signal, timeoutMs: remaining() });
      remaining();
      if (!crossed.ok || distance(actions.bot.entity.position, entrance.outside) > 1 ||
          !safeHomeLanding(actions.bot, entrance.outside)) throw new Error(crossed.note || '尚未实际走出基地');
      status = inspectHome({ actions, state, config, home });
      if (status.inside || status.condition !== 'intact') throw new Error('出门期间基地结构被改变，不能继续工作');
      const closed = await actions.closeDoor({ ...home.door_position, signal: ctx.signal, timeoutMs: remaining() });
      remaining();
      status = inspectHome({ actions, state, config, home });
      if (!closed.ok || status.inside || status.condition !== 'intact' || !status.door_closed ||
          distance(actions.bot.entity.position, entrance.outside) > 1 || !safeHomeLanding(actions.bot, entrance.outside)) {
        throw new Error(closed.note || '尚未确认安全出门并关上基地门');
      }
      return skillResult(true, { note: '已从基地实际出门并确认门已关闭，可以继续工作',
        extra: { home, home_status: status, left_home: true } });
    } catch (err) {
      if (err instanceof CancelledError || err.name === 'CancelledError' || err.name === 'AbortError') throw err;
      if (ctx.signal?.aborted || actions._stopped || JSON.stringify(homeScope(actions.bot, config)) !== scope) {
        throw new CancelledError('出基地被取消或世界已切换');
      }
      status = inspectHome({ actions, state, config, home });
      return skillResult(false, { reason: `暂时无法安全出基地：${describeFailure(err)}`,
        extra: { home, home_status: status, left_home: false } });
    }
  });
}

function shelterReport({ origin, inner, outer, wallHeight, material, doorPos, inspection }) {
  return {
    origin, size: outer, inner, wall_height: wallHeight,
    material: material?.name || null, materials: material?.names || [],
    has_roof: inspection.has_roof, has_door: inspection.has_door,
    door_position: doorPos, complete: inspection.complete,
    missing_floor: inspection.missing_floor, missing_walls: inspection.missing_walls, missing_roof: inspection.missing_roof,
  };
}

/** 保证有足够的建材、门、火把；不够就去弄 */
async function ensureMaterials({ actions, nav, state, ctx, steps, needed, origin, outer }) {
  checkBudget(ctx);
  // 门先备好，避免把门所需木板当墙料用掉；配方需要同种木板六块。
  if (needed.door && !DOOR_NAMES.some((n) => actions.countItem(n) > 0)) {
    try {
      const tableExists = actions.countItem('crafting_table') > 0 ||
        actions.bot.findBlock({ matching: (b) => b && b.name === 'crafting_table', maxDistance: 24 });
      const candidates = () => wood.LOG_NAMES.map((logName) => {
        const planks = wood.planksOf(logName);
        const otherPlanks = wood.countPlanks(actions) - actions.countItem(planks);
        const wanted = 6 + (tableExists ? 0 : Math.max(0, 4 - otherPlanks));
        return { logName, planks, wanted, have: actions.countItem(planks) + actions.countItem(logName) * 4 };
      }).sort((a, b) => b.have - a.have);
      // 现有一根原木也可能不够；按门和缺失工作台的实际用量补齐。
      // 每轮重新选同种材料，避免混合六种木板却误以为能合成门。
      for (let attempt = 0; attempt < 3 && !candidates().some((c) => c.have >= c.wanted); attempt += 1) {
        checkBudget(ctx);
        const best = candidates()[0];
        const before = wood.totalLogs(actions);
        const want = Math.max(1, Math.ceil((best.wanted - best.have) / 4));
        ctx.progress(`装门还缺材料，取 ${want} 根原木`);
        const r = await wood.chopTree({ actions, nav, state, ctx, want, maxAttempts: 4 });
        steps.push(...(r.steps || []));
        checkBudget(ctx);
        if (wood.totalLogs(actions) <= before) break;
      }
      const candidate = candidates().find((c) => c.have >= c.wanted);
      const planks = candidate?.planks;
      if (candidate) {
        const deficit = Math.max(0, candidate.wanted - actions.countItem(planks));
        if (deficit) {
          const plankResult = await actions.craft({ item: planks, count: Math.ceil(deficit / 4) * 4, signal: ctx.signal });
          checkBudget(ctx);
          if (!plankResult.ok) steps.push(`做门木板没有产出：${planks}`);
        }
      }
      if (planks && actions.countItem(planks) >= 6) {
        const table = await wood.ensureCraftingTable({ actions, ctx, steps });
        checkBudget(ctx);
        if (!table.ok) { steps.push(`工作台准备失败：${table.reason || table.note || '没有可用工作台'}`); return null; }
        const doorName = planks.replace('_planks', '_door');
        const doorResult = await actions.craft({ item: doorName, count: 1, signal: ctx.signal });
        checkBudget(ctx);
        if (actions.countItem(doorName) > 0) steps.push(`合成 ${doorName}`);
        else steps.push(`做门没有产出：${doorName}（ok=${!!doorResult.ok}）`);
      } else steps.push('门材料不足：需要六块同种木板');
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      checkBudget(ctx);
      steps.push(`做门失败：${describeFailure(err)}`);
    }
  }
  if (needed.door && !DOOR_NAMES.some((n) => actions.countItem(n) > 0)) return null;

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
            if (err instanceof CancelledError) throw err;
            checkBudget(ctx);
            log.info(`烧木炭失败：${err.message}`);
          }
        }
      }
      if ((actions.countItem('coal') > 0 || actions.countItem('charcoal') > 0) && actions.countItem('stick') >= 1) {
        const torchR4 = await actions.craft({ item: 'torch', count: 4, signal: ctx.signal });
        if (torchR4.ok) { steps.push('合成火把'); } else { log.info('火把没做出来（craft 返回 ok=false，不致命）'); }
      }
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      checkBudget(ctx);
      log.debug(`做火把失败（不致命）：${err.message}`);
    }
  }
  // 只补实际缺量，合并圆石/泥土/各类木板；采矿改变地基后重新读世界。
  const available = () => BUILD_MATERIALS.reduce((n, name) => n + actions.countItem(name), 0);
  // 背包原木也是现成建材，不应留着原木却下矿补墙料。
  for (const logName of wood.LOG_NAMES) {
    checkBudget(ctx);
    const deficit = needed.blocks() - available();
    if (deficit <= 0) break;
    const planks = wood.planksOf(logName);
    if (!BUILD_MATERIALS.includes(planks)) continue;
    const logs = Math.min(actions.countItem(logName), Math.ceil(deficit / 4));
    if (!logs) continue;
    const result = await actions.craft({ item: planks, count: logs * 4, signal: ctx.signal });
    checkBudget(ctx);
    if (result.ok) steps.push(`把现有 ${logName} 转成 ${result.produced} 块木板作建材`);
  }
  while (available() < needed.blocks()) {
    checkBudget(ctx);
    const before = available();
    const lacking = needed.blocks() - before;
    ctx.progress(`建材不足，补 ${lacking} 个方块`);
    // 在预定地基外取材；挖地板得到一块建材，却新增一格待补地板，永远补不齐。
    const p = actions.bot.entity.position;
    if (p.x >= origin.x - 3 && p.x <= origin.x + outer + 3 &&
        p.z >= origin.z - 3 && p.z <= origin.z + outer + 3) {
      const midX = origin.x + outer / 2, midZ = origin.z + outer / 2;
      const sites = [
        { x: origin.x - 8 + 0.5, y: origin.y, z: midZ },
        { x: origin.x + outer + 7.5, y: origin.y, z: midZ },
        { x: midX, y: origin.y, z: origin.z - 8 + 0.5 },
        { x: midX, y: origin.y, z: origin.z + outer + 7.5 },
      ].filter((point) => {
        const cx = Math.floor(point.x), cz = Math.floor(point.z);
        if (!solidSafe(blockAt(actions.bot, cx, origin.y - 1, cz)) ||
            ![0, 1].every((dy) => blockAt(actions.bot, cx, origin.y + dy, cz)?.boundingBox === 'empty')) return false;
        let ground = 0;
        for (const dx of [-1, 0, 1]) for (const dz of [-1, 0, 1]) {
          if (solidSafe(blockAt(actions.bot, cx + dx, origin.y - 1, cz + dz))) ground += 1;
        }
        return ground >= 7;
      }).sort((a, b) => distance(p, a) - distance(p, b));
      let moved = false, lastError = null;
      for (const site of sites.slice(0, 3)) {
        checkBudget(ctx);
        try {
          await nav.goTo({ ...site, range: 1, signal: ctx.signal, timeoutMs: 10000, segmented: false, xzOnly: true });
          if (Math.abs(actions.bot.entity.position.y - site.y) > 1.2) throw new Error('取材点仍有高度差，未走到安全地面');
          moved = true;
          break;
        } catch (err) {
          if (err instanceof CancelledError) throw err;
          checkBudget(ctx);
          lastError = err;
        }
      }
      if (!moved) throw lastError || new Error('地基外没有安全取材点');
      checkBudget(ctx);
    }
    const r = await mining.mineStone({ actions, nav, state, ctx, want: lacking });
    steps.push(...(r.steps || []));
    checkBudget(ctx);
    if (available() <= before) return null;
  }
  const names = BUILD_MATERIALS.filter((n) => actions.countItem(n) > 0);
  return { name: names[0] || null, names, consumed: {} };
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
    checkBudget(ctx);
    try {
      await actions.dig({ x: t.x, y: t.y, z: t.z, signal: ctx.signal, collect: true, reach: true });
      cleared += 1;
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      checkBudget(ctx);
      log.info(`清理 (${t.x},${t.y},${t.z}) 失败：${err.message}`);
    }
  }
  if (cleared) steps.push(`清理场地 ${cleared} 格`);
}

/** 把地板上的洞填上，保证内部是实心平面 */
async function fillFloor({ actions, nav, ctx, origin, outer, material, steps }) {
  const bot = actions.bot;
  const holes = [];
  for (let dx = 0; dx < outer; dx += 1) {
    for (let dz = 0; dz < outer; dz += 1) {
      const x = origin.x + dx;
      const z = origin.z + dz;
      const floor = blockAt(bot, x, origin.y - 1, z);
      if (!solidSafe(floor)) holes.push({ x, y: origin.y - 1, z });
    }
  }
  if (!holes.length) return;
  ctx.progress(`补地板（${holes.length} 处）`);
  let filled = 0;
  // 先补有依附面的边缘，再向空洞中央延伸。
  const supported = (h) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
    .some(([dx, dy, dz]) => solidSafe(blockAt(bot, h.x + dx, h.y + dy, h.z + dz)));
  while (holes.length) {
    const index = holes.findIndex(supported);
    if (index < 0) break;
    const [h] = holes.splice(index, 1);
    checkBudget(ctx);
    const item = nextMaterial(actions, material);
    if (!item) break;
    try {
      if (distance(bot.entity.position, { x: h.x + 0.5, y: h.y + 0.5, z: h.z + 0.5 }) > 4) {
        await moveToBuildPosition({ actions, nav, ctx, origin, outer, near: h });
      }
      await actions.place({ x: h.x, y: h.y, z: h.z, item, signal: ctx.signal, reach: false });
      if (solidSafe(blockAt(bot, h.x, h.y, h.z))) { filled += 1; recordPlacement(material, item); }
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      checkBudget(ctx);
      log.info(`补地板 (${h.x},${h.y},${h.z}) 失败：${err.message}`);
    }
  }
  if (filled) steps.push(`补地板 ${filled} 格`);
}

/** 在完整地板上施工；小屋中心可以直接够到所有墙和屋顶，不必追着墙格寻路。 */
async function moveToBuildPosition({ actions, nav, ctx, origin, outer, near = null }) {
  checkBudget(ctx);
  const bot = actions.bot;
  const center = { x: origin.x + outer / 2, y: origin.y, z: origin.z + outer / 2 };
  const candidates = [];
  for (let dx = -1; dx <= outer; dx += 1) {
    for (let dz = -1; dz <= outer; dz += 1) {
      const x = origin.x + dx, z = origin.z + dz;
      if (!solidSafe(blockAt(bot, x, origin.y - 1, z))) continue;
      if ([0, 1].some((dy) => blockAt(bot, x, origin.y + dy, z)?.boundingBox !== 'empty')) continue;
      const point = { x: x + 0.5, y: origin.y, z: z + 0.5 };
      if (near && distance(point, { x: near.x + 0.5, y: near.y + 0.5, z: near.z + 0.5 }) > 3.8) continue;
      candidates.push(point);
    }
  }
  candidates.sort((a, b) => distance(a, near || center) - distance(b, near || center));
  let lastError = null;
  for (const point of candidates.slice(0, 3)) {
    checkBudget(ctx);
    if (distance(bot.entity.position, point) < 0.8) return;
    try {
      await nav.goTo({ ...point, range: 0.7, signal: ctx.signal, timeoutMs: 15000, segmented: false, xzOnly: true });
      checkBudget(ctx);
      if (distance(bot.entity.position, point) > 1.2) throw new Error('仍未站到施工位置，停止远距离放置');
      return;
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      checkBudget(ctx);
      lastError = err;
    }
  }
  throw lastError || new Error('建造位置没有可站立的完整地板，无法安全施工');
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
      checkBudget(ctx);
      if (doorPos && cell.x === doorPos.x && cell.z === doorPos.z && dy <= 1) continue;
      // 已经有墙了就跳过
      const existing = blockAt(actions.bot, cell.x, cell.y, cell.z);
      if (existing && existing.boundingBox === 'block' && !existing.name.includes('grass') && !existing.name.includes('flower')) {
        continue;
      }
      const item = nextMaterial(actions, material);
      if (!item) break;
      // 墙的每一格都要有依附面：先确保自己在外面/里面够得到
      const used = await placeWithApproach({ actions, nav, ctx, cell, material: item, materials: material, origin, outer });
      if (used) { placed += 1; recordPlacement(material, used); }
    }
  }
  if (placed) steps.push(`砌墙 ${placed} 块`);
  return placed;
}

/** 放一块方块，够不到就先走近 */
async function placeWithApproach({ actions, nav, ctx, cell, material, materials, origin, outer, attempts = 3 }) {
  const bot = actions.bot;
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    checkBudget(ctx);
    // 最后一块物品的背包更新可能晚于世界更新；重试时重新选实际仍在背包里的建材。
    const item = materials ? nextMaterial(actions, materials) : material;
    if (!item) break;
    if (i > 0 && origin) {
      try { await moveToBuildPosition({ actions, nav, ctx, origin, outer, near: cell }); }
      catch (err) {
        if (err instanceof CancelledError) throw err;
        checkBudget(ctx);
        lastError = err;
      }
    }
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
        checkBudget(ctx);
      }
    }
    checkBudget(ctx);
    try {
      const r = await actions.place({ x: cell.x, y: cell.y, z: cell.z, item, signal: ctx.signal, reach: false });
      checkBudget(ctx);
      if (r.ok && solidSafe(blockAt(bot, cell.x, cell.y, cell.z))) return item;
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      checkBudget(ctx);
      // 自己站在目标格上 → 让开
      lastError = err;
      const cur = bot.entity.position;
      if (Math.floor(cur.x) === cell.x && Math.floor(cur.z) === cell.z && (Math.floor(cur.y) === cell.y || Math.floor(cur.y) + 1 === cell.y)) {
        try {
          await nav.goTo({ x: cell.x + 2.5, y: null, z: cell.z + 2.5, range: 1, signal: ctx.signal, timeoutMs: 8000 });
        } catch (moveErr) {
          if (moveErr instanceof CancelledError) throw moveErr;
          checkBudget(ctx);
        }
      } else {
        await delay(250, { signal: ctx.signal });
      }
    }
  }
  log.info(`建造放置 (${cell.x},${cell.y},${cell.z}) 未确认：${lastError?.message || '服务器返回后目标格仍未建成'}`);
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
      checkBudget(ctx);
      const existing = blockAt(actions.bot, cell.x, cell.y, cell.z);
      if (existing && existing.boundingBox === 'block') continue;
      const item = nextMaterial(actions, material);
      if (!item) break;
      const used = await placeWithApproach({ actions, nav, ctx, cell, material: item, materials: material, origin, outer });
      if (used) { placed += 1; recordPlacement(material, used); }
    }
    ctx.progress(`盖屋顶（第 ${inset + 1} 圈）`);
  }
  if (placed) steps.push(`盖屋顶 ${placed} 块`);
  return placed;
}

/** 装门：需要站在门内侧或外侧，把门放到门框里 */
async function installDoor({ actions, nav, ctx, doorPos, material, steps }) {
  checkBudget(ctx);
  const bot = actions.bot;
  const doorItem = DOOR_NAMES.find(
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
      const item = nextMaterial(actions, material);
      if (!item) return false;
      await actions.place({ x: base.x, y: base.y - 1, z: base.z, item, signal: ctx.signal, reach: true });
    }
    if (distance(bot.entity.position, base) > 4) {
      await nav.approach({ ...base, range: 2, signal: ctx.signal, timeoutMs: 10000 });
    }
    checkBudget(ctx);
    await actions.lookAtPoint(base.x + 0.5, base.y + 0.5, base.z + 0.5);
    checkBudget(ctx);
    const r = await actions.place({ x: base.x, y: base.y, z: base.z, item: doorItem, signal: ctx.signal, reach: false });
    if (r.ok) steps.push('装门');
    return r.ok;
  } catch (err) {
    if (err instanceof CancelledError) throw err;
    checkBudget(ctx);
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
    checkBudget(ctx);
    if (placed >= 2) break; // 两个就够照亮了
    if (actions.countItem('torch') <= 0) break;
    const b = blockAt(bot, s.x, s.y, s.z);
    if (b && b.boundingBox === 'block') continue; // 这格被占了，换下一个
    try {
      const r = await actions.place({ x: s.x, y: s.y, z: s.z, item: 'torch', signal: ctx.signal, reach: true });
      if (r.ok) placed += 1;
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      checkBudget(ctx);
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

module.exports = { buildShelter, pickFlatSpot, groundHeightAt, BUILD_MATERIALS, inspectHome, returnHome, leaveHome };
