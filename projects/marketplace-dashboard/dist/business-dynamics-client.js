(function(root){'use strict';
 function categoryScope({allStores=[],visibleStores=[],market='all',store=''}){
  const all=[...new Map(allStores.map(row=>[String(row.id),row])).values()];
  const visible=[...new Map(visibleStores.map(row=>[String(row.id),row])).values()];
  if(!visible.length||visible.some(row=>!all.some(item=>String(item.id)===String(row.id))))return null;
  const same=(left,right)=>left.length===right.length&&left.every(row=>right.some(item=>String(item.id)===String(row.id)));
  if(same(visible,all))return {market,store};
  if(visible.length===1)return {market:visible[0].market,store:String(visible[0].id)};
  const selectedMarket=visible[0].market;
  if(visible.every(row=>row.market===selectedMarket)&&same(visible,all.filter(row=>row.market===selectedMarket)))return {market:selectedMarket,store:''};
  return null;
 }
 function create({fetcher=root.fetch?.bind(root),now=Date.now,ttl=30000,timeout=12000}={}){
  const cache=new Map(),categoriesCache=new Map();
  function read({date,market='all',store=''}){
   if(market==='Wildberries')market='WB';
   const query=new URLSearchParams({date,market:market||'all'});if(store)query.set('store',store);
   const key=query.toString(),old=cache.get(key);if(old&&(old.pending||old.expires>now()))return old.promise;
   const controller=new AbortController(),entry={pending:true,expires:0};
   let timer;
   entry.promise=Promise.race([Promise.resolve().then(()=>fetcher('/api/business-dynamics?'+key,{signal:controller.signal})).then(async response=>{const body=await response.json();if(!response.ok)throw Error(body.error||'Не удалось загрузить динамику');if(body.version!==1||!Array.isArray(body.stores))throw Error('Сервер вернул неподдерживаемый формат динамики');return body}),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('Сервер не ответил вовремя. Повторите запрос.'))},timeout)})]).then(value=>{entry.pending=false;entry.expires=now()+ttl;return value}).catch(error=>{if(cache.get(key)===entry)cache.delete(key);throw error}).finally(()=>clearTimeout(timer));
   cache.set(key,entry);if(cache.size>8)for(const [id,item] of cache){if(!item.pending&&id!==key){cache.delete(id);break}}
   return entry.promise;
  }
  function readCategories({date,market='all',store=''}){
   if(market==='Wildberries')market='WB';
   const query=new URLSearchParams({date,market:market||'all'});if(store)query.set('store',store);
   const key=query.toString(),old=categoriesCache.get(key);if(old&&(old.pending||old.expires>now()))return old.promise;
   const controller=new AbortController(),entry={pending:true,expires:0};let timer;
   entry.promise=Promise.race([Promise.resolve().then(()=>fetcher('/api/business-dynamics/categories?'+key,{signal:controller.signal})).then(async response=>{const body=await response.json();if(!response.ok)throw Error(body.error||'Не удалось загрузить категории');if(body.date!==date||!Array.isArray(body.rows))throw Error('Сервер вернул неподдерживаемый формат категорий');return body}),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('Категории не загрузились вовремя. Повторите запрос.'))},timeout)})]).then(value=>{entry.pending=false;entry.expires=now()+ttl;return value}).catch(error=>{if(categoriesCache.get(key)===entry)categoriesCache.delete(key);throw error}).finally(()=>clearTimeout(timer));
   categoriesCache.set(key,entry);if(categoriesCache.size>8)for(const [id,item] of categoriesCache){if(!item.pending&&id!==key){categoriesCache.delete(id);break}}
   return entry.promise;
  }
  return {read,readCategories,invalidate(){for(const collection of [cache,categoriesCache])for(const [key,item] of collection)if(!item.pending)collection.delete(key)}};
 }
 if(typeof module!=='undefined'&&module.exports)module.exports={create,categoryScope};else root.PultBusinessDynamicsClient={create,categoryScope};
})(typeof window==='undefined'?globalThis:window);
