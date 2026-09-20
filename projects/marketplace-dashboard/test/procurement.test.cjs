'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createProcurement = require('../procurement.cjs');
function setup(t) {
  const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'procurement-test-'));
  t.after(() => fs.rmSync(privateDir, { recursive: true, force: true }));
  const now = () => '2026-09-18T12:00:00.000Z';
  return { api: createProcurement({ privateDir, now }), privateDir, now };
}
const request = (api, items) => api.saveRequest({ version: api.read().version, title: 'Заявка', items });
const price = (api, text, extra = {}) => api.importPriceList({ version: api.read().version, supplierName: 'Поставщик', sourceName: 'Прайс.csv', text, ...extra });

test('free text never treats dimensions as quantities or unmarked SKUs', t => {
  const { api, privateDir } = setup(t);
  const result = api.parseRequest({ text: 'Болт M8x40\nГайка DIN934 M8 20 шт\nКабель артикул: ABC-1 12,5 м' });
  assert.equal(result.items[0].quantity, null);
  assert.equal(result.items[0].article, '');
  assert.equal(result.items[1].quantity, 20);
  assert.equal(result.items[1].name, 'Гайка DIN934 M8');
  assert.equal(result.items[2].article, 'ABC-1');
  assert.equal(result.items[2].quantity, 12.5);
  assert.equal(result.items[2].unit, 'м');
  assert.ok(result.warnings.length);
  assert.equal(fs.existsSync(path.join(privateDir, 'procurement.json')), false);
});
test('request table recognizes explicit SKU, quantity and unit headers', t => {
  const { api } = setup(t);
  const result = api.parseRequest({ text: '\uFEFFАртикул\tНаименование\tКол-во\tЕд. изм.\nA1\tБолт M8x40\t2\tшт.' });
  assert.equal(result.items[0].article, 'A1');
  assert.equal(result.items[0].quantity, 2);
  assert.equal(result.items[0].unit, 'шт');
});

test('explicit dotted article labels separate SKU from product names and quantities', t => {
  const { api } = setup(t);
  const result = api.parseRequest({ text: 'Тестовый кабель, арт. TC-A-137352, 2 шт\nТестовый выключатель, арт. TC-B-137352, 3 шт' });
  assert.deepEqual(result.items.map(({name,article,quantity,unit}) => ({name,article,quantity,unit})), [
    {name:'Тестовый кабель',article:'TC-A-137352',quantity:2,unit:'шт'},
    {name:'Тестовый выключатель',article:'TC-B-137352',quantity:3,unit:'шт'}
  ]);
});

test('explicit article punctuation is accepted while unmarked names remain intact', t => {
  const { api } = setup(t);
  for (const marker of ['арт.', 'АРТ.:', 'арт:', 'артикул', 'артикул:', 'SKU:']) {
    const [item] = api.parseRequest({ text: `Кабель; ${marker} AB-1/2.3; 2 шт` }).items;
    assert.equal(item.article, 'AB-1/2.3', marker);
    assert.equal(item.name, 'Кабель', marker);
    assert.equal(item.quantity, 2, marker);
  }
  for (const name of ['Светильник арт деко', 'Кабель TC-A-137352', 'Болт M8x40', 'Артикульный каталог', 'Картон', 'Стандарт', 'Кабель арт.ABC']) {
    const [item] = api.parseRequest({ text: `${name}, 2 шт` }).items;
    assert.equal(item.article, '', name);
    assert.equal(item.name, name);
  }
  const [wrapped] = api.parseRequest({text:'Кабель (арт. AB-1), 2 шт'}).items;
  assert.equal(wrapped.article, 'AB-1');
  assert.equal(wrapped.name, 'Кабель');
});

test('conflicting explicit articles require manual correction without losing their text', t => {
  const { api } = setup(t);
  const parsed = api.parseRequest({ text:'Кабель, арт. A-1, артикул: B-2, 2 шт' });
  assert.equal(parsed.items[0].article, '');
  assert.match(parsed.items[0].name, /A-1/);
  assert.match(parsed.items[0].name, /B-2/);
  assert.ok(parsed.warnings.some(warning => /несколько артикулов/.test(warning)));
  parsed.items[0].article = 'B-2'; parsed.items[0].name = 'Кабель';
  const saved = request(api, parsed.items);
  assert.equal(saved.requests[0].items[0].article, 'B-2');
});
test('semicolon CSV preserves quoted multiline values and provenance', t => {
  const { api } = setup(t);
  const state = price(api, '\uFEFFАртикул;Наименование;Цена;Остаток;Ед.изм.;НДС\nA1;"Болт; крепёж\nM8x40";"1 234,50";;шт;с НДС\nA2;"Гайка ""DIN""";0;0;шт;без НДС', { priceDate: '2026-09-01' });
  const rows = state.priceLists[0].rows;
  assert.equal(rows[0].price, 1234.5);
  assert.equal(rows[0].stock, null);
  assert.equal(rows[0].name, 'Болт; крепёж\nM8x40');
  assert.equal(rows[1].name, 'Гайка "DIN"');
  assert.equal(rows[1].sourceRow, 4);
  assert.equal(rows[1].stock, 0);
  assert.equal(rows[1].price, 0);
  assert.equal(rows[1].vatBasis, 'no-vat');
});
test('comma CSV and TSV use correct delimiter', t => {
  const { api } = setup(t);
  price(api, 'name,price,stock,unit\nBolt,"12,50",,шт');
  const result = price(api, 'Наименование\tЦена\tНаличие\tЕд.изм.\nГайка\t2\t0\tшт');
  assert.equal(result.priceLists[0].rows[0].price, 12.5);
  assert.equal(result.priceLists[1].rows[0].stock, 0);
});
test('invalid imports are atomic, missing prices and malformed quotes are actionable', t => {
  const { api } = setup(t);
  for (const text of ['Наименование;Цена\nБолт;5\nГайка;', 'Наименование;Цена\n"Болт;5', 'Наименование;Цена\nБолт;5;6', 'Наименование;Цена\nБолт;-1']) {
    assert.throws(() => price(api, text), error => error.public && error.status === 400 && /Строка/.test(error.message));
    assert.equal(api.read().version, 0);
    assert.equal(api.read().priceLists.length, 0);
  }
});
test('saving persists, returns independent data and detects stale factory versions', t => {
  const { api, privateDir, now } = setup(t);
  const other = createProcurement({ privateDir, now });
  const saved = request(api, [{ name: 'Болт', quantity: 10, unit: 'шт' }]);
  saved.requests[0].title = 'Изменено только снаружи';
  assert.equal(other.read().requests[0].title, 'Заявка');
  assert.throws(() => other.saveRequest({ version: 0, title: 'Устаревшая', items: [{ name: 'Гайка' }] }), error => error.status === 409);
  assert.equal(createProcurement({ privateDir, now }).read().requests[0].items[0].quantity, 10);
});
test('exact articles preserve punctuation; conflicting articles only become manual candidates', t => {
  const { api } = setup(t);
  const saved = request(api, [{ name: 'Болт', article: 'A-1', quantity: 2, unit: 'шт' }]);
  price(api, 'Артикул;Наименование;Цена;Ед.изм.\na-1;Болт;15;шт\nA1;Болт;10;шт', { vatBasis: 'included' });
  const row = api.compare({ requestId: saved.id }).items[0];
  assert.equal(row.offers.length, 1);
  assert.equal(row.offers[0].match, 'article');
  assert.equal(row.offers[0].comparable, true);
  assert.equal(row.candidates.length, 1);
  assert.equal(row.candidates[0].needsManualReview, true);
  assert.equal(row.candidates[0].comparable, false);
  assert.equal(row.offers[0].source.verification, 'user-provided-not-live-verified');
  assert.equal(row.offers[0].source.importedAt, '2026-09-18T12:00:00.000Z');
});
test('unknown units, VAT and duplicate article variants require caution', t => {
  const { api } = setup(t);
  const saved = request(api, [{ name: 'Болт M8', article: 'A', quantity: 2, unit: 'шт' }, { name: 'Гайка', unit: 'шт' }]);
  price(api, 'Артикул;Наименование;Цена;Ед.изм.;НДС\nA;Болт M8;10;шт;с НДС\nA;Болт M10;9;шт;с НДС\nB;Гайка;5;шт;20%');
  const result = api.compare({ requestId: saved.id });
  assert.ok(result.items[0].offers.every(offer => offer.needsManualReview && !offer.comparable));
  assert.equal(result.items[1].offers[0].vatBasis, 'unknown');
  assert.equal(result.items[1].offers[0].vatText, '20%');
  assert.equal(result.items[1].offers[0].comparable, false);
});
test('name match requires unit agreement, fuzzy suggestions remain manual', t => {
  const { api } = setup(t);
  const saved = request(api, [{ name: 'Болт M8 оцинкованный', unit: 'шт' }]);
  price(api, 'Наименование;Цена;Ед.изм.\nБолт M8 оцинкованный;5;уп\nБолт M8 оцинкованный DIN;7;шт\nБолт M8 оцинкованный;8;', { vatBasis: 'included' });
  const row = api.compare({ requestId: saved.id }).items[0];
  assert.equal(row.offers.length, 0);
  assert.equal(row.candidates.length, 3);
  assert.ok(row.candidates.every(candidate => !candidate.comparable && candidate.needsManualReview));
});
test('different currencies and VAT bases stay separate without a cheapest winner', t => {
  const { api } = setup(t);
  const saved = request(api, [{ name: 'Болт', unit: 'шт' }]);
  price(api, 'Наименование;Цена;Ед.изм.;Валюта;НДС\nБолт;1;шт;USD;с НДС\nБолт;80;шт;RUB;без НДС');
  const result = api.compare({ requestId: saved.id });
  assert.equal(result.items[0].mixedConditions, true);
  assert.equal(result.items[0].winner, undefined);
  assert.deepEqual(result.items[0].offers.map(o => o.currency), ['USD', 'RUB']);
});
test('input bounds, missing names, invalid date and corrupt state fail safely', t => {
  const { api, privateDir, now } = setup(t);
  assert.throws(() => api.parseRequest({ text: 'Болт\n'.repeat(101) }), /100 позиций/);
  assert.throws(() => api.parseRequest({ text: 'я'.repeat(600000) }), /1 МБ/);
  assert.throws(() => price(api, 'Наименование;Цена\nБолт;5', { priceDate: '2026-02-30' }), /Дата прайса/);
  assert.throws(() => request(api, [{ name: ' ', quantity: 1 }]), /Наименование/);
  assert.throws(() => price(api, 'Наименование;Цена\nБолт;1\n'.replace(/\n$/, '') + '\nБолт;1'.repeat(5000)), /5000 товаров/);
  fs.writeFileSync(path.join(privateDir, 'procurement.json'), '{bad json');
  assert.throws(() => createProcurement({ privateDir, now }), error => error.public && error.status === 500);
});
