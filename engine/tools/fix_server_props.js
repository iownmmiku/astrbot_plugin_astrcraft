'use strict';
/**
 * 修正 server.properties 里被转义的 generator-settings。
 *
 * 症状：文件里出现 `{"layers"\:[{"block"\:"minecraft:bedrock"...` 这种带反斜杠的形式。
 * 服务端解析失败后不会报错，而是**回退成默认的平坦/普通世界**，表现为
 * "明明配了 4 层超平坦，机器人却掉到 y=-63"、寻路在原地失败。
 * 这个坑排查了两轮才定位到，所以单独写成脚本，避免再靠手工编辑。
 *
 * 用法：node tools/fix_server_props.js [服务端目录]
 */

const fs = require('fs');
const path = require('path');

const dir = process.argv[2] || path.join(__dirname, '..', '.testserver');
const file = path.join(dir, 'server.properties');
if (!fs.existsSync(file)) {
  console.error('找不到 ' + file);
  process.exit(1);
}

const layers = {
  layers: [
    { block: 'minecraft:bedrock', height: 1 },
    { block: 'minecraft:dirt', height: 2 },
    { block: 'minecraft:grass_block', height: 1 },
  ],
  biome: 'minecraft:plains',
};
const cleanJson = JSON.stringify(layers);

const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
const out = [];
let seenGen = false;
let fixed = 0;

for (const line of lines) {
  const m = line.match(/^(\s*generator-settings\s*=\s*)(.*)$/);
  if (m) {
    if (seenGen) continue; // 去掉重复键
    seenGen = true;
    out.push(`${m[1]}${cleanJson}`);
    if (m[2] !== cleanJson) fixed += 1;
    continue;
  }
  // 顺带清理 level-type 的重复项
  out.push(line);
}
if (!seenGen) {
  out.push(`generator-settings=${cleanJson}`);
  fixed += 1;
}

fs.writeFileSync(file, out.join('\n'), 'utf8');

console.log(fixed > 0 ? '已修正 generator-settings' : 'generator-settings 本来就是正确的');
for (const l of out.filter((x) => /^(level-type|generator-settings|level-name|server-port)=/.test(x))) {
  console.log('  ' + (l.length > 120 ? l.slice(0, 117) + '...' : l));
}
