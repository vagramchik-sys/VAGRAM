'use strict';
const fs=require('fs'),crypto=require('crypto');
const {isInactive}=require('./dist/dashboard-model.js');
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
class ManagementError extends Error{constructor(message,status=400){super(message);this.status=status;this.public=true}}
const fail=(message,status)=>{throw new ManagementError(message,status)};
function version(product){return digest({key:product.key,pricing:product.pricing&&{...product.pricing,importedAt:undefined},cost:product.cost?.unitCost,archived:product.archived,status:product.salesStatus})}
const cents=v=>Math.round((v+Number.EPSILON)*100)/100;
const moneyValid=v=>typeof v==='number'&&Number.isFinite(v)&&v>0&&v<=10000000&&Math.abs(v*100-Math.round(v*100))<0.000001;
module.exports=function({file,catalog,now=()=>new Date().toISOString()}){
  let state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{batches:[],notes:{},events:[]};
  function commit(fn){const next=structuredClone(state),result=fn(next);fs.writeFileSync(file+'.tmp',JSON.stringify(next));fs.renameSync(file+'.tmp',file);state=next;return result}
  function event(next,type,detail){next.events.unshift({id:crypto.randomUUID(),at:now(),type,...detail});}
  function products(){return catalog().map(p=>({...p,version:version(p),note:state.notes[p.key]||{text:'',flag:'normal',version:0}}))}
  function preview(input){
    if(!Array.isArray(input.targets)||!input.targets.length||input.targets.length>3000)fail('Выберите от 1 до 3000 товаров');
    if(!['set','percent','delta','costplus'].includes(input.mode)||typeof input.amount!=='number'||!Number.isFinite(input.amount)||Math.abs(input.amount)>10000000)fail('Укажите корректное изменение цены');
    if(![0,1,10,100].includes(input.rounding))fail('Выберите округление');
    if(input.fields!==undefined&&(input.targets.length!==1||!input.fields||typeof input.fields!=='object'||Object.keys(input.fields).some(k=>!['minPrice','oldPrice','discount'].includes(k))))fail('Дополнительные поля доступны для одного товара');
    const map=new Map(products().map(p=>[p.key,p])),seen=new Set();
    const rows=input.targets.map(target=>{
      if(!target||typeof target.key!=='string'||seen.has(target.key))fail('Повтор или неверный товар в заявке');seen.add(target.key);
      const p=map.get(target.key);if(!p)fail('Товар отсутствует в подключённых магазинах');
      const errors=[],warnings=[],before=p.pricing||{};
      if(target.version!==p.version)errors.push('Данные товара изменились. Обновите каталог');
      if(isInactive(p))errors.push('Товар архивный или снят с продажи');
      if(before.price!==0&&!moneyValid(before.price))errors.push(before.multiplePrices?'У размеров разные цены. Поразмерное редактирование пока недоступно':'Сначала загрузите цену товара');
      if(before.price===0)warnings.push('Выгружена нулевая цена — проверьте карточку перед отправкой');
      if(before.currency!=='RUB')errors.push('Редактирование доступно для цен в рублях');
      const priceAge=Date.parse(now())-Date.parse(before.importedAt);
      if(!Number.isFinite(priceAge)||priceAge>86400000)errors.push('Цены старше 24 часов. Обновите цены магазина');
      let price=input.mode==='set'?input.amount:input.mode==='percent'?before.price*(1+input.amount/100):input.mode==='delta'?before.price+input.amount:p.cost?.unitCost*(1+input.amount/100);
      if(input.mode==='costplus'&&(p.cost?.status!=='filled'||p.cost.currency!==before.currency))errors.push('Для расчёта нужна себестоимость в валюте цены');
      price=input.rounding?Math.round(price/input.rounding)*input.rounding:cents(price);
      const after={price,minPrice:before.minPrice??null,oldPrice:before.oldPrice??null,discount:before.discount??null,...input.fields};
      if(!moneyValid(price))errors.push('Цена должна быть от 0,01 до 10 000 000 ₽');
      if(p.market==='WB'){
        if(!Number.isInteger(price))errors.push('Базовая цена WB должна быть целым числом рублей');
        if(input.fields&&('oldPrice' in input.fields||'minPrice' in input.fields))errors.push('Поля минимальной и старой цены относятся к Ozon');
        if(!Number.isInteger(after.discount)||after.discount<0||after.discount>99)errors.push('Скидка WB — целое число от 0 до 99%');
      }else{
        if(input.fields&&'discount' in input.fields)errors.push('Скидка WB не относится к Ozon');
        for(const name of ['minPrice','oldPrice'])if(after[name]!==null&&after[name]!==0&&!moneyValid(after[name]))errors.push('Проверьте минимальную цену и цену до скидки');
        if(after.minPrice>price)errors.push('Новая цена ниже минимальной цены Ozon');
        if(after.oldPrice>0&&after.oldPrice<=price)errors.push('Цена до скидки должна быть выше новой цены или равна нулю');
      }
      const changed=['price','minPrice','oldPrice','discount'].some(k=>(before[k]??null)!==after[k]);
      if(!changed)errors.push('Нет изменений');
      const effective=p.market==='WB'?cents(price*(1-after.discount/100)):price;
      if(p.cost?.status==='filled'&&p.cost.currency===before.currency){if(effective<p.cost.unitCost)warnings.push('Цена ниже себестоимости');}
      else warnings.push('Себестоимость не заполнена или не сопоставлена');
      const changePercent=before.price?cents((price/before.price-1)*100):null;
      if(Math.abs(changePercent)>30)warnings.push('Изменение базовой цены больше 30%');
      if(p.market==='WB'){
        const oldEffective=before.price*(1-before.discount/100);
        if(effective<=oldEffective/3)warnings.push('Цена со скидкой снизится в 3 раза или больше: возможен карантин WB');
      }
      const pending=state.batches.find(b=>['draft','submitted'].includes(b.status)&&b.rows.some(r=>r.key===p.key));
      if(pending)errors.push('Товар уже есть в открытой заявке '+pending.number);
      return {key:p.key,version:p.version,name:p.name,offer_id:p.offer_id,storeName:p.storeName,market:p.market,currency:before.currency,importedAt:before.importedAt,before:{price:before.price,minPrice:before.minPrice??null,oldPrice:before.oldPrice??null,discount:before.discount??null},after,changePercent,effective,cost:p.cost?.status==='filled'?p.cost.unitCost:null,errors,warnings};
    });
    const hash=digest(rows.map(r=>({key:r.key,version:r.version,after:r.after,errors:r.errors})));
    return {rows,hash,valid:rows.every(r=>!r.errors.length),errorCount:rows.filter(r=>r.errors.length).length,warningCount:rows.filter(r=>r.warnings.length).length};
  }
  function create(input){
    if(typeof input.requestId!=='string'||!/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId))fail('Не указан идентификатор заявки');
    const duplicate=state.batches.find(b=>b.requestId===input.requestId);
    const requestHash=digest(input);
    if(duplicate){if(duplicate.requestHash!==requestHash)fail('Идентификатор заявки уже использован',409);return duplicate}
    if(typeof input.title!=='string'||!input.title.trim()||input.title.length>160)fail('Добавьте название заявки до 160 символов');
    if(typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>1000)fail('Добавьте причину изменения до 1000 символов');
    const calculated=preview(input);
    if(!calculated.valid)fail('Исправьте ошибки в предварительном просмотре',409);
    if(calculated.hash!==input.previewHash)fail('Предварительный просмотр устарел. Проверьте изменения ещё раз',409);
    if(calculated.warningCount&&input.acceptWarnings!==true)fail('Подтвердите, что проверили предупреждения');
    return commit(next=>{const batch={id:crypto.randomUUID(),number:next.batches.length+1,requestId:input.requestId,requestHash,title:input.title.trim(),reason:input.reason.trim(),status:'draft',version:1,createdAt:now(),updatedAt:now(),rows:calculated.rows};next.batches.unshift(batch);event(next,'created',{batchId:batch.id,label:batch.title,count:batch.rows.length});return batch});
  }
  function transition(input){
    const batch=state.batches.find(b=>b.id===input.id);if(!batch)fail('Заявка не найдена',404);
    if(batch.version!==input.version)fail('Заявку уже изменили. Обновите страницу',409);
    const allowed={draft:['submitted','cancelled'],submitted:['returned','cancelled'],returned:['cancelled']};
    if(!allowed[batch.status]?.includes(input.status))fail('Этот переход заявки недоступен');
    if(input.status==='returned'&&(typeof input.comment!=='string'||!input.comment.trim()||input.comment.length>1000))fail('Укажите причину возврата до 1000 символов');
    if(input.status==='submitted'){
      const map=new Map(products().map(p=>[p.key,p]));
      for(const row of batch.rows){const p=map.get(row.key);if(!p||p.version!==row.version)fail('Цены или статус товара изменились. Отмените заявку и подготовьте новую',409);const age=Date.parse(now())-Date.parse(p.pricing?.importedAt);if(!Number.isFinite(age)||age>86400000)fail('Обновите цены магазина перед передачей на проверку',409)}
    }
    return commit(next=>{const b=next.batches.find(b=>b.id===input.id);b.status=input.status;b.version++;b.updatedAt=now();if(input.status==='returned')b.returnReason=input.comment.trim();event(next,input.status,{batchId:b.id,label:b.title,comment:input.status==='returned'?input.comment.trim():undefined});return b});
  }
  function note(input){
    if(!products().some(p=>p.key===input.key))fail('Товар не найден',404);
    if(typeof input.text!=='string'||input.text.length>2000||!['normal','attention','purchase'].includes(input.flag))fail('Проверьте заметку и метку товара');
    const prior=state.notes[input.key]||{version:0};if(prior.version!==input.version)fail('Заметку уже изменили. Обновите каталог',409);
    return commit(next=>{const note={text:input.text.trim(),flag:input.flag,version:prior.version+1,updatedAt:now()};next.notes[input.key]=note;event(next,'note',{key:input.key,label:'Заметка к товару'});return note});
  }
  return {products,preview,create,transition,note,state:()=>({batches:state.batches,notes:state.notes,events:state.events,capabilities:{priceWrite:false,employeeAccounts:false}})};
};
module.exports.ManagementError=ManagementError;
module.exports.version=version;
