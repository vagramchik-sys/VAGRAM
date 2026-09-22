'use strict';
const crypto=require('node:crypto');
const {createJsonDocumentRepository,encodeJson}=require('../postgres-json-repository.cjs');
const {sourceKey}=require('../postgres-document-import.cjs');
const pure=require('../../order-categories.cjs');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,DAY=/^\d{4}-\d{2}-\d{2}$/u,HASH=/^[a-f0-9]{64}$/u;
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
class CategoryCaptureError extends Error{constructor(message,status=400){super(message);this.name='CategoryCaptureError';this.status=status;this.public=true}}
const fail=(message,status)=>{throw new CategoryCaptureError(message,status)};
function validEvidence(value){return Array.isArray(value)&&value.length>0&&value.length<=100&&value.every(row=>object(row)&&typeof row.sourcePath==='string'&&row.sourcePath.length<=500&&typeof row.revision==='string'&&/^(0|[1-9]\d*)$/u.test(row.revision)&&HASH.test(row.sha256||''))}
function validState(value){return object(value)&&[1,2].includes(value.version)&&Array.isArray(value.points)&&(value.commandResults===undefined||Array.isArray(value.commandResults)&&value.commandResults.every(row=>object(row)&&UUID.test(row.commandId||'')&&typeof row.timestamp==='string'&&Number.isFinite(Date.parse(row.timestamp))&&HASH.test(row.inputHash||'')&&typeof row.changed==='boolean'&&Number.isSafeInteger(row.pointCount)&&typeof row.complete==='boolean'&&(row.reason===null||typeof row.reason==='string')))&&value.points.every(point=>object(point)&&DAY.test(point.date||'')&&typeof point.at==='string'&&Number.isFinite(Date.parse(point.at))&&object(point.values)&&Object.values(point.values).every(amount=>object(amount)&&Number.isFinite(amount.orderedRevenue)&&Number.isSafeInteger(amount.orderedUnits)&&amount.orderedUnits>=0)&&(point.taxonomyRevision===undefined||typeof point.taxonomyRevision==='string')&&(point.classifiedAt===undefined||typeof point.classifiedAt==='string'&&Number.isFinite(Date.parse(point.classifiedAt)))&&(point.types===undefined||Array.isArray(point.types)))}
function operation(value){if(!object(value)||!UUID.test(value.commandId||'')||typeof value.timestamp!=='string'||!Number.isFinite(Date.parse(value.timestamp)))fail('Для фиксации категорий нужны стабильные commandId и timestamp.');return {commandId:value.commandId.toLowerCase(),timestamp:value.timestamp}}
module.exports=function createPostgresOrderCategoryCapture({stateStore}={}){
 if(!stateStore)throw new TypeError('stateStore is required');
 const sourcePath='order-category-intraday.json',repo=createJsonDocumentRepository({stateStore,logicalKey:sourceKey(sourcePath),sourcePath,validate:validState,maxBytes:64*1024*1024}),empty=()=>({version:1,points:[],commandResults:[]});
 async function load(){const record=await repo.read();return {record,value:record&&!record.deleted?record.value:empty()}}
 async function capture(input,commandInput){
  let detached;try{detached=JSON.parse(encodeJson(input,32*1024*1024).toString('utf8'))}catch{fail('Некорректный снимок категорий.')}
  const op=operation(commandInput);if(!object(detached)||!Array.isArray(detached.stores)||!Array.isArray(detached.categories)||!object(detached.registry)||!DAY.test(detached.date||'')||!validEvidence(detached.evidence)||!HASH.test(detached.batchIntentHash||''))fail('Некорректный снимок категорий.');
  const inputHash=crypto.createHash('sha256').update(encodeJson(detached,32*1024*1024)).digest('hex'),journal=await repo.readCommand(op.commandId);
  if(journal){const receipt=(journal.after.value.commandResults||[]).find(row=>row.commandId===op.commandId);if(!receipt||receipt.timestamp!==op.timestamp||receipt.inputHash!==inputHash){const error=Error('command reused');error.code='COMMAND_ID_REUSED';throw error}await repo.compareAndSet(journal.after.value,{expectedRevision:journal.before.revision,commandId:op.commandId});return {...receipt,replayed:true}}
  const loaded=await load(),current=detached.registry.available?pure.hierarchyIndex(detached.stores,detached.categories,detached.registry):{active:false,revision:'legacy',types:[],byStore:pure.productIndex(detached.stores,detached.categories)},ozon=pure.ozonTotals(detached.stores,current.byStore,detached.date,{fallback:current.active?pure.UNMATCHED_ID:pure.UNMATCHED}),next=structuredClone(loaded.value);let changed=false;
  if(ozon.complete){const point={date:detached.date,at:new Date(ozon.at).toISOString(),values:Object.fromEntries(ozon.totals)};if(current.active)Object.assign(point,{taxonomyRevision:current.revision,classifiedAt:op.timestamp,types:current.types.map(type=>({id:type.id,parentId:type.parentId,name:type.name}))});const same=item=>item.date===point.date&&item.at===point.at&&(current.active?item.taxonomyRevision===current.revision:!item.taxonomyRevision);if(!next.points.some(same)){next.points.push(point);next.points.sort((a,b)=>a.at.localeCompare(b.at));next.version=current.active?2:next.version||1;changed=true}}
  const receipt={commandId:op.commandId,timestamp:op.timestamp,inputHash,changed,pointCount:next.points.length,complete:ozon.complete,reason:ozon.complete?null:ozon.reason};next.commandResults=[receipt];
  try{await repo.compareAndSet(next,{expectedRevision:loaded.record?.revision||'0',commandId:op.commandId})}catch(error){if(error?.code==='REVISION_CONFLICT')fail('История категорий уже изменилась. Повторите сбор новой командой.',409);throw error}return {...receipt,replayed:false}
 }
 async function read(){return (await load()).value}
 return Object.freeze({capture,read});
};
module.exports.CategoryCaptureError=CategoryCaptureError;
module.exports.validState=validState;
