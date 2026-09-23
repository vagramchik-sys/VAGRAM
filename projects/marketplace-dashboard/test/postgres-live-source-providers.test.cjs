'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createLiveSourceProviders} = require('../storage/postgres-live-source-providers.cjs');

function fixture(entries) {
  const calls = [];
  const sources = {
    identity(path) { if (!entries[path]) throw Object.assign(Error('unsupported'), {code: 'UNSUPPORTED_SOURCE'}); return {}; },
    async listSources() { calls.push(['list']); return Object.entries(entries).map(([sourcePath, row]) => ({sourcePath, head: row.head})); },
    async record(path, options) {
      calls.push(['record', path, options?.entities]);
      const row = entries[path]; if (!row) return null;
      const value = structuredClone(row.value);
      if (options?.entities && path.startsWith('data-')) for (const key of ['products', 'stocks', 'operations', 'stockRows', 'categoryTree']) if (!options.entities.includes(key) && Object.hasOwn(value, key)) value[key] = [];
      return {revision: row.revision, head: row.head, value};
    }
  };
  return {providers: createLiveSourceProviders({sources}), calls};
}

const sha = 'a'.repeat(64);
const data = (revision, value) => ({revision: String(revision), head: {revision: String(revision), sourceMetadata: {sourceSha256: sha}}, value});

test('concurrent identical reads share SQL work while caller values stay isolated and later reads refresh', async () => {
  let reads=0, release;
  const gate=new Promise(resolve=>{release=resolve;});
  const providers=createLiveSourceProviders({sources:{identity(){return{};},async listSources(){return[];},async record(){reads++;await gate;return data(reads,{products:[{product_id:1,name:'original'}]});}}});
  const first=providers.getProducts('1'),second=providers.getProducts('1');
  await Promise.resolve();assert.equal(reads,1);release();
  const [a,b]=await Promise.all([first,second]);a[0].name='changed';assert.equal(b[0].name,'original');
  await providers.getProducts('1');assert.equal(reads,2);
});

test('failed shared SQL reads are evicted so the next request can recover', async () => {
  let reads=0;
  const providers=createLiveSourceProviders({sources:{identity(){return{};},async listSources(){return[];},async record(){if(++reads===1)throw Error('offline');return data(2,{products:[]});}}});
  const results=await Promise.allSettled([providers.getProducts('1'),providers.getProducts('1')]);
  assert.equal(reads,1);assert.equal(results.every(row=>row.status==='rejected'),true);
  assert.deepEqual(await providers.getProducts('1'),[]);assert.equal(reads,2);
});

test('product and report reads request only their live SQL entities', async () => {
  const {providers, calls} = fixture({
    'data-7.json': data(12, {completedAt: '2026-09-22T00:00:00.000Z', products: [{product_id: 5}], stocks: [{product_id: 5}], operations: [{amount: 9}], categoryTree: [{id: 1}], stockRows: []})
  });
  assert.deepEqual(await providers.getProducts('7'), [{product_id: 5, storeId: '7', key: '7:5'}]);
  assert.deepEqual(calls.at(-1), ['record', 'data-7.json', ['products']]);
  const catalog = await providers.getReportCatalog('7');
  assert.deepEqual(catalog.products, [{product_id: 5}]);
  assert.deepEqual(catalog.stocks, [{product_id: 5}]);
  assert.deepEqual(catalog.operations, []);
  assert.deepEqual(catalog._source, {snapshotId: 'live:7:12', marketRevision: '12', marketSha256: sha});
  assert.deepEqual(calls.at(-1), ['record', 'data-7.json', ['products', 'stocks']]);
});

test('catalog lists use metadata first and never read unrelated sources', async () => {
  const {providers, calls} = fixture({
    'data-1.json': data(1, {products: [{sku: 1}], stocks: [], operations: []}),
    'data-wb-2.json': data(2, {products: [{nmID: 2}], stocks: [], operations: []}),
    'ledger-1.json': data(1, {data: {daily: []}})
  });
  assert.deepEqual(await providers.getAllProducts(), [{sku: 1, storeId: '1', key: '1:1'}, {nmID: 2, storeId: 'wb-2', key: 'wb-2:2'}]);
  assert.equal(calls.some(call => call[1] === 'ledger-1.json'), false);
  assert.equal(calls.filter(call => call[0] === 'record').every(call => JSON.stringify(call[2]) === JSON.stringify(['products'])), true);
});

test('buyer selection reads only the highest complete retry that exactly matches', async () => {
  const make = name => data(1, {name});
  const {providers, calls} = fixture({
    'buyer-order-segments-2026-09-20_2026-09-21.json': make('base'),
    'buyer-order-segments-2026-09-20_2026-09-21-retry-2.json': make('retry2'),
    'buyer-order-segments-2026-09-20_2026-09-21-retry-3.partial.json': make('partial'),
    'buyer-order-segments-2026-09-18_2026-09-19.json': make('unrelated'),
    'data-1.json': data(1, {products: []})
  });
  assert.deepEqual(await providers.getBuyerOrderSnapshot({from: '2026-09-20', to: '2026-09-21'}), {name: 'retry2'});
  assert.deepEqual(calls.filter(call => call[0] === 'record').map(call => call[1]), ['buyer-order-segments-2026-09-20_2026-09-21-retry-2.json']);
});

test('missing live rows return unavailable values without document or snapshot fallback', async () => {
  const calls = [];
  const providers = createLiveSourceProviders({sources: {
    identity() { return {}; },
    async listSources() { calls.push('list'); return []; },
    async record(path) { calls.push(path); return null; }
  }});
  assert.equal(await providers.exact('data-9.json'), null);
  assert.deepEqual(await providers.getProducts('9'), []);
  assert.equal(await providers.getReportCatalog('9'), null);
  assert.deepEqual(await providers.getBuyerOrderSnapshots({from: '2026-09-20', to: '2026-09-21'}), []);
  assert.deepEqual(calls, ['data-9.json', 'data-9.json', 'data-9.json', 'list']);
});

test('known cross-market source names return null without touching the repository', async () => {
  const {providers,calls}=fixture({'data-1.json':data(1,{products:[]})});
  assert.equal(await providers.exact('costs-wb-4.json'),null);
  assert.equal(await providers.exact('prices-4.json'),null);
  assert.equal(await providers.exact('ledger-wb-4.json'),null);
  assert.equal(await providers.getOzonLedger('wb-4'),null);
  assert.deepEqual(calls,[]);
});

test('WB finance reads operations only and small providers request explicit collections', async () => {
  const {providers, calls} = fixture({
    'data-wb-4.json': data(7, {completedAt: 'x', products: [{nmID: 1}], stocks: [], operations: [{rrdId: 2}]}),
    'insights-3.json': data(2, {orders: {daily: [{date: '2026-09-22'}], skuDaily: [], skuCoverage: []}, types: [], errors: []}),
    'wb-orders-wb-4.json': data(3, {points: [], orders: [{id: 1}], rows: []})
  });
  assert.deepEqual(await providers.getWbFinance('wb-4'), {completedAt: 'x', products: [], stocks: [], operations: [{rrdId: 2}]});
  await providers.getInsights(); await providers.getWbOrders();
  assert.deepEqual(calls.find(call => call[1] === 'data-wb-4.json')[2], ['operations']);
  assert.deepEqual(calls.find(call => call[1] === 'insights-3.json')[2], ['orders.daily', 'orders.skuDaily', 'orders.skuCoverage', 'types', 'errors']);
  assert.deepEqual(calls.find(call => call[1] === 'wb-orders-wb-4.json')[2], ['points', 'orders', 'rows']);
});

test('category revision fingerprints only relevant heads for the requested scope and period', async () => {
  const make = revision => data(revision, {}), {providers, calls} = fixture({
    'order-category-catalog-1.json': make(1),
    'order-category-catalog-2.json': make(2),
    'order-category-catalog-wb-3.json': make(3),
    'insights-1.json': make(4),
    'wb-orders-wb-3.json': make(5),
    'buyer-order-segments-2026-09-01_2026-09-10.json': make(6),
    'buyer-order-segments-2026-09-05_2026-09-06.partial.json': make(7),
    'buyer-order-segments-2026-09-05_2026-09-06-retry-2.json': make(8),
    'buyer-order-segments-2026-08-01_2026-08-02.json': make(9),
    'ledger-1.json': make(10)
  });
  assert.deepEqual(JSON.parse(await providers.categoryRevision({from:'2026-09-05',to:'2026-09-06',market:'Ozon',store:'1'})),[
    ['buyer-order-segments-2026-09-01_2026-09-10.json','6'],
    ['buyer-order-segments-2026-09-05_2026-09-06.partial.json','7'],
    ['insights-1.json','4'],
    ['order-category-catalog-1.json','1']
  ]);
  assert.deepEqual(calls,[['list']]);
});

test('category revision rejects malformed relevant heads', async () => {
  const row=data(1,{});row.head.revision='broken';
  const {providers}=fixture({'order-category-catalog-1.json':row});
  await assert.rejects(providers.categoryRevision({from:'2026-09-05',to:'2026-09-06'}),error=>error?.code==='CORRUPT_SOURCE');
});
