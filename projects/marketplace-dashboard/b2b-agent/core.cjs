'use strict';

const crypto = require('node:crypto');

const plain = value => String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const email = value => typeof value === 'string' && /^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/.test(value) && value.length < 255;
const time = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

function returnAddress(activity) {
  const addresses=[...new Set((activity.communications||[]).filter(c=>c.type==='EMAIL').map(c=>typeof c.value==='string'?c.value.trim().toLowerCase():'').filter(Boolean))];
  if(addresses.length!==1||!email(addresses[0]))return {recipient:null,reason:'Нет единственного корректного обратного адреса'};
  const recipient=addresses[0],local=recipient.split('@')[0];
  if(/(^|[._+\-])(no[._\-]?reply|do[._\-]?not[._\-]?reply|mailer[._\-]?daemon|postmaster|bounce[s]?)([._+\-]|$)/i.test(local))return {recipient:null,reason:'Служебный адрес не предназначен для переписки'};
  return {recipient,reason:null};
}

function normalizeExtraction(raw) {
  if (!raw || !['quote', 'availability', 'clarification', 'status', 'other'].includes(raw.intent)) throw Error('Модель вернула неизвестный тип запроса');
  if (!Array.isArray(raw.items) || raw.items.length > 100 || !Array.isArray(raw.missing) || raw.missing.length > 8) throw Error('Некорректный разбор письма');
  const allowedMissing = new Set(['article', 'quantity', 'dimensions', 'material', 'delivery_city']);
  return {
    intent: raw.intent,
    items: raw.items.map(item => {
      if (!item || typeof item.description !== 'string' || item.description.length > 500) throw Error('Некорректная товарная позиция');
      if (item.quantity !== null && (!Number.isFinite(item.quantity) || item.quantity <= 0 || item.quantity > 1e9)) throw Error('Некорректное количество');
      return { article: typeof item.article === 'string' ? item.article.slice(0,100) : null, description: plain(item.description), quantity: item.quantity };
    }),
    missing: [...new Set(raw.missing.filter(x => allowedMissing.has(x)))],
    needsHuman: raw.needsHuman !== false,
    summary: plain(raw.summary).slice(0,1000)
  };
}

// A model extracts only intent. It never chooses recipients, credentials, prices or CRM actions.
function buildDraft(extraction, { facts = [], now = Date.now(), hasAttachments = false, dealId = null } = {}) {
  const value = normalizeExtraction(extraction);
  const reasons = [];
  if (hasAttachments) reasons.push('Есть вложения: содержимое ещё не проверено');
  if (value.needsHuman) reasons.push('Модель указала на необходимость проверки');
  const labels = { article:'артикул или точное наименование', quantity:'количество', dimensions:'размеры', material:'материал и покрытие', delivery_city:'город доставки' };
  let body = '';
  if (value.missing.length) {
    body = `Здравствуйте! Чтобы подготовить предложение, уточните, пожалуйста: ${value.missing.map(x=>labels[x]).join(', ')}. Спасибо!`;
  } else if (['quote','availability'].includes(value.intent) && value.items.length) {
    const lines = [];
    for (const item of value.items) {
      // Semantic matches and substitutes need a person; exact 1C SKU only.
      const matches = facts.filter(f => item.article && f.article === item.article);
      if (matches.length !== 1) { reasons.push('Товар не сопоставлен с единственным артикулом 1С'); continue; }
      const f = matches[0];
      if (!dealId || String(f.crmDealId) !== String(dealId) || !f.priceType || !f.customerRef) { reasons.push('1С не подтвердила условия именно этого клиента'); continue; }
      if (f.source !== '1C' || !f.reference || time(f.checkedAt) === null || time(f.expiresAt) === null || time(f.checkedAt) > now || time(f.expiresAt) <= now || time(f.expiresAt) <= time(f.checkedAt)) {
        reasons.push('Нет свежего подтверждения из 1С'); continue;
      }
      if (!Number.isFinite(f.price) || f.price < 0 || !Number.isFinite(f.available) || f.available < 0 || !['RUB'].includes(f.currency) || !f.unit || !f.vatLabel) {
        reasons.push('1С не вернула полные условия цены и наличия'); continue;
      }
      if (!item.quantity || item.quantity > f.available) { reasons.push('Количество или срок поставки требует уточнения'); continue; }
      lines.push(`${plain(f.name || item.description)}: ${item.quantity} ${plain(f.unit)}, цена за единицу ${f.price.toFixed(2)} руб. (${plain(f.vatLabel)}). Доступно по данным 1С: ${f.available} ${plain(f.unit)}.`);
    }
    if (lines.length === value.items.length && !reasons.length) body = `Здравствуйте! По вашему запросу:\n\n${lines.join('\n')}\n\nНаличие проверено на момент подготовки ответа. Уточните, пожалуйста, способ и адрес получения; резерв и сроки отгрузки подтвердим отдельно.`;
  } else reasons.push('Нужны данные о заказе или решение сотрудника');
  if (!body) body = 'Ответ пока не подготовлен: требуется проверка запроса и данных 1С.';
  return { body, reasons:[...new Set(reasons)], status: reasons.length ? 'needs_data' : 'draft', intent:value.intent, summary:value.summary, items:value.items, factRefs:facts.map(f=>f.reference).filter(Boolean), factExpiresAt:facts.length ? Math.min(...facts.map(f=>time(f.expiresAt)??0)) : null };
}

function prepareCase({ deal, activities, config, existing = null, now = Date.now() }) {
  // A transport failure must remain held even if CRM closes or converts the case.
  if (existing && ['sending','uncertain'].includes(existing.status)) return {...existing,pendingIncoming:true};
  if (String(deal.CATEGORY_ID) !== String(config.categoryId)) return existing ? {...existing,status:'closed',reasons:['Сделка больше не относится к выбранной воронке']} : null;
  if (deal.CLOSED === 'Y') return existing ? {...existing,status:'closed',closedAt:new Date(now).toISOString()} : null;
  if (!existing && String(deal.STAGE_ID) !== config.newStageId) return null;
  const mails = activities.filter(a=>a.direction === 'incoming' || a.direction === 'outgoing');
  const incoming = mails.filter(a=>a.direction==='incoming').sort((a,b)=>(time(b.createdAt)||0)-(time(a.createdAt)||0)||Number(b.id)-Number(a.id));
  const identity={id:String(deal.ID),entityType:'deal',entityId:String(deal.ID),title:plain(deal.TITLE)};
  if (!incoming.length) return { ...identity, status:'needs_data', reasons:['Нет доступного входящего письма в карточке'], updatedAt:new Date(now).toISOString() };
  const last = incoming[0];
  if (time(last.createdAt) === null) return {...identity,status:'needs_data',reasons:['Неизвестно время входящего письма'], updatedAt:new Date(now).toISOString()};
  const fingerprint = digest([last.id,last.updatedAt,last.body,last.subject]);
  const answered = mails.some(a=>a.direction==='outgoing'&&time(a.createdAt)!==null&&time(a.createdAt)>=time(last.createdAt));
  const address=returnAddress(last),recipient=address.recipient;
  if (existing?.fingerprint === fingerprint && existing.recipient===recipient) return answered&&existing.status!=='sent'?{...existing,status:'answered',reasons:['После входящего письма есть исходящее; повторный ответ не готовится']}:existing;
  return { ...identity, stageId:String(deal.STAGE_ID), responsibleId:deal.ASSIGNED_BY_ID, fingerprint, incomingId:String(last.id), receivedAt:last.createdAt, originalMessageDate:last.originalMessageDate||null, subject:plain(last.subject), body:plain(last.body), hasAttachments:!!last.files?.length || last.attachmentsUnknown===true, recipient, mailMessageId:null, status:answered?'answered':recipient?'queued':'skipped', reasons:address.reason?[address.reason]:[], updatedAt:new Date(now).toISOString() };
}

function prepareLeadCase({lead,activities,config,existing=null,now=Date.now()}) {
  const closed=['S','F'].includes(lead.STATUS_SEMANTIC_ID)||['CONVERTED','JUNK'].includes(lead.STATUS_ID);
  const prepared=prepareCase({deal:{...lead,CATEGORY_ID:config.categoryId,STAGE_ID:lead.STATUS_ID,CLOSED:closed?'Y':'N'},activities,
    config:{...config,newStageId:config.newLeadStatusId||'NEW'},existing,now});
  if(!prepared)return null;
  return {...prepared,id:'lead:'+lead.ID,entityType:'lead',entityId:String(lead.ID),stageId:String(lead.STATUS_ID),
    ...(closed&&!['sending','uncertain'].includes(prepared.status)?{status:'closed',reasons:['Лид завершён или преобразован в сделку; обработка лида остановлена']}: {})};
}

function assertCanSend(row, config, now=Date.now()) {
  if (!config.sendEnabled) throw Error('Отправка писем выключена');
  if (!row || row.status !== 'approved') throw Error('Ответ не подтверждён');
  if (!email(row.recipient) || !email(config.sender) || !returnAddress({communications:[{type:'EMAIL',value:row.recipient}]}).recipient || row.recipient.toLowerCase()===config.sender.toLowerCase()) throw Error('Отправитель или получатель не подтверждён');
  if (!row.mailMessageId || !row.threadVerified) throw Error('Не подтверждена связь с исходным письмом');
  if (!row.draft || row.draft.status !== 'draft' || row.draft.reasons?.length) throw Error('Для ответа не хватает проверенных данных');
  if (row.draft.factExpiresAt!==null && row.draft.factExpiresAt<=now) throw Error('Данные 1С устарели: подготовьте ответ заново');
  if (!row.approvedFingerprint || row.approvedFingerprint !== digest([row.fingerprint,row.draft.body,row.recipient,row.mailMessageId])) throw Error('Ответ изменился после подтверждения');
}

module.exports = {plain,digest,email,time,returnAddress,normalizeExtraction,buildDraft,prepareCase,prepareLeadCase,assertCanSend};
