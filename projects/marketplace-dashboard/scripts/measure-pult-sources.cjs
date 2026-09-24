'use strict';

// Serial, read-only source diagnostic. Prints timings/counts, never source data.
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createApplicationPool } = require('../storage/postgres-connection.cjs');
const { createLiveComposition } = require('../storage/postgres-live-composition.cjs');
const { requestMetrics } = require('../storage/postgres-request-metrics.cjs');

function response() {
  const res = new EventEmitter(); res.statusCode = 200;
  res.write = () => true;
  res.end = () => { res.emit('finish'); };
  return res;
}

async function main() {
  const pool = await createApplicationPool({ bootstrapFile: path.resolve(__dirname, '../.private/postgres-setup/application.dpapi'), profile: 'ui' });
  try {
    const live = await createLiveComposition({ pool }), sources = live.sourceProviders;
    const operations = [
      ['catalogs', () => sources.getCatalogs()],
      ['insights', () => sources.getInsights()],
      ['category insights', () => sources.getCategoryInsights()],
      ['WB orders', () => sources.getWbOrders()],
      ['buyer snapshots week', () => sources.getSnapshots({ from: '2026-09-16', to: '2026-09-22' })],
      ['buyer snapshots week warm', () => sources.getSnapshots({ from: '2026-09-16', to: '2026-09-22' })],
      ['all products', () => sources.getAllProducts()],
    ];
    for (const [name, work] of operations) {
      const res = response(), slug = name.replaceAll(' ', '-'); let rows;
      try {
        rows = await requestMetrics.run({ method: 'GET', url: '/diagnostic/' + slug }, res, async () => {
          const value = await work(); res.end(); return Array.isArray(value) ? value.length : null;
        });
        const m = requestMetrics.snapshot().recent.at(-1);
        console.log(JSON.stringify({ name, rows, wallMs: m.wallMs, sqlCount: m.sqlCount, sqlMs: m.sqlMs, poolWaitMs: m.poolWaitMs }));
      } catch (error) {
        console.log(JSON.stringify({ name, code: typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'SOURCE_UNAVAILABLE' }));
      }
    }
  } finally { await pool.end(); }
}

if (require.main === module) main().catch(() => { console.error('LOCAL_SOURCE_DIAGNOSTIC_FAILED'); process.exitCode = 1; });
