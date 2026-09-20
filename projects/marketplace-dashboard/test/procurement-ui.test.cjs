'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.listeners = {};
    this.dataset = {}; this.value = ''; this.textContent = ''; this.className = '';
    this.disabled = false; this.hidden = false; this.files = [];
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  setAttribute(name, value) { this[name] = value; }
  focus() { this.focused = true; }
  scrollIntoView() {}
  matches(selector) { return selector === 'input' && this.tagName === 'INPUT'; }
  closest() { return null; }
}

const ids = [
  'notice', 'refresh', 'save-request', 'import-price', 'request-list', 'price-list',
  'request-items', 'request-table-wrap', 'request-title', 'request-text',
  'parse-warnings', 'request-mode', 'new-request', 'parse-request', 'add-item',
  'supplier-name', 'price-date', 'price-file', 'price-text', 'encoding', 'currency',
  'vat-basis', 'compare-title', 'compare-warning', 'compare-panel', 'comparison',
  'close-compare', 'external-query', 'copy-query'
];

function response(value, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: async () => value });
}

function harness(fetchImpl) {
  const nodes = Object.fromEntries(ids.map(id => [id, new FakeElement()]));
  nodes.currency.value = 'RUB'; nodes['vat-basis'].value = 'unknown'; nodes.encoding.value = 'utf-8';
  const document = {
    getElementById: id => nodes[id] || (nodes[id] = new FakeElement()),
    createElement: tag => new FakeElement(tag),
    querySelectorAll: () => [],
    querySelector: () => new FakeElement()
  };
  const context = vm.createContext({
    document, fetch: fetchImpl, console, Intl, TextDecoder, Number, String, Error,
    navigator: { clipboard: { writeText: async () => {} } },
    CSS: { escape: value => value }, structuredClone, setTimeout, clearTimeout
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'dist', 'procurement.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'procurement.js' });
  return { nodes };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('повторная загрузка после ошибки включает сохранение и импорт', async () => {
  let attempt = 0;
  const { nodes } = harness(() => ++attempt === 1
    ? Promise.reject(new Error('offline'))
    : response({ version: 0, requests: [], priceLists: [] }));
  await tick(); await tick();
  assert.equal(nodes['save-request'].disabled, true);
  assert.equal(nodes['import-price'].disabled, true);
  await nodes.refresh.listeners.click();
  assert.equal(nodes['save-request'].disabled, false);
  assert.equal(nodes['import-price'].disabled, false);
});

test('новый режим сбрасывает id, а повторное сохранение обновляет созданную заявку', async () => {
  const calls = [];
  let version = 1;
  const fetchImpl = (url, options) => {
    if (!options?.body) return response({ version, requests: [], priceLists: [] });
    const body = JSON.parse(options.body); calls.push({ url, body }); version++;
    return response({ version, id: 'request-1', requests: [{ id: 'request-1', title: body.title, items: body.items, createdAt: '2026-09-18T00:00:00Z', updatedAt: '2026-09-18T00:00:00Z' }], priceLists: [] });
  };
  const { nodes } = harness(fetchImpl);
  await tick(); await tick();
  nodes['request-title'].value = 'Тестовая заявка';
  nodes['add-item'].listeners.click();
  const nameInput = new FakeElement('input'); nameInput.dataset.index = '0'; nameInput.dataset.field = 'name'; nameInput.value = 'Кабель';
  nodes['request-items'].listeners.input({ target: nameInput });
  await nodes['save-request'].listeners.click();
  assert.equal(calls[0].body.id, undefined);
  assert.equal(nodes['request-mode'].textContent, 'Редактирование: Тестовая заявка');
  assert.equal(nodes['new-request'].hidden, false);
  await nodes['save-request'].listeners.click();
  assert.equal(calls[1].body.id, 'request-1');
  nodes['new-request'].listeners.click();
  assert.equal(nodes['request-mode'].textContent, 'Новая заявка');
  assert.equal(nodes['request-title'].value, '');
  assert.equal(nodes['request-table-wrap'].hidden, true);
});

test('форма импорта содержит явную валюту и поясняет приоритет строк', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'dist', 'procurement.html'), 'utf8');
  assert.match(html, /id="currency"/);
  assert.match(html, /значения в строках имеют приоритет/);
});
