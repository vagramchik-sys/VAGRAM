'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const create = require('../storage/domains/postgres-category-sales.cjs');
const options = { now: '2026-09-18T12:00:00Z', from: '2026-09-15', to: '2026-09-17', category: 'c' };
test('reader awaits SQL stores/products/categories and per-market facts without changing null coverage', async () => { const calls = []; const service = create({ async getStores() { return [{ id: 'oz', name: 'O', market: 'Ozon' }, { id: 'wb', name: 'W', market: 'WB' }]; }, async getProducts() { return [{ key: 'oz:1', storeId: 'oz', sku: '1' }, { key: 'wb:2', storeId: 'wb', product_id: '2' }]; }, async getCategories() { return [{ id: 'c', name: 'C', productKeys: ['oz:1', 'wb:2'] }]; }, async getOzonLedger(id) { calls.push('oz:' + id); return { version: 3, complete: true, period: { from: options.from, to: options.to }, completedAt: '2026-09-18T00:00:00Z', daily: [], skuDaily: [] }; }, async getWbFinance(id) { calls.push('wb:' + id); return { period: { from: options.from, to: options.to }, sections: { finance: { ok: true } }, completedAt: '2026-09-18T00:00:00Z', operations: [] }; } }); const result = await service.read(options); assert.deepEqual(calls.sort(), ['oz:oz', 'wb:wb']); assert.equal(result.productCount, 2); assert.equal(result.totals.total, null); assert.equal(result.coverage.complete, false); });
test('invalid store provider rows fail closed and never call external writers', async () => { let calls = 0; const service = create({ async getStores() { return [{ id: 'x', market: 'Other' }]; }, async getProducts() { return []; }, async getCategories() { return []; }, async getOzonLedger() { calls++; }, async getWbFinance() { calls++; } }); await assert.rejects(service.read(options), /Invalid store/u); assert.equal(calls, 0); });
test('reader uses the optional SQL product type registry for parent category selection', async () => {
 const registry={schemaVersion:1,revision:'types-1',reviewedAt:'2026-09-20T11:00:00Z',types:[{id:'root',parentId:null,name:'Товары'},{id:'leaf',parentId:'root',name:'Саморезы'}],assignments:{'oz:1':{typeId:'leaf',source:'reviewed'}},rules:[]};
 let reads=0;
 const service=create({async getStores(){return[{id:'oz',name:'O',market:'Ozon'}]},async getProducts(){return[{key:'oz:1',storeId:'oz',sku:'1',name:'Саморезы'}]},async getCategories(){return[]},async getOzonLedger(){return{version:3,complete:true,period:{from:options.from,to:options.to},daily:[],skuDaily:[{date:'2026-09-15',sku:'1',values:{soldUnits:2,salesRows:1}}]}},async getWbFinance(){throw Error('unused')},productTypes:{async read(){reads++;return registry}}});
 const result=await service.read({...options,category:'type:root'});
 assert.equal(reads,1);assert.equal(result.productCount,1);assert.deepEqual(result.series[0].Ozon,{sold:2,returned:0,net:2});assert.equal(result.taxonomyRevision,'types-1');
});
test('reader unwraps a version 3 ledger document and rejects malformed wrapper data', async () => {
 const ledger={version:3,complete:true,period:{from:options.from,to:options.to},daily:[],skuDaily:[{date:'2026-09-15',sku:'1',values:{soldUnits:2,salesRows:1}}]},wrapper={source:{snapshotId:'snapshot-1'},data:ledger};
 const createService=value=>create({async getStores(){return[{id:'oz',name:'O',market:'Ozon'}]},async getProducts(){return[{key:'oz:1',storeId:'oz',sku:'1'}]},async getCategories(){return[{id:'c',name:'C',productKeys:['oz:1']}]},async getOzonLedger(){return value},async getWbFinance(){throw Error('unused')}});
 const result=await createService(wrapper).read(options);
 assert.deepEqual(result.series[0].Ozon,{sold:2,returned:0,net:2});
 for(const malformed of [{...wrapper,data:{...ledger,version:2}},{...wrapper,data:null},{...wrapper,version:3,data:{}}]){
  const rejected=await createService(malformed).read(options);assert.equal(rejected.coverage.coveredDays,0);assert.equal(rejected.totals.Ozon,null);
 }
});
