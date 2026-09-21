'use strict';
/**
 * 原子动作层：挖掘、放置、合成、熔炼、装备、进食、战斗、容器。
 *
 * 原则：**一切失败都要给得出"为什么"和"下一步怎么办"**。
 * 这些错误信息最终会进 LLM 的上下文，写得含糊模型就会原地死循环，
 * 写得清楚它会自己换策略（去拿工具、先去别处、先做中间产物）。
 */

const log = require('./log');
const {
  delay,
  distance,
  blockCenter,
  fmtBlock,
  describeFailure,
  humanizeError,
  CancelledError,
  TimeoutError,
  clamp,
  vec3,
} = require('./util');
const { smoothLookAt } = require('./humanize');

const { GameError, NotConnectedError } = require('./rpc');

/** 工具等级：用来挑"能挖且最快"的工具，顺带避免拿快坏的镐去挖石头 */
const TIER_ORDER = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite'];

class ActionError extends GameError {
  constructor(message, data) {
    super(message, data);
    this.name = 'ActionError';
  }
}

class MissingItemError extends ActionError {
  constructor(what, hint) {
    super(`缺少${what}${hint ? `；${hint}` : ''}`, { kind: 'missing_item', what });
    this.name = 'MissingItemError';
  }
}

class NoToolError extends ActionError {
  constructor(message) {
    super(message, { kind: 'no_tool' });
    this.name = 'NoToolError';
  }
}

class ProtectedBlockError extends ActionError {
  constructor(message) {
    super(message, { kind: 'protected' });
    this.name = 'ProtectedBlockError';
  }
}

const REACH = 4.4; // 原版生存交互距离，略留余量
const DIG_TIMEOUT_BASE = 8000;

class Actions {
  constructor({ bot, config, navigator }) {
    this._bot = bot;
    this._config = config;
    this._nav = navigator;
    this._lastEatAt = 0;
    this._eating = false;
  }

  get bot() {
    return this._bot;
  }

  _requireBot() {
    if (!this._bot || !this._bot.entity) throw new NotConnectedError();
    return this._bot;
  }

  // ================================================================ 挖掘

  /**
   * 挖掉一个方块。会：选合适的工具 → 走近 → 挖掘 → 收集掉落物。
   *
   * @param {object} o
   * @param {number} o.x @param {number} o.y @param {number} o.z
   * @param {AbortSignal} [o.signal]
   * @param {boolean} [o.collect] 是否收集掉落物（默认 true）
   * @param {boolean} [o.reach] 是否允许自己走过去（默认 false，由调用方决定，避免技能层重复寻路）
   */
  async dig({ x, y, z, signal = null, collect = true, reach = false }) {
    this._requireBot();
    const bot = this._bot;
    const block = bot.blockAt(vec3(x, y, z));
    if (!block) throw new ActionError(`(${x}, ${y}, ${z}) 附近没有加载区块，无法挖掘`);
    if (block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') {
      throw new ActionError(`(${x}, ${y}, ${z}) 是空气，没有东西可挖`);
    }
    if (!block.diggable) {
      throw new ProtectedBlockError(`(${x}, ${y}, ${z}) 的 ${block.name} 挖不动（硬度无限，或需要特殊方式）`);
    }
    this._assertNotProtected(x, y, z, block.name);

    // 需要走位就先过去
    let dist = distance(bot.entity.position, blockCenter(x, y, z));
    if (dist > REACH - 0.4) {
      if (!reach) {
        throw new ActionError(
          `目标方块 ${block.name}${fmtBlock({ x, y, z })} 距离 ${dist.toFixed(1)} 格，超出可挖距离；请先移动到附近`,
        );
      }
      // **够不到就别做长途寻路**。
      // 判断依据：这个方块旁边/上面有没有"能站人的位置"。
      // 没有的话（被埋住、或在陡坡上只露一个面），pathfinder 一定失败，
      // 而每次失败都会走一遍"整段寻路 + 分段推进(10/6/3)"，白烧约 5 秒。
      // 实测：挖 8 个圆石要 240 秒，时间全花在这里——她卡在山坡上反复重试。
      // 直接抛错，让技能层改成"朝目标挖开"（mineSpecific 的 digToward 就是干这个的）。
      if (!this._hasAdjacentStand(x, y, z)) {
        throw new ActionError(
          `目标方块 ${block.name}${fmtBlock({ x, y, z })} 旁边没有可以站的位置（被埋住或只露出一面），需要先挖开`,
        );
      }
      // segmented: false —— 挖方块只是"走近两三格"，不需要分段长途推进那套
      // xzOnly: true —— 只要求水平靠近：挖的目标常埋在地下/在陡坡上，
      //   按高度匹配会让目标永远无法满足（实测"距目标 0.4 格"却走不完）
      try {
        await this._nav.goTo({ x, y, z, range: 2.5, signal, timeoutMs: 8000, segmented: false, xzOnly: true });
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        // pathfinder 走不动（卡住/目标不可达）→ 像真人一样直接朝它迈几步。
        // 实测这条兜底很关键：自然地形里 pathfinder 经常原地不动，
        // 而"朝目标走两步"反而能到。
        if (typeof this._nav.stepToward === 'function') {
          await this._nav.stepToward({ x, z, signal, timeoutMs: 6000, tolerance: 2.2 });
        }
      }
      dist = distance(bot.entity.position, blockCenter(x, y, z));
      if (dist > REACH) {
        throw new ActionError(`走到跟前了仍相距 ${dist.toFixed(1)} 格，够不到 ${block.name}（可能被围住或悬空）`);
      }
    }

    await this.equipBestToolFor(block, { signal });

    // 这里必须是完整的背包 map（不是数量）：挖完后要用它做差分算产物
    const before = this.inventoryMap();
    const target = { x, y, z };

    // 面向方块：不看向目标服务器不会接受挖掘包。
    // 拟人化开启时渐进转头（终点角度与瞬间对准完全一致，朝向判定不受影响）——
    // 真人挖矿是"转过去看一眼再挥镐"，不是头瞬间跳过去。
    try {
      if (this._config.get('humanize') === false) {
        await bot.lookAt(blockCenter(x, y, z), true);
      } else {
        await smoothLookAt(bot, blockCenter(x, y, z), { signal, durationMs: 110 });
      }
    } catch {
      /* 视角锁定失败不致命 */
    }

    // 挖掘前确认工具耐久：快坏了就提醒，免得挖一半工具碎裂
    const tool = bot.heldItem;
    if (tool && tool.maxDurability && tool.durabilityUsed !== undefined) {
      if (tool.maxDurability - tool.durabilityUsed <= 2) {
        log.warn(`手持 ${tool.name} 耐久仅剩 ${tool.maxDurability - tool.durabilityUsed}，即将损坏`);
      }
    }

    const canDig = bot.canDigBlock(block);
    const timeout = canDig ? DIG_TIMEOUT_BASE : 2000;
    try {
      await this._raceAbort(bot.dig(block), signal, timeout, `挖掘 ${block.name} 超时（${(timeout / 1000).toFixed(0)} 秒）`);
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      const { reason, hint } = humanizeError(err);
      throw new ActionError(`挖掘 ${block.name}${fmtBlock(target)} 失败：${reason}${hint ? `；建议：${hint}` : ''}`);
    }

    // 确认方块真的没了（服务器可能拒绝）
    const after = blockAt(bot, x, y, z);
    const cleared = !after || after.name === 'air' || after.name === 'cave_air' || after.type === 0;

    if (collect && cleared) {
      // **捡掉落物是"挖掘任务自己的策略"**（按「本能 vs 策略」的分层：这类行为不该是逐 tick 的反射）。
      // 反射层的自动捡东西现在只在完全空闲时才跑，所以这里必须自己捡干净——
      // 超时给 5 秒：掉落物有时会弹开一两格，3 秒不够（实测会漏）。
      await this.collectDrops({ signal, timeoutMs: 5000, expectIncrease: true });
    }

    // 用"整次挖掘前后"的背包差分来报告获得物。
    // 不能只看 collectDrops 的增量：掉落物离得近时会自动吸进背包，
    // 那时 collectDrops 扫到的是空，会误报"没捡到"。
    // 也不能拿方块名去猜产物：挖草方块掉的是泥土。
    const gained = {};
    for (const [k, v] of Object.entries(diffInventory(before, this.inventoryMap()))) {
      if (v > 0) gained[k] = v;
    }

    return {
      ok: true,
      block: block.name,
      position: target,
      cleared,
      tool_used: tool ? tool.name : '徒手',
      collected: gained,
      inventory_delta: gained,
      note: cleared ? undefined : `服务器未确认 ${block.name} 被破坏（可能被保护或立即被重新放置）`,
    };
  }

  /** 连续挖多个方块，自动逐个走近；统计获得物 */
  async digMany({ targets, signal = null, collect = true, limit = 64 }) {
    this._requireBot();
    const list = (targets || []).slice(0, limit);
    const results = [];
    const gained = {};
    const before = this.inventoryMap();

    for (const t of list) {
      if (signal && signal.aborted) throw new CancelledError();
      try {
        const r = await this.dig({ x: t.x, y: t.y, z: t.z, signal, collect: false, reach: true });
        results.push({ ...t, ok: true, block: r.block });
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        results.push({ ...t, ok: false, error: describeFailure(err) });
      }
    }
    if (collect) {
      const c = await this.collectDrops({ signal, timeoutMs: 4000 });
      Object.assign(gained, c.gained || {});
    }
    const after = this.inventoryMap();
    const delta = diffInventory(before, after);
    const okCount = results.filter((r) => r.ok).length;
    return {
      ok: okCount > 0,
      attempted: list.length,
      succeeded: okCount,
      failed: list.length - okCount,
      delta,
      gained: Object.keys(gained).length ? gained : delta,
      details: results.slice(0, 20),
    };
  }

  /** 挖掘前挡住受保护方块（配合领地插件场景；白/黑名单可配） */
  _assertNotProtected(x, y, z, name) {
    const blacklist = this._config.get('digBlacklist') || [];
    const short = String(name).replace(/^minecraft:/, '');
    if (blacklist.includes(short)) {
      throw new ProtectedBlockError(`${short} 在禁止挖掘名单中，跳过`);
    }
    const whitelist = this._config.get('digWhitelist') || [];
    if (whitelist.length && !whitelist.includes(short)) {
      throw new ProtectedBlockError(`${short} 不在允许挖掘的白名单内（当前配置只允许挖：${whitelist.join(', ')}）`);
    }
    const radius = Number(this._config.get('spawnProtectionRadius')) || 0;
    if (radius > 0) {
      const bot = this._bot;
      const spawn = bot.spawnPoint || { x: 0, y: 64, z: 0 };
      if (distance({ x, y, z }, spawn) < radius) {
        throw new ProtectedBlockError(`(${x},${y},${z}) 在出生点保护半径 ${radius} 格内，不进行破坏性动作`);
      }
    }
  }

  // ================================================================ 工具与装备

  /**
   * 为指定方块装备最合适的工具。
   * 找不到工具时**不报错**：徒手也能挖泥土和木头（只是慢），但要提醒调用方。
   */
  async equipBestToolFor(block, { signal = null } = {}) {
    const bot = this._requireBot();
    const better = this._findBetterTool(block);
    if (better) {
      try {
        await this.holdItem({ item: better.name, signal });
        return better.name;
      } catch (err) {
        log.debug(`装备 ${better.name} 失败：${err.message}`);
      }
    }
    // 检查手上/背包里有没有能挖这个方块的工具。
    //
    // **绝对不能用 bot.canDigBlock() 做这个判断**：mineflayer 那个函数检查的是
    // "方块是否在 5.1 格可挖距离内"，跟有没有工具毫无关系（见 mineflayer/lib/plugins/digging.js）。
    // 离得远时它返回 false，于是这里会误报"背包里没有镐"——
    // 实测后果极严重：她明明拿着木镐，却因为石头埋在几格外的地下而报"没有镐"，
    // 于是**直接放弃挖掘、连走过去都不试**，导致"挖石头"永远失败、
    // 整条生存链（石头 → 石制工具 → 庇护所）全部锁死。
    if (!this._hasToolFor(block)) {
      const needed = this._requiredToolKind(block);
      throw new NoToolError(
        `挖 ${block.name} 需要${needed ? `一把${toolKindName(needed)}` : '合适的工具'}，背包里没有；` +
          `建议先合成工具（例如 mc_craft("stone_pickaxe")），或放弃这个目标换一种方块`,
      );
    }
    return null;
  }

  /**
   * 这个方块旁边（或上面）有没有"能站人的位置"。
   *
   * 用途：没有可站位置时，寻路必然失败。识别出来直接跳过寻路，
   * 省掉每次约 5 秒的"整段寻路 + 分段推进"重试——实测这是挖矿慢的主因。
   * 比"六面都是实体"更准：陡坡上只露一个面的石头，六面并非全实心，
   * 但照样站不过去。
   */
  _hasAdjacentStand(x, y, z) {
    const bot = this._bot;
    if (!bot) return true; // 判断不了就别拦
    // 软植被（树叶/草/藤蔓）是可以蹭掉的，不算"挡住站位的实体方块"——
    // 否则森林里树干旁边全是树叶时会被误判成"没地方站"，
    // 实测把砍树也一起挡掉了（"目标方块 oak_log 旁边没有可以站的位置"）。
    const soft = (b) => {
      if (!b) return false;
      const n = String(b.name || '');
      return (
        n.endsWith('_leaves') ||
        n === 'grass' ||
        n === 'tall_grass' ||
        n === 'fern' ||
        n === 'large_fern' ||
        n.endsWith('_vines') ||
        n === 'vine' ||
        n === 'snow' ||
        n === 'dead_bush'
      );
    };
    const openFeet = (b) => !!b && (b.boundingBox === 'empty' || soft(b));
    const standable = (bx, by, bz) => {
      const floor = bot.blockAt(vec3(bx, by - 1, bz));
      const feet = bot.blockAt(vec3(bx, by, bz));
      const head = bot.blockAt(vec3(bx, by + 1, bz));
      if (!floor || !feet || !head) return false; // 读不到（未加载）当作不可站
      return floor.boundingBox === 'block' && openFeet(feet) && openFeet(head);
    };
    // **先看她站在原地够不够得着**。
    // 真人挖自己头上/脚边那格时不需要先"找个位置站好"——她本来就在那儿。
    // 早期这里只看 5 个候选站位，于是"从下面往上挖"被误判成"没地方站"，
    // 导致挖台阶向上爬这条唯一出路被自己挡死（实测：她在 3 格深的坑里一步都不动）。
    const p = bot.entity.position;
    const reach = Math.hypot(p.x - (x + 0.5), p.y + 1.0 - (y + 0.5), p.z - (z + 0.5));
    if (reach <= 3.5) return true;

    const cands = [
      [x + 1, y, z],
      [x - 1, y, z],
      [x, y, z + 1],
      [x, y, z - 1],
      [x, y + 1, z], // 站到方块上面
      [x, y - 1, z], // 站在方块下面（往上挖：爬台阶/挖竖井最常见的情形）
    ];
    return cands.some(([a, b, c]) => standable(a, b, c));
  }

  /**
   * 这个方块是不是"被埋住的"（六面都是实体方块）。
   * 保留作为快速判断，主判断用 _hasAdjacentStand。
   */
  _isBuried(x, y, z) {
    const bot = this._bot;
    if (!bot) return false;
    const solid = (dx, dy, dz) => {
      const b = bot.blockAt(vec3(x + dx, y + dy, z + dz));
      if (!b) return true; // 读不到（未加载）也算"过不去"
      return b.boundingBox === 'block';
    };
    return (
      solid(1, 0, 0) &&
      solid(-1, 0, 0) &&
      solid(0, 1, 0) &&
      solid(0, -1, 0) &&
      solid(0, 0, 1) &&
      solid(0, 0, -1)
    );
  }

  /**
   * 背包里有没有能挖这个方块的工具。
   * 只看"有没有"，不看距离、不看是否已手持——距离问题由 dig 里的走位逻辑负责。
   */
  _hasToolFor(block) {    const bot = this._bot;
    if (!block) return false;
    let harvest = null;
    try {
      const info = bot.registry.blocksByName[block.name];
      harvest = block.harvestTools || (info && info.harvestTools) || null;
    } catch {
      harvest = null;
    }
    // 不需要特定工具（泥土、木头等徒手可挖）
    if (!harvest) return true;
    for (const item of bot.inventory.items()) {
      if (harvest[item.type]) return true;
    }
    // 手持的物品也要算（inventory.items() 已包含快捷栏，这里再兜一层）
    const held = bot.heldItem;
    if (held && harvest[held.type]) return true;
    return false;
  }

  _requiredToolKind(block) {
    try {
      const bot = this._bot;
      const info = bot.registry.blocksByName[block.name];
      if (!info || !info.harvestTools) return null;
      const toolIds = Object.keys(info.harvestTools);
      if (!toolIds.length) return null;
      const item = bot.registry.items[Number(toolIds[0])];
      if (!item) return null;
      return item.name.split('_').pop();
    } catch {
      return null;
    }
  }

  /** 在背包里找"能挖这个方块、且等级最高、耐久还够"的工具 */
  _findBetterTool(block) {
    const bot = this._bot;
    let requiredTools = null;
    try {
      const info = bot.registry.blocksByName[block.name];
      if (info && info.harvestTools) {
        requiredTools = new Set(
          Object.keys(info.harvestTools)
            .map((id) => bot.registry.items[Number(id)])
            .filter(Boolean)
            .map((i) => i.name),
        );
      }
    } catch {
      requiredTools = null;
    }

    let best = null;
    let bestScore = -1;
    for (const item of bot.inventory.items()) {
      const kind = toolKind(item.name);
      if (!kind) continue;
      if (!['pickaxe', 'axe', 'shovel', 'shears'].includes(kind)) continue;
      const tier = TIER_ORDER.indexOf(item.name.split('_')[0]);
      let score = tier >= 0 ? tier : 0;
      // 耐久不足的工具降权，优先用新的
      if (item.maxDurability) {
        const remain = item.maxDurability - (item.durabilityUsed || 0);
        if (remain <= 3) score -= 5;
        else if (remain / item.maxDurability < 0.5) score -= 1;
      }
      if (kindMatchesBlock(kind, block.name)) score += 3;
      if (requiredTools && requiredTools.has(item.name)) score += 2;
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }
    // 当前手持已经是最优就不换来换去（换手有动画延迟）
    const held = bot.heldItem;
    if (held && best && held.name === best.name) return null;
    return best;
  }

  /** 穿戴护甲（只穿比当前更好的位置） */
  async autoEquipArmor({ signal = null } = {}) {
    const bot = this._requireBot();
    const armorSlots = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' };
    const done = [];
    for (const item of bot.inventory.items()) {
      const kind = armorKind(item.name);
      if (!kind) continue;
      const dest = armorSlots[kind];
      const current = bot.inventory.slots[destSlot(kind)];
      if (current && armorScore(current.name) >= armorScore(item.name)) continue;
      try {
        await bot.equip(item, dest);
        await delay(120, { signal });
        done.push(item.name);
      } catch (err) {
        log.debug(`穿戴 ${item.name} 失败：${err.message}`);
      }
    }
    return done;
  }

  /** 装备：支持装备到手上或身上（自动判断目标槽位） */
  async equip({ item: itemName, destination = 'auto', signal = null }) {
    const bot = this._requireBot();
    const want = String(itemName).replace(/^minecraft:/, '');
    const item = this._findItem(want);
    if (!item) {
      throw new MissingItemError(`物品 ${want}`, `当前背包里没有 ${want}；先用 mc_inventory 看看有什么`);
    }
    let dest = destination;
    if (dest === 'auto' || !dest) {
      const kind = armorKind(want);
      dest = kind ? { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' }[kind] : 'hand';
    }
    try {
      await bot.equip(item, dest);
    } catch (err) {
      throw new ActionError(`装备 ${want} 到 ${dest} 失败：${describeFailure(err)}`);
    }
    await delay(120, { signal });
    return { ok: true, equipped: want, destination: dest };
  }

  /**
   * 装备物品到手上（放置/使用前必须确保真的拿在手里）。
   *
   * 为什么不能直接 bot.equip(item, 'hand')：
   *   1. mineflayer 要求重新按槽位取物品；如果手里拿的是**挖矿/捡东西之前**
   *      取到的旧物品对象，槽位可能已经变了，equip 会静默失败
   *   2. 装备是异步的，装备后立刻放置可能还没生效
   * 所以这里：按名字重新查物品 → 装备 → **验证 heldItem** → 必要时重试。
   *
   * 之前的表现是放置方块时报 mineflayer 的 "must be holding an item to place"，
   * 排查半天才发现是装备这一步悄悄没生效。
   */
  async holdItem({ item: itemName, signal = null, attempts = 3 }) {
    const bot = this._requireBot();
    const want = String(itemName).replace(/^minecraft:/, '');
    for (let i = 0; i < attempts; i += 1) {
      const fresh = this._findItem(want);
      if (!fresh) throw new MissingItemError(`物品 ${want}`, '背包里没有这件物品');
      try {
        await bot.equip(fresh, 'hand');
      } catch (err) {
        log.debug(`装备 ${want} 第 ${i + 1} 次失败：${err.message}`);
        await delay(200, { signal });
        continue;
      }
      await delay(120, { signal });
      const held = bot.heldItem;
      if (held && held.name === want) return held;
      log.debug(`装备 ${want} 后手持仍是 ${held ? held.name : '空手'}，重试`);
      await delay(200, { signal });
    }
    const held = bot.heldItem;
    throw new ActionError(
      `想拿 ${want} 但没能装备到手上（当前手持：${held ? held.name : '空手'}）。可以先 mc_equip("${want}") 再重试`,
    );
  }

  /** 在背包里按名字找物品（支持模糊匹配） */
  _findItem(name) {
    const bot = this._bot;
    const want = String(name).replace(/^minecraft:/, '').toLowerCase();
    const items = bot.inventory.items();
    let found = items.find((i) => i.name === want);
    if (found) return found;
    found = items.find((i) => i.name.endsWith(`_${want}`) || i.name === want);
    if (found) return found;
    found = items.find((i) => i.name.includes(want));
    return found || null;
  }

  /** 卸下当前手持到背包 */
  async unequipHand() {
    const bot = this._requireBot();
    const held = bot.heldItem;
    if (!held) return { ok: true, note: '本来就是空手' };
    const slot = bot.inventory.firstEmptySlotRange(9, 45);
    if (slot === null) throw new ActionError('背包已满，无法腾出手持物品');
    await bot.moveSlotItem(held.slot, slot);
    return { ok: true, unequipped: held.name };
  }

  // ================================================================ 放置

  /**
   * 放置方块。
   * mineflayer 的 placeBlock 需要"参考方块 + 面"，直接给坐标是不够的——
   * 这里自动找相邻的实体方块作为支撑面。
   */
  /**
   * 看向某个坐标（世界坐标）。
   * 装门/放东西之前需要先看过去，否则服务器会拒绝交互包。
   * （早期 building.js 调用了这个方法但它并不存在，导致"装门失败：lookAtPoint is not a function"。）
   * 拟人化开启时走渐进转头，终点角度一致，不影响服务器对朝向的判定。
   */
  async lookAtPoint(x, y, z, { signal = null } = {}) {
    const bot = this._requireBot();
    if (this._config.get('humanize') === false) {
      try {
        await bot.lookAt(vec3(x, y, z), true);
        return { ok: true };
      } catch (err) {
        log.debug(`看向 (${x}, ${y}, ${z}) 失败：${err.message}`);
        return { ok: false };
      }
    }
    try {
      const ok = await smoothLookAt(bot, { x, y, z }, { signal });
      return { ok };
    } catch (err) {
      log.debug(`看向 (${x}, ${y}, ${z}) 失败：${err.message}`);
      return { ok: false };
    }
  }

  async place({ x, y, z, item: itemName = null, signal = null, reach = false }) {
    this._requireBot();
    const bot = this._bot;
    const target = { x, y, z };
    const existing = blockAt(bot, x, y, z);
    if (existing && existing.boundingBox !== 'empty' && existing.name !== 'air') {
      throw new ActionError(`${fmtBlock(target)} 已经有 ${existing.name} 了，换个位置`);
    }

    const dist = distance(bot.entity.position, blockCenter(x, y, z));
    if (dist > REACH - 0.4) {
      if (!reach) {
        throw new ActionError(`目标位置 ${fmtBlock(target)} 距离 ${dist.toFixed(1)} 格，超出放置距离；请先移动过去`);
      }
      await this._nav.goTo({ x, y, z, range: 3, signal, timeoutMs: 20000 });
    }

    // 选要放的方块
    let blockItem = null;
    if (itemName) {
      blockItem = this._findItem(itemName);
      if (!blockItem) throw new MissingItemError(`物品 ${itemName}`, '先获取这个方块再放置');
    } else {
      const held = bot.heldItem;
      if (held && isPlaceable(bot, held)) blockItem = held;
      else blockItem = bot.inventory.items().find((i) => isPlaceable(bot, i)) || null;
      if (!blockItem) throw new ActionError('背包里没有任何可以放置的方块；先用 mc_collect 收集一些');
    }
    if (!isPlaceable(bot, blockItem)) {
      throw new ActionError(`${blockItem.name} 不是可放置的方块`);
    }
    // 必须确保真的拿在手里：装备悄悄失败时 mineflayer 只会报
    // "must be holding an item to place"，非常难排查
    await this.holdItem({ item: blockItem.name, signal });

    // 找参考方块：目标六个方向上的第一个实体方块，优先下方（最符合"搭上去"的直觉）
    const faces = [
      { dir: [0, -1, 0], face: { x: 0, y: 1, z: 0 } },
      { dir: [0, 1, 0], face: { x: 0, y: -1, z: 0 } },
      { dir: [-1, 0, 0], face: { x: 1, y: 0, z: 0 } },
      { dir: [1, 0, 0], face: { x: -1, y: 0, z: 0 } },
      { dir: [0, 0, -1], face: { x: 0, y: 0, z: 1 } },
      { dir: [0, 0, 1], face: { x: 0, y: 0, z: -1 } },
    ];
    let reference = null;
    let faceVec = null;
    for (const f of faces) {
      const b = blockAt(bot, x + f.dir[0], y + f.dir[1], z + f.dir[2]);
      if (b && b.boundingBox === 'block') {
        reference = b;
        faceVec = f.face;
        break;
      }
    }
    if (!reference) {
      throw new ActionError(`${fmtBlock(target)} 周围没有可以依附的方块（悬空放置需要先搭一个支撑）`);
    }

    try {
      // 放置前看向目标（渐进转头；终点角度一致，服务器朝向判定不受影响）
      if (this._config.get('humanize') === false) {
        await bot.lookAt(blockCenter(x, y, z), true);
      } else {
        await smoothLookAt(bot, blockCenter(x, y, z), { signal, durationMs: 100 });
      }
    } catch {
      /* ignore */
    }

    try {
      // 用**公开的** bot.placeBlock，不要用底层的 bot._genericPlace：
      // _genericPlace 只负责发包，不等服务器确认；服务器拒绝时（朝向不对、
      // 目标被占、被保护）它也会"成功返回"，表现为"物品被消耗了但方块没出现"。
      // placeBlock 会等 blockUpdate 回执，被拒绝时抛出可读错误。
      await this._raceAbort(
        bot.placeBlock(reference, vec3(faceVec.x, faceVec.y, faceVec.z)),
        signal,
        8000,
        `放置 ${blockItem.name} 超时（服务器没有回应放置请求）`,
      );
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      const held = bot.heldItem;
      throw new ActionError(
        `在 ${fmtBlock(target)} 放置 ${blockItem.name} 失败：${describeFailure(err)}` +
          `（当前手持 ${held ? held.name : '空手'}，依附方块 ${reference.name}）`,
      );
    }

    const after = blockAt(bot, x, y, z);
    const placed = after && after.name !== 'air' && after.boundingBox !== 'empty';
    return {
      ok: placed,
      placed: blockItem.name,
      position: target,
      note: placed ? undefined : '服务器未确认方块被放置（可能被保护或位置被占）',
    };
  }

  // ================================================================ 合成

  /**
   * 合成物品。
   *
   * 工作台的处理策略是**自适应**，不靠猜配方结构：
   *   1. 先按"可能不需要工作台"直接试一次随身合成（2×2）
   *   2. mineflayer 若报 "missing crafting table"，再去找/放一个工作台重试
   *
   * 为什么这么做：配方数据的形状不可靠（实测 jungle_planks 被判成需要工作台，
   * 而它明明是随身可做的），靠启发式会出现**死锁**——做工作台需要木板，
   * 做木板却被告知需要工作台。让代码在运行时试错就不会有这个洞。
   */
  async craft({ item: itemName, count = 1, signal = null, allowTableTravel = true }) {
    const bot = this._requireBot();
    const want = String(itemName).replace(/^minecraft:/, '');
    const mcData = require('minecraft-data')(bot.version);
    const itemData = mcData.itemsByName[want];
    if (!itemData) {
      const near = Object.keys(mcData.itemsByName).filter((n) => n.includes(want)).slice(0, 5);
      throw new ActionError(
        `没有名为 ${want} 的物品${near.length ? `；你是不是想合成：${near.join(' / ')}` : ''}`,
      );
    }

    const recipes = bot.recipesAll(itemData.id, null, true);
    if (!recipes || !recipes.length) {
      throw new ActionError(`${want} 没有可用的合成配方（可能是只能通过熔炼/交易/掉落获得的物品）`);
    }
    // **优先选"她手上的材料能推出来"的配方。**
    //
    // 实测玩家说"做把木镐"：她手上有云杉原木，却去合成 oak_planks——
    // 因为早期这里只按"是否需要工作台"排序，**完全不看她有什么木头**，
    // 结果挑了一个材料不匹配的配方，报"还差 oak_planks×3"，
    // 模型于是反复重试、最后把工具循环步数用光、直接放弃。
    //
    // 只比"缺多少"是不够的：木制配方有五种木头变体，她两种木板都没有时
    // 缺料数完全相同（都是 5），排序分不出来。所以要看**能不能从现有材料推出来**：
    // 有 spruce_log 就意味着 spruce_planks 可做、stick 也可做，
    // 而 oak_planks 做不出来（她没有橡木）。
    const derivable = (name, have) => {
      if ((have[name] || 0) > 0) return true;
      const plank = String(name).match(/^(.+)_planks$/);
      if (plank) {
        return (have[`${plank[1]}_log`] || 0) > 0 || (have[`${plank[1]}_stem`] || 0) > 0;
      }
      if (name === 'stick') {
        // 木棍：任意木板可做，任意原木也能先做木板再做木棍
        return (
          Object.keys(have).some((n) => n.endsWith('_planks') && have[n] > 0) ||
          Object.keys(have).some((n) => /_log$|_stem$/.test(n) && have[n] > 0)
        );
      }
      return false;
    };
    const lackScore = (r) => {
      try {
        const have = this.inventoryMap();
        // 缺料里"做不出来"的越多，越不该选
        return this._missingForRecipe(r, count, mcData).reduce(
          (s, m) => s + (derivable(m.name, have) ? 0 : Math.max(1, m.need - m.have)),
          0,
        );
      } catch {
        return 999;
      }
    };
    recipes.sort(
      (a, b) =>
        lackScore(a) - lackScore(b) ||
        Number(definitelyNeedsTable(b, want)) - Number(definitelyNeedsTable(a, want)),
    );
    const recipe = recipes[0];

    // 检查材料（先于一切，缺材料时不要白跑去找工作台）
    const missing = this._missingForRecipe(recipe, count, mcData);
    if (missing.length) {
      // 提示要**具体**：告诉她手上有什么、该先做什么中间产物
      const have = this.inventoryMap();
      const logs = Object.keys(have).filter((n) => /_log$|_stem$/.test(n) && have[n] > 0);
      const planks = Object.keys(have).filter((n) => n.endsWith('_planks') && have[n] > 0);
      const hintBits = ['可以先 mc_collect（它会自动补齐原木→木板→木棍的整条链）'];
      if (logs.length) hintBits.push(`你手上有 ${logs.join('/')}，可以先 mc_craft(${logs[0].replace(/_log$|_stem$/, '_planks')})`);
      if (planks.length) hintBits.push(`现有木板：${planks.join('/')}`);
      throw new MissingItemError(
        `合成材料（还差 ${missing.map((m) => `${m.name}×${Math.max(0, m.need - m.have)}`).join('、')}）`,
        hintBits.join('；'),
      );
    }

    const times = Math.max(1, Math.min(64, Number(count) || 1));
    const before = this.inventoryMap();

    /**
     * 合成一次。
     *
     * **不要用 bot.craft(recipe, times, table) 的 times 参数**：实测它在 count>1 时
     * 不可靠——`count:2` 只产出 1 份就返回了；`stick` 更是会让 Promise 永不 resolve
     * （20 秒超时，而实际上第一份已经做出来了）。
     * 所以改成"一次只合成一份，循环到数量达标"，用背包增量判断真实产出。
     *
     * 第二个坑（crafttest 实测踩到）：服务器繁忙时（比如刚生成完区块），
     * 合成确认会超过 15 秒，`bot.craft` 的 Promise 超时——
     * 但服务端其实已经把东西做出来了。直接抛错会误报"合成失败"，
     * 而背包里东西明明在。所以超时后先对背包：真的多了就按成功处理。
     */
    const craftOnce = async (table) => {
      // 合成前的三段准备，**顺序很重要**：
      //   1) 先同步一次：让清理用的点击能被服务端接受（否则点击被静默忽略，格子清不掉）
      //   2) 清理 2×2 合成格：残留材料会让服务端算出别的产物（1 块木板 = 按钮）
      //   3) 再同步一次：清理本身也是一串点击，会把 stateId 往前推进——
      //      不同步的话，紧接着的合成点击又是"过期状态"，又被忽略（实测就是这个顺序问题
      //      让"第一次尝试产出为空"反复出现）
      await this._syncInventoryWindow(bot, signal);
      await this._clearCraftingGrid(bot, signal);
      await this._syncInventoryWindow(bot, signal);
      const beforeThis = this.inventoryMap();
      try {
        await this._raceAbort(bot.craft(recipe, 1, table || undefined), signal, 30000, `合成 ${want} 超时`);
      } catch (err) {
        // 关键善后（这条是 crafttest 三连测抓出来的）：
        // _raceAbort 只是放弃了 Promise，mineflayer 的合成**还在后台继续点击**，
        // 窗口不关掉，下一次合成就会在"状态过期"的窗口里点错配方——
        // 实测表现：做木镐产出木斧/按钮、一次出两把斧子、或者"合成没有产出"。
        // 所以出错时先把当前窗口关掉，把合成状态复位。
        try {
          if (bot.currentWindow) {
            log.warn(`合成 ${want} 出错（${describeFailure(err)}），关闭残留窗口以复位合成状态`);
            bot.closeWindow(bot.currentWindow);
          }
        } catch {
          /* 关窗失败不强求 */
        }
        if (err instanceof CancelledError) throw err;
        // 超时/包丢失时先验证真实结果：mineflayer 的 craft 偶发不 resolve，
        // 但服务端早已完成合成（stick 是最典型的）。对不上才报错。
        await delay(300).catch(() => {});
        const now = this.inventoryMap();
        if ((now[want] || 0) > (beforeThis[want] || 0)) {
          log.warn(`合成 ${want} 的回应超时，但背包已更新（按成功处理）`);
          return;
        }
        throw err;
      }
    };

    // **合成一次 + 等产出真正落到本地背包。**
    //
    // 服务端的背包同步是**异步**的：`craftOnce` 返回时，产物可能还没进本地背包。
    // 不等的话会连环出两个问题（都是实测出来的）：
    //   1. 误判"没有产出" → 触发重试 → **多做好几份**
    //      （实测要 4 个木板，最后产出 12 个）
    //   2. 链式合成（木板→木棍→工具）每一步都看不到上一步的产物，
    //      材料检查直接判"缺料" → 链条必断 → 玩家看到"让她做木镐，失败了"
    const craftOnceAndSettle = async (t) => {
      await craftOnce(t);
      await this._waitForInventory(
        () => this.inventoryMap(),
        want,
        (before[want] || 0) + 1,
        { signal, timeoutMs: 1800 },
      );
    };

    // 找到"真正能用"的合成方式：先试随身 2×2，报缺工作台再找/放一个
    let table = null;
    let needRetryWithTable = false;
    try {
      await craftOnceAndSettle(null);
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      if (isMissingTableError(err)) {
        needRetryWithTable = true;
      } else {
        throw new ActionError(`合成 ${want} 失败：${describeFailure(err)}`);
      }
    }
    if (needRetryWithTable) {
      table = await this._ensureCraftingTable({ signal, allowTravel: allowTableTravel, want });
      try {
        await craftOnceAndSettle(table);
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        throw new ActionError(`在有工作台的情况下合成 ${want} 仍失败：${describeFailure(err)}`);
      }
    }

    // 让产出确定地落回背包：合成结果可能还停在窗口里（工作台窗口的产出格或网格），
    // 这时"合成完成"与"背包里真的有"之间存在时间差——
    // 实测表现：引擎报"已合成 X"，但紧接着读背包却没有 X（过一会儿又出现了），
    // 于是上层技能的成败判断和外部观察结果对不上，表现为间歇性失败。
    // 主动关窗 + 稍等，把状态收敛掉。
    await this._closeWindowsAndSettle(bot, signal);

    // 第一次没做出东西时重试。最多三轮，每轮加重"状态复位"的力度。
    //
    // 为什么需要：mineflayer 的合成靠点击落点判断，而 1.17+ 服务端
    // **只在它认为客户端窗口状态过期时才回应点击**——被忽略的点击没有任何回报。
    // 于是本地以为成功了（它还会伪造产出格内容），服务端其实什么都没做，
    // 最终表现为"合成没有产出"。
    // 单次重试能盖住大部分情况，但偶发会连续两轮都踩到脏状态，
    // 所以这里做三轮，每轮之间把窗口同步 + 合成格清理都做一遍。
    //
    // 这里刻意用"应用层兜底"而不是继续深挖 mineflayer 内部状态机：
    // 对使用者来说，能做成比知道它为什么抽风更重要；
    // 三轮都失败才如实报错（并且报的是真正的原因，不是"寻路超时"那种误译）。
    let attempts = 0;
    while (attempts < 2 && (this.inventoryMap()[want] || 0) <= (before[want] || 0)) {
      attempts += 1;
      log.warn(`合成 ${want} 第 ${attempts} 次没有产出，复位窗口状态后重试`);
      // 每轮加大收敛力度：关窗 → 等更久 → 同步 → 清格
      await this._closeWindowsAndSettle(bot, signal);
      await delay(300 * attempts, { signal });
      await this._syncInventoryWindow(bot, signal);
      await this._clearCraftingGrid(bot, signal);
      await this._syncInventoryWindow(bot, signal);
      try {
        await craftOnceAndSettle(table);
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        log.debug(`第 ${attempts} 次重试合成 ${want} 也失败：${describeFailure(err)}`);
      }
      await this._closeWindowsAndSettle(bot, signal);
    }

    // 第一份做出来了，剩下的按需要继续做（逐份，避免上面说的 times 参数问题）
    let produced = (this.inventoryMap()[want] || 0) - (before[want] || 0);
    let guard = 0;
    while (produced < times && guard++ < times + 2) {
      if (signal && signal.aborted) throw new CancelledError();
      const missingNow = this._missingForRecipe(recipe, 1, mcData);
      if (missingNow.length) break; // 材料不够了，见好就收
      try {
        await craftOnceAndSettle(table);
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        log.debug(`继续合成 ${want} 第 ${guard} 份失败（已做出 ${produced} 份）：${describeFailure(err)}`);
        break;
      }
      const now = (this.inventoryMap()[want] || 0) - (before[want] || 0);
      if (now <= produced) break; // 没有新增，说明卡住了，别再空转
      produced = now;
    }

    // 收尾：再收敛一次，保证最后一次合成的产出也已经回到背包，
    // 这样下面这次 after 读到的就是真实结果。
    await this._closeWindowsAndSettle(bot, signal);
    // **等产出真正落到本地背包**：服务端同步是异步的，不等的话
    // 紧接着的链式合成会看不到这批产物（见 _waitForInventory 的说明）。
    await this._waitForInventory(
      () => this.inventoryMap(),
      want,
      (before[want] || 0) + Math.max(1, produced),
      { signal },
    );
    const after = this.inventoryMap();
    const delta = diffInventory(before, after);
    return {
      ok: produced > 0,
      item: want,
      requested: times,
      produced,
      used_table: !!table,
      delta,
      note:
        produced > 0
          ? produced < times
            ? `只做出 ${produced}/${times} 份（材料可能不够）`
            : undefined
          : '合成没有产出，检查材料是否被消耗后又被放回',
    };
  }

  /**
   * 找到或放好一个工作台，并把机器人带到它旁边。
   * 优先用附近的，其次用背包里的（放下来），都没有且允许走远时给出可操作建议。
   */
  async _ensureCraftingTable({ signal = null, allowTravel = true, want = '物品' } = {}) {
    const bot = this._requireBot();
    let table = bot.findBlock({ matching: (b) => b && b.name === 'crafting_table', maxDistance: 24 });

    // **先查记忆**：附近搜不到时，想想"我之前在哪里用过工作台"。
    // 家里有一个就不该再做第二个（做一次要 4 块木板）。
    if (!table && this.stations && bot.entity) {
      const known = this.stations.nearest('crafting_table', bot.entity.position);
      if (known && known.distance <= 128) {
        const b = blockAt(bot, known.x, known.y, known.z);
        if (b && b.name === 'crafting_table') {
          log.info(`想起 ${known.distance} 格外有个工作台，走回去用`);
          table = b;
        } else {
          // 那块已经没了（被拆/被换）→ 忘掉，别再走冤枉路
          this.stations.forget('crafting_table', known);
        }
      }
    }

    if (!table) {
      const tableItem = this._findItem('crafting_table');
      if (tableItem) {
        const pos = this._spotInFront();
        if (pos) {
          try {
            await this.place({ x: pos.x, y: pos.y, z: pos.z, item: 'crafting_table', signal, reach: true });
            table = blockAt(bot, pos.x, pos.y, pos.z);
            // 刚放下的这个记下来：下次直接走回来
            if (table && this.stations) this.stations.remember('crafting_table', table.position);
          } catch (err) {
            log.debug(`放置工作台失败：${err.message}`);
          }
        }
      }
    }

    if (!table) {
      const hint = allowTravel
        ? `${want} 需要工作台才能合成，但附近 24 格内没有、背包里也没有。建议先 mc_craft("crafting_table")（需要 4 个木板）再放置它`
        : `${want} 需要工作台，当前没有可用的工作台`;
      throw new ActionError(hint);
    }

    const d = distance(bot.entity.position, table.position);
    if (d > 3.5) {
      await this._nav.goTo({
        x: table.position.x,
        y: table.position.y,
        z: table.position.z,
        range: 2,
        signal,
        timeoutMs: 20000,
      });
    }
    return table;
  }

  /**
   * 计算这个配方还缺什么。
   *
   * 这里有两个坑，都踩过：
   *
   * 1. **有序配方的 `recipe.ingredients` 是空数组**。
   *    mineflayer 只在无序（shapeless）配方上填 ingredients；有序配方（带 `inShape`
   *    的，工具/工作台/熔炉都是）的 ingredients 是 `[]`。
   *    早期实现只看 ingredients，于是"缺什么"永远算成"不缺"，
   *    表现为反复尝试合成、最后报一句莫名其妙的"材料不足"。
   *    **可靠的数据源是 `recipe.delta`**：里面 count 为负的项就是这一份配方消耗的材料。
   *
   * 2. 不能把网格里每个格子的 count 累加。delta 已经是"整份配方的净消耗"，
   *    直接用它就不用自己数格子了。
   */
  _missingForRecipe(recipe, times, mcData) {
    const perCraft = new Map(); // itemId -> 一份配方消耗几个

    const delta = Array.isArray(recipe.delta) ? recipe.delta : [];
    for (const entry of delta) {
      if (!entry || entry.id === undefined || entry.id === null || entry.id < 0) continue;
      const amount = Number(entry.count) || 0;
      if (amount < 0) perCraft.set(entry.id, (perCraft.get(entry.id) || 0) + -amount);
    }

    // 回退：没有 delta 时按 ingredients 网格数格子（同一物品的多个格子 = 需要几个）
    if (perCraft.size === 0) {
      for (const row of recipe.ingredients || []) {
        for (const [, cell] of Object.entries(row)) {
          if (!cell || cell.id === undefined || cell.id === null || cell.id < 0) continue;
          perCraft.set(cell.id, (perCraft.get(cell.id) || 0) + 1);
        }
      }
    }

    const missing = [];
    // 一批产出几个？多产出配方不能把"想要几个"当成"做几批"：
    // stick 一批出 4 个，要 4 根木棍只需要 1 批（2 块木板），而不是 4 批（8 块木板）。
    // 之前按"件数 × 单批消耗"算，会把材料需求放大好几倍，
    // 导致自愈逻辑过度备料（实测：要 4 根木棍被要求备 8 块木板）。
    let perBatch = 1;
    if (recipe.result && recipe.result.count) {
      perBatch = Math.max(1, Number(recipe.result.count) || 1);
    } else {
      for (const entry of delta) {
        if (entry && Number(entry.count) > 0) perBatch = Math.max(perBatch, Number(entry.count));
      }
    }
    const batches = Math.max(1, Math.ceil(times / perBatch));

    for (const [id, perUnit] of perCraft) {
      const need = perUnit * batches;
      const name = mcData.items[id] ? mcData.items[id].name : `item_${id}`;
      const have = this.countItem(name);
      if (have < need) missing.push({ name, need, have });
    }
    return missing;
  }

  /** 这个配方一份需要消耗哪些材料（给技能层与调试用） */
  recipeRequirements(recipe, mcData) {
    const perCraft = new Map();
    const delta = Array.isArray(recipe.delta) ? recipe.delta : [];
    for (const entry of delta) {
      if (!entry || entry.id === undefined || entry.id === null || entry.id < 0) continue;
      const amount = Number(entry.count) || 0;
      if (amount < 0) perCraft.set(entry.id, (perCraft.get(entry.id) || 0) + -amount);
    }
    if (perCraft.size === 0) {
      for (const row of recipe.ingredients || []) {
        for (const [, cell] of Object.entries(row)) {
          if (!cell || cell.id === undefined || cell.id === null || cell.id < 0) continue;
          perCraft.set(cell.id, (perCraft.get(cell.id) || 0) + 1);
        }
      }
    }
    return [...perCraft.entries()].map(([id, count]) => ({
      name: mcData.items[id] ? mcData.items[id].name : `item_${id}`,
      count,
    }));
  }

  // ================================================================ 熔炼

  /** 熔炼。需要熔炉 + 燃料；会自动放熔炉、找燃料、等产物 */
  async smelt({ item: itemName, count = 1, fuel: fuelName = null, signal = null }) {
    const bot = this._requireBot();
    const want = String(itemName).replace(/^minecraft:/, '');
    const item = this._findItem(want);
    if (!item) throw new MissingItemError(`原料 ${want}`, '先挖到/收集到原料再熔炼');

    const fuelItem = fuelName ? this._findItem(fuelName) : this._findFuel();
    if (!fuelItem) {
      throw new MissingItemError('燃料（煤炭/木炭/原木/木板）', '可以先用 mc_collect 弄点木头当燃料');
    }

    // 找或放熔炉
    let furnace = bot.findBlock({
      matching: (b) => b && (b.name === 'furnace' || b.name === 'blast_furnace' || b.name === 'smoker'),
      maxDistance: 24,
    });
    // 先查记忆：熔炉要 8 个圆石，重做一个等于白挖一轮
    if (!furnace && this.stations && bot.entity) {
      const known = this.stations.nearest('furnace', bot.entity.position);
      if (known && known.distance <= 128) {
        const b = blockAt(bot, known.x, known.y, known.z);
        if (b && (b.name === 'furnace' || b.name === 'blast_furnace' || b.name === 'smoker')) {
          log.info(`想起 ${known.distance} 格外有个熔炉，走回去用`);
          furnace = b;
        } else {
          this.stations.forget('furnace', known);
        }
      }
    }
    if (!furnace) {
      const fItem = this._findItem('furnace');
      if (!fItem) {
        throw new MissingItemError('熔炉', '先用 mc_craft("furnace")（8 个圆石）做一个，再放置');
      }
      const pos = this._spotInFront();
      if (!pos) throw new ActionError('身边找不到可以放熔炉的位置（周围太挤或悬空）');
      await this.place({ x: pos.x, y: pos.y, z: pos.z, item: 'furnace', signal, reach: true });
      furnace = blockAt(bot, pos.x, pos.y, pos.z);
      if (!furnace) throw new ActionError('熔炉放置失败');
      if (this.stations) this.stations.remember('furnace', furnace.position);
    }

    const d = distance(bot.entity.position, furnace.position);
    if (d > 3.5) {
      await this._nav.goTo({
        x: furnace.position.x,
        y: furnace.position.y,
        z: furnace.position.z,
        range: 2,
        signal,
        timeoutMs: 20000,
      });
    }

    const times = Math.max(1, Math.min(64, Number(count) || 1));
    const before = this.inventoryMap();
    const win = await bot.openFurnace(furnace);
    try {
      const put = Math.min(times, item.count);
      const fuelNeeded = Math.max(1, Math.ceil(put / 8)); // 一块煤约烧 8 个
      const fuelPut = Math.min(fuelNeeded, fuelItem.count);
      await win.putInput(item.type, null, put);
      await win.putFuel(fuelItem.type, null, fuelPut);
      log.info(`熔炼 ${want}×${put}，用 ${fuelItem.name}×${fuelPut} 作燃料`);

      const expected = put;
      const deadline = Date.now() + Math.min(60000, 12000 * put);
      let produced = 0;
      while (Date.now() < deadline) {
        if (signal && signal.aborted) throw new CancelledError();
        await delay(500, { signal });
        const out = win.outputItem();
        if (out) {
          produced = out.count;
          if (produced >= expected) break;
        }
        if (!win.inputItem()) break;
      }
      await win.takeOutput();
      try {
        const leftFuel = win.fuelItem();
        if (leftFuel) await win.takeFuel();
      } catch {
        /* ignore */
      }
    } finally {
      win.close();
    }
    await delay(200, { signal });
    const after = this.inventoryMap();
    const delta = diffInventory(before, after);
    const smeltedName = guessSmeltOutput(want);
    const produced = (after[smeltedName] || 0) - (before[smeltedName] || 0);
    return {
      ok: produced > 0,
      input: want,
      output: smeltedName,
      produced,
      delta,
      furnace: fmtBlock(furnace.position),
      note: produced > 0 ? undefined : '熔炼没有产出（燃料不足或配方不对）',
    };
  }

  _findFuel() {
    const preferred = [
      'coal', 'charcoal', 'oak_planks', 'birch_planks', 'spruce_planks', 'oak_log', 'birch_log',
      'spruce_log', 'stick', 'lava_bucket', 'dried_kelp_block', 'blaze_rod',
    ];
    for (const name of preferred) {
      const it = this._findItem(name);
      if (it) return it;
    }
    return null;
  }

  // ================================================================ 进食

  /** 吃东西。会等到饱食度真的恢复，而不是只发个包就返回 */
  async eat({ item: itemName = null, signal = null } = {}) {
    const bot = this._requireBot();
    if (this._eating) throw new ActionError('已经在吃东西了');
    if (bot.food >= 20 && !itemName) return { ok: true, note: '饱食度已满，不需要进食' };

    let food = null;
    if (itemName) {
      food = this._findItem(itemName);
      if (!food) throw new MissingItemError(`食物 ${itemName}`, '先用 mc_inventory 看看有什么吃的');
    } else {
      food = this._pickBestFood();
      if (!food) throw new MissingItemError('可吃的食物', '背包里没有食物；可以打猎获得生肉后熔炼，或收集苹果/面包');
    }

    this._eating = true;
    const beforeFood = bot.food;
    try {
      if (bot.heldItem && bot.heldItem.name !== food.name) {
        await bot.equip(food, 'hand');
        await delay(120, { signal });
      }
      const timeout = 8000;
      const start = Date.now();
      await this._raceAbort(bot.consume(), signal, timeout, '进食超时');
      // 等饱食度真的涨（服务器确认）
      while (Date.now() - start < timeout) {
        if (bot.food > beforeFood || bot.food >= 20) break;
        await delay(200, { signal });
      }
      return {
        ok: true,
        ate: food.name,
        food_before: beforeFood,
        food_after: bot.food,
        health_after: bot.health,
      };
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      throw new ActionError(`进食 ${food.name} 失败：${describeFailure(err)}`);
    } finally {
      this._eating = false;
      this._lastEatAt = Date.now();
    }
  }

  /** 挑最有价值的食物 */
  _pickBestFood() {
    const bot = this._bot;
    const scores = {
      golden_apple: 100, enchanted_golden_apple: 120, cooked_beef: 90, cooked_porkchop: 88,
      cooked_mutton: 86, cooked_chicken: 84, cooked_salmon: 82, cooked_cod: 80, cooked_rabbit: 78,
      bread: 70, baked_potato: 68, golden_carrot: 95, apple: 60, carrot: 55, rabbit_stew: 92,
      mushroom_stew: 88, beetroot_soup: 85, pumpkin_pie: 75, cookie: 40, melon_slice: 35,
      sweet_berries: 30, glow_berries: 32, dried_kelp: 25, rotten_flesh: 5, spider_eye: 1,
      poisonous_potato: 1, raw_beef: 45, raw_porkchop: 43, raw_chicken: 40, raw_mutton: 42,
      raw_salmon: 38, raw_cod: 36, tropical_fish: 20, pufferfish: 1,
    };
    let best = null;
    let bestScore = -1;
    for (const item of bot.inventory.items()) {
      const s = scores[item.name];
      if (s === undefined) continue;
      const score = s + Math.min(item.count, 8);
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }
    return best;
  }

  /** 反射层用：低饱食度且背包有食物 → 立刻吃 */
  async maybeAutoEat({ signal = null } = {}) {
    const bot = this._bot;
    if (!bot || !bot.entity) return null;
    if (!this._config.get('autoEat')) return null;
    const threshold = Number(this._config.get('eatFoodLevel')) || 14;
    if (bot.food >= threshold) return null;
    if (Date.now() - this._lastEatAt < 10000) return null; // 冷却，避免刷屏
    if (this._eating) return null;
    const food = this._pickBestFood();
    if (!food) return null;
    try {
      return await this.eat({ signal });
    } catch (err) {
      log.debug(`自动进食失败：${err.message}`);
      return null;
    }
  }

  // ================================================================ 战斗

  /**
   * **用弓射**（远程）。原来只有近战——骷髅在十几格外射你，她只能干挨着走过去。
   *
   * 要点：
   *   1. **要蓄力**：弓不拉满伤害很低（拉满约 9~10 点，半拉只有 1~2 点）
   *   2. **要预判**：箭飞过去要时间，得瞄"目标将要在的位置"而不是当前位置
   *   3. **要抬一点**：箭会下坠，远距离要往上修正
   * 这三条少一条都打不中——真人射箭也是这么瞄的。
   */
  async attackRanged({ target, signal = null, maxShots = 12, chargeMs = 1200, retreatHealth = null } = {}) {
    const bot = this._requireBot();
    // **先查装备再找目标**：没有弓/箭是最该先说的（否则会报"找不到目标"，
    // 让人以为是目标的问题，其实是没武器——实测踩过这个误导）。
    if (this.countItem('bow') === 0) {
      throw new MissingItemError('弓', '先做一把弓（3 根木棍 + 3 根线），还要有箭');
    }
    if (this.countItem('arrow') === 0) {
      throw new MissingItemError('箭', '弓有了但没箭（燧石 + 木棍 + 羽毛），可以先 mc_craft("arrow")');
    }
    const entity = this._resolveEntity(target);
    if (!entity) throw new ActionError(`附近找不到目标：${target}`);
    await this.holdItem({ item: 'bow', signal });
    const lowHealth = retreatHealth === null ? Number(this._config.get('retreatHealth')) || 8 : retreatHealth;

    let shots = 0;
    const start = Date.now();
    while (shots < maxShots) {
      if (signal && signal.aborted) throw new CancelledError();
      if (Date.now() - start > 90000) {
        return { ok: false, reason: '射箭超时（90 秒）', shots, target: entity.name };
      }
      if (bot.health <= lowHealth) {
        return { ok: false, reason: `血量降到 ${bot.health}，主动撤退（低于阈值 ${lowHealth}）`, shots };
      }
      const live = bot.entities[entity.id];
      if (!live) return { ok: true, killed: true, shots, target: entity.name };

      const dist = distance(bot.entity.position, live.position);
      if (dist > 48) {
        return { ok: false, reason: `目标在 ${dist.toFixed(0)} 格外，太远了（弓的射程约 48 格）`, shots };
      }
      // 太近就别射了——箭没拉开就打，伤害还不如直接砍
      if (dist < 3.5) {
        return { ok: false, reason: `目标已经贴到 ${dist.toFixed(1)} 格，太近了，改用近战（mc_attack）`, shots };
      }

      // **预判 + 抬枪**：箭速约 40 格/秒，重力约 20 格/秒²
      const t = dist / 40;
      const vel = live.velocity || { x: 0, y: 0, z: 0 };
      const aimX = live.position.x + (vel.x || 0) * t;
      const aimZ = live.position.z + (vel.z || 0) * t;
      const aimY = live.position.y + (live.height ? live.height * 0.6 : 0.9) + (vel.y || 0) * t + 0.5 * 20 * t * t;

      try {
        await bot.lookAt(vec3(aimX, aimY, aimZ), true);
      } catch (err) {
        log.debug(`瞄准失败：${err.message}`);
      }

      // 拉弓 → 等蓄力 → 放
      try {
        bot.activateItem();
        await delay(chargeMs, { signal });
        bot.deactivateItem();
        shots += 1;
      } catch (err) {
        throw new ActionError(`射箭失败：${describeFailure(err)}`);
      }
      // 射完等一会儿再看结果。
      //
      // **判断"死了没"踩过两个坑，都记在这里**：
      //   1. 只看 `!bot.entities[id]` 会误判——实体被击中时 mineflayer 会短暂
      //      把它从实体表里摘掉再放回，"看不到"被当成"死了"。
      //   2. 兜底的"按名字找附近"半径写小了也会误判——实测半径 8，
      //      而目标在 10 格外，于是**每一箭都被当成射死了**。
      // 现在：先按 id 查（在就是活着）；id 没了再按名字在**整个射程内**找；
      // 而且要**连续 3 次都看不到**才算死（约 1.5 秒）。
      // 宁可多说"还没打死"，也不要虚报战果——虚报会让模型以为赢了、不再补刀。
      let gone = false;
      for (let i = 0; i < 3; i += 1) {
        await delay(500, { signal });
        if (this._targetAlive(entity.id, entity.name, 48)) {
          gone = false;
          break;
        }
        gone = true;
      }
      if (gone) {
        return { ok: true, killed: true, shots, target: entity.name };
      }
      // 箭用完了就停
      if (this.countItem('arrow') === 0) {
        return { ok: false, reason: `箭用完了（射了 ${shots} 次）`, shots, target: entity.name };
      }
    }
    const stillAlive = this._targetAlive(entity.id, entity.name, 48);
    return {
      ok: !stillAlive,
      killed: !stillAlive,
      shots,
      target: entity.name,
      reason: stillAlive ? `射了 ${shots} 次还没打死（可能要靠近点，或换更好的弓）` : undefined,
    };
  }

  /**
   * 目标还活着吗？
   *
   * 先按实体 id 查（在就是活着）；id 没了再按名字在给定半径内找一遍。
   * 半径要**大于交战距离**——见 attackRanged 里的说明（写成 8 会误判）。
   */
  _targetAlive(entityId, name, radius = 48) {
    const bot = this._requireBot();
    if (entityId !== undefined && entityId !== null && bot.entities[entityId]) return true;
    return this._entityStillNearby(name, radius);
  }

  /**
   * 附近还有没有这个类型的实体？（比"查实体表里那个 id 在不在"可靠）
   */
  _entityStillNearby(name, radius = 8) {
    const bot = this._requireBot();
    const want = String(name || '').toLowerCase();
    if (!want || !bot.entity) return false;
    const me = bot.entity.position;
    for (const e of Object.values(bot.entities || {})) {
      if (!e || !e.position || e === bot.entity) continue;
      if (String(e.name || '').toLowerCase() !== want) continue;
      if (distance(me, e.position) <= radius) return true;
    }
    return false;
  }

  /**
   * **举盾格挡**（按住右键）。
   *
   * 真人在挨打时会举盾：正面来的伤害能减掉大部分。这里只是"举起来"，
   * 什么时候放下由调用方决定（通常是威胁没了）。
   */
  async raiseShield({ signal = null, holdMs = 3000 } = {}) {
    const bot = this._requireBot();
    if (this.countItem('shield') === 0) {
      throw new MissingItemError('盾牌', '先做一个（6 块木板 + 1 个铁锭），挨打时举起来能挡掉大部分伤害');
    }
    await this.holdItem({ item: 'shield', signal });
    try {
      await bot.activateItem(true); // 副手/主手举盾
      await delay(Math.max(300, Math.min(holdMs, 15000)), { signal });
      bot.deactivateItem();
    } catch (err) {
      throw new ActionError(`举盾失败：${describeFailure(err)}`);
    }
    return { ok: true, note: `举了 ${(holdMs / 1000).toFixed(1)} 秒盾` };
  }

  /** 攻击实体。会先走过去、装备武器、连续攻击到目标死亡或逃跑 */
  async attack({ target, signal = null, maxAttacks = 40, retreatHealth = null } = {}) {
    const bot = this._requireBot();
    const entity = this._resolveEntity(target);
    if (!entity) throw new ActionError(`附近找不到目标：${target}`);

    await this.equipBestWeapon({ signal });

    const lowHealth = retreatHealth === null ? Number(this._config.get('retreatHealth')) || 8 : retreatHealth;
    let attacks = 0;
    const start = Date.now();

    while (attacks < maxAttacks) {
      if (signal && signal.aborted) throw new CancelledError();
      if (Date.now() - start > 60000) {
        return { ok: false, reason: '战斗超时（60 秒）', attacks, target: entity.name };
      }
      // 血量太低就撤，别送死
      if (bot.health <= lowHealth) {
        return { ok: false, reason: `血量降到 ${bot.health}，主动撤退（低于阈值 ${lowHealth}）`, attacks, target: entity.name };
      }
      const live = bot.entities[entity.id];
      if (!live) {
        return { ok: true, killed: true, attacks, target: entity.name };
      }
      const d = distance(bot.entity.position, live.position);
      if (d > REACH - 0.6) {
        try {
          await this._nav.goTo({ x: live.position.x, y: live.position.y, z: live.position.z, range: 2, signal, timeoutMs: 8000 });
        } catch (err) {
          if (err instanceof CancelledError) throw err;
          await delay(200, { signal });
          continue;
        }
        continue;
      }
      try {
        // 必须用 Vec3 构造瞄点：entity.position 上的 offset 在部分版本不存在。
        // 攻击目标时也渐进转头（真人打架是转头瞄准，不是瞬间锁定）
        const aim = vec3(live.position.x, live.position.y + (live.height ? live.height * 0.85 : 1), live.position.z);
        if (this._config.get('humanize') === false) {
          await bot.lookAt(aim, true);
        } else {
          await smoothLookAt(bot, aim, { signal, durationMs: 90 });
        }
      } catch {
        /* ignore */
      }
      try {
        bot.attack(live);
        attacks += 1;
      } catch (err) {
        log.debug(`攻击失败：${err.message}`);
      }
      // **走位：像真人那样侧移绕圈**，而不是站着对砍。
      // 站着不动对砍在 MC 里很吃亏（怪会连续命中），而且看着也不像人在打架。
      // 每 2~3 下换一次方向，保持"绕圈"而不是"来回抖"。
      if (attacks % 2 === 0) {
        try {
          const side = Math.random() < 0.5 ? 'left' : 'right';
          bot.setControlState(side, true);
          await delay(180 + Math.random() * 220, { signal });
          bot.setControlState(side, false);
        } catch {
          /* 走位失败不影响攻击 */
        }
      }
      // 原版攻击冷却约 0.6 秒，太快会被服务器判定无效
      await delay(this._config.get('slowMode') ? 900 : 620, { signal });
    }
    return { ok: false, reason: `攻击次数达到上限（${maxAttacks}），目标可能太强或打不中`, attacks, target: entity.name };
  }

  async equipBestWeapon({ signal = null } = {}) {
    const bot = this._requireBot();
    const held = bot.heldItem;
    if (held && /(_sword|_axe)$/.test(held.name)) return held.name;
    const weapons = bot.inventory
      .items()
      .filter((i) => /(_sword|_axe)$/.test(i.name))
      .sort((a, b) => weaponScore(b.name) - weaponScore(a.name));
    if (!weapons.length) return null;
    try {
      await bot.equip(weapons[0], 'hand');
      await delay(120, { signal });
    } catch {
      /* 装备失败不影响徒手打 */
    }
    return weapons[0].name;
  }

  _resolveEntity(target) {
    const bot = this._bot;
    if (!target) return null;
    if (typeof target === 'object' && target.position) return target;
    if (typeof target === 'number') return bot.entities[target] || null;
    const name = String(target).replace(/^minecraft:/, '').toLowerCase();
    const me = bot.entity ? bot.entity.position : null;
    let best = null;
    let bestD = Infinity;
    for (const id of Object.keys(bot.entities)) {
      const e = bot.entities[id];
      if (!e || !e.position || e === bot.entity) continue;
      const candidates = [e.name, e.username, e.displayName, e.mobType, e.kind]
        .filter(Boolean)
        .map((s) => String(s).replace(/^minecraft:/, '').toLowerCase());
      if (!candidates.includes(name)) continue;
      const d = me ? distance(e.position, me) : 0;
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  // ================================================================ 交互与物品

  /** 右键使用方块（开箱/开门/按钮/床） */
  async useBlock({ x, y, z, item = null, signal = null, reach = false }) {
    const bot = this._requireBot();
    const block = blockAt(bot, x, y, z);
    if (!block) throw new ActionError(`${fmtBlock({ x, y, z })} 没有加载`);
    const d = distance(bot.entity.position, blockCenter(x, y, z));
    if (d > REACH - 0.4) {
      if (!reach) throw new ActionError(`方块距离 ${d.toFixed(1)} 格，够不到；先移动过去`);
      await this._nav.goTo({ x, y, z, range: 2, signal, timeoutMs: 15000 });
    }
    // **先把要用的东西拿在手上**。
    //
    // 实测踩过：倒水桶时没装备，`activateBlock` 用的是手上那把镐，
    // 结果"成功"了但**一滴水都没倒出来**（世界里的水方块数还是 0）。
    // 右键的效果完全取决于手持物品，所以这里必须先装备再点。
    if (item) {
      const want = String(item).replace(/^minecraft:/, '');
      if (!bot.heldItem || bot.heldItem.name !== want) {
        await this.holdItem({ item: want, signal });
      }
    }
    try {
      // **对着方块右键，还是"对空气使用"？要看手上是什么。**
      //
      // 实测结论（用 `debug.usebucket` 逐个包试出来的）：
      //   - **水桶**：只有 `activateItem`（`use_item` 包）能让服务端倒出水。
      //     用 `activateBlock`（`block_place`）桶**永远不会变空**、一滴水都没有。
      //     而且必须在**空中**倒——站在地面上倒，水会落在她自己站的那一格，
      //     服务端直接拒绝。
      //   - **方块**：`activateBlock` 才是对的（要指定贴哪一面）。
      // 所以这里按"是不是方块物品"来分派，而不是"先试一个再退另一个"。
      const held = bot.heldItem;
      const isBlockItem = held && require('minecraft-data')(bot.version).blocksByName[held.name];
      await bot.lookAt(block.position.offset(0.5, 1, 0.5), true);
      if (held && !isBlockItem) {
        bot.activateItem();
      } else {
        await bot.activateBlock(block);
      }
    } catch (err) {
      throw new ActionError(`使用 ${block.name} 失败：${describeFailure(err)}`);
    }
    await delay(200, { signal });
    return { ok: true, block: block.name, position: { x, y, z }, held: bot.heldItem ? bot.heldItem.name : null };
  }

  /**
   * 手写的小范围找床（不依赖 `bot.findBlock`）。
   *
   * 扫描量：半径 16、纵向 ±2 → 约 33×33×5 = 5400 次 blockAt。
   * 比"直接把引擎卡住"好得多，而且只在 findBlock 失败时才跑。
   */
  _scanForBed(radius = 16) {
    const bot = this._requireBot();
    const p = bot.entity.position;
    const cx = Math.floor(p.x);
    const cy = Math.floor(p.y);
    const cz = Math.floor(p.z);
    let best = null;
    let bestD = Infinity;
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        for (let dz = -radius; dz <= radius; dz += 1) {
          const b = blockAt(bot, cx + dx, cy + dy, cz + dz);
          if (!b || !String(b.name).endsWith('_bed')) continue;
          const d = Math.hypot(dx, dy, dz);
          if (d < bestD) {
            bestD = d;
            best = b;
          }
        }
      }
    }
    if (best) log.debug(`findBlock 没找到床，手写扫描在 ${bestD.toFixed(1)} 格外找到一张`);
    return best;
  }

  /**
   * **睡一觉**（真人天黑就睡，能跳过整个夜晚 + 设重生点）。
   *
   * mineflayer 有 `bot.sleep()`，但它要求很严、报错还是英文的——
   * 这里把每一条都翻译成"她/模型能读懂并据此行动"的话：
   *   - 不是夜里也不是雷雨 → 服务器不让睡（先干点别的，或者等天黑）
   *   - 附近有怪（原版规则 ~8 格内）→ 先清怪
   *   - 床被占了 / 只有半张床 → 换一张
   * 另外她会**先走过去**——睡觉得站到床边。
   */
  async sleepInBed({ signal = null, timeoutMs = 120000 } = {}) {
    const bot = this._requireBot();
    if (bot.isSleeping) return { ok: true, already: true, note: '已经在睡了' };

    // 先找床：附近 32 格（findBlock），找不到再用**手写的小范围扫描**兜底。
    //
    // 为什么要兜底：实测 `bot.findBlock` 在她**站进床里**（放床时被挤过去）之后
    // 会返回 null——同一张床在天黑前能看到、天黑后就"消失"了，
    // 于是她明明睡在一张床上却报"附近没有床"。
    let bed = bot.findBlock({ matching: (b) => b && String(b.name).endsWith('_bed'), maxDistance: 32 });
    if (!bed) bed = this._scanForBed(16);
    if (!bed && this.stations && bot.entity) {
      const known = this.stations.nearest('bed', bot.entity.position);
      if (known && known.distance <= 96) {
        const b = blockAt(bot, known.x, known.y, known.z);
        if (b && String(b.name).endsWith('_bed')) bed = b;
        else this.stations.forget('bed', known);
      }
    }
    if (!bed) {
      throw new MissingItemError(
        '床',
        '附近 32 格内没有床。先做一张（3 个羊毛 + 3 块木板）放在屋里——晚上能睡过去，还能设重生点',
      );
    }

    // 走过去（睡觉得站到床边）
    const d = distance(bot.entity.position, blockCenter(bed.position.x, bed.position.y, bed.position.z));
    if (d > 2) {
      try {
        await this._nav.goTo({
          x: bed.position.x,
          y: null,
          z: bed.position.z,
          range: 1.6,
          signal,
          timeoutMs: 25000,
          segmented: false,
        });
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        log.debug(`走到床边失败，就地试着睡：${err.message}`);
      }
    }

    // 天亮就如实说，别浪费一轮
    const tod = bot.time ? Number(bot.time.timeOfDay) : 0;
    const isNight = tod >= 12541 && tod <= 23458;
    const storm = !!bot.isRaining && Number(bot.thunderState) > 0;
    if (!isNight && !storm) {
      return {
        ok: false,
        note: '现在天还亮着，睡不了（原版规则：只能夜里或雷雨天睡）。天黑再来，或者先干点别的',
      };
    }

    try {
      await bot.sleep(bed);
    } catch (err) {
      const msg = String(err.message || err);
      let hint = msg;
      if (/not night/i.test(msg)) hint = '服务器说现在不是夜里，睡不了';
      else if (/occupied/i.test(msg)) hint = '这张床被占了，换一张';
      else if (/only half bed/i.test(msg)) hint = '这床只有半张（另一半被拆了），放一张新的';
      else if (/monster|too far|not safe/i.test(msg)) hint = '附近有怪，原版规则不让睡——先清掉它们';
      else if (/cant click/i.test(msg)) hint = '够不到这张床，走近一点再试';
      throw new ActionError(`睡觉失败：${hint}`);
    }

    // 等服务器确认她真的睡下
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !bot.isSleeping) {
      if (signal && signal.aborted) throw new CancelledError();
      await delay(200, { signal });
    }
    if (!bot.isSleeping) {
      return { ok: false, note: '请求睡觉了但服务器没让睡（可能床的位置不对，或附近有怪）' };
    }
    log.info('她睡下了（天黑了）');

    // 等天亮（睡着期间服务器推进时间）。醒来或超时就返回。
    const wakeDeadline = Date.now() + Math.max(30000, Math.min(timeoutMs, 600000));
    while (Date.now() < wakeDeadline) {
      if (signal && signal.aborted) throw new CancelledError();
      if (!bot.isSleeping) break;
      await delay(1000, { signal });
    }
    const stillSleeping = !!bot.isSleeping;
    if (stillSleeping) {
      try {
        await bot.wake();
      } catch {
        /* 叫不醒就算了 */
      }
    }
    const tod2 = bot.time ? Number(bot.time.timeOfDay) : 0;
    return {
      ok: true,
      slept: true,
      woke_at: tod2,
      note: stillSleeping ? '睡了很久还没天亮（可能有人在旁边），先起来了' : '睡醒了，天亮了',
    };
  }

  /**
   * **对实体右键**：剪羊毛、给动物喂食、挤奶、给狗喂骨头…
   *
   * 参数做成"对谁做什么"，而不是"发什么包"——模型只要说
   * `interact(target="sheep", item="shears")` 就够了。
   */
  async interactEntity({ target, item = null, signal = null, timeoutMs = 20000 } = {}) {
    const bot = this._requireBot();
    const ent = this._findEntity(target);
    if (!ent) throw new ActionError(`附近没有 ${target}（可以先 mc_scan_entities 看看有什么）`);
    const d = distance(bot.entity.position, ent.position);
    if (d > 3) {
      try {
        await this._nav.goTo({
          x: ent.position.x,
          y: null,
          z: ent.position.z,
          range: 2,
          signal,
          timeoutMs: Math.max(8000, timeoutMs),
          segmented: false,
        });
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        log.debug(`走到 ${target} 身边失败：${err.message}`);
      }
    }
    if (item) {
      const want = String(item).replace(/^minecraft:/, '');
      if (!bot.heldItem || bot.heldItem.name !== want) await this.holdItem({ item: want, signal });
    }
    try {
      await bot.lookAt(ent.position.offset(0, 1, 0), true);
      await bot.useOn(ent);
    } catch (err) {
      throw new ActionError(`对 ${target} 使用失败：${describeFailure(err)}`);
    }
    await delay(300, { signal });
    return {
      ok: true,
      target: ent.name || target,
      item: bot.heldItem ? bot.heldItem.name : null,
      note: `对 ${ent.name || target} 用了 ${bot.heldItem ? bot.heldItem.name : '手'}`,
    };
  }

  /** 按名字/类型找一个实体（就近优先） */
  _findEntity(target) {
    const bot = this._requireBot();
    const want = String(target || '').toLowerCase().replace(/^minecraft:/, '');
    const me = bot.entity.position;
    let best = null;
    let bestD = Infinity;
    for (const e of Object.values(bot.entities || {})) {
      if (!e || !e.position || e === bot.entity) continue;
      const name = String(e.name || e.displayName || '').toLowerCase();
      if (name !== want && !name.includes(want)) continue;
      const d = distance(me, e.position);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  /** 对玩家使用手持物品（给予物品/喂食/交易入口） */
  async useOnPlayer({ target, signal = null } = {}) {
    const bot = this._requireBot();
    const player = Object.values(bot.players || {}).find(
      (p) => p.username && p.username.toLowerCase() === String(target).toLowerCase() && p.entity,
    );
    if (!player) throw new ActionError(`附近没有玩家 ${target}`);
    const d = distance(bot.entity.position, player.entity.position);
    if (d > REACH - 0.6) {
      await this._nav.goTo({
        x: player.entity.position.x,
        y: player.entity.position.y,
        z: player.entity.position.z,
        range: 2,
        signal,
        timeoutMs: 15000,
      });
    }
    await bot.activateEntity(player.entity);
    return { ok: true, target: player.username };
  }

  async drop({ item: itemName, count = 1, signal = null } = {}) {
    const bot = this._requireBot();
    const it = this._findItem(itemName);
    if (!it) throw new MissingItemError(`物品 ${itemName}`, '背包里没有这个东西');
    const n = clamp(Number(count) || 1, 1, it.count);
    await bot.toss(it.type, null, n);
    await delay(200, { signal });
    return { ok: true, dropped: it.name, count: n };
  }

  async openContainer({ x, y, z, signal = null, reach = false }) {
    const bot = this._requireBot();
    const block = blockAt(bot, x, y, z);
    if (!block) throw new ActionError(`${fmtBlock({ x, y, z })} 没有加载`);
    const containerNames = ['chest', 'trapped_chest', 'barrel', 'shulker_box', 'ender_chest'];
    const isContainer = containerNames.some((n) => block.name.includes(n));
    if (!isContainer) throw new ActionError(`${block.name} 不是容器`);
    const d = distance(bot.entity.position, blockCenter(x, y, z));
    if (d > REACH - 0.4) {
      if (!reach) throw new ActionError(`箱子距离 ${d.toFixed(1)} 格，够不到；先移动过去`);
      await this._nav.goTo({ x, y, z, range: 2, signal, timeoutMs: 15000 });
    }
    const win = await bot.openContainer(block);
    return {
      win,
      describe() {
        return {
          container: block.name,
          items: win.containerItems().map((i) => ({ name: i.name, count: i.count, slot: i.slot })),
        };
      },
    };
  }

  /** 把背包里的物品存进箱子（可指定只存某些） */
  async deposit({ x, y, z, items = null, keep = null, signal = null, reach = true }) {
    const container = await this.openContainer({ x, y, z, signal, reach });
    const win = container.win;
    const moved = {};
    try {
      const keepSet = new Set((keep || []).map((k) => String(k).replace(/^minecraft:/, '')));
      const wantSet = items ? new Set(items.map((k) => String(k).replace(/^minecraft:/, ''))) : null;
      for (const item of win.items()) {
        if (wantSet && !wantSet.has(item.name)) continue;
        if (keepSet.has(item.name)) continue;
        const n = item.count;
        try {
          await win.deposit(item.type, null, n);
          moved[item.name] = (moved[item.name] || 0) + n;
        } catch (err) {
          log.debug(`存入 ${item.name} 失败：${err.message}`);
        }
      }
    } finally {
      win.close();
    }
    return { ok: true, stored: moved, total: Object.values(moved).reduce((a, b) => a + b, 0) };
  }

  /** 从箱子取出物品 */
  async withdraw({ x, y, z, item: itemName, count = 1, signal = null, reach = true }) {
    const container = await this.openContainer({ x, y, z, signal, reach });
    const win = container.win;
    const taken = {};
    try {
      const want = itemName ? String(itemName).replace(/^minecraft:/, '') : null;
      const available = win.containerItems();
      const pool = want ? available.filter((i) => i.name === want || i.name.includes(want)) : available;
      if (!pool.length) throw new MissingItemError(`箱子里的 ${want || '任何物品'}`, '箱子是空的或没有这个物品');
      let remain = Math.max(1, Number(count) || 1);
      for (const item of pool) {
        if (remain <= 0) break;
        const n = Math.min(remain, item.count);
        await win.withdraw(item.type, null, n);
        taken[item.name] = (taken[item.name] || 0) + n;
        remain -= n;
      }
    } finally {
      win.close();
    }
    return { ok: true, taken };
  }

  /**
   * 收集附近的掉落物（挖矿/砍树后必做，否则东西会消失）。
   *
   * 关键点（踩过的坑）：**掉落物不一定就在脚下**。
   * 在树冠/高处挖方块时，掉落物会落到下面的树叶或地面上，站着不动永远够不到，
   * 现象是"方块挖掉了、进度却一直不涨"。所以这里允许为捡东西走一段路，
   * 并且优先捡"能走到的"那些，捡不到的记录下来如实返回，而不是假装成功。
   */
  async collectDrops({ signal = null, timeoutMs = 8000, maxDistance = 16, maxHops = 6, expectIncrease = false } = {}) {
    const bot = this._requireBot();
    const before = this.inventoryMap();
    const countBefore = sumCounts(before);
    const deadline = Date.now() + timeoutMs;

    // 先给服务器一点时间生成掉落物实体。
    // 方块被破坏和掉落物实体出现之间有一小段延迟，立刻扫描会扫到空，
    // 现象是"东西其实已经进背包了，却报告没捡到"。
    await delay(350, { signal });

    let hops = 0;
    let lastCount = countBefore;
    const unreachable = [];
    const triedIds = new Set(); // 已经确认够不到的掉落物，避免在同一处反复打转

    while (Date.now() < deadline && hops < maxHops) {
      if (signal && signal.aborted) throw new CancelledError();

      const drops = Object.values(bot.entities)
        .filter((e) => e && e !== bot.entity && e.name === 'item' && e.position && !triedIds.has(e.id))
        .map((e) => ({ entity: e, dist: distance(e.position, bot.entity.position) }))
        .filter((d) => d.dist <= maxDistance)
        .sort((a, b) => a.dist - b.dist);

      if (!drops.length) break;

      const nearest = drops[0];
      // 已经很近了：站着等吸附，不必寻路
      if (nearest.dist <= 1.6) {
        await delay(400, { signal });
        const nowCount = sumCounts(this.inventoryMap());
        if (nowCount === lastCount) {
          // 停在跟前也吸不到：多半在下方够不着（比如掉在树冠下方的地面上）
          unreachable.push({ x: nearest.entity.position.x, y: nearest.entity.position.y, z: nearest.entity.position.z });
          triedIds.add(nearest.entity.id);
        }
        lastCount = nowCount;
        hops += 1;
        continue;
      }

      try {
        await this._nav.goTo({
          x: nearest.entity.position.x,
          y: nearest.entity.position.y,
          z: nearest.entity.position.z,
          range: 1,
          signal,
          timeoutMs: Math.min(8000, Math.max(1500, deadline - Date.now())),
        });
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        // 走不到就算了，记下来，不为捡东西卡死
        unreachable.push({ x: nearest.entity.position.x, y: nearest.entity.position.y, z: nearest.entity.position.z });
        triedIds.add(nearest.entity.id);
      }
      hops += 1;
      lastCount = sumCounts(this.inventoryMap());
    }

    const after = this.inventoryMap();
    const delta = diffInventory(before, after);
    const gained = {};
    for (const [k, v] of Object.entries(delta)) {
      if (v > 0) gained[k] = v;
    }
    if (expectIncrease && Object.keys(gained).length === 0) {
      // 判定"有没有捡到"只能看背包增量的差分。
      // 不能拿方块名去对：挖草方块掉的是泥土、挖矿掉的是粗矿，名字根本不一样。
      log.debug(
        `这次没有捡到东西（背包无正向变化，diff=${JSON.stringify(delta)}，够不到的掉落物 ${unreachable.length} 处）`,
      );
    }
    return { gained, delta, before, after, unreachable: unreachable.length };
  }

  // ================================================================ 背包

  /**
   * 刷新窗口状态（背包 / 已打开的容器）。
   *
   * **这是"每次合成的第一次尝试都产出为空"的真正解药。**
   *
   * mineflayer 的源码里写明了机制（inventory.js 的 syncWindow 注释）：
   * 1.17.1+ 的服务端只在它认为"客户端记录已过期"时才回应点击，
   * **被它忽略的点击不会有任何回报**。而 mineflayer 的合成完全依赖
   * 自己对窗口的本地模型（点哪个格、光标拿着什么、stateId 是多少）。
   * 一旦本地 stateId 落后于服务端，服务端就静默丢弃我们的点击，
   * 本地却以为点成功了，还会 `updateSlot(0, 伪造的产出)` 然后去
   * shift-click 一个**服务端眼里是空的**产出格 —— 于是"合成没有产出"。
   *
   * `_syncWindow` 是 mineflayer 官方提供的复位手段：发一个故意无效的点击
   * （stateId = -1、slot = -999），逼服务端回一份完整窗口状态，把本地模型拉回一致。
   *
   * 带超时：这是内部 API，万一服务端不回，也不能让合成卡死。
   */
  async _syncInventoryWindow(bot, signal = null) {
    if (!bot || typeof bot._syncWindow !== 'function') return;
    const targets = [];
    if (bot.inventory) targets.push(bot.inventory);
    if (bot.currentWindow && bot.currentWindow !== bot.inventory) targets.push(bot.currentWindow);
    for (const win of targets) {
      try {
        await Promise.race([bot._syncWindow(win), delay(2000, { signal })]);
      } catch (err) {
        log.debug(`窗口状态同步失败（忽略）：${err.message}`);
      }
    }
  }

  /**
   * 清空玩家自带的 2×2 合成格（槽位 1..4；0 是产出格，绝对不能动）。
   *
   * **这是 crafttest 间歇性失败的真正根因**，值得写清楚：
   *
   * mineflayer 的合成是"手动点格子 + 本地伪造产出"——
   * 它把材料点进格子，然后 `window.updateSlot(0, new Item(recipe.result...))`
   * 在本地**假设**产出格里有目标物品，再把产出格 shift-click 进背包。
   * 也就是说：**它信任自己的本地模型，而不是服务端算出来的结果**（见 mineflayer/lib/plugins/craft.js）。
   *
   * 而玩家自己的 2×2 合成格是**持久**的：关窗不会清空它（只有工作台那种容器窗口关了才自动退回）。
   * 于是合成一旦被打断（超时、取消、某次点击丢包），材料就留在格子里。
   * 之后再合成时：格子里已有的木板会让服务端算出完全不同的东西——
   * 一块木板 = **按钮**，而本地却以为做出的是镐子。
   *
   * 实测症状完全对应：背包里莫名出现 `oak_button`、工具"合成没有产出"、
   * 一次点出两把斧子（点击落到了错误的格子上）。
   */
  async _clearCraftingGrid(bot, signal = null) {
    const inv = bot && bot.inventory;
    if (!inv || !inv.slots) return;
    try {
      // 光标上可能还捏着东西（点击丢包时常见），先放回背包
      if (inv.selectedItem) {
        await bot.putSelectedItemRange(inv.inventoryStart, inv.inventoryEnd, inv, null);
        await delay(120, { signal });
      }
    } catch (err) {
      log.debug(`放下光标物品失败（忽略）：${err.message}`);
    }
    for (let slot = 1; slot <= 4; slot += 1) {
      if (!inv.slots[slot]) continue;
      try {
        log.debug(`合成格槽位 ${slot} 有残留（${inv.slots[slot].name}），清回背包`);
        await bot.putAway(slot);
        await delay(80, { signal });
      } catch (err) {
        log.debug(`清理合成格槽位 ${slot} 失败（忽略）：${err.message}`);
      }
    }
  }

  /**
   * 关掉残留的容器窗口并等背包状态收敛。
   *
   * 为什么需要：合成结果可能先落在窗口的产出格/网格里，稍后才回到背包。
   * 这期间"任务已完成"和"背包里真的有"不一致，上层技能与外部观察者
   * （测试脚本、插件）会读到互相矛盾的结果，表现为间歇性的假失败。
   */
  async _closeWindowsAndSettle(bot, signal = null) {
    try {
      if (bot && bot.currentWindow) {
        bot.closeWindow(bot.currentWindow);
        // 等服务端确认关窗、物品归位。250ms 在本地服上够用；
        // 拿不到就下次读背包时自然修正，不至于卡住。
        await delay(250, { signal });
      }
    } catch (err) {
      log.debug(`关窗收敛失败（忽略）：${err.message}`);
    }
  }

  /**
   * 等"服务端的背包更新"真正落到本地。
   *
   * **这是合成链断裂的真凶**：实测
   *   craft(spruce_planks×4) → 返回 ok:true、delta {spruce_planks:4}
   *   紧接着读背包 → {"spruce_log":3}          ← 木板还没到！
   *   下一轮再读 → {"spruce_log":3,"spruce_planks":4}
   * 服务端的背包同步是**异步**的，所以链式合成（木板→木棍→工具）每一步
   * 都看不到上一步的产物，材料检查直接判定"缺料"，链条必断。
   * 玩家看到的就是"让她做木镐，失败了"。
   *
   * @param {function():object} readInv 读背包的函数（返回 name→count）
   * @param {string} expectName 期望出现的物品
   * @param {number} atLeast 期望至少有多少
   */
  async _waitForInventory(readInv, expectName, atLeast, { signal = null, timeoutMs = 2500 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = 0;
    while (Date.now() < deadline) {
      if (signal && signal.aborted) throw new CancelledError();
      const inv = readInv();
      last = inv[expectName] || 0;
      if (last >= atLeast) return true;
      await delay(80, { signal });
    }
    log.debug(`等背包更新超时：期望 ${expectName}×${atLeast}，实际 ${last}`);
    return false;
  }

  inventoryMap() {
    const bot = this._bot;
    if (!bot || !bot.inventory) return {};
    const map = {};
    for (const item of bot.inventory.items()) {
      map[item.name] = (map[item.name] || 0) + item.count;
    }
    return map;
  }

  countItem(name) {
    return this.inventoryMap()[String(name).replace(/^minecraft:/, '')] || 0;
  }

  _countInventoryItems() {
    const bot = this._bot;
    return bot && bot.inventory ? bot.inventory.items().reduce((s, i) => s + i.count, 0) : 0;
  }

  // ================================================================ 辅助

  /** 在脚前方找一块可以放东西的位置（放工作台/熔炉用） */
  _spotInFront() {
    const bot = this._bot;
    if (!bot || !bot.entity) return null;
    const p = bot.entity.position;
    const yaw = bot.entity.yaw;
    const dirs = [
      [Math.round(-Math.sin(yaw)), Math.round(Math.cos(yaw))],
      [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1],
    ];
    for (const [dx, dz] of dirs) {
      for (const dy of [0, -1, 1]) {
        const x = Math.floor(p.x) + dx;
        const y = Math.floor(p.y) + dy;
        const z = Math.floor(p.z) + dz;
        const here = blockAt(bot, x, y, z);
        const below = blockAt(bot, x, y - 1, z);
        if (!here || !below) continue;
        const hereFree = here.boundingBox === 'empty' || here.name === 'air';
        const belowSolid = below.boundingBox === 'block';
        if (hereFree && belowSolid) return { x, y, z };
      }
    }
    return null;
  }

  /** 把 Promise 和取消信号 + 超时绑在一起 */
  async _raceAbort(promise, signal, timeoutMs, timeoutMessage) {
    if (!signal) {
      return Promise.race([
        promise,
        delay(timeoutMs).then(() => {
          throw new TimeoutError(timeoutMessage);
        }),
      ]);
    }
    if (signal.aborted) throw new CancelledError();
    let onAbort;
    const abortPromise = new Promise((_, reject) => {
      onAbort = () => reject(new CancelledError('动作被取消'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([
        promise,
        abortPromise,
        delay(timeoutMs).then(() => {
          throw new TimeoutError(timeoutMessage);
        }),
      ]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

// ---------------------------------------------------------------- 纯函数辅助

function toolKind(name) {
  const n = String(name).replace(/^minecraft:/, '');
  for (const k of ['pickaxe', 'axe', 'shovel', 'hoe', 'sword', 'shears', 'flint_and_steel', 'bucket']) {
    if (n.endsWith(k) || n === k) return k;
  }
  return null;
}

function toolKindName(kind) {
  return {
    pickaxe: '镐',
    axe: '斧',
    shovel: '锹',
    hoe: '锄',
    sword: '剑',
    shears: '剪刀',
  }[kind] || kind;
}

function kindMatchesBlock(kind, blockName) {
  const n = String(blockName);
  if (kind === 'pickaxe') {
    return /(ore|stone|cobble|deepslate|obsidian|netherrack|brick|concrete|iron_block|gold_block|diamond_block|anvil|furnace|rail|glass)/.test(n);
  }
  if (kind === 'axe') return /(log|wood|planks|fence|door|chest|barrel|bookshelf|crafting_table|pumpkin|melon)/.test(n);
  if (kind === 'shovel') return /(dirt|grass_block|sand|gravel|clay|soul_sand|snow|mycelium|podzol|farmland)/.test(n);
  if (kind === 'shears') return /(leaves|wool|web)/.test(n);
  return false;
}

function armorKind(name) {
  const n = String(name).replace(/^minecraft:/, '');
  for (const k of ['helmet', 'chestplate', 'leggings', 'boots']) {
    if (n.endsWith(`_${k}`)) return k;
  }
  return null;
}

function armorScore(name) {
  const n = String(name).replace(/^minecraft:/, '');
  const tier = TIER_ORDER.findIndex((t) => n.startsWith(`${t}_`));
  const slotWeight = /chestplate/.test(n) ? 3 : /leggings/.test(n) ? 2 : 1;
  return (tier + 1) * 10 + slotWeight;
}

function destSlot(kind) {
  return { helmet: 5, chestplate: 6, leggings: 7, boots: 8 }[kind];
}

function weaponScore(name) {
  const n = String(name).replace(/^minecraft:/, '');
  const tier = TIER_ORDER.findIndex((t) => n.startsWith(`${t}_`));
  const base = n.endsWith('_sword') ? 100 : 50;
  return base + (tier + 1);
}

/** 判断物品能否作为方块放置 */
function isPlaceable(bot, item) {
  try {
    const block = bot.registry.blocksByName[item.name];
    if (!block) return false;
    if (item.name === 'water_bucket' || item.name === 'lava_bucket') return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * 判断合成错误是不是"缺工作台"。
 *
 * 必须做**多种拼写**的宽松匹配：mineflayer 的原文是
 *   `Recipe requires craftingTable, but one was not supplied: {...}`
 * ——注意它写的是 `craftingTable`（驼峰、无空格），
 * 早期只匹配 `crafting table`（带空格）导致自适应回退完全失效，
 * 表现为"木板做出来了，但工具永远做不出来"。
 */
function isMissingTableError(err) {
  const msg = String((err && err.message) || err || '')
    .toLowerCase()
    .replace(/[\s_-]/g, ''); // 去掉空格与连字符，这样 craftingTable / crafting_table / crafting table 都能命中
  return (
    msg.includes('craftingtable') ||
    msg.includes('requirestable') ||
    msg.includes('missingtable') ||
    msg.includes('needatable') ||
    msg.includes('requiresatable')
  );
}

/** 已知可以在随身 2×2 合成栏完成的配方（只用于排序，不影响正确性） */
const CRAFTABLE_IN_2X2 = new Set([
  'stick', 'torch', 'crafting_table',
  'oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks',
  'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'crimson_planks', 'warped_planks',
  'pale_oak_planks', 'bamboo_planks',
  'wooden_pickaxe', 'wooden_axe', 'wooden_shovel', 'wooden_hoe', 'wooden_sword',
  'stone_pickaxe', 'stone_axe', 'stone_shovel', 'stone_hoe', 'stone_sword',
  'iron_pickaxe', 'iron_axe', 'iron_shovel', 'iron_hoe', 'iron_sword',
  'golden_pickaxe', 'golden_axe', 'golden_shovel', 'golden_hoe', 'golden_sword',
  'diamond_pickaxe', 'diamond_axe', 'diamond_shovel', 'diamond_hoe', 'diamond_sword',
  'netherite_pickaxe', 'netherite_axe', 'netherite_shovel', 'netherite_hoe', 'netherite_sword',
]);

/** 只用于给配方排序：确定随身可做的排在前面 */
function definitelyNeedsTable(recipe, itemName = null) {
  const name = String(itemName || '').replace(/^minecraft:/, '');
  if (CRAFTABLE_IN_2X2.has(name)) return false;
  // 其余一律先按"可能随身可做"试一次，由运行时决定要不要工作台
  return false;
}

/** 熔炼产物映射：原料名 → 产物名 */
function guessSmeltOutput(input) {
  const n = String(input).replace(/^minecraft:/, '');
  const map = {
    raw_iron: 'iron_ingot',
    raw_gold: 'gold_ingot',
    raw_copper: 'copper_ingot',
    iron_ore: 'iron_ingot',
    gold_ore: 'gold_ingot',
    copper_ore: 'copper_ingot',
    deepslate_iron_ore: 'iron_ingot',
    deepslate_gold_ore: 'gold_ingot',
    deepslate_copper_ore: 'copper_ingot',
    sand: 'glass',
    red_sand: 'glass',
    cobblestone: 'stone',
    stone: 'smooth_stone',
    clay_ball: 'brick',
    clay: 'terracotta',
    porkchop: 'cooked_porkchop',
    beef: 'cooked_beef',
    chicken: 'cooked_chicken',
    mutton: 'cooked_mutton',
    rabbit: 'cooked_rabbit',
    cod: 'cooked_cod',
    salmon: 'cooked_salmon',
    potato: 'baked_potato',
    kelp: 'dried_kelp',
    oak_log: 'charcoal',
    birch_log: 'charcoal',
    spruce_log: 'charcoal',
    jungle_log: 'charcoal',
    acacia_log: 'charcoal',
    dark_oak_log: 'charcoal',
    netherrack: 'nether_brick',
    ancient_debris: 'netherite_scrap',
  };
  return map[n] || `${n}_smelted`;
}

/** 背包差分：{item: deltaCount}，只保留变化项 */
function diffInventory(before, after) {
  const out = {};
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    const d = (after[k] || 0) - (before[k] || 0);
    if (d !== 0) out[k] = d;
  }
  return out;
}

/** 背包物品总数：用来判断"这一轮有没有真的捡到东西" */
function sumCounts(map) {
  let total = 0;
  for (const v of Object.values(map || {})) total += v;
  return total;
}

/**
 * 构造 Vec3 后调用 blockAt。
 * 直接传 {x,y,z} 会抛 "pos.floored is not a function"（mineflayer 内部用 Vec3 方法），
 * 所以方块查询统一走这里。
 */
function blockAt(bot, x, y, z) {
  try {
    return bot.blockAt(vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
  } catch (err) {
    log.debug(`blockAt(${x},${y},${z}) 失败：${err.message}`);
    return null;
  }
}

module.exports = {
  Actions,
  ActionError,
  MissingItemError,
  NoToolError,
  ProtectedBlockError,
  diffInventory,
  guessSmeltOutput,
  toolKind,
  armorKind,
  isPlaceable,
  isMissingTableError,
  CRAFTABLE_IN_2X2,
  REACH,
};
