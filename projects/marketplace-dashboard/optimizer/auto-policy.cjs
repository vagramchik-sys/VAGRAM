'use strict';

// Owner limits. These are hard ceilings for a future actuator, not a switch
// that enables external writes. Unknown evidence always produces HOLD.
const PRICE_DESIRED_STEP = 0.02;
const PRICE_FALLBACK_CEILING = 0.05;
const BID_STEP_CEILING = 0.05;
const BID_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const ADS_SHARE_CEILING = 0.15;
const DAY = 24 * 60 * 60 * 1000;
const REASONS = Object.freeze({
  AUTO_NOT_ENABLED: 'Автоматические изменения ещё не включены.',
  KILL_SWITCH_OR_UNKNOWN: 'Аварийная блокировка включена или её статус неизвестен.',
  DECISION_NOT_ACTIONABLE: 'Нет подтверждённого действия оптимизатора.',
  CONFIDENCE_NOT_HIGH: 'Недостаточно данных для высокой уверенности.',
  SELLER_PRICE_UNVERIFIED: 'Цена продавца не подтверждена.',
  OZON_MINIMUM_STEP_UNKNOWN: 'Минимальный шаг цены Ozon не подтверждён.',
  PRICE_FALLBACK_PRICE_UNVERIFIED: 'Цена после минимального шага Ozon не подтверждена.',
  PRICE_STEP_OUT_OF_BOUNDS: 'Предложенный шаг цены выходит за разрешённые пределы.',
  UNNECESSARY_PRICE_FALLBACK: 'Повышение выше 2% не требуется по подтверждённому шагу.',
  PRICE_INDEX_UNVERIFIED: 'Индекс цены не подтверждён и не проверен на свежесть.',
  CUSTOMER_PRICE_CORRIDOR_UNVERIFIED: 'Цена покупателя и безопасный коридор не подтверждены.',
  CONVERSION_RISK_UNVERIFIED: 'Риск изменения конверсии не оценён на полной выборке.',
  STOCK_UNSAFE_OR_UNKNOWN: 'Запас товара неизвестен или слишком мал.',
  PRICE_EXPERIMENT_OR_COOLDOWN: 'Тест цены ещё идёт или действует пауза между изменениями.',
  PROFIT_FLOOR_UNVERIFIED: 'Прибыль после рекламы ниже минимума или данные неполные.',
  BID_UNIT_OR_VALUE_UNVERIFIED: 'Единицы или текущая ставка Ozon не подтверждены.',
  PROFITABLE_BID_CAP_UNVERIFIED: 'Предложенная ставка выше подтверждённого прибыльного потолка.',
  NO_PROFIT_EVIDENCE: 'Повышение нельзя обосновать только конкурентной ставкой.',
  BID_STEP_OUT_OF_BOUNDS: 'Шаг ставки превышает 5%.',
  PREVIOUS_BID_STEP_UNEVALUATED_OR_COOLDOWN: 'Предыдущий шаг не оценён или не прошло 12 часов.',
  SKU_30D_AD_SHARE_UNVERIFIED: 'Нет полного 30-дневного расчёта расходов к выручке SKU в пределах 15%.',
  SPEND_LIMIT_NOT_ENFORCED: 'Автоматический предел рекламных расходов ещё не обеспечен.'
});
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value ? Date.parse(`${value}T00:00:00Z`) : null;
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const hold = reasons => { const reasonCodes = Object.freeze([...new Set(reasons)]); return Object.freeze({state: 'HOLD', allowed: false, reasonCodes, humanReason: reasonCodes.map(code => REASONS[code] || code).join(' ')}); };
const ready = (dimension, value) => Object.freeze({state: 'READY', allowed: true, dimension, value, reasonCodes: Object.freeze([])});
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
function common(input, dimension) {
  const decision = object(input.decision), reasons = [];
  if (input.autoEnabled !== true) reasons.push('AUTO_NOT_ENABLED');
  if (input.killSwitch !== false) reasons.push('KILL_SWITCH_OR_UNKNOWN');
  if (decision.action !== dimension || !['PRICE_UP', 'BID_UP'].includes(decision.state) || decision.state !== `${dimension}_UP` || !Array.isArray(decision.blockers) || decision.blockers.length || !Array.isArray(decision.reasonCodes)) reasons.push('DECISION_NOT_ACTIONABLE');
  if (decision.confidence !== 'HIGH') reasons.push('CONFIDENCE_NOT_HIGH');
  return reasons;
}
function evaluateAutoPrice(raw = {}) {
  const input = object(raw), decision = object(input.decision), price = object(input.price), stock = object(input.stock), evidence = object(input.evidence), finance = object(input.finance), history = object(input.history), reasons = common(input, 'PRICE');
  const current = number(price.sellerPrice), recommended = number(decision.recommendedPrice), minimum = number(evidence.minimumAcceptedStepPct);
  const recommendedStep = current > 0 && recommended > current ? recommended / current - 1 : null;
  const needsFallback = minimum !== null && minimum > PRICE_DESIRED_STEP + 1e-9 && recommendedStep !== null && recommendedStep + 1e-9 < minimum;
  // The Ozon-confirmed next allowed price must be a concrete currency value.
  // Never silently round a 5% fallback beyond the owner's 5% ceiling.
  const target = needsFallback ? number(evidence.minimumAcceptedPrice) : recommended;
  if (!(current > 0) || !(target > current) || price.currency !== 'RUB') reasons.push('SELLER_PRICE_UNVERIFIED');
  const observed = instant(evidence.minimumStepObservedAt), at = instant(input.now);
  if (evidence.minimumStepVerified !== true || evidence.minimumStepSource !== 'ozon_api'
    || minimum === null || minimum <= 0 || minimum > PRICE_FALLBACK_CEILING
    || observed === null || at === null || observed > at || at - observed > DAY) reasons.push('OZON_MINIMUM_STEP_UNKNOWN');
  if (needsFallback && !(target > current)) reasons.push('PRICE_FALLBACK_PRICE_UNVERIFIED');
  const step = current > 0 && target > current ? target / current - 1 : null;
  if (step === null || step > PRICE_FALLBACK_CEILING + 1e-9 || minimum !== null && step + 1e-9 < minimum
    || target === null || Math.round(target * 100) / 100 !== target) reasons.push('PRICE_STEP_OUT_OF_BOUNDS');
  if (step !== null && step > PRICE_DESIRED_STEP + 1e-9 && (minimum === null || minimum <= PRICE_DESIRED_STEP + 1e-9)) reasons.push('UNNECESSARY_PRICE_FALLBACK');
  if (evidence.priceIndex?.verified !== true || evidence.priceIndex?.withinCorridor !== true || evidence.priceIndex?.fresh !== true || evidence.priceIndex?.evaluatedSellerPrice !== target) reasons.push('PRICE_INDEX_UNVERIFIED');
  if (evidence.customerPriceCorridor?.verified !== true || evidence.customerPriceCorridor?.withinCorridor !== true || evidence.customerPriceCorridor?.fresh !== true || evidence.customerPriceCorridor?.evaluatedSellerPrice !== target) reasons.push('CUSTOMER_PRICE_CORRIDOR_UNVERIFIED');
  if (evidence.conversionRisk?.verified !== true || evidence.conversionRisk?.acceptable !== true || evidence.conversionRisk?.sampleComplete !== true || evidence.conversionRisk?.evaluatedSellerPrice !== target) reasons.push('CONVERSION_RISK_UNVERIFIED');
  if (!(number(stock.quantity) >= 5) || !(number(stock.days) >= 7)) reasons.push('STOCK_UNSAFE_OR_UNKNOWN');
  const lastPriceAction = instant(history.lastPriceActionAt);
  if (history.activeExperiment !== null || history.lastPriceActionAt !== null && (lastPriceAction === null || at === null || at - lastPriceAction < 72 * 60 * 60 * 1000)) reasons.push('PRICE_EXPERIMENT_OR_COOLDOWN');
  const profit = number(finance.contributionAfterAds), orders = number(finance.orders), floor = number(input.profitFloorPerOrder);
  if (finance.complete !== true || !(orders > 0) || profit === null || floor === null || floor < 0 || profit / orders < floor) reasons.push('PROFIT_FLOOR_UNVERIFIED');
  return reasons.length ? hold(reasons) : ready('PRICE', target);
}
function completedThirtyDays(finance, now) {
  const from = date(finance.periodFrom), to = date(finance.periodTo), at = instant(now);
  if (from === null || to === null || at === null || to - from !== 29 * DAY) return false;
  // Data through the current Moscow day is not a completed 30-day window.
  const todayMoscow = new Date(at + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const yesterdayMoscow = new Date(date(todayMoscow) - DAY).toISOString().slice(0, 10);
  return finance.complete === true && finance.periodTo === yesterdayMoscow;
}
function previousStepReady(history, now) {
  const last = instant(history.lastBidActionAt), at = instant(now);
  // A validated baseline is not evidence that a previous bid increase worked.
  // The first automatic increase stays on HOLD until a separately assessed
  // pilot step has a complete observation window and enough orders/clicks.
  if (last === null) return false;
  if (at === null || last > at || at - last < BID_COOLDOWN_MS) return false;
  const previous = object(history.previousBidStep);
  const observedFrom = instant(previous.observedFrom), observedTo = instant(previous.observedTo);
  return previous.actionAt === history.lastBidActionAt
    && previous.evaluated === true && previous.complete === true
    && previous.baselineComparable === true && previous.profitDidNotDecline === true
    && observedFrom !== null && observedTo !== null
    && observedFrom >= last && observedTo <= at
    && observedTo - observedFrom >= BID_COOLDOWN_MS
    && Number.isSafeInteger(previous.clicks) && previous.clicks >= 100
    && Number.isSafeInteger(previous.orders) && previous.orders >= 10;
}
function evaluateAutoBid(raw = {}) {
  const input = object(raw), decision = object(input.decision), ads = object(input.ads), finance = object(input.finance), history = object(input.history), guard = object(input.spendGuard), reasons = common(input, 'BID');
  const current = number(ads.currentBid), target = number(decision.recommendedBid), cap = number(decision.maxProfitableBid);
  if (ads.model !== 'CPC' || ads.unit !== 'RUB_PER_CLICK' || !(current > 0) || !(target > current)) reasons.push('BID_UNIT_OR_VALUE_UNVERIFIED');
  if (!(cap > 0) || !(target > 0) || target > cap) reasons.push('PROFITABLE_BID_CAP_UNVERIFIED');
  if (!Array.isArray(decision.reasonCodes) || !decision.reasonCodes.includes('PROFIT_BUFFER_AVAILABLE')) reasons.push('NO_PROFIT_EVIDENCE');
  if (!(current > 0) || !(target > current) || target / current - 1 > BID_STEP_CEILING + 1e-9) reasons.push('BID_STEP_OUT_OF_BOUNDS');
  if (!previousStepReady(history, input.now)) reasons.push('PREVIOUS_BID_STEP_UNEVALUATED_OR_COOLDOWN');
  const revenue = number(finance.realizedRevenue), spending = number(finance.advertising), floor = number(input.profitFloorPerOrder), profit = number(finance.contributionAfterAds), orders = number(finance.orders);
  if (!completedThirtyDays(finance, input.now) || !(revenue > 0) || spending === null || spending < 0 || spending / revenue > ADS_SHARE_CEILING + 1e-9) reasons.push('SKU_30D_AD_SHARE_UNVERIFIED');
  if (!(orders > 0) || profit === null || floor === null || floor < 0 || profit / orders < floor) reasons.push('PROFIT_FLOOR_UNVERIFIED');
  // A snapshot ratio cannot cap future spend as traffic changes. The external
  // spend limiter must be separately proven active before any automatic bid.
  if (guard.enforced !== true || guard.scope !== 'sku' || guard.windowDays !== 30 || number(guard.maxShare) !== ADS_SHARE_CEILING) reasons.push('SPEND_LIMIT_NOT_ENFORCED');
  return reasons.length ? hold(reasons) : ready('BID', target);
}
module.exports = {evaluateAutoPrice, evaluateAutoBid, PRICE_DESIRED_STEP, PRICE_FALLBACK_CEILING, BID_STEP_CEILING, BID_COOLDOWN_MS, ADS_SHARE_CEILING};
