'use strict';
/**
 * **观战窗口**：在浏览器里以她的第一视角看她，并且**带玩家 HUD**。
 *
 * ## 为什么自己起 express，而不是直接用 prismarine-viewer 的 mineflayer 入口
 *
 * 那个入口内部建了 express/socket.io 就**不对外暴露**，我没法加路由。
 * 而 HUD 必须和观战页面**同源**——它的客户端是这样连 socket 的：
 *
 *     io({ path: window.location.pathname + "socket.io" })
 *
 * 用的是**页面自己的 origin**，所以 HUD 页面只要不在观战端口上，就永远连不上
 * 世界数据。结论：只能自己建这个服务，把 HUD 路由挂进去。
 *
 * 下面这段"世界渲染"部分照 `node_modules/prismarine-viewer/lib/mineflayer.js`
 * 写的（保持一致才能正常渲染），**新增的是 `/` 和 `/hud` 两个路由**。
 *
 * ## HUD 有什么
 *
 *   - 血量（心）、饱食、经验、护甲
 *   - **快捷栏 9 格**，当前手持那格高亮
 *   - **按 E 打开背包**（36 格全览）
 *   - 位置 / 维度 / 手持物品名
 *
 * ## 诚实说明
 *
 * 物品**不显示贴图**，只显示名字和数量。原因是把"物品名 → 贴图"完整映射对
 * 需要一整套物品模型数据（prismarine-viewer 只带了方块贴图，没带物品贴图），
 * 那是一个独立的工程量。名字+数量在"看她在干什么、背包里有什么"这件事上够用。
 */

const EventEmitter = require('events');
// **观战窗口的依赖是"可选的"**（见 package.json 的 optionalDependencies）。
//
// 为什么：`prismarine-viewer` 连它的传递依赖一共约 316 MB，
// 而观战窗口**默认是关的**（`enable_viewer: false`）——
// 不用它的人不该为此多下 300 多 MB。
//
// 所以这里**不能**在顶层 require：那样引擎一启动就会因为"模块没装"而崩，
// 哪怕用户根本不开观战窗口。改成真正要用的时候才加载。
let WorldView = null;
function loadViewerDeps() {
  if (WorldView) return;
  try {
    ({ WorldView } = require('prismarine-viewer/viewer'));
  } catch (err) {
    throw new Error(
      '观战窗口需要额外依赖，但它们没装（它们是**可选**的，不装不影响正常使用）。\n' +
        '要开观战窗口的话，在 engine/ 目录里执行：\n' +
        '    npm install\n' +
        '（或者只装这几个：npm install prismarine-viewer express socket.io）\n' +
        `原始错误：${err.message}`,
    );
  }
}

/** 把 bot 的背包读成 HUD 能直接用的 JSON */
function readInventory(bot) {
  const slots = (bot.inventory && bot.inventory.slots) || [];
  const toItem = (s) => (s && s.name ? { name: s.name, count: s.count, display: s.displayName || s.name } : null);
  const hotbar = [];
  for (let i = 36; i <= 44; i += 1) hotbar.push(toItem(slots[i]));
  const main = [];
  for (let i = 9; i <= 35; i += 1) main.push({ slot: i - 8, item: toItem(slots[i]) });
  const armor = [];
  for (let i = 5; i <= 8; i += 1) armor.push(toItem(slots[i]));
  return {
    held_slot: Number(bot.quickBarSlot) || 0,
    hotbar,
    main,
    armor,
    offhand: toItem(slots[45]),
  };
}

/** HUD 页面的样式与脚本（内联进 HTML，省一个路由） */
const HUD_CSS = `
#hud { position: fixed; left: 0; right: 0; bottom: 0; z-index: 10; pointer-events: none;
       font: 13px/1.4 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; color: #fff;
       text-shadow: 2px 2px 0 rgba(0,0,0,.75); user-select: none; }
#hud .bar { display: flex; justify-content: center; gap: 22px; align-items: flex-end; margin-bottom: 6px; }
#hud .stat { background: rgba(0,0,0,.42); border-radius: 6px; padding: 3px 10px; }
#hud .hotbar { display: flex; justify-content: center; gap: 4px; margin-bottom: 10px; }
#hud .slot { width: 54px; height: 54px; background: rgba(0,0,0,.45);
             border: 2px solid rgba(255,255,255,.28); border-radius: 4px; position: relative;
             display: flex; align-items: center; justify-content: center; text-align: center;
             font-size: 10px; line-height: 1.15; padding: 2px; box-sizing: border-box; overflow: hidden; }
#hud .slot.held { border-color: #fff; background: rgba(255,255,255,.22); transform: scale(1.08); }
#hud .slot .cnt { position: absolute; right: 3px; bottom: 1px; font-size: 11px; font-weight: 700; }
#hud .hint { text-align: center; margin-bottom: 6px; opacity: .85; }
#inv { position: fixed; inset: 0; z-index: 20; background: rgba(0,0,0,.62);
       display: none; align-items: center; justify-content: center;
       font: 13px/1.4 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; color: #fff; }
#inv.on { display: flex; }
#inv .panel { background: rgba(24,24,28,.96); border: 2px solid #555; border-radius: 10px;
              padding: 18px 22px; max-width: 780px; }
#inv h3 { margin: 0 0 10px; font-size: 15px; font-weight: 600; }
#inv .grid { display: grid; grid-template-columns: repeat(9, 74px); gap: 5px; }
#inv .slot { width: 74px; height: 56px; background: rgba(255,255,255,.07);
             border: 1px solid rgba(255,255,255,.18); border-radius: 4px; position: relative;
             display: flex; align-items: center; justify-content: center; text-align: center;
             font-size: 10.5px; padding: 3px; box-sizing: border-box; overflow: hidden; }
#inv .slot.empty { opacity: .32; }
#inv .slot .cnt { position: absolute; right: 3px; bottom: 1px; font-size: 11px; font-weight: 700; }
#inv .row { margin-top: 10px; }
#inv .tip { margin-top: 12px; opacity: .7; font-size: 12px; }
`;

const HUD_JS = `
(function () {
  var inv = document.getElementById('inv');
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function slotHtml(it, cls) {
    if (!it) return '<div class="slot empty ' + (cls || '') + '"></div>';
    return '<div class="slot ' + (cls || '') + '" title="' + esc(it.name) + '">' +
      esc(it.display || it.name) + (it.count > 1 ? '<span class="cnt">' + it.count + '</span>' : '') + '</div>';
  }
  function hearts(hp, max) {
    var full = Math.round(hp / 2), total = Math.round((max || 20) / 2), out = '';
    for (var i = 0; i < total; i++) out += (i < full ? '\\u2764' : '\\u2661');
    return out + ' ' + hp + '/' + (max || 20);
  }
  function draw(d) {
    var hotbar = (d.hotbar || []).map(function (it, i) {
      return slotHtml(it, i === d.held_slot ? 'held' : '');
    }).join('');
    document.getElementById('hud').innerHTML =
      '<div class="hint">按 <b>E</b> 看背包　|　' + esc(d.username || '') + '　' + esc(d.dimension || '') +
        '　(' + esc(d.position || '') + ')</div>' +
      '<div class="bar">' +
        '<span class="stat">' + hearts(d.health, d.max_health) + '</span>' +
        '<span class="stat">\\uD83C\\uDF57 ' + (d.food == null ? '?' : d.food) + '/20</span>' +
        (d.xp_level ? '<span class="stat">XP ' + d.xp_level + '</span>' : '') +
        '<span class="stat">\\u270B ' + esc(d.held_name || '空手') + '</span>' +
      '</div>' +
      '<div class="hotbar">' + hotbar + '</div>';

    var main = (d.main || []).map(function (s) { return slotHtml(s.item); }).join('');
    var armor = (d.armor || []).map(function (it) { return slotHtml(it); }).join('');
    inv.innerHTML = '<div class="panel"><h3>背包（她的）</h3>' +
      '<div class="grid">' + main + '</div>' +
      '<div class="row"><div class="grid">' + hotbar + '</div></div>' +
      (armor.replace(/empty/g, '') ? '<div class="row"><h3>护甲 / 副手</h3><div class="grid">' + armor + slotHtml(d.offhand) + '</div></div>' : '') +
      '<div class="tip">再按 E 或点空白处关闭</div></div>';
  }
  function poll() {
    fetch('hud').then(function (r) { return r.json(); }).then(draw).catch(function () {});
  }
  document.addEventListener('keydown', function (e) {
    var k = (e.key || '').toLowerCase();
    if (k === 'e' || e.code === 'KeyE') { inv.classList.toggle('on'); e.preventDefault(); }
    if (k === 'escape') inv.classList.remove('on');
  });
  inv.addEventListener('click', function (e) { if (e.target === inv) inv.classList.remove('on'); });
  poll();
  setInterval(poll, 700);
})();
`;

/**
 * 起观战服务。
 *
 * @returns {{close: Function, port: number}} —— close() 会真的关掉 HTTP 服务
 *          （prismarine-viewer 的入口其实也提供了 `bot.viewer.close`，
 *           我早期误以为没有、说成"关不掉"，这里一并纠正）
 */
function startViewerServer(bot, { port = 3007, firstPerson = true, viewDistance = 6, prefix = '' } = {}) {
  loadViewerDeps(); // 依赖没装的话，在这里抛出**说人话**的错误（而不是顶层崩溃）
  const express = require('express');
  const app = express();
  const http = require('http').createServer(app);
  const io = require('socket.io')(http, { path: prefix + '/socket.io' });

  // ---- HUD：和观战页面同源（必须同源，见文件头说明）----
  const publicDir = require('path').join(
    require('path').dirname(require.resolve('prismarine-viewer/package.json')),
    'public',
  );

  app.get(prefix + '/hud', (req, res) => {
    try {
      if (!bot.entity) {
        res.json({ error: '她不在游戏里' });
        return;
      }
      const inv = readInventory(bot);
      const held = inv.hotbar[inv.held_slot] || null;
      const p = bot.entity.position;
      res.json({
        username: bot.username,
        dimension: bot.game && bot.game.dimension ? String(bot.game.dimension).replace('minecraft:', '') : '',
        position: `${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}`,
        health: bot.health,
        max_health: 20,
        food: bot.food,
        xp_level: bot.experience ? bot.experience.level : 0,
        held_name: held ? held.display || held.name : '空手',
        ...inv,
      });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  // 观战页面：在它原来的 index.html 上注入 HUD（样式 + 脚本）
  const fs = require('fs');
  app.get(prefix + '/', (req, res) => {
    try {
      let html = fs.readFileSync(require('path').join(publicDir, 'index.html'), 'utf8');
      html = html.replace(
        '</body>',
        `<style>${HUD_CSS}</style>
         <div id="hud"></div><div id="inv"></div>
         <script>${HUD_JS}</script>
         </body>`,
      );
      res.type('html').send(html);
    } catch (err) {
      res.status(500).send(`观战页面生成失败：${err.message}`);
    }
  });

  // 其余静态资源（打包好的 index.js、贴图、worker）交给它自己
  require('prismarine-viewer/lib/common').setupRoutes(app, prefix);

  // ---- 世界渲染：这部分和 prismarine-viewer 的 mineflayer 入口保持一致 ----
  const sockets = [];
  const primitives = {};
  bot.viewer = new EventEmitter();
  bot.viewer.erase = (id) => {
    delete primitives[id];
    for (const s of sockets) s.emit('primitive', { id });
  };
  bot.viewer.drawBoxGrid = (id, start, end, color = 'aqua') => {
    primitives[id] = { type: 'boxgrid', id, start, end, color };
    for (const s of sockets) s.emit('primitive', primitives[id]);
  };
  bot.viewer.drawLine = (id, points, color = 0xff0000) => {
    primitives[id] = { type: 'line', id, points, color };
    for (const s of sockets) s.emit('primitive', primitives[id]);
  };
  bot.viewer.drawPoints = (id, points, color = 0xff0000, size = 5) => {
    primitives[id] = { type: 'points', id, points, color, size };
    for (const s of sockets) s.emit('primitive', primitives[id]);
  };

  io.on('connection', (socket) => {
    socket.emit('version', bot.version);
    sockets.push(socket);
    const worldView = new WorldView(bot.world, viewDistance, bot.entity.position, socket);
    worldView.init(bot.entity.position);
    worldView.on('blockClicked', (block, face, button) => {
      bot.viewer.emit('blockClicked', block, face, button);
    });
    for (const id in primitives) socket.emit('primitive', primitives[id]);

    function botPosition() {
      const packet = { pos: bot.entity.position, yaw: bot.entity.yaw, addMesh: true };
      if (firstPerson) packet.pitch = bot.entity.pitch;
      socket.emit('position', packet);
      worldView.updatePosition(bot.entity.position);
    }

    bot.on('move', botPosition);
    worldView.listenToBot(bot);
    socket.on('disconnect', () => {
      bot.removeListener('move', botPosition);
      worldView.removeListenersFromBot(bot);
      const i = sockets.indexOf(socket);
      if (i >= 0) sockets.splice(i, 1);
    });
  });

  // **端口被占用时必须大声失败**。
  //
  // 踩过：之前的测试留下孤儿引擎进程占着 3007，新服务 `http.listen` 失败，
  // 但没有任何提示——请求全被**旧服务**接走了（它没有 /hud，于是 404）。
  // 现场看起来像"我的代码没生效"，实际上是我的代码根本没起来。
  const listening = new Promise((resolve, reject) => {
    http.once('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `端口 ${port} 已被占用（可能是上一次的观战服务没关，或者引擎有残留进程）。` +
              `换个 viewer_port，或先关掉占用它的进程`,
          ),
        );
      } else {
        reject(err);
      }
    });
    http.listen(port, () => resolve());
  });

  const close = () => {
    for (const s of sockets) {
      try {
        s.disconnect();
      } catch {
        /* 已经断了 */
      }
    }
    sockets.length = 0;
    http.close();
  };

  bot.viewer.close = close;
  return { close, port, listening };
}

module.exports = { startViewerServer, readInventory };
