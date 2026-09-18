'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {BitrixClient}=require('../b2b-agent/bitrix.cjs');
const webhook='https://example.bitrix24.ru/rest/1/'+ 'synthetic_test_value/';
const ok=data=>({ok:true,json:async()=>data});
test('Bitrix only accepts exact HTTPS portal webhook shape',()=>{
 for(const value of ['http://example.bitrix24.ru/rest/1/token/','https://example.bitrix24.ru.evil.test/rest/1/token/','https://example.bitrix24.ru/rest/1/token/?q=1','https://user:pass@example.bitrix24.ru/rest/1/token/'])assert.throws(()=>new BitrixClient({webhook:value}));
});
test('deal list reads all pages and never treats truncated pagination as complete',async()=>{
 let calls=[];const c=new BitrixClient({webhook,fetchImpl:async(url,opt)=>{const p=JSON.parse(opt.body);calls.push(p);return ok(p.start===0?{result:[{ID:'1'}],next:50,total:2}:{result:[{ID:'2'}],total:2});}});
 assert.equal((await c.readCandidates(6,'C6:NEW')).length,2);assert.equal(calls[0].filter.CATEGORY_ID,6);assert.equal(calls[1].start,50);
 const bad=new BitrixClient({webhook,fetchImpl:async()=>ok({result:[{ID:'1'}],total:99})});await assert.rejects(bad.readCandidates(6,'C6:NEW'),/INCOMPLETE_PAGINATION/);
 const repeat=new BitrixClient({webhook,fetchImpl:async()=>ok({result:[{ID:'1'}],next:50})});await assert.rejects(repeat.readCandidates(6,'C6:NEW'),/UNSTABLE_PAGINATION/);
});
test('lead candidates request new leads with email and read every page',async()=>{
 let calls=[];const c=new BitrixClient({webhook,fetchImpl:async(url,opt)=>{const p=JSON.parse(opt.body);calls.push({url,p});return ok(p.start===0?{result:[{ID:'11'}],next:50,total:2}:{result:[{ID:'12'}],total:2});}});
 assert.deepEqual((await c.readLeadCandidates()).map(row=>row.ID),['11','12']);
 assert.ok(calls[0].url.endsWith('/crm.lead.list'));assert.deepEqual(calls[0].p.filter,{STATUS_ID:'NEW',HAS_EMAIL:'Y'});assert.equal(calls[1].p.start,50);
 assert.deepEqual(calls[0].p.select,['ID','TITLE','STATUS_ID','STATUS_SEMANTIC_ID','EMAIL','HAS_EMAIL','ASSIGNED_BY_ID','COMPANY_ID','CONTACT_ID','DATE_CREATE','DATE_MODIFY']);
});
test('lead get validates that Bitrix returned the requested lead',async()=>{
 let request;const c=new BitrixClient({webhook,fetchImpl:async(url,opt)=>{request={url,body:JSON.parse(opt.body)};return ok({result:{ID:'17',TITLE:'Лид'}});}});
 assert.equal((await c.readLead(17)).TITLE,'Лид');assert.ok(request.url.endsWith('/crm.lead.get'));assert.deepEqual(request.body,{id:17});
 const mismatch=new BitrixClient({webhook,fetchImpl:async()=>ok({result:{ID:'18'}})});await assert.rejects(mismatch.readLead(17),/INVALID_RESPONSE/);
});
test('transport errors never reveal webhook or retry an ambiguous send',async()=>{
 let calls=0;const c=new BitrixClient({webhook,fetchImpl:async()=>{calls++;throw Error(webhook);}});
 await assert.rejects(c.replyEmail({replyToMessageId:7,from:'sales@example.test',to:['buyer@example.test'],subject:'Re: Test',body:'Учебный ответ'}),e=>{assert.equal(e.outcome,'unknown');assert.ok(!e.message.includes('synthetic_test_value'));return true;});assert.equal(calls,1);
});
test('mail reply uses REST 3 and exactly one recipient',async()=>{
 let request;const c=new BitrixClient({webhook,fetchImpl:async(url,options)=>{request={url,body:JSON.parse(options.body)};return ok({result:{success:true,to:['buyer@example.test']}});}});
 await c.replyEmail({replyToMessageId:7,from:'sales@example.test',to:['buyer@example.test'],subject:'Re: Test',body:'Учебный ответ'});assert.ok(request.url.includes('/rest/api/'));assert.equal(request.body.replyToMessageId,7);
 await assert.rejects(c.replyEmail({replyToMessageId:7,from:'sales@example.test',to:['a@example.test','b@example.test'],subject:'Test',body:'Test'}));
});
test('email activity preserves provenance and does not invent original email ID or date',async()=>{
 let request;const c=new BitrixClient({webhook,fetchImpl:async(url,opt)=>{request=JSON.parse(opt.body);return ok({result:[{ID:8,TYPE_ID:4,DIRECTION:1,DESCRIPTION:'Текст',DESCRIPTION_TYPE:1,CREATED:'2026-09-18T12:00:00+03:00',COMMUNICATIONS:[{TYPE:'EMAIL',VALUE:'buyer@example.test'}],FILES:[],SETTINGS:{MESSAGE_FROM:'buyer@example.test',SECRET:'not_returned'}}],total:1});}});
 const [row]=await c.readEmailActivities(12);assert.deepEqual(request.filter.BINDINGS,[{OWNER_TYPE_ID:2,OWNER_ID:12}]);assert.equal(row.originalMessageDate,null);assert.equal(row.mailMessageId,null);assert.equal(row.createdAt,'2026-09-18T09:00:00.000Z');assert.ok(!JSON.stringify(row).includes('not_returned'));
});
test('lead email activities use lead owner binding and preserve normalization',async()=>{
 let request;const c=new BitrixClient({webhook,fetchImpl:async(url,opt)=>{request={url,body:JSON.parse(opt.body)};return ok({result:[{ID:9,TYPE_ID:4,DIRECTION:2,SUBJECT:'Ответ',DESCRIPTION:'Текст',DESCRIPTION_TYPE:1,CREATED:'2026-09-18T12:00:00+03:00',COMMUNICATIONS:[{TYPE:'EMAIL',VALUE:'buyer@example.test'}],FILES:[],SETTINGS:{MESSAGE_TO:'buyer@example.test'}}],total:1});}});
 const [row]=await c.readLeadEmailActivities(21);assert.ok(request.url.endsWith('/crm.activity.list'));assert.deepEqual(request.body.filter.BINDINGS,[{OWNER_TYPE_ID:1,OWNER_ID:21}]);assert.equal(request.body.filter.TYPE_ID,4);
 assert.equal(row.leadId,21);assert.equal(row.dealId,undefined);assert.equal(row.direction,'outgoing');assert.equal(row.bodyType,'text');assert.equal(row.createdAt,'2026-09-18T09:00:00.000Z');assert.deepEqual(row.communications,[{value:'buyer@example.test',entityId:null,entityTypeId:null,type:'EMAIL'}]);assert.deepEqual(row.settings,{MESSAGE_FROM:'',MESSAGE_TO:'buyer@example.test'});
});
