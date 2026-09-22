'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { importMarket, MarketImportError, BATCH_SIZE, canonical, requestRowHash } = require('../storage/postgres-market-import.cjs');

const WIDTHS = { category_tree_rows: 6, finance_operations: 8, products: 8, stock_rows: 8, stocks: 7 };
const TYPED = {
  category_tree_rows: ['category_id'], finance_operations: ['operation_id', 'operation_day', 'operation_type'],
  products: ['product_id', 'sku', 'offer_id'], stock_rows: ['product_id', 'sku', 'warehouse_id'], stocks: ['product_id', 'offer_id']
};
class FakeDatabase {
  constructor() {
    this.calls = [];
    this.documents = new Map();
    this.snapshots = new Map();
    this.rows = new Map([...Object.keys(WIDTHS), 'stock_items', 'finance_operation_skus'].map(name => [name, []]));
    this.nextDocument = 1;
    this.client = { query: this.query.bind(this), release: () => this.calls.push({ release: true }) };
  }
  async connect() { return this.client; }
  async query(text, values = []) {
    this.calls.push({ text, values });
    if (text.includes('INSERT INTO pult_market.source_documents')) {
      const id = this.documents.get(values[0])?.id || String(this.nextDocument++);
      this.documents.set(values[0], { id, sha: Buffer.from(values[1]), bytes: Buffer.from(values[2]) });
      const document = this.documents.get(values[0]);
      return { rows: [{ source_document_id: id, sha256: document.sha, byte_length: String(document.bytes.length), exact_bytes: document.bytes }], rowCount: 1 };
    }
    if (text.startsWith('SELECT market FROM')) return { rows: [] };
    if (text.includes('source_byte_length') && text.includes('snapshot_versions v')) {
      const item = [...this.snapshots.values()].find(row => row.storeId === values[0] && row.sha.equals(values[1]));
      const document = item && [...this.documents.values()].find(value => value.id === item.documentId);
      return { rows: item ? [{ snapshot_id: item.id, complete: item.complete, source_byte_length: item.byteLength,
        row_digest: item.rowDigest, exact_bytes: document.bytes, document_sha256: document.sha, document_byte_length: String(document.bytes.length) }] : [] };
    }
    if (text.includes('INSERT INTO pult_market.snapshot_versions')) {
      this.snapshots.set(values[0], { id: values[0], storeId: values[1], documentId: values[2], sha: Buffer.from(values[3]), byteLength: values[4], complete: false });
      return { rows: [], rowCount: 1 };
    }
    for (const [table, width] of Object.entries(WIDTHS)) if (text.includes(`INSERT INTO pult_market.${table}`)) {
      const target = this.rows.get(table);
      for (let offset = 0; offset < values.length; offset += width) {
        const row = { snapshotId: values[offset], store_id: values[offset + 1], index: values[offset + 2], row_sha256: values[offset + width - 2], raw: JSON.parse(values[offset + width - 1]) };
        TYPED[table].forEach((name, index) => { row[name] = values[offset + 3 + index]; });
        target.push(row);
      }
      return { rows: [], rowCount: values.length / width };
    }
    if (text.includes('INSERT INTO pult_market.stock_items')) {
      for (let offset = 0; offset < values.length; offset += 7) this.rows.get('stock_items').push({ snapshotId: values[offset],
        store_id: values[offset + 1], stock_source_index: values[offset + 2], item_index: values[offset + 3], sku: values[offset + 4], warehouse: values[offset + 5], raw_row: JSON.parse(values[offset + 6]) });
      return { rows: [], rowCount: values.length / 7 };
    }
    if (text.includes('INSERT INTO pult_market.finance_operation_skus')) {
      for (let offset = 0; offset < values.length; offset += 7) this.rows.get('finance_operation_skus').push({ snapshotId: values[offset],
        store_id: values[offset + 1], operation_source_index: values[offset + 2], item_index: values[offset + 3], sku: values[offset + 4], operation_day: values[offset + 5],
        raw_item: values[offset + 6] == null ? null : JSON.parse(values[offset + 6]) });
      return { rows: [], rowCount: values.length / 7 };
    }
    const countMatch = /SELECT count\(\*\).*FROM pult_market\.([a-z_]+)/u.exec(text);
    if (countMatch) return { rows: [{ count: String(this.rows.get(countMatch[1]).filter(row => row.snapshotId === values[0]).length) }] };
    const selectMatch = /SELECT store_id,source_index,[\s\S]*?FROM pult_market\.([a-z_]+)/u.exec(text);
    if (selectMatch) return { rows: this.rows.get(selectMatch[1])
      .filter(row => row.snapshotId === values[0] && row.index >= values[1])
      .sort((a, b) => a.index - b.index).slice(0, values[2])
      .map(row => ({ store_id: row.store_id, source_index: row.index, raw_row: row.raw, row_sha256: row.row_sha256,
        ...Object.fromEntries(TYPED[selectMatch[1]].map(name => [name, row[name]])) })) };
    if (text.includes('FROM pult_market.stock_items') && text.includes('SELECT store_id,stock_source_index')) return { rows: this.rows.get('stock_items')
      .filter(row => row.snapshotId === values[0]).sort((a, b) => a.stock_source_index - b.stock_source_index || a.item_index - b.item_index)
      .slice(values[1], values[1] + values[2]) };
    if (text.includes('FROM pult_market.finance_operation_skus') && text.includes('SELECT store_id,operation_source_index')) return { rows: this.rows.get('finance_operation_skus')
      .filter(row => row.snapshotId === values[0]).sort((a, b) => a.operation_source_index - b.operation_source_index || a.item_index - b.item_index || a.sku.localeCompare(b.sku))
      .slice(values[1], values[1] + values[2]) };
    if (text.includes('UPDATE pult_market.snapshot_versions SET')) {
      this.snapshots.get(values[0]).complete = true;
      this.snapshots.get(values[0]).rowDigest = Buffer.from(values[2]);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  }
}

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pult-market-import-'));
  const registry = {
    '10': { name: 'Synthetic Ozon', key: 'opaque-dpapi-ciphertext' },
    'wb-20': { name: 'Synthetic WB', key: 'opaque-dpapi-ciphertext-2' }
  };
  const ozon = {
    store: 'Synthetic Ozon', clientId: '10', completedAt: '2026-01-03T00:00:00Z', period: { from: '2026-01-01', to: '2026-01-02' },
    products: [{ product_id: 101, sku: 501, offer_id: 'offer-1', price: 0 }, { product_id: '9007199254740993', sku: '502', offer_id: null }],
    stocks: [{ product_id: 101, offer_id: 'offer-1', stocks: [{ sku: 501, present: 0, reserved: null, warehouse_ids: ['w1'] }] }],
    operations: [{ operation_id: 7, date: '2026-01-02', operation_type: 'Sale', total_amount: { amount: 0, currency: 'RUB' }, posting: { products: [{ sku: 501, quantity: 1 }] } }],
    categoryTree: [{ description_category_id: 3, category_name: 'Synthetic', children: [] }]
  };
  const wb = {
    market: 'WB', store: 'Synthetic WB', clientId: '20', completedAt: '2026-01-03T00:00:00Z',
    products: [{ product_id: 201, sku: 201, offer_id: 'vendor' }],
    stocks: [{ product_id: 201, stocks: [{ warehouse: 'Synthetic warehouse', present: 2 }] }],
    stockRows: [{ nmId: 201, warehouseId: 4, quantity: 2 }],
    operations: [{ reportId: 8, rrdId: '9007199254740993', rrDate: '2026-01-02', nmId: 201, retailAmount: 0, deduction: null }]
  };
  await fs.writeFile(path.join(directory, 'stores.json'), JSON.stringify(registry));
  await fs.writeFile(path.join(directory, 'data-10.json'), JSON.stringify(ozon));
  await fs.writeFile(path.join(directory, 'data-wb-20.json'), JSON.stringify(wb));
  return directory;
}

test('imports Ozon and WB top-level source rows with typed keys, exact documents and final pointers', async t => {
  const sourceDir = await fixture();
  t.after(() => fs.rm(sourceDir, { recursive: true, force: true }));
  const database = new FakeDatabase(), progress = [];
  const result = await importMarket({ pool: database, sourceDir, onProgress: event => progress.push(event) });
  assert.deepEqual(result, { stores: 2, imported: 2, reused: 0, verified: 2 });
  assert.equal(database.rows.get('products').length, 3);
  assert.equal(database.rows.get('finance_operations').length, 2);
  assert.equal(database.rows.get('stock_rows').length, 1);
  assert.equal(database.calls.filter(call => call.text?.includes('current_snapshots')).length, 2);
  const sourceBytes = await fs.readFile(path.join(sourceDir, 'data-10.json'));
  assert.deepEqual(database.documents.get('data-10.json').bytes, sourceBytes);
  assert.equal(database.rows.get('products')[0].raw.price, 0);
  assert.equal(database.rows.get('products')[1].raw.offer_id, null);
  assert.equal(progress.every(event => Object.keys(event).every(key => ['stage', 'count', 'total'].includes(key))), true);
});

test('same store and exact source SHA is idempotently reused without duplicate rows', async t => {
  const sourceDir = await fixture();
  t.after(() => fs.rm(sourceDir, { recursive: true, force: true }));
  const database = new FakeDatabase();
  await importMarket({ pool: database, sourceDir });
  const before = database.rows.get('finance_operations').length;
  assert.deepEqual(await importMarket({ pool: database, sourceDir }), { stores: 2, imported: 0, reused: 2, verified: 2 });
  assert.equal(database.rows.get('finance_operations').length, before);
});

test('reuse re-verifies exact source bytes and typed projections', async t => {
  const sourceDir = await fixture();
  t.after(() => fs.rm(sourceDir, { recursive: true, force: true }));
  const corruptedBytes = new FakeDatabase();
  await importMarket({ pool: corruptedBytes, sourceDir });
  corruptedBytes.documents.get('data-10.json').bytes[0] ^= 1;
  await assert.rejects(importMarket({ pool: corruptedBytes, sourceDir }), error => error.code === 'SNAPSHOT_CONFLICT');

  const corruptedTyped = new FakeDatabase();
  await importMarket({ pool: corruptedTyped, sourceDir });
  corruptedTyped.rows.get('products')[0].sku = 'wrong-sku';
  await assert.rejects(importMarket({ pool: corruptedTyped, sourceDir }), error => error.code === 'VERIFY_TYPED_MISMATCH');
});

test('batches contain at most 1000 source rows', async t => {
  const sourceDir = await fixture();
  t.after(() => fs.rm(sourceDir, { recursive: true, force: true }));
  const file = path.join(sourceDir, 'data-10.json');
  const snapshot = JSON.parse(await fs.readFile(file, 'utf8'));
  snapshot.operations = Array.from({ length: BATCH_SIZE + 1 }, (_, index) => ({ operation_id: String(index), date: '2026-01-01', amount: index }));
  await fs.writeFile(file, JSON.stringify(snapshot));
  const database = new FakeDatabase();
  await importMarket({ pool: database, sourceDir });
  const inserts = database.calls.filter(call => call.text?.includes('INSERT INTO pult_market.finance_operations') && call.values[1] === '10');
  assert.deepEqual(inserts.map(call => call.values.length / WIDTHS.finance_operations), [1000, 1]);
});

test('canonical row hashes preserve JS zero/null distinctions and ignore object key order', () => {
  assert.equal(canonical({ b: 0, a: null }), canonical({ a: null, b: 0 }));
  assert.deepEqual(requestRowHash({ b: 0, a: null }), requestRowHash({ a: null, b: 0 }));
  assert.notDeepEqual(requestRowHash({ value: 0 }), requestRowHash({ value: null }));
});

test('invalid source shapes fail without exposing registry values', async t => {
  const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pult-market-invalid-'));
  t.after(() => fs.rm(sourceDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(sourceDir, 'stores.json'), '{"10":{"key":"secret-value"}}');
  await fs.writeFile(path.join(sourceDir, 'data-10.json'), '{"operations":{}}');
  await assert.rejects(importMarket({ pool: new FakeDatabase(), sourceDir }), error => {
    assert.equal(error instanceof MarketImportError, true);
    assert.equal(error.code, 'INVALID_SOURCE');
    assert.equal(error.message.includes('secret-value'), false);
    return true;
  });
});

test('rejects unknown top-level arrays instead of silently dropping source rows', async t => {
  const sourceDir = await fixture();
  t.after(() => fs.rm(sourceDir, { recursive: true, force: true }));
  const file = path.join(sourceDir, 'data-10.json');
  const snapshot = JSON.parse(await fs.readFile(file, 'utf8'));
  snapshot.unmappedRows = [{ value: 1 }];
  await fs.writeFile(file, JSON.stringify(snapshot));
  await assert.rejects(importMarket({ pool: new FakeDatabase(), sourceDir }), error => error.code === 'UNHANDLED_SOURCE_ARRAY');
});

test('invalid calendar days become null typed keys while exact JSON is retained', async t => {
  const sourceDir = await fixture();
  t.after(() => fs.rm(sourceDir, { recursive: true, force: true }));
  const file = path.join(sourceDir, 'data-10.json');
  const snapshot = JSON.parse(await fs.readFile(file, 'utf8'));
  snapshot.operations[0].date = '2026-02-30';
  await fs.writeFile(file, JSON.stringify(snapshot));
  const database = new FakeDatabase();
  await importMarket({ pool: database, sourceDir });
  const operation = database.rows.get('finance_operations').find(row => row.raw.date === '2026-02-30');
  assert.equal(operation.operation_day, null);
  assert.equal(operation.raw.date, '2026-02-30');
});

const integrationUrl = process.env.PULT_TEST_DATABASE_URL;
test('PostgreSQL integration: applies schema, imports, verifies and reuses snapshots', { skip: !integrationUrl }, async t => {
  const parsed = new URL(integrationUrl);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  assert.match(databaseName, /test/iu, 'PULT_TEST_DATABASE_URL must name an explicit test database');
  const { Pool, types } = require('pg');
  const pool = new Pool({ connectionString: integrationUrl, max: 3, types: {
    getTypeParser: (oid, format) => oid === 1082 ? () => { throw Error('Business dates must be selected as text without timezone conversion'); } : types.getTypeParser(oid, format)
  } });
  const sourceDir = await fixture();
  let createdSchema = false;
  t.after(() => fs.rm(sourceDir, { recursive: true, force: true }));
  try {
    const existing = await pool.query("SELECT to_regnamespace('pult_market') AS schema_name");
    assert.equal(existing.rows[0].schema_name, null, 'test database already contains pult_market; refusing to modify it');
    await pool.query(require('../storage/postgres-market-schema.cjs'));
    createdSchema = true;
    assert.deepEqual(await importMarket({ pool, sourceDir }), { stores: 2, imported: 2, reused: 0, verified: 2 });
    assert.deepEqual(await importMarket({ pool, sourceDir }), { stores: 2, imported: 0, reused: 2, verified: 2 });
    const result = await pool.query(`SELECT v.complete,d.exact_bytes,p.sku,f.operation_day::text AS operation_day
      FROM pult_market.snapshot_versions v
      JOIN pult_market.source_documents d USING(source_document_id)
      JOIN pult_market.products p USING(snapshot_id)
      JOIN pult_market.finance_operations f USING(snapshot_id)
      WHERE v.store_id='10' ORDER BY p.source_index,f.source_index LIMIT 1`);
    assert.equal(result.rows[0].complete, true);
    assert.equal(result.rows[0].sku, '501');
    assert.equal(result.rows[0].operation_day, '2026-01-02');
    assert.deepEqual(result.rows[0].exact_bytes, await fs.readFile(path.join(sourceDir, 'data-10.json')));
  } finally {
    if (createdSchema) await pool.query('DROP SCHEMA pult_market CASCADE').catch(() => {});
    await pool.end();
  }
});
