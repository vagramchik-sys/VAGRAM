'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { selectCategory } = require('../product-category-site-mapping.cjs');

test('selects explicit wood screw colour and keeps an unknown colour at the reliable site parent', () => {
  assert.equal(selectCategory('screw-wood', { name: 'Саморезы по дереву, черные 4,2 х 64 мм' }, {}), 'Саморезы черные по дереву');
  assert.equal(selectCategory('screw-wood', { name: 'Саморез по дереву 5х60' }, { color: { id: 'yellow' } }), 'Саморезы желтые по дереву');
  assert.equal(selectCategory('screw-wood', { name: 'Саморез по дереву 5х60' }, {}), 'Саморезы');
});

test('splits construction nails only with explicit finish evidence', () => {
  assert.equal(selectCategory('nail-construction', { name: 'Гвозди строительные оцинкованные 3х70' }, {}), 'Гвозди строительные оцинкованные');
  assert.equal(selectCategory('nail-construction', { name: 'Гвозди 150 мм строительные черные' }, {}), 'Гвозди строительные черные');
  assert.equal(selectCategory('nail-construction', { name: 'Гвозди строительные 100 мм' }, {}), 'Гвозди');
});

test('recognizes a nylon insert without guessing a standard from the family', () => {
  assert.equal(selectCategory('oldnut-hex', { name: 'Гайка M14 с нейлоновой вставкой' }, {}), 'Гайки');
  assert.equal(selectCategory('nut-hex', { name: 'Гайка оцинкованная М18 шестигранная' }, {}), 'Гайки');
  assert.equal(selectCategory('nut-hex', { name: 'Гайка оцинкованная М18 DIN 934 шестигранная' }, {}), 'Гайка оцинкованная DIN 934');
});

test('a narrow explicit name corrects a stale tape family', () => {
  assert.equal(selectCategory('tape-packing-clear', { name: 'Малярная лента синяя 48 мм' }, { color: { id: 'blue' } }), 'Скотч');
  assert.equal(selectCategory('tape-masking', { name: 'Алюминиевый скотч 50 мм' }, {}), 'Алюминиевый скотч');
});

test('returns a reliable parent or null instead of inventing a category', () => {
  assert.equal(selectCategory('screw-metal', { name: 'Саморез по металлу 4,2х16' }, {}), 'Саморезы');
  assert.equal(selectCategory('bucket-plastic', { name: 'Ведро строительное пластиковое' }, {}), null);
  assert.equal(selectCategory('family-not-reviewed', { name: 'Что-то новое' }, {}), null);
});

test('does not override an unresolved or conflicting colour facet with title words', () => {
  assert.equal(selectCategory('screw-wood', { name: 'Саморез черный или желтый по дереву' }, { color: null }), 'Саморезы');
  assert.equal(selectCategory('nail-construction', { name: 'Гвозди строительные не черные' }, {}), 'Гвозди');
  assert.equal(selectCategory('nail-construction', { name: 'Гвозди черные и желтые строительные' }, {}), 'Гвозди');
});

test('keeps unknown mesh and roofing variants at their exact public parents', () => {
  assert.equal(selectCategory('mesh-rodent-unspecified', { name: 'Сетка металлическая от грызунов' }, {}), 'Сетка');
  assert.equal(selectCategory('mesh-metal-welded', { name: 'Сетка сварная строительная' }, {}), 'Сетка');
  assert.equal(selectCategory('mesh-metal-welded', { name: 'Сетка сварная оцинкованная в рулоне' }, {}), 'Сетка сварная оцинкованная в рулонах');
  assert.equal(selectCategory('screw-roof-metal', { name: 'Саморез кровельный 4,8х35' }, {}), 'Саморезы для кровли');
  assert.equal(selectCategory('screw-roof-metal', { name: 'Саморез кровельный RAL 3005 4,8х35' }, {}), 'Саморезы для кровли крашенные');
  assert.equal(selectCategory('screw-roof-metal', { name: 'Саморез кровельный с увеличенным сверлом' }, {}), 'Саморезы для кровли');
  assert.equal(selectCategory('screw-roof-metal', { name: 'Саморез кровельный оцинкованный с увеличенным сверлом' }, {}), 'Саморезы для кровли оцинкованные с увеличенным сверлом');
});

test('requires explicit subtype evidence for standards, brands and press-washer points', () => {
  assert.equal(selectCategory('bolt-standard', { name: 'Болт с полной резьбой' }, {}), 'Болты');
  assert.equal(selectCategory('washer-large', { name: 'Шайба усиленная' }, {}), 'Шайбы');
  assert.equal(selectCategory('screw-metal-press', { name: 'Саморез с прессшайбой' }, {}), 'Саморезы');
  assert.equal(selectCategory('screw-structural', { name: 'Саморез конструкционный' }, {}), 'Саморезы');
  assert.equal(selectCategory('screw-universal', { name: 'Саморез универсальный' }, {}), 'Саморезы');
  assert.equal(selectCategory('screw-universal', { name: 'Саморез универсальный POZI' }, {}), 'Саморез универсальный (Pz)');
  assert.equal(selectCategory('tool-battery', { name: 'Аккумулятор для инструмента' }, {}), null);
  assert.equal(selectCategory('tool-battery', { name: 'Аккумулятор для инструмента Toua' }, {}), 'Аккумуляторы для инструментов Toua');
});

test('every category literal returned by the selector exists in the captured public site tree', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'product-category-site-mapping.cjs'), 'utf8');
  const tree = require('../stalkrepej-category-tree.json');
  const occurrences = new Map();
  for (const item of tree.paths) {
    const name = item.names.at(-1);
    occurrences.set(name, (occurrences.get(name) || 0) + 1);
  }
  const returnedNames = [...source.matchAll(/:\s*'([^']+)'|return\s+'([^']+)'/gu)].map(match => match[1] || match[2]);
  for (const name of new Set(returnedNames)) {
    assert.ok(occurrences.has(name), `Нет категории сайта «${name}»`);
    if (!['Инструменты', 'Расходные материалы'].includes(name)) assert.equal(occurrences.get(name), 1, `Неоднозначная категория сайта «${name}»`);
  }
});
