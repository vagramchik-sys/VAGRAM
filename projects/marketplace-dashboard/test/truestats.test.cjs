'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {create,normalize,schemaMetadata}=require('../truestats.cjs');
const TOKEN='fixture-only-not-a-real-api-credential';
const period={from:'2026-09-01',to:'2026-09-15'},stores=[{id:'local-a',name:'Sample A'}];
const report={financialMod:false,stats:{profit:123.456,revenue_value:1000,cost_value:500,tax_value:0,opex_value:20,margin_value:12.3456},profitDetalization:[]};
const catalog=[{id:'revenue_value',header:'Реализация',meta:{suffix:'₽'}},{id:'cost_value',header:'Себестоимость продаж',meta:{suffix:'₽'}},{id:'tax_value',header:'Налог',meta:{suffix:'₽'}},{id:'opex_value',header:'Операционные расходы',meta:{suffix:'₽'}},{id:'margin_value',header:'Маржинальность',meta:{suffix:'%'}}];
function setup(t){
 const privateDir=fs.mkdtempSync(path.join(os.tmpdir(),'truestats-test-'));t.after(()=>fs.rmSync(privateDir,{recursive:true,force:true}));
 const state={time:Date.parse('2026-09-16T10:00:00Z'),calls:[],accounts:[{id:17,name:'Sample A',accountType:1},{id:18,name:'Sample A',accountType:0},{id:19,name:'Sample A region',accountType:1}],report:structuredClone(report),ids:[17],catalog:structuredClone(catalog),readiness:{items:[{accountId:17,dataType:'ozon_report',status:'complete',checkedDate:'2026-09-15',lastDataDate:'2026-09-15'}]},fail:null,wait:null};
 const protect=async(v,decrypt)=>decrypt?Buffer.from(v.slice(7),'base64').toString('utf8'):'sealed:'+Buffer.from(v).toString('base64');
 const fetchImpl=async(url,options)=>{
  const route=new URL(url).pathname,body=options.body?JSON.parse(options.body):null;state.calls.push({route,body,options});
  if(state.wait&&route==='/reporting/main/stats')await state.wait;
  if(state.fail===route)return new Response(JSON.stringify({message:TOKEN}),{status:401});
  const value=route==='/reporting/facets'?{accounts:state.accounts}:route==='/reporting/aggregated-view/day'?{accountIdsFilter:state.ids,financialMod:false,result:[],summary:{}}:route==='/reporting/main/stats'?state.report:route==='/v1/data-readiness'?state.readiness:state.catalog;
  return new Response(JSON.stringify(value),{status:200});
 };
 const options={privateDir,protect,fetchImpl,now:()=>state.time};return {connector:create(options),state,privateDir,options};
}
test('disconnected state never makes network requests; missing figures remain null',async t=>{
 const {connector,state}=setup(t);assert.equal(connector.status().connected,false);
 const result=await connector.compare({period,stores});assert.equal(result.status,'not_connected');assert.equal(result.metrics.profit,null);assert.equal(state.calls.length,0);
});

test('today without delivered finances is pending, not a zero profit',async t=>{
 const {connector,state}=setup(t);await connector.connect(TOKEN);state.report.stats={profit:0,revenue_value:0};
 const result=await connector.compare({period:{from:'2026-09-16',to:'2026-09-16'},stores});assert.equal(result.status,'pending');assert.equal(result.metrics.profit,null);
 state.readiness.items=[];const unknown=await connector.compare({period:{from:'2026-09-15',to:'2026-09-16'},stores});assert.equal(unknown.status,'pending');
});

test('readiness never broadens store scope and blocks an unfinished selected day',async t=>{
 const {connector,state}=setup(t);await connector.connect(TOKEN);state.readiness.items[0].status='pending';
 const result=await connector.compare({period,stores});assert.equal(result.status,'pending');assert.equal(result.metrics.profit,null);
 const call=state.calls.find(c=>c.route==='/v1/data-readiness');assert.equal(call.options.method,'GET');
});

test('signed reconciled costs derive remaining deductions without counting taxes twice',()=>{
 const r=normalize({financialMod:false,stats:{profit:20,margin_value:20},profitDetalization:[{title:'Реализация',amount:100},{title:'Себестоимость продаж',amount:-50},{title:'Налоги',amount:-5},{title:'Операционные расходы',amount:-10},{title:'Логистика',amount:-15}]},[{id:'margin_value',header:'Марж-cть',meta:{suffix:'%'}}],TOKEN);
 assert.equal(r.metrics.marketplaceDeductions,15);assert.equal(r.metrics.profitBeforeTaxAndOpex,35);assert.equal(r.metrics.margin,20);
});
test('connect validates read-only facets before encrypted save and exposes no credential',async t=>{
 const {connector,state,privateDir,options}=setup(t);await connector.connect(TOKEN);
 assert.equal(state.calls[0].route,'/reporting/facets');assert.deepEqual(state.calls[0].body,{_dimensions:['accounts']});
 assert.equal(state.calls[0].options.redirect,'error');assert.equal(state.calls[0].options.headers['X-Api-Token'],TOKEN);
 const saved=fs.readFileSync(path.join(privateDir,'truestats.json'),'utf8');assert.ok(!saved.includes(TOKEN));assert.ok(!JSON.stringify(connector.status()).includes(TOKEN));assert.equal(create(options).status().connected,true);
});
test('rejected key preserves previous working connection and sanitizes upstream message',async t=>{
 const {connector,state,privateDir}=setup(t);await connector.connect(TOKEN);const before=fs.readFileSync(path.join(privateDir,'truestats.json'),'utf8');state.fail='/reporting/facets';
 await assert.rejects(connector.connect(TOKEN+'-new'),error=>!error.message.includes(TOKEN)&&error.code==='unauthorized');assert.equal(fs.readFileSync(path.join(privateDir,'truestats.json'),'utf8'),before);
});
test('exact dates and only uniquely named Ozon account are requested and scope verified',async t=>{
 const {connector,state}=setup(t);await connector.connect(TOKEN);const result=await connector.compare({period,stores});
 assert.equal(result.status,'ready');assert.equal(result.scopeVerified,true);assert.deepEqual(result.period,period);assert.deepEqual(result.accounts,[{id:17,name:'Sample A',localStoreId:'local-a'}]);
 const requests=state.calls.filter(c=>c.route==='/reporting/main/stats'||c.route==='/reporting/aggregated-view/day');
 assert.equal(requests.length,2);for(const call of requests)assert.deepEqual(call.body,{dateFrom:period.from,dateTo:period.to,filters:{accountTypes:[1],accounts:[17]},financialMod:false});
 assert.deepEqual(result.metrics,{profit:123.46,realized:1000,cogs:500,tax:0,operatingExpenses:20,marketplaceDeductions:null,margin:12.35,profitBeforeTaxAndOpex:143.46,ads:null,sales:null,adsBonus:null,adsTotal:null,adShare:null,adShareTotal:null,adShareOrders:null,adShareSales:null,roi:24.69});
 assert.ok(!JSON.stringify(result).includes(TOKEN));
});
test('ambiguous or missing account mapping stops before any financial report request',async t=>{
 for(const mode of ['ambiguous','missing']){
  const {connector,state}=setup(t);await connector.connect(TOKEN);if(mode==='ambiguous')state.accounts.push({id:20,name:'Sample A',accountType:1});else state.accounts=[];
  const result=await connector.compare({period,stores});assert.equal(result.status,'unavailable');assert.equal(result.code,'scope');assert.equal(state.calls.filter(c=>c.route.includes('/main/')).length,0);
 }
});
test('different returned account scope is rejected before reading KPI stats',async t=>{
 const {connector,state}=setup(t);await connector.connect(TOKEN);state.ids=[17,19];const result=await connector.compare({period,stores});assert.equal(result.code,'scope_response');assert.equal(result.metrics.profit,null);assert.equal(state.calls.some(c=>c.route==='/reporting/main/stats'),false);
});
test('cache is isolated by exact period and local account scope, expires without stale fallback',async t=>{
 const {connector,state}=setup(t);await connector.connect(TOKEN);await connector.compare({period,stores});const count=state.calls.length;
 const cached=await connector.compare({period,stores});assert.equal(cached.cached,true);assert.equal(state.calls.length,count);cached.metrics.profit=999;
 assert.equal((await connector.compare({period,stores})).metrics.profit,123.46);
 await connector.compare({period:{...period,to:'2026-09-14'},stores});assert.ok(state.calls.length>count);const next=state.calls.length;
 await connector.compare({period,stores:[{id:'another-id',name:'Sample A'}]});assert.ok(state.calls.length>next);
 state.time+=30*60*1000;state.fail='/reporting/facets';const expired=await connector.compare({period,stores});assert.equal(expired.status,'unavailable');assert.equal(expired.metrics.profit,null);assert.equal(expired.fetchedAt,null);
});
test('concurrent identical reports share requests and return isolated results',async t=>{
 const {connector,state}=setup(t);await connector.connect(TOKEN);const [a,b]=await Promise.all([connector.compare({period,stores}),connector.compare({period,stores})]);assert.equal(state.calls.filter(c=>c.route==='/reporting/main/stats').length,1);a.metrics.profit=999;assert.equal(b.metrics.profit,123.46);
});
test('credential replacement invalidates cache and an old in-flight report',async t=>{
 const {connector,state}=setup(t);await connector.connect(TOKEN);let release;state.wait=new Promise(resolve=>release=resolve);const running=connector.compare({period,stores});
 while(!state.calls.some(c=>c.route==='/reporting/main/stats'))await new Promise(resolve=>setImmediate(resolve));
 await connector.connect(TOKEN+'-second');release();const old=await running;assert.equal(old.code,'connection_changed');assert.equal(old.metrics.profit,null);state.wait=null;
 assert.equal((await connector.compare({period,stores})).cached,false);
});
test('numeric zero differs from missing, blank, non-finite and boolean data',()=>{
 for(const value of [null,undefined,'',false,'Infinity','not-a-number'])assert.equal(normalize({financialMod:false,stats:{profit:value}},[],TOKEN).metrics.profit,null);
 assert.equal(normalize({financialMod:false,stats:{profit:0}},[],TOKEN).metrics.profit,0);
 assert.equal(normalize({financialMod:false,stats:{profit:10.075}},[],TOKEN).metrics.profit,10.08);
 assert.equal(normalize({financialMod:false,stats:{profit:-10.075}},[],TOKEN).metrics.profit,-10.08);
 assert.equal(normalize({financialMod:false,stats:{profit:1e-8}},[],TOKEN).metrics.profit,0);
 const result=normalize({financialMod:false,stats:{profit:'-1.005'},profitDetalization:[{title:'Налог',amount:0},{title:'Операционные расходы',amount:0}]},[],TOKEN);assert.equal(result.metrics.profit,-1.01);assert.equal(result.metrics.tax,0);assert.equal(result.metrics.operatingExpenses,0);assert.equal(result.metrics.realized,null);
});
test('unknown keys and ambiguous dictionary labels never become guessed metrics',()=>{
 const result=normalize({financialMod:false,stats:{profit:10,cogs:30,taxes:12,realisation:100}},[],TOKEN);assert.equal(result.metrics.profit,10);assert.equal(result.metrics.cogs,null);assert.equal(result.metrics.tax,null);assert.equal(result.metrics.realized,null);
 const ambiguous=normalize(report,[...catalog,{id:'another_value',header:'Налог',meta:{suffix:'₽'}}],TOKEN);assert.equal(ambiguous.metrics.tax,null);
});
test('breakdown preserves refunds, reconciles signed contributions and redacts token in labels',()=>{
 const result=normalize({financialMod:false,stats:{profit:55},profitDetalization:[{title:'Реализация',amount:100},{title:'Себестоимость',amount:-50},{title:'Налог',amount:5},{title:TOKEN,amount:0}]},[],TOKEN);
 assert.equal(result.metrics.cogs,50);assert.equal(result.metrics.tax,-5);assert.equal(result.breakdownReconciled,true);assert.ok(!JSON.stringify(result).includes(TOKEN));
});
test('partial results and network failures do not invent zero profit',async t=>{
 const {connector,state}=setup(t);await connector.connect(TOKEN);state.report.stats={};const result=await connector.compare({period,stores});assert.equal(result.status,'partial');assert.equal(result.metrics.profit,null);
 state.time+=31*60*1000;state.fail='/reporting/main/stats';const failed=await connector.compare({period,stores});assert.equal(failed.status,'unavailable');assert.equal(failed.metrics.profit,null);assert.ok(!JSON.stringify(failed).includes(TOKEN));
});
test('schema discovery reports field types without values or secret field names',()=>{
 const output=JSON.stringify(schemaMetadata({stats:{profit:321,token:TOKEN},secret:TOKEN,password:TOKEN}));assert.ok(output.includes('profit'));assert.ok(!output.includes('321'));assert.ok(!output.includes(TOKEN));assert.ok(!output.includes('password'));
});
test('advertising separates cash, bonuses and denominators without changing profit',()=>{
 const dictionary=[['a','Реклама','₽'],['b','Расходы на рекламу с бонусов','₽'],['c','Общие расходы на рекламу','₽'],['r','Реализация','₽'],['s','Продажи','₽'],['d','ДРР','%'],['dt','Общая ДРР','%'],['do','Реклама/ДРРз','%']].map(([id,header,suffix])=>({id,header,meta:{suffix}}));
 const r=normalize({financialMod:false,stats:{profit:50,a:20,b:5,c:25,r:200,s:100,d:10,dt:12.5,do:8}},dictionary,TOKEN);
 assert.equal(r.metrics.ads,20);assert.equal(r.metrics.adsBonus,5);assert.equal(r.metrics.adsTotal,25);assert.equal(r.metrics.adShare,10);assert.equal(r.metrics.adShareTotal,12.5);assert.equal(r.metrics.adShareOrders,8);assert.equal(r.metrics.adShareSales,20);assert.equal(r.metrics.profit,50);
});

test('advertising refunds retain their sign, unknown values do not become zero',()=>{
 const r=normalize({financialMod:false,stats:{profit:20},profitDetalization:[{title:'Реализация',amount:100},{title:'Реклама',amount:5}]},[],TOKEN);
 assert.equal(r.metrics.ads,-5);assert.equal(r.metrics.adShare,-5);assert.equal(r.metrics.adsBonus,null);assert.equal(r.metrics.adsTotal,null);assert.equal(r.metrics.adShareSales,null);
 const zero=normalize({financialMod:false,stats:{profit:0},profitDetalization:[{title:'Реализация',amount:0},{title:'Реклама',amount:0}]},[],TOKEN);assert.equal(zero.metrics.ads,0);assert.equal(zero.metrics.adShare,null);
 const unknown=normalize({financialMod:false,stats:{profit:0}},[],TOKEN);assert.equal(unknown.metrics.ads,null);assert.equal(unknown.metrics.adShare,null);
});

test('unfinished reports hide advertising alongside profit',async t=>{
 const {connector,state}=setup(t);await connector.connect(TOKEN);state.catalog.push({id:'ads',header:'Реклама',meta:{suffix:'₽'}});state.report.stats.ads=50;
 const result=await connector.compare({period:{from:'2026-09-16',to:'2026-09-16'},stores});assert.equal(result.status,'pending');assert.equal(result.metrics.ads,null);
});

test('WB uses a pinned account ID and WB-only scope and readiness',async t=>{
 const {connector,state}=setup(t);await connector.connect(TOKEN);state.ids=[18];state.readiness.items=[{accountId:18,dataType:'wb_report',status:'complete',checkedDate:'2026-09-15',lastDataDate:'2026-09-15'}];
 const selected=[{id:'wb-test',name:'Local WB',market:'WB',trueStatsAccountId:18}];
 const r=await connector.compare({period,stores:selected,market:'WB'});assert.equal(r.status,'ready');assert.equal(r.scopeVerified,true);assert.equal(r.accounts[0].id,18);assert.equal(r.readiness[0].accountId,18);
 const body=state.calls.find(c=>c.route==='/reporting/main/stats').body;assert.deepEqual(body.filters,{accountTypes:[0],accounts:[18]});assert.equal(r.metrics.roi,24.69);
 const wrong=await connector.compare({period,stores:[{...selected[0],trueStatsAccountId:17}],market:'WB'});assert.equal(wrong.status,'unavailable');assert.equal(wrong.metrics.profit,null);
 const unlinked=await connector.compare({period,stores:[{id:'wb-test',name:'WB',market:'WB'}],market:'WB'});assert.equal(unlinked.status,'unavailable');
});

test('ROI needs known positive cost and preserves negative profit',()=>{
 for(const cost of [null,0,-10]){const r=normalize({financialMod:false,stats:{profit:10,cost_value:cost}},catalog,TOKEN);assert.equal(r.metrics.roi,null)}
 assert.equal(normalize({financialMod:false,stats:{profit:-25,cost_value:100}},catalog,TOKEN).metrics.roi,-25);
});

test('invalid date and empty or duplicate local scope cannot call network',async t=>{
 const {connector,state}=setup(t);await connector.connect(TOKEN);const initial=state.calls.length;
 for(const input of [{period:{from:'2026-02-30',to:'2026-09-01'},stores},{period,stores:[]},{period,stores:[...stores,...stores]}])assert.equal((await connector.compare(input)).status,'unavailable');assert.equal(state.calls.length,initial);
});
