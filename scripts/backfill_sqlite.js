// scripts/backfill_sqlite.js
// Copies every collection out of db.json into SQLite. Idempotent: each target
// table is replaced wholesale, so running it twice produces the same database,
// and a run that dies halfway leaves the previous contents intact (one
// transaction per collection).
//
// This does NOT delete anything from db.json. The strangle order is: backfill,
// swap the call sites, verify the pages, and only then drop the collection from
// the JSON file — so there is always a way back until the last step.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { migrate } from '../server/db/migrate.js';
import { SQLITE_PATH, VOLUME, getDb } from '../server/db/connection.js';
import { replaceAllContacts } from '../server/db/contacts.js';
import { replaceAllGrievances } from '../server/db/grievances.js';
import { replaceAllEvents } from '../server/db/events.js';
import { replaceAllNews } from '../server/db/news.js';
import { replaceAllReports } from '../server/db/campaign_reports.js';
import { replaceAllPosts } from '../server/db/social_posts.js';
import { replaceAllLetters } from '../server/db/ttd_letters.js';
import { seedReference } from '../server/db/reference.js';
import { indexStats } from '../server/db/search_index.js';
import { checkFts } from '../server/db/records.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DB_JSON = process.env.DB_JSON || path.join(VOLUME, 'db.json');

// Order matters: ttd_letters carries a FK to grievances, and event_contacts one
// to contacts, so their targets have to exist first. Getting this wrong is not
// silent — foreign_keys is ON — but it is much easier to read than to debug.
const COLLECTIONS = [
  { key: 'contacts',         load: replaceAllContacts },
  { key: 'grievances',       load: replaceAllGrievances },
  { key: 'ttd_letters',      load: replaceAllLetters },
  { key: 'schedule',         load: replaceAllEvents, table: 'events' },
  { key: 'news',             load: replaceAllNews },
  { key: 'campaign_reports', load: replaceAllReports },
  { key: 'social_posts',     load: replaceAllPosts },
];

function loadJson() {
  const candidates = [DB_JSON, path.join(ROOT, 'data', 'db.json')];
  for (const p of candidates) {
    if (fs.existsSync(p)) return { path: p, data: JSON.parse(fs.readFileSync(p, 'utf8')) };
  }
  throw new Error(`No db.json found. Looked in: ${candidates.join(', ')}`);
}

function main() {
  console.log(`SQLite : ${SQLITE_PATH}`);
  const { path: jsonPath, data: db } = loadJson();
  console.log(`Source : ${jsonPath}\n`);

  console.log('Migrations:');
  const m = migrate({ log: line => console.log(line) });
  if (m.applied === 0) console.log('  up to date');

  // Reference data first: entity resolution matches a canonical name before its
  // aliases, so "Ipur" only lands on the "Ipuru" node if that node already exists
  // carrying the alias. Seeding after the contacts would create 26 orphan places.
  const seeded = seedReference();
  console.log(`\nReference data: ${seeded} canonical places seeded`);

  console.log('\nCollections:');
  const failures = [];
  for (const { key, load, table } of COLLECTIONS) {
    const items = db[key] || [];
    const written = load(items);
    const label = table ? `${key} -> ${table}` : key;
    console.log(`  ${label.padEnd(28)} ${String(items.length).padStart(5)} in db.json -> ${String(written).padStart(5)} in SQLite`);

    // The check that matters. A silent row-count drift is the one backfill bug
    // that survives review, because every spot-check of individual records passes.
    if (written !== items.length) failures.push(`${key}: expected ${items.length}, wrote ${written}`);
  }

  if (failures.length) {
    console.error('\nFAIL:');
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }

  console.log('\nRetrieval corpus (records, by type):');
  const stats = indexStats();
  if (!stats.length) console.log('  (empty)');
  for (const s of stats) console.log(`  ${s.source.padEnd(28)} ${String(s.n).padStart(5)}`);

  // The FTS index is external-content and maintained by triggers, so it cannot
  // drift in principle. Assert it anyway: this is the one moment where a restored
  // or hand-edited database would show it.
  checkFts();
  console.log('\nFTS integrity            : OK');

  const fk = getDb().prepare('PRAGMA foreign_key_check').all();
  console.log(`Foreign keys             : ${fk.length === 0 ? 'clean' : `${fk.length} VIOLATIONS`}`);
  if (fk.length) { console.error(fk.slice(0, 10)); process.exit(1); }

  console.log('\nOK. db.json is unchanged — nothing has been deleted.');
}

main();
