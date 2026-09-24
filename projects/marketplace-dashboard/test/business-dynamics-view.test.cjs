const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'dist', 'business-dynamics-view.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'dist', 'business-dynamics.css'), 'utf8');

class FakeNode {
  constructor(name = 'node') {
    this.name = name;
    this.listeners = new Map();
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.innerHTML = '';
    this.textContent = '';
  }
  addEventListener(type, fn) { const rows = this.listeners.get(type) || []; rows.push(fn); this.listeners.set(type, rows); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== fn)); }
  emit(type, event = {}) { for (const fn of [...(this.listeners.get(type) || [])]) fn({ type, target: this, preventDefault() {}, clientX: 0, ...event }); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  closest() { return null; }
  replaceChildren() { this.innerHTML = ''; this.textContent = ''; }
}

function harness(now = Date.parse('2026-09-24T12:40:00+03:00')) {
  let nextTimer = 1;
  const timers = new Map(), cleared = [];
  class Clock extends Date { static now() { return now; } }
  const host = new FakeNode('host');
  let html = '', root = null, retry = null;
  Object.defineProperty(host, 'innerHTML', {
    get() { return html; },
    set(value) {
      html = String(value);
      retry = html.includes('bd-retry') ? new FakeNode('retry') : null;
      if (!html.includes('class="business-dynamics')) { root = null; return; }
      root = new FakeNode('root');
      const chart = html.includes('class="bd-chart"') ? new FakeNode('chart') : null;
      const tooltip = new FakeNode('tooltip'); tooltip.hidden = true;
      tooltip.getBoundingClientRect = () => ({ width: 240 });
      const detail = new FakeNode('detail'); detail.hidden = true;
      const cursor = new FakeNode('cursor'); cursor.setAttribute('hidden', '');
      const focus = new FakeNode('focus'); focus.setAttribute('hidden', '');
      const freshness = new FakeNode('freshness'), freshnessText = new FakeNode('freshness-text');
      freshness.querySelector = selector => selector === 'span' ? freshnessText : null;
      if (chart) {
        const attr = name => html.match(new RegExp('data-' + name + '="([^"]+)"'))?.[1];
        chart.dataset.activeIndex = attr('active-index') || '0';
        chart.dataset.min = attr('min'); chart.dataset.max = attr('max'); chart.dataset.domain = attr('domain');
        chart.querySelector = selector => selector === '.bd-chart__cursor' ? cursor : selector === '.bd-chart__focus' ? focus : null;
        chart.getBoundingClientRect = () => ({ left: 0, width: 1000 });
      }
      const points = new FakeNode('points');
      points.textContent = html.match(/<script type="application\/json" class="bd-points">([\s\S]*?)<\/script>/)?.[1] || '[]';
      points.remove = () => {};
      root.querySelector = selector => ({
        '.bd-chart': chart, '.bd-tooltip': tooltip, '.bd-detail': detail,
        '.bd-points': html.includes('bd-points') ? points : null, '.bd-freshness': freshness
      })[selector] || null;
      root.parts = { chart, tooltip, detail, cursor, focus, freshness, freshnessText };
    }
  });
  host.querySelector = selector => selector === '.business-dynamics' ? root : selector === '.bd-retry' ? retry : null;
  host.replaceChildren = () => { html = ''; root = null; };
  host.dispatchEvent = event => { host.dispatched = event; return true; };
  const context = {
    window: {}, Intl, Date: Clock, Number, String, Math, JSON, Map, WeakMap, TypeError,
    CustomEvent: class { constructor(type, options) { this.type = type; this.bubbles = options?.bubbles; } },
    setInterval(fn) { const id = nextTimer++; timers.set(id, fn); return id; },
    clearInterval(id) { cleared.push(id); timers.delete(id); }
  };
  vm.runInNewContext(source, context, { filename: 'business-dynamics-view.js' });
  return { api: context.window.PultBusinessDynamicsView, host, timers, cleared, get root() { return root; }, get html() { return html; } };
}

function model(overrides = {}) {
  const base = {
    state: 'ready', date: '2026-09-24', periodLabel: 'Сегодня',
    asOf: '2026-09-24T09:00:00.000Z', updatedAt: '2026-09-24T08:30:00.000Z', timezone: 'Europe/Moscow',
    metric: { key: 'orderedRevenue', label: 'Заказано на сумму', unit: 'rub', additive: true },
    kpis: { today: { value: 20 }, yesterdayAtSameTime: { value: 18 }, pace: { value: 11.1 }, forecast: { value: null, available: false, reason: 'Нет прогноза' } },
    series: {
      today: [
        { at: '2026-09-24T08:00:00+03:00', cumulative: 10, complete: true, basis: 'order-time', last15: null, orders: null, avgCheck: null },
        { at: '2026-09-24T09:00:00+03:00', cumulative: 20, complete: false, basis: 'observation', last15: null, orders: null, avgCheck: null }
      ],
      yesterday: [{ at: '2026-09-24T08:00:00+03:00', cumulative: 9 }, { at: '2026-09-24T09:00:00+03:00', cumulative: 18 }],
      avg7d: [{ at: '2026-09-24T08:00:00+03:00', cumulative: 8 }, { at: '2026-09-24T09:00:00+03:00', cumulative: 17 }],
      forecast: []
    },
    velocity: [], velocityComparison: { value: null, reason: 'Нет интервалов' }, stores: [], events: [], notices: [], historyAvailable: true,
    comparisonLabel: 'к вчера', forecastLabel: 'Нет прогноза'
  };
  return { ...base, ...overrides, kpis: overrides.kpis || base.kpis, series: overrides.series || base.series };
}

function group(html, className) {
  return html.match(new RegExp('<g class="[^"]*' + className + '[^"]*">([\\s\\S]*?)</g>'))?.[1] || '';
}

test('uses asOf for facts, updatedAt for freshness, and scales a no-forecast chart to the known slice', () => {
  const view = harness(Date.parse('2026-09-24T10:10:00+03:00'));
  const data = model({
    asOf: '2026-09-24T09:00:00+03:00',
    updatedAt: '2026-09-24T10:03:00+03:00',
    series: { ...model().series, today: [...model().series.today, { at: '2026-09-24T10:00:00+03:00', cumulative: 999, complete: true }] }
  });
  view.api.render(view.host, data);
  assert.doesNotMatch(view.html, />999</);
  assert.match(view.root.parts.freshnessText.textContent, /Данные устарели · 7 мин/);
  assert.equal(view.root.parts.chart.dataset.domain, '540');
});

test('draws all cumulative histories as STEP, keeps incomplete known facts, and breaks only on null', () => {
  const view = harness();
  const base = model();
  base.historyAvailable = false;
  base.series.today = [base.series.today[0], base.series.today[1], { at: '2026-09-24T09:30:00+03:00', cumulative: null }, { at: '2026-09-24T10:00:00+03:00', cumulative: 30, complete: true }];
  base.asOf = '2026-09-24T10:00:00+03:00';
  view.api.render(view.host, base);
  const today = group(view.html, 'bd-chart__line--today'), yesterday = group(view.html, 'bd-chart__line--yesterday');
  assert.equal((today.match(/<path /g) || []).length, 2);
  assert.match(today, / H [\d.]+ V [\d.]+/);
  assert.match(yesterday, / H [\d.]+ V [\d.]+/);
  assert.match(view.html, /Известные значения · покрытие неполное/);
  assert.match(view.html, /Среднее за 7 дней пока недоступно/);
  assert.notEqual(yesterday, '');
});

test('maps next midnight forecast to 24:00 and preserves negative Y values', () => {
  const view = harness();
  const base = model();
  base.asOf = '2026-09-24T12:00:00+03:00';
  base.series.today = [{ at: '2026-09-24T12:00:00+03:00', cumulative: -20, complete: true }];
  base.series.forecast = [{ at: base.asOf, cumulative: -20 }, { at: '2026-09-25T00:00:00+03:00', cumulative: 40 }];
  view.api.render(view.host, base);
  assert.equal(view.root.parts.chart.dataset.domain, '1440');
  assert.equal(view.root.parts.chart.dataset.min, '-20');
  assert.equal(view.root.parts.chart.dataset.max, '40');
  assert.match(group(view.html, 'bd-chart__line--forecast'), /972\.00/);
  assert.match(view.html, />24:00</);
});

test('keyboard focus exposes a readable tooltip and Enter pins a compact detail', () => {
  const view = harness();
  view.api.render(view.host, model());
  const { chart, tooltip, detail, cursor, focus } = view.root.parts;
  chart.emit('focus', { target: chart });
  assert.equal(tooltip.hidden, false);
  assert.match(tooltip.innerHTML, /Заказы с начала дня/);
  assert.match(tooltip.innerHTML, /Средний чек с начала дня/);
  assert.match(tooltip.innerHTML, /Нет данных/);
  assert.match(tooltip.innerHTML, /Интервалы по времени заказа/);
  assert.equal(cursor.attributes.has('hidden'), false);
  assert.equal(focus.attributes.has('hidden'), false);
  view.root.emit('keydown', { target: chart, key: 'ArrowRight' });
  assert.equal(chart.dataset.activeIndex, '1');
  assert.match(tooltip.innerHTML, /Накопительный снимок на время загрузки/);
  view.root.emit('keydown', { target: chart, key: 'Enter' });
  assert.equal(detail.hidden, false);
  assert.match(detail.innerHTML, /Точка/);
  assert.match(view.html, /role="img" tabindex="0"/);
});

test('renders null, partial, chart-unavailable, empty and error states without inventing data', () => {
  const view = harness();
  const partial = model({ state: 'partial', chartUnavailableReason: 'Есть только итог дня.', series: { today: [], yesterday: [], avg7d: [], forecast: [] }, notices: ['Неполно'] });
  view.api.render(view.host, partial);
  assert.match(view.html, /Есть только итог дня/);
  assert.doesNotMatch(view.html, /class="bd-chart"/);
  assert.match(view.html, /20[^<]*₽/);
  view.api.render(view.host, model({ state: 'empty', date: '2026-09-20', periodLabel: '20 сентября', chartUnavailableReason: 'Внутридневной ряд не загружен.', notices: ['Источник недоступен.'] }));
  assert.match(view.html, /Нет данных: 20 сентября/);
  assert.match(view.html, /Внутридневной ряд не загружен\. Источник недоступен\./);
  view.api.error(view.host, { message: 'Ошибка <сети>', retryLabel: 'Ещё раз' });
  assert.match(view.html, /Ошибка &lt;сети&gt;/);
  view.host.querySelector('.bd-retry').emit('click');
  assert.equal(view.host.dispatched.type, 'business-dynamics:retry');
});

test('clear and rerender dispose timers and delegated handlers', () => {
  const view = harness();
  view.api.render(view.host, model());
  const oldRoot = view.root, oldChart = oldRoot.parts.chart;
  assert.equal(view.timers.size, 1);
  view.api.render(view.host, model({ notices: ['Обновлено'] }));
  assert.equal(view.timers.size, 1);
  assert.equal((oldRoot.listeners.get('click') || []).length, 0);
  assert.equal((oldChart.listeners.get('pointermove') || []).length, 0);
  view.api.clear(view.host);
  assert.equal(view.timers.size, 0);
  assert.equal(view.html, '');
  assert.equal(view.cleared.length, 2);
});

test('escapes every user-facing string, including JSON point basis and pinned event detail', () => {
  const attack = '<img src=x onerror="globalThis.pwned=1">';
  const view = harness();
  const data = model({
    metric: { key: 'x', label: attack, unit: 'rub', additive: true }, notices: [attack], forecastLabel: attack,
    stores: [{ id: '1', name: attack, market: attack, value: 1, complete: false, updatedAt: attack }],
    events: [{ id: 'x', at: '2026-09-24T08:30:00+03:00', label: attack, kind: attack, detail: attack }],
    series: { ...model().series, today: [{ ...model().series.today[0], basis: attack }] }
  });
  view.api.render(view.host, data);
  assert.doesNotMatch(view.html, /<img/);
  assert.match(view.html, /&lt;img/);
  const marker = { dataset: { eventIndex: '0' }, closest: selector => selector === '[data-event-index]' ? marker : null };
  view.root.emit('click', { target: marker });
  assert.doesNotMatch(view.root.parts.detail.innerHTML, /<img/);
  assert.match(view.root.parts.detail.innerHTML, /&lt;img/);
});

test('historical selection and long notices use explicit labels and a collapsed summary', () => {
  const view = harness();
  view.api.render(view.host, model({ date: '2026-09-20', periodLabel: '20 сентября', notices: ['a', 'b', 'c'] }));
  assert.match(view.html, /20 сентября по времени/);
  assert.doesNotMatch(view.html, /Сегодня по времени/);
  assert.match(view.html, /<details class="bd-notices"><summary>Ограничения данных · 3/);
});

test('styles stay scoped, readable, and reset the legacy chart only in bd-active mode', () => {
  assert.match(css, /\.business-dynamics \[hidden\]\{display:none!important\}/);
  assert.doesNotMatch(css, /font-size:(?:8|9|10)px/);
  assert.match(css, /#business-chart\.bd-active #ins-chart\{[^}]*min-height:0!important[^}]*padding:0!important[^}]*border:0!important/);
  assert.match(css, /#business-chart\.bd-active #ins-chart svg\.bd-chart\{[^}]*min-height:0!important/);
  assert.match(css, /#business-chart\.bd-active #ins-chart-title[^}]*display:none!important/);
  assert.match(css, /#business-chart\.bd-active \.ins-chart-label\{[^}]*justify-content:flex-end/);
});

test('first and last tooltip stay inside narrow and desktop charts on focus, hover and click',()=>{
 for(const width of [280,430,680,1000]){
  const view=harness();view.api.render(view.host,model());
  const {chart,tooltip,detail}=view.root.parts;
  chart.getBoundingClientRect=()=>({left:0,width});
  tooltip.getBoundingClientRect=()=>({width:240});
  const fits=()=>{const center=parseFloat(tooltip.style.left)/100*width;assert.ok(center-120>=7.9);assert.ok(center+120<=width-7.9);};
  chart.emit('focus');fits();
  for(const key of ['Home','End']){view.root.emit('keydown',{target:chart,key});fits();}
  assert.equal(chart.dataset.activeIndex,'1');
  for(const clientX of [0,width]){
   chart.emit('pointermove',{clientX});fits();
   chart.emit('click',{clientX});fits();assert.equal(detail.hidden,false);
  }
 }
});
