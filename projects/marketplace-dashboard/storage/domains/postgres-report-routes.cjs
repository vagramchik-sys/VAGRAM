'use strict';
const insightsPure=require('../../insights.cjs');
const summary=require('../../summary.cjs');
const model=require('../../dist/dashboard-model.js');
const categoriesPure=require('../../order-categories.cjs');
const {typesHash}=require('../../ledger.cjs');
const refreshPolicy=require('../../refresh-policy.cjs');
const intradayPure=require('../../intraday.cjs');
const {DynamicsError}=require('./postgres-business-dynamics.cjs');
const day=value=>new Date(Number(value)+3*3600000).toISOString().slice(0,10);
class ReportRouteError extends Error{constructor(message,status=400){super(message);this.name='ReportRouteError';this.status=status}}
const routeFail=(message,status)=>{throw new ReportRouteError(message,status)};
const writeJson=(res,status,value)=>{const body=JSON.stringify(value);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body)});res.end(body)};
module.exports=function createPostgresReportRoutes({storesRepository,sourceProviders,supplierPortals,productTypes,intraday,orderCategoryState,trueStats,schedules,businessDynamics,now=()=>Date.now()}={}){
 if(typeof storesRepository?.read!=='function'||!sourceProviders||typeof supplierPortals?.read!=='function'||typeof productTypes?.read!=='function'||typeof intraday?.series!=='function'||typeof orderCategoryState?.read!=='function'||typeof trueStats?.compare!=='function'||typeof schedules?.schedule!=='function'||typeof schedules?.status!=='function'||typeof schedules?.job!=='function'||typeof schedules?.historyError!=='function')throw new TypeError('SQL report route dependencies are required');
 const source=method=>{if(typeof sourceProviders[method]!=='function')throw new TypeError(`SQL source provider ${method} is required`);return sourceProviders[method].bind(sourceProviders)};
 const getReportCatalog=source('getReportCatalog'),getOzonLedger=source('getOzonLedger'),exact=source('exact'),getInsights=source('getInsights'),getWbOrders=source('getWbOrders'),getCatalogs=source('getCatalogs');
 const getOrderInsights=typeof sourceProviders.getOrderInsights==='function'?source('getOrderInsights'):getInsights;
 const getCategoryInsights=typeof sourceProviders.getCategoryInsights==='function'?source('getCategoryInsights'):getInsights;
 const getReportInputRows=typeof sourceProviders.getReportInputs==='function'?source('getReportInputs'):null;
 const getOrderInsightsForStores=typeof sourceProviders.getOrderInsightsForStores==='function'?source('getOrderInsightsForStores'):null;
 async function directory(){const value=await storesRepository.read();if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Некорректный каталог магазинов SQL');return value}
 const publicStores=stores=>Object.entries(stores).map(([id,value])=>({id,name:value.name,clientId:value.clientId,connectedAt:value.connectedAt,job:null,updatedAt:value.updatedAt||null,revision:value.updatedAt||''}));
 async function insightData(){return new Map((await getInsights()).map(row=>[row.storeId,row.value]))}
 async function schedule(id){return schedules.schedule(id)}
 async function jobs(){return schedules.status()}
 async function selectedOzon(params,missingStatus=404){const stores=await directory(),id=params.get('store')||'';if(id&&(!Object.hasOwn(stores,id)||stores[id].market==='WB'))routeFail(missingStatus===400?'Выберите магазин Ozon':'Магазин не подключён',missingStatus);return {stores,selected:publicStores(stores).filter(store=>!store.id.startsWith('wb-')&&(!id||store.id===id))}}
 function currentLedger(saved,catalog,extra){const value=saved?.version===3?saved:saved?.data?.version===3?saved.data:null;if(!value||!catalog||value.completedAt!==catalog.completedAt||value.period?.from!==catalog.period?.from||value.period?.to!==catalog.period?.to)return null;if(!saved?.source)return value;const source=saved.source,current=catalog._source;return current&&source.snapshotId===current.snapshotId&&source.marketRevision===current.marketRevision&&source.marketSha256===current.marketSha256&&source.typesSha256===typesHash(extra?.types||[])?value:null}
 async function reportInputs(selected){
  if(getReportInputRows){const rows=new Map((await getReportInputRows(selected.map(store=>store.id))).map(row=>[row.storeId,row]));return selected.map(store=>{const row=rows.get(store.id)||{},catalog=row.catalog||null,extra=row.extra||null,ledger=currentLedger(row.ledger||null,catalog,extra),snapshot=catalog?summary.summarize(catalog,row.costs||null,null):null;return{id:store.id,name:store.name,ledger,extra,products:model.rowsFor([store],new Map([[store.id,snapshot]]))}})}
  const extras=await insightData();return Promise.all(selected.map(async store=>{const [catalog,saved,costs,prices]=await Promise.all([getReportCatalog(store.id),getOzonLedger(store.id),exact(`costs-${store.id}.json`),exact(`prices-${store.id}.json`)]),extra=extras.get(store.id)||null,ledger=currentLedger(saved,catalog,extra),snapshot=catalog?summary.summarize(catalog,costs,prices):null;return {id:store.id,name:store.name,ledger,extra,products:model.rowsFor([store],new Map([[store.id,snapshot]]))}}))
 }
 async function insights(params){
  const scope=params.get('scope')||'full';if(!['orders','full'].includes(scope))routeFail('Некорректный состав отчёта.');
  const {selected}=await selectedOzon(params);let values;
  if(scope==='orders'){
   const extras=new Map((await (getOrderInsightsForStores?getOrderInsightsForStores(selected.map(store=>store.id)):getOrderInsights())).map(row=>[row.storeId,row.value]));
   values=selected.map(store=>({id:store.id,name:store.name,extra:extras.get(store.id)||null,ledger:null,products:[]}));
  }else values=await reportInputs(selected);
  const report=insightsPure.report(values,{from:params.get('from'),to:params.get('to'),hideInactive:params.get('hideInactive')!=='false'},new Date(now()));
  if(scope==='orders')for(const metric of Object.values(report.metrics))if(metric.source!=='orders'){metric.current=null;metric.previous=null}
  const [scheduleRows,syncJobs,historyError,history,jobRows]=await Promise.all([
   Promise.all(selected.map(async store=>({id:store.id,name:store.name,...await schedule(store.id)}))),
   Promise.all(selected.map(store=>schedules.job(store.id))),scope==='orders'?null:schedules.historyError(),
   report.days===1?intraday.series(selected.map(store=>store.id),report.current.from):null,jobs()
  ]);
  // The order source is committed before the derived history job. Include its
  // latest real observation immediately, without waiting for another job or
  // writing from a read request. Each store must cover the day and pass skew.
  let series=history;
  if(history&&report.current.from===day(now())){
   const observations=values.map(value=>intradayPure.point('orders',value.extra?.orders));
   if(observations.length&&observations.every(point=>point&&point.date===report.current.from&&Date.parse(point.at)<=now())){
    const latest=intradayPure.combine(observations.map(point=>[point]),'orders',report.current.from)[0];
    if(latest&&(!history.orders?.length||Date.parse(latest.at)>Date.parse(history.orders.at(-1).at)))series={...history,orders:[...(history.orders||[]),latest]};
   }
  }
  const nextAt=scheduleRows.map(row=>row.orders?.nextAt).filter(Boolean).sort()[0]||null,financeNextAt=scheduleRows.map(row=>row.finance?.nextAt||row.nextDueAt).filter(Boolean).sort()[0]||null;
  return {...report,scope,intraday:series,refresh:{intervalMinutes:refreshPolicy.ORDERS_INTERVAL/60000,ordersIntervalMinutes:refreshPolicy.ORDERS_INTERVAL/60000,financeIntervalMinutes:refreshPolicy.INTERVAL/60000,background:false,nextAt,financeNextAt,schedules:scheduleRows,error:historyError},jobs:jobRows,syncJobs};
 }
 async function insightSources(){const stores=await directory(),extras=await insightData();return {stores:Object.entries(stores).filter(([,store])=>store.market!=='WB').map(([id,store])=>({id,name:store.name,data:extras.get(id)||null})),jobs:await jobs()}}
 async function categoryStores(){const [stores,catalogRows,insightRows,wbRows]=await Promise.all([directory(),getCatalogs(),getCategoryInsights(),getWbOrders()]),catalogs=new Map(catalogRows.map(value=>[value.storeId,value])),insightsMap=new Map(insightRows.map(row=>[row.storeId,row.value])),wbMap=new Map(wbRows.map(row=>[row.storeId,row.value]));return Object.entries(stores).map(([id,store])=>{const catalog=catalogs.get(id)||{};return {id,market:store.market==='WB'?'WB':'Ozon',products:Array.isArray(catalog.products)?catalog.products:[],categoryTree:Array.isArray(catalog.categoryTree)?catalog.categoryTree:[],orders:store.market==='WB'?wbMap.get(id)||null:insightsMap.get(id)?.orders||null}})}
 async function orderCategories(params){const target=params.get('date')||day(now()),readState=typeof sourceProviders.getOrderCategoryState==='function'?()=>sourceProviders.getOrderCategoryState(target):()=>orderCategoryState.read(),[stores,state,registry,supplier]=await Promise.all([categoryStores(),readState(),productTypes.read(),supplierPortals.read()]);if(!state||!Array.isArray(state.points)||!Array.isArray(supplier?.categories))throw Error('Некорректное состояние категорий SQL');const current=registry?.available?categoriesPure.hierarchyIndex(stores,supplier.categories,registry):{active:false,revision:'legacy',types:[],byStore:categoriesPure.productIndex(stores,supplier.categories)},ozon=categoriesPure.ozonTotals(stores,current.byStore,target,{fallback:current.active?categoriesPure.UNMATCHED_ID:categoriesPure.UNMATCHED}),points=[...state.points];if(ozon.complete){const candidate={date:target,at:new Date(ozon.at).toISOString(),values:Object.fromEntries(ozon.totals)};if(current.active)Object.assign(candidate,{taxonomyRevision:current.revision,classifiedAt:new Date(now()).toISOString(),types:current.types.map(type=>({id:type.id,parentId:type.parentId,name:type.name}))});if(!points.some(point=>point.date===candidate.date&&point.at===candidate.at&&(current.active?point.taxonomyRevision===current.revision:!point.taxonomyRevision)))points.push(candidate)}return categoriesPure.buildReport({stores,state:{...state,points},current,ozon,date:target})}
 async function wbOrders(params){const stores=await directory(),storeId=params.get('store'),target=params.get('date')||day(now()),store=stores[storeId];if(!store||store.market!=='WB')routeFail('Выберите магазин Wildberries.');const state=(await getWbOrders()).find(row=>row.storeId===storeId)?.value||null,available=state?.complete===true&&state.day===target,savedSchedule=await schedule(storeId);return {days:1,current:{from:target,to:target},metrics:{orderedRevenue:{current:available?state.orderedRevenue:null},orderedUnits:{current:available?state.orderedUnits:null}},intraday:{orders:available?state.points:[],ordersIntervalMinutes:state?.intervalMinutes||30},coverage:{orders:available},source:state?.source||'/api/v1/supplier/orders',market:'WB',currency:'RUB',amountBasis:'priceWithDisc',fetchedAt:available?state.fetchedAt:null,error:available?null:state?.error||'Нет полного снимка заказов WB за выбранный день.',errorCode:available?null:state?.errorCode||'unavailable',warning:available?state?.error||null:null,refresh:{intervalMinutes:state?.intervalMinutes||30,...savedSchedule}}}
 async function economicsCompare(params){const {selected}=await selectedOzon(params,400),report=insightsPure.report(await reportInputs(selected),{from:params.get('from'),to:params.get('to')}),input={period:report.current,stores:selected.map(store=>({id:store.id,name:store.name})),localEconomics:report.economics},read=typeof trueStats.readCompare==='function'?trueStats.readCompare:trueStats.compare,result=await read(input);if(result?.status==='pending')trueStats.refreshCompare?.(input);return result}
 async function dynamics(params){if(typeof businessDynamics?.read!=='function')throw new DynamicsError('Динамика бизнеса временно недоступна.',503);return businessDynamics.read({date:params.get('date')||undefined,storeId:params.get('store')||undefined,market:params.get('market')||'all'})}
 async function handle(req,res,url){
  if(url.pathname==='/api/business-dynamics/target'){
   if(req.method!=='POST'){writeJson(res,405,{error:'Метод не поддерживается.'});return true}
   try{
    let bytes=0;const parts=[];for await(const part of req){bytes+=part.length;if(bytes>4096)routeFail('Запрос слишком большой.',413);parts.push(part)}
    let input;try{input=JSON.parse(Buffer.concat(parts).toString('utf8'))}catch{routeFail('Некорректный JSON.')}
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['date','amountRub'].includes(key)))routeFail('Проверьте параметры плана.');
    writeJson(res,200,await businessDynamics.saveTarget(input));
   }catch(error){const safe=error instanceof ReportRouteError||error instanceof DynamicsError;writeJson(res,safe?error.status:503,{error:safe?error.message:'Не удалось сохранить план.'})}
   return true;
  }
  if(req.method!=='GET'){if(url.pathname==='/api/business-dynamics'){writeJson(res,405,{error:'Метод не поддерживается.'});return true}return false}
  const routes={'/api/business-dynamics':dynamics,'/api/insights':insights,'/api/insights/sources':insightSources,'/api/order-categories':orderCategories,'/api/wb/orders':wbOrders,'/api/economics/compare':economicsCompare},method=routes[url.pathname];if(!method)return false;try{writeJson(res,200,await method(url.searchParams))}catch(error){const safe=error instanceof ReportRouteError||error instanceof DynamicsError;writeJson(res,safe?error.status:url.pathname==='/api/business-dynamics'?503:400,{error:safe?error.message:'Не удалось сформировать отчёт.'})}return true}
 return Object.freeze({insights,insightSources,orderCategories,wbOrders,economicsCompare,handle});
};
