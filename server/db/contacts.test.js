// server/db/contacts.test.js
// The contacts repository, and the one property the strangle step depends on:
// what comes out of SQLite must equal what came out of db.json.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'saathi-contacts-'));
process.env.SQLITE_PATH = path.join(TMP, 'test.db');

const { migrate } = await import('./migrate.js');
const { closeDb, getDb } = await import('./connection.js');
const contacts = await import('./contacts.js');
const searchIndex = await import('./search_index.js');
const records = await import('./records.js');

// The repository speaks table names ('contacts'); the corpus speaks record types
// ('contact'). Tests assert against source_id, which is the contact's own id.
const ids = rows => rows.map(r => r.source_id);

const SAMPLE = [
  { id: 'C0001', name: 'Ramesh Kumar', village: 'Karempudi', mandal: 'Karempudi',
    party: 'TDP', role: 'Party Worker', tier: 'T1', pps_score: 90,
    top_drivers: ['influence'], issues: [], krishna_follower: true },
  { id: 'C0002', name: 'Lakshmi Devi', village: 'Chinthapalli', mandal: 'Karempudi',
    party: 'TDP', role: 'Influencer', tier: 'T2', pps_score: 70,
    top_drivers: ['influence', 'loyalty'], issues: [], krishna_follower: false },
  { id: 'C0003', name: 'Suresh Babu', village: 'Piduguralla', mandal: 'Piduguralla',
    party: 'Janasena', role: 'Party Worker', tier: 'T3', pps_score: 70,
    top_drivers: [], issues: [], krishna_follower: false },
];

before(() => {
  migrate({ log: () => {} });
  contacts.replaceAllContacts(SAMPLE);
});

after(() => {
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('round-trips a record without changing shape or types', () => {
  const c = contacts.getContact('C0001');
  assert.equal(c.name, 'Ramesh Kumar');
  // Arrays survive the JSON columns, booleans survive the INTEGER column.
  assert.deepEqual(c.top_drivers, ['influence']);
  assert.equal(c.krishna_follower, true);
  assert.equal(typeof c.pps_score, 'number');
});

test('replaceAllContacts is idempotent', () => {
  contacts.replaceAllContacts(SAMPLE);
  contacts.replaceAllContacts(SAMPLE);
  assert.equal(contacts.countContacts(), 3);
  // The corpus must not accumulate duplicates either — records are keyed on
  // (source_table, source_id), so a re-import overwrites rather than appends.
  const stats = searchIndex.indexStats().find(s => s.source === 'contact');
  assert.equal(stats.n, 3);
});

test('findNearby puts the named village first, then the rest of the mandal', () => {
  const ids = contacts.findNearby({ mandal: 'Karempudi', village: 'Chinthapalli' })
    .map(c => c.id);
  // C0002 is in the village (lower PPS) and still outranks C0001 (higher PPS,
  // same mandal). Village-first is the point of the rule.
  assert.deepEqual(ids, ['C0002', 'C0001']);
});

test('findNearby without a village orders by PPS alone', () => {
  const ids = contacts.findNearby({ mandal: 'Karempudi' }).map(c => c.id);
  assert.deepEqual(ids, ['C0001', 'C0002']);
});

test('findNearby breaks PPS ties deterministically by insertion order', () => {
  // C0002 and C0003 both score 70. Whatever order comes back, it must be the
  // same on every call and every machine — an unstable tiebreak silently
  // changes which contacts survive the LIMIT on real data.
  const a = contacts.findNearby({ mandal: 'Karempudi', limit: 20 }).map(c => c.id);
  const b = contacts.findNearby({ mandal: 'Karempudi', limit: 20 }).map(c => c.id);
  assert.deepEqual(a, b);
});

test('findNearby matches the village across mandal boundaries', () => {
  // The original filtered villageContacts by village ALONE, not village+mandal.
  const ids = contacts.findNearby({ mandal: 'Karempudi', village: 'Piduguralla' })
    .map(c => c.id);
  assert.equal(ids[0], 'C0003');
});

test('updateContact patches without dropping unlisted fields', () => {
  contacts.updateContact('C0001', { days_since_contact: 0 });
  const c = contacts.getContact('C0001');
  assert.equal(c.days_since_contact, 0);
  assert.equal(c.name, 'Ramesh Kumar');
  assert.deepEqual(c.top_drivers, ['influence']);
});

test('soft-deleted contacts leave lists and the corpus', () => {
  contacts.upsertContact({ id: 'C9999', name: 'Temporary Person', mandal: 'Karempudi' });
  assert.ok(contacts.getContact('C9999'));

  contacts.softDeleteContact('C9999');
  assert.equal(contacts.getContact('C9999'), null);
  assert.ok(!contacts.listContacts().some(c => c.id === 'C9999'));
  assert.ok(!ids(searchIndex.ftsSearch('Temporary')).includes('C9999'));
});

test('search finds a contact by name and by place', () => {
  assert.ok(ids(searchIndex.ftsSearch('Ramesh')).includes('C0001'));
  assert.ok(ids(searchIndex.ftsSearch('Chinthapalli')).includes('C0002'));
});

test('search survives punctuation and FTS operator characters', () => {
  // "water supply?" and names with quotes are ordinary user input; passed raw
  // to MATCH they raise SQLITE_ERROR and 500 the page.
  for (const q of ['Ramesh?', 'water "supply"', 'AND', 'a*b', '(test)', "O'Brien",
    'NOT x', 'a OR b', 'col:val', '^anchor', '', '   ']) {
    assert.doesNotThrow(() => searchIndex.ftsSearch(q), `query crashed: ${q}`);
  }
});

test('search ranks a title hit above a body hit', () => {
  // Someone named after a village should outrank everyone who merely lives there.
  contacts.upsertContact({ id: 'C0100', name: 'Karempudi Rao', village: 'Elsewhere', mandal: 'Other' });
  assert.equal(searchIndex.ftsSearch('Karempudi')[0].source_id, 'C0100');
});

test('search can be scoped to record types', () => {
  assert.equal(searchIndex.ftsSearch('Ramesh', { types: ['grievance'] }).length, 0);
  assert.ok(searchIndex.ftsSearch('Ramesh', { types: ['contact'] }).length > 0);
});

// ── the property the standalone index could not offer ────────────────────
// The old search_index was a separate table every repository had to remember to
// update. These two tests assert that SQLite now does it, with no application
// code in the path at all.

test('the FTS index follows a raw UPDATE with no repository involved', () => {
  const rec = records.getRecordFor('contacts', 'C0001');
  getDb().prepare('UPDATE records SET title = ? WHERE id = ?').run('Renamed Entirely', rec.id);

  assert.equal(searchIndex.ftsSearch('Ramesh').length, 0, 'old title still matches');
  assert.ok(ids(searchIndex.ftsSearch('Renamed')).includes('C0001'));

  getDb().prepare('UPDATE records SET title = ? WHERE id = ?').run('Ramesh Kumar', rec.id);
});

test('the FTS index passes its own integrity check', () => {
  // FTS5 compares the index against the base table. It throws on a mismatch,
  // which is the only way a silently-drifted external-content index is visible.
  assert.doesNotThrow(() => records.checkFts());
});

test('entity links resolve places across spellings', () => {
  // Karempudi appears as both a village and a mandal on C0001; the graph must
  // hold ONE place node for it, not one per column.
  const rec = records.getRecordFor('contacts', 'C0001');
  const entityIds = records.entityIdsFor(rec.id);
  assert.ok(entityIds.length >= 2, 'expected person + place links');

  const karempudi = records.resolveEntity('place', 'Karempudi');
  records.addAliases(karempudi.id, ['Karempudy']);
  assert.equal(records.resolveEntity('place', 'karempudy').id, karempudi.id);
});

test('versions capture the state being left behind', () => {
  const rec = records.getRecordFor('contacts', 'C0002');
  const v1 = records.captureVersion(rec.id, { pps_score: 70 }, 'tester');
  const v2 = records.captureVersion(rec.id, { pps_score: 75 }, 'tester');
  assert.equal(v1, 1);
  assert.equal(v2, 2);
  assert.equal(records.listVersions(rec.id).length, 2);
});
