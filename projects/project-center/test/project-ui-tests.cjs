'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
class Element {
 constructor(){this.value='';this.children=[];this.listeners={};this.elements=[];this.classList={toggle(){}};this.style={};this.resets=0;}
 append(...values){this.children.push(...values);}replaceChildren(...values){this.children=values;}addEventListener(name,fn){this.listeners[name]=fn;}querySelector(){return null;}setAttribute(){}scrollIntoView(){}
 reset(){this.resets++;this.value='';this.listeners.reset?.();}
}
const els=new Map(),get=id=>{if(!els.has(id))els.set(id,new Element());return els.get(id);};
const requests=[];
const windowHandlers={};
const context={document:{getElementById:get,createElement:()=>new Element()},fetch:(url,options)=>new Promise(resolve=>requests.push({url,options,resolve})),confirm:()=>true,window:{addEventListener(){}},location:{},console};
const source=process.env.PROJECT_UI_SOURCE||path.join(__dirname,'../projects.js');
context.window.addEventListener=(name,handler)=>windowHandlers[name]=handler;
context.FormData=class {constructor(form){return new Map(Object.entries(form.data));}};
vm.runInNewContext(fs.readFileSync(source,'utf8'),context);
const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
const reply=(status,data)=>requests.at(-1).resolve({ok:status<400,status,json:async()=>data});
const empty={state:{items:[],tasks:[]},version:0,user:{role:'editor'}};
(async()=>{
 reply(200,empty);await flush();
 const form=get('project-form');form.value='Важный черновик';form.listeners.input();
 const failedRefresh=get('hub-refresh').onclick();
 assert.equal(form.resets,0,'Draft must remain while request is pending');
 reply(503,{error:'Нет связи'});await failedRefresh;
 assert.equal(form.value,'Важный черновик');assert.equal(form.resets,0);assert.match(get('hub-status').textContent,/Нет связи/);
 context.confirm=()=>false;const before=requests.length;await get('hub-refresh').onclick();assert.equal(requests.length,before);assert.equal(form.value,'Важный черновик');
 context.confirm=()=>true;const success=get('hub-refresh').onclick();reply(200,empty);await success;
 assert.equal(form.resets,1);assert.equal(form.value,'');assert.equal(get('hub-status').textContent,'Портфель обновлён.');
 form.data={name:'Тест сохранения',description:'',owner:'',status:'planned',dueDate:''};
 const saving=form.listeners.submit({preventDefault(){},currentTarget:form});
 assert.equal(get('hub-logout').disabled,true,'Logout must be disabled during save');
 const count=requests.length;await get('hub-logout').onclick();assert.equal(requests.length,count);
 let prevented=false;windowHandlers.beforeunload({preventDefault(){prevented=true;}});assert.equal(prevented,true);
 reply(200,{version:1});await saving;assert.equal(get('hub-logout').disabled,false);
 prevented=false;windowHandlers.beforeunload({preventDefault(){prevented=true;}});assert.equal(prevented,false);
 console.log('Project UI tests passed: pending/failed refresh preserves draft, cancelled refresh makes no request, successful refresh resets forms.');
})().catch(e=>{console.error(e);process.exitCode=1;});
