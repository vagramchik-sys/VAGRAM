(function (root, factory) {
  'use strict';
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./focus-model.js'));
  else root.PultSellerHomeModel = factory(root.PultFocus);
})(typeof window !== 'undefined' ? window : globalThis, function (focus) {
  'use strict';
  const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
  const percent = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
  const finite = value => Number.isFinite(value) ? value : null;
  const moscowDay = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const format = (value, units) => value === null ? '—' : number.format(value) + (units ? ' шт.' : ' ₽');
  const alertLabels = { stockout: 'Нет остатка при реализации', cost: 'Заполнить себестоимость', negative: 'Отрицательные начисления', logistics: 'Проверить логистику' };
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
    const metrics = {};
    for (const key of ['orderedRevenue', 'orderedUnits', 'realized', 'net', 'ads', 'stocks']) {
      const metric = data?.metrics?.[key];
      const inventory = key === 'stocks';
      const orders = key.startsWith('ordered');
      const confirmed = inventory || coverage[orders ? 'orders' : 'finance'] === true;
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
    const alerts = data ? focus.build(data).alerts : {};
    const notes = [];
    if (data && !data.stores?.length) notes.push('Нет подключённых магазинов Ozon в выбранном фильтре.');
    else if (data) {
      if (!coverage.orders) notes.push('История заказов загружена не за весь период.');
      if (!coverage.finance) notes.push('Начисления загружены не за весь период.');
      if (open) notes.push('Сегодняшние данные предварительные.');
      if (coverage.foreignRecords) notes.push('Показаны только рублёвые операции.');
    }
    return {
      state, range, scope: unsupported ? 'Wildberries' : store ? 'Ozon · ' + (data?.stores?.find(s => s.id === store)?.name || 'выбранный магазин') : market === 'Ozon' ? 'Ozon · все магазины' : 'Ozon · все магазины · WB отдельно',
      message: state === 'loading' ? 'Загружаем сохранённые данные…' : state === 'error' ? 'Не удалось загрузить данные. Попробуйте ещё раз.' : state === 'unsupported' ? 'Данные Wildberries доступны в отдельной сводке продаж и прибыли.' : '',
      period: { ...period, days: data?.days || (period.from && period.to ? Math.round((Date.parse(period.to) - Date.parse(period.from)) / 86400000) + 1 : 28), open },
      metrics,
      daily: (data?.daily || []).map(day => ({ date: day.date, orderedRevenue: coverage.orders === true ? finite(day.orderedRevenue) : null, realized: coverage.finance === true ? finite(day.realized) : null })),
      alerts: Object.entries(alertLabels).map(([id, label]) => ({ id, label, count: finite(alerts[id]) })),
      freshness: data ? 'Заказы: ' + freshness(sources, open ? 'ordersAt' : 'ordersHistoryAt') + ' · Начисления: ' + freshness(sources, 'financeAt') : '',
      coverageNote: notes.join(' '), stores: data?.stores?.length || 0
    };
  }
  return { build };
});
