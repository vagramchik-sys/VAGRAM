'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {financeShape, productShape, advertisingShape, createPostgresOptimizer} = require('../storage/domains/postgres-optimizer.cjs');
const {calculateContributionEconomics} = require('../optimizer/economics.cjs');

test('ledger expense normalization preserves net reversals', () => {
  const value = financeShape({finance_complete: true, finance_unallocated_cents: '0', finance_residual_records: '0', finance_foreign_records: '0', finance_rows: [{date: '2026-09-23', values: {net: 9870, realized: 10000, soldUnits: 1, returnedUnits: 0, salesRows: 1, commission: -100, logistics: 20, acquiring: 0, storage: 0, penalties: 0, other: 0, partners: 0, bonus: 0, ads: -50}}]}, 25);
  assert.equal(value.commission, 1);
  assert.equal(value.logistics, -0.2);
  assert.equal(value.advertising, 0.5);
  assert.equal(value.complete, true);
});

test('complete ledger treats omitted zero fees as zero, but unknown periods remain incomplete', () => {
  const row = {finance_complete: true, finance_source_from: '2026-09-01', finance_source_to: '2026-09-30', finance_unallocated_cents: '0', finance_residual_records: '0', finance_foreign_records: '0', finance_rows: [{date: '2026-09-23', values: {net: 9000, realized: 10000, soldUnits: 1, commission: -1000}}]};
  const period = {from: '2026-09-20', to: '2026-09-23'};
  const value = financeShape(row, 20, period);
  assert.equal(value.realizedRevenue, 100);
  assert.equal(value.commission, 10);
  assert.equal(value.logistics, 0);
  assert.equal(value.cost, 20);
  assert.equal(value.orders, 1);
  assert.equal(value.complete, true);
  assert.equal(financeShape({...row, finance_source_to: '2026-09-21'}, 20, period).complete, false);
  assert.equal(financeShape({...row, finance_complete: false}, 20, period).logistics, null);
  assert.equal(financeShape({...row, finance_rows: [{date: '2026-09-23', values: {...row.finance_rows[0].values, unknownUnitRows: 1}}]}, 20, period).cost, null);
});

test('finance does not claim complete SKU profit with unallocated charges or unreconciled net', () => {
  const row = {finance_complete: true, finance_source_from: '2026-09-01', finance_source_to: '2026-09-30', finance_unallocated_cents: '0', finance_residual_records: '0', finance_foreign_records: '0', finance_rows: [{date: '2026-09-23', values: {net: 9000, realized: 10000, soldUnits: 1, commission: -1000}}]};
  const period = {from: '2026-09-23', to: '2026-09-23'};
  assert.equal(financeShape(row, 20, period).complete, true);
  assert.equal(financeShape({...row, finance_unallocated_cents: '500'}, 20, period).complete, false);
  assert.equal(financeShape({...row, finance_foreign_records: '1'}, 20, period).complete, false);
  assert.equal(financeShape({...row, finance_rows: [{date: '2026-09-23', values: {...row.finance_rows[0].values, net: 9100}}]}, 20, period).complete, false);
  assert.equal(financeShape({...row, finance_unallocated_cents: null}, 20, period).logistics, null);
});

test('unknown archive state is not silently promoted to active', () => {
  assert.equal(productShape({store_id: '1', product: {product_id: '2', sku: '3'}}, 'Store').product.active, null);
  assert.equal(productShape({store_id: '1', product: {product_id: '2', sku: '3', archived: false}}, 'Store').product.active, true);
  assert.equal(productShape({store_id: '1', product: {product_id: '2', sku: '3', is_archived: true}}, 'Store').product.active, false);
});

test('seller price falls back to catalog when costs have no pricing row', () => {
  const value = productShape({store_id: '1', product: {product_id: '2', sku: '3', price: '120', currency_code: 'RUB'}, market_observed_at: '2026-09-23T12:00:00Z'}, 'Store');
  assert.equal(value.price.sellerPrice, 120);
  assert.equal(value.price.observedAt, '2026-09-23T12:00:00.000Z');
});

test('advertising freshness requires both bid and statistics timestamps', () => {
  const input = {observed_at: '2026-09-24T10:00:00Z', statistics_observed_at: '2026-09-23T10:00:00Z'};
  assert.equal(advertisingShape(input).observedAt, '2026-09-23T10:00:00.000Z');
  assert.equal(advertisingShape({...input, statistics_observed_at: null}).observedAt, null);
  assert.equal(advertisingShape({...input, observed_at: new Date(input.observed_at), statistics_observed_at: new Date(input.statistics_observed_at)}).observedAt, '2026-09-23T10:00:00.000Z');
  assert.equal(advertisingShape({...input, spend: null, clicks: '10', impressions: '100', revenue: '100'}).cpc, null);
  assert.equal(advertisingShape({...input, spend: null, clicks: '10', impressions: '100', revenue: '100'}).drrPct, null);
  assert.equal(advertisingShape({...input, current_bid_raw: '25000000', competitive_bid_raw: '30000000'}).currentBidRaw, '25000000');
});

test('one campaign never inherits product-wide profit after partial advertising spend', async () => {
  const financeRows = [{date: '2026-09-23', values: {realized: 10000, soldUnits: 1, returnedUnits: 0, salesRows: 1, commission: -100, logistics: -100, acquiring: 0, storage: 0, penalties: 0, other: 0, partners: 0, bonus: 0, ads: -1500}}];
  const repository = {
    readAds: async () => ({items: [{store_id: '1', product_id: '2', campaign_id: '7', campaign_name: 'One campaign', sku: '3', payment_type: 'CPC', spend: '5', revenue: '100', impressions: '100', clicks: '10', orders: '1', complete: true, period_from: '2026-09-23', period_to: '2026-09-23'}], total: 1, summary: {spend: 5, revenue: 100, complete: true}}),
    readProductInputs: async () => [{store_id: '1', product: {product_id: '2', sku: '3', price: 100, archived: false}, cost: {unitCost: 25, status: 'filled'}, finance_rows: financeRows, finance_complete: true}],
    readSettings: async () => ({mode: 'OBSERVE', killSwitch: false}),
    connectionStatus: async () => ({stores: [{storeId: '1', configured: true}]}), campaignOptions: async () => [],
    readPriceInputs: async () => ({items: [], total: 0}), readAdsForProducts: async () => [], readRecentExperiments: async () => [], readHistory: async () => []
  };
  const optimizer = createPostgresOptimizer({repository, storesRepository: {read: async () => ({'1': {name: 'Store'}})}, sourceProviders: {getProducts: async () => []}, optimizer: {calculateContributionEconomics}, now: () => new Date('2026-09-24T09:00:00Z')});
  const result = await optimizer.ads({storeId: '1', from: '2026-09-23', to: '2026-09-23'});
  assert.equal(result.items[0].advertising.spend, 5);
  assert.equal(result.items[0].economics.contributionAfterAds, null);
  assert.equal(result.summary.contributionAfterAds, null);
});

test('both product lists include recent experiment state using one batched read per page', async () => {
  const experiment = {store_id: '1', product_id: '2', type: 'experiment', dimension: 'PRICE', status: 'observing', at: new Date('2026-09-23T09:00:00Z'), observeUntil: new Date('2026-09-30T09:00:00Z'), beforeValue: '100', afterValue: '103'};
  const product = {store_id: '1', product: {product_id: '2', sku: '3', price: 100, archived: false}, cost: {unitCost: 25, status: 'filled'}};
  let batchReads = 0; const observed = [];
  const repository = {
    readPriceInputs: async () => ({items: [product], total: 1}),
    readAds: async () => ({items: [{store_id: '1', product_id: '2', campaign_id: '7', campaign_name: 'Campaign', sku: '3', payment_type: 'CPC'}], total: 1}),
    readProductInputs: async () => [product], readAdsForProducts: async () => [],
    readRecentExperiments: async refs => { batchReads++; assert.deepEqual(refs, [{storeId: '1', productId: '2'}]); return [experiment]; },
    readSettings: async () => ({mode: 'OBSERVE', killSwitch: false}), readHistory: async () => [],
    connectionStatus: async () => ({stores: []}), campaignOptions: async () => []
  };
  const optimizer = createPostgresOptimizer({repository, storesRepository: {read: async () => ({'1': {name: 'Store'}})}, sourceProviders: {getProducts: async () => []}, optimizer: {optimizerDecision: input => { observed.push(input.history); return {state: input.history.state, action: 'NONE'}; }}, now: () => new Date('2026-09-24T09:00:00Z')});
  const options = {storeId: '1', from: '2026-09-23', to: '2026-09-23'};
  assert.equal((await optimizer.prices(options)).items[0].optimizer.state, 'WAIT_PRICE');
  assert.equal((await optimizer.ads(options)).items[0].optimizer.state, 'WAIT_PRICE');
  assert.equal(batchReads, 2);
  assert.equal(observed[0].activeExperiment.observeUntil, '2026-09-30T09:00:00.000Z');
});
