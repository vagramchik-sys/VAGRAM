'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { create, validate, classify } = require('../storage/domains/postgres-product-type-registry.cjs');
const { createStateStore } = require('../storage/postgres-state.cjs');
const key = path => 'file/' + crypto.createHash('sha256').update(path).digest('hex');
const registry = () => ({ schemaVersion: 1, revision: 'types-1', reviewedAt: '2026-09-20T11:00:00Z', types: [{ id: 'mesh', parentId: null, name: 'Сетки' }, { id: 'plaster', parentId: 'mesh', name: 'Сетка штукатурная' }], assignments: { 'ozon-1:1': { typeId: 'plaster', source: 'reviewed', evidence: 'Проверено' } }, rules: [{ id: 'plaster-name', leafTypeId: 'plaster', includeAny: ['сетка штукатурная'], includeAll: [], excludeAny: [] }] });
function memory(value) { const content = value && Buffer.from(JSON.stringify(value)); return { async read(logicalKey) { if (!content || logicalKey !== key('product-type-registry.json')) return null; return { revision: '1', mediaType: 'application/json', content, sha256: crypto.createHash('sha256').update(content).digest(), deleted: false }; }, async write() { throw Error('readonly'); }, async remove() { throw Error('readonly'); } }; }
test('fresh async reads preserve reviewed assignments, rules and missing unknown state', async () => {
  const service = create({ stateStore: memory(registry()) }); assert.equal((await service.read()).revision, 'types-1'); assert.equal((await service.classify('ozon-1:1', { name: 'ignored' })).source, 'reviewed'); assert.equal((await service.classify('wb:2', { name: 'Сетка штукатурная 1×10' })).typeId, 'plaster');
  assert.equal((await create({ stateStore: memory(null) }).read()).available, false);
});
test('pure validation parity rejects parents and classification stays unresolved for weak evidence', () => {
  const value = registry(); value.assignments['ozon:bad'] = { typeId: 'mesh', source: 'reviewed' }; assert.throws(() => validate(value), /конечный тип/u); assert.equal(classify(validate(registry()), 'none', { name: '100×100 20 шт' }), null);
});
const integrationUrl = process.env.PULT_TEST_DATABASE_URL;
test('PostgreSQL registry integration reads a mapped SQL document and fails closed on corruption', { skip: !integrationUrl }, async t => {
  assert.match(decodeURIComponent(new URL(integrationUrl).pathname.slice(1)), /^pult_test_/u); const { Pool } = require('pg'), pool = new Pool({ connectionString: integrationUrl }), schema = `product_types_${crypto.randomBytes(8).toString('hex')}`; let owned = false;
  t.after(async () => { if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end(); }); await pool.query(require('../storage/postgres-schema.cjs').replace(/\bpult\b/gu, schema)); owned = true; await pool.query(require('../storage/postgres-document-schema.cjs').replace(/\bpult\b/gu, schema)); const state = createStateStore({ pool, schema });
  const repository = require('../storage/postgres-json-repository.cjs').createJsonDocumentRepository({ stateStore: state, logicalKey: key('product-type-registry.json'), sourcePath: 'product-type-registry.json', validate: value => { try { validate(value); return true; } catch { return false; } } });
  await repository.compareAndSet(registry(), { expectedRevision: '0', commandId: crypto.randomUUID() }); const service = create({ stateStore: state }); assert.equal((await service.read()).available, true); assert.equal((await service.classify('ozon-1:1', {})).typeId, 'plaster');
});
