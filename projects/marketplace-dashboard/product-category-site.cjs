'use strict';

const crypto = require('node:crypto');
const { validate } = require('./product-type-registry.cjs');
const { attributes } = require('./product-category-attributes.cjs');
const { selectCategory } = require('./product-category-site-mapping.cjs');
const siteTree = require('./stalkrepej-category-tree.json');
const SOURCE = 'stalkrepej:';
const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
const labels = { size: 'Размер', material: 'Материал', coating: 'Покрытие', color: 'Цвет', density: 'Плотность' };
const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

// Offline maintenance: site paths are reviewed source data, never fetched by a
// user's HTTP request. Marketplace identifiers and source amounts do not change.
function rebuildFromSite(input, products, { reviewedAt = new Date().toISOString(), tree = siteTree } = {}) {
  const original = validate(input);
  if (original.rules.length) throw Error('Review classification rules before replacing the category tree');
  const old = new Map(original.types.map(type => [type.id, type]));
  const ancestors = id => { const out = []; for (let type = old.get(id); type; type = old.get(type.parentId)) out.unshift(type); return out; };
  const categories = new Map();
  for (const path of tree.paths) {
    const name = path.names.at(-1);
    const matches = categories.get(name) || []; matches.push(path); categories.set(name, matches);
  }
  const catalog = new Map(products.map(product => [product.key, product]));
  if (catalog.size !== products.length) throw Error('Duplicate catalog product keys');
  const rows = [];
  const allKeys = new Set([...Object.keys(original.assignments), ...catalog.keys()]);
  for (const key of allKeys) {
    const assignment = original.assignments[key];
    const path = assignment ? ancestors(assignment.typeId) : [];
    const priorSite = assignment?.source.startsWith(SOURCE);
    const family = priorSite
      ? { id: assignment.source.slice(SOURCE.length), name: (path.find(type => type.id.startsWith('site-product-'))?.name || path.at(-1)?.name || 'Тип товара не определён').split(' · ')[0] }
      : [...path].reverse().find(type => !type.id.startsWith('attr-')) || { id: 'unclassified', name: 'Тип товара не определён' };
    const product = catalog.get(key);
    const facts = product || { name: path.map(type => type.name).join(' ') };
    const facets = attributes(facts);
    if (family.id === 'gloves-cotton-pvc' && path.some(type => /серый \/ не указан/u.test(type.name)) && (!facets.color || ['gray', 'gray-or-unknown'].includes(facets.color.id))) {
      facets.color = { id: 'gray-or-unknown', name: 'серый / не указан' };
    }
    const selected = selectCategory(family.id, facts, facets);
    const matches = selected ? categories.get(selected) : null;
    if (selected && (!matches || matches.length !== 1)) throw Error('Unverified or ambiguous site category: ' + selected);
    const category = matches?.[0] || null;
    rows.push({ key, assignment, family, product, facets, category });
  }
  const next = { ...original, types: [], assignments: {}, rules: [] };
  const nodes = new Map(), depths = new Map(), changes = [], unmatched = [], mapped = [];
  function node(id, parentId, name) {
    if (!nodes.has(id)) {
      const value = { id, parentId, name: name.length <= 120 ? name : name.slice(0, 109) + '… ' + id.slice(-8) };
      nodes.set(id, value); depths.set(id, parentId ? depths.get(parentId) + 1 : 1); next.types.push(value);
    }
    return id;
  }
  function sitePath(category) {
    let parent = null;
    for (let index = 0; index < category.names.length; index++) {
      const names = category.names.slice(0, index + 1);
      parent = node('site-category-' + hash(JSON.stringify(names)), parent, names.at(-1));
    }
    return parent;
  }
  // Use one consistent set of product attributes for a reviewed family within a
  // site category. Packaging is deliberately absent from the product identity.
  const groups = new Map();
  for (const row of rows) {
    const groupKey = JSON.stringify([row.category?.names || null, row.family.id]);
    const group = groups.get(groupKey) || []; group.push(row); groups.set(groupKey, group);
  }
  for (const group of groups.values()) {
    const first = group[0], represented = attributes({ name: (first.category?.names || []).join(' ') });
    const facets = Object.keys(labels).filter(key => group.some(row => row.facets[key] && row.facets[key].id !== represented[key]?.id));
    let parent;
    if (first.category) parent = sitePath(first.category);
    else parent = node('site-unmatched', null, 'Не сопоставлено с каталогом сайта');
    for (const row of group) {
      const description = facets.map(key => labels[key] + ': ' + (row.facets[key]?.name || 'не указан')).join(' · ');
      const identity = JSON.stringify([row.family.id, facets.map(key => [key, row.facets[key]?.id || 'unknown']), row.family.id === 'unclassified' ? row.key : null]);
      const productId = 'site-product-' + hash(parent + '|' + identity);
      // Unknown products keep their names and unique keys, rather than being
      // merged by a guessed family. Other products retain the reviewed type.
      const title = row.family.id === 'unclassified' ? row.product?.name || row.product?.title || row.family.name : row.family.name;
      let target = node(productId, parent, title + (description ? ' · ' + description : ''));
      if (depths.get(target) < 5 && group.some(item => item.facets.pack)) {
        target = node('site-pack-' + hash(target + '|' + (row.facets.pack?.id || 'unknown')), target, 'Упаковка: ' + (row.facets.pack?.name || 'не указана'));
      }
      next.assignments[row.key] = { typeId: target, source: SOURCE + row.family.id, evidence: row.assignment?.evidence || null };
      if (row.assignment?.typeId !== target) changes.push({ key: row.key, from: row.assignment?.typeId || null, to: target });
      (row.category ? mapped : unmatched).push(row.key);
    }
  }
  if (next.types.some(type => depths.get(type.id) > 5)) throw Error('Site categories require more than five levels');
  next.types.sort((a, b) => collator.compare(a.parentId || '', b.parentId || '') || collator.compare(a.name, b.name) || a.id.localeCompare(b.id));
  // PostgreSQL JSONB reorders object keys; order must not trigger a rebuild.
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  const content = value => JSON.stringify(stable([value.types, value.assignments, value.rules]));
  const changed = content(next) !== content(original);
  if (changed) { next.reviewedAt = reviewedAt; next.revision = 'stalkrepej-' + hash(content(next)); }
  return { registry: validate(next), changed, changes, addedTypes: next.types.filter(type => !old.has(type.id)), assignedNew: [...allKeys].filter(key => !original.assignments[key]), mapped, unmatched, sourceUrl: tree.sourceUrl };
}

module.exports = { rebuildFromSite };
