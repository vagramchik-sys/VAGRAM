'use strict';

const crypto=require('node:crypto');
const {encodeJson}=require('./postgres-json-repository.cjs');
const {LABELS}=require('../stock-history.cjs');
const MEDIA_TYPE='application/vnd.pult.stock-history-command+json',MAX_ENVELOPE_BYTES=230*1024*1024,HASH=/^[a-f0-9]{64}$/u;
const FIELDS=['day','observedAt','source','storeId','storeName','sku','article','name','warehouse','warehouseId','cluster','totalStock','available','inTransit','reserved','quality'];
class StockHistoryWriterError extends Error{constructor(code,message){super(message);this.name='StockHistoryWriterError';this.code=code}}
const fail=(code,message)=>{throw new StockHistoryWriterError(code,message)};
const prop=(value,key)=>{const d=Object.getOwnPropertyDescriptor(value,key);if(!d?.enumerable||!Object.hasOwn(d,'value'))fail('INVALID_COMMAND',`Missing command field ${key}`);return d.value};
const validDay=value=>/^\d{4}-\d{2}-\d{2}$/u.test(value||'')&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const exactJson=(value,label)=>{try{encodeJson(value,MAX_ENVELOPE_BYTES);const text=JSON.stringify(value);if(typeof text!=='string')throw Error();return text}catch{fail('INVALID_COMMAND',`${label} must be strict JSON`)}};
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
function schemaName(value){if(typeof value!=='string'||!/^[a-z][a-z0-9_]{0,62}$/u.test(value))throw new TypeError('schema must be a PostgreSQL identifier');return `"${value}"`}

function prepare(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.getPrototypeOf(input)!==Object.prototype)fail('INVALID_COMMAND','Stock history command must be a plain object');
 if(prop(input,'schemaVersion')!==1||prop(input,'kind')!=='stock-history.ingest')fail('UNSUPPORTED_COMMAND','Unsupported stock history command');
 const commandId=prop(input,'commandId'),expectedRevision=prop(input,'expectedRevision'),importId=prop(input,'importId'),importedAt=prop(input,'importedAt'),manifest=prop(input,'manifest'),issues=prop(input,'issues'),sourceRows=prop(input,'rows');
 if(typeof commandId!=='string'||typeof expectedRevision!=='string'||typeof importId!=='string'||!HASH.test(importId))fail('INVALID_COMMAND','Stock history command identity is invalid');
 if(typeof importedAt!=='string'||Number.isNaN(Date.parse(importedAt))||new Date(importedAt).toISOString()!==importedAt)fail('INVALID_COMMAND','importedAt must be canonical UTC');
 if(!Array.isArray(sourceRows)||!sourceRows.length)fail('INVALID_COMMAND','Stock history rows are empty');
 const manifestText=exactJson(manifest,'manifest'),issuesText=exactJson(issues,'issues');if(!Array.isArray(issues))fail('INVALID_COMMAND','issues must be an array');
 const rows=sourceRows.map((sourceRow,index)=>{
  if(!sourceRow||typeof sourceRow!=='object'||Array.isArray(sourceRow)||Object.getPrototypeOf(sourceRow)!==Object.prototype)fail('INVALID_COMMAND',`Row ${index} is invalid`);
  const row={};for(const key of FIELDS)row[key]=sourceRow[key]??null;
  if(!validDay(row.day)||!Object.hasOwn(LABELS,row.source)||typeof row.storeId!=='string'||!row.storeId||typeof row.storeName!=='string'||!row.storeName||typeof row.sku!=='string'||!row.sku)fail('INVALID_COMMAND',`Row ${index} identity is invalid`);
  if(row.observedAt!==null&&(typeof row.observedAt!=='string'||Number.isNaN(Date.parse(row.observedAt))))fail('INVALID_COMMAND',`Row ${index} observedAt is invalid`);
  for(const key of ['article','name','warehouse','warehouseId','cluster','quality'])if(row[key]!==null&&typeof row[key]!=='string')fail('INVALID_COMMAND',`Row ${index} ${key} is invalid`);
  for(const key of ['totalStock','available','inTransit','reserved'])if(row[key]!==null&&(!Number.isSafeInteger(row[key])||row[key]<0))fail('INVALID_COMMAND',`Row ${index} quantity is invalid`);
  if(typeof sourceRow.sourceFile!=='string'||!sourceRow.sourceFile||sourceRow.sourceFile.length>1000||sourceRow.sourceFile.includes('\0')||
      !(typeof sourceRow.sourceRow==='string'&&sourceRow.sourceRow.length<=1000||Number.isSafeInteger(sourceRow.sourceRow)))fail('INVALID_COMMAND',`Row ${index} origin is invalid`);
  const detailsText=exactJson(sourceRow.details||{},`Row ${index} details`),id=sha(JSON.stringify(FIELDS.map(key=>row[key]))+'\n'+detailsText);
  const originRow=String(sourceRow.sourceRow);if(originRow.includes('\0'))fail('INVALID_COMMAND',`Row ${index} origin is invalid`);return Object.freeze({...row,id,detailsText,sourceFile:sourceRow.sourceFile,sourceRow:originRow});
 });
 const envelope=encodeJson({schemaVersion:1,kind:'stock-history.ingest',importId,importedAt,manifestText,issuesText,provided:rows.length,rows},MAX_ENVELOPE_BYTES);
 return Object.freeze({commandId,expectedRevision,importId,importedAt,manifestText,issuesText,rows,envelope,logicalKey:`history/stock-import/${importId}`});
}
function validateEnvelope(value){
 try{
  if(!value||value.kind!=='stock-history.ingest'||typeof value.manifestText!=='string'||typeof value.issuesText!=='string'||!Array.isArray(value.rows))throw Error();
  const rebuilt=prepare({schemaVersion:1,kind:'stock-history.ingest',commandId:'00000000-0000-4000-8000-000000000000',expectedRevision:'0',importId:value.importId,importedAt:value.importedAt,manifest:JSON.parse(value.manifestText),issues:JSON.parse(value.issuesText),rows:value.rows.map(row=>({...row,details:JSON.parse(row.detailsText)}) )});
  if(!rebuilt.envelope.equals(encodeJson(value,MAX_ENVELOPE_BYTES)))throw Error();return value;
 }catch(error){if(error instanceof StockHistoryWriterError)throw error;fail('INVALID_COMMAND','Stock history envelope is invalid')}
}

function createStockHistoryWriter({stateStore,schema='pult_history'}={}){
 if(!stateStore||typeof stateStore.writeWithEffect!=='function')throw new TypeError('stateStore.writeWithEffect is required');const qschema=schemaName(schema),table=name=>`${qschema}."${name}"`;
 const expectedRow=row=>({day:row.day,observedAt:row.observedAt,source:row.source,storeId:row.storeId,storeName:row.storeName,sku:row.sku,article:row.article,name:row.name,warehouse:row.warehouse,warehouseId:row.warehouseId,cluster:row.cluster,totalStock:row.totalStock===null?null:String(row.totalStock),available:row.available===null?null:String(row.available),inTransit:row.inTransit===null?null:String(row.inTransit),reserved:row.reserved===null?null:String(row.reserved),quality:row.quality,detailsText:row.detailsText});
 const sameRow=(row,stored)=>Boolean(stored)&&JSON.stringify(stored)===JSON.stringify(expectedRow(row));
 async function effect(command,client){
  const prior=(await client.query(`SELECT imported_at_text,manifest_text,issues_text FROM ${table('stock_imports')} WHERE id=$1`,[command.importId])).rows[0];
  if(prior){
   if(prior.imported_at_text!==command.importedAt||prior.manifest_text!==command.manifestText||prior.issues_text!==command.issuesText)fail('IMPORT_ID_CONFLICT','importId already identifies different metadata');
   const stored=(await client.query(`SELECT o.row_id,o.source_file,o.source_row,to_char(r.day,'YYYY-MM-DD') AS "day",r.observed_at_text AS "observedAt",r.source,r.store_id AS "storeId",r.store_name AS "storeName",r.sku,r.article,r.name,r.warehouse,r.warehouse_id AS "warehouseId",r.cluster,r.total_stock::text AS "totalStock",r.available::text AS available,r.in_transit::text AS "inTransit",r.reserved::text AS reserved,r.quality,r.details_text AS "detailsText" FROM ${table('stock_origins')} o JOIN ${table('stock_rows')} r ON r.id=o.row_id WHERE o.import_id=$1`,[command.importId])).rows;
   const expected=new Map(command.rows.map(row=>[`${row.id}\0${row.sourceFile}\0${row.sourceRow}`,row]));
   if(stored.length!==expected.size)fail('IMPORT_ID_CONFLICT','importId already identifies different rows');
   for(const item of stored){const row=expected.get(`${item.row_id}\0${item.source_file}\0${item.source_row}`);if(!row||!sameRow(row,Object.fromEntries(Object.entries(item).filter(([key])=>!['row_id','source_file','source_row'].includes(key)))))fail('IMPORT_ID_CONFLICT','importId already identifies different rows')}
   return{duplicate:true,inserted:0};
  }
  await client.query(`INSERT INTO ${table('stock_imports')}(id,imported_at,imported_at_text,manifest,manifest_text,issues,issues_text) VALUES($1,$2::text::timestamptz,$2::text,$3::text::jsonb,$3::text,$4::text::jsonb,$4::text)`,[command.importId,command.importedAt,command.manifestText,command.issuesText]);
  let inserted=0;
  for(const row of command.rows){
   const values=[row.id,row.day,row.observedAt,row.source,row.storeId,row.storeName,row.sku,row.article,row.name,row.warehouse,row.warehouseId,row.cluster,row.totalStock,row.available,row.inTransit,row.reserved,row.quality,row.detailsText];
   const added=await client.query(`INSERT INTO ${table('stock_rows')}(id,day,observed_at,observed_at_text,source,store_id,store_name,sku,article,name,warehouse,warehouse_id,cluster,total_stock,available,in_transit,reserved,quality,details,details_text) VALUES($1,$2::text::date,$3::text::timestamptz,$3::text,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::bigint,$14::bigint,$15::bigint,$16::bigint,$17,$18::text::jsonb,$18::text) ON CONFLICT(id) DO NOTHING RETURNING id`,values);
   if(added.rows.length)inserted++;else{
    const stored=(await client.query(`SELECT to_char(day,'YYYY-MM-DD') AS "day",observed_at_text AS "observedAt",source,store_id AS "storeId",store_name AS "storeName",sku,article,name,warehouse,warehouse_id AS "warehouseId",cluster,total_stock::text AS "totalStock",available::text AS available,in_transit::text AS "inTransit",reserved::text AS reserved,quality,details_text AS "detailsText" FROM ${table('stock_rows')} WHERE id=$1`,[row.id])).rows[0];
    if(!sameRow(row,stored))fail('ROW_ID_CONFLICT','Stock row id identifies different content');
   }
   await client.query(`INSERT INTO ${table('stock_origins')}(row_id,import_id,source_file,source_row) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[row.id,command.importId,row.sourceFile,row.sourceRow]);
  }
  return{duplicate:false,inserted,provided:command.rows.length,issues:JSON.parse(command.issuesText).length};
 }
 async function ingest(input){const command=prepare(input);return stateStore.writeWithEffect(command.logicalKey,command.envelope,{expectedRevision:command.expectedRevision,commandId:command.commandId,mediaType:MEDIA_TYPE},client=>effect(command,client))}
 return Object.freeze({ingest});
}
module.exports={createStockHistoryWriter,StockHistoryWriterError,MEDIA_TYPE,prepare,validateEnvelope,FIELDS,MAX_ENVELOPE_BYTES};
