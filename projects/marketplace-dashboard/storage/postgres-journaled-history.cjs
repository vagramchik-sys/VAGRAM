'use strict';

const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { encodeJson } = require('./postgres-json-repository.cjs');

const MEDIA_TYPE = 'application/vnd.pult.history-command+json';
const HASH = /^[a-f0-9]{64}$/u;
const SOURCE = /^(?:insights-[0-9]+|ledger-[0-9]+|wb-orders-wb-[0-9]+|order-category-catalog-(?:wb-)?[0-9]+)\.json$/u;
const MAX_ENVELOPE_BYTES = 320 * 1024 * 1024;
const MAX_RAW_BYTES = 230 * 1024 * 1024;

class JournaledHistoryError extends Error {
  constructor(code, message) { super(message); this.name = 'JournaledHistoryError'; this.code = code; }
}
const fail = (code, message) => { throw new JournaledHistoryError(code, message); };

function canonical(value) {
  try { return encodeJson(value, MAX_ENVELOPE_BYTES); }
  catch { fail('INVALID_COMMAND', 'History command must contain strict JSON'); }
}

function dataProperty(input, name) {
  const property = Object.getOwnPropertyDescriptor(input, name);
  if (!property?.enumerable || !Object.hasOwn(property, 'value'))
    fail('INVALID_COMMAND', `History command ${name} must be an enumerable data value`);
  return property.value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

// All copying and validation deliberately happens before the first await.
function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype)
    fail('INVALID_COMMAND', 'History command must be a plain object');
  if (dataProperty(input, 'schemaVersion') !== 1 || dataProperty(input, 'kind') !== 'history.ingest')
    fail('UNSUPPORTED_COMMAND', 'Unsupported history command kind or schema version');
  const sourceFile = dataProperty(input, 'sourceFile');
  const suppliedHash = dataProperty(input, 'contentHash');
  const capturedAt = dataProperty(input, 'capturedAt');
  const commandId = dataProperty(input, 'commandId');
  const expectedRevision = dataProperty(input, 'expectedRevision');
  const suppliedRaw = dataProperty(input, 'raw');
  if (typeof sourceFile !== 'string' || !SOURCE.test(sourceFile) || typeof suppliedHash !== 'string' || !HASH.test(suppliedHash))
    fail('INVALID_COMMAND', 'History command source identity is invalid');
  if (typeof capturedAt !== 'string' || !Number.isFinite(Date.parse(capturedAt)) || new Date(capturedAt).toISOString() !== capturedAt)
    fail('INVALID_COMMAND', 'History command capturedAt must be canonical UTC');
  if (typeof commandId !== 'string' || typeof expectedRevision !== 'string') fail('INVALID_COMMAND', 'History command identity is missing');
  if (!Buffer.isBuffer(suppliedRaw) || suppliedRaw.length > MAX_RAW_BYTES)
    fail('INVALID_COMMAND', 'History command raw input is invalid or too large');
  const raw = Buffer.from(suppliedRaw);
  const actualHash = crypto.createHash('sha256').update(raw).digest('hex');
  if (actualHash !== suppliedHash) fail('CONTENT_HASH_MISMATCH', 'History command raw bytes do not match contentHash');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); }
  catch { fail('INVALID_JSON', 'History command raw input is not valid UTF-8'); }
  let data;
  try { data = JSON.parse(text); }
  catch { fail('INVALID_JSON', 'History command raw input is not valid JSON'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('INVALID_JSON', 'History command JSON root must be an object');
  canonical(data);
  deepFreeze(data);
  const envelope = canonical({
    schemaVersion: 1, kind: 'history.ingest', sourceFile, contentHash: actualHash, capturedAt,
    rawBytes: raw.length, rawBase64: raw.toString('base64')
  });
  return {
    commandId, expectedRevision, sourceFile, contentHash: actualHash, capturedAt, data, envelope,
    logicalKey: `history/${crypto.createHash('sha256').update(sourceFile).digest('hex')}`
  };
}

function createJournaledHistory({ stateStore, history } = {}) {
  if (!stateStore || typeof stateStore.writeWithEffect !== 'function') throw new TypeError('stateStore.writeWithEffect is required');
  if (!history || typeof history.ingestInTransaction !== 'function') throw new TypeError('history.ingestInTransaction is required');
  async function ingest(input) {
    const command = validate(input);
    return stateStore.writeWithEffect(command.logicalKey, command.envelope, {
      expectedRevision: command.expectedRevision, commandId: command.commandId, mediaType: MEDIA_TYPE
    }, client => history.ingestInTransaction({
      sourceFile: command.sourceFile, contentHash: command.contentHash, capturedAt: command.capturedAt, data: command.data
    }, client));
  }
  return Object.freeze({ ingest });
}

module.exports = { createJournaledHistory, JournaledHistoryError, MEDIA_TYPE, canonical, MAX_RAW_BYTES };
