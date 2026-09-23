'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createPostgresBuyerAggregates}=require('../storage/postgres-buyer-aggregates.cjs');

test('buyer readers issue one parameterized read-only query; both preserve original rows for exact JS semantics',async()=>{
 const calls=[],pool={async query(sql,values){calls.push({sql,values});return{rows:[{payload:{documents:[]}}]}}},reader=createPostgresBuyerAggregates({pool});
 await reader.order({from:'2026-08-21',to:'2026-09-20',market:'Ozon',storeId:'42'});
 await reader.product({from:'2026-08-21',to:'2026-09-20',market:'WB',storeId:'wb-7'});
 assert.equal(calls.length,2);
 assert.deepEqual(calls[0].values.slice(0,2),['2026-08-21','2026-09-20']);assert.equal(calls[0].values.length,3);
 assert.equal(calls[1].values.length,3);assert.match(calls[1].sql,/jsonb_agg\(f\.value ORDER BY f\.source_order\)/u);assert.doesNotMatch(calls[1].sql,/round\(|sql:/u);
 for(const call of calls){assert.match(call.sql,/^WITH\s/u);assert.doesNotMatch(call.sql,/\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/iu)}
});
