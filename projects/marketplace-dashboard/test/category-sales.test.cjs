'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { build, sharedCategories } = require('../category-sales.cjs');
const options = { now: '2026-09-18T12:00:00Z', from: '2026-09-15', to: '2026-09-17' };
const categories = [{ id: 'fasteners', name: 'Крепёж', productKeys: ['oz:10', 'wb:20'] }, { id: 'paper', name: 'Бумага', productKeys: ['oz:11', 'wb:21'] }];
const counts = (sold = 0, returned = 0) => ({ sold, returned, net: sold - returned });
const productTypes = () => ({ schemaVersion: 1, revision: 'types-5', reviewedAt: '2026-09-20T11:00:00Z', types: [
  { id: 'goods', parentId: null, name: 'Товары' },
  { id: 'fasteners', parentId: 'goods', name: 'Крепёж' },
  { id: 'screws', parentId: 'fasteners', name: 'Саморезы' },
  { id: 'metal', parentId: 'screws', name: 'Металлические' },
  { id: 'black', parentId: 'metal', name: 'Чёрные' },
  { id: 'yellow', parentId: 'metal', name: 'Жёлтые' }
], assignments: {
  'oz:10': { typeId: 'black', source: 'reviewed' },
  'oz:11': { typeId: 'black', source: 'reviewed' },
  'wb:20': { typeId: 'yellow', source: 'reviewed' }
}, rules: [] });
function ozon() {
  return { id: 'oz', name: 'Тест Ozon', market: 'Ozon', products: [{ key: 'oz:10', sku: '100', skus: ['100', '101'] }, { key: 'oz:11', sku: '110' }], ledger: { version: 3, complete: true, period: { from: options.from, to: options.to }, completedAt: '2026-09-18T00:00:00Z', daily: [{ date: '2026-09-15', values: { soldUnits: 985, salesRows: 4 } }, { date: '2026-09-16', values: { returnedUnits: 1, salesRows: 1 } }], skuDaily: [
    { date: '2026-09-15', sku: '100', values: { soldUnits: 2, salesRows: 1 } },
    { date: '2026-09-15', sku: '101', values: { soldUnits: 3, salesRows: 1 } },
    { date: '2026-09-16', sku: '101', values: { returnedUnits: 1, salesRows: 1 } },
    { date: '2026-09-15', sku: '110', values: { soldUnits: 80, salesRows: 1 } },
    { date: '2026-09-15', sku: 'unlinked', values: { soldUnits: 900, salesRows: 1 } }
  ] } };
}
function wb() {
  return { id: 'wb', name: 'Тест WB', market: 'WB', products: [{ key: 'wb:20', product_id: '20' }, { key: 'wb:21', product_id: '21' }], finance: { period: { from: options.from, to: options.to }, sections: { finance: { ok: true } }, completedAt: '2026-09-18T00:00:00Z', operations: [
    { rrdId: '1', reportId: 'r', nmId: 20, rrDate: '2026-09-15T00:00:00', saleDt: '2026-08-01', sellerOperName: 'Продажа', quantity: 4 },
    { rrdId: '2', reportId: 'r', nmId: 20, rrDate: '2026-09-16', sellerOperName: 'Возврат', quantity: '2' },
    { rrdId: '3', reportId: 'r', nmId: 21, rrDate: '2026-09-17', sellerOperName: 'Продажа', quantity: 60 },
    { rrdId: '4', reportId: 'r', nmId: 20, rrDate: '2026-09-17', sellerOperName: 'Компенсация', quantity: 30 },
    { rrdId: '5', reportId: 'r', nmId: 20, rrDate: '2026-09-17', sellerOperName: 'Корректная продажа', quantity: 40 }
  ] } };
}
function selected(stores, extra = {}) { return build(stores, categories, { ...options, category: 'fasteners', ...extra }); }

test('shared category sums unambiguous Ozon aliases and WB, excluding other categories and unlinked sales', () => {
  const result = selected([ozon(), wb()]);
  assert.deepEqual(result.series[0].Ozon, counts(5));
  assert.deepEqual(result.series[0].WB, counts(4));
  assert.deepEqual(result.series[0].total, counts(9));
  assert.deepEqual(result.series[1].total, counts(0, 3));
  assert.deepEqual(result.series[2].total, counts());
  assert.deepEqual(result.totals.total, counts(9, 3));
  assert.equal(result.coverage.complete, true);
});
test('all products includes historical units outside catalog; filters retain shared category registry', () => {
  const all = selected([ozon(), wb()], { category: '' });
  assert.deepEqual(all.totals.total, counts(1049, 3));
  const onlyWb = selected([ozon(), wb()], { market: 'WB' });
  assert.equal(onlyWb.totals.Ozon, null);
  assert.deepEqual(onlyWb.totals.total, counts(4, 2));
  assert.equal(onlyWb.categories.length, 2);
  assert.deepEqual(selected([ozon(), wb()], { store: 'oz' }).totals.total, counts(5, 1));
});
test('SKU collision with a product outside selected category makes Ozon unknown', () => {
  const o = ozon(); o.products[1].skus = ['101'];
  const result = selected([o, wb()]);
  assert.equal(result.series[0].Ozon, null);
  assert.deepEqual(result.series[0].WB, counts(4));
  assert.equal(result.series[0].total, null);
  assert.equal(result.totals.total, null);
});
test('missing product or missing aliases cannot turn into zero', () => {
  const o = ozon(); o.products = o.products.slice(1);
  assert.equal(selected([o]).totals.Ozon, null);
  const p = ozon(); delete p.products[0].sku; delete p.products[0].skus;
  assert.equal(selected([p]).totals.Ozon, null);
});
test('WB exact operation rules, rrDate and safe composite ID dedup', () => {
  const w = wb(); w.finance.operations.push({ ...w.finance.operations[0], rrdId: 1 });
  w.finance.operations.push({ ...w.finance.operations[0], reportId: 'other' });
  const result = selected([w]);
  assert.deepEqual(result.series[0].WB, counts(8));
  assert.deepEqual(result.series[2].WB, counts());
  assert.deepEqual(result.totals.WB, counts(8, 2));
});
test('unsafe numeric WB IDs are not deduplicated', () => {
  const w = wb(); w.finance.operations[0].rrdId = Number.MAX_SAFE_INTEGER + 1;
  w.finance.operations.push({ ...w.finance.operations[0] });
  assert.deepEqual(selected([w]).series[0].WB, counts(8));
});
test('absent and fractional WB units remain unknown only for the affected day/category', () => {
  for (const invalid of [undefined, null, '', -1, 1.5, 'bad']) {
    const w = wb(); w.finance.operations[0].quantity = invalid;
    const result = selected([w]);
    assert.equal(result.series[0].WB, null);
    assert.deepEqual(result.series[1].WB, counts(0, 2));
    assert.equal(result.totals.WB, null);
  }
  const w = wb(); delete w.finance.operations[2].quantity;
  assert.deepEqual(selected([w]).totals.WB, counts(4, 2));
});
test('WB missing dates invalidate coverage; no saleDt fallback', () => {
  const w = wb(); delete w.finance.operations[0].rrDate;
  assert.equal(selected([w]).coverage.coveredDays, 0);
});
test('WB observed report horizon and imported period produce gaps', () => {
  const w = wb(); w.finance.operations = w.finance.operations.slice(0, 2);
  const result = selected([w]);
  assert.equal(result.series[2].WB, null);
  assert.equal(result.coverage.coveredDays, 2);
  assert.equal(result.totals.WB, null);
  w.finance.operations = [];
  assert.equal(selected([w]).coverage.coveredDays, 0);
});
test('Ozon coverage validates ledger version, completion and imported dates', () => {
  const o = ozon(); o.ledger.period.from = '2026-09-16';
  const result = selected([o, wb()]);
  assert.equal(result.series[0].total, null);
  assert.deepEqual(result.series[2].total, counts());
  for (const override of [{ version: 2 }, { complete: false }, { foreignRecords: 1 }]) {
    const o = ozon(); Object.assign(o.ledger, override);
    assert.equal(selected([o]).coverage.coveredDays, 0);
  }
});
test('unknown Ozon units and duplicate sku-day rows are gaps, not zero or double-counted', () => {
  const o = ozon(); o.ledger.skuDaily[0].values.unknownUnitRows = 1;
  assert.equal(selected([o]).series[0].Ozon, null);
  const p = ozon(); p.ledger.skuDaily.push({ ...p.ledger.skuDaily[0] });
  assert.equal(selected([p]).series[0].Ozon, null);
  const q = ozon(); q.ledger.skuDaily[0].values = { salesRows: 1 };
  assert.equal(selected([q]).series[0].Ozon, null);
});
test('empty categories, empty scope, dates and query validation', () => {
  const empty = build([], [], options);
  assert.equal(empty.productCount, 0);
  assert.equal(empty.totals.total, null);
  assert.equal(selected([ozon(), wb()], { store: 'oz', market: 'WB' }).productCount, 0);
  for (const extra of [{ category: 'missing' }, { store: 'missing' }, { market: 'bad' }, { to: '2026-09-18' }, { from: '2026-02-30' }]) assert.throws(() => selected([ozon()], extra));
  const recent = build([], [], { now: '2026-09-17T22:00:00Z', days: 7 });
  assert.deepEqual(recent.period, { from: '2026-09-11', to: '2026-09-17', days: 7, completedDaysOnly: true });
});
test('automatic categories use explicit leading nouns with Cyrillic boundaries and manual priority', () => {
  const names = ['Саморезы 4х20', 'Саморез, оцинкованный', 'Гвоздевые пластины', 'Гвозди 90', 'Гвоздика', 'Набор саморезов', 'Тент (строительный)', 'Гайка М10', 'Шайбы стальные', 'Болт-М8', 'Дюбель: 10', 'Шпильки М6', 'Перчатки', 'Термоэтикетки 58х40', 'Этикетка белая', 'Уголок'];
  const products = names.map((name, i) => ({ key: 'oz:' + i, name }));
  const groups = sharedCategories([{ products }], [{ id: 'manual', name: 'Моя группа', productKeys: ['oz:0'] }]);
  assert.deepEqual(groups.find(c => c.id === 'manual').productKeys, ['oz:0']);
  assert.deepEqual(groups.find(c => c.id === 'auto:screws').productKeys, ['oz:1']);
  assert.deepEqual(groups.find(c => c.id === 'auto:nails').productKeys, ['oz:3']);
  assert.deepEqual(groups.find(c => c.id === 'auto:uncategorized').productKeys, ['oz:2', 'oz:4', 'oz:5', 'oz:15']);
  assert.deepEqual(groups.find(c => c.id === 'auto:labels').productKeys, ['oz:13', 'oz:14']);
  assert.equal(new Set(groups.flatMap(c => c.productKeys)).size, products.length);
  assert.equal(groups.flatMap(c => c.productKeys).length, products.length);
});
test('automatic shared type merges markets without changing manual registry', () => {
  const o = ozon(), w = wb(); o.products[0].name = 'Саморезы 4х20'; w.products[0].name = 'Саморез 5х30';
  const registry = [], before = JSON.stringify(registry);
  const result = build([o, w], registry, { ...options, category: 'auto:screws' });
  assert.deepEqual(result.totals.total, counts(9, 3));
  assert.equal(result.productCount, 2);
  assert.equal(JSON.stringify(registry), before);
});
test('five-level taxonomy exposes full paths, parents include descendants once, and manual groups keep priority', () => {
  const manual = [{ id: 'manual-paper', name: 'Бумага поставщика', productKeys: ['oz:11'] }], registry = productTypes();
  const parent = build([ozon(), wb()], manual, { ...options, category: 'type:goods', productTypes: registry });
  assert.deepEqual(parent.totals.total, counts(9, 3));
  assert.equal(parent.productCount, 2);
  assert.equal(parent.categories.find(row => row.id === 'type:goods').productCount, 2);
  assert.deepEqual(parent.categories.find(row => row.id === 'type:black').path, ['Товары', 'Крепёж', 'Саморезы', 'Металлические', 'Чёрные']);
  assert.equal(parent.categories.find(row => row.id === 'type:black').depth, 5);
  assert.deepEqual(parent.categories.find(row => row.id === 'manual-paper'), { id: 'manual-paper', parentId: null, name: 'Бумага поставщика', path: ['Бумага поставщика'], depth: 1, origin: 'manual', productCount: 1 });
  assert.deepEqual(build([ozon(), wb()], manual, { ...options, category: 'type:black', productTypes: registry }).totals.total, counts(5, 1));
  assert.deepEqual(build([ozon(), wb()], manual, { ...options, category: 'type:yellow', market: 'WB', productTypes: registry }).totals.total, counts(4, 2));
  assert.deepEqual(build([ozon(), wb()], manual, { ...options, productTypes: registry }).totals.total, counts(1049, 3));
  assert.equal(parent.taxonomyRevision, 'types-5');
});
test('missing or invalid taxonomy preserves the legacy automatic category fallback', () => {
  const stores = [ozon()]; stores[0].products[0].name = 'Саморезы 4х20';
  assert.ok(build(stores, [], { ...options, productTypes: { available: false } }).categories.some(row => row.id === 'auto:screws'));
  assert.ok(build(stores, [], { ...options, productTypes: { schemaVersion: 99 } }).categories.some(row => row.id === 'auto:screws'));
});
test('category sales UI labels taxonomy options by their full path and styles the fifth level', () => {
  const fs = require('node:fs'), ui = fs.readFileSync(require.resolve('../dist/category-sales.js'), 'utf8'), css = fs.readFileSync(require.resolve('../dist/seller-analytics.css'), 'utf8');
  assert.match(ui, /c\.path\.join\(' › '\)/);
  assert.match(css, /data-category-depth="5"/);
  assert.doesNotMatch(css, /data-category-depth="4"/);
});
