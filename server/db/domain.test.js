// server/db/domain.test.js
// The domain repositories, and the properties the strangle step depends on:
// what comes out of SQLite must have the same shape as what came out of db.json,
// and the corpus must carry enough text to answer a question about a record.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'saathi-domain-'));
process.env.SQLITE_PATH = path.join(TMP, 'test.db');

const { migrate } = await import('./migrate.js');
const { closeDb, getDb } = await import('./connection.js');
const contacts = await import('./contacts.js');
const grievances = await import('./grievances.js');
const events = await import('./events.js');
const news = await import('./news.js');
const reports = await import('./campaign_reports.js');
const posts = await import('./social_posts.js');
const letters = await import('./ttd_letters.js');
const rawEvents = await import('./raw_events.js');
const reference = await import('./reference.js');
const records = await import('./records.js');
const search = await import('./search_index.js');

before(() => {
  migrate({ log: () => {} });
  reference.seedReference();
  contacts.replaceAllContacts([
    { id: 'C1', name: 'Ramesh Kumar', village: 'Karempudi', mandal: 'Karempudi', tier: 'T1', pps_score: 90 },
    { id: 'C2', name: 'Lakshmi Devi', village: 'Chinthapalli', mandal: 'Karempudi', tier: 'T2', pps_score: 70 },
  ]);
});

after(() => {
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── grievances ───────────────────────────────────────────────────────────

test('a grievance round-trips with its legacy media fields intact', () => {
  const g = grievances.insertGrievance({
    full_name: 'Ramesh Kumar', village: 'Karempudi', mandal: 'Karempudi',
    category: 'irrigation_water', urgency: 'High', priority_score: 88,
    date_of_visit: '2026-08-01', issue_description: 'The canal has been breached for weeks.',
  }, { media: [{ path: 'a.jpg', mime: 'image/jpeg', type: 'image' }, { path: 'b.mp3', type: 'audio' }] });

  // The pages read image_path/media_type; they must still be there.
  assert.equal(g.image_path, 'a.jpg');
  assert.equal(g.media_type, 'image');
  assert.equal(g.media.length, 2);
  assert.deepEqual(g.linked_grievance_ids, []);
  assert.deepEqual(g.ttd_letter_refs, []);
});

test('an out-of-range enum coerces to its default rather than throwing', () => {
  // An OCR run that invents a channel must still produce a reviewable record.
  const g = grievances.insertGrievance({
    full_name: 'Test', channel: 'carrier_pigeon', resolution_status: 'Whenever',
    urgency: 'Extreme', issue_description: 'x',
  });
  assert.equal(g.channel, 'walk_in');
  assert.equal(g.resolution_status, 'Pending');
  assert.equal(g.urgency, 'Medium');
});

test('the corpus carries issue_description, not just a label', () => {
  // This is the defect the whole retrieval change exists to fix: chat used to be
  // grounded on "[grievances] Ramesh Kumar — Housing, Karempudi, Pending" and so
  // could not answer a question about what the grievance actually said.
  const hits = search.ftsSearch('canal breached');
  assert.ok(hits.length > 0, 'no hit on body text');
  assert.match(hits[0].body, /canal/i);
});

test('duplicate links are bidirectional and survive a delete as closed edges', () => {
  const a = grievances.insertGrievance({ full_name: 'Dup A', contact_number: '9990001111', issue_description: 'first' });
  const b = grievances.insertGrievance({ full_name: 'Dup B', contact_number: '9990001111', issue_description: 'second' });
  grievances.linkDuplicates(a.id, b.id);

  assert.ok(grievances.getGrievance(a.id).linked_grievance_ids.includes(b.id));
  assert.ok(grievances.getGrievance(b.id).linked_grievance_ids.includes(a.id));

  // Deleting one must not leave a dangling id on the other — the db.json version
  // did exactly that.
  grievances.softDeleteGrievance(b.id);
  assert.deepEqual(grievances.getGrievance(a.id).linked_grievance_ids, []);
});

test('editing a grievance snapshots the state being left behind', () => {
  const g = grievances.insertGrievance({ full_name: 'Version Test', category: 'housing', issue_description: 'roof' });
  grievances.updateGrievance(g.id, { category: 'revenue_land' }, { editedBy: 'tester' });

  const rec = records.getRecordFor('grievances', g.id);
  const versions = records.listVersions(rec.id);
  assert.equal(versions.length, 1);
  assert.equal(JSON.parse(versions[0].snapshot).category, 'housing');
  assert.equal(grievances.getGrievance(g.id).category, 'revenue_land');
});

// ── events ───────────────────────────────────────────────────────────────

test('event contacts are joined live, not frozen copies', () => {
  const e = events.insertEvent(
    { event_name: 'Village meeting', date: '2026-09-01', mandal: 'Karempudi' },
    { contactIds: ['C1', 'C2'] });

  assert.equal(e.nearby_count, 2);
  assert.equal(e.nearby_contacts[0].name, 'Ramesh Kumar');

  // db.json embedded a copy, so renaming a contact left the event stale forever.
  contacts.updateContact('C1', { name: 'Ramesh Kumar Garu', tier: 'T2' });
  const refreshed = events.getEvent(e.id);
  assert.equal(refreshed.nearby_contacts[0].name, 'Ramesh Kumar Garu');
  assert.equal(refreshed.nearby_contacts[0].tier, 'T2');
});

test('the PA-written brief survives a contact refresh', () => {
  const e = events.insertEvent({ event_name: 'Brief test', date: '2026-09-02' }, { contactIds: ['C1'] });
  events.setEventContactBrief(e.id, 'C1', { event_brief: 'Ask about the canal', brief_reviewed: true });

  const got = events.getEvent(e.id).nearby_contacts[0];
  assert.equal(got.event_brief, 'Ask about the canal');
  assert.equal(got.brief_reviewed, true);
});

test('event JSON columns degrade instead of throwing on a malformed blob', () => {
  const e = events.insertEvent({ event_name: 'Blob test', date: '2026-09-03' });
  getDb().prepare('UPDATE events SET creative_touches = ? WHERE id = ?').run('{not json', e.id);
  const got = events.getEvent(e.id);
  assert.deepEqual(got.creative_touches, { selected: [], custom: [], reviewed: false });
});

// ── news ─────────────────────────────────────────────────────────────────

test('news scope is split out of the overloaded mandal field', () => {
  // db.json put "National" in `mandal`; admin.html then filtered on that string.
  const n = news.insertNews({ headline: 'Budget session opens', mandal: 'National' });
  assert.equal(n.scope, 'national');
  assert.equal(n.mandal, 'General');

  const local = news.insertNews({ headline: 'Road repair begins', mandal: 'Karempudi' });
  assert.equal(local.scope, 'mandal');
  assert.equal(local.mandal, 'Karempudi');

  assert.equal(news.listNews({ scope: 'national' }).length, 1);
});

// ── ttd letters ──────────────────────────────────────────────────────────

test('ttd references are sequential and unique', () => {
  const a = letters.insertLetter({ date: '2026-03-01', name: 'A', aadhar: '1111 2222 3333' });
  const b = letters.insertLetter({ date: '2026-03-02', name: 'B' });
  assert.equal(a.reference, 'TTD/2026/001');
  assert.equal(b.reference, 'TTD/2026/002');

  // The reference is quoted to the temple, so a collision is a real-world
  // problem, not just a data one. UNIQUE is the backstop.
  assert.throws(() => letters.insertLetter({ date: '2026-03-03', name: 'C', reference: 'TTD/2026/001' }));
});

test('aadhar is stored normalized so the duplicate check actually matches', () => {
  // Staff type it with spaces, with dashes, or with neither.
  assert.equal(letters.findByAadhar('111122223333').length, 1);
  assert.equal(letters.findByAadhar('1111-2222-3333').length, 1);
  assert.equal(letters.findByAadhar('1111 2222 3333').length, 1);
});

// ── reports, posts ───────────────────────────────────────────────────────

test('campaign reports keep the legacy attachment key and gain media rows', () => {
  const r = reports.insertReport(
    { title: 'Scheme rollout', type: 'Government Scheme', status: 'Ongoing', mandal: 'Karempudi',
      description: 'Pensions disbursed to 400 beneficiaries.' },
    { media: [{ path: 'r.pdf', mime: 'application/pdf', type: 'pdf' }] });

  assert.equal(r.attachment, null);
  assert.equal(r.media[0].path, 'r.pdf');
  assert.ok(search.ftsSearch('pensions disbursed').length > 0);
});

test('social post media keeps the filename key the page reads', () => {
  const p = posts.insertPost({ date: '2026-09-05', caption: 'Inauguration photos' },
    { media: [{ filename: 'x.jpg', mime: 'image/jpeg' }] });
  assert.equal(p.media[0].filename, 'x.jpg');
  assert.equal(p.media[0].type, 'image');
});

test('media type is inferred from mime when the caller omits it', () => {
  const p = posts.insertPost({ date: '2026-09-06', caption: 'Clip' },
    { media: [{ filename: 'v.mp4', mime: 'video/mp4' }] });
  assert.equal(p.media[0].type, 'video');
});

// ── raw events ───────────────────────────────────────────────────────────

test('an inbound submission is recorded before anything can lose it', () => {
  const hash = rawEvents.sha256(Buffer.from('form-bytes'));
  const id = rawEvents.record({ source: 'grievance_upload', kind: 'image', filePath: 'f.jpg', hash });

  assert.equal(rawEvents.getEvent(id).status, 'pending');
  assert.equal(rawEvents.listUnresolved().length, 1);

  // Re-photographing the same form must resolve to the same event, not a second
  // grievance for the same citizen.
  assert.equal(rawEvents.findByHash(hash).id, id);

  rawEvents.markStatus(id, 'compiled', { recordId: 'G123' });
  assert.equal(rawEvents.getEvent(id).status, 'compiled');
  assert.equal(JSON.parse(rawEvents.getEvent(id).meta).record_id, 'G123');
  assert.equal(rawEvents.listUnresolved().length, 0);
});

test('a failed extraction keeps the input instead of dropping it', () => {
  const id = rawEvents.record({ source: 'grievance_upload', kind: 'audio', filePath: 'a.m4a' });
  rawEvents.markStatus(id, 'failed', { error: 'Gemini timeout' });

  const ev = rawEvents.getEvent(id);
  assert.equal(ev.status, 'failed');
  assert.equal(ev.file_path, 'a.m4a', 'the bytes must still be findable');
  assert.ok(rawEvents.listUnresolved().some(e => e.id === id));
});

// ── reference data ───────────────────────────────────────────────────────

test('mandal aliases resolve the spellings that occur in the real data', () => {
  // 170 contacts spell it "Ipur"; the canonical list says "Ipuru". admin.html's
  // hardcoded alias map had no entry for it, so those contacts silently failed
  // to join and simply did not appear in any mandal rollup.
  assert.equal(reference.canonicalMandal('Ipur'), 'Ipuru');
  assert.equal(reference.canonicalMandal('Dachepalli'), 'Dachepalle');
  assert.equal(reference.canonicalMandal('Chilakaluripeta'), 'Chilakaluripet');
  assert.equal(reference.canonicalMandal('Gurajala'), 'Gurazala');
});

test('sattenapalli is not rewritten to a name that exists nowhere', () => {
  // The old map sent it to "Sattenapalle", which is absent from the canonical
  // list — an alias that broke the mandal it was meant to fix.
  assert.equal(reference.canonicalMandal('Sattenapalli'), 'Sattenapalli');
  assert.ok(reference.listMandals().includes('Sattenapalli'));
});

test('an unknown place stays itself rather than vanishing', () => {
  assert.equal(reference.canonicalMandal('Nowhere At All'), 'Nowhere At All');
});

test('seeding twice does not duplicate places or aliases', () => {
  const before = reference.listMandals().length;
  reference.seedReference();
  assert.equal(reference.listMandals().length, before);
});

// ── the corpus as a whole ────────────────────────────────────────────────

test('every collection lands in the corpus under its own type', () => {
  const types = Object.fromEntries(search.indexStats().map(s => [s.source, s.n]));
  for (const t of ['contact', 'grievance', 'event', 'news', 'report', 'post', 'letter']) {
    assert.ok(types[t] > 0, `no records of type ${t}`);
  }
});

test('the FTS index passes its own integrity check after every write path', () => {
  assert.doesNotThrow(() => records.checkFts());
});

test('foreign keys are clean across the whole database', () => {
  assert.deepEqual(getDb().prepare('PRAGMA foreign_key_check').all(), []);
});
