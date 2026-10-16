# Triage Desk server

Your own accounts, tenant separation and metered AI for the Triage Desk page. The page no longer depends on the host's `claude.use("user" | "db" | "sample")`. `public/backend.js` provides those same services from this server, so the page's own code is unchanged.

## Run it

```bash
npm install
cp .env.example .env        # set ANTHROPIC_API_KEY at minimum
node --env-file=.env --disable-warning=ExperimentalWarning server.js
```

Open http://localhost:3000, create a workspace, and you are its admin. For local testing over plain http set `COOKIE_SECURE=false`. In production serve over HTTPS and set `COOKIE_SECURE=true`.

Needs Node 22.13 or newer (uses the built-in `node:sqlite`, so there is nothing native to compile). The only dependency is Express.

## What it does

| Concern | How |
|---|---|
| Sign-in | Email and password (scrypt), HttpOnly SameSite=Lax session cookie, login throttling, sign-up throttling, origin check on every write |
| Password reset and email verification | One-time links by email (see below). A reset signs the account out everywhere. With email on, AI analysis needs a confirmed address |
| Tenancy | Every ticket, KB article, known issue, correction and audit row carries the org id, and every query filters on the org of the signed-in user. Tested: one org cannot read, overwrite or delete another's data |
| Roles | `admin` (manages team), `agent` (edits, can use AI), `viewer` (read-only, cannot spend AI budget) |
| Audit log | Append-only, enforced by database triggers. `who` and `when` are stamped by the server, not the client |
| `/api/analyze` | Authenticates the org, clamps the model tier to the plan, applies redaction server-side, enforces the monthly token cap, per-minute rate limit and concurrency limit, records tokens per call |
| Live team updates | Server-sent events, with polling as a fallback |

## Email: password reset and verification

Set four variables and restart. Resend is the one tested against; Postmark is wired the same way.

```bash
EMAIL_PROVIDER=resend
RESEND_API_KEY=re_...
EMAIL_FROM="Triage Desk <no-reply@yourdomain.com>"   # the domain must be verified in the Resend dashboard
APP_URL=https://desk.yourdomain.com                   # links in emails are built from this
```

How it behaves:

- **Verification.** Sign-up and "add teammate" send a confirmation link (24 hours, one use). Until it is used, the top bar shows a reminder with a resend button and AI analysis is refused; keyword rules keep working. Existing users count as unconfirmed after you turn email on and will see the same reminder.
- **Reset.** "Forgot password?" on the sign-in dialog emails a link (1 hour, one use). Using it sets the new password, ends every session for that account, confirms the address and writes `password_reset` to the org audit log. A "your password was changed" email follows.
- **Without a provider** (`EMAIL_PROVIDER` unset) nothing changes: no gating, and "Forgot password?" tells the user to ask their admin. `EMAIL_PROVIDER=log` prints emails to the console for local testing.
- **Safety properties.** The forgot-password answer is identical for unknown and known addresses and does not wait for the provider. Tokens are 256-bit, stored only as SHA-256, and a newer link replaces an older one. Links use `APP_URL`, never the Host header, and carry the token in the `#fragment` so it stays out of server logs. Confirmation happens by POST, so mail scanners that pre-fetch links cannot use the token up. Limits: 3 reset emails per address per hour, 10 requests per IP per hour, 3 verification emails per user per hour.
- **Other senders.** SES and SMTP are not included. A provider is one function in `mailer.js` returning `send({to, subject, text, html})`.

## Cost control (this is now yours)

- Plans live in `config.js` (`free`, `trial`, `team`) and can be overridden with `PLANS_JSON`. Each has a monthly token allowance, a highest model tier, a screenshot limit and a requests-per-minute limit.
- The keyword-rules triage is free and unlimited. When an org hits its cap, the AI buttons report the limit and the rules keep working.
- `GLOBAL_MONTHLY_TOKEN_CAP` is a hard stop across all customers.
- A call is refused once used tokens plus tokens reserved by in-flight calls reach the cap. The overshoot is bounded by `MAX_CONCURRENT_AI_PER_ORG` calls.
- `npm run usage [YYYY-MM]` prints calls, failed calls and tokens per org. Fill in `PRICES_JSON` from the current price list to get dollars too. Tokens are always metered; cost is only computed from the prices you supply.

Operations:

```bash
node scripts/set-plan.js you@customer.com team          # move an org to a plan
node scripts/set-plan.js <org-id> trial 500000           # plan plus a custom monthly token allowance
node scripts/delete-org.js <org-id> --yes                # erase a customer's content on request
```

## Tests

```bash
npm test                                   # 29 tests against a mock AI (no real tokens spent)
python3 test/e2e/e2e.py                    # real-browser run (needs Playwright; start test/e2e/server.mjs first)
```

## Not built yet

These matter before you take money or real customer data:

1. **Billing.** No Stripe. Plans are changed with `set-plan.js` for now. The natural next step is a Stripe Checkout link plus a webhook that sets `orgs.plan`.
2. **SSO.** Not built. (Email verification and password reset are built: see the next section.)
3. **Scaling past one process.** The rate limiters and the live-update streams are in memory, and the database is a single SQLite file. For several instances, move to Postgres (all SQL is in `db.js`) and Redis.
4. **Backups and retention.** Back up `DB_PATH`. There is no automatic retention policy for tickets or the audit log.
5. **Legal and compliance.** A DPA, subprocessor list and privacy policy. Redaction masks emails, phones, card and ID numbers, keys, passwords and IPs, but not names or free-text details, and it cannot mask text inside screenshots.
6. **A security review of the page itself.** The page builds a lot of HTML from ticket text. It escapes it, but with multiple customers' data on one server it deserves a dedicated XSS pass.

## Changes made to the page

- Loads `backend.js` before its own script.
- CSV exports prefix cells that start with `=`, `+`, `-` or `@`, so hostile ticket text cannot become a spreadsheet formula.
- The AI error message shows the real reason when a limit is hit.
