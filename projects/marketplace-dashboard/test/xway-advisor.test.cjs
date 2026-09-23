'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {buildAdvice,calculatePriceTrial,resolveMigrationContext}=require('../dist/xway-advisor.js');
const NOW=Date.parse('2026-09-23T09:00:00Z');
const base={accountKey:'new',key:'p1',name:'Товар',sku:'SKU-1',article:'A-1',stock:100,orderedUnits:40,orders:35,clicks:200,totalDrr:8.9,periodFrom:'2026-09-10',periodTo:'2026-09-20',observedAt:'2026-09-22T12:00:00+03:00',sourceUrl:'https://am.xway.ru/products'};
const data=products=>({accounts:[{key:'new',name:'Новый магазин'},{key:'old',name:'Старый магазин'}],campaigns:[],products});
const ready={migrationStatus:'recent',migrationDate:'2026-09-08',oldStore:'Старый магазин',skuChanged:'yes',adTarget:15,cpoRate:5,commission:25,termsConfirmed:true};
const run=(products,context=ready,filters={})=>buildAdvice(data(products),context,filters,{now:NOW});

test('period crossing migration is historical context and blocks DRR and price action',()=>{
 const result=run([{...base,periodFrom:'2026-09-05'}]);
 assert.equal(result.findings[0].stage,'transition');
 assert.equal(result.priceIdeas[0].status,'blocked');
 assert.match(result.priceIdeas[0].reason,/пересекает перенос/u);
 assert.doesNotMatch(result.cards.map(row=>row.action).join(' '),/отключить|масштабировать/iu);
});

test('unknown migration blocks recommendations and requests clarification',()=>{
 const result=run([base],{...ready,migrationStatus:'unknown',migrationDate:''});
 assert.equal(result.needsClarification,true);
 assert.equal(result.priceIdeas[0].status,'blocked');
 assert.match(result.migrationSummary,/не подтверждён/u);
});

test('no migration permits a data-backed check but never treats low DRR as a price instruction',()=>{
 const result=run([base],{...ready,migrationStatus:'none'});
 assert.equal(result.priceIdeas[0].status,'check');
 assert.match(result.priceIdeas[0].action,/проверить.+марж.+\+1–2%/iu);
 assert.match(result.priceIdeas[0].reason,/ДРР сам по себе не является основанием/u);
 assert.doesNotMatch(result.priceIdeas[0].action,/повысить|безопас/iu);
});

test('no migration still requires seven completed days',()=>{
 const result=run([{...base,periodFrom:'2026-09-20',periodTo:'2026-09-20'}],{...ready,migrationStatus:'none'});
 assert.equal(result.findings[0].stage,'period-sample');
 assert.equal(result.priceIdeas[0].status,'blocked');
 assert.match(result.supportDraft,/недостаточно завершённых дней/u);
});

test('future invalid and stale dates produce no current conclusion',()=>{
 for(const product of [
  {...base,key:'future-period',periodTo:'2026-09-23'},
  {...base,key:'invalid-date',periodFrom:'2026-02-30'},
  {...base,key:'future-observation',observedAt:'2026-09-24T00:00:00+03:00'},
  {...base,key:'stale',observedAt:'2026-09-10T00:00:00Z'}
 ]){
  const result=run([product]);
  assert.equal(result.priceIdeas[0].status,'blocked');
  assert.notEqual(result.findings[0].stage,'post-migration');
 }
});

test('accounts are not mixed and choosing one account restores its candidate',()=>{
 const products=[base,{...base,accountKey:'old',key:'p2',sku:'SKU-2'}];
 const mixed=run(products,{...ready,migrationStatus:'none'});
 assert.equal(mixed.priceIdeas.every(row=>row.status==='blocked'),true);
 assert.match(mixed.migrationSummary,/выбрать один магазин/u);
 const selected=run(products,{...ready,migrationStatus:'none'},{account:'new'});
 assert.equal(selected.findings.length,1);
 assert.equal(selected.findings[0].accountName,'Новый магазин');
 assert.equal(selected.priceIdeas[0].status,'check');
});

test('null values are unknown rather than zero',()=>{
 const result=run([{...base,totalDrr:null,orders:null}]);
 assert.equal(result.findings[0].totalDrr,null);
 assert.equal(result.findings[0].orders,null);
 assert.equal(result.priceIdeas[0].status,'blocked');
 assert.match(result.priceIdeas[0].reason,/не хватает/iu);
});

test('terms card never derives 10 percent from 15 and 5',()=>{
 const result=run([base]);
 const card=result.cards.find(row=>/рекламного условия/u.test(row.title));
 assert.match(card.reason,/15%.*5%/u);
 assert.match(card.action,/Не считать разницу/u);
 assert.doesNotMatch(JSON.stringify(result),/10%/u);
});

test('support draft respects product filters and includes source facts only',()=>{
 const products=[base,{...base,key:'p2',name:'Другой',sku:'SKU-2'}];
 const result=run(products,ready,{account:'new',query:'SKU-2'});
 assert.doesNotMatch(result.supportDraft,/SKU-1/u);
 assert.match(result.supportDraft,/SKU-2/u);
 assert.match(result.supportDraft,/2026-09-10 — 2026-09-20/u);
 assert.match(result.supportDraft,/общий ДРР 8,9%/u);
 assert.match(result.supportDraft,/цены \+1–2%/u);
 assert.match(result.supportDraft,/согласование до любых изменений/u);
 assert.match(result.supportDraft,/индивидуальных условий к новому магазину/u);
 assert.match(result.supportDraft,/расчётный период.+перечень услуг.+НДС.+возвратов/u);
 assert.match(result.supportDraft,/Расчёт предварительный/u);
});

test('support draft does not assert migration when none and marks unknown as uncertain',()=>{
 const none=run([base],{...ready,migrationStatus:'none'}).supportDraft;
 assert.doesNotMatch(none,/после переноса товаров/u);
 const unknown=run([base],{...ready,migrationStatus:'unknown',migrationDate:''}).supportDraft;
 assert.match(unknown,/Возможный перенос.+требует уточнения/u);
 assert.doesNotMatch(unknown,/после переноса товаров/u);
});

test('support draft labels stale and short post-migration source rows',()=>{
 const stale=run([{...base,observedAt:'2026-09-10T00:00:00Z'}]);
 assert.equal(stale.findings[0].stage,'needs-update');
 assert.match(stale.supportDraft,/устарел или требует обновления/u);
 const short=run([{...base,periodFrom:'2026-09-17',periodTo:'2026-09-20'}]);
 assert.equal(short.findings[0].stage,'post-migration-sample');
 assert.match(short.supportDraft,/после переноса недостаточно завершённых дней/u);
});

test('historical source SKU is labelled in support draft',()=>{
 const result=run([{...base,periodFrom:'2026-09-01',periodTo:'2026-09-07'}]);
 assert.equal(result.findings[0].stage,'historical');
 assert.match(result.supportDraft,/исторический\/требует разделения/u);
});

test('candidate needs seven post-migration days, enough sample and fourteen days of stock',()=>{
 assert.equal(run([{...base,periodFrom:'2026-09-17',periodTo:'2026-09-20'}]).priceIdeas[0].status,'blocked');
 assert.equal(run([{...base,orderedUnits:29}]).priceIdeas[0].status,'blocked');
 assert.equal(run([{...base,clicks:99}]).priceIdeas[0].status,'blocked');
 assert.equal(run([{...base,stock:20}]).priceIdeas[0].status,'blocked');
 assert.equal(run([base]).priceIdeas[0].status,'check');
});

test('negative metrics and out-of-range percentages never qualify',()=>{
 for(const change of [{orderedUnits:-1},{orders:-1},{clicks:-1},{stock:-1},{totalDrr:-1},{totalDrr:101}]){
  assert.equal(run([{...base,...change}],{...ready,migrationStatus:'none'}).priceIdeas[0].status,'blocked');
 }
 const result=run([base],{...ready,migrationStatus:'none',adTarget:101,cpoRate:-1,commission:Infinity});
 const card=result.cards.find(row=>/рекламного условия/u.test(row.title));
 assert.match(card.reason,/Ставки.+не подтверждены/u);
 assert.doesNotMatch(result.supportDraft,/101%|-1%|Infinity/u);
});

test('output is capped for price ideas and input stays immutable',()=>{
 const products=Array.from({length:8},(_,index)=>({...base,key:'p'+index,sku:'SKU-'+index}));
 const snapshot=structuredClone(products);
 const result=run(products,{...ready,migrationStatus:'none'});
 assert.equal(result.priceIdeas.length,5);
 assert.deepEqual(products,snapshot);
});

test('price trial is guarded and returns only a tentative seller price',()=>{
 const idea={status:'check'};
 assert.deepEqual(calculatePriceTrial({sellerPrice:100,buyerPrice:90,peerBuyerPrice:110,marginVerified:false,matchVerified:true},idea),{
  ready:false,reason:'Нужно подтвердить маржу и сопоставимость характеристик, фасовки, доставки и условий оплаты.',proposedSellerPrice:null,stepPercent:null
 });
 assert.equal(calculatePriceTrial({sellerPrice:100,buyerPrice:110,peerBuyerPrice:100,marginVerified:true,matchVerified:true},idea).ready,false);
 assert.equal(calculatePriceTrial({sellerPrice:100,buyerPrice:90,peerBuyerPrice:110,marginVerified:true,matchVerified:true},{status:'blocked'}).ready,false);
 const result=calculatePriceTrial({sellerPrice:100,buyerPrice:100,peerBuyerPrice:101,marginVerified:true,matchVerified:true},idea);
 assert.equal(result.ready,true);
 assert.equal(result.stepPercent,0.5);
 assert.equal(result.proposedSellerPrice,100.5);
 assert.match(result.reason,/цены продавца/u);
 assert.match(result.reason,/цену покупателя нужно проверить/u);
});

test('price trial caps step at two percent and does not assume fixed SPP',()=>{
 const result=calculatePriceTrial({sellerPrice:123.45,buyerPrice:80,peerBuyerPrice:120,marginVerified:true,matchVerified:true},{status:'check'});
 assert.equal(result.ready,true);
 assert.equal(result.stepPercent,2);
 assert.equal(result.proposedSellerPrice,125.92);
 assert.equal(Object.hasOwn(result,'proposedBuyerPrice'),false);
 assert.match(result.reason,/без предположения о фиксированной СПП/iu);
 for(const value of [null,0,-1,NaN,Infinity,'100']){
  assert.equal(calculatePriceTrial({sellerPrice:value,buyerPrice:80,peerBuyerPrice:120,marginVerified:true,matchVerified:true},{status:'check'}).ready,false);
 }
 assert.equal(calculatePriceTrial({sellerPrice:Number.MAX_VALUE,buyerPrice:80,peerBuyerPrice:120,marginVerified:true,matchVerified:true},{status:'check'}).ready,false);
});

test('SKU transfer map applies different migration dates to different products',()=>{
 const context={...ready,migrationDate:'2026-09-01',skuTransferDates:'SKU-1 2026-09-08\nSKU-2 2026-09-15',migrationNotes:'Журнал переноса карточек Ozon'};
 const products=[base,{...base,key:'p2',sku:'SKU-2',periodFrom:'2026-09-16',periodTo:'2026-09-22'}];
 const result=run(products,context,{account:'new'});
 assert.deepEqual(result.findings.map(row=>row.migrationDate),['2026-09-08','2026-09-15']);
 assert.equal(result.findings[0].stage,'post-migration');
 assert.equal(result.findings[1].stage,'post-migration');
 assert.match(result.migrationSummary,/даты переноса по SKU/u);
 assert.match(result.supportDraft,/SKU-1.+дата переноса 2026-09-08/u);
 assert.match(result.supportDraft,/SKU-2.+дата переноса 2026-09-15/u);
 assert.match(result.supportDraft,/Журнал переноса карточек Ozon/u);
 assert.doesNotMatch(result.supportDraft,/первый день нового магазина/u);
});

test('non-mapped SKU is blocked even when a general migration date exists',()=>{
 const context={...ready,migrationDate:'2026-09-01',skuTransferDates:'OTHER 2026-09-08'};
 const resolved=resolveMigrationContext(base,context);
 assert.equal(resolved.migrationDate,'');
 assert.match(resolved.reason,/дата переноса не указана/u);
 const result=run([base],context,{account:'new'});
 assert.equal(result.findings[0].stage,'unknown-date');
 assert.equal(result.findings[0].migrationDate,'');
 assert.equal(result.priceIdeas[0].status,'blocked');
 assert.equal(result.needsClarification,true);
});

test('invalid and conflicting duplicate SKU transfer dates are blocked',()=>{
 for(const skuTransferDates of ['SKU-1 2026-02-30','SKU-1 2026-09-08\nSKU-1 2026-09-15']){
  const result=run([base],{...ready,skuTransferDates},{account:'new'});
  assert.equal(result.findings[0].stage,'unknown-date');
  assert.equal(result.priceIdeas[0].status,'blocked');
  assert.equal(result.findings[0].migrationDate,'');
 }
});

test('unknown SKU transfer date takes precedence over other row quality issues',()=>{
 const result=run([{...base,periodFrom:'bad',periodTo:'bad'}],{...ready,skuTransferDates:'OTHER 2026-09-08'},{account:'new'});
 assert.equal(result.findings[0].stage,'unknown-date');
 assert.equal(result.priceIdeas[0].status,'blocked');
});

test('campaign-like row without SKU cannot inherit one batch date',()=>{
 const resolved=resolveMigrationContext({name:'Кампания'},{...ready,skuTransferDates:'SKU-1 2026-09-08'});
 assert.equal(resolved.migrationDate,'');
 assert.match(resolved.reason,/без SKU/u);
});
