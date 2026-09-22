'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {
  exportDocumentJournal, verifyDocumentJournal, PostgresDocumentJournalError, INCOMPLETE_MARKER
} = require('../storage/postgres-document-journal.cjs');
const { createStateStore } = require('../storage/postgres-state.cjs');

async function directory(t, name = 'bundle') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pult-document-journal-'));
  const destination = path.join(root, name);
  await fs.mkdir(destination);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, destination };
}

test('rejects invalid checkpoint and incomplete journal without database access', async t => {
  const { destination } = await directory(t);
  let connected = false;
  const pool = { query: async () => ({}), connect: async () => { connected = true; throw Error('must not connect'); } };
  await assert.rejects(exportDocumentJournal({ pool, checkpointSequence: '-1', destinationDir: destination }), error =>
    error instanceof PostgresDocumentJournalError && error.code === 'INVALID_ARGUMENT');
  assert.equal(connected, false);
  await fs.writeFile(path.join(destination, INCOMPLETE_MARKER), '{}');
  await assert.rejects(verifyDocumentJournal(destination), error => error.code === 'JOURNAL_INCOMPLETE');
});

const integrationUrl = process.env.PULT_TEST_DATABASE_URL;
test('PostgreSQL integration: exports and verifies exact document command blobs', { skip: !integrationUrl, timeout: 30000 }, async t => {
  const database = decodeURIComponent(new URL(integrationUrl).pathname.slice(1));
  assert.match(database, /^pult_test_[a-f0-9]+$/u);
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: integrationUrl, max: 3 });
  let cleanupAuthorized = false;
  try {
    assert.equal((await pool.query("SELECT to_regnamespace('pult') AS schema")).rows[0].schema, null);
    cleanupAuthorized = true;
    await pool.query(require('../storage/postgres-schema.cjs'));
    await pool.query(require('../storage/postgres-document-schema.cjs'));
    const baseline = Buffer.from('{"state":"baseline"}\n');
    const logicalKey = 'file/' + crypto.createHash('sha256').update('synthetic/state.json').digest('hex');
    await pool.query(`INSERT INTO pult.document_states(logical_key,media_type,content,sha256,revision,deleted)
      VALUES($1,'application/json',$2,sha256($2),1,false)`, [logicalKey, baseline]);
    await pool.query(`INSERT INTO pult.source_files(source_path,logical_key,domain,media_type,source_bytes,source_sha256)
      VALUES('synthetic/state.json',$1,'business-state','application/json',$2,sha256($3))`, [logicalKey, String(baseline.length), baseline]);
    const store = createStateStore({ pool });
    const json = Buffer.from('{"state":"changed"}\n'), binary = Buffer.from([0, 255, 128, 17, 0]);
    await store.write(logicalKey, json, { expectedRevision: '1', commandId: crypto.randomUUID(), mediaType: 'application/json' });
    await store.write(logicalKey, binary, { expectedRevision: '2', commandId: crypto.randomUUID(), mediaType: 'application/octet-stream' });
    await store.remove(logicalKey, { expectedRevision: '3', commandId: crypto.randomUUID(), mediaType: 'application/octet-stream' });

    const { root, destination } = await directory(t);
    const manifest = await exportDocumentJournal({ pool, checkpointSequence: '0', destinationDir: destination });
    assert.equal(manifest.scope, 'documents-only');
    assert.equal(manifest.rollbackReady, false);
    assert.equal(manifest.commands.length, 3);
    assert.equal(manifest.blobs.length, 3);
    assert.equal((await verifyDocumentJournal(destination)).upperSequence, manifest.upperSequence);

    const missing = path.join(root, 'missing');
    await fs.cp(destination, missing, { recursive: true });
    await fs.unlink(path.join(missing, ...manifest.blobs[0].path.split('/')));
    await assert.rejects(verifyDocumentJournal(missing), error => error.code === 'JOURNAL_INVALID');

    const truncated = path.join(root, 'truncated');
    await fs.cp(destination, truncated, { recursive: true });
    await fs.truncate(path.join(truncated, ...manifest.blobs[1].path.split('/')), 1);
    await assert.rejects(verifyDocumentJournal(truncated), error => error.code === 'JOURNAL_INVALID');

    const corrupted = path.join(root, 'corrupted');
    await fs.cp(destination, corrupted, { recursive: true });
    const blob = await fs.open(path.join(corrupted, ...manifest.blobs[2].path.split('/')), 'r+');
    try { const byte = Buffer.alloc(1); await blob.read(byte, 0, 1, 0); byte[0] ^= 0xff; await blob.write(byte, 0, 1, 0); }
    finally { await blob.close(); }
    await assert.rejects(verifyDocumentJournal(corrupted), error => error.code === 'JOURNAL_INVALID');

    await store.write('unmapped/document', Buffer.from('unmapped'), {
      expectedRevision: '0', commandId: crypto.randomUUID(), mediaType: 'application/octet-stream'
    });
    const unsupported = path.join(root, 'unsupported');
    await fs.mkdir(unsupported);
    await assert.rejects(exportDocumentJournal({ pool, checkpointSequence: manifest.upperSequence, destinationDir: unsupported }),
      error => error.code === 'UNSUPPORTED_DOMAIN');
    assert.equal(JSON.parse(await fs.readFile(path.join(unsupported, INCOMPLETE_MARKER), 'utf8')).status, 'incomplete');
  } finally {
    if (cleanupAuthorized) await pool.query('DROP SCHEMA IF EXISTS pult CASCADE').catch(() => {});
    await pool.end();
  }
});
