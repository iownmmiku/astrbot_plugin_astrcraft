'use strict';
/**
 * 蓝图建造：**照着图纸搭，而不是只会盖方盒子**。
 *
 * ## 为什么要它
 *
 * 原来的 `build_shelter` 只会盖"四堵墙 + 一个顶"的方盒子：没有窗、没有屋檐、
 * 没有内部隔断，门和火把的位置也是写死的。用户要的是"建一个像样的房间"。
 *
 * 做法是“给一张图纸就照着搭”，
 * 但**图纸由 LLM 自己写**（它本来就是最会设计的那个），工具只负责把它变成方块。
 * 这样"盖什么样的房子"就不再受我写死的代码限制。
 *
 * ## 图纸格式（刻意做成模型容易写的形状）
 *
 * ```json
 * {
 *   "name": "小屋",
 *   "size": [5, 4, 5],
 *   "palette": { "S": "cobblestone", "P": "oak_planks", "D": "oak_door", "T": "torch", ".": null },
 *   "layers": [
 *     ["SSSSS", "S...S", "S...S", "S...S", "SSSSS"],
 *     ["S...S", ".....", ".....", ".....", "S...S"],
 *     ["SPPPS", "P...P", "P...P", "P...P", "SPPPS"],
 *     ["PPPPP", "PPPPP", "PPPPP", "PPPPP", "PPPPP"]
 *   ]
 * }
 * ```
 *
 * - `layers[0]` 是**最底下一层**，往上依次。
 * - 每个字符串是一行（z 方向），每个字符是一个格子（x 方向）。
 * - `palette` 把字符映射成方块名；映射到 `null` 的字符表示"留空"（不放置）。
 * - 字符可以重复用（`.` 习惯上表示空气）。
 *
 * 这个格式的好处：模型写起来像画画，人读起来也直观，而且**可以校验**
 * （尺寸对不对、材料够不够、有没有悬空）。
 */

const log = require('../log');
const { delay, distance, CancelledError, vec3 } = require('../util');
const { ActionError, MissingItemError } = require('../actions');

/**
 * 读某一格的方块。
 *
 * 直接传 `{x,y,z}` 会抛 "pos.floored is not a function"（mineflayer 内部用 Vec3 方法），
 * 所以必须用 vec3() 包一层——这是本仓库里所有方块查询的统一做法。
 * （common.js 并不导出 blockAt，building.js 也是自己定义一份。）
 */
function blockAt(bot, x, y, z) {
  try {
    return bot.blockAt(vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
  } catch {
    return null;
  }
}

/** 内置图纸：先用它们把"能盖出像样的东西"这件事立住，模型也能参考着改 */
const PRESETS = {
  // 5×4×5 的小屋：石基 + 两层木墙（带窗、带门）+ 木屋顶
  //
  // **图纸设计上踩过的坑（留着当例子）**：第一版我把第 1 层只放了四角
  // （`S...S` / `.....` 那种），结果上一层 的墙、门、窗**下面是空的**，
  // 放置时报"周围没有可以依附的方块"，21 块墙都没搭上去。
  // 教训：**每一层的每个方块都得有支撑**，别留"空中楼阁"。
  //
  // 门占两格高：下层写 D，上一层同位置要写 `.`（门的上一半已经在那儿了）。
  hut: {
    name: '石基小屋',
    size: [5, 4, 5],
    palette: {
      S: 'cobblestone',
      P: 'oak_planks',
      G: 'glass',
      D: 'oak_door',
      T: 'torch',
      '.': null,
    },
    layers: [
      // L0 地基：整块铺满，结实
      ['SSSSS', 'SSSSS', 'SSSSS', 'SSSSS', 'SSSSS'],
      // L1 墙：两扇窗（G）、一扇门（D）
      ['SPGPS', 'P...P', 'P.D.P', 'P...P', 'SPGPS'],
      // L2 墙：门的上半格留空（D 占两格高），其余照旧
      ['SPGPS', 'P...P', 'P...P', 'P...P', 'SPGPS'],
      // L3 屋顶：封满 + 两个火把
      ['PPPPP', 'PPPPP', 'PPTTP', 'PPPPP', 'PPPPP'],
    ],
  },
  // 7×3×5 的长屋：一间大屋 + 中间隔断，适合当"家"
  lodge: {
    name: '长屋',
    size: [7, 3, 5],
    palette: {
      S: 'cobblestone',
      P: 'oak_planks',
      G: 'glass',
      D: 'oak_door',
      T: 'torch',
      '.': null,
    },
    layers: [
      // L0 地基铺满
      ['SSSSSSS', 'SSSSSSS', 'SSSSSSS', 'SSSSSSS', 'SSSSSSS'],
      // L1 墙：两扇窗 + 一扇门（门的上半格在 L2 留空）
      ['SPPPPPS', 'P.....P', 'P.D...P', 'P.....P', 'SPPPPPS'],
      // L2 屋顶 + 两个火把
      ['PPPPPPP', 'PPPPPPP', 'PPTTPPP', 'PPPPPPP', 'PPPPPPP'],
    ],
  },
  // 9×5×9 的小塔：能爬上去看远处
  tower: {
    name: '瞭望塔',
    size: [9, 5, 9],
    palette: { S: 'cobblestone', P: 'oak_planks', T: 'torch', '.': null },
    layers: [
      ['SSSSSSSSS', 'S.......S', 'S.......S', 'S.......S', 'S.......S', 'S.......S', 'S.......S', 'S.......S', 'SSSSSSSSS'],
      ['S.......S', '.........', '.........', '.........', '.........', '.........', '.........', '.........', 'S.......S'],
      ['S.......S', '.........', '.........', '.........', '.........', '.........', '.........', '.........', 'S.......S'],
      ['S.......S', '.........', '.........', '.........', '.........', '.........', '.........', '.........', 'S.......S'],
      ['PPPPPPPPP', 'PPPPPPPPP', 'PPPPPPPPP', 'PPPPPPPPP', 'PPPPPPPPP', 'PPPPTPPPP', 'PPPPPPPPP', 'PPPPPPPPP', 'PPPPPPPPP'],
    ],
  },
};

/**
 * 校验图纸。返回 {ok, problems[]}。
 *
 * 校验很重要：模型写的图纸经常有尺寸对不上、用了未定义的字符、
 * 或者整栋房子悬空。**在动第一块方块之前就把问题说清楚**，
 * 比盖到一半发现对不上好得多（也省材料）。
 */
function validateSpec(spec) {
  const problems = [];
  if (!spec || typeof spec !== 'object') return { ok: false, problems: ['图纸不是一个对象'] };
  const size = spec.size;
  if (!Array.isArray(size) || size.length !== 3) {
    problems.push('size 必须是 [宽(x), 高(y), 深(z)]');
    return { ok: false, problems };
  }
  const [w, h, d] = size.map((n) => Math.floor(Number(n)));
  if (!(w > 0 && h > 0 && d > 0)) problems.push(`size 有非正数：${JSON.stringify(size)}`);
  if (w > 32 || h > 32 || d > 32) problems.push(`尺寸太大（${w}×${h}×${d}），上限 32`);
  const layers = spec.layers;
  if (!Array.isArray(layers) || !layers.length) {
    problems.push('layers 必须是非空数组');
    return { ok: false, problems: problems.length ? problems : ['图纸有问题'] };
  }
  if (layers.length !== h) problems.push(`layers 有 ${layers.length} 层，但 size 说高 ${h}`);
  const palette = spec.palette || {};
  layers.forEach((layer, li) => {
    if (!Array.isArray(layer)) {
      problems.push(`第 ${li} 层不是数组`);
      return;
    }
    if (layer.length !== d) problems.push(`第 ${li} 层有 ${layer.length} 行，但 size 说深 ${d}`);
    layer.forEach((row, ri) => {
      if (typeof row !== 'string') {
        problems.push(`第 ${li} 层第 ${ri} 行不是字符串`);
        return;
      }
      if (row.length !== w) problems.push(`第 ${li} 层第 ${ri} 行长 ${row.length}，但 size 说宽 ${w}`);
      for (const ch of row) {
        if (!(ch in palette)) problems.push(`字符「${ch}」没有在 palette 里定义（第 ${li} 层第 ${ri} 行）`);
      }
    });
  });
  return { ok: problems.length === 0, problems: [...new Set(problems)].slice(0, 8) };
}

/** 数一数要多少材料（给"材料够不够"用） */
function countMaterials(spec) {
  const need = new Map();
  for (const layer of spec.layers || []) {
    for (const row of layer || []) {
      for (const ch of String(row)) {
        const name = (spec.palette || {})[ch];
        if (!name) continue;
        need.set(name, (need.get(name) || 0) + 1);
      }
    }
  }
  return need;
}

/**
 * 把图纸里"要放"的格子列出来。
 *
 * 排序规则（**很关键，直接决定能不能搭上去**）：
 *   1. **自下而上**：下面的层先放，上面的层才有东西可依附。
 *   2. 同一层内**从边缘往里**（离本层中心由远到近）。
 *      MC 要求每个方块至少有一个相邻实体方块才能放置；屋顶中间那几格
 *      正下方是空气（屋里），只能靠**旁边已经放好的那块**依附。
 *      早期按"离原点近"排序，等于可能先放中间——实测会报
 *      "周围没有可以依附的方块"。从边缘往里就永远有邻居可依附。
 */
function listPlacements(spec, origin) {
  const out = [];
  const [w, h, d] = spec.size;
  const cxm = (w - 1) / 2;
  const czm = (d - 1) / 2;
  for (let y = 0; y < h; y += 1) {
    const layer = spec.layers[y] || [];
    for (let z = 0; z < d; z += 1) {
      const row = String(layer[z] || '');
      for (let x = 0; x < w; x += 1) {
        const ch = row[x];
        const name = (spec.palette || {})[ch];
        if (!name) continue;
        out.push({
          x: origin.x + x,
          y: origin.y + y,
          z: origin.z + z,
          name,
          ch,
          // 到本层中心的距离：越大越靠边，越该先放
          edge: Math.hypot(x - cxm, z - czm),
        });
      }
    }
  }
  out.sort((a, b) => a.y - b.y || b.edge - a.edge);
  return out;
}

/**
 * 放一块方块，失败就重试一次。
 *
 * 为什么要重试：MC 服务端偶尔会拒绝一次放置（"Server refused to place"）——
 * 实测门就是这样：明明位置对、材料够，第一次被拒，隔一下再放就成了。
 * 这**不是**掩盖错误：重试还是失败会照实报出去，并且记进 `failed` 列表。
 */
async function placeWithRetry(actions, cell, ctx) {
  try {
    await actions.place({ x: cell.x, y: cell.y, z: cell.z, item: cell.name, signal: ctx.signal });
    return;
  } catch (err) {
    if (err instanceof CancelledError) throw err;
    log.debug(`放 ${cell.name} 第一次被拒（${err.message}），隔一下再试`);
    await delay(400, { signal: ctx.signal });
    await actions.place({ x: cell.x, y: cell.y, z: cell.z, item: cell.name, signal: ctx.signal });
  }
}

/**
 * 照图纸建造。
 *
 * @param {object} o
 * @param {object} o.spec 图纸
 * @param {{x:number,y:number,z:number}} o.origin 起点（图纸的左下前角）
 * @returns {Promise<object>} 建造报告
 */
async function buildFromSpec({ actions, nav, ctx, spec, origin }) {
  const check = validateSpec(spec);
  if (!check.ok) {
    throw new ActionError(`图纸有问题，不能开工：\n  · ${check.problems.join('\n  · ')}`);
  }
  const [w, h, d] = spec.size.map((n) => Math.floor(Number(n)));
  const placements = listPlacements(spec, origin);
  const need = countMaterials(spec);

  // 材料检查：**先看够不够，不够就如实说**（别盖到一半停在那儿）
  const missing = [];
  for (const [name, n] of need.entries()) {
    const have = actions.countItem(name);
    if (have < n) missing.push(`${name} 需要 ${n} 个，只有 ${have} 个`);
  }
  if (missing.length) {
    throw new MissingItemError(
      `材料不够，先备齐再来（要 ${[...need.entries()].map(([k, v]) => `${k}×${v}`).join('、')}）`,
      missing.join('；') + '。可以先用 mc_collect / mc_craft 补齐，或者把图纸改小一点',
    );
  }

  const placed = [];
  const skipped = [];
  const failed = [];
  let idx = 0;

  for (const cell of placements) {
    if (ctx.signal && ctx.signal.aborted) throw new CancelledError();
    idx += 1;
    if (idx % 10 === 0) {
      ctx.progress(`照图纸建造 ${idx}/${placements.length}（第 ${cell.y - origin.y + 1}/${h} 层）`);
    }
    // 已经是目标方块就跳过：让建造**可中断、可续建**（第二次跑不会白费材料）
    const cur = blockAt(actions.bot, cell.x, cell.y, cell.z);
    if (cur && cur.name === cell.name) {
      skipped.push(cell);
      continue;
    }
    try {
      // 走到够得着的地方再放（4.5 格是 MC 的放置距离）
      const me = actions.bot.entity.position;
      if (distance(me, { x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 }) > 4) {
        try {
          await nav.goTo({
            x: cell.x,
            y: null,
            z: cell.z,
            range: 3,
            signal: ctx.signal,
            timeoutMs: 15000,
            segmented: false,
          });
        } catch (err) {
          if (err instanceof CancelledError) throw err;
          log.info(`走到 (${cell.x}, ${cell.z}) 失败，就地试着放：${err.message}`);
        }
      }
      await placeWithRetry(actions, cell, ctx);
      placed.push(cell);
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      // 单个格子失败不该让整栋房子算失败：记下来继续（最后如实报告哪几格没成）
      failed.push({ ...cell, reason: String(err.message || err).slice(0, 60) });
      log.info(`放 ${cell.name} @ (${cell.x},${cell.y},${cell.z}) 失败：${err.message}`);
    }
    await delay(60, { signal: ctx.signal });
  }

  return {
    spec_name: spec.name || '（未命名图纸）',
    size: [w, h, d],
    total: placements.length,
    placed: placed.length,
    skipped: skipped.length,
    failed: failed.length,
    failed_cells: failed.slice(0, 6),
    origin,
    note:
      `照图纸搭完了「${spec.name || '未命名'}」：${w}×${h}×${d}，` +
      `放了 ${placed.length} 块、跳过 ${skipped.length} 块（已经是了）、${failed.length} 块没放成` +
      (failed.length ? `（前几个：${failed.slice(0, 3).map((f) => `(${f.x},${f.y},${f.z})${f.reason}`).join('；')}）` : ''),
  };
}

module.exports = { buildFromSpec, validateSpec, countMaterials, listPlacements, PRESETS };
