'use strict';
// Local business snapshots only. Credentials, sessions and diagnostic logs are excluded.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Transform}=require('node:stream'),{pipeline}=require('node:stream/promises');
const {createGzip,gunzipSync}=require('node:zlib'),{DatabaseSync}=require('node:sqlite');
const STORE='(?:wb-)?[0-9]+';
const MARKET_FILES=new RegExp('^(?:data|insights|intraday|ledger|order-category-catalog|costs|prices|ozon-funnel|wb-orders)-'+STORE+'\\.json$');
const BUSINESS_FILES=new Set(['order-category-intraday.json','product-type-registry.json','ideas.json','charity.json','charity-plan.json','company-impact.json','management.json','partner-commercial-model.json','finance-register.json']);
const BUYER_FILES=/^buyer-order-segments-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.json$/;
const FACT_FILES=new RegExp('^(?:insights|ledger|order-category-catalog|wb-orders)-'+STORE+'\\.json$');
function allowed(name){return typeof name==='string'&&(MARKET_FILES.test(name)||BUSINESS_FILES.has(name)||BUYER_FILES.test(name))}
function create({privateDir,history=null,now=Date.now}){
 const folder=path.join(privateDir,'history'),objects=path.join(folder,'snapshots');
 fs.mkdirSync(objects,{recursive:true});
 const db=new DatabaseSync(path.join(folder,'archive.sqlite'));
 db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS versions(source_file TEXT NOT NULL, content_hash TEXT NOT NULL, captured_at TEXT NOT NULL, source_mtime REAL NOT NULL, source_bytes INTEGER NOT NULL, archive_bytes INTEGER NOT NULL, object_path TEXT NOT NULL, facts_status TEXT NOT NULL, PRIMARY KEY(source_file,content_hash));
 CREATE TABLE IF NOT EXISTS latest(source_file TEXT PRIMARY KEY, stamp TEXT NOT NULL, content_hash TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
 let running=null,lastError=null;
 const getLatest=db.prepare('SELECT l.stamp,v.* FROM latest l JOIN versions v ON v.source_file=l.source_file AND v.content_hash=l.content_hash WHERE l.source_file=?');
 const putState=db.prepare('INSERT OR REPLACE INTO state(key,value) VALUES(?,?)');
 function status(){
  const totals=db.prepare('SELECT COUNT(*) AS versions,COUNT(DISTINCT source_file) AS sources,COALESCE(SUM(archive_bytes),0) AS versionBytes,MIN(captured_at) AS firstCapturedAt,MAX(captured_at) AS lastCapturedAt FROM versions').get();
  const bytes=db.prepare('SELECT COALESCE(SUM(n),0) AS n FROM (SELECT MAX(archive_bytes) n FROM versions GROUP BY content_hash)').get().n;
  const disk=fs.statfsSync(folder),state=Object.fromEntries(db.prepare('SELECT key,value FROM state').all().map(r=>[r.key,r.value]));
  return {...totals,archiveBytes:bytes,freeDiskBytes:disk.bavail*disk.bsize,retentionDays:null,running:!!running,lastScanAt:state.lastScanAt||null,lastError:lastError||state.lastError||null,pendingFacts:db.prepare("SELECT COUNT(*) n FROM versions WHERE facts_status='pending'").get().n};
 }
 function importFacts(name,hash,objectPath,capturedAt){
  if(!history||!FACT_FILES.test(name))return 'not_applicable';
  const stat=fs.statSync(objectPath);
  if(stat.size>32*1024*1024)throw Error('fact_snapshot_too_large');
  const raw=gunzipSync(fs.readFileSync(objectPath),{maxOutputLength:64*1024*1024});
  history.ingest({sourceFile:name,contentHash:hash,data:JSON.parse(raw.toString('utf8').replace(/^\uFEFF/,'')),capturedAt});
  return 'imported';
 }
 async function capture(name){
  if(!allowed(name))throw Error('source_not_allowed');
  const source=path.join(privateDir,name),stat=fs.lstatSync(source);
  if(!stat.isFile()||stat.isSymbolicLink())throw Error('source_not_regular_file');
  const stamp=stat.size+':'+stat.mtimeMs,previous=getLatest.get(name);
  if(previous?.stamp===stamp&&previous.facts_status!=='pending')return {changed:false};
  if(previous?.stamp===stamp){
   const result=importFacts(name,previous.content_hash,path.join(folder,previous.object_path),previous.captured_at);
   db.prepare('UPDATE versions SET facts_status=? WHERE source_file=? AND content_hash=?').run(result,name,previous.content_hash);
   return {changed:false,retriedFacts:true};
  }
  const temporary=path.join(objects,'.capture-'+crypto.randomUUID()+'.tmp');
  const digest=crypto.createHash('sha256');let sourceBytes=0,handle;
  try{
   handle=await fs.promises.open(source,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));const before=await handle.stat(),opened=fs.lstatSync(source);
   if(!opened.isFile()||opened.isSymbolicLink()||before.dev!==opened.dev||before.ino!==opened.ino||before.dev!==stat.dev||before.ino!==stat.ino)throw Error('source_replaced_during_open');
   await pipeline(handle.createReadStream({autoClose:false}),new Transform({transform(chunk,encoding,cb){sourceBytes+=chunk.length;digest.update(chunk);cb(null,chunk)}}),createGzip({level:1}),fs.createWriteStream(temporary,{flags:'wx',flush:true}));
   const after=await handle.stat();
   if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||sourceBytes!==before.size)throw Error('source_changed_during_capture');
   const hash=digest.digest('hex'),prefix=path.join(objects,hash.slice(0,2));fs.mkdirSync(prefix,{recursive:true});
   const target=path.join(prefix,hash+'.json.gz');
   if(fs.existsSync(target))fs.unlinkSync(temporary);else fs.renameSync(temporary,target);
   const capturedAt=new Date(now()).toISOString(),relative=path.relative(folder,target),factStatus=history&&FACT_FILES.test(name)?'pending':'not_applicable';
   db.exec('BEGIN IMMEDIATE');
   try{
    db.prepare('INSERT OR IGNORE INTO versions VALUES(?,?,?,?,?,?,?,?)').run(name,hash,capturedAt,before.mtimeMs,sourceBytes,fs.statSync(target).size,relative,factStatus);
    db.prepare('INSERT OR REPLACE INTO latest VALUES(?,?,?)').run(name,before.size+':'+before.mtimeMs,hash);db.exec('COMMIT');
   }catch(error){db.exec('ROLLBACK');throw error}
   if(factStatus==='pending'){
    const imported=importFacts(name,hash,target,capturedAt);
    db.prepare('UPDATE versions SET facts_status=? WHERE source_file=? AND content_hash=?').run(imported,name,hash);
   }
   return {changed:true,hash};
  }finally{if(handle)await handle.close();if(fs.existsSync(temporary))fs.unlinkSync(temporary)}
 }
 async function cycle(){
  lastError=null;let changed=0,failed=0;
  // A failed old version still matters even if the current source has moved on.
  if(history)for(const item of db.prepare("SELECT * FROM versions WHERE facts_status='pending' ORDER BY captured_at LIMIT 100").all()){
   try{const result=importFacts(item.source_file,item.content_hash,path.join(folder,item.object_path),item.captured_at);db.prepare('UPDATE versions SET facts_status=? WHERE source_file=? AND content_hash=?').run(result,item.source_file,item.content_hash)}catch{failed++;lastError='Часть сохранённых данных ещё не перенесена в таблицы истории. Повторная попытка будет выполнена автоматически.'}
  }
  // Small catalogues and facts become queryable before large original snapshots are compressed.
  const names=fs.readdirSync(privateDir).filter(allowed).sort((a,b)=>Number(a.startsWith('data-'))-Number(b.startsWith('data-'))||a.localeCompare(b));
  for(const name of names){try{if((await capture(name)).changed)changed++}catch(error){failed++;lastError=error.code==='ENOSPC'?'Недостаточно места для сохранения истории. Существующая история сохранена.':'Не удалось сохранить часть обновлений истории. Повторная попытка будет выполнена автоматически.'}}
  putState.run('lastScanAt',new Date(now()).toISOString());putState.run('lastError',lastError||'');return {changed,failed};
 }
 function scan(){if(running)return running;running=cycle().catch(error=>{lastError='Фоновое сохранение истории завершилось с ошибкой. Сохранённые данные остаются на диске.';try{putState.run('lastError',lastError)}catch{}throw error}).finally(()=>{running=null});return running}
 function close(){if(running)throw Error('archive_busy');db.close()}
 return {scan,capture,status,close};
}
module.exports={create,allowed,FACT_FILES};
