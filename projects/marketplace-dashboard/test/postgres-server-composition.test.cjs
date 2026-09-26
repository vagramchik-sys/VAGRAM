'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createPostgresServerComposition, createAnalyticsHandler } = require('../storage/postgres-server-composition.cjs');

const analytics = () => Object.fromEntries(['buyerOrderSegments', 'buyerProductSegments', 'b2bRadar', 'orderCategoryDaily', 'categorySales', 'profitSeries', 'wbEconomics', 'conversion'].map(name => [name, { read: async input => ({ name, input }) }]));
const stateStore = { read: async () => null, readCommand: async () => null, write: async () => {}, remove: async () => {} };
const noop = async () => ({});
const ownerAdapters = { management: { products: noop, state: noop, preview: noop, create: noop, transition: noop, note: noop }, financeRegister: { report: noop, saveLoan: noop, savePayment: noop }, supplierPortals: { read: async () => ({ categories: [] }), preview: noop, saveCategory: noop, savePortal: noop }, history: { status: noop, report: noop }, stockHistory: { status: noop, report: noop, csv: noop }, workspaceTools: { handle: async () => false } };
const scheduler = { load: async () => ({ value: { jobs: {} }, revision: '0' }), jobsProvider: async () => ({}) };
const schedulerRunner = { start: async () => {}, close: async () => {} };
const acquisition = { market: { acquire() {} }, costsPrices: { refresh() {} }, insights: { refreshOrders() {}, refreshFunnel() {} } };
const sourceProviders = { getProducts: async () => [] };
const trueStats = { status: async () => ({ connected: false }), connect: async (key, op) => ({ keyLength: key.length, op }), readLinks: noop, compare: noop, daily: noop, getWbConversion: noop };
function response() { return { status: null, value: null, writeHead(status) { this.status = status; }, end(value) { this.value = JSON.parse(value); } }; }

test('coverage exposes implemented SQL reads and blocks production start on missing mutations', async () => {
  let starts = 0, runtimeOptions;
  const runtimeFactory = options => ({
    options: (runtimeOptions = options),
    readiness: async () => ({ ready: true, missingAdapters: [], passive: false }),
    start: async () => { starts++; return {}; }
  });
  const pool = {}, readPool = {};
  const composition = createPostgresServerComposition({ pool, readPool, stateStore, protect: async value => value, ownerAdapters, scheduler, schedulerRunner, acquisition, staticDir: 'C:\\public', staticFiles: ['index.html'], sourceProviders, trueStats, analytics: analytics(), runtimeFactory });
  assert.equal(runtimeOptions.pool,pool); assert.equal(runtimeOptions.readPool,readPool);
  assert.equal(composition.coverage['/api/stores'].status, 'ready');
  assert.equal(composition.coverage['/api/buyer-order-segments'].status, 'ready');
  assert.equal(composition.coverage['/api/connect'].status, 'missing');
  assert.equal(composition.coverage['/api/disconnect'].status, 'missing'); assert.equal(composition.backgroundCoverage.schedulerExecution.status, 'ready'); assert.equal(composition.backgroundCoverage.periodicAttempts.status, 'missing');
  assert.ok(composition.missingCapabilities.includes('store-commands')); assert.ok(composition.missingCapabilities.includes('provider-contracts'));
  const ready = await composition.readiness(); assert.equal(ready.ready, false); assert.ok(ready.missingAdapters.includes('finance-documents'));
  await assert.rejects(composition.start(), error => error.code === 'RUNTIME_NOT_READY' && error.missingAdapters.includes('store-commands'));
  assert.equal(starts, 0);
});

test('analytics handler preserves query names and awaits TrueStats command envelopes', async () => {
  const seen = [], services = analytics(), stats = { status: async () => ({ connected: true }), async connect(key, op) { seen.push({ key, op }); return { connected: true }; } }, handler = createAnalyticsHandler({ analytics: services, trueStats: stats });
  let res = response(); assert.equal(await handler.handle({ method: 'GET' }, res, new URL('http://local/api/buyer-product-segments?from=2026-09-01&to=2026-09-02&market=WB&store=wb-1&limit=5&buyerType=legal')), true); assert.equal(res.status, 200); assert.deepEqual(res.value.input, { from: '2026-09-01', to: '2026-09-02', market: 'WB', storeId: 'wb-1', limit: 5, buyerType: 'legal' });
  res=response();assert.equal(await handler.handle({method:'GET'},res,new URL('http://local/api/b2b-radar?from=2026-09-01&to=2026-09-07&market=Ozon&store=1&limit=50&offset=100')),true);assert.equal(res.status,200);assert.deepEqual(res.value.input,{from:'2026-09-01',to:'2026-09-07',market:'Ozon',storeId:'1',limit:50,offset:100});
  services.orderCategoryDaily.read=async input=>({period:{from:input.from,to:input.to},types:[{id:'a',parentId:null,name:'Крепёж'}],series:[{typeId:'a',market:'Ozon',points:[{date:input.from,orderedRevenue:150,complete:false}]}],byProduct:Array.from({length:500},(_,i)=>({productKey:String(i)})),coverage:{complete:false,stores:[{source:'orders',observed:true}]}});
  res=response();assert.equal(await handler.handle({method:'GET'},res,new URL('http://local/api/business-dynamics/categories?date=2026-09-25&market=Ozon')),true);assert.equal(res.status,200);assert.equal(res.value.knownTotal,150);assert.equal(res.value.complete,false);assert.equal(res.value.rows[0].name,'Крепёж');assert.equal(JSON.stringify(res.value).includes('productKey'),false);
  const body = { key: 'synthetic-key', commandId: '11111111-1111-4111-8111-111111111111', timestamp: '2026-09-22T00:00:00.000Z' };
  res = response(); await handler.handle(Object.assign(require('node:stream').Readable.from([JSON.stringify(body)]), { method: 'POST', headers: {} }), res, new URL('http://local/api/truestats/connect')); assert.equal(res.status, 200); assert.deepEqual(seen[0], { key: 'synthetic-key', op: { commandId: body.commandId, timestamp: body.timestamp } });
  res = response(); await handler.handle(Object.assign(require('node:stream').Readable.from(['null']), { method: 'POST', headers: {} }), res, new URL('http://local/api/truestats/connect')); assert.equal(res.status, 400);
});

test('unwired capability-shaped objects cannot make readiness true', async () => {
  let started = 0; const method = names => Object.fromEntries(names.map(name => [name, async () => ({})]));
  const capabilities = { productTypes: { read: async () => ({}) }, cadenceProducer: method(['start', 'close']), storeCommands: method(['connectOzon', 'connectWb', 'disconnect', 'sync']), 'insights-api': method(['read', 'sources', 'refresh']), 'pricing-refresh': method(['refresh']), 'wb-orders-report': method(['report']), 'order-categories': method(['report']), 'economics-compare': method(['read']), impact: method(['read']), 'release-notes': method(['read']), 'finance-documents': method(['drafts', 'upload']) };
  const composition = createPostgresServerComposition({ pool: {}, stateStore, protect: async value => value, ownerAdapters, scheduler, schedulerRunner, acquisition, staticDir: 'C:\\public', staticFiles: ['index.html'], sourceProviders, trueStats, analytics: analytics(), verifyProviders: async () => ({ ready: true, missingAdapters: [] }), capabilities, runtimeFactory: () => ({ readiness: async () => ({ ready: true, missingAdapters: [] }), start: async () => { started++; return {}; } }) });
  const state = await composition.readiness(); assert.equal(state.ready, false); assert.ok(state.missingAdapters.includes('store-commands')); assert.ok(state.missingAdapters.includes('cadence-producer')); await assert.rejects(composition.start(), { code: 'RUNTIME_NOT_READY' }); assert.equal(started, 0);
});

test('HTTP handler with real analytics composition consumes the legacy Ozon funnel wrapper', async t => {
  const value = { '1': { name: 'Ozon', clientId: '1', key: 'opaque-ciphertext', connectedAt: '2026-09-01T00:00:00.000Z' } }, content = Buffer.from(JSON.stringify(value)), storesState = { ...stateStore, read: async () => ({ revision: '1', deleted: false, mediaType: 'application/json', content, sha256: crypto.createHash('sha256').update(content).digest() }) };
  const funnel = { version: 1, storeId: '1', complete: true, current: { from: '2026-09-11', to: '2026-09-17' }, previous: { from: '2026-09-04', to: '2026-09-10' }, updatedAt: '2026-09-18T10:00:00Z', currentRows: [{ sku: '7', orderedUnits: 8, views: 200, cartAdds: 30 }], previousRows: [{ sku: '7', orderedUnits: 10, views: 250, cartAdds: 50 }] };
  const sources = { getProducts: async () => [{ key: '1:7', storeId: '1', sku: '7', name: 'Товар' }], getOzonFunnel: async () => ({ status: 'ready', snapshot: funnel }), getBuyerOrderSnapshot: async () => null, getBuyerProductSnapshot: async () => null, getBuyerOrderSnapshots: async () => [], getCatalog: async () => ({ products: [] }), getCatalogs: async () => [], getSnapshots: async () => [], getInsights: async () => [], getWbOrders: async () => [], getAllProducts: async () => [], getOzonLedger: async () => null, getWbFinance: async () => null, getMarketSnapshot: async () => null };
  const stats = { ...trueStats, getWbConversion: async () => null };
  const composition = createPostgresServerComposition({ pool: {}, stateStore: storesState, protect: async input => input, ownerAdapters, scheduler, schedulerRunner, acquisition, staticDir: 'C:\\public', staticFiles: ['index.html'], sourceProviders: sources, trueStats: stats, now: () => Date.parse('2026-09-18T12:00:00Z'), capabilities: { productTypes: { read: async () => ({ schemaVersion: 1, types: [], assignments: {}, rules: [] }) } }, runtimeFactory: () => ({ readiness: async () => ({ ready: false, missingAdapters: ['runtime'] }), start: async () => { throw Error('must remain gated'); } }) });
  const http = require('node:http'), server = http.createServer(async (req, res) => { const url = new URL(req.url, 'http://127.0.0.1'); if (!await composition.analyticsHandler.handle(req, res, url)) res.writeHead(404).end(); }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve))); const origin = `http://127.0.0.1:${server.address().port}`;
  let response = await fetch(`${origin}/api/conversion?store=1&market=Ozon`), report = await response.json(); assert.equal(response.status, 200); assert.equal(report.status, 'ready'); assert.equal(report.rows[0].current.orders, 8); assert.equal(report.rows[0].sku, '7');
  response = await fetch(`${origin}/api/truestats/status`); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { connected: false });
});
