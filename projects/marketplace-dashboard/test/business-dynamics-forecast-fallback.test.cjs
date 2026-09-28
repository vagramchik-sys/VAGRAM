'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),model=require('../dist/business-dynamics-model.js');
const date='2026-09-24',STEP=900000,at=(day,slot)=>new Date(model.start(day)+slot*STEP).toISOString();
const previous=n=>model.shift(date,-n);
function ozon(history=2,{stale=false,share=.5}={}){
 const currentSlot=stale?37:48;
 const current={date,basis:'observation',complete:false,observations:[{at:at(date,currentSlot),orderedRevenue:500,orderedUnits:5,complete:true}]};
 const days=Array.from({length:history},(_,i)=>({date:previous(i+1),basis:'observation',complete:true,totals:{orderedRevenue:1000,orderedUnits:10,orderCount:null},observations:[{at:at(previous(i+1),currentSlot),orderedRevenue:1000*share,orderedUnits:5,complete:true}]}));
 return {id:'ozon',name:'Ozon',market:'Ozon',updatedAt:at(date,currentSlot),days:[current,...days]};
}
function wb(history=7){
 const day=(d,bins,complete)=>({date:d,basis:'order-time',complete,totals:{orderedRevenue:960,orderedUnits:96,orderCount:96},intervals:Array.from({length:bins},(_,i)=>({from:at(d,i),to:at(d,i+1),orderedRevenue:10,orderedUnits:1,orderCount:1,complete:true}))});
 return {id:'wb',name:'WB',market:'WB',updatedAt:at(date,48),days:[day(date,48,false),...Array.from({length:history},(_,i)=>day(previous(i+1),96,true))]};
}
const build=(stores,now=Date.parse(at(date,48))+5*60000)=>model.build({period:{to:date},stores,events:[]},{date,now});

test('mixed marketplaces use only complete per-store forecasts and label the total provisional',()=>{
 const result=build([ozon(),wb()]);
 assert.equal(result.kpis.forecast.available,true);
 assert.equal(result.kpis.forecast.value,1960);
 assert.equal(result.kpis.forecast.exact,false);
 assert.equal(result.kpis.forecast.method,'component-historical-share');
 assert.equal(result.kpis.forecast.sampleSize,2);
 assert.deepEqual(result.kpis.forecast.components.map(row=>row.sampleSize),[2,7]);
 assert.equal(result.executive.forecastConfidence,'low');
 assert.equal(result.kpis.yesterdayAtSameTime.value,null);
 assert.equal(result.executive.changePct,null);
 assert.deepEqual(result.series.forecast,[]);
 assert.match(result.forecastLabel,/Предварительная/);
});
test('missing history or stale current store prevents a misleading total',()=>{
 assert.equal(build([ozon(1),wb()]).kpis.forecast.available,false);
 assert.equal(build([ozon(),wb(6)]).kpis.forecast.available,false);
 assert.equal(build([ozon(2,{stale:true}),wb()]).kpis.forecast.available,false);
});
test('recent but delayed store snapshot retains an explicitly timed preliminary forecast',()=>{
 const store=ozon();
 store.days[0].observations[0].at=at(date,43);
 store.updatedAt=at(date,43);
 for(const day of store.days.slice(1))day.observations[0].at=at(day.date,43);
 const result=build([store,wb()]);
 assert.equal(result.kpis.forecast.available,true);
 assert.equal(result.kpis.forecast.exact,false);
 assert.equal(result.kpis.forecast.oldestSnapshotAt,at(date,43));
});
test('short Ozon history with inconsistent intraday shares is held back',()=>{
 const store=ozon();store.days[2].observations[0].orderedRevenue=900;
 assert.equal(build([store]).kpis.forecast.available,false);
});
test('uses the newest recent snapshot that actually has comparable history',()=>{
 const store=ozon();
 store.days[0].observations.unshift({at:at(date,45),orderedRevenue:450,orderedUnits:4,complete:true});
 store.days[1].observations.unshift({at:at(previous(1),45),orderedRevenue:450,orderedUnits:4,complete:true});
 store.days[2].observations[0].at=at(previous(2),45);
 store.days[2].observations[0].orderedRevenue=450;
 const result=build([store,wb()]);
 assert.equal(result.kpis.forecast.available,true);
 assert.equal(result.kpis.forecast.components[0].asOf,at(date,45));
 assert.equal(result.kpis.forecast.sampleSize,2);
});
