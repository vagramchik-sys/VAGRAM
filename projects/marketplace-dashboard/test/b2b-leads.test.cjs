'use strict';

const test=require('node:test'),assert=require('node:assert/strict');
const {prepareCase,prepareLeadCase}=require('../b2b-agent/core.cjs');
const {Runner}=require('../b2b-agent/runner.cjs');

const config={categoryId:'6',newStageId:'C6:NEW',leadsEnabled:true,newLeadStatusId:'NEW',sendEnabled:false};
const deal=(id='12')=>({ID:id,TITLE:'Учебная сделка',CATEGORY_ID:'6',STAGE_ID:'C6:NEW',CLOSED:'N'});
const lead=(id='12')=>({ID:id,TITLE:'Учебный лид',STATUS_ID:'NEW',STATUS_SEMANTIC_ID:'P'});
const mail=(id=42)=>({id,direction:'incoming',createdAt:'2026-09-18T11:00:00Z',updatedAt:'2026-09-18T11:00:00Z',body:'Нужны болты, количество уточню',subject:'Учебный запрос',files:[],communications:[{type:'EMAIL',value:'buyer@example.test'}]});
const clarification={intent:'quote',summary:'Уточнение количества',items:[],missing:['quantity'],needsHuman:false};
const quote={intent:'quote',summary:'Расчёт',items:[{article:'ABC-1',description:'Болты',quantity:100}],missing:[],needsHuman:false};

function memoryStore(data={cases:{},events:[]}) {
  return {data,snapshot:null,save(){this.snapshot=JSON.stringify(this.data);},event(kind,caseId,message){this.data.events.push({kind,caseId,message});this.save();}};
}

function fixture({deals=[],leads=[],dealMails={},leadMails={},store=memoryStore(),extractImpl=async()=>clarification,oneC}={}) {
  const calls=[];
  const crm={
    async readCandidates(){return deals;},async readLeadCandidates(){return leads;},
    async readDeal(id){calls.push(['deal',id]);const row=deals.find(d=>String(d.ID)===id);assert.ok(row,'Unexpected deal lookup: '+id);return row;},
    async readLead(id){calls.push(['lead',id]);const row=leads.find(d=>String(d.ID)===id);assert.ok(row,'Unexpected lead lookup: '+id);return row;},
    async readEmailActivities(id){calls.push(['dealMail',id]);return dealMails[id]||[];},
    async readLeadEmailActivities(id){calls.push(['leadMail',id]);return leadMails[id]||[];},
    async replyEmail(){assert.fail('Draft processing must never send an email');}
  };
  return {runner:new Runner({store,config,crm,oneC,extractImpl}),store,crm,calls};
}

test('lead and legacy deal with the same numeric ID keep independent state and CRM routing',async()=>{
  const original=prepareCase({deal:deal(),activities:[mail()],config});
  delete original.entityId;delete original.entityType;
  Object.assign(original,{status:'uncertain',attemptId:'preserved-attempt',draft:{body:'preserved draft'}});
  const f=fixture({deals:[deal()],leads:[lead()],dealMails:{12:[mail()]},leadMails:{12:[mail(43)]},store:memoryStore({cases:{12:original},events:[]})});
  await f.runner.scan();await f.runner.processBatch();
  assert.deepEqual(Object.keys(f.store.data.cases).sort(),['12','lead:12']);
  assert.equal(f.store.data.cases['12'].status,'uncertain');
  assert.equal(f.store.data.cases['12'].entityId,'12');
  assert.equal(f.store.data.cases['12'].attemptId,'preserved-attempt');
  assert.equal(f.store.data.cases['12'].draft.body,'preserved draft');
  assert.equal(f.store.data.cases['lead:12'].status,'draft');
  assert.equal(f.store.data.cases['lead:12'].entityId,'12');
  assert.ok(f.calls.some(([method,id])=>method==='lead'&&id==='12'));
  assert.ok(f.calls.every(([,id])=>id==='12'));
});

test('shared CRM incoming activity gets one draft across deal and lead, including repeated scans',async()=>{
  let extracts=0;
  const f=fixture({deals:[deal()],leads:[lead()],dealMails:{12:[mail()]},leadMails:{12:[mail()]},extractImpl:async()=>{extracts++;return clarification;}});
  await f.runner.scan();await f.runner.processBatch();
  await f.runner.scan();await f.runner.processBatch();
  assert.equal(extracts,1);
  assert.equal(f.store.data.cases['12'].status,'draft');
  assert.equal(f.store.data.cases['lead:12'].status,'duplicate');
  assert.equal(f.store.data.cases['lead:12'].duplicateOf,'12');
});

test('sent message claim survives a new email and store reload, blocking its late CRM duplicate',async()=>{
  const sent={...prepareCase({deal:deal(),activities:[mail()],config}),status:'sent',sentAt:'2026-09-18T11:01:00Z'};
  let extracts=0;
  const f=fixture({deals:[deal()],leads:[lead()],dealMails:{12:[{...mail(44),createdAt:'2026-09-18T11:10:00Z'}]},leadMails:{12:[mail()]},store:memoryStore({cases:{12:sent},events:[]}),extractImpl:async()=>{extracts++;return clarification;}});
  await f.runner.scan();
  assert.deepEqual(f.store.data.messageClaims['42'],{ownerId:'12',status:'sent'});
  assert.equal(f.store.data.cases['12'].incomingId,'44');
  const restored=memoryStore(JSON.parse(f.store.snapshot));
  const again=new Runner({store:restored,config,crm:f.crm,extractImpl:async()=>{extracts++;return clarification;}});
  await again.scan();await again.processBatch();
  assert.equal(extracts,1);
  assert.equal(restored.data.cases['12'].status,'draft');
  assert.equal(restored.data.cases['lead:12'].status,'duplicate');
  assert.equal(restored.data.messageClaims['42'].status,'sent');
});

test('uncertain transport result stays held through deal closure, lead conversion and missing or new email',()=>{
  for(const entity of ['deal','lead']) {
    const original=entity==='lead'?prepareLeadCase({lead:lead(),activities:[mail()],config}):prepareCase({deal:deal(),activities:[mail()],config});
    const existing={...original,status:'uncertain',attemptId:'unknown-send',draft:{body:'Already attempted'}};
    for(const activities of [[],[mail(99)]]) {
      const next=entity==='lead'
        ?prepareLeadCase({lead:{...lead(),STATUS_ID:'CONVERTED',STATUS_SEMANTIC_ID:'S'},activities,config,existing})
        :prepareCase({deal:{...deal(),CLOSED:'Y'},activities,config,existing});
      assert.equal(next.status,'uncertain');assert.equal(next.attemptId,'unknown-send');
      assert.equal(next.incomingId,'42');assert.equal(next.draft.body,'Already attempted');
    }
  }
});

test('automatic drafting does not re-extract unchanged email but handles a new incoming message',async()=>{
  let extracts=0;const leadMails={12:[mail()]};
  const f=fixture({leads:[lead()],leadMails,extractImpl:async()=>{extracts++;return clarification;}});
  await f.runner.scan();await f.runner.processBatch();await f.runner.scan();
  assert.equal((await f.runner.processBatch()).attempted,0);assert.equal(extracts,1);
  leadMails[12]=[{...mail(45),createdAt:'2026-09-18T11:10:00Z',body:'Новый запрос'}];
  await f.runner.scan();await f.runner.processBatch();
  assert.equal(extracts,2);assert.equal(f.store.data.cases['lead:12'].incomingId,'45');
});

test('lead quotation never looks up same-number deal or consumes deal-specific 1C facts',async()=>{
  let extracts=0,oneCCalls=0;
  const f=fixture({leads:[lead()],leadMails:{12:[mail()]},extractImpl:async()=>{extracts++;return quote;},oneC:{async facts(){oneCCalls++;return [{crmDealId:'12',article:'ABC-1',price:1}];}}});
  await f.runner.scan();await f.runner.processBatch();await f.runner.scan();await f.runner.processBatch();
  assert.equal(extracts,1);assert.equal(oneCCalls,0);
  assert.equal(f.calls.some(([method])=>method==='deal'),false);
  assert.equal(f.store.data.cases['lead:12'].status,'needs_data');
  assert.equal(f.store.data.cases['lead:12'].draft,undefined);
  assert.match(f.store.data.cases['lead:12'].reasons.join(' '),/1С/);
});

test('model failure in one case does not block next case or automatically repeat the failure',async()=>{
  const extracted=[];
  const f=fixture({leads:[lead('12'),lead('13')],leadMails:{12:[mail()],13:[mail(43)]},extractImpl:async row=>{extracted.push(row.id);if(row.id==='lead:12')throw Error('Synthetic model failure');return clarification;}});
  await f.runner.scan();const result=await f.runner.processBatch();
  assert.equal(result.failed,1);assert.equal(result.processed,1);
  assert.deepEqual(extracted,['lead:12','lead:13']);
  assert.equal(f.store.data.cases['lead:12'].status,'needs_data');
  assert.equal(f.store.data.cases['lead:13'].status,'draft');
  await f.runner.scan();assert.equal((await f.runner.processBatch()).attempted,0);
  assert.equal(extracted.length,2);
});

test('CRM recheck failure in one case still allows next case to be drafted',async()=>{
  const f=fixture({leads:[lead('12'),lead('13')],leadMails:{12:[mail()],13:[mail(43)]}});
  await f.runner.scan();const readLead=f.crm.readLead;
  f.crm.readLead=async id=>{if(id==='12')throw Error('Synthetic CRM failure');return readLead(id);};
  const result=await f.runner.processBatch();
  assert.equal(result.failed,1);assert.equal(result.processed,1);
  assert.equal(f.store.data.cases['lead:12'].status,'needs_data');
  assert.equal(f.store.data.cases['lead:13'].status,'draft');
});
