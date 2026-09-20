'use strict';
const fs=require('node:fs'),path=require('node:path');
const EMPTY={schemaVersion:1,revision:'legacy',reviewedAt:null,types:[],assignments:{},rules:[],available:false};
const clean=value=>typeof value==='string'?value.normalize('NFC').trim().replace(/\s+/gu,' '):'';
const normalized=value=>clean(value).toLocaleLowerCase('ru-RU').replace(/ё/g,'е');
function validate(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||input.schemaVersion!==1)throw Error('Справочник типов товаров имеет неподдерживаемую схему.');
 const revision=clean(input.revision),reviewedAt=clean(input.reviewedAt);if(!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(revision)||!Number.isFinite(Date.parse(reviewedAt)))throw Error('Проверьте версию и дату проверки справочника типов.');
 if(!Array.isArray(input.types)||!input.types.length)throw Error('Справочник типов товаров пуст.');
 const types=input.types.map(raw=>{if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(key=>!['id','parentId','name'].includes(key)))throw Error('Неподдерживаемые поля типа товара.');const id=clean(raw.id),name=clean(raw.name),parentId=raw.parentId===null?null:clean(raw.parentId);if(!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(id)||!name||name.length>120||parentId==='')throw Error('Проверьте id, название и родителя типа товара.');return {id,parentId,name}});
 const byId=new Map();for(const type of types){if(byId.has(type.id))throw Error('В справочнике повторяется id типа товара.');byId.set(type.id,type)}
 for(const type of types)if(type.parentId!==null&&!byId.has(type.parentId))throw Error('В справочнике указан неизвестный родитель типа товара.');
 for(const type of types){const seen=new Set([type.id]);let current=type;while(current.parentId!==null){if(seen.has(current.parentId))throw Error('В справочнике типов найден цикл.');seen.add(current.parentId);current=byId.get(current.parentId)}}
 const parents=new Set(types.map(type=>type.parentId).filter(Boolean)),assignments={};if(!input.assignments||typeof input.assignments!=='object'||Array.isArray(input.assignments))throw Error('Назначения типов товаров должны быть объектом.');
 for(const [productKey,raw] of Object.entries(input.assignments)){const compact=typeof raw==='string',value=compact?{typeId:raw,source:'reviewed',evidence:null}:raw;if(!/^[^:\s]+:[^:\s]+$/.test(productKey)||!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['typeId','source','evidence'].includes(key)))throw Error('Проверьте назначение типа товара.');const typeId=clean(value.typeId),source=clean(value.source),evidence=value.evidence==null?null:clean(value.evidence);if(!byId.has(typeId)||parents.has(typeId)||!source||source.length>80||evidence!==null&&evidence.length>500)throw Error('Назначение должно ссылаться на конечный тип и иметь источник.');assignments[productKey]={typeId,source,evidence}}
 const rules=(input.rules||[]).map(raw=>{if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(key=>!['id','leafTypeId','includeAny','includeAll','excludeAny'].includes(key)))throw Error('Неподдерживаемые поля правила типа товара.');const id=clean(raw.id),leafTypeId=clean(raw.leafTypeId),list=name=>{if(!Array.isArray(raw[name]||[]))throw Error('Фразы правила должны быть списком.');return [...new Set((raw[name]||[]).map(clean).filter(Boolean))]};const rule={id,leafTypeId,includeAny:list('includeAny'),includeAll:list('includeAll'),excludeAny:list('excludeAny')};if(!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(id)||!byId.has(leafTypeId)||parents.has(leafTypeId)||!rule.includeAny.length&&!rule.includeAll.length)throw Error('Правило должно ссылаться на конечный тип и содержать проверяемую фразу.');return rule});
 const ruleIds=new Set();for(const rule of rules){if(ruleIds.has(rule.id))throw Error('В справочнике повторяется id правила.');ruleIds.add(rule.id)}
 return {schemaVersion:1,revision,reviewedAt,types,assignments,rules,available:true};
}
function evidenceText(product){return normalized([product?.name,product?.title,product?.product_name,product?.offer_id,product?.vendorCode,product?.subjectName].filter(Boolean).join(' '))}
function classify(registry,productKey,product){
 const assignment=registry.assignments[productKey];if(assignment)return {typeId:assignment.typeId,source:assignment.source,evidence:assignment.evidence};
 const text=evidenceText(product);if(!text)return null;
 for(const rule of registry.rules){const any=!rule.includeAny.length||rule.includeAny.some(value=>text.includes(normalized(value))),all=rule.includeAll.every(value=>text.includes(normalized(value))),excluded=rule.excludeAny.some(value=>text.includes(normalized(value)));if(any&&all&&!excluded)return {typeId:rule.leafTypeId,source:'rule:'+rule.id,evidence:null}}
 return null;
}
function create({privateDir}){
 const file=path.join(privateDir,'product-type-registry.json');let cached=null,stamp=null;
 function read(){if(!fs.existsSync(file)){cached=EMPTY;stamp=null;return cached}const stat=fs.statSync(file),next=stat.size+':'+stat.mtimeMs;if(cached&&stamp===next)return cached;const value=validate(JSON.parse(fs.readFileSync(file,'utf8')));cached=value;stamp=next;return value}
 return {read,file};
}
module.exports={create,validate,classify,evidenceText,EMPTY};
