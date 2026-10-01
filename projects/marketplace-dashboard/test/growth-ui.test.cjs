'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ui = require('../dist/growth.js');

test('unknown financial values stay distinct from confirmed zero', () => {
  for (const value of [null, undefined, '', NaN, Infinity]) {
    assert.equal(ui.numeric(value), null);
    assert.equal(ui.money(value), '—');
    assert.equal(ui.count(value), '—');
    assert.equal(ui.percent(value), '—');
  }
  assert.equal(ui.numeric('0'), 0);
  assert.match(ui.money(0), /^0(?:,00)?\s*₽$/u);
  assert.equal(ui.percent(0), '0%');
});

test('selection identity uses both actual store and product, including all-store view', () => {
  const state = {storeId: '', selected: {product: {storeId: '11', id: '22'}}};
  assert.equal(ui.isCurrentSelection(state, '11', '22'), true);
  assert.equal(ui.isCurrentSelection(state, '12', '22'), false);
  assert.equal(ui.isCurrentSelection(state, '11', '23'), false);
  state.storeId = '12';
  assert.equal(ui.isCurrentSelection(state, '11', '22'), true, 'a changing filter does not redefine the selected product');
  state.selected = null;
  assert.equal(ui.isCurrentSelection(state, '11', '22'), false);
});

test('list requests preserve filters and fetch a bounded page', () => {
  const params = ui.buildListParams({store: '11', search: 'Саморезы', from: '2026-09-01', to: '2026-09-30', objective: 'sales'}, 100);
  assert.equal(params.get('store'), '11');
  assert.equal(params.get('search'), 'Саморезы');
  assert.equal(params.get('offset'), '100');
  assert.equal(params.get('limit'), '50');
  assert.equal(params.get('objective'), 'sales');
  assert.equal(ui.safeItems({items: Array.from({length: 60}, (_, id) => ({id}))}).length, 50);
  assert.deepEqual(ui.safeItems({items: null}), []);
});

test('evidence keeps Moscow time and optional missing positions without inventing zeroes', () => {
  const fields = {observedAt: '2026-10-01T12:30', region: ' Москва ', query: ' Саморезы ',
    ownBuyerPrice: '1000', ownUnitCount: '100', ownPosition: '', comparable: true,
    competitors: [{name: ' Аналог ', url: 'https://ozon.ru/product/123/', buyerPrice: '900', unitCount: '100', position: ''}]};
  const context = {storeId: '11', productId: '22', revision: '7', commandId: 'fixed-id'};
  const value = ui.buildEvidencePayload(fields, context);
  assert.equal(value.storeId, '11');
  assert.equal(value.productId, '22');
  assert.equal(value.expectedRevision, '7');
  assert.equal(value.commandId, 'fixed-id');
  assert.equal(value.observation.observedAt, '2026-10-01T09:30:00.000Z');
  assert.equal(ui.moscowLocalValue(value.observation.observedAt), fields.observedAt);
  assert.equal(value.observation.ownPosition, null);
  assert.equal(value.observation.competitors[0].position, null);
  assert.equal(value.observation.competitors[0].buyerPrice, 900);
  assert.equal(value.observation.competitors[0].unitCount, 100);
});

test('page totals distinguish absent data, confirmed zero and partial coverage', () => {
  assert.deepEqual(ui.sumKnown([null, undefined, '', NaN]), {value: null, known: 0});
  assert.deepEqual(ui.sumKnown([null, 0]), {value: 0, known: 1});
  assert.deepEqual(ui.sumKnown([null, '12.5', 7.5, undefined]), {value: 20, known: 2});
  assert.deepEqual(ui.sumKnown([]), {value: null, known: 0});
});

test('complete ledger alone does not label invalid-cost economics as confirmed', () => {
  const item = {analysisBasis: {financeComplete: true}, economics: {contributionPerOrder: 150},
    advisory: {coverage: {economicsUsable: false}}};
  assert.equal(ui.economicsUsable(item), false);
  item.advisory.coverage.economicsUsable = true;
  assert.equal(ui.economicsUsable(item), true);
  item.analysisBasis.financeComplete = false;
  assert.equal(ui.economicsUsable(item), false);
  assert.equal(ui.economicsUsable({analysisBasis: {financeComplete: true}}), false);
});

test('personal terms select planned scenarios and never fall back to unrelated ledger assumptions', () => {
  const historical = [{id: 'ledger', metrics: [{value: 111}]}];
  const planned = [{id: 'plan', metrics: [{value: 222}]}];
  const item = {advisory: {scenarios: historical}, commercialPlan: {scenarios: planned}};
  const terms = {commissionPct: 21, advertisingPct: 12};
  assert.deepEqual(ui.scenarioSelection(item, terms).scenarios, planned);
  assert.deepEqual(ui.scenarioSelection(item, null).scenarios, historical);
  assert.notEqual(ui.scenarioSelection(item, terms).title, ui.scenarioSelection(item, null).title);
  delete item.commercialPlan;
  const missing = ui.scenarioSelection(item, terms);
  assert.notDeepEqual(missing.scenarios, historical);
  assert.ok(ui.normalizeScenarios(missing.scenarios).every(row => row.status === 'unavailable'));
});

test('dialog identity and revision remain those shown at open despite later selection and GET results', () => {
  const opening = {storeId: '11', productId: '22', revision: '7'};
  const context = ui.createDialogContext(opening, 1);
  Object.assign(opening, {storeId: '33', productId: '44', revision: '8'});
  assert.equal(context.storeId, '11');
  assert.equal(context.productId, '22');
  assert.equal(context.revision, '7');
  const reopened = ui.createDialogContext(opening, 2);
  assert.notEqual(reopened, context);
  assert.notEqual(reopened.generation, context.generation);
});

test('retry after lost response reuses exact command identity, scope, revision and submitted values', () => {
  const context = ui.createDialogContext({storeId: '11', productId: '22', revision: '7'}, 1);
  const values = [{name: 'Sample', url: 'https://ozon.ru/product/123/'}];
  const signature = JSON.stringify(values);
  let builds = 0;
  const first = ui.stableSubmission(context, signature, () => {
    builds++;
    return {storeId: context.storeId, productId: context.productId,
      expectedRevision: context.revision, commandId: 'original-command', competitors: values};
  });
  // The server may have committed even though its response was lost.
  const retry = ui.stableSubmission(context, signature, () => {
    builds++;
    return {commandId: 'must-not-be-created', expectedRevision: '8'};
  });
  assert.equal(retry, first);
  assert.equal(builds, 1);
  assert.equal(retry.commandId, 'original-command');
  assert.equal(retry.expectedRevision, '7');
  assert.equal(retry.storeId, '11');
  assert.equal(retry.productId, '22');
  assert.deepEqual(retry.competitors, values);
});

test('editing competitor identity cannot transfer the original competitor financial metrics', () => {
  const original = {name: 'Original', url: 'https://ozon.ru/product/123/', matchStatus: 'candidate',
    matchNotes: '', unitCount: 10, metrics: {averagePrice: 450, orderedUnits: 99, drrPct: 12}};
  const edited = ui.watchCompetitorInput({...original, name: 'Replacement', url: 'https://ozon.ru/product/456/'},original);
  assert.equal(edited.url, 'https://ozon.ru/product/456/');
  assert.equal(edited.name, 'Replacement');
  assert.equal(edited.metrics, null);
  assert.equal(original.metrics.averagePrice, 450, 'editor normalization does not mutate the stored observation');
  const unchanged = ui.watchCompetitorInput({...original,url:'https://www.ozon.ru/product/name-123/?from=search'},original);
  assert.deepEqual(unchanged.metrics,original.metrics,'editing a name or a URL alias preserves historical metrics');
  assert.notEqual(unchanged.metrics,original.metrics,'the saved payload owns a copy');
});
