'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { create, PAGE_SIZE, MAX_PAGES } = require('../ozon-funnel.cjs');
const row = (sku, metrics = [2, 20, 4]) => ({ dimensions: [{ id: String(sku) }], metrics });
const response = rows => ({ result: { data: rows } });
function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir()), dir = fs.mkdtempSync(path.join(parent, 'pult-funnel-test-'));
  let time = Date.parse('2026-09-18T09:00:00Z');
  t.after(() => { assert.equal(path.dirname(path.resolve(dir)), parent); assert.ok(path.basename(dir).startsWith('pult-funnel-test-')); fs.rmSync(dir, { recursive: true, force: true }); });
  const options = { privateDir: dir, now: () => time };
  return { client: create(options), options, dir, advance: n => { time += n; }, set: value => { time = Date.parse(value); } };
}
function complete(f) { f.client.request('1'); f.client.accept('1', response([row(10)])); f.client.request('1'); f.client.accept('1', response([row(11, [1, 30, 0])])); }
test('two closed Moscow windows publish atomically, preserving sparse SKU identity and counts', t => {
  const f = fixture(t), payload = f.client.request('1');
  assert.deepEqual(payload.dimension, ['sku']); assert.deepEqual(payload.metrics, ['ordered_units', 'hits_view_pdp', 'hits_tocart_pdp']);
  assert.equal(payload.date_from, '2026-09-04'); assert.equal(payload.date_to, '2026-09-10');
  f.client.accept('1', response([row(10)])); assert.equal(f.client.read('1').snapshot, null);
  const next = f.client.request('1'); assert.equal(next.date_from, '2026-09-11'); assert.equal(next.date_to, '2026-09-17');
  f.client.accept('1', response([row(11, [1, 30, 0])]));
  const { snapshot, status } = f.client.read('1'); assert.equal(status, 'ready'); assert.equal(snapshot.complete, true);
  assert.deepEqual(snapshot.previousRows, [{ sku: '10', orderedUnits: 2, views: 20, cartAdds: 4 }]);
  assert.deepEqual(snapshot.currentRows, [{ sku: '11', orderedUnits: 1, views: 30, cartAdds: 0 }]); assert.equal(f.client.due('1'), false);
});
test('cursor resumes after restart; a full page needs an empty terminal page', t => {
  const f = fixture(t); f.client.request('1'); f.client.accept('1', response(Array.from({ length: PAGE_SIZE }, (_, i) => row(i + 1))));
  f.client = create(f.options); assert.equal(f.client.request('1').offset, 1000); f.client.accept('1', response([]));
  assert.equal(f.client.request('1').offset, 0); assert.equal(f.client.read('1').snapshot, null); f.client.accept('1', response([]));
  assert.equal(f.client.read('1').snapshot.previousRows.length, 1000); assert.deepEqual(f.client.read('1').snapshot.currentRows, []);
});
test('malformed and absent counts, duplicate SKU and unsafe numeric IDs are rejected', t => {
  const f = fixture(t);
  for (const bad of [row(1, [1, 2]), row(1, [1, -2, 3]), row(1, [1, null, 3]), row(1, [1, 2.5, 3]), row(1, [1, Number.MAX_SAFE_INTEGER + 1, 3]), row(1, [1, '2', 3]), { dimensions: [{ id: Number.MAX_SAFE_INTEGER + 1 }], metrics: [1, 2, 3] }]) {
    f.client.request('1'); assert.throws(() => f.client.accept('1', response([bad]))); assert.equal(f.client.read('1').snapshot, null);
  }
  assert.throws(() => f.client.accept('1', response([row(1), row(1)])));
});
test('duplicate across pages and excessive pagination cannot publish partial snapshots', t => {
  const f = fixture(t); f.client.request('1'); f.client.accept('1', response(Array.from({ length: PAGE_SIZE }, (_, i) => row(i + 1))));
  f.client.request('1'); assert.throws(() => f.client.accept('1', response([row(1)])));
  const file = path.join(f.dir, 'ozon-funnel-1.json'), state = JSON.parse(fs.readFileSync(file)); state.pending.offset = (MAX_PAGES - 1) * PAGE_SIZE; fs.writeFileSync(file, JSON.stringify(state));
  assert.throws(() => f.client.accept('1', response(Array.from({ length: PAGE_SIZE }, (_, i) => row(i + 1001))))); assert.equal(f.client.read('1').snapshot, null);
});
test('errors preserve prior successful snapshot, discard partial state and avoid saving raw errors', t => {
  const f = fixture(t); complete(f); const snapshot = f.client.read('1').snapshot; f.advance(30 * 60000);
  f.client.request('1'); f.client.accept('1', response([row(99)]));
  f.client.fail('1', { status: 403, message: 'fixture-secret-do-not-save' });
  assert.equal(f.client.read('1').status, 'unavailable'); assert.deepEqual(f.client.read('1').snapshot, snapshot); assert.equal(f.client.due('1'), false);
  assert.equal(fs.readFileSync(path.join(f.dir, 'ozon-funnel-1.json'), 'utf8').includes('fixture-secret-do-not-save'), false);
  f.advance(6 * 3600000); assert.equal(f.client.due('1'), true); assert.equal(f.client.request('1').date_from, '2026-09-04');
});
test('429 retains retry-after durably and failed probes have a cooldown', t => {
  const f = fixture(t); f.client.request('1'); f.client.fail('1', { status: 429, retryAfterMs: 60 * 60000 });
  f.client = create(f.options); f.advance(30 * 60000); assert.equal(f.client.due('1'), false); f.advance(30 * 60000); assert.equal(f.client.due('1'), true);
  f.client.fail('1', { status: 400 }); assert.equal(f.client.read('1').status, 'unavailable'); f.advance(29 * 60000); assert.equal(f.client.due('1'), false);
});
test('day rollover discards partial imports and never relabels old snapshots', t => {
  const f = fixture(t); complete(f); const previous = f.client.read('1').snapshot; f.advance(30 * 60000); f.client.request('1');
  f.set('2026-09-18T21:00:00Z'); f.client.accept('1', response([row(20)])); assert.deepEqual(f.client.read('1').snapshot, previous);
  const next = f.client.request('1'); assert.equal(next.date_from, '2026-09-05'); assert.equal(next.offset, 0);
});
test('transient Windows file locks retry the atomic replacement without deleting a prior snapshot', t => {
  const f = fixture(t), rename = fs.renameSync; let failures = 0;
  fs.renameSync = function (from, to) {
    if (from.startsWith(f.dir) && failures++ < 2) throw Object.assign(Error('fixture lock'), { code: 'EPERM' });
    return rename.apply(this, arguments);
  };
  try { complete(f); assert.equal(f.client.read('1').snapshot.complete, true); assert.ok(failures >= 2); }
  finally { fs.renameSync = rename; }
});
