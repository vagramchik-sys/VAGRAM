'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {createOzonAdControl, campaignShape, actionShape, scheduleActive} = require('../storage/ozon-ad-control.cjs');

function fixture() {
  const documents = new Map(), calls = [];
  let time = Date.parse('2026-10-01T09:00:00Z');
  const raw = {id: '7', title: 'Campaign', state: 'CAMPAIGN_STATE_RUNNING', PaymentType: 'CPC', advObjectType: 'SKU', budgetType: 'PRODUCT_CAMPAIGN_BUDGET_TYPE_WEEKLY', weeklyBudget: '1000000000', updatedAt: '2026-10-01T08:00:00Z'};
  const stateStore = {
    async read(key) { const value = documents.get(key); return value ? {...value, content: Buffer.from(value.content)} : null; },
    async list({prefix}) { return [...documents].filter(([key]) => key.startsWith(prefix)).map(([logicalKey, value]) => ({logicalKey, ...value})); },
    async write(key, content, {expectedRevision, mediaType}) {
      const current = documents.get(key);
      if (String(current?.revision || '0') !== expectedRevision) throw Object.assign(Error('CAS'), {code: 'REVISION_CONFLICT'});
      const value = {revision: String(BigInt(expectedRevision) + 1n), content: Buffer.from(content), mediaType};
      documents.set(key, value); return {revision: value.revision};
    }
  };
  const transport = {
    capabilities: {budgetWrite: true, stateWrite: true, bidWrite: false},
    async listCampaigns() { calls.push('read'); return [structuredClone(raw)]; },
    async listCampaignProducts() { return [{sku: '101', title: 'Product', bid: '12000000', secret: 'not-public'}]; },
    async updateWeeklyBudget(store, campaign, value) { assertPending(); calls.push(['budget', value]); raw.weeklyBudget = String(Math.round(value * 1e6)); },
    async setCampaignActive(store, campaign, value) { assertPending(); calls.push(['state', value]); raw.state = value ? 'CAMPAIGN_STATE_RUNNING' : 'CAMPAIGN_STATE_INACTIVE'; }
  };
  function assertPending() { const value = JSON.parse(documents.get('adcontrol/1-7').content); assert.ok(value.pending, 'durable pending must precede external mutation'); }
  const storesRepository = {read: async () => ({1: {name: 'Store', key: 'secret'}, 'wb-2': {name: 'WB', market: 'WB'}})};
  const make = () => createOzonAdControl({stateStore, transport, storesRepository, now: () => time});
  return {control: make(), make, documents, raw, transport, stateStore, calls, setTime: value => { time = Date.parse(value); }, state: () => JSON.parse(documents.get('adcontrol/1-7').content)};
}
const preview = (f, action) => f.control.preview({storeId: '1', campaignId: '7', action, exclusiveControl: true});
const apply = (f, plan, commandId = crypto.randomUUID()) => f.control.apply({token: plan.token, commandId});
const schedule = (enabled = true) => ({kind: 'schedule', enabled, days: [1, 2, 3, 4, 5], start: '09:00', end: '21:00', timezone: 'Europe/Moscow'});
const writes = f => f.calls.filter(Array.isArray);

test('reads and preview expose safe fields and never mutate Ozon', async () => {
  const f = fixture();
  const overview = await f.control.overview();
  assert.deepEqual(overview.stores, [{id: '1', name: 'Store'}]);
  const detail = await f.control.campaign({storeId: '1', campaignId: '7'});
  assert.equal(detail.campaign.weeklyBudgetRub, 1000);
  assert.equal(detail.products[0].currentBid, null);
  assert.equal(detail.schedule.enabled, false);
  assert.equal(JSON.stringify(detail).includes('secret'), false);
  const plan = await preview(f, {kind: 'budget', weeklyBudgetRub: 1200});
  assert.ok(plan.token); assert.equal(plan.blockedReason, null);
  assert.deepEqual(plan.changes, [{label: 'Недельный бюджет, ₽', before: 1000, after: 1200}]);
  assert.equal(writes(f).length, 0);
});

test('budget apply reserves durable state and replays without another write across restart', async () => {
  const f = fixture(), plan = await preview(f, {kind: 'budget', weeklyBudgetRub: 1200}), commandId = crypto.randomUUID();
  assert.equal((await apply(f, plan, commandId)).status, 'applied');
  assert.equal(f.raw.weeklyBudget, '1200000000'); assert.equal(f.state().pending, null);
  f.control = f.make(); f.setTime('2026-10-03T09:00:00Z');
  assert.equal((await apply(f, plan, commandId)).replayed, true);
  assert.equal(writes(f).length, 1);
  const second = await preview(f, {kind: 'budget', weeklyBudgetRub: 1300});
  await assert.rejects(apply(f, second, commandId), {code: 'COMMAND_ID_REUSED'});
});

test('expired, replaced and remotely changed previews cannot write', async () => {
  const f = fixture();
  let plan = await preview(f, {kind: 'budget', weeklyBudgetRub: 1200});
  f.setTime('2026-10-01T09:03:00Z');
  await assert.rejects(apply(f, plan), {code: 'PREVIEW_STALE'});
  plan = await preview(f, {kind: 'budget', weeklyBudgetRub: 1200});
  await preview(f, {kind: 'budget', weeklyBudgetRub: 1300});
  await assert.rejects(apply(f, plan), {code: 'PREVIEW_STALE'});
  plan = await preview(f, {kind: 'budget', weeklyBudgetRub: 1200});
  f.raw.weeklyBudget = '1500000000';
  await assert.rejects(apply(f, plan), {code: 'PREVIEW_STALE'});
  assert.equal(writes(f).length, 0);
});

test('unknown outcome remains durable and blocks replay/new writes/scheduler until exact reconciliation', async () => {
  const f = fixture();
  await apply(f, await preview(f, schedule()));
  f.transport.updateWeeklyBudget = async () => { f.calls.push(['uncertain']); throw Object.assign(Error('secret transport detail'), {code: 'WRITE_OUTCOME_UNKNOWN'}); };
  const plan = await preview(f, {kind: 'budget', weeklyBudgetRub: 1200}), commandId = crypto.randomUUID();
  await assert.rejects(apply(f, plan, commandId), {code: 'OUTCOME_UNKNOWN'});
  assert.ok(f.state().pending); f.control = f.make();
  await assert.rejects(apply(f, plan, commandId), {code: 'OUTCOME_UNKNOWN'});
  assert.match((await preview(f, {kind: 'budget', weeklyBudgetRub: 1300})).blockedReason, /неизвестен/);
  f.setTime('2026-10-01T20:00:00Z'); await f.control.tick();
  assert.equal(writes(f).length, 1);
  assert.equal((await f.control.reconcile({storeId: '1', campaignId: '7'})).status, 'unknown');
  f.raw.weeklyBudget = '1200000000';
  assert.equal((await f.control.reconcile({storeId: '1', campaignId: '7'})).status, 'applied');
  assert.equal(f.state().pending, null);
  assert.equal((await apply(f, plan, commandId)).replayed, true);
  assert.equal(writes(f).length, 1);
});

test('explicit rejection clears pending but unexpected failures never authorize retry', async () => {
  for (const code of ['MUTATION_REJECTED', 'MUTATION_NOT_SENT']) {
    const f = fixture(); f.transport.updateWeeklyBudget = async () => { throw Object.assign(Error(), {code}); };
    assert.equal((await apply(f, await preview(f, {kind: 'budget', weeklyBudgetRub: 1200}))).status, 'rejected');
    assert.equal(f.state().pending, null);
  }
  const f = fixture(); f.transport.updateWeeklyBudget = async () => { throw Error('secret'); };
  await assert.rejects(apply(f, await preview(f, {kind: 'budget', weeklyBudgetRub: 1200})), {code: 'OUTCOME_UNKNOWN'});
  assert.ok(f.state().pending);
});

test('bid writes, budget-mode switching, unsafe states and absent exclusive control fail closed', async () => {
  const f = fixture();
  assert.match((await preview(f, {kind: 'bid', sku: '101', bidRub: 10})).blockedReason, /стоп-фраз/);
  f.raw.weeklyBudget = '0';
  assert.ok((await preview(f, {kind: 'budget', weeklyBudgetRub: 1200})).blockedReason);
  f.raw.weeklyBudget = '1000000000'; f.raw.budgetType = 'PRODUCT_CAMPAIGN_BUDGET_TYPE_DAILY';
  assert.ok((await preview(f, {kind: 'budget', weeklyBudgetRub: 1200})).blockedReason);
  for (const state of ['CAMPAIGN_STATE_STOPPED', 'CAMPAIGN_STATE_FINISHED', 'CAMPAIGN_STATE_ARCHIVED', 'CAMPAIGN_STATE_PLANNED', 'unknown']) {
    f.raw.state = state;
    assert.ok((await preview(f, {kind: 'state', active: true})).blockedReason);
    assert.equal(campaignShape(f.raw).active, null);
  }
  await assert.rejects(f.control.preview({storeId: '1', campaignId: '7', action: schedule(), exclusiveControl: false}), {code: 'EXCLUSIVE_CONTROL_REQUIRED'});
  assert.equal(writes(f).length, 0);
});

test('disabled and initially paused schedules never start campaigns', async () => {
  const f = fixture();
  await apply(f, await preview(f, schedule(false))); await f.control.tick(); assert.equal(writes(f).length, 0);
  f.raw.state = 'CAMPAIGN_STATE_INACTIVE';
  await apply(f, await preview(f, schedule()));
  f.control = f.make(); await f.control.tick(); assert.equal(writes(f).length, 0);
});

test('schedule stops outside window and resumes only its own unchanged stop', async () => {
  const f = fixture(); await apply(f, await preview(f, schedule()));
  f.setTime('2026-10-01T18:00:00Z'); // exactly 21:00 Moscow, excluded
  await f.control.tick(); assert.deepEqual(writes(f), [['state', false]]); assert.equal(f.state().schedule.resumeAllowed, true);
  f.control = f.make(); f.setTime('2026-10-02T06:00:00Z');
  await f.control.tick(); assert.deepEqual(writes(f), [['state', false], ['state', true]]); assert.equal(f.state().schedule.resumeAllowed, false);
  f.setTime('2026-10-02T18:00:00Z'); await f.control.tick();
  f.raw.updatedAt = '2026-10-03T06:00:00Z'; f.setTime('2026-10-05T06:00:00Z');
  await f.control.tick(); assert.equal(writes(f).length, 3);
});

test('schedule never resumes exhausted or archived campaigns after its own stop', async () => {
  for (const status of ['CAMPAIGN_STATE_STOPPED', 'CAMPAIGN_STATE_FINISHED', 'CAMPAIGN_STATE_ARCHIVED']) {
    const f = fixture(); await apply(f, await preview(f, schedule()));
    f.setTime('2026-10-01T18:00:00Z'); await f.control.tick();
    f.raw.state = status; f.setTime('2026-10-02T06:00:00Z'); await f.control.tick();
    assert.deepEqual(writes(f), [['state', false]]);
  }
});

test('schedule validates Moscow weekday boundaries and rejects cross-midnight inputs', () => {
  const rule = schedule();
  assert.equal(scheduleActive(rule, Date.parse('2026-10-02T05:59:00Z')), false);
  assert.equal(scheduleActive(rule, Date.parse('2026-10-02T06:00:00Z')), true);
  assert.equal(scheduleActive(rule, Date.parse('2026-10-03T09:00:00Z')), false);
  for (const patch of [{start: '22:00', end: '06:00'}, {start: '09:00', end: '09:00'}, {days: [0]}, {days: [1, 1]}, {timezone: 'UTC'}, {start: '24:00'}, {enabled: 'true'}]) assert.throws(() => actionShape({...rule, ...patch}), {code: 'INVALID_ARGUMENT'});
});

test('concurrent ticks do not overlap or issue duplicate transitions', async () => {
  const f = fixture(); await apply(f, await preview(f, schedule())); f.setTime('2026-10-01T18:00:00Z');
  await Promise.all([f.control.tick(), f.control.tick(), f.control.tick()]);
  assert.deepEqual(writes(f), [['state', false]]);
});

test('cross-instance CAS permits at most one external write for a preview', async () => {
  const f = fixture(), plan = await preview(f, {kind: 'budget', weeklyBudgetRub: 1200}), other = f.make();
  const outcomes = await Promise.allSettled([apply(f, plan), other.apply({token: plan.token, commandId: crypto.randomUUID()})]);
  assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(writes(f).length, 1);
});

test('expiry is checked again after a slow fresh read', async () => {
  const f = fixture(), plan = await preview(f, {kind: 'budget', weeklyBudgetRub: 1200});
  const read = f.transport.listCampaigns;
  f.transport.listCampaigns = async (...args) => { f.setTime('2026-10-01T09:03:00Z'); return read(...args); };
  await assert.rejects(apply(f, plan), {code: 'PREVIEW_STALE'});
  assert.equal(writes(f).length, 0);
});

test('close waits for in-flight external mutation and blocks new work', async () => {
  const f = fixture(), plan = await preview(f, {kind: 'budget', weeklyBudgetRub: 1200});
  let release, reached;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { reached = resolve; });
  const update = f.transport.updateWeeklyBudget;
  f.transport.updateWeeklyBudget = async (...args) => { reached(); await waiting; return update(...args); };
  const applying = apply(f, plan); await started;
  let finished = false;
  const closing = f.control.close().then(() => { finished = true; });
  await Promise.resolve(); assert.equal(finished, false);
  await assert.rejects(preview(f, {kind: 'budget', weeklyBudgetRub: 1300}), {code: 'CONTROL_CLOSING'});
  release(); await applying; await closing; assert.equal(finished, true);
});

test('receipt audit stays bounded while old command identity remains replayable', async () => {
  const f = fixture(); let first;
  for (let i = 0; i < 53; i++) {
    const plan = await preview(f, schedule(i % 2 === 0)), commandId = crypto.randomUUID();
    await apply(f, plan, commandId);
    if (!first) first = {plan, commandId};
  }
  assert.equal(f.state().audit.length, 50);
  f.control = f.make();
  assert.equal((await apply(f, first.plan, first.commandId)).replayed, true);
  assert.equal(writes(f).length, 0);
});

test('replay finalizes a durable applied receipt after a crash before campaign commit', async () => {
  for (const action of [{kind: 'budget', weeklyBudgetRub: 1200}, schedule()]) {
    const f = fixture(), plan = await preview(f, action), commandId = crypto.randomUUID();
    const write = f.stateStore.write;
    let crash = true;
    f.stateStore.write = async (key, content, options) => {
      const value = JSON.parse(content);
      if (crash && key === 'adcontrol/1-7' && value.pending === null) { crash = false; throw Object.assign(Error('lost commit'), {code: 'OUTCOME_UNKNOWN'}); }
      return write(key, content, options);
    };
    await assert.rejects(apply(f, plan, commandId), {code: 'OUTCOME_UNKNOWN'});
    assert.ok(f.state().pending);
    assert.equal(JSON.parse(f.documents.get('adcontrol-command/' + commandId).content).status, 'applied');
    f.control = f.make();
    const externalBefore = writes(f).length;
    assert.equal((await apply(f, plan, commandId)).replayed, true);
    assert.equal(f.state().pending, null);
    assert.equal(f.state().audit.length, 1);
    if (action.kind === 'schedule') assert.equal(f.state().schedule.enabled, true);
    assert.equal(writes(f).length, externalBefore);
    await apply(f, plan, commandId); assert.equal(f.state().audit.length, 1);
  }
});

test('products failure does not hide campaign control or audit and does not leak upstream errors', async () => {
  const f = fixture(); f.transport.listCampaignProducts = async () => { throw Error('private-token'); };
  const detail = await f.control.campaign({storeId: '1', campaignId: '7'});
  assert.equal(detail.campaign.title, 'Campaign'); assert.equal(detail.campaign.paymentType, 'CPC');
  assert.deepEqual(detail.products, []); assert.ok(detail.productsError);
  assert.equal(JSON.stringify(detail).includes('private-token'), false);
});

test('scheduler publishes sanitized auth failure and later successful check', async () => {
  const f = fixture(); await apply(f, await preview(f, schedule()));
  const read = f.transport.listCampaigns;
  f.transport.listCampaigns = async () => { throw Object.assign(Error('private-token'), {code: 'AUTH_FAILED'}); };
  await f.control.tick();
  const failed = (await f.control.overview()).scheduler;
  assert.equal(failed.errors, 1); assert.equal(failed.lastErrorCode, 'AUTH_FAILED'); assert.ok(failed.lastCheckedAt);
  assert.equal(JSON.stringify(failed).includes('private-token'), false);
  f.transport.listCampaigns = read; await f.control.tick();
  assert.equal((await f.control.overview()).scheduler.lastErrorCode, null);
});

test('budget transport upper bound is enforced before preview', () => {
  assert.throws(() => actionShape({kind: 'budget', weeklyBudgetRub: 100000000.01}), {code: 'INVALID_ARGUMENT'});
  assert.equal(actionShape({kind: 'budget', weeklyBudgetRub: 100000000}).weeklyBudgetRub, 100000000);
});

test('already-observed budget and state are no-ops with durable receipts and no external writes', async () => {
  const f = fixture();
  for (const action of [{kind: 'budget', weeklyBudgetRub: 1000}, {kind: 'state', active: true}]) {
    const plan = await preview(f, action), commandId = crypto.randomUUID();
    assert.equal((await apply(f, plan, commandId)).status, 'applied');
    assert.equal((await apply(f, plan, commandId)).replayed, true);
  }
  assert.equal(writes(f).length, 0);
});

test('another service cannot reconcile a live dispatch even after its persisted timeout', async () => {
  const f = fixture(), plan = await preview(f, {kind: 'budget', weeklyBudgetRub: 1200});
  let release, entered;
  const wait = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  f.transport.updateWeeklyBudget = async () => { f.calls.push(['budget', 1200]); f.raw.weeklyBudget = '1200000000'; entered(); await wait; };
  const applying = apply(f, plan); await started;
  const other = f.make();
  f.setTime('2026-10-01T09:05:00Z');
  assert.equal((await other.reconcile({storeId: '1', campaignId: '7'})).status, 'unknown');
  assert.ok(f.state().pending);
  assert.ok((await other.preview({storeId: '1', campaignId: '7', action: {kind: 'budget', weeklyBudgetRub: 1300}, exclusiveControl: true})).blockedReason);
  release(); assert.equal((await applying).status, 'applied');
  assert.equal(writes(f).length, 1);
});

test('crashed dispatch retains a persisted settle gate before restart reconciliation', async () => {
  const f = fixture(), plan = await preview(f, {kind: 'budget', weeklyBudgetRub: 1200});
  const write = f.stateStore.write;
  f.stateStore.write = async (key, content, options) => {
    if (JSON.parse(content).status === 'unknown') throw Error('simulate crash before settled marker');
    return write(key, content, options);
  };
  f.transport.updateWeeklyBudget = async () => { f.raw.weeklyBudget = '1200000000'; throw Object.assign(Error(), {code: 'WRITE_OUTCOME_UNKNOWN'}); };
  await assert.rejects(apply(f, plan), {code: 'OUTCOME_UNKNOWN'});
  f.control = f.make();
  assert.equal((await f.control.reconcile({storeId: '1', campaignId: '7'})).status, 'unknown');
  assert.ok(f.state().pending);
  f.setTime('2026-10-01T09:03:00Z');
  assert.equal((await f.control.reconcile({storeId: '1', campaignId: '7'})).status, 'applied');
  assert.equal(f.state().pending, null);
});

test('observing a running campaign revokes ownership before early return and later manual stop never resumes', async () => {
  const f = fixture(); await apply(f, await preview(f, schedule()));
  f.setTime('2026-10-01T18:00:00Z'); await f.control.tick(); assert.equal(f.state().schedule.resumeAllowed, true);
  f.raw.state = 'CAMPAIGN_STATE_RUNNING'; f.setTime('2026-10-02T06:00:00Z'); await f.control.tick();
  assert.equal(f.state().schedule.resumeAllowed, false);
  f.control = f.make(); f.raw.state = 'CAMPAIGN_STATE_INACTIVE'; await f.control.tick();
  assert.deepEqual(writes(f), [['state', false]]);
});

test('missing pause update identity never permits automatic resume', async () => {
  const f = fixture(); delete f.raw.updatedAt;
  await apply(f, await preview(f, schedule()));
  f.setTime('2026-10-01T18:00:00Z'); await f.control.tick(); assert.equal(f.state().schedule.resumeAllowed, false);
  f.setTime('2026-10-02T06:00:00Z'); await f.control.tick();
  assert.deepEqual(writes(f), [['state', false]]);
});

test('a returned write timeout still requires settle delay before matching-target reconciliation', async () => {
  const f = fixture(), plan = await preview(f, {kind: 'budget', weeklyBudgetRub: 1200});
  f.transport.updateWeeklyBudget = async () => { f.raw.weeklyBudget = '1200000000'; throw Object.assign(Error(), {code: 'WRITE_OUTCOME_UNKNOWN'}); };
  await assert.rejects(apply(f, plan), {code: 'OUTCOME_UNKNOWN'});
  const waiting = await f.control.reconcile({storeId: '1', campaignId: '7'});
  assert.equal(waiting.status, 'unknown'); assert.equal(waiting.retryAt, '2026-10-01T09:02:00.000Z');
  assert.ok(f.state().pending);
  f.setTime('2026-10-01T09:02:00Z');
  assert.equal((await f.control.reconcile({storeId: '1', campaignId: '7'})).status, 'applied');
});
