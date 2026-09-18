'use strict';
const {prepareCase,prepareLeadCase,buildDraft,assertCanSend,digest}=require('./core.cjs');
const {extract}=require('./model.cjs');
const protectedStates=new Set(['sending','uncertain','sent','answered']);
const entityOf=row=>row.entityType==='lead'?'lead':'deal';
const crmIdOf=row=>String(row.entityId||row.id);

class Runner {
  constructor({store,config,crm,oneC,extractImpl=extract}) {
    Object.assign(this,{store,config,crm,oneC,extractImpl});this.busy=false;
    // Legacy numeric deal keys remain valid; lead keys always have a prefix.
    for(const row of Object.values(store.data.cases)){row.entityType=entityOf(row);row.entityId=crmIdOf(row);}
    store.data.messageClaims ||= {};
  }
  async exclusive(fn) {if(this.busy)throw Error('Операция уже выполняется');this.busy=true;try{return await fn();}finally{this.busy=false;}}
  rememberClaims() {
    for(const row of Object.values(this.store.data.cases))if(row.incomingId&&protectedStates.has(row.status)) {
      const old=this.store.data.messageClaims[row.incomingId];
      if(!old||['sending','uncertain'].includes(row.status))this.store.data.messageClaims[row.incomingId]={ownerId:row.id,status:row.status};
    }
  }
  deduplicate() {
    this.rememberClaims();const groups=new Map();
    for(const row of Object.values(this.store.data.cases)) {
      if(!row.incomingId)continue;
      if(row.status==='duplicate'){row.status='queued';row.reasons=[];delete row.draft;delete row.processedFingerprint;delete row.duplicateOf;}
      if(!groups.has(row.incomingId))groups.set(row.incomingId,[]);
      groups.get(row.incomingId).push(row);
    }
    for(const [messageId,rows] of groups) {
      const claim=this.store.data.messageClaims[messageId];
      const active=rows.filter(r=>!['closed','skipped'].includes(r.status));
      active.sort((a,b)=>Number(entityOf(a)==='lead')-Number(entityOf(b)==='lead')||String(a.id).localeCompare(String(b.id)));
      const ownerId=claim?.ownerId||active[0]?.id;
      for(const row of active)if(!protectedStates.has(row.status)&&(row.id!==ownerId||claim)) {
        row.status='duplicate';row.duplicateOf=ownerId;row.reasons=['Это входящее письмо уже обрабатывается в другой карточке или имеет исходящий ответ'];
        delete row.draft;delete row.approvedFingerprint;
      }
    }
  }
  async fresh(row) {
    const id=crmIdOf(row),lead=entityOf(row)==='lead';
    const entity=await (lead?this.crm.readLead(id):this.crm.readDeal(id));
    const activities=await (lead?this.crm.readLeadEmailActivities(id):this.crm.readEmailActivities(id));
    return lead?prepareLeadCase({lead:entity,activities,config:this.config,existing:row}):prepareCase({deal:entity,activities,config:this.config,existing:row});
  }
  async scan() {return this.exclusive(async()=>{
    if(!this.crm||!this.config.newStageId)throw Error('Подключите Битрикс24 и выберите стадию «Новая»');
    this.rememberClaims();const candidates=new Map();let read=0,failed=0,dealRead=0,leadRead=0;
    const add=(entityType,rows)=>{for(const entity of rows)candidates.set(entityType==='lead'?'lead:'+entity.ID:String(entity.ID),{entityType,entity});};
    try{add('deal',await this.crm.readCandidates(this.config.categoryId,this.config.newStageId));}
    catch{failed++;this.store.event('read_error',null,'Не удалось загрузить новые сделки');}
    if(this.config.leadsEnabled)try{add('lead',await this.crm.readLeadCandidates(this.config.newLeadStatusId||'NEW'));}
    catch{failed++;this.store.event('read_error',null,'Не удалось загрузить новые лиды');}
    for(const row of Object.values(this.store.data.cases)) {
      if(entityOf(row)==='lead'&&!this.config.leadsEnabled)continue;
      if(candidates.has(row.id)||row.status==='closed')continue;
      try{candidates.set(row.id,{entityType:entityOf(row),entity:await (entityOf(row)==='lead'?this.crm.readLead(crmIdOf(row)):this.crm.readDeal(crmIdOf(row)))});}
      catch{row.readFailed=true;failed++;this.store.event('read_error',row.id,'Карточка недоступна. Обработка приостановлена.');}
    }
    for(const [id,{entityType,entity}] of candidates) {
      try {
        const lead=entityType==='lead',entityId=String(entity.ID);
        const activities=await (lead?this.crm.readLeadEmailActivities(entityId):this.crm.readEmailActivities(entityId));
        const args={activities,config:this.config,existing:this.store.data.cases[id]};
        const next=lead?prepareLeadCase({...args,lead:entity}):prepareCase({...args,deal:entity});
        if(next){next.readFailed=false;this.store.data.cases[id]=next;}
        read++;if(lead)leadRead++;else dealRead++;
      }catch{if(this.store.data.cases[id])this.store.data.cases[id].readFailed=true;failed++;this.store.event('read_error',id,'Не удалось прочитать переписку. Предыдущие данные сохранены.');}
      this.store.save();
    }
    this.deduplicate();this.store.data.lastScan={at:new Date().toISOString(),read,dealRead,leadRead,failed,complete:failed===0};this.store.save();
    this.store.event('scan',null,`Прочитано сделок: ${dealRead}, лидов: ${leadRead}. Ошибок: ${failed}.`);return this.store.data.lastScan;
  });}
  async draftInternal(id,{automatic=false}={}) {
    let row=this.store.data.cases[id];
    if(!row||!['queued','draft','needs_data'].includes(row.status)||!row.body||row.readFailed)throw Error('Нет актуального письма для подготовки ответа');
    if(entityOf(row)==='lead'&&!this.config.leadsEnabled)throw Error('Обработка лидов выключена');
    if(!row.recipient){row.status='skipped';row.reasons=['Нет проверенного обратного адреса для переписки'];this.store.save();return row;}
    if(this.crm) {
      this.rememberClaims();const next=await this.fresh(row);if(!next)throw Error('Карточка больше не входит в очередь');
      this.store.data.cases[id]=next;this.deduplicate();row=this.store.data.cases[id];
      if(!['queued','draft','needs_data'].includes(row.status)||!row.recipient){this.store.save();return row;}
    }
    row.processedFingerprint=row.fingerprint;row.processedAt=new Date().toISOString();delete row.approvedFingerprint;delete row.draft;
    if(row.hasAttachments){row.status='needs_data';row.reasons=['Нужно проверить содержимое вложений'];this.store.save();return row;}
    this.store.save();
    try {
      const parsed=await this.extractImpl(row,this.config.model);row.extraction=parsed;let facts=[];
      if(['quote','availability'].includes(parsed.intent)&&!parsed.missing.length) {
        if(entityOf(row)==='lead'){row.status='needs_data';row.reasons=['Для предложения лиду нужны подтверждённые условия клиента из 1С. Привязка лида к 1С ещё не настроена'];this.store.save();return row;}
        if(!this.oneC){row.status='needs_data';row.reasons=['Нужно подключить 1С для проверки цены и наличия'];this.store.save();return row;}
        const deal=await this.crm.readDeal(crmIdOf(row));facts=await this.oneC.facts(parsed.items,{dealId:crmIdOf(row),companyId:deal.COMPANY_ID||null,contactId:deal.CONTACT_ID||null});
      }
      row.draft=buildDraft(parsed,{facts,hasAttachments:row.hasAttachments,dealId:entityOf(row)==='deal'?crmIdOf(row):null});row.status=row.draft.status;row.reasons=row.draft.reasons;row.updatedAt=new Date().toISOString();
      this.store.event('draft',id,row.status==='draft'?'Подготовлен черновик ответа. Клиенту не отправлен.':'Запрос требует дополнительных данных');return row;
    }catch(error){row.status='needs_data';row.reasons=['Не удалось подготовить ответ. Доступен ручной повтор после проверки'];this.store.event('draft_error',id,'Подготовка ответа не удалась; автоматический повтор этого письма остановлен');if(!automatic)throw error;return null;}
  }
  async draft(id) {return this.exclusive(()=>this.draftInternal(id));}
  async processBatch({limit=3}={}) {return this.exclusive(async()=>{
    if(!this.crm)throw Error('Подключите CRM');
    this.deduplicate();let processed=0,failed=0,attempted=0;
    const candidates=Object.values(this.store.data.cases).filter(row=>row.status==='queued'&&row.body&&row.recipient&&!row.readFailed&&row.fingerprint!==row.processedFingerprint&&(entityOf(row)!=='lead'||this.config.leadsEnabled))
      .sort((a,b)=>String(a.receivedAt).localeCompare(String(b.receivedAt))||String(a.id).localeCompare(String(b.id)));
    for(const row of candidates.slice(0,Math.max(1,Math.min(10,limit)))) {
      attempted++;
      try{const result=await this.draftInternal(row.id,{automatic:true});if(result)processed++;else failed++;}
      catch{const current=this.store.data.cases[row.id];current.processedFingerprint=current.fingerprint;current.status='needs_data';current.reasons=['Не удалось проверить актуальную переписку. Нужна повторная проверка'];failed++;this.store.event('draft_error',row.id,'Ошибка проверки карточки; обработка остальных продолжается');}
    }
    this.store.data.lastProcess={at:new Date().toISOString(),processed,failed,attempted};this.store.save();return this.store.data.lastProcess;
  });}
  async bindThread(id,mailMessageId) {return this.exclusive(async()=>{
    const row=this.store.data.cases[id];if(!row||!this.crm)throw Error('Карточка недоступна');
    const message=await this.crm.readMailMessage(mailMessageId);return {message,caseId:id,mailMessageId:String(mailMessageId)};
  });}
  async send(id) {return this.exclusive(async()=>{
    this.deduplicate();let row=this.store.data.cases[id];assertCanSend(row,this.config);
    const fresh=await this.fresh(row);
    if(!fresh||['closed','answered'].includes(fresh.status)||fresh.fingerprint!==row.fingerprint)throw Error('Переписка или стадия изменилась. Обновите очередь и проверьте ответ');
    if(fresh.recipient!==row.recipient)throw Error('Получатель изменился');
    row.status='sending';row.attemptId=digest([id,row.fingerprint,row.draft.body]);this.rememberClaims();this.store.save();
    try {
      const result=await this.crm.replyEmail({replyToMessageId:row.mailMessageId,from:this.config.sender,to:[row.recipient],subject:/^re:/i.test(row.subject)?row.subject:'Re: '+row.subject,body:row.draft.body});
      if(!result?.success)throw Error('Результат отправки не подтверждён');
      row.status='sent';row.sentAt=new Date().toISOString();this.store.data.messageClaims[row.incomingId]={ownerId:row.id,status:'sent'};this.store.event('sent',id,'Битрикс24 принял ответ. Доставка клиенту отдельно не подтверждена.');
    }catch{row.status='uncertain';row.reasons=['Результат отправки неизвестен. Автоповтор выключен; проверьте исходящие письма.'];this.rememberClaims();this.store.event('uncertain',id,'Нужна сверка отправленного письма');}
    return row;
  });}
}
module.exports={Runner};
