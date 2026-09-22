'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { classify } = require('./source-inventory.cjs');
const { verifyMigrationSnapshot } = require('./migration-snapshot.cjs');
const { DEFAULT_MAX_PAYLOAD_BYTES } = require('./postgres-state.cjs');
const { acquireMutationFence } = require('./postgres-write-fence.cjs');

class DocumentImportError extends Error {
  constructor(code, message) { super(message); this.name = 'DocumentImportError'; this.code = code; }
}
const fail = (code, message) => { throw new DocumentImportError(code, message); };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest();
const first = result => result.rows?.[0];
function sourceKey(relativePath) {
  classify(relativePath); // Reject ambiguous paths before computing their stable identity.
  return 'file/' + hash(Buffer.from(relativePath, 'utf8')).toString('hex');
}
function mediaType(relativePath) {
  return ({ '.json': 'application/json', '.jsonl': 'application/x-ndjson', '.dpapi': 'application/vnd.pult.dpapi',
    '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' })[path.extname(relativePath).toLowerCase()] || 'application/octet-stream';
}
function selectDocuments(manifest) {
  if (manifest?.writersStopped !== true) fail('INVALID_SNAPSHOT', 'A coordinated stopped-writer checkpoint is required');
  const selected = [], delegated = [];
  for (const file of manifest.files) {
    const type = classify(file.path);
    if (type.kind !== 'runtime' || type.domain !== file.domain)
      fail('CLASSIFICATION_CHANGED', 'Snapshot classification requires review');
    if (type.domain === 'history' || type.domain === 'archive-content') { delegated.push(file); continue; }
    if (BigInt(file.bytes) > BigInt(DEFAULT_MAX_PAYLOAD_BYTES)) fail('PAYLOAD_TOO_LARGE', 'A document exceeds the reviewed import limit');
    selected.push({ ...file, logicalKey: sourceKey(file.path), mediaType: mediaType(file.path) });
  }
  return { selected, delegated };
}

async function readVerifiedFile(root, item) {
  let current = root;
  for (const part of item.path.split('/')) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) fail('SOURCE_CHANGED', 'A checkpoint path became a link');
  }
  const handle = await fs.open(current, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || BigInt(stat.size) !== BigInt(item.bytes)) fail('SOURCE_CHANGED', 'Checkpoint content changed');
    const content = await handle.readFile();
    if (hash(content).toString('hex') !== item.sha256) fail('SOURCE_CHANGED', 'Checkpoint content changed');
    return content;
  } finally { await handle.close(); }
}

function sameBaseline(row, item, content) {
  return row && row.source_path === item.path && row.logical_key === item.logicalKey && row.domain === item.domain &&
    row.source_media_type === item.mediaType && row.media_type === item.mediaType &&
    String(row.source_bytes) === item.bytes && String(row.revision) === '1' && row.deleted === false &&
    Buffer.isBuffer(row.source_sha256) && row.source_sha256.toString('hex') === item.sha256 &&
    Buffer.isBuffer(row.sha256) && row.sha256.toString('hex') === item.sha256 &&
    Buffer.isBuffer(row.content) && row.content.equals(content);
}

async function importDocuments({ pool, sourceDir, schema = 'pult', onProgress = () => {} } = {}) {
  if (!pool?.connect || typeof sourceDir !== 'string' || !path.isAbsolute(sourceDir) ||
      !/^[a-z][a-z0-9_]{0,62}$/u.test(schema) || typeof onProgress !== 'function')
    fail('INVALID_ARGUMENT', 'Invalid document import configuration');
  const namespace = '"' + schema + '"';
  let root, manifest, selected, delegated;
  try {
    root = await fs.realpath(sourceDir);
    if (path.basename(root).toLowerCase() === '.private') fail('INVALID_SNAPSHOT', 'Live private storage is not an import source');
    manifest = await verifyMigrationSnapshot(sourceDir);
    ({ selected, delegated } = selectDocuments(manifest));
  } catch (error) {
    if (error instanceof DocumentImportError) throw error;
    fail('INVALID_SNAPSHOT', 'Checkpoint verification failed');
  }
  const select = `SELECT f.source_path,f.logical_key,f.domain,f.media_type AS source_media_type,
    f.source_bytes::text,f.source_sha256,d.media_type,d.content,d.sha256,d.revision::text,d.deleted
    FROM ${namespace}.source_files f JOIN ${namespace}.document_states d USING(logical_key)
    WHERE f.source_path=$1`;
  let inserted = 0, reused = 0, bytes = 0n;
  for (const item of selected) {
    let client, begun = false, committing = false;
    try {
      const content = await readVerifiedFile(root, item);
      client = await pool.connect();
      await client.query('BEGIN'); begun = true;
      await acquireMutationFence(client);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [schema + ':document-import:' + item.path]);
      const existing = first(await client.query(select + ' FOR UPDATE OF f,d', [item.path]));
      if (existing) {
        if (!sameBaseline(existing, item, content)) fail('BASELINE_CONFLICT', 'Existing document differs from the checkpoint or has runtime changes');
      } else {
        const collision = await client.query(`SELECT logical_key FROM ${namespace}.document_states WHERE logical_key=$1 FOR UPDATE`, [item.logicalKey]);
        if (collision.rows.length) fail('BASELINE_CONFLICT', 'Existing document has no matching checkpoint provenance');
        await client.query(`INSERT INTO ${namespace}.document_states(logical_key,media_type,content,sha256,revision,deleted)
          VALUES($1,$2,$3,$4,1,false)`, [item.logicalKey, item.mediaType, content, hash(content)]);
        await client.query(`INSERT INTO ${namespace}.source_files(source_path,logical_key,domain,media_type,source_bytes,source_sha256)
          VALUES($1,$2,$3,$4,$5,$6)`, [item.path, item.logicalKey, item.domain, item.mediaType, item.bytes, hash(content)]);
      }
      committing = true; await client.query('COMMIT'); begun = false;
      if (existing) reused++; else inserted++;
      bytes += BigInt(item.bytes);
      onProgress({ completed: inserted + reused, total: selected.length });
    } catch (error) {
      if (begun && client) await client.query('ROLLBACK').catch(() => {});
      if (error instanceof DocumentImportError) throw error;
      fail(committing ? 'OUTCOME_UNKNOWN' : 'DOCUMENT_IMPORT_FAILED', committing
        ? 'Commit outcome is unknown; retry the same verified checkpoint'
        : 'Document import failed; no completed migration is declared');
    } finally { client?.release(); }
  }
  // Re-read SQL payloads and reverify the entire checkpoint before reporting success.
  // Completed individual rows are restartable; this is not an atomic application cutover.
  let client;
  try {
    await verifyMigrationSnapshot(sourceDir);
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const catalog = await client.query(`SELECT source_path FROM ${namespace}.source_files ORDER BY source_path COLLATE "C"`);
    const expected = new Set(selected.map(item => item.path));
    if (catalog.rows.length !== expected.size || catalog.rows.some(row => !expected.has(row.source_path)))
      fail('BASELINE_CONFLICT', 'SQL provenance contains missing or unexpected checkpoint files');
    for (const item of selected) {
      const content = await readVerifiedFile(root, item);
      if (!sameBaseline(first(await client.query(select, [item.path])), item, content))
        fail('BASELINE_CONFLICT', 'SQL checkpoint content verification failed');
    }
    await client.query('COMMIT');
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    if (error instanceof DocumentImportError) throw error;
    fail('DOCUMENT_VERIFY_FAILED', 'Checkpoint or SQL verification failed');
  } finally { client?.release(); }
  return { inserted, reused, verified: selected.length, bytes: bytes.toString(), delegatedHistoryFiles: delegated.length, cutoverReady: false };
}

module.exports = { importDocuments, sourceKey, selectDocuments, DocumentImportError };
