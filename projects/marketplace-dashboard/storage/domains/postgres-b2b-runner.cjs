'use strict';

const crypto = require('node:crypto');
const { prepareCase, prepareLeadCase, buildDraft, assertCanSend, digest } = require('../../b2b-agent/core.cjs');

const protectedStates = new Set(['sending', 'uncertain', 'sent', 'answered']);
const entityOf = row => row.entityType === 'lead' ? 'lead' : 'deal';
const crmIdOf = row => String(row.entityId || row.id);
const clone = value => structuredClone(value);
function coreJson(value) {
  if (Array.isArray(value)) return value.map(coreJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, coreJson(item)]));
  return value;
}
const at = () => new Date().toISOString();
const event = (kind, caseId, message) => ({ kind, caseId, message, at: at() });

class B2BRunnerError extends Error {
  constructor(code, message) { super(message); this.name = 'B2BRunnerError'; this.code = code; }
}
const fail = (code, message) => { throw new B2BRunnerError(code, message); };

function stableCommandId(label, revision, ...parts) {
  const bytes = crypto.createHash('sha256').update(JSON.stringify([label, revision, ...parts])).digest().subarray(0, 16);
  bytes[6] = bytes[6] & 0x0f | 0x40; bytes[8] = bytes[8] & 0x3f | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function rememberClaims(value) {
  value.messageClaims ||= {};
  for (const [caseId, row] of Object.entries(value.cases)) if (row.incomingId && protectedStates.has(row.status)) {
    const key = String(row.incomingId), ownerId = String(row.id || caseId), old = value.messageClaims[key];
    if (old && old.ownerId !== ownerId) fail('MESSAGE_CLAIMED', 'Входящее письмо уже закреплено за другой карточкой');
    value.messageClaims[key] = { ownerId, status: row.status };
  }
}

function deduplicate(value) {
  rememberClaims(value);
  const groups = new Map();
  for (const row of Object.values(value.cases)) {
    if (!row.incomingId) continue;
    if (row.status === 'duplicate') { row.status = 'queued'; row.reasons = []; delete row.draft; delete row.processedFingerprint; delete row.duplicateOf; }
    if (!groups.has(String(row.incomingId))) groups.set(String(row.incomingId), []);
    groups.get(String(row.incomingId)).push(row);
  }
  for (const [messageId, rows] of groups) {
    const claim = value.messageClaims[messageId];
    const active = rows.filter(row => !['closed', 'skipped'].includes(row.status));
    active.sort((a, b) => Number(entityOf(a) === 'lead') - Number(entityOf(b) === 'lead') || String(a.id).localeCompare(String(b.id)));
    const ownerId = claim?.ownerId || active[0]?.id;
    for (const row of active) if (!protectedStates.has(row.status) && (row.id !== ownerId || claim)) {
      row.status = 'duplicate'; row.duplicateOf = ownerId; row.reasons = ['Это входящее письмо уже обрабатывается в другой карточке или имеет исходящий ответ'];
      delete row.draft; delete row.approvedFingerprint;
    }
  }
}

async function createPostgresB2BRunner({ queue, config, crm = null, oneC = null, extractImpl, replyEmail } = {}) {
  if (!queue || !['load', 'assertReady', 'recover', 'updateCase', 'updateDocument'].every(name => typeof queue[name] === 'function')) throw new TypeError('async SQL queue is required');
  if (!config || typeof config !== 'object') throw new TypeError('config is required');
  if (typeof extractImpl !== 'function') throw new TypeError('extractImpl is required');
  if (replyEmail !== undefined && typeof replyEmail !== 'function') throw new TypeError('replyEmail must be a function');
  const startup = await queue.load();
  await queue.recover(startup, { commandId: stableCommandId('startup-recovery', startup.revision, queue.logicalKey) });
  queue.assertReady(await queue.load());
  let busy = false;

  async function exclusive(callback) {
    if (busy) fail('BUSY', 'Операция уже выполняется');
    busy = true; try { return await callback(); } finally { busy = false; }
  }
  async function fresh(row) {
    if (!crm) fail('CRM_UNAVAILABLE', 'Карточка недоступна');
    const id = crmIdOf(row), lead = entityOf(row) === 'lead';
    const entity = await (lead ? crm.readLead(id) : crm.readDeal(id));
    const activities = await (lead ? crm.readLeadEmailActivities(id) : crm.readEmailActivities(id));
    const prepared = lead ? prepareLeadCase({ lead: entity, activities, config, existing: row }) : prepareCase({ deal: entity, activities, config, existing: row });
    return prepared ? coreJson(prepared) : prepared;
  }

  async function scan() { return exclusive(async () => {
    if (!crm || !config.newStageId) fail('SCAN_UNAVAILABLE', 'Подключите CRM и выберите новую стадию');
    const current = await queue.load(), value = clone(current.value), candidates = new Map();
    queue.assertReady(current);
    let read = 0, failed = 0, dealRead = 0, leadRead = 0;
    const add = (type, rows) => { for (const item of rows) candidates.set(type === 'lead' ? `lead:${item.ID}` : String(item.ID), { type, item }); };
    try { add('deal', await crm.readCandidates(config.categoryId, config.newStageId)); } catch { failed++; value.events.unshift(event('read_error', null, 'Не удалось загрузить новые сделки')); }
    if (config.leadsEnabled) try { add('lead', await crm.readLeadCandidates(config.newLeadStatusId || 'NEW')); } catch { failed++; value.events.unshift(event('read_error', null, 'Не удалось загрузить новые лиды')); }
    for (const [id, row] of Object.entries(value.cases)) {
      if (entityOf(row) === 'lead' && !config.leadsEnabled || candidates.has(id) || row.status === 'closed') continue;
      try { candidates.set(id, { type: entityOf(row), item: await (entityOf(row) === 'lead' ? crm.readLead(crmIdOf(row)) : crm.readDeal(crmIdOf(row))) }); }
      catch { row.readFailed = true; failed++; value.events.unshift(event('read_error', id, 'Карточка недоступна. Обработка приостановлена.')); }
    }
    for (const [id, candidate] of candidates) try {
      const lead = candidate.type === 'lead', entityId = String(candidate.item.ID);
      const activities = await (lead ? crm.readLeadEmailActivities(entityId) : crm.readEmailActivities(entityId));
      const args = { activities, config, existing: value.cases[id] };
      const next = lead ? prepareLeadCase({ ...args, lead: candidate.item }) : prepareCase({ ...args, deal: candidate.item });
      if (next) { next.readFailed = false; value.cases[id] = coreJson(next); }
      read++; if (lead) leadRead++; else dealRead++;
    } catch { failed++; value.events.unshift(event('read_error', id, 'Не удалось прочитать переписку. Предыдущие данные сохранены.')); }
    deduplicate(value);
    value.lastScan = { at: at(), read, dealRead, leadRead, failed, complete: failed === 0 };
    value.events = [event('scan', null, `Прочитано сделок: ${dealRead}, лидов: ${leadRead}. Ошибок: ${failed}.`), ...value.events].slice(0, 500);
    await queue.updateDocument(current, { value, commandId: stableCommandId('scan', current.revision, value.lastScan.at) });
    return value.lastScan;
  }); }

  async function draftInternal(id, { automatic = false } = {}) {
    const current = await queue.load(), original = current.value.cases[id];
    queue.assertReady(current);
    if (!original || !['queued', 'draft', 'needs_data'].includes(original.status) || !original.body || original.readFailed) fail('NOT_DRAFTABLE', 'Нет актуального письма для подготовки ответа');
    if (entityOf(original) === 'lead' && !config.leadsEnabled) fail('LEADS_DISABLED', 'Обработка лидов отключена');
    let row = crm ? await fresh(original) : clone(original);
    if (!row || !['queued', 'draft', 'needs_data'].includes(row.status) || !row.recipient) fail('NOT_DRAFTABLE', 'Карточка больше не входит в очередь');
    row.processedFingerprint = row.fingerprint; row.processedAt = at(); delete row.approvedFingerprint; delete row.draft;
    if (row.hasAttachments) { row.status = 'needs_data'; row.reasons = ['Нужно проверить содержимое вложений']; }
    else try {
      const parsed = await extractImpl(row, config.model); let facts = [], blocked = false;
      row.extraction = coreJson(parsed);
      if (['quote', 'availability'].includes(parsed.intent) && !parsed.missing.length) {
        if (entityOf(row) === 'lead' || !oneC) { blocked = true; row.status = 'needs_data'; row.reasons = ['Нужны подтверждённые условия из 1С']; }
        else { const deal = await crm.readDeal(crmIdOf(row)); facts = await oneC.facts(parsed.items, { dealId: crmIdOf(row), companyId: deal.COMPANY_ID || null, contactId: deal.CONTACT_ID || null }); }
      }
      if (!blocked) { row.draft = coreJson(buildDraft(parsed, { facts, hasAttachments: row.hasAttachments, dealId: entityOf(row) === 'deal' ? crmIdOf(row) : null })); row.status = row.draft.status; row.reasons = row.draft.reasons; }
    } catch (error) {
      row.status = 'needs_data'; row.reasons = ['Не удалось подготовить ответ. Доступен ручной повтор после проверки']; row.updatedAt = at();
      await queue.updateCase(current, { caseId: id, value: row, event: event('draft_error', id, 'Подготовка ответа не удалась; автоматический повтор этого письма остановлен'), commandId: stableCommandId('draft-error', current.revision, id, row.fingerprint, row.updatedAt) });
      if (!automatic) throw error;
      return null;
    }
    row.updatedAt = at();
    const kind = row.status === 'draft' ? 'draft' : 'draft_error';
    const result = await queue.updateCase(current, { caseId: id, value: row, event: event(kind, id, row.status === 'draft' ? 'Подготовлен черновик ответа. Клиенту не отправлен.' : 'Запрос требует дополнительных данных'), commandId: stableCommandId('draft', current.revision, id, row.fingerprint, row.processedAt) });
    return result.value.cases[id];
  }

  async function draft(id) { return exclusive(() => draftInternal(String(id))); }
  async function processBatch({ limit = 3 } = {}) { return exclusive(async () => {
    if (!crm) fail('CRM_UNAVAILABLE', 'Карточка недоступна');
    const snapshot = await queue.load();
    queue.assertReady(snapshot);
    const ids = Object.values(snapshot.value.cases).filter(row => row.status === 'queued' && row.body && row.recipient && !row.readFailed && row.fingerprint !== row.processedFingerprint).sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)) || String(a.id).localeCompare(String(b.id))).slice(0, Math.max(1, Math.min(10, limit))).map(row => String(row.id));
    let processed = 0, failed = 0;
    for (const id of ids) try { const result = await draftInternal(id, { automatic: true }); if (result) processed++; else failed++; } catch { failed++; }
    const result = { at: at(), processed, failed, attempted: ids.length };
    const latest = await queue.load(), value = clone(latest.value); queue.assertReady(latest); value.lastProcess = result;
    await queue.updateDocument(latest, { value, commandId: stableCommandId('process-batch', latest.revision, result.at) });
    return result;
  }); }

  async function bindThread(id, mailMessageId) { return exclusive(async () => {
    const current = await queue.load(), row = current.value.cases[String(id)];
    queue.assertReady(current);
    if (!row || !crm) fail('CASE_UNAVAILABLE', 'Карточка недоступна');
    return { message: await crm.readMailMessage(mailMessageId), caseId: String(id), mailMessageId: String(mailMessageId) };
  }); }

  async function send(id) { return exclusive(async () => {
    if (!replyEmail) fail('SEND_UNAVAILABLE', 'Отправитель не подключён');
    id = String(id);
    const current = await queue.load(), row = current.value.cases[id];
    queue.assertReady(current);
    assertCanSend(row, config);
    const checked = await fresh(row);
    if (!checked || ['closed', 'answered'].includes(checked.status) || checked.fingerprint !== row.fingerprint || checked.recipient !== row.recipient) fail('CASE_CHANGED', 'Переписка или получатель изменились');
    const attemptId = digest([id, row.fingerprint, row.draft.body]);
    const sendingRow = { ...row, status: 'sending', attemptId };
    const claimed = await queue.updateCase(current, { caseId: id, value: sendingRow, commandId: stableCommandId('sending', current.revision, id, attemptId) });
    if (claimed.replayed) fail('CLAIM_ALREADY_COMMITTED', 'Отправка по уже зафиксированной попытке не повторяется');
    const claimedSnapshot = { revision: claimed.revision, value: claimed.value, exists: true };
    try {
      const result = await replyEmail({ replyToMessageId: row.mailMessageId, from: config.sender, to: [row.recipient], subject: /^re:/iu.test(row.subject) ? row.subject : `Re: ${row.subject}`, body: row.draft.body });
      if (!result?.success) throw new Error('unconfirmed');
      const sentRow = { ...sendingRow, status: 'sent', sentAt: at() };
      const committed = await queue.updateCase(claimedSnapshot, { caseId: id, value: sentRow, event: event('sent', id, 'CRM приняла ответ. Доставка клиенту отдельно не подтверждена.'), commandId: stableCommandId('sent', claimed.revision, id, attemptId, sentRow.sentAt) });
      return committed.value.cases[id];
    } catch (error) {
      if (error?.code && ['OUTCOME_UNKNOWN', 'REVISION_CONFLICT', 'COMMAND_ID_REUSED'].includes(error.code)) throw error;
      const uncertainRow = { ...sendingRow, status: 'uncertain', updatedAt: at(), reasons: ['Результат отправки неизвестен. Автоповтор выключен; проверьте исходящие письма.'] };
      const committed = await queue.updateCase(claimedSnapshot, { caseId: id, value: uncertainRow, event: event('uncertain', id, 'Нужна сверка отправленного письма'), commandId: stableCommandId('uncertain', claimed.revision, id, attemptId, uncertainRow.updatedAt) });
      return committed.value.cases[id];
    }
  }); }

  return Object.freeze({ scan, draft, processBatch, bindThread, send, load: queue.load, get busy() { return busy; } });
}

module.exports = { createPostgresB2BRunner, B2BRunnerError, stableCommandId };
