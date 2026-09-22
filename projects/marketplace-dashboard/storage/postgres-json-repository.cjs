'use strict';

// Async adapter for small business registries. Market facts use normalized tables.
// No filesystem fallback, process cache, automatic seeding, or external effects.
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const path = require('node:path');
const { classify } = require('./source-inventory.cjs');
const MEDIA_TYPE = 'application/json';
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

class JsonDocumentError extends Error {
  constructor(code, message) { super(message); this.name = 'JsonDocumentError'; this.code = code; }
}
const fail = (code, message) => { throw new JsonDocumentError(code, message); };

// Reject values that JSON.stringify would silently drop or coerce. Sorting only
// object keys makes retrying the same logical request byte-identical.
function encodeJson(value, maxBytes = DEFAULT_MAX_BYTES) {
  const ancestors = new Set();
  function encode(item, depth) {
    if (depth > 128) fail('INVALID_DOCUMENT', 'Document nesting exceeds the supported limit');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (!item || typeof item !== 'object' || ancestors.has(item)) fail('INVALID_DOCUMENT', 'Document must contain only JSON values');
    const array = Array.isArray(item);
    const proto = Object.getPrototypeOf(item);
    if (!array && proto !== Object.prototype && proto !== null) fail('INVALID_DOCUMENT', 'Document must contain plain JSON objects');
    if (Object.getOwnPropertySymbols(item).length) fail('INVALID_DOCUMENT', 'Document cannot contain symbol keys');
    ancestors.add(item);
    let result;
    if (array) {
      const keys = Object.keys(item);
      if (keys.length !== item.length || keys.some((key, index) => key !== String(index)))
        fail('INVALID_DOCUMENT', 'Document arrays must be dense and have no extra properties');
      result = '[' + keys.map(key => encodeDataProperty(item, key, depth)).join(',') + ']';
    } else {
      const keys = Object.getOwnPropertyNames(item).sort();
      result = '{' + keys.map(key => JSON.stringify(key) + ':' + encodeDataProperty(item, key, depth)).join(',') + '}';
    }
    ancestors.delete(item);
    return result;
  }
  function encodeDataProperty(object, key, depth) {
    const property = Object.getOwnPropertyDescriptor(object, key);
    if (!property || !property.enumerable || !Object.hasOwn(property, 'value'))
      fail('INVALID_DOCUMENT', 'Document properties must be enumerable data values');
    return encode(property.value, depth + 1);
  }
  const bytes = Buffer.from(encode(value, 0), 'utf8');
  if (bytes.length > maxBytes) fail('DOCUMENT_TOO_LARGE', 'Document exceeds the configured byte limit');
  return bytes;
}

const derivedKey = sourcePath => 'file/' + crypto.createHash('sha256').update(Buffer.from(sourcePath, 'utf8')).digest('hex');
const derivedMediaType = sourcePath => ({ '.json': 'application/json', '.jsonl': 'application/x-ndjson', '.dpapi': 'application/vnd.pult.dpapi',
  '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' })[path.extname(sourcePath).toLowerCase()] || 'application/octet-stream';

function createJsonDocumentRepository({ stateStore, logicalKey, sourcePath, validate, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!stateStore || !['read', 'write', 'remove'].every(method => typeof stateStore[method] === 'function'))
    throw new TypeError('A SQL state store is required');
  if (typeof logicalKey !== 'string' || logicalKey.length > 450 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/u.test(logicalKey))
    throw new TypeError('A canonical logical key is required');
  if (typeof validate !== 'function') throw new TypeError('A domain schema validator is required');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 320 * 1024 * 1024)
    throw new TypeError('An explicit supported byte limit is required');
  let sourceMapping = null;
  if (sourcePath !== undefined) {
    let classification;
    try { classification = classify(sourcePath); } catch { throw new TypeError('A canonical runtime sourcePath is required'); }
    const mediaType = derivedMediaType(sourcePath);
    if (classification.kind !== 'runtime' || ['history', 'archive-content'].includes(classification.domain) ||
        derivedKey(sourcePath) !== logicalKey || mediaType !== MEDIA_TYPE)
      throw new TypeError('sourcePath does not identify this JSON runtime document');
    sourceMapping = Object.freeze({ sourcePath, logicalKey, domain: classification.domain, mediaType });
  }

  function validateDocument(value, stored) {
    let valid = false;
    try { valid = validate(value) === true; } catch {}
    if (!valid) fail(stored ? 'CORRUPT_DOCUMENT' : 'INVALID_DOCUMENT', 'Document does not match its domain schema');
  }

  function decodeRecord(record, { allowAbsent = false, requireDeletedMedia = false } = {}) {
    if (allowAbsent && record && record.revision === '0' && record.deleted === null && record.mediaType === null && record.content === null && record.sha256 === null)
      return { revision: '0', absent: true, deleted: false, value: null, sha256: null };
    if (record?.deleted === true) {
      if (requireDeletedMedia && record.mediaType !== MEDIA_TYPE) fail('CORRUPT_DOCUMENT', 'Stored document metadata is invalid');
      if (requireDeletedMedia && (record.content !== null || record.sha256 !== null)) fail('CORRUPT_DOCUMENT', 'Stored document metadata is invalid');
      return { revision: record.revision, absent: false, deleted: true, value: null, sha256: null };
    }
    if (!record || record.mediaType !== MEDIA_TYPE) fail('CORRUPT_DOCUMENT', 'Stored document metadata is invalid');
    if (record.deleted !== false || !Buffer.isBuffer(record.content) || !Buffer.isBuffer(record.sha256) || record.sha256.length !== 32 || record.content.length > maxBytes)
      fail('CORRUPT_DOCUMENT', 'Stored document metadata is invalid');
    const digest = crypto.createHash('sha256').update(record.content).digest();
    if (!crypto.timingSafeEqual(digest, record.sha256)) fail('CORRUPT_DOCUMENT', 'Stored document checksum does not match');
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(record.content)); }
    catch { fail('CORRUPT_DOCUMENT', 'Stored document is not valid UTF-8 JSON'); }
    validateDocument(value, true);
    return { revision: record.revision, absent: false, deleted: false, value, sha256: digest.toString('hex') };
  }

  async function read() {
    // Preserve tombstone revisions, so deletion cannot be mistaken for a new key.
    const record = await stateStore.read(logicalKey, { includeDeleted: true });
    if (!record) return null;
    const decoded = decodeRecord(record);
    delete decoded.absent;
    return decoded;
  }

  async function readCommand(commandId) {
    if (typeof stateStore.readCommand !== 'function') throw new TypeError('SQL state store command journal access is required');
    const command = await stateStore.readCommand(logicalKey, commandId, { operation: 'write', sourceMapping });
    if (!command) return null;
    return Object.freeze({
      commandId: command.commandId,
      before: decodeRecord(command.before, { allowAbsent: true, requireDeletedMedia: true }),
      after: decodeRecord(command.after, { requireDeletedMedia: true })
    });
  }

  async function compareAndSet(value, { expectedRevision, commandId } = {}) {
    const bytes = encodeJson(value, maxBytes);
    validateDocument(JSON.parse(bytes.toString('utf8')), false);
    // Caller owns expected revision and commandId. Never recompute either on an
    // uncertain commit or conflict: a repeat must describe the identical request.
    return stateStore.write(logicalKey, bytes, { expectedRevision, commandId, mediaType: MEDIA_TYPE, ...(sourceMapping ? { sourceMapping } : {}) });
  }

  async function remove({ expectedRevision, commandId } = {}) {
    return stateStore.remove(logicalKey, { expectedRevision, commandId, mediaType: MEDIA_TYPE, ...(sourceMapping ? { sourceMapping } : {}) });
  }
  return Object.freeze({ read, readCommand, compareAndSet, remove });
}

module.exports = { createJsonDocumentRepository, encodeJson, JsonDocumentError, DEFAULT_MAX_BYTES };
