'use strict';

const {createJsonDocumentRepository, encodeJson} = require('./postgres-json-repository.cjs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REVISION = /^(?:0|[1-9][0-9]*)$/u;
const NUMERIC_ID = /^[0-9]{1,40}$/u;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
const MAX_COMPETITORS = 50;
const METRICS_CURRENCY = 'RUB';

class GrowthWatchlistError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'GrowthWatchlistError';
    this.code = code;
    this.status = status;
  }
}

const fail = (code, message, status = 400) => { throw new GrowthWatchlistError(code, message, status); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const numericId = (value, label) => {
  if (typeof value !== 'string' || !NUMERIC_ID.test(value)) fail('INVALID_ARGUMENT', `Некорректный идентификатор ${label}.`);
  return value;
};
const string = (value, label, max, {allowEmpty = false} = {}) => {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) fail('INVALID_ARGUMENT', `Проверьте поле «${label}».`);
  return value.trim();
};
const nullableNumber = (value, label, max) => {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) fail('INVALID_ARGUMENT', `Проверьте поле «${label}».`);
  return value;
};
const nullableInteger = (value, label, max) => {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > max) fail('INVALID_ARGUMENT', `Проверьте поле «${label}».`);
  return value;
};
const nullablePositiveInteger = (value, label) => {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000000) fail('INVALID_ARGUMENT', `Проверьте поле «${label}».`);
  return value;
};
function exactKeys(value, keys, label) {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) fail('INVALID_ARGUMENT', `Некорректная структура: ${label}.`);
}
function calendarDate(value, label) {
  const time = typeof value === 'string' && DATE.test(value) ? Date.parse(`${value}T00:00:00.000Z`) : NaN;
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value)
    fail('INVALID_ARGUMENT', `Проверьте поле «${label}».`);
  return value;
}
function instant(value, now) {
  if (typeof value !== 'string') fail('INVALID_ARGUMENT', 'Проверьте поле «observedAt».');
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value || time > now) fail('INVALID_ARGUMENT', 'Проверьте поле «observedAt».');
  return value;
}

function canonicalProductUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/u.test(value)) fail('INVALID_ARGUMENT', 'Укажите HTTPS-ссылку на карточку Ozon.');
  let url;
  try { url = new URL(value); } catch { fail('INVALID_ARGUMENT', 'Укажите HTTPS-ссылку на карточку Ozon.'); }
  const match = /^\/product\/(?:[^/]*-)?([0-9]+)\/?$/u.exec(url.pathname);
  if (url.protocol !== 'https:' || !['ozon.ru', 'www.ozon.ru'].includes(url.hostname.toLowerCase()) || url.username || url.password || url.port || !match)
    fail('INVALID_ARGUMENT', 'Нужна HTTPS-ссылка ozon.ru/product/ без учётных данных.');
  return {id: match[1], url: `https://www.ozon.ru/product/${match[1]}/`};
}

function normalizeMetrics(value, now) {
  if (value === null) return null;
  exactKeys(value, ['periodFrom', 'periodTo', 'observedAt', 'averagePrice', 'minimumPrice', 'orderedUnits', 'drrPct'], 'метрики конкурента');
  const periodFrom = calendarDate(value.periodFrom, 'periodFrom');
  const periodTo = calendarDate(value.periodTo, 'periodTo');
  const observedAt = instant(value.observedAt, now);
  if (periodFrom > periodTo || periodTo > observedAt.slice(0, 10)) fail('INVALID_ARGUMENT', 'Период метрик указан некорректно.');
  // Денежные значения этого снимка всегда выражены в рублях; это не текущая цена покупателя.
  return {
    periodFrom,
    periodTo,
    observedAt,
    averagePrice: nullableNumber(value.averagePrice, 'averagePrice', 1000000000),
    minimumPrice: nullableNumber(value.minimumPrice, 'minimumPrice', 1000000000),
    orderedUnits: nullableInteger(value.orderedUnits, 'orderedUnits', 1000000000),
    drrPct: nullableNumber(value.drrPct, 'drrPct', 10000)
  };
}

function normalizeCompetitor(value, now) {
  exactKeys(value, ['id', 'name', 'url', 'matchStatus', 'matchNotes', 'unitCount', 'source', 'metrics'], 'конкурент');
  const canonical = canonicalProductUrl(value.url);
  if (value.id !== undefined && value.id !== canonical.id) fail('INVALID_ARGUMENT', 'Идентификатор конкурента не совпадает со ссылкой.');
  if (!['candidate', 'confirmed'].includes(value.matchStatus)) fail('INVALID_ARGUMENT', 'Проверьте статус сопоставления.');
  if (value.source !== 'ozon_seller_analytics') fail('INVALID_ARGUMENT', 'Проверьте источник конкурента.');
  const matchNotes = string(value.matchNotes, 'matchNotes', 500, {allowEmpty: true});
  const unitCount = nullablePositiveInteger(value.unitCount, 'unitCount');
  if (value.matchStatus === 'confirmed' && (!matchNotes || unitCount === null)) fail('INVALID_ARGUMENT', 'Для подтверждённого аналога нужны пояснение и количество единиц.');
  return {
    id: canonical.id,
    name: string(value.name, 'name', 300),
    url: canonical.url,
    matchStatus: value.matchStatus,
    matchNotes,
    unitCount,
    source: 'ozon_seller_analytics',
    metrics: normalizeMetrics(value.metrics, now)
  };
}

function normalizeCompetitors(value, now) {
  if (!Array.isArray(value) || value.length > MAX_COMPETITORS) fail('INVALID_ARGUMENT', `Можно сохранить не более ${MAX_COMPETITORS} конкурентов.`);
  const rows = value.map(row => normalizeCompetitor(row, now));
  if (new Set(rows.map(row => row.id)).size !== rows.length) fail('INVALID_ARGUMENT', 'Одна карточка Ozon указана несколько раз.');
  return rows;
}

function validateDocument(value, storeId, productId) {
  try {
    if (!object(value) || value.version !== 1 || value.storeId !== storeId || value.productId !== productId || !Array.isArray(value.competitors)) return false;
    const normalized = normalizeCompetitors(value.competitors, Number.MAX_SAFE_INTEGER);
    return encodeJson(value.competitors).equals(encodeJson(normalized));
  } catch { return false; }
}

function createGrowthWatchlist({stateStore, storesRepository, verifyProduct, now = Date.now} = {}) {
  if (!stateStore || !storesRepository || typeof storesRepository.read !== 'function' || typeof verifyProduct !== 'function' || typeof now !== 'function')
    throw new TypeError('Growth watchlist dependencies are required');

  const repository = (storeId, productId) => createJsonDocumentRepository({
    stateStore,
    logicalKey: `growth-watchlist/${storeId}-${productId}`,
    maxBytes: 512 * 1024,
    validate: value => validateDocument(value, storeId, productId)
  });
  const output = (record, replayed) => ({
    revision: record?.revision || '0',
    competitors: structuredClone(record?.value?.competitors || []),
    ...(replayed === undefined ? {} : {replayed})
  });

  async function requireStore(storeId) {
    numericId(storeId, 'магазина');
    const stores = await storesRepository.read();
    const store = object(stores) ? stores[storeId] : null;
    if (!object(store) || store.market === 'WB') fail('NOT_FOUND', 'Магазин Ozon не найден.', 404);
  }

  async function read({storeId, productId} = {}) {
    numericId(productId, 'товара');
    await requireStore(storeId);
    return output(await repository(storeId, productId).read());
  }

  async function save({storeId, productId, expectedRevision, commandId, competitors} = {}) {
    numericId(productId, 'товара');
    if (typeof expectedRevision !== 'string' || !REVISION.test(expectedRevision) || typeof commandId !== 'string' || !UUID.test(commandId))
      fail('INVALID_ARGUMENT', 'Для сохранения нужны версия и стабильный commandId.');
    const normalized = normalizeCompetitors(competitors, Number(now()));
    const id = commandId.toLowerCase();
    await requireStore(storeId);
    const repo = repository(storeId, productId);
    const intended = {version: 1, storeId, productId, competitors: normalized};
    const prior = await repo.readCommand(id);
    if (prior) {
      if (prior.before.revision !== expectedRevision || !encodeJson(prior.after.value).equals(encodeJson(intended)))
        fail('COMMAND_ID_REUSED', 'commandId уже использован для другого сохранения.', 409);
      return output(prior.after, true);
    }
    if (await verifyProduct(storeId, productId) !== true) fail('NOT_FOUND', 'Товар этого магазина не найден.', 404);
    const result = await repo.compareAndSet(intended, {expectedRevision, commandId: id});
    return {revision: result.revision, competitors: structuredClone(normalized), replayed: Boolean(result.replayed)};
  }

  return Object.freeze({read, save});
}

module.exports = {createGrowthWatchlist, GrowthWatchlistError, canonicalProductUrl, METRICS_CURRENCY, MAX_COMPETITORS};
