'use strict';

const {createJsonDocumentRepository, encodeJson} = require('../postgres-json-repository.cjs');
const {adviseProduct, calculateCommercialPlan} = require('../../optimizer/growth-advisor.cjs');
const {createGrowthWatchlist, GrowthWatchlistError} = require('../growth-watchlist.cjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = 86400000;
class GrowthError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const fail = (message, code = 'INVALID_ARGUMENT', status = 400) => { throw new GrowthError(code, message, status); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => { if (typeof value !== 'string' || !/^[0-9]{1,40}$/.test(value)) fail('Проверьте магазин и товар.'); return value; };
const text = (value, max, label) => { if (typeof value !== 'string' || !value.trim() || value.length > max) fail('Проверьте поле «' + label + '».'); return value.trim(); };
const amount = value => { if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1e9) fail('Цена должна быть положительным числом.'); return value; };
const units = value => { if (!Number.isSafeInteger(value) || value <= 0 || value > 1000000) fail('Укажите количество единиц в упаковке.'); return value; };
const position = value => { if (value === null || value === undefined) return null; if (!Number.isSafeInteger(value) || value < 1 || value > 1000000) fail('Позиция должна быть положительным целым числом.'); return value; };

function normalizeTerms(value) {
  if (!object(value) || ![value.commissionPct, value.advertisingPct].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 100) || value.commissionPct + value.advertisingPct >= 100 || value.priceBasis !== 'seller_price' || value.application !== 'planning_reserve') fail('Проверьте проценты и базу планового расчёта.');
  return {commissionPct: value.commissionPct, advertisingPct: value.advertisingPct, priceBasis: 'seller_price', application: 'planning_reserve'};
}

function normalizeObservation(value, now) {
  if (!object(value) || value.comparable !== true) fail('Подтвердите сопоставимость аналогов и условий наблюдения.');
  const observed = typeof value.observedAt === 'string' ? Date.parse(value.observedAt) : NaN;
  if (!Number.isFinite(observed) || observed > now || observed < now - 366 * DAY) fail('Укажите время наблюдения в пределах последнего года, не в будущем.');
  if (!Array.isArray(value.competitors) || value.competitors.length < 1 || value.competitors.length > 20) fail('Добавьте от 1 до 20 сопоставимых товаров.');
  const competitors = value.competitors.map(row => {
    if (!object(row)) fail('Проверьте аналог.');
    let url; try { url = new URL(row.url); } catch { fail('Укажите ссылку на карточку Ozon.'); }
    const match = /^\/product\/(?:[^/]*-)?([0-9]+)\/?$/.exec(url.pathname);
    if (url.protocol !== 'https:' || !['ozon.ru', 'www.ozon.ru'].includes(url.hostname) || url.username || url.password || url.port || !match) fail('Нужна HTTPS-ссылка на карточку товара ozon.ru/product/.');
    return {id: match[1], name: text(row.name, 200, 'Название аналога'), url: 'https://www.ozon.ru/product/' + match[1] + '/', buyerPrice: amount(row.buyerPrice), unitCount: units(row.unitCount), position: position(row.position)};
  });
  if (new Set(competitors.map(row => row.id)).size !== competitors.length) fail('Один и тот же аналог добавлен несколько раз.');
  return {source: 'manual', comparable: true, observedAt: new Date(observed).toISOString(), region: text(value.region, 120, 'Регион'), query: text(value.query, 200, 'Поисковый запрос'), ownBuyerPrice: amount(value.ownBuyerPrice), ownUnitCount: units(value.ownUnitCount), ownPosition: position(value.ownPosition), competitors};
}

function parseOptions(params, now) {
  const yesterday = Date.parse(new Date(now + 3 * 3600000).toISOString().slice(0, 10) + 'T00:00:00Z') - DAY;
  const result = {storeId: params.get('store') || undefined, search: params.get('search') || undefined, from: params.get('from') || new Date(yesterday - 13 * DAY).toISOString().slice(0, 10), to: params.get('to') || new Date(yesterday).toISOString().slice(0, 10), limit: Number(params.get('limit') || 50), offset: Number(params.get('offset') || 0), objective: params.get('objective') || 'profit_volume'};
  const date = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (result.storeId) id(result.storeId);
  if (result.search?.length > 200 || !date(result.from) || !date(result.to) || result.from > result.to || Date.parse(result.to) > yesterday || Date.parse(result.to) - Date.parse(result.from) > 89 * DAY || !Number.isInteger(result.limit) || result.limit < 1 || result.limit > 100 || !Number.isSafeInteger(result.offset) || result.offset < 0 || !['profit_volume', 'sales', 'position'].includes(result.objective)) fail('Проверьте фильтры центра роста.');
  return result;
}

function createGrowthCenter({optimizer, stateStore, storesRepository, readMarket, now = Date.now} = {}) {
  if (!optimizer?.prices || !stateStore || !storesRepository?.read) throw new TypeError('Growth center dependencies required');
  const watchlist = createGrowthWatchlist({stateStore, storesRepository, now, verifyProduct: async (storeId, productId) => {
    const options = parseOptions(new URLSearchParams({store: storeId, limit: '1'}), Number(now()));
    const result = await optimizer.prices({...options, productId});
    return result.items.some(row => String(row.product?.id) === productId && String(row.product?.storeId) === storeId);
  }});
  const termsRepo = createJsonDocumentRepository({stateStore, logicalKey: 'growth-settings/terms', maxBytes: 8192, validate: value => {
    try { return value.version === 1 && !!normalizeTerms(value.terms) && typeof value.observedAt === 'string'; } catch { return false; }
  }});
  const termsOutput = record => ({revision: record?.revision || '0', terms: record?.value?.terms || null, observedAt: record?.value?.observedAt || null});
  async function terms() { return termsOutput(await termsRepo.read()); }
  async function saveTerms(value) {
    if (!object(value) || !UUID.test(value.commandId || '') || !/^(0|[1-9][0-9]*)$/.test(value.expectedRevision || '')) fail('Для сохранения нужны идентификатор команды и версия условий.');
    const normalized = normalizeTerms(value.terms), commandId = value.commandId.toLowerCase();
    const prior = await termsRepo.readCommand(commandId);
    if (prior) {
      if (prior.before.revision !== value.expectedRevision || !encodeJson(prior.after.value.terms).equals(encodeJson(normalized))) fail('Идентификатор команды уже использован.', 'COMMAND_ID_REUSED', 409);
      return {...termsOutput(prior.after), replayed: true};
    }
    try {
      await termsRepo.compareAndSet({version: 1, terms: normalized, observedAt: new Date(Number(now())).toISOString()}, {expectedRevision: value.expectedRevision, commandId});
    } catch (error) {
      if (!['COMMAND_ID_REUSED', 'REVISION_CONFLICT'].includes(error.code)) throw error;
      const committed = await termsRepo.readCommand(commandId);
      if (!committed || committed.before.revision !== value.expectedRevision || !encodeJson(committed.after.value.terms).equals(encodeJson(normalized))) throw error;
      return {...termsOutput(committed.after), replayed: true};
    }
    return termsOutput(await termsRepo.read());
  }
  const repository = (storeId, productId) => createJsonDocumentRepository({stateStore, logicalKey: `growth-evidence/${id(storeId)}-${id(productId)}`, maxBytes: 512 * 1024,
    validate: value => object(value) && value.version === 1 && value.storeId === storeId && value.productId === productId && Array.isArray(value.observations) && value.observations.length <= 30 && value.observations.every(row => object(row) && UUID.test(row.commandId) && object(row.observation))});
  const empty = (storeId, productId) => ({version: 1, storeId, productId, observations: []});
  function output(record) {
    const observations = [...(record?.value?.observations || [])].sort((a, b) => Date.parse(b.observation.observedAt) - Date.parse(a.observation.observedAt)).map(row => ({...row.observation, commandId: row.commandId}));
    return {revision: record?.revision || '0', observations, latest: observations[0] || null};
  }
  async function stores() { return Object.entries(await storesRepository.read()).filter(([key, row]) => /^[0-9]+$/.test(key) && row.market !== 'WB').map(([key, row]) => ({id: key, name: row.name || key})); }
  async function requireStore(storeId) { id(storeId); if (!(await stores()).some(row => row.id === storeId)) fail('Магазин Ozon не найден.', 'NOT_FOUND', 404); }
  async function evidence({storeId, productId}) { await requireStore(storeId); return output(await repository(storeId, productId).read()); }
  async function market({storeId, productId}) {
    await requireStore(storeId); id(productId);
    if (typeof readMarket !== 'function') fail('Чтение индекса Ozon не подключено.', 'MARKET_UNAVAILABLE', 503);
    const raw = await readMarket(storeId, productId);
    const product = raw?.items?.find(row => String(row.product_id) === productId);
    if (!product) fail('Ozon не вернул этот товар магазина.', 'NOT_FOUND', 404);
    const indices = product.price_indexes || {};
    const numeric = value => typeof value === 'number' || typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null : null;
    const shape = value => ({minimumPrice: numeric(value?.minimal_price), currency: typeof value?.minimal_price_currency === 'string' ? value.minimal_price_currency : null, index: numeric(value?.price_index_value)});
    return {source: 'ozon_seller_api', observedAt: new Date(Number(now())).toISOString(), priceIndex: {color: typeof indices.color_index === 'string' ? indices.color_index : null, ozon: shape(indices.ozon_index_data), external: shape(indices.external_index_data), ownMarketplaces: shape(indices.self_marketplaces_index_data)}, message: 'Агрегированный индекс Ozon: это ориентир цены, а не перечень всех конкурентов или гарантия позиции. При отсутствии значения Ozon не подтвердил сопоставимую цену.'};
  }
  async function saveEvidence(value) {
    if (!object(value) || !UUID.test(value.commandId || '') || !/^(0|[1-9][0-9]*)$/.test(value.expectedRevision || '')) fail('Для сохранения нужны идентификатор команды и версия наблюдений.');
    const {storeId, productId} = value; await requireStore(storeId); id(productId);
    const observation = normalizeObservation(value.observation, Number(now()));
    const commandId = value.commandId.toLowerCase(), repo = repository(storeId, productId), prior = await repo.readCommand(commandId);
    if (prior) {
      const saved = prior.after.value.observations.find(row => row.commandId === commandId);
      if (prior.before.revision !== value.expectedRevision || !saved || !encodeJson(saved.observation).equals(encodeJson(observation))) fail('Идентификатор команды уже использован.', 'COMMAND_ID_REUSED', 409);
      return {...output(prior.after), replayed: true};
    }
    const options = parseOptions(new URLSearchParams({store: storeId, limit: '1'}), Number(now()));
    const product = await optimizer.prices({...options, productId});
    if (!product.items.some(row => String(row.product?.id) === productId && row.product?.storeId === storeId)) fail('Товар этого магазина не найден.', 'NOT_FOUND', 404);
    const record = await repo.read();
    if ((record?.revision || '0') !== value.expectedRevision) fail('Наблюдения уже изменились. Обновите карточку.', 'REVISION_CONFLICT', 409);
    const doc = record?.value || empty(storeId, productId);
    const updated = {...doc, observations: [...doc.observations, {commandId, observation}].slice(-30)};
    await repo.compareAndSet(updated, {expectedRevision: value.expectedRevision, commandId});
    return output(await repo.read());
  }
  async function list(params) {
    const options = parseOptions(params, Number(now()));
    if (options.storeId) await requireStore(options.storeId);
    const [data, availableStores, commercialTerms] = await Promise.all([optimizer.prices(options), stores(), terms()]);
    const items = [];
    // Read small local documents in bounded batches, without external requests.
    for (let offset = 0; offset < data.items.length; offset += 8) {
      const batch = await Promise.all(data.items.slice(offset, offset + 8).map(async item => {
        let marketEvidence, evidenceError = null, competitors, watchlistError = null;
        try { marketEvidence = output(await repository(String(item.product.storeId), String(item.product.id)).read()); }
        catch { marketEvidence = {revision: null, observations: [], latest: null}; evidenceError = 'Наблюдения временно недоступны.'; }
        try { competitors = await watchlist.read({storeId: String(item.product.storeId), productId: String(item.product.id)}); }
        catch { competitors = {revision: null, competitors: []}; watchlistError = 'Привязки конкурентов временно недоступны.'; }
        const at = new Date(Number(now())).toISOString();
        return {...item, marketEvidence, evidenceError, watchlist: competitors, watchlistError, commercialPlan: calculateCommercialPlan(item, commercialTerms.terms, {now: at}), advisory: adviseProduct(item, {now: at, objective: options.objective, marketEvidence: marketEvidence.latest})};
      }));
      items.push(...batch);
    }
    return {...data, items, stores: availableStores, commercialTerms, objective: options.objective, capabilities: {priceWrite: false, bidWrite: false, auto: false}, coverage: {competitorMonitoring: false, message: 'Автоматический мониторинг конкурентов не подключён. Ручные наблюдения охватывают только выбранные аналоги, запрос и регион.'}};
  }
  return {list, evidence, saveEvidence, market, terms, saveTerms, watchlist: watchlist.read, saveWatchlist: watchlist.save};
}

function createGrowthRoutes({center, authorize}) {
  const reply = (res, status, value) => { res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(value)); };
  async function handle(req, res, url) {
    if (url.pathname !== '/api/growth' && !url.pathname.startsWith('/api/growth/')) return false;
    try {
      if (await authorize(req, url) !== true) fail('Доступ запрещён.', 'FORBIDDEN', 403);
      if (req.method === 'GET' && url.pathname === '/api/growth') reply(res, 200, await center.list(url.searchParams));
      else if (req.method === 'GET' && url.pathname === '/api/growth/evidence') reply(res, 200, await center.evidence({storeId: url.searchParams.get('store'), productId: url.searchParams.get('product')}));
      else if (req.method === 'GET' && url.pathname === '/api/growth/market') reply(res, 200, await center.market({storeId: url.searchParams.get('store'), productId: url.searchParams.get('product')}));
      else if (req.method === 'GET' && url.pathname === '/api/growth/terms') reply(res, 200, await center.terms());
      else if (req.method === 'GET' && url.pathname === '/api/growth/watchlist') reply(res, 200, await center.watchlist({storeId: url.searchParams.get('store'), productId: url.searchParams.get('product')}));
      else if (req.method === 'POST' && ['/api/growth/evidence', '/api/growth/terms', '/api/growth/watchlist'].includes(url.pathname)) {
        let bytes = 0; const chunks = [];
        for await (const part of req) { const chunk = Buffer.from(part); bytes += chunk.length; if (bytes > (url.pathname.endsWith('/watchlist') ? 256 * 1024 : 32768)) fail('Данные слишком большие.', 'BODY_TOO_LARGE', 413); chunks.push(chunk); }
        let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('Некорректный JSON.'); }
        reply(res, 200, await (url.pathname.endsWith('/terms') ? center.saveTerms(value) : url.pathname.endsWith('/watchlist') ? center.saveWatchlist(value) : center.saveEvidence(value)));
      } else reply(res, 405, {error: 'Метод не поддерживается.'});
    } catch (error) {
      const conflict = ['REVISION_CONFLICT', 'COMMAND_ID_REUSED'].includes(error.code);
      const known = error instanceof GrowthError || error instanceof GrowthWatchlistError;
      reply(res, known ? error.status : conflict ? 409 : 503, {code: known || conflict ? error.code : 'GROWTH_UNAVAILABLE', error: known ? error.message : conflict ? 'Данные изменились. Обновите карточку.' : 'Центр роста временно недоступен.'});
    }
    return true;
  }
  return {handle};
}

module.exports = {createGrowthCenter, createGrowthRoutes, normalizeObservation, normalizeTerms, parseOptions, GrowthError};
