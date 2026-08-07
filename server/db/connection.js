// server/db/connection.js
// The one place a SQLite handle is created. Everything else in the app asks a
// repository function; no route handler opens a connection or writes SQL.
//
// That rule is the whole point of this directory: it is what makes "the schema
// is owned by one module" enforceable rather than aspirational, and it is what
// would make a later split into a separate service mechanical instead of
// archaeological. Adapted from the reference architecture in ../../brain
// (services/core/modules/memory/db.py), where the same rule is spelled out as
// "Memory is the sole SQLite writer".
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

// Volume resolution is copied deliberately from server/index.js:22-25 rather
// than imported: index.js has no exports and importing it would start the HTTP
// server as a side effect. If that block ever changes, this must change with it.
const RAILWAY_VOLUME = '/data';
export const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH
  || (fs.existsSync(RAILWAY_VOLUME) ? RAILWAY_VOLUME : null)
  || path.join(ROOT, 'data');

export const SQLITE_PATH = process.env.SQLITE_PATH || path.join(VOLUME, 'saathi.db');

let _db = null;

export function getDb() {
  if (_db) return _db;

  fs.mkdirSync(path.dirname(SQLITE_PATH), { recursive: true });
  _db = new Database(SQLITE_PATH);

  // WAL lets the daily-brief PDF read while an intake page writes, instead of
  // one blocking the other. It is persistent — set once, stored in the file —
  // but setting it every boot is harmless and survives a restored backup that
  // was taken in journal mode.
  _db.pragma('journal_mode = WAL');
  // Off by default in SQLite. Without this every FOREIGN KEY in the schema is
  // decoration, and grievance_media rows would happily outlive their grievance.
  _db.pragma('foreign_keys = ON');
  // A writer holding the lock during a bulk import should make a concurrent
  // request wait, not fail instantly with SQLITE_BUSY.
  _db.pragma('busy_timeout = 5000');

  return _db;
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
