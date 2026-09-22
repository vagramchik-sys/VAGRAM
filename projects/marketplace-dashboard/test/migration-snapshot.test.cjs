'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const {
  createMigrationSnapshot, verifyMigrationSnapshot, MigrationSnapshotError, INCOMPLETE_MARKER, COMPLETE_MARKER, MANIFEST_FILE
} = require('../storage/migration-snapshot.cjs');

async function directories(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pult-snapshot-test-'));
  const source = path.join(root, 'source'), destination = path.join(root, 'backup');
  await fs.mkdir(source); await fs.mkdir(destination);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, source, destination };
}
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

test('creates a verified manifest and completion marker from allowed runtime files', async t => {
  const { source, destination } = await directories(t);
  await fs.writeFile(path.join(source, 'stores.json'), '{"1":{"key":"opaque-ciphertext"}}');
  await fs.writeFile(path.join(source, 'data-1.json'), '{"products":[],"operations":[]}');
  await fs.writeFile(path.join(source, 'worker.log'), 'synthetic diagnostic');

  const manifest = await createMigrationSnapshot({ sourceRoot: source, destinationDir: destination, writersStopped: true });
  assert.equal(manifest.status, 'complete');
  assert.deepEqual(manifest.files.map(item => item.path), ['data-1.json', 'stores.json']);
  assert.equal(manifest.excluded.some(item => item.path === 'worker.log' && item.kind === 'diagnostic'), true);
  assert.equal(await fs.readFile(path.join(destination, 'stores.json'), 'utf8'), '{"1":{"key":"opaque-ciphertext"}}');
  const manifestBytes = await fs.readFile(path.join(destination, MANIFEST_FILE));
  const marker = JSON.parse(await fs.readFile(path.join(destination, COMPLETE_MARKER), 'utf8'));
  assert.equal(marker.manifestSha256, sha(manifestBytes));
  assert.equal((await verifyMigrationSnapshot(destination)).status, 'complete');
  await assert.rejects(fs.access(path.join(destination, INCOMPLETE_MARKER)));
});

test('independent verifier rejects changed and unmanifested backup files', async t => {
  const { source, destination } = await directories(t);
  await fs.writeFile(path.join(source, 'stores.json'), '{}');
  await createMigrationSnapshot({ sourceRoot: source, destinationDir: destination, writersStopped: true });
  await fs.writeFile(path.join(destination, 'stores.json'), '{"changed":true}');
  await assert.rejects(verifyMigrationSnapshot(destination), error => error.code === 'BACKUP_VERIFY_FAILED');

  const second = await directories(t);
  await fs.writeFile(path.join(second.source, 'stores.json'), '{}');
  await createMigrationSnapshot({ sourceRoot: second.source, destinationDir: second.destination, writersStopped: true });
  await fs.writeFile(path.join(second.destination, 'extra.json'), '{}');
  await assert.rejects(verifyMigrationSnapshot(second.destination), error => error.code === 'BACKUP_VERIFY_FAILED');
});

test('uses SQLite online backup and includes committed rows still represented by WAL', async t => {
  const { source, destination } = await directories(t);
  const history = path.join(source, 'history');
  await fs.mkdir(history);
  const sourceDatabase = path.join(history, 'products.sqlite');
  const writer = new DatabaseSync(sourceDatabase);
  try {
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO items VALUES(1,\'from-wal\');');
    const manifest = await createMigrationSnapshot({ sourceRoot: source, destinationDir: destination, writersStopped: true });
    const item = manifest.files.find(file => file.path === 'history/products.sqlite');
    assert.equal(item.method, 'sqlite-online-backup');
    assert.equal(manifest.files.some(file => /-wal$|-shm$/u.test(file.path)), false);
    const restored = new DatabaseSync(path.join(destination, 'history', 'products.sqlite'), { readOnly: true });
    try {
      const row = restored.prepare('SELECT * FROM items').get();
      assert.equal(row.id, 1); assert.equal(row.value, 'from-wal');
    }
    finally { restored.close(); }
  } finally { writer.close(); }
});

test('requires explicit stopped-writer confirmation and an empty separate destination', async t => {
  const { source, destination } = await directories(t);
  await assert.rejects(
    createMigrationSnapshot({ sourceRoot: source, destinationDir: destination, writersStopped: false }),
    error => error instanceof MigrationSnapshotError && error.code === 'WRITERS_NOT_STOPPED'
  );
  await fs.writeFile(path.join(destination, 'occupied'), 'x');
  await assert.rejects(
    createMigrationSnapshot({ sourceRoot: source, destinationDir: destination, writersStopped: true }),
    error => error.code === 'DESTINATION_NOT_EMPTY'
  );
});

test('fails closed on unknown and source-evidence files and leaves no completion marker', async t => {
  for (const relative of ['unknown-state.json', 'stock-history-imports/evidence.json']) {
    const { source, destination } = await directories(t);
    const file = path.join(source, ...relative.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{}');
    await assert.rejects(
      createMigrationSnapshot({ sourceRoot: source, destinationDir: destination, writersStopped: true }),
      error => error.code === 'INVENTORY_BLOCKED'
    );
    assert.equal(JSON.parse(await fs.readFile(path.join(destination, INCOMPLETE_MARKER), 'utf8')).status, 'incomplete');
    await assert.rejects(fs.access(path.join(destination, COMPLETE_MARKER)));
  }
});

test('rejects directory links without following them', async t => {
  const { root, source, destination } = await directories(t);
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'data-1.json'), '{}');
  try { await fs.symlink(outside, path.join(source, 'linked'), 'junction'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('junction creation is not permitted'); throw error; }
  await assert.rejects(
    createMigrationSnapshot({ sourceRoot: source, destinationDir: destination, writersStopped: true }),
    error => error.code === 'INVENTORY_BLOCKED'
  );
  await assert.rejects(fs.access(path.join(destination, COMPLETE_MARKER)));
});

test('detects an ordinary source file changing during the copy', async t => {
  const { source, destination } = await directories(t);
  const file = path.join(source, 'data-1.json');
  await fs.writeFile(file, Buffer.alloc(16 * 1024 * 1024, 65));
  let stopped = false;
  const mutate = async () => {
    let tick = 1;
    while (!stopped) {
      const changed = new Date(Date.now() + tick++ * 1000);
      try { await fs.utimes(file, changed, changed); }
      catch (error) { if (error.code !== 'EBUSY') throw error; }
      await new Promise(resolve => setTimeout(resolve, 1));
    }
  };
  const mutation = mutate();
  try {
    await assert.rejects(
      createMigrationSnapshot({ sourceRoot: source, destinationDir: destination, writersStopped: true }),
      error => error.code === 'SOURCE_CHANGED' || error.code === 'SOURCE_SET_CHANGED'
    );
  } finally { stopped = true; await mutation; }
  await assert.rejects(fs.access(path.join(destination, COMPLETE_MARKER)));
});

test('final inventory rescan rejects a runtime file added after the initial scan', async t => {
  const { source, destination } = await directories(t);
  await fs.writeFile(path.join(source, 'data-1.json'), Buffer.alloc(32 * 1024 * 1024, 65));
  let addition;
  const watcher = fsSync.watch(destination, (_event, name) => {
    if (String(name) === 'data-1.json' && !addition) addition = fs.writeFile(path.join(source, 'data-2.json'), '{}');
  });
  try {
    await assert.rejects(
      createMigrationSnapshot({ sourceRoot: source, destinationDir: destination, writersStopped: true }),
      error => error.code === 'SOURCE_SET_CHANGED'
    );
    if (addition) await addition;
  } finally { watcher.close(); }
  await assert.rejects(fs.access(path.join(destination, COMPLETE_MARKER)));
});

test('rejects a late WAL commit after SQLite backup while a later file is copied', async t => {
  const { source, destination } = await directories(t);
  const history = path.join(source, 'history');
  await fs.mkdir(history);
  const databaseFile = path.join(history, 'products.sqlite');
  const writer = new DatabaseSync(databaseFile);
  let mutated = false, mutationError;
  try {
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE items(id INTEGER PRIMARY KEY); INSERT INTO items VALUES(1);');
    await fs.writeFile(path.join(source, 'wb-orders-1.json'), Buffer.alloc(32 * 1024 * 1024, 66));
    const watcher = fsSync.watch(destination, { recursive: true }, (_event, name) => {
      if (!mutated && String(name).includes('wb-orders-1.json')) {
        try { writer.exec('INSERT INTO items VALUES(2)'); mutated = true; } catch (error) { mutationError = error; }
      }
    });
    try {
      await assert.rejects(
        createMigrationSnapshot({ sourceRoot: source, destinationDir: destination, writersStopped: true }),
        error => error.code === 'SOURCE_CHANGED'
      );
    } finally { watcher.close(); }
    if (mutationError) throw mutationError;
    assert.equal(mutated, true);
  } finally { writer.close(); }
  await assert.rejects(fs.access(path.join(destination, COMPLETE_MARKER)));
});
