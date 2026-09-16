'use strict';
const assert = require('node:assert/strict');
require('../model.js');
const { toCsv, csvCell, buildReport } = require('../reports.js');
// Independent parser verifies delimiters, escaped quotes, and embedded newlines.
function parse(csv) {
  assert.equal(csv.charCodeAt(0), 0xfeff);
  const rows = []; let row = [], value = '', quoted = false;
  for (let i = 1; i < csv.length; i++) {
    const c = csv[i];
    if (c === '"') { if (quoted && csv[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && c === ';') { row.push(value); value = ''; }
    else if (!quoted && c === '\r' && csv[i + 1] === '\n') { row.push(value); rows.push(row); row = []; value = ''; i++; }
    else value += c;
  }
  assert.equal(quoted, false); return rows;
}
assert.deepEqual(parse(toCsv([['Русский; текст', '"кавычки"', 'две\r\nстроки', '', 12.5, -3.75]])), [['Русский; текст', '"кавычки"', 'две\r\nстроки', '', '12,5', '-3,75']]);
for (const value of ['=SUM(A1:A2)', '+1', '-42', '@abc', '\tcmd', '\rfoo', '\nfoo', '  =1', ' \t+1']) assert.equal(parse(toCsv([[value]]))[0][0], "'" + value);
assert.equal(csvCell(-12.5), '-12,5'); assert.throws(() => csvCell(Infinity));
const state = {
  products: [{ id: 'p1', sku: '=unsafe', name: 'Товар; "первый"', cost: 20, price: 100, stock: 7 }, { id: 'p2', sku: 'empty', name: 'Без продаж', cost: 1, price: 5, stock: 2 }],
  sales: [{ id: 's1', date: '2026-09-01', productId: 'p1', quantity: 2, price: 100, commission: 10, logistics: 5 }, { id: 's2', date: '2026-09-02', productId: 'p1', quantity: 1, price: 50, commission: 3, logistics: 2 }, { id: 's3', date: '2026-09-03', productId: 'p1', quantity: 1, price: 80, commission: 8, logistics: 2 }],
  expenses: [{ id: 'e1', date: '2026-09-02', category: 'Реклама', amount: 4.5, note: '=1+1' }]
};
let rows = parse(buildReport('sales', state, '2026-09-01', '2026-09-02'));
assert.equal(rows.length, 3); assert.equal(rows[1][1], '2026-09-01'); assert.equal(rows[2][1], '2026-09-02');
assert.equal(rows[1][3], "'=unsafe"); assert.equal(rows[1][4], 'Товар; "первый"'); assert.equal(rows[1][12], '145');
rows = parse(buildReport('summary', state, '2026-09-01', '2026-09-02'));
assert.deepEqual(rows[1].slice(3), ['3', '250', '170']); assert.equal(rows.length, 2);
assert.equal(parse(buildReport('products', state, '2027-01-01', '2027-01-02')).length, 3);
rows = parse(buildReport('expenses', state, '2026-09-02', '2026-09-02'));
assert.equal(rows[1][3], '4,5'); assert.equal(rows[1][4], "'=1+1");
assert.equal(parse(buildReport('sales', state, '2027-01-01')).length, 1);
assert.equal(parse(buildReport('sales', state, '', '2026-09-01')).length, 2);
assert.throws(() => buildReport('sales', state, '2026-02-30'));
assert.throws(() => buildReport('sales', state, '2026-09-03', '2026-09-01'));
assert.throws(() => buildReport('unknown', state));
assert.throws(() => buildReport('sales', { ...state, sales: [{ ...state.sales[0], productId: 'missing' }] }));
assert.equal(parse(buildReport('summary', { products: [], sales: [], expenses: [] })).length, 1);
console.log('Report tests passed: CSV encoding/escaping, formula safety, numeric types, date bounds, fresh report calculations.');
