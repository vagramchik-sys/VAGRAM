'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const create = require('../supplier-portals.cjs');

function fixture(t) {
  const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pult-suppliers-'));
  t.after(() => fs.rmSync(privateDir, { recursive: true, force: true }));
  let products = [
    { key: 'store-a:1', name: 'Синтетический болт', sku: 'sku-1', offer_id: 'bolt-a', market: 'Ozon', storeName: 'Тестовый магазин А', quantity: 8, warehouseRows: [{ type: 'fbo', present: 6, reserved: 1, apiKey: 'synthetic-not-a-key' }, { type: 'fbs', present: 2 }], importedAt: '2026-09-18T08:00:00Z', price: 150, cost: { unitCost: 70 }, profit: 80, apiKey: 'synthetic-not-a-key' },
    { key: 'store-b:2', name: 'Синтетический аналог', sku: 'sku-1', offer_id: 'bolt-b', market: 'Ozon', storeName: 'Тестовый магазин Б', quantity: null },
    { key: 'store-a:3', name: 'Синтетическая гайка', sku: 'sku-3', quantity: 0 },
    { key: 'store-a:4', name: 'Синтетическая шайба', sku: 'sku-4', quantity: 4 }
  ];
  const forecasts = new Map([
    ['store-a:1', { status: 'available', averageDailyUnits: 1, projectedUnits: 45, requiredUnits: 37, daysOfStock: 8, historyStart: '2026-08-21', historyEnd: '2026-09-17', caveat: 'Тестовый прогноз', financialTotal: 123, apiKey: 'synthetic-not-a-key' }],
    ['store-b:2', { status: 'available', averageDailyUnits: 1, projectedUnits: 45, requiredUnits: 45 }]
  ]);
  const options = { privateDir, getProducts: () => products, getForecasts: () => forecasts };
  const service = create(options);
  const category = service.saveCategory({ version: 0, name: 'Крепёж', productKeys: ['store-a:1', 'store-b:2', 'store-a:3'] });
  const other = service.saveCategory({ version: 1, name: 'Шайбы', productKeys: ['store-a:4'] });
  const portal = service.savePortal({ version: 2, name: 'Тестовый поставщик', categoryIds: [category.id] });
  return { service, category, other, portal, options, forecasts, setProducts: value => { products = value; } };
}

test('supplier preview scopes by category across stores and returns only the whitelist', t => {
  const { service, portal } = fixture(t);
  const preview = service.preview(portal.id);
  assert.equal(preview.mode, 'local-draft');
  assert.deepEqual(preview.rows.map(p => p.name), ['Синтетический болт', 'Синтетический аналог', 'Синтетическая гайка']);
  assert.deepEqual(Object.keys(preview.rows[0]).sort(), ['name', 'sku', 'article', 'market', 'storeName', 'category', 'stock', 'warehouseBreakdown', 'forecast', 'need', 'importedAt'].sort());
  assert.deepEqual(Object.keys(preview.rows[0].warehouseBreakdown.rows[0]).sort(), ['kind', 'name', 'stock']);
  assert.deepEqual(Object.keys(preview.rows[0].forecast).sort(), ['label', 'status', 'reason', 'averageDailyUnits', 'projectedUnits', 'requiredUnits', 'daysOfStock', 'historyStart', 'historyEnd', 'caveat'].sort());
  const serialized = JSON.stringify({ preview, owner: service.read() });
  for (const forbidden of ['unitCost', 'profit', 'apiKey', 'synthetic-not-a-key', 'financialTotal', '"price"']) assert.ok(!serialized.includes(forbidden), forbidden);
  assert.equal(preview.rows[0].need, 37);
  assert.equal(preview.rows[0].forecast.label, 'Ориентировочный прогноз потребности на 45 дней');
  assert.equal(preview.rows[1].sku, preview.rows[0].sku, 'Identical SKU in separate stores must not be merged');
  assert.notEqual(preview.rows[1].storeName, preview.rows[0].storeName);
});

test('unknown stocks and unavailable history never turn into zero need', t => {
  const { service, portal, setProducts } = fixture(t);
  const rows = service.preview(portal.id).rows;
  assert.equal(rows[1].stock, null);
  assert.equal(rows[1].need, null);
  assert.equal(rows[1].forecast.status, 'unavailable');
  assert.equal(rows[2].stock, 0);
  assert.equal(rows[2].need, null);
  for (const quantity of [undefined, NaN, Infinity, -1, '0']) {
    setProducts([{ key: 'store-a:1', name: 'Тест', quantity }]);
    assert.equal(service.preview(portal.id).rows[0].stock, null);
    assert.equal(service.preview(portal.id).rows[0].need, null);
  }
});

test('categories, portals and optimistic version persist on disk', t => {
  const { service, category, portal, options } = fixture(t);
  assert.deepEqual(create(options).read(), service.read());
  assert.deepEqual(create(options).preview(portal.id), service.preview(portal.id));
  assert.throws(() => service.saveCategory({ version: 0, id: category.id, name: 'Устаревшее', productKeys: [] }), e => e.status === 409 && e.public);
  service.saveCategory({ version: 3, id: category.id, name: 'Крепёж обновлён', productKeys: ['store-a:1'] });
  assert.equal(service.preview(portal.id).rows.length, 1);
  assert.equal(service.preview(portal.id).rows[0].category, 'Крепёж обновлён');
  assert.equal(create(options).read().version, 4);
});

test('target validation rejects values outside integer and category bounds', t => {
  const { service, category, portal } = fixture(t);
  const save = targets => service.savePortal({ version: 3, id: portal.id, name: 'Тестовый поставщик', categoryIds: [category.id], targets });
  for (const target of [-1, 1.5, '3', null, Infinity, NaN, 100000001]) assert.throws(() => save({ 'store-a:1': target }), e => e.status === 400);
  assert.throws(() => save({ 'store-a:4': 10 }), /вне выбранных категорий/);
  assert.throws(() => save([]), /корректные целевые/);
  save({ 'store-a:1': 0, 'store-b:2': 100 });
  assert.equal(service.read().portals[0].targets['store-a:1'], 0);
  assert.equal(service.preview(portal.id).rows[0].need, 37, 'Legacy manual target cannot replace 45-day forecast');
});

test('invalid categories cannot widen a portal scope and missing products are explicit', t => {
  const { service, category, portal, setProducts } = fixture(t);
  assert.throws(() => service.savePortal({ version: 3, name: 'Другой', categoryIds: ['unknown'] }), /не найдена/);
  assert.throws(() => service.savePortal({ version: 3, name: 'Другой', categoryIds: [] }), /хотя бы одну/);
  assert.throws(() => service.saveCategory({ version: 3, name: 'Дубликат', productKeys: ['store-a:1'] }), /другой категории/);
  assert.throws(() => service.saveCategory({ version: 3, name: 'Чужие товары', productKeys: ['not-a-product'] }), /отсутствует/);
  assert.throws(() => service.preview('unknown'), e => e.status === 404);
  setProducts([]);
  const preview = service.preview(portal.id);
  assert.equal(preview.rows.length, 0);
  assert.equal(preview.missingProducts, 3);
  service.saveCategory({ version: 3, id: category.id, name: 'Крепёж', productKeys: ['store-a:1'] });
  assert.equal(service.preview(portal.id).missingProducts, 1);
});

test('prototype-like product keys are handled as data, not inherited targets', t => {
  const { service, portal, category, setProducts } = fixture(t);
  setProducts([{ key: '__proto__', name: 'Тест', quantity: 2 }]);
  service.saveCategory({ version: 3, id: category.id, name: 'Крепёж', productKeys: ['__proto__'] });
  service.savePortal({ version: 4, id: portal.id, name: 'Тестовый поставщик', categoryIds: [category.id], targets: JSON.parse('{"__proto__":9}') });
  assert.equal(Object.hasOwn(service.read().portals[0].targets, '__proto__'), true);
  assert.equal(service.preview(portal.id).rows[0].need, null);
});

test('owner page loads, opens both editors and renders forecast without missing DOM elements', async t => {
  const vm = require('node:vm');
  const { service, portal } = fixture(t);
  const html = fs.readFileSync(path.join(__dirname, '../dist/suppliers.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '../dist/suppliers.js'), 'utf8');
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, {
    value: '', innerHTML: '', textContent: '', hidden: false, disabled: false, checked: false,
    showModal() { this.open = true; }, close() { this.open = false; }, scrollIntoView() {},
    querySelector() { return { disabled: false }; }
  }]));
  const context = vm.createContext({
    document: { getElementById(id) { assert.ok(nodes.has(id), 'Missing DOM id: ' + id); return nodes.get(id); }, querySelectorAll() { return []; } },
    Intl, Date, structuredClone,
    fetch: async url => ({ ok: true, json: async () => url.includes('/preview?') ? service.preview(portal.id) : service.read() })
  });
  vm.runInContext(script, context);
  await vm.runInContext('load()', context);
  assert.equal(nodes.get('new-category').disabled, false);
  vm.runInContext('openCategory()', context);
  assert.equal(nodes.get('category-editor').open, true);
  assert.match(nodes.get('category-products').innerHTML, /Синтетический болт/);
  vm.runInContext('openPortal()', context);
  assert.equal(nodes.get('portal-editor').open, true);
  await vm.runInContext('openPreview(' + JSON.stringify(portal.id) + ')', context);
  assert.equal(nodes.get('preview-panel').hidden, false);
  assert.match(nodes.get('preview-rows').innerHTML, />37</);
  assert.match(nodes.get('preview-rows').innerHTML, /Не рассчитано/);
  assert.ok(!nodes.get('preview-rows').innerHTML.includes('NaN'));
  nodes.get('stock-view').value = 'warehouses';
  vm.runInContext('renderPreview()', context);
  assert.match(nodes.get('preview-rows').innerHTML, /FBO · тип склада/);
  assert.match(nodes.get('preview-rows').innerHTML, /детализации конкретных складов нет/);
  assert.match(nodes.get('preview-rows').innerHTML, /Прогноз по отдельным складам не рассчитывается/);
});

test('WB warehouses aggregate same-name rows and Ozon exposes types without inventing warehouse names', t => {
  const { service, portal, setProducts } = fixture(t);
  let preview = service.preview(portal.id);
  assert.deepEqual(preview.rows[0].warehouseBreakdown.rows, [{ name: 'FBO', kind: 'type', stock: 6 }, { name: 'FBS', kind: 'type', stock: 2 }]);
  assert.equal(preview.rows[0].warehouseBreakdown.complete, true);
  assert.equal(preview.rows[0].warehouseBreakdown.totalMatches, true);
  setProducts([{ key: 'store-a:1', market: 'WB', quantity: 8, warehouseRows: [
    { warehouse: 'Склад А', present: 3, price: 999 }, { warehouse: 'Склад А', present: '2', cost: 888 }, { warehouse: 'Склад Б', present: 3 }
  ] }]);
  preview = service.preview(portal.id);
  assert.deepEqual(preview.rows[0].warehouseBreakdown.rows, [{ name: 'Склад А', kind: 'warehouse', stock: 5 }, { name: 'Склад Б', kind: 'warehouse', stock: 3 }]);
  assert.equal(preview.rows[0].stock, 8);
  assert.equal(preview.rows[0].warehouseBreakdown.totalMatches, true);
  assert.ok(!JSON.stringify(preview).includes('999'));
  assert.ok(!JSON.stringify(preview).includes('888'));
});

test('warehouse invalid, missing and mismatched counts remain unknown and disable an unsafe forecast', t => {
  const { service, portal, setProducts } = fixture(t);
  for (const present of [null, undefined, '', ' ', 'broken', -2, Infinity, NaN, false]) {
    setProducts([{ key: 'store-a:1', quantity: 3, warehouseRows: [{ warehouse: 'Склад А', present: 3 }, { warehouse: 'Склад А', present }] }]);
    const row = service.preview(portal.id).rows[0];
    assert.equal(row.warehouseBreakdown.rows[0].stock, null);
    assert.equal(row.warehouseBreakdown.complete, false);
    assert.equal(row.warehouseBreakdown.totalMatches, null);
    assert.equal(row.stock, null);
    assert.equal(row.need, null);
  }
  setProducts([{ key: 'store-a:1', quantity: 8, warehouseRows: [{ warehouse: 'Склад А', present: 7 }] }]);
  let row = service.preview(portal.id).rows[0];
  assert.equal(row.warehouseBreakdown.totalMatches, false);
  assert.equal(row.stock, null);
  assert.equal(row.need, null);
  assert.match(row.warehouseBreakdown.description, /не совпадает/);
  setProducts([{ key: 'store-a:1', quantity: 0, warehouseRows: [] }]);
  row = service.preview(portal.id).rows[0];
  assert.equal(row.stock, 0);
  assert.equal(row.warehouseBreakdown.complete, false);
  assert.deepEqual(row.warehouseBreakdown.rows, []);
  setProducts([{ key: 'store-a:1', quantity: 8, warehouseRows: [{ present: 8 }] }]);
  row = service.preview(portal.id).rows[0];
  assert.equal(row.stock, 8);
  assert.equal(row.warehouseBreakdown.complete, false);
  assert.deepEqual(row.warehouseBreakdown.rows, [{ name: 'Склад не указан', kind: 'unknown', stock: 8 }]);
});
