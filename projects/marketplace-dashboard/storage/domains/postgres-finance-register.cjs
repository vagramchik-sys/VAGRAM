'use strict';

const { createJsonDocumentRepository } = require('../postgres-json-repository.cjs');
const { sourceKey } = require('../postgres-document-import.cjs');
const { buildReport } = require('../../finance-module.cjs');

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
class FinanceRegisterError extends Error { constructor(message, status = 400) { super(message); this.name = 'FinanceRegisterError'; this.status = status; this.public = true; } }
const fail = (message, status) => { throw new FinanceRegisterError(message, status); };
function finiteMoney(value, label, { allowZero = true } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || (!allowZero && number === 0) || !Number.isSafeInteger(Math.round(number * 100))) fail(`Проверьте поле «${label}»`);
  return Math.round(number * 100) / 100;
}
function clean(value, label, maximum = 160, { required = true } = {}) {
  const text = String(value ?? '').trim(); if ((required && !text) || text.length > maximum) fail(`Проверьте поле «${label}»`); return text;
}
function date(value, label, { required = true } = {}) {
  const text = String(value ?? '').trim(); if (!text && !required) return null;
  const parsed = new Date(`${text}T00:00:00Z`); if (!DATE.test(text) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) fail(`Проверьте поле «${label}»`); return text;
}
const money = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isSafeInteger(Math.round(value * 100));
const instant = value => value === null || typeof value === 'string' && Number.isFinite(Date.parse(value));
const validLoan = loan => object(loan) && typeof loan.id === 'string' && loan.id.length > 0 && loan.id.length <= 80 && typeof loan.lender === 'string' &&
  typeof loan.agreementNumber === 'string' && DATE.test(loan.signedDate) && loan.currency === 'RUB' && money(loan.originalPrincipal) && loan.originalPrincipal > 0 &&
  (loan.outstandingPrincipal === null || money(loan.outstandingPrincipal)) && (loan.annualRatePercent === null || money(loan.annualRatePercent)) &&
  (loan.nextPaymentDate === null || DATE.test(loan.nextPaymentDate)) && ['active', 'closed'].includes(loan.status) && typeof loan.sourceNote === 'string';
const validPayment = payment => object(payment) && typeof payment.id === 'string' && payment.id.length > 0 && payment.id.length <= 80 && typeof payment.loanId === 'string' &&
  DATE.test(payment.date) && money(payment.principal) && money(payment.interest) && money(payment.fee) && payment.principal + payment.interest + payment.fee > 0 && typeof payment.sourceNote === 'string';
const validState = state => object(state) && state.version === 1 && instant(state.updatedAt) && Array.isArray(state.loans) && state.loans.every(validLoan) &&
  Array.isArray(state.payments) && state.payments.every(validPayment);
const empty = () => ({ version: 1, updatedAt: null, loans: [], payments: [] });
const normalized = raw => ({ version: 1, updatedAt: raw?.updatedAt || null, loans: Array.isArray(raw?.loans) ? raw.loans : [], payments: Array.isArray(raw?.payments) ? raw.payments : [] });
function operation(value) {
  if (!object(value) || !UUID.test(value.commandId || '')) fail('Некорректный идентификатор команды');
  if (typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))) fail('Не удалось определить время сохранения');
  return { commandId: value.commandId.toLowerCase(), timestamp: value.timestamp };
}

function createPostgresFinanceRegister({ stateStore, getStores, clock = () => new Date().toISOString() } = {}) {
  if (typeof getStores !== 'function') throw new TypeError('getStores must be an async provider');
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  const repository = createJsonDocumentRepository({ stateStore, logicalKey: sourceKey('finance-register.json'), sourcePath: 'finance-register.json', validate: validState });
  async function load() { const record = await repository.read(); return { record, state: record && !record.deleted ? normalized(record.value) : empty() }; }
  async function read() { return structuredClone((await load()).state); }
  const beforeState = journal => journal.before.absent || journal.before.deleted ? empty() : normalized(journal.before.value);
  async function commit(commandInput, transition) {
    const op = operation(commandInput), journal = await repository.readCommand(op.commandId);
    if (journal) {
      const applied = transition(structuredClone(beforeState(journal)), op);
      await repository.compareAndSet(applied.next, { expectedRevision: journal.before.revision, commandId: op.commandId });
      return structuredClone(applied.result);
    }
    const loaded = await load(), applied = transition(structuredClone(loaded.state), op);
    await repository.compareAndSet(applied.next, { expectedRevision: loaded.record?.revision || '0', commandId: op.commandId });
    return structuredClone(applied.result);
  }
  async function saveLoan(input, commandInput) {
    return commit(commandInput, (state, op) => {
      const id = clean(input?.id || op.commandId, 'Идентификатор', 80), lender = clean(input?.lender, 'Кредитор'), agreementNumber = clean(input?.agreementNumber, 'Номер договора'), signedDate = date(input?.signedDate, 'Дата договора');
      const duplicate = state.loans.find(item => item.id !== id && item.lender.toLocaleLowerCase('ru-RU') === lender.toLocaleLowerCase('ru-RU') && item.agreementNumber.toLocaleLowerCase('ru-RU') === agreementNumber.toLocaleLowerCase('ru-RU'));
      if (duplicate) fail('Такой договор уже есть в реестре');
      const loan = { id, lender, agreementNumber, signedDate, currency: 'RUB', originalPrincipal: finiteMoney(input.originalPrincipal, 'Сумма договора', { allowZero: false }), outstandingPrincipal: input.outstandingPrincipal === '' || input.outstandingPrincipal == null ? null : finiteMoney(input.outstandingPrincipal, 'Остаток основного долга'), annualRatePercent: input.annualRatePercent === '' || input.annualRatePercent == null ? null : finiteMoney(input.annualRatePercent, 'Процентная ставка'), nextPaymentDate: date(input.nextPaymentDate, 'Следующий платёж', { required: false }), status: ['active', 'closed'].includes(input.status) ? input.status : 'active', sourceNote: clean(input.sourceNote, 'Источник подтверждения', 300) };
      const index = state.loans.findIndex(item => item.id === id); if (index >= 0) state.loans[index] = loan; else state.loans.push(loan);
      state.updatedAt = op.timestamp; return { next: state, result: loan };
    });
  }
  async function savePayment(input, commandInput) {
    return commit(commandInput, (state, op) => {
      const loanId = clean(input?.loanId, 'Договор', 80); if (!state.loans.some(item => item.id === loanId)) fail('Договор не найден');
      const payment = { id: clean(input.id || op.commandId, 'Идентификатор', 80), loanId, date: date(input.date, 'Дата платежа'), principal: finiteMoney(input.principal, 'Погашение тела'), interest: finiteMoney(input.interest, 'Проценты'), fee: finiteMoney(input.fee, 'Комиссии'), sourceNote: clean(input.sourceNote, 'Источник подтверждения', 300) };
      if (payment.principal + payment.interest + payment.fee <= 0) fail('Укажите хотя бы одну сумму платежа');
      const duplicate = state.payments.find(item => item.id !== payment.id && item.loanId === payment.loanId && item.date === payment.date && item.principal === payment.principal && item.interest === payment.interest && item.fee === payment.fee && item.sourceNote.toLocaleLowerCase('ru-RU') === payment.sourceNote.toLocaleLowerCase('ru-RU'));
      if (duplicate) fail('Похожий платёж уже есть в реестре');
      const index = state.payments.findIndex(item => item.id === payment.id); if (index >= 0) state.payments[index] = payment; else state.payments.push(payment);
      state.updatedAt = op.timestamp; return { next: state, result: payment };
    });
  }
  async function report(query = {}) {
    const today = clock().slice(0, 10), from = date(query.from || new Date(Date.parse(`${today}T00:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10), 'Начало периода'), to = date(query.to || today, 'Конец периода');
    if (from > to || Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 366 * 86400000) fail('Проверьте период');
    const stores = await getStores(); if (!Array.isArray(stores)) throw new TypeError('getStores must resolve to an array');
    return buildReport({ stores, state: (await load()).state, from, to });
  }
  return Object.freeze({ read, saveLoan, savePayment, report });
}

module.exports = createPostgresFinanceRegister;
module.exports.createPostgresFinanceRegister = createPostgresFinanceRegister;
module.exports.FinanceRegisterError = FinanceRegisterError;
