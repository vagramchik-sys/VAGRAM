'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const schemaSql = require('../storage/postgres-market-schema.cjs');
const { importMarket } = require('../storage/postgres-market-import.cjs');
const { createMarketRepository, MarketRepositoryError } = require('../storage/postgres-market-repository.cjs');
const { summarize } = require('../summary.cjs');

function fakePool(handler) {
  const calls = [];
  const client = {
    async query(text, values) { calls.push({ text, values }); return handler(text, values, calls); },
    release() { calls.push({ release: true }); }
  };
  return { calls, async connect() { calls.push({ connect: true }); return client; } };
}
const metadata = (counts = {}) => ({
  snapshot_id: crypto.randomUUID(),
  source_metadata: { store: 'Synthetic', completedAt: '2026-01-03T00:00:00Z', zero: 0, unknown: null },
  source_array_presence: { products: true, stocks: true, operations: true, stockRows: false, categoryTree: false },
  expected_counts: { products: 1, stocks: 0, operations: 1, stockRows: 0, categoryTree: 0, ...counts },
  verified_counts: { products: 1, stocks: 0, operations: 1, stockRows: 0, categoryTree: 0, stockItems: 0, financeOperationSkus: 0, ...counts }
});

test('getSnapshot reconstructs the exact source shape from the required presence map', async () => {
  const current = metadata(), product = { product_id: 1, price: 0, nullable: null }, operation = { operation_id: 2, date: '2026-01-02' };
  const pool = fakePool(text => {
    if (text.includes('FROM "pult_market"."current_snapshots"')) return { rows: [current] };
    if (text.includes('FROM "pult_market"."products"')) return { rows: [{ raw_row: product }] };
    if (text.includes('FROM "pult_market"."finance_operations"')) return { rows: [{ raw_row: operation }] };
    return { rows: [] };
  });
  const result = await createMarketRepository({ pool }).getSnapshot('10');
  assert.deepEqual(result, { ...current.source_metadata, products: [product], stocks: [], operations: [operation] });
  assert.equal(Object.hasOwn(result, 'stockRows'), false);
  assert.equal(pool.calls.some(call => call.text?.includes('source_documents') || call.text?.includes('exact_bytes')), false);
  assert.equal(pool.calls[1].text, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(pool.calls.at(-2).text, 'COMMIT');
});

test('getSummarySnapshot keeps summary inputs and omits unused snapshot arrays and operation fields', async () => {
  const current = metadata(), product = { product_id: 1, name: 'One' }, stock = { product_id: 1, present: 0 };
  const sourceOperations = [
    { operation_type_name: '', operation_type: 'Sale', total_amount: { currency: 'USD', unused: 'drop' }, amount: 1.005, date: '2026-01-02T01:02:03Z', unused: { huge: true } },
    { sellerOperName: 'Возврат', currency: null, amount: 0, rrDate: '2026-01-03', docTypeName: null },
    { docTypeName: 'WB sale', amount: -2.345, saleDt: '2026-01-04', total_amount: null }
  ];
  const projected = [
    { operation_type_name: '', operation_type: 'Sale', total_amount: { currency: 'USD' }, amount: 1.005, date: '2026-01-02T01:02:03Z' },
    { sellerOperName: 'Возврат', currency: null, amount: 0, rrDate: '2026-01-03', docTypeName: null },
    { docTypeName: 'WB sale', amount: -2.345, saleDt: '2026-01-04', total_amount: null }
  ];
  const state = { ...current, expected_counts: { ...current.expected_counts, stocks: 1, operations: 3 }, verified_counts: { ...current.verified_counts, stocks: 1, operations: 3 } };
  const pool = fakePool(text => {
    if (text.includes('current_snapshots')) return { rows: [state] };
    if (text.includes('FROM "pult_market"."products"')) return { rows: [{ raw_row: product }] };
    if (text.includes('FROM "pult_market"."stocks"')) return { rows: [{ raw_row: stock }] };
    if (text.includes('FROM "pult_market"."finance_operations"')) return { rows: projected.map(raw_row => ({ raw_row })) };
    return { rows: [] };
  });
  const result = await createMarketRepository({ pool }).getSummarySnapshot('10');
  assert.deepEqual(result, { ...current.source_metadata, products: [product], stocks: [stock], operations: projected });
  assert.equal(Object.hasOwn(result, 'stockRows'), false); assert.equal(Object.hasOwn(result, 'categoryTree'), false);
  assert.deepEqual(summarize(result, null, null), summarize({ ...current.source_metadata, products: [product], stocks: [stock], operations: sourceOperations }, null, null));
  const operationQuery = pool.calls.find(call => call.text?.includes('FROM "pult_market"."finance_operations"'));
  assert.match(operationQuery.text, /jsonb_build_object\('currency',raw_row->'total_amount'->'currency'\)/u);
  assert.doesNotMatch(operationQuery.text, /stock_rows|category_tree_rows/u);
});

test('products filters typed columns with parameters and returns raw rows plus source coverage', async () => {
  const current = metadata({ products: 2 }), row = { product_id: '9007199254740993', sku: '001', offer_id: '=offer', price: 0 };
  const pool = fakePool(text => {
    if (text.includes('current_snapshots')) return { rows: [current] };
    if (text.includes('AS source_count')) return { rows: [{ source_count: '2' }] };
    if (text.startsWith('SELECT count(*)')) return { rows: [{ count: '1' }] };
    if (text.startsWith('SELECT r.raw_row')) return { rows: [{ raw_row: row }] };
    return { rows: [] };
  });
  const result = await createMarketRepository({ pool }).products({ storeId: '10', productId: '9007199254740993', sku: '001', offerId: '=offer', limit: 5, offset: 2 });
  assert.deepEqual(result.rows, [row]);
  assert.deepEqual(result.coverage, { complete: true, sourceRows: 2, present: true, matched: 1 });
  assert.deepEqual({ total: result.total, limit: result.limit, offset: result.offset }, { total: 1, limit: 5, offset: 2 });
  const rows = pool.calls.find(call => call.text?.startsWith('SELECT r.raw_row'));
  assert.deepEqual(rows.values, [current.snapshot_id, '9007199254740993', '001', '=offer', 5, 2]);
  assert.match(rows.text, /r\.product_id=\$2 AND r\.sku=\$3 AND r\.offer_id=\$4/u);
  assert.match(rows.text, /ORDER BY r\.source_index ASC/u);
  assert.equal(rows.text.includes('9007199254740993'), false);
});

test('stocks and operations use derived SKU keys and textual DATE parameters', async () => {
  const current = metadata({ stocks: 2, operations: 3 });
  const pool = fakePool(text => {
    if (text.includes('current_snapshots')) return { rows: [current] };
    if (text.includes('AS source_count')) return { rows: [{ source_count: text.includes('finance_operations') ? '3' : '2' }] };
    if (text.startsWith('SELECT count(*)')) return { rows: [{ count: '0' }] };
    if (text.startsWith('SELECT r.raw_row')) return { rows: [] };
    return { rows: [] };
  });
  const repo = createMarketRepository({ pool });
  await repo.stocks({ storeId: '10', productId: 1, sku: '501', warehouse: 'w1' });
  const stockQuery = pool.calls.find(call => call.text?.startsWith('SELECT r.raw_row'));
  assert.match(stockQuery.text, /FROM "pult_market"\."stock_items" si/u);
  assert.match(stockQuery.text, /FROM "pult_market"\."stock_items" wi/u);
  assert.deepEqual(stockQuery.values.slice(0, 4), [current.snapshot_id, '1', '501', 'w1']);
  pool.calls.length = 0;
  await repo.operations({ storeId: '10', from: '2026-01-01', to: '2026-01-02', operationId: 7, operationType: 'Sale', sku: 501 });
  const operationQuery = pool.calls.find(call => call.text?.startsWith('SELECT r.raw_row'));
  assert.match(operationQuery.text, /r\.operation_day>=\$4::date AND r\.operation_day<=\$5::date/u);
  assert.match(operationQuery.text, /FROM "pult_market"\."finance_operation_skus" os/u);
  assert.deepEqual(operationQuery.values.slice(0, -2), [current.snapshot_id, '7', 'Sale', '2026-01-01', '2026-01-02', '501']);
});

test('missing current snapshot is explicit and validation and SQL errors are sanitized', async () => {
  const absent = fakePool(text => text.includes('current_snapshots') ? { rows: [] } : { rows: [] });
  const repo = createMarketRepository({ pool: absent });
  assert.equal(await repo.getSnapshot('missing'), null);
  assert.deepEqual(await repo.products({ storeId: 'missing' }), { rows: [], total: null, limit: 100, offset: 0, coverage: { complete: false, reason: 'NO_CURRENT_SNAPSHOT' } });
  for (const call of [() => repo.products({}), () => repo.products({ storeId: '10', limit: 1001 }), () => repo.operations({ storeId: '10', from: '2026-02-30' }), () => repo.operations({ storeId: '10', from: '2026-02-02', to: '2026-02-01' })]) await assert.rejects(call, error => error instanceof MarketRepositoryError && error.public === true);
  assert.throws(() => createMarketRepository({ pool: absent, schema: 'bad-schema' }), /identifier/u);

  const incomplete = fakePool(text => text.includes('current_snapshots') ? { rows: [{ ...metadata(), source_array_presence: null }] } : { rows: [] });
  await assert.rejects(createMarketRepository({ pool: incomplete }).getSnapshot('10'), error => error.code === 'INCOMPLETE_SNAPSHOT');

  const failing = fakePool(() => { throw Object.assign(Error('private row value'), { detail: 'private row value' }); });
  await assert.rejects(createMarketRepository({ pool: failing }).getSnapshot('10'), error => error instanceof MarketRepositoryError && error.code === 'DATABASE_ERROR' && !error.message.includes('private') && error.cause === undefined && error.detail === undefined);
  assert.equal(failing.calls.some(call => call.text === 'ROLLBACK'), true);
});

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pult-market-repository-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const snapshot = {
    store: 'Synthetic Ozon', clientId: '10', completedAt: '2026-01-03T00:00:00Z', zero: 0, nullable: null,
    products: [{ product_id: 101, sku: '00501', offer_id: '=offer', price: 0 }, { product_id: '9007199254740993', sku: '502', offer_id: null }],
    stocks: [{ product_id: 101, offer_id: '=offer', stocks: [{ sku: '00501', present: 0, reserved: null, warehouse_ids: ['w1'] }] }],
    operations: [{ operation_id: 7, date: '2026-01-02T05:06:07Z', operation_type: 'Sale', amount: 1.005, total_amount: { currency: 'USD', unused: 'drop' }, posting: { products: [{ sku: '00501', quantity: 1 }] }, unused: 'drop' }, { operation_id: 8, sellerOperName: 'Возврат', amount: 0, currency: null, rrDate: '2026-01-02', docTypeName: null }, { operation_id: 9, docTypeName: 'WB sale', amount: -2.345, saleDt: '2026-01-02', total_amount: null }],
    categoryTree: []
  };
  await fs.writeFile(path.join(directory, 'stores.json'), JSON.stringify({ '10': { name: 'Synthetic Ozon', key: 'opaque-ciphertext' } }));
  await fs.writeFile(path.join(directory, 'data-10.json'), JSON.stringify(snapshot));
  return { directory, snapshot };
}

const integrationUrl = process.env.PULT_TEST_DATABASE_URL;
test('PostgreSQL integration: importer rows reconstruct current snapshot and typed filters', { skip: !integrationUrl }, async t => {
  const parsed = new URL(integrationUrl), databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  assert.match(databaseName, /test/iu, 'PULT_TEST_DATABASE_URL must name an explicit test database');
  const { Pool, types } = require('pg');
  const pool = new Pool({ connectionString: integrationUrl, max: 3, types: {
    getTypeParser: (oid, format) => oid === 1082 ? () => { throw Error('DATE must be projected as text'); } : types.getTypeParser(oid, format)
  } });
  const source = await fixture(t);
  let owned = false;
  try {
    const existing = await pool.query("SELECT to_regnamespace('pult_market')::text AS namespace");
    assert.equal(existing.rows[0].namespace, null, 'test database already contains pult_market; refusing to modify it');
    await pool.query(schemaSql); owned = true;
    assert.deepEqual(await importMarket({ pool, sourceDir: source.directory }), { stores: 1, imported: 1, reused: 0, verified: 1 });
    const repo = createMarketRepository({ pool });
    const reconstructed = await repo.getSnapshot('10');
    assert.deepEqual(reconstructed, source.snapshot);
    const summarySnapshot = await repo.getSummarySnapshot('10');
    assert.deepEqual(summarize(summarySnapshot, null, null), summarize(source.snapshot, null, null));
    assert.deepEqual(summarySnapshot.operations, [{ date: '2026-01-02T05:06:07Z', operation_type: 'Sale', amount: 1.005, total_amount: { currency: 'USD' } }, { sellerOperName: 'Возврат', amount: 0, currency: null, rrDate: '2026-01-02', docTypeName: null }, { docTypeName: 'WB sale', amount: -2.345, saleDt: '2026-01-02', total_amount: null }]);
    assert.deepEqual((await repo.products({ storeId: '10', sku: '00501' })).rows, [source.snapshot.products[0]]);
    assert.deepEqual((await repo.stocks({ storeId: '10', sku: '00501' })).rows, source.snapshot.stocks);
    assert.deepEqual((await repo.operations({ storeId: '10', from: '2026-01-02', to: '2026-01-02', sku: '00501' })).rows, [source.snapshot.operations[0]]);
    assert.deepEqual(await repo.products({ storeId: '10', productId: 'absent' }), { rows: [], total: 0, limit: 100, offset: 0, coverage: { complete: true, sourceRows: 2, present: true, matched: 0 } });
  } finally {
    if (owned) await pool.query('DROP SCHEMA pult_market CASCADE');
    await pool.end();
  }
});
