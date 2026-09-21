'use strict';
const fs=require('node:fs'),path=require('node:path');
const {INTERVAL,ORDERS_INTERVAL}=require('./refresh-policy.cjs');
const day=date=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
const covers=(s,d)=>s?.period?.from<=d&&s?.period?.to>=d;
function point(source,data,products){
  const at=source==='orders'?data?.updatedAt:data?.completedAt;
  if(!at||!Number.isFinite(Date.parse(at)))return null;
  const date=day(new Date(at));if(!covers(data,date)||source==='finance'&&!data.complete)return null;
  const values=source==='orders'?{orderedRevenue:0,orderedUnits:0}:{realized:0,net:0,ads:0};
  for(const row of data.daily||[])if(row.date===date){
    if(source==='orders'){values.orderedRevenue+=Math.round(row.revenue*100);values.orderedUnits+=row.units}
    else{values.realized+=row.values.realized||0;values.net+=row.values.net||0;values.ads-=row.values.ads||0}
  }
  if(!Object.values(values).every(Number.isFinite))return null;
  let economy;
  if(source==='finance'&&Array.isArray(products)){const e=require('./economics.cjs').economics([{ledger:data,products}],{from:date,to:date});economy={profit:e.profit,cogs:e.cogs,realized:e.realized};}
  return {...(economy?{economy}:{}),date,at:new Date(at).toISOString(),source,values};
}
// A combined point requires a new, sufficiently close observation from every selected store.
// A failed store never becomes a zero and cannot create a false aggregate change.
function combine(histories,source,date){
  const interval=source==='orders'?ORDERS_INTERVAL:INTERVAL;
  const lists=histories.map(h=>h.filter(p=>p.date===date&&p.source===source).sort((a,b)=>a.at.localeCompare(b.at)));
  if(!lists.length||lists.some(a=>!a.length))return [];
  const indices=lists.map(()=>0),out=[];
  while(lists.every((list,i)=>indices[i]<list.length)){
    const end=Math.max(...lists.map((list,i)=>Date.parse(list[indices[i]].at)));
    for(let i=0;i<lists.length;i++)while(indices[i]+1<lists[i].length&&Date.parse(lists[i][indices[i]+1].at)<=end)indices[i]++;
    const selected=lists.map((list,i)=>list[indices[i]]),start=Math.min(...selected.map(p=>Date.parse(p.at)));
    if(end-start>interval){for(let i=0;i<lists.length;i++)if(Date.parse(selected[i].at)<end-interval)indices[i]++;continue}
    const values={};for(const p of selected)for(const [k,v] of Object.entries(p.values))values[k]=(values[k]||0)+v;
    for(const k of Object.keys(values))if(k!=='orderedUnits')values[k]/=100;
    if(source==='finance'){
      const known=selected.every(p=>p.economy&&['profit','cogs','realized'].every(k=>Number.isFinite(p.economy[k])));
      const total=k=>selected.reduce((n,p)=>n+Math.round(p.economy[k]*100),0);
      values.ourMargin=known&&total('realized')>0?total('profit')/total('realized')*100:null;
      values.ourRoi=known&&total('cogs')>0?total('profit')/total('cogs')*100:null;
    }
    out.push({at:new Date(end).toISOString(),sourceFromAt:new Date(start).toISOString(),...values});
    for(let i=0;i<indices.length;i++)indices[i]++;
  }
  return out;
}
function create({privateDir}){
  const file=id=>path.join(privateDir,'intraday-'+id+'.json');
  function read(id){return fs.existsSync(file(id))?JSON.parse(fs.readFileSync(file(id),'utf8')).points:[]}
  function capture(id,{orders,ledger,products}){
    const points=read(id);let changed=false;
    for(const [source,data] of [['orders',orders],['finance',ledger]]){
      const next=point(source,data,products);if(!next||points.some(p=>p.source===source&&p.at===next.at))continue;
      points.push(next);changed=true;
    }
    if(!changed)return;
    points.sort((a,b)=>a.at.localeCompare(b.at));
    fs.writeFileSync(file(id)+'.tmp',JSON.stringify({version:1,points}));fs.renameSync(file(id)+'.tmp',file(id));
  }
  function series(ids,date){const histories=ids.map(read);return {date,orders:combine(histories,'orders',date),finance:combine(histories,'finance',date),storeCount:ids.length,intervalMinutes:30,ordersIntervalMinutes:ORDERS_INTERVAL/60000,financeIntervalMinutes:30}}
  return {capture,series};
}
module.exports={create,point,combine,day};
