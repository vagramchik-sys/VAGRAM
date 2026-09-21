(function(root) {
  function stockNumber(value) {
    if (typeof value === 'string') {
      const text = value.trim();
      if (!/^\d+$/.test(text)) return null;
      value = Number(text);
    }
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  function normalizeStockRecords(source) {
    // Keep invalid entries as unknown rows so a partial sum cannot look complete.
    const copy = row => row && typeof row === 'object' && !Array.isArray(row) ? { ...row } : {};
    if (Array.isArray(source)) return source.map(copy);
    if (!source || typeof source !== 'object') return [];
    const rows = [];
    for (const [type, value] of Object.entries(source)) {
      const values = Array.isArray(value) ? value : [value];
      for (const row of values) {
        const record = copy(row);
        rows.push({ ...record, type: record.type || type });
      }
    }
    return rows;
  }
  function stockRow(record) {
    const warehouse = String(record.warehouse_name ?? record.warehouse ?? record.warehouse_id ?? '').trim();
    const rawType = String(record.type ?? record.stock_type ?? '').trim();
    const type = /^(?:fbo|fbs|rfbs)$/i.test(rawType) ? rawType.toUpperCase() : rawType;
    return {
      name: warehouse ? warehouse + (type ? ' · ' + type : '') : type || 'Без детализации',
      kind: warehouse ? 'warehouse' : type ? 'type' : 'unknown',
      present: stockNumber(record.present),
      reserved: stockNumber(record.reserved)
    };
  }
  function stockBreakdown(source, reason = null) {
    if (reason) return { rows: [], complete: false, reason };
    const rows = normalizeStockRecords(source).map(stockRow);
    if (!rows.length) return { rows, complete: false, reason: 'missing_stock_rows' };
    const missingPresent = rows.some(row => row.present === null);
    const missingReserved = rows.some(row => row.reserved === null);
    const presentTotal = missingPresent ? null : rows.reduce((sum, row) => sum + row.present, 0);
    const reservedTotal = missingReserved ? null : rows.reduce((sum, row) => sum + row.reserved, 0);
    const totalOutOfRange = (presentTotal !== null && !Number.isSafeInteger(presentTotal))
      || (reservedTotal !== null && !Number.isSafeInteger(reservedTotal));
    return {
      rows,
      complete: !missingPresent && !missingReserved && !totalOutOfRange,
      reason: missingPresent ? 'invalid_present' : missingReserved ? 'invalid_reserved'
        : totalOutOfRange ? 'stock_total_out_of_range' : null
    };
  }
  function stockTotal(rows, field) {
    if (!rows.length || rows.some(row => row[field] === null)) return null;
    const total = rows.reduce((sum, row) => sum + row[field], 0);
    return Number.isSafeInteger(total) ? total : null;
  }
  function isInactive(product) {
    if (product.market !== 'Ozon') return false;
    const status = String(product.salesStatus || '').toLocaleLowerCase('ru-RU').replaceAll('ё','е').trim();
    return product.archived === true || status === 'не продается';
  }
  function rowsFor(stores, snapshots) {
    return stores.flatMap(store => {
      const data = snapshots.get(store.id); if (!data) return [];
      const stock = new Map(), duplicates = new Set();
      for (const record of Array.isArray(data.stocks) ? data.stocks : []) {
        const id = String(record?.product_id ?? '');
        if (stock.has(id)) duplicates.add(id);
        else stock.set(id, record);
      }
      return data.products.map(p => {
        const id = String(p.product_id), record = stock.get(id);
        const sectionKnown = data.sections?.stocks?.ok === true;
        const breakdown = stockBreakdown(sectionKnown ? record?.stocks : null,
          !sectionKnown ? 'stock_section_unavailable' : duplicates.has(id) ? 'duplicate_product_record' : null);
        const quantity = stockTotal(breakdown.rows, 'present');
        const reservedQuantity = stockTotal(breakdown.rows, 'reserved');
        return { ...p, key: store.id + ':' + p.product_id, storeId: store.id, storeName: store.name,
          market: data.market || 'Ozon', quantity, reservedQuantity, stockBreakdown: breakdown,
          warehouseRows: sectionKnown && !duplicates.has(id) ? normalizeStockRecords(record?.stocks) : [],
          importedAt: data.completedAt, costImportedAt: data.costSummary?.importedAt };
      });
    });
  }
  function filterRows(rows, filter) {
    const query = filter.query.trim().toLocaleLowerCase('ru-RU');
    const selected = rows.filter(p => (!filter.store || p.storeId === filter.store)
      && (!filter.market || p.market === filter.market)
      && (!filter.hideInactive || !isInactive(p))
      && (!query || [p.name, p.offer_id, p.sku, p.storeName].join(' ').toLocaleLowerCase('ru-RU').includes(query))
      && (!filter.issue || (filter.issue === 'cost' && p.market === 'Ozon' && p.cost?.status !== 'filled')
        || (filter.issue === 'zero' && p.quantity === 0) || (filter.issue === 'unknown' && p.quantity === null)));
    const collator = new Intl.Collator('ru-RU', { numeric: true });
    return selected.sort((a,b) => {
      if (filter.sort === 'stock') return (a.quantity ?? Infinity) - (b.quantity ?? Infinity) || collator.compare(a.name, b.name);
      if (filter.sort === 'cost') return (b.cost?.status === 'filled' ? b.cost.unitCost : -1) - (a.cost?.status === 'filled' ? a.cost.unitCost : -1) || collator.compare(a.name,b.name);
      return collator.compare(a.name || '', b.name || '');
    });
  }
  function csvCell(value) {
    let text = String(value ?? '');
    if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  }
  function csv(rows) {
    const table = [['Магазин','Площадка','Товар','Артикул','SKU','Цена','Валюта цены','Себестоимость','Валюта себестоимости','Статус себестоимости','Остаток','Зарезервировано','Дата снимка','Статус продажи']];
    for (const p of rows) table.push([p.storeName,p.market,p.name,p.offer_id,p.sku,p.price,p.currency_code,
      p.cost?.unitCost,p.cost?.currency,p.cost?.status || 'не загружена',p.quantity,p.reservedQuantity,p.importedAt,p.salesStatus||'Не загружен']);
    return '\ufeff' + table.map(row => row.map(csvCell).join(';')).join('\r\n');
  }
  const model = { rowsFor, filterRows, csv, isInactive, stockNumber, normalizeStockRecords, stockBreakdown };
  if (typeof module !== 'undefined' && module.exports) module.exports = model;
  else root.PultModel = model;
})(typeof window === 'undefined' ? {} : window);
