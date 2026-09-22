'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createMigrationSnapshot } = require('../storage/migration-snapshot.cjs');
const { importDocuments, sourceKey } = require('../storage/postgres-document-import.cjs');
const { createStateStore } = require('../storage/postgres-state.cjs');
const { createJsonDocumentRepository } = require('../storage/postgres-json-repository.cjs');
const { exportDocumentJournal } = require('../storage/postgres-document-journal.cjs');
const {
  replayDocumentJournal, verifyDocumentReplay, PostgresDocumentReplayError, TREE_DIRECTORY, MANIFEST_FILE
} = require('../storage/postgres-document-replay.cjs');

async function roots(t, label = 'replay') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `pult-${label}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function snapshot(t, management = Buffer.from('{"items":[]}\n')) {
  const root = await roots(t, 'replay-snapshot');
  const source = path.join(root, 'source'), backup = path.join(root, 'snapshot');
  await fs.mkdir(source); await fs.mkdir(backup);
  await fs.writeFile(path.join(source, 'management.json'), management);
  await fs.mkdir(path.join(source, 'loan-contracts'));
  await fs.writeFile(path.join(source, 'loan-contracts', 'synthetic.pdf'), Buffer.from('%PDF-synthetic\n'));
  await fs.mkdir(path.join(source, 'history'));
  const database = new DatabaseSync(path.join(source, 'history', 'products.sqlite'));
  database.exec('CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO items VALUES(1,\'unchanged\')');
  database.close();
  await createMigrationSnapshot({ sourceRoot: source, destinationDir: backup, writersStopped: true });
  return { backup, management };
}

test('rejects private and overlapping replay directories before staging', async t => {
  const root = await roots(t);
  const snapshotDir = path.join(root, 'snapshot'), journalDir = path.join(root, 'journal');
  await fs.mkdir(snapshotDir); await fs.mkdir(journalDir);
  await assert.rejects(replayDocumentJournal({ snapshotDir, journalDir, destinationDir: snapshotDir }), error =>
    error instanceof PostgresDocumentReplayError && (error.code === 'DESTINATION_NOT_EMPTY' || error.code === 'DIRECTORY_OVERLAP'));
  const privateDir = path.join(root, '.private', 'stage');
  await fs.mkdir(privateDir, { recursive: true });
  await assert.rejects(replayDocumentJournal({ snapshotDir, journalDir, destinationDir: privateDir }), error => error.code === 'INVALID_DIRECTORY');
});

const integrationUrl = process.env.PULT_TEST_DATABASE_URL;
test('PostgreSQL integration: bound baseline replays document writes and deletion into a new tree', { skip: !integrationUrl, timeout: 30000 }, async t => {
  const databaseName = decodeURIComponent(new URL(integrationUrl).pathname.slice(1));
  assert.match(databaseName, /^pult_test_[a-f0-9]+$/u);
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: integrationUrl, max: 3 });
  let cleanupAuthorized = false;
  try {
    assert.equal((await pool.query("SELECT to_regnamespace('pult') AS schema")).rows[0].schema, null);
    cleanupAuthorized = true;
    await pool.query(require('../storage/postgres-schema.cjs'));
    await pool.query(require('../storage/postgres-document-schema.cjs'));
    const baseline = await snapshot(t);
    await importDocuments({ pool, sourceDir: baseline.backup });
    const store = createStateStore({ pool });
    const managementKey = sourceKey('management.json'), binaryKey = sourceKey('loan-contracts/synthetic.pdf');
    const changed = Buffer.from('{"items":[{"id":"synthetic"}]}\n');
    await store.write(managementKey, changed, { expectedRevision: '1', commandId: crypto.randomUUID(), mediaType: 'application/json' });
    const sequenceName = (await pool.query("SELECT pg_get_serial_sequence('pult.commands','sequence') AS name")).rows[0].name;
    await pool.query('SELECT setval($1::regclass,5,true)', [sequenceName]);
    await store.write(binaryKey, Buffer.from([9, 8, 7, 0, 255]), { expectedRevision: '1', commandId: crypto.randomUUID(), mediaType: 'application/octet-stream' });
    await store.remove(binaryKey, { expectedRevision: '2', commandId: crypto.randomUUID(), mediaType: 'application/pdf' });
    const ideasPath = 'ideas.json', ideasKey = sourceKey(ideasPath);
    const ideas = createJsonDocumentRepository({ stateStore: store, logicalKey: ideasKey, sourcePath: ideasPath,
      validate: value => value?.schema === 1 && Array.isArray(value.items) });
    await ideas.compareAndSet({ schema: 1, items: [{ id: 'new-runtime' }] }, { expectedRevision: '0', commandId: crypto.randomUUID() });
    const secretPath = 'b2b-agent/connection.dpapi', secretKey = sourceKey(secretPath), ciphertext = Buffer.from([0, 255, 44, 128, 0]);
    await store.write(secretKey, ciphertext, { expectedRevision: '0', commandId: crypto.randomUUID(), mediaType: 'application/vnd.pult.dpapi',
      sourceMapping: { sourcePath: secretPath, logicalKey: secretKey, domain: 'protected-connections', mediaType: 'application/vnd.pult.dpapi' } });

    const root = await roots(t, 'replay-output'), journal = path.join(root, 'journal'), destination = path.join(root, 'result');
    await fs.mkdir(journal); await fs.mkdir(destination);
    const journalManifest = await exportDocumentJournal({ pool, checkpointSequence: '0', destinationDir: journal });
    assert.deepEqual(journalManifest.commands.map(item => item.sequence), ['1', '6', '7', '8', '9']);
    assert.equal(journalManifest.baselineDocuments.filter(item => !item.baselinePresent).length, 2);
    const replay = await replayDocumentJournal({ snapshotDir: baseline.backup, journalDir: journal, destinationDir: destination });
    assert.equal(replay.rollbackReady, false);
    assert.equal(replay.scope, 'documents-only');
    assert.deepEqual(await fs.readFile(path.join(destination, TREE_DIRECTORY, 'management.json')), changed);
    await assert.rejects(fs.access(path.join(destination, TREE_DIRECTORY, 'loan-contracts', 'synthetic.pdf')));
    assert.deepEqual(await fs.readFile(path.join(destination, TREE_DIRECTORY, secretPath)), ciphertext);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(destination, TREE_DIRECTORY, ideasPath), 'utf8')), { schema: 1, items: [{ id: 'new-runtime' }] });
    const restoredHistory = new DatabaseSync(path.join(destination, TREE_DIRECTORY, 'history', 'products.sqlite'), { readOnly: true });
    try { assert.equal(restoredHistory.prepare('SELECT value FROM items').get().value, 'unchanged'); }
    finally { restoredHistory.close(); }
    assert.equal((await verifyDocumentReplay(destination)).upperSequence, journalManifest.upperSequence);

    const invalidCommands = path.join(root, 'invalid-commands');
    await fs.cp(destination, invalidCommands, { recursive: true });
    const replayManifestFile = path.join(invalidCommands, MANIFEST_FILE);
    const replayManifest = JSON.parse(await fs.readFile(replayManifestFile, 'utf8'));
    replayManifest.appliedCommands.push({ ...replayManifest.appliedCommands[0] });
    const replayManifestBytes = Buffer.from(`${JSON.stringify(replayManifest, null, 2)}\n`);
    await fs.writeFile(replayManifestFile, replayManifestBytes);
    const markerFile = path.join(invalidCommands, 'REPLAY_COMPLETE.json');
    const marker = JSON.parse(await fs.readFile(markerFile, 'utf8'));
    marker.manifestSha256 = crypto.createHash('sha256').update(replayManifestBytes).digest('hex');
    await fs.writeFile(markerFile, `${JSON.stringify(marker, null, 2)}\n`);
    await assert.rejects(verifyDocumentReplay(invalidCommands), error => error.code === 'REPLAY_INVALID');

    const mismatched = await snapshot(t, Buffer.from('{"items":[{"different":true}]}\n'));
    const rejected = path.join(root, 'rejected'); await fs.mkdir(rejected);
    await assert.rejects(replayDocumentJournal({ snapshotDir: mismatched.backup, journalDir: journal, destinationDir: rejected }),
      error => error.code === 'BASELINE_MISMATCH');
  } finally {
    if (cleanupAuthorized) await pool.query('DROP SCHEMA IF EXISTS pult CASCADE').catch(() => {});
    await pool.end();
  }
});
