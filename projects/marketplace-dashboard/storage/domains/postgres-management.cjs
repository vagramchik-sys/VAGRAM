'use strict';

const crypto = require('node:crypto');
const { isInactive } = require('../../dist/dashboard-model.js');
const { createJsonDocumentRepository } = require('../postgres-json-repository.cjs');
const { sourceKey } = require('../postgres-document-import.cjs');

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
class ManagementError extends Error { constructor(message, status = 400) { super(message); this.name = 'ManagementError'; this.status = status; this.public = true; } }
const fail = (message, status) => { throw new ManagementError(message, status); };
function version(product) { return digest({ key: product.key, pricing: product.pricing && { ...product.pricing, importedAt: undefined }, cost: product.cost?.unitCost, archived: product.archived, status: product.salesStatus }); }
const cents = value => Math.round((value + Number.EPSILON) * 100) / 100;
const moneyValid = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 10000000 && Math.abs(value * 100 - Math.round(value * 100)) < 0.000001;
const empty = () => ({ batches: [], notes: {}, events: [] });
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const validState = value => object(value) && Object.keys(value).every(key => ['batches', 'notes', 'events'].includes(key)) &&
  Array.isArray(value.batches) && value.batches.length <= 10000 && value.batches.every(batch => object(batch) && UUID.test(batch.id || '') &&
    Number.isSafeInteger(batch.number) && batch.number > 0 && typeof batch.requestId === 'string' && /^[a-f0-9]{64}$/u.test(batch.requestHash || '') &&
    typeof batch.title === 'string' && typeof batch.reason === 'string' && ['draft', 'submitted', 'returned', 'cancelled'].includes(batch.status) &&
    Number.isSafeInteger(batch.version) && batch.version > 0 && instant(batch.createdAt) && instant(batch.updatedAt) && Array.isArray(batch.rows)) &&
  object(value.notes) && Object.values(value.notes).every(note => object(note) && typeof note.text === 'string' && ['normal', 'attention', 'purchase'].includes(note.flag) && Number.isSafeInteger(note.version) && note.version > 0 && instant(note.updatedAt)) &&
  Array.isArray(value.events) && value.events.length <= 50000 && value.events.every(item => object(item) && UUID.test(item.id || '') && instant(item.at) && typeof item.type === 'string');
function operation(value) {
  if (!object(value) || !UUID.test(value.commandId || '')) fail('Некорректный идентификатор команды');
  if (typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))) fail('Не удалось определить время сохранения', 500);
  return { commandId: value.commandId.toLowerCase(), timestamp: value.timestamp };
}
function stableUuid(commandId, label) {
  const bytes = crypto.createHash('sha256').update(commandId).update('\0').update(label).digest().subarray(0, 16);
  bytes[6] = bytes[6] & 0x0f | 0x40; bytes[8] = bytes[8] & 0x3f | 0x80;
  const hex = bytes.toString('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function createPostgresManagement({ stateStore, catalog, clock = () => new Date().toISOString() } = {}) {
  if (typeof catalog !== 'function') throw new TypeError('catalog must be an async product provider');
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  const repository = createJsonDocumentRepository({ stateStore, logicalKey: sourceKey('management.json'), sourcePath: 'management.json', validate: validState });
  async function load() {
    const record = await repository.read();
    return { record, value: record && !record.deleted ? record.value : empty() };
  }
  async function productsFor(state) {
    const rows = await catalog();
    if (!Array.isArray(rows)) throw new TypeError('catalog must resolve to an array');
    return rows.map(product => ({ ...structuredClone(product), version: version(product), note: structuredClone(state.notes[product.key] || { text: '', flag: 'normal', version: 0 }) }));
  }
  async function products() { return productsFor((await load()).value); }
  async function previewWith(input, state, at) {
    if (!Array.isArray(input?.targets) || !input.targets.length || input.targets.length > 3000) fail('Выберите от 1 до 3000 товаров');
    if (!['set', 'percent', 'delta', 'costplus'].includes(input.mode) || typeof input.amount !== 'number' || !Number.isFinite(input.amount) || Math.abs(input.amount) > 10000000) fail('Укажите корректное изменение цены');
    if (![0, 1, 10, 100].includes(input.rounding)) fail('Выберите округление');
    if (input.fields !== undefined && (input.targets.length !== 1 || !object(input.fields) || Object.keys(input.fields).some(key => !['minPrice', 'oldPrice', 'discount'].includes(key)))) fail('Дополнительные поля доступны для одного товара');
    const map = new Map((await productsFor(state)).map(product => [product.key, product])), seen = new Set();
    const rows = input.targets.map(target => {
      if (!target || typeof target.key !== 'string' || seen.has(target.key)) fail('Повтор или неверный товар в заявке'); seen.add(target.key);
      const product = map.get(target.key); if (!product) fail('Товар отсутствует в подключённых магазинах');
      const errors = [], warnings = [], before = product.pricing || {};
      if (target.version !== product.version) errors.push('Данные товара изменились. Обновите каталог');
      if (isInactive(product)) errors.push('Товар архивный или снят с продажи');
      if (before.price !== 0 && !moneyValid(before.price)) errors.push(before.multiplePrices ? 'У размеров разные цены. Поразмерное редактирование пока недоступно' : 'Сначала загрузите цену товара');
      if (before.price === 0) warnings.push('Выгружена нулевая цена — проверьте карточку перед отправкой');
      if (before.currency !== 'RUB') errors.push('Редактирование доступно для цен в рублях');
      const priceAge = Date.parse(at) - Date.parse(before.importedAt); if (!Number.isFinite(priceAge) || priceAge > 86400000) errors.push('Цены старше 24 часов. Обновите цены магазина');
      let price = input.mode === 'set' ? input.amount : input.mode === 'percent' ? before.price * (1 + input.amount / 100) : input.mode === 'delta' ? before.price + input.amount : product.cost?.unitCost * (1 + input.amount / 100);
      if (input.mode === 'costplus' && (product.cost?.status !== 'filled' || product.cost.currency !== before.currency)) errors.push('Для расчёта нужна себестоимость в валюте цены');
      price = input.rounding ? Math.round(price / input.rounding) * input.rounding : cents(price);
      const after = { price, minPrice: before.minPrice ?? null, oldPrice: before.oldPrice ?? null, discount: before.discount ?? null, ...input.fields };
      if (!moneyValid(price)) errors.push('Цена должна быть от 0,01 до 10 000 000 ₽');
      if (product.market === 'WB') {
        if (!Number.isInteger(price)) errors.push('Базовая цена WB должна быть целым числом рублей');
        if (input.fields && ('oldPrice' in input.fields || 'minPrice' in input.fields)) errors.push('Поля минимальной и старой цены относятся к Ozon');
        if (!Number.isInteger(after.discount) || after.discount < 0 || after.discount > 99) errors.push('Скидка WB — целое число от 0 до 99%');
      } else {
        if (input.fields && 'discount' in input.fields) errors.push('Скидка WB не относится к Ozon');
        for (const name of ['minPrice', 'oldPrice']) if (after[name] !== null && after[name] !== 0 && !moneyValid(after[name])) errors.push('Проверьте минимальную цену и цену до скидки');
        if (after.minPrice > price) errors.push('Новая цена ниже минимальной цены Ozon');
        if (after.oldPrice > 0 && after.oldPrice <= price) errors.push('Цена до скидки должна быть выше новой цены или равна нулю');
      }
      if (!['price', 'minPrice', 'oldPrice', 'discount'].some(key => (before[key] ?? null) !== after[key])) errors.push('Нет изменений');
      const effective = product.market === 'WB' ? cents(price * (1 - after.discount / 100)) : price;
      if (product.cost?.status === 'filled' && product.cost.currency === before.currency) { if (effective < product.cost.unitCost) warnings.push('Цена ниже себестоимости'); }
      else warnings.push('Себестоимость не заполнена или не сопоставлена');
      const changePercent = before.price ? cents((price / before.price - 1) * 100) : null; if (Math.abs(changePercent) > 30) warnings.push('Изменение базовой цены больше 30%');
      if (product.market === 'WB' && effective <= before.price * (1 - before.discount / 100) / 3) warnings.push('Цена со скидкой снизится в 3 раза или больше: возможен карантин WB');
      const pending = state.batches.find(batch => ['draft', 'submitted'].includes(batch.status) && batch.rows.some(row => row.key === product.key));
      if (pending) errors.push('Товар уже есть в открытой заявке ' + pending.number);
      return { key: product.key, version: product.version, name: product.name, offer_id: product.offer_id, storeName: product.storeName, market: product.market, currency: before.currency, importedAt: before.importedAt, before: { price: before.price, minPrice: before.minPrice ?? null, oldPrice: before.oldPrice ?? null, discount: before.discount ?? null }, after, changePercent, effective, cost: product.cost?.status === 'filled' ? product.cost.unitCost : null, errors, warnings };
    });
    const hash = digest(rows.map(row => ({ key: row.key, version: row.version, after: row.after, errors: row.errors })));
    return { rows, hash, valid: rows.every(row => !row.errors.length), errorCount: rows.filter(row => row.errors.length).length, warningCount: rows.filter(row => row.warnings.length).length };
  }
  async function preview(input) { return previewWith(input, (await load()).value, clock()); }
  function event(next, op, type, detail) { next.events.unshift({ id: stableUuid(op.commandId, `event:${type}`), at: op.timestamp, type, ...detail }); }
  const beforeState = journal => journal.before.absent || journal.before.deleted ? empty() : journal.before.value;
  async function persist(value, options) {
    try { await repository.compareAndSet(value, options); }
    catch (error) {
      if (error?.code === 'REVISION_CONFLICT') fail('Данные управления уже изменили. Обновите страницу', 409);
      throw error;
    }
  }
  const reused = () => { const error = new Error('commandId was already used for a different request'); error.code = 'COMMAND_ID_REUSED'; throw error; };
  async function replay(journal, op, transition) {
    let applied;
    try { applied = await transition(structuredClone(beforeState(journal)), op, journal); } catch { reused(); }
    await persist(JSON.parse(JSON.stringify(applied.next)), { expectedRevision: journal.before.revision, commandId: op.commandId });
    return structuredClone(applied.result);
  }
  async function commit(commandInput, transition, replayTransition = transition) {
    const op = operation(commandInput), journal = await repository.readCommand(op.commandId);
    if (journal) return replay(journal, op, replayTransition);
    const loaded = await load(), applied = await transition(structuredClone(loaded.value), op);
    const persisted = JSON.parse(JSON.stringify(applied.next));
    await persist(persisted, { expectedRevision: loaded.record?.revision || '0', commandId: op.commandId });
    return structuredClone(applied.result);
  }
  async function create(input, commandInput) {
    const op = operation(commandInput), journal = await repository.readCommand(op.commandId);
    if (typeof input?.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId)) fail('Не указан идентификатор заявки');
    const requestHash = digest(input);
    const replayCreate = async (_before, command, durable) => {
      const after = durable.after.value, eventId = stableUuid(command.commandId, 'event:created');
      const createdEvent = after.events.find(item => item.id === eventId && item.type === 'created');
      const batch = createdEvent && after.batches.find(item => item.id === createdEvent.batchId);
      if (!batch || batch.id !== command.commandId || batch.requestId !== input.requestId || batch.requestHash !== requestHash ||
          batch.createdAt !== command.timestamp || batch.updatedAt !== command.timestamp || createdEvent.at !== command.timestamp) reused();
      return { next: after, result: batch };
    };
    if (journal) {
      return replay(journal, op, replayCreate);
    }
    const current = (await load()).value, duplicate = current.batches.find(batch => batch.requestId === input.requestId);
    if (duplicate) { if (duplicate.requestHash !== requestHash) fail('Идентификатор заявки уже использован', 409); return structuredClone(duplicate); }
    return commit(op, async (next, command) => {
      if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 160) fail('Добавьте название заявки до 160 символов');
      if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 1000) fail('Добавьте причину изменения до 1000 символов');
      const calculated = await previewWith(input, next, command.timestamp);
      if (!calculated.valid) fail('Исправьте ошибки в предварительном просмотре', 409);
      if (calculated.hash !== input.previewHash) fail('Предварительный просмотр устарел. Проверьте изменения ещё раз', 409);
      if (calculated.warningCount && input.acceptWarnings !== true) fail('Подтвердите, что проверили предупреждения');
      const batch = { id: command.commandId, number: next.batches.length + 1, requestId: input.requestId, requestHash, title: input.title.trim(), reason: input.reason.trim(), status: 'draft', version: 1, createdAt: command.timestamp, updatedAt: command.timestamp, rows: calculated.rows };
      next.batches.unshift(batch); event(next, command, 'created', { batchId: batch.id, label: batch.title, count: batch.rows.length });
      return { next, result: batch };
    }, replayCreate);
  }
  async function transition(input, commandInput) {
    const apply = async (next, op, verifyCatalog) => {
      const batch = next.batches.find(item => item.id === input?.id); if (!batch) fail('Заявка не найдена', 404);
      if (batch.version !== input.version) fail('Заявку уже изменили. Обновите страницу', 409);
      const allowed = { draft: ['submitted', 'cancelled'], submitted: ['returned', 'cancelled'], returned: ['cancelled'] };
      if (!allowed[batch.status]?.includes(input.status)) fail('Этот переход заявки недоступен');
      if (input.status === 'returned' && (typeof input.comment !== 'string' || !input.comment.trim() || input.comment.length > 1000)) fail('Укажите причину возврата до 1000 символов');
      if (verifyCatalog && input.status === 'submitted') {
        const map = new Map((await productsFor(next)).map(product => [product.key, product]));
        for (const row of batch.rows) { const product = map.get(row.key); if (!product || product.version !== row.version) fail('Цены или статус товара изменились. Отмените заявку и подготовьте новую', 409); const age = Date.parse(op.timestamp) - Date.parse(product.pricing?.importedAt); if (!Number.isFinite(age) || age > 86400000) fail('Обновите цены магазина перед передачей на проверку', 409); }
      }
      batch.status = input.status; batch.version++; batch.updatedAt = op.timestamp; if (input.status === 'returned') batch.returnReason = input.comment.trim();
      event(next, op, input.status, { batchId: batch.id, label: batch.title, ...(input.status === 'returned' ? { comment: input.comment.trim() } : {}) });
      return { next, result: batch };
    };
    return commit(commandInput, (next, op) => apply(next, op, true), (next, op) => apply(next, op, false));
  }
  async function note(input, commandInput) {
    const apply = async (next, op, verifyCatalog) => {
      if (verifyCatalog && !(await productsFor(next)).some(product => product.key === input?.key)) fail('Товар не найден', 404);
      if (typeof input.text !== 'string' || input.text.length > 2000 || !['normal', 'attention', 'purchase'].includes(input.flag)) fail('Проверьте заметку и метку товара');
      const prior = next.notes[input.key] || { version: 0 }; if (prior.version !== input.version) fail('Заметку уже изменили. Обновите каталог', 409);
      const value = { text: input.text.trim(), flag: input.flag, version: prior.version + 1, updatedAt: op.timestamp };
      next.notes[input.key] = value; event(next, op, 'note', { key: input.key, label: 'Заметка к товару' }); return { next, result: value };
    };
    return commit(commandInput, (next, op) => apply(next, op, true), (next, op) => apply(next, op, false));
  }
  async function state() { const value = (await load()).value; return { batches: structuredClone(value.batches), notes: structuredClone(value.notes), events: structuredClone(value.events), capabilities: { priceWrite: false, employeeAccounts: false } }; }
  return Object.freeze({ products, preview, create, transition, note, state });
}

module.exports = createPostgresManagement;
module.exports.createPostgresManagement = createPostgresManagement;
module.exports.ManagementError = ManagementError;
module.exports.version = version;
