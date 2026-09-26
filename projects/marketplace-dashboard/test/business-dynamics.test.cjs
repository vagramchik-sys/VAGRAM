'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createBusinessDynamics}=require('../storage/domains/postgres-business-dynamics.cjs');
const {createBusinessDynamicsRepository,SQL,TARGET_SQL,SAVE_TARGET_SQL}=require('../storage/postgres-business-dynamics-repository.cjs');
const {point}=require('../intraday.cjs');
const NOW=Date.parse('2026-09-24T09:07:00Z'),DATE='2026-09-24';
const stores={'1':{name:'Первый',market:'Ozon'},'2':{name:'Второй'},'wb-1':{name:'Третий',market:'WB'}};
const head=(store_id,domain,value)=>({kind:'head',store_id,domain,value});
const daily=(date,revenue,units)=>({kind:'daily',store_id:'1',value:{date,revenue,units}});
const ozonHead=(extra={})=>head('1','insights',{orders:{period:{from:'2026-08-27',to:DATE},todayDate:DATE,updatedAt:'2026-09-24T09:05:00Z',historyUpdatedAt:'2026-09-24T08:30:00Z',...extra},orderSection:{ok:true}});
const observed=(date,at,revenue=100,complete=false)=>({kind:'observation',store_id:'1',value:{date,at,source:'orders',values:{orderedRevenue:Math.round(revenue*100),orderedUnits:2},...(complete?{complete:true,coverage:{from:new Date(date+'T00:00:00+03:00').toISOString(),to:at}}:{})}});
function fixture(rows=[],clock=NOW,targets=new Map()){const calls=[],targetCalls=[];const service=createBusinessDynamics({repository:{async read(args){calls.push(args);return rows},async readTarget(args){targetCalls.push(args);return targets.get(`${args.date}:${args.scopeType}:${args.scopeId}`)||null}},storesRepository:{async read(){return stores}},now:()=>clock});return {service,calls,targetCalls};}
const getDay=(result,id='1',date=DATE)=>result.stores.find(s=>s.id===id).days.find(d=>d.date===date);

test('one bounded bulk read covers Moscow today and exactly 28 preceding dates, even at UTC midnight boundary',async()=>{
 const {service,calls}=fixture([],Date.parse('2026-09-24T21:02:00Z')),result=await service.read();
 assert.deepEqual(result.period,{from:'2026-08-28',to:'2026-09-25'});assert.equal(calls.length,1);assert.deepEqual(calls[0],{storeIds:['1','2','wb-1'],...result.period});
 assert.equal(result.stores.length,3);assert.ok(result.stores.every(s=>s.days.length===29));assert.deepEqual(result.events,[]);
 assert.equal(result.stores[0].name,'Первый');assert.equal(result.stores[1].market,'Ozon');
 assert.ok(result.stores.every(s=>s.days.every(d=>d.totals.orderedRevenue===null&&d.intervals.length===0&&!d.complete)));
});

test('Ozon daily totals and cumulative observations never become 15-minute order-time sales',async()=>{
 const rows=[ozonHead(),daily(DATE,135,3),daily('2026-09-23',200,4),observed(DATE,'2026-09-24T09:00:00Z',100,true)];
 const result=await fixture(rows).service.read(),today=getDay(result),yesterday=getDay(result,'1','2026-09-23');
 assert.equal(today.basis,'observation');assert.deepEqual(today.intervals,[]);assert.equal(today.complete,false);assert.equal(today.observations.length,1);assert.equal(today.observations[0].orderedRevenue,135);assert.equal(today.observations[0].complete,true);
 assert.deepEqual(today.coverage,{from:'2026-09-23T21:00:00.000Z',to:'2026-09-24T09:05:00.000Z',intervalsComplete:0});
 assert.equal(yesterday.complete,true);assert.equal(yesterday.totals.orderedRevenue,200);assert.equal(yesterday.updatedAt,'2026-09-24T08:30:00.000Z');
 assert.equal(result.stores[0].sources[1].updatedAt,'2026-09-24T09:00:00.000Z','intraday timestamp must not borrow the later head observation');
});

test('legacy points remain visible but cannot certify cumulative coverage or missing daily totals',async()=>{
 const result=await fixture([ozonHead(),observed('2026-09-23','2026-09-23T12:00:00Z',100)]).service.read(),old=getDay(result,'1','2026-09-23'),today=getDay(result);
 assert.equal(old.observations.length,1);assert.equal(old.observations[0].complete,false);assert.equal(old.complete,false);assert.equal(old.totals.orderedRevenue,null);assert.equal(old.coverage.from,null);
 assert.equal(today.totals.orderedRevenue,null);assert.equal(today.basis,'unavailable');assert.deepEqual(today.observations,[]);
});

test('today-only refresh and missing historical timestamp cannot falsely close yesterday',async()=>{
 for(const historyUpdatedAt of [null,'2026-09-23T20:55:00Z']){
  const result=await fixture([ozonHead({historyUpdatedAt}),daily('2026-09-23',100,1)]).service.read(),old=getDay(result,'1','2026-09-23');
  assert.equal(old.complete,false);assert.equal(old.updatedAt,historyUpdatedAt?new Date(historyUpdatedAt).toISOString():null);
 }
});

test('confirmed historical cumulative points stay partial days and future/mismatched coverage is rejected',async()=>{
 const date='2026-09-23',rows=[observed(date,'2026-09-23T12:00:00Z',100,true),observed(date,'2026-09-24T09:00:00Z',999,true),observed(DATE,'2026-09-24T12:00:00Z',999,true)];
 const result=await fixture(rows).service.read(),old=getDay(result,'1',date);assert.equal(old.complete,false);assert.equal(old.totals.orderedRevenue,100);assert.equal(old.coverage.to,'2026-09-23T12:00:00.000Z');assert.deepEqual(getDay(result).observations,[]);
 rows[0].value.coverage.from='2026-09-23T09:00:00Z';const bad=getDay(await fixture(rows).service.read(),'1',date);assert.equal(bad.totals.orderedRevenue,null);assert.equal(bad.observations[0].complete,false);
});

test('observation response stays at most 96 actual points per store/day without inventing slot timestamps',async()=>{
 const date='2026-09-23',ms=Date.parse(date+'T00:00:00+03:00'),rows=Array.from({length:288},(_,i)=>observed(date,new Date(ms+i*5*60000).toISOString(),i,true));
 const day=getDay(await fixture(rows).service.read(),'1',date);assert.equal(day.observations.length,96);assert.equal(day.observations[0].at,'2026-09-22T21:10:00.000Z');assert.equal(day.observations.at(-1).at,'2026-09-23T20:55:00.000Z');assert.equal(day.complete,false);
});

function wbRows(extra={}){return [head('wb-1','wb-orders',{day:DATE,fetchedAt:'2026-09-24T09:07:00Z',complete:true,orderedRevenue:30.3,orderedUnits:3,orderRowsPresent:true,orderRowsCount:3,...extra}),
 {kind:'wb-interval',store_id:'wb-1',value:{from:'2026-09-23T21:00:00.000Z',firstAt:'2026-09-23T21:00:00Z',lastAt:'2026-09-23T21:14:59.999Z',orderedRevenue:10.1,orderedUnits:1}},
 {kind:'wb-interval',store_id:'wb-1',value:{from:'2026-09-23T21:15:00.000Z',firstAt:'2026-09-23T21:15:00Z',lastAt:'2026-09-23T21:15:00Z',orderedRevenue:20.2,orderedUnits:2}}];}

test('WB slots reconcile amounts/units, respect 15-minute and Moscow boundaries, and expose partial current slot',async()=>{
 const day=getDay(await fixture(wbRows()).service.read(),'wb-1');assert.equal(day.basis,'order-time');assert.equal(day.complete,false);assert.equal(day.intervals.length,49);assert.equal(day.coverage.intervalsComplete,48);
 assert.equal(day.intervals[0].orderedRevenue,10.1);assert.equal(day.intervals[1].orderedRevenue,20.2);assert.equal(day.intervals[2].orderedRevenue,0);assert.equal(day.intervals.at(-1).status,'partial');
 assert.equal(day.intervals.at(-1).complete,false);assert.equal(day.coverage.to,'2026-09-24T09:07:00.000Z');assert.equal(day.totals.orderedRevenue,30.3);assert.equal(day.totals.orderCount,null);
});

test('WB missing, inconsistent, incomplete and future snapshots cannot turn into zero-filled intervals',async()=>{
 for(const patch of [{complete:false},{orderRowsPresent:false},{orderRowsCount:4},{orderedRevenue:40},{orderedUnits:4},{fetchedAt:'2026-09-24T09:08:00Z'}]){
  const day=getDay(await fixture(wbRows(patch)).service.read(),'wb-1');assert.equal(day.totals.orderedRevenue,null);assert.deepEqual(day.intervals,[]);
 }
 const rows=wbRows();rows[2].value.lastAt='2026-09-24T09:08:00Z';assert.deepEqual(getDay(await fixture(rows).service.read(),'wb-1').intervals,[]);
});

test('an explicitly imported empty WB day is zero only until its real source timestamp',async()=>{
 const rows=[head('wb-1','wb-orders',{day:DATE,fetchedAt:'2026-09-23T21:15:00Z',complete:true,orderedRevenue:0,orderedUnits:0,orderRowsPresent:true,orderRowsCount:0})];
 const day=getDay(await fixture(rows).service.read(),'wb-1');assert.equal(day.totals.orderedRevenue,0);assert.equal(day.intervals.length,1);assert.equal(day.intervals[0].complete,true);assert.equal(day.complete,false);
 const historical=getDay(await fixture(rows).service.read(),'wb-1','2026-09-23');assert.equal(historical.basis,'unavailable');assert.equal(historical.totals.orderedRevenue,null);
 rows[0].value.fetchedAt='2026-09-24T21:00:00Z';const closed=getDay(await fixture(rows,Date.parse('2026-09-24T21:01:00Z')).service.read(),'wb-1');assert.equal(closed.complete,true);assert.equal(closed.intervals.length,96);
});

test('historical WB order events restore yesterday without summing old snapshots or borrowing today',async()=>{
 const date='2026-09-23',from='2026-09-22T21:00:00.000Z';
 const rows=[...wbRows(),
  {kind:'wb-history-head',store_id:'wb-1',value:{day:date,fetchedAt:'2026-09-24T07:30:00Z',complete:true,orderedRevenue:15,orderedUnits:2,orderRowsPresent:true,orderRowsCount:2}},
  {kind:'wb-history-interval',store_id:'wb-1',value:{day:date,from,firstAt:'2026-09-22T21:01:00Z',lastAt:'2026-09-22T21:10:00Z',orderedRevenue:15,orderedUnits:2}}];
 const result=await fixture(rows).service.read(),yesterday=getDay(result,'wb-1',date),today=getDay(result,'wb-1');
 assert.equal(yesterday.basis,'order-time');assert.equal(yesterday.complete,true);
 assert.equal(yesterday.totals.orderedRevenue,15);assert.equal(yesterday.intervals.length,96);
 assert.equal(today.totals.orderedRevenue,30.3);
 rows[4].value.orderedRevenue=16;
 assert.equal(getDay(await fixture(rows).service.read(),'wb-1',date).basis,'unavailable','reconciliation must reject inconsistent historical buckets');
});

test('scope validation rejects bad dates and stores before SQL and never silently falls back to all stores',async()=>{
 const f=fixture();for(const options of [{date:'2026-02-30'},{date:'2026-09-25'},{storeId:'1 OR TRUE'},{storeId:'999'},{market:'other'},{storeId:'1',market:'WB'}])await assert.rejects(f.service.read(options));
 assert.equal(f.calls.length,0);const result=await f.service.read({storeId:'wb-1',market:'WB'});assert.deepEqual(f.calls[0].storeIds,['wb-1']);assert.equal(result.stores.length,1);
});

test('sales target is returned only for the exact requested all, marketplace or store scope',async()=>{
 const all={date:DATE,scope:{type:'all'},amountCents:12345,currency:'RUB',timeZone:'Europe/Moscow',updatedAt:'2026-09-24T08:00:00.000Z'};
 const targets=new Map([[`${DATE}:all:`,all],[`${DATE}:marketplace:WB`,{...all,scope:{type:'marketplace',marketplace:'WB'},amountCents:20000}],[`${DATE}:store:wb-1`,{...all,scope:{type:'store',storeId:'wb-1'},amountCents:30000}]]);
 let f=fixture([],NOW,targets),result=await f.service.read();assert.deepEqual(result.target,all);assert.deepEqual(f.targetCalls,[{date:DATE,scopeType:'all',scopeId:''}]);
 f=fixture([],NOW,targets);result=await f.service.read({market:'WB'});assert.equal(result.target.amountCents,20000);assert.deepEqual(f.targetCalls[0],{date:DATE,scopeType:'marketplace',scopeId:'WB'});
 f=fixture([],NOW,targets);result=await f.service.read({storeId:'wb-1',market:'WB'});assert.equal(result.target.amountCents,30000);assert.deepEqual(f.targetCalls[0],{date:DATE,scopeType:'store',scopeId:'wb-1'});
 f=fixture([],NOW,targets);result=await f.service.read({market:'Ozon'});assert.equal(result.target,null);assert.deepEqual(f.targetCalls[0],{date:DATE,scopeType:'marketplace',scopeId:'Ozon'});
});

test('repository makes one parameterized bounded statement and selects only latest WB history snapshot per day',async()=>{
 const calls=[],repository=createBusinessDynamicsRepository({pool:{async query(sql,params){calls.push({sql,params});return {rows:[]}}}});
 await repository.read({storeIds:['1','2','wb-1'],from:'2026-08-27',to:DATE});assert.equal(calls.length,1);assert.deepEqual(calls[0].params,[['1','2','wb-1'],'2026-08-27',DATE]);
 assert.match(SQL,/store_id=ANY\(\$1::text\[\]\)/);assert.match(SQL,/business_day BETWEEN \$2::date AND \$3::date/);assert.match(SQL,/entity_type='orders.daily'/);assert.match(SQL,/entity_type='points'/);assert.match(SQL,/entity_type='orders'/);assert.match(SQL,/floor\(extract\(epoch/);assert.match(SQL,/SELECT DISTINCT ON \(s.store_id,s.day\)/u);assert.match(SQL,/pult_history\.order_events/u);assert.doesNotMatch(SQL,/record_journal|SELECT \*/i);
 for(const args of [{storeIds:['1'],from:'2020-01-01',to:DATE},{storeIds:['1','1'],from:'2026-08-27',to:DATE}])await assert.rejects(repository.read(args));assert.equal(calls.length,1);
 await repository.read({storeIds:[],from:'2026-08-27',to:DATE});assert.equal(calls.length,1);
});

test('repository reads one exact indexed sales target and preserves integer cents',async()=>{
 const calls=[],pool={async query(sql,params){calls.push({sql,params});return {rows:[{business_day:DATE,scope_type:'marketplace',scope_id:'WB',amount_cents:'12345',currency:'RUB',time_zone:'Europe/Moscow',updated_at:'2026-09-24T08:00:00Z'}]}}},repository=createBusinessDynamicsRepository({pool});
 assert.deepEqual(await repository.readTarget({date:DATE,scopeType:'marketplace',scopeId:'WB'}),{date:DATE,scope:{type:'marketplace',marketplace:'WB'},amountCents:12345,currency:'RUB',timeZone:'Europe/Moscow',updatedAt:'2026-09-24T08:00:00.000Z'});
 assert.equal(calls.length,1);assert.equal(calls[0].sql,TARGET_SQL);assert.deepEqual(calls[0].params,[DATE,'marketplace','WB']);assert.match(TARGET_SQL,/WHERE business_day=\$1::date AND scope_type=\$2 AND scope_id=\$3/u);
 for(const args of [{date:'2026-02-30',scopeType:'all',scopeId:''},{date:DATE,scopeType:'marketplace',scopeId:'all'},{date:DATE,scopeType:'store',scopeId:'bad'}])await assert.rejects(repository.readTarget(args));
 assert.equal(calls.length,1);
});

test('daily plan save validates Moscow today and writes integer cents through one parameterized upsert',async()=>{
 const writes=[],writePool={async query(sql,params){writes.push({sql,params});return {rows:[{business_day:DATE,amount_cents:params[1],currency:'RUB',time_zone:'Europe/Moscow',updated_at:'2026-09-24T09:07:00Z'}]}}};
 const repository=createBusinessDynamicsRepository({pool:{query:async()=>({rows:[]})},writePool});
 const service=createBusinessDynamics({repository,storesRepository:{read:async()=>stores},now:()=>NOW});
 const saved=await service.saveTarget({date:DATE,amountRub:'15000000.25'});
 assert.equal(saved.amountCents,1500000025);assert.equal(saved.scope.type,'all');
 assert.equal(writes.length,1);assert.equal(writes[0].sql,SAVE_TARGET_SQL);assert.deepEqual(writes[0].params,[DATE,'1500000025']);
 assert.match(SAVE_TARGET_SQL,/ON CONFLICT \(business_day,scope_type,scope_id\) DO UPDATE/u);
 for(const input of [{date:'2026-09-23',amountRub:'100'},{date:DATE,amountRub:'0'},{date:DATE,amountRub:'1.001'},{date:DATE,amountRub:'1e9'},{date:DATE,amountRub:'-1'}])await assert.rejects(service.saveTarget(input));
 assert.equal(writes.length,1);
});

test('missing optional target table leaves dashboard available, other SQL failures surface',async()=>{
 const argumentsForTarget={date:DATE,scopeType:'all',scopeId:''};
 const missing=createBusinessDynamicsRepository({pool:{async query(){throw Object.assign(new Error('table missing'),{code:'42P01'});}}});
 assert.equal(await missing.readTarget(argumentsForTarget),null);
 const unavailable=createBusinessDynamicsRepository({pool:{async query(){throw Object.assign(new Error('database unavailable'),{code:'08006'});}}});
 await assert.rejects(unavailable.readTarget(argumentsForTarget),{code:'08006'});
});

test('new capture records explicit coverage, but missing or duplicate day rows never certify it',()=>{
 const data={period:{from:DATE,to:DATE},updatedAt:'2026-09-24T09:05:00Z',daily:[{date:DATE,revenue:0,units:0}]};
 const valid=point('orders',data);assert.equal(valid.complete,true);assert.deepEqual(valid.coverage,{from:'2026-09-23T21:00:00.000Z',to:'2026-09-24T09:05:00.000Z'});
 assert.equal(point('orders',{...data,daily:[]}).complete,false);assert.equal(point('orders',{...data,daily:[...data.daily,...data.daily]}).complete,false);
 assert.equal(point('orders',{...data,updatedAt:'2026-09-24T21:00:00Z'}),null);
});
