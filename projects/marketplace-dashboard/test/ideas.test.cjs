'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const createRegistry = require('../idea-registry.cjs');

function fixture(t) {
  const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pult-ideas-'));
  t.after(() => fs.rmSync(privateDir, { recursive: true, force: true }));
  let tick = 0;
  const options = { privateDir, now: () => `2026-09-18T10:00:0${tick++}.000Z` };
  return { privateDir, options, registry: createRegistry(options) };
}

test('ideas persist across module reload with optimistic versions', t => {
  const { options, registry } = fixture(t);
  const created = registry.create({ version: 0, title: '  Новая идея  ', description: ' Детали ', direction: ' Продажи ', status: 'active' });
  assert.equal(created.version, 1);
  assert.equal(created.ideas[0].title, 'Новая идея');
  assert.deepEqual(createRegistry(options).read(), created);
  assert.throws(() => registry.update({ version: 0, id: created.ideas[0].id, status: 'done' }), error => error.status === 409 && error.public === true);
  const updated = registry.update({ version: 1, id: created.ideas[0].id, description: 'Готово', status: 'done' });
  assert.equal(updated.ideas[0].status, 'done');
  assert.equal(createRegistry(options).read().ideas[0].description, 'Готово');
});

test('seed is inserted once and subsequent calls preserve edits', t => {
  const { options, registry } = fixture(t);
  const seeded = registry.seedFirstIdea();
  assert.equal(seeded.version, 1);
  assert.equal(seeded.ideas.length, 1);
  assert.equal(seeded.ideas[0].title, 'Развитие B2B у наших поставщиков');
  assert.equal(seeded.ideas[0].direction, 'Закупки');
  assert.equal(seeded.ideas[0].status, 'deferred');
  const edited = registry.update({ version: 1, id: seeded.ideas[0].id, title: 'Отредактировано', status: 'active' });
  assert.deepEqual(registry.seedFirstIdea(), edited);
  assert.deepEqual(createRegistry(options).seedFirstIdea(), edited);
});

test('seed appends once without overwriting an existing registry', t => {
  const { registry } = fixture(t);
  const created = registry.create({ version: 0, title: 'Пользовательская идея' });
  const seeded = registry.seedFirstIdea();
  assert.equal(seeded.ideas.length, 2);
  assert.equal(seeded.ideas[0].title, 'Пользовательская идея');
  assert.equal(seeded.ideas[1].title, 'Развитие B2B у наших поставщиков');
  assert.equal(seeded.version, created.version + 1);
});

test('client request UUID makes create idempotent across stale retries', t => {
  const { registry } = fixture(t);
  const clientRequestId = '41c98e13-f0b7-4dfc-96cc-d8199d0decee';
  const first = registry.create({ version: 0, title: 'Один раз', clientRequestId });
  const retried = registry.create({ version: 0, title: 'Один раз', clientRequestId });
  assert.deepEqual(retried, first);
  assert.equal(retried.ideas.length, 1);
});

test('unsafe and out-of-bounds inputs are rejected as public errors', t => {
  const { registry } = fixture(t);
  for (const input of [
    { version: 0, title: '' },
    { version: 0, title: 'x'.repeat(161) },
    { version: 0, title: 'x', description: 'x'.repeat(4001) },
    { version: 0, title: 'x', direction: 'x'.repeat(81) },
    { version: 0, title: 'x', status: 'deleted' },
    { version: 0, title: 'x', clientRequestId: '__proto__' }
  ]) assert.throws(() => registry.create(input), error => error.status === 400 && error.public === true);
  const state = registry.create({ version: 0, title: '<img src=x onerror=alert(1)>', description: '<script>alert(1)</script>' });
  assert.equal(state.ideas[0].title, '<img src=x onerror=alert(1)>');
  assert.equal(state.ideas[0].description, '<script>alert(1)</script>');
  assert.throws(() => registry.update({ version: 1, id: state.ideas[0].id, status: 'bad' }), /статус/);
  assert.throws(() => registry.update({ version: 1, id: 'f19e0d17-ed78-48cc-a882-8aef0f29d145', status: 'done' }), error => error.status === 404);
});

test('registry UI escapes stored HTML before rendering', () => {
  const vm = require('node:vm');
  const script = fs.readFileSync(path.join(__dirname, '../dist/ideas.js'), 'utf8');
  const node = () => ({ value: '', innerHTML: '', textContent: '', className: '', addEventListener() {}, querySelector() { return { disabled: false }; }, focus() {} });
  const nodes = new Map(['idea-notice', 'idea-list', 'quick-form', 'quick-title', 'quick-error', 'idea-search', 'status-filter', 'direction-filter'].map(id => [id, node()]));
  const context = vm.createContext({
    document: { getElementById: id => nodes.get(id), querySelector: () => node() },
    fetch: () => new Promise(() => {}), Date, Intl, crypto
  });
  vm.runInContext(script, context);
  assert.equal(vm.runInContext("esc('<img src=x onerror=alert(1)> & \\\"quoted\\\"')", context), '&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quoted&quot;');
});

test('corrupt storage fails safely without replacing it', t => {
  const { privateDir } = fixture(t);
  fs.writeFileSync(path.join(privateDir, 'ideas.json'), '{broken');
  assert.throws(() => createRegistry({ privateDir }), error => error.status === 500 && error.public === true);
  assert.equal(fs.readFileSync(path.join(privateDir, 'ideas.json'), 'utf8'), '{broken');
});
