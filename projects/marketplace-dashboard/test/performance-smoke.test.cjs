'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { endpoints, moscowDay } = require('../scripts/perf-smoke.cjs');

test('performance smoke covers the user-requested analytics endpoints with structural-only budgets', () => {
  const routes = endpoints.map(item => item.route);
  for (const route of ['/api/business-dynamics', '/api/stores', '/api/insights', '/api/category-sales', '/api/b2b-radar', '/api/order-category-daily', '/api/buyer-product-segments']) assert.ok(routes.includes(route), route);
  for (const item of endpoints) {
    assert.ok(item.maxSql > 0);
    assert.ok(item.maxBytes > 100_000);
    assert.equal(Object.hasOwn(item, 'maxMs'), false);
  }
});

test('performance smoke builds Moscow dates', () => {
  assert.match(moscowDay(), /^\d{4}-\d{2}-\d{2}$/);
});
