import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadConfig } from '../config.js';
import { openDb } from '../db.js';
import { createApp } from '../app.js';
import { signWebhook, verifyWebhook, formEncode } from '../stripe.js';
import { startMock } from './mock-anthropic.js';

const SECRET = 'whsec_test';
const APP = 'https://desk.example.test';
let mock, fake, server, base, db;
const stripeCalls = [];

before(async () => {
  mock = await startMock();
  fake = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => (body += d));
    req.on('end', () => {
      stripeCalls.push({ path: req.url, auth: req.headers.authorization, params: new URLSearchParams(body) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ url: 'https://stripe.test/pay/' + req.url.split('/').pop() }));
    });
  }).listen(0);
  const config = loadConfig({}, {
    apiKey: 'k', anthropicBaseUrl: mock.url, cookieSecure: false, appUrl: APP, signupsPerHourPerIp: 100,
    stripeSecretKey: 'sk_test_x', stripeWebhookSecret: SECRET, stripeBaseUrl: `http://127.0.0.1:${fake.address().port}`,
    stripePrices: { team: 'price_team', trial: 'price_other' },
    plans: {
      free: { aiTokens: 0, maxTier: 'quick', maxImages: 0, rpm: 0 },
      trial: { aiTokens: 20_000, maxTier: 'default', maxImages: 2, rpm: 100 },
      team: { aiTokens: 1_000_000, maxTier: 'complex', maxImages: 4, rpm: 100 },
    },
  });
  db = openDb(':memory:');
  server = createApp({ config, db }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fake.close(); mock.close(); });

function client() {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined });
    const sid = (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('td_sid='));
    if (sid) cookie = sid.endsWith('=') ? '' : sid;
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}) };
}
let n = 0;
async function newOrg() {
  const c = client(); const email = `b${++n}@org.test`;
  await c.post('/api/signup', { orgName: 'Org' + n, name: 'Admin', email, password: 'correct-horse-battery' });
  const me = (await c.get('/api/me')).json;
  return { c, orgId: me.org.id, email };
}
let evn = 0;
async function webhook(type, object, { created = Math.floor(Date.now() / 1000), id = `evt_${++evn}`, secret = SECRET, t } = {}) {
  const body = JSON.stringify({ id, type, created, data: { object } });
  const res = await fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': signWebhook(body, secret, t), 'content-type': 'application/json' }, body });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const sub = (orgId, over = {}) => ({ id: 'sub_1', customer: 'cus_1', status: 'active', metadata: { org_id: orgId },
  current_period_end: 2_000_000_000, items: { data: [{ price: { id: 'price_team' } }] }, ...over });
const planOf = async (c) => (await c.get('/api/me')).json.org.plan;

test('formEncode produces Stripe bracket syntax', () => {
  assert.equal(formEncode({ mode: 'subscription', line_items: [{ price: 'p', quantity: 1 }], metadata: { a: 'b c' } }).join('&'),
    'mode=subscription&line_items%5B0%5D%5Bprice%5D=p&line_items%5B0%5D%5Bquantity%5D=1&metadata%5Ba%5D=b%20c');
});

test('webhook signature: wrong secret, tampered body, old timestamp and missing header are rejected', async () => {
  const { orgId } = await newOrg();
  const ev = { id: 'evt_x', type: 'customer.subscription.created', created: 1, data: { object: sub(orgId) } };
  assert.equal((await webhook(ev.type, ev.data.object, { secret: 'whsec_wrong' })).status, 400);
  assert.equal((await webhook(ev.type, ev.data.object, { t: Math.floor(Date.now() / 1000) - 3600 })).status, 400);
  const body = JSON.stringify(ev);
  const good = signWebhook(body, SECRET);
  const tampered = await fetch(base + '/api/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': good }, body: body.replace('evt_x', 'evt_y') });
  assert.equal(tampered.status, 400);
  assert.equal((await fetch(base + '/api/stripe/webhook', { method: 'POST', body })).status, 400);
  assert.equal(verifyWebhook(Buffer.from(body), good, SECRET).id, 'evt_x');
});

test('checkout: admin only, validated plan, org id and price sent to Stripe, plan not changed by the call', async () => {
  const { c, orgId, email } = await newOrg();
  assert.equal((await c.get('/api/me')).json.billing.enabled, true);
  assert.equal((await c.post('/api/billing/checkout', { plan: 'enterprise' })).status, 400);
  assert.equal((await c.post('/api/billing/checkout', { plan: '__proto__' })).status, 400);
  const r = await c.post('/api/billing/checkout', { plan: 'team' });
  assert.equal(r.status, 200);
  assert.match(r.json.url, /^https:\/\/stripe\.test\//);
  const call = stripeCalls.at(-1);
  assert.equal(call.path, '/v1/checkout/sessions');
  assert.equal(call.auth, 'Bearer sk_test_x');
  const p = call.params;
  assert.equal(p.get('mode'), 'subscription');
  assert.equal(p.get('line_items[0][price]'), 'price_team');
  assert.equal(p.get('client_reference_id'), orgId);
  assert.equal(p.get('subscription_data[metadata][org_id]'), orgId);
  assert.equal(p.get('customer_email'), email);
  assert.equal(p.get('success_url'), `${APP}/#billing=success`);
  assert.equal(await planOf(c), 'trial', 'paying is only recognised via the signed webhook');

  const admin = c; const viewerEmail = 'viewer@org.test';
  await admin.post('/api/team', { name: 'V', email: viewerEmail, password: 'temporary-pass-1', role: 'viewer' });
  const v = client(); await v.post('/api/login', { email: viewerEmail, password: 'temporary-pass-1' });
  assert.equal((await v.post('/api/billing/checkout', { plan: 'team' })).status, 403);
  assert.equal((await v.post('/api/billing/portal')).status, 403);
  assert.equal((await client().post('/api/billing/checkout', { plan: 'team' })).status, 401);
});

test('subscription webhook sets the plan, links the customer, audits it, and a repeat delivery is a no-op', async () => {
  const { c, orgId } = await newOrg();
  assert.equal((await webhook('checkout.session.completed', { client_reference_id: orgId, customer: 'cus_1', subscription: 'sub_1' }, { id: 'evt_co' })).status, 200);
  assert.equal(await planOf(c), 'trial');
  const ev = await webhook('customer.subscription.created', sub(orgId), { id: 'evt_s1' });
  assert.equal(ev.status, 200);
  assert.equal(await planOf(c), 'team');
  const me = (await c.get('/api/me')).json;
  assert.equal(me.billing.subscribed, true);
  assert.equal(me.billing.canManage, true);
  assert.equal(me.billing.periodEnd, 2_000_000_000_000);
  assert.ok((await c.get('/api/c/audit')).json.some((r) => r.data.act === 'plan_changed' && r.data.d === 'trial to team'));

  // Stripe delivers events at least once: replaying must not re-apply it over a later change.
  await webhook('customer.subscription.updated', sub(orgId, { status: 'canceled' }), { id: 'evt_s2', created: Math.floor(Date.now() / 1000) + 10 });
  assert.equal(await planOf(c), 'free');
  await webhook('customer.subscription.created', sub(orgId), { id: 'evt_s1' });
  assert.equal(await planOf(c), 'free');

  assert.equal((await c.post('/api/analyze', { prompt: 'x' })).status, 403, 'AI is off on the downgrade plan');
});

test('payment trouble keeps access while Stripe retries; real cancellation downgrades', async () => {
  const { c, orgId } = await newOrg();
  const now = Math.floor(Date.now() / 1000);
  await webhook('customer.subscription.created', sub(orgId), { created: now });
  await webhook('customer.subscription.updated', sub(orgId, { status: 'past_due' }), { created: now + 1 });
  assert.equal(await planOf(c), 'team');
  assert.equal((await c.get('/api/me')).json.billing.status, 'past_due');
  await webhook('customer.subscription.deleted', sub(orgId, { status: 'canceled' }), { created: now + 2 });
  assert.equal(await planOf(c), 'free');
  const me = (await c.get('/api/me')).json;
  assert.equal(me.billing.subscribed, false);
  assert.equal(me.billing.canManage, true, 'customer stays so they can resubscribe or see invoices');
});

test('out-of-order events: an older update delivered late cannot undo a newer one', async () => {
  const { c, orgId } = await newOrg();
  const now = Math.floor(Date.now() / 1000);
  await webhook('customer.subscription.updated', sub(orgId, { status: 'canceled' }), { created: now + 5 });
  await webhook('customer.subscription.created', sub(orgId), { created: now });
  assert.equal(await planOf(c), 'free');
});

test('another subscription ending does not cancel the current one; unknown price and unknown org are harmless', async () => {
  const { c, orgId } = await newOrg();
  const now = Math.floor(Date.now() / 1000);
  await webhook('customer.subscription.created', sub(orgId), { created: now });
  const old = await webhook('customer.subscription.deleted', sub(orgId, { id: 'sub_old', status: 'canceled' }), { created: now + 1 });
  assert.equal(old.status, 200);
  assert.equal(await planOf(c), 'team');
  await webhook('customer.subscription.updated', sub(orgId, { items: { data: [{ price: { id: 'price_mystery' } }] } }), { created: now + 2 });
  assert.equal(await planOf(c), 'team', 'unmapped price leaves the plan alone');
  assert.equal((await webhook('customer.subscription.created', sub('o_nonexistent', { customer: 'cus_ghost' }))).status, 200);
  assert.equal((await webhook('invoice.paid', { id: 'in_1' })).status, 200);
});

test('a second checkout is refused while subscribed; portal needs a customer and sends the return URL', async () => {
  const { c, orgId } = await newOrg();
  assert.equal((await c.post('/api/billing/portal')).json.code, 'no_customer');
  await webhook('customer.subscription.created', sub(orgId, { customer: 'cus_portal' }));
  assert.equal((await c.post('/api/billing/checkout', { plan: 'team' })).status, 409);
  const r = await c.post('/api/billing/portal');
  assert.equal(r.status, 200);
  const call = stripeCalls.at(-1);
  assert.equal(call.path, '/v1/billing_portal/sessions');
  assert.equal(call.params.get('customer'), 'cus_portal');
  assert.equal(call.params.get('return_url'), `${APP}/`);
});

test('after cancelling, checkout reuses the existing Stripe customer', async () => {
  const { c, orgId } = await newOrg();
  const now = Math.floor(Date.now() / 1000);
  await webhook('customer.subscription.created', sub(orgId, { customer: 'cus_again' }), { created: now });
  await webhook('customer.subscription.deleted', sub(orgId, { customer: 'cus_again', status: 'canceled' }), { created: now + 1 });
  assert.equal((await c.post('/api/billing/checkout', { plan: 'team' })).status, 200);
  const p = stripeCalls.at(-1).params;
  assert.equal(p.get('customer'), 'cus_again');
  assert.equal(p.get('customer_email'), null);
});

test('a failure while applying an event rolls back and returns 500 so Stripe retries', async () => {
  const { c, orgId } = await newOrg();
  db.exec('CREATE TRIGGER boom BEFORE UPDATE OF plan ON orgs BEGIN SELECT RAISE(ABORT, \'disk\'); END;');
  const first = await webhook('customer.subscription.created', sub(orgId), { id: 'evt_retry' });
  assert.equal(first.status, 500);
  db.exec('DROP TRIGGER boom');
  assert.equal((await webhook('customer.subscription.created', sub(orgId), { id: 'evt_retry' })).status, 200);
  assert.equal(await planOf(c), 'team');
});

test('without Stripe configured, billing routes say so and nothing else changes', async () => {
  const config = loadConfig({}, { cookieSecure: false });
  const s = createApp({ config, db: openDb(':memory:') }).listen(0);
  const b = `http://127.0.0.1:${s.address().port}`;
  assert.equal((await fetch(b + '/api/stripe/webhook', { method: 'POST', body: '{}' })).status, 503);
  const r = await fetch(b + '/api/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orgName: 'Solo', name: 'S', email: 's@s.test', password: 'long-enough-pass' }) });
  const cookie = r.headers.getSetCookie()[0].split(';')[0];
  const me = await (await fetch(b + '/api/me', { headers: { cookie } })).json();
  assert.deepEqual(me.billing, { enabled: false });
  s.close();
});
