'use strict';
/**
 * 重置超平坦测试世界：停服 → 删世界 → 起服 → 等就绪。
 *
 * 为什么必须这么做：这些测试会真的挖穿地形（挖矿测试要挖通道、合成测试要挖方块），
 * 反复跑几轮之后世界就变成一个满是坑洞的迷宫，机器人会掉进自己挖的洞里、
 * 寻路失败、挖矿找不到目标——**看起来像引擎退化，其实只是测试环境脏了**。
 * 本次开发中就因此误判过一次回归。
 *
 * 用法：
 *   node tools/reset_world.js               # 重置并起服
 *   node tools/reset_world.js --no-start    # 只重置，不起服
 */

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const SERVER_DIR = path.join(__dirname, '..', '.testserver');
const WORLD = path.join(SERVER_DIR, 'flatworld');
const PORT = 25566;
const START = !process.argv.includes('--no-start');
// 默认只删世界；反复改生成配置导致区域文件半生成时，用 --full 连服务端目录一起重建
const FULL = process.argv.includes('--full');
const SOURCE_JAR =
  process.env.MC_SERVER_JAR ||
  'C:\\Users\\miku\\.astrbot\\data\\plugin_data\\astrbot_plugin_minecraft\\server\\server.jar';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 找出占用某端口的 java 进程并结束 */
function killServerOnPort(port) {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 20000 });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (line.includes(`:${port}`) && line.includes('LISTENING')) {
        const m = line.trim().match(/(\d+)$/);
        if (m) pids.add(Number(m[1]));
      }
    }
    for (const pid of pids) {
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/F'], { encoding: 'utf8', timeout: 10000 });
        console.log(`  已结束占用 ${port} 的进程 pid=${pid}`);
      } catch {
        /* ignore */
      }
    }
    return pids.size;
  } catch (err) {
    console.log(`  查找端口占用失败（忽略）：${err.message}`);
    return 0;
  }
}

function waitForPort(port, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tryOnce = () => {
      const sock = net.createConnection({ host: '127.0.0.1', port });
      sock.once('connect', () => {
        sock.destroy();
        resolve(true);
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(tryOnce, 1500);
      });
    };
    tryOnce();
  });
}

(async () => {
  console.log('=== 重置测试世界 ===');
  console.log(`服务端目录：${SERVER_DIR}`);

  console.log('[1] 停掉占用 25566 的服务端');
  killServerOnPort(PORT);
  await sleep(3000);

  if (FULL) {
    // 全量重建：世界生成配置被反复改动后，区域文件可能处于"半生成"状态
    // （同一列既读到实体方块又读到空气），表现极其诡异。
    // 这时只删世界不够，得把服务端目录整个重建。
    console.log('[2] 全量重建服务端目录');
    if (fs.existsSync(SERVER_DIR)) {
      fs.rmSync(SERVER_DIR, { recursive: true, force: true });
      console.log('  已删除 .testserver');
    }
    fs.mkdirSync(SERVER_DIR, { recursive: true });
    if (!fs.existsSync(SOURCE_JAR)) {
      console.error(`❌ 找不到 server.jar 来源：${SOURCE_JAR}\n   可用环境变量 MC_SERVER_JAR 指定`);
      process.exit(1);
    }
    fs.copyFileSync(SOURCE_JAR, path.join(SERVER_DIR, 'server.jar'));
    console.log('  已复制 server.jar');
    fs.writeFileSync(
      path.join(SERVER_DIR, 'eula.txt'),
      '#By changing the setting below to TRUE you are indicating your agreement to our EULA.\neula=true\n',
      'utf8',
    );
    // 用 level-type=flat 的**默认经典超平坦**：不写 generator-settings。
    // 实测在 1.20.1 上手写 generator-settings 的 JSON 会被服务端忽略甚至生成异常地形
    // （出现"基岩层与空气层混在一起"的诡异结果，排查了很久）。
    const props = [
      'server-port=25566',
      'level-name=flatworld',
      'level-type=flat',
      'online-mode=false',
      'enforce-secure-profile=false',
      'gamemode=survival',
      'difficulty=peaceful',
      'spawn-monsters=false',
      'spawn-protection=0',
      'player-idle-timeout=0',
      'enable-rcon=true',
      'rcon.port=25576',
      'rcon.password=mcengine',
      'broadcast-rcon-to-ops=true',
      'view-distance=8',
      'simulation-distance=8',
      'max-players=20',
      'motd=MC Engine Test (flat)',
    ];
    fs.writeFileSync(path.join(SERVER_DIR, 'server.properties'), props.join('\n') + '\n', 'utf8');
    console.log('  已写入 server.properties（默认经典超平坦）');
  } else {
    console.log('[2] 删除旧世界');
    for (const name of ['flatworld', 'flatworld_nether', 'flatworld_the_end']) {
      const p = path.join(SERVER_DIR, name);
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
        console.log(`  已删除 ${name}`);
      }
    }
  }

  if (!START) {
    console.log('（--no-start：不启动服务端）');
    return;
  }

  console.log('[3] 启动服务端');
  const child = spawn('java', ['-Xms512M', '-Xmx1G', '-jar', 'server.jar', 'nogui'], {
    cwd: SERVER_DIR,
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
  console.log(`  已拉起（pid=${child.pid}），等待端口就绪…`);

  const ok = await waitForPort(PORT, 90000);
  if (!ok) {
    console.error('❌ 服务端未在 90 秒内就绪');
    process.exit(1);
  }
  console.log('  端口已就绪');
  // 多等一会儿让世界生成与 RCON 监听完成
  await sleep(4000);
  console.log('✅ 测试世界已重置');
})().catch((err) => {
  console.error('重置失败：', err.message);
  process.exit(1);
});
