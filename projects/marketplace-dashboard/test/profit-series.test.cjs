'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {normalizeDaily,create:connectorCreate}=require('../truestats.cjs');
const {aggregate,create}=require('../profit-series.cjs');
const period={from:'2026-09-15',to:'2026-09-16'},catalog=[{id:'profit',header:'Чистая прибыль',meta:{suffix:'₽'}},{id:'tax',header:'Налоги',meta:{suffix:'₽'}},{id:'expense',header:'Операционные расходы',meta:{suffix:'₽'}}];
function fixture(){return {day:{financialMod:false,accountIdsFilter:[17],result:[{date:'2026-09-16',profit:-10,tax:2,expense:3},{date:'2026-09-15',profit:100,tax:5,expense:7}],summary:{profit:90,tax:7,expense:10}},stats:{financialMod:false,stats:{profit:90,tax:7,expense:10},profitDetalization:[{title:'После себестоимости и маркетплейса',amount:107},{title:'Налоги',amount:-7},{title:'Операционные расходы',amount:-10}]},options:{period,accountId:17,readiness:{status:'complete',checkedDate:'2026-09-16',lastDataDate:'2026-09-16'},today:'2026-09-18'}};}
const run=f=>normalizeDaily(f.day,f.stats,catalog,f.options);
test('daily net profit sorts dates, preserves losses and costs, and matches expense breakdown and period KPI',()=>{
 const r=run(fixture());assert.equal(r.complete,true);assert.equal(r.totalProfit,90);assert.equal(r.reconciled,true);assert.equal(r.breakdownReconciled,true);assert.deepEqual(r.points.map(p=>[p.date,p.profit,p.tax,p.operatingExpenses]),[['2026-09-15',100,5,7],['2026-09-16',-10,2,3]]);
});
test('a partial current day never becomes final net profit, including nonzero values',()=>{
 const f=fixture();f.options.today='2026-09-16';const r=run(f);assert.equal(r.points[1].status,'pending');assert.equal(r.points[1].profit,null);assert.equal(r.totalProfit,null);assert.equal(r.knownProfit,100);
});
test('unknown readiness and dates after last received finance remain gaps',()=>{
 const f=fixture();f.options.readiness=null;assert.equal(run(f).knownProfit,null);f.options.readiness={status:'pending',checkedDate:'2026-09-16',lastDataDate:'2026-09-15'};const r=run(f);assert.equal(r.points[0].profit,100);assert.equal(r.points[1].profit,null);assert.equal(r.status,'partial');
});
test('missing days are not zero while a confirmed numeric zero remains valid',()=>{
 const f=fixture();f.day.result.pop();const missing=run(f);assert.equal(missing.points[0].status,'unavailable');assert.equal(missing.points[0].profit,null);assert.equal(missing.totalProfit,null);
 const z=fixture();z.day.result[1].profit=0;z.day.summary.profit=-10;z.stats.stats.profit=-10;z.stats.profitDetalization=[];assert.equal(run(z).points[0].profit,0);
});
test('different account, duplicate days, unknown profit semantics and reconciliation errors fail closed',()=>{
 for(const change of [f=>f.day.accountIdsFilter.push(18),f=>f.day.result.push({...f.day.result[0]}),f=>f.day.result[0].date='2026-09-17',f=>f.day.summary.profit=200,f=>f.stats.stats.profit=200,f=>f.stats.profitDetalization[0].amount=500]){const f=fixture();change(f);assert.throws(()=>run(f));}
 const f=fixture();assert.throws(()=>normalizeDaily(f.day,f.stats,[],f.options),/определение/);
});
test('a missing day does not bypass conflicting period totals or an invalid expense breakdown',()=>{
 for(const change of [f=>{f.stats.stats.profit=-500;f.stats.profitDetalization=[];},f=>{f.stats.profitDetalization[0].amount=500;}]){
  const f=fixture();f.day.result.pop();change(f);assert.throws(()=>run(f),error=>error.code==='reconciliation');
 }
});
test('all-store totals never sum only the available stores or present partial days as full period',()=>{
 const a={...run(fixture()),id:'a'},b={...run(fixture()),id:'b'};b.points[1]={...b.points[1],status:'pending',profit:null};b.complete=false;b.totalProfit=null;
 const r=aggregate(period,[a,b]);assert.equal(r.daily[0].profit,200);assert.equal(r.daily[1].profit,null);assert.equal(r.daily[1].knownStores,1);assert.equal(r.totalProfit,null);assert.equal(r.knownProfit,200);
});
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'profit-series-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('service includes all four Ozon and pinned WB, respects filters and limits upstream concurrency',async t=>{
 const privateDir=temp(t);fs.writeFileSync(path.join(privateDir,'truestats-wb-link.json'),JSON.stringify({storeId:'wb-1',accountId:42}));
 const stores=Object.fromEntries([1,2,3,4].map(n=>['ozon-'+n,{name:'Ozon '+n,market:'Ozon'}]));stores['wb-1']={name:'WB store',market:'WB'};
 let active=0,maxActive=0;const calls=[],trueStats={daily:async request=>{calls.push(request);maxActive=Math.max(maxActive,++active);await new Promise(r=>setImmediate(r));active--;return {...run(fixture()),fetchedAt:'2026-09-18T00:00:00.000Z',scopeVerified:true,accountId:request.market==='WB'?42:Number(request.store.id.slice(-1))};}};
 const service=create({stores,privateDir,trueStats});const all=await service.read(period);assert.equal(all.stores.length,5);assert.equal(all.totalProfit,450);assert.equal(maxActive,2);assert.equal(calls.find(c=>c.market==='WB').store.trueStatsAccountId,42);
 const wb=await service.read({...period,market:'WB'});assert.equal(wb.stores.length,1);assert.equal(wb.stores[0].id,'wb-1');const one=await service.read({...period,storeId:'ozon-3'});assert.equal(one.stores.length,1);assert.equal(one.totalProfit,90);
 await assert.rejects(service.read({from:'2026-01-01',to:'2026-09-16'}),/90/);await assert.rejects(service.read({...period,market:'Other'}));await assert.rejects(service.read({...period,storeId:'unknown'}));
});
test('duplicate local names and duplicate resolved TrueStats accounts cannot double-count profit',async t=>{
 const privateDir=temp(t);let calls=0;const trueStats={daily:async()=>{calls++;return {...run(fixture()),scopeVerified:true,accountId:17};}};
 const duplicateNames=create({privateDir,stores:{a:{name:'Same'},b:{name:'Same'}},trueStats});await assert.rejects(duplicateNames.read(period),/дважды/);assert.equal(calls,0);
 const duplicateAccounts=create({privateDir,stores:{a:{name:'A'},b:{name:'B'}},trueStats});await assert.rejects(duplicateAccounts.read(period),/двойного/);
});
test('unlinked WB stays visible and blocks the overall total, without using a similar name',async t=>{
 const privateDir=temp(t);fs.writeFileSync(path.join(privateDir,'truestats-wb-link.json'),JSON.stringify({storeId:'different',accountId:42}));let calls=0;
 const service=create({privateDir,stores:{a:{name:'A'},b:{name:'WB',market:'WB'}},trueStats:{daily:async()=>{calls++;return run(fixture());}}});const result=await service.read(period);assert.equal(calls,1);assert.equal(result.stores[1].status,'unavailable');assert.equal(result.daily[0].profit,null);assert.equal(result.totalProfit,null);
});
test('daily connector scopes one account, caches exact ranges and stores, deduplicates concurrent requests and expires',async t=>{
 const privateDir=temp(t),f=fixture(),calls=[];let time=Date.parse('2026-09-18T00:00:00Z');
 const fetchImpl=async(url,options)=>{const route=new URL(url).pathname,body=options.body?JSON.parse(options.body):null;calls.push({route,body,query:new URL(url).search});const values={'/reporting/facets':{accounts:[{id:17,name:'Sample',accountType:1},{id:42,name:'WB',accountType:0}]},'/reporting/aggregated-view/day':f.day,'/reporting/main/stats':f.stats,'/product-metrics':catalog,'/v1/data-readiness':{items:[{accountId:17,dataType:'ozon_report',...f.options.readiness}]}};return new Response(JSON.stringify(values[route]));};
 const connector=connectorCreate({privateDir,protect:async(v,decrypt)=>decrypt?'fixture-token-not-real':'encrypted-fixture',fetchImpl,now:()=>time});await connector.connect('fixture-token-not-real');const request={period,store:{id:'local',name:'Sample'}};
 const [a,b]=await Promise.all([connector.daily(request),connector.daily(request)]);assert.equal(a.totalProfit,90);assert.equal(b.totalProfit,90);assert.equal(calls.filter(c=>c.route==='/reporting/aggregated-view/day').length,1);const reportCall=calls.find(c=>c.route==='/reporting/aggregated-view/day');assert.deepEqual(reportCall.body.filters,{accounts:[17],accountTypes:[1]});
 const count=calls.length;a.points[0].profit=999;assert.equal((await connector.daily(request)).points[0].profit,100);assert.equal(calls.length,count);await connector.daily({...request,store:{...request.store,id:'another-local'}});assert.ok(calls.length>count);
 time+=30*60*1000;const before=calls.length;await connector.daily(request);assert.ok(calls.length>before);assert.ok(!JSON.stringify(b).includes('fixture-token-not-real'));
});
