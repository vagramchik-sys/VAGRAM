'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRepository } = require('../repository.cjs');
const { createService } = require('../service.cjs');
const { create } = require('../route.cjs');
const config = require('../module.config.cjs');

function responseCapture() {
  return { status: null, headers: null, body: '', writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
}

test("Пример модуля exposes its minimal API contract", async () => {
  const expected = { module: "developer-example", status: 'ok', items: [] };
  assert.deepEqual(await createRepository().read(), expected);
  assert.deepEqual(await createService().getStatus(), expected);
  const route = create({ config, ctx: {} });
  const response = responseCapture();
  assert.equal(await route.handle({ method: 'GET' }, response, new URL('http://localhost' + config.apiNamespace)), true);
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /application\/json/);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(JSON.parse(response.body), { ok: true, data: expected });
  assert.equal(await route.handle({ method: 'GET' }, responseCapture(), new URL('http://localhost/api/other')), false);

  const methodResponse = responseCapture();
  assert.equal(await route.handle({ method: 'POST' }, methodResponse, new URL('http://localhost' + config.apiNamespace)), true);
  assert.equal(methodResponse.status, 405);
  assert.equal(methodResponse.headers.allow, 'GET');
  assert.equal(methodResponse.headers['cache-control'], 'no-store');
  assert.equal(JSON.parse(methodResponse.body).error.code, 'METHOD_NOT_ALLOWED');

  const logs = [];
  const failureRoute = create({ config, ctx: { service: { async getStatus() { throw new Error('synthetic secret'); } }, logger: { error(fields, message) { logs.push({ fields, message }); } } } });
  const failureResponse = responseCapture();
  assert.equal(await failureRoute.handle({ method: 'GET' }, failureResponse, new URL('http://localhost' + config.apiNamespace)), true);
  assert.equal(failureResponse.status, 503);
  assert.equal(failureResponse.headers['cache-control'], 'no-store');
  assert.equal(JSON.parse(failureResponse.body).error.code, 'MODULE_UNAVAILABLE');
  assert.equal(failureResponse.body.includes('synthetic secret'), false);
  assert.equal(logs.length, 1);
  assert.deepEqual({ module: logs[0].fields.module, route: logs[0].fields.route, operation: logs[0].fields.operation }, { module: config.id, route: config.apiNamespace, operation: 'getStatus' });
  assert.equal(Number.isFinite(logs[0].fields.duration), true);
  assert.equal(Object.hasOwn(logs[0].fields, 'stack'), false);
});
