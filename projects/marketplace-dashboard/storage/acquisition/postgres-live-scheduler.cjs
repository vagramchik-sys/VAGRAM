'use strict';

const { encodeJson } = require('../postgres-json-repository.cjs');
const { acquireMutationFence } = require('../postgres-write-fence.cjs');

const STATES = new Set(['queued', 'running', 'partial', 'done', 'error', 'unknown']);
const TERMINAL = new Set(['partial', 'done', 'error']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH = /^[a-f0-9]{64}$/u, REVISION = /^(?:0|[1-9][0-9]*)$/u;
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const quote = value => `"${value.replace(/"/gu, '""')}"`;
function namespace(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/u.test(value)) throw new TypeError('SQL scheduler schema is invalid');
  return quote(value);
}

class LiveSchedulerError extends Error {
  constructor(code, message) { super(message); this.name = 'LiveSchedulerError'; this.code = code; }
}
const fail = (code, message) => { throw new LiveSchedulerError(code, message); };
function schemaSql(schema = 'pult_live') {
  const ns = namespace(schema);
  return `BEGIN;
CREATE SCHEMA IF NOT EXISTS ${ns};
CREATE TABLE IF NOT EXISTS ${ns}.scheduler_head (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), revision bigint NOT NULL CHECK(revision>=0)
);
INSERT INTO ${ns}.scheduler_head(singleton,revision) VALUES(true,0) ON CONFLICT(singleton) DO NOTHING;
CREATE TABLE IF NOT EXISTS ${ns}.scheduler_jobs (
 kind text COLLATE "C" NOT NULL, store_id text COLLATE "C" NOT NULL,
 attempt_id uuid NOT NULL, command_id uuid NOT NULL, timestamp_text text COLLATE "C" NOT NULL,
 next_due_at_text text COLLATE "C" NOT NULL, state text COLLATE "C" NOT NULL CHECK(state IN ('queued','running','partial','done','error','unknown')),
 stage text, count_value bigint NOT NULL CHECK(count_value>=0), error_codes jsonb NOT NULL,
 document_revision text COLLATE "C", runner_id text, resolution jsonb,
 payload jsonb, payload_hash text COLLATE "C", updated_revision bigint NOT NULL CHECK(updated_revision>0),
 PRIMARY KEY(kind,store_id), CHECK((payload IS NULL)=(payload_hash IS NULL)), CHECK(payload_hash IS NULL OR payload_hash ~ '^[a-f0-9]{64}$')
);
CREATE INDEX IF NOT EXISTS scheduler_jobs_due_idx ON ${ns}.scheduler_jobs(state,next_due_at_text COLLATE "C");
CREATE TABLE IF NOT EXISTS ${ns}.scheduler_commands (
 command_id uuid PRIMARY KEY, kind text COLLATE "C" NOT NULL, store_id text COLLATE "C" NOT NULL,
 before_revision bigint NOT NULL CHECK(before_revision>=0), after_revision bigint NOT NULL CHECK(after_revision>before_revision),
 before_job jsonb, after_job jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS ${ns}.scheduler_requests (
 command_id uuid PRIMARY KEY, timestamp_text text COLLATE "C" NOT NULL, kind text COLLATE "C" NOT NULL,
 targets jsonb NOT NULL, captured_revision bigint NOT NULL CHECK(captured_revision>0), created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
COMMIT;`;
}

function clone(value) { try { return structuredClone(value); } catch { fail('INVALID_ARGUMENT', 'Scheduler value is not cloneable'); } }
function canonical(value, max = 40 * 1024 * 1024) { return encodeJson(value, max).toString('utf8'); }
function validTarget(value, index, rows) {
  return object(value) && /^\d+$/u.test(value.storeId || '') && REVISION.test(value.documentRevision || '') && (!index || rows[index - 1].storeId.localeCompare(value.storeId) < 0);
}
function validRequest(value) {
  return object(value) && UUID.test(value.commandId || '') && value.kind === 'insights-full' && typeof value.timestamp === 'string' && Number.isFinite(Date.parse(value.timestamp)) && Array.isArray(value.targets) && value.targets.length <= 1000 && value.targets.every(validTarget);
}
function validJob(value, allowMissingDerivedPayload = false) {
  if (!object(value) || !/^[a-z][a-z0-9-]{0,40}$/u.test(value.kind || '') || !/^(?:wb-)?[0-9]+$/u.test(value.storeId || '') ||
      !STATES.has(value.state) || !UUID.test(value.attemptId || '') || !UUID.test(value.commandId || '') ||
      typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp)) || typeof value.nextDueAt !== 'string' || !Number.isFinite(Date.parse(value.nextDueAt)) ||
      !Number.isSafeInteger(value.count) || value.count < 0 || !Array.isArray(value.errorCodes) || value.errorCodes.some(code => typeof code !== 'string' || !/^[A-Z0-9_]{1,80}$/u.test(code)) ||
      !(value.runnerId === null || typeof value.runnerId === 'string') || !(value.stage === null || typeof value.stage === 'string') ||
      !(value.documentRevision === null || REVISION.test(value.documentRevision)) ||
      !(value.resolution == null || object(value.resolution) && value.resolution.outcome === 'not-committed' && UUID.test(value.resolution.attemptId || ''))) return false;
  if (value.payload === undefined) return value.payloadHash === undefined && (value.kind !== 'derived-capture' || allowMissingDerivedPayload || TERMINAL.has(value.state));
  if (value.kind !== 'derived-capture' || !object(value.payload) || !HASH.test(value.payloadHash || '')) return false;
  try { canonical(value.payload, 32 * 1024 * 1024); } catch { return false; }
  return true;
}
function jobFromRow(row, withPayload = true) {
  const value = { kind: row.kind, storeId: row.store_id, attemptId: row.attempt_id, commandId: row.command_id,
    timestamp: row.timestamp_text, nextDueAt: row.next_due_at_text, state: row.state, stage: row.stage,
    count: Number(row.count_value), errorCodes: clone(row.error_codes), documentRevision: row.document_revision, runnerId: row.runner_id, resolution: row.resolution };
  if (!Number.isSafeInteger(value.count)) fail('CORRUPT_SCHEDULER', 'Scheduler count exceeds JavaScript precision');
  if (withPayload && row.payload !== null && row.payload !== undefined) Object.assign(value, { payload: clone(row.payload), payloadHash: row.payload_hash });
  if (!validJob(value, !withPayload)) fail('CORRUPT_SCHEDULER', 'Stored scheduler job is invalid');
  return value;
}
function jobValues(value, revision) {
  return [value.kind, value.storeId, value.attemptId, value.commandId, value.timestamp, value.nextDueAt, value.state, value.stage,
    String(value.count), JSON.stringify(value.errorCodes), value.documentRevision, value.runnerId, value.resolution == null ? null : JSON.stringify(value.resolution),
    value.payload === undefined ? null : JSON.stringify(value.payload), value.payloadHash ?? null, revision];
}
function wrap(error, duringCommit = false) {
  if (error instanceof LiveSchedulerError) return error;
  if (duringCommit) return new LiveSchedulerError('OUTCOME_UNKNOWN', 'Scheduler commit outcome is unknown');
  if (error?.code === '40001' || error?.code === '40P01') return new LiveSchedulerError('SERIALIZATION_RETRY', 'Scheduler transaction must be retried with the same command');
  return new LiveSchedulerError('DATABASE_ERROR', 'SQL scheduler is unavailable');
}

function createPostgresLiveScheduler({ pool, schema = 'pult_live' } = {}) {
  if (!pool || typeof pool.connect !== 'function' || typeof pool.query !== 'function') throw new TypeError('PostgreSQL pool is required');
  const ns = namespace(schema), table = name => `${ns}.${quote(name)}`;
  async function transaction(mode, work) {
    let client, open = false, duringCommit = false, destroy = false;
    try {
      client = await pool.connect(); await client.query(`BEGIN ISOLATION LEVEL ${mode}`); open = true;
      if (!mode.includes('READ ONLY')) await acquireMutationFence(client);
      const result = await work(client); duringCommit = true; await client.query('COMMIT'); open = false; return result;
    } catch (error) {
      destroy = duringCommit;
      if (open && client) try { await client.query('ROLLBACK'); } catch { destroy = true; }
      throw wrap(error, duringCommit);
    } finally { if (client) try { client.release(destroy); } catch {} }
  }
  async function head(client, lock = false) {
    const result = await client.query(`SELECT revision::text AS revision FROM ${table('scheduler_head')} WHERE singleton=true${lock ? ' FOR UPDATE' : ''}`);
    if (result.rows.length !== 1 || !REVISION.test(result.rows[0].revision || '')) fail('CORRUPT_SCHEDULER', 'Scheduler head is invalid');
    return result.rows[0].revision;
  }
  async function commandLock(client, commandId) { await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [commandId]); }
  async function commandKind(client, commandId) {
    const result = await client.query(`SELECT 'transition' AS type,before_revision::text,after_revision::text,before_job,after_job FROM ${table('scheduler_commands')} WHERE command_id=$1
      UNION ALL SELECT 'request' AS type,NULL,NULL,NULL,NULL FROM ${table('scheduler_requests')} WHERE command_id=$1`, [commandId]);
    if (result.rows.length > 1) fail('CORRUPT_SCHEDULER', 'Scheduler command id is ambiguous');
    return result.rows[0] || null;
  }
  async function readJob(client, kind, storeId, lock = false, withPayload = true) {
    const result = await client.query(`SELECT kind,store_id,attempt_id::text,command_id::text,timestamp_text,next_due_at_text,state,stage,count_value::text,error_codes,document_revision,runner_id,resolution${withPayload ? ',payload,payload_hash' : ',NULL::jsonb AS payload,NULL::text AS payload_hash'} FROM ${table('scheduler_jobs')} WHERE kind=$1 AND store_id=$2${lock ? ' FOR UPDATE' : ''}`, [kind, storeId]);
    return result.rows.length ? jobFromRow(result.rows[0], withPayload) : null;
  }
  async function load({ includePayload = true } = {}) {
    if (typeof includePayload !== 'boolean') fail('INVALID_ARGUMENT', 'Scheduler load options are invalid');
    return transaction('REPEATABLE READ READ ONLY', async client => {
      const revision = await head(client), [jobRows, requestRows] = await Promise.all([
        client.query(`SELECT kind,store_id,attempt_id::text,command_id::text,timestamp_text,next_due_at_text,state,stage,count_value::text,error_codes,document_revision,runner_id,resolution${includePayload ? ',payload,payload_hash' : ',NULL::jsonb AS payload,NULL::text AS payload_hash'} FROM ${table('scheduler_jobs')} ORDER BY kind COLLATE "C",store_id COLLATE "C"`),
        client.query(`SELECT command_id::text,timestamp_text,kind,targets FROM ${table('scheduler_requests')} ORDER BY captured_revision,command_id`)
      ]), jobs = {}, requests = {};
      for (const row of jobRows.rows) { const job = jobFromRow(row, includePayload); jobs[`${job.kind}:${job.storeId}`] = job; }
      for (const row of requestRows.rows) requests[row.command_id] = { commandId: row.command_id, timestamp: row.timestamp_text, kind: row.kind, targets: clone(row.targets) };
      return { revision, value: { version: 1, jobs, ...(Object.keys(requests).length ? { requests } : {}) } };
    });
  }
  async function transition(input = {}) {
    const expectedRevision = String(input.expectedRevision), expectedAttemptId = input.expectedAttemptId, expectedState = input.expectedState, expectedRunnerId = input.expectedRunnerId;
    const intent = { kind: input.kind, storeId: input.storeId, attemptId: input.attemptId, commandId: typeof input.commandId === 'string' ? input.commandId.toLowerCase() : input.commandId,
      timestamp: input.timestamp, nextDueAt: input.nextDueAt, state: input.state, stage: input.stage ?? null, count: input.count ?? 0,
      errorCodes: input.errorCodes ?? [], documentRevision: input.documentRevision ?? null, runnerId: input.runnerId ?? null, resolution: input.resolution ?? null,
      ...(input.payload === undefined ? {} : { payload: clone(input.payload), payloadHash: input.payloadHash }) };
    if (!REVISION.test(expectedRevision) || !validJob(intent, true) || expectedAttemptId !== undefined && !UUID.test(expectedAttemptId) || expectedState !== undefined && !STATES.has(expectedState) || expectedRunnerId !== undefined && !(expectedRunnerId === null || typeof expectedRunnerId === 'string')) fail('INVALID_ARGUMENT', 'Scheduler transition is invalid');
    const suppliedPayload = intent.payload !== undefined;
    const comparable = value => suppliedPayload ? value : Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'payload' && key !== 'payloadHash'));
    const frozen = canonical(comparable(intent));
    return transaction('SERIALIZABLE', async client => {
      await commandLock(client, intent.commandId); const prior = await commandKind(client, intent.commandId);
      if (prior) {
        if (prior.type !== 'transition') fail('COMMAND_ID_REUSED', 'Scheduler command id belongs to another operation');
        const before = prior.before_job, after = prior.after_job;
        if (prior.before_revision !== expectedRevision || expectedAttemptId !== undefined && before?.attemptId !== expectedAttemptId || expectedState !== undefined && before?.state !== expectedState || expectedRunnerId !== undefined && (before?.runnerId ?? null) !== expectedRunnerId || canonical(comparable(after)) !== frozen) fail('COMMAND_ID_REUSED', 'Scheduler command intent differs');
        return { revision: prior.after_revision, replayed: true, job: clone(after) };
      }
      const revision = await head(client, true);
      if (revision !== expectedRevision) fail('REVISION_CONFLICT', 'Scheduler revision changed');
      const current = await readJob(client, intent.kind, intent.storeId, true);
      if (expectedAttemptId !== undefined && current?.attemptId !== expectedAttemptId || expectedState !== undefined && current?.state !== expectedState || expectedRunnerId !== undefined && (current?.runnerId ?? null) !== expectedRunnerId) fail('JOB_CONFLICT', 'Scheduler job changed concurrently');
      if (current?.state === 'unknown' && intent.state === 'running') fail('UNKNOWN_OUTCOME_HOLD', 'Unknown attempt requires same-command resolution');
      if (current?.state === 'unknown' && intent.state === 'queued' && !(intent.resolution?.attemptId === current.attemptId && intent.resolution?.outcome === 'not-committed')) fail('UNKNOWN_OUTCOME_HOLD', 'Unknown attempt requires explicit resolution');
      if (!suppliedPayload && intent.kind === 'derived-capture') {
        if (!current || current.attemptId !== intent.attemptId || current.payload === undefined) fail('INVALID_ARGUMENT', 'Derived scheduler payload cannot be omitted for a new attempt');
        intent.payload = clone(current.payload); intent.payloadHash = current.payloadHash;
      }
      if (!validJob(intent)) fail('INVALID_ARGUMENT', 'Scheduler transition is invalid');
      const afterRevision = String(BigInt(revision) + 1n), values = jobValues(intent, afterRevision);
      await client.query(`INSERT INTO ${table('scheduler_jobs')}(kind,store_id,attempt_id,command_id,timestamp_text,next_due_at_text,state,stage,count_value,error_codes,document_revision,runner_id,resolution,payload,payload_hash,updated_revision)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb,$14::jsonb,$15,$16)
        ON CONFLICT(kind,store_id) DO UPDATE SET attempt_id=EXCLUDED.attempt_id,command_id=EXCLUDED.command_id,timestamp_text=EXCLUDED.timestamp_text,next_due_at_text=EXCLUDED.next_due_at_text,state=EXCLUDED.state,stage=EXCLUDED.stage,count_value=EXCLUDED.count_value,error_codes=EXCLUDED.error_codes,document_revision=EXCLUDED.document_revision,runner_id=EXCLUDED.runner_id,resolution=EXCLUDED.resolution,payload=EXCLUDED.payload,payload_hash=EXCLUDED.payload_hash,updated_revision=EXCLUDED.updated_revision`, values);
      await client.query(`UPDATE ${table('scheduler_head')} SET revision=$1 WHERE singleton=true`, [afterRevision]);
      await client.query(`INSERT INTO ${table('scheduler_commands')}(command_id,kind,store_id,before_revision,after_revision,before_job,after_job) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`, [intent.commandId, intent.kind, intent.storeId, revision, afterRevision, current === null ? null : JSON.stringify(current), JSON.stringify(intent)]);
      return { revision: afterRevision, replayed: false, job: clone(intent) };
    });
  }
  async function captureRequest(input = {}) {
    const commandId = typeof input.commandId === 'string' ? input.commandId.toLowerCase() : input.commandId;
    const targets = Array.isArray(input.targets) ? clone(input.targets).sort((a, b) => String(a.storeId).localeCompare(String(b.storeId))) : input.targets;
    const intent = { commandId, timestamp: input.timestamp, kind: input.kind ?? 'insights-full', targets };
    if (!validRequest(intent)) fail('INVALID_ARGUMENT', 'Scheduler request group is invalid');
    return transaction('SERIALIZABLE', async client => {
      await commandLock(client, commandId); const prior = await commandKind(client, commandId);
      if (prior) {
        if (prior.type !== 'request') fail('COMMAND_ID_REUSED', 'Scheduler command id belongs to another operation');
        const saved = await client.query(`SELECT timestamp_text,kind,targets,captured_revision::text FROM ${table('scheduler_requests')} WHERE command_id=$1`, [commandId]), row = saved.rows[0];
        if (!row || row.timestamp_text !== intent.timestamp || row.kind !== intent.kind) fail('COMMAND_ID_REUSED', 'Scheduler request group intent differs');
        return { targets: clone(row.targets), replayed: true, revision: row.captured_revision };
      }
      const revision = await head(client, true), afterRevision = String(BigInt(revision) + 1n);
      await client.query(`INSERT INTO ${table('scheduler_requests')}(command_id,timestamp_text,kind,targets,captured_revision) VALUES($1,$2,$3,$4::jsonb,$5)`, [commandId, intent.timestamp, intent.kind, JSON.stringify(intent.targets), afterRevision]);
      await client.query(`UPDATE ${table('scheduler_head')} SET revision=$1 WHERE singleton=true`, [afterRevision]);
      return { targets: clone(intent.targets), replayed: false, revision: afterRevision };
    });
  }
  async function transitionReceipt({ commandId, kind, storeId, timestamp } = {}) {
    if (!UUID.test(commandId || '') || !/^[a-z][a-z0-9-]{0,40}$/u.test(kind || '') || !/^(?:wb-)?[0-9]+$/u.test(storeId || '') || typeof timestamp !== 'string') fail('INVALID_ARGUMENT', 'Scheduler receipt request is invalid');
    let result; try { result = await pool.query(`SELECT 'transition' AS type,after_job FROM ${table('scheduler_commands')} WHERE command_id=$1 UNION ALL SELECT 'request',NULL FROM ${table('scheduler_requests')} WHERE command_id=$1`, [commandId.toLowerCase()]); } catch (error) { throw wrap(error); }
    if (!result.rows.length) return null;
    if (result.rows.length !== 1 || result.rows[0].type !== 'transition') fail('COMMAND_ID_REUSED', 'Scheduler command id belongs to another operation');
    const saved = result.rows[0].after_job;
    if (!validJob(saved) || saved.commandId !== commandId.toLowerCase() || saved.kind !== kind || saved.storeId !== storeId || saved.timestamp !== timestamp) fail('COMMAND_ID_REUSED', 'Scheduler transition intent differs');
    return clone(saved);
  }
  async function getPayload(kind, storeId, expectedAttemptId) {
    if (!/^[a-z][a-z0-9-]{0,40}$/u.test(kind || '') || !/^(?:wb-)?[0-9]+$/u.test(storeId || '') || !UUID.test(expectedAttemptId || '')) fail('INVALID_ARGUMENT', 'Scheduler payload request is invalid');
    let result; try { result = await pool.query(`SELECT attempt_id::text,payload,payload_hash FROM ${table('scheduler_jobs')} WHERE kind=$1 AND store_id=$2`, [kind, storeId]); } catch (error) { throw wrap(error); }
    if (!result.rows.length) return null;
    const row = result.rows[0]; if (row.attempt_id !== expectedAttemptId.toLowerCase()) fail('JOB_CONFLICT', 'Scheduler job changed concurrently');
    if (row.payload === null) return null;
    if (!object(row.payload) || !HASH.test(row.payload_hash || '')) fail('CORRUPT_SCHEDULER', 'Stored scheduler payload is invalid');
    return { payload: clone(row.payload), payloadHash: row.payload_hash };
  }
  async function statusJobs() {
    let result; try { result = await pool.query(`SELECT kind,store_id,attempt_id::text,command_id::text,timestamp_text,next_due_at_text,state,stage,count_value::text,error_codes,document_revision,runner_id,resolution,NULL::jsonb AS payload,NULL::text AS payload_hash FROM ${table('scheduler_jobs')} ORDER BY kind COLLATE "C",store_id COLLATE "C"`); } catch (error) { throw wrap(error); }
    return Object.fromEntries(result.rows.map(row => { const job = jobFromRow(row, false); return [`${job.kind}:${job.storeId}`, job]; }));
  }
  async function jobsProvider() {
    const jobs = await statusJobs(), selected = new Map();
    for (const job of Object.values(jobs)) { const prior = selected.get(job.storeId); if (!prior || job.state === 'running' && prior.state !== 'running' || job.timestamp > prior.timestamp) selected.set(job.storeId, job); }
    return Object.fromEntries([...selected].map(([id, job]) => [id, { status: job.state, stage: job.stage, count: job.count, startedAt: job.state === 'running' ? job.timestamp : null, finishedAt: ['done','partial','error'].includes(job.state) ? job.timestamp : null, nextDueAt: job.nextDueAt }]));
  }
  async function importLegacy(value, { revision } = {}) {
    const snapshot = clone(value);
    if (!REVISION.test(String(revision)) || !object(snapshot) || snapshot.version !== 1 || !object(snapshot.jobs) ||
        Object.entries(snapshot.jobs).some(([key, job]) => key !== `${job?.kind}:${job?.storeId}` || !validJob(job)) ||
        snapshot.requests !== undefined && (!object(snapshot.requests) || Object.entries(snapshot.requests).some(([key, request]) => key !== request?.commandId || !validRequest(request))) ||
        String(revision) === '0' && (Object.keys(snapshot.jobs).length || Object.keys(snapshot.requests || {}).length)) fail('INVALID_ARGUMENT', 'Legacy scheduler snapshot is invalid');
    return transaction('SERIALIZABLE', async client => {
      const current = await head(client, true), counts = await client.query(`SELECT (SELECT count(*) FROM ${table('scheduler_jobs')})::int AS jobs,(SELECT count(*) FROM ${table('scheduler_commands')})::int AS commands,(SELECT count(*) FROM ${table('scheduler_requests')})::int AS requests`);
      if (current !== '0' || counts.rows[0].jobs || counts.rows[0].commands || counts.rows[0].requests) fail('IMPORT_CONFLICT', 'Live scheduler tables are not empty');
      for (const job of Object.values(snapshot.jobs)) await client.query(`INSERT INTO ${table('scheduler_jobs')}(kind,store_id,attempt_id,command_id,timestamp_text,next_due_at_text,state,stage,count_value,error_codes,document_revision,runner_id,resolution,payload,payload_hash,updated_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb,$14::jsonb,$15,$16)`, jobValues(job, String(revision)));
      for (const request of Object.values(snapshot.requests || {})) await client.query(`INSERT INTO ${table('scheduler_requests')}(command_id,timestamp_text,kind,targets,captured_revision) VALUES($1,$2,$3,$4::jsonb,$5)`, [request.commandId, request.timestamp, request.kind, JSON.stringify(request.targets), String(revision)]);
      await client.query(`UPDATE ${table('scheduler_head')} SET revision=$1 WHERE singleton=true`, [String(revision)]);
      return { revision: String(revision), jobs: Object.keys(snapshot.jobs).length, requests: Object.keys(snapshot.requests || {}).length };
    });
  }
  return Object.freeze({ load, transition, captureRequest, transitionReceipt, getPayload, jobsProvider, statusJobs, importLegacy });
}

module.exports = { createPostgresLiveScheduler, LiveSchedulerError, schemaSql };
