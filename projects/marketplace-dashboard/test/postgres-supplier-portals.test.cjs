'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createLegacy = require('../supplier-portals.cjs');
const createPostgresSupplierPortals = require('../storage/domains/postgres-supplier-portals.cjs');
const { createStateStore } = require('../storage/postgres-state.cjs');

const command = value => ({ commandId: `${value.repeat(8)}-${value.repeat(4)}-4${value.repeat(3)}-8${value.repeat(3)}-${value.repeat(12)}`, timestamp: `2026-09-22T10:00:0${parseInt(value, 16) % 10}Z` });
const sha = content => crypto.createHash('sha256').update(content).digest();
function memoryState({ unknownOnce = false } = {}) {
  let record = null, uncertain = unknownOnce; const commands = new Map();
  const absent = () => ({ revision: '0', mediaType: null, content: null, sha256: null, deleted: null });
  return { async read() { return record; }, async readCommand(key, id) { return commands.get(id) || null; }, async write(key, content, options) {
    const prior = commands.get(options.commandId);
    if (prior) {
      if (prior.before.revision !== options.expectedRevision || !prior.after.content.equals(content)) throw Object.assign(Error('reused'), { code: 'COMMAND_ID_REUSED' });
      return { revision: prior.after.revision, replayed: true };
    }
    if ((record?.revision || '0') !== options.expectedRevision) throw Object.assign(Error('conflict'), { code: 'REVISION_CONFLICT' });
    const before = record ? { ...record, content: Buffer.from(record.content), sha256: Buffer.from(record.sha256) } : absent();
    const after = { revision: String(BigInt(options.expectedRevision) + 1n), mediaType: options.mediaType, content: Buffer.from(content), sha256: sha(content), deleted: false };
    record = after; commands.set(options.commandId, { commandId: options.commandId, before, after });
    if (uncertain) { uncertain = false; throw Object.assign(Error('hidden database detail'), { code: 'OUTCOME_UNKNOWN' }); }
    return { revision: after.revision, replayed: false };
  }, async remove() { throw Error('unused'); } };
}
const products = () => [
  { key: 'a:1', name: 'Болт', sku: 'sku-1', offer_id: 'bolt', market: 'Ozon', storeName: 'А', quantity: 8, warehouseRows: [{ type: 'fbo', present: 8, secret: 'NO' }], importedAt: '2026-09-18T08:00:00Z', price: 999 },
  { key: 'b:2', name: 'Гайка', sku: 'sku-2', market: 'WB', storeName: 'Б', quantity: null }
];
const forecasts = () => new Map([['a:1', { status: 'available', averageDailyUnits: 1, projectedUnits: 45, requiredUnits: 37, daysOfStock: 8, financialTotal: 999 }]]);
const create = (stateStore, overrides = {}) => createPostgresSupplierPortals({ stateStore, getProducts: async () => products(), getForecasts: async () => forecasts(), now: () => '2026-09-22T12:00:00Z', ...overrides });

async function seed(service) {
  const category = await service.saveCategory({ version: 0, name: 'Крепёж', productKeys: ['a:1', 'b:2'] }, command('1'));
  const portal = await service.savePortal({ version: 1, name: 'Поставщик', categoryIds: [category.id], targets: { 'a:1': 0 } }, command('2'));
  return { category, portal };
}

test('async SQL adapter preserves legacy preview fields and filtering', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supplier-parity-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const legacy = createLegacy({ privateDir: dir, getProducts: products, getForecasts: forecasts, now: () => '2026-09-22T12:00:00Z' });
  const lc = legacy.saveCategory({ version: 0, name: 'Крепёж', productKeys: ['a:1', 'b:2'] });
  const lp = legacy.savePortal({ version: 1, name: 'Поставщик', categoryIds: [lc.id], targets: { 'a:1': 0 } });
  const sql = create(memoryState()), { portal } = await seed(sql);
  const expected = legacy.preview(lp.id), actual = await sql.preview(portal.id);
  assert.deepEqual(actual, expected);
  const serialized = JSON.stringify({ preview: actual, owner: await sql.read() });
  for (const forbidden of ['financialTotal', '"price"', '"secret"']) assert.equal(serialized.includes(forbidden), false);
});

test('providers are awaited and every read is fresh SQL state', async () => {
  const state = memoryState(), a = create(state), b = create(state); const seeded = await seed(a);
  assert.equal((await b.read()).version, 2);
  await b.saveCategory({ version: 2, id: seeded.category.id, name: 'Крепёж 2', productKeys: ['a:1'] }, command('3'));
  assert.equal((await a.preview(seeded.portal.id)).rows[0].category, 'Крепёж 2');
});

test('exact journal replay returns original result after later writes without calling mutable providers', async () => {
  const state = memoryState(); let available = true;
  const service = create(state, { getProducts: async () => { if (!available) throw Error('provider changed'); return products(); } });
  const input = { version: 0, name: 'Крепёж', productKeys: ['a:1'] }, first = await service.saveCategory(input, command('4'));
  await service.saveCategory({ version: 1, name: 'Другое', productKeys: ['b:2'] }, command('5'));
  available = false;
  assert.deepEqual(await service.saveCategory(input, command('4')), first);
  await assert.rejects(service.saveCategory({ ...input, name: 'Изменено' }, command('4')), error => error.code === 'COMMAND_ID_REUSED');
  await assert.rejects(service.saveCategory({ ...input, version: 1 }, command('4')), error => error.code === 'COMMAND_ID_REUSED');
});

test('conflict and unknown outcome are safe and retryable only with the same command', async () => {
  const state = memoryState(), a = create(state), b = create(state);
  const left = a.saveCategory({ version: 0, name: 'A', productKeys: ['a:1'] }, command('6'));
  const right = b.saveCategory({ version: 0, name: 'B', productKeys: ['b:2'] }, command('7'));
  const settled = await Promise.allSettled([left, right]); assert.equal(settled.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(settled.find(x => x.status === 'rejected').reason.status, 409);
  const uncertainState = memoryState({ unknownOnce: true }), service = create(uncertainState), input = { version: 0, name: 'A', productKeys: ['a:1'] };
  await assert.rejects(service.saveCategory(input, command('8')), error => error.code === 'OUTCOME_UNKNOWN');
  const replay = await service.saveCategory(input, command('8')); assert.equal(replay.version, 1);
  await assert.rejects(service.saveCategory({ ...input, productKeys: ['b:2'] }, command('8')), error => error.code === 'COMMAND_ID_REUSED');
});

test('category sales providers are awaited and retain strict unknown coverage', async () => {
  const getCategorySales = async options => options.category ? { totals: { total: null }, coverage: { complete: false, coveredDays: 2, totalDays: 28 } } : { period: { from: '2026-08-21', to: '2026-09-17', days: 28, completedDaysOnly: true }, categories: [{ id: 'x', name: 'Саморезы' }], sources: [] };
  const service = create(memoryState(), { getCategorySales }); const value = await service.categorySalesOverview();
  assert.equal(value.categories[0].net, null); assert.equal(value.coverage.complete, false);
});

const integrationUrl = process.env.PULT_TEST_DATABASE_URL;
test('PostgreSQL integration: source mapping, restart, CAS and durable replay', { skip: !integrationUrl }, async t => {
  const parsed = new URL(integrationUrl), databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, '')); assert.match(databaseName, /^pult_test_[a-z0-9]+$/u);
  const { Pool } = require('pg'), pool = new Pool({ connectionString: integrationUrl, max: 5 }); const schema = `supplier_portals_test_${crypto.randomBytes(8).toString('hex')}`; let owned = false;
  t.after(async () => { if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); });
  assert.equal((await pool.query('SELECT to_regnamespace($1)::text AS namespace', [schema])).rows[0].namespace, null);
  await pool.query(require('../storage/postgres-schema.cjs').replace(/\bpult\b/gu, schema)); owned = true;
  await pool.query(require('../storage/postgres-document-schema.cjs').replace(/\bpult\b/gu, schema));
  const state = createStateStore({ pool, schema }), first = create(state), seeded = await seed(first), restarted = create(state);
  assert.equal((await restarted.read()).version, 2);
  await restarted.saveCategory({ version: 2, id: seeded.category.id, name: 'Обновлено', productKeys: ['a:1'] }, command('9'));
  const replay = await first.saveCategory({ version: 0, name: 'Крепёж', productKeys: ['a:1', 'b:2'] }, command('1'));
  assert.deepEqual(replay, seeded.category); assert.equal((await first.read()).categories.find(x => x.id === seeded.category.id).name, 'Обновлено');
  const provenance = await pool.query(`SELECT source_path,baseline_present FROM "${schema}".source_files`); assert.deepEqual(provenance.rows, [{ source_path: 'supplier-portals.json', baseline_present: false }]);
});
