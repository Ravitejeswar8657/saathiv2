// server/search.js
// Retrieval over the app's own records.
//
// Ported step for step from ../../brain/services/core/modules/search/service.py.
// Brain fuses SQLite FTS5 with Qdrant vectors; saathi has no vector store and runs
// on Node, so the second retriever is Fuse.js fuzzy matching instead. The pipeline
// around it — concurrent fan-out, reciprocal rank fusion, bounded graph expansion,
// degrade-never-fail — is the same, and so is the response shape, which is what
// makes adding vectors later a change to ONE function.
//
// What this replaces: six Fuse.js indexes constructed from scratch on every single
// request, merged by raw score, over the whole of db.json.
import Fuse from 'fuse.js';

import { getDb } from './db/connection.js';
import { ftsSearch, indexStats } from './db/search_index.js';

// The RRF constant. 60 is the standard value and it is doing real work: it stops
// one retriever's top rank from drowning the other's mid-rank hit, which is
// exactly the case that matters when BM25 and fuzzy disagree about a misspelling.
const RRF_K = 60;

// Graph expansion only fires once direct retrieval has found a foothold, and its
// results are always scored below the worst direct hit.
const GRAPH_MIN_RESULTS = 3;
const GRAPH_SEED_COUNT = 5;
const GRAPH_MAX_ADDED = 10;

// The record types, mapped back to the collection names the existing pages use.
// admin.html groups results by `source` and prints it as a heading, so this is
// user-visible text, not an internal key.
const TYPE_TO_COLLECTION = {
  contact: 'contacts',
  grievance: 'grievances',
  feedback: 'grievances',
  event: 'schedule',
  news: 'news',
  report: 'campaign_reports',
  post: 'social_posts',
  letter: 'ttd_letters',
};

// ── the fuzzy retriever ──────────────────────────────────────────────────
// One Fuse index over a projection of `records`, rebuilt only when the corpus
// actually changes. The old code built six indexes per request; at 3,255 records
// that was the dominant cost of every search and of every chat turn.
//
// The cache key is (row count, latest updated_at). Both come from one indexed
// query, and together they catch inserts, updates and deletes — a pure delete
// changes the count, an edit changes the timestamp.
let fuseCache = { key: null, fuse: null, rows: [] };

function corpusVersion() {
  const row = getDb().prepare(`
    SELECT COUNT(*) n, COALESCE(MAX(updated_at), '') t
      FROM records WHERE deleted_at IS NULL`).get();
  return `${row.n}:${row.t}`;
}

function fuzzyIndex() {
  const key = corpusVersion();
  if (fuseCache.key === key) return fuseCache;

  const rows = getDb().prepare(`
    SELECT id AS record_id, type, title, body, summary, source_table, source_id,
           status, occurred_at, created_at, superseded_by
      FROM records
     WHERE deleted_at IS NULL`).all();

  // Threshold 0.35 is carried over from the Fuse usage this replaces, so a query
  // that matched before still matches. Title is weighted above body for the same
  // reason BM25 is: someone named after a village should outrank everyone who
  // merely lives there.
  const fuse = new Fuse(rows, {
    keys: [{ name: 'title', weight: 3 }, { name: 'summary', weight: 2 }, { name: 'body', weight: 1 }],
    threshold: 0.35,
    ignoreLocation: true,
    includeScore: true,
  });

  fuseCache = { key, fuse, rows };
  return fuseCache;
}

function fuzzySearch(query, { limit, types, excludeSuperseded, excludeArchived }) {
  const { fuse } = fuzzyIndex();
  return fuse.search(query, { limit: limit * 3 })
    .map(r => r.item)
    .filter(r => {
      if (types?.length && !types.includes(r.type)) return false;
      if (excludeSuperseded && r.superseded_by) return false;
      if (excludeArchived && r.status === 'archived') return false;
      return true;
    })
    .slice(0, limit);
}

// ── the vector seam ──────────────────────────────────────────────────────
/**
 * The third retriever, deliberately unimplemented.
 *
 * Adding embeddings later means filling this in and nothing else: the fusion, the
 * graph expansion, the hydration, the response shape and the UI all stay as they
 * are. That separation is why brain was buildable in phases and it is worth
 * keeping here even while the function returns nothing.
 *
 * Returning `{ available: false }` rather than an empty list is the distinction
 * `degraded` is built on — "no vector store configured" is a different answer
 * from "the vector store found nothing", and only the first should be reported.
 */
function vectorSearch() {
  return { available: false, results: [] };
}

// ── fusion ───────────────────────────────────────────────────────────────

/**
 * Reciprocal rank fusion: score(d) = Σ 1/(RRF_K + rank_in_list).
 *
 * Rank-based rather than score-based on purpose — BM25 returns negative scores on
 * one scale and Fuse returns 0..1 distances on another, and no normalization of
 * the two is meaningful. Ranks are comparable by construction.
 */
function fuse(lists) {
  const scores = new Map();
  const origins = new Map();
  const byId = new Map();

  for (const [origin, rows] of Object.entries(lists)) {
    rows.forEach((row, i) => {
      const id = row.record_id;
      scores.set(id, (scores.get(id) || 0) + 1 / (RRF_K + i + 1));
      if (!origins.has(id)) origins.set(id, new Set());
      origins.get(id).add(origin);
      if (!byId.has(id)) byId.set(id, row);
    });
  }

  return [...scores.entries()]
    .map(([id, score]) => {
      const from = origins.get(id);
      return {
        ...byId.get(id),
        score,
        // A hit both retrievers found is `hybrid`; otherwise it is named for the
        // one that found it. This is what the per-source badge row counts.
        origin: from.size > 1 ? 'hybrid' : [...from][0],
      };
    })
    .sort((a, b) => b.score - a.score);
}

// ── graph expansion ──────────────────────────────────────────────────────

/**
 * Widen the result set by one hop through the entity graph.
 *
 * Records → the entities they are about → other records about those entities.
 * This is what makes a search for a grievance in Piduguralla also surface the
 * contacts and events tied to that place, which no amount of text matching would
 * do because those records do not contain the query's words.
 *
 * Bounded on purpose: it only fires when direct retrieval already found a
 * foothold (otherwise a one-word query drags in the whole graph), it seeds from
 * the top few hits only, it adds at most GRAPH_MAX_ADDED, and every result it
 * adds is scored BELOW the worst direct hit. Graph results fill recall gaps; they
 * do not outrank direct matches.
 */
function graphExpand(merged, { types, excludeSuperseded, excludeArchived }) {
  if (merged.length < GRAPH_MIN_RESULTS) return [];

  const db = getDb();
  const seeds = merged.slice(0, GRAPH_SEED_COUNT).map(r => r.record_id);
  const present = new Set(merged.map(r => r.record_id));

  const q = n => Array(n).fill('?').join(', ');

  const entityIds = db.prepare(`
    SELECT DISTINCT dst_id FROM entity_links
     WHERE src_type = 'record' AND dst_type = 'entity' AND invalid_at IS NULL
       AND src_id IN (${q(seeds.length)})`).all(...seeds).map(r => r.dst_id);
  if (!entityIds.length) return [];

  const where = ['r.deleted_at IS NULL'];
  const params = [...entityIds];
  if (types?.length) { where.push(`r.type IN (${q(types.length)})`); params.push(...types); }
  if (excludeSuperseded) where.push('r.superseded_by IS NULL');
  if (excludeArchived) where.push("r.status <> 'archived'");

  const candidates = db.prepare(`
    SELECT DISTINCT r.id AS record_id, r.type, r.title, r.body, r.summary,
           r.source_table, r.source_id, r.status, r.occurred_at, r.created_at,
           r.importance
      FROM entity_links l
      JOIN records r ON r.id = l.src_id
     WHERE l.dst_type = 'entity' AND l.src_type = 'record' AND l.invalid_at IS NULL
       AND l.dst_id IN (${q(entityIds.length)})
       AND ${where.join(' AND ')}
     ORDER BY r.importance DESC, r.updated_at DESC
     LIMIT ?`).all(...params, GRAPH_MAX_ADDED * 4);

  // Scored strictly below the worst direct hit, and decreasing among themselves
  // so their own order is stable rather than arbitrary.
  const floor = merged[merged.length - 1].score * 0.5;
  return candidates
    .filter(r => !present.has(r.record_id))
    .slice(0, GRAPH_MAX_ADDED)
    .map((r, i) => ({ ...r, origin: 'graph', score: Math.min(floor, 0.05) / (i + 2) }));
}

// ── the public API ───────────────────────────────────────────────────────

/**
 * Retrieve, rank and hydrate.
 *
 * Never throws for a retrieval reason. A retriever that is unavailable sets
 * `degraded` and the rest of the pipeline carries on — a dashboard with a search
 * box on it must not 500 because half of search is down.
 */
export function search(query, { k = 10, filters = {} } = {}) {
  const trimmed = String(query || '').trim();
  const base = { query: trimmed, k, degraded: false, sources: {}, results: [] };
  if (!trimmed) return base;

  // Defaults, matching brain: a superseded record is a correction that has been
  // replaced, and an archived one has been deliberately put away. Neither belongs
  // in a default result set, and both are still reachable by asking for them.
  const opts = {
    types: filters.types || filters.sources?.map(collectionToType).filter(Boolean) || null,
    excludeSuperseded: filters.excludeSuperseded !== false,
    excludeArchived: filters.excludeArchived !== false,
  };

  // Over-fetch from each retriever so fusion has something to fuse. Fusing two
  // top-k lists would mean any record only one retriever ranked highly gets
  // whatever rank the other never gave it.
  const limit = Math.max(k * 2, 16);
  const lists = {};
  let degraded = false;

  try {
    lists.fts = ftsSearch(trimmed, { limit, ...opts });
  } catch (err) {
    console.error('search: fts retriever failed:', err.message);
    degraded = true;
  }

  try {
    lists.fuzzy = fuzzySearch(trimmed, { limit, ...opts });
  } catch (err) {
    console.error('search: fuzzy retriever failed:', err.message);
    degraded = true;
  }

  const vector = vectorSearch();
  if (vector.available) lists.vector = vector.results;

  let merged = fuse(lists);

  let graph = [];
  try {
    graph = graphExpand(merged, opts);
  } catch (err) {
    // Expansion is a recall bonus, never a requirement.
    console.error('search: graph expansion failed:', err.message);
  }
  merged = [...merged, ...graph].slice(0, k);

  return {
    query: trimmed,
    k,
    degraded,
    sources: countSources(merged),
    results: merged.map(hydrate),
  };
}

/**
 * Per-origin counts.
 *
 * The key is `sources`, and it is SPARSE — an origin that contributed nothing is
 * omitted, and `hybrid` is a key like any other. Brain shipped a bug where the
 * client declared this as `counts` with exactly three required numbers, so the
 * badge row rendered nothing for the whole life of the page and type-checked
 * perfectly while doing it. The test pins both the name and the tally.
 */
function countSources(rows) {
  const out = {};
  for (const r of rows) out[r.origin] = (out[r.origin] || 0) + 1;
  return out;
}

// Results carry both the corpus identity (record_id) and the domain identity
// (source + id), because the UI links through to a page that knows nothing about
// `records`.
function hydrate(row, i) {
  return {
    record_id: row.record_id,
    source: TYPE_TO_COLLECTION[row.type] || row.type,
    id: row.source_id,
    type: row.type,
    rank: i + 1,
    score: row.score,
    origin: row.origin,
    title: row.title,
    subtitle: row.summary || '',
    body: row.body,
    occurred_at: row.occurred_at,
  };
}

function collectionToType(collection) {
  return Object.keys(TYPE_TO_COLLECTION).find(t => TYPE_TO_COLLECTION[t] === collection) || null;
}

/**
 * Retriever health and corpus size.
 *
 * This endpoint exists because "search isn't answering" has several very
 * different causes — an empty corpus, a broken index, a retriever that threw —
 * and an operator cannot act until they know which. It pays for itself the first
 * week.
 */
export function status() {
  const stats = indexStats();
  let ftsOk = true;
  let ftsError = null;
  try {
    getDb().prepare("INSERT INTO records_fts(records_fts) VALUES('integrity-check')").run();
  } catch (err) {
    ftsOk = false;
    ftsError = err.message;
  }

  return {
    corpus: {
      total: stats.reduce((n, s) => n + s.n, 0),
      by_type: Object.fromEntries(stats.map(s => [s.source, s.n])),
    },
    retrievers: {
      fts: { available: ftsOk, kind: 'sqlite-fts5-bm25', error: ftsError },
      fuzzy: { available: true, kind: 'fuse.js', cached_rows: fuzzyIndex().rows.length },
      // Declared and off, so an operator can see that semantic search is absent
      // by design rather than broken.
      vector: { available: false, kind: 'none', error: 'no vector store configured' },
    },
    fusion: { method: 'reciprocal-rank', k: RRF_K },
    graph: { min_results: GRAPH_MIN_RESULTS, seeds: GRAPH_SEED_COUNT, max_added: GRAPH_MAX_ADDED },
  };
}

/**
 * The old flat-list API, kept so the existing GET /api/search?q= callers and the
 * chat grounding step do not change shape underneath them.
 */
export function searchAll(_db, query, { limit = 30 } = {}) {
  return search(query, { k: limit }).results;
}
