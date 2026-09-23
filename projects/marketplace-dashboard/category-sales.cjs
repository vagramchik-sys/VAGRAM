'use strict';
const productTypeRegistry = require('./product-type-registry.cjs');

// Shared categories are explicit product-key assignments from supplier-portals.
// No names, articles or marketplace category names are used to guess membership.
const DAY = 86400000;
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const shift = (day, count) => new Date(Date.parse(day) + count * DAY).toISOString().slice(0, 10);
const text = value => value === null || value === undefined ? '' : String(value).trim();
const zero = () => ({ sold: 0, returned: 0, net: 0 });
function sum(values) {
  if (!values.length || values.some(value => value === null)) return null;
  const result = values.reduce((a, b) => ({ sold: a.sold + b.sold, returned: a.returned + b.returned, net: a.net + b.net }), zero());
  return Object.values(result).every(Number.isSafeInteger) ? result : null;
}
function units(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+(?:\.0+)?$/.test(value.trim()))) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
const AUTO_TYPES = [
  ['screws', 'Саморезы', 'саморез(?:ы)?'], ['tarps', 'Тенты', 'тент(?:ы)?'],
  ['nuts', 'Гайки', 'гайк(?:а|и)'], ['washers', 'Шайбы', 'шайб(?:а|ы)'],
  ['bolts', 'Болты', 'болт(?:ы)?'], ['nails', 'Гвозди', 'гвозд(?:ь|и)'],
  ['wood-screws', 'Шурупы', 'шуруп(?:ы)?'], ['dowels', 'Дюбели', 'дюбел(?:ь|и)'],
  ['studs', 'Шпильки', 'шпильк(?:а|и)'], ['gloves', 'Перчатки', 'перчатк(?:а|и)'],
  ['labels', 'Этикетки', '(?:термо)?этикетк(?:а|и)']
].map(([id, name, pattern]) => ({ id: 'auto:' + id, name, pattern: new RegExp('^' + pattern + '(?:\\s|$|[.,:;()\\-])', 'iu') }));
function taxonomyCategories(stores, manual, registry) {
  let value;
  try { value = registry?.available === false ? null : productTypeRegistry.validate(registry); } catch { return null; }
  if (!value) return null;
  const categories = manual.map(c => ({ ...c, origin: 'manual', productKeys: [...(c.productKeys || [])] }));
  const assigned = new Set(categories.flatMap(c => c.productKeys));
  const byId = new Map(value.types.map(type => [type.id, type]));
  const pathOf = type => {
    const path = [], seen = new Set(); let current = type;
    while (current && !seen.has(current.id)) { path.unshift(current.name); seen.add(current.id); current = current.parentId === null ? null : byId.get(current.parentId); }
    return path;
  };
  const hierarchy = value.types.map(type => {
    const path = pathOf(type);
    return { id: 'type:' + type.id, parentId: type.parentId === null ? null : 'type:' + type.parentId, name: type.name, path, depth: path.length, origin: 'taxonomy', productKeys: [] };
  });
  const categoryByType = new Map(value.types.map((type, index) => [type.id, hierarchy[index]]));
  const unmatched = [];
  for (const product of stores.flatMap(store => store.products || [])) {
    if (!product.key || assigned.has(product.key)) continue;
    const classification = productTypeRegistry.classify(value, product.key, product);
    if (!classification || !categoryByType.has(classification.typeId)) { unmatched.push(product.key); continue; }
    let current = byId.get(classification.typeId);
    while (current) {
      const keys = categoryByType.get(current.id).productKeys;
      if (!keys.includes(product.key)) keys.push(product.key);
      current = current.parentId === null ? null : byId.get(current.parentId);
    }
  }
  if (unmatched.length) hierarchy.push({ id: 'type:@unmatched', parentId: null, name: 'Без категории', path: ['Без категории'], depth: 1, origin: 'taxonomy', productKeys: unmatched });
  return categories.concat(hierarchy);
}
function sharedCategories(stores, manual, registry) {
  const taxonomy = taxonomyCategories(stores, manual, registry);
  if (taxonomy) return taxonomy;
  const categories = manual.map(c => ({ ...c, origin: 'manual', productKeys: [...(c.productKeys || [])] }));
  const assigned = new Set(categories.flatMap(c => c.productKeys));
  const automatic = new Map();
  for (const product of stores.flatMap(s => s.products || [])) {
    if (!product.key || assigned.has(product.key)) continue;
    const type = AUTO_TYPES.find(type => type.pattern.test(text(product.name))) || { id: 'auto:uncategorized', name: 'Без категории' };
    if (!automatic.has(type.id)) automatic.set(type.id, { id: type.id, name: type.name, origin: 'automatic', productKeys: [] });
    automatic.get(type.id).productKeys.push(product.key);
    assigned.add(product.key);
  }
  return categories.concat([...automatic.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru')));
}
function sourceSeries(store, keys, days, allProducts = false) {
  const wb = store.market === 'WB', source = wb ? store.finance : store.ledger;
  const reasons = new Set(), series = new Map(days.map(day => [day, null]));
  const products = store.products || [], selected = products.filter(p => keys.has(p.key));
  const imported = { from: source?.period?.from || null, to: source?.period?.to || null };
  let valid = validDate(imported.from) && validDate(imported.to) && imported.from <= imported.to;
  valid = valid && (wb ? source?.sections?.finance?.ok === true && Array.isArray(source.operations) : source?.version === 3 && source.complete === true && !source.foreignRecords && Array.isArray(allProducts ? source.daily : source.skuDaily));
  let observedTo = null;
  if (wb) for (const row of source?.operations || []) {
    const date = typeof row.rrDate === 'string' ? row.rrDate.slice(0, 10) : '';
    if (!validDate(date)) { valid = false; reasons.add('Есть строки WB без даты финансового отчёта.'); }
    else if (!observedTo || date > observedTo) observedTo = date;
  }
  if (!valid) reasons.add('Финансовый импорт отсутствует, неполон или некорректен.');
  for (const day of days) if (valid && day >= imported.from && day <= imported.to && (!wb || observedTo && day <= observedTo)) series.set(day, zero());
  if (!wb) {
    const aliases = new Map();
    for (const product of products) for (const sku of new Set([product.sku, ...(Array.isArray(product.skus) ? product.skus : [])].map(text).filter(Boolean))) {
      if (!aliases.has(sku)) aliases.set(sku, new Set());
      aliases.get(sku).add(product.key);
    }
    const selectedAliases = new Set([...aliases].filter(([, owners]) => [...owners].some(key => keys.has(key))).map(([sku]) => sku));
    const missing = [...keys].some(key => !selected.some(p => p.key === key)) || selected.some(p => ![p.sku, ...(Array.isArray(p.skus) ? p.skus : [])].some(v => text(v)));
    const ambiguous = [...selectedAliases].some(sku => aliases.get(sku).size !== 1);
    if (!allProducts && (missing || ambiguous)) {
      for (const day of days) series.set(day, null);
      reasons.add(ambiguous ? 'SKU выбранной категории связан с несколькими товарами.' : 'Для части товаров категории нет однозначной связи с SKU.');
    }
    const seen = new Set();
    for (const row of (allProducts ? source?.daily : source?.skuDaily) || []) {
      if (!allProducts && !selectedAliases.has(text(row.sku))) continue;
      if (!validDate(row.date)) { for (const day of days) series.set(day, null); reasons.add('У реализации категории отсутствует корректная дата.'); continue; }
      if (!series.has(row.date)) continue;
      const identity = row.date + ':' + text(row.sku), v = row.values || {};
      const counts = ['soldUnits', 'returnedUnits', 'unknownUnitRows', 'salesRows'].map(k => units(v[k] === undefined ? 0 : v[k]));
      if (seen.has(identity) || counts.some(n => n === null) || counts[2] > 0 || counts[3] > 0 && counts[0] + counts[1] === 0) {
        series.set(row.date, null); reasons.add('Есть неизвестное количество или повторные строки реализации категории.');
      } else if (series.get(row.date)) series.set(row.date, sum([series.get(row.date), { sold: counts[0], returned: counts[1], net: counts[0] - counts[1] }]));
      seen.add(identity);
    }
  } else {
    const seen = new Set();
    for (const row of source?.operations || []) {
      const date = typeof row.rrDate === 'string' ? row.rrDate.slice(0, 10) : '';
      if (!series.has(date)) continue;
      const id = row.rrdId;
      const safe = typeof id === 'string' && /^\d+$/.test(id) || typeof id === 'number' && Number.isSafeInteger(id);
      if (safe) { const identity = text(row.reportId) + ':' + text(id); if (seen.has(identity)) continue; seen.add(identity); }
      if (!allProducts && !keys.has(store.id + ':' + text(row.nmId))) continue;
      if (row.sellerOperName !== 'Продажа' && row.sellerOperName !== 'Возврат') continue;
      const quantity = units(row.quantity);
      if (quantity === null) { series.set(date, null); reasons.add('В строках продажи или возврата WB неизвестно количество.'); continue; }
      const returned = row.sellerOperName === 'Возврат';
      if (series.get(date)) series.set(date, sum([series.get(date), { sold: returned ? 0 : quantity, returned: returned ? quantity : 0, net: returned ? -quantity : quantity }]));
    }
  }
  const coveredDays = [...series.values()].filter(Boolean).length;
  if (coveredDays < days.length) reasons.add('Неподтверждённые дни показаны разрывами, а не нулём.');
  return { series, source: { id: store.id, name: store.name, market: wb ? 'WB' : 'Ozon', productCount: keys.size, updatedAt: source?.completedAt || null, imported, observedTo, coveredDays, totalDays: days.length, complete: coveredDays === days.length, reasons: [...reasons] } };
}

function build(stores, categories, options = {}) {
  const taxonomy = taxonomyCategories(stores, categories, options.productTypes);
  categories = taxonomy || sharedCategories(stores, categories);
  const now = new Date(options.now || Date.now());
  if (!Number.isFinite(now.getTime())) throw Error('Некорректная текущая дата');
  const today = new Date(now.getTime() + 3 * 3600000).toISOString().slice(0, 10);
  const count = Number(options.days || 14);
  if (!Number.isInteger(count) || count < 1 || count > 366) throw Error('Некорректная длительность периода');
  const from = options.from || shift(today, -count), to = options.to || shift(today, -1);
  if (!validDate(from) || !validDate(to) || from > to || to >= today || (Date.parse(to) - Date.parse(from)) / DAY > 365) throw Error('Выберите до 366 завершённых дней; сегодняшний день не включается');
  const market = options.market || 'all', storeId = options.store || '';
  if (!['all', 'WB', 'Ozon'].includes(market)) throw Error('Неизвестная площадка');
  if (storeId && !stores.some(s => s.id === storeId)) throw Error('Магазин не подключён');
  const categoryId = options.category || '';
  if (categoryId && !categories.some(c => c.id === categoryId)) throw Error('Категория не найдена');
  const activeCategories = categoryId ? categories.filter(c => c.id === categoryId) : categories;
  const keys = new Set(activeCategories.flatMap(c => c.productKeys || []));
  const days = []; for (let day = from; day <= to; day = shift(day, 1)) days.push(day);
  const scope = stores.filter(s => (!storeId || s.id === storeId) && (market === 'all' || (s.market === 'WB' ? 'WB' : 'Ozon') === market));
  const sources = scope.map(store => ({ store, keys: new Set([...keys].filter(key => key.startsWith(store.id + ':'))) })).filter(s => !categoryId || s.keys.size).map(s => sourceSeries(s.store, s.keys, days, !categoryId));
  const series = days.map(date => {
    const row = { date };
    for (const name of ['Ozon', 'WB']) row[name] = sum(sources.filter(s => s.source.market === name).map(s => s.series.get(date)));
    row.total = sum(sources.map(s => s.series.get(date)));
    return row;
  });
  const totals = Object.fromEntries(['Ozon', 'WB', 'total'].map(name => [name, sum(series.map(day => day[name]))]));
  const limitations = [
    taxonomy ? 'Категории соответствуют проверенному справочнику типов; родитель включает товары всех дочерних категорий. Ручные категории поставщиков показаны отдельно и имеют приоритет.' : 'Автоматические группы по названию; ручные категории имеют приоритет. Неоднозначные названия остаются в группе «Без категории».',
    '«Все товары» включает финансовую реализацию магазина, в том числе исторические SKU вне текущего каталога; категории включают только явно связанные товары.',
    'Это единицы финансовой реализации по датам начислений Ozon и отчёта WB (rrDate), а не заказы или дата покупки.',
    'Ozon: количество определено только при точном целочисленном отношении суммы реализации к цене единицы; отрицательная реализация показана как возвраты/сторно.',
    'WB: учтены только операции «Продажа» и «Возврат»; компенсации и корректировки количества не заменяют продажи.',
    'Общий итог известен только когда подтверждены данные всех участвующих магазинов; неполные дни не суммируются.'
  ];
  return {
    categories: categories.map(c => ({ id: c.id, parentId: c.parentId ?? null, name: c.name, path: c.path || [c.name], depth: c.depth || 1, origin: c.origin, productCount: new Set(c.productKeys || []).size })),
    taxonomyRevision: taxonomy ? options.productTypes.revision : null,
    category: categoryId || null, period: { from, to, days: days.length, completedDaysOnly: true }, market, store: storeId || null,
    productCount: sources.reduce((n, s) => n + s.source.productCount, 0), series, totals,
    coverage: { complete: series.every(day => day.total !== null), coveredDays: series.filter(day => day.total !== null).length, totalDays: days.length },
    sources: sources.map(s => s.source), limitations
  };
}
module.exports = { build, sharedCategories, taxonomyCategories };
