'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createStateStore } = require('../storage/postgres-state.cjs');
const { createMarketHistoryRepository } = require('../storage/postgres-history-repository.cjs');
const { createJournaledHistory, JournaledHistoryError, canonical } = require('../storage/postgres-journaled-history.cjs');

const id = value => crypto.createHash('sha256').update(value).digest('hex');
const capturedAt = '2026-09-19T08:00:00.000Z';
const rawData = (units = 2) => Buffer.from(JSON.stringify({
  orders: { period: { from: '2026-09-18', to: '2026-09-18' }, skuUpdatedAt: capturedAt,
    skuDailyCoverage: true, skuCoverage: ['2026-09-18'], skuDaily: [{ date: '2026-09-18', sku: 'A', units, revenue: 10 }] }
}));
const input = (overrides = {}) => {
  const { units, ...fields } = overrides;
  const raw = fields.raw === undefined ? rawData(units) : fields.raw;
  return {
    schemaVersion: 1, kind: 'history.ingest', commandId: crypto.randomUUID(), expectedRevision: '0',
    sourceFile: 'insights-1.json', contentHash: id(raw), capturedAt, raw,
    ...fields
  };
};

test('versioned command validation and canonical hashing fail closed', async () => {
  let writes = 0;
  const wrapper = createJournaledHistory({
    stateStore: { writeWithEffect: async () => { writes++; } }, history: { ingestInTransaction: async () => ({}) }
  });
  for (const command of [input({ schemaVersion: 2 }), input({ kind: 'unknown' })])
    await assert.rejects(wrapper.ingest(command), error => error instanceof JournaledHistoryError && error.code === 'UNSUPPORTED_COMMAND');
  assert.equal(writes, 0);
  assert.deepEqual(canonical({ b: 2, a: 1 }), canonical({ a: 1, b: 2 }));
});

test('raw bytes are copied and authenticated before any SQL call', async () => {
  let writes = 0;
  let observed;
  const wrapper = createJournaledHistory({
    stateStore: { writeWithEffect: async (_key, content, _options, effect) => {
      writes++; observed = JSON.parse(content); await Promise.resolve(); return effect({});
    } },
    history: { ingestInTransaction: async ({ data }) => ({ units: data.orders.skuDaily[0].units }) }
  });
  const command = input();
  const original = Buffer.from(command.raw);
  const pending = wrapper.ingest(command);
  command.raw.fill(0);
  assert.deepEqual(await pending, { units: 2 });
  assert.equal(observed.rawBase64, original.toString('base64'));
  assert.equal(observed.contentHash, id(original));
  assert.equal(writes, 1);

  await assert.rejects(wrapper.ingest(input({ raw: rawData(3), contentHash: id(rawData(4)) })),
    error => error.code === 'CONTENT_HASH_MISMATCH');
  const invalid = Buffer.from('{"orders":');
  await assert.rejects(wrapper.ingest(input({ raw: invalid, contentHash: id(invalid) })),
    error => error.code === 'INVALID_JSON');
  assert.equal(writes, 1);
});

const integrationUrl = process.env.PULT_TEST_DATABASE_URL;
test('PostgreSQL integration: history facts, state, command and result commit atomically', { skip: !integrationUrl, timeout: 30000 }, async () => {
  const database = decodeURIComponent(new URL(integrationUrl).pathname.slice(1));
  assert.match(database, /^pult_test_[a-f0-9]+$/u);
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: integrationUrl, max: 4 });
  let cleanupAuthorized = false;
  try {
    const occupied = await pool.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname IN ('pult','pult_history')");
    assert.equal(occupied.rows[0].n, 0); cleanupAuthorized = true;
    await pool.query(require('../storage/postgres-schema.cjs'));
    await pool.query(require('../storage/postgres-history-schema.cjs'));
    const stateStore = createStateStore({ pool }), baseHistory = createMarketHistoryRepository({ pool });
    let effects = 0;
    const history = { ingestInTransaction: async (...args) => { effects++; return baseHistory.ingestInTransaction(...args); } };
    const wrapper = createJournaledHistory({ stateStore, history });
    const firstCommand = input({ commandId: crypto.randomUUID() });
    const originalFirstRaw = Buffer.from(firstCommand.raw);
    const firstPending = wrapper.ingest(firstCommand);
    firstCommand.raw.fill(0);
    const first = await firstPending;
    assert.equal(first.replayed, false); assert.equal(effects, 1);
    const firstRetry = { ...firstCommand, raw: originalFirstRaw };
    assert.deepEqual(await wrapper.ingest(firstRetry), { ...first, replayed: true });
    assert.equal(effects, 1);

    const secondCommand = input({ commandId: crypto.randomUUID(), expectedRevision: '1', units: 3 });
    const second = await wrapper.ingest(secondCommand);
    assert.equal(second.revision, '2'); assert.equal(effects, 2);
    assert.deepEqual(await wrapper.ingest(firstRetry), { ...first, replayed: true });
    assert.equal(effects, 2);

    const before = (await pool.query(`SELECT
      (SELECT count(*)::int FROM pult_history.ingestions) AS ingestions,
      (SELECT count(*)::int FROM pult_history.facts) AS facts,
      (SELECT count(*)::int FROM pult.commands) AS commands,
      (SELECT count(*)::int FROM pult.document_states) AS states`)).rows[0];
    await pool.query(`CREATE FUNCTION pult.reject_test_command() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic trigger failure'; END$$;
      CREATE TRIGGER reject_test_command BEFORE INSERT ON pult.commands FOR EACH ROW EXECUTE FUNCTION pult.reject_test_command()`);
    const failedCommand = input({ commandId: crypto.randomUUID(), expectedRevision: '2', units: 4 });
    await assert.rejects(wrapper.ingest(failedCommand), error => error.code === 'DATABASE_ERROR');
    const after = (await pool.query(`SELECT
      (SELECT count(*)::int FROM pult_history.ingestions) AS ingestions,
      (SELECT count(*)::int FROM pult_history.facts) AS facts,
      (SELECT count(*)::int FROM pult.commands) AS commands,
      (SELECT count(*)::int FROM pult.document_states) AS states`)).rows[0];
    assert.deepEqual(after, before);
    await pool.query('DROP TRIGGER reject_test_command ON pult.commands; DROP FUNCTION pult.reject_test_command()');
    const recovered = await wrapper.ingest(failedCommand);
    assert.equal(recovered.revision, '3');
    assert.equal(effects, 4); // failed effect ran once and rolled back; explicit retry ran it again.
    assert.deepEqual((await stateStore.readCommand(`history/${id('insights-1.json')}`, failedCommand.commandId, { operation: 'write' })).result, recovered.result);
  } finally {
    if (cleanupAuthorized) await pool.query('DROP SCHEMA IF EXISTS pult_history,pult CASCADE').catch(() => {});
    await pool.end();
  }
});
