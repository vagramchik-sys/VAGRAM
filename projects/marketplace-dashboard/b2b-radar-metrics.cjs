'use strict';

const COVERAGE_VALUES = new Set(['complete', 'partial', 'unknown']);
const LOW_DATA = 'LOW_DATA';
const DEFAULTS = Object.freeze({ minPeers: 3, minProductUnits: 20, minProductOrders: 5, minObservedDays: 3, opportunityScore: 50 });

const finite = value => typeof value === 'number' && Number.isFinite(value);
const owns = (value, key) => value !== null && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key);
const nonNegative = value => finite(value) && value >= 0 ? value : 0;
const round = (value, digits = 4) => value === null || !finite(value) ? null : Number(value.toFixed(digits));
const sum = values => values.reduce((total, value) => total + nonNegative(value), 0);

function metric(value, status = 'available', reason = null, extra = null) {
  const result = { value: value === null || !finite(value) ? null : value, status };
  if (reason) result.reason = reason;
  if (extra) Object.assign(result, extra);
  return result;
}

function isoDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? value : null;
}

function period(value, label) {
  const from = isoDay(value?.from), to = isoDay(value?.to);
  if (!from || !to || from > to) throw new Error(`Некорректный ${label} период B2B-радара`);
  const days = Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000) + 1;
  return { from, to, days };
}

function coverageValue(value, fallback = 'unknown') {
  if (COVERAGE_VALUES.has(value)) return value;
  if (value === true) return 'complete';
  if (value === false) return 'partial';
  return fallback;
}

function normalizeCoverage(value = {}, periodsCompatible) {
  let classification = coverageValue(value.classification, value.complete === true ? 'complete' : value.complete === false ? 'partial' : 'unknown');
  let amounts = coverageValue(value.amounts, value.amountComplete === true ? 'complete' : value.amountComplete === false ? 'partial' : 'unknown');
  const explicitlyPartialPeriod = value.current?.complete === false || value.previous?.complete === false;
  if (explicitlyPartialPeriod && classification === 'complete') classification = 'partial';
  if (explicitlyPartialPeriod && amounts === 'complete') amounts = 'partial';
  const daily = coverageValue(value.daily, value.dailyComplete === true ? 'complete' : value.dailyComplete === false ? 'partial' : 'unknown');
  return {
    classification,
    amounts,
    daily,
    currentComplete: value.current?.complete === true || value.currentComplete === true || value.complete === true,
    previousComplete: value.previous?.complete === true || value.previousComplete === true || value.complete === true,
    compatibleWithPrevious: value.compatibleWithPrevious === true && periodsCompatible
  };
}

function buyerValue(source, type, field = 'units') {
  const aliases = type === 'legal' ? ['legal', 'business', 'b2b'] : [type];
  for (const alias of aliases) {
    const value = source?.breakdown?.byBuyerType?.[alias]?.[field] ?? source?.byBuyerType?.[alias]?.[field];
    if (finite(value)) return value;
  }
  return null;
}

function normalizeSnapshot(value = {}) {
  const totalUnits = nonNegative(value.notCancelledUnits ?? value.activeUnits ?? value.totalUnits ?? value.units?.total ?? value.units);
  const grossTotalUnits = nonNegative(value.totalUnits ?? value.units?.total ?? value.units ?? totalUnits);
  const cancelledUnits = nonNegative(value.cancelledUnits);
  const hasExplicitNet = finite(value.notCancelledUnits) || finite(value.activeUnits);
  const fallbackNetTotal = hasExplicitNet ? totalUnits : Math.max(0, grossTotalUnits - cancelledUnits);
  const legalGross = nonNegative(value.legalUnits ?? value.units?.legal ?? buyerValue(value, 'legal'));
  const legalCancelled = value.legalCancelledUnits ?? buyerValue(value, 'legal', 'cancelledUnits');
  const hasLegalNet = finite(value.legalNotCancelledUnits) || finite(value.activeLegalUnits) || cancelledUnits === 0;
  const legalUnits = nonNegative(value.legalNotCancelledUnits ?? value.activeLegalUnits ?? (finite(legalCancelled) ? legalGross - legalCancelled : legalGross));
  const individualUnits = nonNegative(value.individualNotCancelledUnits ?? value.individualUnits ?? value.units?.individual ?? buyerValue(value, 'individual'));
  const unknownUnits = nonNegative(value.unknownNotCancelledUnits ?? value.unknownUnits ?? value.units?.unknown ?? buyerValue(value, 'unknown'));
  const legalOrdersRaw = value.legalOrderCount ?? value.legal_order_count ?? value.legalOrders ?? value.b2bOrderCount;
  const totalOrdersRaw = value.orderCount ?? value.order_count ?? value.orders;
  const orderCount = nonNegative(legalOrdersRaw ?? totalOrdersRaw);
  const totalOrderCount = nonNegative(totalOrdersRaw ?? orderCount);
  const cancellationUnknownUnits = nonNegative(value.cancellationUnknownUnits);
  const hasActiveAmount = owns(value, 'notCancelledAmountRub') || owns(value, 'activeAmountRub');
  const explicitActiveAmount = owns(value, 'notCancelledAmountRub') ? value.notCancelledAmountRub : value.activeAmountRub;
  const rawAmount = hasActiveAmount ? explicitActiveAmount : cancelledUnits === 0 && cancellationUnknownUnits === 0 ? value.amountRub : null;
  const amountRub = finite(rawAmount) && rawAmount >= 0 ? rawAmount : null;
  const legalRawAmount = owns(value, 'legalNotCancelledAmountRub') ? value.legalNotCancelledAmountRub : cancelledUnits === 0 && cancellationUnknownUnits === 0 ? value.legalAmountRub : null;
  const individualRawAmount = owns(value, 'individualNotCancelledAmountRub') ? value.individualNotCancelledAmountRub : cancelledUnits === 0 && cancellationUnknownUnits === 0 ? value.individualAmountRub : null;
  const legalAmountRub = finite(legalRawAmount) && legalRawAmount >= 0 ? legalRawAmount : null;
  const individualAmountRub = finite(individualRawAmount) && individualRawAmount >= 0 ? individualRawAmount : null;
  const daily = Array.isArray(value.daily) ? value.daily : [];
  return {
    totalUnits: fallbackNetTotal,
    legalUnits: Math.min(legalUnits, fallbackNetTotal),
    individualUnits,
    unknownUnits,
    orderCount,
    totalOrderCount,
    amountRub,
    legalAmountRub,
    individualAmountRub,
    cancelledUnits,
    cancellationResolved: hasLegalNet && cancellationUnknownUnits === 0,
    cancellationUnknownUnits,
    daily
  };
}

function identity(row) {
  const market = String(row?.market ?? ''), storeId = String(row?.storeId ?? ''), productId = String(row?.productId ?? row?.sku ?? '');
  if (!market || !storeId || !productId) throw new Error('У строки B2B-радара нет market, storeId или productId');
  return {
    id: [market, storeId, productId].join('|'), market, storeId, productId,
    sku: String(row.sku ?? productId), name: String(row.name ?? row.sku ?? productId),
    category: typeof row.category === 'string' && row.category.trim() ? row.category.trim() : null
  };
}

function splitRows(input) {
  if (Array.isArray(input.rows)) return input.rows.map(row => ({
    ...identity(row),
    current: normalizeSnapshot(row.metrics?.current ?? row.current ?? {}),
    previous: normalizeSnapshot(row.metrics?.previous ?? row.previous ?? {})
  }));
  const joined = new Map();
  for (const [side, rows] of [['current', input.currentRows], ['previous', input.previousRows]]) {
    for (const raw of Array.isArray(rows) ? rows : []) {
      const id = identity(raw), existing = joined.get(id.id) || { ...id, current: normalizeSnapshot(), previous: normalizeSnapshot() };
      joined.set(id.id, { ...existing, ...id, [side]: normalizeSnapshot(raw) });
    }
  }
  return [...joined.values()];
}

function statusFor(kind, coverage, snapshot) {
  if (kind === 'amount') {
    if (snapshot.amountRub === null) return ['unavailable', 'Сумма в рублях не подтверждена'];
    if (coverage.amounts !== 'complete') return ['partial', 'Сумма подтверждена только для доступной части данных'];
    return ['available', null];
  }
  if (coverage.classification === 'unknown') return ['unavailable', 'Нет подтверждённой классификации покупателей'];
  if (!snapshot.cancellationResolved) return ['partial', 'Нет разреза отмен по типу покупателя'];
  if (snapshot.unknownUnits > 0) return ['partial', 'Часть заказов имеет неизвестный тип покупателя'];
  if (coverage.classification === 'partial') return ['partial', 'Классификация покупателей покрывает только часть периода'];
  return ['available', null];
}

function values(snapshot, coverage) {
  const [buyerStatus, buyerReason] = statusFor('buyer', coverage, snapshot);
  const [amountStatus, amountReason] = statusFor('amount', coverage, snapshot);
  const share = snapshot.totalUnits > 0 ? snapshot.legalUnits / snapshot.totalUnits : snapshot.legalUnits === 0 ? 0 : null;
  const orderKnown = finite(snapshot.orderCount);
  const avgOrder = orderKnown && snapshot.orderCount > 0 ? snapshot.legalUnits / snapshot.orderCount : snapshot.legalUnits === 0 ? 0 : null;
  const orderStatus = orderKnown ? [buyerStatus, buyerReason] : ['unavailable', 'Нет distinct-счётчика B2B-заказов для этого уровня агрегации'];
  const knownBuyerAmount = snapshot.legalAmountRub !== null && snapshot.individualAmountRub !== null ? snapshot.legalAmountRub + snapshot.individualAmountRub : null;
  const amountShare = knownBuyerAmount > 0 ? snapshot.legalAmountRub / knownBuyerAmount : knownBuyerAmount === 0 ? 0 : null;
  const amountShareStatus = amountShare === null ? ['unavailable', 'Нет подтверждённых сумм заказов по типам покупателей'] : amountStatus === 'available' && buyerStatus === 'available' ? ['available', null] : ['partial', amountReason || buyerReason];
  const b2bAmountStatus = snapshot.legalAmountRub === null ? ['unavailable', 'Сумма B2B-заказов не подтверждена'] : amountStatus === 'available' && buyerStatus === 'available' ? ['available', null] : ['partial', amountReason || buyerReason];
  return {
    totalUnits: metric(round(snapshot.totalUnits, 2)),
    b2bUnits: metric(round(snapshot.legalUnits, 2), buyerStatus, buyerReason),
    b2bShare: metric(round(share), buyerStatus, buyerReason),
    b2bShareDenominator: metric(round(snapshot.totalUnits, 2), buyerStatus, buyerReason),
    individualUnits: metric(round(snapshot.individualUnits, 2), buyerStatus, buyerReason),
    unknownUnits: metric(round(snapshot.unknownUnits, 2), buyerStatus, buyerReason),
    orderCount: metric(round(snapshot.orderCount, 2), orderStatus[0], orderStatus[1]),
    avgOrderUnits: metric(round(avgOrder, 2), orderStatus[0], orderStatus[1]),
    amountRub: metric(snapshot.amountRub === null ? null : round(snapshot.amountRub, 2), amountStatus, amountReason),
    b2bAmountRub: metric(snapshot.legalAmountRub === null ? null : round(snapshot.legalAmountRub, 2), b2bAmountStatus[0], b2bAmountStatus[1]),
    b2bAmountShare: metric(round(amountShare), amountShareStatus[0], amountShareStatus[1]),
    cancelledUnits: metric(round(snapshot.cancelledUnits, 2))
  };
}

function growthMetric(current, previous, coverage, periodsCompatible) {
  if (!periodsCompatible || !coverage.compatibleWithPrevious || !coverage.currentComplete || !coverage.previousComplete) return metric(null, 'unavailable', 'Периоды или источники нельзя корректно сравнить полностью');
  const currentState = statusFor('buyer', coverage, current), previousState = statusFor('buyer', coverage, previous);
  if (currentState[0] !== 'available' || previousState[0] !== 'available') return metric(null, 'unavailable', 'Рост требует полного сравнимого покрытия классификации');
  if (previous.legalUnits === 0) return current.legalUnits === 0 ? metric(0) : metric(null, 'unavailable', 'Новый спрос: в предыдущем периоде нулевая база', { kind: 'new_demand' });
  return metric(round((current.legalUnits - previous.legalUnits) / previous.legalUnits));
}

function quantile(values, q) {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q, lower = Math.floor(position), upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function normalized(values) {
  const available = values.filter(finite), low = quantile(available, 0.05), high = quantile(available, 0.95);
  if (!available.length) return { values: values.map(() => null), capped: 0 };
  if (high === low) return { values: values.map(value => finite(value) ? 50 : null), capped: 0 };
  let capped = 0;
  return { values: values.map(value => {
    if (!finite(value)) return null;
    const clipped = Math.min(high, Math.max(low, value));
    if (clipped !== value) capped++;
    return round((clipped - low) / (high - low) * 100, 2);
  }), capped };
}

function dayStability(snapshot, periodDays) {
  if (!snapshot.daily.length || periodDays < 1) return null;
  const byDay = new Map();
  for (const item of snapshot.daily) {
    const date = isoDay(item?.date);
    if (date) byDay.set(date, (byDay.get(date) || 0) + normalizeSnapshot(item).legalUnits);
  }
  const values = [...byDay.values()];
  while (values.length < periodDays) values.push(0);
  const mean = sum(values) / periodDays;
  if (mean === 0) return 0;
  const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / periodDays;
  return 1 / (1 + Math.sqrt(variance) / mean);
}

function scoreProducts(products, options) {
  const raw = {
    share: products.map(row => row.current.b2bShare.status !== 'unavailable' ? row.current.b2bShare.value : null),
    amountShare: products.map(row => row.current.b2bAmountShare.status === 'available' ? row.current.b2bAmountShare.value : null),
    avgOrder: products.map(row => row.current.avgOrderUnits.status !== 'unavailable' ? row.current.avgOrderUnits.value : null),
    growth: products.map(row => row.growth.status === 'available' ? row.growth.value : null),
    stability: products.map(row => dayStability(row._raw.current, options.periodDays)),
    amount: products.map(row => row.current.b2bAmountRub.status === 'available' ? row.current.b2bAmountRub.value : null)
  };
  const components = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, normalized(value)]));
  const weights = { share: 0.25, amountShare: 0.20, avgOrder: 0.15, growth: 0.20, stability: 0.10, amount: 0.10 };
  let outliersCapped = 0;
  for (const value of Object.values(components)) outliersCapped += value.capped;
  const enoughPeers = products.length >= options.minPeers;
  products.forEach((row, index) => {
    row.components = Object.fromEntries(Object.entries(components).map(([key, result]) => [key, result.values[index]]));
    const present = Object.entries(row.components).filter(([, value]) => finite(value));
    const weight = sum(present.map(([key]) => weights[key]));
    const calculated = weight ? round(sum(present.map(([key, value]) => value * weights[key])) / weight, 2) : null;
    const observedDays = new Set(row._raw.current.daily.map(value => isoDay(value?.date)).filter(Boolean)).size;
    row.scoreStatus = enoughPeers && row.current.b2bUnits.status === 'available' && row.growth.status === 'available' &&
      row.current.b2bUnits.value >= options.minProductUnits && row.current.orderCount.value >= options.minProductOrders &&
      observedDays >= options.minObservedDays && present.length === 6 ? 'ok' : LOW_DATA;
    row.score = row.scoreStatus === 'ok' ? calculated : null;
    if (row.scoreStatus === LOW_DATA) row.flags.push(LOW_DATA);
  });
  const eligible = products.filter(row => row.scoreStatus === 'ok');
  const shares = eligible.map(row => row.current.b2bShare.value), growth = eligible.map(row => row.growth.value);
  const thresholds = {
    share: { p25: round(quantile(shares, 0.25), 4), median: round(quantile(shares, 0.5), 4), p75: round(quantile(shares, 0.75), 4) },
    growth: { p25: round(quantile(growth, 0.25), 4), median: round(quantile(growth, 0.5), 4), p75: round(quantile(growth, 0.75), 4) }
  };
  for (const row of products) {
    if (row.scoreStatus === LOW_DATA) row.zone = LOW_DATA;
    else if (row.current.b2bShare.value >= thresholds.share.median && row.growth.value >= thresholds.growth.median) row.zone = 'leaders';
    else if (row.current.b2bShare.value < thresholds.share.median && row.growth.value >= thresholds.growth.median) row.zone = 'growth';
    else if (row.current.b2bShare.value >= thresholds.share.median) row.zone = 'opportunity';
    else row.zone = 'low';
  }
  return { outliersCapped, thresholds };
}

function potentialFor(row, peers, coverage, periodsCompatible, options) {
  const unavailable = reason => metric(null, 'unavailable', reason, { kind: 'estimated_benchmark' });
  if (!row.category) return unavailable('Для товара не указана категория');
  if (!periodsCompatible || !coverage.compatibleWithPrevious || !coverage.currentComplete || !coverage.previousComplete || coverage.classification !== 'complete' || coverage.amounts !== 'complete') return unavailable('Потенциал требует полного сравнимого покрытия и подтверждённых сумм заказов');
  if (row.current.amountRub.value === null || row.current.totalUnits.value <= 0) return unavailable('Нет подтверждённой суммы или объёма товара');
  const categoryPeers = peers.filter(peer => peer.category === row.category && peer.scoreStatus === 'ok' && peer.current.b2bShare.status === 'available' && peer.current.amountRub.status === 'available');
  if (categoryPeers.length < options.minPeers) return unavailable('Недостаточно сопоставимых товаров категории');
  const benchmark = quantile(categoryPeers.map(peer => peer.current.b2bShare.value), 0.75);
  const unitAmount = row.current.amountRub.value / row.current.totalUnits.value;
  const value = Math.max(0, (benchmark - row.current.b2bShare.value) * row.current.totalUnits.value * unitAmount);
  return metric(round(value, 2), 'available', null, { kind: 'estimated_benchmark', benchmarkShare: round(benchmark) });
}

function aggregateSnapshots(rows, side, distinctSummary = null) {
  const amountKnown = rows.every(row => row[side].amountRub !== null);
  return {
    totalUnits: sum(rows.map(row => row[side].totalUnits)), legalUnits: sum(rows.map(row => row[side].legalUnits)),
    individualUnits: sum(rows.map(row => row[side].individualUnits)), unknownUnits: sum(rows.map(row => row[side].unknownUnits)),
    orderCount: finite(distinctSummary?.legalOrderCount ?? distinctSummary?.legalOrders) ? nonNegative(distinctSummary.legalOrderCount ?? distinctSummary.legalOrders) : null,
    amountRub: amountKnown ? sum(rows.map(row => row[side].amountRub)) : null,
    legalAmountRub: rows.every(row => row[side].legalAmountRub !== null) ? sum(rows.map(row => row[side].legalAmountRub)) : null,
    individualAmountRub: rows.every(row => row[side].individualAmountRub !== null) ? sum(rows.map(row => row[side].individualAmountRub)) : null,
    cancelledUnits: sum(rows.map(row => row[side].cancelledUnits)), cancellationResolved: rows.every(row => row[side].cancellationResolved), daily: []
  };
}

function normalizeSummary(value = {}) {
  const hasTopLevelTotals = ['notCancelledUnits', 'activeUnits', 'totalUnits', 'units', 'legalUnits', 'legalNotCancelledUnits'].some(field => finite(value[field]));
  if (hasTopLevelTotals) return normalizeSnapshot(value);
  const daily = Array.isArray(value.daily) ? value.daily : [];
  const snapshots = daily.map(normalizeSnapshot);
  const totalUnits = sum(snapshots.map(row => row.totalUnits));
  const legalUnits = sum(snapshots.map(row => row.legalUnits));
  const individualUnits = sum(snapshots.map(row => row.individualUnits));
  const unknownUnits = sum(snapshots.map(row => row.unknownUnits));
  const amount = field => {
    if (snapshots.every(row => row[field] !== null)) return sum(snapshots.map(row => row[field]));
    if (field === 'amountRub' && totalUnits === 0) return 0;
    if (field === 'legalAmountRub' && legalUnits === 0) return 0;
    if (field === 'individualAmountRub' && individualUnits === 0) return 0;
    return null;
  };
  const distinctOrders = value.legalOrderCount ?? value.legal_order_count ?? value.legalOrders;
  const allDistinctOrders = value.orderCount ?? value.order_count ?? value.orders;
  return {
    totalUnits, legalUnits, individualUnits, unknownUnits,
    orderCount: finite(distinctOrders) ? nonNegative(distinctOrders) : null,
    totalOrderCount: finite(allDistinctOrders) ? nonNegative(allDistinctOrders) : null,
    amountRub: amount('amountRub'), legalAmountRub: amount('legalAmountRub'), individualAmountRub: amount('individualAmountRub'),
    cancelledUnits: sum(snapshots.map(row => row.cancelledUnits)),
    cancellationResolved: snapshots.every(row => row.cancellationResolved),
    cancellationUnknownUnits: sum(snapshots.map(row => row.cancellationUnknownUnits)),
    daily
  };
}

function trend(rows, side, coverage) {
  const days = new Map();
  for (const row of rows) for (const item of row[side].daily) {
    const date = isoDay(item?.date);
    if (!date) continue;
    const snap = normalizeSnapshot(item), bucket = days.get(date) || { totalUnits: 0, legalUnits: 0, orderCount: 0, b2bOrders: 0, amountRub: 0, amountKnown: true, b2bAmountRub: 0, b2bAmountKnown: true };
    bucket.totalUnits += snap.totalUnits; bucket.legalUnits += snap.legalUnits;
    bucket.orderCount += snap.totalOrderCount; bucket.b2bOrders += snap.orderCount;
    if (snap.amountRub === null) bucket.amountKnown = false; else bucket.amountRub += snap.amountRub;
    if (snap.legalAmountRub === null) bucket.b2bAmountKnown = false; else bucket.b2bAmountRub += snap.legalAmountRub;
    days.set(date, bucket);
  }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => {
    const share = value.totalUnits ? value.legalUnits / value.totalUnits : 0;
    return {
      date, totalUnits: round(value.totalUnits, 2), b2bUnits: round(value.legalUnits, 2), b2bShare: round(share),
      orderCount: round(value.orderCount, 2), b2bOrders: round(value.b2bOrders, 2),
      amountRub: value.amountKnown ? round(value.amountRub, 2) : null,
      b2bAmountRub: value.b2bAmountKnown ? round(value.b2bAmountRub, 2) : null,
      b2bAmountStatus: value.b2bAmountKnown && coverage.amounts === 'complete' && coverage.classification === 'complete' ? 'available' : value.b2bAmountKnown ? 'partial' : 'unavailable',
      status: coverage.daily === 'complete' && coverage.classification === 'complete' ? 'available' : coverage.daily === 'unknown' ? 'unavailable' : 'partial'
    };
  });
}

function categoryRows(products, coverage, periodsCompatible, options) {
  const groups = new Map();
  for (const row of products) if (row.category) {
    if (!groups.has(row.category)) groups.set(row.category, []);
    groups.get(row.category).push(row);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([category, rows]) => {
    const rawRows = rows.map(row => row._raw);
    const currentSnapshot = aggregateSnapshots(rawRows, 'current'), previousSnapshot = aggregateSnapshots(rawRows, 'previous');
    const potentialValues = rows.map(row => row.potentialRub).filter(value => value.status === 'available').map(value => value.value);
    return {
      category, productCount: rows.length,
      current: values(currentSnapshot, coverage), previous: values(previousSnapshot, coverage),
      growth: growthMetric(currentSnapshot, previousSnapshot, coverage, periodsCompatible),
      potentialRub: potentialValues.length === rows.length ? metric(round(sum(potentialValues), 2), 'available', null, { kind: 'estimated_benchmark' }) : metric(null, 'unavailable', 'Не для всех товаров категории можно оценить потенциал', { kind: 'estimated_benchmark' }),
      trend: trend(rawRows, 'current', coverage), flags: rows.length < options.minPeers ? [LOW_DATA] : []
    };
  });
}

function analyzeB2BRadar(input = {}, config = {}) {
  const currentPeriod = period(input.currentPeriod, 'текущий'), previousPeriod = period(input.previousPeriod, 'предыдущий');
  const options = { ...DEFAULTS, ...config, periodDays: currentPeriod.days, minObservedDays: Math.min(currentPeriod.days, config.minObservedDays ?? DEFAULTS.minObservedDays) };
  const periodsCompatible = currentPeriod.days === previousPeriod.days;
  const coverage = normalizeCoverage(input.coverage, periodsCompatible);
  const rows = splitRows(input).sort((a, b) => a.id.localeCompare(b.id));
  const products = rows.map(row => {
    const current = values(row.current, coverage), previous = values(row.previous, coverage), flags = [];
    if (row.current.cancelledUnits > 0) flags.push('HAS_CANCELLATIONS');
    if (!row.current.cancellationResolved) flags.push('CANCELLATION_SPLIT_UNKNOWN');
    if (!row.category) flags.push('CATEGORY_UNKNOWN');
    return { id: row.id, market: row.market, storeId: row.storeId, productId: row.productId, sku: row.sku, name: row.name, category: row.category, current, previous, growth: growthMetric(row.current, row.previous, coverage, periodsCompatible), score: 0, scoreStatus: LOW_DATA, zone: LOW_DATA, components: {}, potentialRub: null, flags, _raw: row };
  });
  const score = scoreProducts(products, options);
  for (const row of products) row.potentialRub = potentialFor(row, products, coverage, periodsCompatible, options);
  const categories = categoryRows(products, coverage, periodsCompatible, options);
  const currentTotal = input.summary?.current ? normalizeSummary(input.summary.current) : aggregateSnapshots(rows, 'current', input.summary?.current);
  const previousTotal = input.summary?.previous ? normalizeSummary(input.summary.previous) : aggregateSnapshots(rows, 'previous', input.summary?.previous);
  const potentialValues = products.map(row => row.potentialRub).filter(value => value.status === 'available').map(value => value.value);
  const declaredTotal = input.productCount ?? input.meta?.productCount;
  const total = finite(declaredTotal) ? Math.max(products.length, Math.floor(nonNegative(declaredTotal))) : products.length;
  const truncated = input.truncated === true || total > products.length;
  const highScoreValue = products.filter(row => row.scoreStatus === 'ok' && finite(row.score) && row.score > 80).length;
  const completeScorePopulation = !truncated && coverage.classification === 'complete' && coverage.amounts === 'complete' && coverage.daily === 'complete' && coverage.currentComplete && coverage.previousComplete && coverage.compatibleWithPrevious;
  const highScore = metric(highScoreValue, completeScorePopulation ? 'available' : 'partial', completeScorePopulation ? null : truncated ? 'Счётчик рассчитан только по загруженной части товаров' : 'Счётчик рассчитан по неполному покрытию');
  const kpis = {
    ...values(currentTotal, coverage),
    previousB2bShare: values(previousTotal, coverage).b2bShare,
    b2bGrowth: growthMetric(currentTotal, previousTotal, coverage, periodsCompatible),
    potentialRub: potentialValues.length === products.length && products.length ? metric(round(sum(potentialValues), 2), 'available', null, { kind: 'estimated_benchmark' }) : metric(null, 'unavailable', 'Оценка доступна только при полном покрытии всех товаров', { kind: 'estimated_benchmark' }),
    highScoreCount: highScore,
    scoreOver80: { ...highScore }
  };
  const opportunities = products.filter(row => row.scoreStatus === 'ok' && (row.score >= options.opportunityScore || row.potentialRub.value > 0)).sort((a, b) => (b.potentialRub.value ?? -1) - (a.potentialRub.value ?? -1) || b.score - a.score || a.id.localeCompare(b.id)).map(row => ({
    id: row.id, market: row.market, storeId: row.storeId, productId: row.productId, sku: row.sku, name: row.name, category: row.category,
    score: row.score, zone: row.zone, potentialRub: row.potentialRub, flags: row.flags
  }));
  const zoneNames = ['leaders', 'growth', 'opportunity', 'low', LOW_DATA], zones = Object.fromEntries(zoneNames.map(name => [name, products.filter(row => row.zone === name).length]));
  for (const row of products) delete row._raw;
  products.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.id.localeCompare(b.id));
  const qualityFlags = [];
  if (!periodsCompatible) qualityFlags.push('PERIOD_LENGTH_MISMATCH');
  if (!coverage.compatibleWithPrevious) qualityFlags.push('INCOMPATIBLE_COVERAGE');
  if (coverage.classification !== 'complete') qualityFlags.push('CLASSIFICATION_' + coverage.classification.toUpperCase());
  if (coverage.amounts !== 'complete') qualityFlags.push('AMOUNTS_' + coverage.amounts.toUpperCase());
  return {
    meta: { total, analyzed: products.length, truncated }, periods: { current: currentPeriod, previous: previousPeriod }, coverage, kpis, products, categories, opportunities,
    zones: { ...zones, thresholds: score.thresholds }, trend: trend(input.summary?.current ? [{ current: currentTotal }] : rows, 'current', coverage),
    quality: { rowCount: products.length, scoredCount: products.filter(row => row.scoreStatus === 'ok').length, lowDataCount: products.filter(row => row.scoreStatus === LOW_DATA).length, outliersCapped: score.outliersCapped, flags: qualityFlags }
  };
}

module.exports = { analyzeB2BRadar, LOW_DATA };
