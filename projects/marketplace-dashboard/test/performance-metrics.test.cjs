'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),create=require('../dist/performance-metrics.js');
const rootDir=path.join(__dirname,'..');

function fixture(){
 const listeners=new Map(),observed=new Map(),measures=[];let now=100;
 class CustomEvent{constructor(type,options={}){this.type=type;this.detail=options.detail}}
 class PerformanceObserver{constructor(callback){this.callback=callback}observe(options){observed.set(options.type,{observer:this,options})}disconnect(){}}
 PerformanceObserver.supportedEntryTypes=['paint','largest-contentful-paint','event'];
 const root={CustomEvent,PerformanceObserver,performance:{now:()=>now,measure:(...args)=>measures.push(args)},requestAnimationFrame:callback=>callback(),setTimeout,
  addEventListener(type,listener){listeners.set(type,listener)},removeEventListener(type){listeners.delete(type)},dispatchEvent(event){listeners.get(event.type)?.(event)}};
 return {root,observed,measures,setNow:value=>{now=value}};
}

test('captures buffered FCP, current LCP and p98 interaction latency',()=>{
 const f=fixture(),api=create(f.root);
 assert.equal(f.observed.get('event').options.durationThreshold,40);
 f.observed.get('paint').observer.callback({getEntries:()=>[{name:'first-contentful-paint',startTime:123.4}]});
 f.observed.get('largest-contentful-paint').observer.callback({getEntries:()=>[{startTime:456.7}]});
 const interactions=Array.from({length:51},(_,index)=>({interactionId:index+1,duration:index+10}));
 f.observed.get('event').observer.callback({getEntries:()=>interactions});
 assert.deepEqual(api.getMetrics(),{fcp:123,lcp:457,inp:59,route:null,routes:[]});
});

test('leaves unsupported or not-yet-observed metrics null',()=>{
 const root={PerformanceObserver:class{static supportedEntryTypes=[]},performance:{now:()=>0},addEventListener(){},removeEventListener(){}};
 assert.deepEqual(create(root).getMetrics(),{fcp:null,lcp:null,inp:null,route:null,routes:[]});
});

test('records route-to-next-paint duration and keeps it in the performance timeline',()=>{
 const f=fixture(),api=create(f.root);f.setNow(125.25);
 f.root.dispatchEvent(new f.root.CustomEvent('pult:view-change',{detail:{view:'analytics',section:'',startedAt:100}}));
 assert.equal(api.metrics.route.duration,25.3);assert.equal(api.metrics.route.view,'analytics');
 assert.equal(f.measures.length,1);assert.equal(f.measures[0][0],'pult:route');assert.deepEqual(f.measures[0][1].detail,{view:'analytics',section:''});
});

test('dashboard loads metrics before route layout and supplies route start times',()=>{
 const html=fs.readFileSync(path.join(rootDir,'dist','index.html'),'utf8'),layout=fs.readFileSync(path.join(rootDir,'dist','page-layout.js'),'utf8');
 assert.ok(html.indexOf('/performance-metrics.js')<html.indexOf('/page-layout.js'));
 assert.match(layout,/pult:view-change[^\n]+startedAt/);assert.match(layout,/const startedAt=performance\.now\(\)/);
});
