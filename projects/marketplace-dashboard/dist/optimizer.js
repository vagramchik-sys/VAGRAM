(function (scope) {
  'use strict';

  const LIMIT = 50;
  const moneyFormatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
  const bidFormatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 6 });
  const countFormatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
  const percentFormatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
  const stateNames = Object.freeze({ BASELINE: 'Наблюдение', PRICE_UP: 'Поднять цену', WAIT_PRICE: 'Проверяем цену', BID_UP: 'Поднять ставку', WAIT_ADS: 'Проверяем рекламу', WAIT_ECONOMICS: 'WAIT_ECONOMICS · Ожидаем экономику', HOLD: 'Без изменений', ROLLBACK: 'Вернуть изменение', BLOCKED: 'Нет рекомендации' });
  const confidenceNames = Object.freeze({ HIGH: 'Высокая', MEDIUM: 'Средняя', LOW: 'Низкая' });

  function numeric(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && /^-?(?:\d+)(?:\.\d+)?$/u.test(value.trim())) {
      const converted = Number(value);
      return Number.isFinite(converted) ? converted : null;
    }
    return null;
  }
  function money(value) { const amount = numeric(value); return amount === null ? '—' : moneyFormatter.format(amount) + ' ₽'; }
  function bid(value) { const amount = numeric(value); return amount === null ? '—' : bidFormatter.format(amount) + ' ₽'; }
  function bidComparison(ad = {}) {
    const current = numeric(ad.currentBid), competitive = numeric(ad.competitiveBid);
    return { belowMarketPct: current !== null && competitive > 0 ? (competitive - current) / competitive * 100 : null,
      roomPct: current > 0 && competitive !== null ? (competitive - current) / current * 100 : null };
  }
  function bidComparisonText(ad = {}) {
    const {belowMarketPct} = bidComparison(ad);
    const comparison = belowMarketPct === null ? 'Сравнение недоступно' : belowMarketPct === 0 ? 'На уровне конкурентной' : (belowMarketPct > 0 ? 'ниже рынка на ' : 'выше рынка на ') + percent(Math.abs(belowMarketPct));
    return ['Текущая ' + bid(ad.currentBid), 'Конкурентная ' + bid(ad.competitiveBid), comparison].join(' · ');
  }
  function competitiveRoom(ad = {}) { const value = bidComparison(ad).roomPct; return value === null ? '—' : (value > 0 ? '+' : '') + percent(value); }
  function confirmedBidValues(economics = {}, optimizer = {}) {
    const cap = economics.confirmed === true ? numeric(optimizer.maxProfitableBid) : null;
    const recommended = economics.confirmed === true ? numeric(optimizer.recommendedBid) : null;
    return {cap, recommended: cap !== null && recommended !== null && recommended <= cap ? recommended : null,
      contribution: economics.confirmed === true ? numeric(economics.contributionAfterAds) : null};
  }
  function count(value) { const amount = numeric(value); return amount === null ? '—' : countFormatter.format(amount); }
  function percent(value) { const amount = numeric(value); return amount === null ? '—' : percentFormatter.format(amount) + ' %'; }
  function dateTime(value) { const time = Date.parse(value); return Number.isFinite(time) ? new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Moscow' }).format(time) + ' МСК' : '—'; }
  function adsCoverage(payload) {
    const items = safeItems(payload), statistics = items.map(item => item?.advertising).filter(ad => ad?.periodFrom && ad?.periodTo);
    const observed = statistics.map(ad => Date.parse(ad.observedAt)).filter(Number.isFinite).sort((a, b) => a - b);
    return {
      hasLocalRows: Math.max(0, Number(payload?.total) || 0) > 0,
      hasStatistics: statistics.length > 0,
      complete: payload?.summary?.complete === true,
      from: statistics.map(ad => ad.periodFrom).sort()[0] || null,
      to: statistics.map(ad => ad.periodTo).sort().at(-1) || null,
      observedAt: observed.length ? new Date(observed[0]).toISOString() : null
    };
  }
  function adsPeriodText(payload) {
    const requested = payload?.period?.from && payload?.period?.to ? `Запрошенный период: ${payload.period.from} — ${payload.period.to}` : 'Запрошенный период не указан';
    const coverage = adsCoverage(payload);
    if (coverage.hasStatistics) return `${requested} · доступная локальная статистика на этой странице: ${coverage.from} — ${coverage.to} · обновлена ${dateTime(coverage.observedAt)}`;
    return `${requested} · статистика за период ещё не накоплена · экран сформирован ${dateTime(payload?.generatedAt)}`;
  }
  function listParams(filters, offset) {
    const params = new URLSearchParams({ limit: String(LIMIT), offset: String(offset) });
    for (const name of ['store', 'campaign', 'search']) {
      const value = String(filters?.[name] || '').trim();
      if (value) params.set(name, value);
    }
    return params;
  }
  function settingsUrl(storeId) {
    const value = String(storeId || '').trim();
    return value ? `/api/optimizer/settings?${new URLSearchParams({ store: value })}` : '/api/optimizer/settings';
  }
  function safeItems(payload) { return Array.isArray(payload?.items) ? payload.items.slice(0, LIMIT) : []; }
  function filterPageItems(items, filters, pageName) {
    return items.filter(item => {
      const state = item.optimizer?.state;
      return (!filters.state || state === filters.state)
        && (!filters.confidence || item.optimizer?.confidence === filters.confidence)
        && (!filters.onlyScalable || state === (pageName === 'ads' ? 'BID_UP' : 'PRICE_UP'))
        && (!filters.onlyBlocked || ['BLOCKED', 'WAIT_ECONOMICS'].includes(state));
    });
  }

  if (typeof module === 'object' && module.exports) module.exports = { LIMIT, numeric, money, bid, bidComparison, bidComparisonText, competitiveRoom, confirmedBidValues, count, percent, dateTime, adsCoverage, adsPeriodText, listParams, safeItems, filterPageItems };
  if (!scope?.document) return;

  const document = scope.document;
  const page = document.body?.dataset.optimizerPage;
  if (!['prices', 'ads'].includes(page)) return;
  const $ = id => document.getElementById(id);
  const form = $('optimizer-filters');
  const rows = $('optimizer-rows');
  const dialog = $('optimizer-detail');
  const state = { offset: 0, total: 0, payload: null, shown: 0, loading: null, requestId: 0, settingsRequestId: 0, detailId: 0 };
  const rowColumns = page === 'prices' ? 12 : 16;

  async function api(url, options) {
    const response = await scope.fetch(url, { credentials: 'same-origin', ...options });
    let value;
    try { value = await response.json(); } catch { throw Error(response.status === 404 ? 'Обновление Пульта ещё не включено на этом сервере.' : 'Сервер вернул неполный ответ.'); }
    if (!response.ok) throw Error(typeof value?.error === 'string' && value.error.length < 300 ? value.error : 'Данные временно недоступны.');
    return value;
  }
  function announce(message, tone = 'info', link = null) {
    const element = $('optimizer-notice');
    element.replaceChildren(document.createTextNode(message));
    if (link) {
      const anchor = document.createElement('a');
      anchor.href = link.href; anchor.textContent = link.text;
      element.append(document.createTextNode(' '), anchor);
    }
    element.dataset.tone = tone;
    element.hidden = !message;
  }
  function textCell(tr, value, className = '') {
    const cell = document.createElement('td');
    cell.textContent = value == null ? '—' : String(value);
    if (className) cell.className = className;
    tr.append(cell);
    return cell;
  }
  function productCell(tr, item) {
    const cell = document.createElement('td');
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'product-button';
    button.textContent = item.product?.name || 'Товар без названия';
    button.addEventListener('click', () => openDetail(item));
    cell.append(button);
    const sub = document.createElement('span'); sub.className = 'secondary-line';
    sub.textContent = [item.product?.offerId, item.product?.sku, page === 'ads' ? item.campaign?.name : null].filter(Boolean).join(' · ') || 'Артикул не указан';
    cell.append(sub); tr.append(cell); return cell;
  }
  function stateCell(tr, optimizer) {
    const cell = document.createElement('td');
    const badge = document.createElement('span'); badge.className = 'optimizer-state';
    badge.dataset.state = optimizer?.state || 'BLOCKED';
    badge.textContent = stateNames[optimizer?.state] || 'Не определено';
    cell.append(badge);
    const reason = document.createElement('span'); reason.className = 'optimizer-reason';
    reason.textContent = optimizer?.humanReason || 'Причина ещё не рассчитана.';
    cell.append(reason);
    const confidence = document.createElement('span'); confidence.className = 'secondary-line';
    confidence.textContent = 'Уверенность: ' + (confidenceNames[optimizer?.confidence] || 'не указана');
    cell.append(confidence); tr.append(cell);
  }
  function renderPriceRow(item) {
    const tr = document.createElement('tr');
    productCell(tr, item);
    textCell(tr, item.product?.storeName || item.product?.storeId);
    textCell(tr, count(item.stock?.quantity), 'number');
    textCell(tr, count(item.stock?.days), 'number');
    textCell(tr, money(item.cost?.unitCost), 'number');
    textCell(tr, money(item.price?.sellerPrice), 'number main-number');
    textCell(tr, money(item.price?.customerPrice), 'number');
    textCell(tr, money(item.price?.sellerCustomerDifference), 'number');
    textCell(tr, money(item.economics?.contributionPerOrder), 'number');
    textCell(tr, percent(item.economics?.marginPct), 'number');
    textCell(tr, money(item.optimizer?.recommendedPrice), 'number main-number');
    stateCell(tr, item.optimizer);
    return tr;
  }
  function renderAdsRow(item) {
    const tr = document.createElement('tr');
    const product = productCell(tr, item), values = confirmedBidValues(item.economics, item.optimizer);
    const comparison = document.createElement('span'); comparison.className = 'secondary-line';
    comparison.textContent = bidComparisonText(item.advertising);
    product.append(comparison);
    if (item.economics?.confirmed !== true) {
      const reason = document.createElement('span'); reason.className = 'optimizer-reason';
      reason.textContent = 'Экономика SKU неполная'; product.append(reason);
    }
    textCell(tr, bid(item.advertising?.currentBid), 'number main-number');
    textCell(tr, bid(item.advertising?.competitiveBid), 'number');
    textCell(tr, bid(values.cap), 'number');
    textCell(tr, bid(values.recommended), 'number main-number');
    textCell(tr, competitiveRoom(item.advertising), 'number');
    textCell(tr, count(item.advertising?.impressions), 'number');
    textCell(tr, count(item.advertising?.clicks), 'number');
    textCell(tr, percent(item.advertising?.ctrPct), 'number');
    textCell(tr, money(item.advertising?.cpc), 'number');
    textCell(tr, count(item.advertising?.orders), 'number');
    textCell(tr, percent(item.advertising?.cvrPct), 'number');
    textCell(tr, money(item.advertising?.spend), 'number');
    textCell(tr, percent(item.advertising?.drrPct), 'number');
    textCell(tr, money(values.contribution), 'number');
    stateCell(tr, item.optimizer);
    return tr;
  }
  function renderRows(payload) {
    const items = filterPageItems(safeItems(payload), readFilters(), page);
    state.shown = items.length;
    const fragment = document.createDocumentFragment();
    if (!items.length) {
      const tr = document.createElement('tr');
      const td = textCell(tr, safeItems(payload).length ? 'На этой странице нет строк с таким решением. Посмотрите следующую страницу.' : 'По выбранным фильтрам данных пока нет.', 'optimizer-empty');
      td.colSpan = rowColumns; fragment.append(tr);
    } else for (const item of items) fragment.append(page === 'prices' ? renderPriceRow(item) : renderAdsRow(item));
    rows.replaceChildren(fragment);
  }
  function metric(label, value, note) {
    const article = document.createElement('article'); article.className = 'optimizer-kpi';
    const span = document.createElement('span'); span.textContent = label;
    const strong = document.createElement('strong'); strong.textContent = value;
    const small = document.createElement('small'); small.textContent = note;
    article.append(span, strong, small); return article;
  }
  function renderKpis(summary = {}) {
    const spec = page === 'prices' ? [
      ['Для повышения цены', 'priceUpCount', count], ['Наблюдаем', 'observingCount', count],
      ['Заблокировано', 'blockedCount', count], ['Откат', 'rollbackCount', count],
      ['Разница цен', 'averageSellerCustomerDifference', money],
      ['Потенциал прибыли', 'potentialContributionIncrease', money]
    ] : [
      ['Расходы на рекламу', 'spend', money], ['Рекламная выручка', 'revenue', money],
      ['Общий ДРР', 'drrPct', percent], ['SKU ниже конкурентной ставки', 'belowCompetitiveCount', count],
      ['SKU с рекламой', 'advertisedSkuCount', count], ['SKU с достаточной статистикой', 'sufficientStatisticsSkuCount', count],
      ['Вклад SKU после рекламы', 'contributionAfterAds', money]
    ];
    const note = summary.complete === true ? 'Подтверждённые данные' : 'Данные могут быть неполными';
    $('optimizer-kpis').replaceChildren(...spec.map(([label, key, format]) => {
      let detail = note;
      if (page === 'ads') {
        detail = summary.complete === true ? 'За выбранный период' : 'По доступным строкам · данные неполные';
        if (key === 'drrPct') detail = 'Расходы / выручка строк, где известны обе суммы';
        if (key === 'advertisedSkuCount' || key === 'belowCompetitiveCount') detail = 'По магазинам · без повторов между кампаниями';
        if (key === 'sufficientStatisticsSkuCount') {
          const t = summary.statisticsThresholds;
          detail = t ? 'Полный период · от ' + count(t.minImpressions) + ' показов, ' + count(t.minClicks) + ' кликов, ' + count(t.minOrders) + ' заказов' : 'Недостаточно данных для оценки';
        }
        if (key === 'contributionAfterAds') detail = summary.economicsComplete === true ? 'По SKU, без повторов между кампаниями' : 'Экономика SKU неполная';
      }
      return metric(label, format(key === 'contributionAfterAds' && summary.economicsComplete !== true ? null : summary[key]), detail);
    }));
  }
  function renderMode(settings, caps = {}) {
    const element = $('optimizer-mode');
    element.replaceChildren();
    const lead = document.createElement('strong'); lead.textContent = 'Режим рекомендаций'; element.append(lead);
    for (const mode of ['OBSERVE', 'RECOMMEND', 'AUTO']) {
      const span = document.createElement('span');
      span.className = 'optimizer-pill' + (mode === 'AUTO' ? ' optimizer-locked' : '');
      span.textContent = mode === 'AUTO' ? 'AUTO · недоступен' : mode + (settings?.mode === mode ? ' · активен' : '');
      element.append(span);
    }
    const kill = document.createElement('span'); kill.className = 'optimizer-kill';
    kill.dataset.status = settings?.killSwitch === true ? 'on' : settings?.killSwitch === false ? 'off' : 'unknown';
    kill.textContent = settings?.killSwitch === true ? 'Аварийная блокировка: ВКЛ' : settings?.killSwitch === false ? 'Аварийная блокировка: ВЫКЛ' : 'Аварийная блокировка: статус не получен';
    element.append(kill);
    if (caps?.auto === true || caps?.priceWrite === true || caps?.bidWrite === true) announce('Неожиданный режим записи. Проверьте настройки перед работой.', 'warn');
  }
  function replaceOptions(select, options, chosen) {
    const previous = chosen ?? select.value;
    const first = select.options[0]?.cloneNode(true) || document.createElement('option');
    const fragment = document.createDocumentFragment(); fragment.append(first);
    const seen = new Set();
    for (const item of options) {
      const id = String(item?.id || '');
      if (!id || seen.has(id)) continue; seen.add(id);
      const option = document.createElement('option'); option.value = id;
      option.textContent = item?.name ? String(item.name) : id;
      fragment.append(option);
    }
    select.replaceChildren(fragment); select.value = previous;
    if (select.value !== previous) select.value = '';
  }
  function renderFilters(payload) {
    const candidates = Array.isArray(payload?.filterOptions?.campaigns) ? payload.filterOptions.campaigns : [];
    const campaigns = candidates.filter(item => !form.elements.store.value || item.storeId === form.elements.store.value)
      .map(item => ({ id: item.id, name: item.name ? `${item.name} · ${item.id}` : item.id }));
    replaceOptions($('optimizer-campaign'), campaigns);
  }
  function renderConnection(payload) {
    const connection = payload?.connection;
    const missing = connection?.status === 'not_connected' || (Array.isArray(connection?.stores) && connection.stores.length > 0 && connection.stores.every(store => store.configured === false));
    const coverage = page === 'ads' ? adsCoverage(payload) : null;
    if (missing) announce(coverage?.hasLocalRows ? 'Performance API не подключён. Показываем ранее сохранённые локально кампании и товары; новые рекламные показатели пока недоступны.' : 'Performance API не подключён. Рекламные показатели и рекомендации по ставкам пока недоступны.', 'warn', { href: '/connections.html#performance', text: 'Подключить рекламу →' });
    else if (coverage && !coverage.complete) announce(coverage.hasStatistics ? 'Показаны сохранённые локально кампании и товары. Статистика покрывает часть выбранного периода; пропуски показаны знаком «—» и не считаются нулём. Полная история накопится постепенно при ежедневных загрузках.' : 'Показаны сохранённые локально кампании и товары. Статистика за выбранный период ещё не накоплена; пропуски показаны знаком «—» и не считаются нулём. Полная история накопится постепенно при ежедневных загрузках.', 'warn');
    else if (payload?.summary?.complete === false) announce('Данные загружены частично. Пропуски показаны знаком «—» и не считаются нулём.', 'warn');
    else announce('');
  }
  function renderPager() {
    const first = state.total ? state.offset + 1 : 0;
    const last = Math.min(state.total, state.offset + LIMIT);
    $('optimizer-page-info').textContent = `Показано ${count(first)}–${count(last)} из ${count(state.total)}`;
    $('optimizer-prev').disabled = state.offset <= 0;
    $('optimizer-next').disabled = state.offset + LIMIT >= state.total;
    $('optimizer-count').textContent = `${count(state.total)} строк · ${count(state.shown)} показано на странице`;
  }
  function readFilters() {
    return { store: form.elements.store.value, campaign: form.elements.campaign.value, search: form.elements.search.value,
      state: form.elements.state.value, confidence: form.elements.confidence.value,
      onlyScalable: form.elements.onlyScalable.checked, onlyBlocked: form.elements.onlyBlocked.checked };
  }
  async function loadList() {
    state.loading?.abort();
    const controller = new AbortController(); state.loading = controller;
    const requestId = ++state.requestId;
    const params = listParams(readFilters(), state.offset);
    $('optimizer-reload').disabled = true;
    try {
      const payload = await api(`/api/optimizer/${page}?${params}`, { signal: controller.signal });
      if (requestId !== state.requestId) return;
      state.total = Math.max(0, Number(payload.total) || 0); state.payload = payload;
      renderKpis(payload.summary); renderRows(payload); renderFilters(payload); renderPager(); renderConnection(payload);
      const period = payload.period;
      $('optimizer-period').textContent = page === 'ads' ? adsPeriodText(payload) : period?.from && period?.to ? `Период: ${period.from} — ${period.to} · данные на ${dateTime(payload.generatedAt)}` : `Данные на ${dateTime(payload.generatedAt)}`;
      renderMode(state.settings, payload.capabilities);
    } catch (error) {
      if (error?.name === 'AbortError' || requestId !== state.requestId) return;
      state.total = 0; state.shown = 0; state.payload = null; renderPager();
      const tr = document.createElement('tr'); const td = textCell(tr, 'Не удалось загрузить данные. Повторите запрос.', 'optimizer-empty'); td.colSpan = rowColumns; rows.replaceChildren(tr);
      announce(error?.message || 'Данные временно недоступны.', 'error');
    } finally { if (requestId === state.requestId) { state.loading = null; $('optimizer-reload').disabled = false; } }
  }
  function detailSection(title, pairs, extra = '', full = false) {
    const section = document.createElement('section'); section.className = 'optimizer-detail-section' + (full ? ' full' : '');
    const heading = document.createElement('h3'); heading.textContent = title; section.append(heading);
    const dl = document.createElement('dl');
    for (const [label, value] of pairs) {
      const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value;
      dl.append(dt, dd);
    }
    section.append(dl);
    if (extra) { const paragraph = document.createElement('p'); paragraph.textContent = extra; section.append(paragraph); }
    return section;
  }
  function renderDetail(detail, fallback) {
    const item = detail.item || fallback;
    const product = item.product || detail.product || fallback.product || {};
    const price = detail.price || item.price || {};
    const cost = detail.cost || item.cost || {};
    const stock = detail.stock || item.stock || {};
    const advertising = detail.advertising || item.advertising || {};
    const ads = Array.isArray(advertising) ? (advertising.find(entry => entry?.campaign?.id === item.campaign?.id) || advertising[0] || {}) : advertising;
    const economics = detail.economics || item.economics || {};
    const optimizer = detail.optimizer || item.optimizer || {};
    const automation = detail.automation || {};
    const bidValues = confirmedBidValues(economics, optimizer);
    $('optimizer-detail-title').textContent = product.name || 'Товар';
    const blocks = [
      detailSection('PRICE · ЦЕНА', [['Цена продавца', money(price.sellerPrice)], ['Цена покупателя', money(price.customerPrice)], ['Разница', money(price.sellerCustomerDifference)], ['Следующая цена', money(optimizer.recommendedPrice)], ['Источник цены покупателя', price.customerPriceSource || 'Не подтверждён']]),
      detailSection('ADVERTISING · РЕКЛАМА', [['Текущая ставка', bid(ads.currentBid)], ['Конкурентная ставка', bid(ads.competitiveBid)], ['Прибыльный потолок', bid(bidValues.cap)], ['Рекомендация', bid(bidValues.recommended)], ['Минимальная ставка', bid(ads.minimumBid)], ['Запас до конкурентной', competitiveRoom(ads)], ['Показы / клики / заказы', [count(ads.impressions), count(ads.clicks), count(ads.orders)].join(' / ')], ['Расход / ДРР', `${money(ads.spend)} / ${percent(ads.drrPct)}`]], ads.connected === false ? 'Performance API не подключён.' : bidComparisonText(ads)),
      detailSection('ECONOMICS · ЭКОНОМИКА', [['Себестоимость', money(cost.unitCost)], ['Остаток', count(stock.quantity)], ['Запас в днях', count(stock.days)], ['До рекламы', money(economics.contributionBeforeAds)], ['После рекламы, весь SKU', money(bidValues.contribution)], ['На заказ', money(economics.contributionPerOrder)], ['Маржа', percent(economics.marginPct)]], economics.confirmed === true ? 'Вклад по всему SKU, а не только по выбранной кампании.' : 'Экономика SKU неполная'),
      detailSection('OPTIMIZER · РЕШЕНИЕ', [['Состояние', stateNames[optimizer.state] || optimizer.state || '—'], ['Следующее действие', optimizer.action || 'NONE'], ['Уверенность', confidenceNames[optimizer.confidence] || '—'], ['Блокировки', Array.isArray(optimizer.blockers) && optimizer.blockers.length ? optimizer.blockers.join(', ') : '—']], optimizer.humanReason || 'Причина ещё не рассчитана.', true),
      detailSection('AUTO · БЕЗОПАСНОСТЬ', [['Цена', automation.price?.state || 'HOLD'], ['Ставка', automation.bid?.state || 'HOLD']],
        `Цена: ${automation.price?.humanReason || 'Нет подтверждённых условий.'} Ставка: ${automation.bid?.humanReason || 'Нет подтверждённых условий.'}`, true)
    ];
    const history = document.createElement('section'); history.className = 'optimizer-detail-section full';
    const heading = document.createElement('h3'); heading.textContent = 'HISTORY · ИСТОРИЯ'; history.append(heading);
    const events = Array.isArray(detail.history) ? detail.history.slice(0, 30) : [];
    if (!events.length) { const note = document.createElement('p'); note.textContent = 'Локальных экспериментов и решений пока нет.'; history.append(note); }
    for (const event of events) {
      const line = document.createElement('div'); line.className = 'optimizer-detail-event';
      line.textContent = `${dateTime(event.at || event.observedAt || event.startedAt || event.createdAt)} · ${event.dimension || event.action || event.state || 'Событие'} · ${event.humanReason || event.status || ''}`;
      history.append(line);
    }
    blocks.push(history); $('optimizer-detail-body').replaceChildren(...blocks);
  }
  async function openDetail(item) {
    const id = item.product?.id, store = item.product?.storeId;
    if (!id || !store) return;
    const detailId = ++state.detailId;
    $('optimizer-detail-title').textContent = item.product.name || 'Товар';
    $('optimizer-detail-body').textContent = 'Загружаем карточку…';
    if (!dialog.open) dialog.showModal();
    const params = new URLSearchParams({ store: String(store) });
    if (item.campaign?.id) params.set('campaign', String(item.campaign.id));
    try {
      const detail = await api(`/api/optimizer/sku/${encodeURIComponent(id)}?${params}`);
      if (detailId === state.detailId && dialog.open) renderDetail(detail, item);
    } catch (error) { if (detailId === state.detailId && dialog.open) $('optimizer-detail-body').textContent = error?.message || 'Карточка временно недоступна.'; }
  }
  async function loadSettings() {
    const requestId = ++state.settingsRequestId;
    try {
      const result = await api(settingsUrl(form.elements.store.value));
      if (requestId !== state.settingsRequestId) return;
      state.settings = result.settings || null; renderMode(state.settings, result.capabilities);
    } catch { if (requestId === state.settingsRequestId) { state.settings = null; renderMode(null, {}); } }
  }
  async function loadStores() {
    try {
      const result = await api('/api/stores');
      const stores = (Array.isArray(result) ? result : result?.stores || []).filter(item => item?.market !== 'WB' && !String(item?.id).startsWith('wb-'));
      replaceOptions($('optimizer-store'), stores);
    } catch { /* List data remains accessible even if the store selector cannot refresh. */ }
  }
  let searchTimer;
  form.addEventListener('input', event => { if (event.target.name !== 'search') return; clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.offset = 0; loadList(); }, 250); });
  form.addEventListener('change', event => { if (event.target.name === 'search') return; if (['state', 'confidence', 'onlyScalable', 'onlyBlocked'].includes(event.target.name)) { if (state.payload) { renderRows(state.payload); renderPager(); } return; } state.offset = 0; if (event.target.name === 'store') { $('optimizer-campaign').value = ''; loadSettings(); } loadList(); });
  form.addEventListener('submit', event => event.preventDefault());
  $('optimizer-prev').addEventListener('click', () => { if (state.offset > 0) { state.offset -= LIMIT; loadList(); } });
  $('optimizer-next').addEventListener('click', () => { if (state.offset + LIMIT < state.total) { state.offset += LIMIT; loadList(); } });
  $('optimizer-reload').addEventListener('click', () => { loadSettings(); loadList(); });
  $('optimizer-detail-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => { state.detailId++; });
  renderKpis({ complete: false });
  Promise.allSettled([loadSettings(), loadStores(), loadList()]);
})(typeof window === 'undefined' ? null : window);
