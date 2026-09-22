'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { withWriteFence } = require('./postgres-write-fence.cjs');

const INCOMPLETE_MARKER = 'JOURNAL_INCOMPLETE.json';
const COMPLETE_MARKER = 'JOURNAL_COMPLETE.json';
const MANIFEST_FILE = 'journal-manifest.json';
const BLOBS_DIRECTORY = 'blobs';
const DECIMAL = /^(0|[1-9]\d*)$/u;
const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

class PostgresDocumentJournalError extends Error {
  constructor(code, message) { super(message); this.name = 'PostgresDocumentJournalError'; this.code = code; }
}
const fail = (code, message) => { throw new PostgresDocumentJournalError(code, message); };
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function sequence(value, field) {
  const result = typeof value === 'bigint' ? value.toString() : value;
  if (typeof result !== 'string' || !DECIMAL.test(result) || BigInt(result) > 9223372036854775807n)
    fail('INVALID_ARGUMENT', `${field} must be a non-negative decimal bigint`);
  return result;
}

function portablePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') || value.includes(':') ||
      value.split('/').some(part => !part || part === '.' || part === '..'))
    fail('UNSUPPORTED_DOMAIN', 'Document command has no portable source path');
  for (const part of value.split('/')) {
    const folded = part.normalize('NFC').toLowerCase();
    const device = folded.split('.')[0];
    if (part.endsWith('.') || part.endsWith(' ') || ['con', 'prn', 'aux', 'nul'].includes(device) ||
        /^(?:com|lpt)[1-9]$/u.test(device)) fail('UNSUPPORTED_DOMAIN', 'Document command path is unsafe on Windows');
  }
  return value;
}

function baselineRow(row, seenPaths, seenKeys) {
  const sourcePath = portablePath(row.source_path);
  const folded = sourcePath.normalize('NFC').toLowerCase();
  if (typeof row.logical_key !== 'string' || !row.logical_key || typeof row.domain !== 'string' || !row.domain ||
      !validateMedia(row.media_type) || typeof row.baseline_present !== 'boolean' || !DECIMAL.test(String(row.source_bytes)) ||
      !Buffer.isBuffer(row.source_sha256) || row.source_sha256.length !== 32)
    fail('UNSUPPORTED_DOMAIN', 'Document baseline provenance is invalid');
  const sha256 = row.source_sha256.toString('hex'), bytes = String(row.source_bytes);
  if (!row.baseline_present && (bytes !== '0' || sha256 !== digest(Buffer.alloc(0))))
    fail('UNSUPPORTED_DOMAIN', 'Runtime-created document has invalid absent-baseline provenance');
  if (seenPaths.has(folded) || seenKeys.has(row.logical_key)) fail('UNSUPPORTED_DOMAIN', 'Document baseline contains a duplicate path or logical key');
  seenPaths.add(folded); seenKeys.add(row.logical_key);
  return { sourcePath, logicalKey: row.logical_key, domain: row.domain, mediaType: row.media_type,
    baselinePresent: row.baseline_present, bytes, sha256 };
}

async function realDirectory(value, field, empty = false) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail('INVALID_ARGUMENT', `${field} must be an absolute directory`);
  const stat = await fs.lstat(value).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail('INVALID_ARGUMENT', `${field} must be a real directory`);
  const root = await fs.realpath(value);
  if (empty && (await fs.readdir(root)).length) fail('DESTINATION_NOT_EMPTY', 'Journal destination must be empty');
  return root;
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

async function writeJson(filename, value, flag = 'wx') {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  const handle = await fs.open(filename, flag);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  return bytes;
}

async function safeFile(root, relative) {
  if (typeof relative !== 'string' || relative.includes('\\') || relative.startsWith('/') || relative.includes(':') ||
      relative.split('/').some(part => !part || part === '.' || part === '..'))
    fail('JOURNAL_INVALID', 'Journal contains an invalid path');
  const filename = path.join(root, ...relative.split('/'));
  const stat = await fs.lstat(filename).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) fail('JOURNAL_INVALID', 'Journal contains an unsafe or missing file');
  const resolved = await fs.realpath(filename);
  const within = path.relative(root, resolved);
  if (within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) fail('JOURNAL_INVALID', 'Journal file resolves outside its directory');
  return filename;
}

async function safeBlobsDirectory(root) {
  const directory = path.join(root, BLOBS_DIRECTORY);
  const stat = await fs.lstat(directory).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory)
    fail('JOURNAL_INVALID', 'Journal blobs directory is unsafe or missing');
  return directory;
}

function blobShape(content, recordedHash, deleted, revision, label) {
  if (typeof deleted !== 'boolean' && deleted !== null) fail('JOURNAL_INVALID', `Invalid ${label} deletion marker`);
  if (deleted === true) {
    if (content != null || recordedHash != null) fail('JOURNAL_INVALID', `Deleted ${label} state contains bytes`);
    return null;
  }
  if (deleted === null) {
    if (revision !== '0' || content != null || recordedHash != null) fail('JOURNAL_INVALID', `Missing ${label} state is inconsistent`);
    return null;
  }
  if (!Buffer.isBuffer(content) || !Buffer.isBuffer(recordedHash) || recordedHash.length !== 32)
    fail('JOURNAL_INVALID', `${label} state is missing bytes or SHA-256`);
  const actual = digest(content), expected = recordedHash.toString('hex');
  if (actual !== expected) fail('JOURNAL_INVALID', `${label} state bytes do not match SHA-256`);
  return { sha256: actual, bytes: String(content.length), path: `${BLOBS_DIRECTORY}/${actual}.bin` };
}

async function writeBlob(root, blob, content, known) {
  if (!blob || known.has(blob.sha256)) return;
  const filename = path.join(root, ...blob.path.split('/'));
  const handle = await fs.open(filename, 'wx');
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  known.set(blob.sha256, blob);
}

function validateMedia(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 255;
}

function validateCommandChain(commands, baseline, upper) {
  const ids = new Set(), previous = new Map();
  let lastSequence = BigInt(baseline);
  for (const command of commands) {
    if (!command || !DECIMAL.test(command.sequence) || BigInt(command.sequence) <= lastSequence || BigInt(command.sequence) > BigInt(upper))
      fail('JOURNAL_INVALID', 'Journal command sequence is invalid');
    lastSequence = BigInt(command.sequence);
    if (!UUID.test(command.commandId) || ids.has(command.commandId.toLowerCase())) fail('JOURNAL_INVALID', 'Journal command UUID is invalid or duplicated');
    ids.add(command.commandId.toLowerCase());
    if (!['write', 'delete'].includes(command.operation) || typeof command.logicalKey !== 'string' || !command.logicalKey)
      fail('JOURNAL_INVALID', 'Journal command identity is invalid');
    portablePath(command.sourcePath);
    if (!DECIMAL.test(command.beforeRevision) || !DECIMAL.test(command.afterRevision) ||
        BigInt(command.afterRevision) !== BigInt(command.beforeRevision) + 1n)
      fail('JOURNAL_INVALID', 'Journal command revision step is invalid');
    if (!validateMedia(command.beforeMediaType) || !validateMedia(command.afterMediaType))
      fail('JOURNAL_INVALID', 'Journal command media type is invalid');
    if (command.operation === 'write' && command.after?.deleted !== false || command.operation === 'delete' && command.after?.deleted !== true)
      fail('JOURNAL_INVALID', 'Journal command operation and after state disagree');
    const earlier = previous.get(command.logicalKey);
    if (earlier && (earlier.afterRevision !== command.beforeRevision || earlier.afterMediaType !== command.beforeMediaType ||
        earlier.sourcePath !== command.sourcePath || !same(earlier.after, command.before)))
      fail('JOURNAL_INVALID', 'Journal revision chain is discontinuous');
    previous.set(command.logicalKey, command);
  }
}

async function exportDocumentJournal({ pool, checkpointSequence, destinationDir } = {}) {
  if (!pool?.connect || !pool?.query) fail('INVALID_ARGUMENT', 'pool is required');
  const baseline = sequence(checkpointSequence, 'checkpointSequence');
  const destination = await realDirectory(destinationDir, 'destinationDir', true);
  const incomplete = path.join(destination, INCOMPLETE_MARKER);
  await writeJson(incomplete, { schemaVersion: 1, status: 'incomplete', startedAt: new Date().toISOString() });
  await fs.mkdir(path.join(destination, BLOBS_DIRECTORY));
  try {
    let upper = baseline, commands = [], baselineDocuments = [];
    const blobs = new Map();
    await withWriteFence({ pool, timeoutMs: 30000 }, async client => {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        upper = String((await client.query('SELECT COALESCE(max(sequence),0)::text AS sequence FROM pult.commands')).rows[0].sequence);
        if (!DECIMAL.test(upper) || BigInt(baseline) > BigInt(upper)) fail('INVALID_ARGUMENT', 'checkpointSequence exceeds the committed upper sequence');
        const baselineRows = await client.query(`SELECT source_path,logical_key,domain,media_type,baseline_present,source_bytes::text,source_sha256
          FROM pult.source_files ORDER BY source_path COLLATE "C"`);
        const seenPaths = new Set(), seenKeys = new Set();
        baselineDocuments = baselineRows.rows.map(row => baselineRow(row, seenPaths, seenKeys));
        await client.query(`DECLARE pult_document_journal NO SCROLL CURSOR FOR
          SELECT c.sequence::text,c.command_id::text,c.operation,c.logical_key,s.source_path,
            c.before_revision::text,c.after_revision::text,c.before_content,c.before_sha256,c.before_deleted,
            c.after_content,c.after_sha256,c.after_deleted,c.media_type AS after_media_type,
            COALESCE(c.before_media_type,(SELECT p.media_type FROM pult.commands p WHERE p.logical_key=c.logical_key AND p.sequence<c.sequence ORDER BY p.sequence DESC LIMIT 1),s.media_type) AS before_media_type
          FROM pult.commands c LEFT JOIN pult.source_files s ON s.logical_key=c.logical_key
          WHERE c.sequence>$1::bigint AND c.sequence<=$2::bigint ORDER BY c.sequence`, [baseline, upper]);
        try {
          for (;;) {
            const page = await client.query('FETCH FORWARD 32 FROM pult_document_journal');
            if (!page.rows.length) break;
            for (const row of page.rows) {
              if (row.source_path == null) fail('UNSUPPORTED_DOMAIN', 'Document journal contains a command without source provenance');
              const beforeRevision = String(row.before_revision), afterRevision = String(row.after_revision);
              const before = blobShape(row.before_content, row.before_sha256, row.before_deleted, beforeRevision, 'before');
              const after = blobShape(row.after_content, row.after_sha256, row.after_deleted, afterRevision, 'after');
              await writeBlob(destination, before, row.before_content, blobs);
              await writeBlob(destination, after, row.after_content, blobs);
              commands.push({
                sequence: String(row.sequence), commandId: String(row.command_id).toLowerCase(), operation: row.operation,
                logicalKey: row.logical_key, sourcePath: portablePath(row.source_path),
                beforeRevision, afterRevision, beforeMediaType: row.before_media_type, afterMediaType: row.after_media_type,
                before: { deleted: row.before_deleted, blob: before }, after: { deleted: row.after_deleted, blob: after }
              });
            }
          }
        } finally { await client.query('CLOSE pult_document_journal').catch(() => {}); }
        validateCommandChain(commands, baseline, upper);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    });
    const manifest = {
      schemaVersion: 1, status: 'complete', createdAt: new Date().toISOString(), scope: 'documents-only',
      baselineSequence: baseline, upperSequence: upper, baselineDocuments, commands,
      blobs: [...blobs.values()].sort((left, right) => left.sha256.localeCompare(right.sha256)), rollbackReady: false
    };
    const manifestBytes = await writeJson(path.join(destination, MANIFEST_FILE), manifest);
    await fs.unlink(incomplete);
    await writeJson(path.join(destination, COMPLETE_MARKER), {
      schemaVersion: 1, manifest: MANIFEST_FILE, manifestSha256: digest(manifestBytes)
    });
    await verifyDocumentJournal(destination);
    return manifest;
  } catch (error) {
    await fs.unlink(path.join(destination, COMPLETE_MARKER)).catch(() => {});
    await fs.writeFile(incomplete, `${JSON.stringify({ schemaVersion: 1, status: 'incomplete', code: error?.code || 'EXPORT_FAILED' }, null, 2)}\n`).catch(() => {});
    if (error instanceof PostgresDocumentJournalError) throw error;
    fail('EXPORT_FAILED', 'PostgreSQL document journal export failed');
  }
}

async function verifyDocumentJournal(directory) {
  const root = await realDirectory(directory, 'directory');
  if (await fs.access(path.join(root, INCOMPLETE_MARKER)).then(() => true, () => false))
    fail('JOURNAL_INCOMPLETE', 'Document journal export is incomplete');
  let manifestBytes, marker, manifest;
  try {
    const markerFile = await safeFile(root, COMPLETE_MARKER), manifestFile = await safeFile(root, MANIFEST_FILE);
    marker = JSON.parse(await fs.readFile(markerFile, 'utf8'));
    manifestBytes = await fs.readFile(manifestFile);
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch (error) {
    if (error instanceof PostgresDocumentJournalError) throw error;
    fail('JOURNAL_INVALID', 'Document journal marker or manifest is invalid');
  }
  if (marker?.schemaVersion !== 1 || marker.manifest !== MANIFEST_FILE || marker.manifestSha256 !== digest(manifestBytes) ||
      manifest?.schemaVersion !== 1 || manifest.status !== 'complete' || manifest.scope !== 'documents-only' ||
      manifest.rollbackReady !== false || !DECIMAL.test(manifest.baselineSequence) || !DECIMAL.test(manifest.upperSequence) ||
      BigInt(manifest.baselineSequence) > BigInt(manifest.upperSequence) || !Array.isArray(manifest.baselineDocuments) ||
      !Array.isArray(manifest.commands) || !Array.isArray(manifest.blobs))
    fail('JOURNAL_INVALID', 'Document journal manifest integrity check failed');
  const seenPaths = new Set(), seenKeys = new Set();
  for (const item of manifest.baselineDocuments) {
    if (!item || !HASH.test(item.sha256) || !DECIMAL.test(item.bytes) || typeof item.baselinePresent !== 'boolean' ||
        typeof item.logicalKey !== 'string' || !item.logicalKey ||
        typeof item.domain !== 'string' || !item.domain || !validateMedia(item.mediaType))
      fail('JOURNAL_INVALID', 'Document journal baseline catalog is invalid');
    if (!item.baselinePresent && (item.bytes !== '0' || item.sha256 !== digest(Buffer.alloc(0))))
      fail('JOURNAL_INVALID', 'Document journal absent-baseline provenance is invalid');
    const sourcePath = portablePath(item.sourcePath), folded = sourcePath.normalize('NFC').toLowerCase();
    if (seenPaths.has(folded) || seenKeys.has(item.logicalKey)) fail('JOURNAL_INVALID', 'Document journal baseline catalog is duplicated');
    seenPaths.add(folded); seenKeys.add(item.logicalKey);
  }
  await safeBlobsDirectory(root);
  const declared = new Map();
  for (const blob of manifest.blobs) {
    if (!blob || !HASH.test(blob.sha256) || !DECIMAL.test(blob.bytes) || blob.path !== `${BLOBS_DIRECTORY}/${blob.sha256}.bin` || declared.has(blob.sha256))
      fail('JOURNAL_INVALID', 'Document journal blob metadata is invalid');
    declared.set(blob.sha256, blob);
    const actual = await digestFile(await safeFile(root, blob.path)).catch(() => null);
    if (!actual || actual.sha256 !== blob.sha256 || actual.bytes !== blob.bytes) fail('JOURNAL_INVALID', 'Document journal blob is corrupted');
  }
  for (const command of manifest.commands) {
    for (const state of [command?.before, command?.after]) {
      if (!state || typeof state.deleted !== 'boolean' && state.deleted !== null) fail('JOURNAL_INVALID', 'Document journal state is invalid');
      if (state.blob !== null) {
        const declaredBlob = declared.get(state.blob?.sha256);
        if (!declaredBlob || !same(declaredBlob, state.blob)) fail('JOURNAL_INVALID', 'Document journal command references an unknown blob');
      }
      if (state.deleted === false && state.blob === null || state.deleted !== false && state.blob !== null)
        fail('JOURNAL_INVALID', 'Document journal state and blob disagree');
    }
    if (command.before.deleted === null && command.beforeRevision !== '0' ||
        command.before.deleted !== null && command.beforeRevision === '0' || command.after.deleted === null)
      fail('JOURNAL_INVALID', 'Document journal revision and deletion state disagree');
  }
  validateCommandChain(manifest.commands, manifest.baselineSequence, manifest.upperSequence);
  const mappings = new Map(manifest.baselineDocuments.map(item => [item.logicalKey, item]));
  const firstByKey = new Map();
  for (const command of manifest.commands) {
    const mapping = mappings.get(command.logicalKey);
    if (!mapping || mapping.sourcePath !== command.sourcePath) fail('JOURNAL_INVALID', 'Document command has no matching source mapping');
    if (!firstByKey.has(command.logicalKey)) firstByKey.set(command.logicalKey, command);
  }
  if (manifest.baselineSequence === '0') {
    for (const mapping of manifest.baselineDocuments.filter(item => !item.baselinePresent)) {
      const first = firstByKey.get(mapping.logicalKey);
      if (!first || first.operation !== 'write' || first.beforeRevision !== '0' || first.before.deleted !== null || first.before.blob !== null)
        fail('JOURNAL_INVALID', 'Runtime-created document does not begin with an absent-state write');
    }
  }
  const actualFiles = [];
  async function walk(folder, prefix = '') {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const filename = path.join(folder, entry.name), stat = await fs.lstat(filename);
      if (stat.isSymbolicLink()) fail('JOURNAL_INVALID', 'Document journal contains a link');
      if (stat.isDirectory()) await walk(filename, relative);
      else if (stat.isFile()) actualFiles.push(relative);
      else fail('JOURNAL_INVALID', 'Document journal contains an unsupported file');
    }
  }
  await walk(root);
  const expectedFiles = [COMPLETE_MARKER, MANIFEST_FILE, ...manifest.blobs.map(blob => blob.path)].sort();
  actualFiles.sort();
  if (!same(actualFiles, expectedFiles)) fail('JOURNAL_INVALID', 'Document journal contains missing or unexpected files');
  return manifest;
}

module.exports = {
  exportDocumentJournal, verifyDocumentJournal, PostgresDocumentJournalError,
  INCOMPLETE_MARKER, COMPLETE_MARKER, MANIFEST_FILE, BLOBS_DIRECTORY
};
