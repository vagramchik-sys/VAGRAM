(function(root,factory){
 if(typeof module!=='undefined'&&module.exports)module.exports=factory;
 else root.PultPerformance=factory(root);
})(typeof window!=='undefined'?window:globalThis,function createPultPerformance(root){
 'use strict';
 const perf=root.performance,Observer=root.PerformanceObserver;
 const metrics={fcp:null,lcp:null,inp:null,route:null,routes:[]};
 const interactions=new Map(),observers=[];
 const copy=()=>JSON.parse(JSON.stringify(metrics));
 function publish(name){root.dispatchEvent?.(new root.CustomEvent('pult:performance',{detail:{name,metrics:copy()}}))}
 function observe(type,handler,options={type,buffered:true}){
  if(!Observer||!Observer.supportedEntryTypes?.includes(type))return;
  try{const observer=new Observer(list=>handler(list.getEntries()));observer.observe(options);observers.push(observer)}catch{}
 }
 observe('paint',entries=>{const entry=entries.find(item=>item.name==='first-contentful-paint');if(entry&&metrics.fcp===null){metrics.fcp=Math.round(entry.startTime);publish('fcp')}});
 observe('largest-contentful-paint',entries=>{const entry=entries.at(-1);if(entry){metrics.lcp=Math.round(entry.startTime);publish('lcp')}});
 observe('event',entries=>{
  for(const entry of entries){if(!entry.interactionId)continue;interactions.set(entry.interactionId,Math.max(interactions.get(entry.interactionId)||0,entry.duration))}
  if(!interactions.size)return;
  const values=[...interactions.values()].sort((a,b)=>b-a),index=Math.min(values.length-1,Math.floor(values.length/50));
  metrics.inp=Math.round(values[index]);publish('inp');
 },{type:'event',buffered:true,durationThreshold:40});
 function routeDone(event){
  const detail=event.detail||{},startedAt=Number(detail.startedAt);if(!Number.isFinite(startedAt)||!perf?.now)return;
  const raf=root.requestAnimationFrame||function(callback){return root.setTimeout(callback,0)};
  raf(()=>raf(()=>{
   const endedAt=perf.now(),route={view:detail.view||'',section:detail.section||'',duration:Math.round((endedAt-startedAt)*10)/10,startedAt};
   metrics.route=route;metrics.routes.push(route);if(metrics.routes.length>20)metrics.routes.shift();
   try{perf.measure('pult:route',{start:startedAt,end:endedAt,detail:{view:route.view,section:route.section}})}catch{}
   publish('route');
  }));
 }
 root.addEventListener?.('pult:view-change',routeDone);
 return {metrics,getMetrics:copy,destroy(){for(const observer of observers)observer.disconnect();root.removeEventListener?.('pult:view-change',routeDone)}};
});
