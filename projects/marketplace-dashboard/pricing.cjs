'use strict';
const fs=require('fs'),path=require('path');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const number=v=>v===null||v===undefined||v===''||!Number.isFinite(Number(v))?null:Number(v);
async function loadWbPrices(key,fetcher=fetch){
  const items=[],seen=new Set();
  for(let offset=0;offset<1000000;offset+=1000){
    let response;
    for(let attempt=0;attempt<3;attempt++){
      response=await fetcher('https://discounts-prices-api.wildberries.ru/api/v2/list/goods/filter?limit=1000&offset='+offset,{headers:{Authorization:key},signal:AbortSignal.timeout(45000)});
      if((response.status===429||response.status>=500)&&attempt<2){await pause(Math.min(60000,Math.max(1000,Number(response.headers.get('Retry-After')||6)*1000)));continue}break;
    }
    if(!response.ok)throw Error('WB: цены недоступны, код '+response.status);
    const result=await response.json(),goods=result.data?.listGoods;
    if(result.error||!Array.isArray(goods))throw Error('WB: неизвестный формат цен');
    if(!goods.length)return {source:'WB · /api/v2/list/goods/filter',importedAt:new Date().toISOString(),items};
    for(const product of goods){
      const id=String(product.nmID);if(seen.has(id))throw Error('WB: повтор страницы цен');seen.add(id);
      const sizes=(product.sizes||[]).map(s=>({id:String(s.sizeID),name:s.techSizeName,price:number(s.price),discountedPrice:number(s.discountedPrice)}));
      const unique=[...new Set(sizes.map(s=>s.price))];
      items.push({product_id:id,pricing:{price:unique.length===1?unique[0]:null,discount:number(product.discount),currency:product.currencyIsoCode4217||null,sizes,multiplePrices:unique.length>1,editableSizePrice:Boolean(product.editableSizePrice)}});
    }
    await pause(650);
  }
  throw Error('WB: не все страницы цен получены');
}
module.exports=function({stores,protect,api,privateDir,jobs}){
  const priceJobs=new Map();
  function save(file,data){fs.writeFileSync(file+'.tmp',JSON.stringify(data));fs.renameSync(file+'.tmp',file)}
  async function refresh(id){
    if(priceJobs.get(id)?.status==='running')return;
    const store=stores[id];if(!store)return;
    const job={status:'running',startedAt:new Date().toISOString()};priceJobs.set(id,job);
    let key;
    try{
      if(jobs.get(id)?.status==='running')throw Error('Дождитесь завершения полного импорта магазина');
      key=await protect(store.key,true);
      const result=store.market==='WB'?await loadWbPrices(key):await require('./costs.cjs')(store,key,api);
      save(path.join(privateDir,(store.market==='WB'?'prices-':'costs-')+id+'.json'),result);
      Object.assign(job,{status:'done',count:result.items.length,finishedAt:result.importedAt});
    }catch(e){Object.assign(job,{status:'error',error:key?String(e.message).replaceAll(key,'[hidden]'):e.message,finishedAt:new Date().toISOString()})}finally{key=null}
  }
  return {refresh,status:()=>Object.fromEntries(priceJobs)};
};
module.exports.loadWbPrices=loadWbPrices;
