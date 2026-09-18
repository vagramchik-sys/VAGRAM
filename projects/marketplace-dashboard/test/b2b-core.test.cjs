'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {returnAddress,prepareCase,buildDraft,assertCanSend,digest}=require('../b2b-agent/core.cjs');
const {Store}=require('../b2b-agent/queue-store.cjs');
const {Runner}=require('../b2b-agent/runner.cjs');
const now=Date.parse('2026-09-18T12:00:00Z'),config={categoryId:'6',newStageId:'C6:NEW'};
const deal={ID:'12',TITLE:'Учебная заявка',CATEGORY_ID:'6',STAGE_ID:'C6:NEW',CLOSED:'N'};
const mail={id:42,direction:'incoming',createdAt:'2026-09-18T11:00:00Z',updatedAt:'2026-09-18T11:00:00Z',body:'Болты ABC-1 100 штук',subject:'Запрос',files:[],communications:[{type:'EMAIL',value:'buyer@example.test'}]};
const parsed={intent:'quote',summary:'Болты',items:[{article:'ABC-1',description:'Болты',quantity:100}],missing:[],needsHuman:false};
const fact={crmDealId:'12',customerRef:'synthetic-customer',priceType:'contract',article:'ABC-1',name:'Болты',price:12,available:500,currency:'RUB',unit:'шт.',vatLabel:'НДС включён',source:'1C',reference:'synthetic-1',checkedAt:'2026-09-18T11:59:00Z',expiresAt:'2026-09-18T12:05:00Z'};

test('B2B only, new entry stage only, already enrolled cases tracked after stage change',()=>{
 assert.equal(prepareCase({deal:{...deal,CATEGORY_ID:'8'},activities:[mail],config}),null);
 assert.equal(prepareCase({deal:{...deal,STAGE_ID:'C6:CHECK'},activities:[mail],config}),null);
 const row=prepareCase({deal,activities:[mail],config,now});assert.equal(row.status,'queued');
 assert.equal(prepareCase({deal:{...deal,STAGE_ID:'C6:CHECK'},activities:[mail],config,existing:row}).id,'12');
 assert.equal(prepareCase({deal:{...deal,CLOSED:'Y'},activities:[mail],config,existing:row}).status,'closed');
});
test('return address cannot come from body, no-reply, multiple or invalid addresses',()=>{
 for(const v of ['no-reply@example.test','noreply@example.test','mailer-daemon@example.test','postmaster@example.test','do.not.reply@example.test','bad','x@example.test\r\nBcc:y@example.test'])assert.equal(returnAddress({communications:[{type:'EMAIL',value:v}]}).recipient,null,v);
 assert.equal(returnAddress({body:'reply to buyer@example.test',communications:[]}).recipient,null);
 assert.equal(returnAddress({communications:[{type:'EMAIL',value:'a@example.test'},{type:'EMAIL',value:'b@example.test'}]}).recipient,null);
 assert.equal(prepareCase({deal,activities:[{...mail,communications:[]}],config}).status,'skipped');
});
test('new outgoing message invalidates previously queued case even when incoming unchanged',()=>{
 const row=prepareCase({deal,activities:[mail],config});
 const next=prepareCase({deal,activities:[mail,{...mail,id:43,direction:'outgoing',createdAt:'2026-09-18T11:15:00Z'}],config,existing:row});assert.equal(next.status,'answered');
 assert.strictEqual(prepareCase({deal,activities:[mail],config,existing:row}),row);
 assert.equal(prepareCase({deal,activities:[{...mail,id:44,body:'Ещё вопрос'}],config,existing:{...row,status:'sent'}}).status,'queued');
});
test('unknown send result stays held even if a new message arrives',()=>{
 const row=prepareCase({deal,activities:[mail],config});const next=prepareCase({deal,activities:[{...mail,id:55}],config,existing:{...row,status:'uncertain'}});assert.equal(next.status,'uncertain');assert.equal(next.pendingIncoming,true);
});
test('quote requires exact SKU, complete current 1C facts, stock and quantity',()=>{
 assert.equal(buildDraft(parsed,{facts:[fact],dealId:12,now}).status,'draft');
 for(const patch of [{expiresAt:'2026-09-18T11:59:00Z'},{checkedAt:'2026-09-19T12:00:00Z'},{price:NaN},{available:10},{unit:''},{vatLabel:''},{source:'guess'},{reference:''}])assert.equal(buildDraft(parsed,{facts:[{...fact,...patch}],dealId:12,now}).status,'needs_data');
 assert.equal(buildDraft(parsed,{facts:[],now}).status,'needs_data');
 assert.equal(buildDraft(parsed,{facts:[fact,fact],dealId:12,now}).status,'needs_data');
 assert.equal(buildDraft({...parsed,needsHuman:true},{facts:[fact],dealId:12,now}).status,'needs_data');
 assert.equal(buildDraft(parsed,{facts:[fact],dealId:12,now,hasAttachments:true}).status,'needs_data');
});
test('clarification never fabricates inventory or cost',()=>{
 const d=buildDraft({...parsed,items:[],missing:['article','quantity']},{now});assert.equal(d.status,'draft');assert.match(d.body,/количество/);assert.doesNotMatch(d.body,/руб|наличии/);
});
test('send gate checks approval, exact draft, return address, thread, freshness and mode',()=>{
 let row={...prepareCase({deal,activities:[mail],config}),status:'approved',mailMessageId:'55',threadVerified:true,draft:buildDraft(parsed,{facts:[fact],dealId:12,now})};row.approvedFingerprint=digest([row.fingerprint,row.draft.body,row.recipient,row.mailMessageId]);const cfg={...config,sendEnabled:true,sender:'sales@example.test'};
 assert.doesNotThrow(()=>assertCanSend(row,cfg,now));
 for(const [r,c]of[[row,{...cfg,sendEnabled:false}],[{...row,threadVerified:false},cfg],[{...row,status:'sent'},cfg],[{...row,recipient:'noreply@example.test'},cfg],[{...row,draft:{...row.draft,body:'changed'}},cfg],[{...row,mailMessageId:null},cfg]])assert.throws(()=>assertCanSend(r,c,now));
 assert.throws(()=>assertCanSend(row,cfg,now+600000));
});
test('persistent queue recovers interrupted send as uncertain, never retries automatically',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'b2b-test-'));try{const s=new Store(dir);s.data.cases['12']={status:'sending'};s.save();const restored=new Store(dir);assert.equal(restored.data.cases['12'].status,'uncertain');}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('draft processing skips attachments and no-return-address without calling model or 1C',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'b2b-test-'));try{const store=new Store(dir),row=prepareCase({deal,activities:[mail],config});store.data.cases['12']={...row,hasAttachments:true};let calls=0;const r=new Runner({store,config,extractImpl:async()=>{calls++;return parsed;}});assert.equal((await r.draft('12')).status,'needs_data');assert.equal(calls,0);store.data.cases['12']={...row,recipient:null};assert.equal((await r.draft('12')).status,'skipped');assert.equal(calls,0);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('timeout after external send holds uncertain result and blocks a second send',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'b2b-test-'));try{const store=new Store(dir),row={...prepareCase({deal,activities:[mail],config}),status:'approved',mailMessageId:'55',threadVerified:true,draft:buildDraft({...parsed,items:[],missing:['quantity']})};row.approvedFingerprint=digest([row.fingerprint,row.draft.body,row.recipient,row.mailMessageId]);store.data.cases['12']=row;let sent=0;const r=new Runner({store,config:{...config,sendEnabled:true,sender:'sales@example.test'},crm:{readDeal:async()=>deal,readEmailActivities:async()=>[mail],replyEmail:async()=>{sent++;throw Error('timeout');}}});assert.equal((await r.send('12')).status,'uncertain');await assert.rejects(r.send('12'));assert.equal(sent,1);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
