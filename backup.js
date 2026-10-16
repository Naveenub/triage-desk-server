// SQLite backups. VACUUM INTO writes a consistent snapshot of the live database (WAL included) without stopping
// the server or blocking readers. Each snapshot is opened and checked before it counts, then old ones are pruned.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, unlinkSync, chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';

const NAME = /^triage-\d{8}-\d{6}\.db$/;

const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15); // 20261016-114500

export function backupNow({ dbPath, dir, keep = 14, now = new Date() }) {
  if (dbPath === ':memory:') throw new Error('cannot back up an in-memory database');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `triage-${stamp(now)}.db`);
  const src = new DatabaseSync(dbPath, { readOnly: true });
  try {
    src.exec('PRAGMA busy_timeout=10000');
    src.prepare('VACUUM INTO ?').run(file);
  } finally { src.close(); }
  chmodSync(file, 0o600); // holds password hashes and customer data

  const copy = new DatabaseSync(file, { readOnly: true });
  try {
    const check = copy.prepare('PRAGMA integrity_check').get().integrity_check;
    if (check !== 'ok') throw new Error(`backup ${file} failed integrity_check: ${check}`);
    const orgs = copy.prepare('SELECT COUNT(*) n FROM orgs').get().n;
    return { file, bytes: statSync(file).size, orgs, pruned: prune(dir, keep) };
  } catch (e) {
    try { unlinkSync(file); } catch {}
    throw e;
  } finally { copy.close(); }
}

// Keeps the newest `keep` backups. Only files this module names are ever deleted.
export function prune(dir, keep) {
  const all = readdirSync(dir).filter((f) => NAME.test(f)).sort();
  const old = all.slice(0, Math.max(0, all.length - Math.max(1, keep)));
  old.forEach((f) => unlinkSync(join(dir, f)));
  return old.length;
}

export function listBackups(dir) {
  try { return readdirSync(dir).filter((f) => NAME.test(f)).sort(); } catch { return []; }
}
