'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, SOURCE_LIMITS } = require('../stock-history-import.cjs');

const storeMap = { donor: { id: '00123', name: 'Магазин' } };

test('invalid quantities remain unknown and Moscow day is used at midnight',()=>{
 const result=normalize({storeMap,files:{'ozon-cabinet-stock-core.json':{stores:{donor:{capturedAt:'2026-09-20T23:30:00Z',items:[{itemId:'01',mainTotal:false,K:-1,U:1.5}]}}}}});
 assert.equal(result.rows[0].day,'2026-09-21');assert.equal(result.rows[0].totalStock,null);assert.equal(result.rows[0].available,null);assert.equal(result.rows[0].inTransit,null);assert.equal(result.issues[0].count,3);
});

test('daily mismatch is retained and visible; impossible date is rejected',()=>{
 const files={'ozon-product-daily-snapshots.json':{rows:[{snapshotDate:'2026-09-21',storeId:'donor',sku:'01',stockExact:true,warehouseExact:true,totalStock:12,stockCapturedAt:'2026-09-21T10:00:00Z',warehouseCapturedAt:'2026-09-21T09:59:00Z',warehouses:[{warehouseId:'1',qty:11}]}]}};
 const result=normalize({storeMap,files});assert.equal(result.rows.length,2);assert.equal(result.issues[0].code,'daily_total_warehouse_mismatch');assert.match(result.rows[0].quality,/различаются/);assert.match(result.rows[1].quality,/различаются/);
 files['ozon-product-daily-snapshots.json'].rows[0].snapshotDate='2026-02-30';assert.equal(normalize({storeMap,files}).rows.length,0);
});

test('normalizes all six file sources without merging different stock meanings', () => {
  const files = {
    'ozon-product-daily-snapshots.json': { rows: [{
      snapshotDate: '2026-09-07', storeId: 'donor', sku: '00042', article: 'A', name: 'Товар',
      totalStock: 10, stockExact: true, stockCapturedAt: '2026-09-07T07:00:00.000Z',
      warehouseExact: true, warehouseCapturedAt: '2026-09-07T07:01:00.000Z', status: 'ok',
      warehouses: [{ warehouseId: 'w1', warehouse: 'Склад', cluster: 'Центр', qty: 10, availableStock: 7 }]
    }] },
    'ozon-cabinet-stock-core.json': { stores: { donor: {
      capturedAt: '2026-09-21T12:00:00.000Z', validation: { companyVerified: true }, items: [
        { itemId: '00042', article: 'A', name: 'Товар', K: 8, T: 2, U: 1, mainTotal: 12, excludedT: 2 }
      ], warehouseProduction: { capturedAt: '2026-09-21T06:00:00.000Z', skuCapturedAt: '2026-09-21T05:59:00.000Z',
        complete: true, stale: true, deltaToSku: {}, items: [
          { sku: '00042', warehouseId: 'w1', warehouseName: 'Склад', clusterName: 'Центр', K: 6, U: 2, mainTotal: 9 }
        ] }
    } } },
    'ozon-seller-stock-core.json': { stores: { donor: {
      apiUpdatedAt: '2026-09-01T09:00:00.000Z', stockReportSchema: 'schema', apiValidation: { fboComplete: true }, rawRows: [
        { sku: '00042', article: 'A', name: 'Товар', warehouseId: 'w1', warehouse: 'Склад', cluster: 'Центр',
          qtyK: 5, qtyU: 2, qtyV: 3, includedQty: 14 }
      ]
    } } },
    'cluster-supply-last-good.json': [['donor|00042', {
      product: { capturedAt: '2026-09-18T13:56:22.409Z', status: 'ok', stockStatus: 'ok' }, rows: [
        { sku: '00042', offer_id: 'A', name: 'Товар', warehouse_id: 'w1', warehouse_name: 'Склад',
          cluster_name: 'Центр', available_stock_count: 4, transit_stock_count: 3, requested_stock_count: 2 }
      ]
    }]]
  };

  const result = normalize({ files, storeMap });
  assert.deepEqual(result.rows.map((row) => row.source), [
    'daily-total', 'daily-warehouse', 'cabinet-total', 'cabinet-warehouse', 'seller-warehouse', 'cluster-warehouse'
  ]);
  assert.ok(result.rows.every((row) => row.storeId === '00123' && row.sku === '00042' && row.reserved === null));
  assert.equal(result.rows[0].day, '2026-09-07');
  assert.equal(result.rows[0].totalStock, 10);
  assert.equal(result.rows[1].totalStock, 10);
  assert.equal(result.rows[1].available, 7);
  assert.equal(result.rows[2].totalStock, 12);
  assert.equal(result.rows[2].available, 8);
  assert.equal(result.rows[2].inTransit, 1);
  assert.equal(result.rows[3].totalStock, 9);
  assert.equal(result.rows[3].inTransit, 2);
  assert.match(result.rows[3].quality, /устаревший/);
  assert.equal(result.rows[4].totalStock, 14);
  assert.equal(result.rows[4].available, 5);
  assert.equal(result.rows[4].inTransit, 2);
  assert.equal(result.rows[5].totalStock, null);
  assert.equal(result.rows[5].available, 4);
  assert.equal(result.rows[5].inTransit, 3);
  assert.equal(result.rows[5].day, '2026-09-18');
  assert.equal(result.issues.length, 0);
  assert.deepEqual(result.sourceStats.limits, [...SOURCE_LIMITS]);
});

test('reports missing mappings and dates instead of silently importing bad rows', () => {
  const result = normalize({
    files: { 'ozon-product-daily-snapshots.json': { rows: [
      { snapshotDate: '', storeId: 'unknown', sku: '1', totalStock: 1 },
      { snapshotDate: '2026-09-07', storeId: 'donor', sku: '', totalStock: 1 }
    ] } },
    storeMap
  });
  assert.equal(result.rows.length, 0);
  assert.deepEqual(result.issues.map((entry) => entry.code), ['missing_store_mapping', 'missing_date', 'missing_sku']);
  assert.ok(result.issues.every((entry) => entry.count === 1 && entry.examples.length === 1));
  assert.equal(result.sourceStats['daily-total'].inputRows, 2);
  assert.equal(result.sourceStats['daily-total'].skippedRows, 2);
});

test('deduplicates exact records and retains conflicting values with issues', () => {
  const base = {
    product: { capturedAt: '2026-09-18T13:56:22.409Z', status: 'ok', stockStatus: 'ok' },
    rows: [{ sku: '7', warehouse_id: 'w', warehouse_name: 'Склад', cluster_name: 'Центр',
      available_stock_count: 4, transit_stock_count: 1 }]
  };
  const changed = JSON.parse(JSON.stringify(base));
  changed.rows[0].available_stock_count = 5;
  const result = normalize({
    files: { 'cluster-supply-last-good.json': [['donor|7', base], ['donor|7', base], ['donor|7', changed]] },
    storeMap
  });
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.issues.map((entry) => entry.code), ['exact_duplicate', 'conflicting_duplicate']);
  assert.equal(result.sourceStats['cluster-warehouse'].inputRows, 3);
  assert.equal(result.sourceStats['cluster-warehouse'].duplicateRows, 1);
  assert.equal(result.sourceStats['cluster-warehouse'].conflictRows, 1);
});

test('aggregates repeated issues and marks a daily attribution/capture date mismatch', () => {
  const result = normalize({
    files: { 'ozon-product-daily-snapshots.json': { rows: [
      { snapshotDate: '2026-09-07', storeId: 'donor', sku: '1', totalStock: 2, stockExact: true,
        stockCapturedAt: '2026-09-08T00:01:00.000Z' },
      { snapshotDate: '2026-09-07', storeId: 'missing', sku: '2' },
      { snapshotDate: '2026-09-07', storeId: 'missing', sku: '3' }
    ] } },
    storeMap
  });
  assert.equal(result.rows[0].day, '2026-09-07');
  assert.equal(result.rows[0].observedAt, '2026-09-08T00:01:00.000Z');
  assert.match(result.rows[0].quality, /наблюдение от 2026-09-08/);
  const missing = result.issues.find((entry) => entry.code === 'missing_store_mapping');
  assert.equal(missing.count, 2);
  assert.equal(missing.examples.length, 2);
});
