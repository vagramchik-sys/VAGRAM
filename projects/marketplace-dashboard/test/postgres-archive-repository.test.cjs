'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { gzipSync } = require('node:zlib');
const schemaSql = require('../storage/postgres-history-schema.cjs');
const { createPostgresArchiveRepository, ArchiveRepositoryError } = require('../storage/postgres-archive-repository.cjs');
const { createMarketHistoryRepository } = require('../storage/postgres-history-repository.cjs');

const raw = Buffer.from('{"orders":{"period":{"from":"2026-09-20","to":"2026-09-20"},"skuUpdatedAt":"2026-09-21T00:00:00Z","skuDaily":[],"skuCoverage":["2026-09-20"],"skuDailyCoverage":true}}');
const contentHash = crypto.createHash('sha256').update(raw).digest('hex');
const payload = gzipSync(raw, { level: 1, mtime: 0 });
const gzipHash = crypto.createHash('sha256').update(payload).digest();

function scriptedPool({ clientSteps = [], poolSteps = [], connectError } = {}) {
  const calls = [], client = {
    released: 0,
    releaseArgs: [],
    async query(sql, values) {
      calls.push({ target: 'client', sql, values });
      if (sql === 'SAVEPOINT pult_write_fence_contract' || sql.includes('pg_advisory_xact_lock_shared') || sql === 'RELEASE SAVEPOINT pult_write_fence_contract') return { rows: [], rowCount: 1 };
      const step = clientSteps.shift();
      if (!step) throw Error('unexpected client query: ' + sql);
      if (step.error) throw step.error;
      return typeof step.result === 'function' ? step.result(sql, values) : step.result;
    },
    release(destroy) { this.released++; this.releaseArgs.push(destroy); }
  };
  const pool = {
    async connect() { calls.push({ target: 'pool', sql: 'CONNECT' }); if (connectError) throw connectError; return client; },
    async query(sql, values) {
      calls.push({ target: 'pool', sql, values });
      const step = poolSteps.shift();
      if (!step) throw Error('unexpected pool query: ' + sql);
      if (step.error) throw step.error;
      return typeof step.result === 'function' ? step.result(sql, values) : step.result;
    }
  };
  return { pool, client, calls };
}

test('schema supports SQL-only payloads and indexed pending facts without a synthetic path', () => {
  assert.match(schemaSql, /object_path text COLLATE "C",/);
  assert.doesNotMatch(schemaSql, /object_path text COLLATE "C" NOT NULL/);
  assert.match(schemaSql, /CREATE INDEX IF NOT EXISTS archive_versions_pending_facts_idx[\s\S]+WHERE facts_status = 'pending'/);
});

test('add atomically writes the compressed version and latest pointer with distinct hashes', async () => {
  const f = scriptedPool({ clientSteps: [
    { result: {} },
    { result: { rowCount: 1, rows: [{ source_file: 'insights-1.json' }] } },
    { result: { rowCount: 1 } },
    { result: {} }
  ] });
  const repository = createPostgresArchiveRepository({ pool: f.pool, history: { ingestInTransaction: async () => {} }, now: () => Date.parse('2026-09-22T01:00:00Z') });
  const result = await repository.add({ sourceFile: 'insights-1.json', sourceMtime: 123.5, raw });
  assert.equal(result.changed, true);
  assert.equal(result.latestUpdated, true);
  assert.equal(result.contentHash, contentHash);
  assert.equal(result.gzipHash, gzipHash.toString('hex'));
  assert.notEqual(result.contentHash, result.gzipHash);
  const insert = f.calls.find(call => /INSERT INTO .*archive_versions/.test(call.sql));
  assert.match(insert.sql, /object_path[\s\S]+NULL/);
  assert.equal(insert.values[1], contentHash);
  assert.deepEqual(insert.values[7], payload);
  assert.deepEqual(insert.values[8], gzipHash);
  assert.equal(insert.values[6], 'pending');
  assert.equal(f.calls.some(call => call.sql?.includes('pg_advisory_xact_lock_shared')), true);
  assert.ok(f.calls.findIndex(call => call.sql?.includes('pg_advisory_xact_lock_shared')) < f.calls.findIndex(call => /INSERT INTO .*archive_versions/.test(call.sql)));
  assert.deepEqual(f.calls.filter(call => call.target === 'client' && !/^(SAVEPOINT|RELEASE)/u.test(call.sql) && !call.sql.includes('pg_advisory_xact_lock_shared')).map(call => call.sql.split(/\s/u)[0]), ['BEGIN', 'INSERT', 'INSERT', 'COMMIT']);
  assert.equal(f.client.released, 1);
});

test('same content retry preserves immutable version values and may advance latest with a new mtime', async () => {
  const f = scriptedPool({ clientSteps: [
    { result: {} },
    { result: { rowCount: 0, rows: [] } },
    { result: { rowCount: 1, rows: [{ content_hash: contentHash, source_bytes: String(raw.length), facts_status: 'pending', archive_payload: payload, archive_gzip_hash: gzipHash }] } },
    { result: { rowCount: 1 } },
    { result: {} }
  ] });
  const repository = createPostgresArchiveRepository({ pool: f.pool });
  const result = await repository.add({ sourceFile: 'insights-1.json', sourceMtime: 999, raw, capturedAt: '2026-09-22T02:00:00Z' });
  assert.equal(result.changed, false);
  const latest = f.calls.find(call => /INSERT INTO .*archive_latest/.test(call.sql));
  assert.deepEqual(latest.values, ['insights-1.json', raw.length + ':999', contentHash, 999]);
  assert.equal(f.calls.some(call => /^UPDATE .*archive_versions/.test(call.sql)), false);
  assert.equal(f.client.released, 1);
});

test('duplicate add reports the gzip hash and status actually stored by an earlier import', async () => {
  const importedRaw = Buffer.from(JSON.stringify({ items: Array.from({ length: 2000 }, (_, index) => `value-${index % 37}-${index}`) }));
  const importedContentHash = crypto.createHash('sha256').update(importedRaw).digest('hex');
  const importedPayload = gzipSync(importedRaw, { level: 9, mtime: 0 });
  const proposedPayload = gzipSync(importedRaw, { level: 1, mtime: 0 });
  assert.notDeepEqual(importedPayload, proposedPayload);
  const importedGzipHash = crypto.createHash('sha256').update(importedPayload).digest();
  const f = scriptedPool({ clientSteps: [
    { result: {} },
    { result: { rowCount: 0, rows: [] } },
    { result: { rowCount: 1, rows: [{ content_hash: importedContentHash, source_bytes: importedRaw.length, facts_status: 'imported', archive_payload: importedPayload, archive_gzip_hash: importedGzipHash }] } },
    { result: { rowCount: 1 } },
    { result: {} }
  ] });
  const result = await createPostgresArchiveRepository({ pool: f.pool }).add({ sourceFile: 'data-1.json', sourceMtime: 12, raw: importedRaw, capturedAt: '2026-09-22T08:00:00.000Z' });
  assert.equal(result.changed, false);
  assert.equal(result.gzipHash, importedGzipHash.toString('hex'));
  assert.equal(result.factsStatus, 'imported');
});

test('an older concurrent capture is archived but cannot replace a newer latest pointer', async () => {
  const f = scriptedPool({ clientSteps: [
    { result: {} },
    { result: { rowCount: 1, rows: [{}] } },
    { result: { rowCount: 0, rows: [] } },
    { result: {} }
  ] });
  const repository = createPostgresArchiveRepository({ pool: f.pool });
  const result = await repository.add({ sourceFile: 'data-1.json', sourceMtime: 5, raw });
  assert.equal(result.changed, true);
  assert.equal(result.latestUpdated, false);
  const latest = f.calls.find(call => /INSERT INTO .*archive_latest/.test(call.sql));
  assert.match(latest.sql, /WHERE \$4::double precision>=substring\(current\.stamp/);
});

test('latest returns verified raw content and rejects a corrupt compressed hash', async () => {
  const base = { stamp: 'x', source_file: 'data-1.json', content_hash: contentHash, captured_at_text: '2026-09-22T01:00:00.000Z', source_mtime: 1, source_bytes: String(raw.length), archive_bytes: String(payload.length), facts_status: 'not_applicable', archive_payload: payload, archive_gzip_hash: gzipHash };
  const good = scriptedPool({ poolSteps: [{ result: { rowCount: 1, rows: [base] } }] });
  const value = await createPostgresArchiveRepository({ pool: good.pool }).latest('data-1.json');
  assert.deepEqual(value.raw, raw);
  const bad = scriptedPool({ poolSteps: [{ result: { rowCount: 1, rows: [{ ...base, archive_gzip_hash: Buffer.alloc(32) }] } }] });
  await assert.rejects(() => createPostgresArchiveRepository({ pool: bad.pool }).latest('data-1.json'), error => error instanceof ArchiveRepositoryError && error.code === 'ARCHIVE_CORRUPT');
});

test('failed fact ingestion rolls back and leaves the exact pending status untouched', async () => {
  const f = scriptedPool({ clientSteps: [
    { result: {} },
    { result: { rowCount: 1, rows: [{ source_file: 'insights-1.json', content_hash: contentHash, captured_at_text: '2026-09-22T01:00:00.000Z', source_bytes: raw.length, facts_status: 'pending', archive_payload: payload, archive_gzip_hash: gzipHash }] } },
    { result: {} }
  ] });
  const repository = createPostgresArchiveRepository({ pool: f.pool, history: { ingestInTransaction: async () => { throw Error('raw driver secret 991'); } } });
  await assert.rejects(() => repository.processPendingFacts(), error => error.code === 'FACT_IMPORT_ERROR' && !error.message.includes('991') && !('cause' in error));
  assert.equal(f.calls.some(call => /SET facts_status='imported'/.test(call.sql)), false);
  assert.equal(f.calls.at(-1).sql, 'ROLLBACK');
  assert.equal(f.client.released, 1);
});

test('successful pending fact import uses the archive identity and marks imported in one claim transaction', async () => {
  const ingested = [];
  const f = scriptedPool({
    clientSteps: [
      { result: {} },
      { result: { rowCount: 1, rows: [{ source_file: 'insights-1.json', content_hash: contentHash, captured_at_text: '2026-09-22T01:00:00.000Z', source_bytes: raw.length, facts_status: 'pending', archive_payload: payload, archive_gzip_hash: gzipHash }] } },
      { result: { rowCount: 1 } },
      { result: {} }
    ],
    poolSteps: [{ result: { rows: [{ count: '0' }] } }]
  });
  const repository = createPostgresArchiveRepository({ pool: f.pool, history: { ingestInTransaction: async (value, client) => { ingested.push({ value, client }); } } });
  assert.deepEqual(await repository.processPendingFacts({ limit: 1 }), { imported: 1, remaining: 0 });
  assert.equal(ingested[0].value.sourceFile, 'insights-1.json');
  assert.equal(ingested[0].value.contentHash, contentHash);
  assert.deepEqual(ingested[0].value.data, JSON.parse(raw));
  assert.equal(ingested[0].client, f.client);
  assert.equal(f.calls.filter(call => call.sql?.includes('pg_advisory_xact_lock_shared')).length, 1);
  assert.equal(f.client.released, 1);
});

test('connect, query and uncertain COMMIT errors are redacted and always release', async () => {
  const connect = scriptedPool({ connectError: Error('password=secret') });
  await assert.rejects(() => createPostgresArchiveRepository({ pool: connect.pool }).add({ sourceFile: 'data-1.json', sourceMtime: 1, raw }), error => error.code === 'DATABASE_ERROR' && !error.message.includes('secret') && !('cause' in error));

  const query = scriptedPool({ clientSteps: [{ result: {} }, { error: Error('row contains business-value') }, { result: {} }] });
  await assert.rejects(() => createPostgresArchiveRepository({ pool: query.pool }).add({ sourceFile: 'data-1.json', sourceMtime: 1, raw }), error => error.code === 'DATABASE_ERROR' && !error.message.includes('business-value'));
  assert.equal(query.client.released, 1);

  const commit = scriptedPool({ clientSteps: [{ result: {} }, { result: { rowCount: 1, rows: [{}] } }, { result: {} }, { error: Error('server detail private') }, { result: {} }] });
  await assert.rejects(() => createPostgresArchiveRepository({ pool: commit.pool }).add({ sourceFile: 'data-1.json', sourceMtime: 1, raw }), error => error.code === 'OUTCOME_UNKNOWN' && /те же sourceFile и содержимое/u.test(error.message) && !error.message.includes('private'));
  assert.equal(commit.client.released, 1);
  assert.deepEqual(commit.client.releaseArgs, [true]);

  const rollback = scriptedPool({ clientSteps: [{ result: {} }, { error: Error('write failed') }, { error: Error('rollback failed') }] });
  await assert.rejects(() => createPostgresArchiveRepository({ pool: rollback.pool }).add({ sourceFile: 'data-1.json', sourceMtime: 1, raw }), error => error.code === 'DATABASE_ERROR');
  assert.deepEqual(rollback.client.releaseArgs, [true]);
});

const integrationUrl = process.env.PULT_TEST_DATABASE_URL;
test('PostgreSQL integration: exact retry, latest payload and pending fact transition', { skip: !integrationUrl }, async t => {
  const parsed = new URL(integrationUrl);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  assert.match(databaseName, /^pult_test_[a-z0-9]+$/u, 'PULT_TEST_DATABASE_URL must name a disposable pult_test database');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: integrationUrl, max: 4 });
  const schema = 'archive_test_' + crypto.randomUUID().replaceAll('-', '');
  let owned = false;
  t.after(async () => { if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); });
  const exists = await pool.query('SELECT to_regnamespace($1) AS name', [schema]);
  assert.equal(exists.rows[0].name, null);
  await pool.query(schemaSql.replace(/\bpult_history\b/gu, schema)); owned = true;
  const history = createMarketHistoryRepository({ pool, schema });
  const repository = createPostgresArchiveRepository({ pool, schema, history });
  const capturedText = '2026-09-22T04:05:06+03:00';
  assert.equal((await repository.add({ sourceFile: 'insights-1.json', sourceMtime: 1, raw, capturedAt: capturedText })).changed, true);
  assert.equal((await repository.add({ sourceFile: 'insights-1.json', sourceMtime: 2, raw })).changed, false);
  const latest = await repository.latest('insights-1.json');
  assert.deepEqual(latest.raw, raw);
  assert.equal(latest.capturedAt, capturedText);
  await pool.query(`CREATE FUNCTION "${schema}".reject_imported() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.facts_status='imported' THEN RAISE EXCEPTION 'synthetic rollback'; END IF; RETURN NEW; END$$; CREATE TRIGGER reject_imported BEFORE UPDATE ON "${schema}".archive_versions FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_imported()`);
  await assert.rejects(repository.processPendingFacts(), error => error.code === 'DATABASE_ERROR');
  const rolledBack = await pool.query(`SELECT (SELECT count(*) FROM "${schema}".ingestions) AS ingestions,(SELECT count(*) FROM "${schema}".snapshots) AS snapshots,(SELECT facts_status FROM "${schema}".archive_versions WHERE source_file='insights-1.json') AS facts_status`);
  assert.deepEqual(rolledBack.rows[0], { ingestions: '0', snapshots: '0', facts_status: 'pending' });
  await pool.query(`DROP TRIGGER reject_imported ON "${schema}".archive_versions; DROP FUNCTION "${schema}".reject_imported()`);
  assert.deepEqual(await repository.processPendingFacts(), { imported: 1, remaining: 0 });
  const committed = await pool.query(`SELECT (SELECT count(*) FROM "${schema}".ingestions) AS ingestions,(SELECT count(*) FROM "${schema}".snapshots) AS snapshots,(SELECT facts_status FROM "${schema}".archive_versions WHERE source_file='insights-1.json') AS facts_status`);
  assert.deepEqual(committed.rows[0], { ingestions: '1', snapshots: '1', facts_status: 'imported' });
});
