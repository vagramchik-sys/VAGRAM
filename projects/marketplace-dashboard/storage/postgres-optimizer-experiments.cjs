'use strict';

const crypto = require('node:crypto');

class OptimizerExperimentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OptimizerExperimentError';
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const STORE = /^[0-9]+$/u;
const REVISION = /^(?:0|[1-9][0-9]*)$/u;
const HASH = /^[a-f0-9]{64}$/u;
const fail = (code, message) => { throw new OptimizerExperimentError(code, message); };
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const clone = value => value === undefined ? undefined : structuredClone(value);
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
};
const digest = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const text = (value, name, max = 500) => {
  if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f]/u.test(value)) fail('INVALID_ARGUMENT', `${name} is invalid`);
  return value;
};
const optionalText = (value, name, max = 500) => value === undefined || value === null || value === '' ? null : text(String(value), name, max);
const timestamp = (value, name) => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail('INVALID_ARGUMENT', `${name} is invalid`);
  return new Date(value).toISOString();
};
const decimal = (value, name, nullable = true) => {
  if ((value === null || value === undefined || value === '') && nullable) return null;
  const normalized = String(value);
  if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/u.test(normalized) || !Number.isFinite(Number(normalized))) fail('INVALID_ARGUMENT', `${name} is invalid`);
  return normalized;
};
const stringList = (value, name) => {
  if (!Array.isArray(value) || value.length > 100 || value.some(item => typeof item !== 'string' || !item || item.length > 100)) fail('INVALID_ARGUMENT', `${name} is invalid`);
  return [...value];
};
const uuidFromHash = hash => `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${((parseInt(hash[16], 16) & 3) | 8).toString(16)}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;

function createOptimizerExperiments({pool, readPool = pool, now = () => new Date(), schema = 'pult_optimizer'} = {}) {
  if (!pool?.connect || !readPool?.query || typeof now !== 'function' || !/^[a-z][a-z0-9_]{0,62}$/u.test(schema)) throw new TypeError('Optimizer experiment dependencies are required');
  const table = name => `"${schema}"."${name}"`;
  const store = value => STORE.test(String(value)) ? String(value) : fail('INVALID_ARGUMENT', 'Store is invalid');
  const command = value => {
    if (!object(value) || !UUID.test(value.commandId || '') || !REVISION.test(String(value.expectedRevision ?? '')) || typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))) fail('INVALID_ARGUMENT', 'Stable command metadata is required');
    return {commandId: value.commandId.toLowerCase(), expectedRevision: String(value.expectedRevision), timestamp: new Date(value.timestamp).toISOString()};
  };
  async function transaction(work) {
    const client = await pool.connect();
    let committing = false;
    try {
      await client.query('BEGIN');
      const result = await work(client);
      committing = true;
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (committing) fail('OUTCOME_UNKNOWN', 'Retry the same optimizer command to resolve its outcome');
      throw error;
    } finally { client.release(); }
  }
  async function replay(client, operation, intentHash) {
    const row = (await client.query(`SELECT kind,store_id,intent_hash,receipt FROM ${table('commands')} WHERE command_id=$1`, [operation.commandId])).rows[0];
    if (!row) return null;
    if (row.kind !== operation.kind || row.store_id !== operation.storeId || row.intent_hash !== intentHash) fail('COMMAND_ID_REUSED', 'Optimizer command id was reused');
    return {...clone(row.receipt), replayed: true};
  }
  async function saveReceipt(client, operation, intentHash, result) {
    await client.query(`INSERT INTO ${table('commands')}(command_id,kind,store_id,intent_hash,receipt,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)`, [operation.commandId, operation.kind, operation.storeId, intentHash, JSON.stringify(result), operation.timestamp]);
  }

  async function recordExperiment(input, metadata, {validate} = {}) {
    if (!object(input)) fail('INVALID_ARGUMENT', 'Experiment is invalid');
    const operation = {...command(metadata), kind: 'record-experiment', storeId: store(input.storeId)};
    const productId = text(String(input.productId || ''), 'Product id'), campaignId = optionalText(input.campaignId, 'Campaign id'), sku = optionalText(input.sku, 'SKU');
    const dimension = input.dimension;
    if (!['PRICE', 'BID'].includes(dimension)) fail('INVALID_ARGUMENT', 'Experiment dimension is invalid');
    const beforeValue = decimal(input.beforeValue, 'Before value', false), afterValue = decimal(input.afterValue, 'After value', false);
    const startedAt = timestamp(input.startedAt || operation.timestamp, 'Start time'), observeUntil = timestamp(input.observeUntil, 'Observation deadline');
    if (Date.parse(observeUntil) <= Date.parse(startedAt)) fail('INVALID_ARGUMENT', 'Observation deadline must follow start time');
    if (operation.expectedRevision !== '0') fail('REVISION_CONFLICT', 'A new experiment requires revision 0');
    if (Number(beforeValue) <= 0 || Number(afterValue) <= 0 || Number(beforeValue) === Number(afterValue)) fail('INVALID_ARGUMENT', 'Experiment values must describe a real positive change');
    const normalized = {storeId: operation.storeId, productId, campaignId, sku, dimension, beforeValue, afterValue, startedAt, observeUntil};
    const intentHash = digest({kind: operation.kind, ...normalized, timestamp: operation.timestamp});
    return transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${schema}:command:${operation.commandId}`]);
      const old = await replay(client, operation, intentHash); if (old) return old;
      if (validate !== undefined) {
        if (typeof validate !== 'function') fail('INVALID_ARGUMENT', 'Experiment validator is invalid');
        await validate();
      }
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([schema, 'experiment', operation.storeId, productId])]);
      const active = (await client.query(`SELECT experiment_id FROM ${table('experiments')} WHERE store_id=$1 AND product_id=$2 AND status IN('recorded','observing') FOR UPDATE`, [operation.storeId, productId])).rows[0];
      if (active) fail('ACTIVE_EXPERIMENT_EXISTS', 'An active experiment already exists for this product');
      const result = {ok: true, experimentId: operation.commandId, storeId: operation.storeId, productId, campaignId, sku, dimension, status: 'recorded', beforeValue, afterValue, startedAt, observeUntil, closedAt: null, revision: '1'};
      await client.query(`INSERT INTO ${table('experiments')}(experiment_id,store_id,product_id,campaign_id,sku,dimension,status,before_value,after_value,started_at,observe_until,revision,command_id) VALUES($1,$2,$3,$4,$5,$6,'recorded',$7,$8,$9,$10,1,$1)`, [result.experimentId, operation.storeId, productId, campaignId, sku, dimension, beforeValue, afterValue, startedAt, observeUntil]);
      await saveReceipt(client, operation, intentHash, result);
      return {...result, replayed: false};
    });
  }

  async function transitionExperiment(input, metadata) {
    if (!object(input)) fail('INVALID_ARGUMENT', 'Experiment transition is invalid');
    const operation = {...command(metadata), kind: 'transition-experiment', storeId: store(input.storeId)};
    const experimentId = String(input.experimentId || '').toLowerCase(), status = input.status;
    if (!UUID.test(experimentId) || !['observing', 'completed', 'cancelled'].includes(status)) fail('INVALID_ARGUMENT', 'Experiment transition is invalid');
    const intentHash = digest({kind: operation.kind, storeId: operation.storeId, experimentId, status, timestamp: operation.timestamp, expectedRevision: operation.expectedRevision});
    return transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${schema}:command:${operation.commandId}`]);
      const old = await replay(client, operation, intentHash); if (old) return old;
      const row = (await client.query(`SELECT experiment_id::text,store_id,product_id,campaign_id,sku,dimension,status,before_value::text,after_value::text,started_at,observe_until,closed_at,revision::text FROM ${table('experiments')} WHERE store_id=$1 AND experiment_id=$2 FOR UPDATE`, [operation.storeId, experimentId])).rows[0];
      if (!row) fail('EXPERIMENT_NOT_FOUND', 'Experiment was not found');
      if (row.revision !== operation.expectedRevision) fail('REVISION_CONFLICT', 'Experiment changed');
      const allowed = row.status === 'recorded' ? new Set(['observing', 'cancelled']) : row.status === 'observing' ? new Set(['completed', 'cancelled']) : new Set();
      if (!allowed.has(status)) fail('INVALID_TRANSITION', 'Experiment transition is not allowed');
      const revision = String(BigInt(row.revision) + 1n), closedAt = ['completed', 'cancelled'].includes(status) ? operation.timestamp : null;
      const updated = await client.query(`UPDATE ${table('experiments')} SET status=$3,revision=$4,closed_at=$5 WHERE store_id=$1 AND experiment_id=$2 AND revision=$6`, [operation.storeId, experimentId, status, revision, closedAt, row.revision]);
      if (updated.rowCount !== 1) fail('REVISION_CONFLICT', 'Experiment changed');
      const result = {ok: true, experimentId, storeId: row.store_id, productId: row.product_id, campaignId: row.campaign_id, sku: row.sku, dimension: row.dimension, status, beforeValue: row.before_value, afterValue: row.after_value, startedAt: new Date(row.started_at).toISOString(), observeUntil: row.observe_until ? new Date(row.observe_until).toISOString() : null, closedAt, revision};
      await saveReceipt(client, operation, intentHash, result);
      return {...result, replayed: false};
    });
  }

  async function recordDecision(input) {
    if (!object(input)) fail('INVALID_ARGUMENT', 'Decision is invalid');
    const normalized = {
      storeId: store(input.storeId), productId: text(String(input.productId || ''), 'Product id'), campaignId: optionalText(input.campaignId, 'Campaign id'), sku: optionalText(input.sku, 'SKU'),
      inputHash: HASH.test(input.inputHash || '') ? input.inputHash : fail('INVALID_ARGUMENT', 'Input hash is invalid'), algorithmVersion: text(input.algorithmVersion, 'Algorithm version', 100), settingsRevision: REVISION.test(String(input.settingsRevision ?? '')) && String(input.settingsRevision) !== '0' ? String(input.settingsRevision) : fail('INVALID_ARGUMENT', 'Settings revision is invalid'),
      sourceRevisions: object(input.sourceRevisions) ? clone(input.sourceRevisions) : fail('INVALID_ARGUMENT', 'Source revisions are invalid'), state: text(input.state, 'State', 50), action: text(input.action, 'Action', 50), recommendedPrice: decimal(input.recommendedPrice, 'Recommended price'), recommendedBid: decimal(input.recommendedBid, 'Recommended bid'), maxProfitableBid: decimal(input.maxProfitableBid, 'Maximum profitable bid'), confidence: optionalText(input.confidence, 'Confidence', 20), reasonCodes: stringList(input.reasonCodes, 'Reason codes'), blockers: stringList(input.blockers, 'Blockers'), humanReason: optionalText(input.humanReason, 'Human reason', 2000), observedAt: timestamp(input.observedAt || new Date(now()).toISOString(), 'Observation time')
    };
    if (Buffer.byteLength(JSON.stringify(normalized.sourceRevisions)) > 16384) fail('INVALID_ARGUMENT', 'Source revisions are too large');
    // Observation time is metadata, not identity. Re-evaluating unchanged inputs
    // must replay the same audit decision instead of conflicting with it.
    const {observedAt: _observedAt, ...identity} = normalized;
    const decisionHash = digest(identity), decisionId = uuidFromHash(decisionHash);
    const values = [decisionId, normalized.storeId, normalized.productId, normalized.campaignId, normalized.sku, normalized.inputHash, normalized.algorithmVersion, normalized.settingsRevision, JSON.stringify(normalized.sourceRevisions), normalized.state, normalized.action, normalized.recommendedPrice, normalized.recommendedBid, normalized.maxProfitableBid, normalized.confidence, JSON.stringify(normalized.reasonCodes), JSON.stringify(normalized.blockers), normalized.humanReason, normalized.observedAt];
    return transaction(async client => {
      const row = (await client.query(`INSERT INTO ${table('decisions')}(decision_id,store_id,product_id,campaign_id,sku,input_hash,algorithm_version,settings_revision,source_revisions,state,action,recommended_price,recommended_bid,max_profitable_bid,confidence,reason_codes,blockers,human_reason,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18,$19) ON CONFLICT DO NOTHING RETURNING decision_id::text`, values)).rows[0];
      if (!row) {
        const existing = (await client.query(`SELECT decision_id::text FROM ${table('decisions')} WHERE store_id=$1 AND product_id=$2 AND COALESCE(campaign_id,'')=COALESCE($3,'') AND COALESCE(sku,'')=COALESCE($4,'') AND input_hash=$5 AND algorithm_version=$6 AND settings_revision=$7`, [normalized.storeId, normalized.productId, normalized.campaignId, normalized.sku, normalized.inputHash, normalized.algorithmVersion, normalized.settingsRevision])).rows[0];
        if (!existing || existing.decision_id !== decisionId) fail('DECISION_CONFLICT', 'Decision identity conflicts with existing audit data');
        return {ok: true, decisionId, replayed: true};
      }
      return {ok: true, decisionId, replayed: false};
    });
  }

  return Object.freeze({recordExperiment, transitionExperiment, recordDecision});
}

module.exports = {createOptimizerExperiments, createPostgresOptimizerExperiments: createOptimizerExperiments, OptimizerExperimentError};
