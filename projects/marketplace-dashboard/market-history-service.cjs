'use strict';
const path=require('node:path'),fs=require('node:fs');
const {Worker,isMainThread,parentPort,workerData}=require('node:worker_threads');
if(!isMainThread&&workerData?.marketHistory){
 const folder=path.join(workerData.privateDir,'history');fs.mkdirSync(folder,{recursive:true});
 const history=require('./market-history.cjs').create({dbFile:path.join(folder,'products.sqlite')});
 const archive=require('./market-history-archive.cjs').create({privateDir:workerData.privateDir,history});
 let scanError=null;
 const scan=()=>archive.scan().then(()=>{scanError=null}).catch(()=>{scanError='Фоновое сохранение истории временно недоступно. Последний успешный архив сохранён.'});void scan();
 const timer=setInterval(scan,60000);timer.unref();
 parentPort.on('message',message=>{
  try{
   let result;
   if(message.action==='status'){const facts=history.status();delete facts.dbFile;delete facts.path;result={archive:{...archive.status(),...(scanError?{lastError:scanError}:{})},facts}}
   else if(message.action==='report')result=history.report(message.options||{});
   else throw Error('Неизвестный запрос истории.');
   parentPort.postMessage({id:message.id,result});
  }catch(error){parentPort.postMessage({id:message.id,error:error.message})}
 });
}else{
 function create({privateDir}){
  let worker=null,failure=null,nextId=0,closed=false,restartTimer=null;const pending=new Map();
  function fail(){failure='База истории временно недоступна. Сохранённые данные остаются на диске.';for(const item of pending.values()){clearTimeout(item.timer);item.reject(Error(failure))}pending.clear()}
  function start(){
   if(worker||closed)return;
   failure=null;worker=new Worker(__filename,{workerData:{marketHistory:true,privateDir}});
   worker.on('message',message=>{const item=pending.get(message.id);if(!item)return;pending.delete(message.id);clearTimeout(item.timer);message.error?item.reject(Error(message.error)):item.resolve(message.result)});
   worker.on('error',fail);worker.on('exit',code=>{worker=null;if(code!==0)fail();if(!closed){restartTimer=setTimeout(start,30000);restartTimer.unref()}});worker.unref();
  }
  function call(action,options){
   if(closed)return Promise.reject(Error('Сервис истории остановлен.'));start();if(failure)return Promise.reject(Error(failure));
   return new Promise((resolve,reject)=>{const id=++nextId,timer=setTimeout(()=>{pending.delete(id);reject(Error('История ещё обрабатывается. Повторите запрос немного позже.'))},15000);pending.set(id,{resolve,reject,timer});worker.postMessage({id,action,options})});
  }
  start();return {status:()=>call('status'),report:options=>call('report',options),close:async()=>{closed=true;clearTimeout(restartTimer);const current=worker;worker=null;fail();if(current)await current.terminate()}};
 }
 module.exports={create};
}
