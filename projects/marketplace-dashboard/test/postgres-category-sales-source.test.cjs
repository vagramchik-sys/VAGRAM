'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {encode} = require('../storage/postgres-live-codecs.cjs');
const {createPostgresCategorySalesSource, CATEGORY_SALES_SQL, CATEGORY_SALES_REVISION_SQL} = require('../storage/postgres-category-sales-source.cjs');

test('category sales source reconstructs narrow ledgers and market finance in one SQL call', async () => {
  const ozon = {stamp:'x',source:{snapshotId:'s'},data:{version:3,complete:true,period:{from:'2026-09-01',to:'2026-09-30'},completedAt:'2026-10-01T00:00:00Z',daily:[],skuDaily:[],fees:[],currencies:['RUB']}};
  const wb = {completedAt:'2026-10-01T00:00:00Z',period:{from:'2026-09-01',to:'2026-09-30'},sections:{finance:{ok:true}},products:[],stocks:[],operations:[],stockRows:[],categoryTree:[]};
  const calls=[],pool={async query(sql,params){calls.push({sql,params});if(sql===CATEGORY_SALES_REVISION_SQL)return{rows:[{store_id:'1',domain:'ledger',revision:'1'},{store_id:'1',domain:'market',revision:'2'},{store_id:'wb-2',domain:'market',revision:'3'}]};return{rows:[
    {store_id:'1',market:'Ozon',selected:true,market_metadata:encode('data-1.json',{products:[],stocks:[],operations:[],stockRows:[],categoryTree:[]}).metadata,market_source_metadata:{sourcePath:'data-1.json'},finance_metadata:encode('ledger-1.json',ozon).metadata,finance_source_metadata:{sourcePath:'ledger-1.json'},products:[{product_id:10,sku:'100'}],finance_rows:[{date:'2026-09-15',sku:'100',values:{soldUnits:2,salesRows:1}}]},
    {store_id:'wb-2',market:'WB',selected:true,market_metadata:encode('data-wb-2.json',wb).metadata,market_source_metadata:{sourcePath:'data-wb-2.json',sourceSha256:'a'.repeat(64)},finance_metadata:null,finance_source_metadata:null,products:[{nmID:20}],finance_rows:[],wb_invalid_date:false,wb_observed_to:'2026-09-15',wb_daily:[{date:'2026-09-15',nmId:'20',sellerOperName:'Продажа',quantity:3,quantityKnown:true}]}
  ]}}};
  const service=createPostgresCategorySalesSource({pool}),request={stores:[{id:'1',market:'Ozon'},{id:'wb-2',market:'WB'}],selectedIds:new Set(['1','wb-2']),from:'2026-09-15',to:'2026-09-17',allProducts:false};
  const result=await service.read(request);
  assert.equal(calls.length,2);assert.equal(calls[1].sql,CATEGORY_SALES_SQL);assert.equal(calls[1].params[3],false);
  assert.deepEqual(result.products,[{product_id:10,sku:'100',storeId:'1',key:'1:10'},{nmID:20,storeId:'wb-2',key:'wb-2:20'}]);
  assert.equal(typeof result.revision,'string');
  assert.deepEqual(result.facts[0][1].data.skuDaily,[{date:'2026-09-15',sku:'100',values:{soldUnits:2,salesRows:1}}]);
  assert.deepEqual(result.facts[0][1].data.daily,[]);
  assert.deepEqual(result.facts[1][1].operations,[]);
  assert.deepEqual(result.facts[1][1]._categorySales,{invalidDate:false,observedTo:'2026-09-15',rows:[{date:'2026-09-15',nmId:'20',sellerOperName:'Продажа',quantity:3,quantityKnown:true}]});
  result.products[0].sku='changed';const cached=await service.read(request);assert.equal(cached.products[0].sku,'100');assert.equal(calls.length,3);assert.equal(calls[2].sql,CATEGORY_SALES_REVISION_SQL);
});

test('category sales source keeps products for unselected stores but leaves their finance cold', async () => {
  const pool={async query(sql,params){if(sql===CATEGORY_SALES_REVISION_SQL)return{rows:[]};assert.equal(JSON.parse(params[0])[1].selected,false);return{rows:[
    {store_id:'1',market:'Ozon',selected:true,market_metadata:null,market_source_metadata:null,finance_metadata:null,finance_source_metadata:null,products:[],finance_rows:[]},
    {store_id:'wb-2',market:'WB',selected:false,market_metadata:null,market_source_metadata:null,finance_metadata:null,finance_source_metadata:null,products:[{nmID:20}],finance_rows:[]}
  ]}}};
  const result=await createPostgresCategorySalesSource({pool}).read({stores:[{id:'1',market:'Ozon'},{id:'wb-2',market:'WB'}],selectedIds:new Set(['1']),from:'2026-09-15',to:'2026-09-17',allProducts:true});
  assert.deepEqual(result.products,[{nmID:20,storeId:'wb-2',key:'wb-2:20'}]);
  assert.deepEqual(result.facts,[['1',null]]);
});
