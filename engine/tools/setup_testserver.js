// 用可加载的 level-type=flat + 干净的 generator-settings 重建超平坦测试服配置。
// 之前用 PowerShell 追加属性时把冒号转义成了 `\:`，导致服务端解析失败。
// 这个脚本直接用 fs 写文件，避免任何 shell 转义问题。
const fs = require('fs');
const path = require('path');
const os = require('os');

const dir = process.argv[2] || path.join(__dirname, '..', '.testserver');
const propsPath = path.join(dir, 'server.properties');
if (!fs.existsSync(propsPath)) {
  console.error('not found: ' + propsPath);
  process.exit(1);
}

// 需要覆盖/确保存在的键
const overrides = {
  'server-port': '25566',
  'level-name': 'flatworld',
  'level-type': 'flat',
  'generator-settings': JSON.stringify({
    layers: [
      { block: 'minecraft:bedrock', height: 1 },
      { block: 'minecraft:dirt', height: 2 },
      { block: 'minecraft:grass_block', height: 1 },
    ],
    biome: 'minecraft:plains',
  }),
  'online-mode': 'false',
  'enforce-secure-profile': 'false',
  'gamemode': 'survival',
  difficulty: 'peaceful', // 测试用：不主动攻击，减少噪音
  'spawn-monsters': 'false',
  'spawn-protection': '0',
  'enable-rcon': 'true',
  'rcon.port': '25576',
  'rcon.password': 'mcengine',
  'view-distance': '8',
  'simulation-distance': '8',
  'allow-flight': 'false',
  // 关掉"玩家空闲踢出"。测试与挂机场景下机器人可能长时间不发包（例如等熔炼），
  // 开着会把它当成挂机玩家踢掉，干扰验证。
  'player-idle-timeout': '0',
  'max-players': '20',
  'motd': 'MC Engine Test (flat)',
};

const lines = fs.readFileSync(propsPath, 'utf8').split(/\r?\n/);
const seen = new Set();
const out = [];
for (const line of lines) {
  const m = line.match(/^\s*([^#=]+?)\s*=(.*)$/);
  if (m) {
    const key = m[1].trim();
    if (key in overrides) {
      if (seen.has(key)) continue; // 去掉重复键，只保留第一次
      seen.add(key);
      out.push(`${key}=${overrides[key]}`);
      continue;
    }
    out.push(line);
    continue;
  }
  out.push(line);
}
for (const [k, v] of Object.entries(overrides)) {
  if (!seen.has(k)) out.push(`${k}=${v}`);
}

fs.writeFileSync(propsPath, out.join(os.EOL), 'utf8');

console.log('已重写 ' + propsPath);
for (const k of ['server-port', 'level-name', 'level-type', 'generator-settings', 'difficulty', 'enable-rcon', 'rcon.port']) {
  const val = out.find((l) => l.startsWith(k + '=')) || '(缺失)';
  console.log('  ' + val);
}

// 顺便清理旧世界，确保地形干净
const world = path.join(dir, overrides['level-name']);
if (fs.existsSync(world)) {
  console.log('\n注意：旧世界仍在 ' + world + '（如需完全重建请手动删除该目录）');
}
