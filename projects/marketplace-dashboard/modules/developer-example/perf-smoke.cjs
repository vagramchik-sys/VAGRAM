'use strict';

const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { create } = require('./route.cjs');
const config = require('./module.config.cjs');

async function main() {
  let sqlQueries = 0;
  const db = { async query() { sqlQueries += 1; return { rows: [] }; } };
  const route = create({ config, ctx: { db } });
  const iterations = 1000;
  let responseBytes = 0;
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    const response = { status: null, headers: null, body: '', writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = String(body); } };
    const handled = await route.handle({ method: 'GET' }, response, new URL('http://localhost' + config.apiNamespace));
    assert.equal(handled, true);
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    const payload = JSON.parse(response.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.data.module, "developer-example");
    assert.ok(Array.isArray(payload.data.items));
    responseBytes += Buffer.byteLength(response.body);
  }
  const elapsedMs = performance.now() - started;
  assert.equal(Number.isFinite(elapsedMs), true);
  assert.equal(responseBytes > 0, true);
  assert.equal(sqlQueries, 0);
  process.stdout.write(JSON.stringify({ module: "developer-example", iterations, elapsedMs: Number(elapsedMs.toFixed(3)), responseBytes, sqlQueries }) + '\n');
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
