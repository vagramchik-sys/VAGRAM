'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { createOzonSnapshotCollector } = require('../storage/acquisition/postgres-ozon-snapshot.cjs');
const response = (status, value, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: name => headers[name] ?? null }, async json() { return value; } });
const fixed = () => new Date('2026-09-22T10:00:00.000Z');

test('SQL API handles every Ozon section without Node fetch or duplicate unknown retry',async()=>{
 let productCalls=0;
 const api=Object.assign(async(_store,_key,route)=>{if(route==='/v3/product/list'){productCalls++;throw Object.assign(Error('private'),{code:'NETWORK_ERROR'})}if(route==='/v1/description-category/tree')return{result:[]};if(route==='/v4/product/info/stocks')return{result:{items:[]}};if(route==='/v1/finance/accrual/by-day')return{accruals:[]};throw Error('Unexpected route')},{usesDatabaseCredentials:true});
 const collector=createOzonSnapshotCollector({api,fetchFn:async()=>{assert.fail('Node HTTP must not run')},sleep:async()=>{},now:fixed});
 assert.equal(collector.usesDatabaseCredentials,true);
 const result=await collector.collect({store:{name:'Synthetic',clientId:'1'},key:'postgresql-managed'});
 assert.equal(result.status,'partial');assert.equal(productCalls,1);assert.equal(JSON.stringify(result).includes('private'),false);
});

test('Ozon collector preserves section semantics, prior categories and sanitizes failures', async () => {
  let productPage = 0;
  const fetchFn = async (url, options) => {
    assert.equal(options.headers['Api-Key'], 'plain-secret');
    if (url.endsWith('/v3/product/list')) { productPage++; return response(200, { result: { items: [{ product_id: 1 }], total: 999, last_id: 'same' } }); }
    if (url.endsWith('/v1/description-category/tree')) throw new Error('plain-secret leaked');
    if (url.endsWith('/v4/product/info/stocks')) return response(200, { result: { items: [] } });
    if (url.endsWith('/v1/finance/accrual/by-day')) return response(200, { accruals: [] });
    throw Error(`unexpected ${url}`);
  };
  const collector = createOzonSnapshotCollector({ fetchFn, sleep: async () => {}, now: fixed });
  const result = await collector.collect({ store: { name: 'S', clientId: '1' }, key: 'plain-secret', previousSnapshot: { categoryTree: [{ id: 'old' }] } });
  assert.equal(result.status, 'partial'); assert.equal(productPage, 2);
  assert.deepEqual(result.snapshot.categoryTree, [{ id: 'old' }]);
  assert.equal(JSON.stringify(result).includes('plain-secret'), false);
  assert.equal(result.snapshot.sections.products.error, 'Ozon product pagination did not complete');
});

test('Ozon transport honors bounded retry cooldown without exposing credentials', async () => {
  let calls = 0; const waits = [];
  const fetchFn = async url => { calls++; if (calls === 1) return response(500, {}); if (url.endsWith('/v3/product/list')) return response(200, { result: { items: [] } }); if (url.endsWith('/v1/description-category/tree')) return response(200, { result: [] }); if (url.endsWith('/v4/product/info/stocks')) return response(200, { result: { items: [] } }); return response(200, { accruals: [] }); };
  const result = await createOzonSnapshotCollector({ fetchFn, sleep: async ms => waits.push(ms), now: fixed }).collect({ store: { name: 'S', clientId: '1' }, key: 'secret' });
  assert.equal(result.status, 'done'); assert.equal(waits[0], 2000); assert.ok(calls > 30);
});
