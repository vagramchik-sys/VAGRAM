'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {createGrowthActions} = require('../storage/growth-actions.cjs');
const {createOzonPriceWriteTransport, READ_PATH, WRITE_PATH} = require('../storage/acquisition/ozon-price-write.cjs');
const {createOzonAdControl} = require('../storage/ozon-ad-control.cjs');

function fixture() {
  const rows = new Map(), calls = [];
  let time = Date.parse('2026-10-01T10:00:00Z'), price = '100.00', failWrite = false, slowWrite = null, failState = false, readHook = null;
  const p = {storeId: '1', id: '22', offerId: 'offer-A', active: true, name: 'Product'};
  const stateStore = {
    async read(key) { return rows.get(key) || null; },
    async list({prefix}) { return [...rows].filter(([key]) => key.startsWith(prefix)).map(([logicalKey, value]) => ({logicalKey, ...value})); },
    async remove() { throw Error('unused'); },
    async write(key, content, {expectedRevision, mediaType}) {
      if (failState) throw Error('storage unavailable');
      if ((rows.get(key)?.revision || '0') !== expectedRevision) throw Object.assign(Error('conflict'), {code: 'REVISION_CONFLICT'});
      const row = {revision: String(BigInt(expectedRevision) + 1n), content: Buffer.from(content), mediaType, sha256: crypto.createHash('sha256').update(content).digest(), deleted: false};
      rows.set(key, row); return {revision: row.revision};
    }
  };
  const storesRepository = {read: async () => ({1: {market: 'OZON'}, 2: {market: 'WB'}})};
  const priceTransport = createOzonPriceWriteTransport({fetchFn: async (url, options) => {
    const path = new URL(url).pathname, body = JSON.parse(options.body);
    calls.push({path, body});
    if (path === READ_PATH) { if (readHook) await readHook(); return Response.json({total: 1, items: [{offer_id: 'offer-A', price: {price, currency_code: 'RUB'}}]}); }
    assert.equal(path, WRITE_PATH);
    assert.ok(JSON.parse(rows.get('growth-price/1-22').content).pending, 'durable fence before mutation');
    if (slowWrite) await slowWrite;
    if (failWrite) throw Error('lost response');
    price = body.prices[0].price;
    return Response.json({result: [{offer_id: 'offer-A', updated: true, errors: []}]});
  }});
  const campaign = {id: '7', title: 'Campaign', state: 'CAMPAIGN_STATE_RUNNING', PaymentType: 'CPC', advObjectType: 'SKU', budgetType: 'PRODUCT_CAMPAIGN_BUDGET_TYPE_WEEKLY', weeklyBudget: '1000000000', updatedAt: '2026-10-01T09:00:00Z'};
  const adCalls = [];
  const adControl = createOzonAdControl({stateStore, storesRepository, now: () => time, transport: {
    capabilities: {budgetWrite: true, stateWrite: true},
    async listCampaigns() { return [structuredClone(campaign)]; },
    async listCampaignProducts() { return [{sku: '101'}]; },
    async updateWeeklyBudget(store, id, amount) { adCalls.push(['budget', store, id, amount]); campaign.weeklyBudget = String(amount * 1e6); },
    async setCampaignActive(store, id, active) { adCalls.push(['state', store, id, active]); campaign.state = active ? 'CAMPAIGN_STATE_RUNNING' : 'CAMPAIGN_STATE_INACTIVE'; }
  }});
  const make = (factory = createGrowthActions) => factory({stateStore, optimizer: {sku: async () => ({item: {product: p}})}, storesRepository, getSellerCredentials: async storeId => ({clientId: storeId, apiKey: 'fixture-secret'}), priceTransport, adControl, now: () => time});
  return {service: make(), make, rows, calls, p, stateStore, adControl, adCalls, setPrice: value => { price = value; }, setFail: value => { failWrite = value; }, setSlow: value => { slowWrite = value; }, setReadHook: value => { readHook = value; }, setFailState: value => { failState = value; }, advance: value => { time += value; }};
}
const plan = f => f.service.pricePreview({storeId: '1', productId: '22', desiredPrice: '110.25', exclusiveControl: true});
const apply = (f, preview, commandId = crypto.randomUUID()) => f.service.priceApply({token: preview.token, commandId, confirmed: true});
const writes = f => f.calls.filter(row => row.path === WRITE_PATH);

test('preview uses live price, derives offer, and makes no external mutation or credential disclosure', async () => {
  const f = fixture(), preview = await plan(f);
  assert.deepEqual(preview.changes, [{label: 'Цена продавца, ₽', before: '100.00', after: '110.25'}]);
  assert.equal(preview.product.offerId, 'offer-A'); assert.equal(writes(f).length, 0);
  assert.equal(JSON.stringify(preview).includes('fixture-secret'), false);
  assert.equal([...f.rows.values()].some(row => row.content.includes('fixture-secret')), false);
});

test('one confirmed price change sends exact payload, verifies and durably replays after restart', async () => {
  const f = fixture(), preview = await plan(f), commandId = crypto.randomUUID();
  await assert.rejects(f.service.priceApply({token: preview.token, commandId}), {code: 'CONFIRMATION_REQUIRED'});
  assert.equal(writes(f).length, 0);
  assert.deepEqual(await apply(f, preview, commandId), {ok: true, status: 'applied', commandId, applied: true, price: '110.25'});
  assert.deepEqual(writes(f)[0].body, {prices: [{offer_id: 'offer-A', price: '110.25', currency_code: 'RUB'}]});
  f.service = f.make(); f.advance(1000000);
  assert.equal((await apply(f, preview, commandId)).replayed, true); assert.equal(writes(f).length, 1);
  assert.equal((await f.service.priceStatus({storeId: '1', productId: '22'})).audit[0].applied, true);
  await assert.rejects(apply(f, preview), {code: 'PREVIEW_STALE'});
});

test('expired, replaced and changed product previews never send prices', async () => {
  for (const change of [f => f.advance(120001), async f => { await plan(f); }, f => { f.p.offerId = 'different'; }, f => { f.p.active = false; }]) {
    const f = fixture(), preview = await plan(f); await change(f);
    await assert.rejects(apply(f, preview)); assert.equal(writes(f).length, 0);
  }
});

test('current price drift rejects safely, target already present does not claim own write', async () => {
  const drift = fixture(), preview = await plan(drift); drift.setPrice('105.00');
  assert.equal((await apply(drift, preview)).status, 'rejected'); assert.equal(writes(drift).length, 0);
  const f = fixture(), p = await plan(f); f.setPrice('110.25');
  const result = await apply(f, p); assert.equal(result.status, 'applied'); assert.equal(result.applied, false); assert.equal(writes(f).length, 0);
});

test('unknown transport outcome survives restart and only read-only reconciliation can release fence', async () => {
  const f = fixture(), preview = await plan(f), commandId = crypto.randomUUID(); f.setFail(true);
  assert.equal((await apply(f, preview, commandId)).status, 'unknown'); assert.equal(writes(f).length, 1);
  f.service = f.make();
  assert.equal((await apply(f, preview, commandId)).status, 'unknown');
  await assert.rejects(plan(f), {code: 'OUTCOME_UNKNOWN'});
  f.setPrice('110.25');
  assert.equal((await f.service.priceReconcile({storeId: '1', productId: '22'})).status, 'unknown');
  f.advance(600001);
  const result = await f.service.priceReconcile({storeId: '1', productId: '22'});
  assert.equal(result.status, 'applied'); assert.equal(result.applied, false); assert.equal(result.attributionUnknown, true); assert.equal(writes(f).length, 1);
  assert.equal((await f.service.priceStatus({storeId: '1', productId: '22'})).pending, null);
});

test('unknown outcome remains fenced when current price never matches the intended target', async () => {
  const f = fixture(), preview = await plan(f); f.setFail(true); await apply(f, preview); f.advance(600001);
  assert.equal((await f.service.priceReconcile({storeId: '1', productId: '22'})).status, 'unknown');
  await assert.rejects(plan(f), {code: 'OUTCOME_UNKNOWN'}); assert.equal(writes(f).length, 1);
});

test('CAS and command UUID prevent two service instances from dispatching twice', async () => {
  const f = fixture(), preview = await plan(f), other = f.make(), commandId = crypto.randomUUID();
  const results = await Promise.allSettled([apply(f, preview, commandId), other.priceApply({token: preview.token, commandId, confirmed: true})]);
  assert.ok(results.some(r => r.status === 'fulfilled' && r.value.status === 'applied'));
  assert.equal(writes(f).length, 1);
  const next = await f.service.pricePreview({storeId: '1', productId: '22', desiredPrice: '112', exclusiveControl: true});
  await assert.rejects(apply(f, next, commandId), {code: 'COMMAND_ID_REUSED'}); assert.equal(writes(f).length, 1);
});

test('storage failure before reservation prevents external write', async () => {
  const f = fixture(), preview = await plan(f); f.setFailState(true);
  await assert.rejects(apply(f, preview)); assert.equal(writes(f).length, 0);
});

test('another instance cannot reconcile a live delayed dispatch even beyond the settle time', async () => {
  const f = fixture(), preview = await plan(f); let release;
  f.setSlow(new Promise(resolve => { release = resolve; }));
  const pending = apply(f, preview);
  while (!writes(f).length) await new Promise(resolve => setImmediate(resolve));
  f.advance(600001); f.setPrice('110.25');
  const result = await f.make().priceReconcile({storeId: '1', productId: '22'});
  assert.equal(result.status, 'unknown');
  await assert.rejects(f.make().pricePreview({storeId: '1', productId: '22', desiredPrice: '115', exclusiveControl: true}), {code: 'OUTCOME_UNKNOWN'});
  release(); assert.equal((await pending).status, 'applied'); assert.equal(writes(f).length, 1);
});

test('persisted receipt repairs audit after interruption before product finalization without resending', async () => {
  const f = fixture(), preview = await plan(f), commandId = crypto.randomUUID();
  const original = f.stateStore.write; let interrupted = false;
  f.stateStore.write = async (key, content, options) => {
    const value = JSON.parse(content);
    if (!interrupted && key === 'growth-price/1-22' && value.audit.length === 1) { interrupted = true; throw Error('crashed before product finalize'); }
    return original(key, content, options);
  };
  await assert.rejects(apply(f, preview, commandId)); assert.equal(writes(f).length, 1);
  f.service = f.make(); const result = await apply(f, preview, commandId);
  assert.equal(result.status, 'applied'); assert.equal(result.replayed, true); assert.equal(writes(f).length, 1);
  const state = await f.service.priceStatus({storeId: '1', productId: '22'});
  assert.equal(state.pending, null); assert.equal(state.audit.length, 1);
});

test('invalid values, unconfirmed exclusive control and unknown or mismatched stores stop before read', async () => {
  for (const input of [{desiredPrice: '0'}, {desiredPrice: '1.001'}, {desiredPrice: '1e2'}, {exclusiveControl: false}, {storeId: '2'}, {storeId: '99'}, {offerId: 'injected'}]) {
    const f = fixture(); await assert.rejects(f.service.pricePreview({storeId: '1', productId: '22', desiredPrice: '110', exclusiveControl: true, ...input})); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); f.p.storeId = '2'; await assert.rejects(plan(f), {code: 'PRODUCT_UNAVAILABLE'}); assert.equal(f.calls.length, 0);
});

test('campaign budget uses existing durable control, explicit confirmation and whole-campaign warning', async () => {
  const f = fixture(), preview = await f.service.adPreview({storeId: '1', campaignId: '7', action: {kind: 'budget', weeklyBudgetRub: 1250}, exclusiveControl: true});
  assert.ok(preview.warnings.some(text => text.includes('всю кампанию'))); assert.equal(f.adCalls.length, 0);
  const commandId = crypto.randomUUID();
  await assert.rejects(f.service.adApply({token: preview.token, commandId}), {code: 'CONFIRMATION_REQUIRED'});
  assert.equal((await f.service.adApply({token: preview.token, commandId, confirmed: true})).status, 'applied');
  assert.deepEqual(f.adCalls, [['budget', '1', '7', 1250]]);
  f.service = f.make(); assert.equal((await f.service.adApply({token: preview.token, commandId, confirmed: true})).replayed, true); assert.equal(f.adCalls.length, 1);
});

test('growth cannot generate bid/schedule commands or accept tokens created outside its allowed preview', async () => {
  const f = fixture();
  for (const action of [{kind: 'bid', sku: '101', bidRub: 10}, {kind: 'schedule'}]) await assert.rejects(f.service.adPreview({storeId: '1', campaignId: '7', action, exclusiveControl: true}), {code: 'ACTION_BLOCKED'});
  const schedule = await f.adControl.preview({storeId: '1', campaignId: '7', exclusiveControl: true, action: {kind: 'schedule', enabled: false, days: [1], start: '09:00', end: '18:00', timezone: 'Europe/Moscow'}});
  await assert.rejects(f.service.adApply({token: schedule.token, commandId: crypto.randomUUID(), confirmed: true}), {code: 'PREVIEW_STALE'}); assert.equal(f.adCalls.length, 0);
});

test('failed initial live read releases the price fence as proven not sent', async () => {
  const f = fixture(), preview = await plan(f), commandId = crypto.randomUUID();
  f.setReadHook(async () => { throw Error('temporary read outage'); });
  const result = await apply(f, preview, commandId);
  assert.equal(result.status, 'rejected'); assert.equal(result.reason, 'INITIAL_READ_FAILED'); assert.equal(writes(f).length, 0);
  assert.equal((await f.service.priceStatus({storeId: '1', productId: '22'})).pending, null);
  f.setReadHook(null);
  assert.equal((await apply(f, preview, commandId)).replayed, true);
  assert.equal((await apply(f, await plan(f))).status, 'applied'); assert.equal(writes(f).length, 1);
});

test('consent expiration during the live read prevents dispatch and releases pending', async () => {
  const f = fixture(), preview = await plan(f);
  f.setReadHook(async () => { f.advance(120001); });
  const result = await apply(f, preview);
  assert.equal(result.status, 'rejected'); assert.equal(result.reason, 'PREVIEW_STALE'); assert.equal(writes(f).length, 0);
  assert.equal((await f.service.priceStatus({storeId: '1', productId: '22'})).pending, null);
});

test('interrupted prepared command recovers after settling, before or after the SKU pending fence', async () => {
  for (const stage of ['reservation-commit', 'pending', 'dispatch']) {
    const f = fixture(), preview = await plan(f), commandId = crypto.randomUUID(), original = f.stateStore.write;
    let failed = false;
    f.stateStore.write = async (key, content, options) => {
      const value = JSON.parse(content);
      if (!failed && stage === 'reservation-commit' && key.startsWith('growth-price-command/') && value.phase === 'prepared') { failed = true; await original(key, content, options); throw Object.assign(Error('unknown reservation commit'), {code: 'OUTCOME_UNKNOWN'}); }
      if (!failed && (stage === 'pending' && key === 'growth-price/1-22' && value.pending || stage === 'dispatch' && key.startsWith('growth-price-command/') && value.phase === 'dispatching')) { failed = true; throw Error('crash'); }
      return original(key, content, options);
    };
    await assert.rejects(apply(f, preview, commandId)); assert.equal(writes(f).length, 0);
    f.service = f.make(); assert.equal((await apply(f, preview, commandId)).status, 'unknown');
    f.advance(600001);
    const recovered = stage === 'dispatch' ? await f.service.priceReconcile({storeId: '1', productId: '22'}) : await apply(f, preview, commandId);
    assert.equal(recovered.status, 'rejected'); assert.equal(recovered.reason, 'PREPARATION_INTERRUPTED');
    assert.equal((await f.service.priceStatus({storeId: '1', productId: '22'})).pending, null);
    assert.equal((await apply(f, preview, commandId)).status, 'rejected'); assert.equal(writes(f).length, 0);
    assert.equal((await apply(f, await plan(f))).status, 'applied');
  }
});

test('recovery CAS fences a delayed different-runtime dispatcher rather than relying on in-memory ACTIVE', async () => {
  const f = fixture(), preview = await plan(f), commandId = crypto.randomUUID(), original = f.stateStore.write;
  let enter, release, paused = false; const entered = new Promise(resolve => { enter = resolve; }), wait = new Promise(resolve => { release = resolve; });
  f.stateStore.write = async (key, content, options) => {
    const value = JSON.parse(content);
    if (!paused && key.startsWith('growth-price-command/') && value.phase === 'dispatching') { paused = true; enter(); await wait; }
    return original(key, content, options);
  };
  const attempt = apply(f, preview, commandId); await entered;
  // Load an isolated module instance to model another process's independent ACTIVE set.
  const modulePath = require.resolve('../storage/growth-actions.cjs'), cached = require.cache[modulePath];
  delete require.cache[modulePath]; const otherFactory = require(modulePath).createGrowthActions; require.cache[modulePath] = cached;
  const other = f.make(otherFactory); f.advance(600001);
  const recovered = await other.priceReconcile({storeId: '1', productId: '22'});
  assert.equal(recovered.status, 'rejected'); assert.equal(recovered.reason, 'PREPARATION_INTERRUPTED');
  release(); await assert.rejects(attempt, {code: 'REVISION_CONFLICT'});
  assert.equal(writes(f).length, 0); assert.equal((await other.priceStatus({storeId: '1', productId: '22'})).pending, null);
});

test('recovered preparation cannot overwrite a newer preview when an old runtime resumes before its SKU fence', async () => {
  const f = fixture(), preview = await plan(f), commandId = crypto.randomUUID(), original = f.stateStore.write;
  let enter, release, paused = false; const entered = new Promise(resolve => { enter = resolve; }), wait = new Promise(resolve => { release = resolve; });
  f.stateStore.write = async (key, content, options) => {
    const value = JSON.parse(content);
    if (!paused && key === 'growth-price/1-22' && value.pending) { paused = true; enter(); await wait; }
    return original(key, content, options);
  };
  const attempt = apply(f, preview, commandId); await entered;
  const modulePath = require.resolve('../storage/growth-actions.cjs'), cached = require.cache[modulePath];
  delete require.cache[modulePath]; const factory = require(modulePath).createGrowthActions; require.cache[modulePath] = cached;
  const other = f.make(factory); f.advance(600001);
  const recovered = await other.priceApply({token: preview.token, commandId, confirmed: true});
  assert.equal(recovered.status, 'rejected');
  const replacement = await other.pricePreview({storeId: '1', productId: '22', desiredPrice: '115', exclusiveControl: true});
  release(); await assert.rejects(attempt, {code: 'REVISION_CONFLICT'});
  assert.equal(writes(f).length, 0); assert.equal((await other.priceStatus({storeId: '1', productId: '22'})).pending, null);
  assert.equal((await other.priceApply({token: replacement.token, commandId: crypto.randomUUID(), confirmed: true})).status, 'applied');
  assert.equal(writes(f).length, 1);
});

test('uncertain dispatch-phase commit never qualifies for not-sent preparation recovery', async () => {
  const f = fixture(), preview = await plan(f), commandId = crypto.randomUUID(), original = f.stateStore.write;
  let lost = false;
  f.stateStore.write = async (key, content, options) => {
    const result = await original(key, content, options);
    if (!lost && key.startsWith('growth-price-command/') && JSON.parse(content).phase === 'dispatching') { lost = true; throw Object.assign(Error('lost dispatch commit acknowledgement'), {code: 'OUTCOME_UNKNOWN'}); }
    return result;
  };
  await assert.rejects(apply(f, preview, commandId)); f.advance(600001);
  assert.equal((await apply(f, preview, commandId)).status, 'unknown');
  assert.equal((await f.service.priceReconcile({storeId: '1', productId: '22'})).status, 'unknown');
  assert.equal(writes(f).length, 0);
});
