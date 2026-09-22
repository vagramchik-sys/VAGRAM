'use strict';

// Async adapter for small business registries. Market facts use normalized tables.
// No filesystem fallback, process cache, automatic seeding, or external effects.
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
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

function createJsonDocumentRepository({ stateStore, logicalKey, validate, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!stateStore || !['read', 'write', 'remove'].every(method => typeof stateStore[method] === 'function'))
    throw new TypeError('A SQL state store is required');
  if (typeof logicalKey !== 'string' || logicalKey.length > 450 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/u.test(logicalKey))
    throw new TypeError('A canonical logical key is required');
  if (typeof validate !== 'function') throw new TypeError('A domain schema validator is required');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 320 * 1024 * 1024)
    throw new TypeError('An explicit supported byte limit is required');

  function validateDocument(value, stored) {
    let valid = false;
    try { valid = validate(value) === true; } catch {}
    if (!valid) fail(stored ? 'CORRUPT_DOCUMENT' : 'INVALID_DOCUMENT', 'Document does not match its domain schema');
  }

  async function read() {
    // Preserve tombstone revisions, so deletion cannot be mistaken for a new key.
    const record = await stateStore.read(logicalKey, { includeDeleted: true });
    if (!record) return null;
    if (record.deleted) return { revision: record.revision, deleted: true, value: null, sha256: null };
    if (record.mediaType !== MEDIA_TYPE || !Buffer.isBuffer(record.content) ||
        !Buffer.isBuffer(record.sha256) || record.sha256.length !== 32 || record.content.length > maxBytes)
      fail('CORRUPT_DOCUMENT', 'Stored document metadata is invalid');
    const digest = crypto.createHash('sha256').update(record.content).digest();
    if (!crypto.timingSafeEqual(digest, record.sha256)) fail('CORRUPT_DOCUMENT', 'Stored document checksum does not match');
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(record.content)); }
    catch { fail('CORRUPT_DOCUMENT', 'Stored document is not valid UTF-8 JSON'); }
    validateDocument(value, true);
    return { revision: record.revision, deleted: false, value, sha256: digest.toString('hex') };
  }

  async function compareAndSet(value, { expectedRevision, commandId } = {}) {
    const bytes = encodeJson(value, maxBytes);
    validateDocument(JSON.parse(bytes.toString('utf8')), false);
    // Caller owns expected revision and commandId. Never recompute either on an
    // uncertain commit or conflict: a repeat must describe the identical request.
    return stateStore.write(logicalKey, bytes, { expectedRevision, commandId, mediaType: MEDIA_TYPE });
  }

  async function remove({ expectedRevision, commandId } = {}) {
    return stateStore.remove(logicalKey, { expectedRevision, commandId, mediaType: MEDIA_TYPE });
  }
  return Object.freeze({ read, compareAndSet, remove });
}

module.exports = { createJsonDocumentRepository, encodeJson, JsonDocumentError, DEFAULT_MAX_BYTES };
