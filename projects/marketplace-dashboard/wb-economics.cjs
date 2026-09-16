'use strict';
const fs=require('node:fs'),path=require('node:path');
function period(from,to){
 const valid=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d;
 if(!valid(from)||!valid(to)||from>to||(Date.parse(to)-Date.parse(from))/86400000>=90)throw Error('Проверьте даты периода WB (не больше 90 дней)');
 return {from,to};
}
function create({stores,privateDir,trueStats}){
 const cache=new Map();
 async function read({from,to,storeId}={}){
  const dates=period(from,to),selected=Object.entries(stores).filter(([id,s])=>s.market==='WB'&&(!storeId||id===storeId));
  if(selected.length!==1)throw Error('Выберите один подключённый магазин WB');
  const [id,s]=selected[0],file=path.join(privateDir,'data-'+id+'.json');
  let direct=null;
  if(fs.existsSync(file)){
   const key=JSON.stringify([id,fs.statSync(file).mtimeMs,from,to]);
   if(!cache.has(key)){cache.set(key,require('./wb-report.cjs').summarize(JSON.parse(fs.readFileSync(file,'utf8')),dates));while(cache.size>10)cache.delete(cache.keys().next().value)}
   direct=cache.get(key);
  }
  let link=null;try{link=JSON.parse(fs.readFileSync(path.join(privateDir,'truestats-wb-link.json'),'utf8').replace(/^\uFEFF/,''))}catch{}
  const linked=link?.storeId===id&&Number.isSafeInteger(link.accountId)&&link.accountId>0;
  const truestats=linked?await trueStats.compare({period:dates,market:'WB',stores:[{id,name:s.name,market:'WB',trueStatsAccountId:link.accountId}]}):{status:'unavailable',reason:'Магазин WB ещё не сопоставлен с кабинетом TrueStats.',metrics:{}};
  return {store:{id,name:s.name},period:dates,direct,truestats,refresh:{intervalMinutes:30},job:s.job||null};
 }
 return {read};
}
module.exports={create,period};
