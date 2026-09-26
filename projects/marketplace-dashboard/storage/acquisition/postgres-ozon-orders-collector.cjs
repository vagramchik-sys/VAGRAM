'use strict';

const GAP = 61000;
const shift = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const day = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const sameMetrics = (left, right) => left?.revenue === right?.revenue && left?.units === right?.units;
function finalizedAt(row, prior, observedAt) {
  const cutoff = Date.parse(`${shift(row.date, 1)}T00:00:00+03:00`), observed = Date.parse(observedAt);
  return sameMetrics(prior, row) && validTime(prior?.finalizedAt) && Date.parse(prior.finalizedAt) >= cutoff && Date.parse(prior.finalizedAt) <= observed ? prior.finalizedAt : observedAt;
}

function createOzonOrdersCollector({ api, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => new Date() } = {}) {
  if (typeof api !== 'function') throw new TypeError('api is required');

  async function collect({ store, key, mode = 'full', previous = null } = {}) {
    const startedAt = now().toISOString(), to = day(now()), yesterday = shift(to, -1);
    let full = mode === 'full';
    if (!full && (!previous?.orders?.period || previous.orders.period.to < yesterday || previous.orders.period.from > to)) full = true;
    const from = full ? shift(to, -59) : to, out = { ...previous, ordersAttemptAt: startedAt, sections: { ...previous?.sections } };
    if (full) {
      out.startedAt = startedAt;
      out.fullAttemptAt = startedAt;
      try {
        const types = await api(store, key, '/v1/finance/accrual/types', {});
        if (!Array.isArray(types.accrual_types)) throw Error();
        out.types = types.accrual_types;
        out.sections.types = { ok: true, updatedAt: now().toISOString() };
      } catch {
        out.sections.types = { ok: false, error: 'Ozon operation types are unavailable', lastSuccessAt: previous?.sections?.types?.updatedAt || previous?.sections?.types?.lastSuccessAt };
      }
    }

    let analyticsCalls = 0;
    async function analytics(rangeFrom, rangeTo, detail) {
      const values = [], seen = new Set();
      for (let offset = 0; offset < 10000; offset += 1000) {
        if (analyticsCalls > 0) await sleep(GAP);
        analyticsCalls++;
        out.analyticsAttemptAt = now().toISOString();
        const response = await api(store, key, '/v1/analytics/data', {
          date_from: rangeFrom, date_to: rangeTo, metrics: ['revenue', 'ordered_units'], dimension: detail ? ['sku', 'day'] : ['day'], filters: [],
          sort: [{ key: 'revenue', order: 'DESC' }], limit: 1000, offset
        });
        const rows = response.result?.data;
        if (!Array.isArray(rows)) throw Error('shape');
        for (const row of rows) {
          const dimensions = Array.isArray(row.dimensions) ? row.dimensions : [];
          const date = dimensions.map(value => String(value?.id ?? '')).find(value => /^\d{4}-\d{2}-\d{2}$/u.test(value));
          const sku = detail ? dimensions.map(value => String(value?.id ?? '')).find(value => value !== date && /^\d+$/u.test(value)) : null;
          const identity = detail ? `${date}:${sku}` : date;
          if (!date || detail && !sku || date < rangeFrom || date > rangeTo || shift(date, 0) !== date || seen.has(identity) || !Array.isArray(row.metrics) || row.metrics.length !== 2 || !row.metrics.every(Number.isFinite) || !Number.isSafeInteger(row.metrics[1]) || row.metrics[1] < 0) throw Error('shape');
          seen.add(identity);
          values.push(detail ? { date, sku, revenue: row.metrics[0], units: row.metrics[1] } : { date, revenue: row.metrics[0], units: row.metrics[1] });
        }
        if (rows.length < 1000) break;
        if (offset === 9000) throw Error('pages');
      }
      return values;
    }

    try {
      const detail = !full, skuValues = detail ? await analytics(to, to, true) : [], values = [];
      if (detail) {
        const sums = new Map();
        for (const row of skuValues) {
          const value = sums.get(row.date) || { date: row.date, revenue: 0, units: 0 };
          value.revenue = Math.round((value.revenue + row.revenue) * 100) / 100;
          value.units += row.units;
          sums.set(row.date, value);
        }
        values.push(...sums.values());
        const closed = await analytics(yesterday, yesterday, false);
        const updatedAt = now().toISOString(), prior = (previous?.orders?.daily || []).find(row => row.date === yesterday);
        for (const row of closed) {
          values.push({ ...row, finalizedAt: finalizedAt(row, prior, updatedAt) });
        }
        const replaced = new Set([yesterday, to]);
        const daily = [...(previous?.orders?.daily || []).filter(row => !replaced.has(row.date)), ...values].sort((a, b) => a.date.localeCompare(b.date));
        const skuDaily = [...(previous?.orders?.skuDaily || []).filter(row => row.date !== to), ...skuValues].sort((a, b) => a.date.localeCompare(b.date) || String(a.sku).localeCompare(String(b.sku)));
        out.orders = {
          period: { from: previous?.orders?.period?.from || yesterday, to }, daily, skuDaily, skuDailyCoverage: true, skuCoverage: [to], skuUpdatedAt: updatedAt,
          updatedAt, historyUpdatedAt: updatedAt, todayUpdatedAt: updatedAt, todayDate: to, source: '/v1/analytics/data · revenue, ordered_units'
        };
        out.sections.orders = { ok: true, updatedAt };
      } else {
        values.push(...await analytics(from, to, false));
        const updatedAt = now().toISOString(), previousDaily = new Map((previous?.orders?.daily || []).map(row => [row.date, row]));
        const daily = values.map(row => row.date < to ? { ...row, finalizedAt: finalizedAt(row, previousDaily.get(row.date), updatedAt) } : row);
        out.orders = {
          period: { from, to }, daily: daily.sort((a, b) => a.date.localeCompare(b.date)),
          skuDaily: previous?.orders?.todayDate === to ? previous.orders.skuDaily || [] : [],
          skuDailyCoverage: previous?.orders?.todayDate === to && previous?.orders?.skuDailyCoverage === true,
          skuCoverage: previous?.orders?.skuCoverage || [], skuUpdatedAt: previous?.orders?.skuUpdatedAt || null,
          updatedAt, historyUpdatedAt: updatedAt, todayUpdatedAt: updatedAt, todayDate: to, source: '/v1/analytics/data · revenue, ordered_units'
        };
        out.sections.orders = { ok: true, updatedAt };
        out.completedAt = updatedAt;
      }
      delete out.analyticsRetryAt;
    } catch (error) {
      const retry = Number(error?.retryAfterMs) || 0;
      if (error?.status === 429 || retry) out.analyticsRetryAt = new Date(now().valueOf() + Math.max(10 * 60000, retry)).toISOString();
      out.sections.orders = { ok: false, error: 'Ozon orders are temporarily unavailable', lastSuccessAt: previous?.orders?.updatedAt };
    }
    out.errors = Object.values(out.sections).filter(value => value?.ok === false).map(value => value.error);
    return out;
  }
  return Object.freeze({ collect, usesDatabaseCredentials: api.usesDatabaseCredentials === true });
}

module.exports = { createOzonOrdersCollector, GAP };
