// server/db/migrate.test.js
// The migration runner is the one piece of this codebase that must not be
// verified by eye: its failure mode is a schema that differs between machines
// and is not discovered until something else breaks. Run with `npm test`.
//
// Uses node:test (built into Node 18) so this adds no dependency.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

import { migrate, MigrationError } from './migrate.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'saathi-migrate-'));
}

// Each test gets its own in-memory database and its own migrations directory,
// so nothing here can touch the real data/saathi.db.
function fixture(files) {
  const dir = tmpdir();
  for (const [name, sql] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), sql);
  }
  return { dir, db: new Database(':memory:') };
}

const NOOP = { log: () => {} };

test('applies pending migrations in order and records them', () => {
  const { dir, db } = fixture({
    '001_first.sql': 'CREATE TABLE a (id INTEGER);',
    '002_second.sql': 'CREATE TABLE b (id INTEGER);',
  });

  const result = migrate({ ...NOOP, dir, db });

  assert.equal(result.applied, 2);
  const rows = db.prepare('SELECT version, name FROM migrations ORDER BY version').all();
  assert.deepEqual(rows, [
    { version: 1, name: 'first' },
    { version: 2, name: 'second' },
  ]);
});

test('running twice is a no-op', () => {
  const { dir, db } = fixture({ '001_first.sql': 'CREATE TABLE a (id INTEGER);' });

  migrate({ ...NOOP, dir, db });
  const second = migrate({ ...NOOP, dir, db });

  assert.equal(second.applied, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM migrations').get().n, 1);
});

test('editing an applied migration refuses to run', () => {
  const { dir, db } = fixture({ '001_first.sql': 'CREATE TABLE a (id INTEGER);' });
  migrate({ ...NOOP, dir, db });

  // Same version, different content — the exact case that is silent on the
  // machine that already ran it and divergent everywhere else.
  fs.writeFileSync(path.join(dir, '001_first.sql'), 'CREATE TABLE a (id INTEGER, extra TEXT);');

  assert.throws(() => migrate({ ...NOOP, dir, db }), MigrationError);
});

test('a gap in version numbers is rejected before anything executes', () => {
  const { dir, db } = fixture({
    '001_first.sql': 'CREATE TABLE a (id INTEGER);',
    '003_third.sql': 'CREATE TABLE c (id INTEGER);',
  });

  assert.throws(() => migrate({ ...NOOP, dir, db }), MigrationError);
  // "Before anything executes" is the actual claim being tested: 001 is valid
  // and would have applied cleanly if the runner validated lazily.
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='a'").all();
  assert.equal(tables.length, 0);
});

test('a duplicate version number is rejected', () => {
  const { dir, db } = fixture({
    '001_first.sql': 'CREATE TABLE a (id INTEGER);',
    '001_other.sql': 'CREATE TABLE b (id INTEGER);',
  });

  assert.throws(() => migrate({ ...NOOP, dir, db }), MigrationError);
});

test('a migration recorded as applied but missing from disk is rejected', () => {
  const { dir, db } = fixture({
    '001_first.sql': 'CREATE TABLE a (id INTEGER);',
    '002_second.sql': 'CREATE TABLE b (id INTEGER);',
  });
  migrate({ ...NOOP, dir, db });

  fs.unlinkSync(path.join(dir, '002_second.sql'));

  assert.throws(() => migrate({ ...NOOP, dir, db }), MigrationError);
});

test('a failing migration leaves no ledger row (commit together)', () => {
  const { dir, db } = fixture({
    '001_first.sql': 'CREATE TABLE a (id INTEGER);',
    '002_broken.sql': 'CREATE TABLE b (id INTEGER); THIS IS NOT SQL;',
  });

  assert.throws(() => migrate({ ...NOOP, dir, db }));

  // 001 applied and is recorded. 002 must be recorded nowhere AND have left no
  // half-built table behind — that pairing is the guarantee.
  const versions = db.prepare('SELECT version FROM migrations ORDER BY version').all();
  assert.deepEqual(versions, [{ version: 1 }]);
  const b = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='b'").all();
  assert.equal(b.length, 0);
});

test('a migration containing its own transaction control is rejected', () => {
  const { dir, db } = fixture({
    '001_first.sql': 'BEGIN;\nCREATE TABLE a (id INTEGER);\nCOMMIT;',
  });

  assert.throws(() => migrate({ ...NOOP, dir, db }), MigrationError);
});

test('a badly named file is rejected rather than skipped', () => {
  const { dir, db } = fixture({ 'initial.sql': 'CREATE TABLE a (id INTEGER);' });

  assert.throws(() => migrate({ ...NOOP, dir, db }), MigrationError);
});
