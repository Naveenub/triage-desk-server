// Every SQL statement lives in this file, so moving to Postgres later means rewriting one module.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orgs(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL,
  ai_tokens_override INTEGER,
  redact_server INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','agent','viewer')),
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS users_org ON users(org_id);
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS docs(
  org_id TEXT NOT NULL,
  coll TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(org_id, coll, id)
);
CREATE TABLE IF NOT EXISTS audit(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  by TEXT NOT NULL,
  act TEXT NOT NULL,
  tid TEXT,
  d TEXT
);
CREATE INDEX IF NOT EXISTS audit_org ON audit(org_id, seq);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
  BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
  BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TABLE IF NOT EXISTS usage(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  user_id TEXT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  model TEXT NOT NULL,
  tier TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_micro INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_org_ts ON usage(org_id, ts);
`;

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec(SCHEMA);
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function monthStart(now = Date.now()) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export function makeStore(db) {
  const q = (sql) => db.prepare(sql);
  const s = {
    // ---- orgs and users ----
    createOrgWithAdmin({ orgId, userId, orgName, email, name, pwHash, plan }) {
      return tx(db, () => {
        const now = Date.now();
        q('INSERT INTO orgs(id,name,plan,created_at) VALUES(?,?,?,?)').run(orgId, orgName, plan, now);
        q('INSERT INTO users(id,org_id,email,name,pw_hash,role,created_at) VALUES(?,?,?,?,?,?,?)')
          .run(userId, orgId, email, name, pwHash, 'admin', now);
      });
    },
    createUser({ id, orgId, email, name, pwHash, role }) {
      q('INSERT INTO users(id,org_id,email,name,pw_hash,role,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(id, orgId, email, name, pwHash, role, Date.now());
    },
    userByEmail: (email) => q('SELECT * FROM users WHERE email=?').get(email),
    listTeam: (orgId) =>
      q('SELECT id,name,email,role FROM users WHERE org_id=? AND disabled=0 ORDER BY created_at').all(orgId),
    userInOrg: (orgId, id) => q('SELECT * FROM users WHERE org_id=? AND id=?').get(orgId, id),
    adminCount: (orgId) =>
      q("SELECT COUNT(*) n FROM users WHERE org_id=? AND role='admin' AND disabled=0").get(orgId).n,
    disableUser(orgId, id) {
      tx(db, () => {
        q('UPDATE users SET disabled=1 WHERE org_id=? AND id=?').run(orgId, id);
        q('DELETE FROM sessions WHERE user_id=?').run(id);
      });
    },
    orgById: (id) => q('SELECT * FROM orgs WHERE id=?').get(id),

    // ---- sessions ----
    createSession: (tokenHash, userId, expiresAt) =>
      q('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(tokenHash, userId, expiresAt),
    sessionByHash: (tokenHash) =>
      q(`SELECT s.expires_at, u.id uid, u.email, u.name uname, u.role, u.disabled,
                o.id oid, o.name oname, o.plan, o.ai_tokens_override, o.redact_server
           FROM sessions s JOIN users u ON u.id=s.user_id JOIN orgs o ON o.id=u.org_id
          WHERE s.token_hash=?`).get(tokenHash),
    extendSession: (tokenHash, expiresAt) =>
      q('UPDATE sessions SET expires_at=? WHERE token_hash=?').run(expiresAt, tokenHash),
    deleteSession: (tokenHash) => q('DELETE FROM sessions WHERE token_hash=?').run(tokenHash),
    purgeSessions: () => q('DELETE FROM sessions WHERE expires_at<?').run(Date.now()),

    // ---- documents (always scoped by org_id) ----
    listDocs: (orgId, coll, limit = 10000) =>
      q('SELECT id,data FROM docs WHERE org_id=? AND coll=? ORDER BY updated_at DESC LIMIT ?').all(orgId, coll, limit),
    getDoc: (orgId, coll, id) => q('SELECT id,data FROM docs WHERE org_id=? AND coll=? AND id=?').get(orgId, coll, id),
    countDocs: (orgId, coll) =>
      q('SELECT COUNT(*) n FROM docs WHERE org_id=? AND coll=?').get(orgId, coll).n,
    putDoc: (orgId, coll, id, json) =>
      q(`INSERT INTO docs(org_id,coll,id,data,updated_at) VALUES(?,?,?,?,?)
         ON CONFLICT(org_id,coll,id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`)
        .run(orgId, coll, id, json, Date.now()),
    deleteDoc: (orgId, coll, id) => q('DELETE FROM docs WHERE org_id=? AND coll=? AND id=?').run(orgId, coll, id).changes,

    // ---- audit (append-only, enforced by triggers) ----
    addAudit: (orgId, e) =>
      q('INSERT INTO audit(org_id,at,by,act,tid,d) VALUES(?,?,?,?,?,?)')
        .run(orgId, Date.now(), e.by, e.act, e.tid || null, e.d || null),
    listAudit: (orgId, limit = 100) =>
      q('SELECT seq,at,by,act,tid,d FROM audit WHERE org_id=? ORDER BY seq DESC LIMIT ?').all(orgId, limit),

    // ---- usage ----
    addUsage: (u) =>
      q(`INSERT INTO usage(org_id,user_id,ts,kind,model,tier,input_tokens,output_tokens,cost_micro,status)
         VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(u.orgId, u.userId, Date.now(), u.kind, u.model, u.tier, u.inTok, u.outTok, u.costMicro || 0, u.status),
    monthUsage: (orgId, since) =>
      q(`SELECT COALESCE(SUM(input_tokens+output_tokens),0) tokens, COUNT(*) calls,
                COALESCE(SUM(cost_micro),0) cost_micro
           FROM usage WHERE org_id=? AND ts>=?`).get(orgId, since),
    globalMonthTokens: (since) =>
      q('SELECT COALESCE(SUM(input_tokens+output_tokens),0) tokens FROM usage WHERE ts>=?').get(since).tokens,
  };
  return s;
}
