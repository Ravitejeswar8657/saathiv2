// server/db/records.js
// The central corpus. Every domain repository writes its typed row, then calls
// upsertRecord() to project that row into `records` — the table retrieval ranks
// over and the table the chat assistant is grounded on.
//
// Adapted from ../../../brain/services/core/modules/memory/repository.py.
//
// Two rules keep this honest:
//
//   · The projection is DERIVED. Every `records` row can be rebuilt from its
//     typed table (see reindexAll), so a bug here costs a rebuild, never data.
//   · `body` is the whole point. The previous design indexed titles and subtitles
//     only, which is why Ask Saathi could tell you a grievance existed but never
//     what it said. Whatever a user might ask about has to be IN body.
import { getDb } from './connection.js';
import { ulid, now } from './ids.js';

// ── entities ─────────────────────────────────────────────────────────────

// Mandal and village names arrive transliterated and inconsistent
// (Chilakaluripeta/Chilakaluripet, Gurajala/Gurazala). Matching on a normalized
// form means the graph converges on one node per real place instead of one per
// spelling, which is what makes "everything in Piduguralla" a single join.
function normalizeName(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Find or create the entity for a name, matching aliases as well as the canonical
 * name. Returns null for blank input rather than minting an empty node — a
 * grievance with no village recorded must not link to an entity called "".
 */
export function resolveEntity(kind, name, { aliases = [] } = {}) {
  const clean = String(name || '').trim();
  if (!clean) return null;

  const db = getDb();
  const norm = normalizeName(clean);

  const exact = db.prepare(
    'SELECT * FROM entities WHERE kind = ? AND lower(name) = ? AND deleted_at IS NULL')
    .get(kind, norm);
  if (exact) return exact;

  // Alias match. Small tables (mandals, departments, categories), so a scan is
  // cheaper than maintaining a second index over a JSON array.
  const byAlias = db.prepare(
    'SELECT * FROM entities WHERE kind = ? AND deleted_at IS NULL AND aliases <> \'[]\'').all(kind);
  for (const row of byAlias) {
    let list = [];
    try { list = JSON.parse(row.aliases); } catch { list = []; }
    if (list.some(a => normalizeName(a) === norm)) return row;
  }

  const ts = now();
  const id = ulid();
  db.prepare(`INSERT INTO entities (id, kind, name, aliases, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, kind, clean, JSON.stringify(aliases), ts, ts);
  return db.prepare('SELECT * FROM entities WHERE id = ?').get(id);
}

/** Register alternate spellings on an existing entity. Idempotent. */
export function addAliases(entityId, aliases) {
  const db = getDb();
  const row = db.prepare('SELECT aliases FROM entities WHERE id = ?').get(entityId);
  if (!row) return false;
  let list = [];
  try { list = JSON.parse(row.aliases); } catch { list = []; }
  const seen = new Set(list.map(normalizeName));
  for (const a of aliases) {
    if (a && !seen.has(normalizeName(a))) { list.push(a); seen.add(normalizeName(a)); }
  }
  db.prepare('UPDATE entities SET aliases = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(list), now(), entityId);
  return true;
}

/**
 * Replace a record's entity links.
 *
 * Links are machine-derived, so wholesale replacement is safe and is the simplest
 * thing that stays correct when a grievance's village is corrected: the old link
 * goes, the new one arrives, and nothing a human wrote is involved.
 */
export function syncRecordEntities(recordId, mentions, { relation = 'about' } = {}) {
  const db = getDb();
  const ts = now();

  const run = db.transaction(() => {
    db.prepare('DELETE FROM entity_links WHERE src_id = ? AND src_type = ? AND relation = ?')
      .run(recordId, 'record', relation);

    // Named parameters, not positional. The first version of this used `?` with
    // two literals inline and put src_type's value into src_id — which a CHECK
    // constraint caught, except that `INSERT OR IGNORE` then swallowed the
    // violation and wrote nothing at all. OR IGNORE suppresses EVERY constraint,
    // not just the one you meant; ON CONFLICT ... DO NOTHING targets exactly the
    // duplicate-mention case (a contact whose village and mandal share a name)
    // and lets a real violation throw.
    const insert = db.prepare(`
      INSERT INTO entity_links
        (id, src_id, src_type, dst_id, dst_type, relation, weight, valid_at, created_at)
      VALUES (@id, @src_id, 'record', @dst_id, 'entity', @relation, @weight, @valid_at, @created_at)
      ON CONFLICT (src_id, dst_id, relation) DO NOTHING`);

    for (const m of mentions) {
      const entity = resolveEntity(m.kind, m.name);
      if (!entity) continue;
      insert.run({
        id: ulid(), src_id: recordId, dst_id: entity.id, relation,
        weight: m.weight ?? 1.0, valid_at: m.validAt ?? null, created_at: ts,
      });
    }
  });
  run();
}

/** Entity ids a record is linked to. Used by retrieval's graph-expansion step. */
export function entityIdsFor(recordId) {
  return getDb().prepare(`
    SELECT dst_id FROM entity_links
     WHERE src_id = ? AND src_type = 'record' AND dst_type = 'entity'
       AND invalid_at IS NULL`).all(recordId).map(r => r.dst_id);
}

// ── records ──────────────────────────────────────────────────────────────

export function getRecordFor(sourceTable, sourceId) {
  return getDb().prepare(
    'SELECT * FROM records WHERE source_table = ? AND source_id = ?').get(sourceTable, sourceId);
}

export function getRecord(id) {
  return getDb().prepare('SELECT * FROM records WHERE id = ?').get(id);
}

/**
 * Project a typed row into the corpus. Insert on first sight, update thereafter,
 * keyed on (source_table, source_id) so re-running an import overwrites instead
 * of duplicating.
 *
 * `mentions` are the entities this row is about; passing them here rather than in
 * a separate call keeps "the record and its edges" one operation, so a caller
 * cannot write half of it.
 */
export function upsertRecord({
  type, title, body, summary = null, sourceTable, sourceId,
  status = 'active', importance = 3, occurredAt = null,
  sourceEventId = null, meta = {}, mentions = [],
}) {
  const db = getDb();
  const ts = now();
  const existing = getRecordFor(sourceTable, sourceId);

  let id;
  if (existing) {
    id = existing.id;
    db.prepare(`
      UPDATE records SET type = ?, title = ?, body = ?, summary = ?, status = ?,
             importance = ?, occurred_at = ?, meta = ?, updated_at = ?, deleted_at = NULL
       WHERE id = ?`)
      .run(type, title ?? '', body ?? '', summary, status, importance,
           occurredAt, JSON.stringify(meta), ts, id);
  } else {
    id = ulid();
    db.prepare(`
      INSERT INTO records (id, type, title, body, summary, status, importance,
                           source_event_id, source_table, source_id, occurred_at,
                           meta, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, type, title ?? '', body ?? '', summary, status, importance,
           sourceEventId, sourceTable, sourceId, occurredAt, JSON.stringify(meta), ts, ts);
  }

  if (mentions.length) syncRecordEntities(id, mentions);
  return id;
}

/**
 * Soft-delete the record behind a typed row.
 *
 * The FTS index still holds the row afterwards — the update trigger re-indexes it
 * with the same text — so every retrieval query MUST join `records` and filter
 * `deleted_at IS NULL`. Filtering in the index instead would mean deleting and
 * re-inserting FTS rows on every soft delete, and a restore would have to rebuild
 * them; the join is cheaper and cannot drift.
 */
export function softDeleteRecordFor(sourceTable, sourceId) {
  const ts = now();
  const info = getDb().prepare(`
    UPDATE records SET deleted_at = ?, updated_at = ?
     WHERE source_table = ? AND source_id = ? AND deleted_at IS NULL`)
    .run(ts, ts, sourceTable, sourceId);
  return info.changes > 0;
}

export function restoreRecordFor(sourceTable, sourceId) {
  const info = getDb().prepare(`
    UPDATE records SET deleted_at = NULL, updated_at = ?
     WHERE source_table = ? AND source_id = ?`).run(now(), sourceTable, sourceId);
  return info.changes > 0;
}

/**
 * Point `oldId` at the record that replaced it. The old row stays readable and
 * stops appearing in default retrieval, which is what makes a correction
 * auditable instead of destructive.
 */
export function supersede(oldId, newId) {
  if (oldId === newId) throw new Error('supersede: a record cannot supersede itself');
  const info = getDb().prepare(
    'UPDATE records SET superseded_by = ?, updated_at = ? WHERE id = ?')
    .run(newId, now(), oldId);
  return info.changes > 0;
}

// ── versions ─────────────────────────────────────────────────────────────

/**
 * Snapshot a record before it changes. Call this BEFORE writing the edit — the
 * version is the state being left behind, not the one being written.
 *
 * `snapshot` carries the full typed row so a grievance's 30 fields are recoverable,
 * not just the three that make up the retrieval projection.
 */
export function captureVersion(recordId, snapshot = {}, editedBy = 'staff') {
  const db = getDb();
  const record = getRecord(recordId);
  if (!record) return null;

  const next = (db.prepare(
    'SELECT MAX(version) v FROM record_versions WHERE record_id = ?').get(recordId).v ?? 0) + 1;

  const id = ulid();
  db.prepare(`INSERT INTO record_versions
                (id, record_id, version, title, body, summary, snapshot, edited_by, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, recordId, next, record.title, record.body, record.summary,
         JSON.stringify(snapshot), editedBy, now());
  return next;
}

export function listVersions(recordId) {
  return getDb().prepare(
    'SELECT * FROM record_versions WHERE record_id = ? ORDER BY version DESC').all(recordId);
}

// ── timeline ─────────────────────────────────────────────────────────────

export function logTimeline({ kind, text, refType = null, refId = null, at = null }) {
  const ts = now();
  getDb().prepare(`INSERT INTO timeline (id, at, kind, ref_type, ref_id, text, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(ulid(), at || ts, kind, refType, refId, text, ts);
}

export function recentTimeline(limit = 50) {
  return getDb().prepare('SELECT * FROM timeline ORDER BY at DESC LIMIT ?').all(limit);
}

// ── settings ─────────────────────────────────────────────────────────────
// Replaces db.json's `metadata` blob. Values are JSON-encoded so a setting can
// hold something other than a string without a second column.

export function getSetting(key, fallback = null) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

export function setSetting(key, value) {
  getDb().prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, JSON.stringify(value), now());
  return value;
}

export function allSettings() {
  const out = {};
  for (const row of getDb().prepare('SELECT key, value FROM settings').all()) {
    try { out[row.key] = JSON.parse(row.value); } catch { out[row.key] = row.value; }
  }
  return out;
}

// ── stats ────────────────────────────────────────────────────────────────

/** Rows in the corpus per type. Used by /api/search/status and the backfill check. */
export function recordStats() {
  return getDb().prepare(`
    SELECT type, COUNT(*) n FROM records WHERE deleted_at IS NULL
     GROUP BY type ORDER BY type`).all();
}

/**
 * Rebuild the FTS index from `records`.
 *
 * External-content FTS5 keeps no copy of the text, so 'rebuild' re-derives every
 * entry from the base table. This is the repair path for an index that was
 * restored from a backup taken mid-write, and it is why nothing here has to trust
 * the index's contents.
 */
export function rebuildFts() {
  getDb().prepare("INSERT INTO records_fts(records_fts) VALUES('rebuild')").run();
  return getDb().prepare('SELECT COUNT(*) n FROM records WHERE deleted_at IS NULL').get().n;
}

/** FTS5's own consistency check. Throws if the index disagrees with the table. */
export function checkFts() {
  getDb().prepare("INSERT INTO records_fts(records_fts) VALUES('integrity-check')").run();
  return true;
}
