'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const createWorkspace = require('../charity-workspace.cjs');
function setup(t) {
  const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pult-charity-test-'));
  t.after(() => { const target = path.resolve(privateDir); if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('pult-charity-test-')) throw Error('Unsafe cleanup'); fs.rmSync(target, { recursive: true, force: true }); });
  const args = { privateDir, now: () => '2026-09-20T12:00:00.000Z' };
  return { args, privateDir, workspace: createWorkspace(args) };
}
function record(extra = {}) { return { date: '2026-09-10', programOrRecipient: 'Тестовый фонд', amount: '10.10', currency: 'RUB', status: 'completed', sourceDocument: { label: 'Тестовый документ 1' }, externalId: '1', ...extra }; }
function batch(records, extra = {}) { return { version: 0, source: 'Синтетическая тестовая выгрузка', asOf: '2026-09-20', coverage: { from: '2026-09-01', to: '2026-09-20', complete: true }, records, ...extra }; }
test('missing history stays unknown and reads do not create files', t => {
  const { workspace, privateDir } = setup(t), data = workspace.read();
  assert.equal(data.state, 'history-not-loaded'); assert.equal(data.coverage.status, 'history-not-loaded');
  assert.deepEqual(data.records, []); assert.deepEqual(data.totalsByCurrency, []); assert.equal(data.counts, null);
  assert.equal(data.capabilities.payments, false); assert.equal(data.capabilities.externalSync, false);
  assert.deepEqual(fs.readdirSync(privateDir), []);
});
test('confirmed totals use exact decimal arithmetic, separated currencies and status buckets', t => {
  const { workspace } = setup(t);
  const result = workspace.importRecords(batch([
    record({ externalId: '1', amount: '0.10' }), record({ externalId: '2', amount: '0.20', status: 'executed' }),
    record({ externalId: '3', amount: '9.99', status: 'pending' }), record({ externalId: '4', amount: '8.88', status: 'cancelled' }), record({ externalId: '5', amount: '7.77', status: 'refunded' }),
    record({ externalId: '6', amount: '1.10', currency: 'USD' }), record({ externalId: '7', amount: '123', currency: 'JPY' }), record({ externalId: '8', amount: '1.001', currency: 'KWD' })
  ]));
  const totals = new Map(result.totalsByCurrency.map(row => [row.currency, row]));
  assert.equal(totals.get('RUB').confirmed, '0.30'); assert.equal(totals.get('RUB').completed, '0.10'); assert.equal(totals.get('RUB').executed, '0.20');
  assert.equal(totals.get('RUB').pending, '9.99'); assert.equal(totals.get('RUB').cancelled, '8.88'); assert.equal(totals.get('RUB').refunded, '7.77');
  assert.equal(totals.get('USD').confirmed, '1.10'); assert.equal(totals.get('JPY').confirmed, '123'); assert.equal(totals.get('KWD').confirmed, '1.001');
  assert.deepEqual(result.counts, { records: 8, confirmed: 5, pending: 1, cancelled: 1, refunded: 1 });
});
test('large legitimate totals do not lose integer precision', t => {
  const { workspace } = setup(t), result = workspace.importRecords(batch([record({ externalId: '1', amount: '99999999999999.99' }), record({ externalId: '2', amount: '99999999999999.99' })]));
  assert.equal(result.totalsByCurrency[0].confirmed, '199999999999999.98');
});
test('imports deduplicate stable source IDs and normalized fingerprints without mutating original input', t => {
  const { workspace, privateDir, args } = setup(t), input = batch([record({ amount: '010.1', programOrRecipient: '  Тестовый   фонд  ', externalId: undefined }), record({ amount: '10.10', programOrRecipient: 'тестовый фонд', externalId: undefined })]);
  const original = JSON.stringify(input), first = workspace.importRecords(input);
  assert.equal(JSON.stringify(input), original); assert.equal(first.importResult.inserted, 1); assert.equal(first.importResult.duplicates, 1);
  const again = workspace.importRecords({ ...input, version: first.version }); assert.equal(again.version, first.version); assert.equal(again.importResult.inserted, 0); assert.equal(again.importResult.duplicates, 2);
  const stored = JSON.parse(fs.readFileSync(path.join(privateDir, 'charity.json'), 'utf8'));
  assert.equal(stored.imports.length, 1); assert.equal(stored.imports[0].input.records[0].amount, '010.1'); assert.equal(stored.imports[0].input.records[0].programOrRecipient, '  Тестовый   фонд  ');
  assert.deepEqual(createWorkspace(args).read().records, first.records);
  first.records[0].amount = '0.00'; assert.equal(workspace.read().records[0].amount, '10.10');
});
test('conflicting stable IDs and stale versions reject the whole import without partial writes', t => {
  const { workspace, privateDir } = setup(t), first = workspace.importRecords(batch([record()]));
  const before = fs.readFileSync(path.join(privateDir, 'charity.json'), 'utf8');
  assert.throws(() => workspace.importRecords(batch([record({ externalId: 'new' })])), e => e.status === 409);
  assert.throws(() => workspace.importRecords(batch([record({ externalId: 'new' }), record({ amount: '20.20' })], { version: first.version })), e => e.status === 409);
  assert.equal(fs.readFileSync(path.join(privateDir, 'charity.json'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(privateDir, 'charity.json.lock')), false);
  const repeated = workspace.importRecords(batch([record()], { version: first.version, asOf: '2026-09-20T12:00:00Z' }));
  assert.equal(repeated.importResult.inserted, 0); assert.equal(repeated.importResult.duplicates, 1);
});
test('date, exact store and status filters constrain both records and totals', t => {
  const { workspace } = setup(t);
  workspace.importRecords(batch([record({ externalId: '1', storeId: 'shop-1' }), record({ externalId: '2', storeId: 'shop-10' }), record({ externalId: '3', storeId: 'shop-1', status: 'pending' }), record({ externalId: '4', storeId: 'shop-1', date: '2026-09-11' }), record({ externalId: '5' })]));
  const selected = workspace.read({ storeId: 'shop-1', from: '2026-09-10', to: '2026-09-10', status: 'completed' });
  assert.equal(selected.records.length, 1); assert.equal(selected.records[0].externalId, '1'); assert.equal(selected.totalsByCurrency[0].confirmed, '10.10');
  assert.equal(workspace.read({ storeId: 'missing' }).records.length, 0);
  assert.throws(() => workspace.read({ from: '2026-09-20', to: '2026-09-01' })); assert.throws(() => workspace.read({ status: 'unknown' }));
});
test('invalid records, money and unsafe documents reject complete batches', t => {
  const { workspace, privateDir } = setup(t);
  for (const bad of [
    { date: '2026-02-31' }, { date: '2026-08-31' }, { status: 'paid' }, { amount: 0.1 + 0.2 }, { amount: '0.001' }, { amount: '-1.00' }, { amount: '0' }, { amount: '1e5' }, { amount: '1.50', currency: 'JPY' }, { currency: 'XYZ' },
    { sourceDocument: { url: 'javascript:alert(1)' } }, { sourceDocument: { url: 'file:///private' } }, { sourceDocument: { url: 'https://user:password@example.com/document' } }, { sourceDocument: { url: 'https://example.com/\nsecret' } }, { sourceDocument: {} }, { unknown: 'unapproved' }
  ]) assert.throws(() => workspace.importRecords(batch([record(), record({ externalId: 'bad', ...bad })])), undefined, JSON.stringify(bad));
  assert.equal(fs.existsSync(path.join(privateDir, 'charity.json')), false); assert.equal(workspace.read().state, 'history-not-loaded');
  assert.throws(() => workspace.importRecords(batch(Array(10001).fill(record()))));
});
test('coverage distinguishes unknown, partial, gaps and declared complete loaded-source periods', t => {
  const { workspace } = setup(t);
  let result = workspace.importRecords(batch([], { coverage: { from: '2026-09-01', to: '2026-09-05', complete: true } }));
  assert.equal(result.state, 'loaded'); assert.equal(result.coverage.status, 'complete'); assert.equal(result.counts.records, 0); assert.deepEqual(result.totalsByCurrency, []);
  result = workspace.importRecords(batch([], { version: result.version, coverage: { from: '2026-09-07', to: '2026-09-10', complete: true } }));
  assert.equal(result.coverage.status, 'partial'); assert.equal(workspace.read({ from: '2026-09-07', to: '2026-09-10' }).coverage.status, 'complete');
  result = workspace.importRecords(batch([], { version: result.version, coverage: { from: '2026-09-06', to: '2026-09-06', complete: true } }));
  assert.equal(result.coverage.status, 'complete'); assert.equal(workspace.read({ from: '2026-08-01' }).coverage.status, 'partial');
  const future = workspace.read({ from: '2026-10-01' }).coverage;
  assert.equal(future.status, 'partial'); assert.equal(future.from, '2026-10-01'); assert.equal(future.to, '2026-10-01');
  assert.throws(() => workspace.importRecords(batch([], { version: result.version, coverage: { from: '2026-09-01', to: '2026-09-21', complete: true } })));
});
test('source documents are data only and unchanged storage corruption fails closed', t => {
  const { workspace, privateDir } = setup(t);
  const result = workspace.importRecords(batch([record({ sourceDocument: { url: 'https://example.test/proof', label: 'Документ' } })]));
  assert.equal(result.records[0].sourceDocument.url, 'https://example.test/proof'); assert.equal('input' in result.coverage.imports[0], false);
  const file = path.join(privateDir, 'charity.json'); fs.writeFileSync(file, '{broken');
  assert.throws(() => workspace.read(), e => e.status === 503);
  assert.throws(() => workspace.importRecords(batch([])), e => e.status === 503);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
