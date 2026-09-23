'use strict';

const buyerSegments=require('../../buyer-order-segments.cjs');
const MARKETS=new Set(['all','Ozon','WB']);
const SEGMENT_FIELDS=['units','orders','cancelledUnits','cancelledOrders','notCancelledUnits','notCancelledOrders','cancellationUnknownUnits','cancellationUnknownOrders'];
const SCHEMES={Ozon:['FBO','FBS'],WB:['FBS','DBS']};

function validDay(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const parsed=Date.parse(value+'T00:00:00Z');
 return Number.isFinite(parsed)&&new Date(parsed).toISOString().slice(0,10)===value;
}
function storeMarket(id,store){return store?.market==='WB'||String(id).startsWith('wb-')?'WB':'Ozon'}
function segment(value){return Object.fromEntries(SEGMENT_FIELDS.map(field=>[field,Number.isSafeInteger(value?.[field])&&value[field]>=0?value[field]:0]))}
function totals(value){return value?Object.fromEntries(['legal','individual','unknown'].map(key=>[key,segment(value[key])])):null}
const shiftDay=value=>new Date(Date.parse(value+'T00:00:00Z')+86400000).toISOString().slice(0,10);
function sourceRange(source){const from=source?.requested?.from||source?.from,to=source?.requested?.to||source?.to;return validDay(from)&&validDay(to)&&from<=to?{from,to}:null}
function covers(intervals,from,to){let cursor=from;for(const interval of intervals.sort((a,b)=>a.from.localeCompare(b.from)||b.to.localeCompare(a.to))){if(interval.to<cursor)continue;if(interval.from>cursor)return false;if(interval.to>=to)return true;cursor=shiftDay(interval.to)}return false}
function combineSnapshots(snapshots,{from,to,match=()=>true}={}){
 const records=new Map(),groups=new Map();
 for(const snapshot of Array.isArray(snapshots)?snapshots:[]){
  const generatedAt=typeof snapshot?.generatedAt==='string'&&Number.isFinite(Date.parse(snapshot.generatedAt))?snapshot.generatedAt:'';
  for(const record of Array.isArray(snapshot?.records)?snapshot.records:[]){if(!match(record)||typeof record?.id!=='string')continue;const key=[record.market,record.storeId||'',record.id].join('\u001f'),prior=records.get(key);if(!prior||generatedAt>=prior.generatedAt)records.set(key,{record,generatedAt})}
  for(const source of Array.isArray(snapshot?.report?.coverage?.sources)?snapshot.report.coverage.sources:[]){if(!match(source))continue;const range=sourceRange(source);if(!range||range.to<from||range.from>to)continue;const key=[source.market,source.storeId||'',source.scheme].join('\u001f'),group=groups.get(key)||{market:source.market,scheme:source.scheme,storeId:source.storeId||null,name:null,intervals:[],available:false,fetched:[]};if(typeof source.name==='string'&&source.name)group.name=source.name;if(source.available===true){group.available=true;if(typeof source.fetchedAt==='string'&&Number.isFinite(Date.parse(source.fetchedAt)))group.fetched.push(new Date(source.fetchedAt).toISOString());if(snapshot?._partialSource!==true&&source.complete===true)group.intervals.push({from:range.from<from?from:range.from,to:range.to>to?to:range.to})}groups.set(key,group)}
 }
 const sources=[...groups.values()].map(group=>{const complete=covers(group.intervals,from,to);return{market:group.market,scheme:group.scheme,storeId:group.storeId,name:group.name,available:group.available,complete,requested:{from,to},fetchedAt:group.fetched.sort()[0]||null,limitation:complete?null:'Дневные источники не покрывают весь выбранный период.'}});
 return{records:[...records.values()].map(item=>item.record),sources};
}

function create({getStores,getSnapshot,getSnapshots,getAggregate}={}){
 if(typeof getStores!=='function'||typeof getSnapshots!=='function'&&typeof getSnapshot!=='function')throw Error('Не настроен SQL-источник сегментов заказов');
 const loadSnapshots=typeof getSnapshots==='function'?getSnapshots:async options=>{const value=await getSnapshot(options);return value?[value]:[]};
 async function read({from,to,market='all',storeId}={}){
  const stores=await getStores();if(!stores||typeof stores!=='object'||Array.isArray(stores))throw Error('Некорректный каталог магазинов SQL');
  if(!validDay(from)||!validDay(to)||from>to)throw Error('Проверьте период заказов');
  market=market||'all';if(!MARKETS.has(market))throw Error('Проверьте площадку');
  if(storeId&&!Object.hasOwn(stores,storeId))throw Error('Проверьте магазин');
  if(storeId&&market!=='all'&&storeMarket(storeId,stores[storeId])!==market)throw Error('Магазин не относится к выбранной площадке');
  const selected=Object.entries(stores).filter(([id,store])=>(!storeId||id===storeId)&&(market==='all'||storeMarket(id,store)===market));
  const matches=value=>(market==='all'||value.market===market)&&(!storeId||value.storeId===storeId);
  const snapshots=typeof getAggregate==='function'?(await getAggregate({from,to,market,storeId}))?.documents||[]:await loadSnapshots({from,to});
  const combined=combineSnapshots(snapshots,{from,to,match:matches}),raw=buyerSegments.aggregate(combined.records,{from,to,sources:combined.sources});
  const sources=(raw.coverage?.sources||[]).map(item=>({market:item.market,scheme:item.scheme,storeId:item.storeId||null,name:typeof item.name==='string'?item.name:null,complete:item.complete===true,available:item.available===true,requested:{from:item.requested?.from||from,to:item.requested?.to||to},fetchedAt:item.fetchedAt||null,limitation:typeof item.limitation==='string'?item.limitation:null}));
  for(const [id,store] of selected){const expectedMarket=storeMarket(id,store);for(const scheme of SCHEMES[expectedMarket])if(!sources.some(item=>item.market===expectedMarket&&item.scheme===scheme&&item.storeId===id))sources.push({market:expectedMarket,scheme,storeId:id,name:typeof store.name==='string'?store.name:null,complete:false,available:false,requested:{from,to},fetchedAt:null,limitation:'Источник за выбранный период ещё не подготовлен.'})}
  const expected=selected.flatMap(([id,store])=>SCHEMES[storeMarket(id,store)].map(scheme=>({id,market:storeMarket(id,store),scheme})));
  const available=sources.some(item=>item.available),complete=available&&expected.length>0&&expected.every(item=>sources.some(sourceItem=>sourceItem.market===item.market&&sourceItem.scheme===item.scheme&&sourceItem.storeId===item.id&&sourceItem.available&&sourceItem.complete))&&raw.coverage?.invalidRecords===0;
  const status=!available?'unavailable':complete?'ready':'partial';
  return {
   status,period:{from,to},totals:status==='unavailable'?null:totals(raw.totals),
   byStore:(raw.byStore||[]).map(item=>({storeId:item.storeId||null,name:typeof item.name==='string'?item.name:null,market:item.market,totals:totals(item.totals),lastUpdated:item.lastUpdated||null})),
   coverage:{complete,includedRecords:Number.isSafeInteger(raw.coverage?.includedRecords)?raw.coverage.includedRecords:0,invalidRecords:Number.isSafeInteger(raw.coverage?.invalidRecords)?raw.coverage.invalidRecords:0,duplicateRecords:Number.isSafeInteger(raw.coverage?.duplicateRecords)?raw.coverage.duplicateRecords:0,sources},
   source:{metric:'gross_ordered_item_units',commonFreshnessAt:raw.source?.commonFreshnessAt||null,newestSourceAt:raw.source?.newestSourceAt||null},
   limitations:Array.isArray(raw.limitations)?raw.limitations.filter(item=>typeof item==='string'):[]
  };
 }
 return {read};
}

module.exports={create,validDay,combineSnapshots};
