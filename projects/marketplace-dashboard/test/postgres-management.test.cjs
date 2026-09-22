'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createLegacy = require('../management.cjs');
const createManagement = require('../storage/domains/postgres-management.cjs');

const digest = bytes => crypto.createHash('sha256').update(bytes).digest();
function memoryStore() {
  let current = null, uncertain = false; const commands = new Map();
  return {
    failNextCommit() { uncertain = true; },
    async read() { return current; },
    async readCommand(key, commandId, { operation }) { const item = commands.get(commandId); if (!item) return null; if (item.key !== key || operation !== 'write') throw Object.assign(Error('reuse'), { code: 'COMMAND_ID_REUSED' }); return item.command; },
    async write(key, content, options) {
      const request = JSON.stringify([key, options.expectedRevision, options.mediaType, content.toString('base64')]), prior = commands.get(options.commandId);
      if (prior) { if (prior.request !== request) throw Object.assign(Error('reuse'), { code: 'COMMAND_ID_REUSED' }); return { revision: prior.revision, replayed: true }; }
      if ((current?.revision || '0') !== options.expectedRevision) throw Object.assign(Error('conflict'), { code: 'REVISION_CONFLICT' });
      const before = current, revision = (BigInt(options.expectedRevision) + 1n).toString(); current = { revision, deleted: false, mediaType: options.mediaType, content: Buffer.from(content), sha256: digest(content) };
      commands.set(options.commandId, { key, request, revision, command: { commandId: options.commandId, before: before ? { ...before } : { revision: '0', mediaType: null, content: null, sha256: null, deleted: null }, after: { ...current } } });
      if (uncertain) { uncertain = false; throw Object.assign(Error('unknown'), { code: 'OUTCOME_UNKNOWN' }); }
      return { revision, replayed: false };
    },
    async remove() { throw Error('unused'); }
  };
}
const AT = '2026-09-22T11:00:00.000Z';
const IDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444'];
const command = index => ({ commandId: IDS[index], timestamp: new Date(Date.parse(AT) + index * 60000).toISOString() });
function fixtures() {
  return [{ key: '1:10', storeId: '1', market: 'Ozon', name: 'Товар', offer_id: 'X', storeName: 'Магазин', salesStatus: 'Продается', cost: { status: 'filled', unitCost: 50, currency: 'RUB' }, pricing: { price: 100, minPrice: 70, oldPrice: 150, currency: 'RUB', importedAt: AT } }];
}
async function request(manager, extra = {}) { const product = (await manager.products())[0]; return { targets: [{ key: product.key, version: product.version }], mode: 'percent', amount: 10, rounding: 0, ...extra }; }

test('async SQL adapter matches legacy products and preview without changing marketplace values', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pult-pg-management-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const products = fixtures(), legacy = createLegacy({ file: path.join(directory, 'management.json'), catalog: () => products, now: () => AT });
  const manager = createManagement({ stateStore: memoryStore(), catalog: async () => products, clock: () => AT });
  assert.deepEqual(await manager.products(), legacy.products());
  const input = await request(manager);
  assert.deepEqual(await manager.preview(input), legacy.preview(input));
  assert.equal(products[0].pricing.price, 100);
  assert.equal((await manager.state()).capabilities.priceWrite, false);
});

test('writes await CAS, use deterministic ids and replay the original result after later writes', async () => {
  const store = memoryStore(); let products = fixtures(); const manager = createManagement({ stateStore: store, catalog: async () => products, clock: () => AT });
  const change = await request(manager), preview = await manager.preview(change);
  const input = { ...change, title: 'Проверка цены', reason: 'Новая закупочная цена', requestId: 'test-request-12345678', previewHash: preview.hash, acceptWarnings: true };
  const batch = await manager.create(input, command(0));
  assert.equal(batch.id, IDS[0]); assert.equal(batch.createdAt, command(0).timestamp); assert.equal(batch.status, 'draft');
  const note = await manager.note({ key: '1:10', version: 0, text: 'Закупить', flag: 'purchase' }, command(1)); assert.equal(note.version, 1);
  products = [];
  assert.deepEqual(await manager.create(input, command(0)), batch);
  await assert.rejects(manager.create({ ...input, title: 'Другой текст' }, command(0)), error => error.code === 'COMMAND_ID_REUSED');
  await assert.rejects(manager.create(input, { ...command(0), timestamp: command(1).timestamp }), error => error.code === 'COMMAND_ID_REUSED');
  const state = await manager.state(); assert.equal(state.batches.length, 1); assert.equal(state.notes['1:10'].text, 'Закупить'); assert.equal(state.events.length, 2);
});

test('create race switches to durable replay without consulting a changed catalog', async () => {
  const base = memoryStore(), products = fixtures(), first = createManagement({ stateStore: base, catalog: async () => products, clock: () => AT });
  const change = await request(first), preview = await first.preview(change);
  const input = { ...change, title: 'Race', reason: 'Commit race', requestId: 'race-request-12345678', previewHash: preview.hash, acceptWarnings: true };
  const original = await first.create(input, command(0));
  let commandReads = 0, stateReads = 0;
  const racedStore = {
    ...base,
    async read(...args) { if (stateReads++ === 0) return null; return base.read(...args); },
    async readCommand(...args) { if (commandReads++ === 0) return null; return base.readCommand(...args); }
  };
  const raced = createManagement({ stateStore: racedStore, catalog: async () => { throw new Error('catalog must not be read during durable replay'); }, clock: () => AT });
  assert.deepEqual(await raced.create(input, command(0)), original);
  assert.equal(commandReads, 2);
});

test('transition and note preserve public validation and unknown commit is surfaced once', async () => {
  const store = memoryStore(); let products = fixtures(); const manager = createManagement({ stateStore: store, catalog: async () => products, clock: () => AT });
  const change = await request(manager), preview = await manager.preview(change);
  const input = { ...change, title: 'Заявка', reason: 'Причина', requestId: 'request-unknown-12345', previewHash: preview.hash, acceptWarnings: true };
  store.failNextCommit(); await assert.rejects(manager.create(input, command(0)), error => error.code === 'OUTCOME_UNKNOWN');
  const batch = await manager.create(input, command(0));
  const submitted = await manager.transition({ id: batch.id, version: 1, status: 'submitted' }, command(1)); assert.equal(submitted.version, 2);
  await manager.transition({ id: batch.id, version: 2, status: 'cancelled' }, command(2));
  products = [];
  assert.deepEqual(await manager.transition({ id: batch.id, version: 1, status: 'submitted' }, command(1)), submitted);
  await assert.rejects(manager.transition({ id: batch.id, version: 1, status: 'cancelled' }, command(1)), error => error.code === 'COMMAND_ID_REUSED');
  await assert.rejects(manager.note({ key: 'missing', version: 0, text: '', flag: 'normal' }, { commandId: crypto.randomUUID(), timestamp: AT }), error => error.public && error.status === 404);
});

const integrationUrl = process.env.PULT_TEST_DATABASE_URL;
test('PostgreSQL integration: management state and provenance survive a fresh adapter', { skip: !integrationUrl }, async () => {
  assert.match(decodeURIComponent(new URL(integrationUrl).pathname.slice(1)), /test/iu);
  const { Pool } = require('pg'), pool = new Pool({ connectionString: integrationUrl, max: 2 });
  const schema = `management_test_${crypto.randomBytes(8).toString('hex')}`; let owned = false;
  try {
    assert.equal((await pool.query('SELECT to_regnamespace($1) AS name', [schema])).rows[0].name, null);
    await pool.query(require('../storage/postgres-schema.cjs').replaceAll('pult', schema)); owned = true;
    await pool.query(require('../storage/postgres-document-schema.cjs').replaceAll('pult', schema));
    const { createStateStore } = require('../storage/postgres-state.cjs'), stateStore = createStateStore({ pool, schema });
    let catalog = fixtures(); let manager = createManagement({ stateStore, catalog: async () => catalog, clock: () => AT });
    const change = await request(manager), preview = await manager.preview(change);
    const batch = await manager.create({ ...change, title: 'SQL', reason: 'Проверка', requestId: 'sql-request-12345678', previewHash: preview.hash, acceptWarnings: true }, command(0));
    const createInput = { ...change, title: 'SQL', reason: 'Проверка', requestId: 'sql-request-12345678', previewHash: preview.hash, acceptWarnings: true };
    const submitted = await manager.transition({ id: batch.id, version: 1, status: 'submitted' }, command(1));
    const note = await manager.note({ key: '1:10', version: 0, text: 'SQL note', flag: 'attention' }, command(2));
    await manager.transition({ id: batch.id, version: 2, status: 'cancelled' }, command(3));
    catalog = [];
    assert.deepEqual(await manager.create(createInput, command(0)), batch);
    assert.deepEqual(await manager.transition({ id: batch.id, version: 1, status: 'submitted' }, command(1)), submitted);
    assert.deepEqual(await manager.note({ key: '1:10', version: 0, text: 'SQL note', flag: 'attention' }, command(2)), note);
    await assert.rejects(manager.create({ ...createInput, title: 'Changed' }, command(0)), error => error.code === 'COMMAND_ID_REUSED');
    await assert.rejects(manager.create(createInput, { ...command(0), timestamp: command(1).timestamp }), error => error.code === 'COMMAND_ID_REUSED');
    manager = createManagement({ stateStore: createStateStore({ pool, schema }), catalog: async () => catalog, clock: () => AT });
    assert.equal((await manager.state()).batches[0].id, batch.id);
    const provenance = (await pool.query(`SELECT baseline_present FROM "${schema}".source_files WHERE source_path='management.json'`)).rows[0]; assert.equal(provenance.baseline_present, false);
  } finally { if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); }
});
