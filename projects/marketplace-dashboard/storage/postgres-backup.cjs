'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { withWriteFence } = require('./postgres-write-fence.cjs');

const SCHEMAS = Object.freeze(['pult', 'pult_history', 'pult_market']);
const INCOMPLETE_MARKER = 'BACKUP_INCOMPLETE.json';
const COMPLETE_MARKER = 'BACKUP_COMPLETE.json';
const MANIFEST_FILE = 'backup-manifest.json';
const DUMP_FILE = 'database.dump';
const IDENTIFIER = /^[a-z_][a-z0-9_$]{0,62}$/u;
const TEST_DATABASE = /^pult_test_[a-f0-9]{8,64}(?:_[a-z0-9_]+)?$/u;

class PostgresBackupError extends Error {
  constructor(code, message) { super(message); this.name = 'PostgresBackupError'; this.code = code; }
}
const fail = (code, message) => { throw new PostgresBackupError(code, message); };
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const quote = value => `"${value.replace(/"/g, '""')}"`;
const stable = value => JSON.stringify(value);
const catalogIdentifier = value => typeof value === 'string' && value.length > 0 &&
  Buffer.byteLength(value, 'utf8') <= 63 && !value.includes('\0');

async function realDirectory(value, field, empty = false) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail('INVALID_ARGUMENT', `${field} must be an absolute directory`);
  const stat = await fs.lstat(value).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail('INVALID_ARGUMENT', `${field} must be a real directory`);
  const result = await fs.realpath(value);
  if (empty && (await fs.readdir(result)).length) fail('DESTINATION_NOT_EMPTY', 'Backup destination must be empty');
  return result;
}

function validateConnection(connection, restore = false) {
  if (!connection || connection.host !== '127.0.0.1' || connection.port !== 5441 ||
      typeof connection.user !== 'string' || !IDENTIFIER.test(connection.user) ||
      typeof connection.database !== 'string' || !IDENTIFIER.test(connection.database) ||
      typeof connection.password !== 'string' || connection.password.length < 1 || connection.password.length > 1024)
    fail('INVALID_ARGUMENT', 'Invalid local PostgreSQL connection configuration');
  if (restore && !TEST_DATABASE.test(connection.database))
    fail('RESTORE_TARGET_FORBIDDEN', 'Restore target must be an explicitly named disposable test database');
  return connection;
}

async function binary(directory, name) {
  const root = await realDirectory(directory, 'binaryDirectory');
  const filename = path.join(root, process.platform === 'win32' ? `${name}.exe` : name);
  const stat = await fs.lstat(filename).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) fail('BINARY_UNAVAILABLE', 'Required PostgreSQL backup binary is unavailable');
  return filename;
}

async function syncFile(filename) {
  const handle = await fs.open(filename, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function digestFile(filename) {
  const hash = crypto.createHash('sha256');
  let bytes = 0n;
  await new Promise((resolve, reject) => {
    const stream = fsSync.createReadStream(filename);
    stream.on('data', chunk => { bytes += BigInt(chunk.length); hash.update(chunk); });
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return { bytes: bytes.toString(), sha256: hash.digest('hex') };
}

async function safeBackupFile(root, name) {
  const filename = path.join(root, name);
  const stat = await fs.lstat(filename).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) fail('BACKUP_INVALID', 'PostgreSQL backup contains an unsafe file');
  const resolved = await fs.realpath(filename);
  if (path.dirname(resolved) !== root) fail('BACKUP_INVALID', 'PostgreSQL backup file resolves outside its directory');
  return filename;
}

async function writeJson(filename, value, flag = 'wx') {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  const handle = await fs.open(filename, flag);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  return bytes;
}

function run(binaryFile, args, connection) {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryFile, args, {
      windowsHide: true,
      env: { ...process.env, PGPASSWORD: connection.password },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let errorBytes = 0;
    child.stderr.on('data', chunk => { errorBytes += chunk.length; if (errorBytes > 1024 * 1024) child.kill(); });
    child.on('error', () => reject(new PostgresBackupError('BACKUP_PROCESS_FAILED', 'PostgreSQL backup process could not start')));
    child.on('close', (code, signal) => code === 0 && !signal ? resolve() : reject(new PostgresBackupError('BACKUP_PROCESS_FAILED', 'PostgreSQL backup process failed')));
  });
}

function connectionArgs(connection) {
  return ['--host', connection.host, '--port', String(connection.port), '--username', connection.user, '--dbname', connection.database];
}

async function assertIdentity(pool, connection) {
  let result;
  try { result = await pool.query('SELECT current_database() AS database,current_user AS role,inet_server_port() AS port'); }
  catch { fail('DATABASE_ERROR', 'PostgreSQL backup identity check failed'); }
  const row = result.rows?.[0];
  if (!row || row.database !== connection.database || row.role !== connection.user || Number(row.port) !== connection.port)
    fail('DATABASE_IDENTITY_MISMATCH', 'PostgreSQL pool does not match the supplied connection');
}

function hashFrame(hash, text) {
  const bytes = Buffer.from(String(text), 'utf8');
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length).update(bytes);
}

async function tableRows(client, table, cursorNumber) {
  const schema = quote(table.schema), name = quote(table.table);
  const rowHash = `encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex')`;
  const order = table.primaryKey.length ? table.primaryKey.map(quote).join(',') : rowHash;
  const keyHash = table.primaryKey.length
    ? `encode(sha256(convert_to(jsonb_build_array(${table.primaryKey.map(column => `to_jsonb(t.${quote(column)})`).join(',')})::text,'UTF8')),'hex')`
    : 'NULL::text';
  const cursor = `pult_backup_${cursorNumber}`;
  await client.query(`DECLARE ${quote(cursor)} NO SCROLL CURSOR FOR SELECT ${rowHash} AS row_hash,${keyHash} AS key_hash FROM ${schema}.${name} t ORDER BY ${order}`);
  const rows = crypto.createHash('sha256'), keys = table.primaryKey.length ? crypto.createHash('sha256') : null;
  let count = 0n;
  try {
    for (;;) {
      const page = await client.query(`FETCH FORWARD 128 FROM ${quote(cursor)}`);
      if (!page.rows.length) break;
      for (const row of page.rows) {
        hashFrame(rows, row.row_hash);
        if (keys) hashFrame(keys, row.key_hash);
        count++;
      }
    }
  } finally { await client.query(`CLOSE ${quote(cursor)}`).catch(() => {}); }
  return { ...table, count: count.toString(), rowSha256: rows.digest('hex'), keySha256: keys ? keys.digest('hex') : null };
}

async function databaseInventory(client) {
  const tablesResult = await client.query(`SELECT n.nspname AS schema_name,c.relname AS table_name,
    COALESCE((SELECT array_agg(a.attname::text ORDER BY k.ordinality)::text[] FROM pg_index i
      CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality)
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum
      WHERE i.indrelid=c.oid AND i.indisprimary),ARRAY[]::text[]) AS primary_key
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=ANY($1::text[]) AND (c.relkind='p' OR (c.relkind='r' AND NOT c.relispartition))
    ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C"`, [SCHEMAS]);
  const tables = [];
  let cursor = 0;
  for (const row of tablesResult.rows) {
    if (!catalogIdentifier(row.schema_name) || !catalogIdentifier(row.table_name) ||
        !Array.isArray(row.primary_key) || row.primary_key.some(column => !catalogIdentifier(column)))
      fail('DATABASE_SHAPE_INVALID', 'PostgreSQL catalog contains an unsupported identifier');
    tables.push(await tableRows(client, { schema: row.schema_name, table: row.table_name, primaryKey: row.primary_key }, ++cursor));
  }

  const constraints = (await client.query(`SELECT n.nspname AS schema_name,c.relname AS table_name,k.conname AS constraint_name,
    k.contype AS type,k.convalidated AS validated,pg_get_constraintdef(k.oid,true) AS definition
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=ANY($1::text[]) ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C",k.conname COLLATE "C"`, [SCHEMAS])).rows.map(row => ({
    schema: row.schema_name, table: row.table_name, name: row.constraint_name,
    type: row.type, validated: row.validated === true, definition: row.definition
  }));
  if (constraints.some(item => !item.validated)) fail('CONSTRAINT_NOT_VALIDATED', 'PostgreSQL contains an unvalidated constraint');

  const indexes = (await client.query(`SELECT n.nspname AS schema_name,c.relname AS table_name,i.relname AS index_name,
    x.indisvalid AS valid,x.indisready AS ready,x.indisunique AS unique_index,x.indisprimary AS primary_index,
    pg_get_indexdef(i.oid) AS definition
    FROM pg_index x JOIN pg_class c ON c.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=ANY($1::text[]) ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C",i.relname COLLATE "C"`, [SCHEMAS])).rows.map(row => ({
    schema: row.schema_name, table: row.table_name, name: row.index_name,
    valid: row.valid === true, ready: row.ready === true, unique: row.unique_index === true,
    primary: row.primary_index === true, definition: row.definition
  }));
  if (indexes.some(item => !item.valid || !item.ready)) fail('INDEX_INVALID', 'PostgreSQL contains an invalid index');
  return { tables, constraints, indexes };
}

async function commandSequence(client) {
  const exists = (await client.query("SELECT to_regclass('pult.commands')::text AS name")).rows?.[0]?.name;
  if (!exists) fail('DATABASE_SHAPE_INVALID', 'pult.commands is required for a backup checkpoint');
  return String((await client.query('SELECT COALESCE(max(sequence),0)::text AS sequence FROM pult.commands')).rows[0].sequence);
}

async function verifyArtifacts(backupDir) {
  const root = await realDirectory(backupDir, 'backupDir');
  if (await fs.access(path.join(root, INCOMPLETE_MARKER)).then(() => true, () => false))
    fail('BACKUP_INCOMPLETE', 'PostgreSQL backup is incomplete');
  let markerBytes, manifestBytes, marker, manifest;
  try {
    const markerFile = await safeBackupFile(root, COMPLETE_MARKER);
    const manifestFile = await safeBackupFile(root, MANIFEST_FILE);
    markerBytes = await fs.readFile(markerFile);
    manifestBytes = await fs.readFile(manifestFile);
    marker = JSON.parse(markerBytes.toString('utf8'));
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch { fail('BACKUP_INVALID', 'PostgreSQL backup marker or manifest is invalid'); }
  if (marker?.schemaVersion !== 1 || marker.manifest !== MANIFEST_FILE || marker.manifestSha256 !== sha256(manifestBytes) ||
      manifest?.schemaVersion !== 1 || manifest.status !== 'complete' || manifest.dump?.file !== DUMP_FILE ||
      !/^[a-f0-9]{64}$/u.test(manifest.dump.sha256) || !/^(0|[1-9]\d*)$/u.test(manifest.dump.bytes) ||
      typeof manifest.sourceDatabase !== 'string' || !Array.isArray(manifest.tables) || !Array.isArray(manifest.constraints) || !Array.isArray(manifest.indexes))
    fail('BACKUP_INVALID', 'PostgreSQL backup manifest authentication failed');
  const dump = await safeBackupFile(root, DUMP_FILE), digest = await digestFile(dump).catch(() => null);
  if (!digest || digest.bytes !== manifest.dump.bytes || digest.sha256 !== manifest.dump.sha256)
    fail('BACKUP_INVALID', 'PostgreSQL dump does not match its manifest');
  const actual = (await fs.readdir(root)).sort();
  const expected = [COMPLETE_MARKER, DUMP_FILE, MANIFEST_FILE].sort();
  if (stable(actual) !== stable(expected)) fail('BACKUP_INVALID', 'PostgreSQL backup contains unexpected files');
  return { root, manifest, dump };
}

async function createBackup({ pool, connection, binaryDirectory, destinationDir } = {}) {
  if (!pool?.query || !pool?.connect) fail('INVALID_ARGUMENT', 'pool is required');
  connection = validateConnection(connection);
  const destination = await realDirectory(destinationDir, 'destinationDir', true);
  const pgDump = await binary(binaryDirectory, 'pg_dump');
  await assertIdentity(pool, connection);
  const incomplete = path.join(destination, INCOMPLETE_MARKER);
  await writeJson(incomplete, { schemaVersion: 1, status: 'incomplete', startedAt: new Date().toISOString() });
  try {
    let checkpoint;
    await withWriteFence({ pool, timeoutMs: 30000 }, async client => {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        await client.query("SET LOCAL TIME ZONE 'UTC'");
        await client.query("SET LOCAL DateStyle TO 'ISO, YMD'");
        await client.query('SET LOCAL extra_float_digits TO 3');
        const snapshot = (await client.query('SELECT pg_export_snapshot() AS snapshot')).rows?.[0]?.snapshot;
        if (typeof snapshot !== 'string' || !snapshot) fail('DATABASE_ERROR', 'PostgreSQL did not export a backup snapshot');
        const upperSequence = await commandSequence(client);
        const inventory = await databaseInventory(client);
        await run(pgDump, [
          ...connectionArgs(connection), '--format=custom', '--no-owner', '--no-acl', '--snapshot', snapshot,
          ...SCHEMAS.flatMap(schema => ['--schema', schema]),
          '--file', path.join(destination, DUMP_FILE)
        ], connection);
        checkpoint = { upperSequence, ...inventory };
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    });
    await syncFile(path.join(destination, DUMP_FILE));
    const dump = await digestFile(path.join(destination, DUMP_FILE));
    const manifest = {
      schemaVersion: 1, status: 'complete', createdAt: new Date().toISOString(), sourceDatabase: connection.database,
      upperSequence: checkpoint.upperSequence, schemas: [...SCHEMAS], dump: { file: DUMP_FILE, ...dump },
      tables: checkpoint.tables, constraints: checkpoint.constraints, indexes: checkpoint.indexes,
      rollbackReady: false
    };
    const manifestBytes = await writeJson(path.join(destination, MANIFEST_FILE), manifest);
    await fs.unlink(incomplete);
    await writeJson(path.join(destination, COMPLETE_MARKER), {
      schemaVersion: 1, manifest: MANIFEST_FILE, manifestSha256: sha256(manifestBytes)
    });
    await verifyArtifacts(destination);
    return manifest;
  } catch (error) {
    await fs.unlink(path.join(destination, COMPLETE_MARKER)).catch(() => {});
    await fs.writeFile(incomplete, `${JSON.stringify({ schemaVersion: 1, status: 'incomplete', code: error?.code || 'BACKUP_FAILED' }, null, 2)}\n`).catch(() => {});
    if (error instanceof PostgresBackupError) throw error;
    fail('BACKUP_FAILED', 'PostgreSQL backup failed');
  }
}

async function verifyRestore({ pool, connection, binaryDirectory, backupDir } = {}) {
  if (!pool?.query || !pool?.connect) fail('INVALID_ARGUMENT', 'pool is required');
  connection = validateConnection(connection, true);
  const artifacts = await verifyArtifacts(backupDir);
  if (connection.database === artifacts.manifest.sourceDatabase)
    fail('RESTORE_TARGET_FORBIDDEN', 'Restore target must differ from the source database');
  const pgRestore = await binary(binaryDirectory, 'pg_restore');
  await assertIdentity(pool, connection);
  const occupied = await pool.query('SELECT nspname FROM pg_namespace WHERE nspname=ANY($1::text[])', [SCHEMAS]);
  if (occupied.rows.length) fail('RESTORE_TARGET_NOT_EMPTY', 'Restore target already contains a Pult schema');
  await run(pgRestore, [
    ...connectionArgs(connection), '--exit-on-error', '--no-owner', '--no-acl', artifacts.dump
  ], connection).catch(error => { throw error instanceof PostgresBackupError
    ? new PostgresBackupError('RESTORE_FAILED', 'PostgreSQL restore process failed') : error; });

  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    await client.query("SET LOCAL DateStyle TO 'ISO, YMD'");
    await client.query('SET LOCAL extra_float_digits TO 3');
    const upperSequence = await commandSequence(client);
    const inventory = await databaseInventory(client);
    if (upperSequence !== artifacts.manifest.upperSequence ||
        stable(inventory.tables) !== stable(artifacts.manifest.tables) ||
        stable(inventory.constraints) !== stable(artifacts.manifest.constraints) ||
        stable(inventory.indexes) !== stable(artifacts.manifest.indexes))
      fail('RESTORE_VERIFICATION_FAILED', 'Restored PostgreSQL database does not match the backup manifest');
    await client.query('COMMIT');
    return { verified: true, sourceDatabase: artifacts.manifest.sourceDatabase, targetDatabase: connection.database,
      upperSequence, tables: inventory.tables.length, rollbackReady: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error instanceof PostgresBackupError) throw error;
    fail('RESTORE_VERIFICATION_FAILED', 'Restored PostgreSQL database verification failed');
  } finally { client.release(); }
}

module.exports = {
  createBackup, verifyRestore, PostgresBackupError,
  INCOMPLETE_MARKER, COMPLETE_MARKER, MANIFEST_FILE, DUMP_FILE
};
