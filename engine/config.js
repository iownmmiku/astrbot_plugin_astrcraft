'use strict';
/**
 * 引擎配置。来源优先级：构造函数入参 > 配置文件 > 默认值。
 * 插件侧通过 connect 的 params 传配置进来，引擎也可以自己读 config/bot.config.json
 * （方便脱离 AstrBot 单独调试引擎）。
 */

const fs = require('fs');
const path = require('path');
const log = require('./log');

const DEFAULTS = {
  // ---- 连接 ----
  host: '127.0.0.1',
  port: 25565,
  username: 'AstrBot',
  auth: 'offline', // offline | microsoft
  version: '1.20.1', // 显式指定，不用自动探测：探测失败会让 bot 卡在握手阶段
  // ---- 行为 ----
  /** 反作弊保守模式：移动更慢、寻路更保守、不自动跳 */
  slowMode: false,
  /** 允许自主层行动 */
  autoMode: true,
  /** 自动进食（独立于 LLM） */
  autoEat: true,
  /** 自动反击/撤退 */
  autoDefend: true,
  /** 自动捡起附近的掉落物（真人不会把挖到的东西留在地上） */
  autoCollectDrops: true,
  /** 太黑时自动插火把（真人夜里/进洞都会照明，顺带防怪贴脸刷） */
  autoTorch: true,
  /** 被方块卡住时自动挖开（挖矿把自己封在洞里时唯一的出路） */
  autoUnstuck: true,
  /**
   * 从高处坠落时放水/垫方块自救（MLG）。
   * 这是**最高优先级的本能**——它是唯一"错过一秒就必死"的情况：
   * 从 20 格掉下来落地就是 20 点伤害，满血也能摔死。
   */
  autoMlg: true,
  /**
   * **观战窗口**：在浏览器里以**她的第一视角**看她在干什么。
   *
   * 用的是 prismarine-viewer（PrismarineJS 官方项目）：它把 mineflayer 看到的
   * 世界用 three.js 渲染出来，`firstPerson: true` 时相机就在她眼睛的位置——
   * 相当于你站在她身后看她玩，**只能看，不能操作**。
   *
   * 为什么不做成"打开一个真的 Minecraft 窗口"：mineflayer 是**无头客户端**，
   * 它根本不下载游戏资源、也没有渲染器。要真的开一个 MC 窗口，只能你用自己的
   * Java 版客户端进服务器 `/spectate 她的名字`——那需要装 Java 版（这台机器上
   * 只有基岩版）。所以这里给的是**不需要第二个账号、不需要装游戏**的方案。
   *
   * 代价：渲染要占 CPU/内存（要额外解析和渲染区块），而且默认只监听本机。
   */
  enableViewer: false,
  /** 观战页面的端口（浏览器打开 http://127.0.0.1:<端口>） */
  viewerPort: 3007,
  /** 观战渲染多远（区块）。越大越吃性能 */
  viewerViewDistance: 6,
  /** 观战是否用第一视角（false = 从斜上方俯视她） */
  viewerFirstPerson: true,
  /**
   * 拟人化动作：渐进转头、走路轻微扫视、变速行走、偶尔停顿环顾、空闲时东张西望。
   * 只影响"看起来像不像人"，不改变任何决策与安全性；关掉则动作更机械但更快。
   */
  humanize: true,
  /** 血量低于该值触发撤退 */
  retreatHealth: 8,
  /** 饱食度低于该值触发进食 */
  eatFoodLevel: 14,
  /** 允许寻路时破坏方块（默认关：真玩家不会随手拆墙） */
  allowDigInPath: false,
  /** 允许寻路时放置方块搭桥 */
  allowPlaceInPath: false,
  /** 单次寻路的整体死线（毫秒）：允许走多久 */
  pathTimeoutMs: 30000,
  /**
   * 单次 A* 搜索的同步时间预算（毫秒）。
   *
   * **务必与 pathTimeoutMs 区分开**：pathTimeoutMs 是"允许走多久"，
   * 而这个是"一次路径搜索最多占住事件循环多久"。
   * 搜索期间 mineflayer-pathfinder 会把 Node 事件循环完全占住，
   * 引擎在这段时间里收不到也回不了任何 RPC——
   * 设太大会出现"她在干活时你问不到状态、也喊不停她"。
   * 实测误设成 30000 时，长任务运行中 `ping` 要等 25~27 秒才返回
   * （ping 本身是纯同步函数，不可能是它自己慢）。
   *
   * **为什么是 1800 而不是 4000**（与 movement.js 里那段实测注释同源）：
   * 真实服务器上量到过"事件循环被阻塞 9.3 秒"（86 次里 50 次超过 6 秒），
   * 而且其中 70 次发生在**当时空闲**——触发者不是技能任务，而是空闲期反复
   * 触发的自动捡东西/自动插火把这类反射。A* 是同步的，预算给多大就可能卡多久，
   * 所以压到 1.8 秒；远距离走不通本来就由分段寻路（_goToSegmented）兜底。
   *
   * **这里是唯一权威值**：movement.js 直接读它，不要再写
   * `Number(config.get('pathThinkTimeoutMs')) || 1800` 那种兜底——
   * DEFAULTS 永远提供值，`||` 右边的数字**永远不可达**，
   * 于是"改了 DEFAULTS 却以为兜底会生效"，就会出现
   * "注释说 1800、实际跑 4000"的漂移（这次就是这么漏的）。
   * 插件侧可用 path_think_timeout_ms 覆盖它。
   */
  pathThinkTimeoutMs: 1800,
  /** 单个技能最长执行时间（毫秒） */
  skillTimeoutMs: 300000,
  /**
   * 允许挖掘的方块白名单；空数组 = 不限制。命中受保护方块时直接拒绝，不重试。
   *
   * **这份默认值必须覆盖内置技能真正会挖的方块**，否则默认配置下技能必然失败：
   *   - mining.js 的 ORES 表（coal/iron/copper/gold/redstone/lapis/diamond/emerald/
   *     quartz/ancient_debris 及其 deepslate 变体）
   *   - mining.js 的 STONE_BLOCKS / STONE_VARIANTS（含 tuff）
   *   - wood.js 的 LOG_NAMES（含 mangrove/cherry/pale_oak 与下界菌柄）
   * 早期这里漏掉了**全部矿石**，于是"挖铁矿"在默认配置下 100% 被
   * actions.js 的 _assertNotProtected 拒绝，而报错又被技能层吞成
   * "附近没有找到iron"——模型完全看不出真正的原因。
   *
   * **这一份必须与 _conf_schema.json 的 dig_whitelist 默认值逐项一致**
   * （由 dev-tools/test_config_parity.py 守住）。
   */
  digWhitelist: [
    // 石头类（含石制工具的三种材料）
    'stone', 'cobblestone', 'deepslate', 'cobbled_deepslate',
    // 其它石质建材（mine_stone 第二阶段的 STONE_VARIANTS）
    'andesite', 'diorite', 'granite', 'tuff',
    // 软方块
    'dirt', 'grass_block', 'sand', 'gravel', 'clay',
    // 原木（wood.js 的 LOG_NAMES：主世界 6 种 + 新树种 3 种 + 下界菌柄 2 种）
    'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
    'mangrove_log', 'cherry_log', 'pale_oak_log', 'crimson_stem', 'warped_stem',
    // 树叶（gathering 的 collect apple 会挖橡木/深色橡木树叶）
    'oak_leaves', 'spruce_leaves', 'birch_leaves', 'dark_oak_leaves',
    'netherrack',
    // 矿石（mining.js 的 ORES 表；漏掉它们 = 默认配置下挖矿必然失败）
    'coal_ore', 'deepslate_coal_ore',
    'iron_ore', 'deepslate_iron_ore',
    'copper_ore', 'deepslate_copper_ore',
    'gold_ore', 'deepslate_gold_ore', 'nether_gold_ore',
    'redstone_ore', 'deepslate_redstone_ore',
    'lapis_ore', 'deepslate_lapis_ore',
    'diamond_ore', 'deepslate_diamond_ore',
    'emerald_ore', 'deepslate_emerald_ore',
    'nether_quartz_ore',
    'ancient_debris',
  ],
  /** 禁止挖掘的方块（领地/主城保护场景） */
  digBlacklist: ['bedrock', 'barrier', 'command_block', 'chain_command_block', 'repeating_command_block'],
  /**
   * 出生点保护半径内不进行破坏性动作。
   *
   * **必须与 _conf_schema.json 的 spawn_protection_radius 一致（16）**：
   * 早期引擎侧是 0、插件侧是 16，于是"单独跑引擎调试"和"通过插件跑"
   * 的保护行为完全不同——同一份配置在两条路径下语义不一致。
   */
  spawnProtectionRadius: 16,
  /** 允许自动穿戴护甲 */
  autoEquipArmor: true,
  /** 附近有多少敌对实体时触发撤退 */
  threatsToRetreat: 2,
  /**
   * keep-alive 超时容忍（毫秒）。mineflayer 默认 30 秒，
   * 但它的计时器只在收到服务端 keep_alive 时重置——服务端忙于生成区块时
   * 会长时间不发包，导致误判断线。放宽到 180 秒。
   */
  keepAliveTimeoutMs: 180000,
  /** 进服后先静置多久再开始做事（等服务器把区块发完、TPS 稳定） */
  settleDelayMs: 1200,
};

/** 数据驱动的"敌对实体"判断：mineflayer 的 entity.kind 在部分版本上不准 */
const HOSTILE_NAMES = new Set([
  'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'creeper', 'spider', 'cave_spider',
  'witch', 'pillager', 'vindicator', 'evoker', 'ravager', 'vex', 'phantom', 'slime', 'magma_cube',
  'blaze', 'ghast', 'piglin', 'piglin_brute', 'hoglin', 'zoglin', 'zombified_piglin', 'enderman',
  'endermite', 'silverfish', 'guardian', 'elder_guardian', 'shulker', 'warden', 'wither',
  'wither_skeleton', 'zombie_villager', 'illusioner', 'breeze',
]);

function isHostileName(name) {
  if (!name) return false;
  const n = String(name).replace(/^minecraft:/, '');
  if (HOSTILE_NAMES.has(n)) return true;
  // 兼容 "zombie" / "Zombie" / 带变体后缀的情况
  const base = n.split('_')[0];
  return HOSTILE_NAMES.has(base);
}

class Config {
  constructor(overrides = {}, { configPath = null } = {}) {
    let fromFile = {};
    const file = configPath || process.env.MC_ENGINE_CONFIG || path.join(__dirname, '..', 'config', 'bot.config.json');
    if (fs.existsSync(file)) {
      try {
        fromFile = JSON.parse(fs.readFileSync(file, 'utf8'));
        log.debug(`已读取引擎配置：${file}`);
      } catch (err) {
        log.warn(`配置文件解析失败，已忽略：${file}（${err.message}）`);
      }
    }
    this._values = { ...DEFAULTS, ...stripMeta(fromFile), ...stripMeta(overrides) };

    // 校验：这里出错要早失败，不要等进服才炸
    if (!['offline', 'microsoft'].includes(this._values.auth)) {
      throw new Error(`config.auth 只能是 offline 或 microsoft，当前为 ${this._values.auth}`);
    }
    const p = Number(this._values.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      throw new Error(`config.port 非法：${this._values.port}`);
    }
    if (!this._values.username || String(this._values.username).length > 16) {
      throw new Error('config.username 必须为 1–16 个字符（Minecraft 用户名限制）');
    }
    log.addSecret(this._values.username);
    log.addSecret(`${this._values.host}:${this._values.port}`);
  }

  get(key) {
    return this._values[key];
  }

  all() {
    return { ...this._values };
  }

  /** 引擎运行期间热更新（插件改配置后不用重启引擎） */
  update(overrides = {}) {
    Object.assign(this._values, stripMeta(overrides));
    return this.all();
  }

  /** mineflayer createBot 的选项 */
  toBotOptions() {
    const v = this._values;
    const opts = {
      host: v.host,
      port: Number(v.port),
      username: v.username,
      auth: v.auth === 'microsoft' ? 'microsoft' : 'offline',
      version: v.version || undefined,
      // 这两个能显著减少无谓的带宽与内存占用
      viewDistance: 'normal',
      hideErrors: true,
      // 1.19+ 聊天签名；离线服必须关掉，否则会被踢
      chat: 'enabled',
      brand: 'vanilla',
      // 物理 tick 由 prismarine-physics 驱动，默认即可
      physicsEnabled: true,
    };
    if (v.auth === 'microsoft') {
      opts.profilesFolder = v.profilesFolder || path.join(__dirname, '..', 'config', 'auth-cache');
      if (v.microsoftEmail) opts.username = v.microsoftEmail;
    }

    // keep-alive 超时容忍：minecraft-protocol 的机制是"收到服务端 keep_alive 后开始计时"，
    // 而这个计时器**只在收到下一个 keep_alive 时才重置**——服务端因为生成区块
    // 把主线程占住、长时间不发包时，无论我们这边多活跃都会超时断线。
    // 实测本地回环 + 超平坦世界反复移动时会触发（服务端也记成 Timed out）。
    // 放宽到 180 秒，配合 bot.js 里的主动心跳（保证服务端那边不超时），
    // 两边就都不会误断了。
    opts.checkTimeoutInterval = Number(v.keepAliveTimeoutMs) || 180000;

    return opts;
  }

  /** 派生出的运行时参数 */
  derived() {
    const v = this._values;
    const basePathTimeout = Number(v.pathTimeoutMs) || 30000;
    return {
      pathTimeoutMs: v.slowMode ? Math.round(basePathTimeout * 1.5) : basePathTimeout,
      moveSpeedMultiplier: v.slowMode ? 0.6 : 1.0,
      hostileNames: HOSTILE_NAMES,
    };
  }
}

/** 允许配置里带 _comment 之类的元字段，不参与合并 */
function stripMeta(obj) {
  const out = {};
  for (const [k, val] of Object.entries(obj || {})) {
    if (k.startsWith('_')) continue;
    out[k] = val;
  }
  return out;
}

module.exports = { Config, DEFAULTS, HOSTILE_NAMES, isHostileName };
