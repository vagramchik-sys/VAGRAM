'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyMigrationSnapshot } = require('./migration-snapshot.cjs');
const { selectDocuments } = require('./postgres-document-import.cjs');
const { verifyDocumentJournal } = require('./postgres-document-journal.cjs');

const INCOMPLETE_MARKER = 'REPLAY_INCOMPLETE.json';
const COMPLETE_MARKER = 'REPLAY_COMPLETE.json';
const MANIFEST_FILE = 'replay-manifest.json';
const TREE_DIRECTORY = 'tree';
const DECIMAL = /^(0|[1-9]\d*)$/u;
const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

class PostgresDocumentReplayError extends Error {
  constructor(code, message) { super(message); this.name = 'PostgresDocumentReplayError'; this.code = code; }
}
const fail = (code, message) => { throw new PostgresDocumentReplayError(code, message); };
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function pathParts(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') || value.includes(':'))
    fail('INVALID_PATH', 'Replay path is not portable');
  const parts = value.split('/');
  for (const part of parts) {
    const folded = part.normalize('NFC').toLowerCase(), device = folded.split('.')[0];
    if (!part || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' ') || folded === '.private' ||
        ['con', 'prn', 'aux', 'nul'].includes(device) || /^(?:com|lpt)[1-9]$/u.test(device))
      fail('INVALID_PATH', 'Replay path is unsafe on Windows');
  }
  return parts;
}

function hasPrivateComponent(value) {
  return path.resolve(value).split(/[\\/]+/u).some(part => part.normalize('NFC').replace(/[. ]+$/u, '').toLowerCase() === '.private');
}

async function noLinkedComponents(value) {
  const absolute = path.resolve(value), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch(() => null);
    if (!stat || stat.isSymbolicLink()) fail('INVALID_DIRECTORY', 'Replay directory path contains a missing or linked component');
  }
}

async function realDirectory(value, field, empty = false) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || hasPrivateComponent(value))
    fail('INVALID_DIRECTORY', `${field} must be an absolute non-private directory`);
  await noLinkedComponents(value);
  const stat = await fs.lstat(value).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail('INVALID_DIRECTORY', `${field} must be a real directory`);
  const root = await fs.realpath(value);
  if (empty && (await fs.readdir(root)).length) fail('DESTINATION_NOT_EMPTY', 'Replay destination must be empty');
  return root;
}

function overlaps(left, right) {
  const relative = path.relative(left, right);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function safeFile(root, relative) {
  const filename = path.join(root, ...pathParts(relative));
  const stat = await fs.lstat(filename).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) fail('INVALID_PATH', 'Replay input file is missing or unsafe');
  const resolved = await fs.realpath(filename), within = path.relative(root, resolved);
  if (within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) fail('INVALID_PATH', 'Replay input resolves outside its root');
  return filename;
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

async function syncFile(filename) {
  const handle = await fs.open(filename, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeJson(filename, value, flag = 'wx') {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  const handle = await fs.open(filename, flag);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  return bytes;
}

async function copyVerified(sourceRoot, treeRoot, item) {
  const source = await safeFile(sourceRoot, item.path), target = path.join(treeRoot, ...pathParts(item.path));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target, fsSync.constants.COPYFILE_EXCL);
  await syncFile(target);
  const actual = await digestFile(target);
  if (actual.bytes !== item.bytes || actual.sha256 !== item.sha256) fail('SOURCE_CHANGED', 'Snapshot file changed while staging replay');
}

function baselineCatalog(snapshotManifest) {
  const { selected } = selectDocuments(snapshotManifest);
  return selected.map(item => ({ sourcePath: item.path, logicalKey: item.logicalKey, domain: item.domain,
    mediaType: item.mediaType, baselinePresent: true, bytes: item.bytes, sha256: item.sha256 })).sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
}

function validateAbsentMapping(item, snapshotPaths) {
  if (snapshotPaths.has(item.sourcePath)) fail('BASELINE_MISMATCH', 'Runtime-created document path already exists in the migration snapshot');
  let selected;
  try {
    selected = selectDocuments({ writersStopped: true, files: [{ path: item.sourcePath, domain: item.domain, bytes: '0' }] }).selected;
  } catch { fail('UNSUPPORTED_DOMAIN', 'Runtime-created document path is not an allowed document domain'); }
  const identity = selected[0];
  if (selected.length !== 1 || identity.logicalKey !== item.logicalKey || identity.mediaType !== item.mediaType)
    fail('UNSUPPORTED_DOMAIN', 'Runtime-created document mapping is not a canonical document identity');
}

async function precondition(treeRoot, command) {
  const filename = path.join(treeRoot, ...pathParts(command.sourcePath));
  const stat = await fs.lstat(filename).catch(() => null);
  if (command.before.deleted !== false) {
    if (stat) fail('PRECONDITION_FAILED', 'Replay expected a deleted or absent document');
    return filename;
  }
  if (!stat?.isFile() || stat.isSymbolicLink()) fail('PRECONDITION_FAILED', 'Replay expected an existing regular document');
  const actual = await digestFile(filename);
  if (actual.bytes !== command.before.blob.bytes || actual.sha256 !== command.before.blob.sha256)
    fail('PRECONDITION_FAILED', 'Replay before-state does not match the staged document');
  return filename;
}

async function applyCommand(treeRoot, journalRoot, command, temporaryNumber) {
  const filename = await precondition(treeRoot, command);
  if (command.after.deleted) {
    await fs.unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return;
  }
  const source = await safeFile(journalRoot, command.after.blob.path);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.replay-${temporaryNumber}.tmp`;
  await fs.copyFile(source, temporary, fsSync.constants.COPYFILE_EXCL);
  await syncFile(temporary);
  const actual = await digestFile(temporary);
  if (actual.bytes !== command.after.blob.bytes || actual.sha256 !== command.after.blob.sha256)
    fail('JOURNAL_CHANGED', 'Journal blob changed while replay was staged');
  await fs.rename(temporary, filename);
}

async function boundManifest(root, name, verified) {
  const bytes = await fs.readFile(await safeFile(root, name));
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { fail('SOURCE_CHANGED', 'Verified input manifest became invalid'); }
  if (!same(parsed, verified)) fail('SOURCE_CHANGED', 'Verified input manifest changed');
  return { sha256: digest(bytes), bytes };
}

async function treeInventory(root) {
  const files = [];
  const aliases = new Set();
  async function walk(folder, prefix = '') {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      pathParts(relative);
      const folded = relative.normalize('NFC').toLowerCase();
      if (aliases.has(folded)) fail('INVALID_PATH', 'Replay tree contains Windows-aliased paths');
      aliases.add(folded);
      const filename = path.join(folder, entry.name), stat = await fs.lstat(filename);
      if (stat.isSymbolicLink()) fail('INVALID_PATH', 'Replay tree contains a link');
      if (stat.isDirectory()) await walk(filename, relative);
      else if (stat.isFile()) files.push({ path: relative, ...await digestFile(filename) });
      else fail('INVALID_PATH', 'Replay tree contains an unsupported file type');
    }
  }
  await walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function replayDocumentJournal({ snapshotDir, journalDir, destinationDir } = {}) {
  const snapshotRoot = await realDirectory(snapshotDir, 'snapshotDir');
  const journalRoot = await realDirectory(journalDir, 'journalDir');
  const destination = await realDirectory(destinationDir, 'destinationDir', true);
  if (overlaps(snapshotRoot, journalRoot) || overlaps(journalRoot, snapshotRoot) || overlaps(snapshotRoot, destination) ||
      overlaps(destination, snapshotRoot) || overlaps(journalRoot, destination) || overlaps(destination, journalRoot))
    fail('DIRECTORY_OVERLAP', 'Replay input and output directories must be separate');
  const incomplete = path.join(destination, INCOMPLETE_MARKER);
  await writeJson(incomplete, { schemaVersion: 1, status: 'incomplete', startedAt: new Date().toISOString() });
  const treeRoot = path.join(destination, TREE_DIRECTORY);
  await fs.mkdir(treeRoot);
  try {
    const snapshot = await verifyMigrationSnapshot(snapshotRoot);
    const journal = await verifyDocumentJournal(journalRoot);
    const snapshotBinding = await boundManifest(snapshotRoot, 'snapshot-manifest.json', snapshot);
    const journalBinding = await boundManifest(journalRoot, 'journal-manifest.json', journal);
    if (journal.baselineSequence !== '0') fail('BASELINE_UNSUPPORTED', 'File replay currently requires journal baseline sequence zero');
    const expectedBaseline = baselineCatalog(snapshot);
    const journalBaseline = [...journal.baselineDocuments].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
    const presentBaseline = journalBaseline.filter(item => item.baselinePresent);
    if (!same(expectedBaseline, presentBaseline)) fail('BASELINE_MISMATCH', 'Migration snapshot does not match the journal baseline catalog');
    const snapshotPaths = new Set(snapshot.files.map(item => item.path));
    for (const item of journalBaseline.filter(item => !item.baselinePresent)) {
      validateAbsentMapping(item, snapshotPaths);
      const first = journal.commands.find(command => command.logicalKey === item.logicalKey);
      if (!first || first.operation !== 'write' || first.beforeRevision !== '0' || first.before.deleted !== null || first.before.blob !== null)
        fail('BASELINE_MISMATCH', 'Runtime-created document does not begin with an absent-state write');
    }
    const allowed = new Map(journalBaseline.map(item => [item.sourcePath, item]));
    const aliases = new Set();
    for (const item of snapshot.files) {
      pathParts(item.path);
      const folded = item.path.normalize('NFC').toLowerCase();
      if (aliases.has(folded)) fail('INVALID_PATH', 'Migration snapshot contains Windows-aliased paths');
      aliases.add(folded);
      await copyVerified(snapshotRoot, treeRoot, item);
    }
    let applied = 0;
    const expectedFinal = new Map(snapshot.files.map(item => [item.path, { path: item.path, bytes: item.bytes, sha256: item.sha256 }]));
    for (const command of journal.commands) {
      const mapped = allowed.get(command.sourcePath);
      if (!mapped || mapped.logicalKey !== command.logicalKey) fail('UNSUPPORTED_DOMAIN', 'Journal command is outside the bound document baseline');
      await applyCommand(treeRoot, journalRoot, command, ++applied);
      if (command.after.deleted) expectedFinal.delete(command.sourcePath);
      else expectedFinal.set(command.sourcePath, { path: command.sourcePath, bytes: command.after.blob.bytes, sha256: command.after.blob.sha256 });
    }
    const files = await treeInventory(treeRoot);
    const expectedFiles = [...expectedFinal.values()].sort((a, b) => a.path.localeCompare(b.path));
    if (!same(files, expectedFiles)) fail('FINAL_STATE_MISMATCH', 'Staged replay tree differs from command after-states');
    const finalSnapshot = await verifyMigrationSnapshot(snapshotRoot), finalJournal = await verifyDocumentJournal(journalRoot);
    const finalSnapshotBinding = await boundManifest(snapshotRoot, 'snapshot-manifest.json', finalSnapshot);
    const finalJournalBinding = await boundManifest(journalRoot, 'journal-manifest.json', finalJournal);
    if (!same(finalSnapshot, snapshot) || !same(finalJournal, journal) ||
        finalSnapshotBinding.sha256 !== snapshotBinding.sha256 || finalJournalBinding.sha256 !== journalBinding.sha256)
      fail('SOURCE_CHANGED', 'Replay input changed while the stage was being built');
    const manifest = {
      schemaVersion: 1, status: 'complete', scope: 'documents-only', createdAt: new Date().toISOString(),
      baselineSequence: '0', upperSequence: journal.upperSequence,
      snapshotManifestSha256: snapshotBinding.sha256, journalManifestSha256: journalBinding.sha256,
      appliedCommands: journal.commands.map(command => ({ sequence: command.sequence, commandId: command.commandId })),
      files, tree: TREE_DIRECTORY, rollbackReady: false
    };
    const manifestBytes = await writeJson(path.join(destination, MANIFEST_FILE), manifest);
    await fs.unlink(incomplete);
    await writeJson(path.join(destination, COMPLETE_MARKER), {
      schemaVersion: 1, manifest: MANIFEST_FILE, manifestSha256: digest(manifestBytes)
    });
    await verifyDocumentReplay(destination);
    return manifest;
  } catch (error) {
    await fs.unlink(path.join(destination, COMPLETE_MARKER)).catch(() => {});
    await fs.writeFile(incomplete, `${JSON.stringify({ schemaVersion: 1, status: 'incomplete', code: error?.code || 'REPLAY_FAILED' }, null, 2)}\n`).catch(() => {});
    if (error instanceof PostgresDocumentReplayError) throw error;
    fail(error?.code === 'UNSUPPORTED_DOMAIN' ? 'UNSUPPORTED_DOMAIN' : 'REPLAY_FAILED', 'Document journal replay failed');
  }
}

async function verifyDocumentReplay(directory) {
  const root = await realDirectory(directory, 'directory');
  if (await fs.access(path.join(root, INCOMPLETE_MARKER)).then(() => true, () => false))
    fail('REPLAY_INCOMPLETE', 'Document replay stage is incomplete');
  let marker, manifest, manifestBytes;
  try {
    marker = JSON.parse(await fs.readFile(await safeFile(root, COMPLETE_MARKER), 'utf8'));
    manifestBytes = await fs.readFile(await safeFile(root, MANIFEST_FILE));
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch (error) {
    if (error instanceof PostgresDocumentReplayError) throw error;
    fail('REPLAY_INVALID', 'Document replay marker or manifest is invalid');
  }
  if (marker?.schemaVersion !== 1 || marker.manifest !== MANIFEST_FILE || marker.manifestSha256 !== digest(manifestBytes) ||
      manifest?.schemaVersion !== 1 || manifest.status !== 'complete' || manifest.scope !== 'documents-only' ||
      manifest.rollbackReady !== false || manifest.baselineSequence !== '0' || !DECIMAL.test(manifest.upperSequence) ||
      !HASH.test(manifest.snapshotManifestSha256) || !HASH.test(manifest.journalManifestSha256) ||
      manifest.tree !== TREE_DIRECTORY || !Array.isArray(manifest.files) || !Array.isArray(manifest.appliedCommands))
    fail('REPLAY_INVALID', 'Document replay manifest integrity check failed');
  const ids = new Set();
  let previousSequence = 0n;
  for (const command of manifest.appliedCommands) {
    if (!command || !DECIMAL.test(command.sequence) || BigInt(command.sequence) <= previousSequence ||
        BigInt(command.sequence) > BigInt(manifest.upperSequence) || !UUID.test(command.commandId) || ids.has(command.commandId.toLowerCase()))
      fail('REPLAY_INVALID', 'Document replay applied command list is invalid');
    previousSequence = BigInt(command.sequence);
    ids.add(command.commandId.toLowerCase());
  }
  const tree = path.join(root, TREE_DIRECTORY), stat = await fs.lstat(tree).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink() || await fs.realpath(tree) !== tree) fail('REPLAY_INVALID', 'Document replay tree is unsafe');
  const actual = await treeInventory(tree);
  if (!same(actual, manifest.files)) fail('REPLAY_INVALID', 'Document replay tree does not match its manifest');
  const rootEntries = (await fs.readdir(root)).sort();
  if (!same(rootEntries, [COMPLETE_MARKER, MANIFEST_FILE, TREE_DIRECTORY].sort())) fail('REPLAY_INVALID', 'Document replay contains unexpected root entries');
  return manifest;
}

module.exports = {
  replayDocumentJournal, verifyDocumentReplay, PostgresDocumentReplayError,
  INCOMPLETE_MARKER, COMPLETE_MARKER, MANIFEST_FILE, TREE_DIRECTORY
};
