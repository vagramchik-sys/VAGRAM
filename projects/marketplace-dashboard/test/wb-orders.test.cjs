const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {create,normalize,instant}=require('../wb-orders.cjs');
const DAY='2026-09-20',at=time=>DAY+'T'+time;
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-orders-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir}
test('Moscow timestamps, duplicate updates and cancellations produce a net order curve without finance substitution',()=>{
 const result=normalize([
  {srid:'a',date:at('10:00:00'),lastChangeDate:at('10:01:00'),priceWithDisc:100,isCancel:false},
  {srid:'a',date:at('10:00:00'),lastChangeDate:at('10:05:00'),priceWithDisc:100,isCancel:true},
  {srid:'b',date:at('11:00:00.123456'),lastChangeDate:at('11:01:00'),priceWithDisc:250.125,isCancel:false,nmId:12,category:'Строительство',subject:'Саморезы'},
  {srid:'c',date:at('11:00:00.123456'),lastChangeDate:at('11:02:00'),priceWithDisc:50,isCancel:false,nmId:13,category:'Хозяйственные товары',subject:'Перчатки'}
 ],DAY,{fetchedAt:'2026-09-20T09:00:00.000Z'});
 assert.equal(instant(at('00:00:00')),Date.parse('2026-09-19T21:00:00.000Z'));assert.equal(result.orderedRevenue,300.13);assert.equal(result.orderedUnits,2);assert.equal(result.cancelledRows,1);assert.equal(result.points[0].at,'2026-09-20T08:00:00.123Z');assert.equal(result.points[0].orderedRevenue,300.13);assert.equal(result.amountBasis,'priceWithDisc');assert.deepEqual(result.orders.map(row=>[row.nmId,row.category,row.subject]),[['12','Строительство','Саморезы'],['13','Хозяйственные товары','Перчатки']]);
});
test('a successful empty full-day response is a known zero, while malformed rows fail closed',()=>{
 const zero=normalize([],DAY,{fetchedAt:'2026-09-20T10:00:00.000Z'});assert.equal(zero.complete,true);assert.equal(zero.orderedRevenue,0);assert.equal(zero.orderedUnits,0);assert.deepEqual(zero.points,[{at:'2026-09-20T10:00:00.000Z',orderedRevenue:0,orderedUnits:0}]);
 assert.throws(()=>normalize([{srid:'x',date:at('12:00:00'),priceWithDisc:null}],DAY),/неполные поля/);
 assert.throws(()=>normalize([{srid:'x',date:'2026-09-19T12:00:00',priceWithDisc:1}],DAY),/неполные поля/);
});
test('durable refresh is idempotent across restarts and respects the 30 minute gate',async t=>{
 const privateDir=temp(t),stores={'wb-1':{market:'WB',key:'encrypted'}},rows=[{srid:'x',date:at('12:00:00'),lastChangeDate:at('12:01:00'),priceWithDisc:123,isCancel:false}];let clock=Date.parse('2026-09-20T10:00:00Z'),calls=0;
 const options={stores,privateDir,protect:async()=> 'secret',now:()=>clock,fetchImpl:async()=>{calls++;return {ok:true,status:200,json:async()=>rows}}};
 let service=create(options),first=await service.report({storeId:'wb-1',date:DAY});assert.equal(calls,1);assert.equal(first.metrics.orderedRevenue.current,123);assert.equal(first.intraday.orders.length,2);
 service=create(options);const repeat=await service.report({storeId:'wb-1',date:DAY});assert.equal(calls,1);assert.deepEqual(repeat.intraday.orders,first.intraday.orders);
 clock+=30*60*1000;await service.report({storeId:'wb-1',date:DAY});assert.equal(calls,2);
});
test('missing Statistics scope preserves the last success and reports an exact blocker without exposing credentials',async t=>{
 const privateDir=temp(t),stores={'wb-1':{market:'WB',key:'encrypted'}},row={srid:'x',date:at('12:00:00'),lastChangeDate:at('12:01:00'),priceWithDisc:10,isCancel:false};let clock=Date.parse('2026-09-20T10:00:00Z'),status=200;
 const service=create({stores,privateDir,protect:async()=> 'super-secret',now:()=>clock,fetchImpl:async()=>status===200?{ok:true,status,json:async()=>[row]}:{ok:false,status,json:async()=>({})}});await service.report({storeId:'wb-1',date:DAY});clock+=30*60*1000;status=403;
 const report=await service.report({storeId:'wb-1',date:DAY});assert.equal(report.metrics.orderedRevenue.current,10);assert.equal(report.coverage.orders,true);assert.match(report.warning,/Statistics/);assert.equal(service.schedule('wb-1').errorCode,'statistics_scope');assert.match(service.schedule('wb-1').error,/Statistics/);assert.doesNotMatch(JSON.stringify(service.readState('wb-1')),/super-secret/);
});
test('rate limiting keeps the cached line and persists the retry gate across restarts',async t=>{
 const privateDir=temp(t),stores={'wb-1':{market:'WB',key:'encrypted'}},row={srid:'x',date:at('12:00:00'),lastChangeDate:at('12:01:00'),priceWithDisc:10,isCancel:false};let clock=Date.parse('2026-09-20T10:00:00Z'),calls=0;
 const options={stores,privateDir,protect:async()=> 'secret',now:()=>clock,fetchImpl:async()=>{calls++;return calls===1?{ok:true,status:200,json:async()=>[row]}:{ok:false,status:429,headers:{get:name=>name==='Retry-After'?'7200':null},json:async()=>({})}}};
 let service=create(options);await service.report({storeId:'wb-1',date:DAY});clock+=30*60*1000;let report=await service.report({storeId:'wb-1',date:DAY});assert.equal(calls,2);assert.equal(report.metrics.orderedRevenue.current,10);assert.equal(service.schedule('wb-1').nextAt,'2026-09-20T12:30:00.000Z');
 service=create(options);clock+=30*60*1000;report=await service.report({storeId:'wb-1',date:DAY});assert.equal(calls,2);assert.equal(report.metrics.orderedRevenue.current,10);
});

