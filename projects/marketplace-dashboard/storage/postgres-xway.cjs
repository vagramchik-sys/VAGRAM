'use strict';
const {acquireMutationFence}=require('./postgres-write-fence.cjs');

// Locally verified observations, one fact per SQL row. No XWAY credentials or
// outbound requests belong in this repository. Runtime exposes only read().
const SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS pult_xway;
CREATE TABLE IF NOT EXISTS pult_xway.accounts (
 key text PRIMARY KEY, marketplace text NOT NULL CHECK(marketplace IN ('Ozon','WB')),
 name text NOT NULL, connection_status text, tariff text,
 products_count integer CHECK(products_count>=0), campaigns_count integer CHECK(campaigns_count>=0),
 connected_products_count integer CHECK(connected_products_count>=0), product_limit integer CHECK(product_limit>=0),
 source_url text NOT NULL, observed_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS pult_xway.settings (
 account_key text NOT NULL REFERENCES pult_xway.accounts(key), key text NOT NULL,
 label text NOT NULL, value text NOT NULL, source_url text NOT NULL, observed_at timestamptz NOT NULL,
 PRIMARY KEY(account_key,key)
);
CREATE TABLE IF NOT EXISTS pult_xway.campaigns (
 account_key text NOT NULL REFERENCES pult_xway.accounts(key), key text NOT NULL, name text NOT NULL,
 status text, type text, strategy text, schedule text,
 products_count integer CHECK(products_count>=0), products_total_count integer CHECK(products_total_count>=0),
 budget numeric CHECK(budget>=0), spend numeric CHECK(spend>=0), orders integer CHECK(orders>=0), revenue numeric CHECK(revenue>=0), drr numeric CHECK(drr>=0),
 impressions bigint CHECK(impressions>=0), clicks bigint CHECK(clicks>=0), carts bigint CHECK(carts>=0), ctr numeric CHECK(ctr>=0), click_to_order numeric CHECK(click_to_order>=0),
 period_from date, period_to date, source_url text NOT NULL, observed_at timestamptz NOT NULL,
 PRIMARY KEY(account_key,key), CHECK(period_from IS NULL OR period_to IS NULL OR period_from<=period_to)
);
REVOKE ALL ON SCHEMA pult_xway FROM PUBLIC;
CREATE TABLE IF NOT EXISTS pult_xway.products (
 account_key text NOT NULL REFERENCES pult_xway.accounts(key), key text NOT NULL, name text NOT NULL,
 sku text, article text, stock integer CHECK(stock>=0), ordered_units integer CHECK(ordered_units>=0), ordered_revenue numeric CHECK(ordered_revenue>=0),
 impressions bigint CHECK(impressions>=0), clicks bigint CHECK(clicks>=0), carts bigint CHECK(carts>=0), orders integer CHECK(orders>=0),
 revenue numeric CHECK(revenue>=0), spend numeric CHECK(spend>=0), drr numeric CHECK(drr>=0), total_drr numeric CHECK(total_drr>=0), ctr numeric CHECK(ctr>=0), click_to_order numeric CHECK(click_to_order>=0),
 period_from date, period_to date, source_url text NOT NULL, observed_at timestamptz NOT NULL,
 PRIMARY KEY(account_key,key), CHECK(period_from IS NULL OR period_to IS NULL OR period_from<=period_to)
);
REVOKE ALL ON ALL TABLES IN SCHEMA pult_xway FROM PUBLIC;
`;
const fields = {
 accounts:['key','marketplace','name','connectionStatus','tariff','productsCount','campaignsCount','connectedProductsCount','productLimit','sourceUrl','observedAt'],
 settings:['accountKey','key','label','value','sourceUrl','observedAt'],
 campaigns:['accountKey','key','name','status','type','strategy','schedule','productsCount','productsTotalCount','budget','spend','orders','revenue','drr','impressions','clicks','carts','ctr','clickToOrder','periodFrom','periodTo','sourceUrl','observedAt'],
 products:['accountKey','key','name','sku','article','stock','orderedUnits','orderedRevenue','impressions','clicks','carts','orders','revenue','spend','drr','totalDrr','ctr','clickToOrder','periodFrom','periodTo','sourceUrl','observedAt']
};
const counts = new Set(['productsCount','campaignsCount','connectedProductsCount','productLimit','productsTotalCount','orders','impressions','clicks','carts','stock','orderedUnits']);
const decimals = new Set(['budget','spend','revenue','drr','ctr','clickToOrder','totalDrr','orderedRevenue']);
const column = key => key.replace(/[A-Z]/gu, char=>'_'+char.toLowerCase());
const fail = code => {throw Object.assign(Error(code),{code});};
function normalize(input) {
 if(!input||input.version!==1||Object.keys(input).some(key=>!['version',...Object.keys(fields)].includes(key)))fail('INVALID_XWAY_IMPORT');
 const result={};
 for(const [table,names] of Object.entries(fields)){
  const source=table==='products'&&input[table]===undefined?[]:input[table];
  if(!Array.isArray(source)||source.length>10000)fail('INVALID_XWAY_IMPORT');
  const seen=new Set();
  result[table]=source.map(row=>{
   if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).some(key=>!names.includes(key)))fail('INVALID_XWAY_IMPORT');
   const record={};
   for(const key of names){
    const value=row[key]??null;
    if(counts.has(key)){if(value!==null&&(!Number.isSafeInteger(value)||value<0))fail('INVALID_XWAY_IMPORT');}
    else if(decimals.has(key)){if(value!==null&&(typeof value!=='number'||!Number.isFinite(value)||value<0))fail('INVALID_XWAY_IMPORT');}
    else if(value!==null&&(typeof value!=='string'||value.length>2000||/[\u0000-\u0008\u000b-\u001f]/u.test(value)))fail('INVALID_XWAY_IMPORT');
    record[key]=value;
   }
   for(const key of ['key','sourceUrl','observedAt',...(table==='accounts'?['name','marketplace']:table==='settings'?['accountKey','label','value']:['accountKey','name'])])if(typeof record[key]!=='string'||!record[key].trim())fail('INVALID_XWAY_IMPORT');
   if(!/^[A-Za-z0-9_.:-]{1,160}$/u.test(record.key)||record.accountKey&&!/^[A-Za-z0-9_.:-]{1,160}$/u.test(record.accountKey))fail('INVALID_XWAY_IMPORT');
   if(table==='accounts'&&!['Ozon','WB'].includes(record.marketplace))fail('INVALID_XWAY_IMPORT');
   if(!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(record.observedAt)||!Number.isFinite(Date.parse(record.observedAt)))fail('INVALID_XWAY_IMPORT');
   let url;try{url=new URL(record.sourceUrl);}catch{fail('INVALID_XWAY_IMPORT');}
   if(url.protocol!=='https:'||url.hostname!=='am.xway.ru'||url.username||url.password||url.search||url.hash)fail('INVALID_XWAY_IMPORT');
   for(const key of ['periodFrom','periodTo'])if(record[key]!=null&&(!/^\d{4}-\d{2}-\d{2}$/u.test(record[key])||!Number.isFinite(Date.parse(record[key]))||new Date(record[key]).toISOString().slice(0,10)!==record[key]))fail('INVALID_XWAY_IMPORT');
   if(record.periodFrom&&record.periodTo&&record.periodFrom>record.periodTo)fail('INVALID_XWAY_IMPORT');
   if(record.orders===0&&record.drr===0)record.drr=null;
   if(record.orderedUnits===0&&record.totalDrr===0)record.totalDrr=null;
   const identity=JSON.stringify([record.accountKey??'',record.key]);if(seen.has(identity))fail('INVALID_XWAY_IMPORT');seen.add(identity);
   return record;
  });
 }
 return result;
}
async function importObservations(pool,input){
 const records=normalize(input),client=await pool.connect();
 try{
  await client.query('BEGIN');
  await acquireMutationFence(client);
  for(const [table,rows] of Object.entries(records))for(const row of rows){
   const names=fields[table],keys=table==='accounts'?['key']:['account_key','key'],columns=names.map(column);
   const result=await client.query(`INSERT INTO pult_xway.${table} (${columns.join(',')}) VALUES (${names.map((_,i)=>'$'+(i+1)).join(',')}) ON CONFLICT (${keys.join(',')}) DO UPDATE SET ${columns.filter(name=>!keys.includes(name)).map(name=>`${name}=EXCLUDED.${name}`).join(',')} WHERE ${table}.observed_at<=EXCLUDED.observed_at RETURNING key`,names.map(name=>row[name]));
   if(!result.rowCount)fail('STALE_XWAY_OBSERVATION');
  }
  await client.query('COMMIT');return Object.fromEntries(Object.entries(records).map(([key,rows])=>[key,rows.length]));
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
function createXwayReader({pool}){
 if(!pool?.connect)throw TypeError('SQL read pool required');
 async function read(){
  const client=await pool.connect();
  try{
   await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const result={mode:'verified-observations',accounts:[],settings:[],campaigns:[],products:[]};
   for(const [table,names] of Object.entries(fields)){
    const rows=await client.query(`SELECT ${names.map(name=>`${name==='periodFrom'||name==='periodTo'?column(name)+'::text':column(name)} AS "${name}"`).join(',')} FROM pult_xway.${table} ORDER BY ${table==='accounts'?'key':'account_key,key'}`);
    result[table]=rows.rows.map(row=>{for(const name of names)if(counts.has(name)||decimals.has(name))row[name]=row[name]===null?null:Number(row[name]);return row;});
   }
   await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
 }
 return Object.freeze({read});
}
function createXwayHandler({reader}){
 return Object.freeze({async handle(req,res,url){
  if(url.pathname!=='/api/xway')return false;
  const reply=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  if(req.method!=='GET'){reply(405,{error:'Раздел XWAY доступен только для чтения.'});return true;}
  try{reply(200,await reader.read());}catch{reply(503,{error:'Проверенные данные XWAY временно недоступны.'});}return true;
 }});
}
module.exports={SCHEMA_SQL,normalize,importObservations,createXwayReader,createXwayHandler};
