'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class SupplierPortalError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; this.public = true; }
}
const fail = (message, status) => { throw new SupplierPortalError(message, status); };
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
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

module.exports = function createSupplierPortals({ privateDir, getProducts, getForecasts = () => new Map(), now = () => new Date().toISOString() }) {
  const file = path.join(privateDir, 'supplier-portals.json');
  const empty = () => ({ schema: 1, version: 0, categories: [], portals: [] });
  let state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : empty();
  if (state.schema !== 1 || !Number.isSafeInteger(state.version) || !Array.isArray(state.categories) || !Array.isArray(state.portals)) fail('Файл кабинетов поставщиков повреждён', 500);

  // Never return original product objects: snapshots can contain private financial fields.
  function products() {
    const source = getProducts();
    if (!Array.isArray(source)) fail('Каталог товаров недоступен', 503);
    return source.filter(p => typeof p.key === 'string').map(p => ({
      key: p.key, name: text(p.name), sku: text(p.sku), article: text(p.offer_id),
      storeName: text(p.storeName), market: text(p.market),
      ...warehouseStock(p),
      importedAt: typeof p.importedAt === 'string' && Number.isFinite(Date.parse(p.importedAt)) ? p.importedAt : null
    }));
  }
  function read() { return { ...structuredClone(state), products: products(), mode: 'local-draft' }; }
  function commit(input, change) {
    if (!object(input) || input.version !== state.version) fail('Настройки изменились. Обновите страницу перед сохранением', 409);
    const next = structuredClone(state);
    const id = change(next);
    next.version++;
    fs.mkdirSync(privateDir, { recursive: true });
    const temporary = file + '.' + crypto.randomUUID() + '.tmp';
    try { fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 }); fs.renameSync(temporary, file); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    state = next;
    return { id, version: state.version };
  }
  function saveCategory(input) {
    return commit(input, next => {
      const name = nameOf(input.name), keys = listOf(input.productKeys);
      const current = input.id === undefined ? null : next.categories.find(c => c.id === input.id);
      if (input.id !== undefined && !current) fail('Категория не найдена', 404);
      if (next.categories.some(c => c.id !== current?.id && c.name.toLocaleLowerCase('ru-RU') === name.toLocaleLowerCase('ru-RU'))) fail('Категория с таким названием уже есть');
      if (!current && next.categories.length >= 500) fail('Достигнут предел: 500 категорий');
      const available = new Set(products().map(p => p.key));
      const previouslyAssigned = new Set(current?.productKeys || []);
      if (keys.some(key => !available.has(key) && !previouslyAssigned.has(key))) fail('Товар отсутствует в текущем каталоге');
      if (next.categories.some(c => c.id !== current?.id && c.productKeys.some(key => keys.includes(key)))) fail('Товар уже назначен другой категории. Сначала уберите его оттуда');
      const category = { id: current?.id || crypto.randomUUID(), name, productKeys: [...keys], updatedAt: now() };
      if (current) next.categories[next.categories.indexOf(current)] = category;
      else next.categories.push(category);
      return category.id;
    });
  }
  function savePortal(input) {
    return commit(input, next => {
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
      const portal = { id: current?.id || crypto.randomUUID(), name, categoryIds: [...categoryIds], targets, updatedAt: now() };
      if (current) next.portals[next.portals.indexOf(current)] = portal;
      else next.portals.push(portal);
      return portal.id;
    });
  }
  function preview(id) {
    const portal = state.portals.find(p => p.id === id);
    if (!portal) fail('Кабинет не найден', 404);
    const categories = state.categories.filter(c => portal.categoryIds.includes(c.id));
    const categoryByKey = new Map(categories.flatMap(c => c.productKeys.map(key => [key, c.name])));
    const forecasts = getForecasts();
    const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    const rows = products().filter(p => categoryByKey.has(p.key)).map(p => {
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
  return { read, saveCategory, savePortal, preview };
};
module.exports.SupplierPortalError = SupplierPortalError;
