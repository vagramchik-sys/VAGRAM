'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ui = require('../dist/optimizer.js');
const read = file => fs.readFileSync(path.join(__dirname, '..', 'dist', file), 'utf8');

test('отсутствующие суммы не превращаются в нули, известный ноль остаётся нулём', () => {
  assert.equal(ui.numeric(null), null);
  assert.equal(ui.numeric(''), null);
  assert.equal(ui.numeric('NaN'), null);
  assert.equal(ui.numeric('0'), 0);
  assert.equal(ui.money(null), '—');
  assert.match(ui.money(0), /^0\s*₽$/u);
  assert.equal(ui.count(undefined), '—');
  assert.equal(ui.percent(null), '—');
  assert.equal(ui.bid(null, '25000000'), '25000000 ед. API');
  assert.equal(ui.bid(null, null), '—');
  assert.match(ui.bid(12.5, '25000000'), /₽$/u);
});

test('список запрашивает одну ограниченную страницу, локальные фильтры честно действуют внутри неё', () => {
  const query = ui.listParams({ store: 'store-1', campaign: 'campaign-2', search: 'саморез', state: 'BLOCKED', confidence: 'LOW', onlyScalable: true, onlyBlocked: false }, 100);
  assert.equal(query.get('limit'), '50');
  assert.equal(query.get('offset'), '100');
  assert.equal(query.get('store'), 'store-1');
  assert.equal(query.get('campaign'), 'campaign-2');
  assert.equal(query.get('search'), 'саморез');
  assert.equal(query.has('onlyScalable'), false);
  assert.equal(query.has('state'), false);
  assert.equal(query.has('onlyBlocked'), false);
  assert.equal(ui.safeItems({ items: Array.from({ length: 1000 }, (_, i) => ({ id: i })) }).length, 50);
  assert.deepEqual(ui.safeItems({ items: null }), []);
  assert.deepEqual(ui.filterPageItems([{optimizer:{state:'BLOCKED',confidence:'LOW'}},{optimizer:{state:'BID_UP',confidence:'HIGH'}}],{state:'BLOCKED',confidence:'LOW'},'ads').map(item=>item.optimizer.state),['BLOCKED']);
  assert.deepEqual(ui.filterPageItems([{optimizer:{state:'BLOCKED'}},{optimizer:{state:'BID_UP'}}],{onlyScalable:true},'ads').map(item=>item.optimizer.state),['BID_UP']);
});

test('индикатор режима запрашивает настройки выбранного магазина', () => {
  const js = read('optimizer.js');
  assert.match(js, /new URLSearchParams\(\{ store: value \}\)/);
  assert.match(js, /settingsUrl\(form\.elements\.store\.value\)/);
  assert.match(js, /event\.target\.name === 'store'.*loadSettings\(\)/);
});

test('страницы показывают реальные API данные с состоянием без подключения и деталями SKU', () => {
  const prices = read('prices.html'), ads = read('ads.html'), js = read('optimizer.js');
  for (const [html, name] of [[prices, 'prices'], [ads, 'ads']]) {
    assert.match(html, new RegExp(`data-optimizer-page="${name}"`));
    assert.match(html, /optimizer-filters/);
    assert.match(html, /optimizer-detail/);
    assert.match(html, /optimizer\.js/);
    assert.match(html, /seller-workspace\.js/);
  }
  assert.match(js, /\/api\/optimizer\/sku\//);
  assert.match(js, /Performance API не подключён/);
  assert.match(js, /AUTO · недоступен/);
  assert.match(js, /Аварийная блокировка: ВЫКЛ/);
  assert.match(js, /document\.createTextNode/);
  assert.match(ads, /масштаб в рублях не подтверждён/);
  assert.doesNotMatch(js, /\/api\/optimizer\/(?:price|bid)\/apply|\/api\/client\/campaign\/[^'"`]*\/(?:products|bids)/u);
});

test('подключение очищает секрет после успешного сохранения и не выводит его в статус', () => {
  const html = read('connections.html'), js = read('optimizer-connections.js');
  assert.match(html, /optimizer-connections\.js/);
  assert.match(html, /command-transport\.js/);
  assert.match(js, /\/api\/optimizer\/performance\/credentials/);
  assert.match(js, /\/api\/optimizer\/performance\/test/);
  assert.match(js, /expectedRevision = statuses\.find/);
  assert.match(js, /JSON\.stringify\(\{ storeId, clientId, clientSecret, expectedRevision \}\)/);
  assert.match(js, /performance-client-secret'\)\.value = ''/);
  assert.doesNotMatch(js, /localStorage|sessionStorage/);
  assert.match(read('seller-workspace.js'), /\/prices\.html/);
  assert.match(read('seller-workspace.js'), /\/ads\.html/);
});
