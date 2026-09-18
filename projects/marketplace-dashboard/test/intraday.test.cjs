const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {point,combine,create,day}=require('../intraday.cjs'),{due,nextAt,INTERVAL}=require('../refresh-policy.cjs');
const date='2026-09-16',at=h=>`${date}T${h}:00:00.000Z`;
const sample=(h,revenue,units=1)=>({date,source:'orders',at:at(h),values:{orderedRevenue:revenue*100,orderedUnits:units}});
test('30 minute refresh uses attempt start, survives restart, skips overlap and retries failed attempts on schedule',()=>{
 const start=Date.parse(at('10')),state={attemptAt:at('10'),snapshotAt:'2026-09-16T10:08:00Z'};
 assert.equal(due(state,start+INTERVAL-1),false);assert.equal(due(state,start+INTERVAL),true);
 assert.equal(nextAt(state,start),'2026-09-16T10:30:00.000Z');
 assert.equal(due({...state,job:{status:'running',startedAt:at('10')}},start+2*INTERVAL),false);
 assert.equal(due({...state,job:{status:'error',startedAt:at('10')}},start+INTERVAL),true);
});
test('Moscow day and source coverage prevent a false zero after midnight',()=>{
 assert.equal(day(new Date('2026-09-15T21:10:00Z')),date);
 const s={updatedAt:'2026-09-15T21:10:00Z',period:{from:'2026-09-15',to:'2026-09-15'},daily:[]};assert.equal(point('orders',s),null);
 s.period.to=date;s.daily=[{date,revenue:1.23,units:2}];assert.deepEqual(point('orders',s).values,{orderedRevenue:123,orderedUnits:2});
});
test('finance captures signed daily totals, excludes failed snapshots and does not duplicate advertising',()=>{
 const s={completedAt:at('10'),period:{from:date,to:date},complete:true,daily:[{date,values:{realized:10000,net:7300,ads:-500}},{date:'2026-09-15',values:{net:999999}}]};
 assert.deepEqual(point('finance',s).values,{realized:10000,net:7300,ads:500});s.complete=false;assert.equal(point('finance',s),null);
});
test('combined series waits for every store, preserves corrections and never invents the morning',()=>{
 const a=[sample('10',100),sample('11',90)],b=[sample('10',200),sample('11',220)];
 let r=combine([a,b],'orders',date);assert.deepEqual(r.map(p=>p.orderedRevenue),[300,310]);assert.equal(r[0].at,at('10'));
 assert.equal(combine([a,[]],'orders',date).length,0);assert.equal(combine([a,[b[0]]],'orders',date).length,1);
 assert.deepEqual(combine([a],'orders',date).map(p=>p.orderedRevenue),[100,90]);
});
test('a stale store does not cause a fabricated combined point; later matching snapshots recover',()=>{
 const a=[sample('10',100),sample('12',200)],b=[sample('11',300),sample('12',400)];
 const r=combine([a,b],'orders',date);assert.equal(r.length,1);assert.equal(r[0].orderedRevenue,600);assert.equal(r[0].at,at('12'));
});
test('orders combine only observations within five minutes while finance keeps thirty minutes',()=>{
 const a=sample('10',100),b={...sample('10',200),at:'2026-09-16T10:05:00Z'};
 assert.equal(combine([[a],[b]],'orders',date)[0].orderedRevenue,300);
 b.at='2026-09-16T10:05:01Z';assert.equal(combine([[a],[b]],'orders',date).length,0);
 a.source=b.source='finance';assert.equal(combine([[a],[b]],'finance',date).length,1);
});
test('history is durable, repeated reads do not add points, and unchanged imported values produce a flat next point',()=>{
 const parent=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(parent,'pult-intraday-test-'));
 try{const h=create({privateDir:dir}),orders={period:{from:date,to:date},updatedAt:at('10'),daily:[{date,revenue:10,units:2}]};
 h.capture('1',{orders});h.capture('1',{orders});assert.equal(h.series(['1'],date).orders.length,1);
 orders.updatedAt=at('11');h.capture('1',{orders});const restored=create({privateDir:dir}).series(['1'],date).orders;
 assert.deepEqual(restored.map(p=>p.orderedRevenue),[10,10]);assert.equal(restored.length,2);
 }finally{const target=path.resolve(dir);assert.equal(path.dirname(target),parent);assert.ok(path.basename(target).startsWith('pult-intraday-test-'));fs.rmSync(target,{recursive:true,force:true})}
});

test('intraday economics uses combined bases and leaves legacy or incomplete snapshots unavailable',()=>{
 const make=e=>({date,source:'finance',at:at('10'),values:{realized:e.realized*100,net:0,ads:0},economy:e});
 const a=make({profit:70,cogs:30,realized:100}),b=make({profit:500,cogs:500,realized:1000});
 const result=combine([[a],[b]],'finance',date)[0];assert.equal(result.ourRoi,570/530*100);assert.equal(result.ourMargin,570/1100*100);
 delete b.economy;assert.equal(combine([[a],[b]],'finance',date)[0].ourRoi,null);
 b.economy={profit:null,cogs:null,realized:1000};assert.equal(combine([[a],[b]],'finance',date)[0].ourMargin,null);
 a.economy={profit:-5,cogs:0,realized:0};assert.equal(combine([[a]],'finance',date)[0].ourRoi,null);
});

test('new finance observations freeze current costs without rewriting older observations',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pult-intraday-economics-'));
 try{const h=create({privateDir:dir}),values={realized:10000,net:8000,salesRows:1,soldUnits:1},ledger={version:3,complete:true,period:{from:date,to:date},completedAt:at('10'),daily:[{date,values}],skuDaily:[{date,sku:'1',values}]},products=[{sku:'1',cost:{status:'filled',currency:'RUB',unitCost:30}}];
 h.capture('1',{ledger,products});products[0].cost.unitCost=40;h.capture('1',{ledger,products});assert.equal(h.series(['1'],date).finance[0].ourRoi,50/30*100);
 ledger.completedAt=at('11');h.capture('1',{ledger,products});const points=h.series(['1'],date).finance;assert.equal(points.length,2);assert.equal(points[1].ourRoi,100);assert.equal(points[0].ourMargin,50);
 }finally{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('pult-intraday-economics-'));fs.rmSync(dir,{recursive:true,force:true})}
});
