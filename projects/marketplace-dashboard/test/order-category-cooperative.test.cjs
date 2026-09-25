'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {build, buildAsync} = require('../order-category-daily.cjs');
const options = {from: '2026-09-22', to: '2026-09-23', now: '2026-09-23T10:00:00Z', classifiedAt: '2026-09-23T10:00:00Z'};
function fixture(count = 1) {
  const registry = {schemaVersion: 1, revision: 'r1', reviewedAt: options.now, types: [{id: 'a', parentId: null, name: 'A'}], assignments: {'s:1': {typeId:'a', source:'reviewed', evidence:null}, 'w:1': {typeId:'a', source:'reviewed', evidence:null}}, rules:[]};
  const row = {market:'Ozon', storeId:'s', scheme:'FBO', productId:'1', orderedAt:'2026-09-21T21:00:00Z', updatedAt:'2026-09-23T00:00:00Z', units:2, amountRub:10};
  const productOrders = Array.from({length:count}, (_,i) => ({...row, postingId:String(i)}));
  // A newer record outside the requested range must suppress its older row.
  productOrders.push({...row,postingId:'0',orderedAt:'2026-09-24T00:00:00Z',updatedAt:'2026-09-24T00:00:00Z'});
  return {registry, catalogs:[{storeId:'s',market:'Ozon',name:'One',products:[{product_id:1}]},{storeId:'w',market:'WB',name:'Two',products:[{nmID:1}]}], snapshots:[{generatedAt:options.now,productOrders,records:[],report:{coverage:{sources:[{market:'Ozon',storeId:'s',scheme:'FBO',available:true,complete:true,requested:{from:options.from,to:options.to}}]}}}], insights:{}, wbOrders:{w:{complete:true,day:'2026-09-23',orders:[{nmId:1,amount:null},{nmId:1,amount:25}]}}};
}
test('cooperative calculation preserves full output across markets, stores and current-day fallback', async () => {
  const input=fixture(1100), before=structuredClone(input);
  for (const filter of [{},{market:'Ozon'},{market:'WB'},{store:'s'},{store:'w'},{from:'2026-09-23'}]) {
    const opts={...options,...filter};
    assert.deepEqual(await buildAsync(input,opts),build(input,opts));
  }
  assert.deepEqual(input,before);
});
test('cooperative large report yields to other event-loop callbacks before completing', async () => {
  const input=fixture(30000); let serviced=false;
  setImmediate(()=>{serviced=true;});
  const pending=buildAsync(input,options);
  assert.equal(serviced,false);
  const result=await pending;
  assert.equal(serviced,true,'short UI work can run while the report is being calculated');
  assert.deepEqual(result,build(input,options));
});
test('cooperative validation errors reject and do not affect subsequent calculations', async () => {
  await assert.rejects(buildAsync(fixture(),{...options,from:'invalid'}),/период/);
  assert.deepEqual(await buildAsync(fixture(),options),build(fixture(),options));
});
