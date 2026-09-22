'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createFinanceDocumentStore}=require('../storage/postgres-finance-documents.cjs');
const {sourceKey}=require('../storage/postgres-document-import.cjs');
const {encodeJson}=require('../storage/postgres-json-repository.cjs');
const {extractDraft}=require('../finance-module.cjs');
const C1='11111111-1111-4111-8111-111111111111',C2='22222222-2222-4222-8222-222222222222',C3='33333333-3333-4333-8333-333333333333';
const at='2026-09-22T12:00:00.000Z',bytes=Buffer.from('%PDF-synthetic contract');
const extracted={pages:[{page:1,text:'Договор займа № T-1 от 01.09.2026\nКредитор: Синтетический банк\nСумма займа: 1000 рублей\nПроцентная ставка: 12 % годовых'}],warnings:[]};
function memory(){const docs=new Map(),receipts=new Map();const stateStore={async read(key){return docs.get(key)||null}};const batch={
  async readReceipt(x){const old=receipts.get(x.batchId);if(!old)return null;if(old.intent!==x.intentSha256)throw Object.assign(Error('intent'),{code:'COMMAND_ID_REUSED'});return{replayed:true,duplicate:old.duplicate,expectedRevisions:old.before,revisions:old.after,members:old.members}},
  async writeDocuments(x){const old=receipts.get(x.batchId);if(old){if(old.intent!==x.intentSha256)throw Object.assign(Error('intent'),{code:'COMMAND_ID_REUSED'});return{replayed:true,revisions:old.after}}const before=[],after=[];for(const w of x.writes){const oldDoc=docs.get(w.logicalKey),rev=oldDoc?String(oldDoc.revision):'0';if(rev!==w.expectedRevision)throw Object.assign(Error('conflict'),{code:'REVISION_CONFLICT'});before.push(rev);const next=String(BigInt(rev)+1n);after.push(next);docs.set(w.logicalKey,{logicalKey:w.logicalKey,mediaType:w.mediaType,content:Buffer.from(w.content),sha256:crypto.createHash('sha256').update(w.content).digest(),revision:next,deleted:false,sourcePath:w.sourceMapping.sourcePath})}const members=x.writes.map(w=>({commandId:w.commandId,logicalKey:w.logicalKey,sourcePath:w.sourceMapping.sourcePath,mediaType:w.mediaType}));receipts.set(x.batchId,{intent:x.intentSha256,duplicate:x.duplicate,before,after,members});return{replayed:false,revisions:after}},
  async listDocuments(){return[...docs.values()].filter(x=>x.sourcePath.endsWith('.json'))}
 };return{docs,receipts,stateStore,batch}}

test('finance upload copies bytes, validates review extraction, and durable retry skips extraction',async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pult-finance-sql-'));try{const mem=memory();let calls=0,release;const gate=new Promise(r=>release=r);const api=createFinanceDocumentStore({stateStore:mem.stateStore,batch:{...mem.batch,async readReceipt(x){await gate;return mem.batch.readReceipt(x)}},tempRoot:temp,extractFile:async(kind,file)=>{calls++;assert.equal(kind,'pdf');assert.deepEqual(fs.readFileSync(file),bytes);return extracted}});
  const caller=Buffer.from(bytes),pending=api.upload({exactBytes:caller,fileName:'contract.pdf',contentType:'application/pdf',commandId:C1,capturedAt:at});caller.fill(0);release();const first=await pending;assert.equal(first.duplicate,false);assert.equal(first.fields.annualRatePercent.value,12);assert.equal(calls,1);
  const replay=await api.upload({exactBytes:bytes,fileName:'contract.pdf',contentType:'application/pdf',commandId:C1,capturedAt:at});assert.equal(replay.replayed,true);assert.equal(calls,1);
  await assert.rejects(api.upload({exactBytes:bytes,fileName:'renamed.pdf',contentType:'application/pdf',commandId:C1,capturedAt:at}),{code:'COMMAND_ID_REUSED'});assert.equal(calls,1);
  const duplicate=await api.upload({exactBytes:bytes,fileName:'other.pdf',contentType:'application/pdf',commandId:C2,capturedAt:'2026-09-22T13:00:00.000Z'});assert.equal(duplicate.duplicate,true);assert.equal(calls,1);assert.equal(mem.receipts.size,2);
  const duplicateReplay=await api.upload({exactBytes:bytes,fileName:'other.pdf',contentType:'application/pdf',commandId:C2,capturedAt:'2026-09-22T13:00:00.000Z'});assert.equal(duplicateReplay.duplicate,true);assert.equal(duplicateReplay.replayed,true);
  assert.equal((await api.drafts()).length,1);assert.deepEqual(fs.readdirSync(temp),[]);
 }finally{fs.rmSync(temp,{recursive:true,force:true})}
});

test('an imported legacy random UUID draft is reused by SHA without OCR or new paths',async()=>{
 const mem=memory(),id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',hash=crypto.createHash('sha256').update(bytes).digest('hex'),draft=extractDraft(extracted.pages,'legacy.pdf',hash,[]),meta={id,fileName:'legacy.pdf',format:'pdf',size:bytes.length,hash,createdAt:at,...draft},metadata=encodeJson(meta),record=(sourcePath,mediaType,content)=>({sourcePath,logicalKey:sourceKey(sourcePath),mediaType,content,sha256:crypto.createHash('sha256').update(content).digest(),revision:'1',deleted:false});
 mem.docs.set(sourceKey(`loan-contracts/${id}.pdf`),record(`loan-contracts/${id}.pdf`,'application/pdf',bytes));mem.docs.set(sourceKey(`loan-contracts/${id}.json`),record(`loan-contracts/${id}.json`,'application/json',metadata));let calls=0;
 const api=createFinanceDocumentStore({stateStore:mem.stateStore,batch:mem.batch,extractFile:async()=>{calls++;return extracted}}),result=await api.upload({exactBytes:bytes,fileName:'copy.pdf',contentType:'application/pdf',commandId:C1,capturedAt:'2026-09-22T14:00:00.000Z'});
 assert.equal(result.id,id);assert.equal(result.duplicate,true);assert.equal(calls,0);assert.equal(mem.docs.size,2);assert.equal(mem.receipts.size,1);
});

test('invalid type, magic, size, and extraction result fail before durable writes',async()=>{
 const mem=memory(),api=createFinanceDocumentStore({stateStore:mem.stateStore,batch:mem.batch,extractFile:async()=>({pages:new Array(11).fill({text:''}),warnings:[]})});
 await assert.rejects(api.upload({exactBytes:bytes,fileName:'x.docx',contentType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',commandId:C1,capturedAt:at}),{code:'MAGIC_MISMATCH'});
 await assert.rejects(api.upload({exactBytes:bytes,fileName:'../x.pdf',contentType:'application/pdf',commandId:C1,capturedAt:at}),{code:'INVALID_FILE'});
 await assert.rejects(api.upload({exactBytes:bytes,fileName:'x.pdf',contentType:'image/png',commandId:C1,capturedAt:at}),{code:'MEDIA_MISMATCH'});
 await assert.rejects(api.upload({exactBytes:bytes,fileName:'x.pdf',contentType:'application/pdf',commandId:C1,capturedAt:at}),{code:'EXTRACTION_INVALID'});assert.equal(mem.receipts.size,0);
});

test('unknown commit is resolved from its durable receipt without a second extraction',async()=>{
 const mem=memory();let calls=0,unknown=true;const batch={...mem.batch,async writeDocuments(input){const result=await mem.batch.writeDocuments(input);if(unknown){unknown=false;throw Object.assign(Error('unknown'),{code:'OUTCOME_UNKNOWN'})}return result}};
 const api=createFinanceDocumentStore({stateStore:mem.stateStore,batch,extractFile:async()=>{calls++;return extracted}});
 const first=await api.upload({exactBytes:bytes,fileName:'contract.pdf',contentType:'application/pdf',commandId:C1,capturedAt:at});assert.equal(first.replayed,true);assert.equal(calls,1);
 const retry=await api.upload({exactBytes:bytes,fileName:'contract.pdf',contentType:'application/pdf',commandId:C1,capturedAt:at});assert.equal(retry.id,first.id);assert.equal(retry.replayed,true);assert.equal(calls,1);
});

const ownerUrl=process.env.PULT_TEST_DATABASE_URL,restrictedUrl=process.env.PULT_TEST_RESTRICTED_DATABASE_URL;
test('PostgreSQL integration: restricted upload stores exact pair atomically and duplicates get receipts',{skip:!ownerUrl||!restrictedUrl},async()=>{
 const {Pool}=require('pg'),owner=new Pool({connectionString:ownerUrl}),app=new Pool({connectionString:restrictedUrl}),schema=`finance_${crypto.randomBytes(8).toString('hex')}`,temp=fs.mkdtempSync(path.join(os.tmpdir(),'pult-finance-pg-'));let made=false;
 try{await owner.query(require('../storage/postgres-schema.cjs').replaceAll('pult',schema));await owner.query(require('../storage/postgres-document-schema.cjs').replaceAll('pult',schema));made=true;const role=(await app.query('SELECT current_user name')).rows[0].name,qrole='"'+role.replaceAll('"','""')+'"',qs='"'+schema+'"';
  await owner.query(`GRANT USAGE ON SCHEMA ${qs} TO ${qrole}; GRANT SELECT,INSERT,UPDATE ON ${qs}.document_states TO ${qrole}; GRANT SELECT,INSERT ON ${qs}.commands,${qs}.source_files TO ${qrole}; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${qs} TO ${qrole}`);
  const state=require('../storage/postgres-state.cjs').createStateStore({pool:app,schema}),batch=require('../storage/postgres-state-batch.cjs').createStateBatch({pool:app,schema});let calls=0;const api=createFinanceDocumentStore({stateStore:state,batch,tempRoot:temp,extractFile:async()=>{calls++;return extracted}});
  const first=await api.upload({exactBytes:bytes,fileName:'contract.pdf',contentType:'application/pdf',commandId:C1,capturedAt:at});assert.equal(first.duplicate,false);assert.equal(calls,1);
  assert.equal((await api.upload({exactBytes:bytes,fileName:'contract.pdf',contentType:'application/pdf',commandId:C1,capturedAt:at})).replayed,true);assert.equal(calls,1);
  const duplicate=await api.upload({exactBytes:bytes,fileName:'copy.pdf',contentType:'application/pdf',commandId:C2,capturedAt:'2026-09-22T13:00:00.000Z'});assert.equal(duplicate.id,first.id);assert.equal(duplicate.duplicate,true);assert.equal(calls,1);
  const duplicateReplay=await api.upload({exactBytes:bytes,fileName:'copy.pdf',contentType:'application/pdf',commandId:C2,capturedAt:'2026-09-22T13:00:00.000Z'});assert.equal(duplicateReplay.duplicate,true);assert.equal(duplicateReplay.replayed,true);assert.equal(calls,1);
  assert.equal((await owner.query(`SELECT count(*)::int n FROM ${qs}.commands`)).rows[0].n,4);assert.equal((await owner.query(`SELECT count(*)::int n FROM ${qs}.document_states WHERE revision=2`)).rows[0].n,2);
  const binary=await state.read(sourceKey(`loan-contracts/${first.id}.pdf`));assert.deepEqual(binary.content,bytes);assert.equal((await api.drafts()).length,1);
  const legacyBytes=Buffer.from('%PDF-imported legacy'),legacyHash=crypto.createHash('sha256').update(legacyBytes).digest('hex'),legacyId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',legacyMeta=encodeJson({id:legacyId,fileName:'legacy.pdf',format:'pdf',size:legacyBytes.length,hash:legacyHash,createdAt:at,...extractDraft(extracted.pages,'legacy.pdf',legacyHash,[])});
  for(const [sourcePath,mediaType,content] of [[`loan-contracts/${legacyId}.pdf`,'application/pdf',legacyBytes],[`loan-contracts/${legacyId}.json`,'application/json',legacyMeta]]){const key=sourceKey(sourcePath),sha=crypto.createHash('sha256').update(content).digest();await owner.query(`INSERT INTO ${qs}.document_states(logical_key,media_type,content,sha256,revision,deleted) VALUES($1,$2,$3,$4,1,false)`,[key,mediaType,content,sha]);await owner.query(`INSERT INTO ${qs}.source_files(source_path,logical_key,domain,media_type,source_bytes,source_sha256,baseline_present) VALUES($1,$2,'documents',$3,$4,$5,true)`,[sourcePath,key,mediaType,content.length,sha]);}
  const importedDuplicate=await api.upload({exactBytes:legacyBytes,fileName:'legacy-copy.pdf',contentType:'application/pdf',commandId:C3,capturedAt:'2026-09-22T14:00:00.000Z'});assert.equal(importedDuplicate.id,legacyId);assert.equal(importedDuplicate.duplicate,true);assert.equal(calls,1);
  assert.equal((await owner.query(`SELECT count(*)::int n FROM ${qs}.document_states`)).rows[0].n,4);assert.equal((await owner.query(`SELECT count(*)::int n FROM ${qs}.commands`)).rows[0].n,6);
 }finally{if(made)await owner.query(`DROP SCHEMA "${schema}" CASCADE`);await app.end();await owner.end();fs.rmSync(temp,{recursive:true,force:true})}
});
