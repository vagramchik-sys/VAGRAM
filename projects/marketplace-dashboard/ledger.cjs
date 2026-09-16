'use strict';
const fs=require('fs'),path=require('path');
const groups={
 ads:new Set(['BrandCommission','BrandPromotion','BrandShelf','ExternalPromotion','InternetSiteAdvertising','Marketing','PayPerClick','Promotion','Stencil','SocialMediaAdvertising','PushCampaign','PointsForReviews','ReviewsPin','SaleReview','FirstCustomerReview','AcceleratedReviewCollection','PremiumCashbackPromotion','PremiumMailingCommission']),
 acquiring:new Set(['Acquiring']),storage:new Set(['Placements','ReturnStorageInTheWarehouse','TemporaryPlacement','TemporaryPlacementsAgent','B2CTemporaryPlacement']),
 logistics:new Set(['BackwardShipment','Cancellation','ClientReturn','CrossDock','CrossDockPickUpCourierDelivery','Fulfillment','Drop-Off','Drop-Off Agent','LastMile','LastMileCourier','LastMilePickUpPoint','Logistic','PartialReturn','Pick-Up','PickUpCourierArrangement','PickUpCourierDelivery','PickUpPointReturnAcceptance','PreparingToReturn','QuantProcessingDrop','Replenishment','ReturnFlowLogistic','RfbsDomesticDelivery','RfbsGlobalDelivery','SellerReturns','Shipment','DeliveryToHandoverPlaceByOzon','InternationalLogisticDelta','OzonGlobalLogisticsDelivery','B2CLogistics','B2CBackwardLogistics','CourierPickUpByOzon','CourierPickUpReinvoice']),
 penalties:new Set(['DefectRate','DefectFineModeration','DefectFineProhibitedGoods','DefectFineCounterfeitGoods','DefectFineComplaint','DefectFineErrors','DefectFineShipmentDelayRate']),
 commission:new Set(['SaleCommission'])
};
function feeGroup(name){for(const [group,names] of Object.entries(groups))if(names.has(name))return group;return 'other'}
function cents(value){if(value===undefined||value===null||value==='')return 0;const n=Number(value);if(!Number.isFinite(n)||!Number.isSafeInteger(Math.round(n*100)))throw Error('Некорректная сумма в начислениях');return Math.round(n*100)}
function buildLedger(raw,types=[]){
 const names=new Map(types.map(t=>[t.id,t])),daily=new Map(),skuDaily=new Map(),fees=new Map(),currencies=new Set();
 let totalCents=0,records=0,residualRecords=0,foreignRecords=0;
 function row(map,key,defaults){if(!map.has(key))map.set(key,{...defaults,values:{}});return map.get(key)}
 function add(date,sku,metric,value,contributes=false){const d=row(daily,date,{date});d.values[metric]=(d.values[metric]||0)+value;if(sku){const p=row(skuDaily,date+':'+sku,{date,sku:String(sku)});p.values[metric]=(p.values[metric]||0)+value;if(contributes)p.values.net=(p.values.net||0)+value}}
 function fee(date,sku,typeId,amount,forced){const type=names.get(typeId),group=forced||feeGroup(type?.name),name=type?.description||'Услуга Ozon № '+typeId;add(date,sku,group,amount,true);const f=row(fees,date+':'+typeId+':'+group,{date,typeId,name,group});f.values.amount=(f.values.amount||0)+amount;f.count=(f.count||0)+1;}
 for(const op of raw.operations||[]){
   const currency=op.total_amount?.currency||'RUB';currencies.add(currency);if(currency!=='RUB'){foreignRecords++;continue}
   const date=op.date;if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw Error('Нет даты у начисления Ozon');
   const total=cents(op.total_amount?.amount),products=op.posting?.products||[];let parts=0;
   const amount=money=>{if(money?.currency&&money.currency!=='RUB')throw Error('Смешанные валюты внутри начисления Ozon');return cents(money?.amount)};
   add(date,null,'net',total);add(date,null,'records',1);totalCents+=total;records++;
   for(const p of products){
     const sale=amount(p.commission?.sale_amount),commission=amount(p.commission?.commission),delivery=amount(p.delivery?.total_accrued);
     add(date,p.sku,'realized',sale,true);add(date,p.sku,'commission',commission,true);add(date,p.sku,'bonus',amount(p.commission?.bonus));add(date,p.sku,'partners',amount(p.commission?.coinvestment));
     if(sale<0)add(date,p.sku,'reversal',-sale);
     let services=0;for(const service of p.delivery?.services||[]){const value=amount(service.accrued);fee(date,p.sku,service.type_id,value,'logistics');services+=value}
     if(delivery!==services)fee(date,p.sku,'delivery-other',delivery-services,'logistics');
     parts+=sale+commission+delivery;
   }
   for(const item of op.item_fees?.fees||[])for(const service of item.fees||[]){const value=amount(service.accrued);fee(date,item.sku,service.type_id,value);parts+=value}
   if(op.non_item_fee){const value=amount(op.non_item_fee.accrued);fee(date,null,op.non_item_fee.type_id,value);parts+=value}
   for(const service of op.container_fees?.fees||[]){const value=amount(service.accrued);fee(date,null,service.type_id,value);parts+=value}
   const residual=total-parts;if(residual){add(date,null,'unreconciled',residual);add(date,null,'unreconciledRecords',1);residualRecords++}
 }
 return {version:2,period:raw.period,completedAt:raw.completedAt,complete:raw.sections?.finance?.ok===true,records,totalCents,residualRecords,foreignRecords,currencies:[...currencies],daily:[...daily.values()],skuDaily:[...skuDaily.values()],fees:[...fees.values()]};
}
module.exports={buildLedger,feeGroup,cents};
module.exports.cache=function({privateDir,readTypes}){
 const memory=new Map();return function(id){const source=path.join(privateDir,'data-'+id+'.json');if(!fs.existsSync(source))return null;const types=readTypes(id)?.types||[];const stamp=fs.statSync(source).mtimeMs+':'+require('crypto').createHash('sha256').update(JSON.stringify(types)).digest('hex');if(memory.get(id)?.stamp===stamp)return memory.get(id).data;
 const file=path.join(privateDir,'ledger-'+id+'.json');if(fs.existsSync(file)){const saved=JSON.parse(fs.readFileSync(file,'utf8'));if(saved.stamp===stamp&&saved.data.version===2){memory.set(id,saved);return saved.data}}
 const data=buildLedger(JSON.parse(fs.readFileSync(source,'utf8')),types),saved={stamp,data};fs.writeFileSync(file+'.tmp',JSON.stringify(saved));fs.renameSync(file+'.tmp',file);memory.set(id,saved);return data;
 };
};
