'use strict';
/**
 * Minecraft 引擎主体：把 mineflayer、寻路、动作、技能、状态跟踪装配到一起。
 *
 * 进程边界说明：
 *   bot.js 只负责"游戏里发生了什么"和"我要做什么"，
 *   与 AstrBot 的所有交互都通过 index.js 的 RPC 出口，这里不 import 任何插件侧代码。
 */

const mineflayer = require('mineflayer');
const path = require('path');
const log = require('./log');
const { StationMemory } = require('./stations');
const { Config, isHostileName } = require('./config');
const { StateTracker } = require('./state');
const { Navigator } = require('./movement');
const { Actions } = require('./actions');
const { TaskQueue, PRIORITY } = require('./goals');
const skills = require('./skills');
const { delay, distance, fmtVec, describeFailure, CancelledError, vec3 } = require('./util');
const { idleLookAround } = require('./humanize');
const { GameError, NotConnectedError } = require('./rpc');

class McEngine {
  /**
   * @param {object} o
   * @param {(event:string, data:object)=>void} o.emit 事件出口
   */
  constructor({ emit }) {
    this._emit = emit;
    this.config = new Config();
    this.bot = null;
    this.nav = null;
    this.actions = null;
    this.state = new StateTracker({ emit });
    this.queue = new TaskQueue({
      onTaskFinished: (task) => this._onTaskFinished(task),
      onTaskStarted: (task) => {
        this.state.setCurrentTaskText(`${task.name}${task._detail() ? `（${task._detail()}）` : ''}`);
      },
    });
    this._reflexTimer = null;
    this._stateTimer = null;
    this._connecting = null;
    // 自动重连：只要不是手动断开，就持续尝试重连（封顶 30 秒间隔），永不彻底放弃。
    // 早期版本 max: 5，导致服务端重启或起得慢时，试 5 次后彻底罢工、变成永久离线。
    this._reconnect = { attempts: 0, max: Infinity, timer: null, enabled: true };
    this._chatTimes = [];
    this._autoDefendCooldown = 0;
    this._lastCollectAt = 0;
    this._lastTorchAt = 0;
    // 拟人化：空闲环顾的节流与"正在进行"标记
    this._nextGlanceAt = 0;
    this._glancing = false;
    // 被方块卡住的自救节流
    this._lastUnstuckAt = 0;
    // **注意到的玩家**：名字 → {greetedAt, near}（主动社交的冷却用）
    this._seenPlayers = new Map();
    // MLG（落地水/垫方块）的节流
    this._lastMlgAt = 0;
    this._mlgRunning = false;
    // 疑似卡住的"待确认"状态 + 静止检测（必须真的动不了才算卡住）
    this._unstuckPending = null;
    this._unstuckLastPos = null;
    this._unstuckStillSince = 0;
    // "被困且无工具"的求助节流（避免刷屏）
    this._lastHelpAt = 0;
    this._lastRetreatAt = 0;
    this._lastDamager = null;
    this._manualDisconnect = false;
    this.started = false;
  }

  // ================================================================ 连接

  async connect(params = {}) {
    if (params && Object.keys(params).length) {
      this.config.update(params);
    }
    if (this._connecting) return this._connecting;
    this._connecting = this._doConnect().finally(() => {
      this._connecting = null;
    });
    return this._connecting;
  }

  async _doConnect() {
    if (this.bot) {
      log.info('已存在连接，先断开旧连接');
      await this.disconnect({ silent: true });
    }
    this._manualDisconnect = false;
    const opts = this.config.toBotOptions();
    log.info(`正在连接 ${this.config.get('host')}:${this.config.get('port')}，用户名 ${this.config.get('username')}，版本 ${this.config.get('version')}`);

    return new Promise((resolve, reject) => {
      let settled = false;
      let bot;
      try {
        bot = mineflayer.createBot(opts);
      } catch (err) {
        return reject(new GameError(`创建客户端失败：${err.message}`));
      }
      this.bot = bot;

      const onSpawn = async () => {
        if (settled) return;
        settled = true;
        clearTimeout(loginTimer);
        try {
          await this._onSpawn(bot);
          resolve({ ok: true, username: bot.username, version: bot.version });
        } catch (err) {
          reject(err);
        }
      };

      const onError = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(loginTimer);
        reject(new GameError(`进服失败：${describeFailure(err)}`));
      };

      const onKicked = (reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(loginTimer);
        const text = typeof reason === 'string' ? reason : reason && reason.toString ? reason.toString() : JSON.stringify(reason);
        reject(
          new GameError(
            `被服务器拒绝进入：${text}。` +
              `常见原因：服务器开启了正版验证（需要 online-mode=false）、用户名被占用、或触发了白名单/封禁`,
          ),
        );
      };

      const onEnd = (reason) => {
        if (settled) {
          this._onDisconnect(reason);
          return;
        }
        settled = true;
        clearTimeout(loginTimer);
        reject(new GameError(`连接在登录阶段就断开了：${reason}`));
      };

      const loginTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          bot.quit('登录超时');
        } catch {
          /* ignore */
        }
        reject(new GameError('进服超时（30 秒）——检查服务器地址、端口与版本是否匹配'));
      }, 30000);

      bot.once('spawn', onSpawn);
      bot.once('error', onError);
      bot.once('kicked', onKicked);
      bot.once('end', onEnd);
    });
  }

  async _onSpawn(bot) {
    // mineflayer-pathfinder 导出的是 { pathfinder, Movements, goals }：
    // 插件函数是 `.pathfinder`，要交给 loadPlugin 注入，不能直接调用。
    const pf = require('mineflayer-pathfinder');
    const pluginFn = pf.pathfinder || pf.plugin;
    if (typeof pluginFn !== 'function') {
      throw new GameError('mineflayer-pathfinder 导出结构不符（找不到插件函数），请检查依赖版本');
    }
    bot.loadPlugin(pluginFn);
    // loadPlugin 是同步注入的，但 pathfinder 对象在下一 tick 才完全就绪
    if (!bot.pathfinder) {
      await delay(300);
    }
    if (!bot.pathfinder) {
      throw new GameError('寻路插件注入失败：bot.pathfinder 为空');
    }

    // 不阻塞 spawn：区块加载可能要十几秒，而 pathfinder 自己会处理未加载区域。
    // 进服该立刻可用，等区块放到后台做。
    this._chunksReady = false;
    this._chunksPromise = this._waitForLocalChunks(bot);
    this.nav = new Navigator(bot, this.config);
    this.actions = new Actions({ bot, config: this.config, navigator: this.nav });
    // 工作站记忆：记住用过的箱子/熔炉/工作台在哪，下次走回去用（而不是重做一个）。
    // 落盘路径由 MC_DATA_DIR 决定；没设就只在这个会话里有效。
    if (!this.stations) {
      const dataDir = process.env.MC_DATA_DIR || '';
      this.stations = new StationMemory({
        file: dataDir ? path.join(dataDir, 'stations.json') : null,
      });
    }
    this.actions.stations = this.stations;
    // 把动作层交给导航层：卡住时它需要"挖开挡路的方块"来脱困
    // （真玩家被困在岩壁和断崖之间时就是朝岩壁挖进去）
    if (typeof this.nav.attachActions === 'function') this.nav.attachActions(this.actions);
    this.state.attach(bot);
    this._wireBotEvents(bot);
    this._startLoops();
    // 观战窗口（浏览器里以她的第一视角看她在干什么）
    if (this.config.get('enableViewer')) {
      this.startViewer().catch((err) => log.warn(`观战窗口启动失败：${err.message}`));
    }
    this._reconnect.attempts = 0;

    log.info(`已进入服务器：${bot.username} @ ${bot.version}`);
    this._emit('bot.spawn', {
      username: bot.username,
      version: bot.version,
      position: { x: Number(bot.entity.position.x.toFixed(1)), y: Number(bot.entity.position.y.toFixed(1)), z: Number(bot.entity.position.z.toFixed(1)) },
      gamemode: bot.game ? bot.game.gameMode : null,
    });

    // 落地后先静置一会儿：服务器在玩家进服时会集中发送区块，
    // 立刻开始寻路/挖掘容易撞上这一刻的卡顿（表现为动作超时或掉线）。
    await delay(Number(this.config.get('settleDelayMs')) || 1200);

    // 落地后自动穿护甲（如果有）并吃一口（如果饿）
    try {
      if (this.config.get('autoEquipArmor')) await this.actions.autoEquipArmor();
    } catch (err) {
      log.debug(`自动穿戴护甲失败：${err.message}`);
    }
  }

  /**
   * 等脚下的关键区块加载好。
   *
   * 不用 mineflayer 自带的 waitForChunksToLoad()：它要求 5x5=25 个区块全部就绪，
   * 只要有一个没到就 10 秒后整体 rejected——在带宽受限或服务端 view-distance 较小时
   * 几乎必然超时，等于每次进服都白等 10 秒。
   * 这里只等"自己站的那一格所在的列"，这才是马上要用到的地形。
   */
  async _waitForLocalChunks(bot) {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (!bot.entity || !bot.world) break;
      try {
        const pos = bot.entity.position;
        const col = bot.world.getColumnAt(vec3(Math.floor(pos.x), 0, Math.floor(pos.z)));
        if (col) {
          // 再确认脚下的方块真的读得到（列在但方块为空的边界情况）
          const below = bot.blockAt(vec3(Math.floor(pos.x), Math.floor(pos.y) - 1, Math.floor(pos.z)));
          if (below) {
            this._chunksReady = true;
            log.debug(`脚下区块已就绪（${below.name}）`);
            return true;
          }
        }
      } catch (err) {
        log.debug(`检查区块时出错：${err.message}`);
      }
      await delay(300);
    }
    log.warn('等待脚下区块加载超时（12 秒），仍继续执行；地形读取可能不完整');
    return false;
  }

  /** 工具方法：需要地形时先确保区块就绪 */
  async ensureChunks({ timeoutMs = 8000 } = {}) {
    if (this._chunksReady) return true;
    if (!this._chunksPromise) return false;
    try {
      await Promise.race([
        this._chunksPromise,
        delay(timeoutMs).then(() => false),
      ]);
    } catch {
      /* ignore */
    }
    return !!this._chunksReady;
  }

  /**
   * **观战窗口**：在浏览器里以她的第一视角看她在干什么。
   *
   * 用 prismarine-viewer：它把 mineflayer 看到的世界用 three.js 渲染，
   * `firstPerson` 时相机就在她眼睛的位置。**只能看，不能操作**——
   * 你看到的就是她看到的东西，和你站在她身后一样。
   *
   * 为什么不是"真的开一个 Minecraft 窗口"：mineflayer 是**无头客户端**，
   * 不下载游戏资源也没有渲染器。真要开 MC 窗口只能用你自己的 Java 版客户端
   * 进服务器 `/spectate 她的名字`（需要装 Java 版）。
   * 这里给的是不需要第二个账号、不需要装游戏的方案。
   *
   * 懒加载：不开就不 require，省内存（这个库会拖进 express/socket.io/three）。
   */
  async startViewer() {
    const bot = this.bot;
    if (!bot || !bot.entity) throw new Error('她还没进游戏，等进服后再开观战');
    if (this._viewer) return this.viewerInfo();
    // 懒加载：不用观战的人不该为此付出内存（这个库会拖进 express/socket.io/three/canvas）
    const { startViewerServer } = require('./viewer');
    const port = Number(this.config.get('viewerPort')) || 3007;
    const firstPerson = this.config.get('viewerFirstPerson') !== false;
    const viewDistance = Math.max(2, Math.min(12, Number(this.config.get('viewerViewDistance')) || 6));
    const srv = startViewerServer(bot, { port, firstPerson, viewDistance });
    // 等它真的监听上再算成功——端口被占用时这里会抛出可读的错误，
    // 而不是"看起来开了、其实请求被旧服务接走"
    await srv.listening;
    this._viewer = { port, firstPerson, viewDistance, startedAt: Date.now(), srv };
    log.warn(
      `观战窗口已开启：浏览器打开 http://127.0.0.1:${port} —— 她的第一视角 + 玩家 HUD` +
        `（血量/饱食/快捷栏，按 E 看背包）｜${firstPerson ? '第一视角' : '俯视'}，渲染 ${viewDistance} 区块`,
    );
    this._emit('viewer.started', this.viewerInfo());
    return this.viewerInfo();
  }

  viewerInfo() {
    if (!this._viewer) return { running: false };
    return {
      running: true,
      url: `http://127.0.0.1:${this._viewer.port}`,
      first_person: this._viewer.firstPerson,
      view_distance: this._viewer.viewDistance,
      uptime_seconds: Math.round((Date.now() - this._viewer.startedAt) / 1000),
      hud: '血量/饱食/快捷栏 + 按 E 看背包',
    };
  }

  /**
   * 关掉观战窗口。
   *
   * **这里纠正我早先的一个错误说法**：我一度说"prismarine-viewer 没有关闭接口，
   * 关不掉"。那是错的——它的入口其实挂过 `bot.viewer.close`（内部 `http.close()`
   * + 断开所有 socket），只是我当时没看到。
   * 现在用的是我们自己的 viewer.js，`close()` 会真的关掉 HTTP 服务，
   * 端口立刻释放，可以再次 start。
   */
  stopViewer() {
    if (!this._viewer) return { ok: true, note: '本来就没开' };
    try {
      this._viewer.srv.close();
    } catch (err) {
      return { ok: false, note: `关闭时报错：${err.message}` };
    }
    const port = this._viewer.port;
    this._viewer = null;
    log.warn(`观战窗口已关闭（端口 ${port} 已释放）`);
    return { ok: true, note: `观战窗口已关闭（端口 ${port} 已释放，可以再开）` };
  }

  /**
   * 接收她的**真实心情**，接到动作上（情绪表达）。
   *
   * 原来"悠闲/精神"是引擎里的随机数，跟她此刻想干什么毫无关系。
   * 现在插件会把动机水位推下来，走路节奏就跟着心情变：
   * 悠闲欲高就走得慢、常停；着急（血量低、天要黑）就爱跑。
   */
  setMood(mood) {
    this._mood = mood || null;
    try {
      if (this.nav && this.nav._gait && typeof this.nav._gait.setMood === 'function') {
        this.nav._gait.setMood(mood);
      }
    } catch (err) {
      log.debug(`设置心情失败（不影响其它功能）：${err.message}`);
    }
  }

  /** 当前心情（诊断视图用） */
  get mood() {
    return this._mood || null;
  }

  /**
   * **注意到有人来了** —— 主动社交的前提。
   *
   * 她原来只会被动回应：别人先说话她才答。真人不这样——有人走进你的视野，
   * 你会抬头看一眼，熟人还会打个招呼。这里做的就是这件事：
   * 每隔一会儿看一眼附近有没有玩家，有就发一个 `player.nearby` 事件，
   * 由插件决定要不要说点什么（带着她的人格和当下的心情）。
   *
   * 每个玩家有**打招呼冷却**（默认 10 分钟），不然会变成"一见面就复读"。
   * 玩家走远了（超过 24 格）就把冷却清掉——下次再来还会打招呼。
   */
  _noticeNearbyPlayers() {
    const bot = this.bot;
    if (!bot || !bot.entity || !bot.players) return;
    const me = bot.entity.position;
    const now = Date.now();
    for (const [name, p] of Object.entries(bot.players)) {
      if (!p || !p.entity || name === bot.username) continue;
      const d = distance(me, p.entity.position);
      const state = this._seenPlayers.get(name) || { greetedAt: 0, near: false };
      if (d <= 16) {
        if (!state.near) {
          state.near = true;
          // 刚进入视野：如果超过冷却没打过招呼，就提醒一次
          if (now - state.greetedAt > 600000) {
            state.greetedAt = now;
            this.state.note(`${name} 过来了（${d.toFixed(0)} 格）`);
            this._emit('player.nearby', {
              player: name,
              distance: Number(d.toFixed(1)),
              position: {
                x: Number(p.entity.position.x.toFixed(1)),
                y: Number(p.entity.position.y.toFixed(1)),
                z: Number(p.entity.position.z.toFixed(1)),
              },
            });
          }
        }
      } else if (d > 24) {
        state.near = false; // 走远了：下次再来重新算
      }
      this._seenPlayers.set(name, state);
    }
  }

  _wireBotEvents(bot) {
    bot.on('chat', (username, message) => {
      if (username === bot.username) return;
      this.state.note(`${username} 说：${message}`);
      this._emit('chat', {
        sender: username,
        message,
        position: bot.players[username] && bot.players[username].entity
          ? {
              x: Number(bot.players[username].entity.position.x.toFixed(1)),
              y: Number(bot.players[username].entity.position.y.toFixed(1)),
              z: Number(bot.players[username].entity.position.z.toFixed(1)),
            }
          : null,
      });
    });

    // 私聊（1.19+ 由 whisper 事件给出）
    bot.on('whisper', (username, message) => {
      this.state.note(`${username} 悄悄说：${message}`);
      this._emit('chat.whisper', { sender: username, message });
    });

    bot.on('messagestr', (message, position, sender, verified, jsonMsg) => {
      const text = String(message || '').trim();
      if (!text) return;
      // 只把服务器系统的关键提示转给插件（死亡、被踢、传送等），避免刷屏
      if (/你死了|You died|被.*杀|已被踢出|joined the game|left the game|加入了游戏|离开了游戏/.test(text)) {
        this.state.note(`[系统] ${text}`);
        this._emit('chat.system', { message: text });
      }
    });

    bot.on('death', () => {
      log.info('机器人死亡');
      this.state.note('机器人死了，自动重生');
      this._emit('bot.death', { position: this._pos() });
      // 立刻清掉当前任务：死了还继续挖没有意义
      this.queue.cancelAll({ reason: '死亡' });
    });

    bot.on('respawn', () => {
      log.info('已重生');
      this.state.note('已重生');
      this._emit('bot.respawn', { position: this._pos() });
      if (this.actions) {
        this.actions.autoEquipArmor().catch(() => {});
      }
    });

    bot.on('health', () => {
      // 具体差分由 state.tick 处理，这里只做反射层的即时反应
      this._lastHealthSeen = bot.health;
    });

    bot.on('entityHurt', (entity) => {
      if (entity === bot.entity) {
        this._emit('bot.hurt', { health: bot.health, position: this._pos() });
      }
    });

    // 记录"谁打了我"，用于自动反击
    bot.on('entitySwingArm', () => {});
    bot.on('itemDrop', () => {});

    bot.on('kicked', (reason) => {
      const text = typeof reason === 'string' ? reason : JSON.stringify(reason);
      log.warn(`被服务器踢出：${text}`);
      this.state.note(`被服务器踢出：${text}`);
      this._emit('bot.kicked', { reason: text });
    });

    bot.on('error', (err) => {
      log.warn(`客户端错误：${err.message}`);
      this._emit('bot.error', { message: err.message });
    });

    bot.on('end', (reason) => {
      this._onDisconnect(reason);
    });
  }

  _onDisconnect(reason) {
    const wasManual = this._manualDisconnect;
    log.warn(`连接断开：${reason}${wasManual ? '（主动断开）' : ''}`);
    this._stopLoops();
    this.state.detach();
    this.queue.cancelAll({ reason: '连接断开' });
    this._emit('bot.disconnect', { reason: String(reason), manual: wasManual });
    this.bot = null;
    this.nav = null;
    this.actions = null;

    if (!wasManual && this._reconnect.enabled) {
      const attempt = this._reconnect.attempts + 1;
      const wait = Math.min(30000, 3000 * 2 ** Math.min(attempt - 1, 5)); // 指数退避，封顶 30 秒
      log.info(`${wait / 1000} 秒后尝试第 ${attempt} 次重连`);
      this._emit('bot.reconnecting', { attempt, max: this._reconnect.max, wait_ms: wait });
      this._reconnect.timer = setTimeout(() => {
        this._reconnect.attempts = attempt;
        this.connect().catch((err) => log.warn(`第 ${attempt} 次重连失败：${err.message}`));
      }, wait);
    }
  }

  async disconnect({ silent = false } = {}) {
    this._manualDisconnect = true;
    if (this._reconnect.timer) {
      clearTimeout(this._reconnect.timer);
      this._reconnect.timer = null;
    }
    this._stopLoops();
    const bot = this.bot;
    if (!bot) {
      if (!silent) return { ok: true, note: '本来就没连接' };
      return { ok: true };
    }
    return new Promise((resolve) => {
      const done = () => resolve({ ok: true });
      try {
        bot.once('end', done);
        bot.quit('AstrBot 主动断开');
        setTimeout(done, 3000);
      } catch (err) {
        done();
      }
    });
  }

  // ================================================================ 循环

  _startLoops() {
    if (this._reflexTimer) return;
    // 反射层：1 秒一次，纯本地规则，不经过 LLM
    this._reflexTimer = setInterval(() => {
      this._reflexTick().catch((err) => log.debug(`反射层异常：${err.message}`));
    }, 1000);
    // **MLG 单独用更快的频率（100ms）**。
    //
    // 为什么不能挂在上面那个 1 秒的反射循环里：实测从 18 格掉下来只有 **1.2 秒**，
    // 也就是只有 1 次机会——时机稍微不对（比如刚传送完速度还是 0）就完全错过，
    // 结果她摔到只剩 10.8 血。这是唯一"错过一秒就必死"的情况，值得单独快查。
    // 代价可以忽略：这里只做"在下坠吗"这一个判断，真正查方块只在快落地时才做。
    this._mlgTimer = setInterval(() => {
      this._mlgTick().catch((err) => log.debug(`MLG 检查异常：${err.message}`));
      // 正在下坠时额外加速：下坠 23 格/秒，100ms 只够看 2.3 格，
      // 而"落地前 7 格"这个动作窗口需要更密的采样才抓得住。
      // 只在真正下坠时多跑几次，平时没有额外开销。
      if (this._lastAirVy !== null && this._lastAirVy !== undefined && this._lastAirVy > 3) {
        for (let i = 0; i < 2; i += 1) {
          setTimeout(() => {
            this._mlgTick().catch(() => {});
          }, 33 * (i + 1));
        }
      }
    }, 100);
    // 状态差分：2 秒一次
    this._stateTimer = setInterval(() => {
      try {
        this.state.tick();
      } catch (err) {
        log.debug(`状态轮询异常：${err.message}`);
      }
      // 顺手看一眼有没有人过来（主动社交的前提）
      try {
        this._noticeNearbyPlayers();
      } catch (err) {
        log.debug(`玩家接近检测异常：${err.message}`);
      }
    }, 2000);
    // 主动心跳：见 _keepAliveTick 的说明。这是防止"服务器生成区块时判定失联"的关键。
    // MC_KEEPALIVE_MS=0 可关闭——保留这个开关是为了做对照实验：
    // 排查"合成偶发产出为空"时，需要能排除"心跳插包扰动窗口事务"这种可能。
    const keepAliveMs = Number(process.env.MC_KEEPALIVE_MS ?? 10000);
    // 事件循环延迟监控。
    //
    // 为什么需要：Node 是单线程的，任何同步耗时操作都会让引擎"短暂失联"——
    // RPC 收不到也回不了，表现成"她在干活时问不到状态、急停也没反应"。
    // 实测出现过 25 秒级别的阻塞，但光看现象无法定位是谁卡住了。
    // 这个定时器测量自己的触发延迟，一旦超过阈值就把"当前正在跑的任务"一起记下来，
    // 于是阻塞源直接暴露在日志里，不用再靠猜。
    this._lastLagCheck = Date.now();
    this._lagTimer = setInterval(() => {
      const now = Date.now();
      const drift = now - this._lastLagCheck - 250;
      this._lastLagCheck = now;
      if (drift > 1500) {
        const cur = this.queue.current;
        // 存下来给诊断视图用：光打日志的话，"她为什么卡"每次都要靠翻日志猜
        this._lastLagWarn = {
          at: now,
          seconds: Number((drift / 1000).toFixed(1)),
          what: cur ? `在跑：${cur.name}` : '空闲',
        };
        log.warn(
          `事件循环被阻塞约 ${(drift / 1000).toFixed(1)} 秒` +
            (cur ? `（当时在跑：${cur.name}）` : '（当时空闲）') +
            '—— 期间引擎无法响应任何 RPC',
        );
      }
    }, 250);
    if (keepAliveMs > 0) {
      this._keepAliveTimer = setInterval(() => {
        try {
          this._keepAliveTick();
        } catch (err) {
          log.debug(`心跳发送失败：${err.message}`);
        }
      }, keepAliveMs);
    } else {
      log.warn('主动心跳已关闭（MC_KEEPALIVE_MS=0）：长时间静置可能被服务端判定失联');
      this._keepAliveTimer = null;
    }
  }

  /**
   * 主动向服务器发包，告诉它"我还活着"。
   *
   * 为什么必须有：minecraft-protocol 的 keep-alive 是**被动**的——只在收到服务端
   * keep_alive 后启动一个定时器，超时就断开。而服务端在忙于生成区块（玩家每进入
   * 一片新区域就要生成一批）时主线程会被占住，keep_alive 发不出来。
   * 实测在超平坦世界反复移动时，服务端会连续 90 秒以上不发包，
   * 于是客户端超时断线，服务端也记录成 `lost connection: Timed out`——
   * 在 127.0.0.1 上这不可能是网络问题。
   *
   * 真玩家即使站着不动，客户端也在持续上报位置与视角。这里做同样的事。
   *
   * **两个反向教训，最后才收敛到现在的设计**：
   *
   * 1) 最初这里用 `bot.look(yaw, pitch, force=true)` 且"无条件发送"，理由是
   *    "熔炼要静默等 40 秒，不发包会被服务端判失联"。结果合成开始出现
   *    "随机产出为空"：因为 bot.look 会改动本地实体状态（yaw/pitch/onGround），
   *    插进容器窗口事务中间会扰动服务端的点击确认——1.17+ 服务端只在它认为
   *    客户端状态过期时才回应点击，被忽略的点击毫无回报，而 mineflayer 的合成
   *    完全依赖点击落点。实测：关掉心跳后 crafttest 5/5 全过，开着则间歇性失败。
   *
   * 2) 那"长时间静默会不会被踢"怎么办？**靠客户端超时**就够了：
   *    checkTimeoutInterval 已放宽到 180 秒（见 connect 参数），
   *    而且服务端自己的 keep_alive 往返由 minecraft-protocol 自动回应。
   *    实测：心跳完全关闭时，"挖矿→熔炼（静默 43 秒）→做工具"依然 13/13 全过。
   *
   * 所以现在的心跳只在**真正空闲**时发，用来做一层防御性保温；
   * 一旦有任务在跑（合成、熔炼、挖掘都会发自己的包），就让位给真实流量，
   * 绝不干扰窗口事务。包本身也换成不改本地状态的裸 look 包。
   */
  _keepAliveTick() {
    const bot = this.bot;
    if (!bot || !bot.entity || !bot._client) return;
    // 服务端未进入 play 态时不要发 play 包
    if (bot._client.state !== 'play') return;
    // 有任务在跑就完全让位：任务自身产生的包足够维持连接，
    // 而我们多发一个包反而可能踩进窗口事务里（见上面的教训 1）。
    if (this.queue.current || this.queue.pendingCount > 0) return;
    // 打开了容器（箱子/熔炉/工作台）时也不要插手
    if (bot.currentWindow) return;
    // 空闲时才做的"人味"动作：站着不动时东张西望。
    // 机器人一动不动盯着同一个方向是最容易被看穿的破绽之一。
    this._maybeIdleGlance();
    try {
      bot._client.write('look', {
        yaw: bot.entity.yaw,
        pitch: bot.entity.pitch,
        onGround: !!bot.entity.onGround,
      });
    } catch (err) {
      log.debug(`心跳失败：${err.message}`);
    }
  }

  /** 空闲时每隔几秒环顾一下（只在无任务、无窗口时调用，不会干扰任何事务） */
  _maybeIdleGlance() {
    if (!this.config.get('humanize', true)) return;
    if (this._glancing) return;
    const now = Date.now();
    if (now < this._nextGlanceAt) return;
    this._nextGlanceAt = now + 4000 + Math.random() * 5000;
    this._glancing = true;
    idleLookAround(this.bot, {})
      .catch(() => {})
      .finally(() => {
        this._glancing = false;
      });
  }

  _stopLoops() {
    if (this._reflexTimer) clearInterval(this._reflexTimer);
    if (this._stateTimer) clearInterval(this._stateTimer);
    if (this._keepAliveTimer) clearInterval(this._keepAliveTimer);
    this._reflexTimer = null;
    this._stateTimer = null;
    this._keepAliveTimer = null;
  }

  /**
   * 反射层：毫秒级威胁的即时反应，**不经过 LLM**。
   * 这一层决定了机器人"会不会自己找死"，是自主性的地板。
   */
  async _reflexTick() {
    const bot = this.bot;
    if (!bot || !bot.entity || !this.actions) return;
    if (this._currentReflexRunning) return;
    this._currentReflexRunning = true;
    try {
      // **"环境行为"只在完全没别的事时才做**（按「本能 vs 策略」的分层）。
      //
      // 机制该分成两类：
      //   - **本能**（逐 tick 竞价、随时可抢身体）：只有 MLG/换气/反击逃跑/进食/脱困
      //   - **策略**（没有 tick、不参与竞价）：挖矿换工具、食物过滤、索敌过滤
      //     ——它们是"任务执行中被咨询的纯函数"
      // 而"捡掉落物""插火把"属于第二类：它们**不该跟 LLM 的任务抢**。
      //
      // 我原来的实现把它们也做成了定时器反射，于是它们会在她干活的时候插进来，
      // 触发额外的寻路和移动——用户看到的"走来走去"有很大一部分来自这里。
      // 现在：**只有在完全没有任务时**才做这两件事。
      const idle = !this.queue.current;

      // MLG 不在这里做——它挂在 100ms 的专用循环上（见 _mlgTick）。
      // 原因：这个反射循环 1 秒才跑一次，而 18 格坠落只有 1.2 秒，
      // 挂在这里会**完全错过**（实测摔到只剩 10.8 血）。

      // 0) **被方块卡住**（自己所在格或头顶是实心）→ 立刻挖开。
      //
      // 这是实测最致命、也最隐蔽的一种困境：她挖矿时把自己封在洞里，
      // 脚下那层是通道、头顶那层却全是实心。此时：
      //   - 任何寻路都失败（日志里她连着一小时喊"路被堵死了走不过去"）
      //   - 所有需要走动的技能（做工具要走到工作台、砍树要走到树）全部失败
      //   - 她自己的脱困逻辑只在"寻路失败且目标 8 格内"时才触发，够不着这种场景
      // 结果就是她被困在地下、什么都做不成，而日志里只有"路被堵死了"。
      // 放在最前面（优先级同致命级）：被埋住比溺水更常见。
      if (this.config.get('autoUnstuck', true) && Date.now() - this._lastUnstuckAt > 8000) {        const stuckBlock = this._blockingSelf();
        // 判定条件：**有方块占着她身体所在的那一格（或头顶那一格）**。
        //
        // 这里刻意**不要求"她静止不动"**：实测完全被埋住时服务器会推动她，
        // 位置一直在微动，于是"静止 N 秒"这个门槛永远满足不了、她永远出不来。
        //
        // 那误报怎么办？靠**两级防护**，而不是靠门槛：
        //   1) 这个反射用 `normal` 级（不抢占）——误报只会让一个挖方块的小任务排队，
        //      **绝不会取消她正在跑的技能**（早期用 critical 时，
        //      误报把 mine_ores 取消了，engine_check / crafttest 跟着挂）
        //   2) 连续两次确认（相隔 2 秒）才算数，滤掉瞬时抖动
        // 代价是"真被困时可能要等手上任务先失败"，但那个任务本来也会很快失败
        // （日志里就是"路被堵死了"），之后挖困任务立刻执行。
        const now = Date.now();
        if (stuckBlock) {
          const key = `${stuckBlock.x},${stuckBlock.y},${stuckBlock.z}`;
          const confirmed = this._unstuckPending && this._unstuckPending.key === key;
          if (!confirmed) {
            this._unstuckPending = { key, at: now };
            log.debug(`疑似被 ${stuckBlock.name} 卡住，再确认一次`);
          } else if (now - this._unstuckPending.at >= 2000) {
            this._unstuckPending = null;
            // **连续失败就长时间退避。**
            // 实测最糟的情形：她被石头困住又没有镐，这个反射每 8 秒提交一次、
            // 每次立刻失败，日志里一分钟十几次——玩家看到的就是"她在乱挖"。
            // 失败 3 次就停 5 分钟，别再把日志和她的动作刷满。
            if (now < (this._unstuckGiveUpUntil || 0)) {
              return;
            }
            // **成功也算"挣扎"**：实测她在石头/泥土堆里会"挖开一格→挪一下→又被卡住"，
            // 每 8 秒循环一次、连着十几分钟，看起来就是一直在乱挖乱走。
            // 所以这里用"5 分钟内尝试次数"做闸门，而不是只看失败。
            this._unstuckTimes = (this._unstuckTimes || []).filter((t) => now - t <= 300000);
            if (this._unstuckTimes.length >= 5) {
              this._unstuckGiveUpUntil = now + 300000;
              this._unstuckTimes = [];
              log.warn('5 分钟内挖困自救 5 次仍未脱身，静默 5 分钟');
              try {
                bot.chat('……怎么挖都出不去，先不管了。');
              } catch {
                /* 聊天失败不致命 */
              }
              return;
            }
            this._unstuckTimes.push(now);
            this._lastUnstuckAt = now;
            const desc = `${stuckBlock.name}(${stuckBlock.x},${stuckBlock.y},${stuckBlock.z})`;
            log.warn(`确认被 ${desc} 卡住，挖开它`);
            this._submitReflex(
              '挖开卡住自己的方块',
              async ({ signal }) => {
                this.state.note(`被 ${desc} 卡住了，挖开它`);
                await this.actions.dig({
                  x: stuckBlock.x,
                  y: stuckBlock.y,
                  z: stuckBlock.z,
                  signal,
                  collect: true,
                });
              },
              'normal',
              {
                onFailed: () => {
                  this._unstuckFailures = (this._unstuckFailures || 0) + 1;
                  if (this._unstuckFailures >= 3) {
                    this._unstuckGiveUpUntil = Date.now() + 300000;
                    this._unstuckFailures = 0;
                    log.warn('挖困连续失败 3 次（多半是缺工具），5 分钟内不再尝试');
                    try {
                      bot.chat('……被困住了，手上又没有能挖的工具，先歇会儿。');
                    } catch {
                      /* 聊天失败不致命 */
                    }
                  }
                },
                onDone: () => {
                  this._unstuckFailures = 0;
                },
              },
            );
            return;
          }
        } else {
          this._unstuckPending = null;
        }
      }

      // 0.5) **被困住又挖不动**（头被堵、身上没有任何工具）→ 求助/认命。
      //
      // 实测的真实死锁：她挖矿把自己封在石头里，而背包是空的
      // （死了掉光 / 镐子用坏），石头徒手挖不动 → 自救任务每 8 秒失败一次、
      // 无限重试，她永远出不来，所有技能都做不成。
      // 真人这时会喊人帮忙，或者干脆认了重新开始。
      // 这里做两件事：在游戏里说一句求助，并把情况写进状态简报让 LLM 知道
      // （它可以决定"回出生点重新来过"这种策略）。
      if (this.config.get('autoUnstuck', true) && Date.now() - this._lastHelpAt > 60000) {
        const stuckBlock = this._blockingSelf();
        const hasTool = this.actions.inventoryMap && Object.keys(this.actions.inventoryMap()).length > 0;
        if (stuckBlock && !hasTool && this.bot.chat) {
          this._lastHelpAt = Date.now();
          const note = `我被卡在 (${stuckBlock.x}, ${stuckBlock.y}, ${stuckBlock.z}) 附近出不去，` +
            `挡住我的是 ${stuckBlock.name}，而我身上没有工具。`;
          this.state.note(note);
          log.warn(`被困且无工具：${note}`);
          try {
            this.bot.chat('……有人吗，我被埋住了，身上又没工具，出不去。');
          } catch {
            /* 聊天失败不致命 */
          }
        }
      }

      // 1) 溺水 → 上浮（致命：必须立刻抢占）
      if (bot.entity.isInWater && bot.entity.oxygenLevel !== undefined && bot.entity.oxygenLevel < 12) {
        this._submitReflex(
          '浮上水面换气',
          async ({ signal }) => {
            bot.setControlState('jump', true);
            await delay(1500, { signal });
            bot.setControlState('jump', false);
            await delay(600, { signal });
          },
          'critical',
        );
        return;
      }
      // 2) 岩浆 → 立刻逃（致命）
      if (bot.entity.isInLava) {        this._submitReflex(
          '从岩浆里逃出来',
          async ({ signal }) => {
            bot.setControlState('jump', true);
            bot.setControlState('forward', true);
            await delay(1200, { signal });
            bot.setControlState('jump', false);
            bot.setControlState('forward', false);
            this.state.note('刚从岩浆里爬出来，血量可能很低');
          },
          'critical',
        );
        return;
      }
      // 3) 着火 → 找水/撤离（致命）
      if (bot.entity.isOnFire || (bot.entity.fireTicks && bot.entity.fireTicks > 0)) {
        this._submitReflex(
          '身上着火了，赶紧处理',
          async ({ signal }) => {
            const water = this.state.findNearestBlock(['water'], { radius: 16 });
            if (water) {
              this.state.note('着火了，冲向附近的水');
              await this.nav.goTo({ x: water.x, y: water.y, z: water.z, range: 1, signal, timeoutMs: 12000 });
            } else {
              this.state.note('着火了，向反方向脱离火源');
              bot.setControlState('forward', true);
              await delay(2500, { signal });
              bot.setControlState('forward', false);
            }
          },
          'critical',
        );
        return;
      }
      // 3) 饿 → 吃
      if (this.config.get('autoEat') && bot.food < (Number(this.config.get('eatFoodLevel')) || 14)) {
        const food = this.actions._pickBestFood();
        if (food) {
          this._submitReflex(`吃 ${food.name}`, async ({ signal }) => {
            await this.actions.eat({ signal });
          });
          return;
        }
      }
      // 4) 血量过低 → 后撤（不硬拼）
      const lowHealth = Number(this.config.get('retreatHealth')) || 8;
      if (bot.health <= lowHealth) {
        // 只在"确实有威胁"时撤。早期版本无条件撤，导致残血被困时每 5 秒
        // 反复提交后撤任务、反复失败刷屏（日志里能看到连续 6 条一样的失败）。
        const threats = this.state.nearbyEntities({ radius: 12, limit: 4, hostileOnly: true });
        const canRetreatNow = Date.now() - this._lastRetreatAt > 20000;
        if (!threats.length || !canRetreatNow) {
          // 没威胁，或刚撤过：不动。让上层（吃/回血）来处理
        } else {
          this._lastRetreatAt = Date.now();
          this._submitReflex('血量过低，后撤', async ({ signal }) => {
            const me = bot.entity.position;
            const t = threats[0];
            const dx = me.x - t.position.x;
            const dz = me.z - t.position.z;
            const len = Math.hypot(dx, dz) || 1;
            const tx = me.x + (dx / len) * 14;
            const tz = me.z + (dz / len) * 14;
            this.state.note(`血量 ${bot.health}，从 ${t.name} 旁边撤退`);
            try {
              await this.nav.goTo({ x: tx, y: null, z: tz, range: 3, signal, timeoutMs: 15000 });
            } catch (err) {
              // 撤不动（被围住/地形复杂）不算异常，别让它在日志里刷错误堆
              log.debug(`后撤失败（可能被围住）：${err.message}`);
              this.state.note('想后撤但走不动，可能被围住了');
            }
          });
          return;
        }
      }
      // 5) 自动反击（可关）：被怪贴身打时还手
      if (this.config.get('autoDefend') && Date.now() - this._autoDefendCooldown > 15000) {
        // 半径从 4 放大到 6：实测 4 格太近，怪贴到脸上才开始还手，往往已经挨了两下。
        const threats = this.state.nearbyEntities({ radius: 6, limit: 1, hostileOnly: true });
        if (threats.length && bot.health > lowHealth + 4) {
          this._autoDefendCooldown = Date.now();
          const t = threats[0];
          // **贴身（3 格内）时用 critical，抢占当前任务。**
          // 普通反射只会排队——她正在挖矿时"排队等挖完再还手"等于站着挨打；
          // 真人这时会立刻放下手上的活。远一点用 normal，不打断她干活。
          const veryClose = t.distance <= 3;
          this._submitReflex(
            `反击 ${t.name}`,
            async ({ signal }) => {
              this.state.note(`被 ${t.name} 近身（${t.distance} 格），自动反击`);
              await this.actions.attack({ target: t.id, signal, maxAttacks: 12 });
            },
            veryClose ? 'critical' : 'normal',
          );
          return;
        }
      }

      // 6) 附近有掉落物 → 过去捡起来。
      // 真人不会把挖到的东西丢在地上不管；实测日志里反复出现
      // "够不到的掉落物 1 处"，也就是她挖完就走去干别的了，东西留在原地。
      // 优先级是 REFLEX（低于 USER/SKILL），所以只会排队、不会打断正在干的活。
      //
      // **半径和冷却都要收窄**：实测"事件循环被阻塞 6~9 秒"里有 70 次发生在
      // "当时空闲"——而空闲时最频繁的动作就是这个反射。
      // 原因在于 pathfinder 的 A* 搜索是**同步**的，每触发一次寻路就可能
      // 把引擎卡住几秒；半径 12 格意味着她周围一有掉落物就反复触发寻路。
      // 现在只捡 6 格内的（走过去本来就只要一两秒），冷却也拉长到 25 秒。
      if (idle && this.config.get('autoCollectDrops', true) && Date.now() - this._lastCollectAt > 25000) {
        const drops = this.state
          .nearbyEntities({ radius: 6, limit: 5 })
          .filter((e) => e.name === 'item' || e.type === 'object');
        if (drops.length) {
          this._lastCollectAt = Date.now();
          const nearest = drops[0];
          this._submitReflex('捡起附近的掉落物', async ({ signal }) => {
            const got = await this.actions.collectDrops({ signal, timeoutMs: 7000, maxDistance: 8 });
            const gained = Object.entries(got.gained || {});
            if (gained.length) {
              this.state.note(`捡起了 ${gained.map(([k, v]) => `${k}×${v}`).join('、')}`);
            } else {
              log.debug(`附近的掉落物没捡到（${nearest.distance} 格，可能够不着）`);
            }
          });
          return;
        }
      }

      // 7) 太黑 → 点个火把。真人夜里/进洞都会照明，顺带防怪在脚边刷。
      //
      // **没火把就现做**：早期这里要求"背包里有火把"，而她根本没做过火把，
      // 于是这个反射永远不触发——用户反馈"她不会在暗处放置火把"就是这个原因。
      // 现在只要有一块煤（或木炭）+ 一根木棍，就先做火把再插。
      if (idle && this.config.get('autoTorch', true) && Date.now() - this._lastTorchAt > 45000) {
        const light = this.state.snapshot('brief').light;
        const dark = typeof light === 'number' && light <= 4;
        if (dark) {
          const torches = this.actions.countItem('torch');
          if (torches > 0) {
            const spot = this._findTorchSpot();
            if (spot) {
              this._lastTorchAt = Date.now();
              this._submitReflex('这里太黑了，插个火把', async ({ signal }) => {
                try {
                  const r = await this.actions.place({ ...spot, item: 'torch', signal, reach: true });
                  if (r && r.ok) this.state.note('插了个火把照亮这里');
                } catch (err) {
                  log.debug(`插火把失败：${err.message}`);
                }
              });
            }
          } else {
            const fuel =
              this.actions.countItem('coal') > 0
                ? 'coal'
                : this.actions.countItem('charcoal') > 0
                  ? 'charcoal'
                  : null;
            const sticks = this.actions.countItem('stick');
            if (fuel && sticks > 0) {
              this._lastTorchAt = Date.now();
              this._submitReflex('做点火把', async ({ signal }) => {
                try {
                  await this.actions.craft({ item: 'torch', count: 4, signal });
                  this.state.note('做了几个火把，这里太黑了');
                } catch (err) {
                  log.debug(`做火把失败：${err.message}`);
                }
              });
            }
          }
        }
      }
    } finally {
      this._currentReflexRunning = false;
    }
  }

  /**
   * MLG 的快速检查（100ms 一次）。
   *
   * 只做最便宜的判断（在不在下坠），确认有危险才去查方块、才动手。
   */
  async _mlgTick() {
    const bot = this.bot;
    // 诊断：确认这个 100ms 的检查真的在跑（排查"MLG 完全不触发"时第一件事）
    this._mlgTicks = (this._mlgTicks || 0) + 1;
    if (!bot || !bot.entity || !this.actions) return;
    // **注意：Config.get() 只接受一个参数**（第二参数"默认值"会被静默忽略），
    // 所以这里不能写 get('autoMlg', true)——那只是读 this._values.autoMlg。
    if (!this.config.get('autoMlg')) return;
    // **不被别的反射挡住**：MLG 是最高优先级的本能（它排在最高优先级，
    // 高于换气 6、反击 5）。原来这里还检查 `_currentReflexRunning`——
    // 那是"反射层正在跑"的标记，结果 MLG 经常被它挡在门外。
    // 唯一该挡住它的是"上一次自救还没做完"。
    if (this._mlgRunning) return;
    if (Date.now() - this._lastMlgAt < 3000) return;
    const e = bot.entity;
    // 最便宜的两个判断先做：没在下坠就直接返回（99.9% 的调用走这条路）
    if (e.onGround) {
      this._mlgTrace = null;
      return;
    }
    // **判断"在下坠"不能用 entity.velocity。**
    //
    // 实测（诊断视图里的 `mlg_last_air_vy`）：她从 18 格高处坠落时，
    // `entity.velocity.y` 只有 **-0.078**，而我的阈值是 -0.7 —— 于是 MLG
    // **一次都没触发**，她照样摔到只剩 9~11 血。
    // mineflayer 的 velocity 是"上一物理帧的瞬时值"，被传送/区块加载打乱后
    // 完全不可信。改成看**位置变化率**：100ms 的检查间隔下，
    // 正常走路/跳跃每格不到 0.15 格，真正下坠远大于这个值。
    const nowMs = Date.now();
    const prev = this._mlgTrace;
    if (!prev) {
      this._mlgTrace = { y: e.position.y, at: nowMs };
      return;
    }
    const dt = Math.max(1, nowMs - prev.at);
    const dropRate = ((prev.y - e.position.y) / dt) * 1000; // 格/秒
    this._mlgTrace = { y: e.position.y, at: nowMs };
    this._lastAirVy = Number(dropRate.toFixed(2));
    if (dropRate < 3) return; // 每秒掉不到 3 格 → 正常跳跃/走下坡，不管
    const danger = this._fallingDanger();
    this._lastDanger = danger; // 诊断用：null 表示"没算出来"
    if (!danger) return;
    // **动作窗口要够宽，而且得按"时间"而不是"格数"想。**
    //
    // 实测她下坠时是 **23 格/秒**——3~5 格的窗口只有约 90ms，
    // 而检查间隔是 100ms，等于**只有一次机会**，稍微错过就没了。
    // 放宽到 7 格（约 300ms = 3 次检查），同时下面把坠落时的检查提速到 40ms。
    if (danger > 7) {
      log.debug(`还有 ${danger} 格落地，再等等（够不着脚下的方块）`);
      return;
    }
    this._mlgRunning = true;
    this._lastMlgAt = Date.now();
    try {
      // 这里**直接做**，不排队：落地水是"晚 100 毫秒就没用"的事，
      // 排进任务队列再等抢占，人已经摔在地上了。
      await this._mlgSave(danger);
    } finally {
      this._mlgRunning = false;
    }
  }

  /**
   * 判断"正在快速下坠、而且落地会摔伤"。
   *
   * 返回落地前还有几格（不够危险就返回 null）。
   *
   * MC 的规则：摔落超过 3 格才开始掉血，每多一格多 1 点伤害
   * （20 点血 = 最多扛 23 格）。所以门槛设在 4 格以上。
   */
  _fallingDanger() {
    const bot = this.bot;
    if (!bot || !bot.entity) return null;
    const e = bot.entity;
    if (e.onGround) return null;
    // 下坠判断交给调用方（_mlgTick 用位置变化率），这里只看"到地面还有多高"。
    // 早期这里也判 `velocity.y < -0.7`，但实测那个值在坠落时只有 -0.078，
    // 于是整个 MLG 永远不触发（见 _mlgTick 里的说明）。
    // 往下找第一块实心，算出还有多高落地
    const p = e.position;
    const bx = Math.floor(p.x);
    const bz = Math.floor(p.z);
    for (let dy = 1; dy <= 24; dy += 1) {
      let b = null;
      try {
        b = bot.blockAt(vec3(bx, Math.floor(p.y) - dy, bz));
      } catch {
        return null;
      }
      if (b && b.boundingBox === 'block') {
        const drop = dy;
        // 下面有水/干草/蜂蜜之类的缓冲物就不算危险
        if (['water', 'flowing_water', 'hay_block', 'honey_block', 'slime_block', 'cobweb', 'powder_snow'].includes(b.name)) {
          return null;
        }
        return drop >= 4 ? drop : null;
      }
    }
    return null; // 底下 24 格都是空的：还没到底，先不慌
  }

  /** 真的去自救：优先放水（水能完全免伤），没水就垫方块 */
  async _mlgSave(drop, { signal = null } = {}) {
    const bot = this.bot;
    const p = bot.entity.position;
    const bx = Math.floor(p.x);
    const by = Math.floor(p.y);
    const bz = Math.floor(p.z);
    // 1) 水桶：往脚下倒水——这是 MC 里最标准的落地水
    //
    // 三个坑都踩过，写清楚免得再犯：
    //   a. 水桶不是方块，不能用 `place`（会报"不是可放置的方块"）
    //   b. **必须先装备到手上**：不装备的话 activateBlock 用的是手上那把镐，
    //      调用会"成功"但一滴水都倒不出来（实测世界里的水方块数还是 0）
    //   c. 桶属于"使用物品"，要走 activateItem 而不是 activateBlock
    // 时机也很关键：只在落地前 3~5 格倒（更早够不着脚下的方块，更晚来不及）。
    if (this.actions.countItem('water_bucket') > 0) {
      try {
        this.state.note(`要从 ${drop} 格高摔下来，往脚下倒水`);
        await this.actions.holdItem({ item: 'water_bucket' });
        this._mlgNote = 'holdItem ok';
        // 看向正下方那一格（水会倒在那儿）
        const below = bot.blockAt(vec3(bx, by - 1, bz));
        if (below) await bot.lookAt(below.position.offset(0.5, 1, 0.5), true);
        this._mlgNote = `lookAt ok（pitch=${bot.entity.pitch.toFixed(2)}）`;
        bot.activateItem();
        this._mlgNote = 'activateItem 已发';
        await delay(200, { signal });
        // 验证水真的出现了（这一步很重要：不验证就会"报成功但没救到命"）
        const w = bot.blockAt(vec3(bx, by - 1, bz));
        if (w && (w.name === 'water' || w.name === 'flowing_water')) {
          log.warn(`MLG：倒水成功（落差 ${drop} 格）`);
          this._mlgNote = '✅ 倒水成功';
          return true;
        }
        this._mlgNote = `activateItem 发了但脚下没水（那里是 ${w ? w.name : '读不到'}）`;
        log.warn(`MLG：倒水了但脚下没出现水（落差 ${drop} 格）｜${this._mlgNote}`);
      } catch (err) {
        // **用 warn 而不是 debug**：这条路径的失败必须看得见，
        // 否则"MLG 没生效"会变成一个查不出原因的谜（已经踩过一次）。
        this._mlgNote = `倒水自救失败：${err.message}`;
        log.warn(`MLG：倒水自救失败（落差 ${drop}）｜${err.message}`);
      }
    } else {
      this._mlgNote = '身上没有水桶';
    }
    // 2) 没水就垫方块：往正下方放一块（能挡一下，减少摔落高度）
    //
    // **绝对不能用 reach:true**：那会尝试寻路走过去（15 秒超时），
    // 而人正在坠落——第一次尝试就卡住 15 秒，`_mlgRunning` 一直为 true，
    // 后面所有检查全被挡掉，她只能硬摔（实测血量 9.5，一次 MLG 日志都没有）。
    // 这里必须"够得着就放、够不着立刻放弃"。
    const BLOCKS = ['cobblestone', 'dirt', 'oak_planks', 'stone', 'sand', 'netherrack'];
    const block = BLOCKS.find((n) => this.actions.countItem(n) > 0);
    if (block) {
      try {
        this.state.note(`要从 ${drop} 格高摔下来，往脚下垫方块`);
        // **坠落中要反复试，而不是只试一次。**
        //
        // 她每 tick 都在往下掉，"脚下那一格"一直在变；服务端收到包时她的位置
        // 已经不同了，一次尝试命中的概率很低。真人在竖井里掉下去也是一边掉
        // 一边狂点右键，总有一格垫得正好。
        // 每次都用 400ms 硬超时（**不能让它去寻路**，见上面的说明）。
        //
        // 注意：这一版**还没验证成功过**（实测 1 格宽竖井里 30 格坠落仍然摔死）。
        // 留着是因为它只可能更好，而且失败会如实记进 mlg_note。
        let placed = false;
        for (let i = 0; i < 6 && !placed; i += 1) {
          const pp = bot.entity.position;
          try {
            await Promise.race([
              this.actions.place({
                x: Math.floor(pp.x),
                y: Math.floor(pp.y) - 1,
                z: Math.floor(pp.z),
                item: block,
                signal,
                reach: false,
              }),
              delay(400, { signal }).then(() => {
                throw new Error('垫方块超时（坠落中不能等）');
              }),
            ]);
            placed = true;
          } catch (err) {
            this._mlgNote = `垫方块第 ${i + 1} 次没成：${err.message}`;
            await delay(90, { signal }).catch(() => {});
          }
          if (bot.entity.onGround) break;
        }
        if (placed) {
          log.warn(`MLG：垫方块自救（落差 ${drop} 格）`);
          this._mlgNote = '✅ 垫方块成功';
          return true;
        }
      } catch (err) {
        log.debug(`垫方块自救失败：${err.message}`);
      }
    }
    log.warn(
      `要从 ${drop} 格高摔下来：倒水这条路服务端不接受，垫方块又贴不上去` +
        `（脚下那格周围没有可依附的方块——在空井/悬崖外侧就是这样）。只能硬扛`,
    );
    this.state.note(`从 ${drop} 格高摔下来，没救成`);
    return false;
  }

  /**
   * 检测"被方块卡住"：她所在的格子或头顶那格是实心方块。
   *
   * 返回要挖掉的那个方块（优先头顶——MC 里头顶被堵住是最常见的死法），
   * 没有则返回 null。
   *
   * **优先挑"挖得动的"**：实测她被困时往往身上什么都没有（死了掉光 / 镐子用坏），
   * 而石头徒手挖不动 → 脱困任务反复失败、她永远出不来。
   * 真人的做法是**先用手刨开软的那面**（泥土/沙/树叶），再想办法。
   * 所以这里按"徒手可挖"排序，同时也会在四个水平方向找软方块。
   */
  _blockingSelf() {
    const bot = this.bot;
    if (!bot || !bot.entity) return null;
    const p = bot.entity.position;
    const bx = Math.floor(p.x);
    const bz = Math.floor(p.z);
    // **必须加偏移量再取整**：她站在方块边界上（或正在下落）时
    // `Math.floor(p.y)` 可能正好指向她脚下那块地面，
    // 于是"被卡住"误报 → 这个反射是 critical 级、会抢占并取消正在跑的技能
    // （实测：mine_ores 在 9.9 秒被莫名取消）。
    // 用 +0.1 表示"她身体实际占据的那一格"，+1.62 是眼睛/头部那一格。
    const byFeet = Math.floor(p.y + 0.1);
    const byHead = Math.floor(p.y + 1.62);
    const BAD = ['lava', 'water', 'flowing_lava', 'flowing_water', 'bedrock', 'barrier'];
    // 徒手就能挖的方块（不需要工具）
    const HAND_DIGGABLE = /dirt|grass_block|sand|gravel|clay|snow|soul_soil|moss|podzol|mycelium|farmland|mud|_leaves|log|wood|planks|netherrack|_stem|_hyphae/;

    const candidates = [];
    // **只考虑她真的挖得动的方块。**
    //
    // 这是"乱挖"的根源之一：她被困在石头里、身上又没镐时，
    // 这个函数照样返回石头 → 反射层反复提交"挖开卡住自己的方块"、
    // 每次都失败、还每次都重试（实测日志里 350ms 一次、一分钟十几次），
    // 玩家看到的就是她在原地乱敲。
    // 挖不动的方块不该进候选——应该走"求助/认命"那条路。
    const canDigThis = (b) => {
      try {
        return typeof this.actions._hasToolFor === 'function' ? this.actions._hasToolFor(b) : true;
      } catch {
        return true;
      }
    };
    // 自己所在格 + 头顶（最优先，因为不挖开就动不了）
    for (const ty of [byHead, byFeet]) {
      let b = null;
      try {
        b = bot.blockAt(vec3(bx, ty, bz));
      } catch {
        continue;
      }
      if (!b || b.boundingBox !== 'block' || !b.diggable) continue;
      if (BAD.includes(b.name)) continue;
      if (!canDigThis(b)) continue;
      candidates.push({ x: bx, y: ty, z: bz, name: b.name, prio: ty === byHead ? 0 : 1 });
    }
    // 四个水平方向（脚和头两层）：被围住时也能开一条路出去
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      for (const ty of [byFeet, byHead]) {
        let b = null;
        try {
          b = bot.blockAt(vec3(bx + dx, ty, bz + dz));
        } catch {
          continue;
        }
        if (!b || b.boundingBox !== 'block' || !b.diggable) continue;
        if (BAD.includes(b.name)) continue;
        if (!canDigThis(b)) continue;
        candidates.push({ x: bx + dx, y: ty, z: bz + dz, name: b.name, prio: 2 });
      }
    }
    if (!candidates.length) return null;
    // 排序：先按"是不是徒手可挖"，再按优先级（头顶 > 自身 > 水平）
    candidates.sort((a, b) => {
      const ha = HAND_DIGGABLE.test(a.name) ? 0 : 1;
      const hb = HAND_DIGGABLE.test(b.name) ? 0 : 1;
      return ha - hb || a.prio - b.prio;
    });
    return candidates[0];
  }

  /**
   * 找一个"能放火把"的位置：脚下是实体、本格和头顶是空气。
   * 优先找自己旁边那一圈，这样不用走远。
   */
  _findTorchSpot() {
    const bot = this.bot;
    if (!bot || !bot.entity) return null;
    const p = bot.entity.position;
    const bx = Math.floor(p.x);
    const by = Math.floor(p.y);
    const bz = Math.floor(p.z);
    const solid = (b) => !!b && b.boundingBox === 'block';
    const empty = (b) => !!b && (b.boundingBox === 'empty' || b.name === 'air');
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    for (const [dx, dz] of dirs) {
      const x = bx + dx;
      const z = bz + dz;
      const floor = bot.blockAt(vec3(x, by - 1, z));
      const feet = bot.blockAt(vec3(x, by, z));
      const head = bot.blockAt(vec3(x, by + 1, z));
      if (solid(floor) && empty(feet) && empty(head)) return { x, y: by, z };
    }
    return null;
  }

  /**
   * 提交一个反射层任务。
   * @param {'critical'|'normal'} level critical = 溺水/岩浆/着火，必须立即抢占；
   *                                      normal  = 饿/低血/被围，做完手上的事再说
   */
  _submitReflex(name, run, level = 'normal', hooks = {}) {
    const cur = this.queue.current;
    // 同名反射任务已经在跑就不重复提交
    if (cur && cur.name === name) return null;
    const priority = level === 'critical' ? PRIORITY.CRITICAL : PRIORITY.REFLEX;
    const task = this.queue.submit({
      name,
      run,
      priority,
      preemptible: level === 'critical',
      kind: 'reflex',
    });
    // 结果回调：让调用方知道这次自救成功了没有（用于"连续失败就退避"）
    if (task && (hooks.onDone || hooks.onFailed)) {
      try {
        task.promise
          .then(() => hooks.onDone && hooks.onDone())
          .catch(() => hooks.onFailed && hooks.onFailed());
      } catch {
        /* 拿不到 promise 就算了，不影响主流程 */
      }
    }
    return task;
  }

  _onTaskFinished(task) {
    const payload = {
      task_id: task.id,
      name: task.name,
      kind: task.kind,
      status: task.status,
      error: task.error ? describeFailure(task.error) : null,
      duration_ms: task.finishedAt && task.startedAt ? task.finishedAt - task.startedAt : null,
      result: task.result,
    };
    this.state.setCurrentTaskText(null);
    this._emit('task.finished', payload);
    if (task.status === 'failed') {
      this.state.note(`动作失败：${task.name}（${payload.error}）`);
    }
  }

  // ================================================================ 对外能力

  _pos() {
    if (!this.bot || !this.bot.entity) return null;
    const p = this.bot.entity.position;
    return { x: Number(p.x.toFixed(1)), y: Number(p.y.toFixed(1)), z: Number(p.z.toFixed(1)) };
  }

  requireBot() {
    if (!this.bot || !this.bot.entity) throw new NotConnectedError();
    return this.bot;
  }

  /**
   * **危险扫描**：附近有没有岩浆、深水、悬崖、会掉下来的沙砾。
   *
   * 为什么要单独做这个：真人在陌生地形里会先"看一眼有没有危险"再动，
   * 而她原来只有"掉下去了才知道"（MLG）——那是事后补救，而且实测救不回来。
   * 有了这个，LLM 可以在动手前先问一句，把危险**提前避开**。
   *
   * 只读，不改世界。扫描有工作量预算（不会把引擎卡住）。
   */
  dangerScan(radius = 8) {
    const bot = this.bot;
    if (!bot || !bot.entity) return { ok: false, reason: '没连接' };
    const r = Math.max(2, Math.min(16, Number(radius) || 8));
    const p = bot.entity.position;
    const cx = Math.floor(p.x);
    const cy = Math.floor(p.y);
    const cz = Math.floor(p.z);
    const lava = [];
    const water = [];
    const cliffs = [];
    let work = 0;
    const BUDGET = 6000;

    // 1) 岩浆/水：只看她这一层上下 2 格（够判断"会不会淹/烧到她"）
    for (let dx = -r; dx <= r && work < BUDGET; dx += 1) {
      for (let dz = -r; dz <= r && work < BUDGET; dz += 1) {
        const d = Math.hypot(dx, dz);
        if (d > r) continue;
        for (let dy = -2; dy <= 2; dy += 1) {
          work += 1;
          let b = null;
          try {
            b = bot.blockAt(vec3(cx + dx, cy + dy, cz + dz));
          } catch {
            continue;
          }
          if (!b) continue;
          if (b.name === 'lava' || b.name === 'flowing_lava') {
            lava.push({ x: cx + dx, y: cy + dy, z: cz + dz, distance: Number(d.toFixed(1)) });
          } else if (b.name === 'water' || b.name === 'flowing_water') {
            water.push({ x: cx + dx, y: cy + dy, z: cz + dz, distance: Number(d.toFixed(1)) });
          }
        }
      }
    }

    // 2) 悬崖：八个方向看"再走一格会不会掉下去"
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]) {
      let drop = null;
      for (let dy = 1; dy <= 6; dy += 1) {
        let b = null;
        try {
          b = bot.blockAt(vec3(cx + dx, cy - dy, cz + dz));
        } catch {
          break;
        }
        if (b && b.boundingBox === 'block') {
          drop = dy - 1;
          break;
        }
      }
      if (drop === null) drop = 6;
      if (drop > 3) {
        cliffs.push({ x: cx + dx, z: cz + dz, drop, dir: `${dx},${dz}` });
      }
    }

    const lavaNear = lava.sort((a, b) => a.distance - b.distance).slice(0, 5);
    const waterNear = water.sort((a, b) => a.distance - b.distance).slice(0, 5);
    const parts = [];
    if (lavaNear.length) parts.push(`**岩浆** ${lavaNear.length} 处（最近 ${lavaNear[0].distance} 格）——千万别往那边挖/走`);
    if (cliffs.length) parts.push(`**悬崖/深坑** ${cliffs.length} 个方向（最深 ${Math.max(...cliffs.map((c) => c.drop))} 格）`);
    if (waterNear.length) parts.push(`水 ${waterNear.length} 处（最近 ${waterNear[0].distance} 格）`);
    return {
      ok: true,
      radius: r,
      lava: lavaNear,
      water: waterNear,
      cliffs,
      safe: parts.length === 0,
      verdict: parts.length ? parts.join('；') : `半径 ${r} 格内没有岩浆、深水或悬崖，可以放心活动`,
      truncated: work >= BUDGET,
    };
  }

  /**
   * **诊断视图**：一眼看清"她为什么不动"。
   *
   * 为什么需要它：前几轮排查"她卡住了 / 她不动"时，我每次都要写临时脚本、
   * 翻几百行日志、逐条猜——而真相往往是这几件事之一：
   *   引擎被阻塞了 / 有任务卡着 / 她在等 LLM / 某个反射在退避 / 她根本不在线
   * 参考实现 的做法是把"她忙不忙、为什么不动、排着什么"集中在 `LoopStatus` 一处读。
   * 这里照做：所有"可能导致她不动"的原因都列出来，**并且明确标出当前哪一条成立**。
   */
  diagnose() {
    const bot = this.bot;
    const now = Date.now();
    const reasons = [];

    if (!bot || !bot.entity) {
      reasons.push('她不在服务器里（没连接）');
    } else {
      // 1) 引擎最近被阻塞过吗
      const lag = this._lastLagWarn || null;
      if (lag && now - lag.at < 60000) {
        reasons.push(`引擎 ${((now - lag.at) / 1000).toFixed(0)} 秒前被阻塞了 ${lag.seconds.toFixed(1)} 秒（当时${lag.what}）`);
      }
      // 2) 有任务卡着吗
      const cur = this.queue.current;
      if (cur) {
        const held = cur.startedAt ? (now - cur.startedAt) / 1000 : 0;
        if (held > 90) reasons.push(`「${cur.name}」已经跑了 ${held.toFixed(0)} 秒还没结束（可能卡住了）`);
      }
      // 3) 反射在退避吗
      if (this._unstuckGiveUpUntil && now < this._unstuckGiveUpUntil) {
        reasons.push(`挖困自救退避中（还有 ${((this._unstuckGiveUpUntil - now) / 1000).toFixed(0)} 秒）`);
      }
      // 4) 血量/饱食危险吗
      if (bot.health !== null && bot.health <= 6) reasons.push(`血量只剩 ${bot.health}，她在硬撑`);
      if (bot.food !== null && bot.food <= 6) reasons.push(`肚子饿了（饱食 ${bot.food}）`);
      // 5) 掉下去了吗（同样不能用 velocity——见 _mlgTick 的说明）
      if (this._lastAirVy !== null && this._lastAirVy !== undefined && this._lastAirVy > 3 && !bot.entity.onGround) {
        reasons.push(`正在下坠（${this._lastAirVy} 格/秒）`);
      }
    }

    return {
      at: new Date(now).toISOString(),
      connected: !!(bot && bot.entity),
      position: this._pos(),
      health: bot && bot.entity ? bot.health : null,
      food: bot ? bot.food : null,
      // **当前状态**：她手上在干什么、排着什么、刚干完什么
      current_task: this.queue.currentInfo,
      queued: this.queue.pendingCount,
      queue: this.queue.queueInfo,
      recent_tasks: this.queue.history.slice(-8).map((h) => ({
        name: h.name,
        status: h.status,
        seconds: h.elapsedMs ? Number((h.elapsedMs / 1000).toFixed(1)) : null,
        error: h.error ? String(h.error).slice(0, 80) : null,
      })),
      // **本能层**：谁最近动过手（用来判断"是不是反射在捣乱"）
      reflexes: {
        last_unstuck_seconds_ago: this._lastUnstuckAt ? Number(((now - this._lastUnstuckAt) / 1000).toFixed(0)) : null,
        unstuck_give_up_for: this._unstuckGiveUpUntil > now ? Number(((this._unstuckGiveUpUntil - now) / 1000).toFixed(0)) : 0,
        last_torch_seconds_ago: this._lastTorchAt ? Number(((now - this._lastTorchAt) / 1000).toFixed(0)) : null,
        last_collect_seconds_ago: this._lastCollectAt ? Number(((now - this._lastCollectAt) / 1000).toFixed(0)) : null,
        last_mlg_seconds_ago: this._lastMlgAt ? Number(((now - this._lastMlgAt) / 1000).toFixed(0)) : null,
        // MLG 的开关与检查次数：排查"它到底有没有在跑"时直接看这里
        mlg_enabled: !!this.config.get('autoMlg'),
        mlg_checks: this._mlgTicks || 0,
        mlg_last_air_vy: this._lastAirVy ?? null,
        mlg_last_danger: this._lastDanger ?? null,
        mlg_running: !!this._mlgRunning,
        mlg_note: this._mlgNote || null,
      },
      // **性能**：最近一次事件循环阻塞（"卡"的直接指标）
      last_lag: this._lastLagWarn || null,
      // **心情**：插件推下来的真实心情（已经接到走路节奏上）
      mood: this._mood || null,
      // **结论**：为什么她可能不动
      idle_reasons: reasons,
      verdict: reasons.length ? reasons.join('；') : '一切正常，她应该能动',
    };
  }

  status() {
    const bot = this.bot;
    return {
      connected: !!(bot && bot.entity),
      ready: !!(bot && bot.entity),
      username: bot ? bot.username : null,
      version: bot ? bot.version : null,
      config: {
        host: log.mask(this.config.get('host')),
        port: this.config.get('port'),
        username: log.mask(this.config.get('username')),
        version: this.config.get('version'),
        auth: this.config.get('auth'),
        slow_mode: !!this.config.get('slowMode'),
        auto_mode: !!this.config.get('autoMode'),
        auto_eat: !!this.config.get('autoEat'),
        auto_defend: !!this.config.get('autoDefend'),
        // 安全相关的设置也报出来：否则"我设了挖掘保护到底生效没有"
        // 在插件侧完全无法确认，只能靠翻引擎日志。
        dig_blacklist: this.config.get('digBlacklist') || [],
        dig_whitelist: this.config.get('digWhitelist') || [],
        spawn_protection_radius: this.config.get('spawnProtectionRadius') || 0,
        skill_timeout_ms: this.config.get('skillTimeoutMs'),
      },
      position: this._pos(),
      health: bot && bot.entity ? bot.health : null,
      food: bot ? bot.food : null,
      current_task: this.queue.currentInfo,
      queued: this.queue.pendingCount,
      queue: this.queue.queueInfo,
      stats: this.queue.stats,
      history: this.queue.history.slice(-10),
    };
  }

  /** 说话：带限流，避免被服务器当刷屏踢掉 */
  chat(message) {
    const bot = this.requireBot();
    const text = String(message || '').replace(/[\r\n]+/g, ' ').trim();
    if (!text) throw new GameError('要说的内容不能为空');
    if (text.length > 250) throw new GameError(`内容太长（${text.length} 字符，上限 250）`);
    const now = Date.now();
    this._chatTimes = this._chatTimes.filter((t) => now - t < 10000);
    if (this._chatTimes.length >= 5) {
      throw new GameError('10 秒内已经说了 5 句，先等等再说话（避免被服务器判定刷屏）');
    }
    this._chatTimes.push(now);
    bot.chat(text);
    this.state.note(`我说话：${text}`);
    return { ok: true, said: text };
  }

  /** 把技能提交成任务，立刻返回 task_id */
  submitSkill({ skill, params = {}, name = null, priority = PRIORITY.SKILL }) {
    this.requireBot();
    const registry = require('./skills');
    const def = registry.get(skill);
    if (!def) {
      throw new GameError(`没有这个技能：${skill}。可用技能：${registry.names().join(' / ')}`);
    }
    const task = this.queue.submit({
      name: name || def.label || skill,
      kind: 'skill',
      priority,
      preemptible: true,
      meta: { skill, params },
      run: async ({ signal, task: self }) => {
        const ctx = new registry.SkillContext({
          signal,
          deadline: Date.now() + (Number(this.config.get('skillTimeoutMs')) || 300000),
          onProgress: (text) => {
            self.setDetail(text);
            this.state.pin(`${def.label || skill}：${text}`);
            this._emit('task.progress', { task_id: self.id, name: self.name, progress: text });
          },
        });
        // 把"确保区块就绪"的能力交给技能层：出生瞬间地形可能还没到
        ctx.ensureChunks = (opts) => this.ensureChunks(opts);
        try {
          // 开干之前先确认踩在实地上：出生点常在树冠/水面上，
          // 从那种位置出发寻路必然失败（详见 skills/common.js 的 settle 注释）
          const s = await skills.settle({ actions: this.actions, nav: this.nav, ctx });
          if (!s.settled) {
            log.debug(`落地稳定未完全成功：${s.note}`);
          }
          const result = await def.run({
            actions: this.actions,
            nav: this.nav,
            state: this.state,
            config: this.config,
            ctx,
            params,
            engine: this,
          });
          self.setDetail(result && result.note ? result.note : null);
          return result;
        } catch (err) {
          // **技能抛异常时把调用栈写进日志**。
          //
          // 为什么值得单独做：像 "Cannot read properties of null (reading 'y')"
          // 这种报错，光看消息**定位不了是哪一行**（实测出现过 46 次，
          // 排查了很久才靠这个找到 wood.js 的回调）。栈里第一帧就是现场。
          if (err && err.stack) {
            const frames = String(err.stack)
              .split('\n')
              .filter((l) => l.includes('skills/') || l.includes('bot\\') || l.includes('bot/'))
              .slice(0, 3)
              .map((l) => l.trim());
            log.warn(`技能「${def.label || skill}」抛异常：${err.message}｜现场：${frames.join(' ← ')}`);
          }
          throw err;
        } finally {
          this.state.unpin(`${def.label || skill}：`);
          // 清理进度 pin：state.unpin 是按完整文本匹配的，这里做一次兜底清理
          this.state._pinnedNotes = this.state._pinnedNotes.filter((n) => !n.startsWith(`${def.label || skill}：`));
        }
      },
    });
    return task;
  }

  /** 直接提交一个动作任务（供 RPC 的 *_async 方法使用） */
  submitAction({ name, run, priority = PRIORITY.USER, meta = {} }) {
    return this.queue.submit({ name, run, priority, kind: 'action', meta, preemptible: true });
  }

  cancelTask(taskId) {
    return this.queue.cancel(taskId);
  }

  cancelAll(reason = '急停') {
    const ids = this.queue.cancelAll({ reason });
    // 顺带停掉脚下的移动控制，避免"取消了但身体还在走"
    try {
      if (this.bot) {
        this.bot.clearControlStates();
        if (this.nav) this.nav.stop();
      }
    } catch {
      /* ignore */
    }
    return { ok: true, cancelled: ids };
  }

  shutdown() {
    log.info('引擎正在关闭');
    this._stopLoops();
    this.queue.cancelAll({ reason: '引擎关闭' });
    if (this.bot) {
      try {
        this.bot.quit('引擎关闭');
      } catch {
        /* ignore */
      }
    }
  }
}

module.exports = { McEngine };
