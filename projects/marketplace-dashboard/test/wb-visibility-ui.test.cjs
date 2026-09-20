const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const ui = fs.readFileSync(require.resolve('../dist/insights-ui.js'), 'utf8');
const wbUi = fs.readFileSync(require.resolve('../dist/wb-economics-ui.js'), 'utf8');
const index = fs.readFileSync(require.resolve('../dist/index.html'), 'utf8');

function runtime() {
  const nodes = new Map();
  const classes = new Map();
  const wbReports = [];
  let fetches = 0;

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
    window: {},
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    location: { hash: '' },
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
    fetch() { fetches++; return new Promise(() => {}); },
    createPultWBEconomics() { return { render(report) { wbReports.push(report); } }; },
    createPultEconomics: inertView,
    createPultSalesDecline: inertView,
    createPultStoreChart: () => ({ render() {} }),
    createPultNetProfit: () => ({ element: new FakeElement(), render() {} }),
    PultFocusUI: { create: () => ({ render() {}, toggleFavorite() {}, detail() {} }) }
  });

  vm.runInContext(ui, context, { filename: 'insights-ui.js' });
  return { nodes, wbReports, get fetches() { return fetches; } };
}

test('UI loads on WB and can switch to Ozon without a removed placeholder crash', () => {
  const app = runtime();

  assert.equal(app.wbReports.length, 1);
  assert.equal(app.nodes.get('executive').hidden, true);
  assert.equal(app.fetches, 0);

  const market = app.nodes.get('market');
  market.value = 'Ozon';
  assert.doesNotThrow(() => market.dispatchEvent({ type: 'change' }));
  assert.equal(app.nodes.get('executive').hidden, false);
  assert.equal(app.fetches, 1);
});

test('WB keeps its canonical selector value and dedicated report labels', () => {
  assert.match(index, /<option value="WB">Wildberries<\/option>/);
  assert.doesNotMatch(ui, /ins-wb/);
  assert.match(wbUi, /TRUESTATS · WILDBERRIES/);
  assert.match(wbUi, /Прямой отчёт WB/);
});
