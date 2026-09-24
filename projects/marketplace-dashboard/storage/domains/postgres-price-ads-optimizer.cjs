'use strict';
const crypto=require('node:crypto');
const {createJsonDocumentRepository}=require('../postgres-json-repository.cjs');
const {sourceKey}=require('../postgres-document-import.cjs');
const {recommend,DEFAULT_SETTINGS,mergeSettings}=require('../../optimizer-engine.cjs');
const {isInactive}=require('../../dist/dashboard-model.js');

const PERF='api-performance.ozon.ru',SELLER='api-seller.ozon.ru',STORE=/^[0-9]{1,32}$/u;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MODES=new Set(['observe','recommend','auto']),HTTP_TIMEOUT=45000,MAX_ROWS=15000,MAX_ACTIONS=5000;
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v),finite=v=>Number.isFinite(Number(v))?Number(v):null,iso=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
class PriceAdsError extends Error{constructor(code,message,status=400){super(message);this.name='PriceAdsError';this.code=code;this.status=status;this.public=true}}
const fail=(code,message,status)=>{throw new PriceAdsError(code,message,status)};
const emptyConn=()=>({version:1,stores:{}}),emptyState=()=>({version:1,stores:{},snapshots:{},actions:[]});
function validConn(v){return object(v)&&v.version===1&&object(v.stores)&&Object.entries(v.stores).every(([id,x])=>STORE.test(id)&&object(x)&&typeof x.clientId==='string'&&typeof x.secret==='string'&&x.secret.length>20&&iso(x.connectedAt))}
function validState(v){return object(v)&&v.version===1&&object(v.stores)&&object(v.snapshots)&&Array.isArray(v.actions)&&v.actions.length<=MAX_ACTIONS&&
 Object.entries(v.stores).every(([id,x])=>STORE.test(id)&&object(x)&&MODES.has(x.mode)&&typeof x.killSwitch==='boolean'&&typeof x.priceWriteEnabled==='boolean'&&typeof x.bidWriteEnabled==='boolean'&&object(x.settings))&&
 Object.values(v.snapshots).every(x=>object(x)&&iso(x.updatedAt)&&Array.isArray(x.rows)&&x.rows.length<=MAX_ROWS&&Array.isArray(x.adRows)&&x.adRows.length<=MAX_ROWS)&&
 v.actions.every(x=>object(x)&&UUID.test(x.id||'')&&STORE.test(x.storeId||'')&&iso(x.at)&&typeof x.type==='string'&&typeof x.status==='string')}
function op(meta){if(!object(meta)||!UUID.test(meta.commandId||'')||!iso(meta.timestamp))fail('INVALID_ARGUMENT','Для изменения нужны commandId и timestamp.');return{commandId:meta.commandId.toLowerCase(),timestamp:new Date(meta.timestamp).toISOString()}}
function defaultConfig(){return{mode:'observe',killSwitch:true,priceWriteEnabled:false,bidWriteEnabled:false,settings:{...DEFAULT_SETTINGS,maxActionsPerCycle:20,cycleMinutes:15},updatedAt:new Date(0).toISOString()}}
function normalizeConfig(v={}){
 const s=mergeSettings(v.settings||v),base=defaultConfig();
 s.maxActionsPerCycle=Math.min(100,Math.max(1,Number(v.settings?.maxActionsPerCycle??v.maxActionsPerCycle??20)||20));
 s.cycleMinutes=Math.min(120,Math.max(5,Number(v.settings?.cycleMinutes??v.cycleMinutes??15)||15));
 return{mode:MODES.has(v.mode)?v.mode:base.mode,killSwitch:v.killSwitch!==false,priceWriteEnabled:v.priceWriteEnabled===true,bidWriteEnabled:v.bidWriteEnabled===true,settings:s,updatedAt:iso(v.updatedAt)?v.updatedAt:base.updatedAt};
}
const shift=(day,n)=>{const d=new Date(day+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
const parts=(a,n)=>{const out=[];for(let i=0;i<a.length;i+=n)out.push(a.slice(i,i+n));return out};
function economics(ledger,sku,period,cost){
 if(!ledger?.complete||!ledger.period||ledger.period.from>period.from||ledger.period.to<period.to||ledger.foreignRecords||!(cost>0))return null;
 const v={};for(const r of ledger.skuDaily||[])if(String(r.sku)===String(sku)&&r.date>=period.from&&r.date<=period.to)for(const[k,n]of Object.entries(r.values||{}))v[k]=(v[k]||0)+n;
 const units=(v.soldUnits||0)-(v.returnedUnits||0);if(!(units>0)||v.unknownUnitRows)return null;
 const net=(v.net||0)/100,ads=(v.ads||0)/100,profit=net-units*cost;
 return{netUnits:units,profitAfterAdsPerOrder:profit/units,contributionBeforeAdsPerOrder:(profit-ads)/units,adsPerOrder:-ads/units,netPerOrder:net/units};
}
function statMap(rows,today){
 const map=new Map();for(const row of rows||[]){const key=String(row.campaignId)+':'+String(row.sku),v=map.get(key)||{campaignId:String(row.campaignId),sku:String(row.sku),views:0,clicks:0,toCart:0,orders:0,expense:0,sales:0,expenseToday:0};
  for(const k of ['views','clicks','toCart','orders'])v[k]+=finite(row[k])||0;for(const k of ['expense','sales'])v[k]+=finite(row[k])||0;if(row.date===today)v.expenseToday+=finite(row.expense)||0;v.price=finite(row.price)??v.price;map.set(key,v)}
 for(const v of map.values()){v.ctr=v.views?100*v.clicks/v.views:null;v.cvr=v.clicks?100*v.orders/v.clicks:null;v.drr=v.sales?100*v.expense/v.sales:null;v.avgCpc=v.clicks?v.expense/v.clicks:null}return map;
}
function priceIndex(item){
 const candidates=[];for(const row of item?.price_indexes||[])for(const key of ['external_index_data','self_index_data'])if(row?.[key])candidates.push(row[key]);
 candidates.sort((a,b)=>(finite(a.price_index)??999)-(finite(b.price_index)??999));const x=candidates[0]||{};
 return{marketPriceIndex:finite(x.price_index),minMarketPrice:finite(x.min_price?.amount),marketUrl:x.url||null};
}

function createPriceAdsOptimizer({stateStore,storesRepository,getProducts,getLedger,protect,fetchFn=globalThis.fetch,now=()=>new Date(),setIntervalFn=setInterval,clearIntervalFn=clearInterval}={}){
 if(!stateStore||!storesRepository?.protectedStore||!storesRepository?.read||typeof getProducts!=='function'||typeof getLedger!=='function'||typeof protect!=='function'||typeof fetchFn!=='function')throw new TypeError('Complete optimizer dependencies are required');
 const connRepo=createJsonDocumentRepository({stateStore,logicalKey:sourceKey('performance-api.json'),sourcePath:'performance-api.json',validate:validConn,maxBytes:2*1024*1024});
 const stateRepo=createJsonDocumentRepository({stateStore,logicalKey:sourceKey('price-ads-optimizer.json'),sourcePath:'price-ads-optimizer.json',validate:validState,maxBytes:32*1024*1024});
 const tokens=new Map(),busy=new Set();let timer=null;
 async function load(repo,empty){const record=await repo.read();return{record,value:record&&!record.deleted?record.value:empty()}}
 async function mutate(repo,empty,commandId,fn){
  for(let i=0;i<3;i++){const old=await load(repo,empty),next=fn(structuredClone(old.value));try{await repo.compareAndSet(next,{expectedRevision:old.record?.revision||'0',commandId:i?crypto.randomUUID():commandId});return next}catch(e){if(e?.code!=='REVISION_CONFLICT'||i===2)throw e}}
 }
 async function replay(repo,id){const r=await repo.readCommand(id);return r?.after?.value||null}
 async function request(host,method,path,{headers={},body,query}={}){
  if(![PERF,SELLER].includes(host)||!path.startsWith('/'))fail('INVALID_ARGUMENT','Некорректный API-маршрут.');
  let suffix='';if(query){const q=new URLSearchParams();for(const[k,v]of Object.entries(query))if(Array.isArray(v))for(const x of v)q.append(k,String(x));else if(v!==undefined&&v!==null&&v!=='')q.set(k,String(v));const s=q.toString();if(s)suffix='?'+s}
  let response;try{response=await fetchFn('https://'+host+path+suffix,{method,headers:{Accept:'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(HTTP_TIMEOUT)})}catch{fail('UPSTREAM_UNAVAILABLE','Ozon API временно недоступен.',503)}
  let text='';try{text=await response.text()}catch{fail('INVALID_RESPONSE','Не удалось прочитать ответ Ozon.',503)}
  if(text.length>8*1024*1024)fail('INVALID_RESPONSE','Ответ Ozon слишком большой.',503);
  let data={};if(text)try{data=JSON.parse(text)}catch{fail('INVALID_RESPONSE','Ozon вернул некорректный JSON.',503)}
  if(!response.ok){const code=[401,403].includes(response.status)?'AUTH_FAILED':response.status===429?'RATE_LIMITED':'UPSTREAM_REJECTED';fail(code,'Ozon API: '+response.status,response.status===429?429:400)}return data;
 }
 async function connState(){return(await load(connRepo,emptyConn)).value}
 async function token(storeId,force=false){
  const cached=tokens.get(storeId);if(!force&&cached&&cached.expiresAt>Date.now()+60000)return cached.value;
  const c=(await connState()).stores[storeId];if(!c)fail('PERFORMANCE_NOT_CONNECTED','Performance API не подключён.',409);
  let secret;try{secret=await protect(c.secret,true)}catch{fail('CREDENTIAL_UNAVAILABLE','Не удалось расшифровать Performance API.',503)}
  let d;try{d=await request(PERF,'POST','/api/client/token',{headers:{'Content-Type':'application/json'},body:{client_id:c.clientId,client_secret:secret,grant_type:'client_credentials'}})}finally{secret=null}
  if(typeof d.access_token!=='string'||!d.access_token)fail('AUTH_FAILED','Performance API не выдал токен.');
  tokens.set(storeId,{value:d.access_token,expiresAt:Date.now()+(Number(d.expires_in)||1800)*1000});return d.access_token;
 }
 async function perf(storeId,method,path,opts={},retry=true){
  const t=await token(storeId);try{return await request(PERF,method,path,{...opts,headers:{Authorization:'Bearer '+t,...(opts.body?{'Content-Type':'application/json'}:{})}})}
  catch(e){if(retry&&e.code==='AUTH_FAILED'){tokens.delete(storeId);await token(storeId,true);return perf(storeId,method,path,opts,false)}throw e}
 }
 async function seller(storeId,path,body){
  const s=await storesRepository.protectedStore(storeId);if(!s)fail('STORE_MISSING','Магазин не подключён.',404);let key;
  try{key=await protect(s.key,true)}catch{fail('CREDENTIAL_UNAVAILABLE','Не удалось расшифровать Seller API.',503)}
  try{return await request(SELLER,'POST',path,{headers:{'Content-Type':'application/json','Client-Id':storeId,'Api-Key':key},body})}finally{key=null}
 }
 async function connect(storeId,input,meta){
  const m=op(meta);if(!STORE.test(storeId)||typeof input.clientId!=='string'||input.clientId.length<5||typeof input.clientSecret!=='string'||input.clientSecret.length<10)fail('INVALID_ARGUMENT','Проверьте client_id и client_secret.');
  const old=await replay(connRepo,m.commandId);if(old){const saved=old.stores?.[storeId];if(!saved||saved.clientId!==input.clientId)fail('COMMAND_ID_REUSED','commandId уже использован.',409);return status(storeId)}
  const d=await request(PERF,'POST','/api/client/token',{headers:{'Content-Type':'application/json'},body:{client_id:input.clientId,client_secret:input.clientSecret,grant_type:'client_credentials'}});
  if(typeof d.access_token!=='string')fail('AUTH_FAILED','Ozon не подтвердил Performance API доступы.');
  let encrypted;try{encrypted=await protect(input.clientSecret,false)}catch{fail('CREDENTIAL_UNAVAILABLE','Не удалось защитить Performance API secret.',503)}
  await mutate(connRepo,emptyConn,m.commandId,next=>{next.stores[storeId]={clientId:input.clientId,secret:encrypted,connectedAt:m.timestamp};return next});
  tokens.set(storeId,{value:d.access_token,expiresAt:Date.now()+(Number(d.expires_in)||1800)*1000});return status(storeId);
 }
 async function disconnect(storeId,meta){const m=op(meta);if(await replay(connRepo,m.commandId))return status(storeId);await mutate(connRepo,emptyConn,m.commandId,next=>{delete next.stores[storeId];return next});tokens.delete(storeId);return status(storeId)}
 async function status(storeId){
  if(!STORE.test(String(storeId)))fail('INVALID_ARGUMENT','Выберите магазин Ozon.');const[c,s]=await Promise.all([connState(),load(stateRepo,emptyState)]),cfg=normalizeConfig(s.value.stores[storeId]||{});
  return{storeId,performance:c.stores[storeId]?{connected:true,clientId:c.stores[storeId].clientId,connectedAt:c.stores[storeId].connectedAt}:{connected:false},config:cfg,snapshotAt:s.value.snapshots[storeId]?.updatedAt||null,actions:s.value.actions.filter(a=>a.storeId===storeId).slice(0,100)};
 }
 async function saveSettings(storeId,input,meta){
  const m=op(meta);if(!STORE.test(storeId))fail('INVALID_ARGUMENT','Выберите магазин Ozon.');if(await replay(stateRepo,m.commandId))return status(storeId);
  const cfg=normalizeConfig(input);cfg.updatedAt=m.timestamp;await mutate(stateRepo,emptyState,m.commandId,next=>{next.stores[storeId]=cfg;return next});return status(storeId);
 }
 async function customerPrices(storeId,products){
  const skus=[...new Set(products.flatMap(p=>[p.sku,...(p.skus||[])].filter(Boolean).map(String)))],map=new Map();if(!skus.length)return{source:'none',map};
  try{for(const group of parts(skus,1000)){const d=await seller(storeId,'/v1/product/prices/details',{skus:group});for(const x of d.prices||[])map.set(String(x.sku),{customerPrice:finite(x.customer_price?.amount),promoPrice:finite(x.price?.amount),...priceIndex(x)})}return{source:'premium-pro',map}}
  catch(e){if(['AUTH_FAILED','UPSTREAM_REJECTED'].includes(e.code))return{source:'unavailable',map};throw e}
 }
 async function campaigns(storeId){
  const out=[];for(let page=1;page<=100;page++){const d=await perf(storeId,'GET','/api/client/campaign',{query:{advObjectType:'SKU',page,pageSize:100}}),rows=Array.isArray(d.list)?d.list:[];out.push(...rows);if(rows.length<100)break}return out.filter(x=>String(x.paymentType)==='CPC');
 }
 async function campaignProducts(storeId,id){
  const out=[];for(let page=1;page<=100;page++){const d=await perf(storeId,'GET','/api/client/campaign/'+encodeURIComponent(id)+'/v2/products',{query:{page,pageSize:100}}),rows=Array.isArray(d.products)?d.products:[];out.push(...rows);if(rows.length<100)break}return out;
 }
 async function competitive(storeId,id,skus){const map=new Map();for(const g of parts(skus,200)){const d=await perf(storeId,'GET','/api/client/campaign/'+encodeURIComponent(id)+'/products/bids/competitive',{query:{skus:g}});for(const x of d.bids||[])map.set(String(x.sku),String(x.bid))}return map}
 async function minimum(storeId,skus,type){const map=new Map();for(const g of parts(skus,200)){const d=await perf(storeId,'POST','/api/client/min/sku',{body:{marketplaceId:'MARKETPLACE_ID_RU',paymentType:type,sku:g}});for(const x of d.minBids||[])map.set(String(x.sku),finite(x.bid))}return map}
 async function statistics(storeId,ids,period){const out=[];for(const g of parts(ids,50)){const d=await perf(storeId,'POST','/api/client/statistics/products/sku',{body:{campaignIds:g,dateFrom:period.from,dateTo:period.to}});if(Array.isArray(d.rows))out.push(...d.rows)}return out}
 async function refresh(storeId){
  if(!STORE.test(storeId))fail('INVALID_ARGUMENT','Выберите магазин Ozon.');const lock='refresh:'+storeId;if(busy.has(lock))return data(storeId);busy.add(lock);
  try{
   const products=(await getProducts()).filter(p=>p.storeId===storeId&&p.market!=='WB'),bySku=new Map();for(const p of products)for(const sku of [p.sku,...(p.skus||[])].filter(Boolean).map(String))if(!bySku.has(sku))bySku.set(sku,p);
   const today=new Date(now()).toISOString().slice(0,10),period={from:shift(today,-1),to:today};
   const[prices,ledger,connections]=await Promise.all([customerPrices(storeId,products),getLedger(storeId),connState()]);
   const adRows=[];if(connections.stores[storeId]){
    const cs=await campaigns(storeId),items=new Map();for(const c of cs)items.set(String(c.id),await campaignProducts(storeId,String(c.id)));
    const sm=statMap(await statistics(storeId,cs.map(c=>String(c.id)),period),today);
    for(const c of cs){const id=String(c.id),list=items.get(id)||[],skus=list.map(x=>String(x.sku)),[comp,mins]=await Promise.all([competitive(storeId,id,skus),minimum(storeId,skus,c.productAutopilotStrategy==='TOP_PROMOTION'?'CPC_TOP':'CPC')]);
     for(const item of list){const sku=String(item.sku),p=bySku.get(sku),pd=prices.map.get(sku)||{},cost=p?.cost?.status==='filled'?finite(p.cost.unitCost):null;
      adRows.push({key:p?.key||storeId+':'+sku,storeId,storeName:p?.storeName||storeId,productId:p?.product_id?String(p.product_id):null,sku,offerId:p?.offer_id||'',name:p?.name||item.title||'SKU '+sku,unitCost:cost,stock:finite(p?.quantity),inactive:p?isInactive(p):false,
       sellerPrice:finite(p?.pricing?.price??p?.price),minPrice:finite(p?.pricing?.minPrice),oldPrice:finite(p?.pricing?.oldPrice),priceUpdatedAt:p?.pricing?.importedAt||p?.costImportedAt||p?.importedAt||null,
       customerPrice:pd.customerPrice??null,customerPriceSource:pd.customerPrice?'premium-pro':prices.source,marketPriceIndex:pd.marketPriceIndex??null,minMarketPrice:pd.minMarketPrice??null,
       campaignId:id,campaignTitle:c.title||'Кампания '+id,campaignState:c.state,autopilot:c.productAutopilotStrategy||'NO_AUTO_STRATEGY',currentBidMicros:item.bid==null?null:String(item.bid),competitiveBidMicros:comp.get(sku)||null,minBidRub:mins.get(sku)??null,targetCir:finite(item.targetCir),topPosition:item.topPosition||null,
       stats:sm.get(id+':'+sku)||{campaignId:id,sku,views:0,clicks:0,orders:0,expense:0,sales:0,expenseToday:0},economics:economics(ledger,sku,period,cost),period});
     }
    }
   }
   const best=new Map();for(const row of adRows){const old=best.get(row.sku);if(!old||(row.stats.views||0)>(old.stats.views||0))best.set(row.sku,row)}
   const rows=products.slice(0,MAX_ROWS).map(p=>{const sku=String(p.sku||p.skus?.[0]||''),ad=best.get(sku),pd=prices.map.get(sku)||{},cost=p.cost?.status==='filled'?finite(p.cost.unitCost):null;return ad||{key:p.key,storeId,storeName:p.storeName,productId:String(p.product_id),sku,offerId:p.offer_id,name:p.name,unitCost:cost,stock:finite(p.quantity),inactive:isInactive(p),sellerPrice:finite(p.pricing?.price??p.price),minPrice:finite(p.pricing?.minPrice),oldPrice:finite(p.pricing?.oldPrice),priceUpdatedAt:p.pricing?.importedAt||p.costImportedAt||p.importedAt||null,customerPrice:pd.customerPrice??null,customerPriceSource:pd.customerPrice?'premium-pro':prices.source,marketPriceIndex:pd.marketPriceIndex??null,minMarketPrice:pd.minMarketPrice??null,campaignId:null,campaignTitle:null,campaignState:null,autopilot:null,currentBidMicros:null,competitiveBidMicros:null,minBidRub:null,targetCir:null,topPosition:null,stats:null,economics:economics(ledger,sku,period,cost),period}});
   const snapshot={updatedAt:new Date(now()).toISOString(),period,customerPriceSource:prices.source,performanceConnected:Boolean(connections.stores[storeId]),rows,adRows:adRows.slice(0,MAX_ROWS)};
   await mutate(stateRepo,emptyState,crypto.randomUUID(),next=>{next.snapshots[storeId]=snapshot;if(!next.stores[storeId])next.stores[storeId]=normalizeConfig();return next});return data(storeId);
  }finally{busy.delete(lock)}
 }
 function lastAction(actions,row){return actions.find(a=>a.storeId===row.storeId&&a.key===row.key&&String(a.campaignId||'')===String(row.campaignId||'')&&a.status==='applied')||null}
 function decorate(snapshot,state,storeId){
  const cfg=normalizeConfig(state.stores[storeId]||{}),actions=state.actions.filter(a=>a.storeId===storeId),make=row=>{const last=lastAction(actions,row),decision=recommend(row,{mode:cfg.mode,settings:cfg.settings,lastAction:last,actions:actions.filter(a=>a.key===row.key),now:new Date(now()).toISOString()});if(cfg.killSwitch&&cfg.mode==='auto')decision.warnings=[...(decision.warnings||[]),'Kill switch включён'];return{...row,decision,lastAction:last&&{type:last.type,at:last.at,status:last.status}}};
  return{storeId,updatedAt:snapshot?.updatedAt||null,period:snapshot?.period||null,customerPriceSource:snapshot?.customerPriceSource||null,performanceConnected:Boolean(snapshot?.performanceConnected),config:cfg,rows:(snapshot?.rows||[]).map(make),adRows:(snapshot?.adRows||[]).map(make),actions:actions.slice(0,200)};
 }
 async function data(storeId){if(!STORE.test(String(storeId)))fail('INVALID_ARGUMENT','Выберите магазин Ozon.');const s=(await load(stateRepo,emptyState)).value;return decorate(s.snapshots[storeId],s,storeId)}
 async function append(action){await mutate(stateRepo,emptyState,crypto.randomUUID(),next=>{next.actions.unshift(action);if(next.actions.length>MAX_ACTIONS)next.actions.length=MAX_ACTIONS;return next});return action}
 async function writePrice(row,value){
  const price=finite(value);if(!(price>0))fail('INVALID_ARGUMENT','Некорректная цена.');const item={offer_id:row.offerId,price:String(price),old_price:String(row.oldPrice>price?row.oldPrice:0),min_price:String(row.minPrice>0&&row.minPrice<=price?row.minPrice:0),currency_code:'RUB'};
  const d=await seller(row.storeId,'/v1/product/import/prices',{prices:[item]}),r=Array.isArray(d.result)?d.result[0]:d.result?.[0];if(!r?.updated)fail('PRICE_WRITE_REJECTED','Ozon не подтвердил изменение цены.');return r;
 }
 async function writeBid(row,value){if(!row.campaignId||!/^\d+$/u.test(String(value)))fail('INVALID_ARGUMENT','Некорректная ставка.');await perf(row.storeId,'PUT','/api/client/campaign/'+encodeURIComponent(row.campaignId)+'/products',{body:{bids:[{sku:String(row.sku),bid:String(value)}]}});return{ok:true}}
 async function execute(row,d,cfg,source){
  const type=d.action?.type;if(!type)return null;const a={id:crypto.randomUUID(),at:new Date(now()).toISOString(),storeId:row.storeId,key:row.key,sku:String(row.sku),campaignId:row.campaignId||null,type,status:'planned',source,reason:(d.reasons||[]).join('; '),before:{sellerPrice:row.sellerPrice,customerPrice:row.customerPrice,currentBidMicros:row.currentBidMicros,stats:row.stats||{}},target:d.action.value};
  if(cfg.killSwitch)return append({...a,status:'skipped',error:'kill-switch'});
  try{if(type.startsWith('price_')){if(!cfg.priceWriteEnabled)return append({...a,status:'skipped',error:'price-write-disabled'});await writePrice(row,d.action.value)}
   else if(type.startsWith('bid_')){if(!cfg.bidWriteEnabled)return append({...a,status:'skipped',error:'bid-write-disabled'});await writeBid(row,d.action.value)}else return null;
   return append({...a,status:'applied'});
  }catch(e){return append({...a,status:'failed',error:e.code||'upstream-error'})}
 }
 async function runCycle(storeId,{source='manual'}={}){
  const lock='cycle:'+storeId;if(busy.has(lock))return data(storeId);busy.add(lock);try{const report=await data(storeId),cfg=report.config;if(cfg.mode!=='auto'||cfg.killSwitch)return report;let count=0;for(const row of report.rows){if(count>=cfg.settings.maxActionsPerCycle)break;if(!row.decision?.action)continue;const a=await execute(row,row.decision,cfg,source);if(a?.status==='applied')count++}return data(storeId)}finally{busy.delete(lock)}
 }
 async function refreshAndRun(storeId,source='manual'){await refresh(storeId);return runCycle(storeId,{source})}
 async function tick(){let stores,state;try{[stores,state]=await Promise.all([storesRepository.read(),load(stateRepo,emptyState)])}catch{return}for(const[id,s]of Object.entries(stores))if(s.market!=='WB'){const cfg=normalizeConfig(state.value.stores[id]||{}),snap=state.value.snapshots[id];if(cfg.mode==='auto'&&!cfg.killSwitch&&(!snap?.updatedAt||Date.now()-Date.parse(snap.updatedAt)>=cfg.settings.cycleMinutes*60000))void refreshAndRun(id,'background').catch(()=>{})}}
 async function start(){if(timer)return;timer=setIntervalFn(()=>void tick(),60000);timer.unref?.()}
 async function close(){if(timer){clearIntervalFn(timer);timer=null}}
 return Object.freeze({status,data,connect,disconnect,saveSettings,refresh,runCycle,refreshAndRun,start,close});
}
module.exports={createPriceAdsOptimizer,PriceAdsError,validState,validConn,economics,statMap};
