'use strict';

const MICRO=1_000_000;
const DEFAULT_SETTINGS=Object.freeze({
 priceStepPct:5.1,bidStepPct:7,competitiveBuffer:1.02,safetyFactor:0.85,
 targetProfitRub:30,targetProfitPct:3,externalReservePct:null,customerPriceTolerancePct:2,
 rollbackConversionDropPct:20,minObservationMinutes:60,minObservationClicks:20,
 minObservationOrders:3,minCoinvestPct:3,minStockUnits:5,staleMinutes:180,
 maxDailyAdSpendRub:null,maxPriceStepsPerDay:3,maxBidStepsPerDay:8
});
const finite=v=>v===null||v===undefined||v===''||!Number.isFinite(Number(v))?null:Number(v);
const positive=v=>{const n=finite(v);return n!==null&&n>0?n:null};
const round2=v=>Math.round((v+Number.EPSILON)*100)/100;
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
const pct=(a,b)=>b?(a/b-1)*100:null;
function fromMicros(v){const n=finite(v);return n===null?null:n/MICRO}
function toMicros(v){const n=finite(v);return n===null?null:String(Math.max(0,Math.round(n*MICRO)))}
function mergeSettings(value={}){
 const next={...DEFAULT_SETTINGS};
 for(const k of Object.keys(DEFAULT_SETTINGS))if(Object.hasOwn(value,k))next[k]=value[k];
 for(const k of ['priceStepPct','bidStepPct','competitiveBuffer','safetyFactor','targetProfitRub','targetProfitPct','customerPriceTolerancePct','rollbackConversionDropPct','minObservationMinutes','minObservationClicks','minObservationOrders','minCoinvestPct','minStockUnits','staleMinutes','maxPriceStepsPerDay','maxBidStepsPerDay']){
  const n=Number(next[k]);next[k]=Number.isFinite(n)&&n>=0?n:DEFAULT_SETTINGS[k];
 }
 next.priceStepPct=Math.max(5.1,next.priceStepPct);
 next.competitiveBuffer=clamp(next.competitiveBuffer,1,1.25);
 next.safetyFactor=clamp(next.safetyFactor,.1,1);
 if(next.externalReservePct!==null&&next.externalReservePct!==''){const n=Number(next.externalReservePct);next.externalReservePct=Number.isFinite(n)&&n>=0&&n<=60?n:null}else next.externalReservePct=null;
 if(next.maxDailyAdSpendRub!==null&&next.maxDailyAdSpendRub!==''){
  const n=Number(next.maxDailyAdSpendRub);next.maxDailyAdSpendRub=Number.isFinite(n)&&n>0?n:null;
 }else next.maxDailyAdSpendRub=null;
 return next;
}
function fresh(at,now,minutes){const age=Date.parse(now)-Date.parse(at||'');return Number.isFinite(age)&&age>=0&&age<=minutes*60000}
function targetProfit(price,s){return Math.max(s.targetProfitRub,(positive(price)||0)*s.targetProfitPct/100)}
function financeModel(row,s){
 const stats=row.stats||{},e=row.economics||{},orders=finite(stats.orders)||0,clicks=finite(stats.clicks)||0;
 const price=positive(row.customerPrice)||positive(stats.price)||positive(row.sellerPrice);
 const rawBefore=finite(e.contributionBeforeAdsPerOrder),rawProfit=finite(e.profitAfterAdsPerOrder),target=price?targetProfit(price,s):null;
 const reserve=price&&s.externalReservePct!==null?price*s.externalReservePct/100:0,before=rawBefore===null?null:rawBefore-reserve,profit=rawProfit===null?null:rawProfit-reserve;
 const maxPerOrder=before!==null&&target!==null?Math.max(0,before-target):null,cvr=clicks>0?orders/clicks:null;
 return{customerPrice:price,beforeAds:before,currentProfit:profit,desiredProfit:target,externalReservePerOrder:reserve,maxAdSpendPerOrder:maxPerOrder,cvr,maxCpcRub:maxPerOrder!==null&&cvr!==null?Math.max(0,maxPerOrder*cvr*s.safetyFactor):null};
}
function delta(last,row){
 if(!last?.before?.stats)return null;const a=row.stats||{},b=last.before.stats,out={};
 for(const k of ['views','clicks','orders','expense','sales'])out[k]=(finite(a[k])||0)-(finite(b[k])||0);
 out.cvrBefore=positive(b.clicks)?(finite(b.orders)||0)/finite(b.clicks):null;
 out.cvrNow=positive(a.clicks)?(finite(a.orders)||0)/finite(a.clicks):null;return out;
}
function enough(last,row,now,s){
 if(!last?.at||!Number.isFinite(Date.parse(last.at)))return true;
 if(Date.parse(now)-Date.parse(last.at)<s.minObservationMinutes*60000)return false;
 const d=delta(last,row);return!d||d.clicks>=s.minObservationClicks||d.orders>=s.minObservationOrders;
}
function todayCounts(actions,now){
 const day=String(now).slice(0,10),out={price:0,bid:0};
 for(const a of actions||[])if(String(a.at).slice(0,10)===day){
  if(['price_up','price_rollback'].includes(a.type))out.price++;
  if(['bid_up','bid_rollback'].includes(a.type))out.bid++;
 }return out;
}
function recommend(row,{settings:raw={},now=new Date().toISOString(),mode='observe',lastAction=null,actions=[]}={}){
 const s=mergeSettings(raw),stats=row.stats||{},finance=financeModel(row,s),blocks=[],warnings=[],reasons=[];
 const seller=positive(row.sellerPrice),buyer=positive(row.customerPrice),cost=positive(row.unitCost),stock=finite(row.stock);
 const current=fromMicros(row.currentBidMicros),competitive=fromMicros(row.competitiveBidMicros),minBid=positive(row.minBidRub),counts=todayCounts(actions,now);
 if(!cost)blocks.push('Нет корректной себестоимости');
 if(!seller)blocks.push('Нет текущей цены продавца');
 if(!row.priceUpdatedAt||!fresh(row.priceUpdatedAt,now,s.staleMinutes))blocks.push('Снимок цены устарел');
 if(stock!==null&&stock<s.minStockUnits)blocks.push('Остаток ниже защитного порога');
 if(row.inactive)blocks.push('Товар не продаётся или архивный');
 if(mode==='auto'&&!buyer)blocks.push('Для автоцены нужна подтверждённая цена покупателя');
 if(mode==='auto'&&finance.beforeAds===null)blocks.push('Для авто-режима не хватает фактической экономики Ozon');
 if(mode==='auto'&&s.externalReservePct===null)blocks.push('Для авто-режима задайте резерв налогов и внешних расходов');
 if(s.maxDailyAdSpendRub!==null&&(finite(stats.expenseToday)||finite(stats.expense)||0)>=s.maxDailyAdSpendRub)blocks.push('Достигнут дневной лимит рекламы');
 if(finance.currentProfit!==null&&finance.desiredProfit!==null&&finance.currentProfit<finance.desiredProfit)warnings.push('Текущая прибыль ниже заданного floor');
 if(row.autopilot&&row.autopilot!=='NO_AUTO_STRATEGY')warnings.push('У кампании включена автостратегия Ozon');
 if(row.campaignState&&row.campaignState!=='CAMPAIGN_STATE_RUNNING')warnings.push('Рекламная кампания не активна');
 const out={status:blocks.length?'blocked':'hold',action:null,reasons,blocks,warnings,currentBidRub:current,competitiveBidRub:competitive,minBidRub:minBid,
  maxProfitableBidRub:finance.maxCpcRub===null?null:round2(finance.maxCpcRub),contributionBeforeAdsPerOrder:finance.beforeAds,
  profitAfterAdsPerOrder:finance.currentProfit,targetProfitPerOrder:finance.desiredProfit,externalReservePerOrder:finance.externalReservePerOrder,cvr:finance.cvr,recommendedPrice:null,recommendedBidMicros:null,recommendedBidRub:null};
 if(blocks.length)return out;
 if(lastAction&&['price_up','bid_up','price_rollback','bid_rollback'].includes(lastAction.type)&&!enough(lastAction,row,now,s)){out.status='observe';reasons.push('Ждём достаточный объём данных после предыдущего шага');return out}
 if(lastAction?.type==='price_up'){
  const oldBuyer=positive(lastAction.before?.customerPrice),rise=oldBuyer&&buyer?pct(buyer,oldBuyer):null,d=delta(lastAction,row);
  const drop=d?.cvrBefore&&d?.cvrNow!==null?(1-d.cvrNow/d.cvrBefore)*100:null;
  if(rise!==null&&rise>s.customerPriceTolerancePct||drop!==null&&d.clicks>=s.minObservationClicks&&drop>s.rollbackConversionDropPct){
   const rollback=Math.floor(Math.min(positive(lastAction.before?.sellerPrice)||seller,seller*(1-s.priceStepPct/100))*100)/100;
   out.status='rollback';out.action={type:'price_rollback',value:rollback};out.recommendedPrice=rollback;
   reasons.push(rise!==null&&rise>s.customerPriceTolerancePct?'Цена покупателя вышла из допустимого коридора':'Конверсия ухудшилась после повышения цены');return out;
  }reasons.push('Предыдущий шаг цены прошёл контроль');
 }
 if(lastAction?.type==='bid_up'){
  const d=delta(lastAction,row);
  if(finance.currentProfit!==null&&finance.desiredProfit!==null&&finance.currentProfit<finance.desiredProfit){
   out.status='rollback';out.action={type:'bid_rollback',value:String(lastAction.before?.currentBidMicros||'')};out.recommendedBidMicros=out.action.value;out.recommendedBidRub=fromMicros(out.action.value);reasons.push('Прибыль опустилась ниже floor');return out;
  }
  if(d&&d.clicks>=s.minObservationClicks&&d.orders<=0&&d.expense>0){
   out.status='rollback';out.action={type:'bid_rollback',value:String(lastAction.before?.currentBidMicros||'')};out.recommendedBidMicros=out.action.value;out.recommendedBidRub=fromMicros(out.action.value);reasons.push('Расход вырос без дополнительных заказов');return out;
  }reasons.push('Предыдущий шаг ставки прошёл контроль');
 }
 const coinvest=seller&&buyer&&seller>buyer?(seller-buyer)/seller*100:0,preferPrice=!lastAction||['bid_up','bid_rollback'].includes(lastAction.type);
 if(preferPrice&&buyer&&coinvest>=s.minCoinvestPct&&counts.price<s.maxPriceStepsPerDay){
  const price=round2(seller*(1+s.priceStepPct/100));out.status='price_up';out.action={type:'price_up',value:price};out.recommendedPrice=price;
  reasons.push('Есть запас скидки/соинвеста Ozon '+round2(coinvest)+'%; проверяем следующий шаг цены');return out;
 }
 const direct=(!row.autopilot||row.autopilot==='NO_AUTO_STRATEGY')&&(!row.campaignState||row.campaignState==='CAMPAIGN_STATE_RUNNING');
 if(direct&&current!==null&&competitive!==null&&finance.maxCpcRub!==null&&counts.bid<s.maxBidStepsPerDay){
  const start=Math.max(current,minBid||0),ceiling=Math.min(finance.maxCpcRub,competitive*s.competitiveBuffer);
  if(ceiling>start+.009&&current<competitive){
   const bid=Math.min(ceiling,Math.max(minBid||0,start*(1+s.bidStepPct/100)));
   if(bid>current+.009){const micros=toMicros(round2(bid));out.status='bid_up';out.action={type:'bid_up',value:micros};out.recommendedBidMicros=micros;out.recommendedBidRub=fromMicros(micros);reasons.push('Ставка ниже конкурентной и запас прибыли позволяет увеличить CPC');return out}
  }
 }
 if(row.campaignState&&row.campaignState!=='CAMPAIGN_STATE_RUNNING')reasons.push('Кампания не активна — ставку не меняем');
 else if(current!==null&&competitive!==null&&current>=competitive)reasons.push('Ставка уже не ниже конкурентной');
 else if(finance.maxCpcRub!==null&&current!==null&&current>=finance.maxCpcRub)reasons.push('Достигнут потолок прибыльной ставки');
 else if(!buyer||coinvest<s.minCoinvestPct)reasons.push('Нет подтверждённого запаса соинвеста для повышения цены');
 else reasons.push('Нет безопасного следующего шага');
 return out;
}
module.exports={MICRO,DEFAULT_SETTINGS,mergeSettings,fromMicros,toMicros,financeModel,enoughObservation:enough,recommend};
