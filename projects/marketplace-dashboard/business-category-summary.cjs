'use strict';

const finite = Number.isFinite;

function summarize(report, date) {
  const types = Array.isArray(report?.types) ? report.types : [];
  const series = Array.isArray(report?.series) ? report.series : [];
  const roots = types.filter(type => type.parentId == null);
  const rows = roots.map(type => {
    const points = series.filter(item => item.typeId === type.id).map(item =>
      (item.points || []).find(point => point.date === date));
    const known = points.filter(point => finite(point?.orderedRevenue));
    return {
      id: type.id,
      name: type.name,
      value: known.length ? Math.round(known.reduce((sum, point) => sum + point.orderedRevenue, 0) * 100) / 100 : null,
      complete: points.length > 0 && points.every(point => point?.complete === true && finite(point.orderedRevenue))
    };
  }).filter(row => finite(row.value)).sort((a, b) => b.value - a.value || String(a.name).localeCompare(String(b.name), 'ru'));
  const knownTotal = rows.length ? Math.round(rows.reduce((sum, row) => sum + row.value, 0) * 100) / 100 : null;
  const scopeComplete = report?.coverage?.complete === true && roots.length > 0 && rows.length === roots.length && rows.every(row => row.complete);
  return {
    date,
    knownTotal,
    complete: scopeComplete,
    coverage: {
      selectedStores: Array.isArray(report?.coverage?.stores) ? report.coverage.stores.length : 0,
      availableStores: Array.isArray(report?.coverage?.stores) ? report.coverage.stores.filter(row => row.observed !== false && row.source !== 'unavailable').length : 0
    },
    rows: rows.slice(0, 6).map(row => ({...row, share: knownTotal > 0 ? row.value / knownTotal * 100 : null}))
  };
}

module.exports = { summarize };
