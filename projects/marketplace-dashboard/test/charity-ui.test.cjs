'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'dist', 'charity.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '..', 'dist', 'charity.js'), 'utf8');

test('экран истории содержит обязательные поля, фильтры, охват и раздельные статусы', () => {
  for (const id of ['filter-from', 'filter-to', 'filter-store', 'filter-status', 'scope-details', 'status-counts', 'totals', 'history-rows']) assert.match(html, new RegExp(`id="${id}"`));
  for (const heading of ['Дата', 'Программа или получатель', 'Сумма', 'Статус', 'Источник / документ', 'Магазин']) assert.match(html, new RegExp(heading));
  assert.match(script, /completed: 'Завершено'/);
  assert.match(script, /executed: 'Исполнено'/);
  assert.match(script, /pending: 'Ожидает'/);
  assert.match(script, /cancelled: 'Отменено'/);
  assert.match(script, /refunded: 'Возвращено'/);
  assert.match(script, /total\.confirmed/);
  assert.match(script, /state\.counts\[key\]/);
});

test('пустое состояние не утверждает, что пожертвований нет', () => {
  assert.match(script, /История ещё не загружена/);
  assert.doesNotMatch(`${html}\n${script}`, /пожертвований нет/i);
});

test('импорт требует явный источник, preview и нормализованный JSON', () => {
  for (const id of ['import-source', 'import-as-of', 'coverage-from', 'coverage-to', 'import-file', 'import-text', 'preview-import', 'confirm-import']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /Локальный нормализованный JSON/);
  assert.match(script, /api\('\/api\/charity\/import', previewPayload\)/);
  assert.match(script, /if \(!source\) throw new Error\('Укажите источник выгрузки\.'/);
  assert.match(script, /new URLSearchParams\(\)/);
  assert.match(script, /params\.set\('store'/);
});

test('экран не содержит платёжных действий, настроек, сообщений или браузера продавца', () => {
  assert.doesNotMatch(html, /(оплатить|настройки|сообщения|кабинет продавца|seller browser)/i);
  assert.match(script, /state\.capabilities\?\.import !== true/);
  assert.match(script, /\['http:', 'https:'\]/);
});
