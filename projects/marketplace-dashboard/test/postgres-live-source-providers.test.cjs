'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createLiveSourceProviders} = require('../storage/postgres-live-source-providers.cjs');
const codecs = require('../storage/postgres-live-codecs.cjs');
const {build: buildCategoryDaily} = require('../order-category-daily.cjs');

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

test('buyer reports can opt into partial rows without a failed retry hiding known history', async () => {
  const partial='buyer-order-segments-2026-09-01_2026-09-19.partial.json';
  const failed='buyer-order-segments-2026-09-01_2026-09-19-retry-3.partial.json';
  const daily='buyer-order-segments-2026-09-20_2026-09-20.json';
  const entries={
    [partial]:data(1,{records:[{id:'known'}],productOrders:[{orderId:'known'}],report:{coverage:{sources:[{complete:true}]}}}),
    [failed]:data(1,{records:[],productOrders:[],report:{coverage:{sources:[]}}}),
    [daily]:data(1,{records:[{id:'daily'}],report:{coverage:{sources:[]}}})
  };
  const {providers,calls}=fixture(entries),options={from:'2026-09-10',to:'2026-09-22'};
  assert.deepEqual((await providers.getBuyerOrderSnapshots(options)).map(value=>value.records[0].id),['daily']);
  const rows=await providers.getBuyerOrderSnapshots({...options,includePartial:true});
  assert.equal(rows.length,3);
  const known=rows.find(value=>value.records[0]?.id==='known');
  assert.equal(known._partialSource,true);
  assert.equal(Object.isFrozen(known.records),true);
  assert.equal(rows.find(value=>value.records[0]?.id==='daily')._partialSource,undefined);
  assert.equal(calls.filter(call=>call[0]==='record').length,3);
  await providers.getBuyerOrderSnapshots({...options,includePartial:true});
  assert.equal(calls.filter(call=>call[0]==='record').length,3);
  assert.equal(calls.filter(call=>call[0]==='record').every(call=>JSON.stringify(call[2])===JSON.stringify(['records','productOrders','report.coverage.sources'])),true);
  entries[partial]=data(2,{records:[{id:'updated'}],productOrders:[],report:{coverage:{sources:[]}}});
  const refreshed=await providers.getBuyerOrderSnapshots({...options,includePartial:true});
  assert.equal(refreshed.some(value=>value.records[0]?.id==='updated'),true);
  assert.equal(calls.filter(call=>call[0]==='record').length,4);
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
    'wb-orders-wb-4.json': data(3, {points: [{at:'2026-09-22T09:00:00Z',orderedRevenue:10,orderedUnits:1}], orders: [{id: 1}], rows: []})
  });
  assert.deepEqual(await providers.getWbFinance('wb-4'), {completedAt: 'x', products: [], stocks: [], operations: [{rrdId: 2}]});
  await providers.getInsights(); const wb=await providers.getWbOrders();
  assert.deepEqual(calls.find(call => call[1] === 'data-wb-4.json')[2], ['operations']);
  assert.deepEqual(calls.find(call => call[1] === 'insights-3.json')[2], ['orders.daily', 'orders.skuDaily', 'orders.skuCoverage', 'types', 'errors']);
  assert.deepEqual(calls.find(call => call[1] === 'wb-orders-wb-4.json')[2], ['points','orders']);
  assert.equal(wb[0].value.points.length,1);
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
  assert.deepEqual(JSON.parse(await providers.categoryRevision({from:'2026-09-05',to:'2026-09-06',today:'2026-09-23',market:'Ozon',store:'1'})),[
    ['buyer-order-segments-2026-09-01_2026-09-10.json','6'],
    ['buyer-order-segments-2026-09-05_2026-09-06.partial.json','7'],
    ['order-category-catalog-1.json','1']
  ]);
  assert.deepEqual(JSON.parse(await providers.categoryRevision({from:'2026-09-23',to:'2026-09-23',today:'2026-09-23',market:'Ozon',store:'1'})),[
    ['insights-1.json','4'],
    ['order-category-catalog-1.json','1']
  ]);
});

test('order chart projection requests daily totals only, leaving SKU detail and finance cold',async()=>{
 const {providers,calls}=fixture({'insights-3.json':data(1,{orders:{daily:[{date:'2026-09-20',revenue:0,units:0}]}})});
 const result=await providers.getOrderInsights();
 assert.deepEqual(calls.find(call=>call[1]==='insights-3.json')[2],['orders.daily','errors']);
 assert.equal(result[0].value.orders.daily[0].revenue,0);
 assert.equal(calls.filter(call=>call[0]==='record').length,1);
});

test('category chart projection requests SKU orders only, leaving daily totals and finance cold',async()=>{
 const insight={orders:{skuDailyCoverage:true,skuUpdatedAt:'2026-09-20T10:00:00Z',skuDaily:[{date:'2026-09-20',sku:'1',revenue:20,units:2}]}};
 const {providers,calls}=fixture({'insights-3.json':data(1,insight)});
 const result=await providers.getCategoryInsights();
 assert.deepEqual(calls.find(call=>call[1]==='insights-3.json')[2],['orders.skuDaily','orders.skuCoverage']);
 assert.deepEqual(result[0].value.orders,insight.orders);
 assert.equal(calls.filter(call=>call[0]==='record').length,1);
});

test('category state reader loads only rows for the requested day at one revision',async()=>{
 const sourcePath='order-category-intraday.json',value={version:2,points:[{date:'2026-09-20',at:'2026-09-20T08:00:00Z',values:{a:{orderedRevenue:1,orderedUnits:1}}},{date:'2026-09-21',at:'2026-09-21T08:00:00Z',values:{b:{orderedRevenue:2,orderedUnits:1}}}],commandResults:[]},encoded=codecs.encode(sourcePath,value),calls=[];
 const head={revision:7,metadata:encoded.metadata,sourceMetadata:{sourcePath}},sources={identity(){return{storeId:'all',domain:'category-intraday'}},async listSources(){return[{sourcePath,head}]},async record(){throw Error('full state must stay cold')},repository:{async listRows(options){calls.push(options);const rows=encoded.collections.points.filter(row=>row.day===options.fromDay).map(row=>({entityType:'points',entityKey:row.key,businessDay:row.day,sourceOrder:row.ordinal,value:row.value}));return{rows,total:rows.length}}}};
 const result=await createLiveSourceProviders({sources}).getOrderCategoryState('2026-09-20');
 assert.deepEqual(result,{version:2,points:[value.points[0]]});assert.equal(calls.length,1);assert.equal(calls[0].expectedRevision,7);assert.equal(calls[0].fromDay,'2026-09-20');assert.equal(calls[0].toDay,'2026-09-20');
});

test('category revision rejects malformed relevant heads', async () => {
  const row=data(1,{});row.head.revision='broken';
  const {providers}=fixture({'order-category-catalog-1.json':row});
  await assert.rejects(providers.categoryRevision({from:'2026-09-05',to:'2026-09-06'}),error=>error?.code==='CORRUPT_SOURCE');
});

test('category snapshots use bounded parallel SQL reads and preserve source order', async () => {
  const paths = Array.from({length: 7}, (_, index) => `buyer-order-segments-2026-09-${String(index + 1).padStart(2, '0')}_2026-09-${String(index + 1).padStart(2, '0')}.json`);
  let active = 0, peak = 0;
  const requestedEntities = [];
  const providers = createLiveSourceProviders({sources: {
    identity() { return {}; },
    async listSources() { return paths.map((sourcePath, index) => ({sourcePath, head: data(index + 1, {}).head})); },
    async record(sourcePath, options) {
      requestedEntities.push(options?.entities);
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      return data(paths.indexOf(sourcePath) + 1, {sourcePath});
    }
  }});
  const snapshots = await providers.getSnapshots({from: '2026-09-01', to: '2026-09-07'});
  assert.deepEqual(snapshots.map(row => row.sourcePath), paths);
  assert.equal(peak, 4);
  assert.equal(requestedEntities.every(value => JSON.stringify(value) === JSON.stringify(['records', 'productOrders', 'report.coverage.sources'])), true);
});

test('category snapshots reuse immutable verified source rows until the SQL head changes', async () => {
  const sourcePath = 'buyer-order-segments-2026-09-22_2026-09-22.json';
  let revision = 1, reads = 0;
  const providers = createLiveSourceProviders({sources: {
    identity() { return {}; },
    async listSources() { return [{sourcePath, head: {revision}}]; },
    async record() {
      reads++;
      return data(revision, {
        records: [{market: 'Ozon', units: revision}], productOrders: [],
        report: {coverage: {sources: []}}
      });
    }
  }});
  const options = {from: '2026-09-22', to: '2026-09-22'};
  const first = await providers.getSnapshots(options), cached = await providers.getSnapshots(options);
  assert.equal(reads, 1);
  assert.equal(cached[0], first[0]);
  assert.throws(() => { cached[0].records[0].units = 99; }, TypeError);
  revision = 2;
  const refreshed = await providers.getSnapshots(options);
  assert.equal(reads, 2);
  assert.equal(refreshed[0].records[0].units, 2);
  assert.notEqual(refreshed[0], first[0]);
});

test('category SQL concurrency limit is global across simultaneous source groups', async () => {
  const entries = {};
  for (let index = 1; index <= 4; index++) {
    entries[`order-category-catalog-${index}.json`] = {products: []};
    entries[`insights-${index}.json`] = {orders: {skuDaily: []}};
    entries[`wb-orders-wb-${index}.json`] = {orders: []};
    entries[`buyer-order-segments-2026-09-0${index}_2026-09-0${index}.json`] = {records: [], productOrders: [], report: {coverage: {sources: []}}};
  }
  let active = 0, peak = 0;
  const providers = createLiveSourceProviders({sources: {
    identity() { return {}; },
    async listSources() { return Object.keys(entries).map(sourcePath => ({sourcePath, head: data(1, {}).head})); },
    async record(sourcePath) {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      return data(1, entries[sourcePath]);
    }
  }});
  await Promise.all([
    providers.getCatalogs(),
    providers.getInsights(),
    providers.getWbOrders(),
    providers.getSnapshots({from: '2026-09-01', to: '2026-09-04'})
  ]);
  assert.equal(peak, 4);
});

test('narrow category SQL reads preserve metadata and produce the same report as full sources', async () => {
  const catalog = {stamp: 'catalog-r1', products: [{product_id: 1, sku: 101, name: 'P'}], categoryTree: [{id: 9}]};
  const insight = {orders: {skuDailyCoverage: true, skuUpdatedAt: '2026-09-23T08:00:00Z', skuDaily: [{date: '2026-09-23', sku: '101', units: 3, revenue: 30}], daily: [{date: '2026-09-23', units: 3, revenue: 30}]}, types: [{id: 1}], errors: []};
  const snapshot = {generatedAt: '2026-09-22T12:00:00Z', records: [{market: 'Ozon', storeId: '1', scheme: 'FBO', id: 'p1', createdAt: '2026-09-22T08:00:00Z', units: 2}], productOrders: [{market: 'Ozon', storeId: '1', scheme: 'FBO', postingId: 'p1', productId: '101', orderedAt: '2026-09-22T08:00:00Z', updatedAt: '2026-09-22T12:00:00Z', units: 2, amountRub: 20}], report: {byStore: [{storeId: '1'}], coverage: {sources: [{market: 'Ozon', storeId: '1', scheme: 'FBO', available: true, complete: true, requested: {from: '2026-09-22', to: '2026-09-22'}}, {market: 'Ozon', storeId: '1', scheme: 'FBS', available: true, complete: true, requested: {from: '2026-09-22', to: '2026-09-22'}}]}, limitations: ['x']}, errors: []};
  const entries = {'order-category-catalog-1.json': catalog, 'insights-1.json': insight, 'buyer-order-segments-2026-09-22_2026-09-22.json': snapshot};
  const providers = createLiveSourceProviders({sources: {
    identity() { return {}; },
    async listSources() { return Object.keys(entries).map(sourcePath => ({sourcePath, head: data(1, {}).head})); },
    async record(sourcePath, options) {
      const encoded = codecs.encode(sourcePath, entries[sourcePath]);
      const selected = options?.entities ? Object.fromEntries(Object.entries(encoded.collections).filter(([name]) => options.entities.includes(name))) : encoded.collections;
      return {...data(1, codecs.decode(sourcePath, {metadata: encoded.metadata, collections: selected}, {partial: !!options?.entities}))};
    }
  }});
  const [catalogs, snapshots, insights] = await Promise.all([providers.getCatalogs(), providers.getSnapshots({from: '2026-09-22', to: '2026-09-23'}), providers.getInsights()]);
  assert.equal(catalogs[0].stamp, 'catalog-r1');
  assert.equal(snapshots[0].generatedAt, snapshot.generatedAt);
  assert.equal(insights[0].value.orders.skuDailyCoverage, true);
  assert.equal(insights[0].value.orders.skuUpdatedAt, insight.orders.skuUpdatedAt);
  const registry = {schemaVersion: 1, revision: 'r1', reviewedAt: '2026-09-23T00:00:00Z', types: [{id: 'a', parentId: null, name: 'A'}], assignments: {'1:1': {typeId: 'a', source: 'reviewed', evidence: null}}, rules: [], available: true};
  const options = {from: '2026-09-22', to: '2026-09-23', now: Date.parse('2026-09-23T12:00:00Z'), classifiedAt: '2026-09-23T12:00:00.000Z'};
  const full = buildCategoryDaily({registry, catalogs: [{...catalog, storeId: '1', market: 'Ozon'}], snapshots: [snapshot], insights: {'1': insight}, wbOrders: {}}, options);
  const narrow = buildCategoryDaily({registry, catalogs, snapshots, insights: Object.fromEntries(insights.map(row => [row.storeId, row.value])), wbOrders: {}}, options);
  assert.deepEqual(narrow, full);
});
