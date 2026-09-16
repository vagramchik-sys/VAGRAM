const fs=require('fs'),path=require('path');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const hosts={content:'https://content-api.wildberries.ru',stocks:'https://seller-analytics-api.wildberries.ru',finance:'https://finance-api.wildberries.ru'};
async function request(key,kind,route,body){
  for(let attempt=0;attempt<4;attempt++){
    const r=await fetch(hosts[kind]+route,{method:'POST',headers:{Authorization:key,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});
    if((r.status===429||r.status>=500)&&attempt<3){await delay(Math.max(2000,Math.min(120000,Number(r.headers.get('X-Ratelimit-Retry')||r.headers.get('Retry-After')||60)*1000)));continue}
    if(!r.ok)throw Error('WB '+r.status+' · '+route);
    return r.status===204?[]:r.json();
  }
}
module.exports=function({stores,jobs,protect,save,privateDir}){
  async function connect(key){
    if(typeof key!=='string'||key.length<50||key.length>5000)throw Error('Проверьте токен WB');
    const id='wb-250069159';if(stores[id])throw Error('Этот магазин WB уже подключён');
    await request(key,'content','/content/v2/get/cards/list',{settings:{cursor:{limit:1},filter:{withPhoto:-1}}});
    stores[id]={name:'WB · СТАЛЬКРЕПЕЖ',market:'WB',clientId:id,key:await protect(key),connectedAt:new Date().toISOString()};save();void sync(id);return id;
  }
  async function sync(id){
    if(jobs.get(id)?.status==='running')return;
    const s=stores[id],job={status:'running',stage:'Товары WB',count:0,errors:[],startedAt:new Date().toISOString()};jobs.set(id,job);s.syncAttemptAt=job.startedAt;save();
    const data={store:s.name,market:'WB',clientId:id,startedAt:job.startedAt,products:[],stocks:[],operations:[],sections:{},period:{from:new Date(Date.now()-29*86400000).toISOString().slice(0,10),to:new Date().toISOString().slice(0,10)},financeAmountKnown:false};
    let key;
    async function section(name,fn){try{await fn();data.sections[name]={ok:true}}catch(e){const error=String(e.message).replaceAll(key,'[hidden]');data.sections[name]={ok:false,error};job.errors.push(error)}}
    try{
      key=await protect(s.key,true);
      await section('products',async()=>{let cursor={limit:100};const seen=new Set();for(let page=0;page<10000;page++){
        const v=await request(key,'content','/content/v2/get/cards/list',{settings:{cursor,filter:{withPhoto:-1}}});if(!Array.isArray(v.cards))throw Error('WB: неизвестный формат карточек');
        data.products.push(...v.cards.map(p=>({product_id:p.nmID,sku:p.nmID,name:p.title,offer_id:p.vendorCode,brand:p.brand,sizes:p.sizes})));job.count=data.products.length;
        if(v.cards.length<100)break;
        const next={limit:100,updatedAt:v.cursor?.updatedAt,nmID:v.cursor?.nmID},marker=JSON.stringify(next);if(!next.updatedAt||seen.has(marker)||page===9999)throw Error('WB: не все страницы товаров получены');seen.add(marker);cursor=next;await delay(650);
      }});
      job.stage='Остатки WB';await section('stocks',async()=>{data.stockRows=[];for(let offset=0;offset<10000000;offset+=250000){
        const v=await request(key,'stocks','/api/analytics/v1/stocks-report/wb-warehouses',{nmIds:[],chrtIds:[],limit:250000,offset});
        const rows=Array.isArray(v)?v:v.data?.items||v.data||v.items;if(!Array.isArray(rows))throw Error('WB: неизвестный формат остатков');for(const row of rows)data.stockRows.push(row);if(rows.length<250000)break;await delay(21000);
      }
      const byId=new Map();for(const r of data.stockRows){const id=String(r.nmId??r.nmID);if(!byId.has(id))byId.set(id,{product_id:id,stocks:[]});if(r.quantity===undefined)throw Error('WB: требуется проверка поля количества');byId.get(id).stocks.push({present:r.quantity,warehouse:r.warehouseName})}data.stocks=[...byId.values()];});
      job.stage='Финансовые отчёты WB';await section('finance',async()=>{let rrdId=0;const seen=new Set();for(let page=0;page<1000;page++){
        const v=await request(key,'finance','/api/finance/v1/sales-reports/detailed',{dateFrom:data.period.from,dateTo:data.period.to,limit:100000,rrdId,period:'daily',fields:['rrdId','reportId','currency','nmId','title','vendorCode','docTypeName','sellerOperName','quantity','retailAmount','forPay','deliveryService','penalty','additionalPayment','paidStorage','deduction','paidAcceptance','saleDt','rrDate']});
        const rows=Array.isArray(v)?v:v.data||v.rows;if(!Array.isArray(rows))throw Error('WB: неизвестный формат финансов');for(const row of rows)data.operations.push(row);job.count=data.operations.length;
        if(!rows.length)break;const next=rows.at(-1).rrdId;if(next===undefined||seen.has(String(next))||page===999)throw Error('WB: требуется проверка страниц финансов');seen.add(String(next));rrdId=next;await delay(61000);
      }});
      data.completedAt=new Date().toISOString();const file=path.join(privateDir,'data-'+id+'.json');fs.writeFileSync(file+'.tmp',JSON.stringify(data));fs.renameSync(file+'.tmp',file);s.updatedAt=data.completedAt;save();job.status=job.errors.length?'partial':'done';job.stage=job.errors.length?'Часть разделов требует проверки':'Готово';
    }catch(e){job.status='error';job.stage='Не удалось завершить импорт WB'}finally{key=null;job.finishedAt=new Date().toISOString()}
  }
  return {connect,sync};
};
