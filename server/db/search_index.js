// server/db/search_index.js
// The FTS5 half of retrieval: BM25 keyword search over `records_fts`.
//
// This module no longer maintains the index. It used to expose
// indexRecord()/removeFromIndex() that every repository had to remember to call
// on every write; the index is now external-content with triggers (001_core.sql),
// so SQLite keeps it current and a repository that forgets nothing can no longer
// serve stale results. What is left here is querying.
//
// Ported from ../../../brain/services/core/modules/memory/repository.py
// (fts_query + the MATCH join).
import { getDb } from './connection.js';

/**
 * Turn typed user text into an FTS5 MATCH expression.
 *
 * FTS5's query syntax treats bare punctuation, AND/OR/NOT and quotes as operators,
 * so passing a user's raw string straight to MATCH throws SQLITE_ERROR on inputs
 * as ordinary as "water supply?" or a name with an apostrophe — and those are not
 * edge cases here, they are what people type. Every token is quoted (making it a
 * literal) and the last one gets a prefix `*` so results narrow as the user types.
 */
export function toMatchQuery(raw, { mode = 'all' } = {}) {
  const tokens = tokenize(raw);
  if (!tokens.length) return null;
  const quoted = tokens.map((t, i) => (i === tokens.length - 1 ? `"${t}"*` : `"${t}"`));
  return quoted.join(mode === 'any' ? ' OR ' : ' AND ');
}

function tokenize(raw) {
  return String(raw || '').replace(/["*()^:-]/g, ' ').split(/\s+/).filter(Boolean);
}

/**
 * BM25 keyword search over the corpus.
 *
 * bm25() is FTS5's relevance score — lower (more negative) is better — and the
 * column weights push a title hit above a body hit, so searching a village name
 * ranks the contact actually named that above the hundred who merely live there.
 *
 * The weights must be given for EVERY indexed column in declaration order
 * (title, body, summary). An earlier version of this file passed weights for the
 * table's UNINDEXED columns too, which silently weighted the wrong things and
 * left title/body at the default 1.0 — it looked correct and ranked by body
 * length instead.
 *
 * Filters are applied HERE, inside the query, not after scoring. Filtering
 * afterwards lets excluded rows consume the LIMIT budget, so the caller silently
 * gets fewer results than it asked for and cannot tell why.
 */
export function ftsSearch(query, opts = {}) {
  // Require every term first — that is what makes "karempudi water" mean both
  // words, which is what someone typing into a search box wants.
  const strict = runMatch(toMatchQuery(query, { mode: 'all' }), opts);
  if (strict.length) return strict;

  // Then relax to ANY term. Without this step the chat assistant retrieves
  // nothing at all, because it feeds the user's whole sentence in as the query:
  // "Which grievances are open in Karempudi?" ANDs "which" and "are" against a
  // corpus that contains neither, so a question that has an obvious answer
  // returns zero records and the model is told there is no data.
  //
  // Recall over precision is the right trade here specifically because BM25 still
  // ranks: a record matching three terms scores far above one matching "in".
  const tokens = tokenize(query);
  if (tokens.length < 2) return strict;

  // Stopwords are dropped in the RELAXED pass only. They carry no retrieval
  // signal, and under OR they actively mislead: title weighting is 10x, so a
  // contact who happens to be called "Are. Manikanta" outranks the grievance the
  // question was about, on the strength of the word "are".
  //
  // Not dropped in the strict pass, because there a stopword is a term the user
  // explicitly asked to be present, and names in this data really do collide with
  // English function words.
  const content = tokens.filter(t => !STOPWORDS.has(t.toLowerCase()));
  const relaxed = content.length ? content.join(' ') : query;
  return runMatch(toMatchQuery(relaxed, { mode: 'any' }), opts);
}

// Deliberately short: function words that appear in questions staff actually type.
// A long list starts removing terms that matter in a domain corpus.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'am',
  'do', 'does', 'did', 'has', 'have', 'had', 'can', 'could', 'should', 'would',
  'will', 'shall', 'may', 'might', 'must',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'it', 'its', 'they', 'them', 'their',
  'this', 'that', 'these', 'those',
  'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how',
  'in', 'on', 'at', 'to', 'for', 'of', 'from', 'by', 'with', 'about',
  'and', 'or', 'but', 'if', 'then', 'than', 'so', 'as',
  'any', 'all', 'some', 'many', 'much', 'more', 'most',
  'there', 'here', 'not', 'no', 'yes', 'please', 'show', 'tell', 'give', 'list',
]);

function runMatch(match, {
  limit = 30,
  types = null,
  excludeSuperseded = true,
  excludeArchived = true,
} = {}) {
  if (!match) return [];

  const where = ['records_fts MATCH ?', 'r.deleted_at IS NULL'];
  const params = [match];

  if (types?.length) {
    where.push(`r.type IN (${types.map(() => '?').join(', ')})`);
    params.push(...types);
  }
  if (excludeSuperseded) where.push('r.superseded_by IS NULL');
  if (excludeArchived) where.push("r.status <> 'archived'");

  try {
    return getDb().prepare(`
      SELECT r.id AS record_id, r.type, r.title, r.body, r.summary,
             r.source_table, r.source_id, r.status, r.occurred_at, r.created_at,
             bm25(records_fts, 10.0, 1.0, 3.0) AS score
        FROM records_fts
        JOIN records r ON r.rowid = records_fts.rowid
       WHERE ${where.join(' AND ')}
       ORDER BY score
       LIMIT ?
    `).all(...params, limit);
  } catch (err) {
    // A malformed MATCH must degrade to "no results", never 500 a page that
    // merely has a search box on it. toMatchQuery should make this unreachable;
    // it is kept because the cost of being wrong is a broken dashboard.
    if (String(err.message).toLowerCase().includes('fts5')) return [];
    throw err;
  }
}

/** Rows currently indexed, per type. Used by /api/search/status and the backfill. */
export function indexStats() {
  return getDb().prepare(`
    SELECT r.type AS source, COUNT(*) n
      FROM records r WHERE r.deleted_at IS NULL
     GROUP BY r.type ORDER BY r.type`).all();
}
