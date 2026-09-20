'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const createWorkspace = require('../partner-workspace.cjs'), { start, cookieName } = require('../partner-server.cjs');
async function setup(t, extra = {}) {
  const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pult-partner-server-test-'));
  const workspace = createWorkspace({ privateDir, getProducts: () => [{ key: 'a:1', market: 'Ozon', name: 'A', quantity: 5, clientId: 'OWNER_SECRET' }, { key: 'b:2', market: 'Ozon', name: 'B', quantity: 20 }] });
  const a = workspace.savePartner({ name: 'Partner A', productKeys: ['a:1'], active: true }), b = workspace.savePartner({ name: 'Partner B', productKeys: ['b:2'], active: true });
  const accessA = workspace.issueCredential({ id: a.id, version: a.version }), accessB = workspace.issueCredential({ id: b.id, version: b.version });
  const server = await start({ privateDir, workspace, port: 0, ...extra }), origin = server.partnerOrigin;
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); const target = path.resolve(privateDir); if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('pult-partner-server-test-')) throw Error('Unsafe cleanup'); fs.rmSync(target, { recursive: true, force: true }); });
  const post = (route, value, headers = {}) => fetch(origin + route, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) });
  const login = async credential => { const res = await post('/api/partner/login', { credential }); assert.equal(res.status, 200); return res.headers.get('set-cookie').split(';')[0]; };
  return { workspace, origin, a: accessA, b: accessB, post, login };
}
test('isolated listener requires its own credential and exposes only own products', async t => {
  const { origin, a, b, login } = await setup(t);
  assert.equal((await fetch(origin + '/api/partner/dashboard', { headers: { cookie: 'pult_session=OWNER' } })).status, 401);
  const cookieA = await login(a.credential), cookieB = await login(b.credential);
  for (const [cookie, expected] of [[cookieA, 'a:1'], [cookieB, 'b:2']]) {
    const res = await fetch(origin + '/api/partner/dashboard', { headers: { cookie } }); assert.equal(res.status, 200);
    const result = await res.json(); assert.deepEqual(result.products.map(p => p.key), [expected]); assert.equal(JSON.stringify(result).includes('OWNER_SECRET'), false);
    assert.equal(result.products[0].finance.settlement, null); assert.equal(result.products[0].sales.sold, null);
    assert.equal(result.commercialModel.contractCommissionPercent, null); assert.equal(result.commercialModel.label, 'Комиссия по договору с нами');
    for (const forbidden of ['ourCommissionPercent', 'partnerCommissionPercent', 'targetDifferencePercentagePoints', 'advertisingPercent', 'requiredAds', 'commission-rate-difference', 'commissionDifferenceIncome', 'netProfit', 'ownerMargin', '25%', '5 п.п.', '15%', 'внутренняя ставка', 'Разница комиссий']) assert.equal(JSON.stringify(result).includes(forbidden), false, 'API leaked internal value: ' + forbidden);
  }
  for (const target of ['/api/stores', '/api/partners/state', '/api/management/state', '/api/partner/' + b.partner.id, '/.private/partner-workspace.json', '/server.cjs', '/index.html']) assert.equal((await fetch(origin + target, { headers: { cookie: cookieA } })).status, 404);
  for (const query of ['?partnerId=' + b.partner.id, '?productKey=b:2', '?id=owner']) assert.equal((await fetch(origin + '/api/partner/dashboard' + query, { headers: { cookie: cookieA } })).status, 400);
});
test('login requires exact origin, rejects extra identity fields, and returns protected session cookie', async t => {
  const { origin, a, b, post } = await setup(t);
  assert.equal((await post('/api/partner/login', { credential: a.credential }, { origin: 'http://attacker.invalid' })).status, 403);
  assert.equal((await fetch(origin + '/api/partner/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: a.credential }) })).status, 403);
  assert.equal((await post('/api/partner/login', { credential: a.credential, partnerId: b.partner.id })).status, 400);
  const res = await post('/api/partner/login', { credential: a.credential });
  assert.equal(res.status, 200); assert.match(res.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Path=\//);
  assert.match(res.headers.get('set-cookie'), /Max-Age=28800/); assert.equal(res.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(await res.json(), { ok: true });
  const rebound = await new Promise((resolve, reject) => { const req = http.get(origin + '/api/partner/dashboard', { headers: { host: 'attacker.invalid' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
  assert.equal(rebound, 403);
});
test('revocation, rotation, logout and expiry reject old session tokens', async t => {
  let time = Date.now(); const { origin, a, workspace, login, post } = await setup(t, { now: () => time, sessionTtlMs: 1000 });
  const cookie = await login(a.credential);
  time += 1001; assert.equal((await fetch(origin + '/api/partner/dashboard', { headers: { cookie } })).status, 401);
  const cookie2 = await login(a.credential);
  assert.equal((await post('/api/partner/logout', {}, { cookie: cookie2, origin: 'http://attacker.invalid' })).status, 403);
  assert.equal((await post('/api/partner/logout', {}, { cookie: cookie2 })).status, 200);
  assert.equal((await fetch(origin + '/api/partner/dashboard', { headers: { cookie: cookie2 } })).status, 401);
  const cookie3 = await login(a.credential), second = workspace.issueCredential({ id: a.partner.id, version: a.partner.version });
  assert.equal((await fetch(origin + '/api/partner/dashboard', { headers: { cookie: cookie3 } })).status, 401);
  assert.equal((await post('/api/partner/login', { credential: a.credential })).status, 401);
  const cookie4 = await login(second.credential);
  workspace.revokeCredential({ id: second.partner.id, version: second.partner.version });
  assert.equal((await fetch(origin + '/api/partner/dashboard', { headers: { cookie: cookie4 } })).status, 401);
  assert.equal((await post('/api/partner/login', { credential: second.credential })).status, 401);
});
test('brute force is bounded, unsupported writes rejected, external binding refused', async t => {
  const { origin, post, a, login } = await setup(t);
  const cookie = await login(a.credential);
  for (const route of ['/api/partner/dashboard', '/api/partners/save', '/api/pricing/submit']) assert.equal((await post(route, { id: a.partner.id }, { cookie })).status, 404);
  for (let i = 0; i < 9; i++) assert.equal((await post('/api/partner/login', { credential: 'invalid' })).status, 401);
  const locked = await post('/api/partner/login', { credential: a.credential }); assert.equal(locked.status, 429); assert.ok(Number(locked.headers.get('retry-after')) > 0);
  assert.equal((await fetch(origin + '/api/partner/dashboard', { headers: { cookie: cookieName + '=invalid' } })).status, 401);
  await assert.rejects(start({ host: '0.0.0.0' }), /127.0.0.1/);
});
