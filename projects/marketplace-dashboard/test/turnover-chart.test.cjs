const test=require('node:test'),assert=require('node:assert/strict'),model=require('../dist/turnover-chart-model.js');
test('intraday lines use the matching data source and preserve actual observation times',()=>{
 const r={days:1,intraday:{orders:[{at:'2026-09-16T11:32:00Z',orderedRevenue:100,orderedUnits:2}],finance:[{at:'2026-09-16T10:00:00Z',realized:60,net:40,ads:0}]}};
 assert.equal(model.points(r,'orderedRevenue')[0].value,100);assert.equal(model.points(r,'net')[0].value,40);assert.equal(model.points(r,'ads')[0].value,0);assert.notEqual(model.points(r,'net')[0].time,model.points(r,'orderedRevenue')[0].time);
});
test('missing series stays unavailable rather than becoming a zero',()=>{
 assert.deepEqual(model.points({days:1,intraday:{orders:[]}},'net'),[]);assert.equal(model.totals({metrics:{realized:{current:null}}},'realized'),null);
 assert.equal(model.totals({metrics:{realized:{current:0}}},'realized'),0);
});

test('store chart retains the real refresh time range for staggered observations',()=>{
 const from='2026-09-20T10:00:00Z',to='2026-09-20T10:20:00Z';
 const point=model.points({days:1,intraday:{orders:[{at:to,orderedRevenue:100,staggered:true,sourceFromAt:from,sourceToAt:to}]}},'orderedRevenue')[0];
 assert.equal(point.time,Date.parse(to));assert.equal(point.staggered,true);assert.equal(point.sourceFromAt,from);assert.equal(point.sourceToAt,to);assert.equal(point.value,100);
});
test('category daily known total distinguishes missing values from observed zero',()=>{
 const missing=model.categoryDailyLine([{points:[{date:'2026-09-14',orderedRevenue:null,complete:false}]}],'orderedRevenue','2026-09-14','2026-09-14',1);
 assert.equal(missing.points[0].value,null);assert.equal(missing.known,null);assert.equal(missing.total,null);assert.equal(missing.complete,false);
 const zero=model.categoryDailyLine([{points:[{date:'2026-09-14',orderedRevenue:0,complete:true}]}],'orderedRevenue','2026-09-14','2026-09-14',1);
 assert.equal(zero.points[0].value,0);assert.equal(zero.known,0);assert.equal(zero.total,0);assert.equal(zero.complete,true);
 const mixed=model.categoryDailyLine([{points:[{date:'2026-09-14',orderedRevenue:125,complete:true},{date:'2026-09-15',orderedRevenue:null,complete:false}]}],'orderedRevenue','2026-09-14','2026-09-15',2);
 assert.deepEqual(mixed.points.map(point=>point.value),[125,null]);assert.equal(mixed.known,125);assert.equal(mixed.total,null);assert.equal(mixed.complete,false);
});
test('daily gaps split line segments; negative values remain visible on a common axis',()=>{
 const points=model.points({days:3,daily:[{date:'2026-09-14',net:30},{date:'2026-09-15',net:null},{date:'2026-09-16',net:-10}]},'net');
 assert.deepEqual(model.segments(points).map(s=>s.map(p=>p.value)),[[30],[-10]]);assert.deepEqual(model.domain([{points},{points:[{value:100}]}]),{min:-10,max:100});
});

test('a missing category marketplace or amount keeps the known value explicitly partial',()=>{
 const point={date:'2026-09-14',orderedRevenue:125,complete:true,observed:true};
 for(const other of [[],[{...point,orderedRevenue:null}],[{...point,orderedRevenue:900,observed:false}]]){
  const line=model.categoryDailyLine([{points:[point]},{points:other}],'orderedRevenue',point.date,point.date,1);
  assert.equal(line.points[0].value,125);assert.equal(line.points[0].partial,true);
  assert.equal(line.known,125);assert.equal(line.total,null);assert.equal(line.complete,false);
 }
 const knownPartial=model.categoryDailyLine([{points:[{...point,complete:false,revenueKnown:false}]}],'orderedRevenue',point.date,point.date,1);
 assert.equal(knownPartial.known,125);assert.equal(knownPartial.total,null);assert.equal(knownPartial.points[0].partial,true);
});
test('total and individual store series remain independent and are never summed twice',()=>{
 const total={days:1,intraday:{orders:[{at:'2026-09-16T12:00:00Z',orderedRevenue:300}]}},shop={days:1,intraday:{orders:[{at:'2026-09-16T12:00:00Z',orderedRevenue:100}]}};
 const series=[total,shop].map(r=>({points:model.points(r,'orderedRevenue')}));assert.equal(model.domain(series).max,300);assert.equal(series[0].points[0].value,300);assert.equal(series[1].points[0].value,100);
});
test('marketplace total combines Ozon aggregate with WB using aligned real observations only',()=>{
 const lines=[
  {id:'',market:'Ozon',report:{coverage:{orders:true}},points:[{time:Date.parse('2026-09-23T10:00:00Z'),label:'o1',value:100},{time:Date.parse('2026-09-23T10:30:00Z'),label:'o2',value:150}]},
  {id:'1',market:'Ozon',points:[{time:Date.parse('2026-09-23T10:30:00Z'),value:90}]},
  {id:'wb-1',market:'WB',report:{coverage:{orders:true}},points:[{time:Date.parse('2026-09-23T10:20:00Z'),label:'w1',value:40},{time:Date.parse('2026-09-23T11:01:00Z'),label:'w2',value:60}]}
 ],combined=model.combineMarketplaceLines(lines,{days:1,metric:'orderedRevenue'}),actual=combined.points.filter(point=>point.value!==null);
 assert.deepEqual(combined.includedIds,['ozon-total','wb-1']);assert.deepEqual(combined.missingIds,[]);assert.equal(combined.complete,false);
 assert.deepEqual(actual.map(point=>point.value),[140,190]);assert.equal(actual[0].time,Date.parse('2026-09-23T10:20:00Z'));assert.equal(actual[0].sourceSkewMs,20*60000);assert.equal(actual[0].staggered,true);assert.equal(actual[0].sources.length,2);
 assert.equal(combined.points.at(-1).value,null);assert.equal(combined.points.at(-1).partial,true);assert.equal(combined.total,null);
});
test('marketplace total keeps missing sources and daily coverage as gaps, never zero',()=>{
 const missing=model.combineMarketplaceLines([{id:'',market:'Ozon',points:[{time:1,label:'x',value:10}]},{id:'wb-1',market:'WB',report:{coverage:{orders:false}},points:[]}],{days:1,metric:'orderedUnits'});
 assert.deepEqual(missing.missingIds,['wb-1']);assert.equal(missing.points[0].value,null);assert.equal(missing.total,null);assert.equal(missing.complete,false);
 const daily=model.combineMarketplaceLines([{id:'',market:'Ozon',points:[{time:1,label:'2026-09-21',value:3},{time:2,label:'2026-09-22',value:4}]},{id:'wb-1',market:'WB',points:[{time:1,label:'2026-09-21',value:2}]}],{days:2,metric:'orderedUnits'});
 assert.deepEqual(daily.points.map(point=>point.value),[5,null]);assert.equal(daily.points[1].partial,true);assert.equal(daily.total,null);assert.equal(daily.complete,false);
});
test('marketplace total rejects finite partial inputs and deduplicates WB identities',()=>{
 const at=Date.parse('2026-09-23T10:00:00Z'),ozon={id:'',market:'Ozon',points:[{time:at,label:'2026-09-23',value:10}]},wb={id:'wb-1',market:'WB',points:[{time:at,label:'2026-09-23',value:5,partial:true}]};
 const intraday=model.combineMarketplaceLines([ozon,wb,{...wb,points:[{time:at,label:'2026-09-23',value:500}]}],{days:1,metric:'orderedUnits'});
 assert.deepEqual(intraday.includedIds,['ozon-total','wb-1']);assert.equal(intraday.points[0].value,null);assert.equal(intraday.total,null);assert.equal(intraday.complete,false);
 const daily=model.combineMarketplaceLines([ozon,wb],{days:2,metric:'orderedUnits'});assert.equal(daily.points[0].value,null);assert.equal(daily.points[0].partial,true);assert.equal(daily.total,null);
});
test('point inspection keeps zero and negative corrections, without comparing across a gap',()=>{
 const points=[{time:1,value:100},{time:2,value:0},{time:3,value:-10},{time:4,value:null},{time:5,value:80}];
 assert.equal(model.observation(points,0).delta,null);
 assert.equal(model.observation(points,1).delta,-100);
 assert.equal(model.observation(points,2).delta,-10);
 assert.equal(model.observation(points,3),null);
 assert.equal(model.observation(points,4).delta,null);
 assert.equal(model.observation(points,5),null);
 assert.equal(model.observation(points,-1),null);
 assert.equal(model.observation([{time:1,value:0},{time:2,value:20}],1).delta,20);
});

function comparisonReport(date,snapshots,total=1000,source='orders',key='orderedRevenue'){
 return {days:1,current:{from:date,to:date},metrics:{[key]:{current:total}},intraday:{[source]:snapshots.map(([at,value])=>({at,[key]:value}))}};
}
test('five minute order comparison rejects a stale baseline but accepts the interval boundary',()=>{
 const today=comparisonReport('2026-09-16',[['2026-09-16T12:00:00Z',600]]);today.intraday.ordersIntervalMinutes=5;
 const old=comparisonReport('2026-09-15',[['2026-09-15T11:54:59Z',500]]);
 assert.equal(model.comparison(today,old,'orderedRevenue').mode,'full-day');
 old.intraday.orders[0].at='2026-09-15T11:55:00Z';
 assert.equal(model.comparison(today,old,'orderedRevenue').delta,100);
});
test('today comparisons align Moscow time across yesterday and the same weekday, including month boundaries',()=>{
 assert.equal(model.shiftDate('2026-09-01',-1),'2026-08-31');
 assert.equal(model.shiftDate('2026-09-01',-7),'2026-08-25');
 const today=comparisonReport('2026-09-16',[['2026-09-16T12:00:00Z',600]]);
 const past=comparisonReport('2026-09-15',[['2026-09-15T11:50:00Z',500],['2026-09-15T12:10:00Z',700]]);
 const result=model.comparison(today,past,'orderedRevenue');
 assert.equal(result.mode,'same-time');assert.equal(result.previous.value,500);assert.equal(result.delta,100);assert.equal(result.percent,20);
 const aligned=model.alignedPoints(past,'orderedRevenue','2026-09-16');
 assert.equal(aligned[0].time,Date.parse('2026-09-16T11:50:00Z'));assert.equal(aligned[0].originalTime,Date.parse('2026-09-15T11:50:00Z'));
});
test('missing, stale or future observations fall back to full-day totals without a false growth percentage',()=>{
 const today=comparisonReport('2026-09-16',[['2026-09-16T12:00:00Z',600]]);
 for(const observations of [[],[['2026-09-15T11:29:59Z',500]],[['2026-09-15T12:00:01Z',500]],[['2026-09-15T11:50:00Z',null]]]){
  const result=model.comparison(today,comparisonReport('2026-09-15',observations,1000),'orderedRevenue');
  assert.equal(result.mode,'full-day');assert.equal(result.fullDay,1000);assert.equal(result.delta,null);assert.equal(result.percent,null);
 }
 assert.equal(model.comparison(today,comparisonReport('2026-09-15',[],null),'orderedRevenue').mode,'unavailable');
 assert.equal(model.comparison(today,comparisonReport('2026-09-15',[],0),'orderedRevenue').fullDay,0);
 assert.deepEqual(model.alignedPoints(comparisonReport('2026-09-15',[]),'orderedRevenue','2026-09-16'),[]);
});
test('comparison boundary is inclusive; zero, signed finance values and missing today remain explicit',()=>{
 const today=comparisonReport('2026-09-16',[['2026-09-16T12:00:00Z',10]]);
 let baseline=comparisonReport('2026-09-09',[['2026-09-09T11:30:00Z',0]],0);
 let result=model.comparison(today,baseline,'orderedRevenue');assert.equal(result.mode,'same-time');assert.equal(result.delta,10);assert.equal(result.percent,null);
 const finance=comparisonReport('2026-09-16',[['2026-09-16T12:00:00Z',-30]],-30,'finance','net');
 baseline=comparisonReport('2026-09-15',[['2026-09-15T12:00:00Z',-10]],-10,'finance','net');
 result=model.comparison(finance,baseline,'net');assert.equal(result.delta,-20);assert.equal(result.percent,null);
 assert.equal(model.comparison(comparisonReport('2026-09-16',[]),baseline,'net').mode,'full-day');
});

function forecastHistory(value=700,key='orderedRevenue',today='2026-09-18'){
 const from=model.shiftDate(today,-21),to=model.shiftDate(today,-1);
 return {days:21,current:{from,to},coverage:{orders:true},daily:Array.from({length:21},(_,i)=>({date:model.shiftDate(from,i),[key]:value}))};
}
test('order forecast starts at the last actual cutoff and reaches the mean of three same weekdays at Moscow midnight',()=>{
 const today=comparisonReport('2026-09-18',[['2026-09-18T09:37:00Z',300]]),history=forecastHistory();
 const before=structuredClone(today),f=model.orderForecast(today,history,'orderedRevenue',{now:'2026-09-18T10:00:00Z'});
 assert.equal(f.status,'available');assert.equal(f.average,700);assert.equal(f.endValue,700);
 assert.equal(f.points[0].time,Date.parse('2026-09-18T09:37:00Z'));assert.equal(f.points[0].value,300);
 assert.equal(f.points[1].time,Date.parse('2026-09-18T10:00:00Z'));
 assert.equal(f.points.at(-1).time,Date.parse('2026-09-18T21:00:00Z'));assert.equal(f.points.at(-1).value,700);
 assert.ok(f.points.every((p,i)=>p.forecast&&(i===0||p.time>f.points[i-1].time)));
 assert.deepEqual(today,before);assert.equal(model.totals(today,'orderedRevenue'),1000);
 assert.equal(model.points(today,'orderedRevenue').length,1);
});
test('forecast requires three covered same weekdays; missing days, duplicate dates and unknown values stay unavailable',()=>{
 const today=comparisonReport('2026-09-18',[['2026-09-18T09:00:00Z',300]]),options={now:'2026-09-18T10:00:00Z'};
 const mutations=[h=>h.coverage.orders=false,h=>h.daily.shift(),h=>h.daily.push({...h.daily[0]}),
  h=>h.daily[0].orderedRevenue=null,h=>h.daily[0].orderedRevenue=-1,h=>h.daily[0].orderedRevenue=NaN,
  h=>h.current.from='2026-09-10',h=>h.current.to='2026-09-18',h=>h.days=6];
 for(const change of mutations){const h=forecastHistory();change(h);const f=model.orderForecast(today,h,'orderedRevenue',options);assert.equal(f.status,'unavailable');assert.equal(f.endValue,null);assert.deepEqual(f.points,[]);assert.ok(f.reason)}
 const missingToday=comparisonReport('2026-09-18',[['2026-09-18T09:00:00Z',300],['2026-09-18T09:05:00Z',null]]);
 assert.equal(model.orderForecast(missingToday,forecastHistory(),'orderedRevenue',options).status,'unavailable');
});
test('zero is a valid baseline and today above average stays flat, with independent total and store forecasts',()=>{
 const options={now:'2026-09-18T10:00:00Z'};
 const zero=comparisonReport('2026-09-18',[['2026-09-18T09:00:00Z',0]],0,'orders','orderedUnits');
 const z=model.orderForecast(zero,forecastHistory(0,'orderedUnits'),'orderedUnits',options);
 assert.equal(z.status,'available');assert.equal(z.endValue,0);assert.ok(z.points.every(p=>p.value===0));
 const today=comparisonReport('2026-09-18',[['2026-09-18T09:00:00Z',900]]);
 const high=model.orderForecast(today,forecastHistory(),'orderedRevenue',options);
 assert.equal(high.endValue,900);assert.ok(high.points.every(p=>p.value===900));
 const shop=comparisonReport('2026-09-18',[['2026-09-18T09:00:00Z',100]]);
 assert.equal(model.orderForecast(shop,forecastHistory(250),'orderedRevenue',options).endValue,250);
 assert.equal(high.endValue,900);
});
test('forecast is today-only in Moscow, excludes future snapshots, and never applies to financial metrics',()=>{
 const today=comparisonReport('2026-09-18',[['2026-09-17T21:00:00Z',1],['2026-09-18T08:00:00Z',9000]]);
 const h=forecastHistory();
 const f=model.orderForecast(today,h,'orderedRevenue',{now:'2026-09-17T21:01:00Z'});
 assert.equal(f.status,'available');assert.equal(f.points[0].value,1);
 assert.equal(model.orderForecast(today,h,'orderedRevenue',{now:'2026-09-17T20:59:59Z'}).status,'unavailable');
 assert.equal(model.orderForecast(today,h,'orderedRevenue',{now:'2026-09-18T21:00:00Z'}).status,'unavailable');
 for(const key of ['realized','net','ads','ourMargin','ourRoi'])assert.equal(model.orderForecast(today,h,key,{now:'2026-09-18T10:00:00Z'}).status,'unavailable');
 assert.equal(model.orderForecast({...today,days:2},h,'orderedRevenue',{now:'2026-09-18T10:00:00Z'}).status,'unavailable');
});

test('weekday forecast ignores other weekdays and exposes the three comparable dates',()=>{const history=forecastHistory(9000);history.daily[0].orderedRevenue=100;history.daily[7].orderedRevenue=200;history.daily[14].orderedRevenue=600;const today=comparisonReport('2026-09-18',[['2026-09-18T09:00:00Z',50]]);const f=model.orderForecast(today,history,'orderedRevenue',{now:'2026-09-18T10:00:00Z'});assert.equal(f.average,300);assert.equal(f.endValue,300);assert.deepEqual(f.basis,[{date:'2026-08-28',value:100},{date:'2026-09-04',value:200},{date:'2026-09-11',value:600}]);history.daily[14].orderedRevenue=null;assert.equal(model.orderForecast(today,history,'orderedRevenue',{now:'2026-09-18T10:00:00Z'}).status,'unavailable')});
