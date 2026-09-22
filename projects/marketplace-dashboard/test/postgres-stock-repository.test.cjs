'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const historySchema = require('../storage/postgres-history-schema.cjs');
const { createStockHistoryRepository, StockRepositoryError, LIMITATIONS } = require('../storage/postgres-stock-repository.cjs');
const publicValue = value => JSON.parse(JSON.stringify(value));

function fakePool(handler) {
  const calls = [];
  const client = {
    async query(text, values) { calls.push({ text, values }); return handler(text, values, calls); },
    release() { calls.push({ release: true }); }
  };
  return { calls, async connect() { calls.push({ connect: true }); return client; } };
}

test('report parameterizes filters, escapes literal search and makes SQLite null ordering explicit', async () => {
  const pool = fakePool(text => {
    if (text.startsWith('SELECT count(*)')) return { rows: [{ n: '2' }] };
    if (text.startsWith('SELECT to_char(day')) return { rows: [
      { day: '2026-09-08', observedAt: null, source: 'daily-total', storeId: '11', storeName: null, sku: '999', article: null, name: 'Другой', warehouse: null, warehouseId: null, cluster: null, totalStock: '9007199254740993', available: null, inTransit: '0', reserved: null, quality: null }
    ] };
    return { rows: [] };
  });
  const report = await createStockHistoryRepository({ pool }).report({ store: '11', q: '_100%', from: '2026-09-01', limit: 1, offset: 1 });
  assert.equal(report.total, 2);
  assert.equal(report.rows[0].totalStock, '9007199254740993');
  assert.equal(report.rows[0].available, null);
  assert.equal(report.rows[0].inTransit, 0);
  const select = pool.calls.find(call => call.text?.startsWith('SELECT to_char(day'));
  assert.deepEqual(select.values, ['daily-total', '11', '2026-09-01', '%\\_100\\%%', 1, 1]);
  assert.match(select.text, /translate\(name COLLATE "C".*LIKE translate\(\$4::text COLLATE "C".*ESCAPE '\\'/u);
  assert.match(select.text, /day DESC NULLS LAST,observed_at DESC NULLS LAST,store_name COLLATE "C" ASC NULLS FIRST,sku COLLATE "C" ASC NULLS FIRST,warehouse_id COLLATE "C" ASC NULLS FIRST,id COLLATE "C" ASC NULLS FIRST/u);
  assert.equal(select.text.includes('_100%'), false);
  assert.equal(pool.calls[1].text, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(pool.calls.at(-2).text, 'COMMIT');
  assert.deepEqual(pool.calls.at(-1), { release: true });
});

test('status uses textual dates, keeps source and store dimensions, and preserves large counts', async () => {
  const pool = fakePool(text => {
    if (text.includes('GROUP BY source')) return { rows: [{ id: 'daily-total', records: '3', from: '2026-09-01', to: '2026-09-08' }] };
    if (text.includes('GROUP BY store_id')) return { rows: [{ id: '11', name: 'Первый' }] };
    if (text.includes('count(*)::text AS records')) return { rows: [{ records: '9007199254740994', from: '2026-09-01', to: '2026-09-08' }] };
    if (text.includes('SELECT DISTINCT')) return { rows: [{ n: '2' }] };
    if (text.includes('imported_at_text')) return { rows: [{ imported_at_text: '2026-09-08T01:02:03.004Z' }] };
    return { rows: [] };
  });
  const status = await createStockHistoryRepository({ pool }).status();
  assert.equal(status.records, '9007199254740994');
  assert.equal(status.products, 2);
  assert.deepEqual(status.stores, [{ id: '11', name: 'Первый' }]);
  assert.deepEqual(status.sources[0], { id: 'daily-total', records: 3, from: '2026-09-01', to: '2026-09-08', label: 'Дневная история — товары' });
  assert.equal(status.importedAt, '2026-09-08T01:02:03.004Z');
  assert.deepEqual(status.limitations, LIMITATIONS);
  assert.match(pool.calls.find(call => call.text?.includes('min(day)')).text, /to_char\(min\(day\),'YYYY-MM-DD'\)/u);
});

test('csv retains leading zeroes, protects spreadsheet cells and uses the same SQL scope', async () => {
  const pool = fakePool(text => text.startsWith('SELECT to_char(day') ? { rows: [{ day: '2026-09-07', observedAt: '2026-09-07T07:44:15.694Z', source: 'daily-total', storeId: '11', storeName: 'Первый', sku: '00123', article: '=TEST', name: 'Товар_100%', warehouse: null, warehouseId: null, cluster: null, totalStock: '20', available: null, inTransit: '0', reserved: null, quality: 'Снимок источника' }] } : { rows: [] });
  const csv = await createStockHistoryRepository({ pool }).csv({ store: '11', sku: '00123' });
  assert.equal(csv.startsWith('\ufeff'), true);
  assert.match(csv, /"00123"/u);
  assert.match(csv, /"'=TEST"/u);
  assert.equal(csv.split('\r\n').length, 2);
  const select = pool.calls.find(call => call.text?.startsWith('SELECT to_char(day'));
  assert.deepEqual(select.values, ['daily-total', '11', '00123']);
});

test('validation happens before connection and database details are redacted', async () => {
  const pool = fakePool(() => { throw Object.assign(Error('secret row value'), { detail: 'secret row value' }); });
  const repo = createStockHistoryRepository({ pool });
  for (const options of [{ source: 'all' }, { from: '2026-02-30' }, { from: '2026-10-01', to: '2026-09-01' }, { limit: 500 }, { offset: -1 }, { q: 'x'.repeat(201) }]) {
    await assert.rejects(repo.report(options), error => error instanceof StockRepositoryError && error.public === true);
  }
  assert.equal(pool.calls.length, 0);
  await assert.rejects(repo.status(), error => error instanceof StockRepositoryError && error.code === 'DATABASE_ERROR' && !error.message.includes('secret') && error.cause === undefined && error.detail === undefined);
  assert.equal(pool.calls.some(call => call.text === 'ROLLBACK'), true);
  assert.deepEqual(pool.calls.at(-1), { release: true });
  assert.throws(() => createStockHistoryRepository({ pool, schema: 'bad-schema' }), /identifier/u);
});

const integrationUrl = process.env.PULT_TEST_DATABASE_URL;
test('PostgreSQL integration: status, report and CSV match the legacy SQLite contract', { skip: !integrationUrl }, async t => {
  const parsed = new URL(integrationUrl), databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  assert.match(databaseName, /test/iu, 'PULT_TEST_DATABASE_URL must name an explicit test database');
  const { Pool } = require('pg');
  const { create, ingest } = require('../stock-history.cjs');
  const pool = new Pool({ connectionString: integrationUrl, max: 2 });
  const schema = `pult_stock_test_${crypto.randomBytes(8).toString('hex')}`;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pult-stock-pg-'));
  const dbFile = path.join(temp, 'stocks.sqlite');
  let owned = false;
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const observedAt = '2026-09-07T07:44:15.694Z', importedAt = '2026-09-09T01:02:03.004Z';
  const fixture = [
    { day: '2026-09-07', observedAt, source: 'daily-total', storeId: '11', storeName: 'Первый', sku: '00123', article: '=TEST', name: 'Товар_100%', warehouse: null, warehouseId: null, cluster: null, totalStock: 20, available: null, inTransit: 0, reserved: null, quality: 'Снимок источника', sourceFile: 'daily.json', sourceRow: 0 },
    { day: '2026-09-08', observedAt: null, source: 'daily-total', storeId: '11', storeName: 'Первый', sku: '999', article: null, name: 'Другой', warehouse: null, warehouseId: null, cluster: null, totalStock: 9, available: 0, inTransit: null, reserved: null, quality: null, sourceFile: 'daily.json', sourceRow: 1 },
    { day: '2026-09-07', observedAt, source: 'daily-warehouse', storeId: '11', storeName: 'Первый', sku: '00123', article: '=TEST', name: 'Товар_100%', warehouse: 'Склад', warehouseId: 'w', cluster: null, totalStock: 7, available: null, inTransit: 0, reserved: null, quality: 'Снимок источника', sourceFile: 'daily.json', sourceRow: 2 }
  ];
  try {
    const existing = await pool.query('SELECT to_regnamespace($1)::text AS namespace', [schema]);
    assert.equal(existing.rows[0].namespace, null);
    await pool.query(historySchema.replaceAll('pult_history', schema)); owned = true;
    ingest({ dbFile, rows: fixture, importId: 'a'.repeat(64), manifest: [], issues: [], now: importedAt });
    await pool.query(`INSERT INTO "${schema}"."stock_imports"(id,imported_at,imported_at_text,manifest,manifest_text,issues,issues_text) VALUES($1,$2::timestamptz,$3::text,'[]'::jsonb,'[]','[]'::jsonb,'[]')`, ['a'.repeat(64), importedAt, importedAt]);
    for (const [index, row] of fixture.entries()) {
      await pool.query(`INSERT INTO "${schema}"."stock_rows"(id,day,observed_at,observed_at_text,source,store_id,store_name,sku,article,name,warehouse,warehouse_id,cluster,total_stock,available,in_transit,reserved,quality,details,details_text) VALUES($1,$2::date,$3::timestamptz,$4::text,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::bigint,$15::bigint,$16::bigint,$17::bigint,$18,'{}'::jsonb,'{}')`, [String(index), row.day, row.observedAt, row.observedAt, row.source, row.storeId, row.storeName, row.sku, row.article, row.name, row.warehouse, row.warehouseId, row.cluster, row.totalStock, row.available, row.inTransit, row.reserved, row.quality]);
    }
    const legacy = create({ dbFile }), postgres = createStockHistoryRepository({ pool, schema });
    assert.deepEqual(publicValue(await postgres.status()), publicValue(legacy.status()));
    for (const options of [{}, { q: '_100%' }, { from: '2026-09-08', to: '2026-09-08' }, { limit: 1, offset: 1 }, { source: 'daily-warehouse', store: '11', sku: '00123' }]) assert.deepEqual(publicValue(await postgres.report(options)), publicValue(legacy.report(options)));
    assert.equal(await postgres.csv({ store: '11', sku: '00123' }), legacy.csv({ store: '11', sku: '00123' }));
    await pool.query(`INSERT INTO "${schema}"."stock_rows"(id,day,source,store_id,store_name,sku,total_stock,details,details_text) VALUES('large','2026-09-09','daily-total','11','Первый','large',9007199254740993,'{}'::jsonb,'{}')`);
    assert.equal((await postgres.report({ sku: 'large' })).rows[0].totalStock, '9007199254740993');
  } finally {
    if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});
