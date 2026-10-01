'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

// Run the shipped browser code, replacing only automatic page startup.
// Minimal nodes support journal rendering; no business functions are replaced.
function fixture(fetchResponse) {
  function node() {
    return {children: [], textContent: '', value: '', isConnected: true, dataset: {},
      classList: {add() {}, toggle() {}},
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      addEventListener() {}, setAttribute() {}, querySelectorAll() { return []; },
      remove() { this.isConnected = false; }, focus() {}};
  }
  const nodes = new Map(), requests = [];
  const document = {getElementById(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
    createElement: node, createTextNode(text) { return {...node(), textContent: text}; }};
  const source = fs.readFileSync(path.join(__dirname, '../dist/ad-control.js'), 'utf8');
  const startup = /loadStores\(\);\s*\}\)\(\);\s*$/;
  assert.match(source, startup, 'browser startup must be isolated without replacing behavior');
  const context = vm.createContext({document, console, crypto, AbortController, URLSearchParams,
    location: {search: ''}, localStorage: {getItem() { return null; }, setItem() {}},
    Option: function(text, value) { return {...node(), textContent: text, value}; },
    fetch: async (url, options) => { requests.push({url, options}); return fetchResponse(url, options); }});
  vm.runInContext(source.replace(startup,
    'globalThis.hooks = {model, stateInfo, money, applyPreview, reconcileEntry};\n})();'), context);
  return {...context.hooks, document, node, requests};
}
function texts(node) { return [node.textContent || '', ...(node.children || []).flatMap(texts)].join(' '); }
const command = () => ({commandId: crypto.randomUUID(), token: '1.7.preview', kind: 'budget',
  action: {kind: 'budget', weeklyBudgetRub: 1200}, storeId: '1', campaignId: '7', campaignName: 'Campaign'});

test('Ozon state prefixes preserve active state and stop reason', () => {
  const f = fixture(() => { throw Error('unexpected network'); });
  assert.equal(f.stateInfo({state: 'CAMPAIGN_STATE_RUNNING'}).active, true);
  assert.equal(f.stateInfo({state: 'CAMPAIGN_STATE_RUNNING'}).label, 'Активна');
  assert.equal(f.stateInfo({state: 'CAMPAIGN_STATE_STOPPED'}).active, false);
  assert.equal(f.stateInfo({state: 'CAMPAIGN_STATE_STOPPED'}).label, 'Недостаточно бюджета');
});

test('unconfirmed budget is not displayed as zero rubles', () => {
  const f = fixture(() => { throw Error('unexpected network'); });
  for (const value of [null, undefined, '']) assert.equal(f.money(value), 'Не подтверждён');
  assert.notEqual(f.money(0), 'Не подтверждён');
  assert.match(f.money(1200.25), /25/);
});

for (const failure of ['network failure', 'truncated success JSON']) {
  test(failure + ' after apply remains unknown and offers reconciliation', async () => {
    const f = fixture(async () => {
      if (failure === 'network failure') throw new TypeError('Failed to fetch');
      return {ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); }};
    });
    const submitted = command(), button = f.node(), preview = f.node();
    await f.applyPreview(submitted, button, preview);
    const entry = f.model.journal.find(row => row.id === submitted.commandId);
    assert.equal(entry.status, 'unknown', 'lost response does not establish that Ozon rejected the write');
    assert.equal(entry.storeId, submitted.storeId);
    assert.equal(entry.campaignId, submitted.campaignId);
    assert.match(texts(f.document.getElementById('journal-list')), /Сверить с Ozon/);
    assert.equal(f.requests.filter(row => row.url === '/api/ad-control/apply').length, 1, 'no automatic write retry');
  });
}

for (const responseKind of ['incomplete valid JSON', 'applied receipt for another UUID']) {
  test(responseKind + ' cannot confirm or reject the submitted change', async () => {
    const body = responseKind === 'incomplete valid JSON' ? {}
      : {ok: true, status: 'applied', commandId: crypto.randomUUID()};
    const f = fixture(async () => ({ok: true, status: 200, json: async () => body}));
    const submitted = command(), preview = f.node();
    await f.applyPreview(submitted, f.node(), preview);
    const entry = f.model.journal.find(row => row.id === submitted.commandId);
    assert.equal(entry.status, 'unknown', 'only a complete matching receipt establishes the result');
    assert.equal(preview.isConnected, true, 'an unrelated receipt must not remove the submitted preview as applied');
    assert.match(texts(f.document.getElementById('journal-list')), /Сверить с Ozon/);
    assert.equal(f.requests.length, 1, 'an uncertain receipt must not trigger another request or write');
  });
}

test('reconcile receipt for another UUID does not confirm the clicked journal entry', async () => {
  const otherId = crypto.randomUUID();
  const f = fixture(async url => ({ok: true, status: 200, json: async () => url.includes('/reconcile')
    ? {ok: true, status: 'applied', commandId: otherId}
    : {campaign: {id: '7', title: 'Campaign'}, audit: [], pending: null, campaigns: []}}));
  const entry = {id: crypto.randomUUID(), status: 'unknown', label: 'Изменение бюджета',
    storeId: '1', campaignId: '7', campaignName: 'Campaign', time: new Date().toISOString()};
  f.model.journal.push(entry);
  await f.reconcileEntry(entry, f.node());
  assert.notEqual(entry.status, 'applied', 'a campaign-wide reconciliation can return a different command');
  assert.ok(f.requests.some(row => row.url.startsWith('/api/ad-control/campaign?')), 'reload persisted receipts to resolve the clicked command by identity');
  assert.doesNotMatch(entry.detail, /Не удалось/, 'the check must not pass merely because the test DOM or API failed');
  assert.equal(f.requests.filter(row => row.url === '/api/ad-control/apply').length, 0);
});
