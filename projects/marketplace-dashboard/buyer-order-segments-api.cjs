'use strict';

const path=require('node:path');
const buyerSegments=require('./buyer-order-segments.cjs');

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

function create({privateDir,stores,source=buyerSegments}={}){
 if(typeof privateDir!=='string'||!stores||typeof stores!=='object'||typeof source.create!=='function')throw Error('Не настроен источник сегментов заказов');
 const services=new Map();
 function service(from,to){const file=path.join(privateDir,`buyer-order-segments-${from}_${to}.json`);if(!services.has(file))services.set(file,source.create({snapshotFile:file}));return services.get(file)}
 function read({from,to,market='all',storeId}={}){
  if(!validDay(from)||!validDay(to)||from>to)throw Error('Проверьте период заказов');
  market=market||'all';if(!MARKETS.has(market))throw Error('Проверьте площадку');
  if(storeId&&!Object.hasOwn(stores,storeId))throw Error('Проверьте магазин');
  if(storeId&&market!=='all'&&storeMarket(storeId,stores[storeId])!==market)throw Error('Магазин не относится к выбранной площадке');
  const selected=Object.entries(stores).filter(([id,store])=>(!storeId||id===storeId)&&(market==='all'||storeMarket(id,store)===market));
  const raw=service(from,to).read({from,to,market:market==='all'?undefined:market,storeId});
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

module.exports={create,validDay};
