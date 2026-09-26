'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{create,categoryScope}=require('../dist/business-dynamics-client.js');
const response=()=>({ok:true,json:async()=>({version:1,stores:[]})});
test('concurrent scope requests deduplicate; successful result expires and metric changes need no new call',async()=>{let calls=0,now=0;const client=create({now:()=>now,ttl:30,fetcher:async()=>{calls++;return response()}}),scope={date:'2026-09-24'};const [a,b]=await Promise.all([client.read(scope),client.read(scope)]);assert.equal(a,b);await client.read(scope);assert.equal(calls,1);now=31;await client.read(scope);assert.equal(calls,2);await client.read({...scope,market:'WB'});assert.equal(calls,3);});
test('failed requests are retryable and never become zero or cached success',async()=>{let calls=0;const client=create({fetcher:async()=>{calls++;return calls===1?{ok:false,json:async()=>({error:'SQL timeout'})}:response()}});await assert.rejects(client.read({date:'2026-09-24'}),/SQL timeout/);await client.read({date:'2026-09-24'});assert.equal(calls,2);});
test('timeout aborts network request and releases pending cache',async()=>{let signal;const client=create({timeout:5,fetcher:async(url,args)=>{signal=args.signal;return new Promise(()=>{})}});await assert.rejects(client.read({date:'2026-09-24'}),/вовремя/);assert.equal(signal.aborted,true);});
test('response contract is verified before display; marketplace/store encoded',async()=>{let url;const client=create({fetcher:async path=>{url=path;return {ok:true,json:async()=>({})}}});await assert.rejects(client.read({date:'2026-09-24',market:'Wildberries',store:'wb-1'}),/формат/);assert.match(url,/market=WB&store=wb-1/);});
test('category summary loads independently, deduplicates and retries failures',async()=>{
 let calls=0,now=0;const client=create({now:()=>now,ttl:30,fetcher:async path=>{calls++;assert.match(path,/\/api\/business-dynamics\/categories\?date=2026-09-24&market=WB/);return calls===1?{ok:false,json:async()=>({error:'busy'})}:{ok:true,json:async()=>({date:'2026-09-24',rows:[],knownTotal:null})}}});
 const scope={date:'2026-09-24',market:'Wildberries'};
 await assert.rejects(client.readCategories(scope),/busy/);
 const [a,b]=await Promise.all([client.readCategories(scope),client.readCategories(scope)]);assert.equal(a,b);assert.equal(calls,2);
 await client.readCategories(scope);assert.equal(calls,2);now=31;await client.readCategories(scope);assert.equal(calls,3);
});
test('category summary scope follows the visible marketplace instead of the background payload',()=>{
 const allStores=[{id:'o1',market:'Ozon'},{id:'o2',market:'Ozon'},{id:'wb-1',market:'WB'}];
 const scope=visibleStores=>categoryScope({allStores,visibleStores,market:'all',store:''});
 assert.deepEqual(scope(allStores),{market:'all',store:''});
 assert.deepEqual(scope([allStores[0],allStores[1]]),{market:'Ozon',store:''});
 assert.deepEqual(scope([allStores[2]]),{market:'WB',store:'wb-1'});
 assert.deepEqual(scope([allStores[1]]),{market:'Ozon',store:'o2'});
 assert.equal(scope([allStores[0],allStores[2]]),null);
 assert.equal(scope([]),null);
});
