import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../config.js';
import { openDb } from '../db.js';
import { createApp } from '../app.js';
import { createMailer } from '../mailer.js';
import { hashToken } from '../auth.js';
import { startMock } from './mock-anthropic.js';

const APP = 'https://desk.example.test';
let mock, server, base, db;
const sent = [];
const capture = { enabled: true, send: async (m) => { sent.push(m); } }; // records synchronously, like a real provider would accept it
const lastTo = (to) => [...sent].reverse().find((m) => m.to === to);
const tokenIn = (m, kind) => new RegExp(`${APP}/#${kind}=([A-Za-z0-9_-]+)`).exec(m.text)[1];

before(async () => {
  mock = await startMock();
  const config = loadConfig({}, { apiKey: 'k', anthropicBaseUrl: mock.url, cookieSecure: false, appUrl: APP, signupsPerHourPerIp: 100, resetRequestsPerHourPerIp: 100,
    plans: { trial: { aiTokens: 100_000, maxTier: 'default', maxImages: 2, rpm: 100 } } });
  db = openDb(':memory:');
  server = createApp({ config, db, mailer: capture }).listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); mock.close(); });

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
const PW = 'correct-horse-battery';
async function signup(email) {
  const c = client();
  assert.equal((await c.post('/api/signup', { orgName: 'Org ' + email, name: 'Pat', email, password: PW })).status, 201);
  return c;
}
const analyze = (c) => c.post('/api/analyze', { prompt: 'Ticket: cannot log in' });

test('signup emails a confirmation link; AI stays off until it is used, and the link works once', async () => {
  const c = await signup('v@one.test');
  const mail = lastTo('v@one.test');
  assert.match(mail.subject, /Confirm/);
  assert.ok(mail.html.includes(APP) && mail.text.includes(APP));
  const me = (await c.get('/api/me')).json;
  assert.deepEqual(me.email, { enabled: true, verified: false });
  assert.equal(me.aiEnabled, false);
  const blocked = await analyze(c);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.code, 'not_granted');

  const token = tokenIn(mail, 'verify');
  assert.equal((await client().post('/api/email/verify', { token })).status, 200); // works from another browser
  assert.equal((await client().post('/api/email/verify', { token })).status, 400);  // single use
  const me2 = (await c.get('/api/me')).json;
  assert.equal(me2.email.verified, true);
  assert.equal(me2.aiEnabled, true);
  assert.equal((await analyze(c)).status, 200);
});

test('resend-verification is limited and a new link replaces the old one', async () => {
  const c = await signup('v@two.test');
  const first = tokenIn(lastTo('v@two.test'), 'verify');
  assert.equal((await c.post('/api/email/send-verification')).status, 200);
  const second = tokenIn(lastTo('v@two.test'), 'verify');
  assert.notEqual(first, second);
  assert.equal((await client().post('/api/email/verify', { token: first })).status, 400);
  assert.equal((await c.post('/api/email/send-verification')).status, 200);
  assert.equal((await c.post('/api/email/send-verification')).status, 200);
  assert.equal((await c.post('/api/email/send-verification')).status, 429);
  assert.equal((await client().post('/api/email/send-verification')).status, 401);
});

test('forgot password answers identically for unknown and known addresses', async () => {
  await signup('r@one.test');
  const before = sent.length;
  const none = await client().post('/api/password/forgot', { email: 'nobody@nowhere.test' });
  assert.equal(sent.length, before);
  const known = await client().post('/api/password/forgot', { email: 'R@One.test' });
  assert.deepEqual(none, known);
  assert.equal(sent.length, before + 1);
  assert.match(sent.at(-1).subject, /Reset/);
});

test('reset: new password works, old does not, all sessions end, token is single use, confirms the email, is audited', async () => {
  const c = await signup('r@two.test');
  await client().post('/api/password/forgot', { email: 'r@two.test' });
  const token = tokenIn(lastTo('r@two.test'), 'reset');

  assert.equal((await client().post('/api/password/reset', { token, password: 'short' })).json.code, 'weak_password'); // does not burn the token
  const NEW = 'a-brand-new-password';
  assert.equal((await client().post('/api/password/reset', { token, password: NEW })).status, 200);
  assert.match(sent.at(-1).subject, /changed/);

  assert.equal((await c.get('/api/me')).status, 401, 'old session is gone');
  assert.equal((await client().post('/api/login', { email: 'r@two.test', password: PW })).status, 401);
  const again = client();
  assert.equal((await again.post('/api/login', { email: 'r@two.test', password: NEW })).status, 200);
  assert.equal((await again.get('/api/me')).json.email.verified, true);
  assert.equal((await client().post('/api/password/reset', { token, password: 'yet-another-password' })).json.code, 'bad_token');
  assert.ok((await again.get('/api/c/audit')).json.some((r) => r.data.act === 'password_reset'));
});

test('reset tokens: unknown, malformed, expired, superseded and disabled-account tokens are refused', async () => {
  assert.equal((await client().post('/api/password/reset', { token: 'x'.repeat(43), password: PW })).json.code, 'bad_token');
  assert.equal((await client().post('/api/password/reset', { token: { $ne: 1 }, password: PW })).json.code, 'bad_token');

  await signup('r@three.test');
  await client().post('/api/password/forgot', { email: 'r@three.test' });
  const t1 = tokenIn(lastTo('r@three.test'), 'reset');
  await client().post('/api/password/forgot', { email: 'r@three.test' });
  const t2 = tokenIn(lastTo('r@three.test'), 'reset');
  assert.equal((await client().post('/api/password/reset', { token: t1, password: PW })).status, 400, 'older link superseded');
  db.prepare('UPDATE email_tokens SET expires_at=? WHERE token_hash=?').run(Date.now() - 1, hashToken(t2));
  assert.equal((await client().post('/api/password/reset', { token: t2, password: PW })).status, 400, 'expired');

  // A removed teammate cannot get back in by resetting.
  const admin = await signup('admin@four.test');
  const added = await admin.post('/api/team', { name: 'Tmp', email: 'gone@four.test', password: 'temporary-pass-1', role: 'agent' });
  await client().post('/api/password/forgot', { email: 'gone@four.test' });
  const t3 = tokenIn(lastTo('gone@four.test'), 'reset');
  const team = (await admin.get('/api/team')).json;
  const id = team.find((m) => m.email === 'gone@four.test').id;
  await fetch(`${base}/api/team/${id}`, { method: 'DELETE', headers: { cookie: '' } }); // unauthenticated: no effect
  db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(id);
  assert.equal((await client().post('/api/password/reset', { token: t3, password: PW })).status, 400);
  assert.equal(added.status, 201);
});

test('only three reset emails per address per hour; the response never changes', async () => {
  await signup('r@five.test');
  const before = sent.filter((m) => m.to === 'r@five.test').length;
  for (let i = 0; i < 5; i++) assert.equal((await client().post('/api/password/forgot', { email: 'r@five.test' })).status, 200);
  assert.equal(sent.filter((m) => m.to === 'r@five.test').length - before, 3);
});

test('reset requests are limited per IP', async () => {
  const config = loadConfig({}, { cookieSecure: false, appUrl: APP, resetRequestsPerHourPerIp: 2 });
  const s = createApp({ config, db: openDb(':memory:'), mailer: capture }).listen(0);
  const post = () => fetch(`http://127.0.0.1:${s.address().port}/api/password/forgot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"email":"a@b.test"}' });
  assert.deepEqual([(await post()).status, (await post()).status, (await post()).status], [200, 200, 429]);
  s.close();
});

test('links use APP_URL and ignore a forged Host header', async () => {
  await signup('h@six.test');
  await fetch(base + '/api/password/forgot', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-host': 'evil.test' }, body: JSON.stringify({ email: 'h@six.test' }) });
  const m = lastTo('h@six.test');
  assert.ok(m.text.includes(`${APP}/#reset=`) && !m.text.includes('evil.test'));
});

test('team members added by an admin get a confirmation email too', async () => {
  const admin = await signup('admin@seven.test');
  assert.equal((await admin.post('/api/team', { name: 'New', email: 'new@seven.test', password: 'temporary-pass-1', role: 'agent' })).status, 201);
  assert.match(lastTo('new@seven.test').subject, /Confirm/);
});

test('without an email provider nothing is gated and reset says it is unavailable', async () => {
  const config = loadConfig({}, { apiKey: 'k', anthropicBaseUrl: mock.url, cookieSecure: false });
  const s = createApp({ config, db: openDb(':memory:') }).listen(0);
  const b = `http://127.0.0.1:${s.address().port}`;
  const r = await fetch(b + '/api/password/forgot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"email":"a@b.test"}' });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).code, 'email_disabled');
  s.close();
});

// ---------- providers ----------
function fakeProvider(status = 200) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => (body += d));
    req.on('end', () => { calls.push({ url: req.url, headers: req.headers, body: JSON.parse(body) }); res.writeHead(status); res.end(status === 200 ? '{}' : '{"message":"bad key"}'); });
  }).listen(0);
  return { calls, url: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() };
}
const msg = { to: 'u@x.test', subject: 'S', text: 'T', html: '<p>H</p>' };

test('Resend request shape', async () => {
  const p = fakeProvider();
  const m = createMailer({ emailProvider: 'resend', appUrl: APP, emailFrom: 'Desk <no-reply@x.test>', resendApiKey: 're_123', resendBaseUrl: p.url });
  await m.send(msg);
  assert.equal(p.calls[0].url, '/emails');
  assert.equal(p.calls[0].headers.authorization, 'Bearer re_123');
  assert.deepEqual(p.calls[0].body, { from: 'Desk <no-reply@x.test>', to: ['u@x.test'], subject: 'S', text: 'T', html: '<p>H</p>' });
  p.close();
});

test('Postmark request shape', async () => {
  const p = fakeProvider();
  const m = createMailer({ emailProvider: 'postmark', appUrl: APP, emailFrom: 'no-reply@x.test', postmarkToken: 'pm_1', postmarkBaseUrl: p.url });
  await m.send(msg);
  assert.equal(p.calls[0].url, '/email');
  assert.equal(p.calls[0].headers['x-postmark-server-token'], 'pm_1');
  assert.equal(p.calls[0].body.To, 'u@x.test');
  assert.equal(p.calls[0].body.TextBody, 'T');
  p.close();
});

test('provider errors reject, and half-configured email fails at startup', async () => {
  const p = fakeProvider(401);
  const m = createMailer({ emailProvider: 'resend', appUrl: APP, emailFrom: 'a@x.test', resendApiKey: 'bad', resendBaseUrl: p.url });
  await assert.rejects(m.send(msg), /401/);
  p.close();
  assert.throws(() => createMailer({ emailProvider: 'resend', appUrl: APP, emailFrom: 'a@x.test' }), /RESEND_API_KEY/);
  assert.throws(() => createMailer({ emailProvider: 'resend', resendApiKey: 'k', emailFrom: 'a@x.test' }), /APP_URL/);
  assert.throws(() => createMailer({ emailProvider: 'ses' }), /must be one of/);
  assert.equal(createMailer({}).enabled, false);
});

test('a database created before email verification is upgraded in place', () => {
  const path = `${process.env.TMPDIR || '/tmp'}/td-old-${process.pid}.db`;
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE orgs(id TEXT PRIMARY KEY, name TEXT NOT NULL, plan TEXT NOT NULL, ai_tokens_override INTEGER, redact_server INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
    CREATE TABLE users(id TEXT PRIMARY KEY, org_id TEXT NOT NULL, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, pw_hash TEXT NOT NULL, role TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    INSERT INTO orgs VALUES('o','O','trial',NULL,1,1); INSERT INTO users VALUES('u','o','a@b.test','A','x','admin',0,1);`);
  old.close();
  const upgraded = openDb(path);
  assert.equal(upgraded.prepare('SELECT email_verified_at v FROM users').get().v, null);
  upgraded.close();
  openDb(path).close(); // idempotent
});
