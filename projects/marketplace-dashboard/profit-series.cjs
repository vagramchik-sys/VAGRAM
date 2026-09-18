'use strict';
const fs=require('node:fs'),path=require('node:path');
const {daysInPeriod}=require('./truestats.cjs');
const moneySum=values=>values.reduce((sum,value)=>sum+Math.round(value*100),0)/100;
const WARNINGS=[
 'Чистая прибыль взята из управленческого отчёта TrueStats после его себестоимости, рекламы, налогов и операционных расходов. Полнота внешних расходов и правильность налоговых настроек зависят от заполнения кабинета.',
 'График показывает прибыль за каждый завершённый день. Сегодняшние заказы обновляются отдельно: они ещё не означают полученную чистую прибыль.',
 'Общий показатель доступен только за дни, по которым есть данные всех выбранных магазинов. Пропуски не заменяются нулями.'
];
function aggregate(period,stores){
 const dates=daysInPeriod(period),daily=dates.map(date=>{
  const points=stores.map(store=>store.points.find(point=>point.date===date)),known=points.filter(point=>point?.status==='ready'&&Number.isFinite(point.profit)),complete=stores.length>0&&known.length===stores.length;
  return {date,profit:complete?moneySum(known.map(point=>point.profit)):null,status:complete?'ready':points.some(point=>point?.status==='pending')?'pending':'unavailable',complete,knownStores:known.length,totalStores:stores.length};
 });
 const complete=stores.length>0&&stores.every(store=>store.complete&&Number.isFinite(store.totalProfit))&&daily.every(point=>point.complete),known=daily.filter(point=>point.complete);
 return {daily,complete,totalProfit:complete?moneySum(stores.map(store=>store.totalProfit)):null,knownProfit:known.length?moneySum(known.map(point=>point.profit)):null,status:complete?'ready':stores.some(store=>store.points.some(point=>point.status==='ready'))?'partial':daily.some(point=>point.status==='pending')?'pending':'unavailable'};
}
function create({stores,privateDir,trueStats,now=()=>Date.now()}){
 if(!stores||!privateDir||typeof trueStats?.daily!=='function')throw Error('Profit series requires stores and TrueStats daily connector');
 async function read({from,to,storeId,market='all'}={}){
  const period={from,to},dates=daysInPeriod(period);
  if(!['all','Ozon','WB'].includes(market))throw Error('Выберите Ozon, WB или все маркетплейсы.');
  const selected=Object.entries(stores).map(([id,store])=>({id,name:store.name,market:store.market==='WB'?'WB':'Ozon'})).filter(store=>(!storeId||store.id===String(storeId))&&(market==='all'||store.market===market));
  if(!selected.length)throw Error('Выберите подключённые магазины для графика прибыли.');
  const ozonNames=selected.filter(store=>store.market==='Ozon').map(store=>store.name);
  if(new Set(ozonNames).size!==ozonNames.length)throw Error('Названия магазинов Ozon совпадают. Нужна однозначная привязка, чтобы не учесть прибыль дважды.');
  let wbLink=null;try{wbLink=JSON.parse(fs.readFileSync(path.join(privateDir,'truestats-wb-link.json'),'utf8').replace(/^\uFEFF/,''));}catch{}
  const rows=new Array(selected.length),sourceAccounts=new Set();let index=0;
  // Two stores at a time; never fan out a request per day (up to 90 days).
  await Promise.all(Array.from({length:Math.min(2,selected.length)},async()=>{
   while(index<selected.length){const i=index++,store=selected[i],linked=store.market!=='WB'||(wbLink?.storeId===store.id&&Number.isSafeInteger(wbLink.accountId)&&wbLink.accountId>0);
    let report;
    if(!linked){const reason='Магазин WB ещё не сопоставлен с кабинетом TrueStats.';report={status:'unavailable',reason,points:dates.map(date=>({date,profit:null,status:'unavailable',reason,tax:null,operatingExpenses:null})),totalProfit:null,knownProfit:null,complete:false,fetchedAt:null,readiness:null};}
    else report=await trueStats.daily({period,market:store.market,store:{...store,...(store.market==='WB'?{trueStatsAccountId:wbLink.accountId}:{})}});
    if(report.scopeVerified===true){
     if(!Number.isSafeInteger(report.accountId)||report.accountId<=0||sourceAccounts.has(report.accountId))throw Error('TrueStats сопоставил магазины неоднозначно. Общая прибыль не рассчитана, чтобы избежать двойного учёта.');
     sourceAccounts.add(report.accountId);
    }
    rows[i]={...store,status:report.status,reason:report.reason||null,points:report.points,totalProfit:report.totalProfit,knownProfit:report.knownProfit,complete:report.complete,readiness:report.readiness||null,fetchedAt:report.fetchedAt,scopeVerified:report.scopeVerified===true,reconciled:report.reconciled===true};
   }
  }));
  return {period,...aggregate(period,rows),source:'TrueStats API',mode:'management',granularity:'day',stores:rows,generatedAt:new Date(now()).toISOString(),refresh:{intervalMinutes:30},warnings:[...WARNINGS]};
 }
 return {read};
}
module.exports={create,aggregate};
