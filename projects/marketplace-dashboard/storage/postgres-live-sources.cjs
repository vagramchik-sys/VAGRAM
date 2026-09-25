'use strict';

const crypto = require('node:crypto');
const { encodeJson } = require('./postgres-json-repository.cjs');
const { sourceKey } = require('./postgres-document-import.cjs');
const codecs = require('./postgres-live-codecs.cjs');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const MAX_BYTES = 480 * 1024 * 1024;
const fail = code => { throw Object.assign(new Error(code), { code }); };

function nativeRevision(value) {
  const text = typeof value === 'bigint' ? value.toString() : value;
  if (typeof text === 'string' && !/^(0|[1-9][0-9]*)$/u.test(text)) fail('INVALID_ARGUMENT');
  if (typeof text !== 'string' && typeof text !== 'number') fail('INVALID_ARGUMENT');
  const revision = Number(text);
  if (!Number.isSafeInteger(revision) || revision < 0) fail('INVALID_ARGUMENT');
  return revision;
}
function validateValue(value, validate, stored) {
  let valid = false;
  try { valid = validate(value) === true; } catch {}
  if (!valid) fail(stored ? 'CORRUPT_DOCUMENT' : 'INVALID_DOCUMENT');
}
function collectionPaths(sourcePath, metadata) {
  // Counts retain historical empty types; only codec markers define presence.
  codecs.decodeMetadata(sourcePath, metadata);
  const result = [];
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, '__pultLiveCollection')) { result.push(value.__pultLiveCollection); return; }
    Object.values(value).forEach(walk);
  }
  walk(metadata);
  return result.sort();
}

function createLiveSources({ repository } = {}) {
  if (!repository || !['publishWithStatus', 'listRows', 'readAtRevision', 'readCommand', 'getHead', 'listHeads'].every(method => typeof repository[method] === 'function'))
    throw new TypeError('Native SQL facts repository is required');
  function identity(sourcePath) {
    const parsed = codecs.parseSourcePath(sourcePath);
    return { storeId: parsed.scope.storeId, domain: parsed.scope.domain };
  }
  function verifySource(head, sourcePath) {
    if (head.sourceMetadata.sourcePath !== sourcePath || head.sourceMetadata.logicalKey !== sourceKey(sourcePath)) fail('CORRUPT_DOCUMENT');
  }
  async function record(sourcePath, { revision, entities, validate, maxBytes = MAX_BYTES } = {}) {
    const scope = identity(sourcePath), requestedRevision = revision === undefined ? undefined : nativeRevision(revision);
    if (entities !== undefined && (!Array.isArray(entities) || entities.some(type => typeof type !== 'string'))) fail('INVALID_ARGUMENT');
    const current = requestedRevision === undefined && entities !== undefined && typeof repository.readCurrentCollections === 'function'
      ? await repository.readCurrentCollections({ ...scope, entityTypes: entities }) : null;
    const head = current ? current.head : requestedRevision === undefined ? await repository.getHead(scope) : (await repository.readAtRevision({ ...scope, revision: requestedRevision, limit: 1 })).head;
    if (!head) return null;
    verifySource(head, sourcePath);
    const present = collectionPaths(sourcePath, head.metadata), selected = entities === undefined ? present : present.filter(type => entities.includes(type)), collections = {};
    for (const entityType of selected) {
      collections[entityType] = [];
      if (current) {
        const rows = current.collections[entityType];
        if (!Array.isArray(rows) || !Number.isSafeInteger(head.entityCounts[entityType]) || head.entityCounts[entityType] < 0 || rows.length !== head.entityCounts[entityType]) fail('CORRUPT_DOCUMENT');
        for (const row of rows) collections[entityType].push({ key: row.entityKey, day: row.businessDay, ordinal: row.sourceOrder, value: row.value });
        continue;
      }
      let after;
      for (let offset = 0; ; offset += 10000) {
        const options = { ...scope, entityType, limit: 10000, offset };
        const page = requestedRevision === undefined ? await repository.listRows({ ...scope, entityType, limit: 10000, after, includeTotal: false, expectedRevision: head.revision }) : await repository.readAtRevision({ ...options, revision: requestedRevision });
        if (!Number.isSafeInteger(head.entityCounts[entityType]) || head.entityCounts[entityType] < 0 || requestedRevision !== undefined && head.entityCounts[entityType] !== page.total) fail('CORRUPT_DOCUMENT');
        for (const row of page.rows) collections[entityType].push({ key: row.entityKey, day: row.businessDay, ordinal: row.sourceOrder, value: row.value });
        if (requestedRevision === undefined) {
          const count = collections[entityType].length;
          if (count > head.entityCounts[entityType]) fail('CORRUPT_DOCUMENT');
          if (page.rows.length < 10000) {
            if (count !== head.entityCounts[entityType]) fail('CORRUPT_DOCUMENT');
            break;
          }
          const last = page.rows[page.rows.length - 1];
          after = {sourceOrder:last.sourceOrder,entityType:last.entityType,entityKey:last.entityKey,occurrence:last.occurrence};
          continue;
        }
        if (offset + page.rows.length >= page.total) break;
        if (!page.rows.length) fail('CORRUPT_DOCUMENT');
      }
    }
    const value = codecs.decode(sourcePath, { metadata: head.metadata, collections }, { partial: entities !== undefined });
    if (validate) validateValue(value, validate, true);
    const sha256 = digest(encodeJson(value, maxBytes));
    return { revision: String(head.revision), deleted: false, value, sha256, head };
  }
  function document(sourcePath, { validate = () => true, maxBytes = MAX_BYTES } = {}) {
    const scope = identity(sourcePath);
    if (typeof validate !== 'function' || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) throw new TypeError('Invalid live document options');
    const documentRecord = (item, includeAbsent = false) => item ? { revision: item.revision, ...(includeAbsent ? { absent: false } : {}), deleted: item.deleted, value: item.value, sha256: item.sha256 } : null;
    async function read() { return documentRecord(await record(sourcePath, { validate, maxBytes })); }
    async function compareAndSet(value, { expectedRevision, commandId, requestHash } = {}) {
      // Detach intent before the first awaited metadata lookup.
      const bytes = encodeJson(value, maxBytes), detached = JSON.parse(bytes.toString('utf8')), wantedRevision = nativeRevision(expectedRevision);
      validateValue(detached, validate, false);
      if (requestHash !== undefined && !/^[a-f0-9]{64}$/u.test(requestHash)) fail('INVALID_ARGUMENT');
      const encoded = codecs.encode(sourcePath, detached);
      let prior = await repository.readCommand({ ...scope, commandId }), before;
      if (!prior) {
        before = await repository.getHead(scope);
        // An identical command may commit between the two reads.
        prior = await repository.readCommand({ ...scope, commandId });
      }
      if (prior) before = prior.beforeHead;
      if (before) verifySource(before, sourcePath);
      const partitions = Object.entries(encoded.collections).map(([entityType, rows]) => ({ entityType, scope: { kind: 'all' }, rows: rows.map(row => ({ entityKey: row.key, businessDay: row.day, sourceOrder: row.ordinal, value: row.value })) }));
      for (const type of before ? collectionPaths(sourcePath, before.metadata) : []) {
        if (!Object.hasOwn(encoded.collections, type)) partitions.push({ entityType: type, scope: { kind: 'all' }, rows: [] });
      }
      partitions.sort((a, b) => a.entityType < b.entityType ? -1 : a.entityType > b.entityType ? 1 : 0);
      let result;
      try {
        result = await repository.publishWithStatus({ ...scope, commandId, expectedRevision: wantedRevision, metadata: encoded.metadata,
          sourceMetadata: { sourcePath, logicalKey: sourceKey(sourcePath), sourceSha256: digest(bytes), ...(requestHash === undefined ? {} : { requestHash }) }, partitions });
      } catch (error) {
        if (error?.code === 'COMMAND_INTENT_CONFLICT') fail('COMMAND_ID_REUSED');
        throw error;
      }
      return { revision: String(result.receipt.revision), replayed: result.replayed };
    }
    async function readCommand(commandId) {
      const receipt = await repository.readCommand({ ...scope, commandId });
      if (!receipt) return null;
      verifySource(receipt.afterHead, sourcePath);
      const before = receipt.beforeHead ? documentRecord(await record(sourcePath, { revision: receipt.beforeHead.revision, validate, maxBytes }), true) : { revision: '0', absent: true, deleted: false, value: null, sha256: null };
      const after = documentRecord(await record(sourcePath, { revision: receipt.afterHead.revision, validate, maxBytes }), true);
      return Object.freeze({ commandId, before, after });
    }
    return Object.freeze({ read, readCommand, compareAndSet });
  }
  async function listSources() {
    const heads = await repository.listHeads({}), result = [];
    for (const head of heads) {
      const sourcePath = head.sourceMetadata.sourcePath;
      if (sourcePath === undefined) continue;
      if (typeof sourcePath !== 'string') fail('CORRUPT_DOCUMENT');
      verifySource(head, sourcePath);
      const scope = identity(sourcePath);
      if (scope.storeId !== head.storeId || scope.domain !== head.domain) fail('CORRUPT_DOCUMENT');
      result.push({ sourcePath, head });
    }
    return result;
  }
  async function revisions(sourcePaths) {
    if (!Array.isArray(sourcePaths) || sourcePaths.some(path => typeof path !== 'string')) fail('INVALID_ARGUMENT');
    const wanted = new Map(), result = new Map();
    for (const sourcePath of sourcePaths) {
      if (!codecs.isSupportedSourcePath(sourcePath)) continue;
      const scope = identity(sourcePath);
      wanted.set(`${scope.domain}\u0000${scope.storeId}`, sourcePath);
      result.set(sourcePath, '0');
    }
    if (!wanted.size) return result;
    for (const head of await repository.listHeads({})) {
      const sourcePath = wanted.get(`${head.domain}\u0000${head.storeId}`);
      if (!sourcePath) continue;
      verifySource(head, sourcePath);
      result.set(sourcePath, String(head.revision));
    }
    return result;
  }
  return Object.freeze({ document, record, identity, listSources, revisions, repository });
}

module.exports = { createLiveSources, nativeRevision };
