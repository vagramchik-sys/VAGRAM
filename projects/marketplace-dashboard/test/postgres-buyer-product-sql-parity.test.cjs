'use strict';

const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {createPostgresBuyerAggregates}=require('../storage/postgres-buyer-aggregates.cjs');
const {create}=require('../storage/domains/postgres-buyer-product-segments.cjs');
const FROM='2026-09-01',TO='2026-09-02';
const enabled=process.env.BUYER_SQL_READ_ONLY_PARITY==='1';

function document(day,units,amountRub){
 const date=`2026-09-0${day}`,orderId=`order-${day}`;
 return {sourcePath:`buyer-order-segments-${date}_${date}.json`,generatedAt:date+'T20:00:00Z',
  records:[{id:orderId,market:'Ozon',storeId:'1',scheme:'FBO',orderKey:orderId,buyerType:'legal'}],
  productOrders:[{market:'Ozon',storeId:'1',scheme:'FBO',orderId,productId:'101',orderedAt:date+'T10:00:00Z',units,amountRub,buyerType:'legal',cancelled:false}],
  report:{coverage:{sources:[{market:'Ozon',storeId:'1',scheme:'FBO',available:true,complete:true,from:date,to:date}]}}};
}

async function compare(t,documents,kind='product'){
 // Opt-in tests execute the actual production SQL over synthetic CTE rows only.
 // A read-only transaction prevents accidental changes to the application DB.
 const {createApplicationPool}=require('../storage/postgres-connection.cjs');
 const pool=await createApplicationPool({bootstrapFile:path.resolve(__dirname,'../.private/postgres-setup/application.dpapi'),profile:'ui'});
 const client=await pool.connect();
 t.after(async()=>{await client.query('ROLLBACK');client.release();await pool.end()});
 await client.query('BEGIN READ ONLY');
 const heads=[],facts=[];
 for(const [index,doc] of documents.entries()){
  const store_id=String(index);
  heads.push({store_id,domain:'buyers',metadata:{generatedAt:doc.generatedAt},source_metadata:{sourcePath:doc.sourcePath}});
  for(const [entity_type,rows] of [['records',doc.records],['productOrders',doc.productOrders],['report.coverage.sources',doc.report.coverage.sources]]){
   (rows||[]).forEach((value,source_order)=>facts.push({store_id,domain:'buyers',entity_type,source_order,value}));
  }
 }
 const fixturePool={query(sql,values){
  const offset=values.length;
  const prefix=`WITH test_heads AS (SELECT * FROM jsonb_to_recordset($${offset+1}::jsonb) AS h(store_id text,domain text,metadata jsonb,source_metadata jsonb)),test_facts AS (SELECT * FROM jsonb_to_recordset($${offset+2}::jsonb) AS f(store_id text,domain text,entity_type text,source_order bigint,value jsonb)),`;
  return client.query(prefix+sql.replace(/^WITH/u,'').replaceAll('pult_live.heads','test_heads').replaceAll('pult_live.facts','test_facts'),[...values,JSON.stringify(heads),JSON.stringify(facts)]);
 }};
 const dependencies={getStores:async()=>({'1':{name:'Fixture'}}),getSnapshot:async()=>null,getSnapshots:async()=>documents,getOrderSnapshots:async()=>documents,getCatalog:async()=>({products:[]})};
 const options={from:FROM,to:TO,market:'all'};
 const builder=kind==='order'?require('../storage/domains/postgres-buyer-order-segments.cjs').create:create;
 const expected=await builder(dependencies).read(options);
 const actual=await builder({...dependencies,getAggregate:createPostgresBuyerAggregates({pool:fixturePool})[kind]}).read(options);
 assert.deepEqual(actual,expected);
 return actual;
}

test('actual product SQL preserves the same SKU from different days',{skip:!enabled},async t=>{
 const result=await compare(t,[document(1,2,200),document(2,3,300)]);
 assert.equal(result.totals.legal.units,5);
 assert.equal(result.totals.legal.amountRub,500);
});

test('actual product SQL preserves original per-row fractional rounding',{skip:!enabled},async t=>{
 const first=document(1,1,0.005),second=document(2,1,0.005);
 // Both amounts belong to one SQL source/bucket, where round(sum(...),2)
 // previously produced 0.01 instead of the original JS result of 0.02.
 first.sourcePath=`buyer-order-segments-${FROM}_${TO}.json`;
 first.productOrders.push(second.productOrders[0]);first.records.push(second.records[0]);
 first.report.coverage.sources[0].to=TO;
 const result=await compare(t,[first]);
 assert.equal(result.totals.legal.amountRub,0.02);
});

function orderDocument(rows){
 const doc=document(1,1,100);
 doc.sourcePath=`buyer-order-segments-${FROM}_${TO}.json`;
 doc.report.coverage.sources[0].to=TO;
 doc.records=rows.map((overrides,index)=>({id:`r-${index}`,orderKey:`o-${index}`,market:'Ozon',storeId:'1',scheme:'FBO',buyerType:'legal',createdAt:FROM+'T10:00:00Z',units:1,cancelled:false,...overrides}));
 return doc;
}

test('actual order SQL rejects zero units through the original reducer',{skip:!enabled},async t=>{
 const result=await compare(t,[orderDocument([{units:0},{}])],'order');
 assert.equal(result.coverage.invalidRecords,1);
 assert.equal(result.coverage.includedRecords,1);
 assert.equal(result.totals.legal.units,1);
});

test('actual order SQL counts missing and null required fields as invalid',{skip:!enabled},async t=>{
 const result=await compare(t,[orderDocument([{orderKey:undefined},{buyerType:null},{createdAt:undefined},{}])],'order');
 assert.equal(result.coverage.invalidRecords,3);
 assert.equal(result.coverage.includedRecords,1);
});

test('actual order SQL preserves Date.parse rejection and accepted timestamp forms',{skip:!enabled},async t=>{
 const result=await compare(t,[orderDocument([{createdAt:'2026-13-01T10:00:00Z'},{createdAt:FROM}])],'order');
 assert.equal(result.coverage.invalidRecords,1);
 assert.equal(result.coverage.includedRecords,1);
 assert.equal(result.totals.legal.units,1);
});

test('actual order SQL skips only the overflowing row and preserves safe totals',{skip:!enabled},async t=>{
 const result=await compare(t,[orderDocument([{units:Number.MAX_SAFE_INTEGER-1},{units:3},{units:1}])],'order');
 assert.equal(result.coverage.invalidRecords,1);
 assert.equal(result.coverage.includedRecords,2);
 assert.equal(result.totals.legal.units,Number.MAX_SAFE_INTEGER);
 assert.equal(result.totals.legal.orders,2);
});
