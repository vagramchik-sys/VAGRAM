'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
class El{constructor(){this.children=[];this.listeners={};this.value='';this.dataset={};this.classList={toggle(){}};}append(...a){this.children.push(...a);}replaceChildren(...a){this.children=a;}addEventListener(t,f){this.listeners[t]=f;}querySelectorAll(){return this.children.flatMap(c=>[...(c.tag==='details'&&c.open?[c]:[]),...c.querySelectorAll()]);}reset(){}}
function setup(role='editor',available=true){
 const els=Object.fromEntries(['dispatch-form','dispatch-status','dispatch-create','dispatch-goal','dispatch-project','dispatch-runs','directors-refresh'].map(id=>[id,new El()]));let requests=[],timers=[];
 const ctx={document:{getElementById:id=>els[id],createElement:tag=>Object.assign(new El(),{tag})},fetch:(path,options)=>new Promise(resolve=>requests.push({path,options,resolve})),setTimeout:fn=>{timers.push(fn);return fn;},clearTimeout:fn=>{timers=timers.filter(f=>f!==fn);},location:{},console,crypto:{randomUUID:()=> '11111111-1111-4111-8111-111111111111'}};
 vm.runInNewContext(fs.readFileSync('./dispatcher.js','utf8'),ctx);
 const reply=(n,data,status=200)=>requests[n].resolve({ok:status<400,status,json:async()=>data});
 reply(0,{directors:[{id:'general',title:'Генеральный'}],projects:[],user:{role},connection:{available,message:'Unavailable'}});
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
 console.log('Dispatch UI tests passed: stale GET after POST, accepted run polling, duplicate start, text safety, viewer/provider guards, retry idempotency and draft retention.');
})().catch(e=>{console.error(e);process.exitCode=1;});
