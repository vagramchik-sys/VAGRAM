'use strict';
const MOSCOW_DAY=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'});

const SOURCE_FILES = Object.freeze({
  daily: 'ozon-product-daily-snapshots.json',
  cabinet: 'ozon-cabinet-stock-core.json',
  seller: 'ozon-seller-stock-core.json',
  cluster: 'cluster-supply-last-good.json'
});

const SOURCE_LABELS = Object.freeze({
  'daily-total': 'Дневной снимок: товар',
  'daily-warehouse': 'Дневной снимок: склад',
  'cabinet-total': 'Cabinet: товар',
  'cabinet-warehouse': 'Cabinet: склад',
  'seller-warehouse': 'Seller Core: склад',
  'cluster-warehouse': 'Seller API: склад'
});

const SOURCE_LIMITS = Object.freeze([
  'В файлах есть дневная история только за даты, присутствующие в ozon-product-daily-snapshots.json; более ранняя SQL-история в импорт не входит.',
  'Cabinet Core, Seller Core и cluster-supply-last-good содержат последние сохраненные наблюдения, а не непрерывную историю.',
  'warehouse qty/mainTotal и availableStock описывают разные показатели; они сохраняются раздельно и не суммируются.',
  'Резерв в этих файловых источниках отдельным достоверным полем не представлен и остается null.',
  'Признаки stale, exact и исходные статусы сохраняются; дата импорта не заменяет дату наблюдения.'
]);

const STOCK_COLUMNS = Object.freeze(['K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'AA']);
const CLUSTER_STOCK_FIELDS = Object.freeze([
  'available_stock_count', 'valid_stock_count', 'waiting_docs_stock_count', 'expiring_stock_count',
  'transit_defect_stock_count', 'stock_defect_stock_count', 'excess_stock_count', 'other_stock_count',
  'requested_stock_count', 'transit_stock_count', 'return_from_customer_stock_count',
  'return_to_seller_stock_count', 'waiting_docs_to_export_stock_count', 'outbound_pending_delivery',
  'outbound_returns_picking', 'outbound_returns_ready_to_ship', 'outbound_returns_return_to_seller',
  'inbound_replenishment', 'stock_not_being_sold'
]);

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function numberOrNull(value) {
  if (!['number','string'].includes(typeof value) || typeof value==='string'&&!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validDay(value) {
  const day = text(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(`${day}T00:00:00Z`)) && new Date(`${day}T00:00:00Z`).toISOString().slice(0,10)===day ? day : null;
}

function validObservedAt(value) {
  const observedAt = text(value);
  return /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(observedAt) && Number.isFinite(Date.parse(observedAt)) ? new Date(observedAt).toISOString() : null;
}

function dayFromObservedAt(value) {
  const observedAt = validObservedAt(value);
  return observedAt ? MOSCOW_DAY.format(new Date(observedAt)) : null;
}

function pickedNumbers(row, fields) {
  return Object.fromEntries(fields.filter((field) => Object.prototype.hasOwnProperty.call(row || {}, field))
    .map((field) => [field, numberOrNull(row[field])]));
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function withObservedDayNote(quality, day, observedAt) {
  const observedDay = dayFromObservedAt(observedAt);
  return observedDay && day && observedDay !== day ? `${quality}; наблюдение от ${observedDay}` : quality;
}

function aggregateIssues(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = stable([entry.code, entry.message, entry.source, entry.sourceFile]);
    if (!groups.has(key)) groups.set(key, {
      code: entry.code, message: entry.message, source: entry.source, sourceFile: entry.sourceFile, count: 0, examples: []
    });
    const group = groups.get(key);
    group.count += 1;
    if (group.examples.length < 5) {
      const { code, message, source, sourceFile, ...example } = entry;
      group.examples.push(example);
    }
  }
  return [...groups.values()];
}

function emptyStat(file) {
  return { sourceFile: file, inputRows: 0, outputRows: 0, skippedRows: 0, duplicateRows: 0, conflictRows: 0 };
}

function normalize({ files = {}, storeMap = {} } = {}) {
  const rows = [];
  const issues = [];
  const stats = Object.fromEntries(Object.entries(SOURCE_LABELS).map(([source]) => [source, emptyStat(
    source.startsWith('daily-') ? SOURCE_FILES.daily
      : source.startsWith('cabinet-') ? SOURCE_FILES.cabinet
        : source === 'seller-warehouse' ? SOURCE_FILES.seller : SOURCE_FILES.cluster
  )]));
  const exactSeen = new Map();
  const logicalSeen = new Map();

  function issue(code, message, source, sourceFile, sourceRow, extra = {}) {
    issues.push({ code, message, source, sourceFile, sourceRow, ...extra });
  }

  function mappedStore(slug, source, sourceFile, sourceRow) {
    const key = text(slug);
    const mapping = key ? storeMap[key] : null;
    if (!key || !mapping || !text(mapping.id) || !text(mapping.name)) {
      issue('missing_store_mapping', 'Нет явного соответствия магазина.', source, sourceFile, sourceRow, { donorStoreId: key || null });
      return null;
    }
    return { storeId: text(mapping.id), storeName: text(mapping.name) };
  }

  function emit(candidate) {
    const stat = stats[candidate.source];
    stat.inputRows += 1;
    const location = candidate.sourceRow;
    let invalid = !candidate.storeId || !candidate.storeName;
    if (!candidate.sku) {
      issue('missing_sku', 'У строки нет SKU.', candidate.source, candidate.sourceFile, location);
      invalid = true;
    }
    if (!candidate.day) {
      issue('missing_date', 'У строки нет достоверной даты снимка или наблюдения.', candidate.source, candidate.sourceFile, location);
      invalid = true;
    }
    if (invalid) {
      stat.skippedRows += 1;
      return;
    }
    const quantities={};
    for(const key of ['totalStock','available','inTransit']){const value=numberOrNull(candidate[key]);quantities[key]=Number.isSafeInteger(value)&&value>=0?value:null;if(candidate[key]!=null&&candidate[key]!==''&&quantities[key]===null)issue('invalid_quantity','Некорректное количество сохранено как неизвестное.',candidate.source,candidate.sourceFile,location,{field:key})}
    const row = {
      day: candidate.day,
      observedAt: candidate.observedAt || null,
      source: candidate.source,
      sourceLabel: SOURCE_LABELS[candidate.source],
      storeId: candidate.storeId,
      storeName: candidate.storeName,
      sku: candidate.sku,
      article: candidate.article || null,
      name: candidate.name || null,
      warehouse: candidate.warehouse || null,
      warehouseId: candidate.warehouseId || null,
      cluster: candidate.cluster || null,
      ...quantities,
      reserved: null,
      quality: candidate.quality,
      sourceFile: candidate.sourceFile,
      sourceRow: location,
      details: candidate.details || {}
    };
    const logicalKey = stable([
      row.source, row.day, row.observedAt, row.storeId, row.sku, row.warehouseId, row.warehouse, row.cluster
    ]);
    const fingerprint = stable({ ...row, sourceRow: null });
    if (exactSeen.has(fingerprint)) {
      issue('exact_duplicate', 'Полный дубликат записи пропущен.', row.source, row.sourceFile, row.sourceRow,
        { duplicateOf: exactSeen.get(fingerprint) });
      stat.duplicateRows += 1;
      stat.skippedRows += 1;
      return;
    }
    const prior = logicalSeen.get(logicalKey);
    if (prior && prior.fingerprint !== fingerprint) {
      issue('conflicting_duplicate', 'Для одного ключа наблюдения найдены разные значения; обе записи сохранены.',
        row.source, row.sourceFile, row.sourceRow, {
          conflictsWith: prior.sourceRow,
          previous: prior.measures,
          current: { totalStock: row.totalStock, available: row.available, inTransit: row.inTransit, reserved: row.reserved }
        });
      stat.conflictRows += 1;
    }
    exactSeen.set(fingerprint, row.sourceRow);
    if (!prior) logicalSeen.set(logicalKey, {
      fingerprint,
      sourceRow: row.sourceRow,
      measures: { totalStock: row.totalStock, available: row.available, inTransit: row.inTransit, reserved: row.reserved }
    });
    rows.push(row);
    stat.outputRows += 1;
  }

  const dailyFile = SOURCE_FILES.daily;
  const daily = files[dailyFile];
  if (daily !== undefined) {
    if (!daily || !Array.isArray(daily.rows)) {
      issue('invalid_file_shape', 'Ожидался объект с массивом rows.', 'daily-total', dailyFile, '$');
    } else daily.rows.forEach((item, index) => {
      const location = `rows[${index}]`;
      const store = mappedStore(item?.storeId, 'daily-total', dailyFile, location);
      const day = validDay(item?.snapshotDate);
      const sku = text(item?.sku);
      const warehouseValues=(Array.isArray(item?.warehouses)?item.warehouses:[]).map(row=>numberOrNull(row?.qty));
      const discrepancy=item?.stockExact===true&&item?.warehouseExact===true&&Number.isSafeInteger(item?.totalStock)&&warehouseValues.length>0&&warehouseValues.every(v=>Number.isSafeInteger(v)&&v>=0)&&warehouseValues.reduce((a,b)=>a+b,0)!==item.totalStock;
      if(discrepancy)issue('daily_total_warehouse_mismatch','Товарный и складской снимки имеют разные итоги; оба сохранены отдельно.','daily-total',dailyFile,location,{sku,totalStock:item.totalStock,warehouseTotal:warehouseValues.reduce((a,b)=>a+b,0)});
      emit({
        day, observedAt: validObservedAt(item?.stockCapturedAt), source: 'daily-total', ...store,
        sku, article: text(item?.article), name: text(item?.name), totalStock: item?.totalStock,
        quality: withObservedDayNote(item?.stockExact === true ? (discrepancy?'товарный и складской итоги различаются':'точный дневной остаток') : `нет точного остатка${text(item?.status) ? `; ${text(item.status)}` : ''}`,
          day, validObservedAt(item?.stockCapturedAt)),
        sourceFile: dailyFile, sourceRow: location,
        details: { stockExact: item?.stockExact === true, warehouseExact: item?.warehouseExact === true,
          status: text(item?.status) || null, error: item?.error ?? null }
      });
      const warehouseRows = Array.isArray(item?.warehouses) ? item.warehouses : [];
      warehouseRows.forEach((warehouse, warehouseIndex) => emit({
        day, observedAt: validObservedAt(item?.warehouseCapturedAt), source: 'daily-warehouse', ...store,
        sku, article: text(item?.article), name: text(item?.name), warehouse: text(warehouse?.warehouse),
        warehouseId: text(warehouse?.warehouseId), cluster: text(warehouse?.cluster), totalStock: warehouse?.qty,
        available: warehouse?.availableStock,
        quality: withObservedDayNote(item?.warehouseExact === true ? (discrepancy?'товарный и складской итоги различаются':'точный дневной складской срез') : `складской срез не подтвержден${text(item?.status) ? `; ${text(item.status)}` : ''}`,
          day, validObservedAt(item?.warehouseCapturedAt)),
        sourceFile: dailyFile, sourceRow: `${location}.warehouses[${warehouseIndex}]`,
        details: { stockExact: item?.stockExact === true, warehouseExact: item?.warehouseExact === true,
          status: text(item?.status) || null, averageDailySales28d: numberOrNull(warehouse?.averageDailySales28d) }
      }));
    });
  }

  const cabinetFile = SOURCE_FILES.cabinet;
  const cabinet = files[cabinetFile];
  if (cabinet !== undefined) {
    if (!cabinet?.stores || typeof cabinet.stores !== 'object' || Array.isArray(cabinet.stores)) {
      issue('invalid_file_shape', 'Ожидался объект stores.', 'cabinet-total', cabinetFile, '$');
    } else for (const [slug, snapshot] of Object.entries(cabinet.stores)) {
      const base = `stores.${slug}`;
      const store = mappedStore(slug, 'cabinet-total', cabinetFile, base);
      const observedAt = validObservedAt(snapshot?.capturedAt);
      const day = dayFromObservedAt(observedAt);
      const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
      items.forEach((item, index) => emit({
        day, observedAt, source: 'cabinet-total', ...store, sku: text(item?.itemId || item?.sku),
        article: text(item?.article), name: text(item?.name), totalStock: item?.mainTotal, available: item?.K, inTransit: item?.U,
        quality: snapshot?.validation?.companyVerified === false ? 'Cabinet: магазин не подтвержден' : 'Cabinet: товарный срез',
        sourceFile: cabinetFile, sourceRow: `${base}.items[${index}]`,
        details: { collectionMode: text(snapshot?.collectionMode) || null, excludedT: numberOrNull(item?.excludedT),
          notBeingSold: numberOrNull(item?.notBeingSold), skuTotal: numberOrNull(item?.skuTotal), stockFields: pickedNumbers(item, STOCK_COLUMNS) }
      }));
      const production = snapshot?.warehouseProduction;
      const warehouseItems = Array.isArray(production?.items) ? production.items : [];
      const warehouseObservedAt = validObservedAt(production?.capturedAt);
      const warehouseDay = dayFromObservedAt(warehouseObservedAt);
      let warehouseQuality = 'Cabinet: точный складской срез';
      if (production?.stale === true) warehouseQuality = 'Cabinet: устаревший складской срез';
      else if (production?.complete !== true || Object.keys(production?.deltaToSku || {}).length
        || text(production?.skuCapturedAt) !== text(snapshot?.capturedAt)) warehouseQuality = 'Cabinet: складской срез не подтвержден';
      warehouseItems.forEach((item, index) => emit({
        day: warehouseDay, observedAt: warehouseObservedAt, source: 'cabinet-warehouse', ...store,
        sku: text(item?.sku || item?.itemId), article: text(item?.article), name: text(item?.name),
        warehouse: text(item?.warehouseName), warehouseId: text(item?.warehouseId), cluster: text(item?.clusterName),
        totalStock: item?.mainTotal, available: item?.availableStock ?? item?.K, inTransit: item?.U, quality: warehouseQuality,
        sourceFile: cabinetFile, sourceRow: `${base}.warehouseProduction.items[${index}]`,
        details: { stale: production?.stale === true, complete: production?.complete === true,
          skuCapturedAt: validObservedAt(production?.skuCapturedAt), excludedT: numberOrNull(item?.excludedT),
          stockFields: pickedNumbers(item, STOCK_COLUMNS) }
      }));
    }
  }

  const sellerFile = SOURCE_FILES.seller;
  const seller = files[sellerFile];
  if (seller !== undefined) {
    if (!seller?.stores || typeof seller.stores !== 'object' || Array.isArray(seller.stores)) {
      issue('invalid_file_shape', 'Ожидался объект stores.', 'seller-warehouse', sellerFile, '$');
    } else for (const [slug, snapshot] of Object.entries(seller.stores)) {
      const base = `stores.${slug}`;
      const store = mappedStore(slug, 'seller-warehouse', sellerFile, base);
      const observedAt = validObservedAt(snapshot?.apiUpdatedAt || snapshot?.importedAt);
      const day = dayFromObservedAt(observedAt);
      const rawRows = Array.isArray(snapshot?.rawRows) ? snapshot.rawRows : [];
      rawRows.forEach((item, index) => emit({
        day, observedAt, source: 'seller-warehouse', ...store, sku: text(item?.sku), article: text(item?.article),
        name: text(item?.name), warehouse: text(item?.warehouse), warehouseId: text(item?.warehouseId),
        cluster: text(item?.cluster), totalStock: item?.includedQty, available: item?.qtyK, inTransit: item?.qtyU,
        quality: snapshot?.apiValidation?.fboComplete === true ? 'полный срез Seller Core' : 'неполный срез Seller Core',
        sourceFile: sellerFile, sourceRow: `${base}.rawRows[${index}]`,
        details: { schema: text(item?.stockReportSchema || snapshot?.stockReportSchema) || null,
          apiStock: item?.apiStock ?? null,
          stockFields: Object.fromEntries(STOCK_COLUMNS.filter((field) => Object.prototype.hasOwnProperty.call(item || {}, `qty${field}`))
            .map((field) => [field, numberOrNull(item[`qty${field}`])])) }
      }));
    }
  }

  const clusterFile = SOURCE_FILES.cluster;
  const cluster = files[clusterFile];
  if (cluster !== undefined) {
    if (!Array.isArray(cluster)) {
      issue('invalid_file_shape', 'Ожидался массив пар cache key/value.', 'cluster-warehouse', clusterFile, '$');
    } else cluster.forEach((entry, entryIndex) => {
      const entryLocation = `[${entryIndex}]`;
      if (!Array.isArray(entry) || entry.length !== 2 || !entry[1] || typeof entry[1] !== 'object') {
        issue('invalid_cache_entry', 'Некорректная пара кеша.', 'cluster-warehouse', clusterFile, entryLocation);
        return;
      }
      const cacheKey = text(entry[0]);
      const separator = cacheKey.lastIndexOf('|');
      const slug = separator > 0 ? cacheKey.slice(0, separator) : '';
      const keySku = separator > 0 ? cacheKey.slice(separator + 1) : '';
      const value = entry[1];
      const store = mappedStore(slug, 'cluster-warehouse', clusterFile, entryLocation);
      const observedAt = validObservedAt(value?.product?.capturedAt || value?.capturedAt);
      const day = dayFromObservedAt(observedAt);
      const cacheRows = Array.isArray(value?.rows) ? value.rows : [];
      cacheRows.forEach((item, rowIndex) => {
        const sku = text(item?.sku || keySku);
        if (keySku && sku && keySku !== sku) {
          issue('cache_sku_mismatch', 'SKU строки не совпадает с SKU ключа кеша.', 'cluster-warehouse', clusterFile,
            `${entryLocation}[1].rows[${rowIndex}]`, { keySku, rowSku: sku });
        }
        emit({
          day, observedAt, source: 'cluster-warehouse', ...store, sku, article: text(item?.offer_id),
          name: text(item?.name), warehouse: text(item?.warehouse_name), warehouseId: text(item?.warehouse_id),
          cluster: text(item?.cluster_name), totalStock: null, available: item?.available_stock_count,
          inTransit: item?.transit_stock_count, quality: text(value?.product?.status) === 'ok' ? 'последний успешный срез Seller API' : 'кеш Seller API с неполным статусом',
          sourceFile: clusterFile, sourceRow: `${entryLocation}[1].rows[${rowIndex}]`,
          details: { productStatus: text(value?.product?.status) || null,
            stockStatus: text(value?.product?.stockStatus) || null, stockFields: pickedNumbers(item, CLUSTER_STOCK_FIELDS) }
        });
      });
    });
  }

  return { rows, issues: aggregateIssues(issues), sourceStats: { ...stats, limits: [...SOURCE_LIMITS] } };
}

module.exports = { normalize, SOURCE_FILES, SOURCE_LABELS, SOURCE_LIMITS };
