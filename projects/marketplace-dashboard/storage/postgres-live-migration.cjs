'use strict';

// A one-time, restartable bridge from the old SQL documents to individual facts.
// The original tables remain intact; runtime readers never use this module.
const crypto = require('node:crypto');
const {encodeJson} = require('./postgres-json-repository.cjs');
const {isSupportedSourcePath, encode} = require('./postgres-live-codecs.cjs');
const MAX = 480 * 1024 * 1024;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(Error(code), {code}); };
function createLiveMigration({pool, sources, stateSchema = 'pult', onProgress = () => {}} = {}) {
  if (!pool?.query || !sources?.document || !sources?.record || !/^[a-z][a-z0-9_]{0,62}$/u.test(stateSchema)) throw new TypeError('Migration dependencies are required');
  const ns = '"' + stateSchema + '"';
  async function inventory() {
    const rows = (await pool.query(`SELECT f.source_path,d.revision::text,encode(d.sha256,'hex') AS sha256,octet_length(d.content) AS bytes FROM ${ns}.source_files f JOIN ${ns}.document_states d USING(logical_key) WHERE NOT d.deleted AND f.media_type='application/json' ORDER BY f.source_path`)).rows;
    return rows.filter(row => isSupportedSourcePath(row.source_path));
  }
  async function migrate({verify = true, sourcePaths = null, verifiedSources = []} = {}) {
    if(sourcePaths!==null&&(!Array.isArray(sourcePaths)||sourcePaths.some(value=>typeof value!=='string')))fail('INVALID_ARGUMENT');
    if(!Array.isArray(verifiedSources))fail('INVALID_ARGUMENT');
    const previousProof=new Map(verifiedSources.filter(row=>row?.verified===true).map(row=>[row.sourcePath,row]));
    const entries = (await inventory()).filter(row=>sourcePaths===null||sourcePaths.includes(row.source_path)), results = [];
    for (const [index, entry] of entries.entries()) {
      const row = (await pool.query(`SELECT d.content,d.revision::text,encode(d.sha256,'hex') AS sha256 FROM ${ns}.source_files f JOIN ${ns}.document_states d USING(logical_key) WHERE f.source_path=$1 AND NOT d.deleted`, [entry.source_path])).rows[0];
      if (!row || !Buffer.isBuffer(row.content) || hash(row.content) !== row.sha256) fail('MIGRATION_SOURCE_CHANGED');
      let value; try { value = JSON.parse(row.content); } catch { fail('MIGRATION_SOURCE_INVALID'); }
      const encoded = encode(entry.source_path, value), canonical = encodeJson(value, MAX), expectedHash = hash(canonical);
      const head = await sources.repository.getHead(sources.identity(entry.source_path));
      let revision = String(head?.revision || 0), reused = head?.sourceMetadata?.sourceSha256 === expectedHash;
      if (!reused) {
        if (head?.revision) {
          const last = (await pool.query('SELECT command_id FROM pult_live.commands WHERE store_id=$1 AND domain=$2 AND revision=$3', [encoded.scope.storeId,encoded.scope.domain,head.revision])).rows[0];
          if (!last?.command_id?.startsWith('sql-rows-import:')) fail('MIGRATION_TARGET_ADVANCED');
        }
        const commandId = 'sql-rows-import:' + hash(Buffer.from(entry.source_path + ':' + row.revision + ':' + row.sha256));
        const prior = await sources.repository.readCommand({...sources.identity(entry.source_path), commandId});
        // An earlier completed migration must never be replayed over newer facts.
        if (prior && prior.revision !== head?.revision) fail('MIGRATION_TARGET_ADVANCED');
        const written = await sources.document(entry.source_path).compareAndSet(value, {expectedRevision: revision, commandId});
        revision = String(written.revision);
      }
      const proof=previousProof.get(entry.source_path), verificationReused=verify&&reused&&proof?.sourceSha256===expectedHash&&String(proof?.revision)===revision;
      if (verify&&!verificationReused) {
        const restored = await sources.record(entry.source_path);
        if (!restored || String(restored.revision) !== revision || hash(encodeJson(restored.value, MAX)) !== expectedHash) fail('MIGRATION_PARITY_FAILED');
      }
      const after = (await pool.query(`SELECT d.revision::text,encode(d.sha256,'hex') AS sha256 FROM ${ns}.source_files f JOIN ${ns}.document_states d USING(logical_key) WHERE f.source_path=$1 AND NOT d.deleted`, [entry.source_path])).rows[0];
      const result = {sourcePath: entry.source_path, legacyRevision: row.revision, legacySha256: row.sha256, revision, sourceSha256: expectedHash, rows: Object.values(encoded.collections).reduce((sum, values) => sum + values.length, 0), reused, verified: verify, verificationReused, sourceStable: !!after && after.revision === row.revision && after.sha256 === row.sha256};
      results.push(result);
      await onProgress({index: index + 1, total: entries.length, kind: encoded.kind, rows: result.rows, reused, verified: verify, sourceStable: result.sourceStable, result});
    }
    return {version: 1, completedAt: new Date().toISOString(), verified: verify, sources: results};
  }
  return Object.freeze({inventory, migrate});
}
module.exports = {createLiveMigration};
