'use strict';
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { sourceKey } = require('../postgres-document-import.cjs');

const KEY = sourceKey('stores.json'), MAPPING = Object.freeze({ sourcePath: 'stores.json', logicalKey: KEY, domain: 'protected-connections', mediaType: 'application/json' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const STORE = /^(?:wb-)?[0-9]+$/u, ALLOWED_NAMES = new Set(['SK', 'Современная канцелярия', 'СтальКрепеж', 'Строительный континент']);
const WB_ID = 'wb-250069159', WB_NAME = 'WB · СТАЛЬКРЕПЕЖ';
class StoreCommandError extends Error { constructor(code, message, status = 400) { super(message); this.name = 'StoreCommandError'; this.code = code; this.status = status; this.public = true; } }
const fail = (code, message, status) => { throw new StoreCommandError(code, message, status); };
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
function derivedCommandId(value) { const bytes = crypto.createHash('sha256').update(`pult:store-sync:${value}`).digest().subarray(0, 16); bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80; const hex = bytes.toString('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`; }
function operation(value) { if (!object(value) || !UUID.test(value.commandId || '') || typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp)) || typeof value.expectedRevision !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value.expectedRevision)) fail('INVALID_ARGUMENT', 'Для изменения нужны expectedRevision, commandId и timestamp.'); return { commandId: value.commandId.toLowerCase(), timestamp: value.timestamp, expectedRevision: value.expectedRevision }; }
function decode(record) {
  if (record === null || record === undefined) return {};
  const content = record.content, sha256 = record.sha256;
  if (record.mediaType !== 'application/json' || !Buffer.isBuffer(content) || !Buffer.isBuffer(sha256) || sha256.length !== 32) fail('DATA_INTEGRITY', 'Реестр магазинов повреждён.', 503);
  const actual = crypto.createHash('sha256').update(content).digest();
  if (!crypto.timingSafeEqual(actual, sha256)) fail('DATA_INTEGRITY', 'Реестр магазинов повреждён.', 503);
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content)); } catch { fail('DATA_INTEGRITY', 'Реестр магазинов повреждён.', 503); }
  if (!object(value)) fail('DATA_INTEGRITY', 'Реестр магазинов повреждён.', 503);
  return value;
}
function encode(value) { return Buffer.from(JSON.stringify(value), 'utf8'); }
function createPostgresStoreCommands({ stateStore, protect, ozonApi, wbApi, scheduleSync = async () => {}, allowedNames = ALLOWED_NAMES } = {}) {
  if (!stateStore || typeof stateStore.read !== 'function' || typeof stateStore.readCommand !== 'function' || typeof stateStore.writeStoreRegistry !== 'function' || typeof protect !== 'function' || typeof ozonApi !== 'function' || typeof wbApi !== 'function' || typeof scheduleSync !== 'function') throw new TypeError('Complete store command dependencies are required');
  const pending = new Map();
  function serialized(meta, work) { const id = typeof meta?.commandId === 'string' ? meta.commandId.toLowerCase() : 'invalid'; const prior = pending.get(id) || Promise.resolve(), run = prior.catch(() => {}).then(work); pending.set(id, run); return run.finally(() => { if (pending.get(id) === run) pending.delete(id); }); }
  async function journal(op, intent) { const row = await stateStore.readCommand(KEY, op.commandId, { operation: 'write', sourceMapping: MAPPING }); if (!row) return null; const saved = row.result; if (!saved || saved.operation !== intent.operation || saved.storeId !== intent.storeId || saved.timestamp !== op.timestamp || row.before.revision !== op.expectedRevision) fail('COMMAND_ID_REUSED', 'commandId уже использован для другой команды.', 409); return { row, saved }; }
  async function persist(next, op, intent) { const saved = await stateStore.writeStoreRegistry(KEY, encode(next), { expectedRevision: op.expectedRevision, commandId: op.commandId, mediaType: 'application/json', sourceMapping: MAPPING, intent }); return { revision: saved.revision, replayed: saved.replayed, ...saved.result }; }
  async function replayCredential(row, supplied) { const after = decode(row.after), storeId = row.result.storeId, savedStore = after[storeId], encrypted = savedStore?.key; if (typeof encrypted !== 'string') fail('DATA_INTEGRITY', 'Сохранённая команда подключения повреждена.', 503); let clear; try { clear = await protect(encrypted, true); } catch { fail('CREDENTIAL_UNAVAILABLE', 'Не удалось проверить защищённый ключ.', 503); } if (clear !== supplied) fail('COMMAND_ID_REUSED', 'commandId уже использован для другой команды.', 409); return savedStore; }
  async function load(op) { const record = await stateStore.read(KEY, { includeDeleted: true }); const revision = record?.revision || '0'; if (revision !== op.expectedRevision) fail('REVISION_CONFLICT', 'Реестр магазинов уже изменился.', 409); return { record, value: decode(record) }; }
  async function finishSync(result, op) { await scheduleSync({ storeId: result.storeId, commandId: derivedCommandId(op.commandId), sourceCommandId: op.commandId, timestamp: op.timestamp }); return result; }
  async function connectOzon(input, meta) {
    const op = operation(meta), clientId = String(input?.clientId || ''), name = input?.name, key = input?.key, intent = { operation: 'connect-ozon', storeId: clientId, timestamp: op.timestamp };
    if (!allowedNames.has(name) || !/^[0-9]+$/u.test(clientId) || typeof key !== 'string' || key.length < 20 || key.length > 500) fail('INVALID_ARGUMENT', 'Проверьте магазин, Client ID и ключ.');
    const old = await journal(op, intent); if (old) { const savedStore = await replayCredential(old.row, key); if (savedStore.name !== name || String(savedStore.clientId) !== clientId) fail('COMMAND_ID_REUSED', 'commandId уже использован для другой команды.', 409); return finishSync({ revision: old.row.after.revision, replayed: true, ...old.saved }, op); }
    const loaded = await load(op); if (Object.hasOwn(loaded.value, clientId)) fail('STORE_EXISTS', 'Этот магазин уже подключён.', 409);
    try { await ozonApi({ name, clientId }, key, '/v3/product/list', { filter: { visibility: 'ALL' }, last_id: '', limit: 1 }); } catch { fail('UPSTREAM_REJECTED', 'Ozon не подтвердил ключ магазина.'); }
    let ciphertext; try { ciphertext = await protect(key, false); } catch { fail('CREDENTIAL_UNAVAILABLE', 'Не удалось защитить ключ магазина.', 503); } if (typeof ciphertext !== 'string' || !ciphertext || ciphertext === key) fail('CREDENTIAL_UNAVAILABLE', 'Не удалось защитить ключ магазина.', 503);
    const next = structuredClone(loaded.value); next[clientId] = { name, clientId, key: ciphertext, connectedAt: op.timestamp };
    return finishSync(await persist(next, op, intent), op);
  }
  async function connectWb(input, meta) {
    const op = operation(meta), key = input?.key, intent = { operation: 'connect-wb', storeId: WB_ID, timestamp: op.timestamp };
    if (typeof key !== 'string' || key.length < 50 || key.length > 5000) fail('INVALID_ARGUMENT', 'Проверьте токен WB.');
    const old = await journal(op, intent); if (old) { await replayCredential(old.row, key); return finishSync({ revision: old.row.after.revision, replayed: true, ...old.saved }, op); }
    const loaded = await load(op); if (Object.hasOwn(loaded.value, WB_ID)) fail('STORE_EXISTS', 'Этот магазин WB уже подключён.', 409);
    try { await wbApi(key, 'content', '/content/v2/get/cards/list', { settings: { cursor: { limit: 1 }, filter: { withPhoto: -1 } } }); } catch { fail('UPSTREAM_REJECTED', 'WB не подтвердил токен магазина.'); }
    let ciphertext; try { ciphertext = await protect(key, false); } catch { fail('CREDENTIAL_UNAVAILABLE', 'Не удалось защитить токен WB.', 503); } if (typeof ciphertext !== 'string' || !ciphertext || ciphertext === key) fail('CREDENTIAL_UNAVAILABLE', 'Не удалось защитить токен WB.', 503);
    const next = structuredClone(loaded.value); next[WB_ID] = { name: WB_NAME, market: 'WB', clientId: WB_ID, key: ciphertext, connectedAt: op.timestamp };
    return finishSync(await persist(next, op, intent), op);
  }
  async function disconnect(input, meta) { const op = operation(meta), storeId = input?.storeId, intent = { operation: 'disconnect', storeId, timestamp: op.timestamp }; if (typeof storeId !== 'string' || !STORE.test(storeId)) fail('INVALID_ARGUMENT', 'Проверьте магазин.'); const old = await journal(op, intent); if (old) return { revision: old.row.after.revision, replayed: true, ...old.saved }; const loaded = await load(op); if (!Object.hasOwn(loaded.value, storeId)) fail('STORE_MISSING', 'Магазин не подключён.', 404); const next = structuredClone(loaded.value); delete next[storeId]; return persist(next, op, intent); }
  async function sync(input, meta) { const op = operation(meta), storeId = input?.storeId, intent = { operation: 'sync', storeId, timestamp: op.timestamp }; if (typeof storeId !== 'string' || !STORE.test(storeId)) fail('INVALID_ARGUMENT', 'Проверьте магазин.'); const old = await journal(op, intent); if (old) return finishSync({ revision: old.row.after.revision, replayed: true, ...old.saved }, op); const loaded = await load(op); if (!Object.hasOwn(loaded.value, storeId)) fail('STORE_MISSING', 'Магазин не подключён.', 404); const next = structuredClone(loaded.value); next[storeId].syncAttemptAt = op.timestamp; return finishSync(await persist(next, op, intent), op); }
  function queued(method, input, meta) {
    let savedInput, savedMeta;
    try { savedInput = structuredClone(input); savedMeta = structuredClone(meta); } catch { fail('INVALID_ARGUMENT', 'Некорректные параметры команды.'); }
    return serialized(savedMeta, () => method(savedInput, savedMeta));
  }
  return Object.freeze({ connectOzon: (input, meta) => queued(connectOzon, input, meta), connectWb: (input, meta) => queued(connectWb, input, meta), disconnect: (input, meta) => queued(disconnect, input, meta), sync: (input, meta) => queued(sync, input, meta) });
}
module.exports = { createPostgresStoreCommands, StoreCommandError, KEY, MAPPING, WB_ID, WB_NAME, derivedCommandId };
