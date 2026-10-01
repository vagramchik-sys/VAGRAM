'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {createLocalReadonlyRecovery, processStopped} = require('../storage/acquisition/local-readonly-recovery.cjs');
const {createPostgresLiveScheduler} = require('../storage/acquisition/postgres-live-scheduler.cjs');
const gone = () => { throw Object.assign(new Error('gone'), {code:'ESRCH'}); };
const job = () => ({kind:'insights-today',storeId:'1',attemptId:crypto.randomUUID(),commandId:crypto.randomUUID(),timestamp:'2026-09-28T13:00:00Z',nextDueAt:'2026-09-28T13:00:00Z',state:'unknown',runnerId:null,documentRevision:'488',count:0,errorCodes:['UNKNOWN_OUTCOME'],stage:null,resolution:null});

test('only a confirmed absent local PID proves producer stopped', () => {
  assert.equal(processStopped('runtime-123', gone), true);
  assert.equal(processStopped('runtime-123', () => {}), false);
  assert.equal(processStopped('runtime-123', () => {throw Object.assign(Error(),{code:'EPERM'});}), false);
  for (const owner of [null,'foreign-worker','runtime-0','runtime--1','runtime-9999999999999999999']) assert.equal(processStopped(owner, gone), false);
});

test('only stopped read-only Ozon acquisition can settle, using original command', async () => {
  const calls=[];
  const recover=createLocalReadonlyRecovery({scheduler:{attemptOwner:async()=> 'runtime-123'},repository:{settleStoppedCommand:async input=>{calls.push(input);return{committed:false,revision:'488'};}},runnerId:'runtime-456',probe:gone});
  const attempt=job();
  assert.deepEqual(await recover(attempt),{committed:false,revision:'488'});
  assert.deepEqual(calls,[{storeId:'1',domain:'insights',commandId:attempt.attemptId,producerStopped:true}]);
  for(const kind of ['ozon-performance','costs-prices','wb-orders','derived-capture']) assert.equal(await recover({...attempt,kind}),null);
  assert.equal(calls.length,1);
});

test('market uses the live market receipt only after the original PID is absent',async()=>{
  const calls=[],attempt={...job(),kind:'market'};
  const recover=createLocalReadonlyRecovery({scheduler:{attemptOwner:async()=> 'runtime-123'},repository:{settleStoppedCommand:async input=>{calls.push(input);return{committed:false,revision:'488'};}},runnerId:'runtime-456',probe:gone});
  assert.deepEqual(await recover(attempt),{committed:false,revision:'488'});
  assert.deepEqual(calls,[{storeId:'1',domain:'market',commandId:attempt.attemptId,producerStopped:true}]);
});

test('Performance recovery uses its own publication locks and holds a live or unknown producer',async()=>{
  const calls=[],attempt={...job(),kind:'ozon-performance'};let owner='runtime-123',absent=false;
  const recover=createLocalReadonlyRecovery({scheduler:{attemptOwner:async()=>owner},repository:{settleStoppedCommand:async()=>assert.fail('wrong repository')},performanceRepository:{settleStoppedRefresh:async input=>{calls.push(input);return{committed:false,revision:'488'};}},runnerId:'runtime-456',probe:()=>{if(absent)gone();}});
  assert.equal(await recover(attempt),null);owner=null;absent=true;assert.equal(await recover(attempt),null);
  owner='runtime-123';assert.deepEqual(await recover(attempt),{committed:false,revision:'488'});
  assert.deepEqual(calls,[{storeId:'1',commandId:attempt.attemptId,expectedRevision:'488',producerStopped:true}]);
  owner='runtime-456';assert.equal(await recover(attempt),null);await recover(attempt,{finishedHere:true});assert.equal(calls.length,2);
});

test('live collector before its SQL publication cannot be resolved as absent',async()=>{
  let probes=0,settles=0;
  const recover=createLocalReadonlyRecovery({scheduler:{attemptOwner:async()=> 'runtime-123'},repository:{settleStoppedCommand:async()=>{settles++;}},runnerId:'runtime-456',probe:()=>{probes++;}});
  assert.equal(await recover(job()),null);
  assert.equal(probes,1);assert.equal(settles,0);
});

test('current or reused PID requires actual awaited completion in this runner',async()=>{
  let settles=0;
  const recover=createLocalReadonlyRecovery({scheduler:{attemptOwner:async()=> 'runtime-456'},repository:{settleStoppedCommand:async()=>{settles++;return{committed:true,revision:'489'};}},runnerId:'runtime-456',probe:gone});
  assert.equal(await recover(job()),null);
  assert.deepEqual(await recover(job(),{finishedHere:true}),{committed:true,revision:'489'});
  assert.equal(settles,1);
});

test('legacy unknown owner is read from matching transition by primary key',async()=>{
  const attempt=job(),queries=[];
  let rows=[{before_job:{...attempt,state:'running',runnerId:'runtime-123'},after_job:attempt}];
  const scheduler=createPostgresLiveScheduler({pool:{connect:async()=>{throw Error('unexpected');},query:async(sql,args)=>{queries.push({sql,args});return{rows};}}});
  assert.equal(await scheduler.attemptOwner(attempt),'runtime-123');
  assert.match(queries[0].sql,/WHERE command_id=\$1/u);assert.deepEqual(queries[0].args,[attempt.commandId]);
  assert.equal(await scheduler.attemptOwner({...attempt,runnerId:'runtime-456'}),'runtime-456');assert.equal(queries.length,1);
  rows=[];assert.equal(await scheduler.attemptOwner(attempt),null);
  rows=[{before_job:{...attempt,state:'running',runnerId:'runtime-123',attemptId:crypto.randomUUID()},after_job:attempt}];
  assert.equal(await scheduler.attemptOwner(attempt),null);
  rows=[{before_job:attempt,after_job:{...attempt,attemptId:crypto.randomUUID()}}];
  await assert.rejects(scheduler.attemptOwner(attempt),{code:'JOB_CONFLICT'});
});
