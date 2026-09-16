function summarize(raw, costs, prices) {
  const groups = new Map(), days = new Map();
  const knownAmounts = raw.financeAmountKnown !== false;
  for (const operation of raw.operations || []) {
    const name = operation.operation_type_name || operation.operation_type || operation.sellerOperName || operation.docTypeName || 'Прочее';
    const currency = operation.total_amount?.currency || operation.currency || 'RUB';
    const amount = knownAmounts ? Math.round(Number(operation.amount || 0) * 100) : 0;
    const key = currency + ':' + name;
    const group = groups.get(key) || { operation_type_name: name, currency, cents: 0, record_count: 0 };
    group.cents += amount; group.record_count++; groups.set(key, group);
    const date = String(operation.date || operation.rrDate || operation.saleDt || '').slice(0, 10);
    if (knownAmounts && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const dayKey = currency + ':' + date;
      const day = days.get(dayKey) || { date, currency, cents: 0, records: 0 };
      day.cents += amount; day.records++; days.set(dayKey, day);
    }
  }
  const costMap = new Map((costs?.items || []).map(p => [p.product_id, p]));
  const priceSource=prices||costs;
  const priceMap=new Map((priceSource?.items||[]).filter(p=>p.pricing).map(p=>[String(p.product_id),{...p.pricing,importedAt:priceSource.importedAt}]));
  return {
    store: raw.store, clientId: raw.clientId, market: raw.market || 'Ozon',
    completedAt: raw.completedAt, startedAt: raw.startedAt, period: raw.period,
    sections: raw.sections, financeAmountKnown: knownAmounts,
    operationCount: (raw.operations || []).length,
    operations: [...groups.values()].map(({ cents, ...g }) => ({ ...g, amount: cents / 100 })),
    daily: [...days.values()].map(({ cents, ...d }) => ({ ...d, amount: cents / 100 })).sort((a,b) => a.date.localeCompare(b.date)),
    costSummary: costs ? {
      source: costs.source, importedAt: costs.importedAt, total: costs.items.length,
      filled: costs.items.filter(p => p.status === 'filled').length,
      zero: costs.items.filter(p => p.status === 'zero').length,
      missing: costs.items.filter(p => p.status === 'missing').length
    } : null,
    stocks: raw.stocks || [],
    products: (raw.products || []).map(p => ({
      product_id: p.product_id || p.id, sku: p.sku || p.sources?.[0]?.sku,
      skus:[...new Set([p.sku,...(p.sources||[]).map(s=>s.sku)].filter(Boolean))],
      name: p.name, offer_id: p.offer_id, price: priceMap.has(String(p.product_id||p.id))?priceMap.get(String(p.product_id||p.id)).price:p.price, currency_code: priceMap.get(String(p.product_id||p.id))?.currency||p.currency_code,
      pricing:priceMap.get(String(p.product_id||p.id))||null,
      salesStatus: p.statuses?.status_name || null,
      archived: Boolean(p.is_archived || p.is_autoarchived || p.archived),
      cost: costMap.get(String(p.product_id || p.id)) || null
    }))
  };
}
module.exports = { summarize };
