'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {createCategoryOrderSources,PATH_PATTERN,RECORD_FIELDS,PRODUCT_FIELDS} = require('../storage/postgres-category-order-sources.cjs');
const {build} = require('../order-category-daily.cjs');

test('category source selection keeps base/partial paths and excludes retry documents', () => {
 const pattern = new RegExp(PATH_PATTERN);
 assert.ok(pattern.test('buyer-order-segments-2026-09-01_2026-09-03.json'));
 assert.ok(pattern.test('buyer-order-segments-2026-09-01_2026-09-03.partial.json'));
 assert.ok(!pattern.test('buyer-order-segments-2026-09-01_2026-09-03-retry-1.json'));
 assert.ok(!pattern.test('buyer-product-segments-2026-09-01_2026-09-03.json'));
});

test('projected sources preserve report order, tombstones, null revenue, coverage and equal-stamp winners', async () => {
 const registry = {schemaVersion:1,revision:'r1',reviewedAt:'2026-09-20T10:00:00Z',types:[{id:'a',parentId:null,name:'A'}],assignments:{'1:1':{typeId:'a',source:'reviewed',evidence:null},'1:2':{typeId:'a',source:'reviewed',evidence:null}},rules:[]};
 const catalogs = [{storeId:'1',market:'Ozon',products:[{product_id:1},{product_id:2}]}];
 const base = {market:'Ozon',storeId:'1',scheme:'FBO',postingId:'p',productId:'1',orderedAt:'2026-09-01T21:00:00Z',units:1,amountRub:10,updatedAt:'2026-09-03T12:00:00Z'};
 const coverage = ['FBO','FBS'].map(scheme=>({market:'Ozon',storeId:'1',scheme,available:true,complete:true,requested:{from:'2026-09-01',to:'2026-09-03'}}));
 const snapshots = [
  {generatedAt:'2026-09-03T12:00:00Z',records:[{market:'Ozon',storeId:'1',scheme:'FBO',createdAt:base.orderedAt,unused:'large'}],productOrders:[base,{...base,postingId:'other',productId:'2',amountRub:null}],report:{coverage:{sources:coverage}}},
  {generatedAt:'2026-09-03T12:00:00Z',records:[],productOrders:[{...base,orderedAt:'2026-09-04T10:00:00Z'},{...base,postingId:'other',productId:'2',units:3,amountRub:null},{...base,postingId:'later',orderId:'fallback',productId:'1',units:5}],report:{coverage:{sources:[]}}}
 ];
 const paths = ['buyer-order-segments-2026-09-01_2026-09-03.json','buyer-order-segments-2026-09-02_2026-09-03.partial.json'];
 const encode = (rows,fields) => rows.map(row=>fields.map(field=>row[field] ?? null));
 const queryRows = snapshots.map((snapshot,index)=>({source_path:paths[index],revision:'1',generated_at:snapshot.generatedAt,records:encode(snapshot.records,RECORD_FIELDS),products:encode(snapshot.productOrders,PRODUCT_FIELDS),sources:snapshot.report.coverage.sources})).reverse();
 const options={from:'2026-09-01',to:'2026-09-03',now:'2026-09-20T10:00:00Z',classifiedAt:'2026-09-20T10:00:00Z'};
 const getSnapshots=createCategoryOrderSources({pool:{async query(sql,params){assert.deepEqual(params,[options.from,options.to,PATH_PATTERN,'{}']);return{rows:queryRows};}}});
 const projected = await getSnapshots(options);
 for (const filter of [{},{market:'Ozon'},{market:'WB'},{store:'1'}]) {
  assert.deepEqual(build({registry,catalogs,snapshots:projected},{...options,...filter}),build({registry,catalogs,snapshots},{...options,...filter}));
 }
 const report=build({registry,catalogs,snapshots:projected},options);
 assert.equal(report.byProduct[0].productId,'2','out-of-period winner removes older product 1 without changing the remaining insertion order');
 assert.equal(report.byProduct[0].points[1].orderedRevenue,null);
});

test('invalid periods fail before SQL and database failures propagate', async () => {
 let calls=0;
 const read=createCategoryOrderSources({pool:{async query(){calls++;throw Error('offline');}}});
 await assert.rejects(read({from:'2026-02-30',to:'2026-03-01'}),/period/);
 await assert.rejects(read({from:'2026-03-02',to:'2026-03-01'}),/period/);
 assert.equal(calls,0);
 await assert.rejects(read({from:'2026-03-01',to:'2026-03-02'}),/offline/);
});

test('each read checks SQL revisions and only unchanged sources reuse projected rows', async () => {
 const path='buyer-order-segments-2026-09-01_2026-09-03.json';
 let revision='1',calls=0;
 const read=createCategoryOrderSources({pool:{async query(sql,params){
  calls++;
  const known=JSON.parse(params[3]),cached=known[path]===revision;
  return {rows:[{source_path:path,revision,generated_at:'2026-09-03',records:cached?null:[],products:cached?null:[['Ozon','1','FBO','p',null,'1','2026-09-02',null,Number(revision),null]],sources:cached?null:[]}]};
 }}});
 const period={from:'2026-09-01',to:'2026-09-03'};
 const first=await read(period),second=await read(period);
 assert.equal(calls,2);assert.equal(second[0],first[0]);
 revision='2';const third=await read(period);
 assert.notEqual(third[0],first[0]);assert.equal(third[0].productOrders[0].units,2);
});
