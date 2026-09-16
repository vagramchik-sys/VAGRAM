(function(root){'use strict';
 const id=p=>String(p.storeId)+':'+String(p.sku);
 function build(report){
  const complete=report.coverage?.finance===true;
  const products=(complete?report.products:[]).map(p=>({...p,focusId:id(p),abc:'—',share:0,signals:[]}));
  const positive=products.filter(p=>p.realized>0).sort((a,b)=>b.realized-a.realized||a.focusId.localeCompare(b.focusId));
  const total=positive.reduce((v,p)=>v+Math.round(p.realized*100),0);let accumulated=0;
  for(const p of positive){p.abc=accumulated<total*.8?'A':accumulated<total*.95?'B':'C';p.share=Math.round(p.realized*100)/total*100;accumulated+=Math.round(p.realized*100)}
  for(const p of products){
   if(!p.archived&&p.key&&p.realized>0){if(p.quantity===0)p.signals.push('stockout');if(!(p.cost>0))p.signals.push('cost')}
   if(p.net<0)p.signals.push('negative');
   if(p.realized>0&&p.logistics/p.realized>=.3)p.signals.push('logistics');
  }
  const alerts=Object.fromEntries(['stockout','cost','negative','logistics'].map(k=>[k,complete?products.filter(p=>p.signals.includes(k)).length:null]));
  const groups=['A','B','C'].map(group=>{const rows=positive.filter(p=>p.abc===group);return {group,count:rows.length,amount:rows.reduce((n,p)=>n+p.realized,0),share:rows.reduce((n,p)=>n+p.share,0)}});
  const stores=(report.stores||[]).map(s=>({...s,share:null,per100:s.complete&&s.realized>0?Object.fromEntries(['commission','logistics','ads','net'].map(k=>[k,s[k]/s.realized*100])):null}));
  const storeTotal=complete&&stores.every(s=>s.complete&&s.realized>=0)?stores.reduce((n,s)=>n+s.realized,0):0;
  if(storeTotal>0)for(const s of stores)s.share=s.realized/storeTotal*100;
  stores.sort((a,b)=>(b.complete?b.realized:-Infinity)-(a.complete?a.realized:-Infinity));
  return {complete,products,alerts,groups,stores,positiveRealized:total/100,top10Share:positive.slice(0,10).reduce((v,p)=>v+p.share,0)};
 }
 function filter(products,{query='',filter='',sort='realized',favorites=new Set()}){
  const q=query.trim().toLocaleLowerCase('ru-RU');
  return products.filter(p=>(!q||[p.name,p.offer_id,p.sku,p.storeName].join(' ').toLocaleLowerCase('ru-RU').includes(q))&&(!filter||(filter==='favorites'?favorites.has(p.focusId):['A','B','C'].includes(filter)?p.abc===filter:p.signals.includes(filter)))).sort((a,b)=>sort==='netAsc'?a.net-b.net:sort==='stock'?(a.quantity??Infinity)-(b.quantity??Infinity)||b.realized-a.realized:b[sort]-a[sort]);
 }
 const api={build,filter,id};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.PultFocus=api;
})(typeof window==='undefined'?{}:window);
