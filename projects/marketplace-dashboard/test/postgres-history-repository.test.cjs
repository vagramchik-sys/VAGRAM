'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const schemaSql = require('../storage/postgres-history-schema.cjs');
const { createMarketHistoryRepository, HistoryRepositoryError } = require('../storage/postgres-history-repository.cjs');

function fakePool(handler) {
  const calls = [];
  const client = {
    async query(text, values) { calls.push({ text, values }); return handler ? handler(text, values, calls) : { rows: [], rowCount: 0 }; },
    release() { calls.push({ release: true }); }
  };
  return {
    calls, client,
    async connect() { calls.push({ connect: true }); return client; },
    async query(text, values) { return client.query(text, values); }
  };
}

const insights = (actual = '2026-09-21T08:00:00Z', rows = [{ date: '2026-09-18', sku: '0001', units: 2, revenue: 100 }], extra = {}) => ({ orders: { period: { from: '2026-09-18', to: '2026-09-20' }, skuPeriod: { from: '2026-09-18', to: '2026-09-20' }, skuDaily: rows, skuUpdatedAt: actual, skuDailyCoverage: true, ...extra } });

test('ingest is one transaction, parameterized, atomic and keeps closed zero days', async () => {
  let snapshotId = 40;
  const pool = fakePool(text => {
    if (text.includes('INSERT INTO "pult_history"."ingestions"')) return { rows: [{ id: '7' }], rowCount: 1 };
    if (text.includes('INSERT INTO "pult_history"."snapshots"')) return { rows: [{ id: String(++snapshotId) }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const repo = createMarketHistoryRepository({ pool });
  const result = await repo.ingest({ sourceFile: 'insights-001.json', contentHash: 'hash', data: insights(), capturedAt: '2026-09-21T09:00:00Z' });
  assert.deepEqual(result, { duplicate: false, ingestionId: 7, snapshotCount: 3, factCount: 1 });
  assert.equal(pool.calls[1].text, 'BEGIN');
  assert.equal(pool.calls.some(call => call.text?.includes('pg_advisory_xact_lock_shared')), true);
  assert.ok(pool.calls.findIndex(call => call.text?.includes('pg_advisory_xact_lock_shared')) < pool.calls.findIndex(call => call.text?.includes('ingestions')));
  assert.equal(pool.calls.at(-2).text, 'COMMIT');
  assert.deepEqual(pool.calls.at(-1), { release: true });
  const ingestion = pool.calls.find(call => call.text?.includes('INSERT INTO "pult_history"."ingestions"'));
  assert.match(ingestion.text, /ON CONFLICT\(source_file,content_hash\) DO NOTHING/u);
  assert.deepEqual(ingestion.values.slice(0, 2), ['insights-001.json', 'hash']);
  assert.equal(ingestion.text.includes("'hash'"), false);
  const snapshots = pool.calls.filter(call => call.text?.includes('INSERT INTO "pult_history"."snapshots"'));
  assert.equal(snapshots.length, 3);
  assert.equal(snapshots.every(call => call.values[6] === true), true);
  const facts = pool.calls.find(call => call.text?.includes('INSERT INTO "pult_history"."facts"'));
  assert.ok(facts);
  assert.equal(facts.values.includes('0001'), true);
});

test('ingestInTransaction reuses the supplied protected transaction without lifecycle queries', async () => {
  let snapshotId = 70;
  const pool = fakePool(text => {
    if (text.includes('ingestions')) return { rows: [{ id: '12' }], rowCount: 1 };
    if (text.includes('snapshots')) return { rows: [{ id: String(++snapshotId) }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const result = await createMarketHistoryRepository({ pool }).ingestInTransaction({ sourceFile: 'insights-1.json', contentHash: 'outer', data: insights() }, pool.client);
  assert.equal(result.ingestionId, 12);
  assert.equal(pool.calls.some(call => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(call.text)), false);
  assert.equal(pool.calls.some(call => call.text?.includes('pg_advisory_xact_lock_shared')), false);
  assert.equal(pool.calls.some(call => call.release), false);
});

test('same source hash is a no-op and never creates snapshots', async () => {
  const pool = fakePool(text => text.includes('INSERT INTO "pult_history"."ingestions"') ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 0 });
  const result = await createMarketHistoryRepository({ pool }).ingest({ sourceFile: 'insights-1.json', contentHash: 'same', data: {} });
  assert.deepEqual(result, { duplicate: true });
  assert.equal(pool.calls.some(call => call.text?.includes('INSERT INTO "pult_history"."snapshots"')), false);
  assert.equal(pool.calls.at(-2).text, 'COMMIT');
});

test('invalid new source data rolls back its reserved ingestion', async () => {
  const pool = fakePool(text => text.includes('INSERT INTO "pult_history"."ingestions"') ? { rows: [{ id: '1' }], rowCount: 1 } : { rows: [], rowCount: 0 });
  await assert.rejects(
    createMarketHistoryRepository({ pool }).ingest({ sourceFile: 'ledger-1.json', contentHash: 'bad', data: { data: { period: { from: '2026-09-18', to: '2026-09-18' }, completedAt: '2026-09-19T08:00:00Z', complete: true, skuDaily: [{ date: '2026-09-18', sku: 'A', values: { soldUnits: null } }] } } }),
    /soldUnits/u
  );
  assert.equal(pool.calls.some(call => call.connect), true);
  assert.equal(pool.calls.some(call => call.text === 'ROLLBACK'), true);
  assert.equal(pool.calls.some(call => call.text === 'COMMIT'), false);
  assert.deepEqual(pool.calls.at(-1), { release: true });
});

test('catalog upsert is store-scoped and refuses older source time in SQL', async () => {
  const pool = fakePool(text => text.includes('INSERT INTO "pult_history"."ingestions"') ? { rows: [{ id: '2' }], rowCount: 1 } : { rows: [], rowCount: 1 });
  const repo = createMarketHistoryRepository({ pool });
  const result = await repo.ingest({ sourceFile: 'order-category-catalog-wb-2.json', contentHash: 'catalog', capturedAt: '2026-09-21T08:00:00Z', data: { products: [{ nmID: 77, vendorCode: 'WB-X', title: 'Товар' }] } });
  assert.equal(result.factCount, 1);
  const name = pool.calls.find(call => call.text?.includes('product_names'));
  const alias = pool.calls.find(call => call.text?.includes('product_aliases'));
  assert.match(name.text, /WHERE EXCLUDED\.source_actual_at>=existing_row\.source_actual_at/u);
  assert.deepEqual(name.values.slice(0, 3), ['WB', 'wb-2', '77']);
  assert.deepEqual(alias.values.slice(0, 4), ['WB', 'wb-2', 'WB-X', '77']);
});

test('finance keeps cents conversion, unknown units and null metric columns distinct', async () => {
  const pool = fakePool(text => {
    if (text.includes('ingestions')) return { rows: [{ id: '3' }], rowCount: 1 };
    if (text.includes('snapshots')) return { rows: [{ id: '4' }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const result = await createMarketHistoryRepository({ pool }).ingest({ sourceFile: 'ledger-1.json', contentHash: 'finance', data: { stamp: '2026-09-19T08:00:00Z', data: { period: { from: '2026-09-18', to: '2026-09-18' }, completedAt: '2026-09-19T08:00:00Z', complete: true, skuDaily: [{ date: '2026-09-18', sku: '0001', values: { soldUnits: 3, returnedUnits: 1, realized: 500, ads: 40, unknownUnitRows: 2 } }] } } });
  assert.equal(result.factCount, 1);
  const facts = pool.calls.find(call => call.text?.includes('INSERT INTO "pult_history"."facts"'));
  assert.deepEqual(facts.values, ['4', '0001', '2026-09-19T08:00:00Z', '2026-09-19T08:00:00Z', null, null, 3, 1, 5, 0.4, 2]);
});

test('WB writes grouped facts and exact order events in the same transaction', async () => {
  const pool = fakePool(text => {
    if (text.includes('ingestions')) return { rows: [{ id: '5' }], rowCount: 1 };
    if (text.includes('snapshots')) return { rows: [{ id: '6' }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const result = await createMarketHistoryRepository({ pool }).ingest({ sourceFile: 'wb-orders-wb-2.json', contentHash: 'wb', data: { day: '2026-09-18', fetchedAt: '2026-09-19T01:00:00Z', complete: true, orders: [{ at: '2026-09-18T10:15:00Z', amount: 19.5, nmId: 77 }] } });
  assert.deepEqual(result, { duplicate: false, ingestionId: 5, snapshotCount: 1, factCount: 1 });
  const events = pool.calls.find(call => call.text?.includes('INSERT INTO "pult_history"."order_events"'));
  assert.deepEqual(events.values, ['6', '77', '2026-09-18T10:15:00Z', '2026-09-18T10:15:00Z', 19.5]);
});

test('database failure rolls back the whole ingestion and releases the client', async () => {
  const pool = fakePool(text => {
    if (text.includes('ingestions')) return { rows: [{ id: '7' }], rowCount: 1 };
    if (text.includes('snapshots')) return { rows: [{ id: '8' }], rowCount: 1 };
    if (text.includes('facts')) throw Object.assign(Error('fixture'), { code: 'XX000' });
    return { rows: [], rowCount: 1 };
  });
  await assert.rejects(createMarketHistoryRepository({ pool }).ingest({ sourceFile: 'insights-1.json', contentHash: 'failure', data: insights() }), error => {
    assert.equal(error instanceof HistoryRepositoryError, true);
    assert.equal(error.code, 'DATABASE_ERROR');
    assert.equal(error.message.includes('fixture'), false);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(pool.calls.some(call => call.text === 'ROLLBACK'), true);
  assert.deepEqual(pool.calls.at(-1), { release: true });
});

test('connect and status failures are redacted without driver details', async () => {
  const secret = 'private-business-value';
  const connectPool = { async connect() { throw new Error(`connect ${secret}`); }, async query() { throw new Error('unused'); } };
  await assert.rejects(createMarketHistoryRepository({ pool: connectPool }).ingest({ sourceFile: 'insights-1.json', contentHash: 'connect', data: insights() }), error => error instanceof HistoryRepositoryError && error.code === 'DATABASE_ERROR' && !error.message.includes(secret) && error.cause === undefined);
  const statusPool = fakePool(() => { throw Object.assign(Error(`status ${secret}`), { detail: secret }); });
  await assert.rejects(createMarketHistoryRepository({ pool: statusPool }).status(), error => error instanceof HistoryRepositoryError && error.code === 'DATABASE_ERROR' && !error.message.includes(secret) && error.detail === undefined && error.cause === undefined);
});

test('unknown write COMMIT returns a redacted same-identity-only instruction', async () => {
  const secret = 'commit leaked business row';
  const pool = fakePool(text => {
    if (text.includes('ingestions')) return { rows: [{ id: '9' }], rowCount: 1 };
    if (text.includes('snapshots')) return { rows: [{ id: '10' }], rowCount: 1 };
    if (text === 'COMMIT') throw Object.assign(Error(secret), { detail: secret });
    return { rows: [], rowCount: 1 };
  });
  await assert.rejects(createMarketHistoryRepository({ pool }).ingest({ sourceFile: 'insights-1.json', contentHash: 'commit', data: insights() }), error => {
    assert.equal(error instanceof HistoryRepositoryError, true);
    assert.equal(error.code, 'OUTCOME_UNKNOWN');
    assert.match(error.message, /sourceFile.*contentHash/u);
    assert.match(error.message, /автоматический повтор/u);
    assert.equal(error.message.includes(secret), false);
    assert.equal(error.detail, undefined);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(pool.calls.some(call => call.text === 'ROLLBACK'), true);
  assert.deepEqual(pool.calls.at(-1), { release: true });
});

test('report query failures are redacted and release the acquired client', async () => {
  const secret = 'report row contents';
  const pool = fakePool(text => {
    if (text.startsWith('WITH ranked')) throw Error(secret);
    return { rows: [], rowCount: 0 };
  });
  await assert.rejects(createMarketHistoryRepository({ pool }).report({ from: '2026-09-18', to: '2026-09-19' }), error => error instanceof HistoryRepositoryError && error.code === 'DATABASE_ERROR' && !error.message.includes(secret) && error.cause === undefined);
  assert.equal(pool.calls.some(call => call.text === 'ROLLBACK'), true);
  assert.deepEqual(pool.calls.at(-1), { release: true });
});

test('report filters in SQL and preserves empty covered days and unknown-unit semantics', async () => {
  const pool = fakePool(text => {
    if (text.startsWith('WITH ranked') && text.includes('SELECT market,store_id')) return { rows: [{ market: 'Ozon', store_id: '001', day: '2026-09-18' }, { market: 'Ozon', store_id: '001', day: '2026-09-19' }] };
    if (text.startsWith('WITH ranked') && text.includes('SELECT r.market')) return { rows: [{ market: 'Ozon', store_id: '001', day: '2026-09-18', product_id: '0001', value: 100, unknown_unit_rows: '2', name: 'Товар' }] };
    return { rows: [], rowCount: 0 };
  });
  const report = await createMarketHistoryRepository({ pool }).report({ from: '2026-09-18', to: '2026-09-19', market: 'Ozon', storeId: '001', productId: '0001', metric: 'revenue' });
  assert.equal(report.coverage.confirmedStoreDays, 2);
  assert.deepEqual(report.rows[0].weekday, { days: 1, value: 100, averagePerDay: 100 });
  assert.deepEqual(report.rows[0].weekend, { days: 1, value: 0, averagePerDay: 0 });
  assert.deepEqual(report.rows[0].totals, { value: 100, revenue: 100, unknownUnitRows: 2, unitsComplete: false });
  const coverage = pool.calls.find(call => call.text?.includes('SELECT market,store_id'));
  const facts = pool.calls.find(call => call.text?.includes('SELECT r.market'));
  assert.match(coverage.text, /day BETWEEN \$1::date AND \$2::date/u);
  assert.match(coverage.text, /market=\$4 AND store_id=\$5/u);
  assert.match(facts.text, /r\.market=\$4 AND r\.store_id=\$5 AND f\.product_id=\$6/u);
  assert.match(facts.text, /ORDER BY source_actual_at DESC,id DESC/u);
  assert.deepEqual(facts.values, ['2026-09-18', '2026-09-19', ['ozon-orders', 'wb-orders'], 'Ozon', '001', '0001']);
  assert.equal(pool.calls[1].text, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(pool.calls.at(-2).text, 'COMMIT');
});

test('status returns safe counts and never returns a source filename', async () => {
  const pool = fakePool(() => ({ rows: [{ ingestions: '2', snapshots: '3', facts: '4', events: '5', last_import: { captured_at: '2026-09-21T09:00:00.000Z', source_kind: 'ozon-orders' } }] }));
  const status = await createMarketHistoryRepository({ pool }).status();
  assert.deepEqual(status, { ingestions: 2, snapshots: 3, facts: 4, events: 5, lastImport: { captured_at: '2026-09-21T09:00:00.000Z', source_kind: 'ozon-orders' }, retention: 'unbounded' });
  assert.equal(JSON.stringify(status).includes('source.json'), false);
});

test('report validation matches the local contract before acquiring a connection', async () => {
  const pool = fakePool();
  const repo = createMarketHistoryRepository({ pool });
  await assert.rejects(repo.report({ from: '2026-02-30', to: '2026-03-01' }), /календар/u);
  await assert.rejects(repo.report({ from: '2026-01-01', to: '2026-01-02', metric: 'net' }), /метрик/u);
  await assert.rejects(repo.report({ from: '2026-01-01', to: '2026-01-02', market: 'Other' }), /площадк/u);
  assert.equal(pool.calls.some(call => call.connect), false);
});

const integrationUrl = process.env.PULT_TEST_DATABASE_URL;
test('PostgreSQL integration: ingest, correction selection and report parity', { skip: !integrationUrl }, async () => {
  const parsed = new URL(integrationUrl), databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  assert.match(databaseName, /test/iu, 'PULT_TEST_DATABASE_URL must name an explicit test database');
  const { Pool } = require('pg'), pool = new Pool({ connectionString: integrationUrl, max: 2 });
  let lastSqlState = null, lastSqlPosition = null;
  const diagnosticPool = {
    query: (...args) => pool.query(...args),
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (...args) => {
          try { return await client.query(...args); }
          catch (error) {
            lastSqlState = /^[0-9A-Z]{5}$/u.test(error?.code || '') ? error.code : 'UNKNOWN';
            lastSqlPosition = /^\d+$/u.test(error?.position || '') ? error.position : null;
            throw error;
          }
        },
        release: () => client.release()
      };
    }
  };
  const schema = `pult_history_test_${crypto.randomBytes(8).toString('hex')}`;
  let owned = false;
  try {
    const existing = await pool.query('SELECT to_regnamespace($1)::text AS namespace', [schema]);
    assert.equal(existing.rows[0].namespace, null);
    await pool.query(schemaSql.replaceAll('pult_history', schema)); owned = true;
    const repo = createMarketHistoryRepository({ pool: diagnosticPool, schema });
    const capturedText = '2026-09-21T12:00:00+03:00', actualText = '2026-09-21T11:00:00+03:00';
    const first = await repo.ingest({ sourceFile: 'insights-1.json', contentHash: 'one', data: insights(actualText), capturedAt: capturedText });
    assert.equal(first.duplicate, false);
    const exactTimes = await pool.query(`SELECT i.captured_at_text,s.source_actual_at_text FROM "${schema}".ingestions i JOIN "${schema}".snapshots s ON s.ingestion_id=i.id WHERE i.content_hash='one' ORDER BY s.id LIMIT 1`);
    assert.deepEqual(exactTimes.rows[0], { captured_at_text: capturedText, source_actual_at_text: actualText });
    assert.deepEqual(await repo.ingest({ sourceFile: 'insights-1.json', contentHash: 'one', data: insights() }), { duplicate: true });
    await repo.ingest({ sourceFile: 'insights-1.json', contentHash: 'old', data: insights('2026-09-21T07:00:00Z', [{ date: '2026-09-18', sku: '0001', units: 9, revenue: 900 }]) });
    let report;
    try { report = await repo.report({ from: '2026-09-18', to: '2026-09-20', market: 'Ozon', storeId: '1', productId: '0001', metric: 'revenue' }); }
    catch (error) { assert.fail(`report failed with sanitized SQLSTATE ${lastSqlState || 'UNKNOWN'}, position ${lastSqlPosition || 'UNKNOWN'}, repository code ${error.code || 'UNKNOWN'}`); }
    assert.equal(report.rows[0].totals.value, 100);
    assert.equal(report.coverage.confirmedStoreDays, 3);
    assert.equal((await repo.status()).ingestions, 2);
  } finally {
    if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});
