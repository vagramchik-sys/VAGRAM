'use strict';

const {
  calculateContributionEconomics, calculateMaxAdSpendPerOrder, calculateMaxCpc,
} = require('./economics.cjs');

const DEFAULT_SETTINGS = Object.freeze({
  mode: 'OBSERVE', killSwitch: false, targetProfitPerOrder: 0,
  priceStepPct: 0.05, bidStepPct: 0.10, competitiveBuffer: 1, safetyFactor: 0.8,
  minStock: 5, minStockDays: 7, maxPriceAgeHours: 24, maxAdsAgeHours: 2,
  minImpressions: 1000, minClicks: 100, minOrders: 10, observationDays: 7,
  cooldownHours: 72,
});
const DAY = 86400000;
const HOUR = 3600000;
const STATES = new Set(['BASELINE', 'PRICE_UP', 'WAIT_PRICE', 'BID_UP', 'WAIT_ADS', 'HOLD', 'ROLLBACK', 'BLOCKED']);
const ACTIVE_STATUSES = new Set(['recorded', 'observing']);
const money = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
const nonnegative = value => money(value) && value >= 0;
const positive = value => money(value) && value > 0;
const count = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const unique = values => [...new Set(values)];
const settingsFor = input => ({ ...DEFAULT_SETTINGS, ...object(input.settings) });
const BLOCKER_MESSAGES = Object.freeze({
  INVALID_SETTINGS: 'Настройки содержат неизвестное значение или превышают допустимый шаг изменения.',
  AUTO_DISABLED: 'Автоматические изменения отключены в этой версии.',
  KILL_SWITCH: 'Аварийная блокировка рекомендаций включена.',
  INVALID_NOW: 'Не задано корректное время оценки.',
  INVALID_ACTION: 'Запрошено неподдерживаемое действие.',
  INACTIVE_PRODUCT: 'Товар неактивен.',
  UNKNOWN_PRODUCT_STATUS: 'Активность товара не подтверждена.',
  MISSING_COST: 'Себестоимость товара не подтверждена.',
  UNSUPPORTED_CURRENCY: 'Денежные данные должны быть подтверждены в рублях.',
  MISSING_PRICE: 'Текущая цена продавца неизвестна.',
  LOW_STOCK: 'Остаток или запас в днях ниже безопасного минимума.',
  UNKNOWN_STOCK: 'Остаток или запас в днях неизвестен.',
  INSUFFICIENT_DATA: 'Для прибыли не хватает подтверждённых финансовых компонентов.',
  ECONOMICS_INCOMPLETE: 'Расчёт прибыли неполный, в том числе могут отсутствовать рекламные расходы.',
  FINANCE_PERIOD_INCOMPLETE: 'Финансовый период не завершён или его покрытие не подтверждено.',
  UNKNOWN_ORDER_BASIS: 'Не подтверждено, рассчитана экономика на заказ или на единицу товара.',
  INSUFFICIENT_ORDERS: 'Нет подтверждённого количества заказов для прибыли на заказ.',
  PERFORMANCE_NOT_CONNECTED: 'Performance API не подключён.',
  UNSUPPORTED_AD_MODEL: 'Оптимизация ставки поддерживает только модель CPC.',
  UNSUPPORTED_BID_UNIT: 'Не подтверждена единица ставки: рубли за клик.',
  ADS_INCOMPLETE: 'Рекламные данные неполные.',
  INVALID_ADVERTISING_DATA: 'Счётчики или суммы рекламной статистики противоречат друг другу.',
  ADS_PERIOD_INCOMPLETE: 'Рекламный период не завершён или неизвестен.',
  PERIOD_MISMATCH: 'Периоды рекламы и финансов не совпадают.',
  ORDER_BASIS_MISMATCH: 'Реклама и финансы используют разные или неизвестные единицы заказа.',
  SCOPE_MISMATCH: 'Реклама и финансы относятся к разной или неизвестной детализации.',
  STORE_SCOPE_MISMATCH: 'Источники относятся к разным магазинам.',
  PRODUCT_SCOPE_MISMATCH: 'Источники относятся к разным товарам.',
  ATTRIBUTION_MISMATCH: 'Атрибуция рекламной и финансовой статистики не совпадает.',
  AMBIGUOUS_SKU: 'SKU связан с несколькими товарами; требуется однозначное сопоставление.',
  UNMAPPED_SKU: 'Связь рекламного SKU с товаром не подтверждена.',
  MISSING_CURRENT_BID: 'Текущая ставка неизвестна.',
  MISSING_COMPETITIVE_BID: 'Конкурентная ставка неизвестна.',
  MISSING_MINIMUM_BID: 'Минимальная ставка неизвестна.',
  MISSING_BID_INCREMENT: 'Допустимый шаг округления ставки не подтверждён.',
  MISSING_PRICE_INCREMENT: 'Допустимый шаг округления цены не подтверждён.',
  MIN_BID_EXCEEDS_PROFIT_CAP: 'Минимальная ставка площадки выше прибыльного потолка.',
  NEGATIVE_CONTRIBUTION: 'Подтверждённая contribution-прибыль отрицательна.',
  PROFIT_FLOOR_VIOLATED: 'Прибыль на заказ ниже установленного минимума.',
  BASELINE_PROFIT_FLOOR_VIOLATED: 'Базовое окно не подтверждает минимальную прибыль на заказ.',
  INVALID_HISTORY: 'История изменений противоречива или содержит неизвестные значения.',
  INVALID_EXPERIMENT: 'Запись эксперимента неполна или содержит противоречивые значения.',
  WAITING_FOR_EXPERIMENT: 'Действующий эксперимент ещё не закрыт.',
  COOLDOWN_ACTIVE: 'После последнего изменения ещё не завершилась пауза наблюдения.',
  EXPERIMENT_VALUE_MISMATCH: 'Текущее значение уже отличается от записанного результата изменения.',
  UNSAFE_ROLLBACK: 'Прежнее значение не проходит текущие ограничения безопасности.',
  EXPERIMENT_BASIS_MISMATCH: 'Окна эксперимента используют разные единицы, валюты или детализацию.',
});

function explainBlockers(blockers) {
  const sourceNames = { PRICE: 'Цены', ADS: 'Рекламы', FINANCE: 'Финансов', STOCK: 'Остатков' };
  return blockers.slice(0, 3).map(code => {
    if (BLOCKER_MESSAGES[code]) return BLOCKER_MESSAGES[code];
    const stale = /^STALE_(PRICE|ADS|FINANCE|STOCK)$/.exec(code);
    if (stale) return `Данные ${sourceNames[stale[1]].toLowerCase()} устарели.`;
    const missingTime = /^(MISSING|INVALID)_(PRICE|ADS|FINANCE|STOCK)_TIMESTAMP$/.exec(code);
    if (missingTime) return `Время наблюдения ${sourceNames[missingTime[2]].toLowerCase()} не подтверждено.`;
    return 'Для безопасного изменения не хватает подтверждённых данных.';
  }).join(' ');
}

// Decimal integer arithmetic avoids both rounding a bid above its cap and
// losing an entire increment to a floating-point division such as 0.29/0.01.
function decimal(value) {
  const [mantissa, exponent = '0'] = value.toString().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  return { integer: BigInt(whole + fraction), exponent: Number(exponent) - fraction.length };
}

function floorIncrement(value, increment) {
  if (!nonnegative(value) || !positive(increment)) return null;
  const v = decimal(value), step = decimal(increment);
  const shift = v.exponent - step.exponent;
  const numerator = v.integer * (shift > 0 ? 10n ** BigInt(shift) : 1n);
  const denominator = step.integer * (shift < 0 ? 10n ** BigInt(-shift) : 1n);
  let units = numerator / denominator;
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  let result = Number(`${units * step.integer}e${step.exponent}`);
  if (result > value && units > 0n) {
    units -= 1n;
    result = Number(`${units * step.integer}e${step.exponent}`);
  }
  return nonnegative(result) && result <= value ? result : null;
}

function calculateRecommendedBid(input = {}) {
  const { currentBid, competitiveBid, minimumBid, maxProfitableBid, competitiveBuffer, bidStepPct, bidIncrement } = object(input);
  if (![currentBid, competitiveBid, minimumBid, competitiveBuffer, bidIncrement].every(positive)
    || !nonnegative(maxProfitableBid) || !nonnegative(bidStepPct) || bidStepPct > 0.10
    || minimumBid > maxProfitableBid) return null;
  const competitiveLimit = competitiveBid * competitiveBuffer;
  const stepLimit = currentBid * (1 + bidStepPct);
  if (!positive(competitiveLimit) || !positive(stepLimit)) return null;
  const bid = floorIncrement(Math.min(maxProfitableBid, competitiveLimit, stepLimit), bidIncrement);
  return bid !== null && bid >= minimumBid ? bid : null;
}

function calculateRecommendedPrice(input = {}) {
  const { sellerPrice, priceStepPct, allowed, priceIncrement } = object(input);
  if (allowed !== true || !positive(sellerPrice) || !nonnegative(priceStepPct)
    || priceStepPct > 0.05 || !positive(priceIncrement)) return null;
  const price = floorIncrement(sellerPrice * (1 + priceStepPct), priceIncrement);
  return price !== null && price > sellerPrice ? price : null;
}

function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const result = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(result) && new Date(result).toISOString().slice(0, 10) === value ? result : null;
}

function timestamp(value) {
  if (nonnegative(value)) return value;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || dateOnly(value.slice(0, 10)) === null) return null;
  const result = Date.parse(value);
  return nonnegative(result) ? result : null;
}

function period(source, now) {
  const from = dateOnly(source.periodFrom), to = dateOnly(source.periodTo);
  if (from === null || to === null || from > to) return null;
  // The API contract uses inclusive Europe/Moscow calendar dates (UTC+03).
  if (now === null || to + DAY - 3 * HOUR > now) return null;
  return { from, to, days: (to - from) / DAY + 1 };
}

function settingsProblems(input, settings) {
  const blockers = [];
  if (input.settings !== undefined && (input.settings === null || typeof input.settings !== 'object' || Array.isArray(input.settings))) blockers.push('INVALID_SETTINGS');
  if (settings.mode === 'AUTO') blockers.push('AUTO_DISABLED');
  else if (!['OBSERVE', 'RECOMMEND'].includes(settings.mode)) blockers.push('INVALID_SETTINGS');
  if (typeof settings.killSwitch !== 'boolean') blockers.push('INVALID_SETTINGS');
  if (settings.killSwitch === true) blockers.push('KILL_SWITCH');
  if (!nonnegative(settings.targetProfitPerOrder)
    || !nonnegative(settings.priceStepPct) || settings.priceStepPct > 0.05
    || !nonnegative(settings.bidStepPct) || settings.bidStepPct > 0.10
    || !positive(settings.competitiveBuffer)
    || !nonnegative(settings.safetyFactor) || settings.safetyFactor > 1
    || !count(settings.minStock) || !nonnegative(settings.minStockDays)
    || !positive(settings.maxPriceAgeHours) || !positive(settings.maxAdsAgeHours)
    || !count(settings.minImpressions) || settings.minImpressions < 1
    || !count(settings.minClicks) || settings.minClicks < 1
    || !count(settings.minOrders) || settings.minOrders < 1
    || !count(settings.observationDays) || settings.observationDays < 1
    || !nonnegative(settings.cooldownHours)) blockers.push('INVALID_SETTINGS');
  return unique(blockers);
}

function freshness(observedAt, now, maxHours, name) {
  const observed = timestamp(observedAt);
  if (observed === null) return [`MISSING_${name}_TIMESTAMP`];
  if (now === null || observed > now) return [`INVALID_${name}_TIMESTAMP`];
  return now - observed > maxHours * HOUR ? [`STALE_${name}`] : [];
}

function validCounts(ads) {
  return ['impressions', 'clicks', 'orders'].every(field => count(ads[field]))
    && ads.clicks <= ads.impressions && ads.orders <= ads.clicks;
}

function advertisingProblems(input, settings, bidFields = false) {
  const ads = object(input.ads), finance = object(input.finance);
  const now = timestamp(input.now), blockers = [];
  if (ads.connected !== true) blockers.push('PERFORMANCE_NOT_CONNECTED');
  if (ads.model !== 'CPC') blockers.push('UNSUPPORTED_AD_MODEL');
  if (ads.unit !== 'RUB_PER_CLICK' || (ads.currency !== undefined && ads.currency !== 'RUB')) blockers.push('UNSUPPORTED_BID_UNIT');
  if (ads.complete !== true) blockers.push('ADS_INCOMPLETE');
  blockers.push(...freshness(ads.observedAt, now, settings.maxAdsAgeHours, 'ADS'));
  if (!validCounts(ads) || !nonnegative(ads.spend) || !nonnegative(ads.revenue)
    || (ads.clicks === 0 && (ads.orders > 0 || ads.spend > 0))
    || (ads.orders === 0 && ads.revenue > 0)) blockers.push('INVALID_ADVERTISING_DATA');
  if (ads.observedCVR !== undefined && (!nonnegative(ads.observedCVR) || ads.observedCVR > 1
    || ads.clicks === 0 || Math.abs(ads.observedCVR - ads.orders / ads.clicks) > 1e-12)) blockers.push('INVALID_ADVERTISING_DATA');
  const adsPeriod = period(ads, now), financePeriod = period(finance, now);
  if (!adsPeriod) blockers.push('ADS_PERIOD_INCOMPLETE');
  if (adsPeriod && financePeriod && (adsPeriod.from !== financePeriod.from || adsPeriod.to !== financePeriod.to)) blockers.push('PERIOD_MISMATCH');
  if (!['order', 'unit'].includes(ads.orderBasis) || ads.orderBasis !== finance.orderBasis) blockers.push('ORDER_BASIS_MISMATCH');
  if (!['sku', 'campaign_sku'].includes(ads.scope) || ads.scope !== finance.scope) blockers.push('SCOPE_MISMATCH');
  if (typeof ads.attributionModel !== 'string' || !ads.attributionModel.trim()
    || ads.attributionModel !== finance.attributionModel) blockers.push('ATTRIBUTION_MISMATCH');
  for (const source of [ads, finance]) {
    if (source.storeId !== undefined && source.storeId !== object(input.product).storeId) blockers.push('STORE_SCOPE_MISMATCH');
    if (source.productId !== undefined && source.productId !== object(input.product).id) blockers.push('PRODUCT_SCOPE_MISMATCH');
  }
  if (bidFields) {
    const linkStatus = input.skuLinkStatus ?? ads.skuLinkStatus;
    if (linkStatus !== 'matched') blockers.push(linkStatus === 'ambiguous' ? 'AMBIGUOUS_SKU' : 'UNMAPPED_SKU');
    if (!positive(ads.currentBid)) blockers.push('MISSING_CURRENT_BID');
    if (!positive(ads.competitiveBid)) blockers.push('MISSING_COMPETITIVE_BID');
    if (!positive(ads.minimumBid)) blockers.push('MISSING_MINIMUM_BID');
    if (!positive(ads.bidIncrement)) blockers.push('MISSING_BID_INCREMENT');
  }
  return unique(blockers);
}

function financeProblems(input, settings, economics) {
  const finance = object(input.finance), now = timestamp(input.now), blockers = [];
  if (finance.currency !== undefined && finance.currency !== 'RUB') blockers.push('UNSUPPORTED_CURRENCY');
  if (economics.economicsStatus !== 'complete') blockers.push(economics.economicsStatus === 'insufficient' ? 'INSUFFICIENT_DATA' : 'ECONOMICS_INCOMPLETE');
  if (!period(finance, now) || finance.complete !== true) blockers.push('FINANCE_PERIOD_INCOMPLETE');
  if (!['order', 'unit'].includes(finance.orderBasis)) blockers.push('UNKNOWN_ORDER_BASIS');
  if (!count(finance.orders) || finance.orders === 0) blockers.push('INSUFFICIENT_ORDERS');
  blockers.push(...freshness(finance.observedAt, now, settings.maxPriceAgeHours, 'FINANCE'));
  return blockers;
}

function profitCap(input, settings, economics) {
  if (settingsProblems(input, settings).some(code => code === 'INVALID_SETTINGS')
    || financeProblems(input, settings, economics).length
    || advertisingProblems(input, settings).length || input.ads.clicks === 0) return null;
  return calculateMaxCpc({
    maxAdSpendPerOrder: calculateMaxAdSpendPerOrder({
      contributionBeforeAdsPerOrder: economics.contributionBeforeAdsPerOrder,
      targetProfitPerOrder: settings.targetProfitPerOrder,
    }),
    observedCVR: input.ads.orders / input.ads.clicks,
    safetyFactor: settings.safetyFactor,
  });
}

function experimentProblems(experiment) {
  if (!experiment || !Object.keys(object(experiment)).length) return ['INVALID_EXPERIMENT'];
  if (!['PRICE', 'BID'].includes(experiment.dimension) || !positive(experiment.beforeValue)
    || !positive(experiment.afterValue) || !['recorded', 'observing', 'completed', 'cancelled'].includes(experiment.status)) return ['INVALID_EXPERIMENT'];
  const started = timestamp(experiment.startedAt), until = timestamp(experiment.observeUntil);
  return started === null || until === null || until <= started ? ['INVALID_EXPERIMENT'] : [];
}

function qualityGate(rawInput = {}, { action = 'BID' } = {}) {
  const input = object(rawInput), settings = settingsFor(input), now = timestamp(input.now);
  const product = object(input.product), price = object(input.price), cost = object(input.cost);
  const stock = object(input.stock), history = object(input.history);
  const economics = calculateContributionEconomics(input.finance);
  const blockers = settingsProblems(input, settings);
  if (now === null) blockers.push('INVALID_NOW');
  if (!['PRICE', 'BID', 'NONE'].includes(action)) blockers.push('INVALID_ACTION');
  if (product.active !== true) blockers.push(product.active === false ? 'INACTIVE_PRODUCT' : 'UNKNOWN_PRODUCT_STATUS');
  if (!nonnegative(cost.unitCost) || ['missing', 'partial', 'invalid'].includes(cost.status)) blockers.push('MISSING_COST');
  if (cost.currency !== 'RUB' || price.currency !== 'RUB') blockers.push('UNSUPPORTED_CURRENCY');
  if (!positive(price.sellerPrice)) blockers.push('MISSING_PRICE');
  blockers.push(...freshness(price.observedAt, now, settings.maxPriceAgeHours, 'PRICE'));
  if (!count(stock.quantity) || !nonnegative(stock.days)) blockers.push('UNKNOWN_STOCK');
  else if (stock.quantity <= 0 || stock.quantity < settings.minStock || stock.days < settings.minStockDays) blockers.push('LOW_STOCK');
  blockers.push(...freshness(stock.observedAt, now, settings.maxPriceAgeHours, 'STOCK'));
  blockers.push(...financeProblems(input, settings, economics), ...advertisingProblems(input, settings, action === 'BID'));
  if ((economics.contributionBeforeAds !== null && economics.contributionBeforeAds < 0)
    || (economics.contributionAfterAds !== null && economics.contributionAfterAds < 0)) blockers.push('NEGATIVE_CONTRIBUTION');
  if (economics.contributionPerOrder !== null && economics.contributionPerOrder < settings.targetProfitPerOrder) blockers.push('PROFIT_FLOOR_VIOLATED');
  if (action === 'PRICE' && !positive(price.priceIncrement)) blockers.push('MISSING_PRICE_INCREMENT');
  if (history.state !== undefined && !STATES.has(history.state)) blockers.push('INVALID_HISTORY');
  if (['WAIT_PRICE', 'WAIT_ADS'].includes(history.state)
    && (!ACTIVE_STATUSES.has(object(history.activeExperiment).status)
      || history.activeExperiment.dimension !== (history.state === 'WAIT_PRICE' ? 'PRICE' : 'BID'))) blockers.push('INVALID_HISTORY');
  if (history.activeExperiment !== undefined && history.activeExperiment !== null) {
    blockers.push(...experimentProblems(history.activeExperiment));
    if (ACTIVE_STATUSES.has(history.activeExperiment.status)) blockers.push('WAITING_FOR_EXPERIMENT');
  }
  if (history.lastActionAt !== undefined && history.lastActionAt !== null) {
    const lastAction = timestamp(history.lastActionAt);
    if (lastAction === null || now === null || lastAction > now) blockers.push('INVALID_HISTORY');
    else if (now - lastAction < settings.cooldownHours * HOUR) blockers.push('COOLDOWN_ACTIVE');
  }
  if (action === 'BID') {
    const cap = profitCap(input, settings, economics);
    if (cap !== null && positive(input.ads.minimumBid) && input.ads.minimumBid > cap) blockers.push('MIN_BID_EXCEEDS_PROFIT_CAP');
  }
  return unique(blockers);
}

function stableDaily(ads, expectedDays) {
  if (!Array.isArray(ads.daily) || ads.daily.length !== expectedDays || expectedDays < 2) return false;
  const dates = new Set(), totals = { impressions: 0, clicks: 0, orders: 0 };
  for (const raw of ads.daily) {
    const row = object(raw), date = dateOnly(row.date);
    if (date === null || row.date < ads.periodFrom || row.date > ads.periodTo || dates.has(row.date)
      || row.complete !== true || !validCounts(row)) return false;
    dates.add(row.date);
    for (const field of Object.keys(totals)) totals[field] += row[field];
  }
  if (Object.keys(totals).some(field => totals[field] !== ads[field])) return false;
  const meanCvr = ads.orders / ads.clicks;
  return ads.daily.every(row => row.clicks > 0 && row.orders > 0
    && row.impressions <= ads.impressions * 2 / expectedDays
    && row.clicks <= ads.clicks * 2 / expectedDays
    && row.orders <= ads.orders * 2 / expectedDays
    && Math.abs(row.orders / row.clicks - meanCvr) <= meanCvr * 0.5);
}

function confidence(rawInput = {}) {
  const input = object(rawInput), settings = settingsFor(input), ads = object(input.ads);
  const economics = calculateContributionEconomics(input.finance);
  if (settingsProblems(input, settings).includes('INVALID_SETTINGS')
    || financeProblems(input, settings, economics).length
    || advertisingProblems(input, settings).length) return 'LOW';
  const window = period(ads, timestamp(input.now));
  if (ads.impressions < settings.minImpressions || ads.clicks < settings.minClicks
    || ads.orders < settings.minOrders || input.finance.orders < settings.minOrders
    || window.days < settings.observationDays) return 'LOW';
  if (ads.daily !== undefined) return stableDaily(ads, window.days) ? 'HIGH' : 'LOW';
  // Period totals alone cannot establish day-to-day stability.
  return 'MEDIUM';
}

function comparableWindow(value, settings) {
  const window = object(value);
  return window.complete === true && money(window.contributionAfterAds)
    && count(window.orders) && window.orders >= settings.minOrders
    && count(window.periodDays) && window.periodDays >= settings.observationDays
    && window.comparable !== false;
}

function sameWindowBasis(baseline, current) {
  return ['orderBasis', 'scope', 'currency', 'attributionModel'].every(field => {
    if (baseline[field] === undefined && current[field] === undefined) return true;
    return typeof baseline[field] === 'string' && baseline[field].length > 0
      && baseline[field] === current[field] && (field !== 'currency' || baseline[field] === 'RUB');
  });
}

function optimizerDecision(rawInput = {}) {
  const input = object(rawInput), settings = settingsFor(input), history = object(input.history);
  const ads = object(input.ads), price = object(input.price), economics = calculateContributionEconomics(input.finance);
  const cap = profitCap(input, settings, economics), level = confidence(input);
  function result(state, codes, humanReason, { action = 'NONE', value = null, blockers = [] } = {}) {
    return {
      state, action, recommendedPrice: action === 'PRICE' ? value : null,
      recommendedBid: action === 'BID' ? value : null, maxProfitableBid: cap,
      confidence: level, reasonCodes: unique(codes), humanReason, blockers: unique(blockers),
    };
  }
  function blocked(blockers, explanation = '') {
    return result('BLOCKED', blockers, [explanation, explainBlockers(blockers)].filter(Boolean).join(' '), { blockers });
  }
  const baseBlockers = qualityGate(input, { action: 'NONE' });
  const experiment = object(history.activeExperiment);
  const active = ACTIVE_STATUSES.has(experiment.status);
  const safetyBlockers = baseBlockers.filter(code => ![
    'WAITING_FOR_EXPERIMENT', 'COOLDOWN_ACTIVE', 'NEGATIVE_CONTRIBUTION', 'PROFIT_FLOOR_VIOLATED',
  ].includes(code));
  if (safetyBlockers.length) return blocked(safetyBlockers);

  if (active) {
    const waitState = experiment.dimension === 'PRICE' ? 'WAIT_PRICE' : 'WAIT_ADS';
    const now = timestamp(input.now), started = timestamp(experiment.startedAt);
    if (started > now) return blocked(['INVALID_EXPERIMENT']);
    const currentValue = experiment.dimension === 'PRICE' ? price.sellerPrice : ads.currentBid;
    if (currentValue !== experiment.afterValue) return blocked(['EXPERIMENT_VALUE_MISMATCH']);
    if (now < timestamp(experiment.observeUntil) || now - started < settings.observationDays * DAY) {
      return result(waitState, ['WAITING_FOR_EXPERIMENT'], 'Эксперимент ещё наблюдается; цену и ставку одновременно не меняем.', { blockers: ['WAITING_FOR_EXPERIMENT'] });
    }
    if (!comparableWindow(history.baseline, settings) || !comparableWindow(history.current, settings)) {
      return result(waitState, ['WAITING_FOR_EXPERIMENT', 'EXPERIMENT_RESULTS_INCOMPLETE'], 'Для оценки эксперимента нужны полные сопоставимые окна прибыли.', { blockers: ['EXPERIMENT_RESULTS_INCOMPLETE'] });
    }
    const baseline = history.baseline, current = history.current;
    if (!sameWindowBasis(baseline, current)) return blocked(['EXPERIMENT_BASIS_MISMATCH']);
    const worse = current.contributionAfterAds / current.periodDays < baseline.contributionAfterAds / baseline.periodDays;
    const belowFloor = current.contributionAfterAds / current.orders < settings.targetProfitPerOrder;
    if (worse || belowFloor) {
      const codes = [worse ? 'ABSOLUTE_CONTRIBUTION_DECREASED' : 'PROFIT_FLOOR_VIOLATED'];
      if (belowFloor) codes.push('PROFIT_FLOOR_VIOLATED');
      const rollbackBlockers = qualityGate(input, { action: experiment.dimension }).filter(code => ![
        'WAITING_FOR_EXPERIMENT', 'COOLDOWN_ACTIVE', 'NEGATIVE_CONTRIBUTION', 'PROFIT_FLOOR_VIOLATED',
      ].includes(code));
      const increment = experiment.dimension === 'PRICE' ? price.priceIncrement : ads.bidIncrement;
      if (experiment.beforeValue >= experiment.afterValue || floorIncrement(experiment.beforeValue, increment) !== experiment.beforeValue
        || baseline.contributionAfterAds / baseline.orders < settings.targetProfitPerOrder) rollbackBlockers.push('UNSAFE_ROLLBACK');
      if (experiment.dimension === 'BID' && (cap === null || experiment.beforeValue > cap || experiment.beforeValue < ads.minimumBid)) rollbackBlockers.push('UNSAFE_ROLLBACK');
      if (rollbackBlockers.length) return blocked(rollbackBlockers, 'Эксперимент ухудшил прибыль, но безопасный возврат значения пока не подтверждён.');
      if (settings.mode === 'OBSERVE') return result('HOLD', [...codes, 'OBSERVE_MODE'], 'Эксперимент ухудшил абсолютную прибыль; режим наблюдения не выдаёт действий.');
      return result('ROLLBACK', codes, 'После полного окна абсолютная прибыль снизилась или нарушен минимум прибыли на заказ. Рекомендуется вернуть только изменённый параметр.', { action: experiment.dimension, value: experiment.beforeValue });
    }
    if (baseBlockers.includes('PROFIT_FLOOR_VIOLATED') || baseBlockers.includes('NEGATIVE_CONTRIBUTION')) {
      return result('HOLD', ['PROFIT_FLOOR_VIOLATED', 'EXPERIMENT_REVIEW_REQUIRED'], 'Окно эксперимента не ухудшилось, но текущая экономика уже не подтверждает минимум прибыли. Требуется проверка перед следующим изменением.', { blockers: ['PROFIT_FLOOR_VIOLATED'] });
    }
    return result('HOLD', ['EXPERIMENT_PASSED', 'EXPERIMENT_REVIEW_REQUIRED'], 'Абсолютная прибыль на день не ухудшилась, минимум прибыли соблюдён. Завершите запись эксперимента перед следующим изменением.', { blockers: ['WAITING_FOR_EXPERIMENT'] });
  }

  const remainingBlockers = baseBlockers.filter(code => code !== 'WAITING_FOR_EXPERIMENT');
  if (remainingBlockers.length) return blocked(remainingBlockers);
  if (!comparableWindow(history.baseline, settings)) return result('BASELINE', ['BASELINE_REQUIRED'], 'Накапливаем полную сопоставимую базу абсолютной прибыли до первого эксперимента.');
  if (history.baseline.contributionAfterAds / history.baseline.orders < settings.targetProfitPerOrder) return blocked(['BASELINE_PROFIT_FLOOR_VIOLATED']);
  if (level === 'LOW') return result('HOLD', ['LOW_CONFIDENCE'], 'Недостаточная выборка или нестабильные наблюдения; повышение цены и ставки отложено.');
  if (settings.mode === 'OBSERVE') return result('HOLD', ['OBSERVE_MODE'], 'Режим наблюдения: экономика рассчитана, рекомендации изменения цены и ставки выключены.');
  if (economics.contributionPerOrder <= settings.targetProfitPerOrder || cap === 0) return result('HOLD', ['NO_PROFIT_BUFFER'], 'Минимум прибыли соблюдён без запаса для увеличения рекламного риска.');
  if (cap !== null && positive(ads.currentBid) && ads.currentBid > cap) return result('HOLD', ['CURRENT_BID_ABOVE_PROFIT_CAP', 'MAX_PROFITABLE_LIMIT'], 'Текущая ставка выше расчётного прибыльного потолка; конкурентная ставка не оправдывает дальнейшее повышение.');

  const priceBlockers = qualityGate(input, { action: 'PRICE' });
  if (history.priceTestPassed !== true && !priceBlockers.length && settings.priceStepPct > 0) {
    const recommended = calculateRecommendedPrice({ ...price, priceStepPct: settings.priceStepPct, allowed: true });
    if (recommended !== null) return result('PRICE_UP', ['PROFIT_BUFFER_AVAILABLE', 'CONTROLLED_PRICE_TEST'], 'Данных достаточно для ограниченного теста цены. Рост абсолютной прибыли предстоит проверить по результатам наблюдения.', { action: 'PRICE', value: recommended });
  }
  const bidBlockers = qualityGate(input, { action: 'BID' });
  if (bidBlockers.length) return blocked(bidBlockers);
  const recommended = calculateRecommendedBid({ ...ads, maxProfitableBid: cap,
    competitiveBuffer: settings.competitiveBuffer, bidStepPct: settings.bidStepPct });
  if (recommended !== null && recommended > ads.currentBid) {
    const codes = ['PROFIT_BUFFER_AVAILABLE', 'BID_BELOW_COMPETITIVE'];
    if (ads.competitiveBid * settings.competitiveBuffer >= cap) codes.push('MAX_PROFITABLE_LIMIT');
    return result('BID_UP', codes, 'Есть запас прибыли для контролируемого расширения охвата. Ставка ограничена прибыльным потолком и допустимым шагом; рост прибыли нужно подтвердить экспериментом.', { action: 'BID', value: recommended });
  }
  return result('HOLD', [cap !== null && ads.currentBid >= cap ? 'MAX_PROFITABLE_LIMIT' : 'NO_PROFITABLE_IMPROVEMENT'], 'Безопасное повышение в пределах прибыльного потолка, конкурентного ориентира и шага ставки не найдено.');
}

module.exports = {
  calculateRecommendedBid, calculateRecommendedPrice, qualityGate,
  confidence, optimizerDecision, DEFAULT_SETTINGS,
};
