// All tunables live here. Everything can be set from environment variables (see .env.example).
export const TIERS = ['quick', 'default', 'complex']; // order matters: index = capability/cost

export function loadConfig(env = process.env, overrides = {}) {
  const num = (k, d) => (env[k] !== undefined && env[k] !== '' ? Number(env[k]) : d);
  const json = (k, d) => {
    if (!env[k]) return d;
    try { return JSON.parse(env[k]); } catch { throw new Error(`${k} is not valid JSON`); }
  };

  // Plans are the unit you sell. aiTokens = input+output tokens per calendar month (UTC).
  // aiTokens 0 means "keyword rules only": the AI buttons are hidden for that org.
  const plans = {
    free:  { aiTokens: 0,        maxTier: 'quick',   maxImages: 0, rpm: 0 },
    trial: { aiTokens: 150_000,  maxTier: 'default', maxImages: 2, rpm: 20 },
    team:  { aiTokens: 3_000_000, maxTier: 'complex', maxImages: 4, rpm: 60 },
    ...json('PLANS_JSON', {}),
  };

  const cfg = {
    port: num('PORT', 3000),
    dbPath: env.DB_PATH || './data/triage.db',
    apiKey: env.ANTHROPIC_API_KEY || '',
    anthropicBaseUrl: (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, ''),
    anthropicVersion: '2023-06-01',
    // Model IDs per tier. Override with env if you want different models.
    models: {
      quick: env.MODEL_QUICK || 'claude-haiku-5-5',
      default: env.MODEL_DEFAULT || 'claude-sonnet-5-5',
      complex: env.MODEL_COMPLEX || 'claude-opus-5-5',
    },
    // Optional USD per million tokens, e.g. {"claude-haiku-5-5":{"in":1,"out":5}}.
    // Tokens are always metered; cost is only computed if you fill this in from the current price list.
    prices: json('PRICES_JSON', {}),
    plans,
    defaultPlan: env.DEFAULT_PLAN || 'trial',
    globalMonthlyTokenCap: num('GLOBAL_MONTHLY_TOKEN_CAP', 0), // 0 = off. Hard stop across all orgs.
    maxConcurrentPerOrg: num('MAX_CONCURRENT_AI_PER_ORG', 4),
    maxPromptChars: num('MAX_PROMPT_CHARS', 40_000),
    maxImageBytes: num('MAX_IMAGE_BYTES', 5_000_000),
    signupEnabled: env.SIGNUP_ENABLED !== 'false',
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',
    trustProxy: env.TRUST_PROXY === 'true',
    allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    sessionDays: num('SESSION_DAYS', 14),
    signupsPerHourPerIp: num('SIGNUPS_PER_HOUR_PER_IP', 5),
    resetRequestsPerHourPerIp: num('RESET_REQUESTS_PER_HOUR_PER_IP', 10),
    // Email (password reset and address verification). Leave EMAIL_PROVIDER unset to run without email.
    emailProvider: env.EMAIL_PROVIDER || '',          // resend | postmark | log
    emailFrom: env.EMAIL_FROM || '',                  // e.g. "Triage Desk <no-reply@yourdomain.com>" (domain must be verified with the provider)
    appUrl: (env.APP_URL || '').replace(/\/$/, ''),    // public https URL, used for links in emails (never taken from the request)
    resendApiKey: env.RESEND_API_KEY || '',
    resendBaseUrl: (env.RESEND_BASE_URL || 'https://api.resend.com').replace(/\/$/, ''),
    postmarkToken: env.POSTMARK_SERVER_TOKEN || '',
    postmarkBaseUrl: (env.POSTMARK_BASE_URL || 'https://api.postmarkapp.com').replace(/\/$/, ''),
    verifyTokenHours: num('VERIFY_TOKEN_HOURS', 24),
    resetTokenMinutes: num('RESET_TOKEN_MINUTES', 60),
    // Per-collection limits so one tenant cannot fill the disk.
    docLimits: {
      tickets: { max: 5000, bytes: 64 * 1024 },
      kb: { max: 1000, bytes: 64 * 1024 },
      known: { max: 500, bytes: 16 * 1024 },
      corrections: { max: 5, bytes: 256 * 1024 },
    },
  };
  return { ...cfg, ...overrides };
}
