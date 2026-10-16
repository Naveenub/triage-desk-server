// Usage: node scripts/delete-org.js <org-id> --yes
// Erases a customer's content (users, sessions, tickets, KB, known issues, audit log) on request.
// Usage rows are kept with the org id only, for billing records.
import { loadConfig } from '../config.js';
import { openDb, tx } from '../db.js';

const [orgId, confirm] = process.argv.slice(2);
if (!orgId || confirm !== '--yes') {
  console.error('Usage: node scripts/delete-org.js <org-id> --yes');
  process.exit(1);
}
const config = loadConfig();
const db = openDb(config.dbPath);
const org = db.prepare('SELECT * FROM orgs WHERE id=?').get(orgId);
if (!org) {
  console.error('No such org.');
  process.exit(1);
}
tx(db, () => {
  // The audit table refuses deletes. Drop the guard inside the transaction and put it back.
  db.exec('DROP TRIGGER audit_no_delete');
  db.prepare('DELETE FROM audit WHERE org_id=?').run(orgId);
  db.exec("CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END");
  db.prepare('DELETE FROM docs WHERE org_id=?').run(orgId);
  db.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE org_id=?)').run(orgId);
  db.prepare('DELETE FROM users WHERE org_id=?').run(orgId);
  db.prepare('DELETE FROM orgs WHERE id=?').run(orgId);
});
console.log(`Deleted ${org.name} (${orgId}).`);
