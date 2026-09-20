'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '..', 'dist', 'charity.js'), 'utf8');

class FakeElement {
  constructor(tagName = 'div', ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = '';
    this.disabled = false;
    this.hidden = false;
    this.open = false;
    this.checked = false;
    this.value = '';
    this.files = [];
    this._text = '';
  }
  append(...items) {
    for (const item of items) {
      if (item?.isFragment) this.children.push(...item.children);
      else this.children.push(item);
    }
  }
  replaceChildren(...items) { this.children = []; this._text = ''; this.append(...items); }
  set textContent(value) { this._text = String(value ?? ''); this.children = []; }
  get textContent() { return this._text + this.children.map(child => typeof child === 'string' ? child : child?.textContent || '').join(''); }
  set innerHTML(value) { this.ownerDocument.unsafeHtmlWrites.push(String(value)); }
  get innerHTML() { return this.textContent; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, listener) { (this.listeners.get(type) || this.listeners.set(type, []).get(type)).push(listener); }
  dispatch(type, event = {}) { for (const listener of this.listeners.get(type) || []) listener({ target: this, ...event }); }
  focus() { this.ownerDocument.activeElement = this; }
  showModal() { this.open = true; }
}

class FakeDocument {
  constructor() {
    this.elements = new Map();
    this.selectors = new Map();
    this.unsafeHtmlWrites = [];
    this.activeElement = null;
  }
  add(id, tag = 'div') { const element = new FakeElement(tag, this); element.id = id; this.elements.set(id, element); return element; }
  getElementById(id) { return this.elements.get(id) || null; }
  createElement(tag) { return new FakeElement(tag, this); }
  createDocumentFragment() { const fragment = new FakeElement('fragment', this); fragment.isFragment = true; return fragment; }
  createTextNode(text) { const node = new FakeElement('#text', this); node.textContent = text; return node; }
  querySelector(selector) { return this.selectors.get(selector) || null; }
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function loadedState(records, { canImport = true } = {}) {
  const counts = { records: records.length, confirmed: 0, pending: 0, cancelled: 0, refunded: 0 };
  for (const record of records) {
    if (record.status === 'completed' || record.status === 'executed') counts.confirmed += 1;
    else if (Object.hasOwn(counts, record.status)) counts[record.status] += 1;
  }
  return {
    state: 'loaded', version: 7, capabilities: { import: canImport }, records, counts,
    totalsByCurrency: [{ currency: 'RUB', confirmed: '1250.00', pending: '90.00', cancelled: '0.00', refunded: '0.00' }],
    coverage: { status: 'partial', reason: 'Загружена только часть периода.', from: '2026-09-01', to: '2026-09-20', imports: [{ source: 'Реестр', asOf: '2026-09-20', importedAt: '2026-09-20T10:00:00Z', coverage: { from: '2026-09-01', to: '2026-09-20' } }] }
  };
}

function record(status, name, amount = '100.00', date = '2026-09-20') {
  return { date, programOrRecipient: name, amount, currency: 'RUB', status, storeId: 'store-1', source: 'Реестр', sourceDocument: { label: 'Документ' } };
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

async function harness(initialState) {
  const document = new FakeDocument();
  const ids = [
    'notice', 'refresh', 'apply-filters', 'reset-filters', 'filter-from', 'filter-to', 'filter-store', 'filter-status',
    'scope-details', 'status-counts', 'totals', 'history-rows', 'history-empty', 'record-count', 'recent-operations',
    'import-source', 'import-as-of', 'coverage-from', 'coverage-to', 'coverage-complete', 'import-file', 'import-text',
    'preview-import', 'confirm-import', 'import-message', 'import-preview', 'support-button', 'support-dialog'
  ];
  for (const id of ids) document.add(id, id === 'filter-store' || id === 'filter-status' ? 'select' : id === 'import-text' ? 'textarea' : 'div');
  const importPanel = new FakeElement('details', document); importPanel.className = 'import-panel';
  const tableWrap = new FakeElement('div', document); tableWrap.className = 'table-wrap';
  document.selectors.set('.import-panel', importPanel);
  document.selectors.set('.history-panel .table-wrap', tableWrap);

  const replies = [response(initialState)];
  const fetch = async () => {
    assert.ok(replies.length, 'unexpected fetch without a queued response');
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  class FakeOption extends FakeElement {
    constructor(text, value) { super('option', document); this.textContent = text; this.value = value; }
  }
  const window = {};
  const context = vm.createContext({ document, window, fetch, Option: FakeOption, URL, URLSearchParams, Intl, console, setTimeout, clearTimeout });
  vm.runInContext(script, context, { filename: 'charity.js' });
  await settle();
  return { document, replies, importPanel, tableWrap };
}

test('failed refresh preserves rendered data and labels it as stale', async () => {
  const ui = await harness(loadedState([record('completed', 'Подтверждённая программа')]));
  assert.equal(ui.document.getElementById('history-rows').children.length, 1);

  ui.replies.push(response({ error: 'Сервис временно недоступен.' }, 503));
  await ui.document.getElementById('refresh').onclick();

  assert.equal(ui.document.getElementById('history-rows').children.length, 1, 'previously rendered history should remain visible');
  assert.match(ui.document.getElementById('notice').textContent, /Показана ранее загруженная версия/);
  assert.match(ui.document.getElementById('notice').textContent, /Сервис временно недоступен/);
});

for (const deniedStatus of [401, 403]) {
  test(`${deniedStatus} clears protected history and import preview`, async () => {
    const ui = await harness(loadedState([record('completed', 'Закрытая запись')]));
    const get = id => ui.document.getElementById(id);
    ui.importPanel.open = true;
    get('import-source').value = 'Секретный документ';
    get('import-as-of').value = '2026-09-20'; get('coverage-from').value = '2026-09-01'; get('coverage-to').value = '2026-09-20';
    get('import-text').value = JSON.stringify({ records: [{ date: '2026-09-20', programOrRecipient: 'Предпросмотр', amount: '100.00', currency: 'RUB', status: 'completed', storeId: 'store-1', sourceDocument: { label: 'Документ' } }] });
    get('preview-import').onclick();
    assert.equal(get('import-preview').hidden, false, 'precondition: preview should be visible');
    assert.equal(get('confirm-import').disabled, false, 'precondition: valid preview should allow confirmation');

    ui.replies.push(response({ error: 'Требуется авторизация.' }, deniedStatus));
    await get('refresh').onclick();

    assert.equal(get('history-rows').children.length, 0);
    assert.equal(ui.tableWrap.hidden, true);
    assert.equal(get('recent-operations').textContent.includes('Закрытая запись'), false);
    assert.equal(ui.importPanel.hidden, true);
    assert.equal(ui.importPanel.open, false);
    assert.equal(get('import-preview').hidden, true);
    assert.equal(get('import-preview').children.length, 0);
    assert.equal(get('import-text').value, '');
    assert.equal(get('import-source').value, '');
    assert.equal(get('confirm-import').disabled, true);
    assert.match(get('notice').textContent, /Защищённые данные скрыты/);
  });
}

test('recent list includes only confirmed statuses and renders record names as text', async () => {
  const hostileName = '<img src=x onerror="globalThis.compromised=true">';
  const ui = await harness(loadedState([
    record('pending', 'Ожидающая операция', '90.00'),
    record('completed', hostileName, '1000.00', '2026-09-19'),
    record('cancelled', 'Отменённая операция', '50.00'),
    record('executed', 'Исполненная операция', '250.00', '2026-09-20'),
    record('refunded', 'Возвращённая операция', '10.00')
  ]));

  const recent = ui.document.getElementById('recent-operations');
  assert.equal(recent.children.length, 2);
  assert.deepEqual(recent.children.map(row => row.children[0].children[0].textContent), ['Исполненная операция', hostileName]);
  assert.deepEqual(recent.children.map(row => row.children[1].textContent), ['Исполнено', 'Завершено']);
  assert.equal(ui.document.unsafeHtmlWrites.length, 0, 'record data must never be assigned through innerHTML');
  assert.equal(ui.document.getElementById('history-rows').children.length, 5, 'full history remains unfiltered by recent-list rules');
});

test('import preview reports record count and source, and says when invalid data was not written', async () => {
  const ui = await harness(loadedState([]));
  const get = id => ui.document.getElementById(id);
  get('import-source').value = 'Подтверждённый реестр';
  get('import-as-of').value = '2026-09-20'; get('coverage-from').value = '2026-09-01'; get('coverage-to').value = '2026-09-20';
  get('import-text').value = JSON.stringify({ records: [{ date: '2026-09-20', programOrRecipient: 'Программа', amount: '100.00', currency: 'RUB', status: 'completed', sourceDocument: { label: 'Документ' } }] });

  get('preview-import').onclick();
  assert.match(get('import-preview').textContent, /1 записей · источник: Подтверждённый реестр/);
  assert.equal(get('confirm-import').disabled, false);

  get('import-text').value = '{broken json'; get('import-text').dispatch('input');
  get('preview-import').onclick();
  assert.match(get('import-preview').textContent, /JSON требует исправлений/);
  assert.match(get('import-preview').textContent, /Запись не выполнялась\./);
  assert.equal(get('confirm-import').disabled, true);
});
