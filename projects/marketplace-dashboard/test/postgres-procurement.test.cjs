'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const schemaSql = require('../storage/postgres-schema.cjs');
const documentSchemaSql = require('../storage/postgres-document-schema.cjs');
const { createStateStore } = require('../storage/postgres-state.cjs');
const { sourceKey } = require('../storage/postgres-document-import.cjs');
const { createPostgresProcurement } = require('../storage/domains/postgres-procurement.cjs');

const digest = bytes => crypto.createHash('sha256').update(bytes).digest();
function memoryStore() {
  let current = null, uncertain = false;
  const calls = [], commands = new Map();
  return {
    calls,
    failNextCommit() { uncertain = true; },
    async read(key) { calls.push({ action: 'read', key }); return current; },
    async readCommand(key, commandId, { operation }) {
      calls.push({ action: 'readCommand', key, commandId, operation });
      const item = commands.get(commandId);
      if (!item) return null;
      if (item.key !== key || operation !== 'write') throw Object.assign(Error('reuse'), { code: 'COMMAND_ID_REUSED' });
      return item.command;
    },
    async write(key, content, options) {
      calls.push({ action: 'write', key, content, options });
      const request = JSON.stringify([key, options.expectedRevision, options.mediaType, content.toString('base64')]), prior = commands.get(options.commandId);
      if (prior) { if (prior.request !== request) throw Object.assign(Error('reuse'), { code: 'COMMAND_ID_REUSED' }); return { revision: prior.revision, replayed: true }; }
      if ((current?.revision || '0') !== options.expectedRevision) throw Object.assign(Error('conflict'), { code: 'REVISION_CONFLICT' });
      const before = current, revision = (BigInt(options.expectedRevision) + 1n).toString();
      current = { revision, deleted: false, mediaType: options.mediaType, content: Buffer.from(content), sha256: digest(content) };
      commands.set(options.commandId, { key, request, revision, command: { commandId: options.commandId,
        before: before ? { revision: before.revision, mediaType: before.mediaType, content: before.content, sha256: before.sha256, deleted: before.deleted } : { revision: '0', mediaType: null, content: null, sha256: null, deleted: null },
        after: { ...current } } });
      if (uncertain) { uncertain = false; throw Object.assign(Error('uncertain'), { code: 'OUTCOME_UNKNOWN' }); }
      return { revision, replayed: false };
    },
    async remove() { throw Error('unused'); }
  };
}
const IDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
const command = index => ({ commandId: IDS[index], timestamp: `2026-09-18T12:00:0${index}.000Z` });

test('parser preserves legacy free-text and CSV semantics without storage access', () => {
  let sequence = 0;
  const api = createPostgresProcurement({ stateStore: memoryStore(), randomUUID: () => `item-${++sequence}` });
  const free = api.parseRequest({ text: 'Болт M8x40\nГайка DIN934 M8 20 шт\nКабель артикул: ABC-1 12,5 м' });
  assert.deepEqual(free.items.map(({ name, article, quantity, unit }) => ({ name, article, quantity, unit })), [
    { name: 'Болт M8x40', article: '', quantity: null, unit: '' },
    { name: 'Гайка DIN934 M8', article: '', quantity: 20, unit: 'шт' },
    { name: 'Кабель', article: 'ABC-1', quantity: 12.5, unit: 'м' }
  ]);
  const table = api.parseRequest({ text: 'Артикул;Наименование;Количество;Единица\nA-1;Болт;5;шт' });
  assert.deepEqual({ ...table.items[0], id: undefined }, { id: undefined, name: 'Болт', article: 'A-1', quantity: 5, unit: 'шт' });
  assert.equal(api.parseRequest.constructor.name, 'Function');
});

test('request and price writes await CAS and preserve public state and comparison results', async () => {
  const store = memoryStore(), api = createPostgresProcurement({ stateStore: store });
  assert.deepEqual(await api.read(), { schema: 1, version: 0, requests: [], priceLists: [], mode: 'local-draft' });
  const saved = await api.saveRequest({ version: 0, title: 'Заявка', items: [{ name: 'Болт', article: 'A-1', quantity: 2, unit: 'шт' }] }, command(0));
  assert.equal(saved.id, IDS[0]);
  assert.equal(saved.requests[0].id, IDS[0]);
  assert.equal(saved.requests[0].createdAt, command(0).timestamp);
  assert.match(saved.requests[0].items[0].id, /^[0-9a-f-]{36}$/u);
  const priced = await api.importPriceList({ version: 1, supplierName: 'Поставщик', sourceName: 'Прайс.csv', vatBasis: 'included', priceDate: '2026-09-01', text: 'Артикул;Наименование;Цена;Остаток;Ед.изм.;НДС\na-1;Болт;12,50;0;шт;с НДС' }, command(1));
  assert.equal(priced.id, IDS[1]);
  assert.equal(priced.priceLists[0].rows[0].price, 12.5);
  assert.equal(priced.priceLists[0].rows[0].stock, 0);
  assert.equal(priced.priceLists[0].importedAt, command(1).timestamp);
  const compared = await api.compare({ requestId: saved.id });
  assert.equal(compared.items[0].offers.length, 1);
  assert.equal(compared.items[0].offers[0].match, 'article');
  assert.equal(compared.items[0].offers[0].comparable, true);
  assert.equal(compared.items[0].offers[0].source.verification, 'user-provided-not-live-verified');
  assert.equal(store.calls.filter(call => call.action === 'write').length, 2);
  assert.equal(store.calls.find(call => call.action === 'write').key, sourceKey('procurement.json'));
  assert.equal(store.calls.find(call => call.action === 'write').options.sourceMapping.sourcePath, 'procurement.json');
});

test('unknown commit is surfaced once and the identical immediate retry resolves deterministically', async () => {
  const store = memoryStore(), api = createPostgresProcurement({ stateStore: store });
  const input = { version: 0, title: 'Заявка', items: [{ name: 'Гайка', quantity: 1, unit: 'шт' }] };
  store.failNextCommit();
  await assert.rejects(api.saveRequest(input, command(0)), error => error.code === 'OUTCOME_UNKNOWN');
  assert.equal(store.calls.filter(call => call.action === 'write').length, 1);
  const resolved = await api.saveRequest(input, command(0));
  assert.equal(resolved.id, IDS[0]);
  assert.equal(resolved.requests.length, 1);
  assert.equal(store.calls.filter(call => call.action === 'write').length, 2);
  await assert.rejects(api.saveRequest({ ...input, title: 'Другая' }, command(0)), error => error.code === 'COMMAND_ID_REUSED');
});

test('durable procurement replay survives later mutations and returns the original command result', async () => {
  const api = createPostgresProcurement({ stateStore: memoryStore() });
  const input = { version: 0, title: 'Исходная', items: [{ name: 'Болт', quantity: 1, unit: 'шт' }] };
  const original = await api.saveRequest(input, command(0));
  await api.importPriceList({ version: 1, supplierName: 'Поставщик', sourceName: 'Прайс', text: 'Наименование;Цена\nБолт;5' }, command(1));
  assert.deepEqual(await api.saveRequest(input, command(0)), original);
  await assert.rejects(api.saveRequest({ ...input, title: 'Другой payload' }, command(0)), error => error.code === 'COMMAND_ID_REUSED');
  assert.equal((await api.read()).version, 2);
});

test('invalid writes remain atomic public errors and stale versions conflict', async () => {
  const store = memoryStore(), api = createPostgresProcurement({ stateStore: store });
  for (const text of ['Наименование;Цена\nБолт;5\nГайка;', 'Наименование;Цена\n"Болт;5', 'Наименование;Цена\nБолт;-1'])
    await assert.rejects(api.importPriceList({ version: 0, supplierName: 'Поставщик', sourceName: 'Прайс', text }, command(0)), error => error.public && error.status === 400);
  assert.equal(store.calls.filter(call => call.action === 'write').length, 0);
  await api.saveRequest({ version: 0, title: 'Первая', items: [{ name: 'Болт' }] }, command(0));
  await assert.rejects(api.saveRequest({ version: 0, title: 'Устаревшая', items: [{ name: 'Гайка' }] }, command(1)), error => error.status === 409);
  assert.equal((await api.read()).requests.length, 1);
});

const integrationUrl = process.env.PULT_TEST_DATABASE_URL;
test('PostgreSQL integration: procurement state, CAS and comparison survive a new adapter instance', { skip: !integrationUrl }, async () => {
  const parsed = new URL(integrationUrl), databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  assert.match(databaseName, /test/iu);
  const { Pool } = require('pg'), pool = new Pool({ connectionString: integrationUrl, max: 2 });
  const schema = `pult_procurement_test_${crypto.randomBytes(8).toString('hex')}`;
  let owned = false;
  try {
    assert.equal((await pool.query('SELECT to_regnamespace($1)::text AS namespace', [schema])).rows[0].namespace, null);
    await pool.query(schemaSql.replaceAll('pult', schema)); owned = true;
    await pool.query(documentSchemaSql.replaceAll('pult', schema));
    const api = createPostgresProcurement({ stateStore: createStateStore({ pool, schema }) });
    const requestInput = { version: 0, title: 'SQL заявка', items: [{ name: 'Болт', article: 'A-1', quantity: 2, unit: 'шт' }] };
    const request = await api.saveRequest(requestInput, command(0));
    await api.importPriceList({ version: 1, supplierName: 'SQL поставщик', sourceName: 'list.csv', vatBasis: 'included', text: 'Артикул;Наименование;Цена;Ед.изм.\nA-1;Болт;10;шт' }, command(1));
    assert.deepEqual(await api.saveRequest(requestInput, command(0)), request);
    await assert.rejects(api.saveRequest({ ...requestInput, title: 'Другой payload' }, command(0)), error => error.code === 'COMMAND_ID_REUSED');
    const reloaded = createPostgresProcurement({ stateStore: createStateStore({ pool, schema }) });
    assert.equal((await reloaded.read()).version, 2);
    assert.equal((await reloaded.compare({ requestId: request.id })).items[0].offers[0].price, 10);
    await assert.rejects(reloaded.saveRequest({ version: 0, title: 'stale', items: [{ name: 'X' }] }, command(2)), error => error.status === 409);
  } finally {
    if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});
