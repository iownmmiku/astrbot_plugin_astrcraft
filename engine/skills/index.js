'use strict';
/**
 * 技能注册表：把技能名映射到实现，并负责参数校验。
 *
 * 这里的技能名会直接暴露给 LLM 当工具名，所以：
 *   - 名字要能自解释（mc_chop_tree 比 mc_skill_1 好一万倍）
 *   - 缺参数要给出**可执行**的报错，而不是 undefined 崩溃
 */

const {
  SkillContext,
  skillResult,
  mergeCounts,
  positiveOnly,
  driveUntil,
  settle,
} = require('./common');
const wood = require('./wood');
const mining = require('./mining');
const building = require('./building');
const gathering = require('./gathering');
const supply = require('./supply');
const blueprint = require('./blueprint');
const traverse = require('./traverse');
const { delay, CancelledError, describeFailure } = require('../util');
const { MissingItemError } = require('../actions');
const log = require('../log');

/** 参数校验小工具 */
function requireParam(params, name, { type = 'number', min = null, max = null, def = null } = {}) {
  let v = params[name];
  if (v === undefined || v === null || v === '') {
    if (def !== null) return def;
    throw new Error(`缺少参数 ${name}`);
  }
  if (type === 'number') {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`参数 ${name} 必须是数字，收到了 ${JSON.stringify(v)}`);
    if (min !== null && n < min) throw new Error(`参数 ${name} 不能小于 ${min}`);
    if (max !== null && n > max) throw new Error(`参数 ${name} 不能大于 ${max}`);
    return n;
  }
  if (type === 'string') {
    const s = String(v).trim();
    if (!s) throw new Error(`参数 ${name} 不能为空`);
    return s;
  }
  if (type === 'array') {
    if (!Array.isArray(v)) {
      if (typeof v === 'string') return v.split(/[,，\s]+/).filter(Boolean);
      throw new Error(`参数 ${name} 必须是数组`);
    }
    return v;
  }
  return v;
}

const SKILLS = {
  chop_tree: {
    label: '砍树',
    description: '找树砍木材，自动捡起掉落物',
    // **策略参数**（见 skills_docs/strategy.md）：
    // 原来"找多远、试几次就放弃"是写死在代码里的常量，模型看不到也改不了。
    // 现在摆出来当参数——它就能根据处境调（比如"这片林子砍光了，找远一点"）。
    params: {
      count: { type: 'number', min: 1, max: 256, def: 8 },
      radius: { type: 'number', min: 8, max: 96, def: 48 },
      max_attempts: { type: 'number', min: 1, max: 64, def: 24 },
    },
    async run({ actions, nav, state, ctx, params }) {
      return wood.chopTree({
        actions,
        nav,
        state,
        ctx,
        want: requireParam(params, 'count', { def: 8 }),
        radius: requireParam(params, 'radius', { def: 48 }),
        maxAttempts: requireParam(params, 'max_attempts', { def: 24 }),
      });
    },
  },

  make_tools: {
    label: '做工具',
    description: '做一整套工具（自动处理原木→木板→木板→工具的依赖链，材料不够会自己去挖）',
    params: { tier: { type: 'string', def: 'stone' }, kinds: { type: 'array', def: null }, allow_search: { type: 'boolean', def: true } },
    async run({ actions, nav, state, ctx, params }) {
      const tier = String(requireParam(params, 'tier', { type: 'string', def: 'stone' })).toLowerCase();
      const kinds = params.kinds ? requireParam(params, 'kinds', { type: 'array' }) : null;
      // allow_search=false 表示"材料已经给好了，别去满世界找树"——用于定向测试
      const allowSearch = params.allow_search !== false;
      return wood.makeTools({ actions, nav, state, ctx, tier, kinds, allowSearch });
    },
  },

  /**
   * 合成一件物品（原语级技能）。
   *
   * **为什么必须注册它**：advisor.py 在"手上有煤却没有火把"时会建议
   * `craft(item="torch", count=8)`，而 SKILLS 注册表里**根本没有 craft**——
   * 这条建议会被 life.py 的 `_fallback_decision()` 原样当成技能名提交给
   * `skill.run`，引擎回一句「没有这个技能：craft」，白烧一整轮模型往返，
   * 还会被记进 `_recent_failures`、进而触发 30 秒失败退避
   * （见 life.py 的 `_should_back_off`）。
   *
   * 引擎里 `actions.craft` 早就写好且很完整（工作台自适应、按"她手上的材料
   * 能不能推出来"挑配方、异步背包同步的善后），只是**没有暴露成技能**，
   * 所以除了 LLM 工具 `mc_craft` 之外谁也调不到。
   *
   * 与 make_tools 的分工：这个只做**单件**合成（火把/箱子/木棍/某一把镐），
   * 要"一整套工具 + 自动补材料"用 make_tools。所以**紧挨着 make_tools 放**，
   * 两个合成类技能在清单里连着。
   *
   * （它一度被"故意放在注册表末尾"——因为当时 life.py 的决策提示词只渲染
   *   技能列表的前 12 项，插中间会把 store_items 等挤出去。P1 改成**全量渲染**
   *   之后这个理由就不存在了，于是挪回它本来该在的位置。）
   */
  craft: {
    label: '合成物品',
    description:
      '合成指定物品（自动处理工作台：随身合成不行就去找一个、没有就做一个放下来）。' +
      '要火把/箱子/木棍/某一把镐这种**单件**合成用它；要一整套工具用 make_tools',
    params: {
      item: { type: 'string', required: true },
      count: { type: 'number', min: 1, max: 256, def: 1 },
    },
    async run({ actions, ctx, params }) {
      const item = requireParam(params, 'item', { type: 'string' });
      const count = requireParam(params, 'count', { def: 1 });
      const r = await actions.craft({ item, count, signal: ctx.signal });
      // **以真实产出为准**：actions.craft 的 ok 依赖"这次调用前后该物品的增量"，
      // 而产物可能早已在背包里（增量 0），所以这里看 produced。
      const produced = Number(r && r.produced) || 0;
      const ok = produced > 0;
      const why = (r && r.note) || `合成 ${item} 没有产出`;
      return skillResult(ok, {
        steps: [
          {
            action: 'craft',
            ok,
            detail: `${item}×${produced}${r && r.used_table ? '（用了工作台）' : ''}`,
          },
        ],
        produced: ok ? { [item]: produced } : {},
        note: ok ? `合成了 ${item}×${produced}` : `没能合成 ${item}：${why}`,
        reason: ok ? null : why,
        extra: { item, requested: count, produced, used_table: !!(r && r.used_table) },
      });
    },
  },

  mine_ores: {
    label: '挖矿',
    description: '挖指定矿石到指定数量（含工具依赖、向下挖阶梯、安全判断）',
    // 默认值**必须等于原来的硬编码值**（radius 40、maxAttempts 40），
    // 否则这就不是"把策略搬到台面上"，而是偷偷改了行为。
    params: {
      ore: { type: 'string', def: 'iron' },
      count: { type: 'number', min: 1, max: 256, def: 8 },
      radius: { type: 'number', min: 8, max: 96, def: 40 },
      max_attempts: { type: 'number', min: 1, max: 96, def: 40 },
      allow_search: { type: 'boolean', def: true },
    },
    async run({ actions, nav, state, ctx, params }) {
      const ore = requireParam(params, 'ore', { type: 'string', def: 'iron' }).toLowerCase();
      const count = requireParam(params, 'count', { def: 8 });
      return mining.mineOre({
        actions,
        nav,
        state,
        ctx,
        ore,
        want: count,
        radius: requireParam(params, 'radius', { def: 40 }),
        maxAttempts: requireParam(params, 'max_attempts', { def: 40 }),
        allowSearch: params.allow_search !== false,
      });
    },
  },

  mine_stone: {
    label: '挖石头',
    description: '挖圆石（建筑与石制工具的基础材料）',
    // 同样：radius 40、maxAttempts 30 是原来 mineStone/mineSpecific 里的值
    params: {
      count: { type: 'number', min: 1, max: 256, def: 20 },
      radius: { type: 'number', min: 8, max: 96, def: 40 },
      max_attempts: { type: 'number', min: 1, max: 96, def: 30 },
      allow_search: { type: 'boolean', def: true },
    },
    async run({ actions, nav, state, ctx, params }) {
      return mining.mineStone({
        actions,
        nav,
        state,
        ctx,
        want: requireParam(params, 'count', { def: 20 }),
        radius: requireParam(params, 'radius', { def: 40 }),
        maxAttempts: requireParam(params, 'max_attempts', { def: 30 }),
        allowSearch: params.allow_search !== false,
      });
    },
  },

  climb_out: {
    label: '爬出坑/矿道',
    description: '从坑、竖井或矿道安全回到地面；记得入口时优先原路返回，再挖阶梯或垫脚，验收真实落点',
    params: { max_steps: { type: 'number', min: 1, max: 96, def: 32 },
      return_target: { type: 'object', def: null } },
    async run({ actions, nav, ctx, params }) {
      const helper = require('./mining_return');
      const target = params.return_target || null;
      if (target && !['x', 'y', 'z'].every((axis) => Number.isFinite(target[axis]))) {
        throw new Error('return_target 需要有效的 x、y、z 数值');
      }
      return helper.withMiningBody({ actions, ctx }, async (ctx) => {
        const back = await helper.returnFromMining({ actions, nav, ctx, target,
          maxSteps: requireParam(params, 'max_steps', { min: 1, max: 96, def: 32 }) });
        return skillResult(back.return_status.ok, {
          note: back.note || '她已经在安全地面上了，不用爬',
          reason: back.return_status.reason,
          extra: { climbed: back.climbed || 0, return_status: back.return_status },
        });
      });
    },
  },

  recover_drops: {
    label: '回去捡掉落物',
    description:
      '走回死亡地点，把掉在那儿的东西捡回来。**会自动判断值不值得去**：' +
      '掉落物大约 5 分钟就消失，太远或太久它会直接告诉你别去了',
    params: {
      x: { type: 'number', required: true },
      y: { type: 'number', required: true },
      z: { type: 'number', required: true },
      age_seconds: { type: 'number', min: 0, max: 3600, def: 0 },
      radius: { type: 'number', min: 2, max: 16, def: 8 },
    },
    async run({ actions, nav, state, ctx, params }) {
      const x = requireParam(params, 'x', {});
      const y = requireParam(params, 'y', {});
      const z = requireParam(params, 'z', {});
      const age = requireParam(params, 'age_seconds', { def: 0 });
      const radius = requireParam(params, 'radius', { def: 8 });
      const bot = actions.bot;
      const me = bot.entity.position;
      const dist = Math.hypot(me.x - x, me.z - z) + Math.abs(me.y - y) * 0.5;

      // **时间判断是这一步的核心**（C 批次，见 docs/DEATH_RECOVERY.md）。
      //
      // 掉落物大约 5 分钟消失。不做判断的话会出现"她花 6 分钟走回去、
      // 什么都没捡到"——**那比不去更糟**（浪费时间，失败还会写进她的教训里）。
      // 判据：已经过了 4 分钟 → 直接劝退；或者按距离估算走不到（约 1.5 格/秒）→ 也劝退。
      const LEFT = 300; // 掉落物存活约 5 分钟
      const left = Math.max(0, LEFT - age);
      const eta = dist / 1.5; // 粗估：每秒约 1.5 格（含绕路）
      if (left <= 30) {
        return skillResult(true, {
          note: `别去了：掉落物已经过了 ${Math.round(age)} 秒，基本消失了`,
          reason: 'MC 里掉落物大约 5 分钟就没了',
          extra: { went: false, distance: Number(dist.toFixed(1)) },
        });
      }
      if (eta > left - 20) {
        return skillResult(true, {
          note:
            `别去了：距离约 ${dist.toFixed(0)} 格、估计要走 ${Math.round(eta)} 秒，` +
            `而掉落物只剩约 ${Math.round(left)} 秒——**走一趟捡不到，不如现在开始重建**`,
          reason: '时间不够',
          extra: { went: false, distance: Number(dist.toFixed(1)), eta_seconds: Math.round(eta) },
        });
      }

      // 值得去 → 走过去再捡
      ctx.progress(`走去死亡地点（约 ${dist.toFixed(0)} 格，掉落物还剩约 ${Math.round(left)} 秒）`);
      let arrived = false;
      try {
        const r = await nav.goTo({ x, y: null, z, range: 2, signal: ctx.signal, timeoutMs: 60000 });
        arrived = !!(r && r.arrived);
      } catch (err) {
        if (err && err.name === 'CancelledError') throw err;
        log.info(`走去死亡地点失败：${err.message}`);
      }
      if (!arrived) {
        return skillResult(false, {
          note: `走不到死亡地点（约 ${dist.toFixed(0)} 格外）`,
          reason: '路上被挡住了，或者地形过不去（可以试试 mc_climb_out）',
          extra: { went: true, arrived: false, distance: Number(dist.toFixed(1)) },
        });
      }
      let got = {};
      try {
        const res = await actions.collectDrops({
          signal: ctx.signal,
          timeoutMs: 12000,
          maxDistance: radius,
        });
        got = (res && res.gained) || {};
      } catch (err) {
        if (err && err.name === 'CancelledError') throw err;
        log.info(`捡掉落物失败：${err.message}`);
      }
      const names = Object.entries(got);
      if (!names.length) {
        return skillResult(true, {
          note: '走到了，但地上已经没有掉落物了（多半已经消失）',
          extra: { went: true, arrived: true, gained: {} },
        });
      }
      return skillResult(true, {
        note: `捡回来了：${names.map(([k, v]) => `${k}×${v}`).join('、')}`,
        produced: got,
        extra: { went: true, arrived: true, gained: got },
      });
    },
  },

  pave: {
    label: '铺路/垫高',
    description:
      '主动改造地形：往前逐格垫方块（跨过坑、岩浆、水），或者垂直垫高自己。' +
      '**走不过去又不想挖的时候用这个**',
    params: {
      direction: { type: 'string', def: 'forward' }, // forward | up
      count: { type: 'number', min: 1, max: 32, def: 4 },
      item: { type: 'string', def: '' },
    },
    async run({ actions, nav, ctx, params }) {
      return traverse.pave({
        actions,
        nav,
        ctx,
        direction: String(params.direction || 'forward'),
        count: requireParam(params, 'count', { def: 4 }),
        item: params.item || null,
      });
    },
  },

  dig_path: {
    label: '挖通一条路',
    description:
      '把通往目标的挡路方块**真的挖掉**再走过去。mc_plan_route 只说"要挖哪几格"，' +
      '这个技能一次把整条路挖通（走不通、被方块挡住时用它）',
    params: {
      x: { type: 'number', required: true },
      y: { type: 'number', def: null },
      z: { type: 'number', required: true },
      max_blocks: { type: 'number', min: 1, max: 48, def: 8 },
    },
    async run({ actions, nav, ctx, params }) {
      return traverse.digPath({
        actions,
        nav,
        ctx,
        x: requireParam(params, 'x', {}),
        y: params.y === undefined || params.y === null || params.y === '' ? null : Number(params.y),
        z: requireParam(params, 'z', {}),
        maxBlocks: requireParam(params, 'max_blocks', { def: 8 }),
      });
    },
  },

  collect: {
    label: '收集物品',
    description: '通用收集：给定物品名与数量，自动决定去砍/挖/合成/熔炼/打猎',
    // collect 会**委派**给 chop_tree / mine_ores / mine_stone 去做，
    // 那三个技能各自的默认重试次数并不一样（24 / 40 / 30）。
    // 所以这里留空表示"用被委派技能自己的默认值"——
    // 硬塞一个 40 会悄悄改掉砍树那条路的行为。
    params: {
      item: { type: 'string', required: true },
      count: { type: 'number', min: 1, max: 256, def: 1 },
      max_attempts: { type: 'number', min: 1, max: 96, def: 0 },
    },
    async run({ actions, nav, state, ctx, params }) {
      const item = requireParam(params, 'item', { type: 'string' });
      const count = requireParam(params, 'count', { def: 1 });
      const rawAttempts = requireParam(params, 'max_attempts', { def: 0 });
      return gathering.collect({
        actions,
        nav,
        state,
        ctx,
        item,
        count,
        // 0 = 不覆盖，交给被委派的技能决定
        maxAttempts: Number(rawAttempts) > 0 ? Number(rawAttempts) : null,
      });
    },
  },

  smelt: {
    label: '熔炼',
    description: '熔炼矿石/食物（自动补熔炉与燃料）',
    params: { item: { type: 'string', def: null }, count: { type: 'number', min: 1, max: 256, def: null } },
    async run({ actions, nav, state, ctx, params }) {
      const item = params.item ? requireParam(params, 'item', { type: 'string' }) : null;
      const count = params.count ? requireParam(params, 'count', { def: null }) : null;
      return mining.smeltOres({ actions, nav, state, ctx, item, count, allowSearch: params.allow_search !== false });
    },
  },

  build_shelter: {
    label: '建庇护所',
    description: '选一块平地，盖一个有墙、有屋顶、有门、有火把的小屋（材料不够会自己去挖）',
    params: { size: { type: 'number', min: 2, max: 6, def: 3 }, roof: { type: 'boolean', def: true }, door: { type: 'boolean', def: true }, torch: { type: 'boolean', def: true } },
    async run({ actions, nav, state, ctx, config, params }) {
      return building.buildShelter({
        actions,
        nav,
        state,
        ctx,
        config,
        size: requireParam(params, 'size', { def: 3 }),
        roof: params.roof !== false,
        door: params.door !== false,
        torch: params.torch !== false,
      });
    },
  },

  return_home: {
    label: '回基地',
    description: '回当前世界记录的基地，走近验证真实墙屋顶与家具，再视夜晚睡觉；最多旅行256格，不挖毁建筑',
    params: { home: { type: 'object', required: true }, sleep: { type: 'boolean', def: true }, timeout_seconds: { type: 'number', min: 5, max: 60, def: 60 }, wait_seconds: { type: 'number', min: 0, max: 30, def: 0 } },
    async run({ actions, nav, state, ctx, config, params }) {
      return building.returnHome({ actions, nav, state, ctx, config, home: params.home,
        sleep: params.sleep !== false, timeoutMs: requireParam(params, 'timeout_seconds', { min: 5, max: 60, def: 60 }) * 1000,
        waitSeconds: requireParam(params, 'wait_seconds', { min: 0, max: 30, def: 0 }) });
    },
  },

  resupply_food: {
    label: '回基地取食物',
    description: '回当前世界128格内的完整基地，实际进屋关门后从最多3个屋内箱子或木桶补齐普通即食食物；保留应急金苹果，取后留屋内，部分补给如实报告',
    params: { home: { type: 'object', required: true }, count: { type: 'number', min: 1, max: 64, def: 4 } },
    async run({ actions, nav, state, ctx, config, params }) {
      return supply.resupplyFood({ actions, nav, state, ctx, config,
        home: requireParam(params, 'home', { type: 'object' }), count: requireParam(params, 'count', { min: 1, max: 64, def: 4 }) });
    },
  },

  leave_home: {
    label: '出基地继续工作',
    description: '从当前完整且关门的基地实际走到安全门外，再确认上下半门已关闭，之后继续原任务',
    params: { home: { type: 'object', required: true }, timeout_seconds: { type: 'number', min: 1, max: 20, def: 20 } },
    async run({ actions, nav, state, ctx, config, params }) {
      return building.leaveHome({ actions, nav, state, ctx, config,
        home: requireParam(params, 'home', { type: 'object' }),
        timeoutMs: requireParam(params, 'timeout_seconds', { min: 1, max: 20, def: 20 }) * 1000 });
    },
  },

  store_items: {
    label: '存东西',
    description: '把背包里的东西存进箱子；给 home 时先回当前世界128格内的完整基地、进屋关门后使用屋内真实箱子，resume_work=true 时再安全出门关门继续工作；否则寻找附近或记忆容器（没有箱子就做一个）',
    params: { items: { type: 'array', def: null }, keep: { type: 'array', def: null }, home: { type: 'object', def: null }, resume_work: { type: 'boolean', def: false } },
    async run({ actions, nav, state, ctx, config, params }) {
      return gathering.storeItems({
        actions,
        nav,
        state,
        ctx,
        config,
        home: params.home ?? null,
        resumeWork: params.resume_work === true,
        items: params.items ? requireParam(params, 'items', { type: 'array' }) : null,
        keep: params.keep ? requireParam(params, 'keep', { type: 'array' }) : null,
      });
    },
  },

  eat: {
    label: '进食补给',
    description: '吃现有食物直到达到目标饱食度，恢复后继续原来的工作',
    params: { item: { type: 'string', def: null }, target_food: { type: 'number', min: 1, max: 20, def: 18 } },
    async run({ actions, ctx, params }) {
      const target = requireParam(params, 'target_food', { min: 1, max: 20, def: 18 });
      const before = actions.bot.food;
      const eaten = [];
      for (let i = 0; i < 20 && actions.bot.food < target; i += 1) {
        ctx.checkAborted();
        ctx.progress(`先吃饱：${actions.bot.food}/${target}`);
        try {
          const r = await actions.eat({ item: params.item || null, signal: ctx.signal });
          eaten.push(r.ate);
        } catch (err) {
          if (err instanceof MissingItemError && eaten.length) break;
          throw err;
        }
      }
      const ok = actions.bot.food >= target;
      return skillResult(ok || eaten.length > 0, { consumed: eaten.reduce((m, n) => { if (n) m[n] = (m[n] || 0) + 1; return m; }, {}),
        note: `饱食度 ${before} → ${actions.bot.food}`,
        extra: { target_food: target, reached_target: ok },
        reason: ok || eaten.length ? null : '还没吃饱，需要补充食物' });
    },
  },

  recover: {
    label: '恢复体力',
    description: '吃饱后在安全处短暂恢复生命，发现附近威胁或无法回血时停止并重新规划',
    params: { target_health: { type: 'number', min: 1, max: 20, def: 12 }, timeout_seconds: { type: 'number', min: 1, max: 30, def: 20 } },
    async run({ actions, state, ctx, params }) {
      const target = requireParam(params, 'target_health', { min: 1, max: 20, def: 12 });
      const seconds = requireParam(params, 'timeout_seconds', { min: 1, max: 30, def: 20 });
      const start = actions.bot.health;
      const deadline = Date.now() + seconds * 1000;
      while (actions.bot.health < target && Date.now() < deadline) {
        ctx.checkAborted();
        if (actions.bot.food < 18) return skillResult(false, { reason: '饱食度不足，先补充食物才能回血' });
        if (state.nearbyEntities({ radius: 12, limit: 1, hostileOnly: true }).length || actions.bot.health < start) {
          return skillResult(false, { reason: '这里仍有威胁，先找安全地点' });
        }
        ctx.progress(`恢复生命：${actions.bot.health}/${target}`);
        await delay(500, { signal: ctx.signal });
      }
      const ok = actions.bot.health >= target;
      return skillResult(ok, { note: `生命 ${start} → ${actions.bot.health}`, reason: ok ? null : '没有恢复到安全血量，检查食物、效果与服务器回血规则' });
    },
  },

  cook_food: {
    label: '准备食物',
    description: '优先用现有小麦和生食补充食物，再猎取可见动物；缺工作台/熔炉/燃料时处理依赖',
    params: { count: { type: 'number', min: 1, max: 64, def: 4 } },
    async run({ actions, nav, state, ctx, params }) {
      return gathering.cookFood({ actions, nav, state, ctx, count: requireParam(params, 'count', { def: 4 }) });
    },
  },

  hunt: {
    label: '打猎',
    description: '猎杀指定动物获取肉/皮革/羊毛',
    params: { mob: { type: 'string', def: 'cow' }, count: { type: 'number', min: 1, max: 32, def: 1 } },
    async run({ actions, nav, state, ctx, params }) {
      return gathering.huntAnimal({
        actions,
        nav,
        state,
        ctx,
        mob: requireParam(params, 'mob', { type: 'string', def: 'cow' }).toLowerCase(),
        want: requireParam(params, 'count', { def: 1 }),
      });
    },
  },

  food_chain: {
    label: '生存补给',
    description: '离开基地前准备至少4份现成食物、一把可用镐和4根火把；优先现有材料，只补缺少的镐，缺料或部分产出如实报告',
    params: {},
    async run({ actions, nav, state, ctx }) {
      ctx.checkAborted();
      const steps = [];
      const before = actions.inventoryMap();
      const child = (stage) => typeof ctx.child === 'function' ? ctx.child(['food_chain', stage]) : ctx;
      const foodReady = () => gathering.READY_FOOD.reduce((sum, name) => sum + actions.countItem(name), 0);
      const finish = (failure = null, dependency = null) => {
        const food = foodReady(), pick = mining.bestPickaxeTier(actions), torches = actions.countItem('torch');
        const missing = [...(food < 4 ? ['food'] : []), ...(!pick ? ['pickaxe'] : []), ...(torches < 4 ? ['torch'] : [])];
        const after = actions.inventoryMap();
        const ok = !failure && missing.length === 0;
        return skillResult(ok, { steps, produced: positiveOnly(wood.diffOf(before, after)),
          consumed: positiveOnly(wood.diffOf(after, before)),
          note: `${ok ? '补给已备好' : '补给尚未齐全'}：食物 ${food}/4 份，镐 ${pick || '无'}，火把 ${torches}/4 根`,
          reason: ok ? null : failure || `还缺 ${missing.join('、')}，补齐后再继续原任务`,
          extra: { food_ready: food, pickaxe_tier: pick, torch_count: torches, missing,
            // A nested food/tool dependency may have gathered furnace material
            // without returning safely. The outer result must let LifeLoop
            // rescue that body before it can resume any dependent work.
            ...(dependency?.return_status ? { return_status: dependency.return_status, collection_ok: ok,
              material_collection_ok: dependency.material_collection_ok === true || dependency.collection_ok === true } : {}) } });
      };
      const food = await gathering.cookFood({ actions, nav, state, ctx: child('food'), count: 4 });
      ctx.checkAborted();
      steps.push(...food.steps);
      if (!food.ok || foodReady() < 4 || food.return_status?.ok === false) {
        return finish(food.reason || food.return_status?.reason || '食物还不足 4 份，先补齐食物再准备工具', food);
      }
      if (!mining.bestPickaxeTier(actions)) {
        const tier = actions.countItem('cobblestone') >= 3 ? 'stone' : 'wooden';
        const tools = await wood.makeTools({ actions, nav, state, ctx: child('pickaxe'), tier, kinds: ['pickaxe'] });
        ctx.checkAborted();
        steps.push(...tools.steps);
        if (!tools.ok || !mining.bestPickaxeTier(actions) || tools.return_status?.ok === false) {
          return finish(tools.reason || tools.return_status?.reason || '没有做出可用的镐', tools);
        }
      }
      if (actions.countItem('torch') < 4) {
        if (actions.countItem('coal') + actions.countItem('charcoal') <= 0) return finish('还缺火把与煤或木炭燃料，现有食物和镐已保留');
        try {
          const deficit = 4 - actions.countItem('torch');
          const sticksNeeded = Math.ceil(deficit / 4);
          if (actions.countItem('stick') < sticksNeeded) {
            const sticks = await wood.makeSticks({ actions, nav, state, ctx: child('torch_sticks'),
              want: sticksNeeded - actions.countItem('stick') });
            ctx.checkAborted();
            steps.push(...sticks.steps);
            if (!sticks.ok || actions.countItem('stick') < sticksNeeded) return finish(sticks.reason || '没有补齐合成火把的木棍');
          }
          const torchResult = await actions.craft({ item: 'torch', count: deficit, signal: ctx.signal });
          ctx.checkAborted();
          if (!torchResult.ok || actions.countItem('torch') < 4) return finish(torchResult.note || '服务端未确认足够的火把');
          steps.push('合成并确认火把');
        } catch (err) {
          ctx.checkAborted();
          if (err instanceof CancelledError || err.name === 'CancelledError' || err.name === 'AbortError') throw err;
          if (actions._stopped) throw new CancelledError('补给被急停');
          return finish(`火把准备失败：${describeFailure(err)}`);
        }
      }
      ctx.checkAborted();
      return finish();
    },
  },

  /**
   * 照图纸建造——**"盖出像样的房子"靠这个**。
   *
   * 图纸由调用方（通常是 LLM 自己）给出：一个字符网格 + 调色板。
   * 比 build_shelter 灵活得多：能盖窗、屋檐、内部隔断、任何形状。
   */
  blueprint: {
    label: '照图纸建造',
    description:
      '照一张图纸搭建筑（可以盖出窗、屋檐、隔断等精细结构）。' +
      'spec 是图纸对象；也可以给 preset 用内置图纸（hut 小屋 / lodge 长屋 / tower 瞭望塔）。',
    params: {
      spec: { type: 'object', def: null },
      preset: { type: 'string', def: null },
      x: { type: 'number', def: null },
      y: { type: 'number', def: null },
      z: { type: 'number', def: null },
    },
    async run({ actions, nav, state, ctx, params }) {
      const bot = actions.bot;
      const spec = params.spec || (params.preset ? blueprint.PRESETS[String(params.preset)] : null);
      if (!spec) {
        throw new Error(
          `要建造就得给图纸：spec 或 preset（可选：${Object.keys(blueprint.PRESETS).join(' / ')}）`,
        );
      }
      // 没给坐标就用她脚站的位置当起点
      const p = bot.entity.position;
      const origin = {
        x: params.x !== null && params.x !== undefined ? Math.floor(Number(params.x)) : Math.floor(p.x),
        y: params.y !== null && params.y !== undefined ? Math.floor(Number(params.y)) : Math.floor(p.y),
        z: params.z !== null && params.z !== undefined ? Math.floor(Number(params.z)) : Math.floor(p.z),
      };
      ctx.progress(`照图纸建造「${spec.name || '未命名'}」（${spec.size?.join('×')}）`);
      const report = await blueprint.buildFromSpec({ actions, nav, ctx, spec, origin });
      return skillResult(report.failed === 0, {
        steps: [{ action: 'blueprint', ok: report.failed === 0, detail: report.note }],
        note: report.note,
        extra: { blueprint: report },
      });
    },
  },

  /**
   * 睡觉：天黑回屋睡一觉（跳过整个夜晚 + 设重生点）。
   */
  sleep: {
    label: '睡觉',
    description: '找一张床睡到天亮（跳过夜晚、设重生点）。附近有怪或不是夜里会如实说原因',
    params: { timeout_seconds: { type: 'number', min: 30, max: 600, def: 120 }, bed_position: { type: 'object', def: null } },
    async run({ actions, ctx, params }) {
      const secs = requireParam(params, 'timeout_seconds', { def: 120 });
      const r = await actions.sleepInBed({ signal: ctx.signal, timeoutMs: secs * 1000, bed_position: params.bed_position || null });
      return skillResult(!!r.ok, {
        steps: [{ action: 'sleep', ok: !!r.ok, detail: r.note }],
        note: r.note,
      });
    },
  },

  /**
   * 对实体右键：剪羊毛、喂食、挤奶。
   */
  interact: {
    label: '和动物互动',
    description: '对附近的动物做一件事：剪羊毛（sheep + shears）、喂食、挤奶（cow + bucket）',
    params: {
      target: { type: 'string', required: true, def: 'sheep' },
      item: { type: 'string', def: null },
    },
    async run({ actions, ctx, params }) {
      const target = requireParam(params, 'target', { type: 'string', def: 'sheep' });
      const r = await actions.interactEntity({
        target,
        item: params.item || null,
        signal: ctx.signal,
      });
      return skillResult(true, {
        steps: [{ action: 'interact', ok: true, detail: r.note }],
        note: r.note,
      });
    },
  },

  /**
   * 远程攻击：用弓射（有蓄力、预判、抬枪）。
   */
  shoot: {
    label: '射箭',
    description: '用弓射目标（需要弓和箭）。会预判目标移动并抬枪修正下坠',
    params: {
      target: { type: 'string', required: true, def: 'zombie' },
      max_shots: { type: 'number', min: 1, max: 30, def: 12 },
    },
    async run({ actions, ctx, params }) {
      const target = requireParam(params, 'target', { type: 'string', def: 'zombie' });
      const shots = requireParam(params, 'max_shots', { def: 12 });
      const r = await actions.attackRanged({ target, maxShots: shots, signal: ctx.signal });
      const note = r.killed
        ? `射死了 ${r.target}（用了 ${r.shots} 箭）`
        : `没射死：${r.reason || '原因不明'}`;
      return skillResult(!!r.killed, {
        steps: [{ action: 'shoot', ok: !!r.killed, detail: note }],
        note,
      });
    },
  },

  /**
   * 举盾格挡。
   */
  shield: {
    label: '举盾',
    description: '举起盾牌挡伤害（需要盾牌）',
    params: { hold_seconds: { type: 'number', min: 1, max: 15, def: 3 } },
    async run({ actions, ctx, params }) {
      const secs = requireParam(params, 'hold_seconds', { def: 3 });
      const r = await actions.raiseShield({ signal: ctx.signal, holdMs: secs * 1000 });
      return skillResult(true, {
        steps: [{ action: 'shield', ok: true, detail: r.note }],
        note: r.note,
      });
    },
  },

};

// The same preparation lease follows dependencies into wood/mining/gathering.
// Ordinary owner requests keep their existing search behavior by default.
for (const name of ['make_tools', 'cook_food', 'food_chain', 'smelt', 'craft']) {
  const skill = SKILLS[name], run = skill.run;
  skill.params = { ...skill.params, home: { type: 'object', def: null },
    allow_search: { type: 'boolean', def: true }, safe_search: { type: 'boolean', def: false } };
  skill.run = async (options) => {
    const params = options.params || {};
    if (!params.home && params.safe_search !== true && params.allow_search !== false) return run(options);
    return require('./preparation').withPreparation({ ...options, home: params.home || null,
      allowSearch: params.allow_search !== false, safeSearch: params.safe_search === true },
    (ctx) => run({ ...options, ctx }));
  };
}

// Autonomous material gathering must not turn an accepted base into its quarry.
// This outer scope also protects digging performed by implicit tool, fuel and
// return dependencies; explicit building/furniture maintenance keeps its scope.
for (const name of ['chop_tree', 'mine_stone', 'mine_ores', 'collect', 'hunt',
  'make_tools', 'cook_food', 'food_chain', 'smelt', 'craft', 'climb_out']) {
  const skill = SKILLS[name], run = skill.run;
  skill.params = { ...skill.params, protected_home: { type: 'object', def: null } };
  skill.run = (options) => require('./mining_return').withProtectedHome(options,
    (ctx) => run({ ...options, ctx }));
}

function get(name) {
  return SKILLS[String(name || '').trim()] || null;
}

function names() {
  return Object.keys(SKILLS);
}

/** 供 LLM 工具描述用：列出技能与参数 */
function describeAll() {
  return names().map((n) => {
    const s = SKILLS[n];
    const ps = Object.entries(s.params || {})
      .map(([k, v]) => `${k}${v.required ? '(必填)' : `=${v.def}`}`)
      .join(', ');
    return `${n}(${ps})：${s.description}`;
  });
}

module.exports = {
  SKILLS,
  get,
  names,
  describeAll,
  SkillContext,
  skillResult,
  mergeCounts,
  positiveOnly,
  driveUntil,
  settle,
};
