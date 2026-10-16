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
| Tenancy | Every ticket, KB article, known issue, correction and audit row carries the org id, and every query filters on the org of the signed-in user. Tested: one org cannot read, overwrite or delete another's data |
| Roles | `admin` (manages team), `agent` (edits, can use AI), `viewer` (read-only, cannot spend AI budget) |
| Audit log | Append-only, enforced by database triggers. `who` and `when` are stamped by the server, not the client |
| `/api/analyze` | Authenticates the org, clamps the model tier to the plan, applies redaction server-side, enforces the monthly token cap, per-minute rate limit and concurrency limit, records tokens per call |
| Live team updates | Server-sent events, with polling as a fallback |

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
npm test                                   # 15 API tests against a mock AI (no real tokens spent)
python3 test/e2e/e2e.py                    # real-browser run (needs Playwright; start test/e2e/server.mjs first)
```

## Not built yet

These matter before you take money or real customer data:

1. **Billing.** No Stripe. Plans are changed with `set-plan.js` for now. The natural next step is a Stripe Checkout link plus a webhook that sets `orgs.plan`.
2. **Email verification, password reset, SSO.** Sign-up accepts any email address, and a forgotten password currently needs you to reset it by hand. Set `SIGNUP_ENABLED=false` for invite-only until this exists.
3. **Scaling past one process.** The rate limiters and the live-update streams are in memory, and the database is a single SQLite file. For several instances, move to Postgres (all SQL is in `db.js`) and Redis.
4. **Backups and retention.** Back up `DB_PATH`. There is no automatic retention policy for tickets or the audit log.
5. **Legal and compliance.** A DPA, subprocessor list and privacy policy. Redaction masks emails, phones, card and ID numbers, keys, passwords and IPs, but not names or free-text details, and it cannot mask text inside screenshots.
6. **A security review of the page itself.** The page builds a lot of HTML from ticket text. It escapes it, but with multiple customers' data on one server it deserves a dedicated XSS pass.

## Changes made to the page

- Loads `backend.js` before its own script.
- CSV exports prefix cells that start with `=`, `+`, `-` or `@`, so hostile ticket text cannot become a spreadsheet formula.
- The AI error message shows the real reason when a limit is hit.
