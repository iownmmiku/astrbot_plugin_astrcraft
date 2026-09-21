'use strict';
/**
 * 技能注册表：把技能名映射到实现，并负责参数校验。
 *
 * 这里的技能名会直接暴露给 LLM 当工具名，所以：
 *   - 名字要能自解释（mc_chop_tree 比 mc_skill_1 好一万倍）
 *   - 缺参数要给出**可执行**的报错，而不是 undefined 崩溃
 */

const { SkillContext, skillResult, mergeCounts, positiveOnly, driveUntil, settle } = require('./common');
const wood = require('./wood');
const mining = require('./mining');
const building = require('./building');
const gathering = require('./gathering');
const blueprint = require('./blueprint');

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
      return mining.smeltOres({ actions, nav, state, ctx, item, count });
    },
  },

  build_shelter: {
    label: '建庇护所',
    description: '选一块平地，盖一个有墙、有屋顶、有门、有火把的小屋（材料不够会自己去挖）',
    params: { size: { type: 'number', min: 2, max: 6, def: 3 }, roof: { type: 'boolean', def: true }, door: { type: 'boolean', def: true }, torch: { type: 'boolean', def: true } },
    async run({ actions, nav, state, ctx, params }) {
      return building.buildShelter({
        actions,
        nav,
        state,
        ctx,
        size: requireParam(params, 'size', { def: 3 }),
        roof: params.roof !== false,
        door: params.door !== false,
        torch: params.torch !== false,
      });
    },
  },

  store_items: {
    label: '存东西',
    description: '把背包里的东西存进箱子（附近没有箱子就做一个）',
    params: { items: { type: 'array', def: null }, keep: { type: 'array', def: null } },
    async run({ actions, nav, state, ctx, params }) {
      return gathering.storeItems({
        actions,
        nav,
        state,
        ctx,
        items: params.items ? requireParam(params, 'items', { type: 'array' }) : null,
        keep: params.keep ? requireParam(params, 'keep', { type: 'array' }) : ['torch', 'crafting_table', 'furnace'],
      });
    },
  },

  cook_food: {
    label: '准备食物',
    description: '打猎并把生肉烤熟，保证有东西吃',
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
    description: '一次性把"食物 + 工具 + 火把"补齐，适合长时间离开基地前使用',
    params: {},
    async run({ actions, nav, state, ctx }) {
      const steps = [];
      const produced = {};
      const food = await gathering.cookFood({ actions, nav, state, ctx, count: 4 });
      steps.push(...food.steps);
      Object.assign(produced, food.produced);
      const pick = mining.bestPickaxeTier(actions);
      if (!pick) {
        const tier = actions.countItem('cobblestone') >= 11 ? 'stone' : 'wooden';
        const tools = await wood.makeTools({ actions, nav, state, ctx, tier });
        steps.push(...tools.steps);
        Object.assign(produced, tools.produced);
      }
      if (actions.countItem('torch') < 4 && (actions.countItem('coal') > 0 || actions.countItem('charcoal') > 0)) {
        try {
          await actions.craft({ item: 'torch', count: 8, signal: ctx.signal });
          steps.push('合成火把');
          produced.torch = (produced.torch || 0) + 8;
        } catch {
          /* 不致命 */
        }
      }
      return skillResult(true, { steps, produced, note: `补给完成：${Object.entries(produced).map(([k, v]) => `${k}×${v}`).join('、') || '无新增'}` });
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
    params: { timeout_seconds: { type: 'number', min: 30, max: 600, def: 120 } },
    async run({ actions, ctx, params }) {
      const secs = requireParam(params, 'timeout_seconds', { def: 120 });
      const r = await actions.sleepInBed({ signal: ctx.signal, timeoutMs: secs * 1000 });
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
