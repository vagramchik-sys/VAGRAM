'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),m=require('../dist/business-dynamics-model.js');
const date='2026-09-24',STEP=900000,DAY=86400000,at=(d,n)=>new Date(m.start(d)+n*STEP).toISOString();
function day(d,{bins=96,revenue=100,orders=2,complete=true}={}){return {date:d,basis:'order-time',complete,totals:{orderedRevenue:bins*revenue,orderedUnits:bins*3,orderCount:bins*orders},intervals:Array.from({length:bins},(_,i)=>({from:at(d,i),to:at(d,i+1),orderedRevenue:revenue,orderedUnits:3,orderCount:orders,complete:true}))};}
function store(id='1',history=7){return {id,name:'Магазин '+id,market:'Ozon',updatedAt:at(date,48),days:[day(date,{bins:48,complete:false}),...Array.from({length:history},(_,i)=>day(m.shift(date,-i-1)))]};}
const payload=stores=>({period:{to:date},stores,events:[]}),build=(stores,opts={})=>m.build(payload(stores),{date,now:Date.parse(at(date,48)),...opts});
test('equal MSK cutoff, seven complete days and historical-share forecast',()=>{const a=build([store()]);assert.equal(a.kpis.today.value,4800);assert.equal(a.kpis.yesterdayAtSameTime.value,4800);assert.equal(a.kpis.pace.value,0);assert.equal(a.comparison.avg7dSameTime,4800);assert.equal(a.kpis.forecast.value,9600);assert.equal(a.kpis.forecast.sampleSize,7);assert.equal(a.series.forecast.at(-1).at,at(date,96));assert.equal(a.velocity.length,48);assert.equal(a.velocityComparison.value,0);assert.equal(a.series.today.at(-1).avgCheck,50);});
test('total and child checkbox never double count; empty selection stays empty',()=>{const a=store(),b=store('2');assert.equal(build([a,a,b],{selectedIds:['','1']}).kpis.today.value,9600);assert.equal(build([a,b],{selectedIds:['2']}).kpis.today.value,4800);assert.equal(build([a],{selectedIds:[]}).state,'empty');});
test('missing store, interval or historical day is not zero',()=>{const a=store(),b=store('2');b.days=[];const result=build([a,b]);assert.equal(result.kpis.today.value,4800);assert.equal(result.kpis.yesterdayAtSameTime.value,null);assert.equal(result.kpis.forecast.available,false);assert.equal(result.state,'partial');a.days[0].intervals.splice(4,1);assert.equal(build([a]).kpis.pace.value,null);assert.equal(build([store('1',6)]).comparison.avg7dSameTime,null);assert.equal(build([store('1',6)]).kpis.yesterdayAtSameTime.value,4800);});
test('zero previous base has no percentage and zero current has no forecast',()=>{const a=store();a.days[1]=day(m.shift(date,-1),{revenue:0});assert.equal(build([a]).kpis.pace.value,null);a.days[0]=day(date,{bins:48,revenue:0,complete:false});assert.equal(build([a]).kpis.today.value,0);assert.equal(build([a]).kpis.forecast.available,false);});
test('incomplete seven minutes of current bucket never compare to full interval',()=>{const a=store();a.days[0].intervals.push({...day(date).intervals[48],orderedRevenue:40,complete:false});const r=build([a],{now:Date.parse(at(date,48))+7*60000});assert.equal(r.asOf,at(date,48));assert.equal(r.kpis.today.value,4800);assert.equal(r.velocity.length,48);});
test('partial current bucket keeps latest known total but compares the last complete interval',()=>{const a=store();const cutoff=new Date(Date.parse(at(date,48))+7*60000).toISOString();a.updatedAt=cutoff;a.days[0].coverage={from:at(date,0),to:cutoff};a.days[0].intervals.push({...day(date).intervals[48],orderedRevenue:40,complete:false});const r=build([a],{now:Date.parse(at(date,49))});assert.equal(r.asOf,cutoff);assert.equal(r.kpis.today.value,4840);assert.equal(r.executive.stores[0].value,4840);assert.equal(r.executive.stores[0].asOf,cutoff);assert.equal(r.executive.stores[0].complete,false);assert.equal(r.executive.stores[0].velocity,400);assert.equal(r.kpis.yesterdayAtSameTime.value,4800);assert.equal(r.executive.comparisonToday,4800);assert.equal(r.executive.comparisonAsOf,at(date,48));assert.equal(r.executive.changePct,0);assert.equal(r.kpis.forecast.available,true);assert.equal(r.velocity.length,48);});
test('staggered observations keep known sum but disable exact-time comparisons',()=>{const a=store(),b=store('2');for(const [s,t,v] of [[a,48,100],[b,47,200]])s.days[0]={date,basis:'observation',complete:false,observations:[{at:at(date,t),orderedRevenue:v,orderedUnits:1,complete:true}]};const r=build([a,b]);assert.equal(r.kpis.today.value,300);assert.equal(r.series.today.at(-1).cumulative,300);assert.equal(r.series.today.at(-1).complete,false);assert.equal(r.kpis.yesterdayAtSameTime.value,null);assert.equal(r.velocity.length,0);assert.equal(r.series.today.at(-1).last15,null);});
test('mixed observation and order-time semantics never give precise comparisons',()=>{const a=store(),b=store('2');b.days[0]={date,basis:'observation',observations:[{at:at(date,48),orderedRevenue:200,orderedUnits:1,complete:true}]};const r=build([a,b]);assert.equal(r.state,'partial');assert.equal(r.kpis.pace.value,null);assert.equal(r.kpis.forecast.available,false);});
test('average check uses pooled revenue and order counts and has no additive forecast',()=>{const a=store();a.days[1]=day(m.shift(date,-1),{orders:10,revenue:300});const r=build([a],{metric:'avgCheck'});assert.equal(r.kpis.today.value,50);assert.equal(r.comparison.avg7dSameTime,(300+6*100)/(10+6*2));assert.equal(r.kpis.forecast.available,false);assert.equal(r.velocity.length,0);});
test('unknown order count remains unavailable, units are not orders',()=>{const a=store();for(const d of a.days){d.totals.orderCount=null;for(const i of d.intervals)i.orderCount=null;}assert.equal(build([a],{metric:'orderCount'}).kpis.today.value,null);assert.equal(build([a],{metric:'avgCheck'}).kpis.today.value,null);assert.equal(build([a]).series.today.at(-1).orders,null);});
test('forecast excludes an outlier and needs seven usable days after exclusion',()=>{const a=store('1',8);a.days[8]=day(m.shift(date,-8),{revenue:10000});assert.equal(build([a]).kpis.forecast.sampleSize,7);a.days.pop();a.days[7]=day(m.shift(date,-7),{revenue:10000});assert.equal(build([a]).kpis.forecast.available,false);});
test('freshness is oldest source, future points/events and foreign store events excluded',()=>{const a=store(),b=store('2');a.updatedAt=at(date,40);const p=payload([a,b]);p.events=[{kind:'price',at:at(date,20),storeId:'1'},{kind:'price',at:at(date,49)},{kind:'bid',at:at(date,30),storeId:'other'},{kind:'unsupported',at:at(date,10)}];const r=m.build(p,{now:Date.parse(at(date,48))});assert.equal(r.updatedAt,at(date,40));assert.equal(r.events.length,1);assert.equal(r.events[0].storeId,'1');});

test('total never connects early WB-only values to the first Ozon observation',()=>{
 const wb=store('wb');wb.market='WB';
 const ozon=store('ozon');ozon.days[0]={date,basis:'observation',observations:[{at:at(date,40),orderedRevenue:10000,orderedUnits:20,complete:true}]};
 const r=build([wb,ozon]);
 assert.ok(r.series.today.filter(p=>Date.parse(p.at)<Date.parse(at(date,40))).every(p=>p.cumulative===null));
 assert.equal(r.series.today.find(p=>p.cumulative!==null).at,at(date,40));
 assert.equal(r.series.today.find(p=>p.cumulative!==null).cumulative,14000);
 assert.equal(r.kpis.today.value,14800);
 assert.equal(r.kpis.pace.value,null);
 assert.equal(r.velocity.length,0);
 assert.match(r.chartCaption,/время загрузки/);
 ozon.days=[];
 const missing=build([wb,ozon]);
 assert.equal(missing.state,'partial');assert.equal(missing.kpis.today.value,4800);
 assert.ok(missing.series.today.every(p=>p.cumulative===null));
 assert.match(missing.chartUnavailableReason,/всех выбранных магазинов/);
 assert.equal(build([wb,ozon],{selectedIds:['wb']}).series.today[0].cumulative,100);
});

test('executive contract exposes only confirmed interval windows and comparable shares',()=>{
 const r=build([store()]);
 assert.deepEqual({today:r.executive.today,yesterday:r.executive.yesterdaySameTime,change:r.executive.changePct},{today:4800,yesterday:4800,change:0});
 assert.equal(r.executive.last15m,100);assert.equal(r.executive.last60m,400);assert.equal(r.executive.last3h,1200);assert.equal(r.executive.previousHourChange,0);
 assert.equal(r.executive.forecastConfidence,'low');assert.equal(r.kpis.forecast.spread,0);
 assert.deepEqual(r.executive.marketplaces,[{market:'Ozon',value:4800,share:100,changePct:0,velocity:400}]);
 assert.deepEqual(r.executive.stores.map(({id,value,share,changePct,velocity})=>({id,value,share,changePct,velocity})),[{id:'1',value:4800,share:100,changePct:0,velocity:400}]);
 assert.equal(r.executive.stores[0].comparisonToday,4800);
 assert.equal(r.executive.stores[0].yesterdaySameTime,4800);
 assert.deepEqual(r.executive.dataQuality,{score:100,issues:[],byMarket:{Ozon:{score:100,issues:[]}}});
 assert.ok(r.executive.insights.every(item=>item.kind==='fact'));
});

test('target is accepted only with a positive finite value and confirmed exact scope',()=>{
 const a=store(),base=payload([a]);
 base.target={date,scope:{type:'all'},amountCents:960000,currency:'RUB',timeZone:'Europe/Moscow',updatedAt:at(date,40)};
 let r=m.build(base,{date,now:Date.parse(at(date,48))});
 assert.deepEqual({target:r.executive.target,completion:r.executive.targetCompletion,remaining:r.executive.remaining,hourly:r.executive.requiredHourly},{target:9600,completion:100,remaining:4800,hourly:400});
 for(const target of [undefined,{...base.target,amountCents:0},{...base.target,amountCents:Infinity},{...base.target,date:m.shift(date,-1)},{...base.target,currency:'USD'},{...base.target,scope:{type:'store',storeId:'2'}}]){
  const p=payload([a]);p.target=target;r=m.build(p,{date,now:Date.parse(at(date,48))});assert.equal(r.executive.target,null);assert.equal(r.executive.targetCompletion,null);assert.equal(r.executive.remaining,null);assert.equal(r.executive.requiredHourly,null);
 }
 const scoped=payload([a]);scoped.target={...base.target,scope:{type:'store',storeId:'1'},amountCents:480000};assert.equal(m.build(scoped,{date,now:Date.parse(at(date,48))}).executive.target,4800);
 const broad=payload([a,store('2')]);broad.target={...base.target,scope:{type:'store',storeId:'1'},amountCents:480000};assert.equal(m.build(broad,{date,selectedIds:['1'],now:Date.parse(at(date,48))}).executive.target,null);
 assert.equal(m.build({...broad,target:{...base.target,scope:{type:'all'}}},{date,selectedIds:['1'],now:Date.parse(at(date,48))}).executive.target,null);
 const partialStore=store('2');partialStore.days=[];const partial=payload([a,partialStore]);partial.target={...base.target,scope:{type:'all'}};r=m.build(partial,{date,now:Date.parse(at(date,48))});assert.equal(r.executive.target,9600);assert.equal(r.executive.targetCompletion,null);assert.equal(r.executive.remaining,null);assert.equal(r.executive.requiredHourly,null);
});

test('partial, stale and mixed sources suppress executive comparisons and velocities',()=>{
 const missingA=store(),missingB=store('2');missingB.days=[];missingB.updatedAt=at(date,40);
 let r=build([missingA,missingB]);
 assert.equal(r.executive.last15m,null);assert.equal(r.executive.changePct,null);assert.equal(r.executive.stores.find(row=>row.id==='1').share,100);assert.equal(r.executive.stores.find(row=>row.id==='2').share,null);
 assert.ok(r.executive.dataQuality.issues.some(issue=>issue.code==='MISSING_CURRENT'));assert.ok(r.executive.dataQuality.issues.some(issue=>issue.code==='STALE_SOURCE'));
 const ozon=store('o'),wb=store('w');wb.market='WB';ozon.days[0]={date,basis:'observation',complete:false,observations:[{at:at(date,48),orderedRevenue:100,orderedUnits:1,complete:true}]};
 r=build([ozon,wb]);
 assert.equal(r.executive.last15m,null);assert.equal(r.executive.last60m,null);assert.equal(r.executive.previousHourChange,null);assert.equal(r.executive.forecastConfidence,'unavailable');
 assert.equal(r.executive.marketplaces.every(row=>Number.isFinite(row.value)&&Number.isFinite(row.share)),true);
 assert.equal(r.executive.marketplaces.find(row=>row.market==='Ozon').changePct,null);
 assert.equal(r.executive.marketplaces.find(row=>row.market==='WB').changePct,0);
 assert.ok(r.executive.dataQuality.byMarket.Ozon);assert.ok(r.executive.dataQuality.byMarket.WB);
 const changedBasis=store();changedBasis.days[1]={date:m.shift(date,-1),basis:'observation',complete:true,totals:{orderedRevenue:9600,orderedUnits:288,orderCount:192},observations:[{at:at(m.shift(date,-1),48),orderedRevenue:4800,orderedUnits:144,orderCount:96,complete:true}]};
 r=build([changedBasis]);assert.equal(r.executive.changePct,null);assert.equal(r.executive.marketplaces[0].changePct,null);assert.equal(r.executive.stores[0].changePct,null);
});

test('Ozon forecast uses a real prior observation no more than 30 minutes old without weakening exact yesterday KPI',()=>{
 const current={date,basis:'observation',complete:false,observations:[{at:at(date,48),orderedRevenue:4800,orderedUnits:144,orderCount:96,complete:true}]};
 const history=Array.from({length:7},(_,i)=>{const d=m.shift(date,-i-1);return {date:d,basis:'observation',complete:true,totals:{orderedRevenue:9600,orderedUnits:288,orderCount:192},observations:[{at:at(d,47),orderedRevenue:4700,orderedUnits:141,orderCount:94,complete:true}]}});
 const ozon={id:'1',name:'Ozon',market:'Ozon',updatedAt:at(date,48),days:[current,...history]};
 const r=build([ozon]);
 assert.equal(r.kpis.forecast.available,true);assert.equal(r.kpis.forecast.sampleSize,7);assert.equal(r.kpis.yesterdayAtSameTime.value,null);assert.equal(r.executive.yesterdaySameTime,null);
 history[0].observations[0].at=at(history[0].date,45);
 assert.equal(build([ozon]).kpis.forecast.available,false);
});

test('yesterday line reaches 24:00 only through confirmed full-day points',()=>{
 const r=build([store()]);assert.equal(r.series.yesterday.length,96);assert.equal(r.series.yesterday.at(-1).at,at(date,96));assert.equal(r.series.yesterday.at(-1).cumulative,9600);
 const a=store();a.days[1].intervals[95].complete=false;const partial=build([a]);assert.equal(partial.series.yesterday.some(point=>point.at===at(date,96)),false);
});

test('zero and large finite values remain factual without fabricated ratios',()=>{
 const zero=store();zero.days[0]=day(date,{bins:48,revenue:0,complete:false});let r=build([zero]);assert.equal(r.executive.today,0);assert.equal(r.executive.last3h,0);assert.equal(r.executive.changePct,-100);assert.equal(r.executive.forecastConfidence,'unavailable');
 const large=store();for(const d of large.days){d.totals.orderedRevenue=d.intervals.length*1e12;for(const row of d.intervals)row.orderedRevenue=1e12;}r=build([large]);assert.equal(r.executive.today,48e12);assert.equal(r.executive.last60m,4e12);assert.equal(r.executive.marketplaces[0].share,100);assert.ok(Number.isFinite(r.kpis.forecast.value));
});

test('executive insights contain factual percentages and comparable store names, capped at four',()=>{
 const growing=store('1'),lagging=store('2');growing.name='Рост';lagging.name='Снижение';
 growing.days[1]=day(m.shift(date,-1),{revenue:80});lagging.days[1]=day(m.shift(date,-1),{revenue:125});
 const p=payload([growing,lagging]);p.target={date,scope:{type:'all'},amountCents:2000000,currency:'RUB',timeZone:'Europe/Moscow',updatedAt:at(date,40)};
 const r=m.build(p,{date,now:Date.parse(at(date,48))});
 assert.equal(r.executive.insights.length,4);
 assert.match(r.executive.insights.find(row=>row.id==='change-vs-yesterday').message,/Заказано на сумму: −2,4%/);
 assert.match(r.executive.insights.find(row=>row.id==='strongest-growing-store').message,/Рост: \+25,0%/);
 assert.match(r.executive.insights.find(row=>row.id==='strongest-lagging-store').message,/Снижение: −20,0%/);
 assert.match(r.executive.insights.find(row=>row.id==='forecast-vs-target').message,/Прогноз к 24:00: −4,0%/);
 assert.doesNotMatch(r.executive.insights.map(row=>row.message).join(' '),/реклам|ставк|измените|увеличьте|снизьте/i);
});

test('without trusted comparisons insights contain only the concrete quality statement',()=>{
 const a=store();a.days[0]={date,basis:'observation',complete:false,observations:[{at:at(date,48),orderedRevenue:100,orderedUnits:1,complete:true}]};a.updatedAt=at(date,40);
 const r=build([a]);assert.equal(r.executive.insights.length,1);assert.equal(r.executive.insights[0].kind,'quality');assert.match(r.executive.insights[0].message,/Сопоставимый вывод пока недоступен/);assert.match(r.executive.insights[0].message,/45 минут/);
});

test('forecast confidence uses both sample size and projection spread thresholds',()=>{
 assert.equal(build([store('seven',7)]).executive.forecastConfidence,'low');
 assert.equal(build([store('ten',10)]).executive.forecastConfidence,'medium');
 assert.equal(build([store('fourteen',14)]).executive.forecastConfidence,'high');
 const profiled=store('spread',14);
 for(let i=1;i<profiled.days.length;i++){
  const low=i%2===0,first=low?80:120,last=low?120:80,d=profiled.days[i];
  d.intervals.forEach((row,index)=>{row.orderedRevenue=index<48?first:last});d.totals.orderedRevenue=9600;
 }
 const spread=build([profiled]);assert.equal(spread.kpis.forecast.sampleSize,14);assert.ok(spread.kpis.forecast.spread>.3);assert.equal(spread.executive.forecastConfidence,'low');
});

test('data quality records history, source and Ozon interval limitations once each',()=>{
 const a=store();a.sources=[{id:'insights',error:true}];a.days=a.days.slice(0,4);a.days[0]={date,basis:'observation',complete:false,observations:[{at:at(date,48),orderedRevenue:100,orderedUnits:1,complete:true}]};
 const quality=build([a]).executive.dataQuality,codes=quality.issues.map(issue=>issue.code);
 assert.equal(codes.filter(code=>code==='SOURCE_ERROR').length,1);assert.equal(codes.includes('STALE_SOURCE'),false);assert.equal(codes.includes('NO_ORDER_TIME'),true);assert.equal(codes.includes('HISTORY_GAPS'),true);assert.equal(new Set(codes).size,codes.length);assert.ok(quality.score<100);
});

test('staggered Ozon and WB show shares of known amounts without claiming an exact total',()=>{
 const wb=store('wb');wb.market='WB';const ozon=store('ozon');ozon.days[0]={date,basis:'observation',complete:false,observations:[{at:at(date,40),orderedRevenue:10000,orderedUnits:20,complete:true}]};
 const r=build([wb,ozon]),byId=new Map(r.executive.stores.map(row=>[row.id,row]));
 assert.equal(r.state,'partial');assert.equal(r.executive.today,14800);
 assert.equal(byId.get('ozon').value,10000);assert.equal(byId.get('ozon').staggered,true);assert.equal(byId.get('ozon').changePct,null);
 assert.equal(byId.get('wb').value,4800);assert.equal(byId.get('wb').asOf,at(date,48));assert.equal(byId.get('wb').staggered,false);assert.equal(byId.get('wb').changePct,0);assert.equal(byId.get('wb').velocity,400);
 assert.ok(Math.abs(byId.get('ozon').share-10000/14800*100)<1e-9);
 assert.ok(Math.abs(byId.get('wb').share-4800/14800*100)<1e-9);
 assert.equal(r.executive.marketplaces.find(row=>row.market==='Ozon').partial,true);
 assert.equal(r.executive.marketplaces.find(row=>row.market==='WB').value,4800);
});

test('observation pace uses actual elapsed time and rejects gaps, resets and missing coverage',()=>{
 const observation=(minute,value,complete=true)=>({at:at(date,minute),orderedRevenue:value,complete});
 const day={date,basis:'observation',observations:[observation(43,1000),observation(47,1600)]};
 const now=Date.parse(at(date,48));
 assert.equal(m.observationHourly(day,'orderedRevenue',now).value,600);
 assert.equal(m.observationHourly(day,'orderedRevenue',now+46*60000),null);
 day.observations[1].orderedRevenue=900;assert.equal(m.observationHourly(day,'orderedRevenue',now),null);
 day.observations[1].orderedRevenue=1600;day.observations[0].complete=false;assert.equal(m.observationHourly(day,'orderedRevenue',now),null);
 day.observations[0].complete=true;day.observations[0].at=at(date,46);assert.equal(m.observationHourly(day,'orderedRevenue',now),null);
 day.observations[0].at=at(m.shift(date,-1),95);assert.equal(m.observationHourly(day,'orderedRevenue',now),null);
});

test('mixed marketplace dashboard shows an estimated pace only when every selected store has valid intervals',()=>{
 const wb=store('wb');wb.market='WB';
 const ozon=store('ozon');ozon.days[0]={date,basis:'observation',complete:false,observations:[{at:at(date,44),orderedRevenue:1000,orderedUnits:10,complete:true},{at:at(date,48),orderedRevenue:1600,orderedUnits:16,complete:true}]};
 const result=build([wb,ozon]);
 assert.equal(result.executive.last60m,null);
 assert.equal(result.executive.currentPaceHourly,1000);
 assert.equal(result.executive.paceEstimated,true);
 ozon.days[0].observations[0].complete=false;
 assert.equal(build([wb,ozon]).executive.currentPaceHourly,null);
});

test('source history uses each store complete cutoff when the mixed total ends at an Ozon observation',()=>{
 const wb=store('wb');wb.market='WB';
 const cutoff=new Date(Date.parse(at(date,48))+7*60000).toISOString();
 wb.updatedAt=cutoff;wb.days[0].coverage={from:at(date,0),to:cutoff};
 wb.days[0].intervals.push({...day(date).intervals[48],orderedRevenue:40,complete:false});
 const ozon=store('ozon');ozon.days[0]={date,basis:'observation',complete:false,observations:[{at:cutoff,orderedRevenue:1000,complete:true}]};
 const r=build([ozon,wb],{now:Date.parse(cutoff)});
 assert.equal(r.executive.comparisonAsOf,null);
 assert.equal(r.executive.stores.find(row=>row.id==='wb').comparisonAsOf,at(date,48));
 assert.equal(r.executive.sourceStatus.find(row=>row.id==='wb').historyCompleteDays,7);
});
