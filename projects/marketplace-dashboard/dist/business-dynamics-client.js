(function(root){'use strict';
 function create({fetcher=root.fetch?.bind(root),now=Date.now,ttl=30000,timeout=12000}={}){
  const cache=new Map();
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
  return {read,invalidate(){for(const [key,item] of cache)if(!item.pending)cache.delete(key)}};
 }
 if(typeof module!=='undefined'&&module.exports)module.exports={create};else root.PultBusinessDynamicsClient={create};
})(typeof window==='undefined'?globalThis:window);
