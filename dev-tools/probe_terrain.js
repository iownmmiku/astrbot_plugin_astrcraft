'use strict';
/** 诊断：正常地形下，机器人的区块是否加载、脚下的方块能不能读到、附近有没有石头。 */

const { spawn } = require('child_process');
const path = require('path');

class C {
  constructor() {
    this.child = spawn(process.execPath, [path.join(__dirname, '..', 'engine', 'index.js')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, MC_ENGINE_LOG_LEVEL: 'debug' },
    });
    this.buf = '';
    this.id = 1;
    this.pending = new Map();
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (c) => {
      this.buf += c;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.method === 'notice') continue;
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          if (m.error) p.reject(new Error(m.error.message));
          else p.resolve(m.result);
        }
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', () => {});
  }
  call(method, params = {}, t = 60000) {
    const id = this.id++;
    return new Promise((res, rej) => {
      const tm = setTimeout(() => rej(new Error('rpc-timeout ' + method)), t);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(tm);
          res(v);
        },
        reject: (e) => {
          clearTimeout(tm);
          rej(e);
        },
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  kill() {
    try {
      this.child.kill();
    } catch {
      /* ignore */
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const c = new C();
  const USER = 'DiagBot' + Math.floor(Math.random() * 9000);
  await c.call('connect', { host: '127.0.0.1', port: 25566, version: '1.20.1', username: USER }, 60000);
  await sleep(6000);

  const st = await c.call('state.get', { detail: 'brief' });
  const bp = st.block_position;
  console.log('位置:', JSON.stringify(bp), '脚下:', st.standing_on);
  console.log('维度:', st.dimension);

  console.log('\n=== 逐格读脚下附近的方块 ===');
  for (let dy = 1; dy >= -6; dy -= 1) {
    const b = await c.call('block.at', { x: bp.x, y: bp.y - dy, z: bp.z });
    console.log(`  y=${bp.y - dy}: ${b ? b.name : '❌ null（区块没加载）'}`);
  }

  console.log('\n=== 附近扫描 ===');
  for (const [name, radius] of [['stone', 16], ['stone', 40], ['cobblestone', 16], ['dirt', 16]]) {
    try {
      const r = await c.call('block.scan', { names: [name], radius, limit: 5 }, 30000);
      console.log(`  ${name}（半径 ${radius}）: 找到 ${r.count} 个`, r.blocks && r.blocks[0] ? JSON.stringify(r.blocks[0]) : '');
    } catch (e) {
      console.log(`  ${name}（半径 ${radius}）: ❌ ${e.message}`);
    }
  }

  console.log('\n=== 诊断 standability（能不能站立）===');
  try {
    const s = await c.call('debug.standability', { radius: 2 });
    console.log('  ', JSON.stringify(s).slice(0, 200));
  } catch (e) {
    console.log('  ❌', e.message);
  }

  await c.call('disconnect').catch(() => {});
  await sleep(300);
  c.kill();
  process.exit(0);
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
