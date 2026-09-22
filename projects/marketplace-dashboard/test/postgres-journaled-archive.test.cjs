'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { gzipSync } = require('node:zlib');
const { createStateStore } = require('../storage/postgres-state.cjs');
const { createMarketHistoryRepository } = require('../storage/postgres-history-repository.cjs');
const { createPostgresArchiveRepository } = require('../storage/postgres-archive-repository.cjs');
const { createJournaledArchive, JournaledArchiveError } = require('../storage/postgres-journaled-archive.cjs');

const capturedAt = '2026-09-22T08:00:00.000Z';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const factRaw = units => Buffer.from(JSON.stringify({ orders: {
  period: { from: '2026-09-21', to: '2026-09-21' }, skuUpdatedAt: capturedAt,
  skuDailyCoverage: true, skuCoverage: ['2026-09-21'], skuDaily: [{ date: '2026-09-21', sku: 'A', units, revenue: 10 }]
} }));
const addCommand = (raw, overrides = {}) => ({ schemaVersion: 1, kind: 'archive.version-add',
  commandId: crypto.randomUUID(), expectedRevision: '0', sourceFile: 'insights-1.json', sourceMtime: 10, capturedAt, raw, ...overrides });
const processCommand = (contentHash, overrides = {}) => ({ schemaVersion: 1, kind: 'archive.process-exact-pending-version',
  commandId: crypto.randomUUID(), expectedRevision: '1', sourceFile: 'insights-1.json', contentHash, capturedAt, ...overrides });

test('raw is copied before await and corrupt or invalid evidence never reaches the SQL effect', async () => {
  let stateCalls = 0, receivedRaw;
  const stateStore = { async readCommand() { return null; }, async writeWithEffect(_key, content, _options, effect) {
    stateCalls++; await Promise.resolve(); return { content: JSON.parse(content), result: await effect({}) };
  } };
  const archive = {
    factsStatusFor: () => 'pending',
    async addInTransaction(input) { receivedRaw = input.raw; return { changed: true, latestUpdated: true, contentHash: digest(input.raw), gzipHash: digest(gzipSync(input.raw, { level: 1, mtime: 0 })), factsStatus: 'pending' }; },
    async processVersionInTransaction() { throw Error('must not run'); },
    async versionEvidence() { const raw = factRaw(1), archivePayload = Buffer.from('not gzip'); return {
      sourceFile: 'insights-1.json', contentHash: digest(raw), capturedAt, sourceMtime: 1, factsStatus: 'pending', raw,
      archivePayload, gzipHash: digest(archivePayload)
    }; }
  };
  const wrapper = createJournaledArchive({ stateStore, archive });
  const raw = factRaw(2), original = Buffer.from(raw), pending = wrapper.addVersion(addCommand(raw));
  raw.fill(0);
  const added = await pending;
  assert.deepEqual(receivedRaw, original);
  assert.equal(added.content.rawBase64, original.toString('base64'));

  const invalid = Buffer.from([0xff]);
  await assert.rejects(wrapper.addVersion(addCommand(invalid)), error => error instanceof JournaledArchiveError && error.code === 'INVALID_FACT_JSON');
  await assert.rejects(wrapper.processVersion(processCommand(digest(factRaw(1)))), error => error.code === 'EVIDENCE_MISMATCH');
  assert.equal(stateCalls, 1);
});

const integrationUrl = process.env.PULT_TEST_DATABASE_URL;
test('PostgreSQL integration: archive effects and journal commit atomically and replay exactly once', { skip: !integrationUrl, timeout: 30000 }, async t => {
  const parsed = new URL(integrationUrl), database = decodeURIComponent(parsed.pathname.slice(1));
  assert.match(database, /^pult_test_[a-z0-9]+$/u);
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: integrationUrl, max: 4 });
  let owned = false;
  t.after(async () => { if (owned) await pool.query('DROP SCHEMA IF EXISTS pult_history,pult CASCADE'); await pool.end(); });
  const existing = await pool.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname IN ('pult','pult_history')");
  assert.equal(existing.rows[0].n, 0);
  await pool.query(require('../storage/postgres-schema.cjs'));
  await pool.query(require('../storage/postgres-history-schema.cjs'));
  owned = true;
  const stateStore = createStateStore({ pool }), history = createMarketHistoryRepository({ pool });
  const baseArchive = createPostgresArchiveRepository({ pool, history });
  let addEffects = 0, processEffects = 0;
  const archive = {
    factsStatusFor: sourceFile => baseArchive.factsStatusFor(sourceFile),
    versionEvidence: (...args) => baseArchive.versionEvidence(...args),
    addInTransaction: (...args) => { addEffects++; return baseArchive.addInTransaction(...args); },
    processVersionInTransaction: (...args) => { processEffects++; return baseArchive.processVersionInTransaction(...args); }
  };
  const wrapper = createJournaledArchive({ stateStore, archive });
  const raw1 = factRaw(2), add1 = addCommand(raw1);
  const added = await wrapper.addVersion(add1);
  assert.equal(added.result.changed, true);
  assert.equal(addEffects, 1);
  await assert.rejects(wrapper.addVersion({ ...add1, raw: factRaw(3) }), error => error.code === 'COMMAND_ID_REUSED');
  assert.equal(addEffects, 1);

  const contentHash1 = digest(raw1), process1 = processCommand(contentHash1);
  await pool.query(`CREATE FUNCTION pult.reject_archive_journal() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic archive journal failure'; END$$;
    CREATE TRIGGER reject_archive_journal BEFORE INSERT ON pult.commands FOR EACH ROW EXECUTE FUNCTION pult.reject_archive_journal()`);
  await assert.rejects(wrapper.processVersion(process1), error => error.code === 'DATABASE_ERROR');
  const rolledBack = (await pool.query(`SELECT
    (SELECT facts_status FROM pult_history.archive_versions WHERE source_file='insights-1.json' AND content_hash=$1) AS status,
    (SELECT count(*)::int FROM pult_history.ingestions) AS ingestions,
    (SELECT count(*)::int FROM pult_history.snapshots) AS snapshots,
    (SELECT count(*)::int FROM pult_history.facts) AS facts,
    (SELECT count(*)::int FROM pult.commands) AS commands`, [contentHash1])).rows[0];
  assert.deepEqual(rolledBack, { status: 'pending', ingestions: 0, snapshots: 0, facts: 0, commands: 1 });
  await pool.query('DROP TRIGGER reject_archive_journal ON pult.commands; DROP FUNCTION pult.reject_archive_journal()');
  const processed = await wrapper.processVersion(process1);
  assert.equal(processed.result.imported, true);
  assert.equal(processEffects, 2);

  const raw2 = factRaw(4), add2 = addCommand(raw2, { expectedRevision: '2', sourceMtime: 5, capturedAt: '2026-09-22T09:00:00.000Z' });
  await wrapper.addVersion(add2);
  assert.equal(addEffects, 2);
  const latest = await baseArchive.latest('insights-1.json');
  assert.equal(latest.contentHash, contentHash1, 'older sourceMtime must not replace latest');
  assert.deepEqual(await wrapper.processVersion(process1), { ...processed, replayed: true });
  assert.equal(processEffects, 2, 'durable duplicate must not rerun archive/history effects');
  const durable = await stateStore.readCommand(`archive/${digest('insights-1.json')}`, process1.commandId, { operation: 'write' });
  assert.deepEqual(durable.result, processed.result);
});
