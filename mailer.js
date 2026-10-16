// Outbound email. One tiny interface: mailer.send({ to, subject, text, html }) returns a promise.
// Providers are plain HTTPS calls, so there is no extra dependency. Adding SES or SMTP means adding one function here.

const TIMEOUT_MS = 10_000;

async function postJson(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`email provider returned ${res.status}: ${detail}`);
  }
}

const providers = {
  // https://resend.com/docs/api-reference/emails/send-email
  resend: (cfg) => (m) =>
    postJson(`${cfg.resendBaseUrl}/emails`, { authorization: `Bearer ${cfg.resendApiKey}` }, {
      from: cfg.emailFrom, to: [m.to], subject: m.subject, text: m.text, html: m.html,
    }),
  // https://postmarkapp.com/developer/api/email-api
  postmark: (cfg) => (m) =>
    postJson(`${cfg.postmarkBaseUrl}/email`, { 'x-postmark-server-token': cfg.postmarkToken }, {
      From: cfg.emailFrom, To: m.to, Subject: m.subject, TextBody: m.text, HtmlBody: m.html, MessageStream: 'outbound',
    }),
  // Development only: prints the message (including the link) instead of sending it.
  log: () => async (m) => {
    console.log(`\n[email to ${m.to}] ${m.subject}\n${m.text}\n`);
  },
};

export function createMailer(cfg) {
  const name = cfg.emailProvider;
  if (!name) return { enabled: false, send: async () => {} };
  if (!providers[name]) throw new Error(`EMAIL_PROVIDER must be one of: ${Object.keys(providers).join(', ')}`);
  const missing = [];
  if (!cfg.appUrl) missing.push('APP_URL');
  if (name !== 'log' && !cfg.emailFrom) missing.push('EMAIL_FROM');
  if (name === 'resend' && !cfg.resendApiKey) missing.push('RESEND_API_KEY');
  if (name === 'postmark' && !cfg.postmarkToken) missing.push('POSTMARK_SERVER_TOKEN');
  if (missing.length) throw new Error(`EMAIL_PROVIDER=${name} needs ${missing.join(', ')}`);
  return { enabled: true, send: providers[name](cfg) };
}

// ---------- message templates ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function layout(heading, paragraphs, link, button) {
  const html =
    `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#14232b">` +
    `<h2 style="margin:0 0 16px">${esc(heading)}</h2>` +
    paragraphs.map((p) => `<p style="line-height:1.5">${esc(p)}</p>`).join('') +
    (link
      ? `<p style="margin:24px 0"><a href="${esc(link)}" style="background:#0b6b78;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">${esc(button)}</a></p>` +
        `<p style="font-size:13px;color:#5b6b73;word-break:break-all">Or paste this into your browser:<br>${esc(link)}</p>`
      : '') +
    `</div>`;
  const text = [heading, '', ...paragraphs, ...(link ? ['', link] : [])].join('\n');
  return { html, text };
}

export function renderEmail(kind, { name, link }) {
  const hi = `Hi ${name || 'there'},`;
  if (kind === 'verify') {
    return {
      subject: 'Confirm your email for Triage Desk',
      ...layout('Confirm your email', [hi, 'Confirm this address to turn on AI analysis for your workspace. The link works once and expires in 24 hours.', 'If you did not create this account you can ignore this email.'], link, 'Confirm email'),
    };
  }
  if (kind === 'reset') {
    return {
      subject: 'Reset your Triage Desk password',
      ...layout('Reset your password', [hi, 'Someone asked to reset the password for this account. The link works once and expires in 1 hour.', 'If that was not you, ignore this email and your password stays as it is.'], link, 'Choose a new password'),
    };
  }
  if (kind === 'password_changed') {
    return {
      subject: 'Your Triage Desk password was changed',
      ...layout('Your password was changed', [hi, 'The password for your Triage Desk account was just changed and you were signed out everywhere.', 'If this was not you, reset your password now and tell your workspace admin.'], null),
    };
  }
  throw new Error(`unknown email kind ${kind}`);
}
