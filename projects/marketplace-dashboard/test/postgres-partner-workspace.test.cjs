'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createLegacy = require('../partner-workspace.cjs');
const createWorkspace = require('../storage/domains/postgres-partner-workspace.cjs');
const { createStateStore } = require('../storage/postgres-state.cjs');

const command = value => ({ commandId: `${value.repeat(8)}-${value.repeat(4)}-4${value.repeat(3)}-8${value.repeat(3)}-${value.repeat(12)}`, timestamp: `2026-09-22T10:00:0${parseInt(value, 16) % 10}Z` });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest();
const protect = async (value, decrypt = false) => decrypt ? Buffer.from(String(value).slice(6), 'base64').toString('utf8') : 'dpapi:' + Buffer.from(value).toString('base64');
function memoryState({ unknownCommand = null } = {}) {
  const records = new Map(), commands = new Map(); let unknown = unknownCommand;
  const absent = () => ({ revision: '0', mediaType: null, content: null, sha256: null, deleted: null });
  return { records, async read(key) { return records.get(key) || null; }, async readCommand(key, id) { const item = commands.get(id); if (item && item.key !== key) throw Object.assign(Error('reuse'), { code: 'COMMAND_ID_REUSED' }); return item || null; }, async write(key, content, options) {
    const prior = commands.get(options.commandId);
    if (prior) { if (prior.key !== key || prior.before.revision !== options.expectedRevision || !prior.after.content.equals(content)) throw Object.assign(Error('reuse'), { code: 'COMMAND_ID_REUSED' }); return { revision: prior.after.revision, replayed: true }; }
    const current = records.get(key); if ((current?.revision || '0') !== options.expectedRevision) throw Object.assign(Error('conflict'), { code: 'REVISION_CONFLICT' });
    const before = current ? { ...current, content: current.content && Buffer.from(current.content), sha256: current.sha256 && Buffer.from(current.sha256) } : absent();
    const after = { revision: String(BigInt(options.expectedRevision) + 1n), mediaType: options.mediaType, content: Buffer.from(content), sha256: hash(content), deleted: false };
    records.set(key, after); commands.set(options.commandId, { key, commandId: options.commandId, before, after });
    if (unknown === options.commandId) { unknown = null; throw Object.assign(Error('hidden'), { code: 'OUTCOME_UNKNOWN' }); }
    return { revision: after.revision, replayed: false };
  }, async remove() { throw Error('unused'); } };
}
const products = () => [{ key: 'a:1', market: 'Ozon', name: 'Первый', quantity: 12, salesStatus: 'Продаётся', offer_id: 'A', sku: 1, storeName: 'A', clientId: 'PRIVATE', cost: { unitCost: 123 }, ownerMargin: 555 }, { key: 'b:2', market: 'Ozon', name: 'Второй', quantity: null, offer_id: 'B', storeName: 'B', apiKey: 'PRIVATE-KEY' }, { key: 'wb:3', market: 'WB', name: 'WB' }];
const create = (stateStore, overrides = {}) => createWorkspace({ stateStore, getProducts: async () => products(), protect, now: () => Date.parse('2026-09-22T12:00:00Z'), ...overrides });
const sourceKeyFor = value => 'file/' + crypto.createHash('sha256').update(value).digest('hex');
function putJson(state, sourcePath, value, revision = '1') { const content = Buffer.from(JSON.stringify(value)); state.records.set(sourceKeyFor(sourcePath), { revision, mediaType: 'application/json', content, sha256: hash(content), deleted: false }); }

test('async owner and partner projections preserve legacy rights and redact owner finance', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'partner-parity-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const legacy = createLegacy({ privateDir: dir, getProducts: products, now: () => Date.parse('2026-09-22T12:00:00Z') });
  const lp = legacy.savePartner({ name: 'A', productKeys: ['a:1'], active: true });
  const state = memoryState(), sql = create(state), p = await sql.savePartner({ name: 'A', productKeys: ['a:1'], active: true }, command('1'));
  const actual = await sql.snapshotForPartner(p.id), expected = legacy.snapshotForPartner(lp.id);
  assert.deepEqual(actual.products, expected.products); assert.deepEqual(actual.commercialModel, expected.commercialModel); assert.deepEqual(actual.capabilities, expected.capabilities);
  const serialized = JSON.stringify({ owner: await sql.ownerState(), partner: actual });
  for (const secret of ['PRIVATE', 'PRIVATE-KEY', 'unitCost', 'ownerMargin', 'credentialHash', 'credentialReceipt']) assert.equal(serialized.includes(secret), false);
});

test('fresh authentication and optional session version close rotation and revocation', async () => {
  const state = memoryState(), a = create(state), b = create(state);
  let p = await a.savePartner({ name: 'A', productKeys: ['a:1'], active: true }, command('2'));
  const issued = await a.issueCredential({ id: p.id, version: p.version }, command('3')), session = await b.authenticateCredential(issued.credential);
  assert.equal(await a.authorizeSession(session), true); assert.equal((await b.snapshotForPartner(p.id, session)).partner.id, p.id);
  p = await b.revokeCredential({ id: p.id, version: issued.partner.version }, command('4'));
  assert.equal(await a.authenticateCredential(issued.credential), null); assert.equal(await a.authorizeSession(session), false);
  await assert.rejects(a.snapshotForPartner(p.id, session), error => error.status === 401);
});

test('credential SQL contains no plaintext and unknown commit retry decrypts one durable receipt', async () => {
  const issue = command('6'), state = memoryState({ unknownCommand: issue.commandId }), service = create(state);
  const p = await service.savePartner({ name: 'A', productKeys: ['a:1'], active: true }, command('5'));
  await assert.rejects(service.issueCredential({ id: p.id, version: p.version }, issue), error => error.code === 'OUTCOME_UNKNOWN');
  const stored = [...state.records.values()].find(record => record.content.toString().includes(p.id)), raw = stored.content.toString('utf8');
  const parsed = JSON.parse(raw), persisted = parsed.partners[0]; assert.equal(typeof persisted.credentialReceipt, 'string');
  const replay = await service.issueCredential({ id: p.id, version: p.version }, issue);
  assert.equal(raw.includes(replay.credential), false); assert.equal(persisted.credentialHash, crypto.createHash('sha256').update(replay.credential).digest('hex'));
  assert.equal(JSON.stringify(replay).includes('credentialReceipt'), false); assert.equal(JSON.stringify(replay).includes('credentialHash'), false);
  await assert.rejects(service.issueCredential({ id: p.id, version: p.version + 1 }, issue), error => error.code === 'COMMAND_ID_REUSED');
  await assert.rejects(service.issueCredential({ id: p.id, version: p.version }, { ...issue, timestamp: '2026-09-22T11:00:00Z' }), error => error.code === 'COMMAND_ID_REUSED');
});

test('save replay is exact after later changes and stale CAS fails', async () => {
  const state = memoryState(), a = create(state), b = create(state), input = { name: 'A', productKeys: [] }, first = await a.savePartner(input, command('7'));
  await b.savePartner({ id: first.id, version: first.version, name: 'B', productKeys: [] }, command('8'));
  assert.deepEqual(await a.savePartner(input, command('7')), first);
  await assert.rejects(a.savePartner({ ...input, name: 'changed' }, command('7')), error => error.code === 'COMMAND_ID_REUSED');
  const current = (await a.ownerState()).partners[0];
  const settled = await Promise.allSettled([a.savePartner({ id: current.id, version: current.version, name: 'C', productKeys: [] }, command('9')), b.savePartner({ id: current.id, version: current.version, name: 'D', productKeys: [] }, command('a'))]);
  assert.equal(settled.filter(x => x.status === 'fulfilled').length, 1); assert.equal(settled.find(x => x.status === 'rejected').reason.status, 409);
});

test('snapshot rechecks authorization after awaited providers and closes assignment race', async () => {
  const state = memoryState(); let entered, release; const waiting = new Promise(resolve => { entered = resolve; });
  const service = create(state, { getProducts: async () => { entered(); await new Promise(resolve => { release = resolve; }); return products(); } });
  const fast = create(state), p = await fast.savePartner({ name: 'A', productKeys: ['a:1'], active: true }, command('b'));
  const snapshot = service.snapshotForPartner(p.id); await waiting;
  await fast.savePartner({ id: p.id, version: p.version, name: 'A', productKeys: [], active: false }, command('c')); release();
  await assert.rejects(snapshot, error => error.status === 409);
});

test('sales remain unknown and corrupt SQL fails closed', async () => {
  const state = memoryState(), service = create(state, { getSales: async () => [{ productKey: 'a:1', sold: 8, privateRevenue: 999 }] });
  const p = await service.savePartner({ name: 'A', productKeys: ['a:1'], active: true }, command('d'));
  const snapshot = await service.snapshotForPartner(p.id); assert.equal(snapshot.products[0].sales.sold, null); assert.equal(JSON.stringify(snapshot).includes('999'), false);
  const [key, record] = [...state.records.entries()][0]; state.records.set(key, { ...record, content: Buffer.from('{broken'), sha256: hash(Buffer.from('{broken')) });
  await assert.rejects(service.ownerState(), error => error.status === 503);
  await assert.rejects(service.authenticateCredential('x'.repeat(43)), error => error.status === 503);
});

test('commercial terms accept source metadata, use a separate SQL document and stay owner-only', async () => {
  const state = memoryState(); putJson(state, 'partner-commercial-model.json', { ourCommissionPercent: 17.25, partnerCommissionPercent: 21.75, updatedAt: '2026-09-22T11:00:00Z', source: { kind: 'owner' } });
  const service = create(state), p = await service.savePartner({ name: 'A', productKeys: ['a:1'], active: true }, command('e'));
  const owner = await service.ownerState(), snapshot = await service.snapshotForPartner(p.id), serialized = JSON.stringify(snapshot);
  assert.equal(owner.commercialModel.ourCommissionPercent, 17.25); assert.equal(owner.commercialModel.targetDifferencePercentagePoints, 4.5);
  assert.equal(snapshot.commercialModel.contractCommissionPercent, 21.75);
  for (const forbidden of ['ourCommissionPercent', 'partnerCommissionPercent', 'targetDifferencePercentagePoints', '17.25', '4.5']) assert.equal(serialized.includes(forbidden), false);
});

const integrationUrl = process.env.PULT_TEST_DATABASE_URL;
test('PostgreSQL integration: mappings, credential replay, restart and revocation', { skip: !integrationUrl }, async t => {
  const parsed = new URL(integrationUrl), databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, '')); assert.match(databaseName, /^pult_test_[a-z0-9]+$/u);
  const { Pool } = require('pg'), pool = new Pool({ connectionString: integrationUrl, max: 5 }); const schema = `partner_workspace_test_${crypto.randomBytes(8).toString('hex')}`; let owned = false;
  t.after(async () => { if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); });
  assert.equal((await pool.query('SELECT to_regnamespace($1)::text AS namespace', [schema])).rows[0].namespace, null);
  await pool.query(require('../storage/postgres-schema.cjs').replace(/\bpult\b/gu, schema)); owned = true; await pool.query(require('../storage/postgres-document-schema.cjs').replace(/\bpult\b/gu, schema));
  const state = createStateStore({ pool, schema }), first = create(state), p = await first.savePartner({ name: 'A', productKeys: ['a:1'], active: true }, command('1'));
  const issued = await first.issueCredential({ id: p.id, version: p.version }, command('2')), restarted = create(state);
  assert.equal((await restarted.authenticateCredential(issued.credential)).partnerId, p.id);
  const replay = await restarted.issueCredential({ id: p.id, version: p.version }, command('2')); assert.equal(replay.credential, issued.credential);
  await restarted.revokeCredential({ id: p.id, version: issued.partner.version }, command('3')); assert.equal(await first.authenticateCredential(issued.credential), null);
  const row = await pool.query(`SELECT content FROM "${schema}".document_states WHERE logical_key=$1`, [sourceKeyFor('partner-workspace.json')]);
  assert.equal(Buffer.from(row.rows[0].content).includes(Buffer.from(issued.credential)), false);
  const mappings = await pool.query(`SELECT source_path FROM "${schema}".source_files ORDER BY source_path`); assert.deepEqual(mappings.rows, [{ source_path: 'partner-workspace.json' }]);
});
