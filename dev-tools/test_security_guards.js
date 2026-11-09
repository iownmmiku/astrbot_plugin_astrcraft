#!/usr/bin/env node
'use strict';

/**
 * 引擎侧两道安全护栏（离线，不需要服务器）：
 *
 * 1. 聊天不能执行服务器命令：minecraft-protocol 的 client.chat 见到 / 开头就改发
 *    chat_command，等于以她的权限执行命令。她是 OP 时，/mc说、mc_say、游戏内提示词注入
 *    都能 /op、/give、/stop。McEngine.chat() 必须拒绝。
 * 2. 观战服务默认只监听本机：原来是 http.listen(port)，不给地址就是所有网卡，
 *    而观战页没有任何登录验证（会暴露视角、坐标、背包）。
 *
 * 观战依赖（prismarine-viewer / express / socket.io）是可选的，这里用替身模块，
 * 只验证"真的 listen 在哪个地址上"。
 */

const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const Module = require('node:module');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { McEngine } = require('../engine/bot');
const { DEFAULTS } = require('../engine/config');
const { vec3 } = require('../engine/util');

const tests = [];
const test = (name, run) => tests.push({ name, run });

function fakeBot() {
  const bot = new EventEmitter();
  Object.assign(bot, {
    username: 'test',
    entity: { position: vec3(0, 64, 0) },
    inventory: { slots: [] },
    said: [],
    chat(text) { this.said.push(text); },
  });
  return bot;
}

function engineWithBot() {
  const engine = new McEngine({ emit: () => {} });
  engine.bot = fakeBot();
  engine.state = { note() {} };
  return engine;
}

// ---------------------------------------------------------------- 1. 聊天
test('以 / 开头的内容不会发出去', () => {
  for (const text of ['/op Steve', '  /stop', '\n/give @a diamond 64', '/me 挥手']) {
    const engine = engineWithBot();
    assert.throws(() => engine.chat(text), /不能通过聊天执行服务器命令/, `应拒绝：${JSON.stringify(text)}`);
    assert.deepEqual(engine.bot.said, [], `不应发出：${JSON.stringify(text)}`);
  }
});

test('普通聊天照常发送（中间带 / 不受影响）', () => {
  const engine = engineWithBot();
  engine.chat('你好');
  engine.chat('坐标 10/64/-20');
  assert.deepEqual(engine.bot.said, ['你好', '坐标 10/64/-20']);
});

test('被拒绝的命令不占用 10 秒 5 句的发言额度', () => {
  const engine = engineWithBot();
  for (let i = 0; i < 6; i += 1) assert.throws(() => engine.chat('/op x'));
  engine.chat('还能说话');
  assert.deepEqual(engine.bot.said, ['还能说话']);
});

// ---------------------------------------------------------------- 2. 观战监听地址
const STUBS = {
  'prismarine-viewer/viewer': { WorldView: class { listenToBot() {} removeListenersFromBot() {} } },
  'prismarine-viewer/lib/common': { setupRoutes() {} },
  express: () => {
    const app = (req, res) => res.end();
    app.get = () => {};
    app.use = () => {};
    return app;
  },
  'socket.io': () => ({ on() {}, close() {} }),
};

function withViewerStubs() {
  const originalLoad = Module._load;
  const originalResolve = Module._resolveFilename;
  Module._load = function load(request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
    return originalLoad.call(this, request, ...rest);
  };
  Module._resolveFilename = function resolve(request, ...rest) {
    if (request === 'prismarine-viewer/package.json') return path.join(__dirname, 'package.json');
    return originalResolve.call(this, request, ...rest);
  };
  const originalListen = http.Server.prototype.listen;
  const calls = [];
  http.Server.prototype.listen = function listen(...args) {
    calls.push(args);
    return originalListen.apply(this, args);
  };
  return {
    calls,
    restore() {
      Module._load = originalLoad;
      Module._resolveFilename = originalResolve;
      http.Server.prototype.listen = originalListen;
    },
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

test('默认配置里观战只听本机', () => {
  assert.equal(DEFAULTS.viewerHost, '127.0.0.1');
});

test('startViewer 把监听地址交给 http.listen（默认 127.0.0.1，可配置）', async () => {
  for (const [configured, expected] of [[undefined, '127.0.0.1'], ['0.0.0.0', '0.0.0.0']]) {
    const stubs = withViewerStubs();
    const engine = engineWithBot();
    try {
      const port = await freePort();
      engine.config.update({ viewerPort: port, ...(configured ? { viewerHost: configured } : {}) });
      const info = await engine.startViewer();
      assert.equal(info.running, true);
      assert.equal(info.host, expected);
      const listenArgs = stubs.calls.find((args) => args[0] === port);
      assert.ok(listenArgs, '应该调用过 http.listen');
      assert.equal(listenArgs[1], expected, `listen 的地址应为 ${expected}，实际 ${listenArgs[1]}`);
    } finally {
      try {
        engine.stopViewer();
      } catch {
        // 关闭失败不影响断言结果
      }
      stubs.restore();
    }
  }
});

(async () => {
  let failed = 0;
  for (const { name, run } of tests) {
    try {
      await run();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed += 1;
      console.log(`  ✗ ${name}\n    ${err && err.stack ? err.stack : err}`);
    }
  }
  console.log(`${tests.length - failed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
