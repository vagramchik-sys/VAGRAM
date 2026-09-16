(function(root) {
  function isInactive(product) {
    if (product.market !== 'Ozon') return false;
    const status = String(product.salesStatus || '').toLocaleLowerCase('ru-RU').replaceAll('ё','е').trim();
    return product.archived === true || status === 'не продается';
  }
  function rowsFor(stores, snapshots) {
    return stores.flatMap(store => {
      const data = snapshots.get(store.id); if (!data) return [];
      const stock = new Map(data.stocks.map(p => [String(p.product_id), p]));
      return data.products.map(p => {
        const record = stock.get(String(p.product_id));
        const known = data.sections.stocks?.ok && Array.isArray(record?.stocks);
        const quantity = known ? record.stocks.reduce((s, v) => s + Number(v.present || 0), 0) : null;
        return { ...p, key: store.id + ':' + p.product_id, storeId: store.id, storeName: store.name,
          market: data.market || 'Ozon', quantity, warehouseRows: record?.stocks || [],
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
    const table = [['Магазин','Площадка','Товар','Артикул','SKU','Цена','Валюта цены','Себестоимость','Валюта себестоимости','Статус себестоимости','Остаток','Дата снимка','Статус продажи']];
    for (const p of rows) table.push([p.storeName,p.market,p.name,p.offer_id,p.sku,p.price,p.currency_code,
      p.cost?.unitCost,p.cost?.currency,p.cost?.status || 'не загружена',p.quantity,p.importedAt,p.salesStatus||'Не загружен']);
    return '\ufeff' + table.map(row => row.map(csvCell).join(';')).join('\r\n');
  }
  const model = { rowsFor, filterRows, csv, isInactive };
  if (typeof module !== 'undefined' && module.exports) module.exports = model;
  else root.PultModel = model;
})(typeof window === 'undefined' ? {} : window);
