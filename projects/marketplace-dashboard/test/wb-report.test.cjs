'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize } = require('../wb-report.cjs');
const period = { from: '2026-09-01', to: '2026-09-15' };
const row = values => ({ rrDate: '2026-09-15', saleDt: '2026-08-01', currency: 'RUB', docTypeName: 'Продажа', sellerOperName: 'Продажа', retailAmount: '100.10', forPay: '80.05', quantity: 1, ...values });
const raw = operations => ({ period, operations, sections: { finance: { ok: true } }, financeAmountKnown: false });

test('WB retail sales minus returns; reimbursements and corrections are not item sales', () => {
  const result = summarize(raw([
    row({ quantity: 2 }),
    row({ sellerOperName: 'Возврат', docTypeName: 'Возврат', retailAmount: '20.01', forPay: '15.01' }),
    row({ sellerOperName: 'Возмещение издержек по перевозке', docTypeName: '', quantity: 50, retailAmount: '0', forPay: '0' }),
    row({ sellerOperName: 'Коррекция продаж', docTypeName: 'Возврат', quantity: 1, retailAmount: '0', forPay: '2.26' })
  ]));
  assert.equal(result.salesAmount, 100.10); assert.equal(result.returnsAmount, 20.01);
  assert.equal(result.netSalesAmount, 80.09); assert.equal(result.netSalesUnits, 1);
  assert.equal(result.returnsUnits, 1); assert.equal(result.sellerProceeds, 62.78);
  assert.equal(result.payout, null); assert.equal(result.profit, null); assert.equal(result.roi, null);
  assert.equal(result.financeAmountKnown, true); assert.equal(result.coverage.complete, true);
});

test('uses financial date, detects missing current report and out-of-range coverage', () => {
  const input = raw([row({ rrDate: '2026-09-14' })]);
  const result = summarize(input);
  assert.equal(result.salesAmount, 100.10); assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.observed.to, '2026-09-14');
  const today = summarize(input, { from: '2026-09-15', to: '2026-09-15' });
  assert.equal(today.salesAmount, null); assert.equal(today.salesUnits, null);
  assert.equal(summarize(input, { from: '2026-08-31', to: '2026-09-15' }).salesAmount, null);
  assert.equal(summarize(input, { from: '2026-09-01', to: '2026-09-02' }).salesAmount, 0);
});

test('does not convert missing, malformed, mixed-currency or partial amounts to valid zero', () => {
  for (const value of [null, undefined, '', 'bad', Infinity]) {
    assert.equal(summarize(raw([row({ retailAmount: value })])).salesAmount, null);
  }
  assert.equal(summarize(raw([row(), row({ currency: 'KZT' })])).salesAmount, null);
  assert.equal(summarize({ ...raw([row()]), sections: { finance: { ok: false } } }).salesAmount, null);
  assert.equal(summarize(raw([])).salesAmount, null);
  assert.equal(summarize(raw([row({ rrDate: '', saleDt: '2026-09-15' })])).salesAmount, null);
  assert.equal(summarize(raw([row({ docTypeName: 'Новая операция' })])).salesAmount, null);
});

test('deduplicates safe IDs, preserves monetary signs and never rounds unsafe IDs together', () => {
  const r = row({ rrdId: '1' });
  assert.equal(summarize(raw([r, r])).salesAmount, 100.10);
  assert.equal(summarize(raw([r, r])).coverage.duplicateRows, 1);
  assert.equal(summarize(raw([row({ retailAmount: '-0.10' }), row({ retailAmount: '0.30' })])).salesAmount, 0.2);
  const unsafe = row({ rrdId: Number.MAX_SAFE_INTEGER + 1 });
  assert.equal(summarize(raw([unsafe, unsafe])).salesAmount, 200.20);
  assert.throws(() => summarize(raw([]), { from: '2026-02-30', to: '2026-09-15' }), /период/);
});
