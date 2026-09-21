'use strict';
/**
 * 引擎入口：NDJSON RPC 服务端。
 *
 * 启动方式：node index.js  （stdin/stdout 与 AstrBot 插件通信）
 * 调试方式：node index.js --cli   （手动敲 JSON 命令行，不依赖 AstrBot）
 *
 * 注意：这个文件只能往 stdout 写 NDJSON。所有日志走 stderr（见 log.js 已劫持 console）。
 */

const { RpcPeer, RpcError, GameError, NotConnectedError } = require('./rpc');
const log = require('./log');
const { McEngine } = require('./bot');
const { PRIORITY } = require('./goals');
const { describeFailure, distance, fmtVec, blockCenter, vec3, delay } = require('./util');
const skills = require('./skills');

const rpc = new RpcPeer({
  onMalformed: (msg) => log.warn(`协议流异常：${msg}`),
});

const engine = new McEngine({
  emit: (event, data) => {
    try {
      // 事件名也塞进 payload：插件侧的回调只拿到 data，
      // 没有这个字段就没法区分"是哪种发现"（第一次见生物 vs 挖到钻石）。
      rpc.notify(event, { ...(data || {}), _event: event });
    } catch (err) {
      log.warn(`事件推送失败 ${event}：${err.message}`);
    }
  },
});

// ================================================================ 工具函数

/** 统一的动作包装：任何失败都转成带建议的可读错误 */
function wrap(fn) {
  return async (params) => {
    try {
      return await fn(params || {});
    } catch (err) {
      if (!err) throw err;
      // 顺序有意义：NotConnectedError 继承自 RpcError，必须先于 GameError 判断，
      // 否则"没进服"会被压成普通的动作失败，插件侧就没法区分该重连还是该换策略。
      if (err instanceof NotConnectedError) throw err;
      if (err instanceof RpcError) throw err;
      if (err && (err.name === 'ActionError' || err.name === 'MissingItemError' || err.name === 'NoToolError' || err.name === 'ProtectedBlockError')) {
        throw new GameError(err.message, err.data);
      }
      if (err instanceof GameError) throw err;
      throw new GameError(describeFailure(err));
    }
  };
}

/** 动作类 RPC 的通用形态：立刻返回 task_id，动作在队列里执行 */
function submitAction({ name, priority = PRIORITY.USER, params = {}, run }) {
  const task = engine.submitAction({ name, priority, meta: { params }, run });
  return {
    ok: true,
    task_id: task.id,
    name: task.name,
    status: 'queued',
    note: '动作已提交，用 task.status 查询进度，task.cancel 取消。不要等待它完成再回话。',
  };
}

// ================================================================ 连接类

rpc.handle(
  'debug.probe',
  wrap(async () => {
    const bot = engine.requireBot();
    const pos = bot.entity.position;
    const fx = Math.floor(pos.x);
    const fy = Math.floor(pos.y);
    const fz = Math.floor(pos.z);
    // 同一份 blockAt 实现的两种调用方式对照，用来定位"为什么 state.get 读到 null"
    const a = engine.state.snapshot('normal');
    const b = bot.blockAt(vec3(fx, fy - 1, fz));
    const c = bot.blockAt({ x: fx, y: fy - 1, z: fz });
    return {
      entity_position: { x: pos.x, y: pos.y, z: pos.z },
      floored: { x: fx, y: fy, z: fz },
      snapshot_block_position: a.block_position,
      snapshot_standing_on: a.standing_on,
      snapshot_feet_block: a.feet_block,
      blockAt_vec3: b ? { name: b.name, pos: b.position } : null,
      blockAt_plain: c ? { name: c.name, pos: c.position } : 'THREW_OR_NULL',
      chunk_loaded: typeof bot.world?.getColumnAt === 'function',
      entity_onGround: bot.entity.onGround,
    };
  }),
);

rpc.handle(
  'debug.findlog',
  wrap(async () => {
    const bot = engine.requireBot();
    const wood = require('./skills/wood');
    const fakeActions = { bot };
    const found = await wood.findLogBlock({ actions: fakeActions, state: engine.state, radius: 32 });
    const near = engine.state.scanBlocks({ names: wood.LOG_NAMES, radius: 16, limit: 10 });
    const raw = [];
    const p = bot.entity.position;
    const cx = Math.floor(p.x);
    const cy = Math.floor(p.y);
    const cz = Math.floor(p.z);
    const logSet = new Set(wood.LOG_NAMES);
    for (let dx = -6; dx <= 6; dx += 1) {
      for (let dz = -6; dz <= 6; dz += 1) {
        for (let dy = -3; dy <= 6; dy += 1) {
          const x = cx + dx;
          const y = cy + dy;
          const z = cz + dz;
          const b = bot.blockAt(vec3(x, y, z));
          if (b && logSet.has(b.name)) raw.push({ name: b.name, x, y, z });
        }
      }
    }
    return {
      position: { x: p.x, y: p.y, z: p.z },
      floored: { x: cx, y: cy, z: cz },
      findLogBlock_result: found,
      scanBlocks_found: near.length,
      raw_bruteforce_found: raw.length,
      raw_sample: raw.slice(0, 8),
    };
  }),
);

rpc.handle(
  'route.plan',
  wrap(async (params = {}) => {
    // **"带价签的候选路线"**（带价签的路线计划）。
    //
    // 走路默认不改世界，所以走不通时不能偷偷挖——而是把"要挖哪几格、放什么"
    // 摊开给模型看，由它决定值不值得动世界。
    // 这里沿直线分段采样，报告每一段的挡路方块和需要的动作。
    const bot = engine.requireBot();
    const x = Number(params.x);
    const z = Number(params.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      throw new Error('route.plan 需要 x 和 z');
    }
    const p = bot.entity.position;
    const dx = x - p.x;
    const dz = z - p.z;
    const dist = Math.hypot(dx, dz);
    const stepX = dx / (dist || 1);
    const stepZ = dz / (dist || 1);
    const by = Math.floor(p.y);

    const segments = [];
    // 每 4 格一段，最多看 8 段（够判断"值不值得走"了）
    for (let i = 0; i < 8; i += 1) {
      const from = i * 4;
      if (from >= dist) break;
      const to = Math.min(from + 4, dist);
      const counts = new Map();
      const needsPlace = new Map();
      let clear = true;
      // 在这一段里逐格采样：脚、头两层 + 脚下有没有坑
      for (let d = from; d < to; d += 1) {
        const cx = Math.floor(p.x + stepX * d);
        const cz = Math.floor(p.z + stepZ * d);
        for (const cy of [by + 1, by]) {
          const b = bot.blockAt(vec3(cx, cy, cz));
          if (b && b.boundingBox === 'block') {
            clear = false;
            counts.set(b.name, (counts.get(b.name) || 0) + 1);
          }
        }
        // 脚下的地面：没有就是坑，得垫方块
        const floor = bot.blockAt(vec3(cx, by - 1, cz));
        if (!floor || floor.boundingBox !== 'block') {
          clear = false;
          needsPlace.set('需要垫脚', (needsPlace.get('需要垫脚') || 0) + 1);
        }
      }
      if (clear) continue; // 这一段的干净路不用说
      const digList = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
      const placeList = [...needsPlace.entries()].slice(0, 2);
      segments.push({
        from: Math.round(from),
        to: Math.round(to),
        // 价签：要挖什么
        dig: digList.map(([name, count]) => ({ name, count })),
        place: placeList.map(([name, count]) => ({ name, count })),
        at: { x: Math.floor(p.x + stepX * from), z: Math.floor(p.z + stepZ * from) },
      });
    }

    return {
      from: { x: Number(p.x.toFixed(1)), y: Number(p.y.toFixed(1)), z: Number(p.z.toFixed(1)) },
      to: { x, z },
      distance: Number(dist.toFixed(1)),
      // 空数组 = 一条干净的路，直接走就行（不会改世界）
      obstacles: segments,
      verdict: segments.length
        ? `直线方向上有 ${segments.length} 段被挡：${segments
            .map((s) => `第 ${s.from}~${s.to} 格要挖 ${s.dig.map((d) => d.name + '×' + d.count).join('/') || '（垫脚）'}`)
            .join('；')}`
        : '直线方向干净，直接走即可（不会改动任何方块）',
      note: '这份计划只做读取，没有改动世界。要真的挖，请用 dig 工具逐格挖。',
    };
  }),
);

rpc.handle(
  'debug.inv',
  wrap(async () => {
    const bot = engine.requireBot();
    const inv = bot.inventory;
    const items = inv.items().map((i) => ({ name: i.name, count: i.count, slot: i.slot }));
    const slots = [];
    for (let s = 0; s < (inv.slots || []).length; s += 1) {
      const it = inv.slots[s];
      if (it) slots.push(`${s}:${it.name}x${it.count}`);
    }
    return {
      items,
      slots,
      inventoryStart: inv.inventoryStart,
      inventoryEnd: inv.inventoryEnd,
      hotbarStart: inv.hotbarStart,
      currentWindow: bot.currentWindow ? bot.currentWindow.type : null,
    };
  }),
);

rpc.handle(
  'debug.findblock',
  wrap(async (params = {}) => {
    const bot = engine.requireBot();
    const name = String(params.name || 'stone').replace(/^minecraft:/, '');
    const radius = Number(params.radius) || 16;
    const mcData = require('minecraft-data')(bot.version);
    const id = mcData.blocksByName[name] ? mcData.blocksByName[name].id : null;
    const out = { name, id, radius };

    // 1) 函数型 matcher（findNearestDiggable 用的就是这种）
    try {
      const t0 = Date.now();
      const b = bot.findBlock({
        matching: (bb) => bb && bb.name === name && bb.diggable,
        maxDistance: radius,
      });
      out.function_matcher = b ? { x: b.position.x, y: b.position.y, z: b.position.z, name: b.name } : null;
      out.function_matcher_ms = Date.now() - t0;
    } catch (err) {
      out.function_matcher_error = `${err.name}: ${err.message}`;
    }

    // 2) 方块 ID 数组（state.scanBlocks 用的就是这种）
    try {
      const t1 = Date.now();
      const b2 = id === null ? null : bot.findBlock({ matching: [id], maxDistance: radius });
      out.id_matcher = b2 ? { x: b2.position.x, y: b2.position.y, z: b2.position.z, name: b2.name } : null;
      out.id_matcher_ms = Date.now() - t1;
    } catch (err) {
      out.id_matcher_error = `${err.name}: ${err.message}`;
    }

    // 3) 只要名字（不加 diggable 判断）
    try {
      const b3 = bot.findBlock({ matching: (bb) => bb && bb.name === name, maxDistance: radius });
      out.name_only = b3 ? { x: b3.position.x, y: b3.position.y, z: b3.position.z } : null;
    } catch (err) {
      out.name_only_error = `${err.name}: ${err.message}`;
    }

    return out;
  }),
);

rpc.handle(
  'debug.discoveries',
  wrap(async () => {
    engine.requireBot();
    return {
      ...engine.state.exportDiscoveries(),
      recent_notes: engine.state.recentEvents.slice(-8).map((e) => e.text),
    };
  }),
);

rpc.handle(
  'memory.export_discoveries',
  wrap(async () => {
    engine.requireBot();
    return engine.state.exportDiscoveries();
  }),
);

rpc.handle(
  'memory.import_discoveries',
  wrap(async (params = {}) => {
    engine.requireBot();
    engine.state.importDiscoveries(params);
    return { ok: true, ...engine.state.exportDiscoveries() };
  }),
);

rpc.handle(
  'debug.recipe',
  wrap(async (params = {}) => {
    const bot = engine.requireBot();
    const mcData = require('minecraft-data')(bot.version);
    const name = String(params.item || 'jungle_planks').replace(/^minecraft:/, '');
    const itemData = mcData.itemsByName[name];
    if (!itemData) return { error: `没有物品 ${name}` };
    const all = bot.recipesAll(itemData.id, null, true) || [];
    const summary = all.map((r) => ({
      // 关键：看清每个配方到底需不需要工作台
      hasInShape: Array.isArray(r.inShape),
      inShape: r.inShape || null,
      ingredientsRows: (r.ingredients || []).length,
      ingredientsCols: Math.max(0, ...(r.ingredients || []).map((row) => Object.keys(row).length)),
      requiresTableByOurRule: (() => {
        if (!r.ingredients) return false;
        const rows = r.ingredients.length;
        const cols = Math.max(...r.ingredients.map((row) => Object.keys(row).length));
        return rows > 2 || cols > 2;
      })(),
      result: r.result,
      delta: r.delta,
    }));
    return { item: name, recipeCount: all.length, recipes: summary };
  }),
);

rpc.handle(
  'debug.dropall',
  wrap(async () => {
    const bot = engine.requireBot();
    const dropped = {};
    const items = bot.inventory.items().slice();
    for (const item of items) {
      try {
        await bot.toss(item.type, null, item.count);
        dropped[item.name] = (dropped[item.name] || 0) + item.count;
      } catch (err) {
        log.debug(`丢出 ${item.name} 失败：${err.message}`);
      }
      await delay(80);
    }
    return {
      dropped: Object.values(dropped).reduce((a, b) => a + b, 0),
      items: dropped,
      note: '调试用途：把背包清空（给测试准备干净的初始状态）',
    };
  }),
);

rpc.handle(
  'debug.craftdiag',
  wrap(async (params = {}) => {
    const bot = engine.requireBot();
    const mcData = require('minecraft-data')(bot.version);
    const name = String(params.item || 'wooden_pickaxe').replace(/^minecraft:/, '');
    const itemData = mcData.itemsByName[name];
    if (!itemData) return { error: `没有物品 ${name}` };
    const recipes = bot.recipesAll(itemData.id, null, true) || [];
    const inv = engine.actions.inventoryMap();
    const out = recipes.map((r, idx) => {
      const perCraft = new Map();
      for (const row of r.ingredients || []) {
        for (const [, cell] of Object.entries(row)) {
          if (!cell || cell.id === undefined || cell.id === null || cell.id < 0) continue;
          perCraft.set(cell.id, (perCraft.get(cell.id) || 0) + 1);
        }
      }
      const needs = [...perCraft.entries()].map(([id, n]) => {
        const n2 = mcData.items[id] ? mcData.items[id].name : `item_${id}`;
        return { id, name: n2, per_craft: n, have: inv[n2] || 0, enough: (inv[n2] || 0) >= n };
      });
      return {
        index: idx,
        hasInShape: Array.isArray(r.inShape),
        requiresTableFlag: r.requiresTable,
        ingredientsRaw: JSON.stringify(r.ingredients || []).slice(0, 400),
        needs,
        allEnough: needs.every((n) => n.enough),
      };
    });
    return { item: name, recipes: out, inventory: inv, engineRuleMissing: engine.actions._missingForRecipe(recipes[0], 1, mcData) };
  }),
);

rpc.handle(
  'debug.standability',
  wrap(async (params = {}) => {
    const bot = engine.requireBot();
    const r = Math.max(1, Math.min(16, Number(params.radius) || 6));
    const p = bot.entity.position;
    const cx = Math.floor(p.x);
    const cy = Math.floor(p.y);
    const cz = Math.floor(p.z);
    let walkable = 0;
    let total = 0;
    const samples = [];
    for (let dx = -r; dx <= r; dx += 1) {
      for (let dz = -r; dz <= r; dz += 1) {
        for (let dy = 1; dy >= -2; dy -= 1) {
          total += 1;
          const x = cx + dx;
          const y = cy + dy;
          const z = cz + dz;
          const below = bot.blockAt(vec3(x, y - 1, z));
          const feet = bot.blockAt(vec3(x, y, z));
          const head = bot.blockAt(vec3(x, y + 1, z));
          const ok =
            below &&
            feet &&
            head &&
            below.boundingBox === 'block' &&
            (feet.boundingBox === 'empty' || feet.name === 'air') &&
            (head.boundingBox === 'empty' || head.name === 'air');
          if (ok) {
            walkable += 1;
            if (samples.length < 12) samples.push({ x, y, z, on: below.name });
            break; // 这一列已经找到落脚点
          }
        }
      }
    }
    return { radius: r, walkable, total, samples, position: { x: p.x, y: p.y, z: p.z }, on_ground: !!bot.entity.onGround };
  }),
);

rpc.handle(
  'debug.seed_ores',
  wrap(async (params = {}) => {
    const bot = engine.requireBot();
    const ore = String(params.ore || 'iron_ore').replace(/^minecraft:/, '');
    const count = Math.max(1, Math.min(64, Number(params.count) || 6));
    const depth = Math.max(1, Math.min(8, Number(params.depth) || 3));
    const mcData = require('minecraft-data')(bot.version);
    const blockInfo = mcData.blocksByName[ore];
    if (!blockInfo) throw new GameError(`没有名为 ${ore} 的方块`);

    const p = bot.entity.position;
    const bx = Math.floor(p.x);
    const by = Math.floor(p.y) - depth;
    const bz = Math.floor(p.z);

    // 铺一小片矿脉（3×3 中间挖空后用中心扩散放），并保证上方留出可站立空间
    const placed = [];
    let n = 0;
    outer: for (let dy = 0; dy < 3; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          if (n >= count) break outer;
          const x = bx + dx;
          const y = by - dy;
          const z = bz + dz;
          try {
            await bot.creative.setInventory([{ type: blockInfo.id, count: 1 }]);
            await bot.creative.placeBlock(vec3(x, y, z));
            placed.push({ x, y, z });
            n += 1;
          } catch (err) {
            log.debug(`放置 ${ore} 到 (${x},${y},${z}) 失败：${err.message}`);
          }
        }
      }
    }

    // 恢复成空手（否则会把手里的矿方块算进背包）
    try {
      await bot.creative.setInventory([]);
    } catch {
      /* ignore */
    }
    return {
      ore,
      placed: placed.length,
      positions: placed,
      note: `已在 (${bx}, ${by}, ${bz}) 附近放了 ${placed.length} 个 ${ore}（调试用途）`,
    };
  }),
);

rpc.handle(
  'ping', () => ({ pong: true, time: Date.now(), pid: process.pid }));

rpc.handle(
  'version',
  () => ({
    engine: 'astrbot-mc-engine',
    version: require('./package.json').version,
    node: process.version,
    mineflayer: safeVersion('mineflayer'),
    pathfinder: safeVersion('mineflayer-pathfinder'),
    features: {
      skills: skills.names(),
      phases: ['M0-channel', 'M1-pathfinding', 'M2-survival', 'M3-perception', 'M4-autonomy', 'M5-hardening'],
    },
  }),
);

rpc.handle(
  'connect',
  wrap(async (params) => {
    const r = await engine.connect(params);
    return { ...r, note: `已进入 ${engine.config.get('host')}:${engine.config.get('port')}` };
  }),
);

rpc.handle('disconnect', wrap(async () => engine.disconnect()));

rpc.handle('status', () => engine.status());

// **诊断视图**：一眼看清"她为什么不动"（给面板和 /mc诊断 用）
rpc.handle('status.diagnose', () => engine.diagnose());

// **危险扫描**：附近有没有岩浆/深水/悬崖（动手之前先问一句，提前避开）
rpc.handle('danger.scan', (params = {}) => engine.dangerScan(params.radius));

// 工作站记忆：她记得的箱子/熔炉/工作台在哪
rpc.handle('stations.list', () => {  const bot = engine.bot;
  const from = bot && bot.entity ? bot.entity.position : null;
  return {
    stations: engine.stations ? engine.stations.all() : [],
    text: engine.stations ? engine.stations.render(from) : '',
  };
});

rpc.handle(
  'config.update',
  wrap(async (params) => {
    const values = engine.config.update(params || {});
    // 心情也走这条通道下来（`mood: {label, drive, intensity, urgency}`）。
    // 它严格说不是"配置"，但复用同一条推送通道最省事，而且热更新立刻生效。
    if (params && params.mood !== undefined) {
      engine.setMood(params.mood);
    }
    return { ok: true, config: values };
  }),
);

// ================================================================ 感知类

rpc.handle('state.get', (params = {}) => {
  const detail = ['brief', 'normal', 'full'].includes(params.detail) ? params.detail : 'normal';
  return engine.state.snapshot(detail);
});

rpc.handle('state.brief', (params = {}) => {
  const includeGoal = params.goal || null;
  return { text: engine.state.brief({ maxLength: params.max_length || 800, includeGoal }) };
});

rpc.handle('state.events', (params = {}) => {
  const limit = Math.max(1, Math.min(50, Number(params.limit) || 10));
  return { events: engine.state.recentEvents.slice(-limit), pins: engine.state.pinnedNotes };
});

rpc.handle(
  'block.scan',
  wrap(async (params = {}) => {
    engine.requireBot();
    const names = params.names ? (Array.isArray(params.names) ? params.names : String(params.names).split(/[,，\s]+/)) : null;
    const blocks = engine.state.scanBlocks({
      names,
      radius: Number(params.radius) || 16,
      limit: Math.min(100, Number(params.limit) || 30),
    });
    // 如实报告"有没有扫完"：扫不完时上层该建议换个地方，而不是以为这里真没有
    return { count: blocks.length, blocks, truncated: !!blocks.truncated };
  }),
);

rpc.handle(
  'block.at',
  wrap(async ({ x, y, z }) => {
    const bot = engine.requireBot();
    const b = blockAt(bot, Math.floor(x), Math.floor(y), Math.floor(z));
    if (!b) return { name: null, note: '该位置未加载' };
    return {
      name: b.name,
      position: { x: b.position.x, y: b.position.y, z: b.position.z },
      diggable: !!b.diggable,
      bounding_box: b.boundingBox,
      light: b.light,
    };
  }),
);

rpc.handle(
  'entity.scan',
  wrap(async (params = {}) => {
    engine.requireBot();
    return {
      entities: engine.state.nearbyEntities({
        radius: Number(params.radius) || 24,
        limit: Math.min(50, Number(params.limit) || 15),
        hostileOnly: !!params.hostile_only,
      }),
    };
  }),
);

rpc.handle('inventory.get', () => {
  const bot = engine.requireBot();
  return {
    held: bot.heldItem
      ? { name: bot.heldItem.name, count: bot.heldItem.count, slot: bot.quickBarSlot }
      : null,
    items: engine.actions
      ? engine.actions.inventoryMap()
      : {},
    slots: (bot.inventory.slots || [])
      .map((it, slot) => (it ? { slot, name: it.name, count: it.count, durability_pct: it.maxDurability ? Math.round((1 - (it.durabilityUsed || 0) / it.maxDurability) * 100) : null } : null))
      .filter(Boolean),
  };
});

rpc.handle('players.list', () => {
  const bot = engine.requireBot();
  const me = bot.entity ? bot.entity.position : null;
  return {
    players: Object.values(bot.players || {})
      .filter((p) => p.username)
      .map((p) => ({
        username: p.username,
        ping: p.ping,
        gamemode: p.gameMode,
        self: p.username === bot.username,
        position: p.entity && p.entity.position
          ? { x: Number(p.entity.position.x.toFixed(1)), y: Number(p.entity.position.y.toFixed(1)), z: Number(p.entity.position.z.toFixed(1)) }
          : null,
        distance: p.entity && p.entity.position && me ? Number(distance(p.entity.position, me).toFixed(1)) : null,
      })),
  };
});

// ================================================================ 移动类

rpc.handle(
  'move.to',
  wrap(async (params) => {
    engine.requireBot();
    return submitAction({
      name: `移动到 (${params.x}, ${params.z})`,
      run: async ({ signal, task }) => {
        task.setDetail('寻路中');
        // 先落地：出生点常在树冠/水面上，从那里出发寻路会直接失败
        await skills.settle({
          actions: engine.actions,
          nav: engine.nav,
          ctx: {
            aborted: signal.aborted,
            progress: (t) => task.setDetail(t),
            ensureChunks: (o) => engine.ensureChunks(o),
          },
        });
        if (signal.aborted) throw new GameError('移动被取消');
        task.setDetail('寻路中');
        const r = await engine.nav.goTo({
          x: Number(params.x),
          y: params.y === undefined || params.y === null ? null : Number(params.y),
          z: Number(params.z),
          range: Number(params.range) || 1,
          signal,
          timeoutMs: Number(params.timeout_ms) || null,
          onTick: (info) => task.setDetail(`距目标约 ${distance(info.position, { x: Number(params.x), y: info.position.y, z: Number(params.z) }).toFixed(1)} 格`),
        });
        if (!r.arrived) {
          throw new GameError(
            `没能到达目标：停在 ${fmtVec(r.final_position)}，距目标还有 ${r.distance_to_target} 格。` +
              `可能被方块挡住或目标不可达；可以试试先挖开挡路的东西，或换一个更近的位置`,
          );
        }
        return r;
      },
    });
  }),
);

rpc.handle(
  'move.follow',
  wrap(async (params) => {
    engine.requireBot();
    const target = params.target || params.player;
    if (!target) throw new GameError('缺少参数 target（玩家名或实体名）');
    return submitAction({
      name: `跟随 ${target}`,
      run: async ({ signal, task }) => {
        task.setDetail(`跟着 ${target}`);
        return engine.nav.follow(target, {
          distance: Number(params.distance) || 3,
          signal,
          onTick: (info) => task.setDetail(`距 ${target} ${info.distance.toFixed(1)} 格`),
        });
      },
    });
  }),
);

rpc.handle(
  'move.jump',
  wrap(async () => {
    engine.requireBot();
    await engine.nav.jump();
    return { ok: true };
  }),
);

rpc.handle(
  'move.look',
  wrap(async (params) => {
    engine.requireBot();
    if (params.x !== undefined && params.z !== undefined) {
      await engine.nav.lookAtPoint(Number(params.x), Number(params.y ?? engine.bot.entity.position.y), Number(params.z));
      return { ok: true, looking_at: { x: params.x, y: params.y, z: params.z } };
    }
    if (params.yaw !== undefined) {
      await engine.nav.look(Number(params.yaw), Number(params.pitch ?? 0));
      return { ok: true, yaw: params.yaw, pitch: params.pitch ?? 0 };
    }
    throw new GameError('需要给出 (x,z) 坐标，或 yaw/pitch 角度');
  }),
);

rpc.handle(
  'move.stop',
  wrap(async () => {
    const ids = engine.queue.cancelAll({ reason: '停止移动' });
    try {
      engine.bot.clearControlStates();
      engine.nav.stop();
    } catch {
      /* ignore */
    }
    return { ok: true, cancelled: ids };
  }),
);

// ================================================================ 动作类（同步，快的）

rpc.handle(
  'dig',
  wrap(async (params) => {
    engine.requireBot();
    const { x, y, z } = normalizeCoords(params);
    return engine.actions.dig({ x, y, z, collect: params.collect !== false, reach: params.reach !== false });
  }),
);

rpc.handle(
  'place',
  wrap(async (params) => {
    engine.requireBot();
    const { x, y, z } = normalizeCoords(params);
    return engine.actions.place({ x, y, z, item: params.item || null, reach: params.reach !== false });
  }),
);

rpc.handle(
  'craft',
  wrap(async (params) => {
    engine.requireBot();
    if (!params.item) throw new GameError('缺少参数 item（要合成什么）');
    return engine.actions.craft({ item: params.item, count: Number(params.count) || 1 });
  }),
);

rpc.handle(
  'smelt',
  wrap(async (params) => {
    engine.requireBot();
    if (!params.item) throw new GameError('缺少参数 item（要熔炼什么）');
    return engine.actions.smelt({ item: params.item, count: Number(params.count) || 1, fuel: params.fuel || null });
  }),
);

rpc.handle(
  'equip',
  wrap(async (params) => {
    engine.requireBot();
    if (!params.item) throw new GameError('缺少参数 item');
    return engine.actions.equip({ item: params.item, destination: params.destination || 'auto' });
  }),
);

rpc.handle(
  'eat',
  wrap(async (params) => {
    engine.requireBot();
    return engine.actions.eat({ item: params.item || null });
  }),
);

rpc.handle(
  'attack',
  wrap(async (params) => {
    engine.requireBot();
    if (params.target === undefined) throw new GameError('缺少参数 target（实体名或实体 id）');
    return engine.actions.attack({ target: params.target, maxAttacks: Number(params.max_attacks) || 40 });
  }),
);

rpc.handle(
  'attack.ranged',
  wrap(async (params) => {
    engine.requireBot();
    if (params.target === undefined) throw new GameError('缺少参数 target（要射谁）');
    return engine.actions.attackRanged({
      target: params.target,
      maxShots: Number(params.max_shots) || 12,
      chargeMs: Number(params.charge_ms) || 1200,
    });
  }),
);

rpc.handle(
  'shield.raise',
  wrap(async (params = {}) => {
    engine.requireBot();
    return engine.actions.raiseShield({ holdMs: Number(params.hold_ms) || 3000 });
  }),
);

rpc.handle(
  'use.block',
  wrap(async (params) => {
    engine.requireBot();
    const { x, y, z } = normalizeCoords(params);
    return engine.actions.useBlock({ x, y, z, item: params.item || null, reach: params.reach !== false });
  }),
);

rpc.handle(
  'sleep',
  wrap(async (params = {}) => {
    engine.requireBot();
    return engine.actions.sleepInBed({
      timeoutMs: Number(params.timeout_ms) || 120000,
    });
  }),
);

rpc.handle(
  'interact.entity',
  wrap(async (params = {}) => {
    engine.requireBot();
    if (!params.target) throw new Error('interact.entity 需要 target（要交互的实体名，如 sheep/cow）');
    return engine.actions.interactEntity({
      target: params.target,
      item: params.item || null,
      timeoutMs: Number(params.timeout_ms) || 20000,
    });
  }),
);

rpc.handle(
  'use.player',
  wrap(async (params) => {
    engine.requireBot();
    if (!params.target) throw new GameError('缺少参数 target（玩家名）');
    return engine.actions.useOnPlayer({ target: params.target });
  }),
);

rpc.handle(
  'drop',
  wrap(async (params) => {
    engine.requireBot();
    if (!params.item) throw new GameError('缺少参数 item');
    return engine.actions.drop({ item: params.item, count: Number(params.count) || 1 });
  }),
);

rpc.handle(
  'container.open',
  wrap(async (params) => {
    engine.requireBot();
    const { x, y, z } = normalizeCoords(params);
    const r = await engine.actions.openContainer({ x, y, z, reach: params.reach !== false });
    const info = r.describe();
    r.win.close();
    return info;
  }),
);

rpc.handle(
  'container.deposit',
  wrap(async (params) => {
    engine.requireBot();
    const { x, y, z } = normalizeCoords(params);
    return engine.actions.deposit({
      x,
      y,
      z,
      items: params.items || null,
      keep: params.keep || null,
      reach: params.reach !== false,
    });
  }),
);

rpc.handle(
  'container.withdraw',
  wrap(async (params) => {
    engine.requireBot();
    const { x, y, z } = normalizeCoords(params);
    return engine.actions.withdraw({ x, y, z, item: params.item || null, count: Number(params.count) || 1, reach: params.reach !== false });
  }),
);

rpc.handle(
  'collect.drops',
  wrap(async (params) => {
    engine.requireBot();
    return engine.actions.collectDrops({ timeoutMs: Number(params.timeout_ms) || 4000 });
  }),
);

// ================================================================ 技能类（长任务，异步）

rpc.handle(
  'skill.run',
  wrap(async (params) => {
    const skill = params.skill || params.name;
    if (!skill) throw new GameError(`缺少参数 skill。可用技能：${skills.names().join(' / ')}`);
    // 先校验技能名再要求连接：参数错误应该在进服之前就告诉调用方，
    // 否则 LLM 会以为是"没进服"而不是"技能名写错了"，它会去重连而不是改名字。
    if (!skills.get(skill)) {
      throw new GameError(`没有这个技能：${skill}。可用技能：${skills.names().join(' / ')}`);
    }
    engine.requireBot();
    const task = engine.submitSkill({ skill, params: params.params || params.args || {} });
    return {
      ok: true,
      task_id: task.id,
      name: task.name,
      status: 'queued',
      note: `技能「${task.name}」已开始执行（可能持续几分钟）。用 task.status 查询进度，用 task.cancel 取消。不要干等，可以先回应用户然后再查。`,
    };
  }),
);

rpc.handle('skill.list', () => ({ skills: skills.describeAll(), names: skills.names() }));

rpc.handle('task.status', (params = {}) => {
  if (!params.task_id) {
    return { current: engine.queue.currentInfo, queued: engine.queue.queueInfo, stats: engine.queue.stats };
  }
  const t = engine.queue.describe(params.task_id);
  if (!t) throw new GameError(`找不到任务 ${params.task_id}（可能已经结束很久了）`);
  if (t.status === 'running' && t.detail) t.progress = t.detail;
  return t;
});

rpc.handle('task.cancel', (params = {}) => {
  if (!params.task_id) {
    return engine.cancelAll('取消全部任务');
  }
  const r = engine.queue.cancel(params.task_id, { reason: params.reason || '用户取消' });
  if (!r.ok) throw new GameError(r.reason);
  return { ok: true, task_id: params.task_id, note: '已请求取消' };
});

rpc.handle('task.list', () => ({
  current: engine.queue.currentInfo,
  queued: engine.queue.queueInfo,
  history: engine.queue.history.slice(-20),
  stats: engine.queue.stats,
}));

// ================================================================ 社交与安全

rpc.handle(
  'chat.say',
  wrap(async (params) => {
    if (!params.message) throw new GameError('缺少参数 message');
    return engine.chat(params.message);
  }),
);

rpc.handle(
  'safety.stop',
  wrap(async () => {
    const r = engine.cancelAll('急停');
    return { ...r, note: '已急停：所有动作与排队任务都已停止' };
  }),
);

rpc.handle(
  'safety.set',
  wrap(async (params) => {
    const allowed = ['autoMode', 'autoEat', 'autoDefend', 'slowMode', 'digWhitelist', 'digBlacklist', 'spawnProtectionRadius', 'allowDigInPath', 'allowPlaceInPath'];
    const patch = {};
    for (const [k, v] of Object.entries(params || {})) {
      if (allowed.includes(k)) patch[k] = v;
    }
    engine.config.update(patch);
    return { ok: true, applied: patch };
  }),
);

// ================================================================ 坐标归一化

function normalizeCoords(params) {
  const x = Number(params.x);
  const y = Number(params.y);
  const z = Number(params.z);
  if (![x, y, z].every(Number.isFinite)) {
    throw new GameError(`坐标必须是数字，收到 x=${params.x} y=${params.y} z=${params.z}`);
  }
  return { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
}

function safeVersion(name) {
  try {
    return require(`${name}/package.json`).version;
  } catch {
    return null;
  }
}

// ================================================================ 启动与收尾

rpc.onClose(() => {
  log.info('通道已关闭，正在退出引擎');
  engine.shutdown();
  // 给 stdout 一点时间把最后的响应写出去
  setTimeout(() => process.exit(0), 200);
});

process.on('uncaughtException', (err) => {
  log.error(`未捕获异常：${err.stack || err.message}`);
  rpc.notify('bot.error', { message: `引擎内部错误：${err.message}`, fatal: false });
});

process.on('unhandledRejection', (reason) => {
  log.error(`未处理的 Promise 拒绝：${reason && reason.stack ? reason.stack : reason}`);
});

rpc.start();
log.info(`Minecraft 引擎已启动（pid=${process.pid}，node=${process.version}）`);

// 启动即上报一次能力清单，插件侧可以用于自检
rpc.notify('engine.ready', {
  version: require('./package.json').version,
  skills: skills.names(),
  pid: process.pid,
});

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
