'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync, backup } = require('node:sqlite');
const { inspectPrivateDirectory } = require('./source-inventory.cjs');

const INCOMPLETE_MARKER = 'SNAPSHOT_INCOMPLETE.json';
const COMPLETE_MARKER = 'SNAPSHOT_COMPLETE.json';
const MANIFEST_FILE = 'snapshot-manifest.json';
const SQLITE_MAIN = /^history\/(products|archive|stocks)\.sqlite$/u;
const EXCLUDED_KINDS = new Set(['backup', 'candidate-source', 'diagnostic', 'ephemeral', 'sqlite-sidecar']);

class MigrationSnapshotError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MigrationSnapshotError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new MigrationSnapshotError(code, message); };
const digestBuffer = value => crypto.createHash('sha256').update(value).digest('hex');
async function digestFile(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fsSync.createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}
function canonicalRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') || value.includes(':') ||
      value.split('/').some(part => !part || part === '.' || part === '..')) fail('INVALID_PATH', 'Inventory contains an invalid path');
  return value;
}
function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function realDirectory(value, field) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail('INVALID_ARGUMENT', `${field} must be an absolute path`);
  const stat = await fs.lstat(value).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail('INVALID_ARGUMENT', `${field} must be a real directory`);
  return fs.realpath(value);
}
function statView(stat) {
  return {
    dev: stat.dev.toString(), ino: stat.ino.toString(), size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString()
  };
}
const sameFingerprint = (left, right) => Object.keys(left).every(key => left[key] === right[key]);
function runtimeInventorySignature(inventory) {
  return JSON.stringify(inventory.entries.filter(entry => entry.kind === 'runtime').map(entry => ({
    path: entry.path, bytes: entry.bytes, modifiedAt: entry.modifiedAt, domain: entry.domain, target: entry.target
  })));
}
async function fingerprint(file, withHash = true) {
  const stat = await fs.stat(file, { bigint: true });
  if (!stat.isFile()) fail('SOURCE_CHANGED', 'Source is no longer a regular file');
  return { ...statView(stat), ...(withHash ? { sha256: await digestFile(file) } : {}) };
}
async function assertSafeSourceFile(root, relativePath) {
  const source = path.join(root, ...canonicalRelative(relativePath).split('/'));
  if (!inside(root, source)) fail('INVALID_PATH', 'Source path escapes the source root');
  const linkStat = await fs.lstat(source);
  if (!linkStat.isFile() || linkStat.isSymbolicLink()) fail('LINK_NOT_ALLOWED', 'Snapshot sources must be regular files');
  const resolved = await fs.realpath(source);
  if (!inside(root, resolved)) fail('OUTSIDE_ROOT', 'Snapshot source resolves outside the source root');
  return source;
}
async function destinationPath(root, relativePath) {
  const destination = path.join(root, ...canonicalRelative(relativePath).split('/'));
  if (!inside(root, destination)) fail('INVALID_PATH', 'Destination path escapes the backup root');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const parent = await fs.realpath(path.dirname(destination));
  if (!inside(root, parent) && parent !== root) fail('OUTSIDE_ROOT', 'Destination parent resolves outside the backup root');
  return destination;
}
async function copyRegular(sourceRoot, destinationRoot, entry) {
  const source = await assertSafeSourceFile(sourceRoot, entry.path);
  const destination = await destinationPath(destinationRoot, entry.path);
  const before = await fingerprint(source);
  await fs.copyFile(source, destination, fsSync.constants.COPYFILE_EXCL);
  const after = await fingerprint(source);
  const copied = await fingerprint(destination);
  if (!sameFingerprint(before, after) || before.sha256 !== after.sha256 || after.sha256 !== copied.sha256 || after.size !== copied.size)
    fail('SOURCE_CHANGED', 'Source changed while the snapshot was being copied');
  return { path: entry.path, method: 'file-copy', domain: entry.domain, bytes: copied.size, sha256: copied.sha256, sourceBefore: before, sourceAfter: after };
}
async function sqliteFamilyFingerprint(source) {
  const result = {};
  for (const suffix of ['', '-wal']) {
    const file = source + suffix;
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink()) fail('LINK_NOT_ALLOWED', 'SQLite database family contains an unsafe file');
    result[suffix || 'main'] = await fingerprint(file);
  }
  return result;
}
async function removeGeneratedSqliteSidecars(file) {
  await fs.unlink(file + '-wal').catch(error => { if (error.code !== 'ENOENT') throw error; });
  await fs.unlink(file + '-shm').catch(error => { if (error.code !== 'ENOENT') throw error; });
}
async function syncFile(file) {
  // Windows FlushFileBuffers requires a writable handle even for our completed copies.
  const handle = await fs.open(file, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function copySqlite(sourceRoot, destinationRoot, entry) {
  const source = await assertSafeSourceFile(sourceRoot, entry.path);
  const destination = await destinationPath(destinationRoot, entry.path);
  const before = await sqliteFamilyFingerprint(source);
  let database;
  try {
    database = new DatabaseSync(source, { readOnly: true });
    await backup(database, destination, { rate: 100 });
  } finally {
    if (database) database.close();
  }
  const after = await sqliteFamilyFingerprint(source);
  if (JSON.stringify(before) !== JSON.stringify(after)) fail('SOURCE_CHANGED', 'SQLite source changed during online backup');
  const copied = await fingerprint(destination);
  let verification;
  try {
    verification = new DatabaseSync(destination, { readOnly: true });
    const check = verification.prepare('PRAGMA integrity_check').get();
    if (!check || Object.values(check)[0] !== 'ok') fail('BACKUP_VERIFY_FAILED', 'SQLite backup integrity check failed');
  } finally {
    if (verification) verification.close();
  }
  await removeGeneratedSqliteSidecars(destination);
  await syncFile(destination);
  return { path: entry.path, method: 'sqlite-online-backup', domain: entry.domain, bytes: copied.size, sha256: copied.sha256, sourceBefore: before, sourceAfter: after };
}
async function writeJson(file, value, flag = 'wx') {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  const handle = await fs.open(file, flag);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  return bytes;
}

async function snapshotFileSet(root) {
  const result = [];
  async function walk(folder, prefix = '') {
    for (const child of await fs.readdir(folder, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      const file = path.join(folder, child.name), stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) fail('LINK_NOT_ALLOWED', 'Backup snapshot contains a link');
      const resolved = await fs.realpath(file);
      if (!inside(root, resolved)) fail('OUTSIDE_ROOT', 'Backup snapshot entry resolves outside its root');
      if (stat.isDirectory()) await walk(file, relative);
      else if (stat.isFile()) result.push(relative);
      else fail('BACKUP_VERIFY_FAILED', 'Backup snapshot contains an unsupported file type');
    }
  }
  await walk(root);
  return result.sort();
}

async function verifyMigrationSnapshot(destinationDir) {
  const destination = await realDirectory(destinationDir, 'destinationDir');
  if (await fs.access(path.join(destination, INCOMPLETE_MARKER)).then(() => true, () => false))
    fail('SNAPSHOT_INCOMPLETE', 'Backup snapshot has an incomplete marker');
  let markerBytes, manifestBytes, marker, manifest;
  try {
    const markerFile = await assertSafeSourceFile(destination, COMPLETE_MARKER);
    const manifestFile = await assertSafeSourceFile(destination, MANIFEST_FILE);
    markerBytes = await fs.readFile(markerFile);
    manifestBytes = await fs.readFile(manifestFile);
    marker = JSON.parse(markerBytes.toString('utf8'));
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch { fail('BACKUP_VERIFY_FAILED', 'Backup snapshot marker or manifest is missing or invalid'); }
  if (marker?.schemaVersion !== 1 || marker.manifest !== MANIFEST_FILE || !/^[a-f0-9]{64}$/u.test(marker.manifestSha256) ||
      digestBuffer(manifestBytes) !== marker.manifestSha256 || manifest?.schemaVersion !== 1 || manifest.status !== 'complete' || !Array.isArray(manifest.files))
    fail('BACKUP_VERIFY_FAILED', 'Backup snapshot marker does not authenticate the manifest');
  const expected = new Set([COMPLETE_MARKER, MANIFEST_FILE]);
  const sqliteFiles = [];
  for (const item of manifest.files) {
    const relative = canonicalRelative(item?.path);
    if (expected.has(relative) || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256) ||
        typeof item.bytes !== 'string' || !/^(0|[1-9]\d*)$/u.test(item.bytes)) fail('BACKUP_VERIFY_FAILED', 'Backup manifest contains an invalid file entry');
    expected.add(relative);
    const file = await assertSafeSourceFile(destination, relative);
    const actual = await fingerprint(file);
    if (actual.size !== item.bytes || actual.sha256 !== item.sha256) fail('BACKUP_VERIFY_FAILED', 'Backup file does not match the manifest');
    if (item.method === 'sqlite-online-backup') sqliteFiles.push(file);
  }
  const actualFiles = await snapshotFileSet(destination);
  if (actualFiles.length !== expected.size || actualFiles.some(file => !expected.has(file)))
    fail('BACKUP_VERIFY_FAILED', 'Backup snapshot contains files absent from the manifest');
  for (const file of sqliteFiles) {
    let database;
    try {
      database = new DatabaseSync(file, { readOnly: true });
      const check = database.prepare('PRAGMA integrity_check').get();
      if (!check || Object.values(check)[0] !== 'ok') fail('BACKUP_VERIFY_FAILED', 'SQLite backup integrity check failed');
    } finally { if (database) database.close(); }
    await removeGeneratedSqliteSidecars(file);
  }
  return manifest;
}

async function createMigrationSnapshot({ sourceRoot, destinationDir, writersStopped } = {}) {
  if (writersStopped !== true) fail('WRITERS_NOT_STOPPED', 'Explicit writersStopped=true confirmation is required');
  const source = await realDirectory(sourceRoot, 'sourceRoot');
  const destination = await realDirectory(destinationDir, 'destinationDir');
  if (source === destination || inside(source, destination) || inside(destination, source))
    fail('INVALID_ARGUMENT', 'Source and destination directories must be separate');
  if ((await fs.readdir(destination)).length !== 0) fail('DESTINATION_NOT_EMPTY', 'Destination backup directory must be empty');

  const incompletePath = path.join(destination, INCOMPLETE_MARKER);
  await writeJson(incompletePath, { schemaVersion: 1, status: 'incomplete', startedAt: new Date().toISOString() });
  try {
    const inventory = await inspectPrivateDirectory(source);
    if (inventory.blockers.length) fail('INVENTORY_BLOCKED', 'Source inventory contains links, unknown files, or evidence requiring classification');
    const included = inventory.entries.filter(entry => entry.kind === 'runtime');
    const excluded = inventory.entries.filter(entry => EXCLUDED_KINDS.has(entry.kind)).map(entry => ({ path: entry.path, kind: entry.kind, domain: entry.domain }));
    const unhandled = inventory.entries.filter(entry => entry.kind !== 'runtime' && !EXCLUDED_KINDS.has(entry.kind));
    if (unhandled.length) fail('INVENTORY_BLOCKED', 'Source inventory contains an unhandled classification');

    const files = [];
    for (const entry of included) files.push(SQLITE_MAIN.test(entry.path)
      ? await copySqlite(source, destination, entry)
      : await copyRegular(source, destination, entry));

    const finalInventory = await inspectPrivateDirectory(source);
    if (finalInventory.blockers.length || runtimeInventorySignature(finalInventory) !== runtimeInventorySignature(inventory))
      fail('SOURCE_SET_CHANGED', 'Runtime source inventory changed while the snapshot was being created');

    for (const item of files) {
      const sourceFile = await assertSafeSourceFile(source, item.path);
      const finalSource = item.method === 'sqlite-online-backup' ? await sqliteFamilyFingerprint(sourceFile) : await fingerprint(sourceFile);
      if (JSON.stringify(finalSource) !== JSON.stringify(item.sourceAfter))
        fail('SOURCE_CHANGED', 'Source changed after it was copied but before snapshot completion');
      const copied = await assertSafeSourceFile(destination, item.path);
      const verified = await fingerprint(copied);
      if (verified.size !== item.bytes || verified.sha256 !== item.sha256) fail('BACKUP_VERIFY_FAILED', 'Copied file changed before snapshot completion');
      await syncFile(copied);
    }
    const manifest = {
      schemaVersion: 1, status: 'complete', createdAt: new Date().toISOString(), writersStopped: true,
      inventorySchemaVersion: inventory.schemaVersion, files, excluded,
      totals: { files: files.length, bytes: files.reduce((sum, item) => sum + BigInt(item.bytes), 0n).toString() }
    };
    const manifestBytes = await writeJson(path.join(destination, MANIFEST_FILE), manifest);
    const manifestSha256 = digestBuffer(manifestBytes);
    await fs.unlink(incompletePath);
    // File data and markers are fsynced. Portable directory fsync is not promised on Windows.
    await writeJson(path.join(destination, COMPLETE_MARKER), { schemaVersion: 1, manifest: MANIFEST_FILE, manifestSha256 });
    await verifyMigrationSnapshot(destination);
    return { ...manifest, manifestSha256 };
  } catch (error) {
    const code = error instanceof MigrationSnapshotError ? error.code : 'SNAPSHOT_FAILED';
    await fs.unlink(path.join(destination, COMPLETE_MARKER)).catch(() => {});
    await fs.writeFile(incompletePath, `${JSON.stringify({ schemaVersion: 1, status: 'incomplete', code }, null, 2)}\n`).catch(() => {});
    if (error instanceof MigrationSnapshotError) throw error;
    throw new MigrationSnapshotError(code, 'Migration snapshot failed');
  }
}

module.exports = { createMigrationSnapshot, verifyMigrationSnapshot, MigrationSnapshotError, INCOMPLETE_MARKER, COMPLETE_MARKER, MANIFEST_FILE };
