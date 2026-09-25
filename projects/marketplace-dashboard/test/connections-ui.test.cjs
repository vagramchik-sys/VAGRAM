'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../dist/connections.js'), 'utf8');
const declarations = source.slice(0, source.indexOf('let selected='));
const context = { Intl };
vm.runInNewContext(declarations + ';globalThis.contract={ACTIVE_POLL_MS,IDLE_POLL_MS,snapshotRevision,snapshotNeedsReload,jobActive,pollDelay}', context);
const contract = context.contract;

test('connections snapshot cache is invalidated by the store revision contract', () => {
  const store = { id: '1', snapshotRevision: '27', revision: '2026-09-25T10:00:00Z:17:9' }, revision = '27|' + store.revision;
  assert.equal(contract.snapshotRevision(store), revision);
  assert.equal(contract.snapshotNeedsReload({ storeId: '1', loadedStoreId: '1', revision, loadedRevision: revision, loadedAt: 0, now: 999999 }), false);
  assert.equal(contract.snapshotNeedsReload({ storeId: '1', loadedStoreId: '1', revision: '28|' + store.revision, loadedRevision: revision, loadedAt: 0, now: 1 }), true);
  assert.equal(contract.snapshotNeedsReload({ storeId: '2', loadedStoreId: '1', revision, loadedRevision: revision, loadedAt: 0, now: 1 }), true);
  assert.equal(contract.snapshotRevision({ revision: 'legacy' }), null);
  assert.equal(contract.snapshotNeedsReload({ storeId: '1', loadedStoreId: '1', revision: null, loadedRevision: null, loadedAt: 1000, now: 45999 }), false);
  assert.equal(contract.snapshotNeedsReload({ storeId: '1', loadedStoreId: '1', revision: null, loadedRevision: null, loadedAt: 1000, now: 46000 }), true);
  assert.doesNotMatch(source, /data\?\.completedAt===s\.updatedAt/);
});

test('connections polling is fast only while an import runs and pauses while hidden', () => {
  assert.equal(contract.pollDelay([{ job: { status: 'running' } }]), 4000);
  assert.equal(contract.pollDelay([{ job: { status: 'queued' } }]), 4000);
  assert.equal(contract.jobActive({ job: { status: 'queued' } }), true);
  assert.equal(contract.pollDelay([{ job: { status: 'done' } }]), 45000);
  assert.equal(contract.pollDelay([]), 45000);
  assert.match(source, /if\(!document\.hidden\)timer=setTimeout/);
  assert.match(source, /visibilitychange/);
  assert.match(source, /if\(!document\.hidden\)void refresh\(\)/);
  assert.doesNotMatch(source, /setInterval\(refresh,4000\)/);
});
