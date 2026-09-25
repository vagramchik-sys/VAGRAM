'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { rebuildFromSite } = require('../product-category-site.cjs');
const { rebuild } = require('../product-category-rebuild.cjs');
const { options } = require('../scripts/refine-product-categories.cjs');
const tree = require('../stalkrepej-category-tree.json');
const reviewedAt = '2026-09-25T08:00:00Z';
function fixture() {
  return { schemaVersion: 1, revision: 'old', reviewedAt, types: [
    { id: 'fasteners', parentId: null, name: 'Крепёж' },
    { id: 'screws', parentId: 'fasteners', name: 'Саморезы' },
    { id: 'screw-wood', parentId: 'screws', name: 'Саморез по дереву' },
    { id: 'angle-reinforced', parentId: 'fasteners', name: 'Уголок крепёжный усиленный' },
    { id: 'absent-family', parentId: null, name: 'Особый товар' }
  ], assignments: { 's:a': 'screw-wood', 's:b': 'screw-wood', 's:c': 'screw-wood', 's:d': 'angle-reinforced', 's:e': 'absent-family' }, rules: [] };
}
const products = [
  { key: 's:a', name: 'Саморез по дереву чёрный 3,5х35 мм 100 шт' },
  { key: 's:b', name: 'Саморез по дереву чёрный 3,5х35 мм 200 шт' },
  { key: 's:c', name: 'Саморез по дереву жёлтый 3,5х35 мм 100 шт' },
  { key: 's:d', name: 'Уголок крепёжный усиленный 90х90х40 мм 50 шт' },
  { key: 's:e', name: 'Особый товар 10 шт' }
];
function path(registry, key) {
  const byId = new Map(registry.types.map(type => [type.id, type]));
  const names = [];
  for (let type = byId.get(registry.assignments[key].typeId); type; type = byId.get(type.parentId)) names.unshift(type.name);
  return names;
}
test('site navigation is preserved verbatim, product precedes pack and no assignments disappear', () => {
  const input = fixture(), before = structuredClone(input), result = rebuildFromSite(input, products, { reviewedAt });
  const r = result.registry;
  assert.deepEqual(path(r, 's:a').slice(0, 3), ['Крепеж и метизы', 'Саморезы', 'Саморезы черные по дереву']);
  assert.match(path(r, 's:a')[3], /3.5×35 мм/);
  assert.equal(path(r, 's:a')[4], 'Упаковка: 100 шт.');
  assert.deepEqual(path(r, 's:a').slice(0, 4), path(r, 's:b').slice(0, 4));
  assert.equal(path(r, 's:c')[2], 'Саморезы желтые по дереву');
  assert.deepEqual(path(r, 's:d').slice(0, 4), ['Крепеж и метизы', 'Перфорированный крепеж', 'Уголки крепежные', 'Уголок крепежный усиленный']);
  assert.equal(path(r, 's:d').length, 5);
  assert.equal(path(r, 's:e')[0], 'Не сопоставлено с каталогом сайта');
  assert.deepEqual(Object.keys(r.assignments), Object.keys(input.assignments));
  assert.deepEqual(input, before);
});
test('reruns are stable and the old rebuild command keeps the site hierarchy', () => {
  const first = rebuildFromSite(fixture(), products, { reviewedAt });
  const second = rebuildFromSite(first.registry, products, { reviewedAt: '2026-09-26T08:00:00Z' });
  assert.equal(second.changed, false);
  assert.deepEqual(second.registry, first.registry);
  assert.deepEqual(rebuild(first.registry, products).registry, first.registry);
  const corrected = products.map(p => p.key === 's:a' ? { ...p, name: 'Саморез по дереву жёлтый 3,5х35 мм 100 шт' } : p);
  assert.equal(path(rebuildFromSite(second.registry, corrected).registry, 's:a')[2], 'Саморезы желтые по дереву');
});
test('historical assignments survive, new unmatched cards are visible and missing colour is not guessed', () => {
  const ps = products.filter(p => p.key !== 's:e').map(p => p.key === 's:a' ? { ...p, name: 'Саморез по дереву 3,5х35 мм 100 шт' } : p);
  ps.push({ key: 's:new', name: 'Новый товар без классификации' });
  const first = rebuildFromSite(fixture(), ps, { reviewedAt });
  assert.equal(Object.keys(first.registry.assignments).length, 6);
  assert.equal(path(first.registry, 's:a')[2].includes('черные'), false);
  assert.equal(path(first.registry, 's:new')[0], 'Не сопоставлено с каталогом сайта');
  assert.deepEqual(first.assignedNew, ['s:new']);
  assert.equal(rebuildFromSite(first.registry, ps, { reviewedAt }).changed, false);
});
test('duplicate product keys, broad old rules and invented site paths are rejected before writing', () => {
  assert.throws(() => rebuildFromSite(fixture(), [...products, products[0]]), /Duplicate/);
  const r = fixture(); r.rules = [{ id: 'old', leafTypeId: 'screw-wood', includeAny: ['саморез'] }];
  assert.throws(() => rebuildFromSite(r, products), /Review classification rules/);
  assert.throws(() => rebuildFromSite(fixture(), products, { tree: { paths: [] } }), /Unverified/);
  assert.deepEqual(options(['--stalkrepej']), { apply: false, mergeColors: false, site: true });
  assert.throws(() => options(['--stalkrepej', '--rebuild-product-pack']));
});
test('reviewed website tree has unique paths and same-domain URLs with no broken parent path', () => {
  const keys = new Set(tree.paths.map(p => JSON.stringify(p.names)));
  assert.equal(keys.size, tree.paths.length);
  assert.equal(new Set(tree.paths.map(p => p.url)).size, tree.paths.length);
  for (const p of tree.paths) {
    assert.equal(new URL(p.url).hostname, 'stalkrepej.ru');
    assert.ok(p.names.length <= 4);
    if (p.names.length > 1) assert.ok(keys.has(JSON.stringify(p.names.slice(0, -1))));
  }
});

test('JSONB object key ordering does not cause a redundant rewrite', () => {
  const first = rebuildFromSite(fixture(), products).registry;
  const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().reverse().map(key => [key, reorder(value[key])])) : value;
  assert.equal(rebuildFromSite(reorder(first), products).changed, false);
});
