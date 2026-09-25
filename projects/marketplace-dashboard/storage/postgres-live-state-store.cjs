'use strict';

// JSON bytes exist only transiently at the compatibility boundary. Supported
// marketplace sources never read or write legacy document payloads.
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { sourceKey } = require('./postgres-document-import.cjs');
const { encodeJson } = require('./postgres-json-repository.cjs');
const { classify } = require('./source-inventory.cjs');
const { requestHash } = require('./postgres-state.cjs');
const { isSupportedSourcePath } = require('./postgres-live-codecs.cjs');
const digest = content => crypto.createHash('sha256').update(content).digest();
const fail = code => { throw Object.assign(new Error(code), { code }); };

function createLiveStateStore({ legacyStateStore, sources, sourcePaths = [] } = {}) {
  if (!legacyStateStore || !['read', 'write', 'readCommand', 'remove'].every(method => typeof legacyStateStore[method] === 'function') || !sources?.document || !sources?.listSources || !sources?.repository?.readCommand || !Array.isArray(sourcePaths))
    throw new TypeError('Legacy registries and native marketplace sources are required');
  const knownPaths = new Map();
  function learn(sourcePath) {
    const key = sourceKey(sourcePath), previous = knownPaths.get(key);
    if (previous && previous !== sourcePath) fail('SOURCE_MAPPING_CONFLICT');
    knownPaths.set(key, sourcePath);
    return key;
  }
  sourcePaths.forEach(learn);
  async function resolve(key, mapping) {
    if (typeof key !== 'string' || key.length > 450 || !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/u.test(key)) fail('INVALID_ARGUMENT');
    if (mapping != null) {
      if (!mapping || typeof mapping !== 'object' || typeof mapping.sourcePath !== 'string') fail('INVALID_ARGUMENT');
      const sourcePath = mapping.sourcePath, classification = classify(sourcePath);
      if (sourceKey(sourcePath) !== key || mapping.logicalKey !== key || mapping.mediaType !== 'application/json' || mapping.domain !== classification.domain || classification.kind !== 'runtime') fail('INVALID_ARGUMENT');
      learn(sourcePath);
    }
    if (!knownPaths.has(key) && key.startsWith('file/')) for (const row of await sources.listSources()) learn(row.sourcePath);
    const sourcePath = knownPaths.get(key);
    return sourcePath && isSupportedSourcePath(sourcePath) ? sourcePath : null;
  }
  function nativeCommandId(value) {
    if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) fail('INVALID_ARGUMENT');
    return value.toLowerCase();
  }
  function stateRecord(key, record, includeContent = true) {
    const content = record && includeContent ? encodeJson(record.value, 480 * 1024 * 1024) : null;
    return record ? { logicalKey: key, mediaType: 'application/json', ...(includeContent ? { content, sha256: digest(content) } : {}), revision: String(record.revision), deleted: false, modifiedAt: record.head?.updatedAt } : null;
  }
  async function read(key, options = {}) {
    const sourcePath = await resolve(key);
    if (!sourcePath) return legacyStateStore.read(key, options);
    return stateRecord(key, await sources.record(sourcePath));
  }
  async function revisions(sourcePaths) {
    if (!Array.isArray(sourcePaths) || sourcePaths.length > 100 || sourcePaths.some(path => typeof path !== 'string')) fail('INVALID_ARGUMENT');
    const nativePaths = [], legacyPaths = [];
    for (const sourcePath of new Set(sourcePaths)) {
      sourceKey(sourcePath);
      (isSupportedSourcePath(sourcePath) ? nativePaths : legacyPaths).push(sourcePath);
    }
    const [native, legacy] = await Promise.all([
      nativePaths.length ? sources.revisions(nativePaths) : new Map(),
      legacyPaths.length ? legacyStateStore.readRevisions(legacyPaths.map(sourceKey)) : new Map()
    ]);
    return new Map(sourcePaths.map(sourcePath => [sourcePath, isSupportedSourcePath(sourcePath)
      ? native.get(sourcePath) : legacy.get(sourceKey(sourcePath))]));
  }
  async function write(key, content, options = {}) {
    // Detach bytes before resolving metadata asynchronously.
    if (!Buffer.isBuffer(content)) fail('INVALID_ARGUMENT');
    const detached = Buffer.from(content), detachedOptions = { ...options, ...(options.sourceMapping ? { sourceMapping: { ...options.sourceMapping } } : {}) };
    const sourcePath = await resolve(key, detachedOptions.sourceMapping);
    if (!sourcePath) return legacyStateStore.write(key, detached, detachedOptions);
    if (detachedOptions.mediaType !== 'application/json') fail('INVALID_ARGUMENT');
    const commandId = nativeCommandId(detachedOptions.commandId), revision = typeof detachedOptions.expectedRevision === 'bigint' ? detachedOptions.expectedRevision.toString() : detachedOptions.expectedRevision;
    if (typeof revision !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(revision)) fail('INVALID_ARGUMENT');
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(detached)); } catch { fail('INVALID_DOCUMENT'); }
    return sources.document(sourcePath).compareAndSet(value, { expectedRevision: revision, commandId, requestHash: requestHash('write', key, revision, 'application/json', detached).toString('hex') });
  }
  async function readCommand(key, commandId, options = {}) {
    const sourcePath = await resolve(key, options.sourceMapping);
    if (!sourcePath) return legacyStateStore.readCommand(key, commandId, options);
    const id = nativeCommandId(commandId);
    if (options.operation !== 'write') fail('UNSUPPORTED_LIVE_OPERATION');
    const receipt = await sources.repository.readCommand({ ...sources.identity(sourcePath), commandId: id });
    if (!receipt) return null;
    const command = await sources.document(sourcePath).readCommand(id);
    function stateImage(image) {
      if (image.absent) return { revision: '0', mediaType: null, content: null, sha256: null, deleted: null };
      const content = encodeJson(image.value, 480 * 1024 * 1024);
      return { revision: image.revision, mediaType: 'application/json', content, sha256: digest(content), deleted: image.deleted };
    }
    const before = stateImage(command.before), after = stateImage(command.after);
    const hash = receipt.sourceMetadata.requestHash ? Buffer.from(receipt.sourceMetadata.requestHash, 'hex') : requestHash('write', key, command.before.revision, 'application/json', after.content);
    return { commandId: id, operation: 'write', logicalKey: key, requestHash: hash, committedAt: receipt.updatedAt, before, after };
  }
  async function list(options = {}) {
    if (typeof legacyStateStore.list !== 'function') throw new TypeError('Registry listing is unavailable');
    const prefix = options.prefix ?? '', includeContent = options.includeContent ?? true;
    if (typeof prefix !== 'string' || prefix.length > 450 || prefix !== '' && !/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/u.test(prefix)) fail('INVALID_ARGUMENT');
    const native = await sources.listSources();
    native.forEach(row => learn(row.sourcePath));
    // Filter identities before ever requesting legacy content.
    const legacy = await legacyStateStore.list({ ...options, includeContent: false }), result = [];
    for (const row of legacy) {
      const sourcePath = knownPaths.get(row.logicalKey);
      if (sourcePath && isSupportedSourcePath(sourcePath)) continue;
      result.push(includeContent ? await legacyStateStore.read(row.logicalKey) : row);
    }
    for (const row of native) {
      const key = sourceKey(row.sourcePath);
      if (!key.startsWith(prefix)) continue;
      if (includeContent) result.push(stateRecord(key, await sources.record(row.sourcePath)));
      else result.push({ logicalKey: key, mediaType: 'application/json', revision: String(row.head.revision), deleted: false, modifiedAt: row.head.updatedAt });
    }
    return result.filter(Boolean).sort((a, b) => a.logicalKey < b.logicalKey ? -1 : a.logicalKey > b.logicalKey ? 1 : 0);
  }
  const methods = { read, readCommand, revisions, write, list, learn };
  for (const method of ['remove', 'writeWithEffect', 'writeWithProjection', 'writeStoreRegistry']) {
    if (typeof legacyStateStore[method] !== 'function') continue;
    methods[method] = async (key, ...args) => {
      const options = method === 'remove' ? args[0] : args[1];
      if (await resolve(key, options?.sourceMapping)) fail('UNSUPPORTED_LIVE_OPERATION');
      return legacyStateStore[method](key, ...args);
    };
  }
  return Object.freeze(methods);
}

module.exports = { createLiveStateStore };
