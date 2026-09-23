'use strict';

const crypto = require('node:crypto');
const registryModule = require('./product-type-registry.cjs');
const { attributes } = require('./product-category-attributes.cjs');
const MAX_DEPTH = 5;
const FACET_LABELS = { color: 'Цвет', material: 'Материал', coating: 'Покрытие', size: 'Размер', density: 'Плотность', pack: 'Упаковка' };
const normalize = value => String(value || '').toLowerCase().replace(/ё/g, 'е');

function refine(input, products, { reviewedAt = new Date().toISOString() } = {}) {
  const original = registryModule.validate(input), next = structuredClone(original);
  const byId = new Map(next.types.map(type => [type.id, type]));
  // These navigation-only groups consume the fifth level before color can be shown.
  // Their named product types remain intact and become direct children of Саморезы.
  for (const id of ['typ-roof-screws', 'typ-other-self-tapping']) {
    const group = byId.get(id);
    if (!group || !byId.has(group.parentId)) continue;
    for (const type of next.types) if (type.parentId === id) type.parentId = group.parentId;
    next.types = next.types.filter(type => type.id !== id); byId.delete(id);
  }
  const depth = id => { let count = 0; for (let type = byId.get(id); type; type = byId.get(type.parentId)) count++; return count; };
  const catalog = new Map(products.map(product => [product.key, product]));
  const assignedNew = [];
  for (const product of products) {
    if (next.assignments[product.key]) continue;
    const text = normalize(product.name || product.title).replace(/_/g, ' ');
    const candidates = [
      [/^саморез.*кровельн.*металл/u, 'screw-roof-metal'], [/^саморез.*кровельн.*дерев/u, 'screw-roof-wood'],
      [/^саморез.*конструкцион/u, 'screw-structural'], [/^саморез.*универсальн/u, 'screw-universal'],
      [/^саморез.*прессшайб/u, 'screw-metal-press'], [/^саморез.*гвл/u, 'screw-gvl'],
      [/^саморез.*по дерев/u, 'screw-wood'], [/^саморез.*по металл/u, 'screw-metal'],
      [/^пластина соединительн/u, 'plate-connecting'], [/^пластина крепежн/u, 'plate-unspecified'],
      [/^держатель балки/u, 'beam-holder'], [/^гвозд[ьи].*ершен/u, 'nail-ring'],
      [/^(?:стеклообои|стеклохолст).*стеклохолст|^стеклохолст/u, 'paint-fiberglass']
    ];
    const matched = candidates.find(([pattern, id]) => pattern.test(text) && byId.has(id) && !next.types.some(type => type.parentId === id));
    if (matched) { next.assignments[product.key] = { typeId: matched[1], source: 'explicit-product-name', evidence: String(product.name || product.title).slice(0, 500) }; assignedNew.push(product.key); }
  }
  const parents = new Set(next.types.map(type => type.parentId));
  const baseLeaves = next.types.filter(type => !parents.has(type.id) && !type.id.startsWith('attr-'));
  const changes = [], nodes = [];
  function node(parentId, facet, value) {
    const id = 'attr-' + crypto.createHash('sha256').update([parentId, facet, value?.id || 'unknown'].join('|')).digest('hex').slice(0, 24);
    if (!byId.has(id)) {
      const type = { id, parentId, name: value ? FACET_LABELS[facet] + ': ' + value.name : FACET_LABELS[facet] + ': не указан' };
      next.types.push(type); byId.set(id, type); nodes.push(type);
    }
    return id;
  }
  function priorities(type) {
    const name = normalize(type.name), id = type.id;
    if (id.startsWith('screw-')) return ['color', 'coating', 'size', 'pack'];
    if (id.startsWith('gloves-')) {
      // Material is already explicit in these reviewed product types.
      if (/хлоп|нейлон|спилк/.test(name)) return ['color', 'size', 'pack'];
      return ['material', 'color', 'coating', 'size', 'pack'];
    }
    if (/mesh|fiberglass/.test(id)) return ['density', 'size', 'color', 'pack'];
    if (/tarpaulin/.test(id)) return ['color', 'size', 'pack'];
    if (/tape|film|label|bag|box/.test(id)) return ['color', 'size', 'density', 'material', 'pack'];
    return ['size', 'material', 'color', 'coating', 'density', 'pack'];
  }
  function split(parentId, members, remaining, level) {
    if (level >= MAX_DEPTH) return members.map(member => ({ ...member, target: parentId }));
    const facet = remaining.find(key => members.some(member => member.facets[key]));
    if (!facet) return members.map(member => ({ ...member, target: parentId }));
    const later = remaining.filter(key => key !== facet), groups = new Map();
    for (const member of members) {
      const value = member.facets[facet], id = node(parentId, facet, value), group = groups.get(id) || [];
      group.push({ ...member, evidence: value ? [...member.evidence, `${FACET_LABELS[facet]}: ${value.name} (${value.evidence || 'карточка товара'})`] : member.evidence });
      groups.set(id, group);
    }
    return [...groups].flatMap(([id, group]) => split(id, group, later, level + 1));
  }
  for (const leaf of baseLeaves) {
    const members = Object.entries(next.assignments).filter(([, value]) => value.typeId === leaf.id).map(([key]) => ({ key, facets: catalog.has(key) ? attributes(catalog.get(key)) : {}, evidence: [] }));
    if (!members.length) continue;
    let preferred = priorities(leaf);
    // Do not duplicate an attribute already stated in the category itself.
    const represented = attributes({ name: leaf.name });
    preferred = preferred.filter(facet => !represented[facet]);
    const refined = split(leaf.id, members, preferred, depth(leaf.id));
    for (const member of refined) {
      if (member.target === leaf.id) continue;
      const before = next.assignments[member.key];
      next.assignments[member.key] = { typeId: member.target, source: 'reviewed-attributes-v1', evidence: [before.evidence, ...member.evidence].filter(Boolean).join('; ').slice(0, 500) || null };
      changes.push({ key: member.key, from: leaf.id, to: member.target });
    }
    // Existing rules must still target a leaf; without a reviewed product record
    // they retain their broad classification under an explicit unknown branch.
    for (const rule of next.rules.filter(rule => rule.leafTypeId === leaf.id)) {
      if (next.types.some(type => type.parentId === leaf.id)) {
        const id = 'attr-' + crypto.createHash('sha256').update(leaf.id + '|unreviewed').digest('hex').slice(0, 24);
        if (!byId.has(id)) { const type = { id, parentId: leaf.id, name: 'Характеристики не уточнены' }; next.types.push(type); byId.set(id, type); nodes.push(type); }
        rule.leafTypeId = id;
      }
    }
  }
  const changed = changes.length > 0 || assignedNew.length > 0 || next.types.length !== original.types.length;
  if (changed) {
    next.reviewedAt = reviewedAt;
    next.revision = 'attributes-5-' + crypto.createHash('sha256').update(JSON.stringify([next.types, next.assignments, next.rules])).digest('hex').slice(0, 16);
  }
  const registry = registryModule.validate(next);
  if (registry.types.some(type => depth(type.id) > MAX_DEPTH)) throw Error('Category refinement exceeds five levels');
  return { registry, changes, assignedNew, addedTypes: nodes, changed };
}

module.exports = { refine, MAX_DEPTH };
