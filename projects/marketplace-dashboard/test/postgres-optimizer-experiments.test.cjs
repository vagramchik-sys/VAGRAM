'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const {createOptimizerExperiments} = require('../storage/postgres-optimizer-experiments.cjs');

const COMMAND = '11111111-1111-4111-8111-111111111111';
const OTHER_COMMAND = '22222222-2222-4222-8222-222222222222';
const TIME = '2026-09-24T09:00:00.000Z';

function database() {
  const state = {commands: new Map(), experiments: new Map(), decisions: new Map(), connects: 0, releases: 0, rollbacks: 0, locks: [], loseCommit: false};
  const key = (store, id) => `${store}\0${id}`;
  const client = {async query(sql, values = []) {
    if (sql.startsWith('SELECT pg_advisory')) {
      assert.equal(values[0].includes('\0'), false, 'PostgreSQL text parameters cannot contain NUL');
      state.locks.push(values[0]); return {rows: []};
    }
    if (sql === 'COMMIT' && state.loseCommit) {state.loseCommit = false; throw Error('socket lost after committed transaction');}
    if (sql === 'BEGIN' || sql === 'COMMIT') return {rows: []};
    if (sql === 'ROLLBACK') { state.rollbacks++; return {rows: []}; }
    if (sql.includes('FROM "pult_optimizer"."commands"')) return {rows: state.commands.has(values[0]) ? [structuredClone(state.commands.get(values[0]))] : []};
    if (sql.includes('INSERT INTO "pult_optimizer"."commands"')) { state.commands.set(values[0], {kind: values[1], store_id: values[2], intent_hash: values[3], receipt: JSON.parse(values[4])}); return {rows: []}; }
    if (sql.includes("status IN('recorded','observing') FOR UPDATE")) {
      const row = [...state.experiments.values()].find(value => value.store_id === values[0] && value.product_id === values[1] && ['recorded', 'observing'].includes(value.status));
      return {rows: row ? [{experiment_id: row.experiment_id}] : []};
    }
    if (sql.includes('INSERT INTO "pult_optimizer"."experiments"')) {
      const row = {experiment_id: values[0], store_id: values[1], product_id: values[2], campaign_id: values[3], sku: values[4], dimension: values[5], status: 'recorded', before_value: values[6], after_value: values[7], started_at: new Date(values[8]), observe_until: new Date(values[9]), closed_at: null, revision: '1'};
      state.experiments.set(key(row.store_id, row.experiment_id), row); return {rows: []};
    }
    if (sql.includes('FROM "pult_optimizer"."experiments"') && sql.includes('experiment_id=$2 FOR UPDATE')) {
      const row = state.experiments.get(key(values[0], values[1])); return {rows: row ? [structuredClone(row)] : []};
    }
    if (sql.includes('UPDATE "pult_optimizer"."experiments"')) {
      const row = state.experiments.get(key(values[0], values[1]));
      if (row && row.revision === values[5]) Object.assign(row, {status: values[2], revision: values[3], closed_at: values[4]});
      return {rows: [], rowCount: row ? 1 : 0};
    }
    if (sql.includes('INSERT INTO "pult_optimizer"."decisions"')) {
      const unique = [values[1], values[2], values[3] || '', values[4] || '', values[5], values[6], values[7]].join('\0');
      if (state.decisions.has(unique)) return {rows: []};
      state.decisions.set(unique, {decision_id: values[0]}); return {rows: [{decision_id: values[0]}]};
    }
    if (sql.includes('FROM "pult_optimizer"."decisions"')) {
      const unique = [values[0], values[1], values[2] || '', values[3] || '', values[4], values[5], values[6]].join('\0');
      const row = state.decisions.get(unique); return {rows: row ? [structuredClone(row)] : []};
    }
    throw Error(`Unexpected SQL: ${sql}`);
  }, release() { state.releases++; }};
  const pool = {async connect() { state.connects++; return client; }, query: (...args) => client.query(...args)};
  return {pool, state};
}

const metadata = (commandId = COMMAND, expectedRevision = '0') => ({commandId, expectedRevision, timestamp: TIME});
const experiment = overrides => ({storeId: '1', productId: '42', campaignId: '7', sku: '101', dimension: 'PRICE', beforeValue: '100.00', afterValue: '105.00', startedAt: TIME, observeUntil: '2026-10-01T09:00:00.000Z', ...overrides});

test('record is receipt-idempotent and enforces one active experiment per store product', async () => {
  const db = database(), api = createOptimizerExperiments({pool: db.pool, now: () => new Date(TIME)});
  const first = await api.recordExperiment(experiment(), metadata());
  assert.equal(first.replayed, false); assert.equal(first.revision, '1'); assert.equal(first.experimentId, COMMAND);
  const replay = await api.recordExperiment(experiment(), metadata());
  assert.equal(replay.replayed, true); assert.equal(replay.experimentId, COMMAND);
  await assert.rejects(api.recordExperiment(experiment(), metadata(OTHER_COMMAND)), {code: 'ACTIVE_EXPERIMENT_EXISTS'});
  const anotherStore = await api.recordExperiment(experiment({storeId: '2'}), metadata(OTHER_COMMAND));
  assert.equal(anotherStore.storeId, '2');
  assert.equal(db.state.releases, db.state.connects);
});

test('experiment validation runs for the first command and is skipped on receipt replay', async () => {
  const db=database(),api=createOptimizerExperiments({pool:db.pool});let checks=0;
  const validate=async()=>{checks++;if(checks>1)throw Error('current price has since changed')};
  const first=await api.recordExperiment(experiment(),metadata(),{validate});
  const replay=await api.recordExperiment(experiment(),metadata(),{validate});
  assert.equal(first.replayed,false);assert.equal(replay.replayed,true);assert.equal(checks,1);
});

test('record rejects command reuse and nonzero creation revision', async () => {
  const db = database(), api = createOptimizerExperiments({pool: db.pool});
  await api.recordExperiment(experiment(), metadata());
  await assert.rejects(api.recordExperiment(experiment({afterValue: '106'}), metadata()), {code: 'COMMAND_ID_REUSED'});
  await assert.rejects(api.recordExperiment(experiment({storeId: '3'}), metadata(OTHER_COMMAND, '1')), {code: 'REVISION_CONFLICT'});
});

test('transition uses store-scoped CAS and permits only the state machine edges', async () => {
  const db = database(), api = createOptimizerExperiments({pool: db.pool});
  await api.recordExperiment(experiment(), metadata());
  await assert.rejects(api.transitionExperiment({storeId: '2', experimentId: COMMAND, status: 'observing'}, metadata(OTHER_COMMAND, '1')), {code: 'EXPERIMENT_NOT_FOUND'});
  await assert.rejects(api.transitionExperiment({storeId: '1', experimentId: COMMAND, status: 'observing'}, metadata(OTHER_COMMAND, '0')), {code: 'REVISION_CONFLICT'});
  const observing = await api.transitionExperiment({storeId: '1', experimentId: COMMAND, status: 'observing'}, metadata(OTHER_COMMAND, '1'));
  assert.equal(observing.status, 'observing'); assert.equal(observing.revision, '2'); assert.equal(observing.closedAt, null);
  const replay = await api.transitionExperiment({storeId: '1', experimentId: COMMAND, status: 'observing'}, metadata(OTHER_COMMAND, '1'));
  assert.equal(replay.replayed, true);
  const third = '33333333-3333-4333-8333-333333333333';
  const completed = await api.transitionExperiment({storeId: '1', experimentId: COMMAND, status: 'completed'}, metadata(third, '2'));
  assert.equal(completed.status, 'completed'); assert.equal(completed.revision, '3'); assert.equal(completed.closedAt, TIME);
  const fourth = '44444444-4444-4444-8444-444444444444';
  await assert.rejects(api.transitionExperiment({storeId: '1', experimentId: COMMAND, status: 'cancelled'}, metadata(fourth, '3')), {code: 'INVALID_TRANSITION'});
});

test('decision audit insert is deterministic and exact replay does not duplicate', async () => {
  const db = database(), api = createOptimizerExperiments({pool: db.pool, now: () => new Date(TIME)}), input = {storeId: '1', productId: '42', campaignId: '7', sku: '101', inputHash: 'a'.repeat(64), algorithmVersion: 'price-ads-v1', settingsRevision: '2', sourceRevisions: {market: '9', ads: '4'}, state: 'BLOCKED', action: 'NONE', recommendedPrice: null, recommendedBid: null, maxProfitableBid: null, confidence: 'LOW', reasonCodes: ['BID_UNIT_UNSUPPORTED'], blockers: ['BID_UNIT_UNSUPPORTED'], humanReason: 'Единица ставки не подтверждена.', observedAt: TIME};
  const first = await api.recordDecision(input), replay = await api.recordDecision(structuredClone(input));
  assert.equal(first.replayed, false); assert.equal(replay.replayed, true); assert.equal(first.decisionId, replay.decisionId); assert.match(first.decisionId, /^[0-9a-f-]{36}$/u);
  assert.equal(db.state.decisions.size, 1);
});

test('invalid records fail before opening a database transaction', async () => {
  const db = database(), api = createOptimizerExperiments({pool: db.pool});
  await assert.rejects(api.recordExperiment(experiment({observeUntil: TIME}), metadata()), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(api.recordDecision({storeId: '../1'}), {code: 'INVALID_ARGUMENT'});
  assert.equal(db.state.connects, 0);
});

test('experiment command locks share the repository namespace and product locks are PostgreSQL text', async () => {
  const db=database(),api=createOptimizerExperiments({pool:db.pool});
  await api.recordExperiment(experiment(),metadata());
  await api.transitionExperiment({storeId:'1',experimentId:COMMAND,status:'observing'},metadata(OTHER_COMMAND,'1'));
  assert.equal(db.state.locks[0],`pult_optimizer:command:${COMMAND}`);
  assert.deepEqual(JSON.parse(db.state.locks[1]),['pult_optimizer','experiment','1','42']);
  assert.equal(db.state.locks[2],`pult_optimizer:command:${OTHER_COMMAND}`);
});

test('lost experiment commit acknowledgement returns unknown outcome and the same identity resolves it', async () => {
  const db=database(),api=createOptimizerExperiments({pool:db.pool});db.state.loseCommit=true;
  await assert.rejects(api.recordExperiment(experiment(),metadata()),{code:'OUTCOME_UNKNOWN'});
  const replay=await api.recordExperiment(experiment(),metadata());
  assert.equal(replay.replayed,true);assert.equal(replay.experimentId,COMMAND);assert.equal(db.state.experiments.size,1);
});

test('changing the expected revision on a repeated transition is command reuse', async () => {
  const db=database(),api=createOptimizerExperiments({pool:db.pool});
  await api.recordExperiment(experiment(),metadata());
  const change={storeId:'1',experimentId:COMMAND,status:'observing'};
  await api.transitionExperiment(change,metadata(OTHER_COMMAND,'1'));
  await assert.rejects(api.transitionExperiment(change,metadata(OTHER_COMMAND,'2')),{code:'COMMAND_ID_REUSED'});
});
