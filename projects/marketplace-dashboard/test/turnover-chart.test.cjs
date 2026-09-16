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
