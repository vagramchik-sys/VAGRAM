'use strict';
const {PriceAdsError}=require('./postgres-price-ads-optimizer.cjs');
const ROUTES=new Set(['/api/price-ads/status','/api/price-ads/data','/api/price-ads/performance/connect','/api/price-ads/performance/disconnect','/api/price-ads/settings','/api/price-ads/refresh','/api/price-ads/run']);
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
function createPriceAdsRoutes({optimizer,authorize}={}){
 if(!optimizer||typeof authorize!=='function')throw new TypeError('optimizer and authorize are required');
 const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value))};
 async function body(req){const chunks=[];let size=0;for await(const p of req){const c=Buffer.from(p);size+=c.length;if(size>256*1024)throw new PriceAdsError('INVALID_ARGUMENT','Слишком большой запрос.',413);chunks.push(c)}let v;try{v=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}')}catch{throw new PriceAdsError('INVALID_ARGUMENT','Некорректный JSON.')}if(!object(v))throw new PriceAdsError('INVALID_ARGUMENT','Некорректный запрос.');return v}
 const meta=(req,v)=>({commandId:req.headers['x-pult-command-id']??v.commandId,timestamp:req.headers['x-pult-command-timestamp']??v.timestamp});
 const store=(url,v)=>{const id=String(v?.storeId??url.searchParams.get('store')??'');if(!/^[0-9]{1,32}$/u.test(id))throw new PriceAdsError('INVALID_ARGUMENT','Выберите магазин Ozon.');return id};
 async function handle(req,res,url){
  if(!ROUTES.has(url.pathname))return false;
  try{
   if(await authorize(req,url)!==true)throw new PriceAdsError('FORBIDDEN','Доступ запрещён.',403);
   if(req.method==='GET'){const id=store(url);if(url.pathname==='/api/price-ads/status')json(res,200,await optimizer.status(id));else if(url.pathname==='/api/price-ads/data')json(res,200,await optimizer.data(id));else json(res,405,{error:'Метод не поддерживается.'});return true}
   if(req.method!=='POST'){json(res,405,{error:'Метод не поддерживается.'});return true}
   const v=await body(req),id=store(url,v);
   if(url.pathname==='/api/price-ads/performance/connect')json(res,200,await optimizer.connect(id,v,meta(req,v)));
   else if(url.pathname==='/api/price-ads/performance/disconnect')json(res,200,await optimizer.disconnect(id,meta(req,v)));
   else if(url.pathname==='/api/price-ads/settings')json(res,200,await optimizer.saveSettings(id,v.config||v,meta(req,v)));
   else if(url.pathname==='/api/price-ads/refresh')json(res,200,await optimizer.refresh(id));
   else if(url.pathname==='/api/price-ads/run')json(res,200,await optimizer.refreshAndRun(id,'manual'));
   else json(res,404,{error:'Не найдено.'});
  }catch(e){if(e instanceof PriceAdsError||e?.public===true)json(res,e.status||400,{error:e.message,code:e.code||'ERROR'});else if(['REVISION_CONFLICT','COMMAND_ID_REUSED'].includes(e?.code))json(res,409,{error:'Данные уже изменились. Обновите страницу.',code:e.code});else json(res,503,{error:'Модуль цен и рекламы временно недоступен.',code:'UNAVAILABLE'})}
  return true;
 }
 return Object.freeze({name:'price-ads',handle});
}
module.exports={createPriceAdsRoutes,ROUTES};
