'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const LABELS={
 'daily-total':'Дневная история — товары',
 'daily-warehouse':'Дневная история — склады',
 'cabinet-total':'Снимок кабинета — товары',
 'cabinet-warehouse':'Снимок кабинета — склады',
 'seller-warehouse':'Архив Seller API — склады',
 'cluster-warehouse':'Сохранённый API — склады и кластеры',
 'audit-total':'Внутридневная история — товары',
 'audit-warehouse':'Внутридневная история — склады',
 'diagnostic-warehouse':'Архив API за август — неполные выборки'
};
const LIMITATIONS=[
 'Это сохранённая история Control Seller. Дата наблюдения может отличаться от даты дневной записи; актуальные остатки Пульта не заменены.',
 'Источники и даты не складываются между собой. «Остаток источника» может включать недоступные товары и отличается от «Доступно».',
 'Импортированы файловые снимки. Более полная история из резервной SQL-базы пока не перенесена.',
 'Отсутствие записи или неизвестное значение не означает нулевой остаток.'
];
const FIELDS=['day','observedAt','source','storeId','storeName','sku','article','name','warehouse','warehouseId','cluster','totalStock','available','inTransit','reserved','quality'];
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function day(value){return /^\d{4}-\d{2}-\d{2}$/.test(value||'')&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value}
function invalid(message){const error=Error(message);error.public=true;return error}
function open(dbFile,readOnly=false){
 const db=new DatabaseSync(dbFile,{readOnly});db.exec('PRAGMA busy_timeout=5000;');
 if(!readOnly)db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS imports(id TEXT PRIMARY KEY,imported_at TEXT NOT NULL,manifest TEXT NOT NULL,issues TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS stock_rows(id TEXT PRIMARY KEY,day TEXT NOT NULL,observedAt TEXT,source TEXT NOT NULL,storeId TEXT NOT NULL,storeName TEXT NOT NULL,sku TEXT NOT NULL,article TEXT,name TEXT,warehouse TEXT,warehouseId TEXT,cluster TEXT,totalStock INTEGER,available INTEGER,inTransit INTEGER,reserved INTEGER,quality TEXT,details TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS origins(row_id TEXT NOT NULL REFERENCES stock_rows(id),import_id TEXT NOT NULL REFERENCES imports(id),source_file TEXT NOT NULL,source_row TEXT NOT NULL,PRIMARY KEY(row_id,import_id,source_file,source_row));
 CREATE INDEX IF NOT EXISTS stock_scope ON stock_rows(source,storeId,day,sku);
 CREATE INDEX IF NOT EXISTS stock_product ON stock_rows(storeId,sku,source,day);
 `);
 return db;
}
function ingest({dbFile,importId,manifest,rows,issues=[],now=new Date().toISOString()}){
 if(!/^[a-f0-9]{64}$/.test(importId)||!Array.isArray(rows)||!rows.length)throw Error('Некорректный или пустой импорт истории');
 const db=open(dbFile);
 try{
  if(db.prepare('SELECT id FROM imports WHERE id=?').get(importId))return{duplicate:true,inserted:0};
  const insert=db.prepare(`INSERT OR IGNORE INTO stock_rows(id,${FIELDS.join(',')},details) VALUES(${Array(FIELDS.length+2).fill('?').join(',')})`),origin=db.prepare('INSERT OR IGNORE INTO origins VALUES(?,?,?,?)');
  let inserted=0;
  db.exec('BEGIN IMMEDIATE');
  try{
   db.prepare('INSERT INTO imports VALUES(?,?,?,?)').run(importId,now,JSON.stringify(manifest),JSON.stringify(issues));
   for(const row of rows){
    if(!day(row.day)||!Object.hasOwn(LABELS,row.source)||!row.storeId||!row.sku||!row.sourceFile||row.sourceRow===undefined)throw Error('Некорректная привязка исторической строки');
    if(row.observedAt!=null&&!Number.isFinite(Date.parse(row.observedAt)))throw Error('Некорректная дата наблюдения');
    for(const key of ['totalStock','available','inTransit','reserved'])if(row[key]!=null&&(!Number.isSafeInteger(row[key])||row[key]<0))throw Error('Некорректный остаток');
    const values=FIELDS.map(key=>row[key]??null),details=JSON.stringify(row.details||{}),id=hash(JSON.stringify(values)+'\n'+details);
    inserted+=Number(insert.run(id,...values,details).changes);
    origin.run(id,importId,String(row.sourceFile),String(row.sourceRow));
   }
   db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error}
  return {duplicate:false,inserted,provided:rows.length,issues:issues.length};
 }finally{db.close()}
}
function create({dbFile}){
 function read(fn){if(!fs.existsSync(dbFile))return null;const db=open(dbFile,true);try{return fn(db)}finally{db.close()}}
 function status(){return read(db=>{
  const counts=db.prepare('SELECT count(*) records,min(day) "from",max(day) "to" FROM stock_rows').get();
  const products=db.prepare('SELECT count(*) n FROM (SELECT DISTINCT storeId,sku FROM stock_rows)').get().n;
  const sources=db.prepare('SELECT source id,count(*) records,min(day) "from",max(day) "to" FROM stock_rows GROUP BY source ORDER BY source').all().map(x=>({...x,label:LABELS[x.id]}));
  const stores=db.prepare('SELECT storeId id,max(storeName) name FROM stock_rows GROUP BY storeId ORDER BY name').all();
  const last=db.prepare('SELECT imported_at FROM imports ORDER BY imported_at DESC LIMIT 1').get();
  return {...counts,products,stores,sources,importedAt:last?.imported_at||null,limitations:LIMITATIONS};
 })||{records:0,products:0,stores:[],sources:[],from:null,to:null,importedAt:null,limitations:LIMITATIONS}}
 function scope(options={}){
  const source=options.source||'daily-total';if(!Object.hasOwn(LABELS,source))throw invalid('Выберите источник истории');
  for(const key of ['from','to'])if(options[key]&&!day(options[key]))throw invalid('Проверьте даты периода');
  if(options.from&&options.to&&options.from>options.to)throw invalid('Начало периода позже окончания');
  const clauses=['source=?'],values=[source];
  for(const [key,op] of [['store','='],['sku','='],['from','>='],['to','<=']])if(options[key]){
   const value=String(options[key]);if(value.length>100)throw invalid('Слишком длинный фильтр');
   clauses.push((key==='store'?'storeId':key==='from'||key==='to'?'day':key)+op+'?');values.push(value);
  }
  if(options.q){if(String(options.q).length>200)throw invalid('Слишком длинный поиск');const value='%'+String(options.q).replace(/[\\%_]/g,'\\$&')+'%';clauses.push("(name LIKE ? ESCAPE '\\' OR article LIKE ? ESCAPE '\\' OR sku LIKE ? ESCAPE '\\')");values.push(value,value,value)}
  return {source,sql:clauses.join(' AND '),values};
 }
 function report(options={}){
  const filter=scope(options),limit=options.limit==null?100:Number(options.limit),offset=options.offset==null?0:Number(options.offset);
  if(!Number.isSafeInteger(limit)||limit<1||limit>200||!Number.isSafeInteger(offset)||offset<0||offset>10000000)throw invalid('Некорректная страница истории');
  return read(db=>{
   const total=db.prepare('SELECT count(*) n FROM stock_rows WHERE '+filter.sql).get(...filter.values).n;
   const rows=db.prepare(`SELECT ${FIELDS.join(',')} FROM stock_rows WHERE ${filter.sql} ORDER BY day DESC,observedAt DESC,storeName,sku,warehouseId,id LIMIT ? OFFSET ?`).all(...filter.values,limit,offset).map(row=>({...row,sourceLabel:LABELS[row.source]}));
   return {rows,total,limit,offset,source:filter.source,from:options.from||null,to:options.to||null,limitations:LIMITATIONS};
  })||{rows:[],total:0,limit,offset,source:filter.source,limitations:LIMITATIONS};
 }
 function csv(options={}){
  const filter=scope(options),cell=value=>{let text=String(value??'');if(/^[\s]*[=+@-]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"'};
  return read(db=>{
   const head=['Дата записи','Дата наблюдения','Источник','ID магазина','Магазин','SKU','Артикул','Товар','Склад','ID склада','Кластер','Остаток источника','Доступно','В пути','Резерв','Качество данных'];
   const lines=[head.map(cell).join(';')];
   for(const row of db.prepare(`SELECT ${FIELDS.join(',')} FROM stock_rows WHERE ${filter.sql} ORDER BY day DESC,observedAt DESC,storeName,sku,warehouseId,id`).iterate(...filter.values))lines.push(FIELDS.map(key=>cell(key==='source'?LABELS[row.source]:row[key])).join(';'));
   return '\ufeff'+lines.join('\r\n');
  })||'\ufeffНет импортированной истории';
 }
 function handle(req,res,u){
  if(req.method!=='GET'||!['/api/stock-history/status','/api/stock-history/report','/api/stock-history/export'].includes(u.pathname))return false;
  try{
   const options=Object.fromEntries(u.searchParams);
   if(u.pathname.endsWith('/export')){const content=csv(options);res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="pult-stock-history.csv"','Cache-Control':'no-store'});res.end(content)}
   else{const value=u.pathname.endsWith('/status')?status():report(options);res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value))}
  }catch(error){res.writeHead(error.public?400:503,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({error:error.public?error.message:'История остатков временно недоступна.'}))}
  return true;
 }
 return {status,report,csv,handle};
}
module.exports={create,ingest,LABELS,LIMITATIONS};
