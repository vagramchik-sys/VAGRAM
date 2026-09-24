'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const create = require('../storage/domains/postgres-order-category-daily.cjs');
const registry = { schemaVersion: 1, revision: 'r1', reviewedAt: '2026-09-20T10:00:00Z', types: [{ id: 'a', parentId: null, name: 'A' }], assignments: { 's1:1': { typeId: 'a', source: 'reviewed', evidence: null } }, rules: [], available: true };
function providers(overrides = {}) { const called = [], snapshotOptions = []; return { called, snapshotOptions, options: { productTypes: { async read() { called.push('registry'); return registry; } }, async getCatalogs() { called.push('catalogs'); return [{ storeId: 's1', market: 'Ozon', products: [{ product_id: 1, sku: 101 }] }]; }, async getSnapshots(options) { called.push('snapshots'); snapshotOptions.push(options); return [{ generatedAt: '2026-09-22T12:00:00Z', productOrders: [{ market: 'Ozon', storeId: 's1', scheme: 'FBO', postingId: 'p', productId: '101', orderedAt: '2026-09-21T21:00:00Z', units: 2, amountRub: null }], records: [], report: { coverage: { sources: [{ market: 'Ozon', storeId: 's1', scheme: 'FBO', available: true, complete: true, requested: { from: '2026-09-22', to: '2026-09-22' } }, { market: 'Ozon', storeId: 's1', scheme: 'FBS', available: true, complete: true, requested: { from: '2026-09-22', to: '2026-09-22' } }] } } }]; }, async getInsights() { called.push('insights'); return []; }, async getWbOrders() { called.push('wb'); return []; }, async getStores() { called.push('stores'); return { s1: { name: 'SQL store' } }; }, now: () => Date.parse('2026-09-23T00:00:00Z'), ...overrides } }; }
test('reader passes the requested period and leaves current-only sources cold for history', async () => { const p = providers(), result = await create(p.options).read({ from: '2026-09-22', to: '2026-09-22', store: 's1' }), leaf = result.series.find(row => row.typeId === 'a'); assert.deepEqual(new Set(p.called), new Set(['registry', 'catalogs', 'snapshots', 'stores'])); assert.deepEqual(p.snapshotOptions,[{from:'2026-09-22',to:'2026-09-22'}]); assert.equal(leaf.points[0].orderedUnits, 2); assert.equal(leaf.points[0].orderedRevenue, null); assert.equal(result.byStore[0].storeName, 'SQL store'); });
test('invalid current provider rows fail closed rather than becoming empty history', async () => { const p = providers({ getInsights: async () => ({}) }); await assert.rejects(create(p.options).read({ from: '2026-09-23', to: '2026-09-23' }), /provider contract/u); });

test('concurrent category requests share work, later reads refresh, and failures can retry', async () => {
  let release, attempts = 0;
  const p = providers({getSnapshots: () => { attempts++; return new Promise(resolve => {release = resolve;}); }});
  const reader = create(p.options), options = {from: '2026-09-22', to: '2026-09-22'};
  const first = reader.read(options), second = reader.read({...options});
  assert.equal(attempts, 1); release([]);
  const [a,b] = await Promise.all([first, second]); assert.deepEqual(a,b);
  const refresh = reader.read(options); assert.equal(attempts, 2); release([]); await refresh;
  const broken = providers({getSnapshots: async () => { if (++attempts === 3) throw Error('offline'); return []; }});
  const retryReader = create(broken.options);
  await assert.rejects(retryReader.read(options), /offline/);
  await retryReader.read(options); assert.equal(attempts, 4);
});

test('completed reports use the cheap revision path and isolate caller mutations', async () => {
  let snapshots=0,revisions=0;
  const p=providers({async categoryRevision(){revisions++;return 'sources-1';},async getSnapshots(){snapshots++;return[];}}),reader=create(p.options),options={from:'2026-09-22',to:'2026-09-22'};
  const first=await reader.read(options);first.period.from='changed';
  const second=await reader.read(options);
  assert.equal(second.period.from,'2026-09-22');assert.equal(snapshots,1);assert.equal(revisions,3);
  assert.equal(p.called.filter(value=>value==='catalogs').length,1);assert.equal(p.called.filter(value=>value==='registry').length,2);assert.equal(p.called.filter(value=>value==='stores').length,2);
});

test('cold source reads wait for the initial revision gate', async () => {
  let releaseRevision, revisionCalls=0, snapshotsStarted=false;
  const p=providers({
    categoryRevision(){revisionCalls++;if(revisionCalls===1)return new Promise(resolve=>{releaseRevision=()=>resolve('sources-1')});return Promise.resolve('sources-1');},
    async getSnapshots(){snapshotsStarted=true;return[];}
  }),reader=create(p.options),request=reader.read({from:'2026-09-22',to:'2026-09-22'});
  await Promise.resolve();
  assert.equal(snapshotsStarted,false,'snapshot rows must not precede the revision that identifies them');
  releaseRevision();await request;
  assert.equal(snapshotsStarted,true);
  assert.equal(revisionCalls,2,'the post-build revision check still protects cache correctness');
});

test('a source update before the initial revision cannot cache stale category totals', async () => {
  let sourceRevision='sources-1',snapshots=0;
  const p=providers(),original=p.options.getSnapshots;
  p.options.categoryRevision=async()=>sourceRevision;
  p.options.getSnapshots=options=>{snapshots++;if(snapshots===1)sourceRevision='sources-2';return original(options).then(rows=>{rows[0].productOrders[0].units=snapshots===1?2:9;return rows;});};
  const reader=create(p.options),options={from:'2026-09-22',to:'2026-09-22'};
  const units=report=>report.series.find(row=>row.typeId==='a').points[0].orderedUnits;
  assert.equal(units(await reader.read(options)),2);
  assert.equal(units(await reader.read(options)),9);
  assert.equal(units(await reader.read(options)),9);
  assert.equal(snapshots,2);
});

test('reader without a revision provider also starts independent cold reads together', async () => {
  let releaseRegistry,snapshotsStarted=false;
  const p=providers({
    productTypes:{read:()=>new Promise(resolve=>{releaseRegistry=()=>resolve(registry)})},
    async getSnapshots(){snapshotsStarted=true;return[];}
  }),request=create(p.options).read({from:'2026-09-22',to:'2026-09-22'});
  await Promise.resolve();
  assert.equal(snapshotsStarted,true);
  releaseRegistry();await request;
});

test('report cache invalidates on source, taxonomy, store metadata and Moscow day revisions', async () => {
  let sourceRevision='sources-1',taxonomy=registry,clock=Date.parse('2026-09-23T00:00:00Z'),snapshots=0,storeName='SQL store';
  const p=providers({async categoryRevision(){return sourceRevision;},productTypes:{async read(){return taxonomy;}},async getStores(){return{s1:{name:storeName}}},async getSnapshots(){snapshots++;return[];},now:()=>clock}),reader=create(p.options),options={from:'2026-09-22',to:'2026-09-22'};
  await reader.read(options);await reader.read(options);assert.equal(snapshots,1);
  sourceRevision='sources-2';await reader.read(options);assert.equal(snapshots,2);
  taxonomy={...registry,revision:'r2'};await reader.read(options);assert.equal(snapshots,3);
  storeName='Renamed';await reader.read(options);assert.equal(snapshots,4);
  clock=Date.parse('2026-09-24T00:00:00Z');await reader.read(options);assert.equal(snapshots,5);
});

test('historical cache ignores current-source churn but invalidates for buyer history and taxonomy', async () => {
  let todayRevision='today-1',buyerRevision='buyer-1',taxonomy=registry,snapshots=0;
  const p=providers({async categoryRevision(options){assert.equal(options.today,'2026-09-23');const includesToday=options.from<=options.today&&options.to>=options.today;return JSON.stringify([buyerRevision,includesToday?todayRevision:null]);},productTypes:{async read(){return taxonomy;}},async getSnapshots(){snapshots++;return[];}}),reader=create(p.options),options={from:'2026-09-22',to:'2026-09-22'};
  await reader.read(options);todayRevision='today-2';await reader.read(options);assert.equal(snapshots,1);
  buyerRevision='buyer-2';await reader.read(options);assert.equal(snapshots,2);
  taxonomy={...registry,revision:'r2'};await reader.read(options);assert.equal(snapshots,3);
});

test('cache does not retain transient failures and recovers on retry', async () => {
  let snapshots=0;
  const p=providers({async categoryRevision(){return 'sources-1';},async getSnapshots(){if(++snapshots===1)throw Error('offline');return[];}}),reader=create(p.options),options={from:'2026-09-22',to:'2026-09-22'};
  await assert.rejects(reader.read(options),/offline/);await reader.read(options);await reader.read(options);assert.equal(snapshots,2);
});

test('source changes during a build prevent that report from entering the cache', async () => {
  let revisions=0,snapshots=0;
  const p=providers({async categoryRevision(){revisions++;return revisions===1?'sources-1':'sources-2';},async getSnapshots(){snapshots++;return[];}}),reader=create(p.options),options={from:'2026-09-22',to:'2026-09-22'};
  await reader.read(options);await reader.read(options);await reader.read(options);assert.equal(snapshots,2);
});

test('completed report cache is bounded to four entries', async () => {
  let snapshots=0;
  const p=providers({async categoryRevision(){return 'sources-1';},async getSnapshots(){snapshots++;return[];}}),reader=create(p.options);
  for(let day=1;day<=5;day++){const date=`2026-09-0${day}`;await reader.read({from:date,to:date});}
  await reader.read({from:'2026-09-01',to:'2026-09-01'});assert.equal(snapshots,6);
});
