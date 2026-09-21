'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const create=require('../insights-sync.cjs'),{point}=require('../intraday.cjs');
const base=Date.parse('2026-09-18T09:00:00Z'),today='2026-09-18';
const row=(date,revenue,units=1,sku='101')=>({dimensions:[{id:sku},{id:date}],metrics:[revenue,units]});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function settled(client){
 const deadline=Date.now()+5000;
 while(Object.values(client.status()).some(job=>job.status==='running')){
  assert.ok(Date.now()<deadline,'background refresh did not finish');await tick();
 }
 for(const job of Object.values(client.status()))assert.equal(job.status,'done',JSON.stringify(job));
}
function fixture(t,handler){
 const parent=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(parent,'pult-order-refresh-'));let time=base;
 const calls=[],file=path.join(dir,'insights-1.json');
 const options={stores:{1:{market:'Ozon',key:'fixture'}},privateDir:dir,protect:async()=> 'fixture',now:()=>time,sleep:async ms=>{time+=ms},api:async(s,k,endpoint,payload)=>{calls.push({endpoint,payload,at:time});return handler?handler(endpoint,payload,file):endpoint.includes('types')?{accrual_types:[]}:{result:{data:[row(today,100),...(payload.date_from===today?[]:[row('2026-09-17',80)])]}}}};
 t.after(()=>{assert.equal(path.dirname(path.resolve(dir)),parent);assert.ok(path.basename(dir).startsWith('pult-order-refresh-'));fs.rmSync(dir,{recursive:true,force:true})});
 return {client:create(options),options,calls,file,advance:ms=>{time+=ms},set:value=>{time=Date.parse(value)}};
}
test('today refresh waits ten minutes, preserves history and leaves the 30-minute full schedule intact',async t=>{
 const f=fixture(t);await f.client.sync('1');const original=f.client.read('1');
 assert.equal(f.calls.length,2);assert.equal(f.client.schedule('1').orders.nextAt,'2026-09-18T09:10:00.000Z');assert.equal(f.client.schedule('1').full.nextAt,'2026-09-18T09:30:00.000Z');
 f.advance(599999);f.client.ensure();await settled(f.client);assert.equal(f.calls.length,2);
 f.advance(1);f.client.ensure();await settled(f.client);assert.equal(f.calls.length,3);assert.equal(f.calls[2].payload.date_from,today);assert.equal(f.calls[2].payload.date_to,today);
 const result=f.client.read('1');assert.deepEqual(result.orders.daily,original.orders.daily);assert.equal(result.orders.historyUpdatedAt,original.orders.updatedAt);assert.equal(result.completedAt,original.completedAt);assert.equal(result.orders.updatedAt,'2026-09-18T09:10:00.000Z');
 f.advance(20*60000);f.client.ensure();await settled(f.client);assert.equal(f.calls.length,5);assert.equal(f.calls[4].payload.date_from,'2026-07-21');
});
test('a transient Windows snapshot lock retries atomically before API work and retains the job lock',async t=>{
 const f=fixture(t),rename=fs.renameSync;let failures=0;
 fs.renameSync=function(from,to){if(from===f.file+'.tmp'&&failures++<2)throw Object.assign(Error('fixture Windows lock'),{code:'EPERM'});return rename.apply(this,arguments)};
 try{
  const pending=f.client.sync('1');assert.equal(f.client.status()['1'].status,'running');assert.equal(f.calls.length,0);
  await f.client.syncToday('1');await pending;assert.equal(f.client.status()['1'].status,'done');assert.equal(f.calls.length,2);assert.equal(f.client.read('1').orders.daily.length,2);
 }finally{fs.renameSync=rename}
});
test('credential failures are persisted before requesting and survive restarts without immediate retry',async t=>{
 const f=fixture(t);f.options.protect=async()=>{const saved=JSON.parse(fs.readFileSync(f.file));assert.equal(saved.ordersAttemptAt,'2026-09-18T09:00:00.000Z');throw Error('fixture credential error')};
 const first=create(f.options);await first.sync('1');assert.equal(f.calls.length,0);assert.equal(first.read('1').sections.orders.ok,false);
 const restarted=create(f.options);restarted.ensure();await tick();assert.equal(f.calls.length,0);assert.equal(restarted.schedule('1').orders.nextAt,'2026-09-18T09:10:00.000Z');
});
test('today and full requests cannot overlap and share a durable analytics cooldown',async t=>{
 const f=fixture(t);await f.client.sync('1');f.advance(5*60000);let release,entered;
 const waiting=new Promise(resolve=>{entered=resolve});f.options.api=async(s,k,endpoint,payload)=>{f.calls.push({endpoint,payload});entered();return new Promise(resolve=>{release=()=>resolve({result:{data:[row(today,130)]}})})};
 const client=create(f.options),pending=client.syncToday('1');await waiting;await client.sync('1');client.ensure();assert.equal(f.calls.length,3);release();await pending;
 const restarted=create(f.options);await restarted.sync('1');assert.equal(f.calls.length,3);
});
test('failed and malformed responses preserve successful values and are not new intraday observations',async t=>{
 const f=fixture(t);await f.client.sync('1');const original=f.client.read('1').orders;
 f.advance(5*60000);f.options.api=async()=>({result:{data:[row('2026-09-17',999)]}});const client=create(f.options);await client.syncToday('1');
 assert.deepEqual(client.read('1').orders,original);assert.equal(client.read('1').sections.orders.ok,false);assert.equal(point('orders',client.read('1').orders).at,original.updatedAt);
});
test('midnight coverage stays honest, and the next today refresh extends a contiguous period',async t=>{
 let requestedDate;const f=fixture(t,(endpoint,payload)=>{if(endpoint.includes('types'))return {accrual_types:[]};requestedDate=payload.date_to;f.advance(2000);return {result:{data:[row(requestedDate,20)]}}});
 f.set('2026-09-18T20:59:59Z');await f.client.sync('1');assert.equal(f.client.read('1').orders.period.to,'2026-09-18');assert.equal(point('orders',f.client.read('1').orders),null);
 f.advance(5*60000);await f.client.syncToday('1');const orders=f.client.read('1').orders;assert.equal(orders.period.to,'2026-09-19');assert.equal(f.calls.at(-1).payload.date_from,'2026-09-19');assert.equal(point('orders',orders).values.orderedRevenue,2000);
});
test('missing days trigger a full backfill instead of advertising an unqueried gap',async t=>{
 const f=fixture(t);await f.client.sync('1');f.set('2026-09-21T09:00:00Z');await f.client.syncToday('1');
 assert.equal(f.calls.at(-1).payload.date_to,'2026-09-21');assert.notEqual(f.calls.at(-1).payload.date_from,'2026-09-21');assert.equal(f.client.status()['1'].mode,'full');
});
test('429 retry-after blocks both schedules and manual requests across restart',async t=>{
 const f=fixture(t);await f.client.sync('1');f.advance(10*60000);f.options.api=async()=>{throw Object.assign(Error('Ozon 429'),{status:429,retryAfterMs:15*60000})};
 const client=create(f.options);await client.syncToday('1');assert.equal(client.schedule('1').orders.nextAt,'2026-09-18T09:25:00.000Z');
 let requests=0;f.options.api=async()=>{requests++;throw Error('must not request')};const restarted=create(f.options);f.advance(10*60000);restarted.ensure();await restarted.sync('1');await restarted.syncToday('1');await tick();assert.equal(requests,0);
});

test('429 without Retry-After pauses analytics for at least the ten-minute orders interval',async t=>{
 const f=fixture(t);await f.client.sync('1');f.advance(10*60000);f.options.api=async()=>{throw Object.assign(Error('Ozon 429'),{status:429})};
 const client=create(f.options);await client.syncToday('1');assert.equal(client.read('1').analyticsRetryAt,'2026-09-18T09:20:00.000Z');assert.equal(client.schedule('1').orders.nextAt,'2026-09-18T09:20:00.000Z');
 let requests=0;f.options.api=async()=>{requests++;return {result:{data:[]}}};f.advance(10*60000-1);const restarted=create(f.options);restarted.ensure();await tick();assert.equal(requests,0);
});

test('supplemental funnel uses orders priority, one page per job and the durable analytics gate',async t=>{
 const f=fixture(t);let requested=0,accepted=0;
 f.options.funnel={due:()=>true,request:()=>{requested++;return {dimension:['sku'],metrics:['ordered_units','hits_view_pdp','hits_tocart_pdp'],limit:1000,offset:0}},accept:()=>{accepted++},fail:()=>assert.fail('unexpected funnel failure')};
 const client=create(f.options);client.ensure();await settled(client);assert.equal(requested,0);assert.equal(f.calls.length,2);
 f.advance(61000);client.ensure();await settled(client);assert.equal(requested,1);assert.equal(accepted,1);assert.equal(f.calls.length,3);assert.equal(f.calls.at(-1).payload.dimension[0],'sku');
 const restarted=create(f.options);await restarted.syncFunnel('1');assert.equal(requested,1);
 f.advance(539000);restarted.ensure();await settled(restarted);assert.equal(requested,1);assert.deepEqual(f.calls.at(-1).payload.dimension,['sku','day']);
});

test('supplemental 429 backs off orders too without changing last successful orders or leaking upstream errors',async t=>{
 const f=fixture(t);await f.client.sync('1');const orders=f.client.read('1').orders;let failure;
 f.options.funnel={due:()=>true,request:()=>({dimension:['sku']}),accept:()=>assert.fail('must fail'),fail:(id,reason)=>{failure=reason}};
 f.options.api=async()=>{throw Object.assign(Error('upstream-secret 429'),{status:429,retryAfterMs:10*60000})};f.advance(61000);
 const client=create(f.options);await client.syncFunnel('1');assert.equal(failure.status,429);assert.equal(failure.message,undefined);assert.deepEqual(client.read('1').orders,orders);assert.equal(client.read('1').analyticsRetryAt,'2026-09-18T09:11:01.000Z');
 assert.equal(fs.readFileSync(f.file,'utf8').includes('upstream-secret'),false);assert.equal(JSON.stringify(client.status()).includes('upstream-secret'),false);
 let requests=0;f.options.api=async()=>{requests++;throw Error('must not request')};f.advance(5*60000);const restarted=create(f.options);restarted.ensure();await restarted.syncFunnel('1');await restarted.syncToday('1');await tick();assert.equal(requests,0);
});

test('funnel holds the same job lock so orders and supplemental pages cannot overlap',async t=>{
 const f=fixture(t);await f.client.sync('1');f.advance(61000);let release,entered;
 const waiting=new Promise(resolve=>{entered=resolve});
 f.options.funnel={due:()=>true,request:()=>({dimension:['sku']}),accept:()=>{},fail:()=>assert.fail('unexpected failure')};
 f.options.api=async()=>{entered();return new Promise(resolve=>{release=()=>resolve({result:{data:[]}})})};
 const client=create(f.options),pending=client.syncFunnel('1');await waiting;assert.equal(client.status()['1'].mode,'funnel');await client.syncToday('1');await client.syncFunnel('1');release();await pending;assert.equal(client.status()['1'].status,'done');
});

test('supplemental analytics does not take the slot immediately before the ten-minute orders refresh',async t=>{
 const f=fixture(t);await f.client.sync('1');let requests=0;
 f.options.funnel={due:()=>true,request:()=>{requests++;return {dimension:['sku']}},accept:()=>{},fail:()=>assert.fail('unexpected failure')};
 f.advance(9*60000);const client=create(f.options);await client.syncFunnel('1');assert.equal(requests,0);
 f.advance(60000);client.ensure();await settled(client);assert.equal(requests,0);assert.deepEqual(f.calls.at(-1).payload.dimension,['sku','day']);assert.equal(client.read('1').orders.updatedAt,'2026-09-18T09:10:00.000Z');
});

test('SKU-day analytics is retained for category snapshots while daily totals stay compatible',async t=>{
 const f=fixture(t,(endpoint,payload)=>endpoint.includes('types')?{accrual_types:[]}:payload.dimension.length===1?{result:{data:[{dimensions:[{id:today}],metrics:[150,3]}]}}:{result:{data:[row(today,100,2,'10'),row(today,50,1,'20')]}});await f.client.sync('1');f.advance(5*60000);await f.client.syncToday('1');
 const orders=f.client.read('1').orders;assert.equal(orders.skuDailyCoverage,true);assert.deepEqual(orders.skuDaily,[{date:today,sku:'10',revenue:100,units:2},{date:today,sku:'20',revenue:50,units:1}]);assert.deepEqual(orders.daily,[{date:today,revenue:150,units:3}]);
});
