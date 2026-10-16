// Minimal Stripe client: the three API calls we need, plus webhook signature verification. No SDK, no dependency.
import crypto from 'node:crypto';

// Stripe's API takes form-encoded bodies with bracketed keys: line_items[0][price]=price_123
export function formEncode(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'object' ? formEncode(x, `${key}[${i}]`, out) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(x)}`)));
    else if (typeof v === 'object') formEncode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out;
}

export function createStripe(cfg) {
  const enabled = Boolean(cfg.stripeSecretKey && cfg.stripeWebhookSecret && Object.keys(cfg.stripePrices).length && cfg.appUrl);
  const priceToPlan = Object.fromEntries(Object.entries(cfg.stripePrices).map(([plan, price]) => [price, plan]));

  async function post(path, params) {
    const res = await fetch(`${cfg.stripeBaseUrl}/v1/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.stripeSecretKey}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: formEncode(params).join('&'),
      signal: AbortSignal.timeout(15_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`stripe ${path} ${res.status}: ${json.error?.message || 'request failed'}`);
    return json;
  }

  return {
    enabled,
    priceToPlan,
    createCheckout: (params) => post('checkout/sessions', params),
    createPortal: (params) => post('billing_portal/sessions', params),
  };
}

// Header looks like "t=1700000000,v1=<hex>,v1=<hex>". The signature is HMAC-SHA256 over `${t}.${rawBody}`.
// Returns the parsed event, or throws. `rawBody` must be the exact bytes Stripe sent.
export function verifyWebhook(rawBody, header, secret, { toleranceSec = 300, now = Date.now() } = {}) {
  const parts = String(header || '').split(',').map((p) => p.trim().split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !sigs.length || !Buffer.isBuffer(rawBody)) throw new Error('malformed signature header');
  if (!/^\d+$/.test(t) || Math.abs(now / 1000 - Number(t)) > toleranceSec) throw new Error('timestamp outside tolerance');
  const expected = crypto.createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
  const ok = sigs.some((s) => {
    const b = Buffer.from(s, 'hex');
    return b.length === expected.length && crypto.timingSafeEqual(b, expected);
  });
  if (!ok) throw new Error('signature mismatch');
  return JSON.parse(rawBody.toString('utf8'));
}

export function signWebhook(rawBody, secret, t = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return `t=${t},v1=${v1}`;
}
