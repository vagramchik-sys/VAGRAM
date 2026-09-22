'use strict';
const {DatabaseSync}=require('node:sqlite');
const {postgresSummary,sqliteSummary,inventorySummary,validateSummary}=require('./postgres-parity-stream.cjs');
class StockHistoryParityError extends Error{constructor(code,message){super(message);this.name='StockHistoryParityError';this.code=code}}
const fail=(code,message)=>{throw new StockHistoryParityError(code,message)};
const quote=value=>{if(typeof value!=='string'||!/^[a-z][a-z0-9_]{0,62}$/u.test(value))throw new TypeError('schema must be a PostgreSQL identifier');return `"${value}"`};
const sort=(rows,keys)=>rows.sort((a,b)=>{for(const key of keys){const order=String(a[key]??'').localeCompare(String(b[key]??''),'en');if(order)return order}return 0});
const number=value=>value==null?null:String(value);
const NAMES=['imports','rows','origins'];
function summary(inventory){return Object.freeze(inventorySummary(inventory,NAMES))}
const pick=(row,a,b)=>Object.hasOwn(row,a)?row[a]:row[b];
const mapImport=row=>({id:row.id,importedAt:pick(row,'importedAt','imported_at'),manifestText:pick(row,'manifestText','manifest'),issuesText:pick(row,'issuesText','issues')});
const mapRow=row=>({id:row.id,day:row.day,observedAt:pick(row,'observedAt','observed_at'),source:row.source,storeId:pick(row,'storeId','store_id'),storeName:pick(row,'storeName','store_name'),sku:row.sku,article:row.article,name:row.name,warehouse:row.warehouse,warehouseId:pick(row,'warehouseId','warehouse_id'),cluster:row.cluster,totalStock:number(pick(row,'totalStock','total_stock')),available:number(row.available),inTransit:number(pick(row,'inTransit','in_transit')),reserved:number(row.reserved),quality:row.quality,detailsText:pick(row,'detailsText','details')});
const mapOrigin=row=>({rowId:pick(row,'rowId','row_id'),importId:pick(row,'importId','import_id'),sourceFile:pick(row,'sourceFile','source_file'),sourceRow:pick(row,'sourceRow','source_row')});
async function postgresStockInventory(client,{schema='pult_history'}={}){
 const s=quote(schema),imports=(await client.query(`SELECT id,imported_at_text AS "importedAt",manifest_text AS "manifestText",issues_text AS "issuesText" FROM ${s}.stock_imports`)).rows;
 const rows=(await client.query(`SELECT id,to_char(day,'YYYY-MM-DD') AS "day",observed_at_text AS "observedAt",source,store_id AS "storeId",store_name AS "storeName",sku,article,name,warehouse,warehouse_id AS "warehouseId",cluster,total_stock::text AS "totalStock",available::text AS available,in_transit::text AS "inTransit",reserved::text AS reserved,quality,details_text AS "detailsText" FROM ${s}.stock_rows`)).rows;
 const origins=(await client.query(`SELECT row_id AS "rowId",import_id AS "importId",source_file AS "sourceFile",source_row AS "sourceRow" FROM ${s}.stock_origins`)).rows;
 return{imports:sort(imports,['id']),rows:sort(rows,['id']),origins:sort(origins,['rowId','importId','sourceFile','sourceRow'])};
}
function legacyStockInventory({dbFile}){
 if(typeof dbFile!=='string'||!dbFile)throw new TypeError('dbFile is required');let db;try{db=new DatabaseSync(dbFile,{readOnly:true});const imports=db.prepare('SELECT id,imported_at "importedAt",manifest "manifestText",issues "issuesText" FROM imports').all().map(row=>({...row}));const rows=db.prepare('SELECT id,day,observedAt,source,storeId,storeName,sku,article,name,warehouse,warehouseId,cluster,totalStock,available,inTransit,reserved,quality,details "detailsText" FROM stock_rows').all().map(row=>({...row,totalStock:number(row.totalStock),available:number(row.available),inTransit:number(row.inTransit),reserved:number(row.reserved)}));const origins=db.prepare('SELECT row_id "rowId",import_id "importId",source_file "sourceFile",source_row "sourceRow" FROM origins').all().map(row=>({...row}));return{imports:sort(imports,['id']),rows:sort(rows,['id']),origins:sort(origins,['rowId','importId','sourceFile','sourceRow'])}}catch{fail('LEGACY_READ_FAILED','Legacy stock history inventory could not be read')}finally{try{db?.close()}catch{}}}
function compareStockInventories(expected,actual){const left=summary(expected),right=summary(actual);for(const name of Object.keys(left))if(left[name].count!==right[name].count||left[name].sha256!==right[name].sha256)fail('PARITY_MISMATCH',`Stock history ${name} differs`);return Object.freeze({matched:true,...left})}
async function summarizePostgresStock(client,{schema='pult_history',batchSize=128}={}){const s=quote(schema),text=column=>`${column} COLLATE "C" ASC NULLS FIRST`;return postgresSummary(client,[
 {name:'imports',sql:`SELECT id,imported_at_text AS "importedAt",manifest_text AS "manifestText",issues_text AS "issuesText" FROM ${s}.stock_imports ORDER BY ${text('id')}`,map:mapImport},
 {name:'rows',sql:`SELECT id,to_char(day,'YYYY-MM-DD') AS "day",observed_at_text AS "observedAt",source,store_id AS "storeId",store_name AS "storeName",sku,article,name,warehouse,warehouse_id AS "warehouseId",cluster,total_stock::text AS "totalStock",available::text AS available,in_transit::text AS "inTransit",reserved::text AS reserved,quality,details_text AS "detailsText" FROM ${s}.stock_rows ORDER BY ${text('id')}`,map:mapRow},
 {name:'origins',sql:`SELECT row_id AS "rowId",import_id AS "importId",source_file AS "sourceFile",source_row AS "sourceRow" FROM ${s}.stock_origins ORDER BY ${text('row_id')},${text('import_id')},${text('source_file')},${text('source_row')}`,map:mapOrigin}
 ],{batchSize})}
async function summarizeLegacyStock({dbFile,batchSize=128}={}){void batchSize;if(typeof dbFile!=='string'||!dbFile)throw new TypeError('dbFile is required');let db;try{db=new DatabaseSync(dbFile,{readOnly:true});return await sqliteSummary(db,[
 {name:'imports',sql:'SELECT id,imported_at,manifest,issues FROM imports ORDER BY id COLLATE BINARY ASC',map:mapImport},
 {name:'rows',sql:'SELECT id,day,observedAt,source,storeId,storeName,sku,article,name,warehouse,warehouseId,cluster,totalStock,available,inTransit,reserved,quality,details FROM stock_rows ORDER BY id COLLATE BINARY ASC',map:mapRow},
 {name:'origins',sql:'SELECT row_id,import_id,source_file,source_row FROM origins ORDER BY row_id COLLATE BINARY ASC,import_id COLLATE BINARY ASC,source_file COLLATE BINARY ASC,source_row COLLATE BINARY ASC',map:mapOrigin}
 ])}catch(error){if(error instanceof StockHistoryParityError)throw error;fail('LEGACY_READ_FAILED','Legacy stock history summary could not be read')}finally{try{db?.close()}catch{}}}
function compareStockSummary(expected,actual){try{validateSummary(expected,NAMES);validateSummary(actual,NAMES)}catch{fail('PARITY_INVALID','Stock history summary version is unsupported')}if(JSON.stringify(expected)!==JSON.stringify(actual))fail('PARITY_MISMATCH','Staged legacy stock history differs from PostgreSQL summary');return{matched:true,expected,actual}}
module.exports={postgresStockInventory,legacyStockInventory,compareStockInventories,stockInventorySummary:summary,summarizePostgresStock,summarizeLegacyStock,compareStockSummary,StockHistoryParityError};
