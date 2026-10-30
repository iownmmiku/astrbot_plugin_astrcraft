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
const KINDS = ['crafting_table', 'furnace', 'chest', 'trapped_chest', 'barrel', 'bed'];
const kindOf = (name) => String(name || '').replace(/^minecraft:/, '').endsWith('_bed') ? 'bed' : String(name || '').replace(/^minecraft:/, '');
const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

function storedEntry(entry) {
  if (!isObject(entry) || !['x', 'y', 'z'].every((axis) => Number.isFinite(entry[axis])) ||
      (entry.usedAt !== undefined && (!Number.isFinite(entry.usedAt) || entry.usedAt < 0))) return null;
  // Only retain known fields: an injected `kind` must not override all()'s kind.
  return { x: entry.x, y: entry.y, z: entry.z, usedAt: entry.usedAt ?? 0 };
}

class StationMemory {
  constructor({ file = null } = {}) {
    this._file = file;
    /** @type {Map<string, Array<{x:number,y:number,z:number,usedAt:number}>>} */
    this._byKind = new Map();
    this._scopes = new Map([['legacy', this._byKind]]);
    this._scopeProvider = null;
    this._writeProtected = false;
    this.load();
  }

  load() {
    if (!this._file) return;
    let bytes;
    try {
      bytes = fs.readFileSync(this._file);
    } catch (err) {
      if (err.code === 'ENOENT') return;
      this._writeProtected = true;
      log.warn(`读取工作站记忆失败，已启用写保护：${err.message}`);
      return;
    }
    try {
      const raw = JSON.parse(bytes.toString('utf8'));
      if (!isObject(raw) || (raw.version !== undefined && (raw.version !== 2 || !isObject(raw.scopes)))) {
        throw new Error('工作站记忆格式无效或版本不受支持');
      }
      const scopes = raw.version === 2 ? raw.scopes : { legacy: raw };
      const restored = new Map();
      let damaged = false, count = 0;
      for (const [scope, data] of Object.entries(scopes)) {
        if (!isObject(data)) { damaged = true; continue; }
        const byKind = new Map();
        for (const [kind, list] of Object.entries(data)) {
          if (!KINDS.includes(kind) || !Array.isArray(list)) { damaged = true; continue; }
          const valid = list.map(storedEntry).filter(Boolean);
          if (valid.length !== list.length) damaged = true;
          valid.sort((a, b) => b.usedAt - a.usedAt);
          if (valid.length) byKind.set(kind, valid.slice(0, MAX_PER_KIND));
          count += Math.min(valid.length, MAX_PER_KIND);
        }
        restored.set(scope, byKind);
      }
      if (damaged) {
        const preserved = this._preserveCorrupt(bytes);
        this._writeProtected = !preserved || count === 0;
        log.warn(`工作站记忆有损坏记录，保留 ${count} 个有效位置${this._writeProtected ? '，已启用写保护' : ''}`);
      }
      this._scopes = restored;
      this._byKind = this._scopes.get('legacy') || new Map();
      if (!this._scopes.has('legacy')) this._scopes.set('legacy', this._byKind);
      if (count) log.info(`工作站记忆：记得 ${count} 个位置（重启后直接走回去用）`);
    } catch (err) {
      this._writeProtected = true;
      this._preserveCorrupt(bytes);
      log.warn(`工作站记忆无法恢复，已启用写保护：${err.message}`);
    }
  }

  _preserveCorrupt(bytes) {
    const backup = `${this._file}.corrupt-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
    try {
      fs.writeFileSync(backup, bytes, { flag: 'wx' });
      log.warn(`损坏的工作站记忆已保留：${backup}`);
      return true;
    } catch (err) {
      log.warn(`无法保留损坏的工作站记忆，禁止覆盖原档：${err.message}`);
      return false;
    }
  }

  save() {
    if (!this._file || this._writeProtected) return false;
    let temporary = null, fd = null;
    try {
      fs.mkdirSync(path.dirname(this._file), { recursive: true });
      const out = { version: 2, scopes: Object.fromEntries([...this._scopes].map(
        ([scope, byKind]) => [scope, Object.fromEntries(byKind)])) };
      const text = JSON.stringify(out, null, 1);
      const candidate = `${this._file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      fd = fs.openSync(candidate, 'wx');
      temporary = candidate;
      fs.writeFileSync(fd, text, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(temporary, this._file);
      temporary = null;
      return true;
    } catch (err) {
      log.warn(`工作站记忆未保存，保留原档：${err.message}`);
      return false;
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); }
        catch (err) { log.warn(`关闭工作站记忆临时文件失败：${err.message}`); }
      }
      if (temporary) {
        try { fs.unlinkSync(temporary); }
        catch (err) { log.warn(`清理工作站记忆临时文件失败：${err.message}`); }
      }
    }
  }

  /** Resolve the live world on every access, including dimension changes without reconnecting. */
  bindScope(provider) {
    this._scopeProvider = provider;
  }

  _current() {
    let key = 'legacy';
    if (this._scopeProvider) {
      const scope = this._scopeProvider() || {};
      if (!scope.server || !scope.dimension) return false;
      key = JSON.stringify([String(scope.server), String(scope.dimension).replace(/^minecraft:/, '')]);
    }
    if (!this._scopes.has(key)) this._scopes.set(key, new Map());
    this._byKind = this._scopes.get(key);
    return true;
  }

  /** 记下"这个位置有个 X" */
  remember(kind, pos) {
    const k = kindOf(kind);
    if (!this._current() || !KINDS.includes(k) || !pos || ![pos.x, pos.y, pos.z].every(Number.isFinite)) return false;
    const list = this._byKind.get(k) || [];
    const same = list.find(
      (e) => Math.abs(e.x - pos.x) < 0.6 && Math.abs(e.y - pos.y) < 0.6 && Math.abs(e.z - pos.z) < 0.6,
    );
    if (same) {
      same.usedAt = Date.now();
      list.sort((a, b) => (b.usedAt || 0) - (a.usedAt || 0));
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
    if (!this._current()) return;
    const k = kindOf(kind);
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
    if (!this._current()) return null;
    const k = kindOf(kind);
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
    if (!this._current()) return [];
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
