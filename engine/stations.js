'use strict';
/**
 * 工作站记忆：**记住用过的箱子、熔炉、工作台在哪**。
 *
 * ## 为什么需要它
 *
 * 参考实现 的 README 里把这条列为"记性"的一部分：
 * "它记得用过的工作台、熔炉、箱子，下次直接走回去，而不是重造一个。"
 *
 * 我这边原来只有"附近 24 格内搜一下"——超出这个距离就等于没做过。
 * 后果是：
 *   - 家里明明有工作台，她在 30 格外砍完树，又要花 4 块木板重做一个
 *   - 箱子也一样，存东西时找不到就近的箱子就再做一个
 *   - 熔炉更贵（8 个圆石），重做一次等于白挖一轮
 *
 * ## 设计
 *
 * - 记录的是**方块坐标**，不是物品：她走回去用"那一个"，而不是手上再放一个。
 * - 同一个位置只记一次；同一个种类最多记若干个（按最近使用排序）。
 * - 用之前先确认那块方块还在（可能被拆了/被别人挖了），不在就忘掉。
 * - 可以落盘（`MC_DATA_DIR`），重启后她还记得家在哪。
 */

const fs = require('fs');
const path = require('path');
const log = require('./log');

// 每种工作站最多记几个（太多没意义，反而会走很远去用一个旧箱子）
const MAX_PER_KIND = 8;
// 认为"这个位置还在"的检查半径（方块可能被换掉）
const KINDS = ['crafting_table', 'furnace', 'chest', 'trapped_chest', 'barrel'];

class StationMemory {
  constructor({ file = null } = {}) {
    this._file = file;
    /** @type {Map<string, Array<{x:number,y:number,z:number,usedAt:number}>>} */
    this._byKind = new Map();
    this.load();
  }

  load() {
    if (!this._file) return;
    try {
      if (!fs.existsSync(this._file)) return;
      const raw = JSON.parse(fs.readFileSync(this._file, 'utf8'));
      for (const kind of KINDS) {
        const list = raw && Array.isArray(raw[kind]) ? raw[kind] : [];
        if (list.length) {
          this._byKind.set(
            kind,
            list
              .filter((e) => e && Number.isFinite(e.x) && Number.isFinite(e.y) && Number.isFinite(e.z))
              .slice(0, MAX_PER_KIND),
          );
        }
      }
      const n = [...this._byKind.values()].reduce((s, l) => s + l.length, 0);
      if (n) log.info(`工作站记忆：记得 ${n} 个位置（重启后直接走回去用）`);
    } catch (err) {
      log.debug(`读工作站记忆失败（忽略）：${err.message}`);
    }
  }

  save() {
    if (!this._file) return;
    try {
      fs.mkdirSync(path.dirname(this._file), { recursive: true });
      const out = {};
      for (const [kind, list] of this._byKind.entries()) out[kind] = list;
      fs.writeFileSync(this._file, JSON.stringify(out, null, 1), 'utf8');
    } catch (err) {
      log.debug(`存工作站记忆失败（忽略）：${err.message}`);
    }
  }

  /** 记下"这个位置有个 X" */
  remember(kind, pos) {
    const k = String(kind || '').replace(/^minecraft:/, '');
    if (!KINDS.includes(k) || !pos) return false;
    const list = this._byKind.get(k) || [];
    const same = list.find(
      (e) => Math.abs(e.x - pos.x) < 0.6 && Math.abs(e.y - pos.y) < 0.6 && Math.abs(e.z - pos.z) < 0.6,
    );
    if (same) {
      same.usedAt = Date.now();
      this._byKind.set(k, list);
      this.save();
      return true;
    }
    list.push({ x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), usedAt: Date.now() });
    list.sort((a, b) => (b.usedAt || 0) - (a.usedAt || 0));
    this._byKind.set(k, list.slice(0, MAX_PER_KIND));
    log.info(`记住了一个${k}的位置 (${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)})`);
    this.save();
    return true;
  }

  /** 忘掉一个位置（方块不在了） */
  forget(kind, pos) {
    const k = String(kind || '').replace(/^minecraft:/, '');
    const list = this._byKind.get(k);
    if (!list) return;
    this._byKind.set(
      k,
      list.filter(
        (e) => !(Math.abs(e.x - pos.x) < 0.6 && Math.abs(e.y - pos.y) < 0.6 && Math.abs(e.z - pos.z) < 0.6),
      ),
    );
    this.save();
  }

  /** 离 from 最近的同类工作站（不做"还在不在"的检查，那是调用方的事） */
  nearest(kind, from) {
    const k = String(kind || '').replace(/^minecraft:/, '');
    const list = this._byKind.get(k) || [];
    if (!list.length || !from) return null;
    let best = null;
    let bestD = Infinity;
    for (const e of list) {
      const d = Math.hypot(e.x - from.x, e.y - from.y, e.z - from.z);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best ? { ...best, distance: Number(bestD.toFixed(1)) } : null;
  }

  /** 全部（给面板/工具看） */
  all() {
    const out = [];
    for (const [kind, list] of this._byKind.entries()) {
      for (const e of list) out.push({ kind, ...e });
    }
    return out;
  }

  /** 渲染成给模型看的一段 */
  render(from = null) {
    const items = this.all();
    if (!items.length) return '';
    const lines = [];
    for (const it of items.slice(0, 12)) {
      const d = from ? Math.hypot(it.x - from.x, it.y - from.y, it.z - from.z) : null;
      lines.push(
        `  ${it.kind} @ (${it.x}, ${it.y}, ${it.z})` + (d === null ? '' : ` 距 ${d.toFixed(0)} 格`),
      );
    }
    return '【你记得的工作站】\n' + lines.join('\n');
  }
}

module.exports = { StationMemory, KINDS };
