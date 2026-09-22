'use strict';

const crypto = require('node:crypto');

const MAX_METADATA_BYTES = 64 * 1024;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const MARKER = '__pultLiveCollection';

class LiveCodecError extends Error {
  constructor(code, message) { super(message); this.name = 'LiveCodecError'; this.code = code; }
}
const fail = (code, message) => { throw new LiveCodecError(code, message); };
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);

function validDay(value) {
  if (typeof value !== 'string' || !DAY.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function parseSourcePath(sourcePath) {
  if (typeof sourcePath !== 'string') fail('UNSUPPORTED_SOURCE', 'Live source path is unsupported');
  let match;
  if ((match = /^(data)-((?:wb-)?[0-9]{1,190})\.json$/u.exec(sourcePath))) return { kind: 'data', scope: { domain: 'market', storeId: match[2] } };
  if ((match = /^(insights)-([0-9]{1,190})\.json$/u.exec(sourcePath))) return { kind: 'insights', scope: { domain: 'insights', storeId: match[2] } };
  if ((match = /^(costs)-([0-9]{1,190})\.json$/u.exec(sourcePath))) return { kind: 'costs', scope: { domain: 'costs', storeId: match[2] } };
  if ((match = /^(prices)-(wb-[0-9]{1,190})\.json$/u.exec(sourcePath))) return { kind: 'prices', scope: { domain: 'prices', storeId: match[2] } };
  if ((match = /^(ozon-funnel)-([0-9]{1,190})\.json$/u.exec(sourcePath))) return { kind: 'funnel', scope: { domain: 'funnel', storeId: match[2] } };
  if ((match = /^(wb-orders)-(wb-[0-9]{1,190})\.json$/u.exec(sourcePath))) return { kind: 'wb-orders', scope: { domain: 'wb-orders', storeId: match[2] } };
  if ((match = /^(ledger)-([0-9]{1,190})\.json$/u.exec(sourcePath))) return { kind: 'ledger', scope: { domain: 'ledger', storeId: match[2] } };
  if ((match = /^(order-category-catalog)-((?:wb-)?[0-9]{1,190})\.json$/u.exec(sourcePath))) return { kind: 'catalog', scope: { domain: 'catalogs', storeId: match[2] } };
  if ((match = /^intraday-((?:wb-)?[0-9]{1,190})\.json$/u.exec(sourcePath))) return { kind: 'intraday', scope: { domain: 'intraday', storeId: match[1] } };
  if (sourcePath === 'order-category-intraday.json') return { kind: 'order-category-intraday', scope: { domain: 'category-intraday', storeId: 'all' } };
  if ((match = /^buyer-(order|product)-segments-(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})(?:-retry-([0-9]+))?(\.partial)?\.json$/u.exec(sourcePath))) {
    if (!validDay(match[2]) || !validDay(match[3]) || match[2] > match[3]) fail('UNSUPPORTED_SOURCE', 'Buyer source period is invalid');
    const storeId=sourcePath.slice(0,-5),retry=match[4]===undefined?null:Number(match[4]);if(Buffer.byteLength(storeId,'utf8')>200||retry!==null&&!Number.isSafeInteger(retry))fail('UNSUPPORTED_SOURCE','Buyer source scope is invalid');
    return { kind: `buyer-${match[1]}-segments`, scope: { domain: 'buyers', storeId, period: { from: match[2], to: match[3] }, retry, partial: !!match[5] } };
  }
  fail('UNSUPPORTED_SOURCE', 'Live source path is unsupported');
}

function isSupportedSourcePath(sourcePath) {
  try { parseSourcePath(sourcePath); return true; } catch (error) { if (error?.code === 'UNSUPPORTED_SOURCE') return false; throw error; }
}

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (!object(value)) fail('INVALID_DOCUMENT', 'Live document must contain strict JSON values');
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}

function cloneJson(value) {
  const ancestors = new Set();
  function visit(item, depth) {
    if (depth > 128) fail('INVALID_DOCUMENT', 'Live document nesting is too deep');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object' || ancestors.has(item)) fail('INVALID_DOCUMENT', 'Live document must contain strict JSON values');
    const array = Array.isArray(item), proto = Object.getPrototypeOf(item);
    if (!array && proto !== Object.prototype && proto !== null) fail('INVALID_DOCUMENT', 'Live document must contain plain JSON objects');
    ancestors.add(item);
    let result;
    if (array) {
      if (Object.keys(item).length !== item.length || Object.getOwnPropertyNames(item).length !== item.length + 1) fail('INVALID_DOCUMENT', 'Live document arrays must be dense');
      result = item.map(child => visit(child, depth + 1));
    } else {
      result = {};
      for (const key of Object.keys(item)) {
        const property = Object.getOwnPropertyDescriptor(item, key);
        if (!property?.enumerable || !Object.hasOwn(property, 'value')) fail('INVALID_DOCUMENT', 'Live document properties must be data values');
        result[key] = visit(property.value, depth + 1);
      }
    }
    ancestors.delete(item);
    return result;
  }
  return visit(value, 0);
}

const hashKey = value => 'sha256:' + crypto.createHash('sha256').update(canonical(value)).digest('hex');
function safeKey(parts, value) {
  const key = parts.filter(part => part !== undefined && part !== null && String(part) !== '').map(String).join(':');
  return key && Buffer.byteLength(key, 'utf8') <= 1024 && !/[\u0000-\u001f\u007f]/u.test(key) ? key : hashKey(value);
}
const fallback = value => hashKey(value);
function identified(prefix, identities, value) { const parts=identities.filter(item=>item!==undefined&&item!==null&&String(item)!=='');return parts.length?safeKey([prefix,...parts],value):fallback(value); }
const explicitDay = value => validDay(value?.date) ? value.date : validDay(value?.day) ? value.day : null;

const natural = Object.freeze({
  product: value => identified('product',[value?.product_id ?? value?.id ?? value?.nmID ?? value?.sku],value),
  stock: value => identified('stock',[value?.product_id ?? value?.nmID,value?.offer_id ?? value?.vendorCode],value),
  operation: value => identified('operation',[value?.operation_id ?? value?.accrual_id ?? (value?.reportId != null && value?.rrdId != null ? `${value.reportId}:${value.rrdId}` : value?.rrdId)],value),
  category: value => identified('category',[value?.description_category_id ?? value?.category_id ?? value?.id],value),
  daily: value => identified('day',[value?.date],value),
  skuDaily: value => identified('sku-day',[value?.date,value?.sku ?? value?.nmId],value),
  type: value => identified('type',[value?.id ?? value?.type_id],value),
  fee: value => identified('fee',[value?.date,value?.typeId ?? value?.type_id,value?.group],value),
  funnel: value => identified('sku',[value?.sku],value),
  point: value => identified('point',[value?.source,value?.date,value?.at],value),
  command: value => identified('command',[value?.commandId],value),
  buyerRecord: value => identified('record',[value?.market,value?.storeId,value?.scheme,value?.id ?? value?.orderKey],value),
  buyerProduct: value => identified('product-order',[value?.market,value?.storeId,value?.scheme,value?.orderId ?? value?.postingId,value?.productId],value)
});

const spec = (path, entityType, key = fallback, { scalar = false } = {}) => ({ path, entityType, key, scalar });
const SPECS = Object.freeze({
  data: [spec('products','market.products',natural.product),spec('stocks','market.stocks',natural.stock),spec('operations','market.operations',natural.operation),spec('stockRows','market.stockRows'),spec('categoryTree','market.categoryTree',natural.category)],
  insights: [spec('orders.daily','insights.orders.daily',natural.daily),spec('orders.skuDaily','insights.orders.skuDaily',natural.skuDaily),spec('types','insights.types',natural.type),spec('orders.skuCoverage','insights.orders.skuCoverage',fallback,{scalar:true}),spec('errors','insights.errors',fallback,{scalar:true})],
  costs: [spec('items','costs.items',natural.product)],
  prices: [spec('items','prices.items',natural.product)],
  funnel: [spec('snapshot.currentRows','funnel.currentRows',natural.funnel),spec('snapshot.previousRows','funnel.previousRows',natural.funnel),spec('snapshot.metrics','funnel.metrics',fallback,{scalar:true})],
  'wb-orders': [spec('points','wb-orders.points',value=>safeKey(['point',value?.at],value)),spec('orders','wb-orders.rows'),spec('rows','wb-orders.rawRows')],
  ledger: [spec('data.daily','ledger.daily',natural.daily),spec('data.skuDaily','ledger.skuDaily',natural.skuDaily),spec('data.fees','ledger.fees',natural.fee),spec('data.currencies','ledger.currencies',fallback,{scalar:true})],
  'buyer-order-segments': [spec('records','buyers.records',natural.buyerRecord),spec('productOrders','buyers.productOrders',natural.buyerProduct),spec('report.byStore','buyers.report.byStore'),spec('report.coverage.sources','buyers.report.coverage.sources'),spec('report.limitations','buyers.report.limitations',fallback,{scalar:true}),spec('errors','buyers.errors',fallback,{scalar:true}),spec('_sqlAcquisition.targets','buyers.acquisition.targets',value=>safeKey(['target',value?.storeId],value))],
  'buyer-product-segments': [spec('products','buyers.products',value=>identified('product',[value?.market,value?.storeId,value?.productId],value)),spec('coverage.sources','buyers.productCoverage.sources'),spec('limitations','buyers.productLimitations',fallback,{scalar:true}),spec('errors','buyers.productErrors',fallback,{scalar:true})],
  catalog: [spec('products','catalogs.products',natural.product),spec('categoryTree','catalogs.categoryTree',natural.category)],
  intraday: [spec('points','intraday.points',natural.point),spec('commandResults','intraday.commandResults',natural.command)],
  'order-category-intraday': [spec('points','intraday.category.points',value=>safeKey(['category-point',value?.date,value?.at,value?.taxonomyRevision],value)),spec('commandResults','intraday.category.commandResults',natural.command)]
});

function location(root, path) {
  const names = path.split('.'); let parent = root;
  for (let index = 0; index < names.length - 1; index++) {
    if (!object(parent) || !Object.hasOwn(parent, names[index])) return null;
    parent = parent[names[index]];
  }
  return object(parent) ? { parent, name: names.at(-1) } : null;
}

function rejectArrays(value, path = '$') {
  if (Array.isArray(value)) fail('UNSUPPORTED_ARRAY_PATH', `Unsupported live array at ${path}`);
  if (!object(value)) return;
  for (const [key, child] of Object.entries(value)) rejectArrays(child, path + '.' + key);
}

function marker(path, scalar) { return { [MARKER]: path, scalar: scalar === true }; }
function rowsFor(values, definition) {
  return values.map((raw, ordinal) => {
    if (definition.scalar) raw = { scalar: raw };
    else if (!object(raw)) fail('INVALID_DOCUMENT', `Live collection ${definition.path} must contain objects`);
    const value = cloneJson(raw), key = definition.scalar ? definition.key(value.scalar) : definition.key(value);
    return { key, day: definition.scalar ? null : explicitDay(value), ordinal, value };
  });
}

function encode(sourcePath, value) {
  const parsed = parseSourcePath(sourcePath), definitions = SPECS[parsed.kind];
  if (!definitions) fail('UNSUPPORTED_SOURCE', 'Live source codec is unavailable');
  const metadata = cloneJson(value);
  if (!object(metadata)) fail('INVALID_DOCUMENT', 'Live document root must be an object');
  const collections = {};
  for (const definition of definitions) {
    const target = location(metadata, definition.path);
    if (!target || !Object.hasOwn(target.parent, target.name) || target.parent[target.name] === null) continue;
    if (!Array.isArray(target.parent[target.name])) fail('INVALID_DOCUMENT', `Live collection ${definition.path} must be an array, null or absent`);
    collections[definition.path] = rowsFor(target.parent[target.name], definition);
    target.parent[target.name] = marker(definition.path, definition.scalar);
  }
  rejectArrays(metadata);
  const metadataBytes = Buffer.byteLength(JSON.stringify(metadata), 'utf8');
  if (metadataBytes > MAX_METADATA_BYTES) fail('METADATA_TOO_LARGE', 'Live source metadata exceeds the row repository limit');
  return { kind: parsed.kind, scope: cloneJson(parsed.scope), metadata, collections };
}

function decode(sourcePath, encoded, {partial=false}={}) {
  const wanted = parseSourcePath(sourcePath), definitions = SPECS[wanted.kind];
  if (!object(encoded) || !object(encoded.metadata) || !object(encoded.collections) || typeof partial!=='boolean') fail('INVALID_ENCODED', 'Encoded live source envelope is invalid');
  const result = cloneJson(encoded.metadata), expected = new Set();
  rejectArrays(result);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_METADATA_BYTES) fail('METADATA_TOO_LARGE', 'Live source metadata exceeds the row repository limit');
  for (const definition of definitions) {
    const target = location(result, definition.path);
    if (!target || !Object.hasOwn(target.parent, target.name) || target.parent[target.name] === null) {
      if (Object.hasOwn(encoded.collections, definition.path)) fail('INVALID_ENCODED', 'Encoded live source has rows for an absent collection');
      continue;
    }
    const value = target.parent[target.name];
    if (!object(value) || value[MARKER] !== definition.path || value.scalar !== definition.scalar || Object.keys(value).length !== 2) fail('INVALID_ENCODED', 'Encoded live collection marker is invalid');
    expected.add(definition.path);
    if (!Object.hasOwn(encoded.collections,definition.path)) { if(partial){target.parent[target.name]=[];continue} fail('INVALID_ENCODED','Encoded live collection rows are missing'); }
    if(!Array.isArray(encoded.collections[definition.path]))fail('INVALID_ENCODED','Encoded live collection rows are invalid');
    const rows = encoded.collections[definition.path].map(row => cloneJson(row)).sort((a,b)=>a.ordinal-b.ordinal);
    const restored = rows.map((row, ordinal) => {
      if (!object(row) || typeof row.key !== 'string' || !row.key || Buffer.byteLength(row.key,'utf8') > 1024 || /[\u0000-\u001f\u007f]/u.test(row.key) || row.day !== null && !validDay(row.day) || row.ordinal !== ordinal || !object(row.value)) fail('INVALID_ENCODED', 'Encoded live row is invalid');
      let restoredValue;
      if (definition.scalar) {
        if (!Object.hasOwn(row.value,'scalar') || Object.keys(row.value).length !== 1) fail('INVALID_ENCODED', 'Encoded scalar live row is invalid');
        restoredValue=cloneJson(row.value.scalar);
      } else restoredValue=cloneJson(row.value);
      const expectedKey=definition.key(restoredValue),expectedDay=definition.scalar?null:explicitDay(restoredValue);
      if(row.key!==expectedKey||row.day!==expectedDay)fail('INVALID_ENCODED','Encoded live row index differs from its value');
      return restoredValue;
    });
    target.parent[target.name] = restored;
  }
  for (const name of Object.keys(encoded.collections)) if (!expected.has(name)) fail('INVALID_ENCODED', 'Encoded live source has an unknown collection');
  return result;
}

const decodeMetadata=(sourcePath,metadata)=>decode(sourcePath,{metadata,collections:{}},{partial:true});
module.exports = { encode, decode, decodeMetadata, parseSourcePath, isSupportedSourcePath, LiveCodecError, MAX_METADATA_BYTES };
