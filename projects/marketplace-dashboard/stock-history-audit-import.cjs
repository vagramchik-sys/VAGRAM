'use strict';
const MOSCOW_DAY=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'});

// Pure normalizer: exported files are data, never executable code.
const STATE_KEYS = ['K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z','AA','mainTotal'];
const quantity = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const identity = value => typeof value === 'string' && value.trim() ? value.trim() : Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
function normalizeAudit({files = {}, storeMap = {}} = {}) {
  const rows = [], issues = [], sourceStats = {};
  function issue(file, code, extra = {}) { issues.push({sourceFile:file, code, ...extra}); }
  function store(slug, file) {
    const mapped = Object.hasOwn(storeMap, slug || '') && storeMap[slug];
    if (!mapped || !identity(mapped.id) || typeof mapped.name !== 'string' || !mapped.name.trim()) {
      issue(file, 'unmapped_store', {sourceStoreId:slug || null}); return null;
    }
    return {storeId:identity(mapped.id), storeName:mapped.name};
  }
  function base(mapped, observedAt, source) {
    return {day:MOSCOW_DAY.format(new Date(observedAt)), observedAt, source, ...mapped, sku:null, article:null, name:null,
      warehouse:null, warehouseId:null, cluster:null, totalStock:null, available:null, inTransit:null, reserved:null};
  }
  for (const [file, data] of Object.entries(files).sort(([a],[b]) => a.localeCompare(b))) {
    if (/^stock-api-diagnostics\/[^/]+\.json$/.test(file)) {
      const stats = sourceStats[file] = {kind:'diagnostics', probes:0, acceptedRows:0, skippedRows:0};
      const observedAt = timestamp(data?.generatedAt);
      if (!observedAt || !Array.isArray(data?.stores)) { issue(file, 'invalid_diagnostic_envelope'); continue; }
      for (const [si, sourceStore] of data.stores.entries()) {
        const mapped = store(sourceStore?.storeId, file); if (!mapped) continue;
        for (const [pi, probe] of (Array.isArray(sourceStore.probes) ? sourceStore.probes : []).entries()) {
          if (probe?.endpoint !== '/v1/analytics/stocks' || probe.ok !== true || !Array.isArray(probe.raw?.items)) continue;
          stats.probes++;
          for (const [ri, item] of probe.raw.items.entries()) {
            const sku = identity(item?.sku), warehouseId = identity(item?.warehouse_id);
            const available = quantity(item?.available_stock_count), inTransit = quantity(item?.transit_stock_count);
            if (!sku || !warehouseId || !item || !Object.keys(item).some(k => /_stock_count$/.test(k) && quantity(item[k]) !== null)) {
              stats.skippedRows++; issue(file, 'invalid_diagnostic_row', {sourceRow:`stores[${si}].probes[${pi}].raw.items[${ri}]`}); continue;
            }
            const stockCounts = Object.fromEntries(Object.entries(item).filter(([k]) => /_stock_count$/.test(k)));
            const invalidCounts = Object.entries(stockCounts).filter(([,v]) => v != null && quantity(v) === null).map(([k]) => k);
            if (invalidCounts.length) issue(file, 'invalid_diagnostic_counts', {sourceRow:`stores[${si}].probes[${pi}].raw.items[${ri}]`, fields:invalidCounts});
            rows.push({...base(mapped, observedAt, 'diagnostic-warehouse'), sku, article:identity(item.offer_id),
              name:typeof item.name === 'string' ? item.name : null, warehouseId,
              warehouse:typeof item.warehouse_name === 'string' ? item.warehouse_name : null,
              cluster:typeof item.cluster_name === 'string' ? item.cluster_name : null,
              available, inTransit, quality:'Неполная диагностическая выборка; время начала сбора отчёта',
              sourceFile:file, sourceRow:`stores[${si}].probes[${pi}].raw.items[${ri}]`,
              details:{sourceStoreId:sourceStore.storeId, endpoint:probe.endpoint, generatedAt:data.generatedAt,
                observationTimeBasis:'diagnostic-report-generatedAt', completeness:'unknown-diagnostic-sample',
                stockCounts, clusterId:item.cluster_id ?? null}});
            stats.acceptedRows++;
          }
        }
      }
      continue;
    }
    if (!/^stock-audit\/[^/]+\.jsonl$/.test(file)) continue;
    const stats = sourceStats[file] = {kind:'audit', runs:0, committedRuns:0, acceptedRuns:0, acceptedRows:0};
    if (!Array.isArray(data)) { issue(file, 'invalid_audit_events'); continue; }
    const groups = new Map();
    data.forEach((event, index) => {
      if (!event || !identity(event.runId) || !identity(event.storeId)) { issue(file, 'invalid_audit_event', {sourceRow:String(index)}); return; }
      const key = JSON.stringify([event.storeId,event.runId]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({event,index});
    });
    for (const entries of groups.values()) {
      stats.runs++;
      const first = entries[0].event, mapped = store(first.storeId,file);
      if (!mapped) continue;
      const commits = entries.filter(x => x.event.event === 'committed');
      if (commits.length !== 1) { issue(file, commits.length ? 'ambiguous_commit' : 'uncommitted_run', {runId:first.runId}); continue; }
      stats.committedRuns++;
      const {event:commit,index:commitIndex} = commits[0], committedAt = timestamp(commit.at);
      const allPages = entries.filter(x => x.event.event === 'page' && x.index < commitIndex);
      const attempt = Math.max(...allPages.map(x => Number.isSafeInteger(x.event.attempt) ? x.event.attempt : -1));
      const pages = allPages.filter(x => x.event.attempt === attempt).sort((a,b) => a.event.page-b.event.page);
      const rejected = entries.some(x => x.event.event === 'attempt_rejected' && x.event.attempt === attempt);
      let reason = !committedAt || attempt < 1 || rejected ? 'invalid_committed_attempt' : null;
      if (!reason && (quantity(commit.uniqueCount) === null || quantity(commit.pages) === null || commit.pages < 1 ||
          pages.length !== commit.pages || commit.pagesCaptured !== commit.pages || commit.duplicates !== 0 ||
          pages.some((x,i) => x.event.page !== i+1 || x.event.pages !== commit.pages || x.event.expected !== commit.uniqueCount || !Array.isArray(x.event.records)))) reason = 'incomplete_committed_pages';
      const records = pages.flatMap(p => (Array.isArray(p.event.records) ? p.event.records : []).map((record,i) => ({record,page:p.event,index:p.index,recordIndex:i})));
      const identities = new Set();
      if (!reason) for (const {record,page} of records) {
        const sku = identity(record?.itemId), warehouseId = identity(record?.warehouseId);
        const granularity = record?.granularity;
        const observedAt = timestamp(page.at);
        const key = JSON.stringify([sku,warehouseId,granularity]);
        if (!sku || !observedAt || observedAt > committedAt || !['sku-all-warehouses','sku-warehouse'].includes(granularity) ||
            (granularity === 'sku-warehouse' && !warehouseId) || (granularity === 'sku-all-warehouses' && warehouseId) ||
            !record.states || STATE_KEYS.some(k => quantity(record.states[k]) === null) || identities.has(key)) {
          reason = 'invalid_committed_record'; break;
        }
        identities.add(key);
      }
      if (!reason && (records.length !== commit.uniqueCount || commit.rawCount !== records.length)) reason = 'committed_count_mismatch';
      if (!reason && (!commit.rowTotals || STATE_KEYS.some(k => quantity(commit.rowTotals[k]) === null ||
          records.reduce((sum,x) => sum+x.record.states[k],0) !== commit.rowTotals[k]))) reason = 'committed_totals_mismatch';
      if (reason) { issue(file, reason, {runId:first.runId}); continue; }
      const residual = quantity(commit.serverResidualQty);
      if (residual !== 0) issue(file, 'committed_server_residual', {runId:first.runId, serverResidualQty:residual});
      for (const {record,page,index,recordIndex} of records) {
        const observedAt = timestamp(page.at), source = record.granularity === 'sku-all-warehouses' ? 'audit-total' : 'audit-warehouse';
        rows.push({...base(mapped, observedAt, source), sku:identity(record.itemId), warehouseId:identity(record.warehouseId),
          totalStock:record.states.mainTotal, quality:residual === 0 ? 'Подтверждённый прогон; строки и суммы проверены' : 'Подтверждённый прогон; есть расхождение с серверным итогом',
          sourceFile:file, sourceRow:`${index}.records[${recordIndex}]`,
          details:{sourceStoreId:first.storeId, runId:first.runId, committedAt, attempt, page:page.page,
            granularity:record.granularity, cabinetItemCode:record.cabinetItemCode ?? null, productId:record.productId ?? null,
            states:{...record.states}, serverResidualQty:commit.serverResidualQty ?? null,
            controlResidual:commit.controlResidual ?? null, rowsHash:commit.rowsHash ?? null, identityHash:commit.identityHash ?? null}});
      }
      stats.acceptedRuns++; stats.acceptedRows += records.length;
    }
  }
  return {rows,issues,sourceStats};
}
module.exports = {normalizeAudit};
