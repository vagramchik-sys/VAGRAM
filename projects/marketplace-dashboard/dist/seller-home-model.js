(function (root, factory) {
  'use strict';
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./focus-model.js'));
  else root.PultSellerHomeModel = factory(root.PultFocus);
})(typeof window !== 'undefined' ? window : globalThis, function (focus) {
  'use strict';
  const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
  const percent = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
  const finite = value => Number.isFinite(value) ? value : null;
  const nextDay = value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
    const date = new Date(value + 'T00:00:00Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
  };
  function cumulative(daily, from) {
    const totals = { orderedRevenue: 0, orderedUnits: 0, realized: 0 };
    const known = { orderedRevenue: true, orderedUnits: true, realized: true };
    const dateCounts = new Map();
    for (const day of daily) dateCounts.set(day.date, (dateCounts.get(day.date) || 0) + 1);
    let expected = from;
    let datesKnown = nextDay(from) !== null;
    return daily.map(day => {
      if (!datesKnown || day.date !== expected || dateCounts.get(day.date) !== 1) {
        datesKnown = false;
        for (const key of Object.keys(known)) known[key] = false;
      }
      const result = { date: day.date };
      for (const key of Object.keys(known)) {
        if (known[key] && finite(day[key]) !== null) {
          totals[key] += day[key];
          if (finite(totals[key]) === null) known[key] = false;
        } else known[key] = false;
        result[key] = known[key] ? totals[key] : null;
      }
      expected = datesKnown ? nextDay(expected) : null;
      return result;
    });
  }
  const moscowDay = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  function dates(from, to) {
    if (nextDay(from) === null || nextDay(to) === null || from > to) return null;
    const result = [];
    for (let date = from; date <= to && result.length <= 366; date = nextDay(date)) result.push(date);
    return result.length && result.at(-1) === to ? result : null;
  }
  function dailyEvidence(rows, period) {
    const expected = dates(period.from, period.to);
    if (!expected || !Array.isArray(rows)) return { daily: [], orders: false, finance: false };
    const byDate = new Map();
    for (const row of rows) {
      if (!row || !expected.includes(row.date)) continue;
      const matches = byDate.get(row.date) || [];
      matches.push(row); byDate.set(row.date, matches);
    }
    let orders = true, finance = true;
    const coveredDaily = expected.map(date => {
      const matches = byDate.get(date) || [], row = matches.length === 1 ? matches[0] : null;
      const point = { date, orderedRevenue: finite(row?.orderedRevenue), orderedUnits: finite(row?.orderedUnits), realized: finite(row?.realized) };
      if (!row || point.orderedRevenue === null || point.orderedUnits === null) orders = false;
      if (!row || point.realized === null) finance = false;
      return point;
    });
    return { daily: coveredDaily, coveredDaily, orders, finance };
  }
  function agrees(value, daily, key) {
    value = finite(value);
    if (value === null || daily.some(day => finite(day[key]) === null)) return false;
    const total = daily.reduce((sum, day) => sum + day[key], 0);
    return Number.isFinite(total) && Math.abs(total - value) <= Math.max(1e-7, Math.abs(value) * 1e-10);
  }
  const format = (value, units) => value === null ? '—' : number.format(value) + (units ? ' шт.' : ' ₽');
  const alertLabels = { stockout: 'Нет остатка при реализации', cost: 'Заполнить себестоимость', negative: 'Отрицательные начисления', logistics: 'Проверить логистику' };
  const alertDescriptions = { stockout: 'Есть реализация, текущий остаток нулевой', cost: 'У товаров с реализацией нет положительной себестоимости', negative: 'Начисления по SKU за период ниже нуля', logistics: 'Логистика составляет от 30% реализации' };
  function freshness(sources, field) {
    const dates = sources.map(s => Date.parse(s[field]));
    if (!dates.length || dates.some(d => !Number.isFinite(d))) return 'нет полного снимка';
    return new Date(Math.min(...dates)).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' МСК';
  }
  function build({ state = 'loading', report, market = '', store = '', range = '28', from = '', to = '' } = {}, now = new Date()) {
    const unsupported = market === 'WB' || market === 'Wildberries' || store.startsWith('wb-');
    if (unsupported) state = 'unsupported';
    // Only the report for the current successful request may feed the homepage.
    const data = state === 'ready' ? report : null;
    const period = data?.current || { from, to };
    const open = Boolean(period.from && period.to && period.from <= moscowDay(now) && period.to >= moscowDay(now));
    const sources = data?.sources || [];
    const coverage = data?.coverage || {};
    const evidence = dailyEvidence(data?.daily, period);
    const ordersComplete = coverage.orders === true && evidence.orders
      && agrees(data?.metrics?.orderedRevenue?.current, evidence.coveredDaily, 'orderedRevenue')
      && agrees(data?.metrics?.orderedUnits?.current, evidence.coveredDaily, 'orderedUnits');
    const financeComplete = coverage.finance === true && evidence.finance
      && agrees(data?.metrics?.realized?.current, evidence.coveredDaily, 'realized');
    const metrics = {};
    for (const key of ['orderedRevenue', 'orderedUnits', 'realized', 'net', 'ads', 'stocks']) {
      const metric = data?.metrics?.[key];
      const inventory = key === 'stocks';
      const orders = key.startsWith('ordered');
      const confirmed = inventory || (orders ? ordersComplete : financeComplete);
      const previousConfirmed = coverage[orders ? 'previousOrders' : 'previousFinance'] === true;
      const value = confirmed ? finite(metric?.current) : null;
      const previous = previousConfirmed ? finite(metric?.previous) : null;
      let comparison = inventory ? 'Текущий снимок' : value === null ? 'Нет полного периода' : open ? 'Период ещё не завершён' : 'Нет данных для сравнения';
      let tone = '';
      if (!inventory && !open && value !== null && previous !== null) {
        const delta = value - previous;
        if (delta === 0) comparison = 'Без изменений к прошлому периоду';
        else if (previous === 0) comparison = 'В прошлом периоде: 0';
        else { comparison = (delta > 0 ? '+' : '−') + percent.format(Math.abs(delta / previous * 100)) + '% к прошлому периоду'; tone = delta > 0 ? 'up' : 'down'; }
      }
      metrics[key] = { value, text: format(value, key === 'stocks' || key === 'orderedUnits'), comparison, tone };
    }
    const focusData = data ? focus.build({ ...data, coverage: { ...coverage, orders: ordersComplete, finance: financeComplete } }) : null;
    const alerts = focusData?.alerts || {};
    const positiveProducts = (focusData?.products || []).filter(p => finite(p.realized) !== null && p.realized > 0)
      .sort((a, b) => b.realized - a.realized || String(a.focusId).localeCompare(String(b.focusId)));
    const positiveRevenue = positiveProducts.reduce((total, p) => total + p.realized, 0);
    const leaders = positiveProducts.slice(0, 5).map(p => ({
      key: p.focusId, sku: String(p.sku), name: p.name || 'SKU ' + p.sku,
      offerId: p.offer_id || '', storeName: p.storeName || '',
      realizedText: format(p.realized, false), share: positiveRevenue > 0 ? p.realized / positiveRevenue * 100 : 0
    }));
    const attentionCount = focusData?.complete ? new Set(focusData.products.filter(p => p.signals.length).map(p => p.focusId)).size : null;
    const complete = financeComplete && ordersComplete;
    const coverageState = !complete ? 'partial' : open ? 'open' : 'complete';
    const notes = [];
    if (data && !data.stores?.length) notes.push('Нет подключённых магазинов Ozon в выбранном фильтре.');
    else if (data) {
      if (!ordersComplete) notes.push('История заказов загружена не за весь период.');
      if (!financeComplete) notes.push('Начисления загружены не за весь период.');
      if (open) notes.push('Сегодняшние данные предварительные.');
      if (coverage.foreignRecords) notes.push('Показаны только рублёвые операции.');
    }
    // Declared incomplete domains are not trustworthy across the selected shop scope.
    // Within a declared covered domain, keep known points but never fill a gap with zero.
    const daily = evidence.daily.map(day => ({
      date: day.date,
      orderedRevenue: coverage.orders === true ? day.orderedRevenue : null,
      orderedUnits: coverage.orders === true ? day.orderedUnits : null,
      realized: coverage.finance === true ? day.realized : null
    }));
    return {
      state, range, scope: unsupported ? 'Wildberries' : store ? 'Ozon · ' + (data?.stores?.find(s => s.id === store)?.name || 'выбранный магазин') : market === 'Ozon' ? 'Ozon · все магазины' : 'Ozon · все магазины · WB отдельно',
      message: state === 'loading' ? 'Загружаем сохранённые данные…' : state === 'error' ? 'Не удалось загрузить данные. Попробуйте ещё раз.' : state === 'unsupported' ? 'Данные Wildberries доступны в отдельной сводке продаж и прибыли.' : '',
      period: { ...period, days: data?.days || (period.from && period.to ? Math.round((Date.parse(period.to) - Date.parse(period.from)) / 86400000) + 1 : 28), open },
      metrics,
      daily,
      cumulativeDaily: cumulative(daily, period.from),
      alerts: Object.entries(alertLabels).map(([id, label]) => ({ id, label, description: alertDescriptions[id], count: finite(alerts[id]) }))
        .sort((a, b) => Number(b.count > 0) - Number(a.count > 0)),
      leaders, attentionCount, coverageState,
      coverageLabel: coverageState === 'complete' ? 'Период загружен' : coverageState === 'open' ? 'Сегодняшние данные предварительные' : 'Данные загружены частично',
      freshness: data ? 'Заказы: ' + freshness(sources, open ? 'ordersAt' : 'ordersHistoryAt') + ' · Начисления: ' + freshness(sources, 'financeAt') : '',
      coverageNote: notes.join(' '), stores: data?.stores?.length || 0
    };
  }
  return { build };
});
