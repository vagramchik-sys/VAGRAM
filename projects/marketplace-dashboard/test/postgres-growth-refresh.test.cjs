'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {createGrowthRefresh, GrowthRefreshError, sourceStatus} = require('../storage/domains/postgres-growth-refresh.cjs');
const {createCadenceProducer, stableUuid} = require('../storage/acquisition/postgres-cadence-producer.cjs');

const NOW = '2026-10-01T12:00:00.000Z';
const COMMAND = '11111111-1111-4111-8111-111111111111';
function product(changes = {}) {
  return {product: {id: '2', storeId: '1'}, price: {sellerPrice: 100, currency: 'RUB', observedAt: NOW}, stock: {quantity: 10, observedAt: NOW},
    cost: {unitCost: 40, currency: 'RUB', status: 'filled', observedAt: NOW}, sourceRevisions: {market: '3', costs: '4', ledger: '5'},
    analysisBasis: {financeComplete: true, financeObservedAt: NOW, periodFrom: '2026-09-17', periodTo: '2026-09-30', units: 2},
    economics: {economicsStatus: 'complete'}, ...changes};
}
function fixture({item = product(), jobs = {}, connected = true} = {}) {
  const requests = [];
  const optimizer = {prices: async options => ({items: item ? [item] : [], connection: {stores: connected ? [{storeId: '1', configured: true}] : []}})};
  const service = createGrowthRefresh({optimizer, producer: {request: async value => { requests.push(value); for (const kind of value.kinds) jobs[`${kind}:1`] = {state: 'queued', attemptId: kind + '-attempt'}; return {attempts: Object.fromEntries(value.kinds.map(kind => [kind, kind + '-attempt']))}; }}, scheduler: {statusJobs: async () => jobs}, storesRepository: {read: async () => ({'1': {name: 'Store', market: 'Ozon'}, 'wb-1': {market: 'WB'}})}, now: () => new Date(NOW)});
  return {service, requests};
}

test('selected product refresh queues only bounded store sources and discloses the actual scope', async () => {
  const f = fixture(), result = await f.service.request({storeId: '1', productId: '2', commandId: COMMAND, timestamp: NOW, includePerformance: true});
  assert.deepEqual(f.requests, [{storeId: '1', kinds: ['market', 'costs-prices', 'ozon-performance'], commandId: COMMAND, timestamp: NOW}]);
  assert.equal(result.acquisitionScope.productScoped, false);
  assert.equal(result.acquisitionScope.storeScoped, true);
  assert.equal(result.acquisitionScope.financeWindowDays, 30);
  assert.equal(result.acquisitionScope.includesHistoricalOrders, false);
  assert.deepEqual(result.attempts, {market: 'market-attempt', 'costs-prices': 'costs-prices-attempt', 'ozon-performance': 'ozon-performance-attempt'});
  assert.equal(result.queued, true); assert.equal(result.allQueued, true); assert.equal(result.state, 'queued');
});

function realProducerFixture({leaseActive = async () => true, failCosts = false} = {}) {
  const jobs = {}, receipts = new Map(), transitions = [], priceReads = []; let revision = 0;
  const scheduler = {
    statusJobs: async () => structuredClone(jobs),
    load: async () => ({revision: String(revision), value: {jobs: structuredClone(jobs)}}),
    captureRequest: async () => {},
    transitionReceipt: async value => { const receipt = receipts.get(value.commandId); if (receipt && receipt.timestamp !== value.timestamp) throw Object.assign(Error('reused'), {code: 'COMMAND_ID_REUSED'}); return receipt || null; },
    transition: async value => { transitions.push(value); receipts.set(value.commandId, value); jobs[`${value.kind}:${value.storeId}`] = value; revision++; return {revision: String(revision)}; }
  };
  const storesRepository = {read: async () => ({'1': {market: 'Ozon'}})}, now = () => new Date(NOW);
  const producer = createCadenceProducer({scheduler, storesRepository, now, leaseActive, readDocument: async path => { if (failCosts && path === 'costs-1.json') throw Error('private raw upstream failure'); return {revision: '1', value: {}}; }});
  const service = createGrowthRefresh({producer, scheduler, storesRepository, now, optimizer: {prices: async options => { priceReads.push(options); return {items: [product()], connection: {stores: []}}; }}});
  return {service, producer, jobs, transitions, priceReads};
}
const refreshCommand = {storeId: '1', productId: '2', commandId: COMMAND, timestamp: NOW};

test('actual producer replay returns completed attempts without pretending to queue fresh work', async () => {
  const f = realProducerFixture(); const initial = await f.service.request(refreshCommand);
  assert.equal(initial.state, 'queued'); assert.equal(initial.outcomes.market.reusedExisting, false);
  for (const job of Object.values(f.jobs)) job.state = 'done';
  const replay = await f.service.request(refreshCommand);
  assert.equal(replay.queued, false); assert.equal(replay.state, 'completed'); assert.equal(replay.outcomes.market.replayed, true);
  assert.equal(f.transitions.length, 2); assert.match(replay.message, /Проверьте готовность/u);
  assert.equal(f.priceReads[0].productId, '2'); assert.equal(f.priceReads[0].storeId, '1');
});

test('busy actual producer reports reused running attempts, while lost lease reports not queued', async () => {
  const f = realProducerFixture();
  f.jobs['market:1'] = {state: 'running', attemptId: 'existing-market'};
  f.jobs['costs-prices:1'] = {state: 'running', attemptId: 'existing-costs'};
  const result = await f.service.request(refreshCommand);
  assert.equal(result.queued, false); assert.equal(result.state, 'refreshing'); assert.equal(result.outcomes.market.reusedExisting, true); assert.equal(f.transitions.length, 0);
  const stopped = await realProducerFixture({leaseActive: async () => false}).service.request(refreshCommand);
  assert.equal(stopped.ok, false); assert.equal(stopped.queued, false); assert.equal(stopped.state, 'not_queued');
  assert.equal(stopped.attempts.market, null);
});

test('partial queue failure reports the persisted first source and never exposes raw errors', async () => {
  const f = realProducerFixture({failCosts: true}), result = await f.service.request(refreshCommand);
  assert.equal(result.ok, false); assert.equal(result.state, 'partial'); assert.equal(result.queued, true); assert.equal(result.allQueued, false);
  assert.equal(result.outcomes.market.status, 'queued'); assert.equal(result.outcomes['costs-prices'].status, 'unknown');
  assert.equal(result.attempts.market, stableUuid(`manual-attempt:${COMMAND}:market:1`));
  assert.equal(JSON.stringify(result).includes('private raw'), false); assert.equal(f.transitions.length, 1);
});

test('partial lease loss reports a mixed result instead of all queued', async () => {
  let calls = 0; const f = realProducerFixture({leaseActive: async () => ++calls === 1});
  const result = await f.service.request(refreshCommand);
  assert.equal(result.state, 'partial'); assert.equal(result.allQueued, false); assert.equal(result.outcomes['costs-prices'].status, 'not_queued'); assert.equal(f.transitions.length, 1);
});

test('failed, partial and unknown jobs cannot be masked by a complete cached snapshot', async () => {
  for (const [jobState, expected] of [['error', 'failed'], ['partial', 'partial'], ['unknown', 'unknown']]) {
    const result = await fixture({jobs: {'market:1': {state: jobState}}}).service.status({storeId: '1', productId: '2'});
    assert.equal(result.readiness.complete, true); assert.equal(result.state, expected); assert.equal(result.jobs.market.count, null);
  }
});

test('today, future and impossible periods fail before producer or product reads', async () => {
  const f = realProducerFixture();
  for (const to of ['2026-10-01', '2026-10-02', '2026-09-31']) {
    await assert.rejects(f.service.request({...refreshCommand, from: '2026-09-17', to}), {code: 'INVALID_ARGUMENT'});
    await assert.rejects(f.service.status({storeId: '1', productId: '2', from: '2026-09-17', to}), {code: 'INVALID_ARGUMENT'});
  }
  assert.equal(f.priceReads.length, 0); assert.equal(f.transitions.length, 0);
});

test('readiness rejects wrong finance coverage and unknown numeric values while preserving real zero', async () => {
  const at = Date.parse(NOW), requested = {from: '2026-09-01', to: '2026-09-30'};
  assert.ok(sourceStatus(product(), at, requested).reasons.includes('FINANCE_PERIOD_MISMATCH'));
  assert.equal(sourceStatus(product({stock: {quantity: 0, observedAt: NOW}}), at).sources.market.complete, true);
  assert.equal(sourceStatus(product({stock: {quantity: null, observedAt: NOW}}), at).sources.market.complete, false);
  assert.equal(sourceStatus(product({price: {sellerPrice: null, currency: 'RUB', observedAt: NOW}}), at).sources.market.complete, false);
});

test('existing SKU from another store or different product cannot be refreshed', async () => {
  for (const wrong of [{id: '2', storeId: '9'}, {id: '99', storeId: '1'}]) {
    const f = fixture({item: product({product: wrong})});
    await assert.rejects(f.service.request(refreshCommand), {code: 'PRODUCT_MISSING'}); assert.equal(f.requests.length, 0);
  }
});

test('refresh never silently queues order history and Performance is opt-in', async () => {
  const f = fixture(), result = await f.service.request({storeId: '1', productId: '2', commandId: COMMAND, timestamp: NOW});
  assert.deepEqual(result.kinds, ['market', 'costs-prices']);
  assert.equal(result.kinds.includes('insights-full'), false);
  const disconnected = fixture({connected: false});
  await assert.rejects(disconnected.service.request({storeId: '1', productId: '2', commandId: COMMAND, timestamp: NOW, includePerformance: true}), error => error instanceof GrowthRefreshError && error.code === 'PERFORMANCE_NOT_CONNECTED');
  assert.equal(disconnected.requests.length, 0);
});

test('status reports exact product readiness and scheduler failure evidence', async () => {
  const stale = product({stock: {quantity: 10, observedAt: '2026-09-29T11:59:59Z'}, analysisBasis: {financeComplete: false, financeObservedAt: '2026-09-29T11:00:00Z', periodFrom: '2026-09-17', periodTo: '2026-09-22', units: null}, economics: {economicsStatus: 'insufficient'}});
  const jobs = {'market:1': {attemptId: 'm', state: 'error', stage: 'Attempt failed', count: 0, nextDueAt: NOW, errorCodes: ['RATE_LIMITED']}};
  const result = await fixture({item: stale, jobs}).service.status({storeId: '1', productId: '2', from: '2026-09-17', to: '2026-09-30'});
  assert.equal(result.state, 'failed');
  assert.equal(result.readiness.complete, false);
  assert.ok(result.readiness.reasons.includes('FINANCE_INCOMPLETE'));
  assert.ok(result.readiness.reasons.includes('UNITS_UNKNOWN'));
  assert.deepEqual(result.jobs.market.errorCodes, ['RATE_LIMITED']);
});

test('store-only status never substitutes an arbitrary SKU for aggregate completeness', async () => {
  const f = fixture({jobs: {'costs-prices:1': {attemptId: 'c', state: 'running', stage: 'Running', count: 3, nextDueAt: NOW, errorCodes: []}}});
  const result = await f.service.status({storeId: '1'});
  assert.equal(result.target.productId, null);
  assert.equal(result.state, 'refreshing');
  assert.equal(result.readiness.aggregate, 'unknown');
  assert.deepEqual(result.readiness.reasons, ['PRODUCT_NOT_SELECTED']);
});

test('source completeness requires fresh observations and valid zero or filled cost', () => {
  assert.equal(sourceStatus(product(), Date.parse(NOW)).complete, true);
  const zero = product({cost: {unitCost: 0, currency: 'RUB', status: 'zero', observedAt: NOW}});
  assert.equal(sourceStatus(zero, Date.parse(NOW)).complete, true);
  const stale = product({cost: {unitCost: 40, currency: 'RUB', status: 'filled', observedAt: '2026-09-30T11:59:59Z'}});
  assert.ok(sourceStatus(stale, Date.parse(NOW)).reasons.includes('COST_UNVERIFIED'));
});

test('invalid or mismatched target is rejected before queueing', async () => {
  const f = fixture({item: null});
  await assert.rejects(f.service.request({storeId: '1', productId: '2', commandId: COMMAND, timestamp: NOW}), error => error.code === 'PRODUCT_MISSING');
  await assert.rejects(f.service.request({storeId: 'wb-1', productId: '2', commandId: COMMAND, timestamp: NOW}), error => error.code === 'INVALID_ARGUMENT');
  assert.equal(f.requests.length, 0);
});
