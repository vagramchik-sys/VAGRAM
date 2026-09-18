(function(root,factory){
 const model=factory();if(typeof module==='object'&&module.exports)module.exports=model;else root.PultUpdatesModel=model;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const statuses={planned:'План',progress:'В работе',verification:'Проверка',ready:'Готово',blocked:'Заблокировано'};
 const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
 const text=value=>typeof value==='string'&&value.trim().length>0;
 function timestamp(value){if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))return false;if(/^\d{4}-\d{2}-\d{2}$/.test(value))return new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;return /^\d{4}-\d{2}-\d{2}T/.test(value);}
 function normalize(value){
  if(!isObject(value)||!Array.isArray(value.entries)||value.entries.length>1000||(value.updatedAt!==undefined&&!timestamp(value.updatedAt)))throw Error('Сервер вернул неподдерживаемый журнал изменений.');
  const ids=new Set();
  const entries=value.entries.map(item=>{
   if(!isObject(item)||!text(item.id)||ids.has(item.id)||!text(item.title)||typeof item.details!=='string'||!Object.hasOwn(statuses,item.status)||!timestamp(item.date)||(item.updatedAt!==undefined&&!timestamp(item.updatedAt)))throw Error('В журнале есть неоднозначные или неполные записи.');
   ids.add(item.id);
   const arrays={};for(const name of ['completed','remaining','verification']){if(item[name]!==undefined&&(!Array.isArray(item[name])||item[name].some(v=>!text(v))))throw Error('Не подтверждён состав задач в журнале.');arrays[name]=(item[name]||[]).map(v=>v.trim());}
   if(item.status==='ready'&&arrays.remaining.length)throw Error('Завершённая запись содержит невыполненные задачи.');
   if(item.dependencies!==undefined&&(!Array.isArray(item.dependencies)||item.dependencies.some(d=>!isObject(d)||!text(d.label)||(d.id!==undefined&&!text(d.id)))))throw Error('Не подтверждён список зависимостей.');
   if(item.estimate!==undefined&&(!isObject(item.estimate)||!text(item.estimate.text)||!text(item.estimate.basis)))throw Error('Оценка срока не содержит текста и основания.');
   return {id:item.id,title:item.title.trim(),details:item.details.trim(),date:item.date,status:item.status,...(item.updatedAt?{updatedAt:item.updatedAt}:{}),...arrays,remaining:item.status==='ready'?[]:arrays.remaining,dependencies:(item.dependencies||[]).map(d=>({label:d.label.trim(),...(d.id?{id:d.id}:{})})),estimate:item.status==='ready'?null:item.estimate?{text:item.estimate.text.trim(),basis:item.estimate.basis.trim()}:null};
  });
  entries.sort((a,b)=>Date.parse(b.updatedAt||b.date)-Date.parse(a.updatedAt||a.date)||a.id.localeCompare(b.id,'ru'));
  return {entries,updatedAt:value.updatedAt||null};
 }
 const fold=value=>String(value).toLocaleLowerCase('ru-RU').replace(/ё/g,'е');
 function select(entries,{status='all',query=''}={}){
  if(status!=='all'&&!Object.hasOwn(statuses,status))status='all';
  const terms=fold(query).trim().split(/\s+/).filter(Boolean),counts={all:0,...Object.fromEntries(Object.keys(statuses).map(k=>[k,0]))};
  const matched=entries.filter(item=>{const haystack=fold([item.title,item.details,...item.completed,...item.remaining,...item.verification,...item.dependencies.map(d=>d.label),item.estimate?.text||'',item.estimate?.basis||''].join(' '));return terms.every(term=>haystack.includes(term));});
  for(const item of matched){counts.all++;counts[item.status]++;}
  return {rows:matched.filter(item=>status==='all'||item.status===status),counts,total:entries.length,matched:matched.length,status};
 }
 function dependencies(item,entries){
  const byId=new Map(entries.map(entry=>[entry.id,entry]));
  return item.dependencies.map(dependency=>{const target=dependency.id?byId.get(dependency.id):null;return {...dependency,resolved:!!target,self:target?.id===item.id,status:target?.status||null,title:target?.title||null};});
 }
 const estimate=item=>item.status==='ready'?{text:'Завершено',basis:null}:item.estimate||{text:'Срок пока не оценён',basis:null};
 return {statuses,normalize,select,dependencies,estimate};
});
