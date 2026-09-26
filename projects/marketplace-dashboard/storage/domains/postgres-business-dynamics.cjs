'use strict';

const DAY=86400000,INTERVAL=15*60000;
const iso=ms=>new Date(ms).toISOString();
const moscowDay=ms=>iso(ms+3*3600000).slice(0,10);
const validDay=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d))&&iso(Date.parse(d)).slice(0,10)===d;
const start=d=>Date.parse(d+'T00:00:00+03:00');
const time=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isFinite(Date.parse(v))?Date.parse(v):null;
const money=v=>typeof v==='number'&&Number.isFinite(v)&&Number.isSafeInteger(Math.round(v*100));
const units=v=>Number.isSafeInteger(v)&&v>=0;
const emptyTotals=()=>({orderedRevenue:null,orderedUnits:null,orderCount:null});
const metrics=(revenue,count)=>money(revenue)&&units(count)?{orderedRevenue:revenue,orderedUnits:count,orderCount:null}:null;
class DynamicsError extends Error {constructor(message,status=400){super(message);this.status=status;this.public=true;}}

function emptyDay(date,reason='Заказы за этот день недоступны.') {
 return {date,basis:'unavailable',complete:false,updatedAt:null,coverage:{from:null,to:null,intervalsComplete:0},totals:emptyTotals(),intervals:[],observations:[],reason};
}

function observation(raw,date,now) {
 const at=time(raw?.at),v=raw?.values;
 if(at===null||at>now||moscowDay(at)!==date||raw.date!==date||!v||!Number.isSafeInteger(v.orderedRevenue)||!units(v.orderedUnits))return null;
 const complete=raw.complete===true&&time(raw.coverage?.from)===start(date)&&time(raw.coverage?.to)===at;
 return {at:iso(at),orderedRevenue:v.orderedRevenue/100,orderedUnits:v.orderedUnits,orderCount:null,complete};
}

function ozonDays(days,head,rows,now) {
 const orders=head?.orders,covered=date=>validDay(orders?.period?.from)&&validDay(orders?.period?.to)&&orders.period.from<=date&&orders.period.to>=date;
 for(const target of days) {
  const date=target.date,daily=rows.filter(r=>r.kind==='daily'&&r.value?.date===date),dailyRow=daily.length===1?daily[0]:null;
  const latest=time(orders?.updatedAt),isObservedDay=date===orders?.todayDate||latest!==null&&moscowDay(latest)===date;
  // Current-day coverage comes from the live head. Historical totals are
  // certified by the daily fact itself, after its Moscow day has closed.
  const factUpdated=time(dailyRow?.value?.factUpdatedAt),finalized=time(dailyRow?.value?.finalizedAt),dayEnd=start(date)+DAY;
  const validFinalized=finalized!==null&&finalized<=now&&finalized>=dayEnd;
  const rawAt=isObservedDay?orders?.todayUpdatedAt||orders?.updatedAt:validFinalized?dailyRow.value.finalizedAt:dailyRow?.value?.factUpdatedAt;
  const updated=time(rawAt),dailyMetrics=dailyRow?metrics(dailyRow.value.revenue,dailyRow.value.units):null;
  const usable=covered(date)&&updated!==null&&updated<=now&&updated>=start(date)&&dailyMetrics;
  const dailyComplete=usable&&(validFinalized||factUpdated!==null&&factUpdated>=dayEnd);
  const points=rows.filter(r=>r.kind==='observation'&&r.value?.date===date).map(r=>observation(r.value,date,now)).filter(Boolean);
  // The current head may precede the derived history writer. Its explicit day
  // coverage can prove a new cumulative observation without writing from GET.
  const latestAt=updated;
  if(usable&&latestAt!==null&&latestAt<=now&&moscowDay(latestAt)===date)points.push({at:iso(latestAt),...dailyMetrics,complete:isObservedDay||dailyComplete});
  // Keep the last real observation in each 15-minute display slot. These are
  // cumulative observations, never sales in that slot and never differenced.
  const slots=new Map();
  for(const point of points.sort((a,b)=>a.at.localeCompare(b.at)))slots.set(Math.floor((Date.parse(point.at)-start(date))/INTERVAL),point);
  const observations=[...slots.values()],confirmed=observations.filter(p=>p.complete),last=confirmed.at(-1);
  target.basis=observations.length||usable?'observation':'unavailable';target.observations=observations;
  if(usable){target.totals=dailyMetrics;target.updatedAt=iso(updated);target.complete=dailyComplete;}
  else if(last){target.totals={orderedRevenue:last.orderedRevenue,orderedUnits:last.orderedUnits,orderCount:null};target.updatedAt=last.at;}
  else if(observations.length)target.updatedAt=observations.at(-1).at;
  if(last)target.coverage={from:iso(start(date)),to:last.at,intervalsComplete:0};
  if(target.complete)target.coverage={from:iso(start(date)),to:iso(start(date)+DAY),intervalsComplete:0};
  target.reason=target.basis==='unavailable'?'Нет подтверждённых данных Ozon за этот день.':'Ozon хранит дневные суммы и накопительные наблюдения. Время отдельных заказов неизвестно; продажи за 15 минут недоступны.';
 }
}

function wbDays(days,head,rows,now) {
 const target=days.find(d=>d.date===head?.day);if(!target)return;
 const fetched=time(head.fetchedAt),totals=metrics(head.orderedRevenue,head.orderedUnits),raw=rows.filter(r=>r.kind==='wb-interval').map(r=>r.value);
 if(head.complete!==true||!head.orderRowsPresent||!units(head.orderRowsCount)||fetched===null||fetched>now||fetched<start(target.date)||!totals)return;
 const buckets=new Map();let revenue=0,count=0;
 for(const row of raw) {
  const at=time(row.from),first=time(row.firstAt),last=time(row.lastAt),m=metrics(row.orderedRevenue,row.orderedUnits);
  if(at===null||at%INTERVAL!==0||moscowDay(at)!==target.date||!m||m.orderedRevenue<0||first===null||last===null||first<at||last>=at+INTERVAL||last>fetched||first>last||buckets.has(at))return;
  revenue+=Math.round(m.orderedRevenue*100);count+=m.orderedUnits;buckets.set(at,m);
 }
 if(!Number.isSafeInteger(revenue)||!Number.isSafeInteger(count)||count!==head.orderRowsCount||count!==totals.orderedUnits||revenue!==Math.round(totals.orderedRevenue*100))return;
 const end=Math.min(fetched,start(target.date)+DAY),intervals=[];
 // Zero is valid only inside an explicitly complete imported snapshot whose
 // rows reconcile to its totals. Future and uncovered intervals remain absent.
 for(let at=start(target.date);at<end;at+=INTERVAL) {
  const complete=at+INTERVAL<=end;
  intervals.push({from:iso(at),to:iso(at+INTERVAL),...(buckets.get(at)||{orderedRevenue:0,orderedUnits:0,orderCount:null}),complete,status:complete?'ready':'partial'});
 }
 Object.assign(target,{basis:'order-time',complete:end===start(target.date)+DAY,updatedAt:iso(fetched),coverage:{from:iso(start(target.date)),to:iso(end),intervalsComplete:intervals.filter(i=>i.complete).length},totals,intervals,reason:'WB: активные товарные единицы по времени заказа; отменённые исключены. Сумма priceWithDisc, число покупательских заказов неизвестно.'});
}

function createBusinessDynamics({repository,storesRepository,now=()=>Date.now()}={}) {
 if(typeof repository?.read!=='function'||typeof repository?.readTarget!=='function'||typeof storesRepository?.read!=='function')throw new TypeError('Business dynamics SQL dependencies are required');
 async function read({date,storeId,market='all'}={}) {
  const instant=Number(new Date(now()));if(!Number.isFinite(instant))throw Error('Invalid clock');
  const target=date||moscowDay(instant);
  if(!validDay(target)||target>moscowDay(instant)||!['all','Ozon','WB'].includes(market)||storeId!==undefined&&(typeof storeId!=='string'||!/^(?:wb-)?[0-9]+$/.test(storeId)))throw new DynamicsError('Проверьте дату, магазин и маркетплейс.');
  const directory=await storesRepository.read();
  if(storeId&&!Object.hasOwn(directory,storeId))throw new DynamicsError('Магазин не подключён.',404);
  const stores=Object.entries(directory).map(([id,s])=>({id,name:s.name,market:s.market==='WB'?'WB':'Ozon'})).filter(s=>(!storeId||s.id===storeId)&&(market==='all'||s.market===market));
  if(storeId&&!stores.length)throw new DynamicsError('Магазин не относится к выбранному маркетплейсу.');
  const dates=Array.from({length:29},(_,i)=>moscowDay(start(target)-(28-i)*DAY)),period={from:dates[0],to:target};
  const targetScope=storeId?{scopeType:'store',scopeId:storeId}:market==='all'?{scopeType:'all',scopeId:''}:{scopeType:'marketplace',scopeId:market};
  const [result,salesTarget]=await Promise.all([repository.read({storeIds:stores.map(s=>s.id),...period}),repository.readTarget({date:target,...targetScope})]),byStore=new Map();
  for(const row of result){if(!byStore.has(row.store_id))byStore.set(row.store_id,[]);byStore.get(row.store_id).push(row);}
  for(const store of stores) {
   const rows=byStore.get(store.id)||[],domain=store.market==='WB'?'wb-orders':'insights',head=rows.find(r=>r.kind==='head'&&r.domain===domain)?.value;
   store.days=dates.map(date=>emptyDay(date,store.market==='WB'?'Исторические интервалы WB не загружены в доступный индексируемый источник.':'Заказы за этот день недоступны.'));
   (store.market==='WB'?wbDays:ozonDays)(store.days,head,rows,instant);
   const updated=time(store.market==='WB'?head?.fetchedAt:head?.orders?.updatedAt);
   store.updatedAt=updated!==null&&updated<=instant?iso(updated):null;
   store.sources=[{id:domain,basis:store.market==='WB'?'order-time':'observation',updatedAt:store.updatedAt,error:store.market==='WB'?!!head?.errorCode:head?.orderSection?.ok===false}];
   if(store.market==='Ozon'){
    const last=rows.filter(r=>r.kind==='observation').map(r=>observation(r.value,r.value?.date,instant)).filter(Boolean).map(p=>p.at).sort().at(-1)||null;
    store.sources.push({id:'intraday',basis:'observation',updatedAt:last});
   }
  }
  return {version:1,timeZone:'Europe/Moscow',currency:'RUB',intervalMinutes:15,period,generatedAt:iso(instant),target:salesTarget,events:[],stores};
 }
 return Object.freeze({read});
}
module.exports={createBusinessDynamics,DynamicsError};
