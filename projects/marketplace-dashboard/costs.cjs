// Ozon Seller API: price.net_price is the seller-entered current unit cost.
module.exports=async function loadCosts(store,key,api){
  let cursor='';const seen=new Set(),items=[];
  for(let page=0;page<1000;page++){
    const r=await api(store,key,'/v5/product/info/prices',{filter:{visibility:'ALL'},cursor,limit:1000});
    if(!Array.isArray(r.items))throw Error('Ozon: неизвестный формат себестоимости');
    for(const p of r.items){const raw=p.price?.net_price;const value=raw===null||raw===undefined||raw===''?null:Number(raw);const number=v=>v===null||v===undefined||v===''||!Number.isFinite(Number(v))?null:Number(v);items.push({product_id:String(p.product_id),offer_id:p.offer_id,unitCost:Number.isFinite(value)?value:null,status:Number.isFinite(value)&&value>0?'filled':value===0?'zero':'missing',currency:p.price?.currency_code||null,pricing:{price:number(p.price?.price),minPrice:number(p.price?.min_price),oldPrice:number(p.price?.old_price),sellerPrice:number(p.price?.marketing_seller_price),currency:p.price?.currency_code||null}});}
    if(!r.items.length||items.length>=Number(r.total_items??r.total)||!r.cursor)return {source:'/v5/product/info/prices · price.net_price',importedAt:new Date().toISOString(),items};
    if(seen.has(r.cursor))throw Error('Ozon повторил страницу себестоимости');seen.add(r.cursor);cursor=r.cursor;await new Promise(r=>setTimeout(r,1100));
  }
  throw Error('Ozon: не все страницы себестоимости получены');
};
