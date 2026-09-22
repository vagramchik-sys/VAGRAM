'use strict';

const { createJsonDocumentRepository } = require('./postgres-json-repository.cjs');
const { sourceKey } = require('./postgres-document-import.cjs');

const LOGICAL_KEY = sourceKey('b2b-agent/queue.json');
const PROTECTED = new Set(['sending', 'uncertain', 'sent', 'answered']);
const TERMINAL = new Set(['uncertain', 'sent', 'answered']);
const RECOVERY_REASON = 'После остановки неизвестен результат отправки. Нужна сверка с почтой.';

class B2BQueueError extends Error {
  constructor(code, message) { super(message); this.name = 'B2BQueueError'; this.code = code; }
}
const fail = (code, message) => { throw new B2BQueueError(code, message); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const jsonValue = value => {
  if (value === null || ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value)) return true;
  if (Array.isArray(value)) return value.every(jsonValue);
  return plain(value) && Object.values(value).every(jsonValue);
};
const optionalObject = value => value === undefined || value === null || plain(value) && jsonValue(value);

function validateQueue(value) {
  if (!plain(value) || value.version !== 1 || !plain(value.cases) || !Array.isArray(value.events) || value.events.length > 500 || !Object.hasOwn(value, 'lastScan') || !optionalObject(value.lastScan)) return false;
  if (!optionalObject(value.lastProcess) || value.messageClaims !== undefined && !plain(value.messageClaims)) return false;
  for (const [id, row] of Object.entries(value.cases)) {
    if (!id || !plain(row) || !jsonValue(row) || typeof row.status !== 'string') return false;
  }
  for (const event of value.events) {
    if (!plain(event) || typeof event.kind !== 'string' || !event.kind || event.caseId !== null && typeof event.caseId !== 'string' || typeof event.message !== 'string' || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))) return false;
  }
  if (value.messageClaims !== undefined) for (const claim of Object.values(value.messageClaims)) {
    if (!plain(claim) || typeof claim.ownerId !== 'string' || typeof claim.status !== 'string') return false;
  }
  return jsonValue(value);
}

const emptyQueue = () => ({ version: 1, cases: {}, events: [], lastScan: null });
const clone = value => structuredClone(value);
function snapshot(value) {
  if (!value || typeof value.revision !== 'string' || !/^(0|[1-9]\d*)$/u.test(value.revision) || !validateQueue(value.value)) fail('INVALID_SNAPSHOT', 'Queue snapshot is invalid');
  return value;
}
function command(value) {
  if (typeof value !== 'string') fail('INVALID_COMMAND', 'A stable commandId is required');
  return value;
}
function eventValue(event) {
  if (!plain(event) || !validateQueue({ version: 1, cases: {}, events: [event], lastScan: null })) fail('INVALID_EVENT', 'Queue event is invalid');
  return clone(event);
}

function assertMutation(before, after) {
  const claims = after.messageClaims || {}, required = new Map();
  const allowedStatus = (from, to) => from === 'sending' ? ['sending', 'sent', 'uncertain'].includes(to) : from === to;
  const identity = row => [row.incomingId == null ? null : String(row.incomingId), row.attemptId == null ? null : String(row.attemptId)];
  for (const [caseId, previous] of Object.entries(before.cases)) if (PROTECTED.has(previous.status)) {
    const next = after.cases[caseId];
    if (!next || !allowedStatus(previous.status, next.status) || JSON.stringify(identity(previous)) !== JSON.stringify(identity(next)))
      fail('TERMINAL_STATUS', 'A protected case requires a separate owner resolution');
    if (previous.status === 'sending' && (previous.recipient || null) !== (next.recipient || null) || previous.status === 'sending' && (previous.draft?.body || null) !== (next.draft?.body || null))
      fail('ATTEMPT_CHANGED', 'An in-flight send attempt is immutable');
  }
  for (const [caseId, row] of Object.entries(after.cases)) if (row.incomingId && PROTECTED.has(row.status)) {
    const incomingId = String(row.incomingId), ownerId = String(row.id || caseId), prior = required.get(incomingId);
    if (prior && prior !== ownerId) fail('MESSAGE_CLAIMED', 'The incoming message is already claimed');
    required.set(incomingId, ownerId);
    const claim = claims[incomingId];
    if (!claim || claim.ownerId !== ownerId || claim.status !== row.status) fail('INVALID_CLAIM', 'Protected cases require a matching durable claim');
  }
  for (const [incomingId, previous] of Object.entries(before.messageClaims || {})) if (PROTECTED.has(previous.status)) {
    const next = claims[incomingId];
    if (!next || next.ownerId !== previous.ownerId) fail('MESSAGE_CLAIMED', 'A protected message claim cannot be removed or reassigned');
    if (!allowedStatus(previous.status, next.status)) fail('INVALID_CLAIM', 'A protected message claim cannot be downgraded');
  }
}

function createPostgresB2BQueue({ stateStore, maxBytes = 25 * 1024 * 1024 } = {}) {
  const repository = createJsonDocumentRepository({ stateStore, logicalKey: LOGICAL_KEY, sourcePath: 'b2b-agent/queue.json', validate: validateQueue, maxBytes });

  async function load() {
    const record = await repository.read();
    if (!record || record.deleted) return { revision: record?.revision || '0', value: emptyQueue(), exists: false };
    return { revision: record.revision, value: record.value, exists: true };
  }

  async function commit(current, value, commandId) {
    current = snapshot(current); command(commandId);
    if (!validateQueue(value)) fail('INVALID_QUEUE', 'Queue document is invalid');
    assertMutation(current.value, value);
    const result = await repository.compareAndSet(value, { expectedRevision: current.revision, commandId });
    return { ...result, value: clone(value) };
  }

  function assertReady(current) {
    current = snapshot(current);
    assertMutation(current.value, current.value);
    return true;
  }

  async function recover(current, { commandId } = {}) {
    current = snapshot(current);
    const value = clone(current.value), recovered = [];
    value.messageClaims ||= {};
    for (const [caseId, row] of Object.entries(value.cases)) if (PROTECTED.has(row.status)) {
      const ownerId = String(row.id || caseId), incomingId = row.incomingId === undefined || row.incomingId === null ? null : String(row.incomingId);
      const existing = incomingId ? value.messageClaims[incomingId] : null;
      if (existing && existing.ownerId !== ownerId) fail('MESSAGE_CLAIMED', 'The incoming message is already claimed');
      if (row.status === 'sending') { row.status = 'uncertain'; row.reasons = [RECOVERY_REASON]; recovered.push(caseId); }
      if (incomingId && (!existing || existing.status !== row.status)) value.messageClaims[incomingId] = { ownerId, status: row.status };
    }
    const changed = recovered.length > 0 || JSON.stringify(value.messageClaims || {}) !== JSON.stringify(current.value.messageClaims || {});
    if (!changed) return { changed: false, revision: current.revision, value };
    const result = await commit(current, value, commandId);
    return { changed: true, recovered, ...result };
  }

  async function updateCase(current, { caseId, value: nextCase, claim = null, event = null, commandId } = {}) {
    current = snapshot(current);
    caseId = String(caseId || '');
    if (!caseId || !plain(nextCase) || !jsonValue(nextCase) || String(nextCase.id || caseId) !== caseId || typeof nextCase.status !== 'string') fail('INVALID_CASE', 'Queue case is invalid');
    const value = clone(current.value), previous = value.cases[caseId];
    const incomingId = nextCase.incomingId === undefined || nextCase.incomingId === null ? null : String(nextCase.incomingId);
    value.messageClaims ||= {};
    if (incomingId && PROTECTED.has(nextCase.status)) {
      const existing = value.messageClaims[incomingId];
      if (existing && existing.ownerId !== caseId) fail('MESSAGE_CLAIMED', 'The incoming message is already claimed');
      value.messageClaims[incomingId] = { ownerId: caseId, status: nextCase.status };
    }
    if (claim !== null) {
      if (!plain(claim) || String(claim.ownerId || '') !== caseId || claim.status !== nextCase.status || !PROTECTED.has(nextCase.status) || !incomingId) fail('INVALID_CLAIM', 'Message claim is invalid');
      const existing = value.messageClaims[incomingId];
      if (existing && existing.ownerId !== caseId) fail('MESSAGE_CLAIMED', 'The incoming message is already claimed');
      value.messageClaims[incomingId] = { ownerId: caseId, status: claim.status };
    }
    value.cases[caseId] = clone(nextCase);
    if (event !== null) value.events = [eventValue(event), ...value.events].slice(0, 500);
    return commit(current, value, commandId);
  }

  async function updateEvent(current, { event, commandId } = {}) {
    current = snapshot(current);
    const value = clone(current.value);
    value.events = [eventValue(event), ...value.events].slice(0, 500);
    return commit(current, value, commandId);
  }

  async function updateDocument(current, { value, commandId } = {}) {
    return commit(current, clone(value), commandId);
  }

  return Object.freeze({ load, assertReady, recover, updateCase, updateEvent, updateDocument, logicalKey: LOGICAL_KEY });
}

module.exports = { createPostgresB2BQueue, validateQueue, B2BQueueError, LOGICAL_KEY, RECOVERY_REASON };
