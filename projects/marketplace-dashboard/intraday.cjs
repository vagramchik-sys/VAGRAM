'use strict';
const fs=require('node:fs'),path=require('node:path');
const {INTERVAL}=require('./refresh-policy.cjs');
const day=date=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
const covers=(s,d)=>s?.period?.from<=d&&s?.period?.to>=d;
function point(source,data){
  const at=source==='orders'?data?.updatedAt:data?.completedAt;
  if(!at||!Number.isFinite(Date.parse(at)))return null;
  const date=day(new Date(at));if(!covers(data,date)||source==='finance'&&!data.complete)return null;
  const values=source==='orders'?{orderedRevenue:0,orderedUnits:0}:{realized:0,net:0,ads:0};
  for(const row of data.daily||[])if(row.date===date){
    if(source==='orders'){values.orderedRevenue+=Math.round(row.revenue*100);values.orderedUnits+=row.units}
    else{values.realized+=row.values.realized||0;values.net+=row.values.net||0;values.ads-=row.values.ads||0}
  }
  if(!Object.values(values).every(Number.isFinite))return null;
  return {date,at:new Date(at).toISOString(),source,values};
}
// A combined point requires a new, sufficiently close observation from every selected store.
// A failed store never becomes a zero and cannot create a false aggregate change.
function combine(histories,source,date){
  const lists=histories.map(h=>h.filter(p=>p.date===date&&p.source===source).sort((a,b)=>a.at.localeCompare(b.at)));
  if(!lists.length||lists.some(a=>!a.length))return [];
  const indices=lists.map(()=>0),out=[];
  while(lists.every((list,i)=>indices[i]<list.length)){
    const end=Math.max(...lists.map((list,i)=>Date.parse(list[indices[i]].at)));
    for(let i=0;i<lists.length;i++)while(indices[i]+1<lists[i].length&&Date.parse(lists[i][indices[i]+1].at)<=end)indices[i]++;
    const selected=lists.map((list,i)=>list[indices[i]]),start=Math.min(...selected.map(p=>Date.parse(p.at)));
    if(end-start>INTERVAL){for(let i=0;i<lists.length;i++)if(Date.parse(selected[i].at)<end-INTERVAL)indices[i]++;continue}
    const values={};for(const p of selected)for(const [k,v] of Object.entries(p.values))values[k]=(values[k]||0)+v;
    for(const k of Object.keys(values))if(k!=='orderedUnits')values[k]/=100;
    out.push({at:new Date(end).toISOString(),sourceFromAt:new Date(start).toISOString(),...values});
    for(let i=0;i<indices.length;i++)indices[i]++;
  }
  return out;
}
function create({privateDir}){
  const file=id=>path.join(privateDir,'intraday-'+id+'.json');
  function read(id){return fs.existsSync(file(id))?JSON.parse(fs.readFileSync(file(id),'utf8')).points:[]}
  function capture(id,{orders,ledger}){
    const points=read(id);let changed=false;
    for(const [source,data] of [['orders',orders],['finance',ledger]]){
      const next=point(source,data);if(!next||points.some(p=>p.source===source&&p.at===next.at))continue;
      points.push(next);changed=true;
    }
    if(!changed)return;
    points.sort((a,b)=>a.at.localeCompare(b.at));const newest=Date.parse(points.at(-1).at),kept=points.filter(p=>newest-Date.parse(p.at)<=32*86400000);
    fs.writeFileSync(file(id)+'.tmp',JSON.stringify({version:1,points:kept}));fs.renameSync(file(id)+'.tmp',file(id));
  }
  function series(ids,date){const histories=ids.map(read);return {date,orders:combine(histories,'orders',date),finance:combine(histories,'finance',date),storeCount:ids.length,intervalMinutes:30}}
  return {capture,series};
}
module.exports={create,point,combine,day};
