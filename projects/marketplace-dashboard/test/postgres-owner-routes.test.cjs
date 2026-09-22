'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const createOwnerRoutes = require('../storage/domains/postgres-owner-routes.cjs');
const { FinanceRegisterError } = require('../storage/domains/postgres-finance-register.cjs');

const COMMAND = '11111111-1111-4111-8111-111111111111', TIMESTAMP = '2026-09-22T12:00:00.000Z';
function adapters(overrides = {}) {
  const management = { products: async () => [], state: async () => ({ batches: [], notes: {}, events: [], capabilities: {} }), preview: async value => value, create: async value => value, transition: async value => value, note: async value => value };
  const financeRegister = { report: async query => ({ query }), saveLoan: async value => value, savePayment: async value => value };
  const supplierPortals = { read: async () => ({ categories: [] }), preview: async id => ({ id }), saveCategory: async value => value, savePortal: async value => value };
  const history = { status: async () => ({ archive: { versions: 0 }, facts: { snapshots: 0 } }), report: async options => options };
  const stockHistory = { status: async () => ({ ok: true }), report: async options => options, csv: async () => '\ufeffcsv' };
  return { management, financeRegister, supplierPortals, history, stockHistory, authorize: async req => req.headers['x-auth'] === 'yes', pricingStatus: async () => ({ active: 0 }), ...overrides };
}
async function serverFor(t, options) {
  const router = createOwnerRoutes(options), server = http.createServer(async (req, res) => {
    const handled = await router.handle(req, res, new URL(req.url, 'http://127.0.0.1'));
    if (!handled) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"fallback"}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
async function request(base, route, { method = 'GET', value, auth = true, headers = {} } = {}) {
  const response = await fetch(base + route, { method, headers: { ...(auth ? { 'x-auth': 'yes' } : {}), ...(value !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, ...(value !== undefined ? { body: JSON.stringify(value) } : {}) });
  const text = await response.text(); return { status: response.status, headers: response.headers, text, value: response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
}

test('authorization precedes all operations; unknown and contract routes fall through', async t => {
  let calls = 0; const values = adapters(); values.management.products = async () => { calls++; return []; };
  const base = await serverFor(t, values);
  assert.equal((await request(base, '/api/manage', { auth: false })).status, 403); assert.equal(calls, 0);
  assert.equal((await request(base, '/api/unowned')).status, 404);
  assert.equal((await request(base, '/api/finance/contracts')).status, 404);
  assert.equal((await request(base, '/api/finance/contracts', { method: 'POST', value: {} })).status, 404);
});

test('router awaits reads and writes and preserves route/query/CSV response contracts', async t => {
  let release; const barrier = new Promise(resolve => { release = resolve; }); let completed = false;
  const values = adapters(); values.management.products = async () => { await barrier; completed = true; return [{ key: 'p' }]; };
  const base = await serverFor(t, values), pending = request(base, '/api/manage');
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(completed, false); release();
  const manage = await pending; assert.equal(manage.status, 200); assert.deepEqual(manage.value.products, [{ key: 'p' }]); assert.deepEqual(manage.value.priceJobs, { active: 0 });
  const history = await request(base, '/api/market-history/report?from=2026-09-01&to=2026-09-02&market=WB&store=wb-1&product=10&metric=units');
  assert.deepEqual(history.value, { from: '2026-09-01', to: '2026-09-02', market: 'WB', storeId: 'wb-1', productId: '10', metric: 'units' });
  const stock = await request(base, '/api/stock-history/report?source=daily-total&limit=5&q=A%25_B'); assert.equal(stock.value.q, 'A%_B');
  const csv = await request(base, '/api/stock-history/export'); assert.equal(csv.status, 200); assert.equal(csv.text, 'csv'); assert.match(csv.headers.get('content-disposition'), /pult-stock-history\.csv/u);
  const saved = await request(base, '/api/finance/loans', { method: 'POST', value: { lender: 'Банк', commandId: COMMAND, timestamp: TIMESTAMP } });
  assert.equal(saved.status, 200); assert.equal(saved.value.item.lender, 'Банк');
});

test('strict mutation envelopes and body limits return safe validation errors', async t => {
  const base = await serverFor(t, adapters());
  for (const value of [null, [], 'text', 1]) assert.equal((await request(base, '/api/finance/loans', { method: 'POST', value })).status, 400);
  assert.equal((await request(base, '/api/finance/loans', { method: 'POST', value: { lender: 'x' } })).status, 400);
  assert.equal((await request(base, '/api/finance/loans', { method: 'POST', value: { commandId: COMMAND, timestamp: TIMESTAMP }, headers: { 'x-pult-command-id': crypto.randomUUID() } })).status, 400);
  const oversized = await fetch(base + '/api/manage/preview', { method: 'POST', headers: { 'x-auth': 'yes', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(1500001) }) });
  assert.equal(oversized.status, 413);
  assert.equal((await request(base, '/api/market-history/report?from=2026-02-30&to=2026-03-01')).status, 400);
});

test('only owned public errors are disclosed; database and canary errors are sanitized with retry guidance', async t => {
  const values = adapters(), canary = 'synthetic-private-canary';
  values.financeRegister.report = async () => { throw Error(canary); };
  values.management.create = async () => { throw Object.assign(Error(canary), { code: 'OUTCOME_UNKNOWN' }); };
  values.financeRegister.saveLoan = async () => { throw new FinanceRegisterError('Проверьте поле «Кредитор»'); };
  const base = await serverFor(t, values);
  const hidden = await request(base, '/api/finance'); assert.equal(hidden.status, 503); assert.equal(hidden.text.includes(canary), false);
  const uncertain = await request(base, '/api/manage/drafts', { method: 'POST', value: { commandId: COMMAND, timestamp: TIMESTAMP } });
  assert.equal(uncertain.status, 503); assert.match(uncertain.value.error, /теми же commandId и timestamp/u); assert.equal(uncertain.text.includes(canary), false);
  const publicError = await request(base, '/api/finance/loans', { method: 'POST', value: { commandId: COMMAND, timestamp: TIMESTAMP } });
  assert.equal(publicError.status, 400); assert.match(publicError.value.error, /Кредитор/u);
});

const integrationUrl = process.env.PULT_TEST_DATABASE_URL;
test('PostgreSQL integration: full owner router uses production adapters in isolated schemas', { skip: !integrationUrl }, async t => {
  assert.match(decodeURIComponent(new URL(integrationUrl).pathname.slice(1)), /test/iu);
  const { Pool } = require('pg'), pool = new Pool({ connectionString: integrationUrl, max: 4 });
  const suffix = crypto.randomBytes(8).toString('hex'), schema = `owner_test_${suffix}`, historySchema = `owner_history_${suffix}`; let owned = false;
  try {
    assert.equal((await pool.query('SELECT to_regnamespace($1) AS name', [schema])).rows[0].name, null);
    await pool.query(require('../storage/postgres-schema.cjs').replaceAll('pult', schema)); owned = true;
    await pool.query(require('../storage/postgres-document-schema.cjs').replaceAll('pult', schema));
    await pool.query(require('../storage/postgres-history-schema.cjs').replaceAll('pult_history', historySchema));
    const stateStore = require('../storage/postgres-state.cjs').createStateStore({ pool, schema });
    const management = require('../storage/domains/postgres-management.cjs')({ stateStore, catalog: async () => [], clock: () => TIMESTAMP });
    const financeRegister = require('../storage/domains/postgres-finance-register.cjs')({ stateStore, getStores: async () => [], clock: () => TIMESTAMP });
    const supplierPortals = require('../storage/domains/postgres-supplier-portals.cjs')({ stateStore, getProducts: async () => [] });
    const facts = require('../storage/postgres-history-repository.cjs').createMarketHistoryRepository({ pool, schema: historySchema });
    const archive = require('../storage/postgres-archive-repository.cjs').createPostgresArchiveRepository({ pool, history: facts, schema: historySchema });
    const history = { status: async () => ({ archive: await archive.status(), facts: await facts.status() }), report: options => facts.report(options) };
    const stockHistory = require('../storage/postgres-stock-repository.cjs').createStockHistoryRepository({ pool, schema: historySchema });
    const base = await serverFor(t, { authorize: async req => req.headers['x-auth'] === 'yes', management, financeRegister, supplierPortals, history, stockHistory, pricingStatus: async () => ({}) });
    assert.equal((await request(base, '/api/manage')).status, 200);
    const loan = await request(base, '/api/finance/loans', { method: 'POST', value: { lender: 'SQL банк', agreementNumber: 'A-1', signedDate: '2026-09-01', originalPrincipal: 1000, sourceNote: 'synthetic', commandId: COMMAND, timestamp: TIMESTAMP } });
    assert.equal(loan.status, 200); assert.equal(loan.value.item.id, COMMAND);
    const category = await request(base, '/api/suppliers/category', { method: 'POST', value: { version: 0, name: 'SQL категория', productKeys: [], commandId: '22222222-2222-4222-8222-222222222222', timestamp: TIMESTAMP } });
    assert.equal(category.status, 200); assert.equal(category.value.version, 1);
    const historyStatus = await request(base, '/api/market-history/status'); assert.equal(historyStatus.status, 200); assert.deepEqual(Object.keys(historyStatus.value).sort(), ['archive', 'facts']);
    assert.equal((await request(base, '/api/stock-history/status')).status, 200);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM "${schema}".source_files WHERE baseline_present=false`)).rows[0].n, 2);
  } finally {
    if (owned) { await pool.query(`DROP SCHEMA "${historySchema}" CASCADE`); await pool.query(`DROP SCHEMA "${schema}" CASCADE`); }
    await pool.end();
  }
});
