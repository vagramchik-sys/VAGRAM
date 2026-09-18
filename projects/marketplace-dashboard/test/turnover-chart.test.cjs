const test=require('node:test'),assert=require('node:assert/strict'),model=require('../dist/turnover-chart-model.js');
test('intraday lines use the matching data source and preserve actual observation times',()=>{
 const r={days:1,intraday:{orders:[{at:'2026-09-16T11:32:00Z',orderedRevenue:100,orderedUnits:2}],finance:[{at:'2026-09-16T10:00:00Z',realized:60,net:40,ads:0}]}};
 assert.equal(model.points(r,'orderedRevenue')[0].value,100);assert.equal(model.points(r,'net')[0].value,40);assert.equal(model.points(r,'ads')[0].value,0);assert.notEqual(model.points(r,'net')[0].time,model.points(r,'orderedRevenue')[0].time);
});
test('missing series stays unavailable rather than becoming a zero',()=>{
 assert.deepEqual(model.points({days:1,intraday:{orders:[]}},'net'),[]);assert.equal(model.totals({metrics:{realized:{current:null}}},'realized'),null);
 assert.equal(model.totals({metrics:{realized:{current:0}}},'realized'),0);
});
test('daily gaps split line segments; negative values remain visible on a common axis',()=>{
 const points=model.points({days:3,daily:[{date:'2026-09-14',net:30},{date:'2026-09-15',net:null},{date:'2026-09-16',net:-10}]},'net');
 assert.deepEqual(model.segments(points).map(s=>s.map(p=>p.value)),[[30],[-10]]);assert.deepEqual(model.domain([{points},{points:[{value:100}]}]),{min:-10,max:100});
});
test('total and individual store series remain independent and are never summed twice',()=>{
 const total={days:1,intraday:{orders:[{at:'2026-09-16T12:00:00Z',orderedRevenue:300}]}},shop={days:1,intraday:{orders:[{at:'2026-09-16T12:00:00Z',orderedRevenue:100}]}};
 const series=[total,shop].map(r=>({points:model.points(r,'orderedRevenue')}));assert.equal(model.domain(series).max,300);assert.equal(series[0].points[0].value,300);assert.equal(series[1].points[0].value,100);
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
 const from=model.shiftDate(today,-7),to=model.shiftDate(today,-1);
 return {days:7,current:{from,to},coverage:{orders:true},daily:Array.from({length:7},(_,i)=>({date:model.shiftDate(from,i),[key]:value}))};
}
test('order forecast starts at the last actual cutoff and reaches the seven-day mean at Moscow midnight',()=>{
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
test('forecast requires exactly seven covered known days; missing days, duplicate dates and unknown values stay unavailable',()=>{
 const today=comparisonReport('2026-09-18',[['2026-09-18T09:00:00Z',300]]),options={now:'2026-09-18T10:00:00Z'};
 const mutations=[h=>h.coverage.orders=false,h=>h.daily.pop(),h=>h.daily[1].date=h.daily[0].date,
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
