'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { importDocuments, sourceKey, selectDocuments } = require('../storage/postgres-document-import.cjs');
const { createMigrationSnapshot } = require('../storage/migration-snapshot.cjs');

async function checkpoint(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pult-document-test-'));
  const source = path.join(root, 'source'), backup = path.join(root, 'backup');
  await fs.mkdir(source); await fs.mkdir(backup);
  await fs.mkdir(path.join(source, 'b2b-agent'));
  await fs.mkdir(path.join(source, 'loan-contracts'));
  const entries = new Map([
    ['stores.json', Buffer.from('{"1":{"key":"opaque-synthetic-ciphertext"}}\r\n')],
    ['management.json', Buffer.from('{ "items": [] }\n')],
    ['b2b-agent/queue.json', Buffer.from('{"items":[]}')],
    ['b2b-agent/connection.dpapi', Buffer.from([0, 255, 128, 17, 0])],
    ['loan-contracts/образец.pdf', Buffer.from('%PDF-synthetic-only\n')]
  ]);
  for (const [name, bytes] of entries) await fs.writeFile(path.join(source, ...name.split('/')), bytes);
  await createMigrationSnapshot({ sourceRoot: source, destinationDir: backup, writersStopped: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { source, backup, entries };
}

test('baseline selection rejects unknown or reclassified files and delegates normalized histories', () => {
  const base = { writersStopped: true, files: [] };
  assert.throws(() => sourceKey('../stores.json'));
  assert.notEqual(sourceKey('loan-contracts/образец.pdf'), sourceKey('loan-contracts/sample.pdf'));
  assert.throws(() => selectDocuments({ ...base, writersStopped: false }), { code: 'INVALID_SNAPSHOT' });
  assert.throws(() => selectDocuments({ ...base, files: [{ path: 'unreviewed.json', domain: 'business-state', bytes: '2' }] }), { code: 'CLASSIFICATION_CHANGED' });
  assert.throws(() => selectDocuments({ ...base, files: [{ path: 'stores.json', domain: 'business-state', bytes: '2' }] }), { code: 'CLASSIFICATION_CHANGED' });
  const selected = selectDocuments({ ...base, files: [
    { path: 'history/products.sqlite', domain: 'history', bytes: '0' },
    { path: 'history/snapshots/aa/' + 'a'.repeat(64) + '.json.gz', domain: 'archive-content', bytes: '0' },
    { path: 'stores.json', domain: 'protected-connections', bytes: '2' }
  ] });
  assert.equal(selected.selected.length, 1);
  assert.equal(selected.delegated.length, 2);
});

test('corrupted checkpoint is rejected before any database access', async t => {
  const { backup } = await checkpoint(t);
  await fs.writeFile(path.join(backup, 'management.json'), '{"changed":true}');
  let connected = false;
  await assert.rejects(importDocuments({ sourceDir: backup, pool: { connect: async () => { connected = true; throw Error('must not connect'); } } }), { code: 'INVALID_SNAPSHOT' });
  assert.equal(connected, false);
});

test('database failures disclose neither the protected input nor database error details', async t => {
  const { backup } = await checkpoint(t);
  const pool = { connect: async () => { throw Error('synthetic-secret-that-must-not-escape'); } };
  await assert.rejects(importDocuments({ sourceDir: backup, pool }), error => error.code === 'DOCUMENT_IMPORT_FAILED' && !error.message.includes('secret'));
});

const integrationUrl = process.env.PULT_TEST_DATABASE_URL;
test('PostgreSQL baseline import preserves all exact bytes, reuses safely and refuses runtime overwrite', { skip: !integrationUrl }, async t => {
  assert.match(decodeURIComponent(new URL(integrationUrl).pathname.slice(1)), /^pult_test_[a-f0-9]+$/u);
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: integrationUrl, max: 2 });
  const schema = 'document_test_' + crypto.randomBytes(8).toString('hex');
  let owned = false;
  t.after(async () => { if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); });
  assert.equal((await pool.query('SELECT to_regnamespace($1) AS name', [schema])).rows[0].name, null);
  await pool.query(`CREATE SCHEMA "${schema}"`); owned = true;
  await pool.query(require('../storage/postgres-schema.cjs').replace(/\bpult\b/gu, schema));
  await pool.query(require('../storage/postgres-document-schema.cjs').replace(/\bpult\b/gu, schema));
  const { backup, entries } = await checkpoint(t);
  const bytes = [...entries.values()].reduce((sum, value) => sum + value.length, 0);
  const result = await importDocuments({ pool, sourceDir: backup, schema });
  assert.deepEqual(result, { inserted: 5, reused: 0, verified: 5, bytes: String(bytes), delegatedHistoryFiles: 0, cutoverReady: false });
  for (const [name, content] of entries) {
    const row = (await pool.query(`SELECT content FROM "${schema}".document_states WHERE logical_key=$1`, [sourceKey(name)])).rows[0];
    assert.deepEqual(row.content, content);
  }
  assert.deepEqual(await importDocuments({ pool, sourceDir: backup, schema }), { ...result, inserted: 0, reused: 5 });
  assert.equal((await pool.query(`SELECT count(*)::text AS n FROM "${schema}".commands`)).rows[0].n, '0');
  const store = require('../storage/postgres-state.cjs').createStateStore({ pool, schema });
  const changed = Buffer.from('{"items":[{"id":"new-live-record"}]}');
  await store.write(sourceKey('management.json'), changed, { expectedRevision: '1', commandId: crypto.randomUUID(), mediaType: 'application/json' });
  await assert.rejects(importDocuments({ pool, sourceDir: backup, schema }), { code: 'BASELINE_CONFLICT' });
  assert.deepEqual((await store.read(sourceKey('management.json'))).content, changed);
});
