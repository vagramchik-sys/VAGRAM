'use strict';
const {createJsonDocumentRepository}=require('../postgres-json-repository.cjs');
const {sourceKey}=require('../postgres-document-import.cjs');
const {INTERVAL,ORDERS_INTERVAL}=require('../../refresh-policy.cjs');
const {INTERVAL:WB_INTERVAL}=require('../../wb-orders.cjs');
const {isOnDemand}=require('../acquisition/acquisition-policy.cjs');
const validImpact=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Number.isSafeInteger(value.donatedRub)&&value.donatedRub>=0&&Number.isSafeInteger(value.childrenHomes)&&value.childrenHomes>=0&&(value.updatedAt===undefined||typeof value.updatedAt==='string'&&Number.isFinite(Date.parse(value.updatedAt)));
const iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const safeCodes=value=>Array.isArray(value)?value.filter(code=>typeof code==='string'&&/^[A-Z0-9_]{1,80}$/u.test(code)).slice(0,20):[];
const sourcePath=(kind,id,wb)=>kind==='market'?`data-${id}.json`:kind==='costs-prices'?`${wb?'prices':'costs'}-${id}.json`:kind==='insights-full'||kind==='insights-today'?`insights-${id}.json`:kind==='insights-funnel'?`ozon-funnel-${id}.json`:kind==='wb-orders'?`wb-orders-${id}.json`:null;
const interval=kind=>kind==='insights-today'?ORDERS_INTERVAL:kind==='wb-orders'?WB_INTERVAL:INTERVAL;
function successAt(kind,value){if(!value||typeof value!=='object')return null;if(kind==='market')return value.sections&&Object.keys(value.sections).length&&Object.values(value.sections).every(section=>section?.ok===true)?iso(value.completedAt):null;if(kind==='insights-today')return iso(value.orders?.updatedAt);if(kind==='insights-full')return value.sections?.orders?.ok===true&&value.sections?.types?.ok===true?iso(value.orders?.historyUpdatedAt||value.completedAt):null;if(kind==='insights-funnel')return value.snapshot?.complete===true?iso(value.snapshot.updatedAt):null;if(kind==='wb-orders')return value.complete===true?iso(value.fetchedAt):null;return iso(value.importedAt)}
module.exports=function createPostgresInfoRoutes({stateStore,releaseNotes,storesRepository,scheduler,readSourceMetadata,now=()=>Date.now()}={}){
 if(!stateStore||!releaseNotes||typeof releaseNotes!=='object')throw new TypeError('stateStore and releaseNotes are required');const repo=createJsonDocumentRepository({stateStore,logicalKey:sourceKey('company-impact.json'),sourcePath:'company-impact.json',validate:validImpact});
 const reply=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value))};
 async function dataUpdates(){
  if(typeof storesRepository?.read!=='function'||typeof scheduler?.statusJobs!=='function'||typeof readSourceMetadata!=='function')throw Error('DATA_UPDATES_UNAVAILABLE');
  const [stores,jobs]=await Promise.all([storesRepository.read(),scheduler.statusJobs()]);if(!stores||typeof stores!=='object'||Array.isArray(stores)||!jobs||typeof jobs!=='object'||Array.isArray(jobs))throw Error('DATA_UPDATES_UNAVAILABLE');
  const descriptors=[];
  for(const [id,store] of Object.entries(stores).sort(([a],[b])=>a.localeCompare(b))){
   const wb=store?.market==='WB'||id.startsWith('wb-'),kinds=wb?['market','costs-prices','wb-orders']:['market','costs-prices','insights-full','insights-today','insights-funnel'];
   for(const kind of kinds)descriptors.push({kind,id,store,wb,path:sourcePath(kind,id,wb)});
  }
  const metadata=await readSourceMetadata([...new Set(descriptors.map(row=>row.path))]);if(!(metadata instanceof Map))throw Error('DATA_UPDATES_UNAVAILABLE');
  const rows=descriptors.map(({kind,id,store,wb,path})=>{
   const job=jobs[`${kind}:${id}`]||null,lastSuccessAt=successAt(kind,metadata.get(path)),manual=isOnDemand(kind),onDemandOnly=safeCodes(job?.errorCodes).includes('ON_DEMAND_ONLY'),status=manual&&onDemandOnly?'idle':job?.state||'idle',errorCodes=safeCodes(job?.errorCodes).filter(code=>code!=='ON_DEMAND_ONLY'),active=!manual&&job&&['queued','running'].includes(job.state),estimate=!manual&&lastSuccessAt?new Date(Date.parse(lastSuccessAt)+interval(kind)).toISOString():null;
   return{kind,storeId:id,storeName:typeof store?.name==='string'?store.name:null,market:wb?'WB':'Ozon',status,lastSuccessAt,attemptAt:status!=='idle'&&job&&['queued','running','error','unknown','partial'].includes(job.state)?iso(job.timestamp):null,nextDueAt:active?iso(job.nextDueAt):estimate,nextDueKind:manual?'manual':active?'scheduled':estimate?'estimate':null,intervalMs:manual?null:interval(kind),errorCodes};
  });
  const derived=jobs['derived-capture:0'];if(derived)rows.push({kind:'derived-capture',storeId:null,storeName:null,market:null,status:derived.state,lastSuccessAt:derived.state==='done'?iso(derived.timestamp):null,attemptAt:['queued','running','error','unknown','partial'].includes(derived.state)?iso(derived.timestamp):null,nextDueAt:['queued','running'].includes(derived.state)?iso(derived.nextDueAt):derived.state==='done'&&iso(derived.timestamp)?new Date(Date.parse(derived.timestamp)+INTERVAL).toISOString():null,nextDueKind:['queued','running'].includes(derived.state)?'scheduled':derived.state==='done'?'estimate':null,intervalMs:INTERVAL,errorCodes:safeCodes(derived.errorCodes)});
  return{checkedAt:new Date(now()).toISOString(),jobs:rows};
 }
 async function handle(req,res,url){if(!['/api/impact','/api/changes','/api/data-updates'].includes(url.pathname))return false;if(req.method!=='GET'){reply(res,405,{error:'Метод не поддерживается.'});return true}if(url.pathname==='/api/data-updates'){try{reply(res,200,await dataUpdates())}catch{reply(res,503,{error:'Статусы обновлений временно недоступны.'})}return true}if(url.pathname==='/api/changes')reply(res,200,structuredClone(releaseNotes));else{const row=await repo.read();reply(res,200,row&&!row.deleted?{donatedRub:row.value.donatedRub,childrenHomes:row.value.childrenHomes,updatedAt:row.value.updatedAt,source:'owner'}:null)}return true}
 return Object.freeze({handle});
};
