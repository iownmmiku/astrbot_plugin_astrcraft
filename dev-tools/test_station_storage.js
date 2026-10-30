'use strict';

// Offline fault injection: station locations must survive bad files and failed writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StationMemory } = require('../engine/stations');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'astrcraft-station-storage-'));
const position = { x: 4, y: 64, z: 8 };
let passed = 0, failed = 0, sequence = 0;

function test(name, run) {
  const dir = path.join(root, String(++sequence));
  fs.mkdirSync(dir);
  try { run(path.join(dir, 'stations.json')); passed++; console.log(`PASS ${name}`); }
  catch (err) { failed++; console.error(`FAIL ${name}: ${err.stack}`); }
}
function inject(method, replacement, run) {
  const original = fs[method];
  fs[method] = (...args) => replacement(original, ...args);
  try { return run(); } finally { fs[method] = original; }
}
function backups(file) {
  return fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith('stations.json.corrupt-'))
    .map((name) => fs.readFileSync(path.join(path.dirname(file), name)));
}
function write(file, value) { fs.writeFileSync(file, JSON.stringify(value)); }
function entry(x, usedAt = 1) { return { x, y: 64, z: 8, usedAt }; }

test('truncated file remains untouched and is preserved before later learning', (file) => {
  const raw = Buffer.from('{"version":2,"scopes":');
  fs.writeFileSync(file, raw);
  const memory = new StationMemory({ file });
  memory.remember('furnace', position);
  assert.deepEqual(fs.readFileSync(file), raw);
  assert.ok(backups(file).some((bytes) => bytes.equals(raw)));
  assert.equal(memory.save(), false);
});

test('mixed entries salvage safe records and preserve the exact damaged source', (file) => {
  write(file, { crafting_table: [entry(1), { ...entry(2), usedAt: [] }, { x: 'bad', y: 64, z: 0 }] });
  const raw = fs.readFileSync(file);
  const memory = new StationMemory({ file });
  assert.deepEqual(memory.all().map((e) => e.x), [1]);
  assert.ok(backups(file).some((bytes) => bytes.equals(raw)));
  memory.remember('furnace', position);
  assert.equal(new StationMemory({ file }).all().length, 2);
});

test('an entirely invalid record list is write protected', (file) => {
  write(file, { chest: [{ x: 'unknown', y: 64, z: 0 }] });
  const raw = fs.readFileSync(file);
  const memory = new StationMemory({ file });
  memory.remember('furnace', position);
  assert.deepEqual(fs.readFileSync(file), raw);
});

test('unknown future format cannot be silently replaced', (file) => {
  write(file, { version: 3, scopes: { future: { payload: 'preserve' } } });
  const raw = fs.readFileSync(file);
  const memory = new StationMemory({ file });
  memory.remember('furnace', position);
  assert.deepEqual(fs.readFileSync(file), raw);
});

test('read errors protect the original even after reads become available', (file) => {
  write(file, { crafting_table: [entry(1)] });
  const raw = fs.readFileSync(file);
  const memory = inject('readFileSync', (original, target, ...args) => {
    if (target === file) throw Object.assign(new Error('injected unreadable file'), { code: 'EACCES' });
    return original(target, ...args);
  }, () => new StationMemory({ file }));
  memory.remember('furnace', position);
  assert.deepEqual(fs.readFileSync(file), raw);
});

test('failed damaged-file backup prevents later overwrite', (file) => {
  write(file, { crafting_table: [entry(1), { broken: true }] });
  const raw = fs.readFileSync(file);
  const memory = inject('writeFileSync', (original, target, ...args) => {
    if (String(target).includes('.corrupt-')) throw new Error('injected backup failure');
    return original(target, ...args);
  }, () => new StationMemory({ file }));
  assert.equal(memory.all().length, 1);
  memory.remember('furnace', position);
  assert.deepEqual(fs.readFileSync(file), raw);
});

test('failed rename leaves the old archive intact and removes the temporary file', (file) => {
  const memory = new StationMemory({ file });
  memory.remember('crafting_table', position);
  const raw = fs.readFileSync(file);
  inject('renameSync', () => { throw new Error('injected replace failure'); }, () => {
    memory.remember('furnace', { x: 9, y: 64, z: 8 });
    assert.equal(memory.save(), false);
  });
  assert.deepEqual(fs.readFileSync(file), raw);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['stations.json']);
  assert.equal(memory.save(), true);
  assert.equal(new StationMemory({ file }).all().length, 2);
});

test('partial write failure cannot truncate the old archive', (file) => {
  const memory = new StationMemory({ file });
  memory.remember('crafting_table', position);
  const raw = fs.readFileSync(file);
  inject('writeFileSync', (original, target, ...args) => {
    original(target, '{');
    throw new Error('injected partial write');
  }, () => {
    memory.remember('furnace', position);
  });
  assert.deepEqual(fs.readFileSync(file), raw);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['stations.json']);
});

test('flush failure keeps the prior archive and can be retried', (file) => {
  const memory = new StationMemory({ file });
  memory.remember('crafting_table', position);
  const raw = fs.readFileSync(file);
  inject('fsyncSync', () => { throw new Error('injected flush failure'); }, () => {
    memory.remember('furnace', position);
    assert.equal(memory.save(), false);
  });
  assert.deepEqual(fs.readFileSync(file), raw);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['stations.json']);
  assert.equal(memory.save(), true);
  assert.equal(new StationMemory({ file }).all().length, 2);
});

test('malformed world scopes do not discard valid positions in another world', (file) => {
  const scope = JSON.stringify(['host:25565', 'overworld']);
  write(file, { version: 2, scopes: { [scope]: { chest: [entry(10)] }, broken: null } });
  const raw = fs.readFileSync(file);
  const memory = new StationMemory({ file });
  memory.bindScope(() => ({ server: 'host:25565', dimension: 'overworld' }));
  assert.equal(memory.all()[0].x, 10);
  assert.ok(backups(file).some((bytes) => bytes.equals(raw)));
  memory.remember('furnace', position);
  const reloaded = new StationMemory({ file });
  reloaded.bindScope(() => ({ server: 'host:25565', dimension: 'overworld' }));
  assert.equal(reloaded.all().length, 2);
});

test('stored metadata cannot change a station kind', (file) => {
  write(file, { crafting_table: [{ ...entry(1), kind: 'chest' }] });
  const memory = new StationMemory({ file });
  assert.equal(memory.all()[0].kind, 'crafting_table');
});

test('current scope survives reload and remains separate from legacy and other worlds', (file) => {
  write(file, { crafting_table: [entry(1)] });
  const memory = new StationMemory({ file });
  let world = { server: 'host:25565', dimension: 'overworld' };
  memory.bindScope(() => world);
  memory.remember('furnace', position);
  world = { server: 'host:25565', dimension: 'the_nether' };
  memory.remember('chest', { x: 20, y: 30, z: 40 });
  const reloaded = new StationMemory({ file });
  assert.equal(reloaded.all()[0].kind, 'crafting_table');
  reloaded.bindScope(() => world);
  assert.equal(reloaded.all()[0].kind, 'chest');
  world = { server: 'host:25565', dimension: 'minecraft:overworld' };
  assert.equal(reloaded.all()[0].kind, 'furnace');
});

test('using an older station refreshes displayed order and retains it when adding another', (file) => {
  write(file, { chest: Array.from({ length: 8 }, (_, i) => entry(i * 10, 100 - i)) });
  const memory = new StationMemory({ file });
  memory.remember('chest', { x: 70, y: 64, z: 8 });
  assert.equal(memory.all()[0].x, 70);
  memory.remember('chest', { x: 90, y: 64, z: 8 });
  assert.ok(memory.all().some((e) => e.x === 70));
  assert.ok(!memory.all().some((e) => e.x === 60));
});

test('empty valid and absent files remain writable', (file) => {
  const memory = new StationMemory({ file });
  assert.equal(memory.save(), true);
  const reloaded = new StationMemory({ file });
  reloaded.remember('white_bed', position);
  assert.equal(new StationMemory({ file }).all()[0].kind, 'bed');
});

console.log(`结果：${passed} 通过，${failed} 失败`);
// The recursive target is the exact freshly-created child of the OS temp dir.
assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
assert.ok(path.basename(root).startsWith('astrcraft-station-storage-'));
fs.rmSync(root, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
