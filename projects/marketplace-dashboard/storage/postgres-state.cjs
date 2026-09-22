'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { acquireMutationFence } = require('./postgres-write-fence.cjs');
const { classify } = require('./source-inventory.cjs');

const DEFAULT_MAX_PAYLOAD_BYTES = 320 * 1024 * 1024;

class PostgresStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PostgresStateError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new PostgresStateError(code, message); };
const first = result => Array.isArray(result?.rows) ? result.rows[0] : undefined;
const quoteIdentifier = value => `"${value.replace(/"/g, '""')}"`;
function validateSchema(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/u.test(value))
    fail('INVALID_ARGUMENT', 'schema is invalid');
  return quoteIdentifier(value);
}
function validateKey(value) {
  if (typeof value !== 'string' || value.length > 450 || !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/u.test(value))
    fail('INVALID_ARGUMENT', 'logicalKey must use domain/id segments');
  return value;
}
function validateCommandId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value))
    fail('INVALID_ARGUMENT', 'commandId must be a UUID');
  return value.toLowerCase();
}
function validateMediaType(value) {
  if (typeof value !== 'string' || value.length > 255 || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:;[ -~]+)?$/u.test(value))
    fail('INVALID_ARGUMENT', 'mediaType is invalid');
  return value;
}
function validateRevision(value) {
  const normalized = typeof value === 'bigint' ? value.toString() : value;
  if (typeof normalized !== 'string' || !/^(0|[1-9]\d*)$/u.test(normalized) || BigInt(normalized) > 9223372036854775806n)
    fail('INVALID_ARGUMENT', 'expectedRevision is invalid');
  return normalized;
}
function validateContent(value, maxPayloadBytes) {
  if (!Buffer.isBuffer(value)) fail('INVALID_ARGUMENT', 'content must be a Buffer');
  if (value.length > maxPayloadBytes) fail('PAYLOAD_TOO_LARGE', 'content exceeds the configured limit');
  return Buffer.from(value);
}
function frame(hash, value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(data.length));
  hash.update(length).update(data);
}
function requestHash(operation, key, expectedRevision, mediaType, content) {
  const hash = crypto.createHash('sha256');
  for (const value of [operation, key, expectedRevision, mediaType]) frame(hash, value);
  frame(hash, content || Buffer.alloc(0));
  return hash.digest();
}
const contentHash = content => crypto.createHash('sha256').update(content).digest();
const EMPTY_SHA256 = contentHash(Buffer.alloc(0));
function validateSourceMapping(value, key, mediaType) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.sourcePath !== 'string')
    fail('INVALID_ARGUMENT', 'sourceMapping is invalid');
  let classification;
  try { classification = classify(value.sourcePath); } catch { fail('INVALID_ARGUMENT', 'sourceMapping path is invalid'); }
  const expectedKey = 'file/' + crypto.createHash('sha256').update(Buffer.from(value.sourcePath, 'utf8')).digest('hex');
  const expectedMedia = ({ '.json': 'application/json', '.jsonl': 'application/x-ndjson', '.dpapi': 'application/vnd.pult.dpapi',
    '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' })[path.extname(value.sourcePath).toLowerCase()] || 'application/octet-stream';
  if (classification.kind !== 'runtime' || ['history', 'archive-content'].includes(classification.domain) || value.logicalKey !== key ||
      expectedKey !== key || value.domain !== classification.domain || value.mediaType !== mediaType || expectedMedia !== mediaType)
    fail('INVALID_ARGUMENT', 'sourceMapping does not match the document identity');
  return { sourcePath: value.sourcePath, logicalKey: key, domain: classification.domain, mediaType };
}

function createStateStore({ pool, schema = 'pult', maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function')
    fail('INVALID_ARGUMENT', 'pool must provide query and connect');
  if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes < DEFAULT_MAX_PAYLOAD_BYTES)
    fail('INVALID_ARGUMENT', 'maxPayloadBytes must be at least 320 MiB');
  const namespace = validateSchema(schema);
  const table = name => `${namespace}.${quoteIdentifier(name)}`;

  function wrapDatabaseError(error, duringCommit = false) {
    if (error instanceof PostgresStateError) return error;
    if (error?.code === '40001')
      return new PostgresStateError('SERIALIZATION_RETRY', 'Serialization conflict; retry only with the same commandId and request');
    if (duringCommit)
      return new PostgresStateError('OUTCOME_UNKNOWN', 'Commit outcome is unknown; retry only with the same commandId and request');
    return new PostgresStateError('DATABASE_ERROR', 'PostgreSQL state operation failed');
  }

  async function query(text, values) {
    try { return await pool.query(text, values); }
    catch (error) { throw wrapDatabaseError(error); }
  }

  function project(row, includeContent = true) {
    return {
      logicalKey: row.logical_key,
      mediaType: row.media_type,
      ...(includeContent ? {
        content: row.content == null ? null : Buffer.from(row.content),
        sha256: row.sha256 == null ? null : Buffer.from(row.sha256)
      } : {}),
      revision: String(row.revision),
      deleted: Boolean(row.deleted),
      modifiedAt: row.modified_at
    };
  }

  async function read(logicalKey, { includeDeleted = false } = {}) {
    const key = validateKey(logicalKey);
    const result = await query(
      `SELECT logical_key,media_type,content,sha256,revision::text AS revision,deleted,modified_at
         FROM ${table('document_states')} WHERE logical_key=$1`, [key]
    );
    const row = first(result);
    return !row || (row.deleted && !includeDeleted) ? null : project(row);
  }

  async function list({ prefix = '', includeContent = true } = {}) {
    if (typeof prefix !== 'string' || prefix.length > 450 || (prefix !== '' && !/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/u.test(prefix)))
      fail('INVALID_ARGUMENT', 'prefix is invalid');
    const escaped = prefix.replace(/[\\%_]/gu, match => `\\${match}`);
    const columns = includeContent ? ',content,sha256' : '';
    const result = await query(
      `SELECT logical_key,media_type,revision::text AS revision,deleted,modified_at${columns}
         FROM ${table('document_states')}
        WHERE NOT deleted AND ($1='' OR logical_key LIKE $2 || '%' ESCAPE '\\')
        ORDER BY logical_key COLLATE "C"`, [prefix, escaped]
    );
    return (result.rows || []).map(row => project(row, includeContent));
  }

  async function readCommand(logicalKey, commandId, { operation, sourceMapping } = {}) {
    const key = validateKey(logicalKey), id = validateCommandId(commandId);
    if (!['write', 'delete'].includes(operation)) fail('INVALID_ARGUMENT', 'operation must be write or delete');
    const row = first(await query(
      `SELECT command_id::text AS command_id,operation,logical_key,request_hash,
              before_revision::text AS before_revision,after_revision::text AS after_revision,
              media_type,before_media_type,before_content,before_sha256,before_deleted,
              after_content,after_sha256,after_deleted,committed_at
         FROM ${table('commands')} WHERE command_id=$1`, [id]
    ));
    if (!row) return null;
    if (row.logical_key !== key || row.operation !== operation)
      fail('COMMAND_ID_REUSED', 'commandId was already used for a different key or operation');
    const mapping = validateSourceMapping(sourceMapping, key, String(row.media_type));
    if (mapping) {
      const mappedRows = await query(`SELECT source_path,logical_key,domain,media_type,baseline_present FROM ${table('source_files')} WHERE source_path=$1 OR logical_key=$2`, [mapping.sourcePath, key]);
      const mapped = first(mappedRows);
      if (mappedRows.rows.length !== 1 || mapped.source_path !== mapping.sourcePath || mapped.logical_key !== key || mapped.domain !== mapping.domain || mapped.media_type !== mapping.mediaType)
        fail('SOURCE_MAPPING_MISSING', 'Runtime source mapping is missing or conflicts with the command');
    }
    const record = (revision, mediaType, content, sha256, deleted) => ({
      revision: String(revision),
      mediaType: mediaType == null ? null : String(mediaType),
      content: content == null ? null : Buffer.from(content),
      sha256: sha256 == null ? null : Buffer.from(sha256),
      deleted: deleted == null ? null : Boolean(deleted)
    });
    return {
      commandId: String(row.command_id), operation: row.operation, logicalKey: row.logical_key,
      requestHash: Buffer.from(row.request_hash), committedAt: row.committed_at,
      before: record(row.before_revision, row.before_media_type, row.before_content, row.before_sha256, row.before_deleted),
      after: record(row.after_revision, row.media_type, row.after_content, row.after_sha256, row.after_deleted)
    };
  }

  async function mutate(operation, logicalKey, content, options = {}) {
    const key = validateKey(logicalKey);
    const commandId = validateCommandId(options.commandId);
    const expectedRevision = validateRevision(options.expectedRevision);
    const mediaType = validateMediaType(options.mediaType || 'application/octet-stream');
    const sourceMapping = validateSourceMapping(options.sourceMapping, key, mediaType);
    const body = operation === 'write' ? validateContent(content, maxPayloadBytes) : null;
    const sha256 = body && contentHash(body);
    const fingerprint = requestHash(operation, key, expectedRevision, mediaType, body);
    let client;
    let transactionOpen = false;
    let duringCommit = false;
    let destroyClient = false;
    try {
      client = await pool.connect();
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      transactionOpen = true;
      await acquireMutationFence(client);

      const locks = [`command:${commandId}`, `key:${key}`, ...(sourceMapping ? [`source:${sourceMapping.sourcePath}`] : [])].sort();
      for (const lock of locks)
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lock]);

      const recorded = first(await client.query(
        `SELECT request_hash,after_revision::text AS after_revision
           FROM ${table('commands')} WHERE command_id=$1`, [commandId]
      ));
      if (recorded) {
        if (!Buffer.from(recorded.request_hash).equals(fingerprint))
          fail('COMMAND_ID_REUSED', 'commandId was already used for a different request');
        if (sourceMapping) {
          const mappedRows = await client.query(`SELECT source_path,logical_key,domain,media_type,baseline_present FROM ${table('source_files')} WHERE source_path=$1 OR logical_key=$2 FOR UPDATE`, [sourceMapping.sourcePath, key]);
          const mapped = first(mappedRows);
          if (mappedRows.rows.length !== 1 || mapped.source_path !== sourceMapping.sourcePath || mapped.logical_key !== key || mapped.domain !== sourceMapping.domain || mapped.media_type !== sourceMapping.mediaType)
            fail('SOURCE_MAPPING_MISSING', 'Runtime source mapping is missing or conflicts with the command');
        }
        duringCommit = true;
        await client.query('COMMIT');
        transactionOpen = false;
        return { revision: String(recorded.after_revision), replayed: true };
      }

      const before = first(await client.query(
        `SELECT media_type,content,sha256,revision::text AS revision,deleted
           FROM ${table('document_states')} WHERE logical_key=$1 FOR UPDATE`, [key]
      ));
      const actualRevision = before ? String(before.revision) : '0';
      if (actualRevision !== expectedRevision)
        fail('REVISION_CONFLICT', 'expectedRevision does not match current revision');
      let insertMapping = false;
      if (sourceMapping) {
        const mappedRows = await client.query(`SELECT source_path,logical_key,domain,media_type,baseline_present FROM ${table('source_files')} WHERE source_path=$1 OR logical_key=$2 FOR UPDATE`, [sourceMapping.sourcePath, key]);
        const mapped = first(mappedRows);
        if (mappedRows.rows.length > 1 || mapped && (mapped.source_path !== sourceMapping.sourcePath || mapped.logical_key !== key || mapped.domain !== sourceMapping.domain || mapped.media_type !== sourceMapping.mediaType))
          fail('SOURCE_MAPPING_CONFLICT', 'Runtime source mapping conflicts with existing provenance');
        if (!mapped && actualRevision !== '0') fail('SOURCE_MAPPING_MISSING', 'An existing document has no verified source mapping');
        insertMapping = !mapped;
      }
      const afterRevision = (BigInt(actualRevision) + 1n).toString();

      await client.query(
        `INSERT INTO ${table('document_states')}
           (logical_key,media_type,content,sha256,revision,deleted,modified_at)
         VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp())
         ON CONFLICT (logical_key) DO UPDATE SET
           media_type=EXCLUDED.media_type,content=EXCLUDED.content,sha256=EXCLUDED.sha256,
           revision=EXCLUDED.revision,deleted=EXCLUDED.deleted,modified_at=EXCLUDED.modified_at`,
        [key, mediaType, body, sha256, afterRevision, operation === 'delete']
      );
      if (insertMapping) await client.query(
        `INSERT INTO ${table('source_files')}(source_path,logical_key,domain,media_type,source_bytes,source_sha256,baseline_present)
         VALUES($1,$2,$3,$4,0,$5,false)`,
        [sourceMapping.sourcePath, key, sourceMapping.domain, sourceMapping.mediaType, EMPTY_SHA256]
      );
      await client.query(
        `INSERT INTO ${table('commands')}
           (command_id,operation,logical_key,request_hash,before_revision,after_revision,media_type,before_media_type,
            before_content,before_sha256,before_deleted,after_content,after_sha256,after_deleted)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [commandId, operation, key, fingerprint, actualRevision, afterRevision, mediaType,
          before?.media_type == null ? null : String(before.media_type),
          before?.content == null ? null : Buffer.from(before.content),
          before?.sha256 == null ? null : Buffer.from(before.sha256),
          before ? Boolean(before.deleted) : null, body, sha256, operation === 'delete']
      );
      duringCommit = true;
      await client.query('COMMIT');
      transactionOpen = false;
      return { revision: afterRevision, replayed: false };
    } catch (error) {
      destroyClient = duringCommit;
      if (transactionOpen && client) {
        try { await client.query('ROLLBACK'); } catch { destroyClient = true; }
      }
      throw wrapDatabaseError(error, duringCommit);
    } finally {
      if (client) { try { client.release(destroyClient); } catch {} }
    }
  }

  return Object.freeze({
    read,
    readCommand,
    list,
    write: (key, content, options) => mutate('write', key, content, options),
    remove: (key, options) => mutate('delete', key, null, options)
  });
}

module.exports = { createStateStore, PostgresStateError, DEFAULT_MAX_PAYLOAD_BYTES, requestHash };
