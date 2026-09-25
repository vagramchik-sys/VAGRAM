'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createPostgresBuyerAggregates}=require('../storage/postgres-buyer-aggregates.cjs');

test('buyer readers issue one parameterized read-only query; both preserve original rows for exact JS semantics',async()=>{
 const calls=[],pool={async query(sql,values){calls.push({sql,values});return{rows:[]}}},reader=createPostgresBuyerAggregates({pool});
 await reader.order({from:'2026-08-21',to:'2026-09-20',market:'Ozon',storeId:'42'});
 await reader.product({from:'2026-08-21',to:'2026-09-20',market:'WB',storeId:'wb-7'});
 assert.equal(calls.length,2);
 assert.deepEqual(calls[0].values.slice(0,2),['2026-08-21','2026-09-20']);assert.equal(calls[0].values.length,3);
 assert.equal(calls[1].values.length,3);assert.match(calls[1].sql,/json_agg\(ordered\.value\)/u);assert.match(calls[1].sql,/f\.entity_type='productOrders' ORDER BY f\.source_order/u);assert.doesNotMatch(calls[1].sql,/FILTER\(WHERE|round\(|sql:/u);
 for(const call of calls){assert.match(call.sql,/^WITH\s/u);assert.doesNotMatch(call.sql,/\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/iu)}
});

test('buyer readers rebuild ordered document envelopes from SQL rows',async()=>{
 const row={source_path:'buyer-order-segments-2026-09-20_2026-09-20.json',generated_at:'2026-09-20T20:00:00Z',partial:false,records:[{id:'r1'}],products:[{productId:'p1'}],sources:[{market:'Ozon'}]},later={...row,source_path:'buyer-order-segments-2026-09-21_2026-09-21.json'},reader=createPostgresBuyerAggregates({pool:{query:async()=>({rows:[later,row]})}});
 const result=await reader.product({from:'2026-09-20',to:'2026-09-21'});
 assert.deepEqual(result.documents.map(document=>document._sourcePath),[row.source_path,later.source_path]);
 assert.deepEqual(result.documents[0],{_sourcePath:row.source_path,generatedAt:row.generated_at,_partialSource:false,records:row.records,productOrders:row.products,report:{coverage:{sources:row.sources}}});
});
