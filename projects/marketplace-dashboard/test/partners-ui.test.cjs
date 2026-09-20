'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '..', 'dist', file), 'utf8');

test('код доступа выпускается отдельным действием и не сохраняется в браузере', () => {
  const html = read('partners.html'), js = read('partners.js');
  assert.match(js, /\/api\/partners\/issue-credential/);
  assert.match(js, /credential-value'\)\.textContent = result\.credential/);
  assert.match(js, /credential-dialog'\)\.addEventListener\('close'.*credential-value'\)\.textContent = ''/s);
  assert.doesNotMatch(js + html, /localStorage|sessionStorage|document\.cookie/);
  assert.doesNotMatch(js, /innerHTML/);
});

test('владелец назначает конкретные productKeys и явно управляет активностью', () => {
  const html = read('partners.html'), js = read('partners.js');
  assert.match(html, /id="partner-active"/);
  assert.match(html, /только отмеченные ниже товары Ozon/);
  assert.match(js, /productKeys: \[\.\.\.selected\]/);
  assert.match(js, /active: \$\('partner-active'\)\.checked/);
  assert.match(js, /!partner\.active \|\| !partner\.productKeys\.length/);
  assert.match(html, /id="partner-rate">Не задана/);
  assert.match(html, /id="owner-rate">не задана/);
  assert.match(html, /id="target-difference">не рассчитана/);
  assert.match(html, /не подтверждены API тарифов/);
  assert.match(html, /Денежный расчёт не выполняется/);
  assert.doesNotMatch(html + js, /\d+(?:[.,]\d+)?%|\d+(?:[.,]\d+)? п\.п\./);
});

test('кабинет партнёра изолирован от интерфейса владельца и не принимает scope из URL', () => {
  const html = read('partner.html'), js = read('partner.js');
  assert.doesNotMatch(html, /sidebar|navigation\.js|dashboard\.css|\/partners\.html/);
  assert.match(js, /api\('\/api\/partner\/dashboard'\)/);
  assert.doesNotMatch(js, /URLSearchParams|location\.search|localStorage|sessionStorage/);
  assert.match(html, /только товары, явно назначенные владельцем/);
  assert.match(html, /Ключи Ozon и товары других магазинов не показываются/);
  assert.match(js, /value === null \|\| value === undefined \? node\('span', 'unknown', 'Неизвестно'\)/);
});

test('партнёр видит только свою договорную ставку без внутренних условий владельца', () => {
  const assets = read('partner.html') + read('partner.js') + read('partner.css');
  assert.match(assets, /Комиссия по договору с нами/);
  assert.match(assets, /contractCommissionPercent/);
  assert.match(assets, /finance\?\.settlement/);
  assert.doesNotMatch(read('partner.html') + read('partner.js'), /\d+(?:[.,]\d+)?%|\d+(?:[.,]\d+)? п\.п\./);
  assert.doesNotMatch(assets, /targetDifferencePercentagePoints|ourCommissionPercent|partnerCommissionPercent|advertisingPercent|commissionDifferenceIncome|netProfit|owner-rate|target-difference/);
  assert.doesNotMatch(assets, /комиссия Ozon/i);
});
