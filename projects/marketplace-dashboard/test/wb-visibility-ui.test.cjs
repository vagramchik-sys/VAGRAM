const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const ui = fs.readFileSync(require.resolve('../dist/insights-ui.js'), 'utf8');
const wbUi = fs.readFileSync(require.resolve('../dist/wb-economics-ui.js'), 'utf8');
const index = fs.readFileSync(require.resolve('../dist/index.html'), 'utf8');

function runtime({ href = 'http://127.0.0.1:4317/' } = {}) {
  const nodes = new Map();
  const classes = new Map();
  const wbReports = [];
  const fetches = [];
  const homeUpdates = [];

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
  ensure('market').value = 'WB';
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
    window: { addEventListener() {}, PultSellerHome: { update(value) { homeUpdates.push(value); } } },
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
    setInterval: () => 1,
    fetch(url) { fetches.push(String(url)); return new Promise(() => {}); },
    createPultWBEconomics() { return { render(report) { wbReports.push(report); } }; },
    createPultEconomics: inertView,
    createPultSalesDecline: inertView,
    createPultStoreChart: () => ({ render() {} }),
    createPultNetProfit: () => ({ element: new FakeElement(), render() {} }),
    PultFocusUI: { create: () => ({ render() {}, toggleFavorite() {}, detail() {} }) }
  });

  vm.runInContext(ui, context, { filename: 'insights-ui.js' });
  return { nodes, wbReports, fetches, homeUpdates };
}

test('UI loads on WB and can switch to Ozon without a removed placeholder crash', () => {
  const app = runtime();

  assert.equal(app.wbReports.length, 1);
  assert.equal(app.nodes.get('executive').hidden, true);
  assert.equal(app.fetches.length, 1);
  assert.match(app.fetches[0], /^\/api\/profit-series\?/);
  assert.match(app.fetches[0], /market=WB/);
  assert.match(app.fetches[0], /from=\d{4}-\d{2}-\d{2}/);
  assert.match(app.fetches[0], /to=\d{4}-\d{2}-\d{2}/);
  assert.equal(app.fetches.some(url => url.startsWith('/api/insights?')), false);
  assert.equal(app.homeUpdates.at(-1).state, 'unsupported');

  const market = app.nodes.get('market');
  market.value = 'Ozon';
  assert.doesNotThrow(() => market.dispatchEvent({ type: 'change' }));
  assert.equal(app.nodes.get('executive').hidden, false);
  assert.equal(app.fetches.length, 2);
  assert.match(app.fetches[1], /^\/api\/insights\?/);
  assert.equal(app.homeUpdates.at(-1).state, 'loading');
  assert.equal(app.homeUpdates.at(-1).market, 'Ozon');
});

test('homepage starts with completed days while existing deep links retain their default period', () => {
  const home = runtime();
  assert.equal(home.nodes.get('ins-range').value, '28');
  const dates = home.wbReports[0].current;
  assert.equal((Date.parse(dates.to) - Date.parse(dates.from)) / 86400000, 27);
  const analytics = runtime({ href: 'http://127.0.0.1:4317/?view=overview&section=business-chart' });
  assert.equal(analytics.nodes.get('ins-range').value, 'today');
});

test('WB keeps its canonical selector value and dedicated report labels', () => {
  assert.match(index, /<option value="WB">Wildberries<\/option>/);
  assert.doesNotMatch(ui, /ins-wb/);
  assert.match(wbUi, /TRUESTATS · WILDBERRIES/);
  assert.match(wbUi, /Прямой отчёт WB/);
});

test('business chart exposes WB honestly and removes yesterday and week reference controls', () => {
  const chart = fs.readFileSync(require.resolve('../dist/turnover-chart.js'), 'utf8');
  assert.match(chart, /catalog=list/);
  assert.match(chart, /\/api\/wb\/orders\?/);
  assert.match(chart, /WB: сумма по priceWithDisc, без отменённых заказов/);
  assert.match(chart, /одна строка API равна одной заказанной единице/);
  assert.doesNotMatch(chart, /id="chart-compare-controls"/);
  assert.doesNotMatch(chart, /Неделю назад/);
  assert.doesNotMatch(chart, /name:'Вчера'/);
  assert.match(chart, /chart-forecast-enabled/);
});

test('business chart switches to categories without losing the store selection or inventing Ozon order times', () => {
  const chart = fs.readFileSync(require.resolve('../dist/turnover-chart.js'), 'utf8');
  assert.match(chart, /chart-mode-categories/);
  assert.match(chart, /\/api\/order-categories\?/);
  assert.match(chart, /selectedCategories/);
  assert.match(chart, /Исторические дни используют текущую подтверждённую классификацию/);
  assert.match(chart, /каждая точка соответствует дню/);
  assert.match(chart, /Ozon и Wildberries объединены по нашим типам/);
  assert.match(chart, /сумма остаётся пустой, если рублёвая сумма не подтверждена/);
  assert.match(chart, /не выдаётся за полный итог/);
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
  assert.match(chart, /Выберите категорию или магазин в таблице/);
});
