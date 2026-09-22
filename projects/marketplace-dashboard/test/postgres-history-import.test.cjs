'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { gzipSync } = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const schemaSql = require('../storage/postgres-history-schema.cjs');
const { importHistory, _test } = require('../storage/postgres-history-import.cjs');

test('history schema is normalized PostgreSQL with exact text and binary archive storage', () => {
  for (const table of ['ingestions', 'snapshots', 'facts', 'order_events', 'product_names', 'product_aliases', 'archive_versions', 'archive_latest', 'archive_state', 'stock_imports', 'stock_rows', 'stock_origins']) {
    assert.match(schemaSql, new RegExp(`CREATE TABLE IF NOT EXISTS pult_history\\.${table} \\(`));
  }
  assert.match(schemaSql, /double precision/);
  assert.match(schemaSql, /archive_payload bytea NOT NULL/);
  assert.match(schemaSql, /text COLLATE "C"/);
  assert.match(schemaSql, /captured_at_text text/);
  assert.doesNotMatch(schemaSql, /CREATE TABLE[^;]+sqlite_file[^;]+bytea/is);
});

test('importer refuses the live history directory before opening it', async () => {
  const live = path.resolve(__dirname, '..', '.private', 'history');
  await assert.rejects(importHistory({ pool: { connect() { throw Error('must not connect'); } }, sourceDir: live }), error => error.code === 'LIVE_SOURCE_FORBIDDEN');
});

test('archive verifier distinguishes source hash from gzip hash and rejects traversal', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pult-archive-verify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const raw = Buffer.from('{"n":9007199254740993}\n'), gzip = gzipSync(raw), file = path.join(root, 'object.json.gz');
  fs.writeFileSync(file, gzip);
  const row = { object_path: 'object.json.gz', archive_bytes: gzip.length, source_bytes: raw.length, content_hash: crypto.createHash('sha256').update(raw).digest('hex') };
  const result = await _test.archivePayload(root, row);
  assert.deepEqual(result.payload, gzip);
  assert.equal(result.gzipHash.toString('hex'), crypto.createHash('sha256').update(gzip).digest('hex'));
  assert.notEqual(result.gzipHash.toString('hex'), row.content_hash);
  await assert.rejects(_test.archivePayload(root, { ...row, object_path: '../outside.json.gz' }), error => error.code === 'INVALID_ARCHIVE_PATH');
});

test('archive verifier rejects a linked path component', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pult-archive-link-')), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pult-archive-outside-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  const raw = Buffer.from('{}'), gzip = gzipSync(raw), target = path.join(outside, 'object.json.gz');
  fs.writeFileSync(target, gzip);
  try { fs.symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Creating a test link is not permitted'); throw error; }
  const row = { object_path: path.join('linked', 'object.json.gz'), archive_bytes: gzip.length, source_bytes: raw.length, content_hash: crypto.createHash('sha256').update(raw).digest('hex') };
  await assert.rejects(_test.archivePayload(root, row), error => error.code === 'INVALID_ARCHIVE_PATH');
});

test('target verification streams an ordered server cursor without OFFSET', async () => {
  const spec = {
    name: 'synthetic_rows',
    sourceColumns: [{ name: 'id', type: 'int' }, { name: 'value', type: 'text' }],
    targetSelect: ['"id" AS "id"', '"value" AS "value"'],
    pk: ['id'],
    batchSize: 2
  };
  const calls = [], batches = [
    [{ id: '1', value: 'a' }, { id: '2', value: 'b' }],
    [{ id: '3', value: 'c' }],
    []
  ];
  const client = { async query(sql, parameters) {
    calls.push({ sql, parameters });
    if (sql.startsWith('FETCH ')) return { rows: batches.shift() };
    return { rows: [] };
  } };
  const result = await _test.verifyTarget(client, spec);
  const expected = crypto.createHash('sha256');
  for (const row of [{ id: '1', value: 'a' }, { id: '2', value: 'b' }, { id: '3', value: 'c' }]) {
    expected.update(_test.stable(row) + '\n');
  }
  assert.deepEqual(result, { count: 3, hash: expected.digest('hex') });
  assert.match(calls[0].sql, /^DECLARE "pult_verify_synthetic_rows" NO SCROLL CURSOR FOR SELECT /u);
  assert.doesNotMatch(calls[0].sql, /\b(?:LIMIT|OFFSET)\b/iu);
  assert.equal(calls.filter(call => call.sql.startsWith('FETCH FORWARD 2 ')).length, 3);
  assert.match(calls.at(-1).sql, /^CLOSE /u);
  assert.ok(calls.every(call => call.parameters === undefined));
  assert.doesNotMatch(_test.sourceQuery(spec), /\b(?:LIMIT|OFFSET)\b/iu);
});

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pult-pg-history-')), history = path.join(root, 'history');
  fs.mkdirSync(path.join(history, 'snapshots', 'aa'), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const products = new DatabaseSync(path.join(history, 'products.sqlite'));
  products.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE ingestions(id INTEGER PRIMARY KEY,source_file TEXT NOT NULL,content_hash TEXT NOT NULL,captured_at TEXT NOT NULL,source_kind TEXT NOT NULL,UNIQUE(source_file,content_hash));
    CREATE TABLE snapshots(id INTEGER PRIMARY KEY,ingestion_id INTEGER NOT NULL REFERENCES ingestions(id),source_kind TEXT NOT NULL,market TEXT NOT NULL,store_id TEXT NOT NULL,day TEXT NOT NULL,source_actual_at TEXT NOT NULL,closed_confirmed INTEGER NOT NULL,partial_reason TEXT,UNIQUE(ingestion_id,source_kind,store_id,day));
    CREATE TABLE facts(id INTEGER PRIMARY KEY,snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),product_id TEXT NOT NULL,observed_at TEXT,units REAL,revenue REAL,sold_units REAL,returned_units REAL,realized REAL,ads REAL,unknown_unit_rows INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE order_events(id INTEGER PRIMARY KEY,snapshot_id INTEGER NOT NULL REFERENCES snapshots(id),product_id TEXT NOT NULL,occurred_at TEXT NOT NULL,amount REAL);
    CREATE TABLE product_names(market TEXT NOT NULL,store_id TEXT NOT NULL,product_id TEXT NOT NULL,name TEXT NOT NULL,source_actual_at TEXT NOT NULL,PRIMARY KEY(market,store_id,product_id));
    CREATE TABLE product_aliases(market TEXT NOT NULL,store_id TEXT NOT NULL,alias TEXT NOT NULL,product_id TEXT NOT NULL,source_actual_at TEXT NOT NULL,PRIMARY KEY(market,store_id,alias));
    INSERT INTO ingestions VALUES(9007199254740993,'source.json','content-1','2026-09-20T08:00:00.123Z','wb-orders');
    INSERT INTO snapshots VALUES(9007199254740994,9007199254740993,'wb-orders','WB','001','2026-09-19','2026-09-20T08:00:00.123Z',1,NULL);
    INSERT INTO facts VALUES(9007199254740995,9007199254740994,'000123','2026-09-20T08:00:00.123Z',0.123456789,19.9999999,NULL,NULL,NULL,NULL,0);
    INSERT INTO order_events VALUES(9007199254740996,9007199254740994,'000123','2026-09-19T10:11:12.345Z',NULL);
    INSERT INTO product_names VALUES('WB','001','000123','Товар','2026-09-20T08:00:00.123Z');
    INSERT INTO product_aliases VALUES('WB','001','ART-001','000123','2026-09-20T08:00:00.123Z');
  `);
  products.close();

  const raw = Buffer.from('{"fixture":true}\n'), gzip = gzipSync(raw), contentHash = crypto.createHash('sha256').update(raw).digest('hex');
  const objectPath = path.join('snapshots', 'aa', `${contentHash}.json.gz`), objectFile = path.join(history, objectPath);
  fs.writeFileSync(objectFile, gzip);
  const archive = new DatabaseSync(path.join(history, 'archive.sqlite'));
  archive.exec(`
    CREATE TABLE versions(source_file TEXT NOT NULL,content_hash TEXT NOT NULL,captured_at TEXT NOT NULL,source_mtime REAL NOT NULL,source_bytes INTEGER NOT NULL,archive_bytes INTEGER NOT NULL,object_path TEXT NOT NULL,facts_status TEXT NOT NULL,PRIMARY KEY(source_file,content_hash));
    CREATE TABLE latest(source_file TEXT PRIMARY KEY,stamp TEXT NOT NULL,content_hash TEXT NOT NULL);
    CREATE TABLE state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  `);
  archive.prepare('INSERT INTO versions VALUES(?,?,?,?,?,?,?,?)').run('source.json', contentHash, '2026-09-20T08:00:00.123Z', 1234.5, raw.length, gzip.length, objectPath, 'imported');
  archive.prepare('INSERT INTO latest VALUES(?,?,?)').run('source.json', 'stamp-1', contentHash);
  archive.prepare('INSERT INTO state VALUES(?,?)').run('lastScanAt', '2026-09-20T08:00:00.123Z');
  archive.close();

  const stocks = new DatabaseSync(path.join(history, 'stocks.sqlite'));
  stocks.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE imports(id TEXT PRIMARY KEY,imported_at TEXT NOT NULL,manifest TEXT NOT NULL,issues TEXT NOT NULL);
    CREATE TABLE stock_rows(id TEXT PRIMARY KEY,day TEXT NOT NULL,observedAt TEXT,source TEXT NOT NULL,storeId TEXT NOT NULL,storeName TEXT NOT NULL,sku TEXT NOT NULL,article TEXT,name TEXT,warehouse TEXT,warehouseId TEXT,cluster TEXT,totalStock INTEGER,available INTEGER,inTransit INTEGER,reserved INTEGER,quality TEXT,details TEXT NOT NULL);
    CREATE TABLE origins(row_id TEXT NOT NULL REFERENCES stock_rows(id),import_id TEXT NOT NULL REFERENCES imports(id),source_file TEXT NOT NULL,source_row TEXT NOT NULL,PRIMARY KEY(row_id,import_id,source_file,source_row));
    INSERT INTO imports VALUES('${'a'.repeat(64)}','2026-09-20T08:00:00.123Z','[{"n":9007199254740993}]','[]');
    INSERT INTO stock_rows VALUES('${'b'.repeat(64)}','2026-09-19','2026-09-19T23:59:59.999Z','daily-total','001','Магазин','000123','=ART','Товар',NULL,NULL,NULL,7,NULL,0,NULL,'ok','{"source":"fixture"}');
    INSERT INTO origins VALUES('${'b'.repeat(64)}','${'a'.repeat(64)}','fixture.json','0');
  `);
  stocks.close();
  return { root, history };
}

const integrationUrl = process.env.PULT_TEST_DATABASE_URL;
test('PostgreSQL integration imports all SQLite history tables, verifies hashes and rejects changed conflicts', { skip: !integrationUrl }, async t => {
  const parsed = new URL(integrationUrl), databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  assert.match(databaseName, /test/iu, 'PULT_TEST_DATABASE_URL must name an explicit test database');
  const { Pool } = require('pg'), pool = new Pool({ connectionString: integrationUrl, max: 2 });
  const fixture = createFixture(t), progress = [];
  let ownedSchema = false;
  try {
    const existing = await pool.query(`SELECT to_regnamespace('pult_history')::text AS namespace`);
    assert.equal(existing.rows[0].namespace, null, 'test database already contains pult_history; refusing destructive integration test');
    await assert.rejects(importHistory({ pool, sourceDir: fixture.history }), { code: 'HISTORY_SCHEMA_REQUIRED' });
    await pool.query(require('../storage/postgres-history-schema.cjs'));
    ownedSchema = true;
    const first = await importHistory({ pool, sourceDir: fixture.history, onProgress: event => progress.push(event) });
    assert.equal(first.counts.facts, 1);
    assert.equal(first.counts.archive_versions, 1);
    assert.equal(first.counts.stock_rows, 1);
    assert.equal(Object.keys(first.hashes).length, 12);
    assert.ok(progress.some(event => event.phase === 'complete'));

    const exact = await pool.query(`SELECT facts.id,store_id,product_id,units,revenue,observed_at_text FROM pult_history.facts JOIN pult_history.snapshots ON snapshots.id=facts.snapshot_id`);
    assert.equal(exact.rows[0].id, '9007199254740995');
    assert.equal(exact.rows[0].store_id, '001');
    assert.equal(exact.rows[0].product_id, '000123');
    assert.equal(exact.rows[0].units, 0.123456789);
    assert.equal(exact.rows[0].revenue, 19.9999999);
    assert.equal(exact.rows[0].observed_at_text, '2026-09-20T08:00:00.123Z');
    const json = await pool.query(`SELECT manifest_text,manifest #>> '{0,n}' AS exact_number FROM pult_history.stock_imports`);
    assert.equal(json.rows[0].manifest_text, '[{"n":9007199254740993}]');
    assert.equal(json.rows[0].exact_number, '9007199254740993');
    const nullable = await pool.query(`SELECT amount FROM pult_history.order_events`);
    assert.equal(nullable.rows[0].amount, null);
    const blob = await pool.query(`SELECT archive_bytes,octet_length(archive_payload) bytes,encode(archive_gzip_hash,'hex') gzip_hash FROM pult_history.archive_versions`);
    assert.equal(String(blob.rows[0].archive_bytes), String(blob.rows[0].bytes));
    assert.equal(blob.rows[0].gzip_hash.length, 64);

    const repeated = await importHistory({ pool, sourceDir: fixture.history });
    assert.deepEqual(repeated.counts, first.counts);
    assert.deepEqual(repeated.hashes, first.hashes);
    assert.equal(repeated.sourceFingerprint, first.sourceFingerprint);
    const verifiedState = await pool.query(`SELECT table_counts,table_hashes,encode(source_fingerprint,'hex') source_fingerprint FROM pult_history.import_state`);
    assert.deepEqual(verifiedState.rows[0].table_counts, first.counts);
    assert.deepEqual(verifiedState.rows[0].table_hashes, first.hashes);
    assert.equal(verifiedState.rows[0].source_fingerprint, first.sourceFingerprint);
    const products = new DatabaseSync(path.join(fixture.history, 'products.sqlite'));
    products.prepare('UPDATE product_names SET name=? WHERE market=? AND store_id=? AND product_id=?').run('Изменено', 'WB', '001', '000123');
    products.close();
    await assert.rejects(importHistory({ pool, sourceDir: fixture.history }), error => error.code === 'HISTORY_CONFLICT');
    const state = await pool.query(`SELECT status FROM pult_history.import_runs ORDER BY started_at DESC LIMIT 1`);
    assert.equal(state.rows[0].status, 'failed');
  } finally {
    if (ownedSchema) await pool.query('DROP SCHEMA pult_history CASCADE');
    await pool.end();
  }
});
