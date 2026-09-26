'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPostgresApplication } = require('../storage/postgres-application.cjs');
const { createBusinessDynamicsRepository } = require('../storage/postgres-business-dynamics-repository.cjs');
const { createStateStore } = require('../storage/postgres-state.cjs');
const createStores = require('../storage/domains/postgres-stores.cjs');

// A real bounded checkout queue with explicitly released SQL work. No database,
// timers, port, background scheduler or elapsed-time threshold is needed.
function boundedPool(max) {
  let active = 0, serial = 0, hold = false, rejectReads = false;
  const waiters = [], blocked = [], events = [];
  async function connect() {
    if (active === max) await new Promise(resolve => waiters.push(resolve));
    else active++;
    const id = ++serial;
    let released = false;
    return {
      async query(sql) {
        events.push({ id, sql });
        if (hold && sql.startsWith('SELECT revision,metadata,source_metadata')) {
          await new Promise(resolve => blocked.push(resolve));
          if (rejectReads) throw Error('synthetic read failure');
        }
        return { rows: [] };
      },
      release() {
        assert.equal(released, false, 'each checked-out client is released once');
        released = true;
        if (waiters.length) waiters.shift()(); else active--;
      }
    };
  }
  return {
    connect,
    async query(sql, values) { const client = await connect(); try { return await client.query(sql, values); } finally { client.release(); } },
    hold() { hold = true; },
    unblock({ fail = false } = {}) { hold = false; rejectReads = fail; blocked.splice(0).forEach(resolve => resolve()); },
    get active() { return active; }, get waiting() { return waiters.length; }, get blocked() { return blocked.length; }, events
  };
}
async function until(condition) {
  for (let i = 0; i < 50; i++) { if (condition()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('deterministic queue did not reach the expected state');
}
async function application(pool, readPool, analyticsPool) {
  return createPostgresApplication({ pool, readPool, analyticsPool, protect: async value => value, fetchFn: async () => {}, staticDir: __dirname, staticFiles: [] });
}

test('shared-pool baseline queues interactive reads; isolated analytics leaves UI capacity free', async () => {
  for (const isolated of [false, true]) {
    const runtime = boundedPool(10), ui = boundedPool(3), heavy = isolated ? boundedPool(2) : ui;
    const app = await application(runtime, ui, heavy);
    assert.equal(app.analytics.sourceProviders, app.sourceProviders, 'category and other analytics use the isolated sources');
    heavy.hold();
    const reports = ['1', '2', '3'].map(id => app.analytics.sourceProviders.getProducts(id));
    let storesDone = false, dynamicsDone = false;
    let stores, dynamics;
    try {
      await until(() => heavy.blocked === (isolated ? 2 : 3));
      stores = createStores({ stateStore: createStateStore({ pool: ui }) }).read().then(value => { storesDone = true; return value; });
      dynamics = createBusinessDynamicsRepository({ pool: ui }).readTarget({ date: '2026-09-25', scopeType: 'all', scopeId: '' }).then(value => { dynamicsDone = true; return value; });
      if (isolated) {
        await until(() => storesDone && dynamicsDone);
        assert.equal(ui.waiting, 0);
        assert.equal(heavy.waiting, 1, 'excess report work stays within two reserved connections');
      } else {
        await until(() => ui.waiting === 2);
        assert.equal(storesDone, false);
        assert.equal(dynamicsDone, false);
      }
    } finally { heavy.unblock(); }
    assert.deepEqual(await Promise.all(reports), [[], [], []]);
    assert.deepEqual(await stores, {});
    assert.equal(await dynamics, null);
    assert.equal(heavy.active, 0);
    const transactions = heavy.events.filter(event => event.sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.ok(transactions.length >= 3);
    for (const { id } of transactions) assert.ok(heavy.events.some(event => event.id === id && event.sql === 'COMMIT'), 'read transactions keep their original client through commit');
  }
});

test('analytics read failure rolls back and releases its client without consuming UI connections', async () => {
  const runtime = boundedPool(10), ui = boundedPool(3), heavy = boundedPool(2);
  const app = await application(runtime, ui, heavy);
  const before = ui.events.length;
  heavy.hold();
  const report = app.sourceProviders.getProducts('1');
  const failed = assert.rejects(report, { code: 'DATABASE_ERROR' });
  await until(() => heavy.blocked === 1);
  heavy.unblock({ fail: true });
  await failed;
  assert.equal(heavy.active, 0);
  assert.equal(ui.events.length, before);
  assert.ok(heavy.events.some(event => event.sql === 'ROLLBACK'));
  assert.deepEqual(await app.sourceProviders.getProducts('1'), [], 'a subsequent read still succeeds');
});

test('aggregate analytics uses the reserved pool and later source reads recheck SQL', async () => {
  const runtime = boundedPool(10), ui = boundedPool(3), heavy = boundedPool(2);
  const app = await application(runtime, ui, heavy);
  const uiBefore = ui.events.length;
  await app.analytics.buyerOrderSegments.read({ from: '2026-09-01', to: '2026-09-07', market: 'all' });
  assert.ok(heavy.events.some(event => event.sql.includes('heads0 AS MATERIALIZED')), 'aggregate SQL must not bypass the reserved analytics pool');
  assert.equal(runtime.events.some(event => event.sql.includes('heads0 AS MATERIALIZED')), false);
  const sourceReads = () => heavy.events.filter(event => event.sql.startsWith('SELECT revision,metadata,source_metadata')).length;
  await app.sourceProviders.getProducts('1');
  const before = sourceReads();
  await app.sourceProviders.getProducts('1');
  assert.ok(sourceReads() > before, 'completed reads do not become a stale pool-level cache');
  assert.equal(ui.events.length, uiBefore);
  assert.equal(heavy.events.some(event => event.sql === 'BEGIN'), false, 'no write transaction is started on the analytics pool');
});
