'use strict';

// Read-only live HTTP smoke. It reports timings but gates only correctness and
// generous structural budgets, so a noisy laptop does not make CI flaky.
const ORIGIN = process.env.PULT_ORIGIN || 'http://127.0.0.1:4317';
const endpoints = Object.freeze([
  { name: 'business-dynamics', route: '/api/business-dynamics', path: day => `/api/business-dynamics?date=${day}&market=all`, maxSql: 15, maxBytes: 1024 * 1024 },
  { name: 'stores', route: '/api/stores', path: () => '/api/stores', maxSql: 30, maxBytes: 128 * 1024 },
  { name: 'insights-orders', route: '/api/insights', path: (day, week) => `/api/insights?scope=orders&from=${week}&to=${day}`, maxSql: 80, maxBytes: 512 * 1024 },
  { name: 'category-sales', route: '/api/category-sales', path: () => '/api/category-sales?days=7', maxSql: 40, maxBytes: 2 * 1024 * 1024 },
  { name: 'b2b-radar', route: '/api/b2b-radar', path: (day, week) => `/api/b2b-radar?from=${week}&to=${day}&market=all&limit=50&offset=0`, maxSql: 30, maxBytes: 1024 * 1024 },
  { name: 'order-category-daily', route: '/api/order-category-daily', path: (day, week) => `/api/order-category-daily?from=${week}&to=${day}&market=all`, maxSql: 200, maxBytes: 5 * 1024 * 1024 },
  { name: 'buyer-product-segments', route: '/api/buyer-product-segments', path: (day, week) => `/api/buyer-product-segments?from=${week}&to=${day}&market=all&limit=20&buyerType=legal`, maxSql: 30, maxBytes: 1024 * 1024 }
]);

function moscowDay(offset = 0) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const date = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day) - offset));
  return date.toISOString().slice(0, 10);
}

async function fetchJson(path, cookie) {
  const response = await fetch(new URL(path, ORIGIN), { headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(30000) });
  const body = Buffer.from(await response.arrayBuffer());
  let value;
  try { value = JSON.parse(body.toString('utf8')); } catch { value = null; }
  return { status: response.status, bytes: body.length, value, cookie: response.headers.get('set-cookie')?.split(';', 1)[0] || null };
}

async function run({ samples = 2, includeFull = false } = {}) {
  if (!Number.isInteger(samples) || samples < 1 || samples > 5) throw Error('INVALID_SAMPLES');
  const home = await fetchJson('/', null);
  if (home.status !== 200 || !home.cookie) throw Error('LOCAL_SESSION_UNAVAILABLE');
  const cookie = home.cookie, day = moscowDay(), week = moscowDay(6), results = [];
  const checks = includeFull ? [...endpoints, { name: 'insights-full', route: '/api/insights', path: (today, from) => `/api/insights?scope=full&from=${from}&to=${today}`, maxSql: 120, maxBytes: 2 * 1024 * 1024 }] : endpoints;
  for (const endpoint of checks) {
    const history = [];
    for (let index = 0; index < samples; index++) {
      const before = await fetchJson('/api/runtime-metrics', cookie);
      if (before.status !== 200 || !before.value?.recent) throw Error('METRICS_UNAVAILABLE');
      const started = process.hrtime.bigint();
      const response = await fetchJson(endpoint.path(day, week), cookie);
      const clientMs = Number(process.hrtime.bigint() - started) / 1e6;
      if (response.status !== 200) throw Error(`HTTP_${response.status}:${endpoint.name}`);
      const after = await fetchJson('/api/runtime-metrics', cookie);
      const previousAt = Date.parse(before.value.generatedAt || '');
      const metric = [...(after.value?.recent || [])].reverse().find(row => row.route === endpoint.route && row.status === 200 && Date.parse(row.at) >= previousAt);
      if (!metric || metric.responseBytes !== response.bytes) throw Error(`METRIC_MISMATCH:${endpoint.name}`);
      if (metric.sqlCount > endpoint.maxSql || response.bytes > endpoint.maxBytes) throw Error(`STRUCTURAL_BUDGET:${endpoint.name}`);
      history.push({ clientMs: +clientMs.toFixed(1), serverMs: metric.wallMs, sqlCount: metric.sqlCount, sqlMs: metric.sqlMs, poolWaitMs: metric.poolWaitMs, externalMs: metric.externalMs, responseBytes: response.bytes });
    }
    results.push({ endpoint: endpoint.name, samples: history });
  }
  const poolSnapshot = await fetchJson('/api/runtime-metrics', cookie);
  return { generatedAt: new Date().toISOString(), origin: ORIGIN, dateBasis: 'Europe/Moscow', samples, results, pools: poolSnapshot.value.pools };
}

if (require.main === module) {
  const args = process.argv.slice(2), samplesIndex = args.indexOf('--samples'), samples = samplesIndex >= 0 ? Number(args[samplesIndex + 1]) : 2;
  run({ samples, includeFull: args.includes('--include-full') }).then(value => console.log(JSON.stringify(value, null, 2))).catch(error => { console.error(error.message.startsWith('HTTP_') || error.message.startsWith('STRUCTURAL_') || error.message.startsWith('METRIC_') ? error.message : 'PERF_SMOKE_FAILED'); process.exitCode = 1; });
}

module.exports = { endpoints, moscowDay, run };
