'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createStateBatch}=require('../storage/postgres-state-batch.cjs');
const {requestHash}=require('../storage/postgres-state.cjs');
const {sourceKey}=require('../storage/postgres-document-import.cjs');
const C1='11111111-1111-4111-8111-111111111111', C2='22222222-2222-4222-8222-222222222222', C3='33333333-3333-4333-8333-333333333333';
const intent='a'.repeat(64);
const mapping=(p,m)=>({sourcePath:p,logicalKey:sourceKey(p),domain:'documents',mediaType:m});
function writes(){return [{commandId:C2,logicalKey:sourceKey('loan-contracts/a.pdf'),sourceMapping:mapping('loan-contracts/a.pdf','application/pdf'),mediaType:'application/pdf',content:Buffer.from('%PDF-x'),expectedRevision:'0'},{commandId:C3,logicalKey:sourceKey('loan-contracts/a.json'),sourceMapping:mapping('loan-contracts/a.json','application/json'),mediaType:'application/json',content:Buffer.from('{}'),expectedRevision:'0'}]}

test('batch validates complete durable membership and never locks source_files rows',async()=>{
 const calls=[];const client={async query(sql,args){calls.push({sql,args});if(sql.includes('FROM "pult"."commands"'))return{rows:[]};if(sql.includes('COALESCE(sum'))return{rows:[{bytes:'0'}]};if(sql.includes('FROM "pult"."document_states"'))return{rows:[]};if(sql.includes('FROM "pult"."source_files"'))return{rows:[]};return{rows:[]}},release(d=false){calls.push({release:true,d})}};
 const result=await createStateBatch({pool:{connect:async()=>client,query:(...x)=>client.query(...x)}}).writeDocuments({batchId:C1,intentSha256:intent,writes:writes(),capacity:{prefix:'loan-contracts/',maxBytes:1000}});
 assert.deepEqual(result,{replayed:false,revisions:['1','1']});assert.equal(calls.filter(x=>x.sql?.includes('INSERT INTO "pult"."commands"')).length,2);assert.equal(calls.some(x=>x.sql?.includes('source_files')&&x.sql.includes('FOR UPDATE')),false);
 const receipts=calls.filter(x=>x.sql?.includes('INSERT INTO "pult"."commands"')).map(x=>JSON.parse(x.args[12]));assert.equal(receipts.length,2);assert.equal(receipts[0].batchId,C1);assert.equal(receipts[0].intentSha256,intent);assert.equal(receipts[0].memberCount,2);assert.match(receipts[0].membersSha256,/^[a-f0-9]{64}$/);assert.deepEqual(receipts[1],receipts[0]);
});

test('partial receipt and changed intent fail closed',async()=>{
 const membersSha256=crypto.createHash('sha256').update([C2,C3].sort().join('\n')).digest('hex'),row={command_id:C2,before_revision:'0',after_revision:'1',result_json:{batchId:C1,intentSha256:intent,memberCount:2,membersSha256}};
 const pool={query:async()=>({rows:[row]}),connect:async()=>{throw Error('unused')}};const batch=createStateBatch({pool});
 await assert.rejects(batch.readReceipt({batchId:C1,commandIds:[C2,C3],intentSha256:intent}),{code:'BATCH_INCOMPLETE'});
 pool.query=async()=>({rows:[row,{...row,command_id:C3}]});await assert.rejects(batch.readReceipt({batchId:C1,commandIds:[C2,C3],intentSha256:'b'.repeat(64)}),{code:'COMMAND_ID_REUSED'});
});

test('ambiguous COMMIT while replaying destroys the pooled connection',async()=>{
 const input=writes(),membersSha256=crypto.createHash('sha256').update([C2,C3].sort().join('\n')).digest('hex'),result_json={batchId:C1,intentSha256:intent,memberCount:2,membersSha256,duplicate:false},calls=[];
 const client={async query(sql,args){calls.push({sql,args});if(sql.includes('FROM "pult"."commands"'))return{rows:input.map(w=>({command_id:w.commandId,logical_key:w.logicalKey,media_type:w.mediaType,request_hash:requestHash('write',w.logicalKey,w.expectedRevision,w.mediaType,w.content),after_revision:'1',result_json}))};if(sql.startsWith('SELECT 1 FROM'))return{rows:[{}]};if(sql==='COMMIT')throw Object.assign(Error('lost'),{code:'ECONNRESET'});return{rows:[]}},release(d){calls.push({release:true,d})}};
 await assert.rejects(createStateBatch({pool:{connect:async()=>client}}).writeDocuments({batchId:C1,intentSha256:intent,writes:input}),{code:'OUTCOME_UNKNOWN'});assert.deepEqual(calls.at(-1),{release:true,d:true});
});

const ownerUrl=process.env.PULT_TEST_DATABASE_URL,restrictedUrl=process.env.PULT_TEST_RESTRICTED_DATABASE_URL;
test('PostgreSQL integration: restricted app role atomically writes and replays a document batch',{skip:!ownerUrl||!restrictedUrl},async()=>{
 const {Pool}=require('pg'),owner=new Pool({connectionString:ownerUrl}),app=new Pool({connectionString:restrictedUrl}),schema=`batch_${crypto.randomBytes(8).toString('hex')}`;let made=false;
 try{await owner.query(require('../storage/postgres-schema.cjs').replaceAll('pult',schema));await owner.query(require('../storage/postgres-document-schema.cjs').replaceAll('pult',schema));made=true;
  const role=(await app.query('SELECT current_user AS name')).rows[0].name,qrole='"'+role.replaceAll('"','""')+'"',qs='"'+schema+'"';
  await owner.query(`GRANT USAGE ON SCHEMA ${qs} TO ${qrole}; GRANT SELECT,INSERT,UPDATE ON ${qs}.document_states TO ${qrole}; GRANT SELECT,INSERT ON ${qs}.commands,${qs}.source_files TO ${qrole}; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${qs} TO ${qrole}`);
  const batch=createStateBatch({pool:app,schema}),input=writes();
  await owner.query(`CREATE FUNCTION ${qs}.reject_json() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.media_type='application/json' THEN RAISE EXCEPTION 'synthetic'; END IF; RETURN NEW; END$$; CREATE TRIGGER reject_json BEFORE INSERT OR UPDATE ON ${qs}.document_states FOR EACH ROW EXECUTE FUNCTION ${qs}.reject_json()`);
  await assert.rejects(batch.writeDocuments({batchId:C1,intentSha256:intent,writes:input,capacity:{prefix:'loan-contracts/',maxBytes:1000}}),{code:'DATABASE_ERROR'});
  assert.deepEqual((await owner.query(`SELECT (SELECT count(*)::int FROM ${qs}.document_states) states,(SELECT count(*)::int FROM ${qs}.commands) commands,(SELECT count(*)::int FROM ${qs}.source_files) sources`)).rows[0],{states:0,commands:0,sources:0});
  await owner.query(`DROP TRIGGER reject_json ON ${qs}.document_states; DROP FUNCTION ${qs}.reject_json()`);
  const first=await batch.writeDocuments({batchId:C1,intentSha256:intent,writes:input,capacity:{prefix:'loan-contracts/',maxBytes:1000}});assert.deepEqual(first,{replayed:false,revisions:['1','1']});
  assert.deepEqual(await batch.writeDocuments({batchId:C1,intentSha256:intent,writes:input,capacity:{prefix:'loan-contracts/',maxBytes:1000}}),{replayed:true,revisions:['1','1']});
  const receipt=await batch.readReceipt({batchId:C1,commandIds:[C2,C3],intentSha256:intent});assert.deepEqual(receipt.expectedRevisions,['0','0']);
  assert.equal((await owner.query(`SELECT count(*)::int n FROM ${qs}.commands`)).rows[0].n,2);
 }finally{if(made)await owner.query(`DROP SCHEMA "${schema}" CASCADE`);await app.end();await owner.end()}
});
