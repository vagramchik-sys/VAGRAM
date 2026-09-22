'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const schemaSql = require('../storage/postgres-schema.cjs');
const documentSchemaSql = require('../storage/postgres-document-schema.cjs');
const { createStateStore } = require('../storage/postgres-state.cjs');
const { sourceKey } = require('../storage/postgres-document-import.cjs');
const { createPostgresIdeas, IdeaRegistryError } = require('../storage/domains/postgres-ideas.cjs');

const digest = bytes => crypto.createHash('sha256').update(bytes).digest();
function memoryStore(initial = null) {
  let current = initial, failAfterCommit = false;
  const commands = new Map(), calls = [];
  return {
    calls,
    failNextCommit() { failAfterCommit = true; },
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
      const request = JSON.stringify([key, options.expectedRevision, content.toString('base64')]), previous = commands.get(options.commandId);
      if (previous) { if (previous.request !== request) throw Object.assign(Error('reuse'), { code: 'COMMAND_ID_REUSED' }); return { revision: previous.revision, replayed: true }; }
      if ((current?.revision || '0') !== options.expectedRevision) throw Object.assign(Error('conflict'), { code: 'REVISION_CONFLICT' });
      const before = current, revision = (BigInt(options.expectedRevision) + 1n).toString();
      current = { revision, deleted: false, mediaType: options.mediaType, content: Buffer.from(content), sha256: digest(content) };
      commands.set(options.commandId, { request, revision, key, command: { commandId: options.commandId,
        before: before ? { revision: before.revision, mediaType: before.mediaType, content: before.content, sha256: before.sha256, deleted: before.deleted } : { revision: '0', mediaType: null, content: null, sha256: null, deleted: null },
        after: { ...current } } });
      if (failAfterCommit) { failAfterCommit = false; throw Object.assign(Error('uncertain'), { code: 'OUTCOME_UNKNOWN' }); }
      return { revision, replayed: false };
    },
    async remove() { throw Error('unused'); }
  };
}
const COMMAND_1 = '11111111-1111-4111-8111-111111111111';
const COMMAND_2 = '22222222-2222-4222-8222-222222222222';
const at = seconds => ({ commandId: seconds ? COMMAND_2 : COMMAND_1, timestamp: `2026-09-18T10:00:0${seconds}.000Z` });

test('async registry preserves legacy state, validation and optimistic versions', async () => {
  const store = memoryStore(), registry = createPostgresIdeas({ stateStore: store });
  assert.deepEqual(await registry.read(), { version: 0, ideas: [] });
  const created = await registry.create({ version: 0, title: '  Новая идея  ', description: ' Детали ', direction: ' Продажи ', status: 'active' }, at(0));
  assert.equal(created.version, 1);
  assert.deepEqual(created.ideas[0], { id: COMMAND_1, title: 'Новая идея', description: 'Детали', direction: 'Продажи', status: 'active', createdAt: at(0).timestamp, updatedAt: at(0).timestamp });
  assert.equal(store.calls.find(call => call.action === 'write').key, sourceKey('ideas.json'));
  assert.equal(store.calls.find(call => call.action === 'write').options.sourceMapping.sourcePath, 'ideas.json');
  await assert.rejects(registry.update({ version: 0, id: COMMAND_1, status: 'done' }, at(1)), error => error instanceof IdeaRegistryError && error.status === 409 && error.public);
  const updated = await registry.update({ version: 1, id: COMMAND_1, description: 'Готово', status: 'done' }, at(1));
  assert.equal(updated.version, 2);
  assert.equal(updated.ideas[0].description, 'Готово');
  assert.equal(updated.ideas[0].updatedAt, at(1).timestamp);
});

test('client request and uncertain SQL commit are idempotent without a hidden retry', async () => {
  const store = memoryStore(), registry = createPostgresIdeas({ stateStore: store }), requestId = '41c98e13-f0b7-4dfc-96cc-d8199d0decee';
  store.failNextCommit();
  await assert.rejects(registry.create({ version: 0, title: 'Один раз', clientRequestId: requestId }, at(0)), error => error.code === 'OUTCOME_UNKNOWN');
  assert.equal(store.calls.filter(call => call.action === 'write').length, 1);
  const resolved = await registry.create({ version: 0, title: 'Один раз', clientRequestId: requestId }, at(0));
  assert.equal(resolved.ideas.length, 1);
  assert.equal(resolved.ideas[0].id, COMMAND_1);
  assert.equal(store.calls.filter(call => call.action === 'write').length, 2);
  assert.deepEqual(await registry.create({ version: 0, title: 'ignored after client request', clientRequestId: requestId }, at(1)), resolved);
});

test('durable command replay returns its original result after later writes and rejects changed payload', async () => {
  const registry = createPostgresIdeas({ stateStore: memoryStore() });
  const first = await registry.create({ version: 0, title: 'Первая' }, at(0));
  await registry.update({ version: 1, id: COMMAND_1, status: 'done' }, at(1));
  assert.deepEqual(await registry.create({ version: 0, title: 'Первая' }, at(0)), first);
  await assert.rejects(registry.create({ version: 0, title: 'Изменённая' }, at(0)), error => error.code === 'COMMAND_ID_REUSED');
  assert.equal((await registry.read()).version, 2);
});

test('seed is once-only and malformed inputs remain public errors', async () => {
  const registry = createPostgresIdeas({ stateStore: memoryStore() });
  const seeded = await registry.seedFirstIdea(at(0));
  assert.equal(seeded.ideas[0].title, 'Развитие B2B у наших поставщиков');
  assert.deepEqual(await registry.seedFirstIdea(), seeded);
  for (const input of [{ version: 1, title: '' }, { version: 1, title: 'x'.repeat(161) }, { version: 1, title: 'x', status: 'deleted' }])
    await assert.rejects(registry.create(input, at(1)), error => error.public && error.status === 400);
});

const integrationUrl = process.env.PULT_TEST_DATABASE_URL;
test('PostgreSQL integration: ideas CAS, journal replay resolution and exact reads', { skip: !integrationUrl }, async () => {
  const parsed = new URL(integrationUrl), databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  assert.match(databaseName, /test/iu);
  const { Pool } = require('pg'), pool = new Pool({ connectionString: integrationUrl, max: 2 });
  const schema = `pult_ideas_test_${crypto.randomBytes(8).toString('hex')}`;
  let owned = false;
  try {
    assert.equal((await pool.query('SELECT to_regnamespace($1)::text AS namespace', [schema])).rows[0].namespace, null);
    await pool.query(schemaSql.replaceAll('pult', schema)); owned = true;
    await pool.query(documentSchemaSql.replaceAll('pult', schema));
    const registry = createPostgresIdeas({ stateStore: createStateStore({ pool, schema }) });
    const first = await registry.create({ version: 0, title: 'SQL идея', status: 'active' }, at(0));
    const provenance = (await pool.query(`SELECT baseline_present,source_bytes::text AS source_bytes,source_sha256 FROM "${schema}".source_files WHERE source_path='ideas.json'`)).rows[0];
    assert.equal(provenance.baseline_present, false);
    assert.equal(provenance.source_bytes, '0');
    assert.deepEqual(provenance.source_sha256, digest(Buffer.alloc(0)));
    assert.equal(first.ideas[0].id, COMMAND_1);
    const updated = await registry.update({ version: 1, id: COMMAND_1, status: 'done' }, at(1));
    assert.deepEqual(await registry.create({ version: 0, title: 'SQL идея', status: 'active' }, at(0)), first);
    await assert.rejects(registry.create({ version: 0, title: 'Другой payload', status: 'active' }, at(0)), error => error.code === 'COMMAND_ID_REUSED');
    const second = createPostgresIdeas({ stateStore: createStateStore({ pool, schema }) });
    assert.deepEqual(await second.read(), updated);
    await assert.rejects(second.update({ version: 0, id: COMMAND_1, status: 'done' }, at(1)), error => error.status === 409);
  } finally {
    if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});
