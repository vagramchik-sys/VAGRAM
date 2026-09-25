'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createPostgresB2BRadarRepository,RADAR_SQL,MAX_DAILY_PRODUCTS}=require('../storage/postgres-b2b-radar.cjs');
const {create,periods}=require('../storage/domains/postgres-b2b-radar.cjs');

const CURRENT={from:'2026-09-18',to:'2026-09-24'},PREVIOUS={from:'2026-09-11',to:'2026-09-17'};
const amountFields={amountRub:'150.25',notCancelledAmountRub:'100.25',legalAmountRub:'100.25',individualAmountRub:'50',unknownAmountRub:'0',legalNotCancelledAmountRub:'100.25',individualNotCancelledAmountRub:null,unknownNotCancelledAmountRub:'0'};
function product(period='current'){return {kind:'product',payload:{market:'Ozon',storeId:'1',productId:'10',sku:'sku-10',name:'Товар',category:'Категория',period,grossUnits:'5',notCancelledUnits:'4',legalUnits:'3',legalNotCancelledUnits:'3',individualUnits:'2',individualNotCancelledUnits:'1',unknownUnits:'0',unknownNotCancelledUnits:'0',orderCount:'2',legalOrderCount:'1',cancelledUnits:'1',cancellationUnknownUnits:'0',...amountFields,daily:[{date:period==='current'?'2026-09-18':'2026-09-11',grossUnits:'5',notCancelledUnits:'4',legalUnits:'3',legalNotCancelledUnits:'3',individualUnits:'2',individualNotCancelledUnits:'1',unknownUnits:'0',unknownNotCancelledUnits:'0',orderCount:'2',legalOrderCount:'1',cancelledUnits:'1',cancellationUnknownUnits:'0',...amountFields}],productCount:1}};}

test('repository checks source revisions, aggregates bounded SKU buckets and reuses unchanged results',async()=>{
 const calls=[],pool={async query(sql,values){calls.push({sql,values});if(sql.includes('revision_key'))return{rows:[{revision_key:'buyers/1/1|market/1/1'}]};return{rows:[product(),product('previous'),{kind:'summary',payload:{period:'current',orderCount:'2',legalOrderCount:'1',daily:[{date:'2026-09-18',grossUnits:'5',notCancelledUnits:'4',legalUnits:'3',legalNotCancelledUnits:'3',individualUnits:'2',individualNotCancelledUnits:'1',unknownUnits:'0',unknownNotCancelledUnits:'0',orderCount:'2',legalOrderCount:'1',cancelledUnits:'1',cancellationUnknownUnits:'0',...amountFields}]}},{kind:'summary',payload:{period:'previous',orderCount:'2',legalOrderCount:'1',daily:[]}},{kind:'count',payload:{productCount:1}}]}}};
 const repository=createPostgresB2BRadarRepository({pool}),options={currentPeriod:CURRENT,previousPeriod:PREVIOUS,market:'Ozon',storeId:'1'};
 const value=await repository.read(options);
 assert.equal(calls.length,2);assert.equal(calls[1].values.length,9);assert.equal(calls[1].values[8],MAX_DAILY_PRODUCTS);assert.doesNotMatch(calls[1].sql,/\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/iu);
 assert.match(calls[1].sql,/DISTINCT ON \(p\.market,p\.store_id,p\.scheme,p\.order_id,p\.product_id\)/u);assert.match(calls[1].sql,/left\(f\.value->>'orderedAt',10\) BETWEEN/u);assert.doesNotMatch(calls[1].sql,/entity_type='records'/u);
 assert.match(calls[1].sql,/f\.value->>'orderedAt' AS ordered_at/u);assert.doesNotMatch(calls[1].sql,/SELECT f\.value,s\.source_path/u);assert.match(calls[1].sql,/GROUP BY GROUPING SETS \(\(period,order_day\),\(period\)\)/u);
 assert.match(calls[1].sql,/f\.domain='market' AND f\.entity_type='products'/u);assert.match(calls[1].sql,/category_nodes\(store_id,value\)/u);
 assert.equal(value.rows.length,1);assert.equal(value.rows[0].metrics.current.totalUnits,5);assert.equal(value.rows[0].metrics.current.notCancelledUnits,4);assert.equal(value.rows[0].metrics.current.individualUnits,2);assert.equal(value.rows[0].metrics.current.individualNotCancelledUnits,1);assert.equal(value.rows[0].metrics.current.legalAmountRub,100.25);assert.equal(value.rows[0].metrics.current.individualNotCancelledAmountRub,null);assert.equal(value.rows[0].metrics.current.daily.length,1);assert.equal(value.summary.current.legalOrderCount,1);assert.equal(value.summary.current.daily[0].orderCount,2);assert.equal(value.summary.current.daily[0].individualNotCancelledUnits,1);
 assert.match(calls[1].sql,/count\(DISTINCT \(market,store_id,scheme,order_id\)\) FILTER\(WHERE cancelled=false\)/u);
 assert.strictEqual(await repository.read(options),value);assert.equal(calls.length,3);
});

test('repository exposes product cardinality above its bounded analyzed rows',async()=>{
 const pool={async query(sql){return sql.includes('revision_key')?{rows:[{revision_key:'1'}]}:{rows:[product(),{kind:'count',payload:{productCount:2}}]}}};
 const result=await createPostgresB2BRadarRepository({pool,maxProducts:1}).read({currentPeriod:CURRENT,previousPeriod:PREVIOUS});assert.equal(result.productCount,2);assert.equal(result.rows.length,1);
});

test('repository invalidates its report when a buyer or catalog revision changes',async()=>{
 let revision='buyers/1/1|market/1/1',aggregateQueries=0;
 const pool={async query(sql){if(sql.includes('revision_key'))return{rows:[{revision_key:revision}]};aggregateQueries++;return{rows:[product(),{kind:'count',payload:{productCount:1}}]}}};
 const repository=createPostgresB2BRadarRepository({pool}),options={currentPeriod:CURRENT,previousPeriod:PREVIOUS};
 await repository.read(options);await repository.read(options);assert.equal(aggregateQueries,1);
 revision='buyers/1/2|market/1/1';await repository.read(options);assert.equal(aggregateQueries,2);
 revision='buyers/1/2|market/1/2';await repository.read(options);assert.equal(aggregateQueries,3);
});

test('domain computes equal previous period, conservative coverage and bounded output',async()=>{
 const source=(from,to,complete=true)=>({value:{market:'Ozon',storeId:'1',scheme:'FBO',available:true,complete,from,to,fetchedAt:to+'T12:00:00Z'}}),seen=[];
 const repository={async read(input){seen.push(input);return{rows:Array.from({length:3},(_,index)=>({...product().payload,productId:String(index),metrics:{current:{totalUnits:1,notCancelledUnits:1,legalUnits:1,legalNotCancelledUnits:1,individualUnits:0,unknownUnits:0,orderCount:1,legalOrderCount:1,cancelledUnits:0,cancellationUnknownUnits:0,amountRub:10,notCancelledAmountRub:10,daily:[]},previous:{totalUnits:1,notCancelledUnits:1,legalUnits:1,legalNotCancelledUnits:1,individualUnits:0,unknownUnits:0,orderCount:1,legalOrderCount:1,cancelledUnits:0,cancellationUnknownUnits:0,amountRub:10,notCancelledAmountRub:10,daily:[]}}})),summary:{current:{legalOrderCount:2},previous:{legalOrderCount:2}},sources:[source(CURRENT.from,CURRENT.to,false),source(PREVIOUS.from,PREVIOUS.to),{value:{market:'Ozon',storeId:'1',scheme:'FBS',available:true,complete:true,from:PREVIOUS.from,to:CURRENT.to}}]};}};
 const analyze=input=>({meta:{total:input.productCount,analyzed:input.rows.length,truncated:input.productCount>input.rows.length},products:input.rows,categories:[],opportunities:[],coverage:input.coverage,kpis:{},zones:{},trend:[],quality:{}}),service=create({repository,getStores:async()=>({'1':{name:'Ozon'}}),analyze});
 const result=await service.read({...CURRENT,market:'Ozon',limit:2,offset:1});
 assert.deepEqual(periods(CURRENT.from,CURRENT.to),{current:CURRENT,previous:PREVIOUS});assert.deepEqual(seen[0].previousPeriod,PREVIOUS);assert.equal(result.status,'partial');assert.equal(result.coverage.current.complete,false);assert.equal(result.coverage.previous.complete,true);assert.equal(result.products.length,2);assert.equal(result.meta.total,3);assert.equal(result.meta.analyzed,3);assert.equal(result.meta.truncated,false);assert.equal(result.meta.offset,1);
});

test('domain preserves declared cardinality and pages only inside the analyzed hard cap',async()=>{
 const rows=Array.from({length:3},(_,index)=>({market:'Ozon',storeId:'1',productId:String(index),metrics:{current:{},previous:{}}})),repository={async read(){return{rows,productCount:6001,summary:{},sources:[]}}},analyze=input=>({meta:{total:input.productCount,analyzed:input.rows.length,truncated:input.productCount>input.rows.length},products:input.rows,categories:[],opportunities:[],coverage:input.coverage,kpis:{},zones:{},trend:[],quality:{}}),service=create({repository,getStores:async()=>({'1':{name:'Ozon'}}),analyze});
 const result=await service.read({...CURRENT,offset:2,limit:2});assert.deepEqual(result.meta,{total:6001,analyzed:3,truncated:true,limit:2,offset:2,returned:1,categoryTotal:0});assert.equal(result.products.length,1);
 await assert.rejects(service.read({...CURRENT,offset:3,limit:2}),error=>error.code==='INVALID_ARGUMENT');
});

test('domain validates period, scope and pagination before SQL',async()=>{
 const service=create({repository:{read:async()=>{throw Error('unexpected')}},getStores:async()=>({'1':{}}),analyze:value=>value});
 await assert.rejects(service.read({from:'2026-02-30',to:'2026-03-01'}),error=>error.code==='INVALID_PERIOD');
 await assert.rejects(service.read({...CURRENT,market:'WB',storeId:'1'}),error=>error.code==='INVALID_STORE');
 await assert.rejects(service.read({...CURRENT,limit:501}),error=>error.code==='INVALID_ARGUMENT');
});
