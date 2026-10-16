// Usage: node scripts/backup.js [backup-dir] [keep]
// Writes a verified snapshot of the live database. Safe to run while the server is running (cron-friendly).
import { loadConfig } from '../config.js';
import { backupNow } from '../backup.js';

const config = loadConfig();
const dir = process.argv[2] || config.backupDir;
const keep = Number(process.argv[3] || config.backupKeep);
try {
  const r = backupNow({ dbPath: config.dbPath, dir, keep });
  console.log(`backup ok: ${r.file} (${(r.bytes / 1024).toFixed(0)} KB, ${r.orgs} workspaces, ${r.pruned} old removed)`);
} catch (e) {
  console.error('BACKUP FAILED:', e.message);
  process.exit(1);
}
