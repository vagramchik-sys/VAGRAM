'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const model=require('../dist/updates-model.js');
const fs=require('node:fs'),path=require('node:path');
const uiScript=fs.readFileSync(path.join(__dirname,'..','dist','updates.js'),'utf8');
const releaseNotes=JSON.parse(fs.readFileSync(path.join(__dirname,'..','release-notes.json'),'utf8'));
const entry=(id,status='progress',extra={})=>({id,status,title:'Задача '+id,details:'Описание',date:'2026-09-18T12:00:00Z',...extra});
const document=entries=>({updatedAt:'2026-09-18T12:10:00Z',entries});
test('legacy entries gain empty sections without invented progress or deadlines',()=>{
 const value=model.normalize(document([entry('legacy','ready',{date:'2026-09-18'})])),r=value.entries[0];
 assert.deepEqual(r.completed,[]);assert.deepEqual(r.remaining,[]);assert.deepEqual(r.dependencies,[]);assert.deepEqual(r.verification,[]);assert.equal(r.estimate,null);assert.deepEqual(model.estimate(r),{text:'Завершено',basis:null});
 const pending=model.normalize(document([entry('future','planned')])).entries[0];assert.deepEqual(model.estimate(pending),{text:'Срок пока не оценён',basis:null});assert.equal(Object.hasOwn(pending,'percent'),false);
});
test('ready entries with unfinished work, duplicate IDs and unknown statuses are rejected',()=>{
 assert.throws(()=>model.normalize(document([entry('bad','ready',{remaining:['Проверить запуск']})])),/невыполненные/);
 assert.throws(()=>model.normalize(document([entry('dup'),entry('dup','planned')])));
 for(const status of ['done','__proto__',''])assert.throws(()=>model.normalize(document([entry('bad',status)])));
 assert.throws(()=>model.normalize(document([entry('bad','progress',{date:'2026-02-30'})])));
});
test('search covers tasks, verification and dependencies; status counts reflect the query',()=>{
 const entries=model.normalize(document([entry('planned','planned',{remaining:['Расчёт истории']}),entry('working','progress',{verification:['Проверен РАСЧЕТ']}),entry('ready','ready',{completed:['Загрузка товаров']}),entry('blocked','blocked',{dependencies:[{label:'Готовый расчет от площадки'}]}),entry('review','verification',{title:'Расчёт каталога'})])).entries;
 const r=model.select(entries,{status:'progress',query:'расчёт'});assert.deepEqual(r.rows.map(i=>i.id),['working']);assert.equal(r.counts.all,4);assert.equal(r.counts.ready,0);assert.equal(r.counts.blocked,1);assert.equal(r.counts.verification,1);assert.equal(r.total,5);
 assert.deepEqual(model.select(entries,{query:'площадки расчет'}).rows.map(i=>i.id),['blocked']);assert.equal(model.select(entries,{status:'ready',query:'расчет'}).rows.length,0);
});
test('dependencies resolve locally and safely preserve missing, external-condition and self references',()=>{
 const entries=model.normalize(document([entry('a','planned',{dependencies:[{id:'b',label:'Закончить основу'},{id:'unknown',label:'Другая запись'},{label:'Подключение площадки'},{id:'a',label:'Текущая запись'},{id:'https://outside.example/path',label:'Непроверенный идентификатор'}]}),entry('b','ready')])).entries;
 const result=model.dependencies(entries.find(e=>e.id==='a'),entries);assert.equal(result[0].resolved,true);assert.equal(result[0].status,'ready');assert.equal(result[1].resolved,false);assert.equal(result[2].resolved,false);assert.equal(Object.hasOwn(result[2],'id'),false);assert.equal(result[3].self,true);assert.equal(result[4].resolved,false);assert.ok(result.every(r=>!Object.hasOwn(r,'href')));
});
test('provided estimates require their basis, and incomplete optional schema is rejected',()=>{
 const entries=model.normalize(document([entry('a','verification',{estimate:{text:'После проверки доступа',basis:'Зависит от подтверждения владельца'},verification:['Синтаксис проверен']})])).entries;assert.deepEqual(model.estimate(entries[0]),{text:'После проверки доступа',basis:'Зависит от подтверждения владельца'});
 for(const extra of [{estimate:{text:'Завтра'}},{estimate:{text:'Завтра',basis:''}},{completed:['']},{remaining:'Задача'},{verification:[42]},{dependencies:[{id:'a'}]}])assert.throws(()=>model.normalize(document([entry('bad','progress',extra)])));
});
test('new updates sort by updatedAt, preserve original timestamps and do not mutate input',()=>{
 const source=document([entry('old','ready',{date:'2026-09-16',updatedAt:'2026-09-18T12:05:01Z',completed:['Готово']}),entry('new','planned',{date:'2026-09-18T12:00:00Z'})]),before=JSON.stringify(source),result=model.normalize(source);assert.deepEqual(result.entries.map(e=>e.id),['old','new']);assert.equal(result.entries[0].date,'2026-09-16');assert.equal(result.entries[0].updatedAt,'2026-09-18T12:05:01Z');result.entries[0].completed.push('Локальное изменение');assert.equal(JSON.stringify(source),before);
});

test('returning to the tab and the existing refresh button force a journal check',()=>{
 assert.match(uiScript,/onVisibility=\(\)=>\{if\(!document\.hidden\)void refresh\(true\);\}/);
 assert.match(uiScript,/refreshView\?\.addEventListener\('click',onManualRefresh\)/);
 assert.match(uiScript,/refreshView\?\.removeEventListener\('click',onManualRefresh\)/);
 assert.match(uiScript,/Последнее изменение в журнале:/);
 assert.match(uiScript,/Последняя проверка новых записей:/);
});
test('journal contains the published marketplace, cache, category and data-loading changes',()=>{
 const value=model.normalize(releaseNotes),byId=new Map(value.entries.map(item=>[item.id,item]));
 for(const id of ['combined-ozon-wb-order-total','today-yesterday-report-cache','gray-gloves-category-merge','data-monitor-and-on-demand-reports'])assert.equal(byId.get(id)?.status,'ready');
 assert.match(byId.get('combined-ozon-wb-order-total').verification.join(' '),/6d7f4138/);
 assert.match(byId.get('data-monitor-and-on-demand-reports').verification.join(' '),/275002/);
 assert.ok(Date.parse(value.updatedAt)>Date.parse('2026-09-23T00:00:00Z'));
});
