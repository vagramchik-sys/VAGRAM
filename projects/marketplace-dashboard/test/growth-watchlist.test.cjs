'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {createGrowthWatchlist, METRICS_CURRENCY} = require('../storage/growth-watchlist.cjs');

const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const sha = value => crypto.createHash('sha256').update(value).digest();

function stateStore({unknownOnce = false} = {}) {
  const rows = new Map(), commands = new Map(); let uncertain = unknownOnce;
  return {
    rows,
    async read(key) { return rows.get(key) || null; },
    async readCommand(key, commandId) { return commands.get(`${key}:${commandId}`)?.command || null; },
    async write(key, content, options) {
      const commandKey = `${key}:${options.commandId}`, prior = commands.get(commandKey);
      const request = JSON.stringify([options.expectedRevision, options.mediaType, content.toString('base64')]);
      if (prior) {
        if (prior.request !== request) throw Object.assign(Error('reused'), {code: 'COMMAND_ID_REUSED'});
        return {revision: prior.command.after.revision, replayed: true};
      }
      const current = rows.get(key);
      if ((current?.revision || '0') !== options.expectedRevision) throw Object.assign(Error('conflict'), {code: 'REVISION_CONFLICT'});
      const revision = String(BigInt(options.expectedRevision) + 1n);
      const before = current || {revision: '0', mediaType: null, content: null, sha256: null, deleted: null};
      const after = {revision, mediaType: options.mediaType, content: Buffer.from(content), sha256: sha(content), deleted: false};
      rows.set(key, after); commands.set(commandKey, {request, command: {commandId: options.commandId, before, after}});
      if (uncertain) { uncertain = false; throw Object.assign(Error('unknown database outcome'), {code: 'OUTCOME_UNKNOWN'}); }
      return {revision, replayed: false};
    },
    async remove() { throw Error('unused'); }
  };
}

function competitor(overrides = {}) {
  return {
    id: '123456789',
    name: 'Аналог',
    url: 'https://ozon.ru/product/analog-123456789/?utm_source=test#details',
    matchStatus: 'confirmed',
    matchNotes: 'Одинаковая комплектация',
    unitCount: 2,
    source: 'ozon_seller_analytics',
    metrics: {periodFrom: '2026-09-01', periodTo: '2026-09-30', observedAt: '2026-10-01T10:00:00.000Z', averagePrice: 1250.5, minimumPrice: 999, orderedUnits: 40, drrPct: 12.5},
    ...overrides
  };
}

function fixture(options = {}) {
  const state = options.state || stateStore(), verified = [];
  const service = createGrowthWatchlist({stateStore: state, storesRepository: {async read() { return {'17': {name: 'Ozon'}, 'wb-2': {market: 'WB'}}; }}, verifyProduct: async (...args) => { verified.push(args); return options.productExists !== false; }, now: () => NOW});
  return {state, service, verified};
}

test('export contract persists a canonical, store/product-scoped watchlist', async () => {
  assert.equal(METRICS_CURRENCY, 'RUB');
  const f = fixture();
  assert.deepEqual(await f.service.read({storeId: '17', productId: '42'}), {revision: '0', competitors: []});
  const saved = await f.service.save({storeId: '17', productId: '42', expectedRevision: '0', commandId: C1, competitors: [competitor()]});
  assert.equal(saved.revision, '1'); assert.equal(saved.replayed, false);
  assert.deepEqual(saved.competitors[0], {...competitor(), url: 'https://www.ozon.ru/product/123456789/'});
  assert.deepEqual(f.verified, [['17', '42']]);
  assert.ok(f.state.rows.has('growth-watchlist/17-42'));
  assert.deepEqual(await f.service.read({storeId: '17', productId: '42'}), {revision: '1', competitors: saved.competitors});
});

test('exact replay uses canonical JSON, survives later writes, and does not verify again', async () => {
  const f = fixture(), firstInput = {storeId: '17', productId: '42', expectedRevision: '0', commandId: C1, competitors: [competitor()]};
  const first = await f.service.save(firstInput);
  await f.service.save({storeId: '17', productId: '42', expectedRevision: '1', commandId: C2, competitors: []});
  const replay = await f.service.save({...firstInput, competitors: [{...competitor(), url: 'https://www.ozon.ru/product/123456789/'}]});
  assert.deepEqual(replay, {...first, replayed: true});
  assert.equal(f.verified.length, 2);
  await assert.rejects(f.service.save({...firstInput, competitors: [competitor({name: 'Другой'})]}), {code: 'COMMAND_ID_REUSED'});
});

test('retry after an unknown commit returns the durable exact result', async () => {
  const f = fixture({state: stateStore({unknownOnce: true})}), input = {storeId: '17', productId: '42', expectedRevision: '0', commandId: C1, competitors: [competitor()]};
  await assert.rejects(f.service.save(input), {code: 'OUTCOME_UNKNOWN'});
  const replay = await f.service.save(input);
  assert.equal(replay.replayed, true); assert.equal(replay.revision, '1'); assert.equal(f.verified.length, 1);
});

test('candidate may be incomplete while confirmed matching needs notes and unit count', async () => {
  const f = fixture();
  const candidate = competitor({matchStatus: 'candidate', matchNotes: '', unitCount: null, metrics: null});
  assert.equal((await f.service.save({storeId: '17', productId: '42', expectedRevision: '0', commandId: C1, competitors: [candidate]})).competitors[0].unitCount, null);
  await assert.rejects(f.service.save({storeId: '17', productId: '43', expectedRevision: '0', commandId: C2, competitors: [competitor({matchNotes: ''})]}), {code: 'INVALID_ARGUMENT'});
});

test('scope, URL aliases, limits, metrics and product ownership fail closed', async () => {
  const foreign = competitor({id: '7', url: 'https://example.com/product/x-7/'}), credentials = competitor({id: '7', url: 'https://user:pass@ozon.ru/product/x-7/'});
  for (const row of [foreign, credentials]) await assert.rejects(fixture().service.save({storeId: '17', productId: '42', expectedRevision: '0', commandId: C1, competitors: [row]}), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(fixture().service.save({storeId: '17', productId: '42', expectedRevision: '0', commandId: C1, competitors: [competitor(), competitor({url: 'https://www.ozon.ru/product/123456789/', id: '123456789'})]}), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(fixture().service.save({storeId: '17', productId: '42', expectedRevision: '0', commandId: C1, competitors: Array.from({length: 51}, (_, index) => competitor({id: String(1000 + index), url: `https://ozon.ru/product/${1000 + index}/`}))}), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(fixture().service.save({storeId: '17', productId: '42', expectedRevision: '0', commandId: C1, competitors: [competitor({metrics: {...competitor().metrics, drrPct: -1}})]}), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(fixture().service.save({storeId: '17', productId: '42', expectedRevision: '0', commandId: C1, competitors: [competitor({metrics: {...competitor().metrics, periodFrom: '2026-99-99'}})]}), {code: 'INVALID_ARGUMENT', status: 400});
  await assert.rejects(fixture().service.read({storeId: 'no', productId: '42'}), {code: 'INVALID_ARGUMENT'});
  await assert.rejects(fixture({productExists: false}).service.save({storeId: '17', productId: '42', expectedRevision: '0', commandId: C1, competitors: []}), {code: 'NOT_FOUND'});
});

test('repository checksum and schema validation protect reads', async () => {
  const f = fixture();
  await f.service.save({storeId: '17', productId: '42', expectedRevision: '0', commandId: C1, competitors: [competitor()]});
  f.state.rows.get('growth-watchlist/17-42').content[0] ^= 1;
  await assert.rejects(f.service.read({storeId: '17', productId: '42'}), {code: 'CORRUPT_DOCUMENT'});
});
