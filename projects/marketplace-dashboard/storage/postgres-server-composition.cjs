'use strict';

const createStores = require('./domains/postgres-stores.cjs');
const createTrueStats = require('./domains/postgres-truestats.cjs');
const { createPostgresSourceProviders } = require('./postgres-source-providers.cjs');
const createAnalytics = require('./domains/postgres-analytics-composition.cjs');
const { createPostgresRuntime } = require('./postgres-runtime-composition.cjs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const READ_ROUTES = Object.freeze({
  '/api/buyer-order-segments': ['buyerOrderSegments', value => ({ from: value.get('from'), to: value.get('to'), market: value.get('market') || 'all', storeId: value.get('store') || undefined })],
  '/api/buyer-product-segments': ['buyerProductSegments', value => ({ from: value.get('from'), to: value.get('to'), market: value.get('market') || 'all', storeId: value.get('store') || undefined, limit: Number(value.get('limit') || 20), buyerType: value.get('buyerType') || 'legal' })],
  '/api/category-sales': ['categorySales', value => ({ category: value.get('category') || undefined, from: value.get('from') || undefined, to: value.get('to') || undefined, market: value.get('market') || 'all', store: value.get('store') || undefined, days: Number(value.get('days') || 7) })],
  '/api/conversion': ['conversion', value => ({ storeId: value.get('store') || undefined, market: value.get('market') || 'all' })],
  '/api/order-category-daily': ['orderCategoryDaily', value => ({ from: value.get('from'), to: value.get('to'), market: value.get('market') || 'all', store: value.get('store') || undefined })],
  '/api/profit-series': ['profitSeries', value => ({ from: value.get('from'), to: value.get('to'), storeId: value.get('store') || undefined, market: value.get('market') || 'all' })],
  '/api/wb/economics': ['wbEconomics', value => ({ from: value.get('from'), to: value.get('to'), storeId: value.get('store') || undefined })]
});

const ROUTE_CAPABILITIES = Object.freeze({
  '/api/stores': 'core', '/api/data': 'core', '/api/xway': 'xway-read',
  '/api/manage': 'owner', '/api/manage/preview': 'owner', '/api/manage/drafts': 'owner', '/api/manage/transition': 'owner', '/api/manage/note': 'owner',
  '/api/finance': 'owner', '/api/finance/loans': 'owner', '/api/finance/payments': 'owner',
  '/api/suppliers': 'owner', '/api/suppliers/preview': 'owner', '/api/suppliers/category': 'owner', '/api/suppliers/portal': 'owner',
  '/api/market-history/status': 'owner', '/api/market-history/report': 'owner', '/api/stock-history/status': 'owner', '/api/stock-history/report': 'owner', '/api/stock-history/export': 'owner',
  '/api/ideas': 'workspace', '/api/ideas/create': 'workspace', '/api/ideas/update': 'workspace', '/api/procurement': 'workspace', '/api/procurement/parse': 'workspace', '/api/procurement/request': 'workspace', '/api/procurement/import': 'workspace', '/api/procurement/compare': 'workspace',
  ...Object.fromEntries(Object.entries(READ_ROUTES).map(([route, [slot]]) => [route, `analytics.${slot}`])),
  '/api/truestats/status': 'truestats', '/api/truestats/connect': 'truestats',
  '/api/connect': 'store-commands', '/api/connect-wb': 'store-commands', '/api/disconnect': 'store-commands', '/api/sync': 'store-commands',
  '/api/insights': 'insights-api', '/api/insights/sources': 'insights-api', '/api/insights/refresh': 'insights-refresh',
  '/api/manage/refresh-prices': 'pricing-refresh', '/api/wb/orders': 'wb-orders-report', '/api/order-categories': 'order-categories',
  '/api/economics/compare': 'economics-compare', '/api/impact': 'impact', '/api/changes': 'release-notes',
  '/api/finance/contracts': 'finance-documents', '/api/partners/*': 'partner-tools', '/api/charity/*': 'charity-tools'
  ,'/api/optimizer/*': 'optimizer-api'
});
const BACKGROUND_CAPABILITIES = Object.freeze({ schedulerExecution: 'scheduler-runner', periodicAttempts: 'cadence-producer', marketSnapshots: 'market-acquisition', costsAndPrices: 'costs-prices', orders: 'insights-orders', funnel: 'insights-funnel', wbOrders: 'wb-orders-acquisition', performance: 'performance-acquisition', intradayCapture: 'intraday-writer', categoryCapture: 'category-writer' });
const HANDLER_GROUPS = Object.freeze({
  'xway-read': ['xway-read'],
  'store-commands': ['store-commands'],
  'finance-documents': ['finance-documents'],
  'partner-tools': ['partner-tools'],
  'charity-tools': ['charity-tools'],
  'optimizer-routes': ['optimizer-api'],
  'report-routes': ['insights-api', 'wb-orders-report', 'order-categories', 'economics-compare'],
  'acquisition-routes': ['pricing-refresh', 'insights-refresh'],
  'info-routes': ['impact', 'release-notes']
});

const REQUIRED = Object.freeze(['core', 'owner', 'workspace', ...Object.values(READ_ROUTES).map(([slot]) => `analytics.${slot}`), 'truestats', 'provider-contracts', 'scheduler-runner', 'cadence-producer', 'market-acquisition', 'costs-prices', 'insights-orders', 'insights-funnel', 'wb-orders-acquisition', 'intraday-writer', 'category-writer', 'store-commands', 'insights-api', 'insights-refresh', 'pricing-refresh', 'wb-orders-report', 'order-categories', 'economics-compare', 'impact', 'release-notes', 'finance-documents', 'partner-tools', 'charity-tools']);
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const methods = (value, names) => !!value && names.every(name => typeof value[name] === 'function');
const reply = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };

function createAnalyticsHandler({ analytics, trueStats }) {
  async function body(req) { const chunks = []; let size = 0; for await (const part of req) { const chunk = Buffer.from(part); size += chunk.length; if (size > 64 * 1024) throw Object.assign(Error(), { code: 'INVALID_ARGUMENT' }); chunks.push(chunk); } let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(Error(), { code: 'INVALID_ARGUMENT' }); } if (!object(value)) throw Object.assign(Error(), { code: 'INVALID_ARGUMENT' }); return value; }
  async function handle(req, res, url) {
    const route = READ_ROUTES[url.pathname];
    if (route) { if (req.method !== 'GET') { reply(res, 405, { error: 'Метод не поддерживается.' }); return true; } try { reply(res, 200, await analytics[route[0]].read(route[1](url.searchParams))); } catch (error) { const invalid = !error?.code || /^INVALID_/u.test(error.code); reply(res, invalid ? 400 : 503, { error: invalid ? 'Проверьте параметры аналитики.' : 'SQL-аналитика временно недоступна.' }); } return true; }
    if (url.pathname === '/api/truestats/status') { if (req.method !== 'GET') reply(res, 405, { error: 'Метод не поддерживается.' }); else try { reply(res, 200, await trueStats.status()); } catch { reply(res, 503, { error: 'TrueStats временно недоступен.' }); } return true; }
    if (url.pathname !== '/api/truestats/connect') return false;
    if (req.method !== 'POST') { reply(res, 405, { error: 'Метод не поддерживается.' }); return true; }
    try { const value = await body(req), commandId = req.headers['x-pult-command-id'] ?? value.commandId, timestamp = req.headers['x-pult-command-timestamp'] ?? value.timestamp; if (req.headers['x-pult-command-id'] !== undefined && value.commandId !== undefined && req.headers['x-pult-command-id'] !== value.commandId || req.headers['x-pult-command-timestamp'] !== undefined && value.timestamp !== undefined && req.headers['x-pult-command-timestamp'] !== value.timestamp || !UUID.test(commandId || '') || typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp)) || typeof value.key !== 'string') throw Object.assign(Error(), { code: 'INVALID_ARGUMENT' }); reply(res, 200, await trueStats.connect(value.key, { commandId: commandId.toLowerCase(), timestamp })); }
    catch (error) { if (error?.code === 'COMMAND_ID_REUSED') reply(res, 409, { error: 'commandId уже использован для другой команды.' }); else if (error?.code === 'OUTCOME_UNKNOWN') reply(res, 503, { error: 'Результат подключения требует проверки. Повторите тот же запрос с теми же commandId и timestamp.' }); else reply(res, error?.code === 'INVALID_ARGUMENT' ? 400 : 503, { error: error?.code === 'INVALID_ARGUMENT' ? 'Проверьте ключ и параметры команды.' : 'TrueStats временно недоступен.' }); } return true;
  }
  return Object.freeze({ handle });
}

function createPostgresServerComposition({ pool, readPool = pool, stateStore, stateSchema = 'pult', marketSchema = 'pult_market', protect, transport, now, ownerAdapters, scheduler, schedulerRunner, cadenceProducer, derivedCaptureRunner, acquisition, staticDir, staticFiles, sourceProviders, trueStats, analytics, verifyProviders, capabilities = {}, additionalHandlers = [], handlerFactories = {}, background = [], readAdapters, runtimeFactory = createPostgresRuntime } = {}) {
  if (!pool || !stateStore || typeof protect !== 'function' || !object(ownerAdapters) || !Array.isArray(additionalHandlers) || !object(handlerFactories) || !Array.isArray(background)) throw new TypeError('Complete SQL server composition dependencies are required');
  const storesRepository = createStores({ stateStore });
  sourceProviders ||= createPostgresSourceProviders({ pool, stateSchema, marketSchema });
  trueStats ||= createTrueStats({ stateStore, protect, transport, now, getProducts: sourceProviders.getProducts });
  const productTypes = capabilities.productTypes, supplierPortals = ownerAdapters.supplierPortals;
  analytics ||= createAnalytics({ pool, stateSchema, storesRepository, productTypes, supplierPortals, trueStats, now, sourceProviders });
  const analyticsHandler = createAnalyticsHandler({ analytics, trueStats });
  const namedHandlers = new Map(additionalHandlers.map(item => [item?.name, item]));
  const factories = [];
  for (const [name, factory] of Object.entries(handlerFactories)) {
    if (!Object.hasOwn(HANDLER_GROUPS, name) || typeof factory !== 'function') throw new TypeError('Unknown or invalid SQL route handler factory');
    factories.push(factory);
  }
  const available = new Set(['core']);
  if (methods(ownerAdapters.management, ['products', 'state', 'preview', 'create', 'transition', 'note']) && methods(ownerAdapters.financeRegister, ['report', 'saveLoan', 'savePayment']) && methods(ownerAdapters.supplierPortals, ['read', 'preview', 'saveCategory', 'savePortal']) && methods(ownerAdapters.history, ['status', 'report']) && methods(ownerAdapters.stockHistory, ['status', 'report', 'csv'])) available.add('owner');
  if (methods(trueStats, ['status', 'connect', 'readLinks', 'compare', 'daily', 'getWbConversion'])) available.add('truestats');
  if (typeof verifyProviders === 'function') available.add('provider-contracts');
  if (methods(schedulerRunner, ['start', 'close'])) available.add('scheduler-runner');
  if (methods(cadenceProducer, ['start', 'close', 'tick'])) available.add('cadence-producer');
  if (methods(derivedCaptureRunner, ['start', 'close'])) { available.add('intraday-writer'); available.add('category-writer'); }
  if (typeof acquisition?.market?.acquire === 'function') available.add('market-acquisition');
  if (typeof acquisition?.costsPrices?.refresh === 'function') available.add('costs-prices');
  if (typeof acquisition?.insights?.refreshOrders === 'function') available.add('insights-orders');
  if (typeof acquisition?.insights?.refreshFunnel === 'function') available.add('insights-funnel');
  if (typeof acquisition?.wbOrders?.refresh === 'function') available.add('wb-orders-acquisition');
  if (methods(acquisition?.performance, ['refresh', 'resolve'])) available.add('performance-acquisition');
  if (methods(acquisition?.derivedCapture, ['run', 'resolve'])) { available.add('intraday-writer'); available.add('category-writer'); }
  if (ownerAdapters.workspaceTools?.handle) available.add('workspace');
  for (const slot of Object.values(READ_ROUTES).map(([name]) => name)) if (typeof analytics?.[slot]?.read === 'function') available.add(`analytics.${slot}`);
  for (const [group, names] of Object.entries(HANDLER_GROUPS)) if (typeof handlerFactories[group] === 'function' || typeof namedHandlers.get(group)?.handle === 'function') for (const name of names) available.add(name);
  const coverage = Object.freeze(Object.fromEntries(Object.entries(ROUTE_CAPABILITIES).map(([route, capability]) => [route, Object.freeze({ capability, status: available.has(capability) ? 'ready' : 'missing' })])));
  const backgroundCoverage = Object.freeze(Object.fromEntries(Object.entries(BACKGROUND_CAPABILITIES).map(([job, capability]) => [job, Object.freeze({ capability, status: available.has(capability) ? 'ready' : 'missing' })])));
  const missingCapabilities = Object.freeze(REQUIRED.filter(name => !available.has(name)));
  async function compositionGate() { const missing = [...missingCapabilities]; if (typeof verifyProviders === 'function') { let check; try { check = await verifyProviders({ storesRepository, sourceProviders, trueStats, analytics }); } catch { check = null; } if (check?.ready !== true) missing.push(...(Array.isArray(check?.missingAdapters) && check.missingAdapters.length ? check.missingAdapters : ['provider-contracts'])); } return { ready: missing.length === 0, missingAdapters: [...new Set(missing)] }; }
  const tasks = [...(cadenceProducer ? [cadenceProducer] : []), ...(derivedCaptureRunner ? [derivedCaptureRunner] : []), ...background];
  const runtime = runtimeFactory({ pool, readPool, stateStore, stateSchema, marketSchema, scheduler, schedulerRunner, ownerAdapters, acquisition, otherHandlers: [analyticsHandler, ...additionalHandlers], handlerFactories: factories, background: tasks, staticDir, staticFiles, runtimeReadiness: compositionGate, readAdapters });
  async function readiness() { const [base, gate] = await Promise.all([runtime.readiness(), compositionGate()]), missing = [...new Set([...(base.missingAdapters || []), ...(gate.missingAdapters || [])])]; return { ready: base.ready === true && gate.ready === true && missing.length === 0, missingAdapters: missing, passive: false, coverage, backgroundCoverage }; }
  async function start(options) { const state = await readiness(); if (!state.ready) throw Object.assign(Error('PostgreSQL server composition is incomplete'), { code: 'RUNTIME_NOT_READY', missingAdapters: state.missingAdapters }); return runtime.start(options); }
  return Object.freeze({ storesRepository, sourceProviders, trueStats, analytics, analyticsHandler, coverage, backgroundCoverage, missingCapabilities, readiness, start });
}

module.exports = { createPostgresServerComposition, createAnalyticsHandler, ROUTE_CAPABILITIES, BACKGROUND_CAPABILITIES, REQUIRED, HANDLER_GROUPS };
