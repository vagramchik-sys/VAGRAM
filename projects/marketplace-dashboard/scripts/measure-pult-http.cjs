'use strict';

// Small, serial, read-only sample of local routes. No response bodies or session
// credentials are printed or persisted. This is diagnostic, not a load test.
const origin = 'http://127.0.0.1:4317';
const day = '2026-09-22';
const week = '2026-09-16';
const month = '2026-08-26';
const paths = [
  ['home HTML', '/'],
  ['stores', '/api/stores'],
  ['data updates', '/api/data-updates'],
  ['changes', '/api/changes'],
  ['insight sources', '/api/insights/sources'],
  ['orders day', `/api/insights?scope=orders&from=${day}&to=${day}`],
  ['orders week', `/api/insights?scope=orders&from=${week}&to=${day}`],
  ['orders month', `/api/insights?scope=orders&from=${month}&to=${day}`],
  ['insights full day', `/api/insights?scope=full&from=${day}&to=${day}`],
  ['insights full week', `/api/insights?scope=full&from=${week}&to=${day}`],
  ['categories day', `/api/order-categories?date=${day}`],
  ['categories week', `/api/order-category-daily?from=${week}&to=${day}`],
  ['categories month', `/api/order-category-daily?from=${month}&to=${day}`],
  ['buyer units day', `/api/buyer-order-segments?from=${day}&to=${day}`],
  ['buyer units week', `/api/buyer-order-segments?from=${week}&to=${day}`],
  ['buyer units month', `/api/buyer-order-segments?from=${month}&to=${day}`],
  ['buyer products day', `/api/buyer-product-segments?from=${day}&to=${day}`],
  ['buyer products week', `/api/buyer-product-segments?from=${week}&to=${day}`],
  ['buyer products month', `/api/buyer-product-segments?from=${month}&to=${day}`],
  ['category sales week', `/api/category-sales?from=${week}&to=${day}`],
];

async function main() {
  const first = await fetch(origin + '/', { signal: AbortSignal.timeout(10000) });
  const cookie = first.headers.get('set-cookie')?.split(';', 1)[0];
  await first.arrayBuffer();
  if (!cookie || !first.ok) throw Error('LOCAL_SESSION_UNAVAILABLE');
  for (const [name, path] of paths) {
    const started = process.hrtime.bigint();
    try {
      const response = await fetch(origin + path, { headers: { cookie }, signal: AbortSignal.timeout(30000) });
      const bytes = (await response.arrayBuffer()).byteLength;
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      console.log(JSON.stringify({ name, route: new URL(path, origin).pathname, status: response.status, ms: Math.round(ms * 10) / 10, bytes }));
    } catch (error) {
      console.log(JSON.stringify({ name, route: new URL(path, origin).pathname, status: 'error', code: error?.name === 'TimeoutError' ? 'TIMEOUT' : 'REQUEST_FAILED' }));
    }
  }
}

if (require.main === module) main().catch(error => {
  console.error(error?.message === 'LOCAL_SESSION_UNAVAILABLE' ? error.message : 'LOCAL_BENCHMARK_FAILED');
  process.exitCode = 1;
});
