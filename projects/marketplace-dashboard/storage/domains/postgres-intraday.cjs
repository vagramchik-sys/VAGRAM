'use strict';
const { createJsonDocumentRepository } = require('../postgres-json-repository.cjs');
const { sourceKey } = require('../postgres-document-import.cjs');
const pure = require('../../intraday.cjs');
const crypto = require('node:crypto');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
class IntradayError extends Error { constructor(message, status = 400) { super(message); this.status = status; this.public = true; } }
const fail = (message, status) => { throw new IntradayError(message, status); };
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const empty = () => ({ version: 1, points: [], commandResults: [] });
function validState(value) { return object(value) && value.version === 1 && Array.isArray(value.points) && (value.commandResults === undefined || Array.isArray(value.commandResults) && value.commandResults.every(row => object(row) && UUID.test(row.commandId || '') && typeof row.timestamp === 'string' && Number.isFinite(Date.parse(row.timestamp)) && /^[a-f0-9]{64}$/u.test(row.inputHash || '') && typeof row.changed === 'boolean' && Number.isSafeInteger(row.pointCount))) && value.points.every(point => object(point) && ['orders', 'finance'].includes(point.source) && typeof point.date === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(point.date) && typeof point.at === 'string' && Number.isFinite(Date.parse(point.at)) && object(point.values) && Object.values(point.values).every(Number.isFinite) && (point.economy === undefined || object(point.economy) && Number.isFinite(point.economy.realized) && ['profit', 'cogs'].every(key => point.economy[key] === null || Number.isFinite(point.economy[key])))); }
function operation(value) { if (!object(value) || !UUID.test(value.commandId || '') || typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))) fail('Для сохранения нужны стабильные commandId и timestamp.'); return { commandId: value.commandId.toLowerCase(), timestamp: value.timestamp }; }
const storeName = id => { if (typeof id !== 'string' || !/^(?:wb-)?[0-9]+$/u.test(id)) fail('Некорректный идентификатор магазина.'); return `intraday-${id}.json`; };
module.exports = function createPostgresIntraday({ stateStore } = {}) {
  if (!stateStore) throw new TypeError('stateStore is required');
  const repository = id => { const sourcePath = storeName(id); return createJsonDocumentRepository({ stateStore, logicalKey: sourceKey(sourcePath), sourcePath, validate: validState, maxBytes: 32 * 1024 * 1024 }); };
  const inputHash = input => crypto.createHash('sha256').update(JSON.stringify({ orders: input?.orders ?? null, ledger: input?.ledger ?? null, products: input?.products ?? null })).digest('hex');
  const applyPoints = (before, input) => { const next = structuredClone(before); next.commandResults ||= []; for (const [source, data] of [['orders', input?.orders], ['finance', input?.ledger]]) { const candidate = pure.point(source, data, input?.products); if (!candidate || next.points.some(item => item.source === source && item.at === candidate.at)) continue; next.points.push(candidate); } next.points.sort((a, b) => a.at.localeCompare(b.at)); return next; };
  async function load(id) { const record = await repository(id).read(); return { record, value: record && !record.deleted ? record.value : empty() }; }
  async function capture(id, input, commandInput) {
    const op = operation(commandInput), detached = structuredClone(input || {}), intentHash = inputHash(detached), repo = repository(id), journal = await repo.readCommand(op.commandId);
    if (journal) { const receipt = (journal.after.value.commandResults || []).find(row => row.commandId === op.commandId); if (!receipt || receipt.timestamp !== op.timestamp || receipt.inputHash !== intentHash) { const error = Error('command reused'); error.code = 'COMMAND_ID_REUSED'; throw error; } await repo.compareAndSet(journal.after.value, { expectedRevision: journal.before.revision, commandId: op.commandId }); return { changed: receipt.changed, pointCount: receipt.pointCount }; }
    const loaded = await load(id), next = applyPoints(loaded.value, detached), result = { changed: next.points.length !== loaded.value.points.length, pointCount: next.points.length }; next.commandResults = [{ commandId: op.commandId, timestamp: op.timestamp, inputHash: intentHash, ...result }];
    try { await repo.compareAndSet(next, { expectedRevision: loaded.record?.revision || '0', commandId: op.commandId }); } catch (error) { if (error?.code === 'REVISION_CONFLICT') fail('Внутридневная история уже изменилась. Повторите сбор с новой командой.', 409); throw error; } return result;
  }
  async function series(ids, date) { if (!Array.isArray(ids) || ids.length > 1000 || new Set(ids).size !== ids.length) fail('Проверьте список магазинов.'); const histories = await Promise.all(ids.map(async id => (await load(id)).value.points)); return { date, orders: pure.combine(histories, 'orders', date), finance: pure.combine(histories, 'finance', date), storeCount: ids.length, intervalMinutes: 30, ordersIntervalMinutes: require('../../refresh-policy.cjs').ORDERS_INTERVAL / 60000, financeIntervalMinutes: 30 }; }
  return Object.freeze({ capture, series });
};
module.exports.IntradayError = IntradayError;
module.exports.validState = validState;
