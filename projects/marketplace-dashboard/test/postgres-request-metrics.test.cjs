'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createRequestMetrics } = require('../storage/postgres-request-metrics.cjs');

function response() { const res = new EventEmitter(); res.statusCode = 200; res.write = () => true; res.end = () => { res.emit('finish'); }; return res; }

test('request metrics aggregate timings and bytes without retaining SQL, URLs, or request data', async () => {
  let tick = 0; const metrics = createRequestMetrics({ now: () => BigInt(tick) * 1000000n });
  const secretSql = 'SELECT * FROM private_customer WHERE token=$1';
  const client = { async query(sql) { assert.equal(sql, secretSql); tick += 3; return { rows: [] }; } };
  const pool = metrics.instrumentPool({ async connect() { tick += 2; return client; } });
  const external = metrics.instrumentExternal(async url => { assert.match(url, /secret-token/u); tick += 5; return { ok: true }; });
  const req = { method: 'GET', url: '/api/partners/very-private-customer?token=secret-token' }, res = response();
  await metrics.run(req, res, async () => { const lease = await pool.connect(); await lease.query(secretSql); await external('https://example.invalid/secret-token'); res.end('hello'); });
  const snapshot = metrics.snapshot(), [item] = snapshot.series;
  assert.deepEqual({ route: item.route, count: item.count, sqlCount: item.sqlCount, sqlMs: item.sqlMs, poolWaitMs: item.poolWaitMs, externalCount: item.externalCount, externalMs: item.externalMs, responseBytes: item.responseBytes, wallMs: item.wallMs }, { route: '/api/partners/*', count: 1, sqlCount: 1, sqlMs: 3, poolWaitMs: 2, externalCount: 1, externalMs: 5, responseBytes: 5, wallMs: 10 });
  assert.deepEqual({ route: snapshot.recent[0].route, sqlCount: snapshot.recent[0].sqlCount, responseBytes: snapshot.recent[0].responseBytes }, { route: '/api/partners/*', sqlCount: 1, responseBytes: 5 });
  assert.deepEqual({ total: snapshot.pools[0].total, inUse: snapshot.pools[0].inUse, waiting: snapshot.pools[0].waiting }, { total: 0, inUse: 0, waiting: 0 });
  assert.equal(JSON.stringify(snapshot).includes('secret'), false);
});

test('recent request buffer is bounded and pool gauges expose counts without connection settings', async () => {
  let tick = 0; const metrics = createRequestMetrics({ maxRecent: 2, now: () => BigInt(++tick) * 1000000n });
  const pool = { totalCount: 3, idleCount: 1, waitingCount: 2, options: { application_name: 'pult_ui', max: 3, password: 'private' }, async connect() { return { async query() { return { rows: [] }; } }; } };
  metrics.instrumentPool(pool);
  for (const route of ['/api/a', '/api/b', '/api/c']) { const res = response(); await metrics.run({ method: 'GET', url: route }, res, async () => res.end()); }
  const snap = metrics.snapshot();
  assert.deepEqual(snap.recent.map(item => item.route), ['/api/b', '/api/c']);
  assert.deepEqual(snap.pools, [{ name: 'pult_ui', max: 3, total: 3, idle: 1, inUse: 2, waiting: 2 }]);
  assert.equal(JSON.stringify(snap).includes('private'), false);
});

test('series cardinality is bounded and overflow is aggregated', async () => {
  let tick = 0; const metrics = createRequestMetrics({ maxSeries: 2, now: () => BigInt(++tick) * 1000000n });
  for (const url of ['/api/a', '/api/b', '/api/c', '/api/d']) { const res = response(); await metrics.run({ method: 'GET', url }, res, async () => res.end()); }
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.series.length, 2);
  assert.equal(snapshot.series.find(item => item.route === 'OTHER').count, 3);
});
