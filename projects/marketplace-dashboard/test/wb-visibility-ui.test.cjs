const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const ui = fs.readFileSync(require.resolve('../dist/insights-ui.js'), 'utf8');
const wbUi = fs.readFileSync(require.resolve('../dist/wb-economics-ui.js'), 'utf8');
const index = fs.readFileSync(require.resolve('../dist/index.html'), 'utf8');

function runtime({ href = 'http://127.0.0.1:4317/', market = 'WB', fetchImpl } = {}) {
  const nodes = new Map();
  const classes = new Map();
  const wbReports = [];
  const fetches = [];
  const homeUpdates = [];
  const intervals = [];
  const windowListeners = new Map();

  class FakeElement {
    constructor(id = '') {
      this.id = id;
      this.value = '';
      this.hidden = false;
      this.checked = false;
      this.dataset = {};
      this.listeners = new Map();
      this.parentElement = this;
      this.classList = { add() {}, remove() {} };
    }
    insertAdjacentHTML(_position, html) {
      for (const match of html.matchAll(/id="([^"]+)"/g)) ensure(match[1]);
      for (const match of html.matchAll(/class="([^"]+)"/g)) {
        for (const name of match[1].split(/\s+/)) if (!classes.has(name)) classes.set(name, new FakeElement());
      }
      ensure('ins-range').value ||= 'today';
    }
    addEventListener(type, listener) {
      const list = this.listeners.get(type) || [];
      list.push(listener);
      this.listeners.set(type, list);
    }
    dispatchEvent(event) {
      event.target = this;
      for (const listener of this.listeners.get(event.type) || []) listener.call(this, event);
      const handler = this['on' + event.type];
      if (handler) handler.call(this, event);
      return true;
    }
    querySelector() { return new FakeElement(); }
    closest() { return new FakeElement(); }
    after() {}
    before() {}
    append() {}
    replaceWith() {}
    setAttribute() {}
    showModal() {}
    close() {}
    remove() { if (this.id) nodes.delete(this.id); }
  }

  function ensure(id) {
    if (!nodes.has(id)) nodes.set(id, new FakeElement(id));
    return nodes.get(id);
  }

  for (const id of ['metrics', 'business-chart', 'focus-brief', 'focus-priorities', 'products', 'market', 'store', 'hide-inactive']) ensure(id);
  ensure('market').value = market;
  ensure('store').value = '';

  const document = {
    body: new FakeElement('body'),
    hidden: false,
    getElementById: id => nodes.get(id) || null,
    createElement: () => new FakeElement(),
    querySelector(selector) {
      if (selector.startsWith('.')) return classes.get(selector.slice(1)) || new FakeElement();
      return null;
    },
    querySelectorAll() { return []; }
  };

  const inertView = () => ({ render() {} });
  const context = vm.createContext({
    document,
    window: { addEventListener(type, listener) { const list = windowListeners.get(type) || []; list.push(listener); windowListeners.set(type, list); }, dispatchEvent(event) { for (const listener of windowListeners.get(event.type) || []) listener(event); }, PultSellerHome: { update(value) { homeUpdates.push(value); } } },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    location: { hash: new URL(href).hash, href },
    Event: class Event { constructor(type) { this.type = type; } },
    URL,
    URLSearchParams,
    Blob,
    Intl,
    Date,
    console,
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval(callback) { intervals.push(callback); return intervals.length; },
    fetch(url, options) {
      fetches.push(String(url));
      return fetchImpl ? fetchImpl(String(url), options) : new Promise(() => {});
    },
    createPultWBEconomics() { return { render(report) { wbReports.push(report); } }; },
    createPultEconomics: inertView,
    createPultSalesDecline: inertView,
    createPultStoreChart: () => ({ update() {}, render() {} }),
    createPultNetProfit: () => ({ element: new FakeElement(), render() {} }),
    PultFocusUI: { create: () => ({ render() {}, toggleFavorite() {}, detail() {} }) }
  });

  vm.runInContext(ui, context, { filename: 'insights-ui.js' });
  return { nodes, wbReports, fetches, homeUpdates, intervals, context, dispatch(type) { context.window.dispatchEvent({ type }); } };
}

function ordersReport() {
  const metric = (current, previous, kind = 'money', source = 'orders') => ({ current, previous, kind, source });
  return { scope: 'orders', days: 28, current: { from: '2026-08-26', to: '2026-09-22' }, previous: { from: '2026-07-29', to: '2026-08-25' }, coverage: { orders: true, previousOrders: true, finance: false, previousFinance: false }, metrics: { orderedRevenue: metric(120, 100), orderedUnits: metric(2, 1, 'units'), realized: metric(null, null, 'money', 'finance'), net: metric(null, null, 'money', 'finance') }, daily: [], stores: [{ id: '1', name: 'Store' }], products: [], fees: [], sources: [{ id: '1', name: 'Store', ordersAt: '2026-09-22T10:00:00Z', ordersHistoryAt: '2026-09-22T10:00:00Z', errors: [] }], jobs: {}, syncJobs: [], refresh: {} };
}

test('initial page-layout route event reuses the in-flight orders request and reaches ready', async () => {
  let resolveInsights;
  const app = runtime({ market: 'Ozon', fetchImpl: url => url.startsWith('/api/insights?') ? new Promise(resolve => { resolveInsights = resolve; }) : new Promise(() => {}) });
  app.dispatch('pult:view-change');
  assert.equal(app.fetches.filter(url => url.startsWith('/api/insights?')).length, 1);
  resolveInsights({ ok: true, json: async () => ordersReport() });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.homeUpdates.at(-1).state, 'ready');
  assert.match(app.nodes.get('ins-state').textContent, /Заказы загружены/);
  assert.equal(app.fetches.filter(url => url.startsWith('/api/insights?')).length, 1);
});

test('buyer page does not start or poll the hidden insights report', () => {
  const app = runtime({ href: 'http://127.0.0.1:4317/?view=buyers', market: 'Ozon' });
  app.dispatch('pult:view-change');
  app.intervals[0]();
  assert.equal(app.fetches.filter(url => url.startsWith('/api/insights?')).length, 0);
  app.context.document.body.dataset.pultView = 'overview';
  app.dispatch('pult:view-change');
  assert.equal(app.fetches.filter(url => url.startsWith('/api/insights?')).length, 1);
});

test('latest report mode wins while an orders request is in flight', async () => {
  let resolveInsights;
  const app = runtime({ market: 'Ozon', fetchImpl: url => url.startsWith('/api/insights?') ? new Promise(resolve => { resolveInsights = resolve; }) : new Promise(() => {}) });
  const metric = app.nodes.get('ins-chart-metric');
  metric.value = 'net'; metric.dispatchEvent({ type: 'change' });
  metric.value = 'orderedRevenue'; metric.dispatchEvent({ type: 'change' });
  resolveInsights({ ok: true, json: async () => ordersReport() });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.fetches.filter(url => url.startsWith('/api/insights?')).length, 1);
  assert.equal(app.homeUpdates.at(-1).state, 'ready');
});

test('periodic poll does not invalidate an in-flight insights response', async () => {
  let resolveInsights;
  const app = runtime({
    fetchImpl(url) {
      if (url.startsWith('/api/insights?')) {
        return new Promise(resolve => { resolveInsights = resolve; });
      }
      return new Promise(() => {});
    }
  });
  const market = app.nodes.get('market');
  market.value = 'Ozon';
  market.dispatchEvent({ type: 'change' });
  assert.equal(app.fetches.filter(url => url.startsWith('/api/insights?')).length, 1);

  app.intervals[0]();
  assert.equal(app.fetches.filter(url => url.startsWith('/api/insights?')).length, 1);

  resolveInsights({ ok: true, json: async () => ({}) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.homeUpdates.filter(value => value.state === 'ready').length, 1);
  assert.equal(app.fetches.filter(url => url.startsWith('/api/insights?')).length, 1);
});

test('today order chart requests fresh lightweight data on the next poll', async () => {
  const app = runtime({
    href: 'http://127.0.0.1:4317/?view=overview&section=business-chart',
    market: 'Ozon',
    fetchImpl: async url => url.startsWith('/api/insights?')
      ? { ok: true, json: async () => ordersReport() }
      : new Promise(() => {})
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.fetches.filter(url => url.startsWith('/api/insights?')).length, 1);
  app.intervals[0]();
  assert.equal(app.fetches.filter(url => url.startsWith('/api/insights?')).length, 2);
  assert.ok(app.fetches.filter(url => url.startsWith('/api/insights?')).every(url => url.includes('scope=orders')));
});

test('UI loads on WB and can switch to Ozon without a removed placeholder crash', () => {
  const app = runtime();

  assert.equal(app.wbReports.length, 0);
  assert.equal(app.nodes.get('executive').hidden, true);
  assert.equal(app.fetches.length, 0);
  assert.equal(app.fetches.some(url => url.startsWith('/api/insights?')), false);
  assert.equal(app.homeUpdates.at(-1).state, 'unsupported');

  const market = app.nodes.get('market');
  market.value = 'Ozon';
  assert.doesNotThrow(() => market.dispatchEvent({ type: 'change' }));
  assert.equal(app.nodes.get('executive').hidden, false);
  assert.equal(app.fetches.length, 1);
  assert.match(app.fetches[0], /^\/api\/insights\?/);
  assert.match(app.fetches[0], /scope=orders/);
  assert.equal(app.homeUpdates.at(-1).state, 'loading');
  assert.equal(app.homeUpdates.at(-1).market, 'Ozon');
});

test('homepage starts with completed days while existing deep links retain their default period', () => {
  const home = runtime();
  assert.equal(home.nodes.get('ins-range').value, '28');
  assert.equal((Date.parse(home.nodes.get('ins-to').value) - Date.parse(home.nodes.get('ins-from').value)) / 86400000, 27);
  const analytics = runtime({ href: 'http://127.0.0.1:4317/?view=overview&section=business-chart' });
  assert.equal(analytics.nodes.get('ins-range').value, 'today');
});

test('business chart uses the orders scope while an explicit economics route loads the full report', () => {
  const chart = runtime({ href: 'http://127.0.0.1:4317/#business-chart', market: 'Ozon' });
  assert.equal(chart.fetches.length, 1);
  assert.match(chart.fetches[0], /^\/api\/insights\?/);
  assert.match(chart.fetches[0], /scope=orders/);
  assert.equal(chart.fetches.some(url => url.startsWith('/api/profit-series?')), false);
  assert.equal(chart.fetches.some(url => url.startsWith('/api/data?')), false);

  const economics = runtime({ href: 'http://127.0.0.1:4317/#economics', market: 'Ozon' });
  assert.equal(economics.fetches.length, 1);
  assert.match(economics.fetches[0], /^\/api\/insights\?/);
  assert.doesNotMatch(economics.fetches[0], /scope=orders/);
  const queryEconomics = runtime({ href: 'http://127.0.0.1:4317/?view=economics', market: 'Ozon' });
  assert.equal(queryEconomics.fetches.length, 1);
  assert.doesNotMatch(queryEconomics.fetches[0], /scope=orders/);
  assert.match(ui, /else void load\('orders'\)/);
  assert.match(ui, /insightsRoutes\.has\(currentHash\(\)\)&&!wantsFullReport\(\)/);
  assert.doesNotMatch(ui, /wbView\.render\(report\);focusView\.render\(report\);economicsView\.render\(report\);declineView\.render\(report\)/);
});

test('TrueStats management summary stays deferred until its section is explicitly opened', () => {
  const overview = runtime({ market: 'Ozon' });
  assert.equal(overview.fetches.some(url => url.startsWith('/api/profit-series?')), false);
  const summary = runtime({ href: 'http://127.0.0.1:4317/#management-summary', market: 'Ozon' });
  assert.equal(summary.fetches.filter(url => url.startsWith('/api/profit-series?')).length, 1);
  assert.match(ui, /href="\/data-updates\.html">Обновление данных/);
  assert.match(ui, /Сам экран автоматически читает только лёгкую сводку заказов/);
  assert.match(ui, /60-дневная история заказов Ozon и воронка запускаются только вручную/);
  assert.match(ui, /Уже сохранённые данные остаются доступны/);
  assert.match(ui, /Тяжёлые отчёты и история: вручную/);
  assert.doesNotMatch(ui, /Финансы, товары и себестоимость: каждые 30 минут/);
});

test('WB keeps its canonical selector value and dedicated report labels', () => {
  assert.match(index, /<option value="WB">Wildberries<\/option>/);
  assert.doesNotMatch(ui, /ins-wb/);
  assert.match(wbUi, /TRUESTATS · WILDBERRIES/);
  assert.match(wbUi, /Прямой отчёт WB/);
});

test('WB economics polls only while its own section is open and the document is visible', () => {
  assert.match(wbUi, /hash\?hash==='wb-economics':view==='wb-economics'/);
  assert.match(wbUi, /&&!document\.hidden/);
  assert.match(wbUi, /if\(!sectionActive\(\)\)return/);
  assert.match(wbUi, /window\.addEventListener\('hashchange',\(\)=>\{if\(!sectionActive\(\)\)deactivate\(\)\}\)/);
  assert.match(wbUi, /window\.addEventListener\('pult:view-change'/);
  assert.match(wbUi, /document\.addEventListener\('visibilitychange'/);
  assert.match(wbUi, /else if\(lastReport\)void load\(lastReport\)/);
});

test('business chart exposes WB honestly and removes yesterday and week reference controls', () => {
  const chart = fs.readFileSync(require.resolve('../dist/turnover-chart.js'), 'utf8');
  assert.match(chart, /catalog=list/);
  assert.match(chart, /\/api\/wb\/orders\?/);
  assert.match(chart, /priceWithDisc/);
  assert.match(chart, /Общий · Ozon \+ WB/);
  assert.match(chart, /Общий итог неполный/);
  assert.match(chart, /одна строка API равна одной заказанной единице/);
  assert.doesNotMatch(chart, /id="chart-compare-controls"/);
  assert.doesNotMatch(chart, /Неделю назад/);
  assert.doesNotMatch(chart, /name:'Вчера'/);
  assert.match(chart, /chart-forecast-enabled/);
});

test('business chart switches to categories without losing the store selection or inventing Ozon order times', () => {
  const chart = fs.readFileSync(require.resolve('../dist/turnover-chart.js'), 'utf8');
  assert.match(chart, /chart-mode-categories/);
  assert.match(chart, /\/api\/order-category-daily\?/);
  assert.doesNotMatch(chart, /\/api\/order-categories\?/);
  assert.match(chart, /selectedCategories/);
  assert.match(chart, /Исторические дни используют текущую подтверждённую классификацию/);
  assert.match(chart, /За сегодня показывается последний подтверждённый итог из API/);
  assert.match(chart, /Ozon и Wildberries объединены по нашим типам/);
  assert.match(chart, /Прочерк означает, что подтверждённых сумм нет; пропуски не заменяются нулём/);
  assert.match(chart, /часть дней или площадок не загружена, она отмечена «Неполно»/);
  assert.match(chart, /function setMode\(next\)\{mode=next/);
});

test('category chart starts empty and only changes selection by explicit user action', () => {
  const chart = fs.readFileSync(require.resolve('../dist/turnover-chart.js'), 'utf8');
  assert.match(chart, /selectedCategories=new Set\(\)/);
  assert.doesNotMatch(chart, /if\(!selectedCategories\.size\)\{selectedCategories=new Set\(categoryReport\.categories\)\}/);
  assert.match(chart, /const valid=new Set\(\(daily\.types\|\|\[\]\)\.map\(type=>type\.id\)\)/);
  assert.match(chart, /valid\.add\('store:'\+item\.storeId\+'\:'\+item\.typeId\)/);
  assert.match(chart, /chart-all-categories'[)]\.onclick=\(\)=>\{const types=categoryReport\?\.types\|\|\[\]/);
  assert.match(chart, /for\(const parent of ancestors\(id,map\)\)selectedCategories\.delete\(parent\)/);
  assert.match(chart, /for\(const child of descendants\(id\)\)selectedCategories\.delete\(child\)/);
  assert.match(chart, /chart-category-search/);
  assert.match(chart, /Сначала выберите нужные категории/);
  assert.match(chart, /Выберите категорию или товар в таблице/);
});
