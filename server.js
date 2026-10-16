import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { createMailer } from './mailer.js';
import { createStripe } from './stripe.js';

const config = loadConfig();
const db = openDb(config.dbPath);
const mailer = createMailer(config); // throws at startup if email is half-configured
const stripe = createStripe(config);
const anyStripe = [config.stripeSecretKey, config.stripeWebhookSecret, Object.keys(config.stripePrices).length].filter(Boolean).length;
if (anyStripe && !stripe.enabled) {
  throw new Error('Billing needs STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, a price (STRIPE_PRICE_TEAM or STRIPE_PRICES_JSON) and APP_URL, all together');
}
for (const plan of Object.keys(config.stripePrices)) {
  if (!config.plans[plan]) throw new Error(`STRIPE_PRICES_JSON names plan "${plan}", which is not defined in config.plans`);
}
if (!config.plans[config.billingDowngradePlan]) throw new Error(`BILLING_DOWNGRADE_PLAN "${config.billingDowngradePlan}" is not a defined plan`);
const app = createApp({ config, db, mailer, stripe });
if (!stripe.enabled) console.warn('Stripe is not configured: plans change only with scripts/set-plan.js.');
if (!mailer.enabled) console.warn('EMAIL_PROVIDER is not set: password reset and email verification are off.');
if (config.emailProvider === 'log') console.warn('EMAIL_PROVIDER=log prints emails (with their links) to this console. Development only.');

if (!config.apiKey) console.warn('ANTHROPIC_API_KEY is not set: AI analysis is off, keyword rules still work.');
if (process.env.NODE_ENV === 'production' && !config.cookieSecure) {
  console.warn('COOKIE_SECURE is false in production. Serve over HTTPS and set COOKIE_SECURE=true.');
}

const server = app.listen(config.port, () => {
  console.log(`Triage Desk listening on http://localhost:${config.port}`);
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => { db.close(); process.exit(0); }));
}
