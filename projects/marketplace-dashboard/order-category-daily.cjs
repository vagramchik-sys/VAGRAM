'use strict';

const fs = require('node:fs'), path = require('node:path');
const productTypes = require('./product-type-registry.cjs');
const DAY = 86400000, TZ = 'Europe/Moscow';
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const moscowDay = value => { const parsed = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value); return Number.isFinite(parsed) ? formatter.format(new Date(parsed)) : null; };
function validDay(value) { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null; const parsed = Date.parse(value + 'T00:00:00Z'); return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? value : null; }
const shift = (value, count) => new Date(Date.parse(value + 'T00:00:00Z') + count * DAY).toISOString().slice(0, 10);
const numericId = value => value !== null && value !== undefined && String(value).trim() ? String(value) : null;
const displayText = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const safeUnits = value => Number.isSafeInteger(value) && value > 0 ? value : null;
function safeAmount(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isSafeInteger(Math.round(value * 100)) ? value : null; }
function checkedSum(values, label) { let total = 0; for (const value of values) { total += value; if (!Number.isSafeInteger(total) && label === 'units' || !Number.isFinite(total)) throw Error('Переполнение ' + label); } return total; }

function compileCatalogs(catalogs, registry) {
  const stores = new Map();
  for (const catalog of Array.isArray(catalogs) ? catalogs : []) {
    if (!catalog?.storeId || !['Ozon', 'WB'].includes(catalog.market) || !Array.isArray(catalog.products)) continue;
    const aliases = new Map();
    for (const product of catalog.products) {
      const stable = numericId(product.product_id ?? product.nmID);
      if (!stable) continue;
      const productKey = catalog.storeId + ':' + stable, classification = productTypes.classify(registry, productKey, product);
      const entry = { productKey, productId: stable, sku: numericId(product.sku), offerId: numericId(product.offer_id ?? product.offerId ?? product.vendorCode), name: displayText(product.name) || displayText(product.title) || displayText(product.product_name), typeId: classification?.typeId || null, classificationSource: classification?.source || null };
      for (const alias of [product.sku, product.product_id, product.nmID]) if (numericId(alias)) aliases.set(String(alias), entry);
    }
    stores.set(catalog.storeId, { storeId: catalog.storeId, name: catalog.name || null, market: catalog.market, aliases, catalogStamp: catalog.stamp || null });
  }
  return stores;
}

function latestProductOrders(snapshots, { from, to } = {}) {
  const scoped = !!validDay(from) && !!validDay(to) && from <= to;
  const latest = new Map(), coverage = [], orderEvidence = new Set(), productEvidence = new Set();
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    for (const source of snapshot?.report?.coverage?.sources || []) coverage.push(source);
    for (const record of snapshot?.records || []) {
      const date = moscowDay(record.createdAt);
      if (scoped && (!date || date < from || date > to)) continue;
      if (date && record.market && record.storeId && record.scheme) orderEvidence.add([record.market, record.storeId, record.scheme, date].join('\u001f'));
    }
    for (const row of snapshot?.productOrders || []) {
      const posting = numericId(row.postingId) || numericId(row.orderId), productId = numericId(row.productId);
      if (!row.market || !row.storeId || !row.scheme || !posting || !productId) continue;
      const date = moscowDay(row.orderedAt), inRange = !scoped || !!date && date >= from && date <= to;
      if (inRange && date) productEvidence.add([row.market, row.storeId, row.scheme, date].join('\u001f'));
      const key = [row.market, row.storeId, row.scheme, posting, productId].join('\u001f'), previous = latest.get(key);
      const rawStamp = Date.parse(row.updatedAt || snapshot.generatedAt || 0), stamp = Number.isFinite(rawStamp) ? rawStamp : -Infinity;
      // Keep an out-of-range winner as a tombstone: an updated order can move
      // outside the requested period and must still supersede an older row.
      if (!previous || stamp >= previous.stamp) latest.set(key, { row: inRange ? row : null, stamp });
    }
  }
  return { rows: [...latest.values()].flatMap(item => item.row ? [item.row] : []), coverage, orderEvidence, productEvidence };
}

function sourceCovers(source, date) {
  const from = validDay(source?.requested?.from) || validDay(source?.from), to = validDay(source?.requested?.to) || validDay(source?.to);
  return source?.available === true && source?.complete === true && !!from && !!to && date >= from && date <= to;
}
function expectedSchemes(market) { return market === 'Ozon' ? ['FBO', 'FBS'] : ['FBS']; }
function descendants(types, parentId) {
  const children = new Map(); for (const type of types) { const list = children.get(type.parentId) || []; list.push(type.id); children.set(type.parentId, list); }
  const leaves = []; (function visit(id) { const next = children.get(id) || []; if (!next.length) leaves.push(id); else for (const child of next) visit(child); })(parentId); return leaves;
}
const freshForDay = (stamp, date) => typeof stamp === 'string' && moscowDay(stamp) === date;

function build(data, options = {}) {
  const registry = productTypes.validate(data.registry), classifiedAt = new Date(options.classifiedAt || Date.now()).toISOString();
  let from = validDay(options.from), to = validDay(options.to); if (!from || !to || from > to || (Date.parse(to) - Date.parse(from)) / DAY > 365) throw Error('Некорректный период динамики категорий');
  const market = options.market === '' || options.market === 'all' || options.market == null ? 'all' : options.market;
  if (!['all', 'Ozon', 'WB'].includes(market)) throw Error('Неизвестная площадка');
  const stores = compileCatalogs(data.catalogs, registry), storeId = options.store || options.storeId || null;
  if (storeId && !stores.has(storeId)) throw Error('Магазин не найден в каталоге заказов');
  const scope = [...stores.values()].filter(store => (!storeId || store.storeId === storeId) && (market === 'all' || store.market === market));
  const days = []; for (let value = from; value <= to; value = shift(value, 1)) days.push(value);
  const canonical = latestProductOrders(data.snapshots, { from, to }), canonicalRowsByStoreDay = new Map(), sourcesByScheme = new Map(), today = moscowDay(options.now || Date.now());
  for (const row of canonical.rows) {
    const date = moscowDay(row.orderedAt); if (!date) continue;
    const key = [row.market, row.storeId, date].join('\u001f'), rows = canonicalRowsByStoreDay.get(key);
    if (rows) rows.push(row); else canonicalRowsByStoreDay.set(key, [row]);
  }
  for (const source of canonical.coverage) {
    const key = [source?.market, source?.storeId, source?.scheme].join('\u001f'), sources = sourcesByScheme.get(key);
    if (sources) sources.push(source); else sourcesByScheme.set(key, [source]);
  }
  const events = new Map(), productEvents = new Map(), orderedProducts = new Map(), coverage = [], coverageByMarketDay = new Map(), coverageByStoreDay = new Map(), missingProducts = new Map();
  const recordCoverage = item => {
    coverage.push(item);
    const marketDay = [item.market, item.date].join('\u001f'), relevant = coverageByMarketDay.get(marketDay);
    if (relevant) relevant.push(item); else coverageByMarketDay.set(marketDay, [item]);
    coverageByStoreDay.set([item.market, item.storeId, item.date].join('\u001f'), item);
  };
  const add = (store, date, source, raw) => {
    const key = [store.market, store.storeId, date].join('\u001f'); if (!events.has(key)) events.set(key, new Map());
    const alias = store.aliases.get(String(raw.productId));
    if (!alias?.typeId) { missingProducts.set(key, checkedSum([missingProducts.get(key) || 0, raw.units], 'units')); return; }
    const byType = events.get(key), rows = byType.get(alias.typeId);
    const event = { typeId: alias.typeId, units: raw.units, amountRub: raw.amountRub, source, productKey: alias.productKey };
    if (rows) rows.push(event); else byType.set(alias.typeId, [event]);
    if (!productEvents.has(key)) productEvents.set(key, new Map());
    const daily = productEvents.get(key), previous = daily.get(alias.productKey), amountKnown = raw.amountRub !== null;
    daily.set(alias.productKey, { units: checkedSum([previous?.units || 0, raw.units], 'units'), amountRub: checkedSum([previous?.amountRub || 0, amountKnown ? raw.amountRub : 0], 'revenue'), amountKnown: (previous?.amountKnown ?? true) && amountKnown });
    orderedProducts.set(alias.productKey, { store, product: alias });
  };
  for (const store of scope) for (const date of days) {
    const key = [store.market, store.storeId, date].join('\u001f'), schemes = expectedSchemes(store.market);
    const rows = canonicalRowsByStoreDay.get(key) || [];
    const schemeSourceCoverage = schemes.map(scheme => (sourcesByScheme.get([store.market, store.storeId, scheme].join('\u001f')) || []).some(source => source.market === store.market && source.storeId === store.storeId && source.scheme === scheme && sourceCovers(source, date)));
    const schemeCoverage = schemes.map((scheme,index) => { const evidenceKey = [store.market, store.storeId, scheme, date].join('\u001f');return schemeSourceCoverage[index]&&(!canonical.orderEvidence.has(evidenceKey)||canonical.productEvidence.has(evidenceKey)); });
    const canonicalEvidence = schemes.some(scheme => canonical.orderEvidence.has([store.market, store.storeId, scheme, date].join('\u001f')));
    if (rows.length || schemeSourceCoverage.some(Boolean) && !canonicalEvidence) {
      for (const row of rows) { const units = safeUnits(row.units); if (units) add(store, date, 'canonical-orders', { productId: row.productId, units, amountRub: safeAmount(row.amountRub) }); }
      recordCoverage({ date, storeId: store.storeId, market: store.market, source: 'canonical-orders', complete: schemeCoverage.every(Boolean), observed: rows.length > 0 || !canonicalEvidence, schemes: Object.fromEntries(schemes.map((scheme, index) => [scheme, schemeCoverage[index]])) });
      continue;
    }
    if (date !== today && schemeSourceCoverage.some(Boolean)) {
      recordCoverage({ date, storeId: store.storeId, market: store.market, source: 'canonical-orders', complete: false, observed: false, schemes: Object.fromEntries(schemes.map((scheme, index) => [scheme, schemeCoverage[index]])) });
      continue;
    }
    if (date === today && store.market === 'Ozon') {
      const insight = data.insights?.[store.storeId], orders = insight?.orders, fresh = orders?.skuDailyCoverage === true && freshForDay(orders.skuUpdatedAt, date) && Array.isArray(orders.skuDaily);
      if (fresh) for (const row of orders.skuDaily.filter(item => item.date === date)) { const units = safeUnits(row.units); if (units) add(store, date, 'ozon-sku-today', { productId: row.sku, units, amountRub: safeAmount(row.revenue) }); }
      recordCoverage({ date, storeId: store.storeId, market: store.market, source: fresh ? 'ozon-sku-today' : 'unavailable', complete: fresh, schemes: { aggregateAnalytics: fresh } }); continue;
    }
    if (date === today && store.market === 'WB') {
      const state = data.wbOrders?.[store.storeId], fresh = state?.complete === true && state.day === date && Array.isArray(state.orders);
      if (fresh) for (const row of state.orders) { const units = 1; add(store, date, 'wb-orders-today', { productId: row.nmId, units, amountRub: safeAmount(row.amount) }); }
      recordCoverage({ date, storeId: store.storeId, market: store.market, source: fresh ? 'wb-orders-today' : 'unavailable', complete: fresh, schemes: { ordersSnapshot: fresh } }); continue;
    }
    recordCoverage({ date, storeId: store.storeId, market: store.market, source: 'unavailable', complete: false, schemes: Object.fromEntries(schemes.map(scheme => [scheme, false])) });
  }
  const parentIds = new Set(registry.types.map(type => type.parentId));
  const leafIds = registry.types.filter(type => !parentIds.has(type.id)).map(type => type.id), markets = market === 'all' ? ['Ozon', 'WB'] : [market];
  const scopeByMarket = new Map(markets.map(currentMarket => [currentMarket, scope.filter(store => store.market === currentMarket)]));
  const leafSeries = [];
  for (const currentMarket of markets) for (const typeId of leafIds) {
    const points = days.map(date => {
      const relevantCoverage = coverageByMarketDay.get([currentMarket, date].join('\u001f')) || [], observed = relevantCoverage.some(item => item.source !== 'unavailable' && item.observed !== false);
      const rows = scopeByMarket.get(currentMarket).flatMap(store => events.get([currentMarket, store.storeId, date].join('\u001f'))?.get(typeId) || []);
      const missing = relevantCoverage.some(item => !item.complete) || scopeByMarket.get(currentMarket).some(store => (missingProducts.get([currentMarket, store.storeId, date].join('\u001f')) || 0) > 0);
      const amountKnown = observed && rows.every(row => row.amountRub !== null);
      return { date, orderedUnits: observed ? checkedSum(rows.map(row => row.units), 'units') : null, orderedRevenue: amountKnown ? Math.round(checkedSum(rows.map(row => row.amountRub), 'revenue') * 100) / 100 : null, complete: observed && !missing, unitsKnown: observed && !missing, revenueKnown: amountKnown && !missing, observed };
    });
    if (points.some(point => point.orderedUnits > 0)) leafSeries.push({ typeId, market: currentMarket, aggregate: false, points });
  }
  const storeLeafSeries = [];
  for (const store of scope) for (const typeId of leafIds) {
    const points = days.map(date => {
      const key = [store.market, store.storeId, date].join('\u001f'), storeCoverage = coverageByStoreDay.get(key), observed = !!storeCoverage && storeCoverage.source !== 'unavailable' && storeCoverage.observed !== false;
      const rows = events.get(key)?.get(typeId) || [], missing = !storeCoverage?.complete || (missingProducts.get(key) || 0) > 0;
      const amountKnown = observed && rows.every(row => row.amountRub !== null);
      return { date, orderedUnits: observed ? checkedSum(rows.map(row => row.units), 'units') : null, orderedRevenue: amountKnown ? Math.round(checkedSum(rows.map(row => row.amountRub), 'revenue') * 100) / 100 : null, complete: observed && !missing, unitsKnown: observed && !missing, revenueKnown: amountKnown && !missing, observed };
    });
    if (points.some(point => point.orderedUnits > 0)) storeLeafSeries.push({ storeId: store.storeId, storeName: store.name, typeId, market: store.market, aggregate: false, points });
  }
  const byProduct = [];
  for (const { store, product } of orderedProducts.values()) {
    const points = days.map(date => {
      const key = [store.market, store.storeId, date].join('\u001f'), storeCoverage = coverageByStoreDay.get(key), observed = !!storeCoverage && storeCoverage.source !== 'unavailable' && storeCoverage.observed !== false;
      const daily = productEvents.get(key)?.get(product.productKey), missing = !storeCoverage?.complete || (missingProducts.get(key) || 0) > 0, amountKnown = observed && (!daily || daily.amountKnown);
      return { date, orderedUnits: observed ? daily?.units || 0 : null, orderedRevenue: amountKnown ? Math.round((daily?.amountRub || 0) * 100) / 100 : null, complete: observed && !missing, unitsKnown: observed && !missing, revenueKnown: amountKnown && !missing, observed };
    });
    byProduct.push({ productKey: product.productKey, typeId: product.typeId, productId: product.productId, sku: product.sku, offerId: product.offerId, name: product.name, storeId: store.storeId, storeName: store.name, market: store.market, points });
  }
  const series = [...leafSeries];
  for (const type of registry.types.filter(type => parentIds.has(type.id))) for (const currentMarket of markets) {
    const leafSet = new Set(descendants(registry.types, type.id)), children = leafSeries.filter(item => item.market === currentMarket && leafSet.has(item.typeId)); if (!children.length) continue;
    const points = days.map((date, index) => { const values = children.map(child => child.points[index]), observed = values.some(value => value.observed), complete = observed && values.every(value => value.complete), units = observed ? checkedSum(values.map(value => value.orderedUnits || 0), 'units') : null, revenueAvailable = observed && values.every(value => value.orderedRevenue !== null), revenueKnown = complete && values.every(value => value.revenueKnown); return { date, orderedUnits: units, orderedRevenue: revenueAvailable ? Math.round(checkedSum(values.map(value => value.orderedRevenue), 'revenue') * 100) / 100 : null, complete, unitsKnown: complete, revenueKnown, observed }; });
    series.push({ typeId: type.id, market: currentMarket, aggregate: true, leafCount: children.length, points });
  }
  const byStore = [...storeLeafSeries];
  for (const store of scope) for (const type of registry.types.filter(type => parentIds.has(type.id))) {
    const leafSet = new Set(descendants(registry.types, type.id)), children = storeLeafSeries.filter(item => item.storeId === store.storeId && leafSet.has(item.typeId)); if (!children.length) continue;
    const points = days.map((date, index) => { const values = children.map(child => child.points[index]), observed = values.some(value => value.observed), complete = observed && values.every(value => value.complete), units = observed ? checkedSum(values.map(value => value.orderedUnits || 0), 'units') : null, revenueAvailable = observed && values.every(value => value.orderedRevenue !== null), revenueKnown = complete && values.every(value => value.revenueKnown); return { date, orderedUnits: units, orderedRevenue: revenueAvailable ? Math.round(checkedSum(values.map(value => value.orderedRevenue), 'revenue') * 100) / 100 : null, complete, unitsKnown: complete, revenueKnown, observed }; });
    byStore.push({ storeId: store.storeId, storeName: store.name, typeId: type.id, market: store.market, aggregate: true, leafCount: children.length, points });
  }
  const typeIds = new Set(series.map(item => item.typeId)), selectedTypes = registry.types.filter(type => typeIds.has(type.id)).map(type => ({ ...type, leaf: !parentIds.has(type.id) }));
  const coveredDays = coverage.filter(item => item.source !== 'unavailable').map(item => item.date).sort(), coverageWithNames = coverage.map(item => ({ ...item, name: stores.get(item.storeId)?.name || null }));
  return { period: { from, to, days: days.length, timezone: TZ }, types: selectedTypes, series, byStore, byProduct, classificationRevision: registry.revision, classifiedAt, sourcePeriod: { from: coveredDays[0] || null, to: coveredDays.at(-1) || null }, coverage: { complete: coverage.length > 0 && coverage.every(item => item.complete) && missingProducts.size === 0, stores: coverageWithNames, missingProductUnits: checkedSum([...missingProducts.values()], 'units') }, limitations: ['Исторические категории пересчитаны по текущей ревизии справочника; сохранённые внутридневные точки не изменяются.', 'За день и магазин используется один источник: канонические заказы либо только сегодняшний SKU-снимок.', 'WB до текущего дня не показан без подтверждённой истории заказов.', 'Сумма равна null, если валюта RUB не подтверждена для всех включённых строк.', 'Неполные магазины и схемы дают частичную точку, а отсутствие источника — null.'] };
}

function create({ privateDir, stores: storeDirectory = {}, now = () => Date.now() }) {
  const jsonCache = new Map(), resultCache = new Map();
  function readJson(file) { const stat = fs.statSync(file), signature = stat.size + ':' + stat.mtimeMs, previous = jsonCache.get(file); if (previous?.signature === signature) return { value: previous.value, signature }; const value = JSON.parse(fs.readFileSync(file, 'utf8')); jsonCache.set(file, { signature, value }); return { value, signature }; }
  function load() {
    const files = fs.readdirSync(privateDir).filter(name => /^buyer-order-segments-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}(?:\.partial)?\.json$/.test(name)).map(name => path.join(privateDir, name));
    const supporting = fs.readdirSync(privateDir).filter(name => /^(?:product-type-registry|order-category-catalog-.+|insights-.+|wb-orders-.+)\.json$/.test(name)).map(name => path.join(privateDir, name));
    const registryFile = path.join(privateDir, 'product-type-registry.json'), registryRead = readJson(registryFile), catalogs = [], insights = {}, wbOrders = {}, baseParts = [registryFile + ':' + registryRead.signature], currentParts = [];
    for (const file of supporting) { const name = path.basename(file); if (name === 'product-type-registry.json') continue; const read = readJson(file); if (name.startsWith('order-category-catalog-')) { const storeId = name.slice(23, -5); catalogs.push({ ...read.value, storeId, name: typeof storeDirectory[storeId]?.name === 'string' ? storeDirectory[storeId].name : read.value.name || null, market: storeId.startsWith('wb-') ? 'WB' : 'Ozon' }); baseParts.push(file + ':' + read.signature); } else if (name.startsWith('insights-')) { insights[name.slice(9, -5)] = read.value; currentParts.push(file + ':' + read.signature); } else if (name.startsWith('wb-orders-')) { wbOrders[name.slice(10, -5)] = read.value; currentParts.push(file + ':' + read.signature); } }
    const snapshots = files.map(file => { const read = readJson(file); baseParts.push(file + ':' + read.signature); return read.value; });
    return { data: { registry: registryRead.value, catalogs, insights, wbOrders, snapshots }, baseKey: baseParts.sort().join('|'), currentKey: currentParts.sort().join('|') };
  }
  return { read(options = {}) { const loaded = load(), effectiveNow = options.now || now(), today = moscowDay(effectiveNow), includesToday = validDay(options.from) <= today && validDay(options.to) >= today, key = JSON.stringify({ ...options, now: today, sources: loaded.baseKey + (includesToday ? '|' + loaded.currentKey : '') }); if (!resultCache.has(key)) { if (resultCache.size >= 20) resultCache.delete(resultCache.keys().next().value); resultCache.set(key, build(loaded.data, { ...options, now: effectiveNow })); } return resultCache.get(key); } };
}

module.exports = { build, create, compileCatalogs, latestProductOrders, descendants, moscowDay };
