'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createJsonDocumentRepository, encodeJson, JsonDocumentError } = require('../storage/postgres-json-repository.cjs');

const digest = bytes => crypto.createHash('sha256').update(bytes).digest();
const document = value => value && value.schema === 1 && Array.isArray(value.items);
function memoryStore(initial = null) {
  let current = initial;
  const commands = new Map();
  const calls = [];
  return {
    calls,
    async read(key, options) { calls.push({ action: 'read', key, options }); return current; },
    async write(key, bytes, options) {
      calls.push({ action: 'write', key, bytes, options });
      const request = JSON.stringify([key, options.expectedRevision, options.mediaType, bytes.toString('base64')]);
      const previous = commands.get(options.commandId);
      if (previous) {
        if (previous.request !== request) throw Object.assign(new Error('reused'), { code: 'COMMAND_ID_REUSED' });
        return { revision: previous.revision, replayed: true };
      }
      if ((current?.revision || '0') !== options.expectedRevision)
        throw Object.assign(new Error('conflict'), { code: 'REVISION_CONFLICT' });
      const revision = (BigInt(options.expectedRevision) + 1n).toString();
      current = { revision, deleted: false, mediaType: options.mediaType, content: bytes, sha256: digest(bytes) };
      commands.set(options.commandId, { request, revision });
      return { revision, replayed: false };
    },
    async remove(key, options) { calls.push({ action: 'remove', key, options }); return { revision: '4', replayed: false }; }
  };
}
const repository = (stateStore, overrides = {}) => createJsonDocumentRepository({ stateStore, logicalKey: 'business/example', validate: document, ...overrides });

test('fresh SQL reads distinguish absent, empty and tombstoned documents without seeding', async () => {
  const store = memoryStore();
  const first = repository(store), second = repository(store);
  assert.equal(await first.read(), null);
  assert.equal(store.calls.some(call => call.action === 'write'), false);
  await first.compareAndSet({ schema: 1, items: [] }, { expectedRevision: '0', commandId: 'request-1' });
  const a = await second.read();
  assert.deepEqual(a.value, { schema: 1, items: [] });
  a.value.items.push('local mutation');
  assert.deepEqual((await first.read()).value.items, []);
  const deleted = await repository(memoryStore({ revision: '9007199254740993', deleted: true })).read();
  assert.deepEqual(deleted, { revision: '9007199254740993', deleted: true, value: null, sha256: null });
  assert.equal(store.calls[0].options.includeDeleted, true);
});

test('same logical JSON retry is byte-identical; conflicting revision remains a conflict', async () => {
  const store = memoryStore(), repo = repository(store);
  const request = { expectedRevision: '0', commandId: 'request-1' };
  assert.deepEqual(await repo.compareAndSet({ schema: 1, items: [{ b: null, a: 0 }] }, request), { revision: '1', replayed: false });
  assert.deepEqual(await repo.compareAndSet({ items: [{ a: 0, b: null }], schema: 1 }, request), { revision: '1', replayed: true });
  await assert.rejects(repo.compareAndSet({ schema: 1, items: [] }, { ...request, commandId: 'request-2' }), error => error.code === 'REVISION_CONFLICT');
  assert.deepEqual((await repo.read()).value.items, [{ a: 0, b: null }]);
});

test('corrupt stored bytes, wrong media type, invalid UTF-8 and schema fail closed', async () => {
  const valid = Buffer.from('{"schema":1,"items":[]}');
  const inputs = [
    { content: valid, sha256: Buffer.alloc(32), mediaType: 'application/json' },
    { content: valid, sha256: digest(valid), mediaType: 'application/octet-stream' },
    ...[Buffer.from([0xff]), Buffer.from('"sensitive-value"'), Buffer.from('{broken')].map(content => ({ content, sha256: digest(content), mediaType: 'application/json' }))
  ];
  for (const input of inputs) {
    await assert.rejects(repository(memoryStore({ revision: '1', ...input })).read(), error => {
      assert.equal(error instanceof JsonDocumentError, true);
      assert.equal(error.code, 'CORRUPT_DOCUMENT');
      assert.equal(error.message.includes('sensitive'), false);
      return true;
    });
  }
});

test('write rejects JSON coercion, hidden getters, cycles and invalid domain data before persistence', async () => {
  let getterCalled = false;
  const accessor = { get schema() { getterCalled = true; return 1; }, items: [] };
  const cyclic = { schema: 1, items: [] }; cyclic.items.push(cyclic);
  const invalid = [accessor, cyclic, { schema: 1, items: [undefined] }, { schema: 1, items: [NaN] },
    { schema: 1, items: [new Date()] }, { schema: 1, items: [1n] }, { schema: 1, items: new Array(1) },
    { schema: 1, items: [], hidden: undefined }, { schema: 2, items: [] }];
  const store = memoryStore(), repo = repository(store);
  for (const value of invalid) await assert.rejects(repo.compareAndSet(value, {}), error => error.code === 'INVALID_DOCUMENT');
  assert.equal(getterCalled, false);
  assert.equal(store.calls.length, 0);
});

test('byte limit measures UTF-8 and failed validation does not leak private text', async () => {
  assert.throws(() => encodeJson('я', 3), error => error.code === 'DOCUMENT_TOO_LARGE');
  const store = memoryStore();
  await assert.rejects(repository(store, { validate() { throw Error('private text'); } }).compareAndSet({ schema: 1, items: [] }), error => !error.message.includes('private text'));
  assert.equal(store.calls.length, 0);
});

test('unknown commit outcome passes through once with the original caller command', async () => {
  const store = memoryStore();
  const uncertainty = Object.assign(new Error('unknown commit outcome'), { code: 'OUTCOME_UNKNOWN' });
  let attempts = 0;
  store.write = async (key, bytes, options) => { attempts++; assert.equal(options.commandId, 'stable-command'); throw uncertainty; };
  await assert.rejects(repository(store).compareAndSet({ schema: 1, items: [] }, { expectedRevision: '3', commandId: 'stable-command' }), error => error === uncertainty);
  assert.equal(attempts, 1);
  await repository(store).remove({ expectedRevision: '3', commandId: 'delete-command' });
  assert.deepEqual(store.calls[0].options, { expectedRevision: '3', commandId: 'delete-command', mediaType: 'application/json' });
});
