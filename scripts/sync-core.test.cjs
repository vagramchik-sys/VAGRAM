'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { plan, digest, scan, safePath, allowed, secretFinding } = require('./sync-core.cjs');
test('disjoint incoming and outgoing changes stay separate', () => {
  assert.deepEqual(plan({ a: 'old', b: 'old' }, { a: 'new', b: 'old' }, { a: 'old', b: 'remote' }), { outgoing: ['a'], incoming: ['b'], conflicts: [] });
});
test('concurrent edit and delete conflicts never overwrite silently', () => {
  assert.deepEqual(plan({ a: 'old', b: 'old' }, { a: 'local' }, { a: 'remote', b: 'remote' }).conflicts, ['a', 'b']);
});
test('identical changes and Windows line endings are not conflicts', () => {
  assert.deepEqual(plan({ a: 'old' }, { a: 'same\r\n' }, { a: 'same\n' }), { outgoing: [], incoming: [], conflicts: [] });
  assert.equal(digest('a\r\nb'), digest('a\nb'));
});
test('additions and deletions are tracked in both directions', () => {
  assert.deepEqual(plan({ a: 'old', b: 'old' }, { b: 'old', c: 'new' }, { a: 'old', d: 'new' }), { outgoing: ['a', 'c'], incoming: ['b', 'd'], conflicts: [] });
});
test('private files and repository-only test copies stay outside sync', () => {
  for (const name of ['.env', '.env.local', 'data/store.json', '.private/stores.json', 'work/x.cjs', 'AGENTS.md', 'credentials.json', 'cookies.txt', 'test/server-tests.cjs']) assert.equal(allowed(name, ['test']), false, name);
  assert.equal(allowed('dist/app.js'), true);
  assert.equal(allowed('README.md'), true);
});
test('scanner excludes live stores and refuses symbolic links', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vagram-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'data')); fs.writeFileSync(path.join(root, 'data', 'store.json'), 'private'); fs.writeFileSync(path.join(root, 'app.js'), 'ok\r\n');
  assert.deepEqual(scan(root), { 'app.js': 'ok\n' });
  fs.symlinkSync(path.join(root, 'data'), path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => scan(root), /link/i);
  assert.throws(() => safePath(root, 'linked/file.js'), /Linked/);
});
test('path traversal and credential-shaped values are rejected', () => {
  for (const rel of ['../escape', '/absolute', 'a/../../escape', 'a\\b', 'a//b']) assert.throws(() => safePath(process.cwd(), rel));
  assert.equal(secretFinding('gh' + 'p_' + 'a'.repeat(36)), true);
  assert.equal(secretFinding('process.env.API_KEY'), false);
});
