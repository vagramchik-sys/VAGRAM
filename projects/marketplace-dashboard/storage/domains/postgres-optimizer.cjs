'use strict';

const {bidToRubles, storedBidToRubles, RUB} = require('../../optimizer/bid-units.cjs');
const {evaluateAutoPrice, evaluateAutoBid} = require('../../optimizer/auto-policy.cjs');
const CAPABILITIES = Object.freeze({priceWrite: false, bidWrite: false, auto: false});
const number = value => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const ledgerSum = (rows, key, complete) => {
  if (!rows.length) return null;
  const values = rows.map(row => {
    if (!row?.values || typeof row.values !== 'object') return null;
    if (!Object.hasOwn(row.values, key)) return complete ? 0 : null;
    return number(row.values[key]);
  });
  return values.some(value => value === null) ? null : values.reduce((a, b) => a + b, 0);
};
const rub = value => value === null ? null : value / 100;
const expense = value => value === null ? null : value === 0 ? 0 : -rub(value);
const timestamp = value => (value instanceof Date ? Number.isFinite(value.valueOf()) : typeof value === 'string' && Number.isFinite(Date.parse(value))) ? new Date(value).toISOString() : null;
const day = value => value instanceof Date && Number.isFinite(value.valueOf()) ? value.toISOString().slice(0, 10) : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : null;
const oldestTimestamp = values => {
  const dates = values.map(timestamp);
  return dates.length && dates.every(Boolean) ? dates.sort()[0] : null;
};

function stockQuantity(rows) {
  let total = 0, known = false;
  for (const row of rows || []) for (const value of Array.isArray(row?.stocks) ? row.stocks : [row]) {
    const amount = number(value?.present ?? value?.quantity ?? value?.freeToSellAmount ?? value?.available);
    if (amount !== null) { known = true; total += amount; }
  }
  return known ? total : null;
}

function productShape(row, storeName) {
  const product = row.product || {}, cost = row.cost || {}, pricing = cost.pricing || {};
  const id = String(product.product_id ?? product.id ?? ''), sku = String(product.sku ?? '');
  const skus = [...new Set([sku, ...(Array.isArray(product.sources) ? product.sources.map(value => String(value?.sku ?? '')) : [])].filter(Boolean))];
  const archived = typeof product.archived === 'boolean' ? product.archived : typeof product.is_archived === 'boolean' ? product.is_archived : null;
  return {
    key: `${row.store_id}:${id}`,
    product: {id, storeId: row.store_id, storeName: storeName || row.store_id, sku: sku || null, skus, offerId: product.offer_id ?? null, name: product.name ?? product.title ?? null, active: archived === null ? null : !archived},
    price: {sellerPrice: number(pricing.price ?? product.price), promotionalSellerPrice: number(pricing.sellerPrice), customerPrice: null, customerPriceSource: null, sellerCustomerDifference: null, sellerCustomerDifferencePct: null, currency: pricing.currency || product.currency_code || cost.currency || 'RUB', observedAt: timestamp(row.cost_observed_at) || timestamp(row.market_observed_at), priceIncrement: null},
    cost: {unitCost: number(cost.unitCost), currency: cost.currency || 'RUB', status: cost.status || 'missing', observedAt: timestamp(row.cost_observed_at)},
    stock: {quantity: stockQuantity(row.stocks), days: null, observedAt: timestamp(row.market_observed_at)},
    sourceRevisions: {market: row.market_revision || null, costs: row.cost_revision || null, ledger: row.ledger_revision || null}
  };
}

function financeShape(row, unitCost, requested = null) {
  const rows = Array.isArray(row.finance_rows) ? row.finance_rows : [];
  const imported = row.finance_complete === true || row.finance_complete === 'true';
  const covered = !requested || !!(row.finance_source_from && row.finance_source_to && row.finance_source_from <= requested.from && row.finance_source_to >= requested.to);
  // A complete finance import is not proof that every fee was allocated to an SKU.
  // Only the ledger builder's explicit zero-residual evidence permits sparse fees.
  const allocated = number(row.finance_unallocated_cents) === 0 && number(row.finance_residual_records) === 0 && number(row.finance_foreign_records) === 0;
  const provisional = imported && covered && allocated;
  const provisionalSum = key => ledgerSum(rows, key, provisional);
  const net = provisionalSum('net');
  const components = ['realized', 'commission', 'logistics', 'acquiring', 'storage', 'penalties', 'other', 'ads'].map(provisionalSum);
  const reconciled = net !== null && components.every(value => value !== null) && Math.abs(net - components.reduce((a, b) => a + b, 0)) <= 1;
  const complete = provisional && reconciled;
  const sum = key => ledgerSum(rows, key, complete);
  const unknownUnits = sum('unknownUnitRows');
  const sold = sum('soldUnits'), returned = sum('returnedUnits');
  const units = unknownUnits === 0 && sold !== null && returned !== null ? sold - returned : null;
  const cost = unitCost === null || units === null ? null : unitCost * units;
  const services = ['storage', 'penalties', 'other'].map(sum);
  // bonus/partners in ledger.cjs are informational and do not contribute to net.
  return {realizedRevenue: rub(sum('realized')), cost, commission: expense(sum('commission')), logistics: expense(sum('logistics')), acquiring: expense(sum('acquiring')), marketplaceServices: services.some(value => value === null) ? null : expense(services.reduce((a, b) => a + b, 0)), compensation: complete ? 0 : null, advertising: expense(sum('ads')), orders: units, orderBasis: 'unit', scope: 'seller_sku', attributionModel: 'seller_realized', complete, observedAt: timestamp(row.finance_observed_at), periodFrom: requested?.from || day(rows[0]?.date), periodTo: requested?.to || day(rows.at(-1)?.date)};
}

function advertisingShape(row) {
  const impressions = number(row.impressions), clicks = number(row.clicks), orders = number(row.orders), spend = number(row.spend), revenue = number(row.revenue);
  const pairedSpend = Object.hasOwn(row, 'paired_spend') ? number(row.paired_spend) : spend, pairedRevenue = Object.hasOwn(row, 'paired_revenue') ? number(row.paired_revenue) : revenue;
  return {connected: true, campaign: {id: row.campaign_id, name: row.campaign_name}, scope: 'campaign_sku', model: row.payment_type === 'CPC' ? 'CPC' : row.payment_type || null, unit: RUB, currentBid: storedBidToRubles(row.current_bid, row.bid_unit, row.current_bid_raw), competitiveBid: storedBidToRubles(row.competitive_bid, row.bid_unit, row.competitive_bid_raw), minimumBid: storedBidToRubles(row.minimum_bid, row.bid_unit, row.minimum_bid_raw), currentBidRaw: row.current_bid_raw ?? null, competitiveBidRaw: row.competitive_bid_raw ?? null, minimumBidRaw: row.minimum_bid_raw ?? null, currentBidRawUnit: row.current_bid_raw_unit ?? null, competitiveBidRawUnit: row.competitive_bid_raw_unit ?? null, minimumBidRawUnit: row.minimum_bid_raw_unit ?? null, bidIncrement: null, impressions, clicks, orders, ctrPct: impressions > 0 && clicks !== null ? clicks / impressions * 100 : null, cpc: clicks > 0 && spend !== null ? spend / clicks : null, cvrPct: clicks > 0 && orders !== null ? orders / clicks * 100 : null, spend, revenue, drrPct: pairedRevenue > 0 && pairedSpend !== null ? pairedSpend / pairedRevenue * 100 : null, orderBasis: 'attributed_order', attributionModel: 'ozon_performance', observedAt: oldestTimestamp([row.observed_at, row.statistics_observed_at]), periodFrom: day(row.period_from), periodTo: day(row.period_to), complete: row.complete === true, skuLinkStatus: row.sku_link_status || 'unmapped'};
}

function advertisingDecision(decision, econ, finance, advertising) {
  const confirmed = finance.complete === true && econ.economicsStatus === 'complete' && number(econ.contributionAfterAds) !== null;
  const economics = {...econ, confirmed, incompleteReason: confirmed ? null : 'Экономика SKU неполная'};
  const result = {...decision, bidUnit: RUB,
    maxProfitableBid: confirmed ? bidToRubles(decision.maxProfitableBid, RUB) : null,
    recommendedBid: confirmed ? bidToRubles(decision.recommendedBid, RUB) : null};
  if (!confirmed) {
    economics.contributionAfterAds = null;
    economics.contributionPerOrder = null;
    economics.marginPct = null;
    if (number(advertising.currentBid) !== null && number(advertising.competitiveBid) !== null && advertising.currentBid < advertising.competitiveBid) result.state = 'WAIT_ECONOMICS';
    else if (['BID_UP', 'PRICE_UP'].includes(result.state)) result.state = 'BLOCKED';
    result.action = 'NONE';
    result.recommendedPrice = null;
    result.humanReason = 'Экономика SKU неполная. Повышение ставки не рекомендуется.';
    result.blockers = [...new Set([...(result.blockers || []), 'ECONOMICS_INCOMPLETE'])];
  } else if (result.recommendedBid !== null && (result.maxProfitableBid === null || result.recommendedBid > result.maxProfitableBid)) {
    result.recommendedBid = null;
    result.action = 'NONE';
    result.state = 'HOLD';
    result.humanReason = 'Рекомендация не подтверждена прибыльным потолком.';
    result.blockers = [...new Set([...(result.blockers || []), 'PROFITABLE_BID_LIMIT'])];
  }
  result.competitiveWarning = confirmed && result.maxProfitableBid !== null && number(advertising.competitiveBid) !== null && advertising.competitiveBid > result.maxProfitableBid ? 'Конкурентную ставку догонять невыгодно' : null;
  if (result.competitiveWarning) result.humanReason = [result.humanReason, result.competitiveWarning].filter(Boolean).join(' ');
  return {economics, optimizer: result};
}

const disconnectedAds = () => ({connected: false, scope: 'campaign_sku', model: null, unit: null, currentBid: null, competitiveBid: null, minimumBid: null, currentBidRaw: null, competitiveBidRaw: null, minimumBidRaw: null, bidIncrement: null, impressions: null, clicks: null, orders: null, spend: null, revenue: null, orderBasis: null, attributionModel: null, observedAt: null, periodFrom: null, periodTo: null, complete: false, skuLinkStatus: 'unmapped'});
const blocked = reason => ({state: 'BLOCKED', action: 'NONE', recommendedPrice: null, recommendedBid: null, maxProfitableBid: null, confidence: 'LOW', reasonCodes: [reason], humanReason: 'Недостаточно подтверждённых данных для рекомендации.', blockers: [reason]});
const aggregateAds = rows => {
  if (!rows.length) return disconnectedAds();
  if (rows.length === 1) return advertisingShape(rows[0]);
  const ads = rows.map(advertisingShape), total = key => ads.every(row => row[key] !== null) ? ads.reduce((value, row) => value + row[key], 0) : null;
  const impressions = total('impressions'), clicks = total('clicks'), orders = total('orders'), spend = total('spend'), revenue = total('revenue');
  return {connected: true, scope: 'seller_sku', model: ads.every(row => row.model === 'CPC') ? 'CPC' : null, unit: ads.every(row => row.unit === ads[0].unit) ? ads[0].unit : null, currentBid: null, competitiveBid: null, minimumBid: null, bidIncrement: null, impressions, clicks, orders, ctrPct: impressions > 0 && clicks !== null ? clicks / impressions * 100 : null, cpc: clicks > 0 && spend !== null ? spend / clicks : null, cvrPct: clicks > 0 && orders !== null ? orders / clicks * 100 : null, spend, revenue, drrPct: revenue > 0 && spend !== null ? spend / revenue * 100 : null, orderBasis: 'attributed_order', attributionModel: 'ozon_performance', observedAt: oldestTimestamp(ads.map(row => row.observedAt)), periodFrom: ads.map(row => row.periodFrom).filter(Boolean).sort()[0] || null, periodTo: ads.map(row => row.periodTo).filter(Boolean).sort().at(-1) || null, complete: ads.every(row => row.complete), skuLinkStatus: ads.every(row => row.skuLinkStatus === 'matched') ? 'matched' : 'ambiguous'};
};

function historyState(events) {
  const experiments = events.filter(event => event.type === 'experiment');
  const active = experiments.find(event => ['recorded', 'observing'].includes(event.status));
  const activeExperiment = active ? {...active, startedAt: timestamp(active.at), observeUntil: timestamp(active.observeUntil), beforeValue: number(active.beforeValue), afterValue: number(active.afterValue)} : null;
  return {state: activeExperiment ? (activeExperiment.dimension === 'PRICE' ? 'WAIT_PRICE' : 'WAIT_ADS') : 'BASELINE', activeExperiment, lastActionAt: timestamp(experiments[0]?.at), baseline: null, current: null, priceTestPassed: false};
}

function createPostgresOptimizer({repository, storesRepository, sourceProviders, optimizer = {}, now = () => new Date()} = {}) {
  if (!repository?.readPriceInputs || !repository?.readProductInputs || !repository?.readAds || !repository?.readAdsForProducts || !repository?.readRecentExperiments || !repository?.connectionStatus || !repository?.campaignOptions || !repository?.readSettings || !repository?.readHistory || !storesRepository?.read || !sourceProviders?.getProducts || typeof now !== 'function') throw new TypeError('PostgreSQL optimizer dependencies are required');
  const decide = input => typeof optimizer.optimizerDecision === 'function' ? optimizer.optimizerDecision(input) : blocked('OPTIMIZER_UNAVAILABLE');
  const economics = input => typeof optimizer.calculateContributionEconomics === 'function' ? optimizer.calculateContributionEconomics(input) : {contributionBeforeAds: null, contributionAfterAds: null, contributionBeforeAdsPerOrder: null, contributionPerOrder: null, marginPct: null, economicsStatus: 'insufficient', missingFields: ['optimizer']};
  const envelope = async (base, options, summary = {}) => {
    const [connection, campaigns] = await Promise.all([repository.connectionStatus(options.storeId ? {storeId: options.storeId} : {}), repository.campaignOptions(options.storeId ? {storeId: options.storeId} : {})]);
    return {...base, generatedAt: now().toISOString(), period: {from: options.from, to: options.to, timeZone: 'Europe/Moscow'}, summary, filterOptions: {campaigns: campaigns.map(row => ({id: row.id, name: row.name, storeId: row.store_id}))}, connection: {status: connection.stores.length ? 'connected' : 'not_connected', stores: connection.stores}, capabilities: CAPABILITIES};
  };

  async function prices(options = {}) {
    const [page, stores, settings] = await Promise.all([repository.readPriceInputs(options), storesRepository.read(), repository.readSettings({storeId: options.storeId})]);
    const refs = page.items.map(row => ({storeId: row.store_id, productId: String(row.product?.product_id ?? row.product?.id ?? '')})).filter(ref => ref.productId);
    const [performance, recentExperiments] = await Promise.all([repository.readAdsForProducts(refs, options), repository.readRecentExperiments(refs)]), byProduct = new Map();
    for (const row of performance) { const key = `${row.store_id}:${row.product_id}`; if (!byProduct.has(key)) byProduct.set(key, []); byProduct.get(key).push(row); }
    const recentByProduct = new Map(recentExperiments.map(row => [`${row.store_id}:${row.product_id}`, row]));
    const items = [];
    for (const row of page.items) {
      const shaped = productShape(row, stores[row.store_id]?.name), finance = financeShape(row, shaped.cost.unitCost, options), ads = aggregateAds(byProduct.get(shaped.key) || []), history = historyState(recentByProduct.has(shaped.key) ? [recentByProduct.get(shaped.key)] : []);
      const econ = economics(finance), decision = decide({now: now().toISOString(), ...shaped, finance, ads, settings, history});
      items.push({...shaped, campaign: null, advertising: ads, economics: econ, optimizer: decision, stale: false});
    }
    const all = page.total === items.length, pricedPairs = items.filter(item => item.price.sellerCustomerDifference !== null);
    return envelope({...page, items}, options, {priceUpCount: all ? items.filter(item => item.optimizer.state === 'PRICE_UP').length : null, observingCount: all ? items.filter(item => ['BASELINE', 'WAIT_PRICE', 'WAIT_ADS'].includes(item.optimizer.state)).length : null, blockedCount: all ? items.filter(item => item.optimizer.state === 'BLOCKED').length : null, rollbackCount: all ? items.filter(item => item.optimizer.state === 'ROLLBACK').length : null, averageSellerCustomerDifference: pricedPairs.length ? pricedPairs.reduce((value, item) => value + item.price.sellerCustomerDifference, 0) / pricedPairs.length : null, pricedPairCount: pricedPairs.length, potentialContributionIncrease: null, complete: all && items.every(item => item.economics.economicsStatus === 'complete')});
  }

  async function liveInputs(rows, options) {
    const refs = rows.filter(row => row.product_id).map(row => ({storeId: row.store_id, productId: String(row.product_id)}));
    const inputs = await repository.readProductInputs(refs, options);
    return new Map(inputs.map(row => [`${row.store_id}:${row.product?.product_id ?? row.product?.id ?? ''}`, row]));
  }

  async function ads(options = {}) {
    const [stores, settings] = await Promise.all([storesRepository.read(), repository.readSettings({storeId: options.storeId})]);
    const page = await repository.readAds({...options, statisticsThresholds: settings});
    const refs = page.items.filter(row => row.product_id).map(row => ({storeId: row.store_id, productId: String(row.product_id)}));
    const [live, recentExperiments] = await Promise.all([liveInputs(page.items, options), repository.readRecentExperiments(refs)]), recentByProduct = new Map(recentExperiments.map(row => [`${row.store_id}:${row.product_id}`, row])), items = [];
    for (const row of page.items) {
      const input = live.get(`${row.store_id}:${row.product_id}`), base = input ? productShape(input, stores[row.store_id]?.name) : {key: `${row.store_id}:${row.product_id || row.sku}`, product: {id: row.product_id || null, storeId: row.store_id, storeName: stores[row.store_id]?.name || row.store_id, sku: row.sku, skus: [row.sku], offerId: null, name: null, active: false}, price: {sellerPrice: null, promotionalSellerPrice: null, customerPrice: null, customerPriceSource: null, sellerCustomerDifference: null, sellerCustomerDifferencePct: null, currency: 'RUB', observedAt: null, priceIncrement: null}, cost: {unitCost: null, currency: 'RUB', status: 'missing', observedAt: null}, stock: {quantity: null, days: null, observedAt: null}, sourceRevisions: {}};
      const advertising = advertisingShape(row), finance = input ? financeShape(input, base.cost.unitCost, options) : financeShape({}, null, options), history = historyState(recentByProduct.has(base.key) ? [recentByProduct.get(base.key)] : []);
      // Confirmed contribution is SKU-wide from the ledger; never subtract one campaign again.
      const econ = economics(finance), decision = decide({now: now().toISOString(), ...base, finance, ads: advertising, settings, history});
      items.push({...base, campaign: {id: row.campaign_id, name: row.campaign_name, state: row.campaign_state, paymentType: row.payment_type}, advertising, ...advertisingDecision(decision, econ, finance, advertising), stale: !input});
    }
    const all = page.total === items.length, summary = page.summary || {};
    const uniqueProducts = [...new Map(items.map(item => [item.key, item])).values()];
    const confirmed = all && uniqueProducts.length > 0 && uniqueProducts.every(item => item.economics.confirmed);
    return envelope({...page, items}, options, {...summary, contributionAfterAds: confirmed ? uniqueProducts.reduce((value, item) => value + item.economics.contributionAfterAds, 0) : null, economicsComplete: confirmed, complete: summary.complete === true});
  }

  async function sku({storeId, productId, campaignId} = {}) {
    const today = new Date(now().valueOf() + 3 * 3600000).toISOString().slice(0, 10), end = new Date(Date.parse(today + 'T00:00:00Z') - 86400000), start = new Date(end.valueOf() - 13 * 86400000), period = {from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10)};
    const [products, adsRows, settings, stores, events] = await Promise.all([repository.readPriceInputs({storeId, productId: String(productId), limit: 1, offset: 0, ...period}), repository.readSkuAds({storeId, productId, campaignId, ...period}), repository.readSettings({storeId}), storesRepository.read(), repository.readHistory({storeId, productId: String(productId), limit: 100})]);
    const row = products.items[0]; if (!row) return null;
    const item = productShape(row, stores[storeId]?.name), finance = financeShape(row, item.cost.unitCost, period), advertising = adsRows.map(advertisingShape), ads = aggregateAds(adsRows), history = historyState(events), at = now().toISOString();
    const guarded = advertisingDecision(decide({now: at, ...item, finance, ads, settings, history}), economics(finance), finance, ads);
    const calculatedEconomics = guarded.economics, decision = guarded.optimizer;
    const autoInput = {autoEnabled: false, killSwitch: settings.killSwitch, now: at, decision, price: item.price, stock: item.stock,
      finance: {...finance, contributionAfterAds: calculatedEconomics.contributionAfterAds}, history, profitFloorPerOrder: settings.targetProfitPerOrder};
    return {item, price: item.price, advertising, economics: calculatedEconomics, optimizer: decision,
      automation: {price: evaluateAutoPrice({...autoInput, evidence: {}}), bid: evaluateAutoBid({...autoInput, ads, spendGuard: {}})},
      history: events, settingsRevision: settings.revision, capabilities: CAPABILITIES};
  }
  async function settings(options = {}) { const value = await repository.readSettings(options); return {settings: value, revision: value.revision, capabilities: CAPABILITIES}; }
  return Object.freeze({prices, ads, sku, settings, CAPABILITIES});
}

module.exports = {createPostgresOptimizer, CAPABILITIES, productShape, financeShape, advertisingShape, advertisingDecision};
