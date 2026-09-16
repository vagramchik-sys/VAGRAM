'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {EventEmitter}=require('node:events');
const cp=require('node:child_process');
process.env.OZON_DATA_DIR=fs.mkdtempSync(path.join(__dirname,'ai-errors-test-'));
process.env.DIRECTOR_CODEX_PATH=process.execPath;
let mode='exit';
cp.spawn=(_exe,args)=>{
  const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
  child.kill=()=>{};
  child.stdin.end=()=>queueMicrotask(()=>{
    if(mode==='launch')return child.emit('error',new Error('PRIVATE_SECRET'));
    if(mode==='limit'){child.stderr.emit('data',Buffer.alloc(2*1024*1024+1));return child.emit('close',1);}
    if(mode==='exit'){child.stderr.emit('data',Buffer.from('PRIVATE_SECRET'));return child.emit('close',42);}
    if(mode==='ok')fs.writeFileSync(args[args.indexOf('--output-last-message')+1],'Готово');
    child.emit('close',0);
  });return child;
};
const adapter=require('../ai-directors.cjs');
const {publicMessage,codeOf}=require('../ai-errors.cjs');
const input={director:{title:'Test'},history:[{role:'user',text:'PRIVATE_PROMPT'}]};
const logs=[];const oldError=console.error;console.error=x=>logs.push(x);
(async()=>{
  for(const [scenario,expected] of [['exit','AI_PROCESS_EXIT'],['launch','AI_LAUNCH'],['limit','AI_OUTPUT_LIMIT'],['empty','AI_EMPTY']]){
    mode=scenario;await assert.rejects(adapter.generate(input),e=>{assert.equal(e.code,expected);assert.ok(publicMessage(e).includes(expected));return true;});
  }
  mode='ok';assert.equal(await adapter.generate(input),'Готово');
  assert.equal(logs.length,4);assert.equal(JSON.parse(logs[0]).exitCode,42);
  assert.ok(!logs.join('').includes('PRIVATE'));
  assert.equal(codeOf({code:'__proto__',message:'PRIVATE'}),'AI_UNKNOWN');
  assert.ok(!publicMessage(new Error('PRIVATE')).includes('PRIVATE'));
  assert.equal(fs.readdirSync(path.join(process.env.OZON_DATA_DIR,'ai-runs')).length,0);
  console.log('AI error tests passed: launch, exit code, output limit, empty output, success, redaction and cleanup.');
})().catch(e=>{oldError(e);process.exitCode=1;}).finally(()=>{console.error=oldError;});
