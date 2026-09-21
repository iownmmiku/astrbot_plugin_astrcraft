'use strict';
/**
 * 向正在运行的 Minecraft 服务端发送控制台指令（走 RCON 协议）。
 *
 * 为什么用 Node 写而不是 PowerShell：Windows PowerShell 5.1 默认按 GBK 读取 .ps1，
 * 脚本里的中文注释会被解码成乱码，进而把引号吃掉导致语法错误。Node 读 UTF-8 没有这个问题。
 *
 * 用途：给测试造场景——给机器人发物品、设置时间与天气、生成结构等。
 *
 * 用法：
 *   node tools/rcon.js --port 25576 "list"
 *   node tools/rcon.js --port 25576 --cmd "give AstrBotSkill cobblestone 64" --cmd "time set day"
 *   node tools/rcon.js --port 25576 --dir "D:\path\to\server" "list"
 */

const net = require('net');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let rconPort = null;
let serverDir = null;
let host = '127.0.0.1';
const commands = [];

for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === '--port') {
    rconPort = Number(args[++i]);
  } else if (a === '--dir') {
    serverDir = args[++i];
  } else if (a === '--host') {
    host = args[++i];
  } else if (a === '--cmd') {
    commands.push(args[++i]);
  } else {
    commands.push(a);
  }
}

/** 从 server.properties 里读 rcon 配置 */
function readRconConfig(dir) {
  const file = path.join(dir, 'server.properties');
  if (!fs.existsSync(file)) throw new Error(`找不到 ${file}`);
  const cfg = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*)$/);
    if (m) cfg[m[1].trim()] = m[2].trim();
  }
  return cfg;
}

/** Minecraft RCON 协议：长度(4) + 请求ID(4) + 类型(4) + 载荷 + \0\0 */
function packet(id, type, body) {
  const bodyBuf = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(4 + 4 + 4 + bodyBuf.length + 2);
  buf.writeInt32LE(4 + 4 + bodyBuf.length + 2, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  bodyBuf.copy(buf, 12);
  buf.writeUInt8(0, 12 + bodyBuf.length);
  buf.writeUInt8(0, 13 + bodyBuf.length);
  return buf;
}

function parsePacket(buf) {
  const len = buf.readInt32LE(0);
  const id = buf.readInt32LE(4);
  const type = buf.readInt32LE(8);
  const body = buf.toString('utf8', 12, 4 + len - 2);
  return { id, type, body };
}

/** 发一条指令，返回服务端回显 */
function sendCommand(socket, id, password, cmd) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let stage = 'auth';

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const len = buffer.readInt32LE(0);
        if (buffer.length < 4 + len) break;
        const pkt = parsePacket(buffer);
        buffer = buffer.subarray(4 + len);

        if (stage === 'auth') {
          if (pkt.id === -1) {
            cleanup();
            reject(new Error('rcon 认证失败：密码不对'));
            return;
          }
          stage = 'command';
          socket.write(packet(id + 1, 2, cmd));
        } else {
          cleanup();
          resolve(pkt.body);
        }
      }
    };

    const cleanup = () => socket.off('data', onData);
    socket.on('data', onData);
    socket.write(packet(id, 3, password));
  });
}

async function main() {
  let dir = serverDir;
  if (!rconPort || !dir) {
    // 没给端口时按约定推断：默认读测试服的配置
    if (!dir) dir = path.join(__dirname, '..', '.testserver');
    const cfg = readRconConfig(dir);
    if (!rconPort) rconPort = Number(cfg['rcon.port'] || 25575);
    var password = cfg['rcon.password'];
    if (cfg['enable-rcon'] !== 'true') {
      throw new Error(`${dir}\\server.properties 里 enable-rcon 不是 true，服务端没有开 rcon`);
    }
  }
  if (!password) {
    const cfg = readRconConfig(dir);
    password = cfg['rcon.password'];
  }
  if (!commands.length) {
    console.log('用法：node tools/rcon.js --port <rcon端口> [--dir <服务端目录>] "<指令>" [--cmd "<指令>"]');
    console.log(`当前配置：host=${host} port=${rconPort} dir=${dir}`);
    process.exit(1);
  }

  const socket = net.createConnection({ host, port: rconPort });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
    setTimeout(() => reject(new Error(`连接 rcon ${host}:${rconPort} 超时`)), 5000);
  });

  let id = 1;
  for (const cmd of commands) {
    try {
      const out = await sendCommand(socket, id, password, cmd);
      id += 2;
      console.log(`> ${cmd}`);
      if (out) console.log(`  ${out.trim()}`);
    } catch (err) {
      console.error(`指令失败「${cmd}」：${err.message}`);
      socket.destroy();
      process.exit(1);
    }
  }
  socket.end();
}

main().catch((err) => {
  console.error(`rcon 出错：${err.message}`);
  process.exit(1);
});
