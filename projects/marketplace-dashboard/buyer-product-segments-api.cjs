'use strict';

const fs=require('node:fs');
const path=require('node:path');
const productSegments=require('./buyer-product-segments.cjs');

const MARKETS=new Set(['all','Ozon','WB']);
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

function create({privateDir,stores,catalogForStore,builder=productSegments}={}){
 if(typeof privateDir!=='string'||!stores||typeof stores!=='object'||typeof catalogForStore!=='function')throw Error('Не настроен источник товарных сегментов');
 const cache=new Map();
 function readJson(file){
  const stat=fs.statSync(file),signature=stat.size+':'+stat.mtimeMs,known=cache.get(file);
  if(known?.signature===signature)return {value:known.value,signature};
  const value=JSON.parse(fs.readFileSync(file,'utf8'));cache.set(file,{signature,value});return {value,signature};
 }
 function derivedSnapshot(from,to){
  const candidates=new Map();
  for(const name of fs.readdirSync(privateDir)){
   const match=name.match(/^buyer-order-segments-(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})(\.partial)?\.json$/);if(!match)continue;
   const key=match[1]+'_'+match[2],previous=candidates.get(key);
   if(!previous||previous.endsWith('.partial.json')&&!match[3])candidates.set(key,name);
  }
  const files=[...candidates.values()].map(name=>path.join(privateDir,name)).sort(),reads=files.map(readJson);
  if(!reads.length)return null;
  const signature=files.map((file,index)=>file+':'+reads[index].signature).join('|'),key='derived:'+from+':'+to+':'+signature,known=cache.get(key);
  if(known)return known;
  const records=new Map(),productOrders=new Map(),sources=[];
  for(const {value} of reads){
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
  const value=builder.summarize([...productOrders.values()].map(item=>item.row),{records:[...records.values()].map(item=>item.row),sources,from,to});
  cache.set(key,value);return value;
 }
 function snapshot(from,to){
  for(const suffix of ['.json','.partial.json']){
   const file=path.join(privateDir,`buyer-product-segments-${from}_${to}${suffix}`);
   if(!fs.existsSync(file))continue;
   return readJson(file).value;
  }
  return derivedSnapshot(from,to);
 }
 function catalogIndex(selected){
  const index=new Map();
  for(const [storeId,store] of selected){
   let catalog;try{catalog=catalogForStore(storeId)}catch{continue}
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
 function unavailable(from,to,sources=[]){return {status:'unavailable',period:{from,to},products:[],coverage:{complete:false,sources},source:{metric:'gross_ordered_product_units_by_buyer_type',amountConfirmed:false},limitations:['Рейтинг товаров за выбранный период ещё не подготовлен.']}}
 function read({from,to,market='all',storeId,limit=20}={}){
  if(!validDay(from)||!validDay(to)||from>to)throw Error('Проверьте период товарного рейтинга');
  market=market||'all';if(!MARKETS.has(market))throw Error('Проверьте площадку');
  if(storeId&&!Object.hasOwn(stores,storeId))throw Error('Проверьте магазин');
  if(storeId&&market!=='all'&&storeMarket(storeId,stores[storeId])!==market)throw Error('Магазин не относится к выбранной площадке');
  limit=Number(limit);if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Проверьте размер товарного рейтинга');
  const selected=Object.entries(stores).filter(([id,store])=>(!storeId||id===storeId)&&(market==='all'||storeMarket(id,store)===market));
  const raw=snapshot(from,to);
  if(!raw||!Array.isArray(raw.products)||raw.period?.from!==from||raw.period?.to!==to)return unavailable(from,to);
  const actualSources=(Array.isArray(raw.coverage?.sources)?raw.coverage.sources:[]).filter(source=>(market==='all'||source.market===market)&&(!storeId||source.storeId===storeId)).map(source=>({market:source.market,scheme:source.scheme,storeId:source.storeId||null,name:typeof source.name==='string'?source.name:null,available:source.available===true,complete:source.complete===true&&source.coversRequested!==false,coversRequested:source.coversRequested!==false,overlapsRequested:source.overlapsRequested!==false,limitation:typeof source.limitation==='string'?source.limitation:null}));
  for(const [id,store] of selected){const expectedMarket=storeMarket(id,store);for(const scheme of SCHEMES[expectedMarket])if(!actualSources.some(source=>source.market===expectedMarket&&source.scheme===scheme&&source.storeId===id))actualSources.push({market:expectedMarket,scheme,storeId:id,name:typeof store.name==='string'?store.name:null,available:false,complete:false,limitation:'Источник за выбранный период ещё не подготовлен.'})}
  const available=raw.status!=='unavailable'&&actualSources.some(source=>source.available&&source.overlapsRequested),complete=available&&selected.length>0&&selected.every(([id,store])=>SCHEMES[storeMarket(id,store)].every(scheme=>actualSources.some(source=>source.market===storeMarket(id,store)&&source.storeId===id&&source.scheme===scheme&&source.available&&source.complete)))&&raw.status==='ready';
  if(!available)return unavailable(from,to,actualSources);
  const index=catalogIndex(selected),products=[];
  for(const item of raw.products){
   if(market!=='all'&&item?.market&&item.market!==market||storeId&&item?.storeId&&item.storeId!==storeId)continue;
   const productId=String(item?.productId??'');if(!productId)continue;
   const matches=(index.get(productId)||[]).filter(match=>(market==='all'||match.market===market)&&(!storeId||match.storeId===storeId)&&(!item.market||match.market===item.market)&&(!item.storeId||match.storeId===item.storeId));
   if(storeId&&matches.length!==1)continue;
   if(matches.length>1&&new Set(matches.map(match=>match.storeId)).size>1)continue;
   const match=matches[0]||null,legal=publicSegment(item.segments?.legal);
   products.push({productId,name:match?.name||'Название не найдено',sku:String(match?.sku??productId),market:match?.market||item.market||null,storeId:match?.storeId||item.storeId||null,storeName:match?.storeName||null,legalUnits:legal.units,legalShare:safeShare(item.legalShare),cancelledUnits:legal.cancelledUnits,cancellationUnknownUnits:legal.cancellationUnknownUnits,amountRub:legal.amountRub,currency:legal.currency});
   if(products.length>=limit)break;
  }
  return {status:complete?'ready':'partial',period:{from,to},products,coverage:{complete,sources:actualSources},source:{metric:'gross_ordered_product_units_by_buyer_type',amountConfirmed:products.length>0&&products.every(product=>product.amountRub!==null&&product.currency==='RUB')},limitations:[complete?'':'Данные по части источников отсутствуют или неполны.'].filter(Boolean)};
 }
 return {read};
}

module.exports={create,validDay};
