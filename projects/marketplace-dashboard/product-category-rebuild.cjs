'use strict';

const crypto = require('node:crypto');
const { validate } = require('./product-type-registry.cjs');
const { attributes } = require('./product-category-attributes.cjs');
const labels = { size: 'Размер', material: 'Материал', coating: 'Покрытие', color: 'Цвет', density: 'Плотность' };
const generated = id => id.startsWith('attr-');
const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

// Explicit maintenance only. Rebuild derived branches from the reviewed family,
// never from the previous generated leaf (which would freeze old mistakes).
function rebuild(input, products, { reviewedAt = new Date().toISOString() } = {}) {
  if (String(input?.revision || '').startsWith('stalkrepej-')) return require('./product-category-site.cjs').rebuildFromSite(input, products, { reviewedAt });
  const original = validate(input), next = structuredClone(original);
  const old = new Map(original.types.map(type => [type.id, type]));
  const baseId = id => { let type = old.get(id); while (type && generated(type.id)) type = old.get(type.parentId); if (!type) throw Error('Missing reviewed product family'); return type.id; };
  const oldPath = id => { const names = []; for (let type = old.get(id); type; type = old.get(type.parentId)) names.unshift(type.name); return names.join(' '); };
  const catalog = new Map(products.map(product => [product.key, product]));
  next.types = next.types.filter(type => !generated(type.id));
  const byId = new Map(next.types.map(type => [type.id, type]));
  if (next.types.some(type => type.parentId && !byId.has(type.parentId))) throw Error('Custom branch under generated category requires review');
  const depth = id => { let count = 0; for (let type = byId.get(id); type; type = byId.get(type.parentId)) count++; return count; };
  const members = new Map();
  for (const [key, assignment] of Object.entries(original.assignments)) {
    const id = baseId(assignment.typeId);
    if (next.types.some(type => type.parentId === id)) throw Error('Reviewed assignment family is not a leaf');
    const product = catalog.get(key), facets = attributes(product || { name: oldPath(assignment.typeId) });
    const rows = members.get(id) || []; rows.push({ key, assignment, facets }); members.set(id, rows);
  }
  for (const rule of next.rules) rule.leafTypeId = baseId(rule.leafTypeId);
  // Remove only navigation intermediates: a reviewed product type is never dropped.
  const leafIds = new Set([...members.keys(), ...next.rules.map(rule => rule.leafTypeId)]);
  const parents = new Set(next.types.map(type => type.parentId));
  for (const type of next.types.filter(type => !parents.has(type.id))) leafIds.add(type.id);
  const removedTypes = [];
  for (const id of leafIds) {
    while (depth(id) > 3) {
      let group = byId.get(id);
      while (depth(group.id) > 2) group = byId.get(group.parentId);
      if (leafIds.has(group.id)) throw Error('Cannot remove a reviewed product type');
      for (const child of next.types) if (child.parentId === group.id) child.parentId = group.parentId;
      next.types = next.types.filter(type => type.id !== group.id); byId.delete(group.id); removedTypes.push(group.id);
    }
  }
  const changes = [], addedTypes = [];
  function node(parentId, signature, name) {
    const id = 'attr-' + hash(parentId + '|' + signature);
    if (!byId.has(id)) {
      const type = { id, parentId, name: name.length <= 120 ? name : name.slice(0, 109) + '… ' + id.slice(-8) };
      byId.set(id, type); next.types.push(type); addedTypes.push(type);
    }
    return id;
  }
  for (const [id, rows] of members) {
    const family = byId.get(id), represented = attributes({ name: family.name });
    // Retain the owner's explicit gray/unspecified cotton-PVC grouping.
    const mergedGray = original.types.some(type => type.parentId === id && type.name === 'Цвет: серый / не указан') ||
      rows.some(row => /серый \/ не указан/u.test(oldPath(row.assignment.typeId)));
    if (/хлопчатобумажные с ПВХ/iu.test(family.name) && mergedGray) for (const row of rows) {
      if (!row.facets.color || row.facets.color.id === 'gray' || row.facets.color.id === 'gray-or-unknown') row.facets.color = { id: 'gray-or-unknown', name: 'серый / не указан', evidence: 'Объединение владельца' };
    }
    const facets = Object.keys(labels).filter(key => rows.some(row => row.facets[key] && row.facets[key].id !== represented[key]?.id));
    const hasPack = rows.some(row => row.facets.pack);
    // The owner wants wood-screw colour at level 4. Product dimensions use
    // level 5; individual marketplace cards below retain their pack variants.
    const colorFirst = depth(id) === 3 && /^Саморез по дереву$/iu.test(family.name);
    for (const row of rows) {
      let target = id;
      if (colorFirst) target = node(id, 'color|' + (row.facets.color?.id || 'unknown'), 'Цвет: ' + (row.facets.color?.name || 'не указан'));
      const productFacets = colorFirst ? facets.filter(key => key !== 'color') : facets;
      if (productFacets.length || colorFirst) {
        const signature = productFacets.map(key => [key, row.facets[key]?.id || 'unknown']);
        const description = productFacets.filter(key => !represented[key] || row.facets[key]?.id !== represented[key].id)
          .map(key => labels[key] + ': ' + (row.facets[key]?.name || 'не указан')).join(' · ');
        target = node(target, 'product|' + JSON.stringify(signature), family.name + (description ? ' · ' + description : ' · Размер: не указан'));
      }
      if (hasPack && !colorFirst) target = node(target, 'pack|' + (row.facets.pack?.id || 'unknown'), 'Упаковка: ' + (row.facets.pack?.name || 'не указана'));
      next.assignments[row.key] = { ...row.assignment, typeId: target };
      if (target !== row.assignment.typeId) changes.push({ key: row.key, from: row.assignment.typeId, to: target });
    }
  }
  for (const rule of next.rules) if (next.types.some(type => type.parentId === rule.leafTypeId)) {
    rule.leafTypeId = node(rule.leafTypeId, 'unreviewed', 'Характеристики не уточнены');
  }
  next.types.sort((a, b) => collator.compare(a.parentId || '', b.parentId || '') || collator.compare(a.name, b.name) || a.id.localeCompare(b.id));
  if (next.types.some(type => depth(type.id) > 5)) throw Error('Product hierarchy exceeds five category levels');
  const content = value => JSON.stringify([value.types, value.assignments, value.rules]);
  const changed = content(next) !== content(original);
  if (changed) { next.reviewedAt = reviewedAt; next.revision = 'product-pack-' + hash(content(next)); }
  return { registry: validate(next), changed, changes, addedTypes, removedTypes };
}

module.exports = { rebuild };
