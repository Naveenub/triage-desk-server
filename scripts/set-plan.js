// Usage: node scripts/set-plan.js <org-id | user-email> <plan> [monthly-token-override|none]
// Use this (or your Stripe webhook, later) to move an org between plans.
import { loadConfig } from '../config.js';
import { openDb } from '../db.js';

const [who, plan, override] = process.argv.slice(2);
if (!who || !plan) {
  console.error('Usage: node scripts/set-plan.js <org-id | user-email> <plan> [token-override|none]');
  process.exit(1);
}
const config = loadConfig();
if (!config.plans[plan]) {
  console.error(`Unknown plan "${plan}". Known: ${Object.keys(config.plans).join(', ')}`);
  process.exit(1);
}
const db = openDb(config.dbPath);
const org = who.includes('@')
  ? db.prepare('SELECT o.* FROM orgs o JOIN users u ON u.org_id=o.id WHERE u.email=?').get(who.toLowerCase())
  : db.prepare('SELECT * FROM orgs WHERE id=?').get(who);
if (!org) {
  console.error('No such org or user.');
  process.exit(1);
}
const ov = override === undefined ? org.ai_tokens_override : override === 'none' ? null : Number(override);
db.prepare('UPDATE orgs SET plan=?, ai_tokens_override=? WHERE id=?').run(plan, ov, org.id);
console.log(`${org.name} (${org.id}) -> plan ${plan}${ov != null ? `, monthly tokens ${ov}` : ''}`);
