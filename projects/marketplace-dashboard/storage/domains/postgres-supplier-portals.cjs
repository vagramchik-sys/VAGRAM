'use strict';
const crypto = require('node:crypto');
const { createJsonDocumentRepository, encodeJson } = require('../postgres-json-repository.cjs');
const { sourceKey } = require('../postgres-document-import.cjs');

class SupplierPortalError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; this.public = true; }
}
const fail = (message, status) => { throw new SupplierPortalError(message, status); };
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const text = value => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const nameOf = value => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120) fail('Укажите название длиной от 1 до 120 символов');
  return value.trim();
};
const listOf = value => {
  if (!Array.isArray(value) || value.length > 30000 || value.some(v => typeof v !== 'string' || !v || v.length > 300) || new Set(value).size !== value.length) fail('Некорректный или повторяющийся список товаров или категорий');
  return value;
};
function warehouseStock(product) {
  const total = typeof product.quantity === 'number' && Number.isFinite(product.quantity) && product.quantity >= 0 ? product.quantity : null;
  const source = Array.isArray(product.warehouseRows) ? product.warehouseRows : [];
  const groups = new Map();
  for (const row of source) {
    const named = typeof row?.warehouse === 'string' ? row.warehouse.trim() : typeof row?.warehouse_name === 'string' ? row.warehouse_name.trim() : '';
    const type = typeof row?.type === 'string' ? row.type.trim().toLowerCase() : '';
    const kind = named ? 'warehouse' : ['fbo', 'fbs', 'rfbs'].includes(type) ? 'type' : 'unknown';
    const name = named || (kind === 'type' ? type.toUpperCase() : 'Склад не указан');
    const value = row?.present;
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
    const stock = Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    const key = kind + ':' + name;
    if (!groups.has(key)) groups.set(key, { name, kind, stock });
    else {
      const previous = groups.get(key);
      previous.stock = previous.stock === null || stock === null ? null : previous.stock + stock;
      if (!Number.isFinite(previous.stock)) previous.stock = null;
    }
  }
  const rows = [...groups.values()];
  const known = rows.length > 0 && rows.every(row => row.stock !== null);
  const sum = known ? rows.reduce((value, row) => value + row.stock, 0) : null;
  const totalMatches = known && total !== null ? Math.abs(sum - total) < 0.000001 : null;
  const invalid = rows.some(row => row.stock === null) || totalMatches === false;
  let description = !rows.length ? 'Разбивка по складам не загружена.' : rows.some(row => row.kind === 'type') ? 'По типам складов FBO/FBS; детализации конкретных складов нет.' : 'По названиям складов из кабинета маркетплейса.';
  if (rows.some(row => row.kind === 'unknown')) description += ' Для части остатка склад не указан.';
  if (invalid) description += totalMatches === false ? ' Сумма разбивки не совпадает с общим остатком; требуется обновление данных.' : ' Часть количества неизвестна; общий остаток не подтверждён.';
  return { stock: invalid ? null : total, warehouseBreakdown: { rows, complete: known && rows.every(row => row.kind !== 'unknown') && totalMatches === true, totalMatches, description } };
}

function validState(value) {
  return object(value) && value.schema === 1 && Number.isSafeInteger(value.version) && value.version >= 0 && Array.isArray(value.categories) && value.categories.length <= 500 && Array.isArray(value.portals) && value.portals.length <= 500 &&
    value.categories.every(row => object(row) && UUID.test(row.id || '') && typeof row.name === 'string' && Array.isArray(row.productKeys) && row.productKeys.every(key => typeof key === 'string') && typeof row.updatedAt === 'string' && Number.isFinite(Date.parse(row.updatedAt))) &&
    value.portals.every(row => object(row) && UUID.test(row.id || '') && typeof row.name === 'string' && Array.isArray(row.categoryIds) && row.categoryIds.every(id => typeof id === 'string') && object(row.targets) && Object.values(row.targets).every(target => Number.isSafeInteger(target) && target >= 0) && typeof row.updatedAt === 'string' && Number.isFinite(Date.parse(row.updatedAt)));
}
function operation(value) {
  if (!object(value) || !UUID.test(value.commandId || '')) fail('Некорректный идентификатор команды');
  if (typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))) fail('Не удалось определить время сохранения', 500);
  return { commandId: value.commandId.toLowerCase(), timestamp: value.timestamp };
}
function stableUuid(commandId, label) {
  const bytes = crypto.createHash('sha256').update(commandId).update('\0').update(label).digest().subarray(0, 16);
  bytes[6] = bytes[6] & 0x0f | 0x40; bytes[8] = bytes[8] & 0x3f | 0x80; const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

module.exports = function createSupplierPortals({ stateStore, getProducts, getForecasts = async () => new Map(), getCategorySales = null, now = () => new Date().toISOString() }) {
  if (typeof getProducts !== 'function') throw new TypeError('getProducts must be an async provider');
  const empty = () => ({ schema: 1, version: 0, categories: [], portals: [] });
  const repository = createJsonDocumentRepository({ stateStore, logicalKey: sourceKey('supplier-portals.json'), sourcePath: 'supplier-portals.json', validate: validState });
  async function load() { const record = await repository.read(); return { record, value: record && !record.deleted ? record.value : empty() }; }

  // Never return original product objects: snapshots can contain private financial fields.
  async function products() {
    const source = await getProducts();
    if (!Array.isArray(source)) fail('Каталог товаров недоступен', 503);
    return source.filter(p => typeof p.key === 'string').map(p => ({
      key: p.key, name: text(p.name), sku: text(p.sku), article: text(p.offer_id),
      storeName: text(p.storeName), market: text(p.market),
      ...warehouseStock(p),
      importedAt: typeof p.importedAt === 'string' && Number.isFinite(Date.parse(p.importedAt)) ? p.importedAt : null
    }));
  }
  async function read() { const state = (await load()).value; return { ...structuredClone(state), products: await products(), mode: 'local-draft' }; }
  async function readCategories() { const state = (await load()).value; return { version: state.version, categories: structuredClone(state.categories) }; }
  const beforeState = journal => journal.before.absent || journal.before.deleted ? empty() : journal.before.value;
  async function commit(input, commandInput, change, replayChange = change) {
    const op = operation(commandInput), journal = await repository.readCommand(op.commandId);
    if (journal) {
      let applied; try { const prior = structuredClone(beforeState(journal)); if (!object(input) || input.version !== prior.version) throw Error(); applied = await replayChange(prior, op); prior.version++; if (!encodeJson(prior).equals(encodeJson(journal.after.value))) throw Error(); }
      catch { const error = Error('commandId was already used for a different request'); error.code = 'COMMAND_ID_REUSED'; throw error; }
      await repository.compareAndSet(journal.after.value, { expectedRevision: journal.before.revision, commandId: op.commandId });
      return structuredClone({ id: applied, version: journal.after.value.version });
    }
    const loaded = await load(), state = loaded.value;
    if (!object(input) || input.version !== state.version) fail('Настройки изменились. Обновите страницу перед сохранением', 409);
    const next = structuredClone(state), id = await change(next, op); next.version++;
    try { await repository.compareAndSet(next, { expectedRevision: loaded.record?.revision || '0', commandId: op.commandId }); }
    catch (error) { if (error?.code === 'REVISION_CONFLICT') fail('Настройки изменились. Обновите страницу перед сохранением', 409); throw error; }
    return { id, version: next.version };
  }
  async function saveCategory(input, commandInput) {
    const apply = verifyProducts => async (next, op) => {
      const name = nameOf(input.name), keys = listOf(input.productKeys);
      const current = input.id === undefined ? null : next.categories.find(c => c.id === input.id);
      if (input.id !== undefined && !current) fail('Категория не найдена', 404);
      if (next.categories.some(c => c.id !== current?.id && c.name.toLocaleLowerCase('ru-RU') === name.toLocaleLowerCase('ru-RU'))) fail('Категория с таким названием уже есть');
      if (!current && next.categories.length >= 500) fail('Достигнут предел: 500 категорий');
      const available = verifyProducts ? new Set((await products()).map(p => p.key)) : new Set(keys);
      const previouslyAssigned = new Set(current?.productKeys || []);
      if (keys.some(key => !available.has(key) && !previouslyAssigned.has(key))) fail('Товар отсутствует в текущем каталоге');
      if (next.categories.some(c => c.id !== current?.id && c.productKeys.some(key => keys.includes(key)))) fail('Товар уже назначен другой категории. Сначала уберите его оттуда');
      const category = { id: current?.id || stableUuid(op.commandId, 'category'), name, productKeys: [...keys], updatedAt: op.timestamp };
      if (current) next.categories[next.categories.indexOf(current)] = category;
      else next.categories.push(category);
      return category.id;
    };
    return commit(input, commandInput, apply(true), apply(false));
  }
  async function savePortal(input, commandInput) {
    const apply = async (next, op) => {
      const name = nameOf(input.name), categoryIds = listOf(input.categoryIds);
      if (!categoryIds.length) fail('Выберите хотя бы одну категорию');
      if (categoryIds.some(id => !next.categories.some(c => c.id === id))) fail('Выбранная категория не найдена');
      const current = input.id === undefined ? null : next.portals.find(p => p.id === input.id);
      if (input.id !== undefined && !current) fail('Кабинет не найден', 404);
      if (!current && next.portals.length >= 500) fail('Достигнут предел: 500 кабинетов');
      if (next.portals.some(p => p.id !== current?.id && p.name.toLocaleLowerCase('ru-RU') === name.toLocaleLowerCase('ru-RU'))) fail('Кабинет с таким названием уже есть');
      if (input.targets !== undefined && !object(input.targets)) fail('Укажите корректные целевые остатки');
      const allowed = new Set(next.categories.filter(c => categoryIds.includes(c.id)).flatMap(c => c.productKeys));
      const targets = {};
      for (const [key, target] of Object.entries(input.targets || {})) {
        if (!allowed.has(key)) fail('Целевой остаток указан для товара вне выбранных категорий');
        if (typeof target !== 'number' || !Number.isSafeInteger(target) || target < 0 || target > 100000000) fail('Целевой остаток должен быть целым числом от 0 до 100 000 000');
        Object.defineProperty(targets, key, { value: target, enumerable: true, writable: true, configurable: true });
      }
      const portal = { id: current?.id || stableUuid(op.commandId, 'portal'), name, categoryIds: [...categoryIds], targets, updatedAt: op.timestamp };
      if (current) next.portals[next.portals.indexOf(current)] = portal;
      else next.portals.push(portal);
      return portal.id;
    };
    return commit(input, commandInput, apply);
  }
  async function preview(id) {
    const state = (await load()).value;
    const portal = state.portals.find(p => p.id === id);
    if (!portal) fail('Кабинет не найден', 404);
    const categories = state.categories.filter(c => portal.categoryIds.includes(c.id));
    const categoryByKey = new Map(categories.flatMap(c => c.productKeys.map(key => [key, c.name])));
    const forecasts = await getForecasts();
    const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    const rows = (await products()).filter(p => categoryByKey.has(p.key)).map(p => {
      const source = forecasts instanceof Map ? forecasts.get(p.key) : null;
      const available = source?.status === 'available' && p.stock !== null && nonnegative(source.requiredUnits) !== null;
      const forecast = { label: 'Ориентировочный прогноз потребности на 45 дней', status: available ? 'available' : 'unavailable',
        reason: available ? null : p.stock === null ? 'Остаток неизвестен; потребность не рассчитана.' : text(source?.reason) || 'Недостаточно истории продаж для прогноза.',
        averageDailyUnits: available ? nonnegative(source.averageDailyUnits) : null,
        projectedUnits: available ? nonnegative(source.projectedUnits) : null,
        requiredUnits: available ? nonnegative(source.requiredUnits) : null,
        daysOfStock: available ? nonnegative(source.daysOfStock) : null,
        historyStart: text(source?.historyStart), historyEnd: text(source?.historyEnd), caveat: text(source?.caveat) };
      return { name: p.name, sku: p.sku, article: p.article, market: p.market, storeName: p.storeName, category: categoryByKey.get(p.key), stock: p.stock,
        warehouseBreakdown: p.warehouseBreakdown, forecast, need: forecast.requiredUnits, importedAt: p.importedAt };
    });
    return { name: portal.name, mode: 'local-draft', categories: categories.map(c => c.name), rows,
      missingProducts: categoryByKey.size - rows.length };
  }
  async function categorySalesOverview({ days = 28 } = {}) {
    const unavailable = reason => ({ basis: 'Единицы финансовой реализации, не заказы', period: null, generatedAt: now(), coverage: { complete: false, coveredDays: 0, totalDays: 0 }, sources: [], categories: [], reason });
    if (typeof getCategorySales !== 'function') return unavailable('Источник продаж по категориям не подключён.');
    const integer = (value, signed = false) => Number.isSafeInteger(value) && (signed || value >= 0) ? value : null;
    const amounts = value => {
      const sold = integer(value?.sold), returned = integer(value?.returned), net = integer(value?.net, true);
      return sold !== null && returned !== null && net === sold - returned ? { sold, returned, net } : { sold: null, returned: null, net: null };
    };
    let base;
    try { base = await getCategorySales({ days, market: 'all' }); }
    catch { return unavailable('Сводка категорий временно недоступна.'); }
    if (!object(base) || !object(base.period) || !Array.isArray(base.categories) || !Array.isArray(base.sources)) return unavailable('Источник вернул некорректную сводку.');
    const period = { from: text(base.period.from), to: text(base.period.to), days: integer(base.period.days), completedDaysOnly: base.period.completedDaysOnly === true };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(period.from) || !/^\d{4}-\d{2}-\d{2}$/.test(period.to) || period.from > period.to || period.days === null) return unavailable('Период сводки не подтверждён.');
    const categories = [];
    for (const category of base.categories) {
      const name = text(category?.name).slice(0, 120) || 'Без названия';
      try {
        const report = await getCategorySales({ category: category.id, from: period.from, to: period.to, market: 'all' });
        const total = amounts(report?.totals?.total), ozon = amounts(report?.totals?.Ozon), wb = amounts(report?.totals?.WB);
        const totalDays = integer(report?.coverage?.totalDays), coveredDays = integer(report?.coverage?.coveredDays);
        const complete = report?.coverage?.complete === true && totalDays !== null && coveredDays === totalDays && total.net !== null;
        categories.push({ name, sold: complete ? total.sold : null, returned: complete ? total.returned : null, net: complete ? total.net : null,
          Ozon: ozon, WB: wb, coverage: { complete, coveredDays, totalDays } });
      } catch { categories.push({ name, sold: null, returned: null, net: null, Ozon: amounts(null), WB: amounts(null), coverage: { complete: false, coveredDays: null, totalDays: period.days } }); }
    }
    const sourceGroups = new Map();
    for (const source of base.sources) {
      if (!['Ozon', 'WB'].includes(source?.market)) continue;
      const group = sourceGroups.get(source.market) || { market: source.market, storeCount: 0, updated: [], coveredDays: [], totalDays: [], complete: true };
      group.storeCount++;if (typeof source.updatedAt === 'string' && Number.isFinite(Date.parse(source.updatedAt))) group.updated.push(source.updatedAt);
      const covered = integer(source.coveredDays), total = integer(source.totalDays);if (covered !== null) group.coveredDays.push(covered);if (total !== null) group.totalDays.push(total);group.complete = group.complete && source.complete === true;sourceGroups.set(source.market, group);
    }
    const sources = [...sourceGroups.values()].map(group => ({ market: group.market, storeCount: group.storeCount,
      oldestUpdatedAt: group.updated.length ? group.updated.sort()[0] : null, newestUpdatedAt: group.updated.length ? group.updated.sort().at(-1) : null,
      coveredDays: group.coveredDays.length === group.storeCount ? Math.min(...group.coveredDays) : null,
      totalDays: group.totalDays.length === group.storeCount && new Set(group.totalDays).size === 1 ? group.totalDays[0] : null, complete: group.complete }));
    const completeRows = categories.filter(row => row.coverage.complete).length;
    return { basis: 'Единицы финансовой реализации, не заказы', period, generatedAt: now(), coverage: { complete: completeRows === categories.length && categories.length > 0, coveredCategories: completeRows, totalCategories: categories.length }, sources, categories,
      reason: completeRows === categories.length && categories.length ? null : 'Неполные категории оставлены неизвестными; нули не подставлены.' };
  }
  return { read, readCategories, saveCategory, savePortal, preview, categorySalesOverview };
};
module.exports.SupplierPortalError = SupplierPortalError;
