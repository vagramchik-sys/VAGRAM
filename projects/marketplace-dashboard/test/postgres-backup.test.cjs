'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  createBackup, verifyRestore, PostgresBackupError, INCOMPLETE_MARKER
} = require('../storage/postgres-backup.cjs');

const BIN = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'Pult', 'PostgreSQL', '18.6', 'bin')
  : null;
const TEST_DATABASE = /^pult_test_[a-f0-9]{8,64}(?:_[a-z0-9_]+)?$/u;

async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pult-pg-backup-'));
  const backup = path.join(root, 'backup');
  await fs.mkdir(backup);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, backup };
}

test('rejects unsafe connection and incomplete backup before restore', async t => {
  const { backup } = await temporary(t);
  await fs.writeFile(path.join(backup, INCOMPLETE_MARKER), '{}');
  const pool = { query: async () => ({ rows: [] }), connect: async () => ({}) };
  await assert.rejects(createBackup({ pool, connection: { host: 'remote', port: 5441 }, binaryDirectory: BIN || 'missing', destinationDir: backup }), error =>
    error instanceof PostgresBackupError && error.code === 'INVALID_ARGUMENT');
  await assert.rejects(verifyRestore({ pool, connection: {
    host: '127.0.0.1', port: 5441, user: 'tester', database: 'pult_test_12345678_restore', password: 'x'
  }, binaryDirectory: BIN || 'missing', backupDir: backup }), error => error.code === 'BACKUP_INCOMPLETE');
});

test('restore target name must be explicitly disposable', async t => {
  const { backup } = await temporary(t);
  const pool = { query: async () => ({ rows: [] }), connect: async () => ({}) };
  await assert.rejects(verifyRestore({ pool, connection: {
    host: '127.0.0.1', port: 5441, user: 'tester', database: 'pult', password: 'x'
  }, binaryDirectory: BIN || 'missing', backupDir: backup }), error => error.code === 'RESTORE_TARGET_FORBIDDEN');
});

const sourceUrl = process.env.PULT_TEST_DATABASE_URL;
const restoreUrl = process.env.PULT_TEST_RESTORE_DATABASE_URL;
test('PostgreSQL integration: custom dump restores with exact rows, keys and catalog metadata', {
  skip: !sourceUrl || !restoreUrl, timeout: 60000
}, async t => {
  const { Pool } = require('pg');
  const sourceParsed = new URL(sourceUrl), restoreParsed = new URL(restoreUrl);
  const connection = parsed => ({
    host: parsed.hostname, port: Number(parsed.port), user: decodeURIComponent(parsed.username),
    database: decodeURIComponent(parsed.pathname.slice(1)), password: decodeURIComponent(parsed.password)
  });
  const source = connection(sourceParsed), target = connection(restoreParsed);
  assert.ok(BIN, 'LOCALAPPDATA is required for PostgreSQL integration tests');
  assert.match(source.database, TEST_DATABASE, 'source must be an explicitly disposable test database');
  assert.match(target.database, TEST_DATABASE, 'restore target must be an explicitly disposable test database');
  assert.notEqual(source.database, target.database, 'source and restore target must be distinct');
  const sourcePool = new Pool({ connectionString: sourceUrl, max: 4 });
  const restorePool = new Pool({ connectionString: restoreUrl, max: 2 });
  let sourceCleanupAuthorized = false, targetCleanupAuthorized = false;
  const { backup } = await temporary(t);
  try {
    const schemaCount = async pool => Number((await pool.query(
      'SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname IN ($1,$2,$3)',
      ['pult', 'pult_history', 'pult_market']
    )).rows[0].count);
    assert.equal(await schemaCount(sourcePool), 0, 'source test database must not contain Pult schemas');
    assert.equal(await schemaCount(restorePool), 0, 'restore test database must not contain Pult schemas');
    sourceCleanupAuthorized = true;
    targetCleanupAuthorized = true;
    await sourcePool.query(`CREATE SCHEMA pult; CREATE SCHEMA pult_history; CREATE SCHEMA pult_market;
      CREATE TABLE pult.commands(sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,payload bytea NOT NULL);
      CREATE TABLE pult_history.parent("camelCaseId" bigint PRIMARY KEY,amount numeric(40,12) NOT NULL);
      CREATE TABLE pult_history.child(id bigint PRIMARY KEY,parent_id bigint NOT NULL REFERENCES pult_history.parent("camelCaseId"),note text);
      CREATE INDEX child_note_idx ON pult_history.child(note);
      CREATE TABLE pult_market.duplicates(value text NOT NULL);
      INSERT INTO pult.commands(payload) VALUES(decode('00ff10','hex'));
      INSERT INTO pult_history.parent VALUES(1,12345678901234567890.123456789012);
      INSERT INTO pult_history.child VALUES(2,1,'synthetic');
      INSERT INTO pult_market.duplicates VALUES('same'),('same');`);
    const manifest = await createBackup({ pool: sourcePool, connection: source, binaryDirectory: BIN, destinationDir: backup });
    assert.equal(manifest.rollbackReady, false);
    assert.equal(manifest.upperSequence, '1');

    const truncated = path.join(path.dirname(backup), 'truncated');
    await fs.cp(backup, truncated, { recursive: true });
    await fs.truncate(path.join(truncated, 'database.dump'), 16);
    await assert.rejects(verifyRestore({ pool: restorePool, connection: target, binaryDirectory: BIN, backupDir: truncated }),
      error => error.code === 'BACKUP_INVALID');
    assert.equal(await schemaCount(restorePool), 0);

    const corrupted = path.join(path.dirname(backup), 'corrupted');
    await fs.cp(backup, corrupted, { recursive: true });
    const corruptedDump = await fs.open(path.join(corrupted, 'database.dump'), 'r+');
    try {
      const byte = Buffer.alloc(1);
      await corruptedDump.read(byte, 0, 1, 0);
      byte[0] ^= 0xff;
      await corruptedDump.write(byte, 0, 1, 0);
    } finally { await corruptedDump.close(); }
    await assert.rejects(verifyRestore({ pool: restorePool, connection: target, binaryDirectory: BIN, backupDir: corrupted }),
      error => error.code === 'BACKUP_INVALID');
    assert.equal(await schemaCount(restorePool), 0);

    const result = await verifyRestore({ pool: restorePool, connection: target, binaryDirectory: BIN, backupDir: backup });
    assert.equal(result.verified, true);
    assert.equal(result.rollbackReady, false);
    assert.equal((await restorePool.query('SELECT count(*)::text AS count FROM pult_market.duplicates')).rows[0].count, '2');
  } finally {
    if (sourceCleanupAuthorized) await sourcePool.query('DROP SCHEMA IF EXISTS pult_market,pult_history,pult CASCADE').catch(() => {});
    if (targetCleanupAuthorized) await restorePool.query('DROP SCHEMA IF EXISTS pult_market,pult_history,pult CASCADE').catch(() => {});
    await sourcePool.end();
    await restorePool.end();
  }
});
