'use strict';

// REST reference checked 2026-09-18:
// https://apidocs.bitrix24.com/api-reference/crm/timeline/activities/activity-base/crm-activity-list.html
// https://apidocs.bitrix24.com/tutorials/crm/how-to-add-crm-objects/how-to-send-email.html
// https://apidocs.bitrix24.com/api-reference/mail/message/mail-message-reply.html
// CRM timestamps describe an activity, not the original RFC e-mail timestamp.
// There is no documented activityId -> mailMessageId mapping here. Never infer it
// from ORIGIN_ID, subject, chronology, or undocumented SETTINGS. CRM attachments
// below are metadata only; their URLs can contain credentials and are not returned.
// crm.activity.add sends a NEW message and records an activity; it does not offer
// documented reply threading. mail.message.reply does, but does not guarantee a
// deal timeline entry or delivery. Neither write is retried by this adapter.

class BitrixError extends Error {
  constructor(code, outcome = 'not_sent') {
    super(`Bitrix24: ${code}`);
    this.name = 'BitrixError';
    this.code = code;
    this.outcome = outcome;
  }
}

const knownErrors = new Set(['ACCESS_DENIED', 'INVALID_CREDENTIALS', 'NO_AUTH_FOUND',
  'insufficient_scope', 'QUERY_LIMIT_EXCEEDED', 'OPERATION_TIME_LIMIT', 'ERROR_METHOD_NOT_FOUND',
  'expired_token', 'user_access_error', 'BITRIX_REST_V3_EXCEPTION_ACCESSDENIEDEXCEPTION',
  'BITRIX_REST_V3_EXCEPTION_ENTITYNOTFOUNDEXCEPTION',
  'BITRIX_REST_V3_EXCEPTION_VALIDATION_REQUESTVALIDATIONEXCEPTION']);
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function integer(value, min = 1) {
  if (!/^(0|[1-9]\d*)$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < min) {
    throw new BitrixError('INVALID_ARGUMENT');
  }
  return Number(value);
}
function text(value, max = 200000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new BitrixError('INVALID_ARGUMENT');
  return value;
}
function email(value) {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s<>@,;\r\n]+@[^\s<>@,;\r\n]+\.[^\s<>@,;\r\n]+$/.test(value)) throw new BitrixError('INVALID_EMAIL');
  return value;
}
function subject(value) {
  text(value, 998);
  if (/[\r\n]/.test(value)) throw new BitrixError('INVALID_ARGUMENT');
  return value;
}
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new BitrixError('UNSUPPORTED_ARGUMENT');
}
function iso(value) {
  // Never interpret a timezone-less timestamp using the machine's local zone.
  if (typeof value !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

class BitrixClient {
  #base; #v3base; #fetch; #maxPages; #timeoutMs;
  constructor({ webhook, fetchImpl = globalThis.fetch, maxPages = 100, timeoutMs = 20000 } = {}) {
    let url;
    try { url = new URL(webhook); } catch { throw new BitrixError('INVALID_WEBHOOK'); }
    if (typeof webhook !== 'string' || url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.bitrix24\.(ru|com)$/.test(url.hostname) ||
        !/^\/rest\/[1-9]\d*\/[a-zA-Z0-9_-]+\/$/.test(url.pathname) ||
        webhook.includes('\\') || /[\s%]/.test(webhook)) throw new BitrixError('INVALID_WEBHOOK');
    this.#base = url.href;
    this.#v3base = `${url.origin}${url.pathname.replace('/rest/', '/rest/api/')}`;
    this.#fetch = fetchImpl;
    this.#maxPages = integer(maxPages);
    this.#timeoutMs = integer(timeoutMs);
    if (this.#maxPages > 1000 || this.#timeoutMs > 120000 || typeof fetchImpl !== 'function') throw new BitrixError('INVALID_ARGUMENT');
  }

  async #call(method, params, { v3 = false, write = false } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    timer.unref?.();
    let response, payload;
    try {
      response = await this.#fetch(`${v3 ? this.#v3base : this.#base}${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(params), redirect: 'error', signal: controller.signal,
      });
      payload = await response.json();
    } catch {
      // Fetch/JSON errors may include the secret webhook URL. Do not attach cause.
      throw new BitrixError('TRANSPORT_ERROR', write ? 'unknown' : 'not_sent');
    } finally { clearTimeout(timer); }
    if (!object(payload)) throw new BitrixError('INVALID_RESPONSE', write ? 'unknown' : 'not_sent');
    if (payload.error || !response.ok) {
      const rawCode = object(payload.error) ? payload.error.code : payload.error;
      throw new BitrixError(knownErrors.has(rawCode) ? rawCode : 'API_ERROR', write ? 'unknown' : 'not_sent');
    }
    if (!Object.hasOwn(payload, 'result')) throw new BitrixError('INVALID_RESPONSE', write ? 'unknown' : 'not_sent');
    return payload;
  }

  async #list(method, params) {
    const rows = [], ids = new Set();
    let start = 0;
    for (let page = 0; page < this.#maxPages; page++) {
      const data = await this.#call(method, { ...params, start });
      if (!Array.isArray(data.result) || data.result.length > 50) throw new BitrixError('INVALID_RESPONSE');
      for (const item of data.result) {
        if (!object(item)) throw new BitrixError('INVALID_RESPONSE');
        const id = integer(item.ID);
        if (ids.has(id)) throw new BitrixError('UNSTABLE_PAGINATION');
        ids.add(id); rows.push(item);
      }
      if (data.next === undefined || data.next === null) {
        if (data.total !== undefined && integer(data.total, 0) > rows.length) throw new BitrixError('INCOMPLETE_PAGINATION');
        // A full page with neither next nor total gives no completion evidence.
        if (data.total === undefined && data.result.length === 50) throw new BitrixError('INCOMPLETE_PAGINATION');
        return rows;
      }
      const next = integer(data.next, 0);
      if (next <= start || data.result.length === 0) throw new BitrixError('UNSTABLE_PAGINATION');
      start = next;
    }
    throw new BitrixError('PAGINATION_LIMIT');
  }

  readCandidates(categoryId, stageId) {
    return this.#list('crm.deal.list', {
      filter: { CATEGORY_ID: integer(categoryId, 0), STAGE_ID: text(stageId, 100) },
      order: { ID: 'ASC' }, select: ['ID', 'TITLE', 'CATEGORY_ID', 'STAGE_ID', 'STAGE_SEMANTIC_ID',
        'ASSIGNED_BY_ID', 'CONTACT_ID', 'COMPANY_ID', 'DATE_CREATE', 'DATE_MODIFY', 'CLOSED'],
    });
  }

  readLeadCandidates(statusId = 'NEW') {
    return this.#list('crm.lead.list', {
      filter: { STATUS_ID: text(statusId, 100), HAS_EMAIL: 'Y' },
      order: { ID: 'ASC' }, select: ['ID', 'TITLE', 'STATUS_ID', 'STATUS_SEMANTIC_ID', 'EMAIL', 'HAS_EMAIL',
        'ASSIGNED_BY_ID', 'COMPANY_ID', 'CONTACT_ID', 'DATE_CREATE', 'DATE_MODIFY'],
    });
  }

  async readDeal(id) {
    const dealId = integer(id);
    const { result } = await this.#call('crm.deal.get', { id: dealId });
    if (!object(result) || Number(result.ID) !== dealId) throw new BitrixError('INVALID_RESPONSE');
    return result;
  }

  async readLead(id) {
    const leadId = integer(id);
    const { result } = await this.#call('crm.lead.get', { id: leadId });
    if (!object(result) || Number(result.ID) !== leadId) throw new BitrixError('INVALID_RESPONSE');
    return result;
  }

  listDealStages(categoryId) {
    const category = integer(categoryId, 0);
    return this.#list('crm.status.list', {
      filter: { ENTITY_ID: category === 0 ? 'DEAL_STAGE' : `DEAL_STAGE_${category}` }, order: { SORT: 'ASC', ID: 'ASC' },
    });
  }

  async readEmailActivities(dealId) {
    return this.#readOwnerEmailActivities(2, dealId, 'dealId');
  }

  async readLeadEmailActivities(leadId) {
    return this.#readOwnerEmailActivities(1, leadId, 'leadId');
  }

  async #readOwnerEmailActivities(ownerTypeId, ownerId, ownerIdKey) {
    const id = integer(ownerId);
    const rows = await this.#list('crm.activity.list', {
      filter: { BINDINGS: [{ OWNER_TYPE_ID: ownerTypeId, OWNER_ID: id }], TYPE_ID: 4 },
      order: { ID: 'ASC' }, select: ['*', 'COMMUNICATIONS', 'FILES', 'STORAGE_ELEMENT_IDS'],
    });
    const normalized = [];
    for (let item of rows) {
      if (typeof item.DESCRIPTION !== 'string' || !Array.isArray(item.COMMUNICATIONS)) {
        const { result } = await this.#call('crm.activity.get', { id: integer(item.ID) });
        if (!object(result) || Number(result.ID) !== Number(item.ID)) throw new BitrixError('INVALID_RESPONSE');
        item = { ...item, ...result };
      }
      if (Number(item.TYPE_ID) !== 4 || typeof item.DESCRIPTION !== 'string' || !Array.isArray(item.COMMUNICATIONS)) throw new BitrixError('INCOMPLETE_ACTIVITY');
      const direction = ({ 1: 'incoming', 2: 'outgoing' })[item.DIRECTION] || 'unknown';
      const bodyType = ({ 1: 'text', 2: 'html', 3: 'bbcode' })[item.DESCRIPTION_TYPE] || 'unknown';
      const createdAt = iso(item.CREATED), updatedAt = iso(item.LAST_UPDATED), activityStartAt = iso(item.START_TIME);
      normalized.push({
        id: integer(item.ID), [ownerIdKey]: id, direction, subject: String(item.SUBJECT || ''), body: item.DESCRIPTION,
        bodyType, createdAt, updatedAt, activityStartAt, originalMessageDate: null, mailMessageId: null,
        communications: item.COMMUNICATIONS.map(c => ({ value: String(c.VALUE || ''), entityId: Number(c.ENTITY_ID) || null,
          entityTypeId: Number(c.ENTITY_TYPE_ID) || null, type: String(c.TYPE || '') })),
        files: Array.isArray(item.FILES) ? item.FILES.map(f => ({ id: Number(f.id || f.ID) || null, name: String(f.name || f.NAME || '') })) : [],
        attachmentsUnknown: !Array.isArray(item.FILES) || (Array.isArray(item.STORAGE_ELEMENT_IDS) && item.STORAGE_ELEMENT_IDS.length > 0 && !item.FILES?.length),
        attachmentsRead: false,
        complete: direction !== 'unknown' && bodyType !== 'unknown' && !!createdAt,
        // Only public sender/recipient fields: never return provider data or opaque settings.
        settings: { MESSAGE_FROM: String(item.SETTINGS?.MESSAGE_FROM || ''), MESSAGE_TO: String(item.SETTINGS?.MESSAGE_TO || '') },
      });
    }
    return normalized;
  }

  async listMailSenders() {
    const rows = [];
    for (let page = 1; page <= this.#maxPages; page++) {
      const { result } = await this.#call('mail.mailbox.senders', { pagination: { page, limit: 100 } }, { v3: true });
      if (!object(result) || !Array.isArray(result.items) || result.items.length > 100) throw new BitrixError('INVALID_RESPONSE');
      for (const item of result.items) {
        if (!object(item) || typeof item.email !== 'string') throw new BitrixError('INVALID_RESPONSE');
        if (rows.some(row => row.email === item.email)) throw new BitrixError('UNSTABLE_PAGINATION');
        rows.push({ email: item.email, name: String(item.name || ''), sender: String(item.sender || '') });
      }
      if (result.items.length < 100) return rows;
    }
    throw new BitrixError('PAGINATION_LIMIT');
  }

  async readMailMessage(messageId) {
    const id = integer(messageId);
    const { result } = await this.#call('mail.message.get', { id,
      select: ['id', 'mailboxId', 'mailboxEmail', 'subject', 'from', 'to', 'cc', 'date', 'isSeen', 'hasAttachments', 'body'],
    }, { v3: true });
    if (!object(result?.item) || Number(result.item.id) !== id || typeof result.item.body !== 'string') throw new BitrixError('INVALID_RESPONSE');
    const item = result.item;
    return { id, mailboxId: Number(item.mailboxId) || null, mailboxEmail: String(item.mailboxEmail || ''),
      subject: String(item.subject || ''), from: String(item.from || ''), to: String(item.to || ''), cc: String(item.cc || ''),
      date: typeof item.date === 'string' ? item.date : null, body: item.body, isSeen: item.isSeen === true,
      hasAttachments: typeof item.hasAttachments === 'boolean' ? item.hasAttachments : null };
  }

  async readMailThread(messageId) {
    const id = integer(messageId);
    const { result } = await this.#call('mail.message.thread', { id, limit: 50 }, { v3: true });
    if (!Array.isArray(result)) throw new BitrixError('INVALID_RESPONSE');
    // This API has no documented continuation cursor. Never silently use a cut-off thread.
    if (result.length >= 50) throw new BitrixError('THREAD_LIMIT');
    if (!result.some(item => Number(item?.id) === id)) throw new BitrixError('INCOMPLETE_THREAD');
    const ids = new Set();
    return result.map(item => {
      if (!object(item) || typeof item.body !== 'string' || ids.has(Number(item.id))) throw new BitrixError('INVALID_RESPONSE');
      ids.add(integer(item.id));
      return { id: Number(item.id), subject: String(item.subject || ''), from: String(item.from || ''), to: String(item.to || ''),
        cc: String(item.cc || ''), date: typeof item.date === 'string' ? item.date : null, body: item.body };
    });
  }

  async replyEmail(params) {
    keys(params, ['replyToMessageId', 'from', 'to', 'subject', 'body']);
    if (!Array.isArray(params.to) || params.to.length !== 1) throw new BitrixError('INVALID_RECIPIENTS');
    const request = { replyToMessageId: integer(params.replyToMessageId), from: email(params.from), to: params.to.map(email),
      subject: subject(params.subject), body: text(params.body) };
    const { result } = await this.#call('mail.message.reply', request, { v3: true, write: true });
    if (!object(result) || result.success !== true || !Array.isArray(result.to) ||
        result.to.length !== request.to.length || result.to.some((to, i) => to !== request.to[i])) throw new BitrixError('INVALID_RESPONSE', 'unknown');
    return { success: true, to: [...result.to] };
  }

  async sendEmail(params) {
    keys(params, ['dealId', 'responsibleId', 'contactId', 'to', 'from', 'subject', 'body']);
    const fields = { OWNER_TYPE_ID: 2, OWNER_ID: integer(params.dealId), RESPONSIBLE_ID: integer(params.responsibleId),
      TYPE_ID: 4, DIRECTION: 2, COMPLETED: 'Y', DESCRIPTION_TYPE: 1,
      SUBJECT: subject(params.subject), DESCRIPTION: text(params.body),
      COMMUNICATIONS: [{ ENTITY_TYPE_ID: 3, ENTITY_ID: integer(params.contactId), VALUE: email(params.to) }],
      SETTINGS: { MESSAGE_FROM: email(params.from), DISABLE_SENDING_MESSAGE_COPY: 'Y' },
      START_TIME: new Date().toISOString(), END_TIME: new Date().toISOString() };
    const { result } = await this.#call('crm.activity.add', { fields }, { write: true });
    if (!/^[1-9]\d*$/.test(String(result)) || !Number.isSafeInteger(Number(result))) throw new BitrixError('INVALID_RESPONSE', 'unknown');
    return { activityId: Number(result) };
  }
}

module.exports = { BitrixClient, BitrixError };
