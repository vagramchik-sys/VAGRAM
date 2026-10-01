'use strict';

const DAY = 86400000;
const {stableUuid} = require('../acquisition/postgres-cadence-producer.cjs');
const STORE = /^[0-9]+$/u;
const PRODUCT = /^[0-9]{1,40}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ACTIVE = new Set(['queued', 'running', 'unknown']);

class GrowthRefreshError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'GrowthRefreshError';
    this.code = code;
    this.status = status;
    this.public = true;
  }
}

const fail = (code, message, status) => { throw new GrowthRefreshError(code, message, status); };
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN;
const fresh = (value, at) => { const observed = instant(value); return Number.isFinite(observed) && observed <= at && at - observed <= DAY; };
const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const currentPeriod = at => {
  const today = new Date(at + 3 * 3600000).toISOString().slice(0, 10), end = Date.parse(today + 'T00:00:00Z') - DAY;
  return {from: new Date(end - 13 * DAY).toISOString().slice(0, 10), to: new Date(end).toISOString().slice(0, 10)};
};

function input(value, at, command = false) {
  const storeId = String(value?.storeId || ''), productId = String(value?.productId || ''), defaults = currentPeriod(at);
  const from = value?.from || defaults.from, to = value?.to || defaults.to;
  if (!STORE.test(storeId) || command && !PRODUCT.test(productId) || !command && productId && !PRODUCT.test(productId) || !validDay(from) || !validDay(to) || from > to || to > defaults.to || Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z') > 89 * DAY) fail('INVALID_ARGUMENT', 'Проверьте магазин, товар и завершённый период.');
  const result = {storeId, productId, from, to};
  if (command) {
    if (!UUID.test(value?.commandId || '') || typeof value?.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp)) || value.includePerformance !== undefined && typeof value.includePerformance !== 'boolean') fail('INVALID_ARGUMENT', 'Для обновления нужны стабильные commandId и timestamp.');
    result.commandId = value.commandId.toLowerCase(); result.timestamp = value.timestamp; result.includePerformance = value.includePerformance === true;
  }
  return result;
}

function sourceStatus(item, at, requested = null) {
  const basis = item.analysisBasis || {}, cost = item.cost || {}, price = item.price || {}, stock = item.stock || {}, economics = item.economics || {};
  const marketFresh = fresh(price.observedAt, at) && fresh(stock.observedAt, at);
  const marketValid = price.currency === 'RUB' && Number.isFinite(price.sellerPrice) && price.sellerPrice > 0 && Number.isSafeInteger(stock.quantity) && stock.quantity >= 0;
  const costFresh = cost.currency === 'RUB' && Number.isFinite(cost.unitCost) && cost.unitCost >= 0 && fresh(cost.observedAt, at) && (cost.status === 'filled' && cost.unitCost > 0 || cost.status === 'zero' && cost.unitCost === 0);
  const financeFresh = fresh(basis.financeObservedAt, at), financeComplete = basis.financeComplete === true;
  const financePeriod = validDay(basis.periodFrom) && validDay(basis.periodTo) && basis.periodFrom <= basis.periodTo && basis.periodTo <= currentPeriod(at).to && (!requested || basis.periodFrom <= requested.from && basis.periodTo >= requested.to);
  const reasons = [];
  if (!marketFresh) reasons.push('MARKET_NOT_FRESH');
  if (!marketValid) reasons.push('MARKET_UNVERIFIED');
  if (!costFresh) reasons.push('COST_UNVERIFIED');
  if (!financeComplete) reasons.push('FINANCE_INCOMPLETE');
  if (!financeFresh) reasons.push('FINANCE_NOT_FRESH');
  if (!financePeriod) reasons.push('FINANCE_PERIOD_MISMATCH');
  if (!Number.isSafeInteger(basis.units) || basis.units < 0) reasons.push('UNITS_UNKNOWN');
  else if (basis.units === 0) reasons.push('NO_REALIZED_UNITS');
  if (economics.economicsStatus !== 'complete') reasons.push('ECONOMICS_INCOMPLETE');
  return {
    complete: reasons.length === 0,
    reasons: [...new Set(reasons)],
    sources: {
      market: {complete: marketFresh && marketValid, revision: item.sourceRevisions?.market || null, observedAt: price.observedAt || stock.observedAt || null},
      costs: {complete: costFresh, revision: item.sourceRevisions?.costs || null, observedAt: cost.observedAt || null},
      finance: {complete: financeComplete && financeFresh && financePeriod, revision: item.sourceRevisions?.ledger || null, observedAt: basis.financeObservedAt || null, period: {from: basis.periodFrom || null, to: basis.periodTo || null}}
    }
  };
}

function jobShape(job) {
  if (!job) return null;
  return {attemptId: job.attemptId || null, status: job.state || null, stage: job.stage || null, count: Number.isSafeInteger(job.count) && job.count >= 0 ? job.count : null, nextDueAt: job.nextDueAt || null, errorCodes: Array.isArray(job.errorCodes) ? [...job.errorCodes] : []};
}

function createGrowthRefresh({producer, scheduler, optimizer, storesRepository, now = () => new Date()} = {}) {
  if (!producer?.request || !scheduler?.statusJobs || !optimizer?.prices || !storesRepository?.read || typeof now !== 'function') throw new TypeError('Growth refresh dependencies are required');

  async function target(options) {
    const stores = await storesRepository.read(), store = stores[options.storeId];
    if (!store || store.market === 'WB' || options.storeId.startsWith('wb-')) fail('STORE_MISSING', 'Магазин Ozon не найден.', 404);
    const page = await optimizer.prices({...options, limit: 1, offset: 0});
    const item = page.items?.find(row => String(row.product?.storeId) === options.storeId && String(row.product?.id) === options.productId);
    if (!item) fail('PRODUCT_MISSING', 'Товар выбранного магазина не найден.', 404);
    const performanceConnected = page.connection?.stores?.some(row => String(row.storeId ?? row.store_id) === options.storeId && row.configured === true) === true;
    return {item, performanceConnected};
  }

  async function status(raw = {}) {
    const at = now().valueOf(), options = input(raw, at);
    const stores = await storesRepository.read(), store = stores[options.storeId];
    if (!store || store.market === 'WB' || options.storeId.startsWith('wb-')) fail('STORE_MISSING', 'Магазин Ozon не найден.', 404);
    const [verified, jobs] = await Promise.all([options.productId ? target(options) : Promise.resolve(null), scheduler.statusJobs()]);
    const selected = Object.fromEntries(['market', 'costs-prices', 'ozon-performance'].map(kind => [kind, jobShape(jobs[`${kind}:${options.storeId}`])]));
    const readiness = verified ? sourceStatus(verified.item, at, options) : {complete: false, aggregate: 'unknown', reasons: ['PRODUCT_NOT_SELECTED'], sources: {market: null, costs: null, finance: null}};
    const active = Object.values(selected).some(job => job && ACTIVE.has(job.status));
    const failed = Object.values(selected).some(job => job?.status === 'error'), partial = Object.values(selected).some(job => job?.status === 'partial');
    const unknown = Object.values(selected).some(job => job?.status === 'unknown');
    const state = unknown ? 'unknown' : failed ? 'failed' : partial ? 'partial' : active ? 'refreshing' : readiness.complete ? 'ready' : 'needs_refresh';
    return {target: {storeId: options.storeId, productId: options.productId || null}, period: {from: options.from, to: options.to}, state, readiness, jobs: selected, performanceConnected: verified ? verified.performanceConnected : null, generatedAt: new Date(at).toISOString()};
  }

  async function request(raw = {}) {
    const at = now().valueOf(), options = input(raw, at, true), verified = await target(options);
    const kinds = ['market', 'costs-prices'];
    if (options.includePerformance) {
      if (!verified.performanceConnected) fail('PERFORMANCE_NOT_CONNECTED', 'Performance API для магазина не подключён.', 409);
      kinds.push('ozon-performance');
    }
    // A producer receipt may refer to a busy existing attempt, an old completed
    // command, or false after lease loss. It is not proof of a newly queued job.
    const before = structuredClone(await scheduler.statusJobs());
    let receipt = null, errorCode = null;
    try { receipt = await producer.request({storeId: options.storeId, kinds, commandId: options.commandId, timestamp: options.timestamp}); }
    catch (error) { errorCode = ['COMMAND_ID_REUSED', 'REVISION_CONFLICT', 'JOB_CONFLICT', 'OUTCOME_UNKNOWN', 'SOURCE_INTEGRITY', 'STORE_MISSING'].includes(error?.code) ? error.code : 'REFRESH_QUEUE_UNAVAILABLE'; }
    let after = null;
    try { after = await scheduler.statusJobs(); } catch { errorCode ||= 'REFRESH_STATUS_UNAVAILABLE'; }
    const outcomes = {}, attempts = {};
    for (const kind of kinds) {
      const expected = stableUuid(`manual-attempt:${options.commandId}:${kind}:${options.storeId}`), job = after?.[`${kind}:${options.storeId}`];
      const returned = receipt?.attempts?.[kind], attemptId = typeof returned === 'string' && returned ? returned : errorCode && job?.attemptId === expected ? expected : null;
      const observed = attemptId && job?.attemptId === attemptId;
      const state = observed && ['queued', 'running', 'unknown', 'done', 'partial', 'error'].includes(job.state) ? job.state : attemptId || errorCode ? 'unknown' : 'not_queued';
      attempts[kind] = attemptId;
      outcomes[kind] = {attemptId, status: state, reusedExisting: !!attemptId && attemptId !== expected,
        replayed: attemptId === expected && before?.[`${kind}:${options.storeId}`]?.attemptId === expected ? true : null};
    }
    const states = Object.values(outcomes).map(value => value.status), queued = states.includes('queued');
    const bad = states.some(value => ['not_queued', 'partial', 'error', 'unknown'].includes(value));
    const accepted = states.some(value => ['queued', 'running', 'done'].includes(value));
    const state = bad && accepted ? 'partial' : states.includes('unknown') ? 'unknown' : states.includes('error') ? 'failed' : states.includes('partial') ? 'partial' : states.every(value => value === 'not_queued') ? 'not_queued' : states.includes('running') ? 'refreshing' : queued ? 'queued' : 'completed';
    return {ok: !bad && !errorCode, queued, allQueued: states.every(value => value === 'queued'), state, outcomes, errorCode,
      message: state === 'completed' ? 'Указанные попытки уже завершены. Проверьте готовность данных выбранного товара.' : state === 'partial' ? 'Подтверждена только часть обновления. Проверьте состояния источников и повторите ту же команду при необходимости.' : state === 'not_queued' ? 'Обновление не поставлено в очередь.' : 'Показаны подтверждённые состояния попыток; это не подтверждение готовности данных.',
      target: {storeId: options.storeId, productId: options.productId}, period: {from: options.from, to: options.to}, kinds,
      attempts, acquisitionScope: {productScoped: false, storeScoped: true, financeWindowDays: 30, includesHistoricalOrders: false,
        message: 'По выбранному магазину Ozon обновляются каталог, остатки, себестоимость и ограниченный финансовый срез за 30 дней. История заказов не загружается.'}};
  }

  return Object.freeze({status, request});
}

module.exports = {createGrowthRefresh, GrowthRefreshError, sourceStatus, input};
