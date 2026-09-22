'use strict';
const { createJsonDocumentRepository } = require('../postgres-json-repository.cjs');
const { sourceKey } = require('../postgres-document-import.cjs');
const SOURCE = 'runtime-schedules.json', KEY = sourceKey(SOURCE), STATES = new Set(['queued','running','partial','done','error','unknown']);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
class SchedulerError extends Error { constructor(code,message){super(message);this.name='SchedulerError';this.code=code;} }
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
function valid(value){return object(value)&&value.version===1&&object(value.jobs)&&Object.entries(value.jobs).every(([key,j])=>key===`${j.kind}:${j.storeId}`&&/^[a-z][a-z0-9-]{0,40}$/u.test(j.kind)&&/^(?:wb-)?[0-9]+$/u.test(j.storeId)&&STATES.has(j.state)&&UUID.test(j.attemptId)&&UUID.test(j.commandId)&&Number.isFinite(Date.parse(j.timestamp))&&Number.isFinite(Date.parse(j.nextDueAt))&&Array.isArray(j.errorCodes)&&(j.runnerId==null||typeof j.runnerId==='string')&&(j.resolution==null||j.resolution?.outcome==='not-committed'&&UUID.test(j.resolution.attemptId)));}
function createPostgresScheduler({stateStore,repository=createJsonDocumentRepository({stateStore,logicalKey:KEY,sourcePath:SOURCE,validate:valid})}={}){
  if(!repository?.read||!repository?.compareAndSet||!repository?.readCommand)throw new TypeError('scheduler repository is required');
  async function load(){const row=await repository.read();return row&&!row.deleted?{value:structuredClone(row.value),revision:row.revision}:{value:{version:1,jobs:{}},revision:'0'};}
  async function transition({kind,storeId,expectedRevision,commandId,attemptId,timestamp,nextDueAt,state,stage=null,count=0,errorCodes=[],documentRevision=null,runnerId=null,expectedAttemptId,expectedState,expectedRunnerId,resolution=null}={}){
    const intent={kind,storeId,attemptId,commandId,timestamp,nextDueAt,state,stage,count,errorCodes,documentRevision,runnerId,resolution};
    const prior=await repository.readCommand(commandId);if(prior){const before=prior.before.value?.jobs?.[`${kind}:${storeId}`],got=prior.after.value.jobs[`${kind}:${storeId}`];if(prior.before.revision!==String(expectedRevision)||expectedAttemptId!==undefined&&before?.attemptId!==expectedAttemptId||expectedState!==undefined&&before?.state!==expectedState||expectedRunnerId!==undefined&&(before?.runnerId??null)!==expectedRunnerId||JSON.stringify(got)!==JSON.stringify(intent))throw new SchedulerError('COMMAND_ID_REUSED','Scheduler command intent differs');return{revision:prior.after.revision,replayed:true,job:structuredClone(got)};}
    if(!valid({version:1,jobs:{[`${kind}:${storeId}`]:intent}})||!Number.isSafeInteger(count)||count<0||!errorCodes.every(v=>typeof v==='string'&&/^[A-Z0-9_]{1,80}$/u.test(v)))throw new SchedulerError('INVALID_ARGUMENT','Scheduler transition is invalid');
    const loaded=await load(),current=loaded.value.jobs[`${kind}:${storeId}`];
    if(expectedAttemptId!==undefined&&current?.attemptId!==expectedAttemptId||expectedState!==undefined&&current?.state!==expectedState||expectedRunnerId!==undefined&&(current?.runnerId??null)!==expectedRunnerId)throw new SchedulerError('JOB_CONFLICT','Scheduler job changed concurrently');
    if(current?.state==='unknown'&&state==='running')throw new SchedulerError('UNKNOWN_OUTCOME_HOLD','Unknown attempt requires same-command resolution');
    if(current?.state==='unknown'&&state==='queued'&&!(resolution?.attemptId===current.attemptId&&resolution?.outcome==='not-committed'))throw new SchedulerError('UNKNOWN_OUTCOME_HOLD','Unknown attempt requires explicit resolution');
    const next=structuredClone(loaded.value);next.jobs[`${kind}:${storeId}`]=intent;
    const result=await repository.compareAndSet(next,{expectedRevision,commandId});return{...result,job:structuredClone(intent)};
  }
  async function jobsProvider(){const {value}=await load(),selected=new Map();for(const j of Object.values(value.jobs)){const prior=selected.get(j.storeId);if(!prior||j.state==='running'&&prior.state!=='running'||j.timestamp>prior.timestamp)selected.set(j.storeId,j);}return Object.fromEntries([...selected].map(([id,j])=>[id,{status:j.state,stage:j.stage,count:j.count,startedAt:j.state==='running'?j.timestamp:null,finishedAt:['done','partial','error'].includes(j.state)?j.timestamp:null,nextDueAt:j.nextDueAt}]));}
  return Object.freeze({load,transition,jobsProvider,sourcePath:SOURCE});
}
module.exports={createPostgresScheduler,SchedulerError};
