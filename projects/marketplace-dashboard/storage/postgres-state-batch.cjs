'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { acquireMutationFence } = require('./postgres-write-fence.cjs');
const { classify } = require('./source-inventory.cjs');
const { requestHash, PostgresStateError } = require('./postgres-state.cjs');

const MAX_BYTES = 320 * 1024 * 1024;
const EMPTY_SHA256 = crypto.createHash('sha256').update(Buffer.alloc(0)).digest();
const fail = (code, message) => { throw new PostgresStateError(code, message); };
const quote = value => `"${value.replace(/"/g, '""')}"`;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const revision = value => {
  const result = typeof value === 'bigint' ? String(value) : value;
  if (typeof result !== 'string' || !/^(0|[1-9]\d*)$/u.test(result) || BigInt(result) > 9223372036854775806n) fail('INVALID_ARGUMENT', 'expectedRevision is invalid');
  return result;
};
const mediaFor = sourcePath => ({ '.json': 'application/json', '.jsonl': 'application/x-ndjson', '.dpapi': 'application/vnd.pult.dpapi',
  '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' })[path.extname(sourcePath).toLowerCase()] || 'application/octet-stream';
const keyFor = sourcePath => `file/${crypto.createHash('sha256').update(Buffer.from(sourcePath, 'utf8')).digest('hex')}`;

function validateWrite(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !uuid(input.commandId)) fail('INVALID_ARGUMENT', 'Each write needs a command UUID');
  const commandId = input.commandId.toLowerCase(), expectedRevision = revision(input.expectedRevision);
  if (!Buffer.isBuffer(input.content) || input.content.length > MAX_BYTES) fail('INVALID_ARGUMENT', 'Each write needs supported Buffer content');
  const content = Buffer.from(input.content), mapping = input.sourceMapping;
  if (!mapping || typeof mapping.sourcePath !== 'string' || mapping.logicalKey !== input.logicalKey || mapping.mediaType !== input.mediaType)
    fail('INVALID_ARGUMENT', 'Each write needs an exact source mapping');
  let classified;
  try { classified = classify(mapping.sourcePath); } catch { fail('INVALID_ARGUMENT', 'sourcePath is invalid'); }
  if (classified.kind !== 'runtime' || ['history', 'archive-content'].includes(classified.domain) || classified.domain !== mapping.domain ||
      keyFor(mapping.sourcePath) !== input.logicalKey || mediaFor(mapping.sourcePath) !== input.mediaType)
    fail('INVALID_ARGUMENT', 'source mapping does not identify a writable document');
  return Object.freeze({ commandId, expectedRevision, logicalKey: input.logicalKey, mediaType: input.mediaType, content,
    sha256: crypto.createHash('sha256').update(content).digest(), sourcePath: mapping.sourcePath, domain: mapping.domain,
    fingerprint: requestHash('write', input.logicalKey, expectedRevision, input.mediaType, content) });
}

function createStateBatch({ pool, schema = 'pult' } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('A PostgreSQL pool is required');
  if (typeof schema !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/u.test(schema)) throw new TypeError('schema is invalid');
  const table = name => `${quote(schema)}.${quote(name)}`;
  const wrap = (error, duringCommit) => {
    if (error instanceof PostgresStateError) return error;
    if (error?.code === '40001') return new PostgresStateError('SERIALIZATION_RETRY', 'Serialization conflict; retry the identical batch');
    if (duringCommit) return new PostgresStateError('OUTCOME_UNKNOWN', 'Commit outcome is unknown; retry the identical batch');
    return new PostgresStateError('DATABASE_ERROR', 'PostgreSQL batch operation failed');
  };

  function validateIntent(intentSha256) {
    if (typeof intentSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(intentSha256)) fail('INVALID_ARGUMENT', 'intentSha256 is invalid');
    return intentSha256;
  }
  const membersHash = commandIds => crypto.createHash('sha256').update(commandIds.map(x => x.toLowerCase()).sort().join('\n')).digest('hex');
  function validateReceipt(row, batchId, intentSha256, commandIds) {
    const value = row?.result_json;
    if (!value || value.batchId !== batchId.toLowerCase() || value.intentSha256 !== intentSha256 || value.memberCount !== commandIds.length || value.membersSha256 !== membersHash(commandIds) || typeof value.duplicate !== 'boolean')
      fail('COMMAND_ID_REUSED', 'Batch receipt does not match the requested intent');
  }

  async function readReceipt({ batchId, commandIds, intentSha256 } = {}) {
    if (!uuid(batchId) || !Array.isArray(commandIds) || commandIds.length < 2 || commandIds.length > 16 || commandIds.some(x => !uuid(x)) || new Set(commandIds.map(x => x.toLowerCase())).size !== commandIds.length)
      fail('INVALID_ARGUMENT', 'Batch receipt identity is invalid');
    validateIntent(intentSha256);
    let result;
    try { result = await pool.query(`SELECT c.command_id::text,c.logical_key,c.media_type,c.before_revision::text,c.after_revision::text,c.result_json,s.source_path FROM ${table('commands')} c JOIN ${table('source_files')} s USING(logical_key) WHERE c.command_id=ANY($1::uuid[])`, [commandIds]); }
    catch (error) { throw wrap(error, false); }
    if (!result.rows.length) return null;
    if (result.rows.length !== commandIds.length) fail('BATCH_INCOMPLETE', 'Only part of the batch command is durable');
    const byId = new Map(result.rows.map(row => [row.command_id, row]));
    const ordered = commandIds.map(id => byId.get(id.toLowerCase()));
    if (ordered.some(row => !row)) fail('BATCH_INCOMPLETE', 'Batch command membership is incomplete');
    for (const row of ordered) validateReceipt(row, batchId, intentSha256, commandIds);
    if (ordered.some(row => row.result_json.duplicate !== ordered[0].result_json.duplicate)) fail('BATCH_INCOMPLETE', 'Batch receipt outcomes disagree');
    return Object.freeze({ replayed: true, duplicate: Boolean(ordered[0].result_json.duplicate),
      expectedRevisions: ordered.map(row => String(row.before_revision)), revisions: ordered.map(row => String(row.after_revision)),
      members: ordered.map(row => Object.freeze({ commandId:row.command_id,logicalKey:row.logical_key,sourcePath:row.source_path,mediaType:row.media_type })) });
  }

  async function writeDocuments({ batchId, intentSha256, duplicate = false, writes, capacity = null } = {}) {
    if (!uuid(batchId) || !Array.isArray(writes) || writes.length < 2 || writes.length > 16) fail('INVALID_ARGUMENT', 'A batch UUID and 2-16 writes are required');
    if (typeof duplicate !== 'boolean') fail('INVALID_ARGUMENT', 'duplicate receipt flag is invalid');
    validateIntent(intentSha256);
    const prepared = writes.map(validateWrite);
    if (new Set(prepared.flatMap(x => [x.commandId])).size !== prepared.length || new Set(prepared.map(x => x.logicalKey)).size !== prepared.length ||
        new Set(prepared.map(x => x.sourcePath)).size !== prepared.length) fail('INVALID_ARGUMENT', 'Batch command, key, and path identities must be unique');
    let checkedCapacity = null;
    if (capacity !== null) {
      if (!capacity || typeof capacity.prefix !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*\/$/u.test(capacity.prefix) ||
          !Number.isSafeInteger(capacity.maxBytes) || capacity.maxBytes < 1) fail('INVALID_ARGUMENT', 'capacity is invalid');
      if (prepared.some(x => !x.sourcePath.startsWith(capacity.prefix))) fail('INVALID_ARGUMENT', 'capacity scope does not cover the batch');
      checkedCapacity = { prefix: capacity.prefix, maxBytes: capacity.maxBytes };
    }
    let client, open = false, duringCommit = false, destroy = false;
    try {
      client = await pool.connect(); await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE'); open = true; await acquireMutationFence(client);
      const locks = [`batch:${batchId.toLowerCase()}`, ...prepared.flatMap(x => [`command:${x.commandId}`, `key:${x.logicalKey}`, `source:${x.sourcePath}`]),
        ...(checkedCapacity ? [`capacity:${checkedCapacity.prefix}`] : [])].sort();
      for (const lock of locks) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lock]);
      const recorded = await client.query(`SELECT command_id::text,logical_key,media_type,request_hash,after_revision::text,result_json FROM ${table('commands')} WHERE command_id=ANY($1::uuid[])`, [prepared.map(x => x.commandId)]);
      if (recorded.rows.length) {
        if (recorded.rows.length !== prepared.length) fail('BATCH_INCOMPLETE', 'Only part of the batch command is durable');
        const byId = new Map(recorded.rows.map(row => [row.command_id, row]));
        for (const item of prepared) {
          const row = byId.get(item.commandId);
          if (!row || !Buffer.from(row.request_hash).equals(item.fingerprint)) fail('COMMAND_ID_REUSED', 'A child commandId was used for another request');
          validateReceipt(row, batchId, intentSha256, prepared.map(x => x.commandId));
          if (Boolean(row.result_json.duplicate) !== duplicate) fail('COMMAND_ID_REUSED', 'Batch receipt outcome does not match the request');
          const mapped = await client.query(`SELECT 1 FROM ${table('source_files')} WHERE source_path=$1 AND logical_key=$2 AND domain=$3 AND media_type=$4`, [item.sourcePath,item.logicalKey,item.domain,item.mediaType]);
          if (mapped.rows.length !== 1) fail('SOURCE_MAPPING_MISSING', 'Runtime source mapping is missing or conflicts with the command');
        }
        duringCommit = true; await client.query('COMMIT'); open = false;
        return { replayed: true, revisions: prepared.map(item => String(byId.get(item.commandId).after_revision)) };
      }
      const states = new Map(), mappings = new Map();
      for (const item of prepared) {
        const state = (await client.query(`SELECT media_type,content,sha256,revision::text,deleted FROM ${table('document_states')} WHERE logical_key=$1 FOR UPDATE`, [item.logicalKey])).rows[0];
        const actual = state ? String(state.revision) : '0';
        if (actual !== item.expectedRevision) fail('REVISION_CONFLICT', 'expectedRevision does not match current revision');
        states.set(item.logicalKey, state || null);
        const rows = await client.query(`SELECT source_path,logical_key,domain,media_type FROM ${table('source_files')} WHERE source_path=$1 OR logical_key=$2`, [item.sourcePath, item.logicalKey]);
        const mapped = rows.rows[0];
        if (rows.rows.length > 1 || mapped && (mapped.source_path !== item.sourcePath || mapped.logical_key !== item.logicalKey || mapped.domain !== item.domain || mapped.media_type !== item.mediaType))
          fail('SOURCE_MAPPING_CONFLICT', 'Runtime source mapping conflicts with provenance');
        if (!mapped && actual !== '0') fail('SOURCE_MAPPING_MISSING', 'Existing document has no verified source mapping');
        mappings.set(item.logicalKey, mapped || null);
      }
      if (checkedCapacity) {
        const used = await client.query(`SELECT COALESCE(sum(octet_length(d.content)),0)::text AS bytes FROM ${table('source_files')} s JOIN ${table('document_states')} d USING(logical_key) WHERE s.source_path LIKE $1 ESCAPE '\\' AND NOT d.deleted`, [checkedCapacity.prefix.replace(/[\\%_]/g, '\\$&') + '%']);
        const replacing = prepared.reduce((sum, item) => sum + BigInt(states.get(item.logicalKey)?.content?.length || 0), 0n);
        const next = BigInt(used.rows[0].bytes) - replacing + prepared.reduce((sum, item) => sum + BigInt(item.content.length), 0n);
        if (next > BigInt(checkedCapacity.maxBytes)) fail('CAPACITY_EXCEEDED', 'Document storage capacity is exceeded');
      }
      const revisions = [];
      for (const item of prepared) {
        const before = states.get(item.logicalKey), afterRevision = (BigInt(item.expectedRevision) + 1n).toString(); revisions.push(afterRevision);
        await client.query(`INSERT INTO ${table('document_states')}(logical_key,media_type,content,sha256,revision,deleted,modified_at) VALUES($1,$2,$3,$4,$5,false,clock_timestamp()) ON CONFLICT(logical_key) DO UPDATE SET media_type=EXCLUDED.media_type,content=EXCLUDED.content,sha256=EXCLUDED.sha256,revision=EXCLUDED.revision,deleted=false,modified_at=EXCLUDED.modified_at`, [item.logicalKey,item.mediaType,item.content,item.sha256,afterRevision]);
        if (!mappings.get(item.logicalKey)) await client.query(`INSERT INTO ${table('source_files')}(source_path,logical_key,domain,media_type,source_bytes,source_sha256,baseline_present) VALUES($1,$2,$3,$4,0,$5,false)`, [item.sourcePath,item.logicalKey,item.domain,item.mediaType,EMPTY_SHA256]);
        await client.query(`INSERT INTO ${table('commands')}(command_id,operation,logical_key,request_hash,before_revision,after_revision,media_type,before_media_type,before_content,before_sha256,before_deleted,after_content,after_sha256,after_deleted,result_json) VALUES($1,'write',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,false,$13::jsonb)`, [item.commandId,item.logicalKey,item.fingerprint,item.expectedRevision,afterRevision,item.mediaType,before?.media_type ?? null,before?.content ?? null,before?.sha256 ?? null,before ? Boolean(before.deleted) : null,item.content,item.sha256,JSON.stringify({batchId:batchId.toLowerCase(),intentSha256,memberCount:prepared.length,membersSha256:membersHash(prepared.map(x=>x.commandId)),duplicate})]);
      }
      duringCommit = true; await client.query('COMMIT'); open = false;
      return { replayed: false, revisions };
    } catch (error) {
      destroy = duringCommit;
      if (open && client) try { await client.query('ROLLBACK'); } catch { destroy = true; }
      throw wrap(error, duringCommit);
    } finally { if (client) try { client.release(destroy); } catch {} }
  }

  async function listDocuments({ prefix, suffix } = {}) {
    if (typeof prefix !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*\/$/u.test(prefix) || typeof suffix !== 'string' || !/^\.[A-Za-z0-9]+$/u.test(suffix))
      fail('INVALID_ARGUMENT', 'Document catalog filter is invalid');
    try {
      const result = await pool.query(`SELECT s.source_path,d.logical_key,d.media_type,d.content,d.sha256,d.revision::text,d.deleted FROM ${table('source_files')} s JOIN ${table('document_states')} d USING(logical_key) WHERE s.source_path LIKE $1 ESCAPE '\\' AND s.source_path LIKE $2 ESCAPE '\\' ORDER BY s.source_path COLLATE "C"`, [prefix.replace(/[\\%_]/g, '\\$&') + '%', '%' + suffix.replace(/[\\%_]/g, '\\$&')]);
      return result.rows.map(row => ({ sourcePath: row.source_path, logicalKey: row.logical_key, mediaType: row.media_type, content: row.content == null ? null : Buffer.from(row.content), sha256: row.sha256 == null ? null : Buffer.from(row.sha256), revision: String(row.revision), deleted: Boolean(row.deleted) }));
    } catch (error) { throw wrap(error, false); }
  }
  return Object.freeze({ writeDocuments, readReceipt, listDocuments });
}

module.exports = { createStateBatch };
