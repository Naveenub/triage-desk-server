import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeStore, monthStart } from './db.js';
import {
  hashPassword, verifyPassword, DUMMY_HASH, newId, newToken, hashToken, parseCookies, Limiter,
} from './auth.js';
import { callModel, extractJson, UpstreamError } from './anthropic.js';
import { redact } from './redact.js';
import { TIERS } from './config.js';
import { createMailer, renderEmail } from './mailer.js';
import { createStripe, verifyWebhook } from './stripe.js';

const here = dirname(fileURLToPath(import.meta.url));
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const IMG_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const COOKIE = 'td_sid';

export function createApp({ config, db, mailer = createMailer(config), stripe = createStripe(config) }) {
  const store = makeStore(db);
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  const loginLimiter = new Limiter(10, 15 * 60_000);   // failed logins per email+ip
  const signupLimiter = new Limiter(config.signupsPerHourPerIp, 60 * 60_000);   // signups per ip
  const forgotIpLimiter = new Limiter(config.resetRequestsPerHourPerIp, 60 * 60_000);    // reset requests per ip
  const forgotEmailLimiter = new Limiter(3, 60 * 60_000);  // reset emails per address (extra requests are silently dropped)
  const resetLimiter = new Limiter(20, 15 * 60_000);       // reset/verify token attempts per ip
  const verifySendLimiter = new Limiter(3, 60 * 60_000);   // verification emails per user
  const aiLimiter = new Limiter(60, 60_000);           // AI calls per org per minute (max comes from plan)
  const inflight = new Map();                          // orgId -> { n, tokens } reserved for running calls
  const streams = new Map();                           // orgId -> Set(res) for live updates
  const sweeper = setInterval(() => {
    loginLimiter.sweep(); signupLimiter.sweep(); aiLimiter.sweep(); store.purgeSessions();
    forgotIpLimiter.sweep(); forgotEmailLimiter.sweep(); resetLimiter.sweep(); verifySendLimiter.sweep(); store.purgeEmailTokens(); store.purgeStripeEvents();
  }, 10 * 60_000);
  sweeper.unref();

  const fail = (res, status, code, error) => res.status(status).json({ code, error });
  const planOf = (org) => config.plans[org.plan] || config.plans[config.defaultPlan];
  const capOf = (org) => (org.ai_tokens_override ?? planOf(org).aiTokens);

  // ---------- headers, origin check ----------
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    });
    next();
  });
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const origin = req.get('origin');
    if (origin) {
      let ok = config.allowedOrigins.includes(origin);
      try { ok = ok || new URL(origin).host === req.get('host'); } catch { ok = false; }
      if (!ok) return fail(res, 403, 'bad_origin', 'Cross-site request blocked');
    }
    next();
  });

  app.use(express.static(join(here, 'public')));

  const small = express.json({ limit: '300kb' });
  const big = express.json({ limit: '25mb' });

  // ---------- sessions ----------
  function setCookie(res, token) {
    const maxAge = config.sessionDays * 86400;
    res.append('Set-Cookie',
      `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${config.cookieSecure ? '; Secure' : ''}`);
  }
  function clearCookie(res) {
    res.append('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${config.cookieSecure ? '; Secure' : ''}`);
  }
  function startSession(res, userId) {
    const token = newToken();
    store.createSession(hashToken(token), userId, Date.now() + config.sessionDays * 86400_000);
    setCookie(res, token);
  }

  function requireAuth(req, res, next) {
    const token = parseCookies(req.get('cookie'))[COOKIE];
    if (!token) return fail(res, 401, 'unauthenticated', 'Not signed in');
    const h = hashToken(token);
    const s = store.sessionByHash(h);
    if (!s || s.expires_at < Date.now() || s.disabled) {
      if (s) store.deleteSession(h);
      return fail(res, 401, 'unauthenticated', 'Not signed in');
    }
    if (s.expires_at - Date.now() < config.sessionDays * 43200_000) { // under half left: slide forward
      store.extendSession(h, Date.now() + config.sessionDays * 86400_000);
      setCookie(res, token);
    }
    req.tokenHash = h;
    req.user = { id: s.uid, email: s.email, name: s.uname, role: s.role, emailVerified: Boolean(s.email_verified_at) };
    req.org = { id: s.oid, name: s.oname, plan: s.plan, ai_tokens_override: s.ai_tokens_override, redact_server: s.redact_server };
    next();
  }
  const requireWrite = (req, res, next) =>
    req.user.role === 'viewer' ? fail(res, 403, 'read_only', 'Your role is read-only') : next();
  const requireAdmin = (req, res, next) =>
    req.user.role !== 'admin' ? fail(res, 403, 'admin_only', 'Admins only') : next();

  // ---------- usage ----------
  function costMicro(model, inTok, outTok) {
    const p = config.prices[model];
    return p ? Math.round(inTok * (p.in || 0) + outTok * (p.out || 0)) : 0; // USD per Mtok == micro-USD per token
  }
  function usageSummary(org) {
    const u = store.monthUsage(org.id, monthStart());
    const plan = planOf(org);
    return {
      month: new Date(monthStart()).toISOString().slice(0, 7),
      plan: org.plan,
      used: u.tokens,
      cap: capOf(org),
      calls: u.calls,
      avgTokensPerCall: u.calls ? Math.round(u.tokens / u.calls) : 0,
      costUsd: Object.keys(config.prices).length ? u.cost_micro / 1e6 : null,
      maxTier: plan.maxTier,
    };
  }
  const aiEnabled = (org) => Boolean(config.apiKey) && capOf(org) > 0;
  // With email configured, AI spend needs a confirmed address. Without email configured, nothing is gated.
  const needsVerify = (user) => mailer.enabled && !user.emailVerified;

  // ---------- billing ----------
  const ACTIVE = new Set(['active', 'trialing', 'past_due']);   // paid access continues (past_due: Stripe is still retrying the card)
  const ENDED = new Set(['canceled', 'unpaid', 'incomplete_expired']);
  function billingSummary(req) {
    if (!stripe.enabled) return { enabled: false };
    const o = store.orgById(req.org.id);
    return {
      enabled: true,
      plans: Object.keys(config.stripePrices),
      status: o.stripe_status || null,
      subscribed: ACTIVE.has(o.stripe_status || ''),
      canManage: Boolean(o.stripe_customer_id),
      periodEnd: o.stripe_period_end || null,
    };
  }

  // Admin starts a subscription. The org id travels with the Stripe objects as metadata, which is how the
  // webhook finds the org again. The plan is NOT changed here: only a signed webhook from Stripe changes plans.
  app.post('/api/billing/checkout', requireAuth, requireAdmin, small, async (req, res) => {
    if (!stripe.enabled) return fail(res, 503, 'billing_disabled', 'Billing is not set up on this server');
    const plan = (req.body || {}).plan;
    if (typeof plan !== 'string' || !Object.hasOwn(config.stripePrices, plan)) return fail(res, 400, 'bad_request', 'Unknown plan');
    const org = store.orgById(req.org.id);
    if (ACTIVE.has(org.stripe_status || '')) return fail(res, 409, 'already_subscribed', 'This workspace already has a subscription. Use Manage billing to change it.');
    try {
      const session = await stripe.createCheckout({
        mode: 'subscription',
        line_items: [{ price: config.stripePrices[plan], quantity: 1 }],
        client_reference_id: org.id,
        ...(org.stripe_customer_id ? { customer: org.stripe_customer_id } : { customer_email: req.user.email }),
        metadata: { org_id: org.id },
        subscription_data: { metadata: { org_id: org.id } },
        success_url: `${config.appUrl}/#billing=success`,
        cancel_url: `${config.appUrl}/#billing=cancel`,
      });
      res.json({ url: session.url });
    } catch (e) {
      console.error(e.message);
      fail(res, 502, 'upstream_error', 'Could not reach the payment provider. Try again.');
    }
  });

  // Stripe-hosted page to change plan, update the card, see invoices or cancel.
  app.post('/api/billing/portal', requireAuth, requireAdmin, async (req, res) => {
    if (!stripe.enabled) return fail(res, 503, 'billing_disabled', 'Billing is not set up on this server');
    const org = store.orgById(req.org.id);
    if (!org.stripe_customer_id) return fail(res, 400, 'no_customer', 'This workspace has no billing account yet');
    try {
      const s = await stripe.createPortal({ customer: org.stripe_customer_id, return_url: `${config.appUrl}/` });
      res.json({ url: s.url });
    } catch (e) {
      console.error(e.message);
      fail(res, 502, 'upstream_error', 'Could not open the billing portal. Try again.');
    }
  });

  function applySubscription(sub, eventAt) {
    const org = (sub.metadata && sub.metadata.org_id && store.orgById(sub.metadata.org_id)) || store.orgByStripeCustomer(sub.customer);
    if (!org) { console.error('stripe: subscription for unknown org', sub.id); return; }
    if (org.stripe_event_at && eventAt < org.stripe_event_at) return; // an older event arriving late must not undo a newer one
    const active = ACTIVE.has(sub.status), ended = ENDED.has(sub.status);
    // The end of some OTHER (older) subscription must not cancel the one the org is on now.
    if (ended && org.stripe_subscription_id && org.stripe_subscription_id !== sub.id) return;
    const item = sub.items && sub.items.data && sub.items.data[0];
    const periodEnd = (sub.current_period_end ?? (item && item.current_period_end) ?? null);
    const base = { customerId: sub.customer, subscriptionId: sub.id, status: sub.status, periodEnd: periodEnd ? periodEnd * 1000 : null, eventAt };
    if (active) {
      const plan = stripe.priceToPlan[item && item.price && item.price.id];
      if (!plan) { console.error('stripe: subscription', sub.id, 'has a price that is not in STRIPE_PRICES_JSON; plan left unchanged'); return; }
      store.updateOrgBilling(org.id, { ...base, plan });
      if (plan !== org.plan) store.addAudit(org.id, { by: 'stripe', act: 'plan_changed', d: `${org.plan} to ${plan}` });
    } else if (ended) {
      store.updateOrgBilling(org.id, { ...base, subscriptionId: null, plan: config.billingDowngradePlan });
      store.addAudit(org.id, { by: 'stripe', act: 'plan_changed', d: `${org.plan} to ${config.billingDowngradePlan}` });
    } else if (!org.stripe_subscription_id || org.stripe_subscription_id === sub.id) {
      // e.g. incomplete: record the status only, and never let a not-yet-paid subscription hide a working one
      store.updateOrgBilling(org.id, { ...base, subscriptionId: org.stripe_subscription_id, periodEnd: org.stripe_period_end });
    }
  }

  // Needs the exact bytes Stripe signed, so it reads the body raw instead of through express.json.
  app.post('/api/stripe/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    if (!stripe.enabled) return fail(res, 503, 'billing_disabled', 'Billing is not set up');
    let event;
    try { event = verifyWebhook(req.body, req.get('stripe-signature'), config.stripeWebhookSecret); }
    catch (e) { return fail(res, 400, 'bad_signature', 'Invalid signature'); }
    try {
      store.processStripeEvent(event.id, () => {
        const obj = event.data && event.data.object;
        if (!obj) return;
        if (event.type === 'checkout.session.completed') {
          const orgId = obj.client_reference_id || (obj.metadata && obj.metadata.org_id);
          if (orgId && store.orgById(orgId)) store.linkOrgStripe(orgId, obj.customer, obj.subscription);
        } else if (event.type.startsWith('customer.subscription.')) {
          applySubscription(obj, event.created * 1000);
        }
      });
      res.json({ received: true });
    } catch (e) {
      console.error('stripe webhook failed', e); // 500 makes Stripe retry later
      res.status(500).json({ code: 'server_error', error: 'retry' });
    }
  });

  // ---------- email ----------
  // Tokens are random, single use and stored only as a hash. Links use the configured APP_URL (never the Host
  // header, which an attacker controls) and put the token in the #fragment so it stays out of server logs.
  function sendTokenEmail(user, purpose) {
    const token = newToken();
    const ttl = purpose === 'verify' ? config.verifyTokenHours * 3600_000 : config.resetTokenMinutes * 60_000;
    store.createEmailToken({ hash: hashToken(token), userId: user.id, purpose, email: user.email, expiresAt: Date.now() + ttl });
    const msg = renderEmail(purpose, { name: user.name, link: `${config.appUrl}/#${purpose === 'verify' ? 'verify' : 'reset'}=${token}` });
    return sendMail(user.email, msg);
  }
  // Fire and forget: the HTTP response never waits on the provider, so timing cannot reveal whether an address exists.
  function sendMail(to, msg) {
    return Promise.resolve()
      .then(() => mailer.send({ to, ...msg }))
      .catch((e) => console.error('email send failed:', e.message));
  }

  // ---------- auth routes ----------
  const validPassword = (p) => typeof p === 'string' && p.length >= 10 && p.length <= 200;
  const clean = (s, max) => String(s ?? '').trim().slice(0, max);

  app.post('/api/signup', small, async (req, res) => {
    if (!config.signupEnabled) return fail(res, 403, 'signup_closed', 'Sign-ups are closed');
    if (!signupLimiter.take(req.ip)) return fail(res, 429, 'rate_limited', 'Too many sign-ups from this address. Try again later.');
    const b = req.body || {};
    const email = clean(b.email, 255).toLowerCase(), name = clean(b.name, 80), orgName = clean(b.orgName, 80);
    if (!EMAIL_RE.test(email)) return fail(res, 400, 'bad_email', 'Enter a valid email address');
    if (name.length < 1 || orgName.length < 2) return fail(res, 400, 'bad_request', 'Enter your name and a workspace name');
    if (!validPassword(b.password)) return fail(res, 400, 'weak_password', 'Use a password of at least 10 characters');
    if (store.userByEmail(email)) return fail(res, 409, 'email_taken', 'That email already has an account. Sign in instead.');
    const userId = newId('u_');
    store.createOrgWithAdmin({
      orgId: newId('o_'), userId, orgName, email, name,
      pwHash: await hashPassword(b.password), plan: config.defaultPlan,
    });
    startSession(res, userId);
    if (mailer.enabled) sendTokenEmail({ id: userId, email, name }, 'verify');
    res.status(201).json({ ok: true });
  });

  app.post('/api/login', small, async (req, res) => {
    const b = req.body || {};
    const email = clean(b.email, 255).toLowerCase();
    const key = `${email}|${req.ip}`;
    if (loginLimiter.count(key) >= 10) return fail(res, 429, 'rate_limited', 'Too many failed attempts. Try again in 15 minutes.');
    const u = store.userByEmail(email);
    const ok = await verifyPassword(String(b.password ?? ''), u ? u.pw_hash : DUMMY_HASH);
    if (!u || u.disabled || !ok) {
      loginLimiter.take(key);
      return fail(res, 401, 'bad_credentials', 'Incorrect email or password');
    }
    loginLimiter.clear(key);
    startSession(res, u.id);
    res.json({ ok: true });
  });

  // ---------- password reset and email verification ----------
  const isToken = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{20,100}$/.test(t);

  // Always answers the same way, whether or not the address has an account.
  app.post('/api/password/forgot', small, (req, res) => {
    if (!mailer.enabled) return fail(res, 503, 'email_disabled', 'Password reset by email is not set up on this server. Ask your workspace admin.');
    if (!forgotIpLimiter.take(req.ip)) return fail(res, 429, 'rate_limited', 'Too many requests. Try again later.');
    const email = clean((req.body || {}).email, 255).toLowerCase();
    if (EMAIL_RE.test(email) && forgotEmailLimiter.take(email)) {
      const u = store.userByEmail(email);
      if (u && !u.disabled) sendTokenEmail(u, 'reset');
    }
    res.json({ ok: true });
  });

  app.post('/api/password/reset', small, async (req, res) => {
    if (!resetLimiter.take(req.ip)) return fail(res, 429, 'rate_limited', 'Too many attempts. Try again later.');
    const b = req.body || {};
    if (!isToken(b.token) || !store.emailTokenValid(hashToken(b.token), 'reset')) {
      return fail(res, 400, 'bad_token', 'This reset link is invalid or has expired. Request a new one.');
    }
    if (!validPassword(b.password)) return fail(res, 400, 'weak_password', 'Use a password of at least 10 characters');
    const pwHash = await hashPassword(b.password);
    const u = store.useEmailToken(hashToken(b.token), 'reset', (user) => {
      store.setPassword(user.id, pwHash);
      store.markVerified(user.id); // they received mail at this address, which proves they own it
      store.addAudit(user.org_id, { by: user.id, act: 'password_reset' });
    });
    if (!u) return fail(res, 400, 'bad_token', 'This reset link is invalid or has expired. Request a new one.');
    sendMail(u.email, renderEmail('password_changed', { name: u.name }));
    res.json({ ok: true });
  });

  // POST rather than GET, so mail scanners that pre-fetch links cannot use up the token.
  app.post('/api/email/verify', small, (req, res) => {
    if (!resetLimiter.take(req.ip)) return fail(res, 429, 'rate_limited', 'Too many attempts. Try again later.');
    const b = req.body || {};
    const u = isToken(b.token) && store.useEmailToken(hashToken(b.token), 'verify', (user) => store.markVerified(user.id));
    if (!u) return fail(res, 400, 'bad_token', 'This confirmation link is invalid or has expired. Sign in and ask for a new one.');
    res.json({ ok: true });
  });

  app.post('/api/email/send-verification', requireAuth, (req, res) => {
    if (!mailer.enabled) return fail(res, 503, 'email_disabled', 'Email is not set up on this server');
    if (req.user.emailVerified) return res.json({ ok: true, alreadyVerified: true });
    if (!verifySendLimiter.take(req.user.id)) return fail(res, 429, 'rate_limited', 'Too many emails requested. Try again in an hour.');
    sendTokenEmail(req.user, 'verify');
    res.json({ ok: true });
  });

  app.post('/api/logout', requireAuth, (req, res) => {
    store.deleteSession(req.tokenHash);
    clearCookie(res);
    res.json({ ok: true });
  });

  app.get('/api/me', requireAuth, (req, res) => {
    const plan = planOf(req.org);
    res.json({
      user: req.user,
      org: { id: req.org.id, name: req.org.name, plan: req.org.plan },
      aiEnabled: aiEnabled(req.org) && !needsVerify(req.user),
      email: { enabled: mailer.enabled, verified: req.user.emailVerified },
      billing: billingSummary(req),
      limits: { maxImages: plan.maxImages },
      usage: usageSummary(req.org),
    });
  });

  app.get('/api/usage', requireAuth, (req, res) => res.json(usageSummary(req.org)));

  // ---------- team ----------
  app.get('/api/team', requireAuth, (req, res) => res.json(store.listTeam(req.org.id)));

  app.post('/api/team', requireAuth, requireAdmin, small, async (req, res) => {
    const b = req.body || {};
    const email = clean(b.email, 255).toLowerCase(), name = clean(b.name, 80);
    const role = ['admin', 'agent', 'viewer'].includes(b.role) ? b.role : 'agent';
    if (!EMAIL_RE.test(email)) return fail(res, 400, 'bad_email', 'Enter a valid email address');
    if (!name) return fail(res, 400, 'bad_request', 'Enter a name');
    if (!validPassword(b.password)) return fail(res, 400, 'weak_password', 'Use a temporary password of at least 10 characters');
    if (store.userByEmail(email)) return fail(res, 409, 'email_taken', 'That email already has an account');
    const id = newId('u_');
    store.createUser({ id, orgId: req.org.id, email, name, role, pwHash: await hashPassword(b.password) });
    if (mailer.enabled) sendTokenEmail({ id, email, name }, 'verify');
    store.addAudit(req.org.id, { by: req.user.id, act: 'user_added', d: `${role}` });
    res.status(201).json({ id, email, name, role });
  });

  app.delete('/api/team/:id', requireAuth, requireAdmin, (req, res) => {
    const target = store.userInOrg(req.org.id, req.params.id); // org-scoped lookup: other tenants' ids are "not found"
    if (!target || target.disabled) return fail(res, 404, 'not_found', 'No such user');
    if (target.id === req.user.id) return fail(res, 400, 'bad_request', 'You cannot remove yourself');
    if (target.role === 'admin' && store.adminCount(req.org.id) <= 1) return fail(res, 400, 'bad_request', 'Keep at least one admin');
    store.disableUser(req.org.id, target.id);
    store.addAudit(req.org.id, { by: req.user.id, act: 'user_removed', d: target.role });
    res.json({ ok: true });
  });

  // ---------- live updates (server-sent events) ----------
  function broadcast(orgId, coll) {
    const set = streams.get(orgId);
    if (!set) return;
    for (const r of set) r.write(`data: ${JSON.stringify({ c: coll })}\n\n`);
  }
  app.get('/api/events', requireAuth, (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const orgId = req.org.id;
    if (!streams.has(orgId)) streams.set(orgId, new Set());
    streams.get(orgId).add(res);
    const beat = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(beat);
      const set = streams.get(orgId);
      if (set) { set.delete(res); if (!set.size) streams.delete(orgId); }
    });
  });

  // ---------- collections (every query is scoped by the signed-in user's org) ----------
  const parse = (row) => ({ id: row.id, data: JSON.parse(row.data) });
  const isPlainObject = (x) => x && typeof x === 'object' && !Array.isArray(x);

  function collOr404(req, res, next) {
    const c = req.params.coll;
    if (c === 'audit' || config.docLimits[c]) return next();
    return fail(res, 404, 'not_found', 'Unknown collection');
  }

  app.get('/api/c/:coll', requireAuth, collOr404, (req, res) => {
    const { coll } = req.params;
    if (coll === 'audit') {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
      return res.json(store.listAudit(req.org.id, limit).map((r) => ({
        id: String(r.seq), data: { at: r.at, by: r.by, act: r.act, tid: r.tid || '', d: r.d || '' },
      })));
    }
    res.json(store.listDocs(req.org.id, coll).map(parse));
  });

  // Append-only: no PUT, PATCH or DELETE exists for audit. `by` and `at` come from the server, never the client.
  app.post('/api/c/audit', requireAuth, small, (req, res) => {
    const b = req.body || {};
    const act = clean(b.act, 64);
    if (!/^[a-z_]{1,64}$/.test(act)) return fail(res, 400, 'bad_request', 'Invalid action');
    store.addAudit(req.org.id, { by: req.user.id, act, tid: clean(b.tid, 64), d: clean(b.d, 200) });
    broadcast(req.org.id, 'audit');
    res.status(201).json({ ok: true });
  });
  app.all('/api/c/audit/:id', requireAuth, (req, res) => fail(res, 405, 'append_only', 'The audit log is append-only'));

  app.get('/api/c/:coll/:id', requireAuth, collOr404, (req, res) => {
    const { coll, id } = req.params;
    if (coll === 'audit' || !ID_RE.test(id)) return fail(res, 404, 'not_found', 'Not found');
    const row = store.getDoc(req.org.id, coll, id);
    if (!row) return fail(res, 404, 'not_found', 'Not found');
    res.json(parse(row).data);
  });

  function checkDoc(res, coll, data) {
    const lim = config.docLimits[coll];
    if (!isPlainObject(data)) { fail(res, 400, 'bad_request', 'Body must be a JSON object'); return null; }
    const json = JSON.stringify(data);
    if (json.length > lim.bytes) { fail(res, 413, 'too_large', 'Document too large'); return null; }
    return json;
  }

  app.put('/api/c/:coll/:id', requireAuth, requireWrite, collOr404, small, (req, res) => {
    const { coll, id } = req.params;
    if (!ID_RE.test(id)) return fail(res, 400, 'bad_request', 'Invalid id');
    if (!config.docLimits[coll]) return fail(res, 404, 'not_found', 'Unknown collection');
    const existing = store.getDoc(req.org.id, coll, id);
    const data = req.body;
    if (isPlainObject(data) && coll === 'tickets') {
      data.createdBy = existing ? JSON.parse(existing.data).createdBy || req.user.id : req.user.id; // not client-controlled
    }
    const json = checkDoc(res, coll, data);
    if (json === null) return;
    if (!existing && store.countDocs(req.org.id, coll) >= config.docLimits[coll].max) {
      return fail(res, 409, 'limit_reached', `This workspace has reached its limit of ${config.docLimits[coll].max} ${coll}. Delete some to add more.`);
    }
    store.putDoc(req.org.id, coll, id, json);
    broadcast(req.org.id, coll);
    res.json({ ok: true });
  });

  app.patch('/api/c/:coll/:id', requireAuth, requireWrite, collOr404, small, (req, res) => {
    const { coll, id } = req.params;
    if (!config.docLimits[coll] || !ID_RE.test(id)) return fail(res, 404, 'not_found', 'Not found');
    const row = store.getDoc(req.org.id, coll, id);
    if (!row) return fail(res, 404, 'not_found', 'Not found');
    if (!isPlainObject(req.body)) return fail(res, 400, 'bad_request', 'Body must be a JSON object');
    const merged = { ...JSON.parse(row.data), ...req.body };
    if (coll === 'tickets') merged.createdBy = JSON.parse(row.data).createdBy || merged.createdBy;
    const json = checkDoc(res, coll, merged);
    if (json === null) return;
    store.putDoc(req.org.id, coll, id, json);
    broadcast(req.org.id, coll);
    res.json({ ok: true });
  });

  app.delete('/api/c/:coll/:id', requireAuth, requireWrite, collOr404, (req, res) => {
    const { coll, id } = req.params;
    if (!config.docLimits[coll] || !ID_RE.test(id)) return fail(res, 404, 'not_found', 'Not found');
    store.deleteDoc(req.org.id, coll, id);
    broadcast(req.org.id, coll);
    res.json({ ok: true });
  });

  // ---------- metered AI endpoint ----------
  app.post('/api/analyze', requireAuth, requireWrite, big, async (req, res) => {
    const { org, user } = req;
    const plan = planOf(org);
    const b = req.body || {};
    if (typeof b.prompt !== 'string' || !b.prompt.trim()) return fail(res, 400, 'bad_request', 'A prompt is required');
    if (b.prompt.length > config.maxPromptChars) return fail(res, 413, 'too_large', 'That ticket is too long to analyze');
    if (!config.apiKey) return fail(res, 503, 'not_granted', 'AI analysis is not configured on this server');
    if (needsVerify(user)) return fail(res, 403, 'not_granted', 'Confirm your email address to use AI analysis. Check your inbox for the link.');
    const cap = capOf(org);
    if (cap <= 0) return fail(res, 403, 'not_granted', 'AI analysis is not included in your plan');

    const images = [];
    for (const img of Array.isArray(b.images) ? b.images : []) {
      if (!img || !IMG_TYPES.has(img.type) || typeof img.data !== 'string') return fail(res, 400, 'bad_request', 'Unsupported image');
      if (img.data.length * 0.75 > config.maxImageBytes) return fail(res, 413, 'too_large', 'An image is too large');
      images.push({ type: img.type, data: img.data });
    }
    if (images.length > plan.maxImages) return fail(res, 400, 'bad_request', `Your plan allows ${plan.maxImages} screenshots per ticket`);

    // Tier is clamped to what the plan allows. A client cannot buy a more expensive model than it pays for.
    const wanted = TIERS.includes(b.tier) ? b.tier : 'default';
    const tier = TIERS[Math.min(TIERS.indexOf(wanted), TIERS.indexOf(plan.maxTier))];
    const model = config.models[tier];

    if (!aiLimiter.take(org.id, plan.rpm || 1)) return fail(res, 429, 'rate_limited', 'Too many AI requests. Wait a moment and try again.');
    const since = monthStart();
    const used = store.monthUsage(org.id, since).tokens;
    const cur = inflight.get(org.id) || { n: 0, tokens: 0 };
    if (used + cur.tokens >= cap) {
      return fail(res, 402, 'rate_limited', `Monthly AI limit reached (${used.toLocaleString('en-US')} of ${cap.toLocaleString('en-US')} tokens). Keyword rules still work.`);
    }
    if (config.globalMonthlyTokenCap && store.globalMonthTokens(since) >= config.globalMonthlyTokenCap) {
      return fail(res, 503, 'rate_limited', 'AI analysis is temporarily unavailable');
    }
    if (cur.n >= config.maxConcurrentPerOrg) return fail(res, 429, 'rate_limited', 'Too many AI requests at once. Wait a moment.');

    const bulk = b.prompt.includes('JSON array of tickets');
    const maxTokens = bulk ? 7000 : 1800;
    const prompt = org.redact_server ? redact(b.prompt) : b.prompt; // enforced here, not just in the browser
    const reserve = Math.ceil(prompt.length / 3) + images.length * 1600 + maxTokens;
    inflight.set(org.id, { n: cur.n + 1, tokens: cur.tokens + reserve });

    let out;
    try {
      out = await callModel({ config, model, prompt, images, maxTokens });
    } catch (e) {
      store.addUsage({ orgId: org.id, userId: user.id, kind: bulk ? 'bulk' : 'single', model, tier, inTok: 0, outTok: 0, status: 'upstream_error' });
      console.error('anthropic call failed', e instanceof UpstreamError ? `${e.status} ${e.detail}` : e);
      const busy = e instanceof UpstreamError && (e.status === 429 || e.status === 529);
      return fail(res, busy ? 503 : 502, busy ? 'rate_limited' : 'upstream_error',
        busy ? 'The AI service is busy. Try again shortly.' : 'The AI service failed. Try again.');
    } finally {
      const c = inflight.get(org.id);
      if (c) {
        const n = c.n - 1, tokens = c.tokens - reserve;
        if (n <= 0) inflight.delete(org.id); else inflight.set(org.id, { n, tokens: Math.max(0, tokens) });
      }
    }

    const inTok = out.usage.input_tokens || 0, outTok = out.usage.output_tokens || 0;
    const parsed = extractJson(out.text);
    store.addUsage({
      orgId: org.id, userId: user.id, kind: bulk ? 'bulk' : 'single', model, tier, inTok, outTok,
      costMicro: costMicro(model, inTok, outTok), status: parsed === null ? 'bad_output' : 'ok',
    });
    if (parsed === null) return fail(res, 422, 'bad_output', 'The AI returned an answer that could not be read. Try again.');
    res.json({ json: parsed, usage: usageSummary(org) });
  });

  app.use('/api', (req, res) => fail(res, 404, 'not_found', 'Not found'));
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') return fail(res, 413, 'too_large', 'Request too large');
    if (err && err.type === 'entity.parse.failed') return fail(res, 400, 'bad_request', 'Invalid JSON');
    console.error(err);
    fail(res, 500, 'server_error', 'Something went wrong');
  });

  return app;
}
