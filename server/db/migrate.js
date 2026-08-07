// server/db/migrate.js
// Plain numbered .sql files, applied in order, each recorded in a `migrations`
// table. Deliberately not an ORM migration generator: the schema is one SQLite
// file owned by one module, and generating migrations from model diffs would be
// more machinery than this needs.
//
// Ported from ../../brain/services/core/modules/memory/migrate.py. Three
// properties are load-bearing, because each is a way a naive runner has already
// burned somebody:
//
//   · a migration and its `migrations` row COMMIT TOGETHER. If they can diverge,
//     a crash mid-run leaves a schema that is half-applied and recorded as
//     either fully done or never started, and every later run makes it worse.
//   · applied files are CHECKSUMMED. Editing a migration that already ran is
//     silent on the machine that ran it and a different schema everywhere else;
//     this refuses to start instead.
//   · GAPS AND DUPLICATE version numbers are rejected before anything executes.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { getDb } from './connection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const FILENAME = /^(\d{3})_([a-z0-9_]+)\.sql$/;

const BOOTSTRAP = `
CREATE TABLE IF NOT EXISTS migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    checksum   TEXT NOT NULL,
    applied_at TEXT NOT NULL
)`;

export class MigrationError extends Error {
  // Refuse to run rather than apply a schema nobody can reason about.
  constructor(message) {
    super(message);
    this.name = 'MigrationError';
  }
}

function checksum(sql) {
  return crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);
}

// Read every migration off disk and validate the SET before executing any of
// it. A gap means someone's branch was merged without its migration; running
// the later ones anyway produces a schema that exists on no other machine.
function loadMigrations(dir = MIGRATIONS_DIR) {
  if (!fs.existsSync(dir)) return [];

  const migrations = [];
  const seen = new Map();

  for (const entry of fs.readdirSync(dir).sort()) {
    if (!entry.endsWith('.sql')) continue;
    const match = FILENAME.exec(entry);
    if (!match) {
      throw new MigrationError(
        `Migration filename "${entry}" must look like 001_snake_case_name.sql`);
    }
    const version = parseInt(match[1], 10);
    if (seen.has(version)) {
      throw new MigrationError(
        `Duplicate migration version ${version}: "${seen.get(version)}" and "${entry}"`);
    }
    seen.set(version, entry);

    const sql = fs.readFileSync(path.join(dir, entry), 'utf8');
    // better-sqlite3 wraps each migration in its own transaction (see below).
    // A migration that opens its own would abort that wrapper and break the
    // commit-together guarantee, so refuse it rather than silently degrade.
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\b/im.test(sql)) {
      throw new MigrationError(
        `Migration "${entry}" contains transaction control; the runner supplies it.`);
    }
    migrations.push({ version, name: match[2], file: entry, sql, checksum: checksum(sql) });
  }

  migrations.sort((a, b) => a.version - b.version);
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new MigrationError(
        `Migration versions must be contiguous from 001; expected ${i + 1}, found ${m.version} ("${m.file}")`);
    }
  });

  return migrations;
}

export function migrate({ log = console.log, dir = MIGRATIONS_DIR, db = getDb() } = {}) {
  db.exec(BOOTSTRAP);

  const migrations = loadMigrations(dir);
  const applied = new Map(
    db.prepare('SELECT version, name, checksum FROM migrations').all()
      .map(r => [r.version, r]));

  // Verify everything already applied still matches what is on disk, before
  // applying anything new. A drifted migration is not a problem you want to
  // discover halfway through adding three more.
  for (const m of migrations) {
    const prior = applied.get(m.version);
    if (prior && prior.checksum !== m.checksum) {
      throw new MigrationError(
        `Migration ${m.file} was modified after it was applied `
        + `(recorded ${prior.checksum}, on disk ${m.checksum}). `
        + `Add a new migration instead of editing a shipped one.`);
    }
  }
  for (const version of applied.keys()) {
    if (!migrations.some(m => m.version === version)) {
      throw new MigrationError(
        `Migration ${version} ("${applied.get(version).name}") is recorded as applied `
        + `but is missing from ${dir}.`);
    }
  }

  const pending = migrations.filter(m => !applied.has(m.version));
  if (pending.length === 0) return { applied: 0, current: migrations.length };

  const record = db.prepare(
    'INSERT INTO migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)');

  for (const m of pending) {
    // The schema change and its ledger row in ONE transaction. better-sqlite3
    // rolls the whole thing back if either half throws, so a crash here leaves
    // the database exactly as it was.
    const run = db.transaction(() => {
      db.exec(m.sql);
      record.run(m.version, m.name, m.checksum, new Date().toISOString());
    });
    run();
    log(`  migrated ${m.file}`);
  }

  return { applied: pending.length, current: migrations.length };
}

// `node server/db/migrate.js` runs migrations standalone, so a deploy can apply
// them without booting the HTTP server.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = migrate();
    console.log(result.applied === 0
      ? `Up to date (${result.current} migrations).`
      : `Applied ${result.applied} migration(s); now at ${result.current}.`);
  } catch (err) {
    console.error(`Migration failed: ${err.message}`);
    process.exit(1);
  }
}
