'use strict';
const within=(date,period)=>date>=period.from&&date<=period.to;
const sum=(rows,key)=>rows.reduce((total,row)=>total+(row.values[key]||0),0);
const money=cents=>cents===null?null:cents/100;
function economics(stores,period){
 const products=[],results=[];
 for(const store of stores){
  const ledger=store.ledger,covered=ledger?.version===3&&!!ledger.complete&&!ledger.foreignRecords&&!!ledger.period&&ledger.period.from<=period.from&&ledger.period.to>=period.to;
  const days=(ledger?.daily||[]).filter(row=>within(row.date,period)),bySku=new Map(),catalog=new Map();
  for(const product of store.products||[])for(const sku of new Set([product.sku,...(product.skus||[])].filter(Boolean).map(String))){
   if(!sku)continue;const key=String(sku),existing=catalog.get(key);
   if(!existing)catalog.set(key,{product,ambiguous:false});else if(existing.product!==product&&(!product.key||existing.product.key!==product.key))existing.ambiguous=true;
  }
  for(const day of ledger?.skuDaily||[])if(within(day.date,period)){
   const row=bySku.get(day.sku)||{sku:day.sku,values:{}};
   for(const [key,value] of Object.entries(day.values))row.values[key]=(row.values[key]||0)+value;
   bySku.set(day.sku,row);
  }
  const rows=[];
  for(const row of bySku.values()){
   const entry=catalog.get(String(row.sku)),product=entry?.product,values=row.values;
   const sold=values.soldUnits||0,returned=values.returnedUnits||0,netUnits=sold-returned,unknown=values.unknownUnitRows||0;
   const cost=product?.cost,roundedCost=Math.round(cost?.unitCost*100),unitCost=!entry?.ambiguous&&cost?.status==='filled'&&cost.currency==='RUB'&&Number.isSafeInteger(roundedCost)&&roundedCost>0&&Number.isSafeInteger(netUnits*roundedCost)?roundedCost:null;
   const needsCost=sold+returned>0||unknown>0,missingCost=needsCost&&unitCost===null;
   const complete=covered&&!unknown&&!missingCost,cogs=complete?(needsCost?netUnits*unitCost:0):null,net=values.net||0,realized=values.realized||0,profit=cogs===null?null:net-cogs;
   rows.push({storeId:store.id,storeName:store.name,sku:String(row.sku),key:product?.key||null,name:product?.name||'SKU '+row.sku,offerId:product?.offer_id||'',soldUnits:sold,returnedUnits:returned,netUnits,unknownUnitRows:unknown,salesRows:values.salesRows||0,missingCost,costAt:product?.costImportedAt||null,unitCost:money(unitCost),costComplete:complete,realized:money(realized),net:money(net),ozonDeductions:money(realized-net),cogs:money(cogs),profit:money(profit),margin:profit!==null&&realized>0?profit/realized*100:null,roi:profit!==null&&cogs>0?profit/cogs*100:null,perUnit:profit!==null&&netUnits>0?money(profit/netUnits):null});
  }
  const unmappedSaleRows=Math.max(0,sum(days,'salesRows')-rows.reduce((v,r)=>v+r.salesRows,0));
  const missingCostSkus=rows.filter(r=>r.missingCost).length,unknownUnitRows=sum(days,'unknownUnitRows'),complete=covered&&!unmappedSaleRows&&rows.every(r=>r.costComplete);
  const totalNet=sum(days,'net'),realized=sum(days,'realized'),skuNet=[...bySku.values()].reduce((v,r)=>v+(r.values.net||0),0);
  const known=rows.filter(r=>r.costComplete),knownCogs=known.reduce((v,r)=>v+Math.round(r.cogs*100),0),knownContribution=known.reduce((v,r)=>v+Math.round(r.profit*100),0);
  const cogs=complete?knownCogs:null,profit=cogs===null?null:totalNet-cogs;
  results.push({id:store.id,name:store.name,covered,complete,realized:covered?money(realized):null,net:covered?money(totalNet):null,ozonDeductions:covered?money(realized-totalNet):null,sharedNet:covered?money(totalNet-skuNet):null,cogs:money(cogs),knownCogs:covered?money(knownCogs):null,profit:money(profit),knownContribution:covered?money(knownContribution):null,margin:profit!==null&&realized>0?profit/realized*100:null,roi:profit!==null&&cogs>0?profit/cogs*100:null,soldUnits:sum(days,'soldUnits'),returnedUnits:sum(days,'returnedUnits'),unknownUnitRows,unmappedSaleRows,missingCostSkus,calculatedSkus:known.length,totalSkus:rows.length,costCoverage:rows.length?known.length/rows.length*100:null});
  products.push(...rows);
 }
 const covered=results.length>0&&results.every(r=>r.covered),complete=covered&&results.every(r=>r.complete);
 const total=key=>results.reduce((v,r)=>v+(r[key]||0),0),totalMoney=key=>results.reduce((v,r)=>v+Math.round((r[key]||0)*100),0)/100;
 const profit=complete?totalMoney('profit'):null,realized=covered?totalMoney('realized'):null,cogs=complete?totalMoney('cogs'):null;
 return {basis:'current-cost',quantityMethod:'exact-sale-amount-divided-by-unit-price',beforeTax:true,covered,complete,realized,net:covered?totalMoney('net'):null,ozonDeductions:covered?totalMoney('ozonDeductions'):null,sharedNet:covered?totalMoney('sharedNet'):null,cogs:complete?totalMoney('cogs'):null,knownCogs:covered?totalMoney('knownCogs'):null,profit,margin:profit!==null&&realized>0?profit/realized*100:null,roi:profit!==null&&cogs>0?profit/cogs*100:null,knownContribution:covered?totalMoney('knownContribution'):null,soldUnits:total('soldUnits'),returnedUnits:total('returnedUnits'),missingCostSkus:total('missingCostSkus'),unknownUnitRows:total('unknownUnitRows'),unmappedSaleRows:total('unmappedSaleRows'),calculatedSkus:total('calculatedSkus'),totalSkus:total('totalSkus'),stores:results,products};
}
module.exports={economics};
