import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.js';
import { openDb } from '../db.js';
import { createApp } from '../app.js';
import { startMock } from './mock-anthropic.js';

let mock, server, base, db;

before(async () => {
  mock = await startMock();
  const config = loadConfig({}, {
    apiKey: 'test-key', anthropicBaseUrl: mock.url, cookieSecure: false,
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
after(() => { server.close(); mock.close(); });

// A tiny client with a cookie jar.
function client() {
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.getSetCookie?.() || [];
    const sid = sc.map((c) => c.split(';')[0]).find((c) => c.startsWith('td_sid='));
    if (sid) cookie = sid.endsWith('=') ? '' : sid;
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
  return { get: (p, h) => call('GET', p, undefined, h), post: (p, b, h) => call('POST', p, b ?? {}, h), put: (p, b) => call('PUT', p, b),
    patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}

async function signup(org, email) {
  const c = client();
  const r = await c.post('/api/signup', { orgName: org, name: org + ' admin', email, password: 'correct-horse-battery' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return c;
}

let A, B;
test('signup creates separate workspaces and signs the user in', async () => {
  A = await signup('Acme', 'a@acme.test');
  B = await signup('Globex', 'b@globex.test');
  const me = await A.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.org.name, 'Acme');
  assert.equal(me.json.user.role, 'admin');
  assert.equal(me.json.aiEnabled, true);
});

test('unauthenticated requests are rejected', async () => {
  const anon = client();
  assert.equal((await anon.get('/api/me')).status, 401);
  assert.equal((await anon.get('/api/c/tickets')).status, 401);
  assert.equal((await anon.post('/api/analyze', { prompt: 'hi' })).status, 401);
});

test('weak passwords and duplicate emails are refused; bad logins are generic', async () => {
  const c = client();
  assert.equal((await c.post('/api/signup', { orgName: 'X Co', name: 'x', email: 'x@x.test', password: 'short' })).json.code, 'weak_password');
  assert.equal((await c.post('/api/signup', { orgName: 'Dup', name: 'x', email: 'a@acme.test', password: 'long-enough-pass' })).status, 409);
  const bad = await c.post('/api/login', { email: 'a@acme.test', password: 'wrong-password' });
  const none = await c.post('/api/login', { email: 'nobody@nowhere.test', password: 'wrong-password' });
  assert.equal(bad.status, 401);
  assert.deepEqual(bad.json, none.json);
});

test('tenant isolation: one org cannot read, overwrite or delete another org\'s data', async () => {
  const t = { id: 'tk1', text: 'Acme secret ticket', summary: 'Acme only', pr: 'P2', primary: 'Bug', status: 'open' };
  assert.equal((await A.put('/api/c/tickets/tk1', t)).status, 200);
  assert.equal((await A.put('/api/c/kb/k1', { id: 'k1', title: 'Acme KB', body: 'secret' })).status, 200);

  assert.equal((await B.get('/api/c/tickets')).json.length, 0);
  assert.equal((await B.get('/api/c/tickets/tk1')).status, 404);
  assert.equal((await B.get('/api/c/kb')).json.length, 0);
  assert.equal((await B.patch('/api/c/tickets/tk1', { status: 'resolved' })).status, 404);
  await B.del('/api/c/tickets/tk1');
  // B writing the same id creates B's own doc; A's is untouched
  assert.equal((await B.put('/api/c/tickets/tk1', { id: 'tk1', text: 'Globex ticket' })).status, 200);

  const a = await A.get('/api/c/tickets/tk1');
  assert.equal(a.json.text, 'Acme secret ticket');
  assert.equal((await A.get('/api/c/tickets')).json.length, 1);
  assert.equal((await B.get('/api/c/tickets')).json.length, 1);
  assert.equal((await B.get('/api/c/tickets')).json[0].data.text, 'Globex ticket');
});

test('createdBy is stamped by the server, not the client', async () => {
  const me = (await A.get('/api/me')).json.user.id;
  await A.put('/api/c/tickets/tk2', { id: 'tk2', text: 'x', createdBy: 'someone-else' });
  assert.equal((await A.get('/api/c/tickets/tk2')).json.createdBy, me);
});

test('roles: viewers are read-only and cannot spend AI budget', async () => {
  const add = await A.post('/api/team', { name: 'Vera', email: 'v@acme.test', password: 'viewer-password-1', role: 'viewer' });
  assert.equal(add.status, 201);
  const V = client();
  assert.equal((await V.post('/api/login', { email: 'v@acme.test', password: 'viewer-password-1' })).status, 200);
  assert.equal((await V.get('/api/c/tickets')).json.length, 2);              // sees the team's data
  assert.equal((await V.put('/api/c/tickets/tk9', { id: 'tk9' })).status, 403);
  assert.equal((await V.del('/api/c/tickets/tk1')).status, 403);
  assert.equal((await V.post('/api/analyze', { prompt: 'hello' })).status, 403);
  assert.equal((await V.post('/api/team', { name: 'x', email: 'q@acme.test', password: 'another-pass-1' })).status, 403);
  // admin of another org cannot remove this user
  const vid = (await A.get('/api/team')).json.find((m) => m.email === 'v@acme.test').id;
  assert.equal((await B.del('/api/team/' + vid)).status, 404);
  assert.equal((await A.del('/api/team/' + vid)).status, 200);
  assert.equal((await V.get('/api/c/tickets')).status, 401);                  // removing a user ends their sessions
});

test('audit log is append-only, server-stamped and org-scoped', async () => {
  const me = (await A.get('/api/me')).json.user.id;
  assert.equal((await A.post('/api/c/audit', { act: 'ticket_added', d: 'x', by: 'forged', at: 1 })).status, 201);
  const rows = (await A.get('/api/c/audit')).json;
  const e = rows.find((r) => r.data.act === 'ticket_added');
  assert.equal(e.data.by, me);
  assert.ok(e.data.at > 1_000_000_000_000);
  assert.equal((await A.del('/api/c/audit/' + e.id)).status, 405);
  assert.equal((await A.put('/api/c/audit/' + e.id, { act: 'x' })).status, 405);
  assert.throws(() => db.exec('DELETE FROM audit'), /append-only/);
  assert.throws(() => db.exec("UPDATE audit SET act='x'"), /append-only/);
  assert.equal((await B.get('/api/c/audit')).json.some((r) => r.data.act === 'ticket_added'), false);
});

test('cross-site writes are blocked by the origin check', async () => {
  const evil = { origin: 'https://evil.example' };
  const r = await A.post('/api/c/audit', { act: 'x_y' }, evil);
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'bad_origin');
  assert.equal((await A.post('/api/analyze', { prompt: 'hi' }, evil)).status, 403);
  assert.equal((await A.post('/api/c/audit', { act: 'ok_act' }, { origin: base })).status, 201);
});

test('/analyze meters tokens, redacts server-side and returns usable JSON from a fenced reply', async () => {
  const before = (await A.get('/api/usage')).json;
  assert.equal(before.used, 0);
  const r = await A.post('/api/analyze', { prompt: 'Ticket: please call me on +1 415 555 0134 or mail jane@corp.example, card 4242 4242 4242 4242', tier: 'quick' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.json.category, 'Bug');
  const sent = mock.requests.at(-1);
  assert.match(sent.text, /\[email\]/);
  assert.match(sent.text, /\[phone\]/);
  assert.match(sent.text, /\[card\]/);
  assert.doesNotMatch(sent.text, /jane@corp/);
  assert.equal(sent.key, 'test-key');
  const after = (await A.get('/api/usage')).json;
  assert.ok(after.used > 300, 'tokens counted');
  assert.equal(after.calls, 1);
  assert.equal((await B.get('/api/usage')).json.used, 0, 'other org unaffected');
});

test('/analyze clamps the model tier to the plan and handles bulk prompts', async () => {
  await A.post('/api/analyze', { prompt: 'Ticket: hi', tier: 'complex' });
  assert.equal(mock.requests.at(-1).model, 'claude-sonnet-5-5'); // trial allows up to "default"
  await A.post('/api/analyze', { prompt: 'x', tier: 'quick' });
  assert.equal(mock.requests.at(-1).model, 'claude-haiku-5-5');
  const bulk = await A.post('/api/analyze', { prompt: 'You will receive a JSON array of tickets\n[{"id":0,"ticket":"a"},{"id":1,"ticket":"b"}]' });
  assert.equal(bulk.status, 200);
  assert.equal(bulk.json.json.length, 2);
  assert.equal(mock.requests.at(-1).max_tokens, 7000);
});

test('/analyze validates input and image limits', async () => {
  assert.equal((await A.post('/api/analyze', {})).status, 400);
  assert.equal((await A.post('/api/analyze', { prompt: 'x'.repeat(50_000) })).status, 413);
  const img = { type: 'image/png', data: 'AAAA' };
  assert.equal((await A.post('/api/analyze', { prompt: 'x', images: [img, img, img] })).status, 400); // trial allows 2
  assert.equal((await A.post('/api/analyze', { prompt: 'x', images: [{ type: 'image/svg+xml', data: 'AAAA' }] })).status, 400);
});

test('monthly cap stops AI calls for that org only, and the response carries the rate_limited code', async () => {
  const before = mock.requests.length;
  // trial cap is 20,000 tokens; push the org over it with real metered calls
  let last;
  for (let i = 0; i < 20; i++) {
    last = await A.post('/api/analyze', { prompt: 'Ticket: ' + 'word '.repeat(2500) });
    if (last.status !== 200) break;
  }
  assert.equal(last.status, 402);
  assert.equal(last.json.code, 'rate_limited');
  assert.match(last.json.error, /Monthly AI limit reached/);
  const calls = mock.requests.length - before;
  const stuck = await A.post('/api/analyze', { prompt: 'again' });
  assert.equal(stuck.status, 402);
  assert.equal(mock.requests.length - before, calls, 'no further upstream calls once capped');
  assert.equal((await B.post('/api/analyze', { prompt: 'Ticket: hi' })).status, 200, 'other org still works');
  assert.equal((await A.put('/api/c/tickets/tk4', { id: 'tk4' })).status, 200, 'rest of the app still works when capped');
});

test('plans: a plan with zero AI tokens hides AI and refuses calls; moving plans takes effect immediately', async () => {
  const F = await signup('Free Co', 'f@free.test');
  db.prepare("UPDATE orgs SET plan='free' WHERE name='Free Co'").run();
  const me = (await F.get('/api/me')).json;
  assert.equal(me.aiEnabled, false);
  assert.equal((await F.post('/api/analyze', { prompt: 'hi' })).json.code, 'not_granted');
  db.prepare("UPDATE orgs SET plan='team' WHERE name='Free Co'").run();
  assert.equal((await F.post('/api/analyze', { prompt: 'hi' })).status, 200);
  // and a capped trial org is unblocked by a plan change
  db.prepare("UPDATE orgs SET plan='team' WHERE name='Acme'").run();
  assert.equal((await A.post('/api/analyze', { prompt: 'again' })).status, 200);
});

test('document limits and sizes are enforced', async () => {
  assert.equal((await A.put('/api/c/known/n1', { title: 'x'.repeat(20_000) })).status, 413);
  assert.equal((await A.put('/api/c/nope/n1', { a: 1 })).status, 404);
  assert.equal((await A.put('/api/c/tickets/bad id!', { a: 1 })).status, 400);
  assert.equal((await A.put('/api/c/tickets/ok1', [1, 2])).status, 400);
});

test('repeated bad logins are throttled', async () => {
  const c = client();
  let status;
  for (let i = 0; i < 11; i++) status = (await c.post('/api/login', { email: 'a@acme.test', password: 'nope-nope-nope' })).status;
  assert.equal(status, 429);
});
