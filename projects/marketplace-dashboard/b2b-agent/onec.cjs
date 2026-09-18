'use strict';

// Contract for an internal 1C HTTP service. Not a claim that this service already exists.
class OneCClient {
  constructor({baseUrl,token='',fetchImpl=fetch}) {
    const url=new URL(baseUrl);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('Неверный адрес сервиса 1С');
    this.base=url.href.replace(/\/$/,'');this.token=token;this.fetch=fetchImpl;
  }
  async facts(items, {dealId,companyId=null,contactId=null} = {}) {
    if(!/^\d+$/.test(String(dealId)))throw Error('Нужна привязка запроса 1С к сделке');
    let response;
    try {response=await this.fetch(this.base+'/quote',{method:'POST',headers:{'content-type':'application/json',...(this.token?{authorization:'Bearer '+this.token}:{})},signal:AbortSignal.timeout(20000),redirect:'error',body:JSON.stringify({crm:{dealId:String(dealId),companyId,contactId},items:items.map(({article,quantity})=>({article,quantity}))})});}catch{throw Error('Сервис 1С недоступен');}
    if(!response.ok)throw Error('1С не подтвердила данные для предложения');
    let data;try{data=await response.json();}catch{throw Error('Некорректный ответ сервиса 1С');}
    if(!Array.isArray(data.items)||data.items.length>100)throw Error('Неподдерживаемый формат ответа 1С');
    return data.items.map(x=>({...x,source:'1C'}));
  }
}
module.exports={OneCClient};
