(function(root,factory){
 'use strict';
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 else root.XwayAdvisor=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const DAY=86400000;
 const finite=value=>typeof value==='number'&&Number.isFinite(value);
 const isoDay=value=>{
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/u.test(value))return NaN;
  const parsed=Date.parse(value+'T00:00:00Z');
  return Number.isFinite(parsed)&&new Date(parsed).toISOString().slice(0,10)===value?parsed:NaN;
 };
 const moscowDay=now=>{
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(now));
  const get=type=>parts.find(part=>part.type===type)?.value;
  return get('year')+'-'+get('month')+'-'+get('day');
 };
 const text=value=>typeof value==='string'?value.trim():'';
 const percent=value=>finite(value)&&value>=0&&value<=100?value:null;
 const periodDays=row=>Math.floor((isoDay(row.periodTo)-isoDay(row.periodFrom))/DAY)+1;
 const periodLabel=row=>text(row.periodFrom)&&text(row.periodTo)?row.periodFrom+' — '+row.periodTo:'период не указан';
 const formatPercent=value=>finite(value)?String(value).replace('.',',')+'%':'не подтверждён';
 const accountMap=data=>new Map((Array.isArray(data.accounts)?data.accounts:[]).map(row=>[row.key,text(row.name)]));
 const matches=(row,filters)=>{
  const account=text(filters.account),query=text(filters.query).toLocaleLowerCase('ru');
  return (!account||row.accountKey===account)&&(!query||[row.name,row.sku,row.article].some(value=>String(value||'').toLocaleLowerCase('ru').includes(query)));
 };
 function resolveMigrationContext(row={},context={}){
  const status=['unknown','recent','none'].includes(context.migrationStatus)?context.migrationStatus:'unknown';
  if(status!=='recent')return {migrationStatus:status,migrationDate:text(context.migrationDate),source:'general',reason:''};
  const raw=text(context.skuTransferDates);
  if(!raw)return {migrationStatus:status,migrationDate:text(context.migrationDate),source:'general',reason:''};
  const dates=new Map(),invalid=new Set(),conflicts=new Set();
  for(const sourceLine of raw.split(/\r?\n/u)){
   const line=sourceLine.trim();if(!line)continue;
   const match=line.match(/^(.*?)\s+(\S+)$/u),sku=text(match?.[1]),date=text(match?.[2]);
   if(!sku||!Number.isFinite(isoDay(date))){if(sku)invalid.add(sku);continue;}
   if(dates.has(sku)&&dates.get(sku)!==date)conflicts.add(sku);else dates.set(sku,date);
  }
  const sku=text(row.sku);
  if(!sku)return {migrationStatus:status,migrationDate:'',source:'sku-map',reason:'Для записи без SKU нельзя выбрать дату из карты партий.'};
  if(conflicts.has(sku))return {migrationStatus:status,migrationDate:'',source:'sku-map',reason:'Для SKU '+sku+' указаны конфликтующие даты переноса.'};
  if(invalid.has(sku))return {migrationStatus:status,migrationDate:'',source:'sku-map',reason:'Для SKU '+sku+' указана некорректная дата переноса.'};
  if(!dates.has(sku))return {migrationStatus:status,migrationDate:'',source:'sku-map',reason:'Для SKU '+sku+' дата переноса не указана в карте партий.'};
  return {migrationStatus:status,migrationDate:dates.get(sku),source:'sku-map',reason:''};
 }
 function rowState(row,context,now,today){
  const migrationContext=resolveMigrationContext(row,context);
  const from=isoDay(row.periodFrom),to=isoDay(row.periodTo),todayMs=isoDay(today),observed=Date.parse(row.observedAt);
  const withMigration=value=>({...value,migrationDate:Number.isFinite(isoDay(migrationContext.migrationDate))?migrationContext.migrationDate:''});
  if(migrationContext.migrationStatus==='recent'&&migrationContext.source==='sku-map'&&!Number.isFinite(isoDay(migrationContext.migrationDate)))return withMigration({eligible:false,stage:'unknown-date',reason:migrationContext.reason||'Для SKU нужна однозначная дата переноса.'});
  if(!Number.isFinite(from)||!Number.isFinite(to)||from>to)return withMigration({eligible:false,stage:'needs-update',reason:'Границы периода отсутствуют или некорректны.'});
  if(to>=todayMs)return withMigration({eligible:false,stage:'needs-update',reason:'Нужен завершённый период без сегодняшнего и будущих дней.'});
  if(migrationContext.migrationStatus==='unknown')return withMigration({eligible:false,stage:'verify-migration',reason:'Дата и границы переноса между магазинами не подтверждены.'});
  if(migrationContext.migrationStatus==='recent'){
   const migration=isoDay(migrationContext.migrationDate);
   if(!Number.isFinite(migration))return withMigration({eligible:false,stage:'unknown-date',reason:migrationContext.reason||'Для недавнего переноса нужна точная дата переноса товара.'});
   if(from<=migration){
    const stage=to<=migration?'historical':'transition';
    const stale=todayMs-to>14*DAY||!Number.isFinite(observed)||observed>now||now-observed>7*DAY;
    return withMigration({eligible:false,stage,reason:(stage==='historical'?'Период относится к старому магазину или дню переноса.':'Период пересекает перенос и смешивает несопоставимые дни.')+(stale?' Срез нужно проверить или обновить.':'')});
   }
   if(todayMs-to>14*DAY)return withMigration({eligible:false,stage:'needs-update',reason:'Период завершился более 14 дней назад.'});
   if(!Number.isFinite(observed)||observed>now||now-observed>7*DAY)return withMigration({eligible:false,stage:'needs-update',reason:'Срез данных отсутствует, устарел или датирован будущим.'});
   if(periodDays(row)<7)return withMigration({eligible:false,stage:'post-migration-sample',reason:'После переноса ещё нет семи завершённых дней в отдельном периоде.'});
   return withMigration({eligible:true,stage:'post-migration',reason:''});
  }
  if(todayMs-to>14*DAY)return withMigration({eligible:false,stage:'needs-update',reason:'Период завершился более 14 дней назад.'});
  if(!Number.isFinite(observed)||observed>now||now-observed>7*DAY)return withMigration({eligible:false,stage:'needs-update',reason:'Срез данных отсутствует, устарел или датирован будущим.'});
  if(periodDays(row)<7)return withMigration({eligible:false,stage:'period-sample',reason:'Для оценки нужно не менее семи завершённых дней в отдельном периоде.'});
  return withMigration({eligible:true,stage:'current',reason:''});
 }
 const finding=(row,accounts,state)=>({
  name:text(row.name),sku:text(row.sku),accountName:accounts.get(row.accountKey)||text(row.accountKey),
  periodFrom:text(row.periodFrom),periodTo:text(row.periodTo),observedAt:text(row.observedAt),
  totalDrr:finite(row.totalDrr)?row.totalDrr:null,orders:finite(row.orders)?row.orders:null,
  clicks:finite(row.clicks)?row.clicks:null,sourceUrl:text(row.sourceUrl),stage:state.stage,migrationDate:state.migrationDate||''
 });
 function buildCards(context,states,mixedAccounts){
  const cards=[];
  const migrationProblem=context.migrationStatus==='unknown'||context.migrationStatus==='recent'&&!text(context.skuTransferDates)&&!Number.isFinite(isoDay(context.migrationDate))||states.some(item=>['historical','transition','post-migration-sample','verify-migration','unknown-date'].includes(item.state.stage));
  if(migrationProblem||mixedAccounts)cards.push({title:'Сначала сверить перенос и магазины',reason:mixedAccounts?'В выборке несколько магазинов, а единый анализ смешает их показатели.':'Дата переноса или сопоставимость периода пока не подтверждены.',action:'Указать первый день нового магазина, выбрать один магазин, сопоставить старые и новые SKU и анализировать только отдельные завершённые дни после переходного дня.',tone:'warning'});
  const target=percent(context.adTarget),cpo=percent(context.cpoRate),commission=percent(context.commission);
  const known=[target===null?'':('общая реклама '+formatPercent(target)),cpo===null?'':('CPO '+formatPercent(cpo)),commission===null?'':('комиссия '+formatPercent(commission))].filter(Boolean).join(', ');
  cards.push({title:'Подтвердить состав рекламного условия',reason:known?'В контексте указано: '+known+'. Нужно подтвердить общую базу расчёта и состав услуг.':'Ставки и общая база расчёта пока не подтверждены.',action:'Уточнить, входит ли CPO в общий рекламный процент вместе с Ozon. Не считать разницу процентов свободным бюджетом и не задавать лимиты без расходов и согласованной базы.',tone:context.termsConfirmed?'info':'warning'});
  cards.push({title:'Проверить экономику и остатки',reason:'ДРР без закупочной цены, комиссии, логистики, возвратов, скидок и полноты расходов не показывает прибыль.',action:'Собрать маржу на единицу и запас минимум на 14 дней до теста цены или рекламы. Высокий общий ДРР использовать только как повод проверить исходный период.',tone:'neutral'});
  cards.push({title:'Сравнить характеристики и покупательскую цену',reason:'Цена аналога полезна только при одинаковых характеристиках, фасовке, сроке доставки и условиях оплаты.',action:'Сопоставить предложения вручную и считать итоговую цену покупателя, а не только цену на карточке.',tone:'neutral'});
  cards.push({title:'Разделить тесты цены и рекламы',reason:'Одновременное изменение цены и рекламы не позволит понять причину результата.',action:'Сначала согласовать один тест, стоп-условия и критерии отката; затем провести его на семи завершённых днях с учётом окна атрибуции.',tone:'info'});
  return cards;
 }
 function priceIdea(row,accounts,state,mixedAccounts){
  const base={name:text(row.name),sku:text(row.sku),accountName:accounts.get(row.accountKey)||text(row.accountKey),sourceUrl:text(row.sourceUrl),periodFrom:text(row.periodFrom),periodTo:text(row.periodTo),migrationDate:state.migrationDate||''};
  if(mixedAccounts)return {...base,status:'blocked',reason:'Не выбран один магазин; показатели разных магазинов нельзя смешивать.',action:'Выбрать магазин и повторить проверку на его отдельном периоде.'};
  if(!state.eligible)return {...base,status:'blocked',reason:state.reason,action:'Обновить и разделить данные до оценки теста цены.'};
  const metrics=[row.orderedUnits,row.orders,row.clicks,row.stock,row.totalDrr];
  const required=[row.name,row.sku,row.sourceUrl,row.observedAt,row.periodFrom,row.periodTo].every(value=>text(value))&&metrics.every(value=>finite(value)&&value>=0)&&row.totalDrr<=100;
  if(!required)return {...base,status:'blocked',reason:'Не хватает подтверждённых SKU, периода, источника, ДРР, кликов, заказанных единиц или остатка.',action:'Обновить карточку товара и финансовый срез; неизвестные значения не считать нулём.'};
  if(row.orderedUnits<30||row.clicks<100)return {...base,status:'blocked',reason:'Для оценки теста пока недостаточно объёма: нужно не менее 30 заказанных единиц и 100 кликов.',action:'Накопить выборку на завершённом периоде и проверить снова.'};
  const duration=periodDays(row),cover=row.orderedUnits>0?row.stock/(row.orderedUnits/duration):0;
  if(!Number.isFinite(cover)||cover<14)return {...base,status:'blocked',reason:'Подтверждённого запаса не хватает минимум на 14 дней при темпе периода.',action:'Проверить остаток и поставку до ценового теста.'};
  return {...base,status:'check',reason:'Есть достаточная выборка и запас для предварительной ручной оценки; низкий ДРР сам по себе не является основанием повышать цену.',action:'Проверить сопоставимые аналоги и маржу для отдельного теста цены +1–2%. Отбор предварительный. Повышение требует отдельного теста и условий отката.'};
 }
 function supportDraft(rows,accounts,context,states,mixedAccounts){
  const intro=context.migrationStatus==='recent'?'Здравствуйте! Помогите, пожалуйста, подготовить план после переноса товаров в новый магазин.':context.migrationStatus==='unknown'?'Здравствуйте! Возможный перенос товаров между магазинами требует уточнения; помогите, пожалуйста, проверить его статус и подготовить план.':'Здравствуйте! Помогите, пожалуйста, проверить текущие настройки и подготовить план по выбранному магазину.';
  const lines=[intro+' Ничего не меняйте без моего согласования.'];
  const migration=isoDay(context.migrationDate),hasSkuMap=Boolean(text(context.skuTransferDates));
  const details=[];
  if(text(context.oldStore))details.push('старый магазин: '+text(context.oldStore));
  if(context.migrationStatus==='recent'&&hasSkuMap)details.push('перенос выполнялся партиями; для каждого SKU используется его дата переноса как переходный день');
  else if(context.migrationStatus==='recent'&&Number.isFinite(migration))details.push('дата переноса: '+context.migrationDate+' (её считаем переходным днём)');
  if(context.skuChanged==='yes')details.push('SKU после переноса изменились');
  if(context.skuChanged==='no')details.push('SKU после переноса не менялись');
  if(details.length)lines.push('Подтверждённые вводные: '+details.join('; ')+'.');
  if(text(context.migrationNotes))lines.push('Заметка об источнике переноса: '+text(context.migrationNotes));
  lines.push('Нужны раздельные данные по старому и новому магазинам, сопоставление SKU, проверка даты старта, атрибуции и кампаний после переноса. Пожалуйста, не объединяйте агрегаты периодов и не обрезайте период с сохранением прежних сумм.');
  const target=percent(context.adTarget),cpo=percent(context.cpoRate),commission=percent(context.commission),terms=[];
  if(target!==null)terms.push('общая реклама '+formatPercent(target));
  if(cpo!==null)terms.push('CPO '+formatPercent(cpo));
  if(commission!==null)terms.push('комиссия '+formatPercent(commission));
  lines.push('Уточните, входит ли CPO в общий рекламный процент вместе с Ozon, и подтвердите применимость индивидуальных условий к новому магазину, базу, расчётный период, перечень услуг, НДС и учёт возвратов'+(terms.length?' для указанных вводных ('+terms.join(', ')+')':'')+'. Не вычитайте одну ставку из другой до подтверждения состава услуг.');
  const selected=rows.map((row,index)=>({row,state:states[index].state})).filter(item=>text(item.row.sku)&&Number.isFinite(isoDay(item.row.periodFrom))&&Number.isFinite(isoDay(item.row.periodTo))&&finite(item.row.totalDrr)).slice(0,4);
  if(selected.length){
   lines.push('Исходные SKU для сверки:');
   for(const {row,state} of selected){
    const store=accounts.get(row.accountKey)||text(row.accountKey),labels={historical:'исторический/требует разделения',transition:'пересекает перенос/требует разделения','verify-migration':'перенос требует уточнения','unknown-date':'дата переноса этого SKU требует уточнения','needs-update':'устарел или требует обновления','post-migration-sample':'после переноса недостаточно завершённых дней','period-sample':'недостаточно завершённых дней'};
    const label=labels[state.stage]?' — '+labels[state.stage]:'';
    const transfer=state.migrationDate?', дата переноса '+state.migrationDate+' (переходный день)':'';
    lines.push('• '+text(row.sku)+' — '+text(row.name)+(store?' ('+store+')':'')+', '+periodLabel(row)+transfer+', общий ДРР '+formatPercent(row.totalDrr)+label+'.');
   }
  }
  if(mixedAccounts)lines.push('Сначала помогите выбрать один магазин для анализа, чтобы не смешивать показатели разных кабинетов.');
  lines.push('Предложите набор настроек, лимитов, стоп-условий и план теста на 7 завершённых дней с учётом окна атрибуции.');
  if(context.migrationStatus==='recent')lines.push('Пометка «после переноса» используется только как фильтр периода и не подтверждает полноту истории переносов.');
  lines.push('Отдельно предложите SKU для небольшого теста цены +1–2% после сравнения одинаковых характеристик, фасовки, срока доставки и условий оплаты и проверки экономики после комиссии и рекламы. Расчёт предварительный, цену и рекламу тестируйте отдельно; задайте критерии отката по прибыли и конверсии с учётом объёма выборки.');
  lines.push('Пришлите план на согласование до любых изменений.');
  return lines.join('\n\n');
 }
 function migrationSummary(context,mixedAccounts){
  if(mixedAccounts)return 'Нужно выбрать один магазин: текущая выборка содержит несколько магазинов.';
  if(context.migrationStatus==='none')return 'Перенос магазина не указан; используются только свежие завершённые периоды.';
  if(context.migrationStatus==='recent'&&text(context.skuTransferDates))return 'Учтены даты переноса по SKU; товары без однозначной даты нужно подтверждать отдельно.';
  if(context.migrationStatus==='recent'&&Number.isFinite(isoDay(context.migrationDate)))return 'Дата переноса: '+context.migrationDate+' — переходный день; для выводов подходят только отдельные завершённые последующие дни.';
  return 'Перенос не подтверждён: нужны дата первого дня нового магазина и сопоставление SKU.';
 }
 function buildAdvice(data={},context={},filters={},options={}){
  const now=finite(options.now)?options.now:Date.now(),today=moscowDay(now),accounts=accountMap(data);
  const rows=(Array.isArray(data.products)?data.products:[]).filter(row=>matches(row,filters));
  const accountKeys=new Set(rows.map(row=>row.accountKey).filter(Boolean));
  const mixedAccounts=!text(filters.account)&&accountKeys.size>1;
  const normalizedContext={migrationStatus:['unknown','recent','none'].includes(context.migrationStatus)?context.migrationStatus:'unknown',migrationDate:text(context.migrationDate),skuTransferDates:text(context.skuTransferDates),migrationNotes:text(context.migrationNotes),oldStore:text(context.oldStore),skuChanged:['unknown','yes','no'].includes(context.skuChanged)?context.skuChanged:'unknown',adTarget:context.adTarget,cpoRate:context.cpoRate,commission:context.commission,termsConfirmed:context.termsConfirmed===true};
  const states=rows.map(row=>({row,state:rowState(row,normalizedContext,now,today)}));
  const findings=states.map(item=>finding(item.row,accounts,item.state));
  const priceIdeas=states.map(item=>priceIdea(item.row,accounts,item.state,mixedAccounts)).sort((a,b)=>(a.status==='check'?0:1)-(b.status==='check'?0:1)).slice(0,5);
  const needsClarification=mixedAccounts||normalizedContext.migrationStatus==='unknown'||states.some(item=>item.state.stage==='unknown-date')||normalizedContext.migrationStatus==='recent'&&!normalizedContext.skuTransferDates&&!Number.isFinite(isoDay(normalizedContext.migrationDate))||normalizedContext.skuChanged==='unknown'||!normalizedContext.termsConfirmed;
  return {cards:buildCards(normalizedContext,states,mixedAccounts),findings,supportDraft:supportDraft(rows,accounts,normalizedContext,states,mixedAccounts),migrationSummary:migrationSummary(normalizedContext,mixedAccounts),needsClarification,priceIdeas};
 }
 function calculatePriceTrial(input={},idea={}){
  const blocked=reason=>({ready:false,reason,proposedSellerPrice:null,stepPercent:null});
  if(!idea||idea.status!=='check')return blocked('Сначала товар должен пройти проверку данных и получить статус кандидата.');
  const sellerPrice=input.sellerPrice,buyerPrice=input.buyerPrice,peerBuyerPrice=input.peerBuyerPrice;
  if(!finite(sellerPrice)||!finite(buyerPrice)||!finite(peerBuyerPrice)||sellerPrice<=0||buyerPrice<=0||peerBuyerPrice<=0)return blocked('Нужны положительные подтверждённые цены продавца, покупателя и сопоставимого аналога.');
  if(input.marginVerified!==true||input.matchVerified!==true)return blocked('Нужно подтвердить маржу и сопоставимость характеристик, фасовки, доставки и условий оплаты.');
  if(buyerPrice>=peerBuyerPrice)return blocked('Цена покупателя уже не ниже цены сопоставимого аналога; повышение не предлагается.');
  const step=Math.min(2,((peerBuyerPrice/buyerPrice)-1)*100/2);
  if(!Number.isFinite(step)||step<=0)return blocked('Положительный шаг теста не рассчитан.');
  const proposed=Math.round(sellerPrice*(1+step/100)*100)/100;
  if(!finite(proposed)||proposed<=0||!(proposed>sellerPrice))return blocked('После расчёта не получена корректная положительная цена продавца.');
  return {ready:true,reason:'Предварительный шаг только для цены продавца; фактическую цену покупателя нужно проверить после изменения, без предположения о фиксированной СПП.',proposedSellerPrice:proposed,stepPercent:Math.round(step*100)/100};
 }
 return Object.freeze({buildAdvice,calculatePriceTrial,resolveMigrationContext});
});
