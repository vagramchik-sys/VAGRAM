'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const legacy = require('../finance-module.cjs');
const createFinance = require('../storage/domains/postgres-finance-register.cjs');

const digest = bytes => crypto.createHash('sha256').update(bytes).digest();
function memoryStore() {
  let current = null, uncertain = false, conflict = false; const commands = new Map();
  return {
    failNextCommit() { uncertain = true; }, conflictNextWrite() { conflict = true; },
    async read() { return current; },
    async readCommand(key, commandId, { operation }) { const item = commands.get(commandId); if (!item) return null; if (item.key !== key || operation !== 'write') throw Object.assign(Error('reuse'), { code: 'COMMAND_ID_REUSED' }); return item.command; },
    async write(key, content, options) {
      const request = JSON.stringify([key, options.expectedRevision, options.mediaType, content.toString('base64')]), prior = commands.get(options.commandId);
      if (prior) { if (prior.request !== request) throw Object.assign(Error('reuse'), { code: 'COMMAND_ID_REUSED' }); return { revision: prior.revision, replayed: true }; }
      if (conflict) { conflict = false; throw Object.assign(Error('conflict'), { code: 'REVISION_CONFLICT' }); }
      if ((current?.revision || '0') !== options.expectedRevision) throw Object.assign(Error('conflict'), { code: 'REVISION_CONFLICT' });
      const before = current, revision = (BigInt(options.expectedRevision) + 1n).toString(); current = { revision, deleted: false, mediaType: options.mediaType, content: Buffer.from(content), sha256: digest(content) };
      commands.set(options.commandId, { key, request, revision, command: { commandId: options.commandId, before: before ? { ...before } : { revision: '0', mediaType: null, content: null, sha256: null, deleted: null }, after: { ...current } } });
      if (uncertain) { uncertain = false; throw Object.assign(Error('unknown'), { code: 'OUTCOME_UNKNOWN' }); }
      return { revision, replayed: false };
    }, async remove() { throw Error('unsupported'); }
  };
}
const IDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
const command = index => ({ commandId: IDS[index], timestamp: `2026-09-2${index + 1}T10:00:00.000Z` });
const loanInput = { id: 'loan-synthetic', lender: 'Банк', agreementNumber: 'A-1', signedDate: '2026-09-01', originalPrincipal: 1000, outstandingPrincipal: '', annualRatePercent: 12, nextPaymentDate: '2026-10-01', sourceNote: 'Договор A-1' };
const paymentInput = { id: 'payment-synthetic', loanId: 'loan-synthetic', date: '2026-09-20', principal: 100, interest: 10, fee: 0, sourceNote: 'Выписка' };
const period = { from: '2026-09-01', to: '2026-09-30' };
const stores = [{ id: '1', name: 'Ozon', updatedAt: '2026-09-20T10:00:00Z', ledger: { version: 3, complete: true, foreignRecords: 0, period, daily: [{ date: '2026-09-20', values: { net: 7500, records: 1 } }] } }];

test('SQL registry preserves legacy validation, values and report calculations', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pult-pg-finance-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const old = legacy.create({ privateDir: directory, getStores: () => stores });
  const manager = createFinance({ stateStore: memoryStore(), getStores: async () => stores, clock: () => '2026-09-30T12:00:00.000Z' });
  assert.deepEqual(Object.keys(manager).sort(), ['read', 'report', 'saveLoan', 'savePayment']);
  assert.deepEqual(await manager.saveLoan(loanInput, command(0)), old.saveLoan(loanInput));
  assert.deepEqual(await manager.savePayment(paymentInput, command(1)), old.savePayment(paymentInput));
  const actual = await manager.report(period), expected = old.report(period); delete actual.generatedAt; delete expected.generatedAt; delete actual.debt.updatedAt; delete expected.debt.updatedAt;
  assert.deepEqual(actual, expected);
  assert.equal((await manager.read()).loans[0].outstandingPrincipal, null);
  await assert.rejects(manager.savePayment({ ...paymentInput, id: 'negative', principal: -1 }, command(2)), /Погашение тела/);
  await assert.rejects(manager.saveLoan({ ...loanInput, id: 'duplicate', lender: 'банк', agreementNumber: 'a-1' }, command(2)), /уже есть/);
});

test('stable commands survive unknown outcome, later edits and a fresh adapter', async () => {
  const store = memoryStore(), manager = createFinance({ stateStore: store, getStores: async () => [] });
  store.failNextCommit(); await assert.rejects(manager.saveLoan(loanInput, command(0)), error => error.code === 'OUTCOME_UNKNOWN');
  const loan = await manager.saveLoan(loanInput, command(0));
  const payment = await manager.savePayment(paymentInput, command(1));
  await manager.saveLoan({ ...loanInput, outstandingPrincipal: 900 }, command(2));
  const reopened = createFinance({ stateStore: store, getStores: async () => [] });
  assert.deepEqual(await reopened.saveLoan(loanInput, command(0)), loan);
  assert.deepEqual(await reopened.savePayment(paymentInput, command(1)), payment);
  await assert.rejects(reopened.saveLoan({ ...loanInput, originalPrincipal: 2000 }, command(0)), error => error.code === 'COMMAND_ID_REUSED');
  await assert.rejects(reopened.saveLoan(loanInput, { ...command(0), timestamp: command(3).timestamp }), error => error.code === 'COMMAND_ID_REUSED');
  assert.equal((await reopened.read()).loans[0].outstandingPrincipal, 900);
});

test('CAS conflict is surfaced without retry and getStores is awaited', async () => {
  const store = memoryStore(); let resolved = false;
  const manager = createFinance({ stateStore: store, getStores: async () => { await Promise.resolve(); resolved = true; return []; }, clock: () => '2026-09-30T00:00:00.000Z' });
  store.conflictNextWrite(); await assert.rejects(manager.saveLoan(loanInput, command(0)), error => error.code === 'REVISION_CONFLICT');
  assert.equal((await manager.read()).loans.length, 0);
  await manager.report(period); assert.equal(resolved, true);
  await assert.rejects(manager.report({ from: '2026-02-30', to: '2026-03-01' }), error => error instanceof require('../storage/domains/postgres-finance-register.cjs').FinanceRegisterError && error.public === true);
});

const integrationUrl = process.env.PULT_TEST_DATABASE_URL;
test('PostgreSQL integration: register CAS, replay, report and provenance', { skip: !integrationUrl }, async () => {
  assert.match(decodeURIComponent(new URL(integrationUrl).pathname.slice(1)), /test/iu);
  const { Pool } = require('pg'), pool = new Pool({ connectionString: integrationUrl, max: 2 });
  const schema = `finance_register_test_${crypto.randomBytes(8).toString('hex')}`; let owned = false;
  try {
    assert.equal((await pool.query('SELECT to_regnamespace($1) AS name', [schema])).rows[0].name, null);
    await pool.query(require('../storage/postgres-schema.cjs').replaceAll('pult', schema)); owned = true;
    await pool.query(require('../storage/postgres-document-schema.cjs').replaceAll('pult', schema));
    const { createStateStore } = require('../storage/postgres-state.cjs'), stateStore = createStateStore({ pool, schema });
    let manager = createFinance({ stateStore, getStores: async () => stores, clock: () => '2026-09-30T00:00:00.000Z' });
    const loan = await manager.saveLoan(loanInput, command(0)), payment = await manager.savePayment(paymentInput, command(1));
    await manager.saveLoan({ ...loanInput, outstandingPrincipal: 800 }, command(2));
    manager = createFinance({ stateStore: createStateStore({ pool, schema }), getStores: async () => stores, clock: () => '2026-09-30T00:00:00.000Z' });
    assert.deepEqual(await manager.saveLoan(loanInput, command(0)), loan);
    assert.deepEqual(await manager.savePayment(paymentInput, command(1)), payment);
    await assert.rejects(manager.savePayment({ ...paymentInput, fee: 1 }, command(1)), error => error.code === 'COMMAND_ID_REUSED');
    const report = await manager.report(period); assert.equal(report.accruals.value, 75); assert.equal(report.debt.summary.totalCashOut, 110);
    assert.equal((await pool.query(`SELECT baseline_present FROM "${schema}".source_files WHERE source_path='finance-register.json'`)).rows[0].baseline_present, false);
  } finally { if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); }
});
