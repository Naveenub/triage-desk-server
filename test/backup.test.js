import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, makeStore } from '../db.js';
import { backupNow, listBackups } from '../backup.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'td-bk-'));

function liveDb() {
  const dir = tmp(); const path = join(dir, 'live.db');
  const db = openDb(path); const store = makeStore(db);
  store.createOrgWithAdmin({ orgId: 'o1', userId: 'u1', orgName: 'Acme', email: 'a@acme.test', name: 'A', pwHash: 'x', plan: 'trial' });
  store.putDoc('o1', 'tickets', 't1', '{"text":"hello"}');
  return { db, path, dir };
}

test('backup of a live database in WAL mode is complete, readable and private', () => {
  const { db, path, dir } = liveDb();
  const out = join(dir, 'bk');
  const r = backupNow({ dbPath: path, dir: out });
  // Keep writing to the live DB: the snapshot must not move.
  makeStore(db).putDoc('o1', 'tickets', 't2', '{"text":"later"}');
  const copy = new DatabaseSync(r.file, { readOnly: true });
  assert.equal(copy.prepare("SELECT COUNT(*) n FROM docs WHERE coll='tickets'").get().n, 1);
  assert.equal(copy.prepare('SELECT name FROM orgs').get().name, 'Acme');
  copy.close();
  assert.equal(r.orgs, 1);
  assert.equal(statSync(r.file).mode & 0o777, 0o600);
  db.close();
});

test('only the newest N backups are kept and unrelated files are never deleted', () => {
  const { db, path, dir } = liveDb();
  const out = join(dir, 'bk');
  writeFileSync(join(dir, 'keepme.txt'), 'x');
  for (let i = 0; i < 5; i++) backupNow({ dbPath: path, dir: out, keep: 3, now: new Date(Date.UTC(2026, 9, 16, 10, i, 0)) });
  assert.deepEqual(listBackups(out), ['triage-20261016-100200.db', 'triage-20261016-100300.db', 'triage-20261016-100400.db']);
  writeFileSync(join(out, 'notes.txt'), 'mine');
  backupNow({ dbPath: path, dir: out, keep: 1, now: new Date(Date.UTC(2026, 9, 16, 11, 0, 0)) });
  assert.deepEqual(readdirSync(out).sort(), ['notes.txt', 'triage-20261016-110000.db']);
  assert.ok(existsSync(join(dir, 'keepme.txt')));
  db.close();
});

test('a missing database fails loudly and leaves no partial backup', () => {
  const dir = tmp();
  assert.throws(() => backupNow({ dbPath: join(dir, 'nope.db'), dir: join(dir, 'bk') }));
  assert.deepEqual(listBackups(join(dir, 'bk')), []);
  assert.throws(() => backupNow({ dbPath: ':memory:', dir }), /in-memory/);
});
