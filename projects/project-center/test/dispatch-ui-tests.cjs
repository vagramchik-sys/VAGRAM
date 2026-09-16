'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
class El{constructor(){this.children=[];this.listeners={};this.value='';this.dataset={};this.classList={toggle(){}};}append(...a){this.children.push(...a);}replaceChildren(...a){this.children=a;}addEventListener(t,f){this.listeners[t]=f;}querySelectorAll(){return this.children.flatMap(c=>[...(c.tag==='details'&&c.open?[c]:[]),...c.querySelectorAll()]);}reset(){}}
function setup(role='editor',available=true,projects=[]){
 const els=Object.fromEntries(['dispatch-form','dispatch-status','dispatch-create','dispatch-goal','dispatch-project','dispatch-runs','directors-refresh'].map(id=>[id,new El()]));let requests=[],timers=[];
 const ctx={document:{getElementById:id=>els[id],createElement:tag=>Object.assign(new El(),{tag})},fetch:(path,options)=>new Promise(resolve=>requests.push({path,options,resolve})),setTimeout:fn=>{timers.push(fn);return fn;},clearTimeout:fn=>{timers=timers.filter(f=>f!==fn);},location:{},console,crypto:{randomUUID:()=> '11111111-1111-4111-8111-111111111111'}};
 vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../dispatcher.js'),'utf8'),ctx);
 const reply=(n,data,status=200)=>requests[n].resolve({ok:status<400,status,json:async()=>data});
 reply(0,{directors:[{id:'general',title:'Генеральный'}],projects,user:{role},connection:{available,message:'Unavailable'}});
 return{els,requests,reply,timers:()=>timers,fire:()=>{const fn=timers.shift();if(fn)fn();}};
}
const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
const run=(status='planning')=>({id:'r1',goal:'<img onerror=alert(1)>',status,createdAt:'2026-09-16T12:00:00Z',tasks:status==='planned'?[{id:'t1',title:'Анализ',instruction:'Проверить',directorId:'general',status:'queued'}]:[]});
(async()=>{
 const x=setup();await flush();assert.equal(x.requests[1].path,'/api/dispatch');
 x.els['dispatch-goal'].value='Цель';const submit=x.els['dispatch-form'].listeners.submit({preventDefault(){}});
 x.reply(2,{run:run()},202);await flush();await submit;
 assert.equal(x.els['dispatch-runs'].children[0].children[0].children[0].textContent,'<img onerror=alert(1)>');
 x.reply(1,{runs:[]});await flush();assert.equal(x.els['dispatch-runs'].children[0].children[0].children[0].textContent,'<img onerror=alert(1)>');assert.ok(x.timers().length);
 x.fire();await flush();x.reply(3,{runs:[run('planned')]});await flush();
 const actions=x.els['dispatch-runs'].children[0].children.at(-1),start=actions.children[0];
 const first=start.onclick();await start.onclick();assert.equal(x.requests.length,5);x.reply(4,{run:run('running')},202);await flush();x.reply(5,{runs:[run('running')]});await first;assert.equal(x.els['dispatch-create'].disabled,true);
 const denied=setup('viewer');await flush();denied.reply(1,{runs:[]});await flush();assert.equal(denied.els['dispatch-create'].disabled,true);await denied.els['dispatch-form'].listeners.submit({preventDefault(){}});assert.equal(denied.requests.length,2);
 const missing=setup('editor',false);await flush();missing.reply(1,{runs:[]});await flush();assert.equal(missing.els['dispatch-create'].disabled,true);
 const retry=setup();await flush();retry.reply(1,{runs:[]});await flush();retry.els['dispatch-goal'].value='Не терять';let p=retry.els['dispatch-form'].listeners.submit({preventDefault(){}});retry.reply(2,{error:'Temporary'},503);await p;const firstId=JSON.parse(retry.requests[2].options.body).requestId;p=retry.els['dispatch-form'].listeners.submit({preventDefault(){}});assert.equal(JSON.parse(retry.requests[3].options.body).requestId,firstId);retry.reply(3,{error:'Temporary'},503);await p;assert.equal(retry.els['dispatch-goal'].value,'Не терять');
 const catalog=(projects,role='editor',available=true)=>({directors:[{id:'general',title:'Новый генеральный'}],projects,user:{role},connection:{available,message:'Provider disabled'}});
 const manual=setup('editor',true,[{id:'p1',name:'Первый'},{id:'p2',name:'Второй'}]);await flush();manual.reply(1,{runs:[]});await flush();
 manual.els['dispatch-goal'].value='Сохранить черновик';manual.els['dispatch-project'].value='p1';
 let update=manual.els['directors-refresh'].listeners.click();assert.equal(manual.requests[2].path,'/api/directors');assert.equal(manual.requests[3].path,'/api/dispatch');
 assert.equal(manual.els['dispatch-create'].disabled,true);
 // User can continue editing during GET; response must preserve the latest draft and selection.
 manual.els['dispatch-goal'].value='Продолженный черновик';manual.els['dispatch-project'].value='p2';
 manual.reply(2,catalog([{id:'p1',name:'Переименован'},{id:'p2',name:'Второй'},{id:'p3',name:'Новый'}]));manual.reply(3,{runs:[]});await update;
 assert.equal(manual.els['dispatch-goal'].value,'Продолженный черновик');assert.equal(manual.els['dispatch-project'].value,'p2');assert.deepEqual(manual.els['dispatch-project'].children.map(x=>x.value),['','p1','p2','p3']);
 update=manual.els['directors-refresh'].listeners.click();manual.reply(4,catalog([{id:'p1',name:'Первый'}]));manual.reply(5,{runs:[]});await update;
 assert.equal(manual.els['dispatch-project'].value,'p2');assert.equal(manual.els['dispatch-project'].children.at(-1).disabled,true);assert.match(manual.els['dispatch-status'].textContent,/больше недоступен/);assert.equal(manual.els['dispatch-create'].disabled,true);
 const count=manual.requests.length;await manual.els['dispatch-form'].listeners.submit({preventDefault(){}});assert.equal(manual.requests.length,count,'Deleted context must not submit as no-project');
 manual.els['dispatch-project'].value='';manual.els['dispatch-project'].listeners.change();assert.equal(manual.els['dispatch-create'].disabled,false);
 update=manual.els['directors-refresh'].listeners.click();manual.reply(6,catalog([],'viewer'));manual.reply(7,{runs:[]});await update;assert.equal(manual.els['dispatch-create'].disabled,true);
 update=manual.els['directors-refresh'].listeners.click();manual.reply(8,catalog([],'editor',false));manual.reply(9,{runs:[]});await update;assert.equal(manual.els['dispatch-create'].disabled,true);assert.match(manual.els['dispatch-status'].textContent,/Provider disabled/);
 update=manual.els['directors-refresh'].listeners.click();manual.reply(10,{error:'Catalogue offline'},503);manual.reply(11,{runs:[]});await update;assert.equal(manual.els['dispatch-create'].disabled,true);assert.equal(manual.els['dispatch-goal'].value,'Продолженный черновик');
 update=manual.els['directors-refresh'].listeners.click();manual.reply(12,catalog([]));manual.reply(13,{runs:[run('running')]});await update;
 manual.fire();await flush();assert.equal(manual.requests[14].path,'/api/dispatch');assert.equal(manual.requests.filter(x=>x.path==='/api/directors').length,7,'Polling must not fetch catalogue');manual.reply(14,{runs:[]});await flush();
 console.log('Dispatch UI tests passed: existing race/idempotency guards; manual catalogue+run refresh, latest draft/selection retention, deleted context blocked until explicit choice, role/provider updates, catalogue failure, run-only polling.');
})().catch(e=>{console.error(e);process.exitCode=1;});
