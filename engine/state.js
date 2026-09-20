'use strict';
/**
 * 状态快照 + 差分事件。
 *
 * 为什么要差分：如果每次都把完整世界状态推给 LLM，token 会在几分钟内爆炸
 * （背包几十格、附近几十个实体，每 3 秒刷一遍）。这里的策略是：
 *   - 全量快照只在插件主动 state.get 时生成
 *   - 平时只推"有意义的变化"（位置移动 >8 格、血量变化、背包变化、实体进出一屏）
 *   - 高频事件（实体进出）做去抖，避免刷屏
 */

const log = require('./log');
const { isHostileName, HOSTILE_NAMES } = require('./config');
const { distance, distanceXZ, blockOf, fmtVec, round, vec3 } = require('./util');

/** 需要关注的方块：只列这些，避免简报里出现一堆草和石头 */
const INTERESTING_BLOCKS = [
  'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log',
  'cherry_log', 'pale_oak_log', 'crimson_stem', 'warped_stem', 'oak_leaves',
  'coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'redstone_ore', 'lapis_ore', 'diamond_ore',
  'emerald_ore', 'deepslate_coal_ore', 'deepslate_iron_ore', 'deepslate_copper_ore',
  'deepslate_gold_ore', 'deepslate_redstone_ore', 'deepslate_lapis_ore', 'deepslate_diamond_ore',
  'deepslate_emerald_ore', 'nether_gold_ore', 'nether_quartz_ore', 'ancient_debris',
  'crafting_table', 'furnace', 'blast_furnace', 'smoker', 'chest', 'trapped_chest', 'barrel',
  'water', 'lava', 'sand', 'gravel', 'clay', 'obsidian', 'bedrock',
  'torch', 'wall_torch', 'oak_door', 'oak_planks', 'cobblestone', 'stone', 'dirt', 'grass_block',
];

const INTERESTING_SET = new Set(INTERESTING_BLOCKS);

/** 物品名 → 中文/分类，用于简报可读性（LLM 认得英文 ID，但中文更省 token） */
const ITEM_GROUPS = [
  [/^(oak|birch|spruce|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|crimson|warped)_(log|stem|planks|wood|hyphae)$/, '木材'],
  [/^(coal|charcoal)$/, '燃料'],
  [/_ore$|^raw_/, '矿石'],
  [/^(iron|gold|copper|diamond|emerald|netherite|lapis_lazuli|redstone|coal)_(ingot|nugget|block)$/, '金属'],
  [/(_pickaxe|_axe|_shovel|_hoe|_sword)$/, '工具'],
  [/(_helmet|_chestplate|_leggings|_boots)$/, '护甲'],
  [/(_apple|bread|cooked_|_beef|_porkchop|_chicken|_mutton|_cod|_salmon|_potato|_carrot|_stew|_soup|melon_slice|cookie|cake)$/, '食物'],
  [/^(torch|lantern|glowstone|sea_lantern)$/, '照明'],
];

function itemGroup(name) {
  for (const [re, label] of ITEM_GROUPS) {
    if (re.test(name)) return label;
  }
  return null;
}

/**
 * 值得记住的贵重物品 → 记忆权重。
 * 用于"挖到钻石了"这类高光时刻——她自己也会想提起这件事。
 */
const VALUABLE_ITEMS = {
  diamond: 9,
  emerald: 8,
  netherite_ingot: 10,
  ancient_debris: 9,
  netherite_scrap: 8,
  gold_ingot: 6,
  iron_ingot: 5,
  lapis_lazuli: 5,
  redstone: 4,
  quartz: 3,
  obsidian: 5,
  enchanted_golden_apple: 10,
  golden_apple: 7,
  totem_of_undying: 10,
  elytra: 10,
  nether_star: 10,
  wither_skeleton_skull: 8,
  echo_shard: 7,
  amethyst_shard: 4,
};

/**
 * 值得记住的生物（第一次见到记一笔）。
 * 目的是让她对世界有"印象"——第一次看到熊猫和第一次看到僵尸的意义不一样。
 */
const NOTABLE_MOBS = new Set([
  'creeper', 'enderman', 'witch', 'pillager', 'ravager', 'evoker', 'vindicator', 'phantom',
  'warden', 'wither', 'ender_dragon', 'elder_guardian', 'guardian', 'shulker', 'blaze',
  'ghast', 'hoglin', 'piglin_brute', 'zoglin', 'breeze', 'bogged', 'armadillo', 'axolotl',
  'panda', 'polar_bear', 'fox', 'wolf', 'cat', 'ocelot', 'parrot', 'dolphin', 'turtle',
  'villager', 'wandering_trader', 'iron_golem', 'snow_golem', 'allay', 'frog', 'camel',
  'sniffer', 'goat', 'llama', 'mooshroom', 'bee', 'strider', 'magma_cube', 'slime',
]);

class StateTracker {
  /**
   * @param {object} o
   * @param {(event:string, data:object)=>void} o.emit 事件出口（由 index.js 接到 RPC notify）
   */
  constructor({ emit }) {
    this._emit = emit;
    this._bot = null;
    this._last = null; // 上一次快照
    this._lastPos = null;
    this._lastEmitAt = 0;
    this._entityDebounce = new Map(); // 实体 id/名 -> 上次事件时间
    this._recentEvents = []; // 环形缓冲，供简报里"刚才发生了什么"
    this._pinnedNotes = []; // 由技能写入的临时备注（"正在砍树 3/5"）
    this._timers = [];

    // ---- 记忆相关：她"经历过什么"
    /** 已经见过的值得记住的生物（第一次见到才报 discover 事件） */
    this._seenMobs = new Set();
    /** 已经拿到过的贵重物品（第一次拿到才报 treasure 事件） */
    this._seenItems = new Set();
    /** 走过的总路程（用于"走出去很远"这类里程碑） */
    this._traveled = 0;
    this._lastMilestoneAt = 0;
  }

  attach(bot) {
    this._bot = bot;
    this._last = null;
    this._lastPos = null;
    this._recentEvents = [];
    this._lastInventoryKey = null;
    this._lastHealth = null;
    // 注意：_seenMobs/_seenItems/_traveled 不在这里重置。
    // 它们代表"她这一生的见闻"，换一个服务器连接不该让她失忆。
  }

  /** 把见闻状态导出/导入，让插件可以持久化（跨重启保留"第一次"的语义） */
  exportDiscoveries() {
    return {
      mobs: [...this._seenMobs],
      items: [...this._seenItems],
      traveled: Math.round(this._traveled),
    };
  }

  importDiscoveries(data) {
    if (!data || typeof data !== 'object') return;
    for (const m of data.mobs || []) this._seenMobs.add(String(m));
    for (const i of data.items || []) this._seenItems.add(String(i));
    this._traveled = Number(data.traveled) || 0;
    log.debug(
      `已载入见闻：${this._seenMobs.size} 种生物、${this._seenItems.size} 种贵重物品、累计行走 ${Math.round(this._traveled)} 格`,
    );
  }

  detach() {
    this._bot = null;
    for (const t of this._timers) clearInterval(t);
    this._timers = [];
  }

  /** 由 bot.js 在事件里调用，记录一句"最近发生的事"，进简报 */
  note(text) {
    this._recentEvents.push({ at: Date.now(), text });
    if (this._recentEvents.length > 30) this._recentEvents.shift();
  }

  pin(note) {
    this._pinnedNotes.push(note);
    if (this._pinnedNotes.length > 10) this._pinnedNotes.shift();
  }

  unpin(note) {
    const i = this._pinnedNotes.indexOf(note);
    if (i >= 0) this._pinnedNotes.splice(i, 1);
  }

  get recentEvents() {
    return [...this._recentEvents];
  }

  get pinnedNotes() {
    return [...this._pinnedNotes];
  }

  // ------------------------------------------------------------ 快照

  /**
   * @param {'brief'|'normal'|'full'} detail
   */
  snapshot(detail = 'normal', opts = {}) {
    const bot = this._bot;
    if (!bot || !bot.entity) {
      return { connected: false, ready: false, message: '机器人尚未进入服务器' };
    }

    const pos = bot.entity.position;
    const snap = {
      connected: !!bot._client && bot._client.state === 'play',
      ready: !!bot.entity,
      username: bot.username,
      uuid: bot.entity.uuid || null,
      position: { x: round(pos.x, 2), y: round(pos.y, 2), z: round(pos.z, 2) },
      block_position: blockOf(pos.x, pos.y, pos.z),
      yaw: round(normalizeYaw(bot.entity.yaw), 1),
      pitch: round(bot.entity.pitch, 1),
      on_ground: !!bot.entity.onGround,
      health: round(bot.health, 1),
      max_health: bot.entity.maxHealth || 20,
      food: bot.food,
      saturation: bot.foodSaturation !== undefined ? round(bot.foodSaturation, 1) : null,
      xp: { level: bot.experience ? bot.experience.level : 0, points: bot.experience ? bot.experience.points : 0 },
      gamemode: bot.game ? bot.game.gameMode : null,
      dimension: bot.game ? bot.game.dimension : null,
      is_raining: bot.isRaining,
      time_of_day: bot.time ? bot.time.timeOfDay : null,
      held_item: describeHeldItem(bot),
      effects: describeEffects(bot),
      armor: describeArmor(bot),
      inventory_summary: summarizeInventory(bot),
      players_online: Object.keys(bot.players || {}).filter((n) => n !== bot.username),
      ping: bot.player ? bot.player.ping : null,
      server: bot._client && bot._client.socket ? `${bot._client.socket.remoteAddress}:${bot._client.socket.remotePort}` : null,
      version: bot.version,
    };

    // 环境：脚下/脚下方块、光照、水里/岩浆里
    //
    // **必须放在 brief 提前返回之前**：早期这里先 `return snap`，
    // 导致 brief 模式下 `standing_on` / `feet_block` / `light` / `in_water`
    // 永远是 undefined——而 brief 正是喂给 LLM 的那一份，
    // 也就是她**从来不知道自己站在什么上面、天黑了没有、是不是在水里**。
    const below = blockAt(bot, Math.floor(pos.x), Math.floor(pos.y) - 1, Math.floor(pos.z));
    const feet = blockAt(bot, Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
    snap.standing_on = below ? below.name : null;
    snap.feet_block = feet ? feet.name : null;
    snap.light = safeLight(bot, pos);
    // 分开报"天空光/方块光"，方便上层做判断（比如夜里该不该点灯）
    const lights = rawLights(bot, pos);
    snap.sky_light = lights.sky;
    snap.block_light = lights.block;
    if (!below) {
      // 脚下读不到方块意味着地形查询出了问题，而不是"这里没有方块"。
      // 静默返回 null 会让上层看到"脚下未知"却查不出原因，所以这里必须留下痕迹。
      log.debug(
        `快照读不到脚下方块：pos=(${pos.x},${pos.y},${pos.z}) 取整=(${Math.floor(pos.x)},${Math.floor(pos.y) - 1},${Math.floor(pos.z)})`,
      );
    }
    snap.in_water = !!bot.entity.isInWater;
    snap.in_lava = !!bot.entity.isInLava;

    if (detail === 'brief') {
      delete snap.inventory_summary;
      delete snap.armor;
      delete snap.effects;
      return snap;
    }

    // 附近实体（按距离排序，最多 12 个，按类型聚合）
    snap.nearby_entities = this.nearbyEntities({ radius: 24, limit: 12 });

    // 附近玩家详细一点
    snap.nearby_players = (snap.nearby_entities || []).filter((e) => e.type === 'player');

    if (detail === 'full') {
      snap.inventory = describeInventoryFull(bot);
      snap.all_entities = this.nearbyEntities({ radius: 48, limit: 40 });
      // 注意：这里**故意不做** block_scan。
      //
      // 以前这行是 `snap.block_scan = this.scanBlocks({ radius: 12, limit: 30 })`，
      // 而那个扫描（半径 12 × 17 层 ≈ 7700 次 blockAt）实测要 ~2.3 秒，
      // 且是同步的——每次状态快照都会把 Node 事件循环阻塞两秒多，
      // 期间引擎无法响应任何 RPC（状态查询、急停都会卡）。
      //
      // 更糟的是：**没有任何地方读 block_scan**（引擎和插件里都搜不到消费者），
      // 也就是白白付出这个代价。需要附近方块时走 `block.scan` RPC（mc_scan 工具），
      // 那条路径是按需调用且已做"就近优先 + 提前退出"优化。
      // opt-in：调用方显式传 detail='full' 且设 include_block_scan 时才扫。
      if (opts.include_block_scan) {
        snap.block_scan = this.scanBlocks({ radius: 12, limit: 30 });
      }
    }

    return snap;
  }

  nearbyEntities({ radius = 24, limit = 12, hostileOnly = false } = {}) {
    const bot = this._bot;
    if (!bot || !bot.entity) return [];
    const me = bot.entity.position;
    const out = [];
    for (const id of Object.keys(bot.entities)) {
      const e = bot.entities[id];
      if (!e || !e.position || e === bot.entity) continue;
      const d = distance(e.position, me);
      if (d > radius) continue;
      const name = entityName(e, bot);
      const hostile = isHostileName(name);
      if (hostileOnly && !hostile) continue;
      out.push({
        id: e.id,
        name,
        type: e.type,
        hostile,
        distance: round(d, 1),
        position: { x: round(e.position.x, 1), y: round(e.position.y, 1), z: round(e.position.z, 1) },
      });
    }
    // 先按"是否敌对"再按距离：威胁要排在前面，LLM 才不会漏看
    out.sort((a, b) => Number(b.hostile) - Number(a.hostile) || a.distance - b.distance);
    return collapseEntities(out).slice(0, limit);
  }

  /**
   * 扫描附近指定方块。
   * @param {object} o
   * @param {string[]} [o.names] 方块名（可带/不带 minecraft: 前缀），为空则用关注列表
   * @param {number} [o.radius]
   * @param {number} [o.limit]
   */
  scanBlocks({ names = null, radius = 16, limit = 30, yRange = null } = {}) {
    const bot = this._bot;
    if (!bot || !bot.entity) return [];
    const want = names && names.length ? new Set(names.map((n) => String(n).replace(/^minecraft:/, ''))) : null;
    const pos = bot.entity.position;
    const cx = Math.floor(pos.x);
    const cy = Math.floor(pos.y);
    const cz = Math.floor(pos.z);
    // 半径上限 32 → **16**。
    //
    // 实测真实服务器上 `mc_scan(radius=32)` 把事件循环阻塞了 **8 秒**，
    // 后果是她整个人卡住（模型在等她、玩家看到的就是"基本上不动"）。
    // 32 格的扫描量是 16 格的 4 倍，而"找树/找矿石"根本不需要那么远——
    // 找不到就换个方向再扫，比一次扫一大片把引擎卡死好得多。
    const r = Math.max(1, Math.min(16, Number(radius) || 16));
    const yMin = yRange ? yRange[0] : cy - 8;
    const yMax = yRange ? yRange[1] : cy + 8;

    // **就近优先 + 提前退出**：
    // 旧实现是无序三重循环全量扫描，r=48、y 范围 17 时约 16 万次 blockAt
    // （每次分配 Vec3），实测阻塞 Node 事件循环 20 秒以上——
    // 你日志里 `block.scan 超时（20 秒）` 就是这个原因，而且期间整个引擎无法响应 RPC。
    // 现在按水平距离由近到远扫，凑够 limit 个之后，
    // 只要下一列的距离已经超过"已保留的最远结果"，就可以安全停下
    // （更远的列不可能产生更近的结果，语义完全不变）。
    const cols = [];
    for (let dx = -r; dx <= r; dx += 1) {
      for (let dz = -r; dz <= r; dz += 1) {
        const d = Math.hypot(dx, dz);
        if (d <= r) cols.push({ x: cx + dx, z: cz + dz, d });
      }
    }
    cols.sort((a, b) => a.d - b.d);

    const found = [];
    let worstKept = Infinity; // 已保留结果里的最远距离
    // **硬性工作量预算**：无论找不找得到，都不能把事件循环占住超过这么多格。
    //
    // 为什么必须有：上面的"提前退出"只在**已经凑够 limit 个结果**时才生效。
    // 实测扫一个附近根本不存在的方块（比如在针叶林里找 oak_log）时，
    // 它会老老实实扫完所有列——r=32 时约 5.4 万次 blockAt，阻塞引擎 8 秒。
    // 真人的做法是"这一带没有，换个地方看"，而不是原地把所有格子读完。
    // 实测：12000 次查询约 2.2 秒（仍有阻塞告警），5000 次约 1 秒以内。
    // 宁可"只看了近处、建议换个方向"，也不要让引擎卡住——她卡住就等于站着不动。
    const BUDGET = 5000;
    let work = 0;
    let truncated = false;
    for (const col of cols) {
      if (found.length >= limit && col.d > worstKept) break; // 安全提前退出
      if (work > BUDGET) {
        truncated = true;
        break;
      }
      for (let y = yMin; y <= yMax; y += 1) {
        work += 1;
        const block = blockAt(bot, col.x, y, col.z);
        if (!block) continue;
        const name = block.name;
        if (name === 'air' || name === 'cave_air' || name === 'void_air') continue;
        if (want) {
          if (!want.has(name)) continue;
        } else if (!INTERESTING_SET.has(name)) {
          continue;
        }
        const d = distance({ x: col.x + 0.5, y: y + 0.5, z: col.z + 0.5 }, pos);
        if (d > r) continue;
        found.push({ name, x: col.x, y, z: col.z, distance: round(d, 1), diggable: !!block.diggable });
        if (found.length >= limit) {
          worstKept = Math.max(...found.map((f) => f.distance));
        }
      }
    }
    found.sort((a, b) => a.distance - b.distance);
    const out = found.slice(0, limit);
    // 把"没扫完"如实带出去：否则上层会以为"这一带真的没有"，
    // 而真相是"只看了最近的这些格子"。
    if (truncated) {
      Object.defineProperty(out, 'truncated', { value: true, enumerable: false });
    }
    return out;
  }

  /** 找最近的指定方块（技能层用，不经过 LLM） */
  findNearestBlock(names, { radius = 32, yRange = null, from = null } = {}) {
    const bot = this._bot;
    if (!bot || !bot.entity) return null;
    const want = new Set(names.map((n) => String(n).replace(/^minecraft:/, '')));
    const origin = from || bot.entity.position;
    const cx = Math.floor(origin.x);
    const cy = Math.floor(origin.y);
    const cz = Math.floor(origin.z);
    const r = Math.max(1, Math.min(40, Number(radius) || 32));
    const yMin = yRange ? yRange[0] : cy - 16;
    const yMax = yRange ? yRange[1] : cy + 16;

    // 就近优先 + 提前退出（与 scanBlocks 同一套道理）：
    // 旧实现 r 最大 64、y 范围 33 → 最坏 54 万次 blockAt，足以把事件循环卡住近一分钟。
    // 按水平距离由近到远扫，一旦已有候选，比它更远的列就不可能产生更近的结果，直接停。
    const cols = [];
    for (let dx = -r; dx <= r; dx += 1) {
      for (let dz = -r; dz <= r; dz += 1) {
        const d = Math.hypot(dx, dz);
        if (d <= r) cols.push({ x: cx + dx, z: cz + dz, d });
      }
    }
    cols.sort((a, b) => a.d - b.d);

    let best = null;
    let bestD = Infinity;
    for (const col of cols) {
      if (col.d > bestD) break; // 更远的列不可能更近
      for (let y = yMin; y <= yMax; y += 1) {
        const block = blockAt(bot, col.x, y, col.z);
        if (!block || !want.has(block.name)) continue;
        const d = distance({ x: col.x + 0.5, y: y + 0.5, z: col.z + 0.5 }, origin);
        if (d <= r && d < bestD) {
          bestD = d;
          best = { name: block.name, x: col.x, y, z: col.z, distance: round(d, 1) };
        }
      }
    }
    return best;
  }

  // ------------------------------------------------------------ 差分与推送

  /** 由定时器调用：检查是否有"值得通知插件"的变化 */
  tick() {
    const bot = this._bot;
    if (!bot || !bot.entity) return;
    const pos = bot.entity.position;

    // 位置大跨度移动
    if (this._lastPos) {
      const moved = distanceXZ(pos, this._lastPos);
      if (moved >= 8) {
        this._emit('bot.moved', {
          from: { x: round(this._lastPos.x, 1), y: round(this._lastPos.y, 1), z: round(this._lastPos.z, 1) },
          to: { x: round(pos.x, 1), y: round(pos.y, 1), z: round(pos.z, 1) },
          distance: round(moved, 1),
        });
        this._lastPos = pos.clone ? pos.clone() : { ...pos };
      }
    } else {
      this._lastPos = pos.clone ? pos.clone() : { ...pos };
    }

    // 血量
    if (this._lastHealth !== null && bot.health !== this._lastHealth) {
      const delta = round(bot.health - this._lastHealth, 1);
      if (Math.abs(delta) >= 1) {
        this._emit('bot.health', { health: round(bot.health, 1), delta, food: bot.food });
      }
    }
    this._lastHealth = bot.health;

    // 背包变化（用低成本指纹：槽位数 + 总数量）
    const invKey = inventoryFingerprint(bot);
    if (this._lastInventoryKey !== null && invKey !== this._lastInventoryKey) {
      this._emit('bot.inventory', { summary: summarizeInventory(bot) });
    }
    this._lastInventoryKey = invKey;

    // 附近敌对实体进出（带去抖，5 秒内同名只报一次）
    const hostiles = this.nearbyEntities({ radius: 16, limit: 6, hostileOnly: true });
    const now = Date.now();
    for (const h of hostiles) {
      const key = `${h.name}`;
      const last = this._entityDebounce.get(key) || 0;
      if (now - last > 5000) {
        this._entityDebounce.set(key, now);
        this._emit('entity.threat', { name: h.name, distance: h.distance, position: h.position, count: hostiles.length });
      }
    }

    this._trackDiscoveries();
  }

  /**
   * 追踪"值得记住的见闻"，并推成事件让插件写进她的记忆。
   *
   * 这三类东西构成她对世界的印象：
   *   1. 第一次见到某种值得留意的生物（第一次看到熊猫 ≠ 第一次看到僵尸）
   *   2. 第一次拿到某种贵重物品（挖到钻石是高光时刻）
   *   3. 走出很远（累计行程里程碑）
   *
   * 关键设计：**"第一次"只报一次**。所以 `_seenMobs` / `_seenItems` 不随重连清空，
   * 插件还会把它们持久化，这样重启后她仍然记得"我以前见过熊猫"。
   */
  _trackDiscoveries() {
    this._tickCount = (this._tickCount || 0) + 1;
    const bot = this._bot;
    if (!bot || !bot.entity) return;
    const pos = bot.entity.position;

    // 累计行程：只在同维度内累加，避免传送/换维度把数字冲爆
    if (this._lastPosForTravel) {
      const step = distanceXZ(pos, this._lastPosForTravel);
      // 过滤掉瞬移（例如重生、/tp），单步超过 64 格不计
      if (step > 0.2 && step < 64) this._traveled += step;
    }
    this._lastPosForTravel = { x: pos.x, z: pos.z };

    // 1) 第一次见到值得留意的生物
    const ents = this.nearbyEntities({ radius: 32, limit: 40 });
    for (const e of ents) {
      const name = String(e.name || '').replace(/^minecraft:/, '');
      if (!name || name === 'item' || name === 'player') continue;
      if (!NOTABLE_MOBS.has(name)) continue;
      if (this._seenMobs.has(name)) continue;
      this._seenMobs.add(name);
      this._emit('discovery.mob', {
        name,
        distance: e.distance,
        position: e.position,
        hostile: e.hostile,
        first_time: true,
      });
    }

    // 2) 第一次拿到贵重物品
    const inv = collectInventoryMap(bot);
    if (inv) {
      for (const [item, count] of Object.entries(inv)) {
        if (!VALUABLE_ITEMS[item]) continue;
        if (this._seenItems.has(item) || count <= 0) continue;
        this._seenItems.add(item);
        this._emit('discovery.treasure', {
          item,
          count,
          weight: VALUABLE_ITEMS[item],
          position: { x: round(pos.x, 1), y: round(pos.y, 1), z: round(pos.z, 1) },
          dimension: bot.game ? bot.game.dimension : null,
        });
      }
    }

    // 3) 行程里程碑：每累计 200 格报一次
    if (this._traveled - this._lastMilestoneAt >= 200) {
      this._lastMilestoneAt = this._traveled;
      this._emit('discovery.milestone', {
        kind: 'travel',
        traveled: Math.round(this._traveled),
        position: { x: round(pos.x, 1), y: round(pos.y, 1), z: round(pos.z, 1) },
        dimension: bot.game ? bot.game.dimension : null,
      });
    }
  }

  /** 给插件生成面向 LLM 的紧凑简报（真正的 token 预算守门人在这里） */
  brief({ maxLength = 800, includeGoal = null } = {}) {
    const s = this.snapshot('normal');
    if (!s.connected) return '【Bot 未进服】';

    const parts = [];
    parts.push(
      `位置 (${s.position.x}, ${s.position.y}, ${s.position.z}) ${dimensionName(s.dimension)} | ` +
        `生命 ${s.health}/${s.max_health} | 饱食 ${s.food}/20`,
    );
    if (s.effects && s.effects.length) parts.push(`状态 ${s.effects.map((e) => e.name).join('/')}`);
    if (s.held_item) parts.push(`手持 ${s.held_item.name}${s.held_item.durability_pct !== null ? `(耐久${s.held_item.durability_pct}%)` : ''}`);
    if (s.armor && s.armor.length) parts.push(`护甲 ${s.armor.map((a) => a.name).join('/')}`);
    parts.push(`背包 ${s.inventory_summary.text}`);

    const ground = s.standing_on ? `脚下 ${s.standing_on}` : null;
    const env = [ground, s.light !== null ? `光照 ${s.light}` : null, `时间 ${timeName(s.time_of_day)}`, s.is_raining ? '下雨' : null]
      .filter(Boolean)
      .join(' | ');
    if (env) parts.push(env);

    const ents = (s.nearby_entities || []).slice(0, 6).map((e) => `${e.name}×${e.count || 1} ${e.distance}格`);
    if (ents.length) parts.push(`附近 ${ents.join(' | ')}`);

    if (includeGoal) parts.push(`目标 ${includeGoal}`);
    const current = this._currentTaskText;
    if (current) parts.push(`当前动作 ${current}`);

    for (const n of this._pinnedNotes.slice(-3)) parts.push(n);

    let text = parts.join('\n');
    if (text.length > maxLength) text = `${text.slice(0, maxLength - 12)}…(已截断)`;
    return text;
  }

  setCurrentTaskText(text) {
    this._currentTaskText = text || null;
  }
}

// ---------------------------------------------------------------- 内部函数

/**
 * 构造 Vec3 后调用 blockAt。
 *
 * 注意：这里必须直接调 bot.blockAt，**不能**递归调自己。
 * 之前批量替换脚本把本函数的函数体也替换成了 blockAt(bot, x, y, z)，
 * 导致无限递归 → 栈溢出 → 被下面的 catch 吞掉 → 所有方块查询静默返回 null。
 * 教训：这类"兜底 catch"会掩盖真实故障，所以这里出错要打日志，不能无声。
 */
function blockAt(bot, x, y, z) {
  try {
    if (!bot || typeof bot.blockAt !== 'function') return null;
    return bot.blockAt(vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
  } catch (err) {
    log.debug(`blockAt(${x},${y},${z}) 失败：${err.message}`);
    return null;
  }
}

function safeLight(bot, pos) {
  try {
    if (typeof bot.blockAt !== 'function') return null;
    const b = blockAt(bot, Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
    if (!b) return null;
    // **这里报的是"有效光照"**，不是单纯的方块光：
    //   - b.light 是方块光源（火把/岩浆/萤石），白天地表它也是 0
    //   - b.skyLight 是"露天程度"，**夜里在地表它仍然是 15**（天空光不随时间变）
    // 只看其中一个都会误判：
    //   只看 light → 白天地表报"光照 0"，她以为天黑了；
    //   只看 skyLight → 夜里地表报"光照 15"，她以为很亮、不去点灯。
    // MC 的实际亮度规则大致是"夜里天空光要减 11"，这里照此估算。
    const blockLight = typeof b.light === 'number' ? b.light : 0;
    const skyLight = typeof b.skyLight === 'number' ? b.skyLight : 0;
    const tod = bot.time ? bot.time.timeOfDay : 0;
    const night = tod >= 13000 && tod <= 23000;
    const effectiveSky = night ? Math.max(0, skyLight - 11) : skyLight;
    return Math.max(blockLight, effectiveSky);
  } catch {
    return null;
  }
}

/** 原始的天空光/方块光（不做时间修正），给需要分开判断的地方用 */
function rawLights(bot, pos) {
  try {
    if (typeof bot.blockAt !== 'function') return { sky: null, block: null };
    const b = blockAt(bot, Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
    if (!b) return { sky: null, block: null };
    return {
      sky: typeof b.skyLight === 'number' ? b.skyLight : null,
      block: typeof b.light === 'number' ? b.light : null,
    };
  } catch {
    return { sky: null, block: null };
  }
}

function entityName(e, bot) {
  if (!e) return 'unknown';
  if (e.type === 'player' && e.username) return e.username;
  // mineflayer 的 entity.name 在部分版本是 displayName（如 "Zombie"）
  if (e.name) return String(e.name);
  if (e.displayName) return String(e.displayName);
  if (e.mobType) return String(e.mobType);
  try {
    const data = bot.registry && bot.registry.entitiesByName ? bot.registry.entitiesByName : null;
    if (data && e.entityType !== undefined) {
      const key = Object.keys(data).find((k) => data[k].id === e.entityType);
      if (key) return key;
    }
  } catch {
    /* ignore */
  }
  return 'unknown';
}

/** 把同名同距离段的实体合并成 {name, count}，简报更短 */
function collapseEntities(list) {
  const out = [];
  const byName = new Map();
  for (const e of list) {
    const key = e.type === 'player' ? `player:${e.name}` : e.name;
    const existing = byName.get(key);
    if (existing) {
      existing.count += 1;
      existing.distance = Math.min(existing.distance, e.distance);
      continue;
    }
    const item = { ...e, count: 1 };
    byName.set(key, item);
    out.push(item);
  }
  out.sort((a, b) => Number(b.hostile) - Number(a.hostile) || a.distance - b.distance);
  return out;
}

function describeHeldItem(bot) {
  const item = bot.heldItem;
  if (!item) return null;
  const out = { name: item.name, count: item.count, slot: bot.quickBarSlot };
  if (item.maxDurability) {
    out.durability = item.durabilityUsed !== undefined ? item.maxDurability - item.durabilityUsed : null;
    out.durability_pct = item.durabilityUsed !== undefined ? Math.round((1 - item.durabilityUsed / item.maxDurability) * 100) : null;
  }
  return out;
}

function describeEffects(bot) {
  const effects = bot.entity && bot.entity.effects ? bot.entity.effects : null;
  if (!effects) return [];
  return Object.values(effects).map((e) => ({
    name: (bot.registry && bot.registry.effects && bot.registry.effects[e.id]) ? bot.registry.effects[e.id].name : `effect_${e.id}`,
    amplifier: e.amplifier,
    duration: e.duration,
  }));
}

function describeArmor(bot) {
  const out = [];
  const slots = [
    ['helmet', bot.inventory && bot.inventory.slots ? bot.inventory.slots[5] : null],
    ['chestplate', bot.inventory && bot.inventory.slots ? bot.inventory.slots[6] : null],
    ['leggings', bot.inventory && bot.inventory.slots ? bot.inventory.slots[7] : null],
    ['boots', bot.inventory && bot.inventory.slots ? bot.inventory.slots[8] : null],
  ];
  for (const [slot, item] of slots) {
    if (item) out.push({ slot, name: item.name, count: item.count });
  }
  return out;
}

/** 背包摘要：按分类聚合，最多 12 条，避免简报被 36 格物品撑爆 */
function summarizeInventory(bot) {
  const items = collectInventoryItems(bot);
  const totalCount = items.reduce((sum, i) => sum + i.count, 0);
  const byName = new Map();
  for (const i of items) {
    byName.set(i.name, (byName.get(i.name) || 0) + i.count);
  }
  const entries = [...byName.entries()].map(([name, count]) => ({ name, count, group: itemGroup(name) }));
  // 分组聚合：同一类只报总量，例如"木材×32"
  const groups = new Map();
  const singles = [];
  for (const e of entries) {
    if (e.group) {
      const g = groups.get(e.group) || { count: 0, names: [] };
      g.count += e.count;
      if (g.names.length < 4) g.names.push(e.name);
      groups.set(e.group, g);
    } else {
      singles.push(e);
    }
  }
  const parts = [];
  for (const [label, g] of groups) {
    parts.push(`${label}×${g.count}`);
  }
  singles.sort((a, b) => b.count - a.count);
  for (const s of singles.slice(0, 8)) parts.push(`${s.name}×${s.count}`);

  const usedSlots = new Set(items.map((i) => i.slot)).size;
  return {
    text: parts.length ? parts.join(' ') : '空',
    used_slots: usedSlots,
    total_items: totalCount,
    entries: entries.slice(0, 40),
  };
}

function describeInventoryFull(bot) {
  const items = collectInventoryItems(bot);
  return items.map((i) => ({
    slot: i.slot,
    name: i.name,
    count: i.count,
    display: i.displayName,
    durability_pct: i.maxDurability ? Math.round((1 - (i.durabilityUsed || 0) / i.maxDurability) * 100) : null,
  }));
}

/** 背包 → {物品名: 总数}，给"第一次拿到贵重物品"的判定用 */
function collectInventoryMap(bot) {
  const out = {};
  for (const item of collectInventoryItems(bot)) {
    out[item.name] = (out[item.name] || 0) + item.count;
  }
  return out;
}

/**
 * 收集背包物品（不含护甲与副手）。
 *
 * **槽位布局是这里最容易搞错的地方**，之前就写反过一次：
 *   实际布局（实测 slots.length=46）：
 *     0–4    合成栏
 *     5–8    护甲（头/胸/腿/脚）
 *     9–35   主背包
 *     36–44  快捷栏（inv.hotbarStart = 36）
 *     45     副手
 *   而曾经误以为是"0–8 快捷栏、36–44 护甲"，于是把快捷栏物品全过滤掉了——
 *   表现是"背包摘要一直缺东西"，而且只在拿到物品后才发现。
 *
 * 现在改为**优先用 mineflayer 暴露的边界常量**（inventoryStart / inventoryEnd /
 * hotbarStart），拿不到时才退回硬编码，避免再写反。
 */
function collectInventoryItems(bot) {
  const out = [];
  if (!bot.inventory || !bot.inventory.slots) return out;
  const inv = bot.inventory;
  const slots = inv.slots;

  // 主背包区间：mineflayer 的 inventoryStart..inventoryEnd 覆盖主背包 + 快捷栏
  const mainStart = Number.isInteger(inv.inventoryStart) ? inv.inventoryStart : 9;
  const mainEnd = Number.isInteger(inv.inventoryEnd) ? inv.inventoryEnd : 45; // 不含
  const hotbarStart = Number.isInteger(inv.hotbarStart) ? inv.hotbarStart : 36;

  for (let slot = 0; slot < slots.length; slot += 1) {
    const item = slots[slot];
    if (!item) continue;
    // 只统计"主背包 + 快捷栏"这两个区间
    const inMain = slot >= mainStart && slot < mainEnd;
    const inHotbar = slot >= hotbarStart && slot < hotbarStart + 9;
    if (!inMain && !inHotbar) continue;
    out.push({
      slot,
      name: item.name,
      count: item.count,
      displayName: item.displayName,
      maxDurability: item.maxDurability || null,
      durabilityUsed: item.durabilityUsed || 0,
    });
  }
  return out;
}

function inventoryFingerprint(bot) {
  const items = collectInventoryItems(bot);
  let sum = 0;
  let slots = 0;
  for (const i of items) {
    sum += i.count;
    slots += 1;
  }
  return `${slots}:${sum}`;
}

function normalizeYaw(yaw) {
  let deg = (yaw * 180) / Math.PI;
  deg %= 360;
  if (deg < 0) deg += 360;
  return deg;
}

function dimensionName(dim) {
  if (!dim) return '';
  const map = {
    'minecraft:overworld': '主世界',
    'minecraft:the_nether': '下界',
    'minecraft:the_end': '末地',
    overworld: '主世界',
    the_nether: '下界',
    the_end: '末地',
  };
  return map[dim] || dim;
}

function timeName(tick) {
  if (tick === null || tick === undefined) return '未知';
  const t = Number(tick) % 24000;
  if (t < 6000) return '清晨';
  if (t < 12000) return '白天';
  if (t < 13800) return '黄昏';
  if (t < 22200) return '夜晚';
  return '黎明';
}

module.exports = {
  StateTracker,
  INTERESTING_BLOCKS,
  itemGroup,
  summarizeInventory,
  dimensionName,
  timeName,
  HOSTILE_NAMES,
  isHostileName,
};
