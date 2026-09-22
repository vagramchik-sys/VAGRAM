'use strict';

const productSegments=require('../../buyer-product-segments.cjs');

const MARKETS=new Set(['all','Ozon','WB']);
const BUYER_TYPES=new Set(['legal','individual','unknown']);
const SCHEMES={Ozon:['FBO','FBS'],WB:['FBS','DBS']};
const PRODUCT_FIELDS=['sku','product_id','nmID','offer_id','vendorCode'];

function validDay(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const parsed=Date.parse(value+'T00:00:00Z');
 return Number.isFinite(parsed)&&new Date(parsed).toISOString().slice(0,10)===value;
}
function storeMarket(id,store){return store?.market==='WB'||String(id).startsWith('wb-')?'WB':'Ozon'}
function safeCount(value){return Number.isSafeInteger(value)&&value>=0?value:0}
function safeShare(value){return typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1?value:null}
function publicSegment(value){
 const confirmedAmount=value?.amountKnown===true&&typeof value.amountRub==='number'&&Number.isFinite(value.amountRub)&&value.amountRub>=0;
 return {units:safeCount(value?.units),cancelledUnits:safeCount(value?.cancelledUnits),cancellationUnknownUnits:safeCount(value?.cancellationUnknownUnits),amountRub:confirmedAmount?value.amountRub:null,currency:confirmedAmount?'RUB':null};
}
function totalSegment(items,buyerType){
 let units=0,cancelledUnits=0,cancellationUnknownUnits=0,amountRub=0,amountKnown=true;
 for(const item of items){
  const raw=item?.segments?.[buyerType],segment=publicSegment(raw);
  units+=segment.units;cancelledUnits+=segment.cancelledUnits;cancellationUnknownUnits+=segment.cancellationUnknownUnits;
  if(segment.units>0){if(segment.amountRub===null)amountKnown=false;else amountRub=Math.round((amountRub+segment.amountRub)*100)/100}
 }
 return {units,cancelledUnits,cancellationUnknownUnits,amountRub:amountKnown?amountRub:null,currency:amountKnown?'RUB':null};
}

function create({getStores,getSnapshot,getOrderSnapshots,getCatalog,builder=productSegments}={}){
 if([getStores,getSnapshot,getOrderSnapshots,getCatalog].some(value=>typeof value!=='function'))throw Error('Не настроен SQL-источник товарных сегментов');
 function derivedSnapshot(documents,from,to){
  if(!Array.isArray(documents)||!documents.length)return null;
  const records=new Map(),productOrders=new Map(),sources=[];
  for(const value of documents){
   const documentStamp=Date.parse(value?.generatedAt||0)||0;
   const documentRecords=Array.isArray(value?.records)?value.records:[],documentProducts=Array.isArray(value?.productOrders)?value.productOrders:[];
   const orderSchemes=new Set(documentRecords.filter(record=>record?.market&&record?.storeId&&record?.scheme).map(record=>[record.market,record.storeId,record.scheme].join('\u001f')));
   const productSchemes=new Set(documentProducts.filter(row=>row?.market&&row?.storeId&&row?.scheme).map(row=>[row.market,row.storeId,row.scheme].join('\u001f')));
   for(const record of documentRecords){
    const recordKey=[record?.market,record?.storeId,record?.id].join('\u001f'),previous=records.get(recordKey);
    if(record?.id&&(!previous||documentStamp>=previous.stamp))records.set(recordKey,{row:record,stamp:documentStamp});
   }
   for(const row of documentProducts){
    if(!row?.market||!row?.storeId||!row?.scheme||!row?.orderId||!row?.productId)continue;
    const rowKey=[row.market,row.storeId,row.scheme,row.orderId,row.productId].join('\u001f'),stamp=Date.parse(row.updatedAt||value.generatedAt||0)||0,previous=productOrders.get(rowKey);
    if(!previous||stamp>=previous.stamp)productOrders.set(rowKey,{row,stamp});
   }
   for(const source of value?.report?.coverage?.sources||[]){
    const sourceKey=[source?.market,source?.storeId,source?.scheme].join('\u001f'),missingProducts=orderSchemes.has(sourceKey)&&!productSchemes.has(sourceKey);
    sources.push(missingProducts?{...source,available:false,complete:false,limitation:'Для заказов источника не сохранены товарные строки.'}:source);
   }
  }
  return builder.summarize([...productOrders.values()].map(item=>item.row),{records:[...records.values()].map(item=>item.row),sources,from,to});
 }
 function catalogIndex(selected,catalogs){
  const index=new Map();
  for(const [storeId,store] of selected){
   const catalog=catalogs.get(storeId);if(!catalog)continue;
   for(const product of Array.isArray(catalog?.products)?catalog.products:[]){
    const name=[product.name,product.title,product.product_name,product.offer_id,product.vendorCode].find(value=>typeof value==='string'&&value.trim())?.trim()||null;
    for(const field of PRODUCT_FIELDS){
     if(product[field]===undefined||product[field]===null||String(product[field])==='')continue;
     const key=String(product[field]),items=index.get(key)||[];
     if(!items.some(item=>item.storeId===storeId))items.push({storeId,storeName:typeof store.name==='string'?store.name:null,market:storeMarket(storeId,store),name,sku:product.sku??product.nmID??product.product_id??key});
     index.set(key,items);
    }
   }
  }
  return index;
 }
 function resolveProduct(item,index,stores){
  const productId=String(item?.productId??'');
  if(!productId)return null;
  const explicitMarket=item?.market==='Ozon'||item?.market==='WB'?item.market:null;
  if(item?.market!=null&&!explicitMarket)return null;
  const explicitStore=item?.storeId==null||String(item.storeId)===''?null:String(item.storeId);
  const candidates=(index.get(productId)||[]).filter(match=>!explicitMarket||match.market===explicitMarket);
  if(explicitStore){
   if(!Object.hasOwn(stores,explicitStore))return null;
   const resolvedMarket=storeMarket(explicitStore,stores[explicitStore]);
   if(explicitMarket&&explicitMarket!==resolvedMarket)return null;
   return {item,productId,market:resolvedMarket,storeId:explicitStore,match:candidates.find(match=>match.storeId===explicitStore)||null};
  }
  const storeIds=[...new Set(candidates.map(match=>match.storeId))];
  if(storeIds.length===1){
   const match=candidates.find(candidate=>candidate.storeId===storeIds[0]);
   return {item,productId,market:match.market,storeId:match.storeId,match};
  }
  if(storeIds.length===0&&explicitMarket)return {item,productId,market:explicitMarket,storeId:null,match:null};
  return null;
 }
 function explicitlyOutsideScope(item,market,storeId,stores){
  const itemStore=item?.storeId==null||String(item.storeId)===''?null:String(item.storeId);
  if(storeId&&itemStore&&itemStore!==storeId)return true;
  if(market!=='all'&&item?.market!=null&&item.market!==market)return true;
  if(market!=='all'&&itemStore&&Object.hasOwn(stores,itemStore)&&storeMarket(itemStore,stores[itemStore])!==market)return true;
  if(storeId&&item?.market!=null&&item.market!==storeMarket(storeId,stores[storeId]))return true;
  return false;
 }
 function unavailable(from,to,sources=[],buyerType='legal'){return {status:'unavailable',period:{from,to},buyerType,totals:null,products:[],coverage:{complete:false,sources},source:{metric:'gross_ordered_product_units_by_buyer_type',amountConfirmed:false},limitations:['Рейтинг товаров за выбранный период ещё не подготовлен.']}}
 async function read({from,to,market='all',storeId,limit=20,buyerType='legal'}={}){
  const stores=await getStores();if(!stores||typeof stores!=='object'||Array.isArray(stores))throw Error('Некорректный каталог магазинов SQL');
  if(!validDay(from)||!validDay(to)||from>to)throw Error('Проверьте период товарного рейтинга');
  market=market||'all';if(!MARKETS.has(market))throw Error('Проверьте площадку');
  if(!BUYER_TYPES.has(buyerType))throw Error('Проверьте тип покупателя');
  if(storeId&&!Object.hasOwn(stores,storeId))throw Error('Проверьте магазин');
  if(storeId&&market!=='all'&&storeMarket(storeId,stores[storeId])!==market)throw Error('Магазин не относится к выбранной площадке');
  limit=Number(limit);if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Проверьте размер товарного рейтинга');
  const selected=Object.entries(stores).filter(([id,store])=>(!storeId||id===storeId)&&(market==='all'||storeMarket(id,store)===market));
  const prepared=await getSnapshot({from,to}),raw=prepared||derivedSnapshot(await getOrderSnapshots({from,to}),from,to);
  if(!raw||!Array.isArray(raw.products)||raw.period?.from!==from||raw.period?.to!==to)return unavailable(from,to,[],buyerType);
  const actualSources=(Array.isArray(raw.coverage?.sources)?raw.coverage.sources:[]).filter(source=>(market==='all'||source.market===market)&&(!storeId||source.storeId===storeId)).map(source=>({market:source.market,scheme:source.scheme,storeId:source.storeId||null,name:typeof source.name==='string'?source.name:null,available:source.available===true,complete:source.complete===true&&source.coversRequested!==false,coversRequested:source.coversRequested!==false,overlapsRequested:source.overlapsRequested!==false,limitation:typeof source.limitation==='string'?source.limitation:null}));
  for(const [id,store] of selected){const expectedMarket=storeMarket(id,store);for(const scheme of SCHEMES[expectedMarket])if(!actualSources.some(source=>source.market===expectedMarket&&source.scheme===scheme&&source.storeId===id))actualSources.push({market:expectedMarket,scheme,storeId:id,name:typeof store.name==='string'?store.name:null,available:false,complete:false,limitation:'Источник за выбранный период ещё не подготовлен.'})}
  const available=raw.status!=='unavailable'&&actualSources.some(source=>source.available&&source.overlapsRequested),sourcesComplete=available&&selected.length>0&&selected.every(([id,store])=>SCHEMES[storeMarket(id,store)].every(scheme=>actualSources.some(source=>source.market===storeMarket(id,store)&&source.storeId===id&&source.scheme===scheme&&source.available&&source.complete)))&&raw.status==='ready';
  if(!available)return unavailable(from,to,actualSources,buyerType);
  const catalogRows=await Promise.all(Object.keys(stores).map(async id=>[id,await getCatalog(id)])),index=catalogIndex(Object.entries(stores),new Map(catalogRows));
  const resolved=raw.products.map(item=>({item,resolved:resolveProduct(item,index,stores)}));
  const unresolvedRows=resolved.filter(row=>!row.resolved&&!explicitlyOutsideScope(row.item,market,storeId,stores)).length;
  const complete=sourcesComplete&&unresolvedRows===0;
  const scoped=resolved.map(row=>row.resolved).filter(Boolean).filter(row=>(market==='all'||row.market===market)&&(!storeId||row.storeId===storeId));
  const totals=Object.fromEntries([...BUYER_TYPES].map(type=>[type,totalSegment(scoped.map(row=>row.item),type)]));
  const ranked=scoped.filter(row=>publicSegment(row.item?.segments?.[buyerType]).units>0).sort((a,b)=>{
   const aSegment=publicSegment(a.item?.segments?.[buyerType]),bSegment=publicSegment(b.item?.segments?.[buyerType]);
   const aTotal=[...BUYER_TYPES].reduce((sum,type)=>sum+publicSegment(a.item?.segments?.[type]).units,0),bTotal=[...BUYER_TYPES].reduce((sum,type)=>sum+publicSegment(b.item?.segments?.[type]).units,0);
   const aShare=aTotal?aSegment.units/aTotal:0,bShare=bTotal?bSegment.units/bTotal:0;
   return bSegment.units-aSegment.units||bShare-aShare||a.market.localeCompare(b.market)||String(a.storeId||'').localeCompare(String(b.storeId||''))||a.productId.localeCompare(b.productId);
  });
  const products=[];
  for(const row of ranked){
   const {item,productId,match}=row,legal=publicSegment(item.segments?.legal),chosen=publicSegment(item.segments?.[buyerType]);
   const allUnits=[...BUYER_TYPES].reduce((sum,type)=>sum+publicSegment(item.segments?.[type]).units,0);
   products.push({productId,name:match?.name||'Название не найдено',sku:String(match?.sku??productId),market:row.market,storeId:row.storeId,storeName:match?.storeName||stores[row.storeId]?.name||null,buyerType,orderedUnits:chosen.units,buyerShare:allUnits?chosen.units/allUnits:null,legalUnits:legal.units,legalShare:safeShare(item.legalShare),cancelledUnits:chosen.cancelledUnits,cancellationUnknownUnits:chosen.cancellationUnknownUnits,amountRub:chosen.amountRub,currency:chosen.currency});
   if(products.length>=limit)break;
  }
  return {status:complete?'ready':'partial',period:{from,to},buyerType,totals,products,coverage:{complete,unresolvedRows,sources:actualSources},source:{metric:'gross_ordered_product_units_by_buyer_type',amountConfirmed:totals[buyerType].units>0&&totals[buyerType].amountRub!==null},limitations:[sourcesComplete?'':'Данные по части источников отсутствуют или неполны.',unresolvedRows?'Часть товарных строк не включена: магазин или площадка не определены однозначно.':''].filter(Boolean)};
 }
 return {read};
}

module.exports={create,validDay};
