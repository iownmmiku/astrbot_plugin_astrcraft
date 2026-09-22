const { StationMemory } = require('../engine/stations');
const fs = require('fs'); const path = require('path'); const os = require('os');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
const f = path.join(dir, 'stations.json');
let pass = 0, fail = 0;
const ok = (m, c, d='') => { if (c) { pass++; console.log(`  ✅ ${m}${d?' — '+d:''}`); } else { fail++; console.log(`  ❌ ${m}${d?' — '+d:''}`); } };

const sm = new StationMemory({ file: f });
ok('新记忆是空的', sm.all().length === 0);
sm.remember('crafting_table', { x: 100, y: 64, z: 200 });
sm.remember('furnace', { x: 102, y: 64, z: 200 });
ok('记下两个工作站', sm.all().length === 2);
sm.remember('crafting_table', { x: 100, y: 64, z: 200 });
ok('同一位置不会重复记', sm.all().length === 2);
ok('不认识的东西不记（防脏数据）', sm.remember('diamond_block', { x: 1, y: 2, z: 3 }) === false);
const n = sm.nearest('crafting_table', { x: 130, y: 64, z: 200 });
ok('能按距离找到最近的', n && n.x === 100, n ? `距 ${n.distance} 格` : 'null');
ok('找不到的种类返回 null', sm.nearest('chest', { x: 0, y: 0, z: 0 }) === null);
ok('渲染成给模型看的文本', sm.render({ x: 100, y: 64, z: 200 }).includes('crafting_table'));

// 持久化
const sm2 = new StationMemory({ file: f });
ok('重启后还记得（落盘生效）', sm2.all().length === 2, `${sm2.all().length} 个`);
sm2.forget('furnace', { x: 102, y: 64, z: 200 });
ok('能忘掉（方块被拆时）', sm2.nearest('furnace', { x: 0, y: 0, z: 0 }) === null);

// 上限
const sm3 = new StationMemory({});
for (let i = 0; i < 20; i++) sm3.remember('chest', { x: i * 10, y: 64, z: 0 });
ok('每种有上限（不会无限膨胀）', sm3.all().length <= 8, `${sm3.all().length} 个`);

console.log(`\n=== 结果：${pass} 通过，${fail} 失败 ===`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail > 0 ? 1 : 0);
