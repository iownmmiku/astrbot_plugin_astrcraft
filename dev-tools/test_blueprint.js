'use strict';
/**
 * 蓝图建造的单元测试（不需要服务器）。
 *
 * 用户要的是"能盖出像样的房子"，所以这里钉住的是**建造之前**的每一步：
 *   1. 图纸校验（尺寸对不上、字符没定义、太大 → 都要在开工前拦住）
 *   2. 材料估算（要多少块，够不够）
 *   3. 放置清单（顺序自下而上、数量正确、空气格不占位）
 *   4. 内置图纸本身是合法的（我第一版把中间层只放了四角，
 *      导致上一层悬空、21 块墙都放不上去——这种错必须在测试里拦住）
 */

const { validateSpec, countMaterials, listPlacements, PRESETS } = require('../engine/skills/blueprint');

let pass = 0;
let fail = 0;
const ok = (m, c, d = '') => {
  if (c) {
    pass += 1;
    console.log(`  ✅ ${m}${d ? ` — ${d}` : ''}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${m}${d ? ` — ${d}` : ''}`);
  }
};

console.log('=== 图纸校验 ===');
const good = {
  name: 't',
  size: [3, 2, 3],
  palette: { S: 'cobblestone', '.': null },
  layers: [
    ['SSS', 'S.S', 'SSS'],
    ['SSS', 'SSS', 'SSS'],
  ],
};
ok('合法图纸通过', validateSpec(good).ok);
ok('尺寸不对被拦住', !validateSpec({ ...good, size: [3, 9, 3] }).ok);
ok('层数不对被拦住', !validateSpec({ ...good, layers: [good.layers[0]] }).ok);
ok('行数不对被拦住', !validateSpec({ ...good, layers: [['SS', 'S.S', 'SSS'], good.layers[1]] }).ok);
ok('行长不对被拦住', !validateSpec({ ...good, layers: [['SSSS', 'S.S', 'SSS'], good.layers[1]] }).ok);
ok('未定义的字符被拦住', !validateSpec({ ...good, layers: [['SXS', 'S.S', 'SSS'], good.layers[1]] }).ok);
ok('尺寸过大被拦住', !validateSpec({ ...good, size: [64, 2, 3] }).ok);
const v = validateSpec({ ...good, size: [3, 9, 3] });
ok('报错说得清楚（能照着修）', v.problems.some((p) => p.includes('层')), v.problems[0] || '');

console.log('\n=== 材料估算 ===');
const need = countMaterials(good);
ok('数得对（地基 8 + 顶 9 = 17 块石）', need.get('cobblestone') === 17, `${need.get('cobblestone')} 块`);
ok('空气格不算材料', !need.has(null) && need.size === 1);

console.log('\n=== 放置清单 ===');
const cells = listPlacements(good, { x: 0, y: 0, z: 0 });
ok('数量等于材料数', cells.length === 17, `${cells.length} 格`);
ok('自下而上（先第 0 层）', cells[0].y === 0 && cells[cells.length - 1].y === 1);
ok('空气格不在清单里', !cells.some((c) => c.x === 1 && c.z === 1 && c.y === 0));
ok('坐标是绝对坐标（带 origin 偏移）', listPlacements(good, { x: 10, y: 5, z: 20 }).every((c) => c.x >= 10 && c.y >= 5 && c.z >= 20));

console.log('\n=== 内置图纸 ===');
for (const [key, spec] of Object.entries(PRESETS)) {
  const r = validateSpec(spec);
  ok(`内置图纸 ${key} 合法`, r.ok, r.ok ? `${spec.size.join('×')}` : r.problems.join('; '));
  // **关键**：每个方块至少要有**一个相邻实体方块**才能放置（这是 MC 的规则，
  // 不是"正下方必须有"——屋顶中间正下方是屋里，靠旁边的屋顶块依附就行）。
  // 实测踩过的坑：第一版中间层只放四角 → 上层悬空 → 21 块墙放不上去。
  const at = (y, x, z) => {
    const layer = spec.layers[y];
    if (!layer) return null;
    const row = layer[z];
    if (row === undefined) return null;
    const ch = row[x];
    if (ch === undefined) return null;
    return (spec.palette || {})[ch] || null;
  };
  const lonely = [];
  spec.layers.forEach((layer, y) => {
    layer.forEach((row, z) => {
      for (let x = 0; x < row.length; x += 1) {
        if (!(spec.palette || {})[row[x]]) continue;
        const neigh = [
          at(y - 1, x, z),
          at(y + 1, x, z),
          at(y, x - 1, z),
          at(y, x + 1, z),
          at(y, x, z - 1),
          at(y, x, z + 1),
        ];
        if (!neigh.some(Boolean)) lonely.push(`(${x},${y},${z})`);
      }
    });
  });
  ok(`内置图纸 ${key} 没有孤立方块`, lonely.length === 0, lonely.slice(0, 3).join(' ') || '每块都有邻居可依附');

  // 放置顺序：同一层必须"从边缘往里"，否则屋顶中间先放会没有依附面
  const cells = listPlacements(spec, { x: 0, y: 0, z: 0 });
  let orderOk = true;
  for (let i = 1; i < cells.length; i += 1) {
    if (cells[i].y < cells[i - 1].y) orderOk = false; // 必须自下而上
    if (cells[i].y === cells[i - 1].y && cells[i].edge > cells[i - 1].edge + 1e-9) orderOk = false;
  }
  ok(`内置图纸 ${key} 的放置顺序正确（自下而上 + 从边缘往里）`, orderOk);
}

console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
process.exit(fail > 0 ? 1 : 0);
