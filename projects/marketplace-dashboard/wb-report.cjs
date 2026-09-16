'use strict';

const SOURCE_URL = 'https://dev.wildberries.ru/docs/openapi/financial-reports-and-accounting';
// WB's report formula: sum retailAmount for docTypeName=Продажа minus Возврат.
// https://static-basket-02.wbbasket.ru/vol20/portal/education/instruction/Kak_chitat_finansovyi_otchet.pdf
// forPay is proceeds BEFORE logistics, storage and other deductions, not profit
// or the final payment. The current import omits cashback and other fee fields,
// so a complete payout must not be inferred from this restricted projection.
function date(value) {
  const d = typeof value === 'string' ? value.slice(0, 10) : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d ? d : null;
}
function number(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value.trim()))) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
const cents = value => { const n = number(value); return n === null ? null : Math.round(n * 100); };

function summarize(raw = {}, { from = raw.period?.from, to = raw.period?.to } = {}) {
  from = date(from); to = date(to);
  if (!from || !to || from > to) throw new Error('WB: укажите корректный период отчёта');
  const imported = { from: date(raw.period?.from), to: date(raw.period?.to) };
  const observed = { from: null, to: null };
  const currencies = new Set(), seen = new Set();
  let rows = 0, missingDates = 0, duplicateRows = 0, invalidAmounts = 0, invalidUnits = 0, invalidProceeds = 0;
  let sales = 0, returns = 0, salesUnits = 0, returnsUnits = 0, proceeds = 0;
  const hasOperations = Array.isArray(raw.operations);
  for (const row of hasOperations ? raw.operations : []) {
    // rrDate is the financial-report date. saleDt would silently mix two
    // different periods (late reports and adjustments often refer to old sales).
    const day = date(row.rrDate);
    if (!day) { missingDates++; continue; }
    if (!observed.from || day < observed.from) observed.from = day;
    if (!observed.to || day > observed.to) observed.to = day;
    if (day < from || day > to) continue;
    // IDs arrive as numbers or strings. Unsafe numeric IDs are not deduplicated:
    // two distinct large integers may have rounded to the same JS number.
    const id = row.rrdId;
    const safeId = (typeof id === 'string' && /^\d+$/.test(id)) || (typeof id === 'number' && Number.isSafeInteger(id));
    if (safeId) {
      const key = String(row.reportId ?? '') + ':' + String(id);
      if (seen.has(key)) { duplicateRows++; continue; }
      seen.add(key);
    }
    rows++;
    currencies.add(row.currency || 'unknown');
    const sign = row.docTypeName === 'Продажа' ? 1 : row.docTypeName === 'Возврат' ? -1 : 0;
    const amount = cents(row.retailAmount), pay = cents(row.forPay);
    if (amount === null || (!sign && amount !== 0)) invalidAmounts++;
    else if (sign > 0) sales += amount;
    else if (sign < 0) returns += amount;
    if (pay === null || (!sign && pay !== 0)) invalidProceeds++;
    else proceeds += sign * pay;
    // Shipment/reimbursement quantity is not a sold-item count. Corrections
    // have their own operation names and must not become physical returns.
    if (row.sellerOperName === 'Продажа' || row.sellerOperName === 'Возврат') {
      const q = number(row.quantity);
      if (q === null || q < 0 || !Number.isSafeInteger(q)) invalidUnits++;
      else if (row.sellerOperName === 'Продажа') salesUnits += q;
      else returnsUnits += q;
    }
  }
  const financeOk = raw.sections?.finance?.ok === true && hasOperations;
  const currency = currencies.size === 1 && !currencies.has('unknown') ? [...currencies][0] : null;
  const inImportedRange = !!(imported.from && imported.to && from >= imported.from && to <= imported.to);
  const complete = financeOk && inImportedRange && missingDates === 0 && !!observed.to && to <= observed.to;
  // An unreported period is unknown, not zero. Empty intervals before the last
  // received report date can still be verified as zero within a complete import.
  const intervalKnown = financeOk && inImportedRange && missingDates === 0 && !!observed.to && from <= observed.to;
  const currencyKnown = rows === 0 || currency !== null;
  const financeAmountKnown = intervalKnown && currencyKnown && invalidAmounts === 0;
  const unitsKnown = intervalKnown && invalidUnits === 0;
  const limitations = ['Итоговая выплата, прибыль и ROI не определяются по сокращённому финансовому отчёту WB.'];
  if (!complete) limitations.push('Финансовые отчёты не подтверждают весь выбранный период.');
  if (missingDates) limitations.push('Есть строки без корректной даты финансового отчёта.');
  if (!currencyKnown) limitations.push('Суммы в разных или неизвестных валютах не складываются.');
  if (invalidAmounts || invalidProceeds || invalidUnits) limitations.push('Часть строк содержит неизвестные или некорректные финансовые значения.');
  if (duplicateRows) limitations.push('Повторные строки отчёта исключены по идентификатору.');
  return {
    salesAmount: financeAmountKnown ? sales / 100 : null,
    returnsAmount: financeAmountKnown ? returns / 100 : null,
    netSalesAmount: financeAmountKnown ? (sales - returns) / 100 : null,
    salesUnits: unitsKnown ? salesUnits : null,
    returnsUnits: unitsKnown ? returnsUnits : null,
    netSalesUnits: unitsKnown ? salesUnits - returnsUnits : null,
    sellerProceeds: intervalKnown && currencyKnown && invalidProceeds === 0 ? proceeds / 100 : null,
    payout: null, profit: null, roi: null, financeAmountKnown, currency,
    coverage: { requested: { from, to }, imported, observed, complete, rows, missingDates, duplicateRows },
    source: { kind: 'wb-finance-detailed', dateBasis: 'rrDate', updatedAt: raw.completedAt || null, url: SOURCE_URL },
    limitations
  };
}
module.exports = { summarize };
