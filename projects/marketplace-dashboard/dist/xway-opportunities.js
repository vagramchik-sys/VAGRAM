(function(root,factory){
 'use strict';
 const api=factory();
 if(typeof module==='object'&&module.exports)module.exports=api;
 else root.XwayOpportunities=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const DEFAULTS=Object.freeze({minClicks:100,minOrders:30,minHighDrrOrders:5,minPeers:5,growthRatio:.8,highDrrRatio:1.5,highDrrGap:5,lowStockDays:7,minOrderedUnits:10,staleDays:7,maxPeriodAgeDays:14,minPeriodDays:7});
 const finite=value=>typeof value==='number'&&Number.isFinite(value);
 const day=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/u.test(value)?Date.parse(value+'T00:00:00Z'):NaN;
 const days=(from,to)=>Math.floor((day(to)-day(from))/86400000)+1;
 const complete=(row,today,maxAge)=>Number.isFinite(day(row.periodFrom))&&Number.isFinite(day(row.periodTo))&&day(row.periodFrom)<=day(row.periodTo)&&day(row.periodTo)<day(today)&&day(today)-day(row.periodTo)<=maxAge*86400000;
 const fresh=(row,now,limit)=>Number.isFinite(Date.parse(row.observedAt))&&Date.parse(row.observedAt)<=now&&now-Date.parse(row.observedAt)<=limit*86400000;
 const median=values=>{const sorted=values.slice().sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;};
 const targetInName=name=>{const match=String(name||'').match(/(?:д[рp][рp]|drr)\s*(?:до|[:=≤<])?\s*(\d+(?:[.,]\d+)?)(?:\s*[-–—]\s*(\d+(?:[.,]\d+)?))?\s*%?/iu);if(!match)return null;return Math.max(...[match[1],match[2]].filter(Boolean).map(value=>Number(value.replace(',','.'))));};
 const targetNote=row=>{const target=targetInName(row.name);return target===null?'':' Ориентир в названии: ДРР '+target+'%; это не подтверждённая настройка и не показатель маржи.';};
 const moscowDay=now=>{const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(now)),get=type=>parts.find(part=>part.type===type)?.value;return get('year')+'-'+get('month')+'-'+get('day');};
 const period=row=>row.periodFrom&&row.periodTo?row.periodFrom+' — '+row.periodTo:'Период не подтверждён';
 const source=row=>({period:period(row),observedAt:row.observedAt||null,sourceUrl:row.sourceUrl||null});
 const card=(kind,title,reason,action,fact,row,extra={})=>({kind,title,reason,action,fact,...source(row),...extra});
 function analyze(input={},filters={},options={}){
  const limits={...DEFAULTS,...options},now=Number.isFinite(options.now)?options.now:Date.now(),today=options.today||moscowDay(now);
  const account=filters.account||'',status=filters.status||'',strategy=filters.strategy||'',query=String(filters.query||'').trim().toLocaleLowerCase('ru');
  const allCampaigns=Array.isArray(input.campaigns)?input.campaigns:[],allProducts=Array.isArray(input.products)?input.products:[];
  const campaigns=allCampaigns.filter(row=>(!account||row.accountKey===account)&&(!status||row.status===status)&&(!strategy||row.strategy===strategy)&&(!query||String(row.name||'').toLocaleLowerCase('ru').includes(query)));
  const products=allProducts.filter(row=>(!account||row.accountKey===account)&&(!query||[row.name,row.sku,row.article].some(value=>String(value||'').toLocaleLowerCase('ru').includes(query))));
  const problems=[],growth=[],needsData=[];
  for(const row of campaigns){
   const namedTarget=targetNote(row);
   const isComplete=complete(row,today,limits.maxPeriodAgeDays),isFresh=fresh(row,now,limits.staleDays);
   if(!isComplete)needsData.push(card('needs-data',row.name,'Период кампании не завершён, слишком старый или его границы не подтверждены.','Выбрать свежий завершённый период и повторно проверить показатели.','Сравнение эффективности пока преждевременно.',row,{entity:'campaign',priority:10}));
   else if(!isFresh)needsData.push(card('needs-data',row.name,'Дата проверки недостоверна или устарела.','Обновить факты в XWAY перед выводами.','Сохранённые показатели могут уже не описывать текущую настройку.',row,{entity:'campaign'}));
   else if(!finite(row.clicks)||!finite(row.orders)||(!finite(row.drr)&&row.orders!==0))needsData.push(card('needs-data',row.name,'Не подтверждены клики, заказы или ДРР.','Проверить полноту метрик кампании в источнике.','Неизвестное значение не считается нулём.',row,{entity:'campaign',priority:20}));
   else if(row.clicks<limits.minClicks||row.orders>0&&row.orders<limits.minHighDrrOrders)needsData.push(card('needs-data',row.name,'Выборки пока недостаточно для сравнительного сигнала.','Накопить не менее '+limits.minClicks+' кликов и '+limits.minHighDrrOrders+' заказов; для кандидата на рост нужно '+limits.minOrders+' заказов.','Сейчас: '+row.clicks+' кликов, '+row.orders+' заказов.',row,{entity:'campaign',priority:15}));
   if(complete(row,today,limits.maxPeriodAgeDays)&&fresh(row,now,limits.staleDays)&&finite(row.clicks)&&row.clicks>=limits.minClicks&&row.orders===0){
    problems.push(card('problem',row.name,'Есть '+row.clicks+' кликов, но в источнике не подтверждено ни одного рекламного заказа.','Проверить атрибуцию, период, карточку и путь от клика к заказу. Нулевое значение само по себе не доказывает бесполезный расход.','Расход: '+(finite(row.spend)?row.spend+' ₽':'не подтверждён')+'.'+namedTarget,row,{entity:'campaign',priority:80,strength:row.clicks}));
   }
  }
  for(const row of products){
   const duration=days(row.periodFrom,row.periodTo);
   if(!complete(row,today,limits.maxPeriodAgeDays)||!fresh(row,now,limits.staleDays)){
    needsData.push(card('needs-data',row.name,'Остаток и темп заказов относятся к неполному или устаревшему срезу.','Обновить остаток и использовать завершённый период.','Оценку запаса не строим.',row,{entity:'product'}));continue;
   }
   if(!finite(row.stock)||!finite(row.orderedUnits)){
    needsData.push(card('needs-data',row.name,'Не подтверждён текущий остаток или количество заказанных единиц.','Проверить данные товара в источнике.','Неизвестное значение не считается нулём.',row,{entity:'product'}));continue;
   }
   if(duration>=limits.minPeriodDays&&row.orderedUnits>=limits.minOrderedUnits&&row.orderedUnits>0){
    const pace=row.orderedUnits/duration,cover=row.stock/pace;
    if(cover<=limits.lowStockDays)problems.push(card('problem',row.name,'Текущий остаток покрывает около '+cover.toFixed(1)+' дня при темпе заказов завершённого периода.','Проверить доступный остаток и поставку до увеличения рекламного трафика.','Остаток '+row.stock+' шт.; '+row.orderedUnits+' заказанных единиц за '+duration+' дн. Это оценка, не прогноз.',row,{entity:'product',priority:100,strength:limits.lowStockDays-cover}));
   }
  }
  const comparable=allCampaigns.filter(row=>complete(row,today,limits.maxPeriodAgeDays)&&fresh(row,now,limits.staleDays)&&finite(row.drr)&&finite(row.clicks)&&finite(row.orders)&&row.clicks>=limits.minClicks);
  const baseline=comparable.filter(row=>row.orders>=limits.minOrders),qualified=campaigns.filter(row=>comparable.includes(row));
  for(const row of qualified){
   const peers=baseline.filter(peer=>peer!==row&&peer.accountKey===row.accountKey&&peer.periodFrom===row.periodFrom&&peer.periodTo===row.periodTo&&(peer.type||'')===(row.type||''));
   if(peers.length<limits.minPeers)continue;
   const benchmark=median(peers.map(peer=>peer.drr));
   if(row.orders>=limits.minOrders&&benchmark>0&&row.drr<benchmark*limits.growthRatio)growth.push(card('growth',row.name,'ДРР заметно ниже медианы '+peers.length+' других сопоставимых кампаний того же кабинета, периода и типа.','Кандидат на проверку: изучить настройки и возможность аккуратного масштабирования. Сначала подтвердить маржу и остаток товара.','ДРР '+row.drr+'% против медианы '+benchmark.toFixed(1)+'%; '+row.orders+' заказов и '+row.clicks+' кликов.',row,{entity:'campaign',priority:50,strength:benchmark-row.drr}));
   if(row.orders>=limits.minHighDrrOrders&&benchmark>=0&&row.drr>=benchmark*limits.highDrrRatio&&row.drr-benchmark>=limits.highDrrGap)problems.push(card('problem',row.name,'ДРР заметно выше медианы '+peers.length+' других сопоставимых кампаний этого кабинета. Это относительный ориентир, а не порог прибыльности.','Проверить ставку, воронку, атрибуцию и карточку; вывод о прибыли делать только с подтверждённой маржой.','ДРР '+row.drr+'% против медианы группы '+benchmark.toFixed(1)+'%; '+row.orders+' заказов и '+row.clicks+' кликов.'+targetNote(row),row,{entity:'campaign',priority:60,strength:row.drr-benchmark}));
  }
  const order=(a,b)=>(b.priority||0)-(a.priority||0)||(b.strength||0)-(a.strength||0)||(Date.parse(b.observedAt)||0)-(Date.parse(a.observedAt)||0);
  return {problems:problems.sort(order),growth:growth.sort(order),needsData:needsData.sort(order),meta:{campaignCount:campaigns.length,productCount:products.length,productFiltersIgnoreCampaignFields:Boolean(status||strategy),thresholds:limits}};
 }
 return Object.freeze({analyze,DEFAULTS});
});
