'use strict';

// Read-only explanations and conditional arithmetic. This module neither changes
// optimizer decisions nor grants permission to change marketplace values.
const DAY = 86400000;
const finite = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
const positive = value => finite(value) && value > 0;
const nonnegative = value => finite(value) && value >= 0;
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const instant = value => value instanceof Date ? value.valueOf() : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ? Date.parse(value) : typeof value === 'number' && finite(value) ? value : NaN;
function day(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return NaN;
  const parsed = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? parsed : NaN;
}
function fresh(value, now) {
  const observed = instant(value);
  return Number.isFinite(now) && Number.isFinite(observed) && observed <= now && now - observed <= DAY;
}
function verifiedCost(raw, now) {
  const cost = object(raw);
  return cost.currency === 'RUB' && nonnegative(cost.unitCost) && fresh(cost.observedAt, now)
    && (cost.status === 'filled' && cost.unitCost > 0 || cost.status === 'zero' && cost.unitCost === 0);
}
const metric = (label, value, unit) => ({label, value, unit});
const unavailable = (id, label, summary) => ({id, label, status: 'unavailable', summary, metrics: [], assumptions: []});
const close = (a, b) => finite(a) && finite(b) && Math.abs(a - b) <= Math.max(0.01, Math.abs(a) * 1e-9);

function marketObservation(raw, now) {
  const value = object(raw), competitors = value.competitors;
  const validPosition = position => position === null || position === undefined || Number.isSafeInteger(position) && position > 0;
  const valid = value.source === 'manual' && value.comparable === true && fresh(value.observedAt, now)
    && typeof value.region === 'string' && value.region.trim()
    && typeof value.query === 'string' && value.query.trim()
    && positive(value.ownBuyerPrice) && positive(value.ownUnitCount) && validPosition(value.ownPosition)
    && Array.isArray(competitors) && competitors.length > 0
    && competitors.every(row => row && positive(row.buyerPrice) && positive(row.unitCount) && validPosition(row.position));
  if (!valid) return {available: false, source: value.source || null, observedAt: value.observedAt || null};
  const ownPricePerUnit = value.ownBuyerPrice / value.ownUnitCount;
  const prices = competitors.map(row => row.buyerPrice / row.unitCount);
  if (![ownPricePerUnit, ...prices].every(positive)) return {available: false, source: value.source, observedAt: value.observedAt};
  return {available: true, source: 'manual', observedAt: value.observedAt, region: value.region, query: value.query,
    ownPricePerUnit, competitorMinPricePerUnit: Math.min(...prices), competitorMaxPricePerUnit: Math.max(...prices),
    competitorCount: competitors.length, ownPosition: value.ownPosition ?? null, completeMarketCoverage: false};
}

function adviseProduct(rawItem = {}, rawOptions = {}) {
  const item = object(rawItem), options = object(rawOptions);
  const at = instant(options.now), basis = object(item.analysisBasis), econ = object(item.economics);
  const price = object(item.price), stock = object(item.stock), optimizer = object(item.optimizer);
  const priceStep = options.priceStepPct === undefined ? 0.02 : options.priceStepPct;
  const adStep = options.adStepPct === undefined ? 0.05 : options.adStepPct;
  const objective = options.objective === undefined ? 'profit_volume' : options.objective;
  const signals = [], missingEvidence = [], issues = [];
  const need = (code, text, blocking = true) => {
    missingEvidence.push({code, text});
    if (blocking) issues.push(code);
  };
  if (!Number.isFinite(at)) need('INVALID_NOW', 'Не задано корректное время оценки.');
  if (!['profit_volume', 'sales', 'position'].includes(objective) || !positive(priceStep) || priceStep > 0.05 || !positive(adStep) || adStep > 0.05) {
    need('INVALID_SCENARIO_SETTINGS', 'Нужна известная цель и положительные шаги не более 5%.');
  }
  if (!verifiedCost(item.cost, at)) need('COST_UNVERIFIED', 'Себестоимость должна быть подтверждена в рублях, соответствовать статусу filled/zero и быть не старше 24 часов.');
  if (basis.financeComplete !== true || econ.economicsStatus !== 'complete') need('FINANCE_INCOMPLETE', 'Для сценария нужны все подтверждённые финансовые компоненты.');
  const financeFresh = fresh(basis.financeObservedAt, at);
  if (!financeFresh) need('FINANCE_NOT_FRESH', 'Финансовый срез должен быть не старше 24 часов и не из будущего.');
  const from = day(basis.periodFrom), to = day(basis.periodTo);
  const periodComplete = Number.isFinite(from) && Number.isFinite(to) && from <= to && to + DAY - 3 * 3600000 <= at;
  if (!periodComplete) need('PERIOD_INCOMPLETE', 'Нужен завершённый период по московскому времени с известными границами.');
  if (basis.orderBasis !== 'unit' || basis.scope !== 'seller_sku') need('FINANCE_BASIS_UNKNOWN', 'Экономика должна относиться к реализованным единицам этого SKU.');
  if (!Number.isSafeInteger(basis.units) || basis.units < 0) need('UNITS_UNKNOWN', 'Количество реализованных единиц неизвестно или некорректно.');
  else if (basis.units === 0) need('NO_REALIZED_UNITS', 'В периоде нет реализованных единиц для оценки вклада на единицу.');
  if (!positive(basis.realizedRevenue)) need('REVENUE_UNAVAILABLE', 'Нужна положительная подтверждённая выручка реализации.');
  if (!nonnegative(basis.commission) || !nonnegative(basis.acquiring)) need('FEES_UNAVAILABLE', 'Комиссия и эквайринг неизвестны либо содержат возвратные корректировки; простая доля удержаний неприменима.');
  const feeRatio = positive(basis.realizedRevenue) && nonnegative(basis.commission) && nonnegative(basis.acquiring)
    ? (basis.commission + basis.acquiring) / basis.realizedRevenue : null;
  if (feeRatio !== null && (!finite(feeRatio) || feeRatio >= 1)) need('FEES_RATIO_UNUSABLE', 'Доля комиссии и эквайринга не позволяет применить линейный ценовой сценарий.');
  if (!nonnegative(basis.advertising)) need('ADVERTISING_UNAVAILABLE', 'Полные рекламные расходы SKU неизвестны либо содержат возвратные корректировки.');
  if (![econ.contributionAfterAds, econ.contributionBeforeAds, econ.contributionPerOrder, econ.contributionBeforeAdsPerOrder].every(finite)) {
    need('CONTRIBUTION_UNAVAILABLE', 'Подтверждённый вклад до и после рекламы неизвестен.');
  } else if (positive(basis.units) && (!close(econ.contributionPerOrder * basis.units, econ.contributionAfterAds)
    || !close(econ.contributionBeforeAdsPerOrder * basis.units, econ.contributionBeforeAds)
    || nonnegative(basis.advertising) && !close(econ.contributionBeforeAds - basis.advertising, econ.contributionAfterAds))) {
    need('CONTRIBUTION_INCONSISTENT', 'Итоги вклада и реализованные единицы не согласуются с расходами SKU.');
  }
  const priceFresh = fresh(price.observedAt, at);
  if (price.currency !== 'RUB' || !positive(price.sellerPrice)) need('SELLER_PRICE_UNAVAILABLE', 'Нужна подтверждённая цена продавца в рублях.');
  if (!priceFresh) need('PRICE_NOT_FRESH', 'Цена продавца должна быть не старше 24 часов и не из будущего.');

  const economicsUsable = issues.length === 0;
  const positiveContribution = positive(econ.contributionPerOrder);
  const stockKnown = Number.isSafeInteger(stock.quantity) && stock.quantity >= 0 && fresh(stock.observedAt, at);
  const stockLow = stockKnown && (stock.quantity < 5 || nonnegative(stock.days) && stock.days < 7);
  if (!stockKnown) need('STOCK_UNVERIFIED', 'Нужен свежий подтверждённый остаток перед тестом.', false);
  if (!nonnegative(stock.days)) need('STOCK_COVER_UNKNOWN', 'Запас в днях не подтверждён; перед тестом проверьте темп продаж и поставку.', false);
  if (stockLow) signals.push({kind: 'warning', text: 'Остаток или запас в днях ниже безопасного минимума; расширение спроса следует отложить.'});
  if (economicsUsable) signals.push({kind: positiveContribution ? 'positive' : 'warning', text: positiveContribution
    ? 'Полный финансовый срез подтверждает положительный вклад после рекламы на реализованную единицу.'
    : 'Подтверждённый вклад после рекламы не положителен: сначала проверьте цену, себестоимость и расходы.'});

  const market = marketObservation(options.marketEvidence, at);
  if (!market.available) need('MARKET_OBSERVATION_NEEDED', 'Нет свежего сопоставимого наблюдения цен покупателей и позиций; вывод о рынке недоступен.', false);
  else {
    const location = market.ownPricePerUnit < market.competitorMinPricePerUnit ? 'ниже диапазона'
      : market.ownPricePerUnit > market.competitorMaxPricePerUnit ? 'выше диапазона' : 'внутри диапазона';
    signals.push({kind: 'neutral', text: `Цена покупателя за единицу ${location} выбранных аналогов (${market.competitorCount}). Это одно ручное наблюдение, не оценка всего рынка; сопоставимость характеристик и доставки требует проверки.`});
    if (market.ownPosition !== null) signals.push({kind: 'neutral', text: `Позиция ${market.ownPosition} зафиксирована для запроса «${market.query}», регион ${market.region}. Наблюдение не предсказывает изменение позиции.`});
  }
  if (Array.isArray(optimizer.blockers) && optimizer.blockers.length) signals.push({kind: 'warning', text: 'В основном оптимизаторе остаются блокировки. Условные расчёты ниже их не снимают и не разрешают изменение цены или рекламы.'});
  if (objective === 'sales') {
    need('SALES_EFFECT_UNVERIFIED', 'Для цели роста продаж нужны измеримый критерий и сопоставимые наблюдения спроса до и после теста.', false);
    signals.push({kind: 'neutral', text: 'Выбрана цель роста продаж. Расчёты показывают только финансовые пороги; реакция спроса и оптимальная цена не установлены.'});
  }
  if (objective === 'position') {
    need('POSITION_EFFECT_UNVERIFIED', 'Для цели по позиции нужны целевой критерий и ряд наблюдений по одному запросу, региону и условиям поиска.', false);
    signals.push({kind: 'neutral', text: 'Выбрана цель по позиции. Одиночное наблюдение и финансовый сценарий не доказывают рост или сохранение позиции.'});
  }

  const unavailableReason = !economicsUsable ? 'Сценарий недоступен до проверки полноты, свежести и согласованности исходных данных.'
    : 'При неположительном вкладе сначала нужна проверка экономики; масштабирование и пороги сохранения прибыли не подтверждены.';
  const scenarios = [];
  for (const [id, label, sign] of [['price_up', 'Повысить цену', 1], ['price_down', 'Снизить цену', -1]]) {
    if (!economicsUsable || !positiveContribution) { scenarios.push(unavailable(id, label, unavailableReason)); continue; }
    const nextPrice = price.sellerPrice * (1 + sign * priceStep);
    const deltaContribution = (nextPrice - price.sellerPrice) * (1 - feeRatio);
    const nextContribution = econ.contributionPerOrder + deltaContribution;
    const threshold = sign > 0 ? (1 - econ.contributionPerOrder / nextContribution) * 100 : (econ.contributionPerOrder / nextContribution - 1) * 100;
    if (![nextPrice, nextContribution].every(positive) || !nonnegative(threshold)) {
      scenarios.push(unavailable(id, label, 'При такой цене положительный вклад и конечный порог сохранения прибыли не подтверждены.')); continue;
    }
    scenarios.push({id, label, status: 'conditional', summary: sign > 0
      ? 'Условный расчёт показывает, какое снижение объёма оставит прежний суммарный вклад. Изменение спроса неизвестно.'
      : 'Условный расчёт показывает, насколько должен вырасти объём для сохранения прежнего суммарного вклада. Рост спроса не гарантирован.',
    metrics: [metric('Цена продавца в сценарии', nextPrice, 'RUB'), metric('Вклад после рекламы на реализованную единицу', nextContribution, 'RUB'),
      metric(sign > 0 ? 'Допустимое снижение реализованного объёма' : 'Необходимый рост реализованного объёма', threshold, 'percent')],
    assumptions: ['Доля комиссии и эквайринга сохраняется на уровне выбранного периода.',
      'Изменение цены продавца полностью переносится в выручку реализации; скидки и субсидии не меняются.',
      'Себестоимость, прочие расходы и реклама на реализованную единицу сохраняются.',
      'Это условная арифметика, не прогноз спроса, прибыли или позиций; перед тестом нужны запас, аналоги и проверка ограничений оптимизатора.']});
  }
  if (economicsUsable && positiveContribution && positive(econ.contributionBeforeAdsPerOrder) && positive(basis.advertising)) {
    const extraSpend = basis.advertising * adStep, extraUnits = extraSpend / econ.contributionBeforeAdsPerOrder;
    if (positive(extraSpend) && positive(extraUnits)) scenarios.push({id: 'ad_up', label: 'Увеличить рекламный расход', status: 'conditional',
      summary: 'Для окупаемости дополнительного расхода нужен дополнительный реализованный объём. Это не рекомендация ставки и не прогноз рекламных заказов.',
      metrics: [metric('Дополнительный расход за такой же период', extraSpend, 'RUB'), metric('Дополнительные реализованные единицы для окупаемости', extraUnits, 'units')],
      assumptions: ['Используются полные рекламные расходы SKU из финансового среза; расход Performance повторно не вычитается.',
        'Вклад до рекламы на дополнительную реализованную единицу сохраняется.', 'Нужны дополнительные продажи сверх базовых, а не перераспределение органических заказов в рекламную атрибуцию.',
        'Рост расхода не равен росту ставки; текущие блокировки оптимизатора остаются в силе.']});
    else scenarios.push(unavailable('ad_up', 'Увеличить рекламный расход', 'Результат расчёта выходит за допустимые числовые пределы.'));
  } else scenarios.push(unavailable('ad_up', 'Увеличить рекламный расход', economicsUsable && basis.advertising === 0
    ? 'Рекламные расходы равны нулю: процентный шаг не задаёт бюджет пилота. Нужна отдельная оценка.' : unavailableReason));
  scenarios.push({id: 'hold', label: 'Сохранить параметры', status: 'conditional', summary: 'Сохранить параметры и собрать недостающие доказательства; наблюдение само по себе не гарантирует неизменности результата.', metrics: [], assumptions: ['Никакие изменения на площадке не выполняются.']});

  let status = 'review', priority = 40, title = 'Проверить ценовой тест', nextStep = 'Согласовать один тест, критерий по суммарному вкладу, период наблюдения и условия остановки; сначала закрыть блокировки основного оптимизатора.';
  if (!economicsUsable) { status = 'data_needed'; priority = 80; title = 'Сначала уточнить экономику'; nextStep = 'Проверить отмеченные исходные данные и повторить расчёт на полном завершённом периоде.'; }
  else if (!positiveContribution) { priority = 100; title = 'Проверить убыточный товар'; nextStep = 'Разобрать подтверждённые расходы и цену реализации; не расширять рекламу до проверки вклада.'; }
  else if (stockLow) { status = 'hold'; priority = 90; title = 'Сначала пополнить запас'; nextStep = 'Проверить поставку и запас в днях до любого теста расширения спроса.'; }
  else if (objective === 'profit_volume' && stockKnown && nonnegative(stock.days) && market.available && optimizer.action !== 'NONE' && ['PRICE_UP', 'BID_UP'].includes(optimizer.state) && Array.isArray(optimizer.blockers) && optimizer.blockers.length === 0) status = 'test_candidate';
  if (objective === 'sales') nextStep += ' Задайте критерий роста реализованного объёма и соберите сопоставимые наблюдения спроса.';
  if (objective === 'position') nextStep += ' Задайте целевую позицию и соберите ряд наблюдений по одному запросу и региону.';
  return {status, priority, title, summary: !economicsUsable ? unavailableReason : 'Сценарии сопоставляют условные пороги объёма и расходов. Они не прогнозируют спрос и не разрешают изменения на площадке.',
    signals, missingEvidence, scenarios, coverage: {objective, financeComplete: basis.financeComplete === true, financeFresh, periodComplete,
      periodFrom: basis.periodFrom ?? null, periodTo: basis.periodTo ?? null, economicsUsable, priceFresh, stockKnown,
      realizedUnits: Number.isSafeInteger(basis.units) && basis.units >= 0 ? basis.units : null, market,
      finance: economicsUsable, advertising: economicsUsable && nonnegative(basis.advertising),
      competitors: market.available, positions: market.available && market.ownPosition !== null,
      optimizerState: optimizer.state || null, optimizerBlockers: Array.isArray(optimizer.blockers) ? [...optimizer.blockers] : [],
      automaticChanges: false}, nextStep};
}

function calculateCommercialPlan(rawItem = {}, rawTerms = {}, rawOptions = {}) {
  const item = object(rawItem), terms = object(rawTerms), at = instant(object(rawOptions).now);
  const price = object(item.price), cost = object(item.cost), basis = object(item.analysisBasis);
  const missing = [];
  const need = (code, text) => missing.push({code, text});
  const validRate = value => nonnegative(value) && value <= 100;
  const ratesValid = validRate(terms.commissionPct) && validRate(terms.advertisingPct)
    && terms.commissionPct + terms.advertisingPct < 100
    && terms.priceBasis === 'seller_price' && terms.application === 'planning_reserve';
  if (!ratesValid) need('TERMS_UNAVAILABLE', 'Нужны плановые ставки от цены продавца с общей долей менее 100%.');
  const priceValid = price.currency === 'RUB' && positive(price.sellerPrice) && fresh(price.observedAt, at);
  if (!priceValid) need('PRICE_UNVERIFIED', 'Нужна свежая подтверждённая цена продавца в рублях.');
  const costValid = verifiedCost(cost, at);
  if (!costValid) need('COST_UNVERIFIED', 'Нужна свежая подтверждённая себестоимость в рублях со статусом filled или zero.');
  const from = day(basis.periodFrom), to = day(basis.periodTo);
  const basisValid = basis.financeComplete === true && fresh(basis.financeObservedAt, at)
    && Number.isFinite(from) && Number.isFinite(to) && from <= to && to + DAY - 3 * 3600000 <= at
    && Number.isSafeInteger(basis.units) && basis.units > 0 && basis.orderBasis === 'unit' && basis.scope === 'seller_sku';
  const componentsValid = ['logistics', 'acquiring', 'marketplaceServices', 'compensation'].every(field => finite(basis[field]));
  let otherCostsPerUnit = basisValid && componentsValid
    ? (basis.logistics + basis.acquiring + basis.marketplaceServices - basis.compensation) / basis.units : null;
  if (!finite(otherCostsPerUnit)) { otherCostsPerUnit = null; need('OTHER_COSTS_UNAVAILABLE', 'Прочие расходы на единицу неизвестны: нужен полный свежий завершённый финансовый период и все компоненты.'); }
  const retainedShare = ratesValid ? 1 - (terms.commissionPct + terms.advertisingPct) / 100 : null;
  let retainedRevenue = ratesValid && priceValid ? price.sellerPrice * retainedShare : null;
  if (!finite(retainedRevenue)) retainedRevenue = null;
  const unitCost = costValid ? cost.unitCost : null;
  let status = ratesValid && priceValid && costValid ? otherCostsPerUnit === null ? 'partial' : 'complete' : 'unavailable';
  let contributionPerUnit = status === 'complete' ? retainedRevenue - unitCost - otherCostsPerUnit : null;
  let minPrice = status === 'complete' ? Math.max(0, (unitCost + otherCostsPerUnit) / retainedShare) : null;
  if (status === 'complete' && (!finite(contributionPerUnit) || !finite(minPrice))) {
    status = 'unavailable'; contributionPerUnit = null; minPrice = null;
    need('CALCULATION_UNAVAILABLE', 'Результат расчёта выходит за допустимые числовые пределы.');
  }
  const assumptions = [
    'Плановые проценты применяются к цене продавца и резервируют комиссию и рекламу; это не фактические удержания.',
    'Фактические комиссия и реклама из финансового среза повторно не вычитаются.',
    'Себестоимость и прочие расходы на единицу сохраняются; исторические возвратные корректировки могут не повториться.',
    'Модель предполагает реализацию по указанной цене продавца без дополнительных скидок или изменения субсидий.',
    'Минимальная цена означает только нулевой вклад в этой модели, не рекомендованную цену.',
    'Это плановая арифметика, не прогноз спроса, прибыли или позиции и не разрешение изменения на площадке.'
  ];
  const scenarios = [];
  for (const [id, label, sign] of [['price_up', 'План: повысить цену на 2%', 1], ['price_down', 'План: снизить цену на 2%', -1]]) {
    if (status !== 'complete') { scenarios.push(unavailable(id, label, 'Для планового сценария нужны подтверждённая себестоимость и полный состав прочих расходов.')); continue; }
    const nextPrice = price.sellerPrice * (1 + sign * 0.02);
    const nextContribution = nextPrice * retainedShare - unitCost - otherCostsPerUnit;
    if (![nextPrice, nextContribution].every(finite)) { scenarios.push(unavailable(id, label, 'Результат сценария выходит за допустимые числовые пределы.')); continue; }
    const metrics = [metric('Цена продавца в плане', nextPrice, 'RUB'), metric('Плановый вклад на реализованную единицу', nextContribution, 'RUB')];
    if (positive(contributionPerUnit) && positive(nextContribution)) {
      const threshold = sign > 0 ? (1 - contributionPerUnit / nextContribution) * 100 : (contributionPerUnit / nextContribution - 1) * 100;
      if (nonnegative(threshold)) metrics.push(metric(sign > 0 ? 'Допустимое снижение объёма в плане' : 'Необходимый рост объёма в плане', threshold, 'percent'));
    }
    scenarios.push({id, label, status: 'conditional', summary: positive(contributionPerUnit) && positive(nextContribution)
      ? 'Условный порог объёма сохраняет прежний суммарный плановый вклад; реакция спроса неизвестна.'
      : 'Показан условный вклад. При неположительном исходном или новом вкладе порог сохранения прибыли не определён.', metrics, assumptions: [...assumptions]});
  }
  scenarios.push(unavailable('ad_up', 'План: увеличить рекламу', 'Плановый рекламный резерв не доказывает дополнительный спрос. Без проверенного критерия окупаемости увеличение не рассчитывается.'));
  scenarios.push(status === 'complete' ? {id: 'hold', label: 'План: сохранить цену', status: 'conditional',
    summary: 'Плановый вклад при текущей цене и заданных резервах.', metrics: [metric('Плановый вклад на реализованную единицу', contributionPerUnit, 'RUB')], assumptions: [...assumptions]}
    : unavailable('hold', 'План: сохранить цену', 'Полный плановый вклад пока неизвестен.'));
  return {status, commissionPct: validRate(terms.commissionPct) ? terms.commissionPct : null,
    advertisingPct: validRate(terms.advertisingPct) ? terms.advertisingPct : null, priceBasis: terms.priceBasis ?? null,
    application: terms.application ?? null, retainedRevenue, unitCost, otherCostsPerUnit, contributionPerUnit, minPrice,
    scenarios, assumptions, missing};
}

// The growth decision uses the configured planning reserves, while preserving
// actual finance in the input. It never authorizes a marketplace command.
function adviseGrowthDecision(rawItem = {}, rawOptions = {}) {
  const item = object(rawItem), options = object(rawOptions), at = instant(options.now);
  const objective = options.objective || 'profit_volume', plan = calculateCommercialPlan(item, options.terms, {now: options.now});
  const market = marketObservation(options.marketEvidence, at), stock = object(item.stock), optimizer = object(item.optimizer);
  const missingEvidence = [...plan.missing], signals = [], blockers = Array.isArray(optimizer.blockers) ? [...optimizer.blockers] : [];
  const need = (code, text) => { if (!missingEvidence.some(row => row.code === code)) missingEvidence.push({code, text}); };
  const stockKnown = Number.isSafeInteger(stock.quantity) && stock.quantity >= 0 && fresh(stock.observedAt, at);
  const stockCoverKnown = stockKnown && nonnegative(stock.days), stockLow = stockKnown && (stock.quantity < 5 || stockCoverKnown && stock.days < 7);
  const remainder = finite(plan.retainedRevenue) && finite(plan.unitCost) ? plan.retainedRevenue - plan.unitCost : null;
  let status = 'data_needed', priority = 80, title = 'Уточнить данные для плана', direction = 'hold', primaryScenarioId = 'hold', suggestedPrice = null;
  let summary = 'Для решения нужны подтверждённые исходные данные.', nextStep = 'Обновите отмеченные источники и повторите расчёт.';
  if (!Number.isFinite(at) || !['profit_volume', 'sales', 'position'].includes(objective)) need('INVALID_SCENARIO_SETTINGS', 'Выберите известную цель и корректное время расчёта.');
  if (!stockKnown) need('STOCK_UNVERIFIED', 'Обновите остатки товара: нужна подтверждённая величина не старше 24 часов.');
  if (!stockCoverKnown) need('STOCK_COVER_UNKNOWN', 'Подтвердите запас в днях по текущему темпу продаж и дату следующей поставки.');
  if (!market.available) need('MARKET_OBSERVATION_NEEDED', 'Обновите цены покупателей у своего товара и сопоставимых аналогов за последние 24 часа: одинаковые упаковка, регион, запрос и условия доставки.');
  if (blockers.length) signals.push({kind: 'warning', text: 'Ограничения основного оптимизатора сохраняются. Плановый сценарий не снимает их и не разрешает запись на площадку.'});
  if (plan.status !== 'unavailable') signals.push({kind: 'neutral', text: `План резервирует ${plan.commissionPct}% цены продавца на комиссию и ${plan.advertisingPct}% на рекламу. Фактические комиссия и реклама повторно не вычитаются.`});
  const relation = market.available ? market.ownPricePerUnit < market.competitorMinPricePerUnit ? 'below' : market.ownPricePerUnit > market.competitorMaxPricePerUnit ? 'above' : 'within' : null;
  if (relation) signals.push({kind: 'neutral', text: `Цена покупателя за единицу ${relation === 'below' ? 'ниже' : relation === 'above' ? 'выше' : 'внутри'} диапазона выбранных аналогов. Это наблюдение части рынка; цена продавца напрямую с ним не сравнивается.`});
  const ads = object(item.advertising), previous = object(ads.previousPeriod), pilot = object(ads.pilotBasis);
  const period = row => { const from = day(row.periodFrom), to = day(row.periodTo); return Number.isFinite(from) && Number.isFinite(to) && from <= to && to + DAY - 3 * 3600000 <= at ? {from, to, duration: to - from} : null; };
  const counts = row => Number.isSafeInteger(row.impressions) && row.impressions >= 0 && Number.isSafeInteger(row.clicks) && row.clicks >= 0 && row.clicks <= row.impressions && Number.isSafeInteger(row.orders) && row.orders >= 0 && row.orders <= row.clicks;
  const currentPeriod = period(ads), priorPeriod = period(previous);
  const funnelKnown = ads.connected === true && ads.complete === true && ads.model === 'CPC' && ads.skuLinkStatus === 'matched' && ads.attributionModel === 'ozon_performance' && ads.orderBasis === 'attributed_order' && ['seller_sku', 'campaign_sku'].includes(ads.scope) && fresh(ads.observedAt, at) && counts(ads) && !!currentPeriod;
  const comparableTraffic = funnelKnown && previous.complete === true && fresh(previous.observedAt, at) && counts(previous) && !!priorPeriod && priorPeriod.duration === currentPeriod.duration && priorPeriod.to < currentPeriod.from && previous.scope === ads.scope && previous.attributionModel === ads.attributionModel && (ads.scope === 'seller_sku' || typeof ads.campaign?.id === 'string' && previous.campaignId === ads.campaign.id);
  const trafficDeclined = comparableTraffic && ads.clicks < previous.clicks;
  // Optional pilotBasis is explicit reviewed evidence, never inferred from spend
  // or an arbitrary percent: confirmed, observedAt, days, maxAdditionalSpendRub,
  // stopLossRub, and incrementalSalesMeasurement.
  const pilotKnown = pilot.confirmed === true && fresh(pilot.observedAt, at) && Number.isSafeInteger(pilot.days) && pilot.days > 0 && pilot.days <= 90 && positive(pilot.maxAdditionalSpendRub) && positive(pilot.stopLossRub) && pilot.stopLossRub <= pilot.maxAdditionalSpendRub && pilot.incrementalSalesMeasurement === true;
  if (funnelKnown) signals.push({kind: 'neutral', text: `Рекламная воронка: ${ads.impressions} показов → ${ads.clicks} кликов → ${ads.orders} атрибутированных заказов. Атрибуция не доказывает дополнительные продажи.`});
  if (plan.status === 'partial') {
    title = remainder <= 0 ? 'Не расширять: резервов уже недостаточно' : 'Уточнить прочие расходы';
    priority = remainder <= 0 ? 100 : 80;
    summary = remainder <= 0 ? 'После плановых резервов и себестоимости остаток неположителен ещё до прочих расходов. Итоговый вклад неизвестен; неизвестные компенсации не считаются прибылью.' : 'Положительный остаток после резервов и себестоимости ещё не является прибылью: прочие расходы неизвестны.';
    nextStep = 'Обновите финансы за завершённый период: логистику, эквайринг, услуги, компенсации и реализованные единицы. До проверки полного вклада не расширяйте рекламу.';
    if (remainder <= 0) status = 'hold';
  } else if (plan.status === 'complete') {
    status = 'review'; priority = 40;
    title = 'Проверить один управляемый тест'; summary = 'Полный плановый вклад рассчитан по заданным резервам и прочим расходам. Реакция спроса неизвестна.';
    nextStep = 'Выберите один тест, срок, критерий по суммарному вкладу и условия остановки; затем подтвердите конкретное изменение.';
    if (!positive(plan.contributionPerUnit)) {
      status = 'hold'; priority = 100; title = 'Сначала восстановить положительный вклад';
      summary = 'При текущей цене полный плановый вклад неположителен. Рост объёма по этой модели не устраняет проблему.';
      nextStep = 'Проверьте себестоимость и прочие расходы, затем рассмотрите цену с положительным вкладом. Не расширяйте рекламный бюджет до проверки.';
    } else if (stockLow) {
      status = 'hold'; priority = 90; title = 'Сначала пополнить запас';
      summary = 'Плановый вклад положителен, но остаток или запас в днях слишком мал для расширения спроса.';
      nextStep = 'Подтвердите поставку и достаточный запас перед ценовым или рекламным тестом.';
    } else if (relation === 'above' || relation === 'below') {
      direction = relation === 'above' ? 'price_down' : 'price_up'; primaryScenarioId = direction;
      const scenario = plan.scenarios.find(row => row.id === direction);
      const target = scenario?.metrics[0] ? Math.round(scenario.metrics[0].value * 100) / 100 : null;
      const contribution = positive(target) ? target * (1 - (plan.commissionPct + plan.advertisingPct) / 100) - plan.unitCost - plan.otherCostsPerUnit : null;
      const changesPrice = direction === 'price_up' ? target > item.price?.sellerPrice : target < item.price?.sellerPrice;
      if (scenario?.status === 'conditional' && positive(target) && positive(contribution) && changesPrice && scenario.metrics.length >= 3) {
        suggestedPrice = target;
        scenario.metrics[0].value = target;
        scenario.metrics[1].value = contribution;
        scenario.metrics[2].value = (direction === 'price_up' ? 1 - plan.contributionPerUnit / contribution : plan.contributionPerUnit / contribution - 1) * 100;
        title = relation === 'above' ? 'Рассмотреть небольшой тест снижения цены' : 'Рассмотреть небольшой тест повышения цены';
        summary = relation === 'above' ? 'Цена покупателя выше выбранных аналогов. Условное снижение цены продавца показывает, какой рост реализованного объёма нужен для сохранения суммарного вклада.' : 'Цена покупателя ниже выбранных аналогов. Условное повышение цены продавца показывает допустимое снижение объёма при сохранении суммарного вклада.';
        nextStep = 'Проверьте перенос изменения цены продавца в цену покупателя, скидки и доставку. Согласуйте один тест и сравните суммарный вклад за сопоставимые периоды.';
        if (stockCoverKnown && !blockers.length) status = 'test_candidate';
      } else {
        direction = 'hold'; primaryScenarioId = 'hold'; status = 'hold'; title = 'Снижение цены не подтверждено вкладом';
        summary = 'Условный шаг не сохраняет положительный вклад. Порог роста объёма для сохранения прибыли не определён.';
      }
    } else if (relation === 'within') {
      title = 'Уточнить основание для рекламного пилота';
      summary = 'Цена находится в диапазоне выбранных аналогов, плановый вклад положителен. Это ещё не доказывает окупаемость дополнительного бюджета.';
      if (!funnelKnown) need('AD_FUNNEL_UNVERIFIED', 'Обновите Performance API за завершённый период: показы, клики, заказы и точную связь рекламы с этим SKU.');
      if (!comparableTraffic) need('TRAFFIC_BASELINE_NEEDED', 'Добавьте предыдущий сопоставимый рекламный период той же длительности: без базы нельзя подтвердить снижение трафика.');
      if (!funnelKnown || ads.clicks === 0 || ads.orders === 0) need('CONVERSION_EVIDENCE_NEEDED', 'Подтвердите конверсию на ненулевых кликах и заказах; нулевая выборка не обосновывает расширение бюджета.');
      if (!pilotKnown) need('AD_PILOT_BASIS_NEEDED', 'Согласуйте сумму дополнительного бюджета, срок, предел потерь и способ измерения дополнительных реализованных продаж относительно базы.');
      if (trafficDeclined && ads.clicks > 0 && ads.orders > 0 && pilotKnown) {
        direction = 'ad_pilot'; primaryScenarioId = 'ad_up'; title = 'Рассмотреть ограниченный рекламный пилот';
        summary = 'Трафик ниже сопоставимого периода, конверсия наблюдается, ограничения пилота заданы. Проверяйте дополнительные продажи и суммарный вклад: рост бюджета сам по себе не гарантирует результат.';
        const index = plan.scenarios.findIndex(row => row.id === 'ad_up');
        plan.scenarios[index] = {id: 'ad_up', label: 'Ограниченный рекламный пилот', status: 'conditional', summary: 'Показаны согласованные ограничения пилота, а не прогноз расхода, продаж или прибыли.',
          metrics: [metric('Лимит дополнительного расхода за пилот', pilot.maxAdditionalSpendRub, 'RUB'), metric('Срок пилота', pilot.days, 'days'), metric('Предел потерь для остановки', pilot.stopLossRub, 'RUB')],
          assumptions: ['Лимиты заданы явно; рекламный резерв не является разрешением потратить эту сумму.', 'Атрибутированные заказы не равны дополнительным реализованным продажам.', 'Бюджет кампании влияет на все её товары; нужна отдельная проверка и подтверждение точного изменения.']};
        if (stockCoverKnown && !blockers.length) status = 'test_candidate';
      }
      nextStep = 'Меняйте только один параметр кампании после отдельного подтверждения; учитывайте все товары кампании и проверяйте дополнительные продажи, а не только атрибутированные заказы.';
    } else {
      title = 'Обновить сравнение с рынком'; nextStep = 'Зафиксируйте сопоставимые цены покупателей и условия доставки. До этого нельзя выбрать направление ценового теста.';
    }
  }
  if (!Number.isFinite(at) || !['profit_volume', 'sales', 'position'].includes(objective)) { status = 'data_needed'; direction = 'hold'; primaryScenarioId = 'hold'; suggestedPrice = null; }
  if (objective === 'sales') { need('SALES_EFFECT_UNVERIFIED', 'Задайте критерий роста реализованных единиц и сравнимую базу; финансовый порог не прогнозирует продажи.'); if (status === 'test_candidate') status = 'review'; }
  if (objective === 'position') { need('POSITION_EFFECT_UNVERIFIED', 'Задайте целевую позицию и ряд наблюдений одного запроса/региона; финансовый порог не прогнозирует позицию.'); if (status === 'test_candidate') status = 'review'; }
  return {status, priority, title, summary, nextStep, direction, primaryScenarioId, suggestedPrice, signals, missingEvidence, scenarios: plan.scenarios,
    coverage: {objective, planStatus: plan.status, finance: plan.status === 'complete', financeComplete: item.analysisBasis?.financeComplete === true, economicsUsable: plan.status === 'complete', stockKnown, stockCoverKnown, market, marketRelation: relation, advertising: funnelKnown, trafficDeclined, pilotKnown, optimizerBlockers: blockers, automaticChanges: false},
    calculation: {basis: 'planning_reserve', remainderBeforeOtherCosts: remainder, contributionPerUnit: plan.contributionPerUnit, minPrice: plan.minPrice, commissionPct: plan.commissionPct, advertisingPct: plan.advertisingPct}};
}

module.exports = {adviseProduct, calculateCommercialPlan, adviseGrowthDecision};
