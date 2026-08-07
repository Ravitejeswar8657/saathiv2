// server/search.test.js
// The retrieval pipeline: fan-out, RRF fusion, graph expansion, degradation, and
// the response contract the UI reads.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'saathi-search-'));
process.env.SQLITE_PATH = path.join(TMP, 'test.db');

const { migrate } = await import('./db/migrate.js');
const { closeDb } = await import('./db/connection.js');
const { seedReference } = await import('./db/reference.js');
const contacts = await import('./db/contacts.js');
const grievances = await import('./db/grievances.js');
const events = await import('./db/events.js');
const { search, status, searchAll } = await import('./search.js');

before(() => {
  migrate({ log: () => {} });
  seedReference();

  contacts.replaceAllContacts([
    { id: 'C1', name: 'Ramesh Kumar', village: 'Piduguralla', mandal: 'Piduguralla', role: 'Party Worker', tier: 'T1', pps_score: 90 },
    { id: 'C2', name: 'Lakshmi Devi', village: 'Piduguralla', mandal: 'Piduguralla', role: 'Influencer', tier: 'T2', pps_score: 70 },
    { id: 'C3', name: 'Suresh Babu', village: 'Karempudi', mandal: 'Karempudi', role: 'Party Worker', tier: 'T3', pps_score: 50 },
  ]);

  grievances.insertGrievance({
    full_name: 'Sita Devi', village: 'Piduguralla', mandal: 'Piduguralla',
    category: 'irrigation_water', urgency: 'High', priority_score: 88,
    date_of_visit: '2026-08-01',
    issue_description: 'The borewell dried up after the canal was diverted last month.',
  });
  grievances.insertGrievance({
    full_name: 'Venkat Rao', village: 'Karempudi', mandal: 'Karempudi',
    category: 'roads_infrastructure', urgency: 'Medium', priority_score: 60,
    date_of_visit: '2026-08-02',
    issue_description: 'The approach road floods every monsoon and buses stop running.',
  });
  events.insertEvent({ event_name: 'Irrigation review', date: '2026-09-01', mandal: 'Piduguralla', village: 'Piduguralla' });
});

after(() => {
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── the response contract ────────────────────────────────────────────────

test('the per-source counts are called `sources` and tally with the results', () => {
  // Brain shipped this exact bug: the client type declared `counts` while the API
  // sent `sources`, so the badge row rendered nothing for the whole life of the
  // page — and it type-checked perfectly, because the type was wrong in the same
  // direction as the code. A hand-written client type is an assertion, not a
  // check, so the name is pinned server-side.
  const r = search('Piduguralla', { k: 10 });
  assert.ok(r.sources, 'the key must be `sources`');
  assert.equal(r.counts, undefined, 'must not be called `counts`');

  const tally = {};
  for (const hit of r.results) tally[hit.origin] = (tally[hit.origin] || 0) + 1;
  assert.deepEqual(r.sources, tally, 'sources keys must tally with the results own origins');
});

test('`sources` is sparse — a retriever that contributed nothing is omitted', () => {
  const r = search('Piduguralla', { k: 10 });
  for (const [key, n] of Object.entries(r.sources)) {
    assert.ok(n > 0, `${key} present with a zero count`);
  }
  // `hybrid` is a key like any other, not a special case outside the set.
  assert.ok(['hybrid', 'fts', 'fuzzy', 'graph'].some(k => k in r.sources));
});

test('every result carries the fields the UI reads', () => {
  const hit = search('Piduguralla', { k: 3 }).results[0];
  for (const f of ['record_id', 'source', 'id', 'rank', 'score', 'origin', 'title', 'subtitle', 'body']) {
    assert.ok(f in hit, `missing field: ${f}`);
  }
  // `source` is a collection name, because admin.html prints it as a heading.
  assert.equal(hit.source, 'contacts');
});

test('an empty query returns the empty shape, not an error', () => {
  for (const q of ['', '   ', null, undefined]) {
    const r = search(q);
    assert.deepEqual(r.results, []);
    assert.equal(r.degraded, false);
  }
});

test('punctuation and FTS operators never throw', () => {
  for (const q of ['water supply?', "O'Brien", 'a AND b', 'NOT x', 'col:val', '^a', 'a*b', '((']) {
    assert.doesNotThrow(() => search(q), `crashed on: ${q}`);
  }
});

// ── ranking ──────────────────────────────────────────────────────────────

test('results are ordered by fused score, descending', () => {
  const results = search('Piduguralla', { k: 10 }).results;
  for (let i = 1; i < results.length; i++) {
    assert.ok(results[i - 1].score >= results[i].score, 'scores must not increase');
    assert.equal(results[i].rank, i + 1, 'rank must follow position');
  }
});

test('a hit both retrievers found is tagged hybrid', () => {
  const r = search('Piduguralla', { k: 10 });
  assert.ok(r.results.some(x => x.origin === 'hybrid'),
    'an exact term present in both indexes should fuse');
});

test('the fuzzy half recovers a misspelling BM25 cannot match', () => {
  // This is why fuzzy earns its place rather than being redundant with FTS:
  // transliterated Telugu names vary constantly, and a prefix match on a typo
  // ("Kumr*") matches nothing at all.
  const r = search('Ramesh Kumr', { k: 10 });
  assert.ok(r.results.some(x => x.id === 'C1'),
    'the misspelled name found nothing');
  assert.ok(r.results.some(x => x.origin === 'fuzzy' || x.origin === 'hybrid'));
});

test('the corpus is searched by body text, not only by title', () => {
  // The defect this whole change exists to fix: retrieval used to see a label
  // only, so a grievance was findable by the citizen's name and never by what
  // the grievance actually said.
  const r = search('borewell diverted', { k: 5 });
  assert.ok(r.results.length > 0, 'no hit on issue_description');
  assert.equal(r.results[0].source, 'grievances');
  assert.match(r.results[0].body, /borewell/i);
});

// ── graph expansion ──────────────────────────────────────────────────────

test('graph results never outrank a direct hit', () => {
  const results = search('Piduguralla', { k: 20 }).results;
  const graph = results.filter(r => r.origin === 'graph');
  const direct = results.filter(r => r.origin !== 'graph');
  if (graph.length && direct.length) {
    const worstDirect = Math.min(...direct.map(r => r.score));
    const bestGraph = Math.max(...graph.map(r => r.score));
    assert.ok(bestGraph < worstDirect,
      'graph expansion fills recall gaps; it must not outrank direct matches');
  }
});

test('graph expansion does not fire without a foothold', () => {
  // A query matching one record must not drag its whole neighbourhood in.
  const r = search('zzzzznotarealword', { k: 10 });
  assert.equal(r.results.filter(x => x.origin === 'graph').length, 0);
});

// ── filters ──────────────────────────────────────────────────────────────

test('filters are applied inside retrieval, not after scoring', () => {
  // Filtering afterwards lets excluded rows eat the top-k budget, so the caller
  // silently gets fewer results than it asked for and cannot tell why.
  const all = search('Piduguralla', { k: 10 });
  const only = search('Piduguralla', { k: 10, filters: { sources: ['grievances'] } });

  assert.ok(only.results.length > 0);
  assert.ok(only.results.every(r => r.source === 'grievances'));
  assert.ok(all.results.some(r => r.source === 'contacts'),
    'the unfiltered query should include other collections');
});

// ── status ───────────────────────────────────────────────────────────────

test('status distinguishes an absent retriever from a broken one', () => {
  const s = status();
  assert.equal(s.retrievers.fts.available, true);
  assert.equal(s.retrievers.fuzzy.available, true);
  // Absent by design, with a reason — not silently missing.
  assert.equal(s.retrievers.vector.available, false);
  assert.ok(s.retrievers.vector.error);
  assert.ok(s.corpus.total > 0);
  assert.ok(s.corpus.by_type.contact > 0);
  assert.equal(s.fusion.k, 60);
});

// ── back-compat ──────────────────────────────────────────────────────────

test('searchAll still returns the flat list the old callers expect', () => {
  const rows = searchAll(null, 'Piduguralla', { limit: 5 });
  assert.ok(Array.isArray(rows));
  assert.ok(rows.length <= 5);
  for (const r of rows) {
    assert.ok(r.source && r.id && r.title !== undefined && r.subtitle !== undefined);
  }
});

// ── the cache ────────────────────────────────────────────────────────────

test('the fuzzy index refreshes when the corpus changes', () => {
  // The index is cached on (row count, latest updated_at) because rebuilding six
  // Fuse indexes per request was the dominant cost of every search. A stale cache
  // would be worse than the cost it saves.
  assert.equal(search('Brandnewperson', { k: 5 }).results.length, 0);

  contacts.upsertContact({ id: 'C9', name: 'Brandnewperson Rao', mandal: 'Karempudi' });

  const after = search('Brandnewperson', { k: 5 });
  assert.ok(after.results.some(r => r.id === 'C9'), 'a new record was not picked up');
});

test('an edit is visible to both retrievers immediately', () => {
  contacts.upsertContact({ id: 'C9', name: 'Renamedperson Rao', mandal: 'Karempudi' });
  assert.equal(search('Brandnewperson', { k: 5 }).results.length, 0, 'old name still matches');
  assert.ok(search('Renamedperson', { k: 5 }).results.some(r => r.id === 'C9'));
});
