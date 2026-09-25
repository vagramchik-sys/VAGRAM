'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createLiveSources, nativeRevision } = require('../storage/postgres-live-sources.cjs');
const { createPostgresLiveRepository } = require('../storage/postgres-live-repository.cjs');
const { ensurePostgresLiveSchema } = require('../storage/postgres-live-schema.cjs');
const { sourceKey } = require('../storage/postgres-document-import.cjs');
const { encodeJson } = require('../storage/postgres-json-repository.cjs');
const codecs = require('../storage/postgres-live-codecs.cjs');
const hash = value => crypto.createHash('sha256').update(encodeJson(value)).digest('hex');
const store = () => BigInt('0x' + crypto.randomBytes(8).toString('hex')).toString();
const hasCode = code => error => error.code === code;

test('bridge validates supported scopes and converts legacy revisions without precision loss', () => {
  assert.equal(nativeRevision('0'), 0); assert.equal(nativeRevision('42'), 42); assert.equal(nativeRevision(42n), 42);
  for (const invalid of ['01', '-1', '', '1e2', Number.MAX_SAFE_INTEGER + 1, '9007199254740993', null, undefined]) assert.throws(() => nativeRevision(invalid), hasCode('INVALID_ARGUMENT'));
  const methods = Object.fromEntries(['publishWithStatus', 'listRows', 'readAtRevision', 'readCommand', 'getHead', 'listHeads'].map(name => [name, async () => null]));
  const sources = createLiveSources({ repository: methods });
  assert.deepEqual(sources.identity('data-wb-17.json'), { storeId: 'wb-17', domain: 'market' });
  assert.deepEqual(sources.identity('order-category-intraday.json'), { storeId: 'all', domain: 'category-intraday' });
  assert.throws(() => sources.document('stores.json'), hasCode('UNSUPPORTED_SOURCE'));
});

test('live revisions fetch supported heads together and leave legacy sources for fallback', async () => {
  const sourcePath = 'costs-1.json', calls = [];
  const methods = Object.fromEntries(['publishWithStatus', 'listRows', 'readAtRevision', 'readCommand', 'getHead', 'listHeads'].map(name => [name, async () => { calls.push(name); throw Error('unexpected'); }]));
  methods.listHeads = async () => {
    calls.push('listHeads');
    return [{ domain: 'costs', storeId: '1', revision: 7, sourceMetadata: { sourcePath, logicalKey: sourceKey(sourcePath) } }];
  };
  const revisions = await createLiveSources({ repository: methods }).revisions(['costs-1.json', 'costs-2.json', 'prices-1.json']);
  assert.deepEqual([...revisions], [['costs-1.json', '7'], ['costs-2.json', '0']]);
  assert.deepEqual(calls, ['listHeads']);
});

test('bridge validates and detaches requested JSON before database work', async () => {
  let calls = 0;
  const methods = Object.fromEntries(['publishWithStatus', 'listRows', 'readAtRevision', 'readCommand', 'getHead', 'listHeads'].map(name => [name, async () => { calls++; return null; }]));
  const doc = createLiveSources({ repository: methods }).document('costs-1.json', { validate: () => { throw new Error('private payload'); } });
  await assert.rejects(doc.compareAndSet({ items: [] }, { expectedRevision: '0', commandId: 'first' }), error => error.code === 'INVALID_DOCUMENT' && !error.message.includes('private'));
  assert.equal(calls, 0);
});

test('current projected collections share one repository read and preserve decoding', async () => {
  const sourcePath = 'buyer-order-segments-2026-09-22_2026-09-22.json';
  const value = {
    version: 2, period: {from: '2026-09-22', to: '2026-09-22'}, scope: 'all-ozon-stores', status: 'collected', generatedAt: '2026-09-22T12:00:00.000Z',
    records: [{id: 'one'}], productOrders: [{postingId: 'p', productId: '1'}], report: {coverage: {sources: [{storeId: '1'}]}}, errors: []
  };
  const encoded = codecs.encode(sourcePath, value), calls = [];
  const head = {revision: 4, metadata: encoded.metadata, sourceMetadata: {sourcePath, logicalKey: sourceKey(sourcePath)}, entityCounts: Object.fromEntries(Object.entries(encoded.collections).map(([type, rows]) => [type, rows.length]))};
  const methods = Object.fromEntries(['publishWithStatus', 'listRows', 'readAtRevision', 'readCommand', 'getHead', 'listHeads'].map(name => [name, async () => { calls.push(name); throw Error('unexpected'); }]));
  methods.readCurrentCollections = async input => {
    calls.push(['current', input.entityTypes]);
    return {head, collections: Object.fromEntries(input.entityTypes.map(type => [type, (encoded.collections[type] || []).map(row => ({entityType:type,entityKey:row.key,occurrence:0,businessDay:row.day,sourceOrder:row.ordinal,value:row.value,revision:4}))]))};
  };
  const loaded = await createLiveSources({repository: methods}).record(sourcePath, {entities: ['records', 'productOrders', 'report.coverage.sources']});
  assert.deepEqual(loaded.value, value);
  assert.deepEqual(calls, [['current', ['records', 'productOrders', 'report.coverage.sources']]]);
});

test('batched current projections share one repository bundle and preserve source order', async () => {
  const values=[{sourcePath:'costs-1.json',value:{items:[{product_id:1}]}},{sourcePath:'insights-1.json',value:{orders:{daily:[{date:'2026-09-22',revenue:10,units:1}]},errors:[]}}];
  const encoded=values.map(row=>({...row,encoded:codecs.encode(row.sourcePath,row.value)})),calls=[];
  const methods=Object.fromEntries(['publishWithStatus','listRows','readAtRevision','readCommand','getHead','listHeads'].map(name=>[name,async()=>{throw Error('unexpected')}])) ;
  methods.readCurrentBundles=async requests=>{
    calls.push(requests);
    return requests.map((request,index)=>{
      const item=encoded[index],head={revision:index+1,metadata:item.encoded.metadata,sourceMetadata:{sourcePath:item.sourcePath,logicalKey:sourceKey(item.sourcePath)},entityCounts:Object.fromEntries(Object.entries(item.encoded.collections).map(([type,rows])=>[type,rows.length]))};
      return {head,collections:Object.fromEntries(request.entityTypes.map(type=>[type,(item.encoded.collections[type]||[]).map(row=>({entityType:type,entityKey:row.key,occurrence:0,businessDay:row.day,sourceOrder:row.ordinal,value:row.value,revision:index+1}))]))};
    });
  };
  const sources=createLiveSources({repository:methods}),result=await sources.records([{sourcePath:'costs-1.json',entities:['items']},{sourcePath:'insights-1.json',entities:['orders.daily','errors']}]);
  assert.deepEqual(result.map(row=>row.value),values.map(row=>row.value));
  assert.deepEqual(calls,[[{storeId:'1',domain:'costs',entityTypes:['items']},{storeId:'1',domain:'insights',entityTypes:['orders.daily','errors']}]]);
});

test('live source bridge PostgreSQL CAS and journal compatibility', { skip: !process.env.PULT_TEST_DATABASE_URL }, async t => {
  const { Pool } = require('pg'), pool = new Pool({ connectionString: process.env.PULT_TEST_DATABASE_URL, max: 5 });
  t.after(() => pool.end()); await ensurePostgresLiveSchema(pool);
  const repository = createPostgresLiveRepository({ pool }), sources = createLiveSources({ repository });

  await t.test('current collections use exact keyset pages, verify EOF and preserve historical parity', async () => {
    const sourcePath=`data-${store()}.json`,doc=sources.document(sourcePath),value={products:Array.from({length:10001},(_,index)=>({product_id:'duplicate',price:index}))};
    await doc.compareAndSet(value,{expectedRevision:'0',commandId:crypto.randomUUID()});
    const pages=[],traced=createLiveSources({repository:{...repository,async listRows(input){pages.push(input);return repository.listRows(input)}}});
    assert.deepEqual((await traced.record(sourcePath)).value,value);
    assert.deepEqual(pages.map(page=>page.after?.sourceOrder),[undefined,9999]);
    assert.equal(pages[1].after.occurrence,9999);
    assert.ok(pages.every(page=>page.includeTotal===false&&page.offset===undefined&&page.expectedRevision===1));
    let understatedPages=0;
    const understated=createLiveSources({repository:{...repository,async getHead(input){const head=structuredClone(await repository.getHead(input));head.entityCounts.products=10000;return head},async listRows(input){understatedPages++;return repository.listRows(input)}}});
    await assert.rejects(understated.record(sourcePath),hasCode('CORRUPT_DOCUMENT'));
    assert.equal(understatedPages,2,'a full first page must not hide undeclared extra rows');
    const exact={products:value.products.slice(0,10000)};
    await doc.compareAndSet(exact,{expectedRevision:'1',commandId:crypto.randomUUID()});
    pages.length=0;
    assert.deepEqual((await traced.record(sourcePath)).value,exact);
    assert.deepEqual(pages.map(page=>page.after?.sourceOrder),[undefined,9999],'exact page boundary requires an empty EOF page');
    assert.ok(pages.every(page=>page.expectedRevision===2));
    pages.length=0;
    assert.deepEqual((await traced.record(sourcePath,{revision:'1'})).value,value);
    assert.equal(pages.length,0,'historical reconstruction keeps its original readAtRevision path');
  });

  await t.test('removed arrays, null and empty collections decode from markers after later writes', async () => {
    const sourcePath = `data-${store()}.json`, doc = sources.document(sourcePath), firstId = crypto.randomUUID(), secondId = crypto.randomUUID();
    const first = { status: 'one', products: [{ product_id: 1, price: 0 }, { product_id: 1, price: 0 }], stocks: [], operations: [{ operation_id: 1, amount: 3 }] };
    const second = { status: 'two', products: null, stocks: [] };
    const third = { status: 'three', products: [{ product_id: 4 }], operations: [], categoryTree: [] };
    assert.equal(await doc.read(), null);
    assert.deepEqual(await doc.compareAndSet(first, { commandId: firstId, expectedRevision: '0' }), { revision: '1', replayed: false });
    assert.deepEqual(await doc.compareAndSet(second, { commandId: secondId, expectedRevision: '1' }), { revision: '2', replayed: false });
    assert.deepEqual((await doc.read()).value, second);
    const absentRead = await sources.record(sourcePath, { entities: ['products', 'operations', 'categoryTree'] });
    assert.deepEqual(absentRead.value, second, 'requesting absent or null arrays never synthesizes collections');
    await doc.compareAndSet(third, { commandId: crypto.randomUUID(), expectedRevision: 2n });
    assert.deepEqual((await doc.read()).value, third);
    assert.deepEqual(await doc.compareAndSet(second, { commandId: secondId, expectedRevision: '1' }), { revision: '2', replayed: true });
    assert.deepEqual(await doc.compareAndSet(first, { commandId: firstId, expectedRevision: '0' }), { revision: '1', replayed: true });
    const replay = await doc.readCommand(secondId);
    assert.deepEqual(replay.before, { revision: '1', absent: false, deleted: false, value: first, sha256: hash(first) });
    assert.deepEqual(replay.after, { revision: '2', absent: false, deleted: false, value: second, sha256: hash(second) });
    assert.deepEqual((await doc.readCommand(firstId)).before, { revision: '0', absent: true, deleted: false, value: null, sha256: null });
    await assert.rejects(doc.compareAndSet({ ...second, status: 'changed' }, { commandId: secondId, expectedRevision: '1' }), hasCode('COMMAND_ID_REUSED'));
    await assert.rejects(doc.compareAndSet(third, { commandId: crypto.randomUUID(), expectedRevision: '1' }), hasCode('REVISION_CONFLICT'));
    assert.deepEqual((await sources.record(sourcePath, { revision: '1' })).value, first);
    const stored = await pool.query('SELECT receipt FROM pult_live.commands WHERE store_id=$1', [sources.identity(sourcePath).storeId]);
    assert.equal(JSON.stringify(stored.rows).includes('"product_id"'), false);
  });

  await t.test('concurrent identical commands return exactly one fresh publication', async () => {
    const doc = sources.document(`costs-${store()}.json`), options = { expectedRevision: '0', commandId: crypto.randomUUID() }, value = { items: [{ product_id: 'a', cost: 1 }] };
    const results = await Promise.all([doc.compareAndSet(value, options), doc.compareAndSet(value, options)]);
    assert.deepEqual(results.map(result => result.replayed).sort(), [false, true]);
    assert.deepEqual(results.map(result => result.revision), ['1', '1']);
  });

  await t.test('partial nested collection reads and original import hashes remain coherent', async () => {
    const sourcePath = `insights-${store()}.json`, value = { status: 'ready', types: [{ id: '1' }], orders: { daily: [{ date: '2026-01-01', count: 1 }], skuDaily: [{ date: '2026-01-01', sku: 2 }], skuCoverage: ['2'] }, errors: [] };
    const encoded = codecs.encode(sourcePath, value), scope = sources.identity(sourcePath);
    await repository.importComplete({ ...scope, commandId: crypto.randomUUID(), expectedRevision: 0, metadata: encoded.metadata,
      sourceMetadata: { sourcePath, logicalKey: sourceKey(sourcePath), sourceSha256: 'a'.repeat(64) },
      partitions: Object.entries(encoded.collections).map(([entityType, rows]) => ({ entityType, scope: { kind: 'all' }, rows: rows.map(row => ({ entityKey: row.key, businessDay: row.day, sourceOrder: row.ordinal, value: row.value })) })) });
    const loaded = await sources.record(sourcePath);
    assert.deepEqual(loaded.value, value); assert.equal(loaded.sha256, hash(value)); assert.notEqual(loaded.sha256, loaded.head.sourceMetadata.sourceSha256);
    const partial = await sources.record(sourcePath, { entities: ['orders.daily'] });
    assert.deepEqual(partial.value.orders.daily, value.orders.daily); assert.deepEqual(partial.value.orders.skuDaily, []); assert.deepEqual(partial.value.types, []);
    assert.equal((await sources.listSources()).some(row => row.sourcePath === sourcePath), true);
  });

  await t.test('missing fact rows fail integrity instead of silently shrinking an array', async () => {
    const sourcePath = `costs-${store()}.json`, doc = sources.document(sourcePath);
    await doc.compareAndSet({ items: [{ product_id: 1 }] }, { commandId: crypto.randomUUID(), expectedRevision: '0' });
    await pool.query('DELETE FROM pult_live.facts WHERE store_id=$1', [sources.identity(sourcePath).storeId]);
    await assert.rejects(doc.read(), hasCode('CORRUPT_DOCUMENT'));
  });
});
