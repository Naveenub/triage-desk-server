// Usage: npm run usage [YYYY-MM]
// Prints AI tokens, calls and (if PRICES_JSON is set) cost per org for a month, so you can see cost per customer.
import { loadConfig } from '../config.js';
import { openDb } from '../db.js';

const config = loadConfig();
const db = openDb(config.dbPath);
const month = process.argv[2] || new Date().toISOString().slice(0, 7);
const [y, m] = month.split('-').map(Number);
const from = Date.UTC(y, m - 1, 1), to = Date.UTC(y, m, 1);

const rows = db.prepare(`
  SELECT o.name, o.plan, u.org_id, COUNT(*) calls,
         SUM(u.input_tokens) inTok, SUM(u.output_tokens) outTok, SUM(u.cost_micro) cost,
         SUM(u.status!='ok') failed
    FROM usage u LEFT JOIN orgs o ON o.id=u.org_id
   WHERE u.ts>=? AND u.ts<? GROUP BY u.org_id ORDER BY inTok+outTok DESC`).all(from, to);

if (!rows.length) {
  console.log(`No AI usage in ${month}.`);
} else {
  const priced = Object.keys(config.prices).length > 0;
  console.table(rows.map((r) => ({
    org: r.name || `(deleted) ${r.org_id}`, plan: r.plan || '-', calls: r.calls, failed: r.failed,
    inputTokens: r.inTok, outputTokens: r.outTok,
    costUsd: priced ? Number((r.cost / 1e6).toFixed(4)) : 'set PRICES_JSON',
  })));
}
