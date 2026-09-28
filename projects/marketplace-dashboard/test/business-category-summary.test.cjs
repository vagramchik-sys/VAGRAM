'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize } = require('../business-category-summary.cjs');

test('top products include only known positive sums and preserve partial coverage', () => {
  const report = {
    coverage: { complete: false, stores: [{ observed: true, source: 'orders' }] },
    types: [{ id: 'root', parentId: null, name: 'Все' }],
    series: [{ typeId: 'root', points: [{ date: '2026-09-28', orderedRevenue: 500, complete: false }] }],
    byProduct: [
      { productKey: 'a', name: 'Первый', storeName: 'Магазин', market: 'Ozon', points: [{ date: '2026-09-28', orderedRevenue: 300, complete: false, revenueKnown: false }] },
      { productKey: 'b', name: 'Второй', storeName: 'Магазин', market: 'Ozon', points: [{ date: '2026-09-28', orderedRevenue: 200, complete: true, revenueKnown: true }] },
      { productKey: 'unknown', name: 'Неизвестный', points: [{ date: '2026-09-28', orderedRevenue: null, complete: false, revenueKnown: false }] },
      { productKey: 'zero', name: 'Без продаж', points: [{ date: '2026-09-28', orderedRevenue: 0, complete: true, revenueKnown: true }] }
    ]
  };
  const result = summarize(report, '2026-09-28');
  assert.deepEqual(result.products.map(row => [row.key, row.value, row.complete]), [['a', 300, false], ['b', 200, true]]);
  assert.equal(result.productsComplete, false);
});

test('top products are limited, sorted and complete only with complete report coverage', () => {
  const byProduct = Array.from({ length: 7 }, (_, index) => ({
    productKey: String(index), name: 'Товар ' + index, storeName: 'Магазин', market: 'WB',
    points: [{ date: '2026-09-28', orderedRevenue: 100 + index, complete: true, revenueKnown: true }]
  }));
  const result = summarize({ coverage: { complete: true, stores: [] }, types: [], series: [], byProduct }, '2026-09-28');
  assert.deepEqual(result.products.map(row => row.value), [106, 105, 104, 103, 102]);
  assert.equal(result.productsComplete, true);
});

