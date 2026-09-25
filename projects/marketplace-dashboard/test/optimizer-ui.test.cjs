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
  assert.equal(ui.bid(null, '25000000'), '—');
  assert.equal(ui.bid(null, null), '—');
  assert.match(ui.bid(12.5, '25000000'), /₽$/u);
});

test('экран рекламы отдельно показывает локальные строки, покрытие и свежесть статистики', () => {
  const partial = { total: 2, period: { from: '2026-09-10', to: '2026-09-23' }, generatedAt: '2026-09-25T09:00:00Z', summary: { complete: false }, items: [
    { advertising: { periodFrom: '2026-09-22', periodTo: '2026-09-23', observedAt: '2026-09-24T08:00:00Z' } },
    { advertising: { periodFrom: null, periodTo: null, observedAt: null } }
  ] };
  assert.deepEqual(ui.adsCoverage(partial), { hasLocalRows: true, hasStatistics: true, complete: false, from: '2026-09-22', to: '2026-09-23', observedAt: '2026-09-24T08:00:00.000Z' });
  assert.match(ui.adsPeriodText(partial), /Запрошенный период: 2026-09-10 — 2026-09-23/);
  assert.match(ui.adsPeriodText(partial), /доступная локальная статистика на этой странице: 2026-09-22 — 2026-09-23/);
  assert.doesNotMatch(ui.adsPeriodText(partial), /25 сент/u, 'время формирования ответа не должно выглядеть свежестью статистики');

  const catalogOnly = { total: 3, period: partial.period, generatedAt: partial.generatedAt, summary: { complete: false }, items: [{ advertising: { periodFrom: null, periodTo: null } }] };
  assert.deepEqual(ui.adsCoverage(catalogOnly), { hasLocalRows: true, hasStatistics: false, complete: false, from: null, to: null, observedAt: null });
  assert.match(ui.adsPeriodText(catalogOnly), /статистика за период ещё не накоплена/);
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
  assert.match(js, /Показаны сохранённые локально кампании и товары/);
  assert.match(js, /Полная история накопится постепенно при ежедневных загрузках/);
  assert.match(js, /AUTO · недоступен/);
  assert.match(js, /AUTO · БЕЗОПАСНОСТЬ/);
  assert.match(js, /Аварийная блокировка: ВЫКЛ/);
  assert.match(js, /document\.createTextNode/);
  assert.match(ads, /Ставки указаны в рублях за клик/);
  assert.doesNotMatch(js + ads, /ед\. API|пересчёт в рубли не подтверждён/);
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

test('ставки сравниваются с разными базами: 35% ниже рынка и 53,8% до конкурентной', () => {
  const ad = {currentBid: 130, competitiveBid: 200};
  assert.equal(ui.bidComparison(ad).belowMarketPct, 35);
  assert.ok(Math.abs(ui.bidComparison(ad).roomPct - 53.846153846) < 1e-6);
  assert.match(ui.bidComparisonText(ad), /Текущая 130 ₽ · Конкурентная 200 ₽ · ниже рынка на 35 %/u);
  assert.equal(ui.competitiveRoom(ad), '+53,8 %');
  assert.equal(ui.competitiveRoom({currentBid: 0, competitiveBid: 200}), '—');
  assert.equal(ui.bidComparison({currentBid: null, competitiveBid: 200}).belowMarketPct, null);
  assert.equal(ui.bidComparison({currentBid: 130, competitiveBid: 0}).belowMarketPct, null);
  assert.equal(ui.bid(0.000001), '0,000001 ₽');
  assert.equal(ui.bid(130, '130000000'), '130 ₽');
});

test('UI не раскрывает непроверенную прибыль и не показывает ставку выше потолка', () => {
  const decision = {maxProfitableBid: 180, recommendedBid: 170};
  assert.deepEqual(ui.confirmedBidValues({confirmed: false, contributionAfterAds: 300}, decision), {cap: null, recommended: null, contribution: null});
  assert.deepEqual(ui.confirmedBidValues({confirmed: true, contributionAfterAds: 0}, decision), {cap: 180, recommended: 170, contribution: 0});
  assert.equal(ui.confirmedBidValues({confirmed: true}, {...decision, recommendedBid: 181}).recommended, null);
  assert.equal(ui.confirmedBidValues({confirmed: true}, {...decision, maxProfitableBid: null}).recommended, null);
  assert.deepEqual(ui.filterPageItems([{optimizer:{state:'WAIT_ECONOMICS'}}],{onlyBlocked:true},'ads').map(item=>item.optimizer.state), ['WAIT_ECONOMICS']);
});
