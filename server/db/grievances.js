// server/db/grievances.js
// The grievance register. Every SQL statement touching `grievances` lives here.
//
// Return shape is deliberately identical to the old db.json grievance object —
// same keys, same types, including the legacy singular `image_path`/`media_type`
// and the `media[]` array — so the strangle step can swap call sites in
// server/index.js without touching grievances.html, the Excel export or either
// PDF generator.
//
// The one thing that is genuinely new: the record projected into the corpus
// carries `issue_description` in its BODY. Retrieval used to see only a label
// ("[grievances] Ramesh Kumar — Housing, Piduguralla, Pending"), which is why Ask
// Saathi could tell you a grievance existed and never what it said.
import { getDb } from './connection.js';
import { ulid, now } from './ids.js';
import { listMedia, replaceMedia, mediaPaths } from './media.js';
import {
  upsertRecord, softDeleteRecordFor, getRecordFor, captureVersion, logTimeline,
} from './records.js';

const COLUMNS = [
  'id', 'channel', 'entry_type', 'sentiment', 'intake_mode', 'logged_by',
  'full_name', 'address', 'village', 'mandal', 'assembly_constituency',
  'reference_name', 'reference_number', 'contact_number', 'email', 'date_of_visit',
  'issue_description', 'action_taken', 'action_to_be_taken', 'assigned_officer',
  'resolution_status', 'deadline', 'category', 'urgency', 'urgency_reason',
  'priority_score', 'ocr_confidence', 'transcript', 'escalated_at',
  'suggested_response', 'suggested_next_action', 'drafted_letter_subject',
  'drafted_letter_body', 'source_event_id', 'created_at',
];

// ── row <-> object ───────────────────────────────────────────────────────

function toRecord(row) {
  if (!row) return null;
  const out = { ...row };
  delete out.updated_at;
  delete out.deleted_at;

  const media = listMedia('grievance_media', row.id)
    .map(m => ({ path: m.file_path, mime: m.mime, type: m.type, label: m.label }));
  out.media = media;
  // Legacy singular fields mirror the first attachment so every existing reader
  // (table row media button, delete cleanup, exports) keeps working unchanged.
  out.image_path = media[0]?.path || '';
  out.media_type = media[0]?.type || '';

  // Cross-record references live in entity_links, not in a JSON column. Rebuilt
  // here into the arrays the pages already read.
  out.linked_grievance_ids = linkedGrievanceIds(row.id);
  out.ttd_letter_refs = ttdLetterRefs(row.id);
  return out;
}

// The constrained columns, with the value each falls back to. These MUST match
// the CHECK constraints in 002_domain.sql — which are themselves lifted from the
// Sets in server/index.js, so all three say the same thing in three places.
//
// Blanket-defaulting every column to '' (the obvious first version of toRow) is
// wrong precisely here: '' satisfies no CHECK on this table, so a grievance
// posted without a channel was rejected outright rather than landing as a
// walk-in. An out-of-range value coerces to the default rather than throwing,
// mirroring how buildGrievanceRecord already treats these — an OCR run that
// guesses a category nobody defined should still produce a reviewable record.
const ENUMS = {
  channel:           { values: ['walk_in', 'phone_call', 'whatsapp_text', 'whatsapp_voice'], fallback: 'walk_in' },
  entry_type:        { values: ['grievance', 'feedback'],                                    fallback: 'grievance' },
  sentiment:         { values: ['', 'Positive', 'Neutral', 'Negative', 'Mixed'],             fallback: '' },
  intake_mode:       { values: ['typed', 'ocr', 'dictated', 'mixed'],                        fallback: 'typed' },
  resolution_status: { values: ['Pending', 'In Progress', 'Resolved'],                       fallback: 'Pending' },
  urgency:           { values: ['High', 'Medium', 'Low'],                                    fallback: 'Medium' },
};

function toRow(g) {
  const ts = now();
  const row = {};
  for (const c of COLUMNS) row[c] = g[c] ?? '';

  for (const [col, { values, fallback }] of Object.entries(ENUMS)) {
    if (!values.includes(row[col])) row[col] = fallback;
  }

  row.id = g.id;
  row.priority_score = Number(g.priority_score) || 0;
  row.source_event_id = g.source_event_id || null;
  row.created_at = g.created_at || ts;
  row.updated_at = ts;
  return row;
}

// ── the corpus projection ────────────────────────────────────────────────

// A grievance's searchable text. issue_description is the whole reason retrieval
// exists on this table, so it leads the body; the rest is what people actually
// search by (a village, an officer's name, a category).
function projectGrievance(g) {
  const place = [g.village, g.mandal].filter(Boolean).join(', ');
  return {
    type: g.entry_type === 'feedback' ? 'feedback' : 'grievance',
    sourceTable: 'grievances',
    sourceId: g.id,
    title: g.full_name || (g.issue_description || '').slice(0, 60) || 'Grievance',
    body: [
      g.issue_description, g.action_taken, g.action_to_be_taken, g.urgency_reason,
      g.transcript, place, g.address, g.assigned_officer, g.reference_name,
      g.category, g.contact_number,
    ].filter(Boolean).join('\n'),
    summary: [g.category, place, g.resolution_status].filter(Boolean).join(' · '),
    // A resolved grievance stays retrievable but stops being "open work".
    status: g.resolution_status === 'Resolved' ? 'resolved' : 'active',
    // priority_score is 0-100 and deterministic; importance is 1-5 and drives
    // tie-breaks in retrieval. Mapping one onto the other keeps a single source
    // of truth for "how much does this matter".
    importance: g.priority_score >= 85 ? 5 : g.priority_score >= 70 ? 4
      : g.priority_score >= 55 ? 3 : g.priority_score >= 40 ? 2 : 1,
    occurredAt: g.date_of_visit || g.created_at || null,
    sourceEventId: g.source_event_id || null,
    meta: { category: g.category, urgency: g.urgency, channel: g.channel },
    mentions: [
      { kind: 'person', name: g.full_name },
      { kind: 'place', name: g.village },
      { kind: 'place', name: g.mandal },
      { kind: 'topic', name: g.category },
      { kind: 'person', name: g.assigned_officer },
    ].filter(m => m.name),
  };
}

// ── cross-record links ───────────────────────────────────────────────────

const DUPLICATE_RELATION = 'duplicate_of';
const TTD_RELATION = 'ttd_letter';

export function linkedGrievanceIds(grievanceId) {
  return getDb().prepare(`
    SELECT dst_id FROM entity_links
     WHERE src_id = ? AND src_type = 'grievance' AND dst_type = 'grievance'
       AND relation = ? AND invalid_at IS NULL`)
    .all(grievanceId, DUPLICATE_RELATION).map(r => r.dst_id);
}

/**
 * Link two grievances as duplicates, in both directions.
 *
 * Bidirectional because the pages read the link from whichever record the user
 * happens to be looking at. It was two mutations of two JSON arrays before, and
 * deleting one grievance left a dangling id on the other.
 */
export function linkDuplicates(aId, bId) {
  if (aId === bId) return;
  const db = getDb();
  const ts = now();
  const insert = db.prepare(`
    INSERT INTO entity_links (id, src_id, src_type, dst_id, dst_type, relation, created_at)
    VALUES (@id, @src, 'grievance', @dst, 'grievance', @rel, @ts)
    ON CONFLICT (src_id, dst_id, relation) DO NOTHING`);
  const run = db.transaction(() => {
    insert.run({ id: ulid(), src: aId, dst: bId, rel: DUPLICATE_RELATION, ts });
    insert.run({ id: ulid(), src: bId, dst: aId, rel: DUPLICATE_RELATION, ts });
  });
  run();
}

export function ttdLetterRefs(grievanceId) {
  return getDb().prepare(`
    SELECT t.reference FROM entity_links l
      JOIN ttd_letters t ON t.id = l.dst_id
     WHERE l.src_id = ? AND l.relation = ? AND l.invalid_at IS NULL`)
    .all(grievanceId, TTD_RELATION).map(r => r.reference);
}

export function linkTtdLetter(grievanceId, ttdLetterId) {
  getDb().prepare(`
    INSERT INTO entity_links (id, src_id, src_type, dst_id, dst_type, relation, created_at)
    VALUES (?, ?, 'grievance', ?, 'ttd_letter', ?, ?)
    ON CONFLICT (src_id, dst_id, relation) DO NOTHING`)
    .run(ulid(), grievanceId, ttdLetterId, TTD_RELATION, now());
}

// ── reads ────────────────────────────────────────────────────────────────

export function getGrievance(id) {
  return toRecord(getDb().prepare(
    `SELECT * FROM grievances WHERE id = ? AND deleted_at IS NULL`).get(id));
}

/**
 * The register listing. Filters match GET /api/grievances exactly.
 *
 * Newest first by date_of_visit, then by id — and id is a ULID, so that second
 * key is a creation-time tiebreak rather than an arbitrary one. Two grievances
 * logged on the same day used to come back in whatever order the JSON array held.
 */
export function listGrievances({ from, to, category, status, channel, entryType } = {}) {
  const where = ['deleted_at IS NULL'];
  const params = {};
  if (from)      { where.push('date_of_visit >= @from');        params.from = from; }
  if (to)        { where.push('date_of_visit <= @to');          params.to = to; }
  if (category)  { where.push('category = @category');          params.category = category; }
  if (status)    { where.push('resolution_status = @status');   params.status = status; }
  if (channel)   { where.push('channel = @channel');            params.channel = channel; }
  if (entryType) { where.push('entry_type = @entryType');       params.entryType = entryType; }

  return getDb().prepare(`
    SELECT * FROM grievances WHERE ${where.join(' AND ')}
     ORDER BY date_of_visit DESC, id DESC`).all(params).map(toRecord);
}

export function countOpenGrievances() {
  return getDb().prepare(`
    SELECT COUNT(*) n FROM grievances
     WHERE deleted_at IS NULL AND entry_type = 'grievance'
       AND resolution_status <> 'Resolved'`).get().n;
}

export function countFeedback() {
  return getDb().prepare(
    "SELECT COUNT(*) n FROM grievances WHERE deleted_at IS NULL AND entry_type = 'feedback'")
    .get().n;
}

/** Category rollup for the admin dashboard's breakdown widget. */
export function categoryBreakdown() {
  return getDb().prepare(`
    SELECT category, COUNT(*) n,
           SUM(CASE WHEN resolution_status <> 'Resolved' THEN 1 ELSE 0 END) open_n,
           AVG(priority_score) avg_priority
      FROM grievances
     WHERE deleted_at IS NULL AND entry_type = 'grievance'
     GROUP BY category ORDER BY n DESC`).all();
}

/** Per-mandal rollup for the governance report and the heatmap. */
export function mandalBreakdown() {
  return getDb().prepare(`
    SELECT mandal, village, COUNT(*) n, AVG(priority_score) avg_priority
      FROM grievances
     WHERE deleted_at IS NULL AND entry_type = 'grievance' AND mandal <> ''
     GROUP BY mandal, village ORDER BY n DESC`).all();
}

/** Exact-phone duplicate signal. Callers pass an already-normalized number. */
export function findByPhone(phone, excludeId = null) {
  if (!phone) return [];
  return getDb().prepare(`
    SELECT * FROM grievances
     WHERE deleted_at IS NULL AND contact_number = ? AND id <> COALESCE(?, '')`)
    .all(phone, excludeId).map(toRecord);
}

// ── writes ───────────────────────────────────────────────────────────────

export function insertGrievance(grievance, { media = [] } = {}) {
  const db = getDb();
  const row = toRow({ ...grievance, id: grievance.id || ulid() });

  const run = db.transaction(() => {
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO grievances (${cols.join(', ')})
                VALUES (${cols.map(c => `@${c}`).join(', ')})`).run(row);
    if (media.length) replaceMedia('grievance_media', row.id, media);
    upsertRecord(projectGrievance({ ...grievance, id: row.id }));
    logTimeline({
      kind: 'grievance.logged', refType: 'grievance', refId: row.id,
      text: `${row.entry_type === 'feedback' ? 'Feedback' : 'Grievance'} logged: `
        + `${row.full_name || 'unnamed'} (${row.category})`,
      at: row.created_at,
    });
  });
  run();
  return getGrievance(row.id);
}

/**
 * Partial update, matching PATCH /api/grievances/:id.
 *
 * Snapshots the previous state into record_versions FIRST. Staff re-triage
 * categories and reassign officers routinely, and before this every correction
 * overwrote the previous value with no way back.
 */
export function updateGrievance(id, patch, { editedBy = 'staff', media } = {}) {
  const db = getDb();
  const existing = getGrievance(id);
  if (!existing) return null;

  const merged = { ...existing, ...patch, id };
  const row = toRow(merged);

  const run = db.transaction(() => {
    const rec = getRecordFor('grievances', id);
    if (rec) captureVersion(rec.id, existing, editedBy);

    const sets = Object.keys(row).filter(c => c !== 'id' && c !== 'created_at');
    db.prepare(`UPDATE grievances SET ${sets.map(c => `${c} = @${c}`).join(', ')}
                 WHERE id = @id`).run(row);
    if (media !== undefined) replaceMedia('grievance_media', id, media);
    upsertRecord(projectGrievance(merged));
  });
  run();
  return getGrievance(id);
}

/**
 * Soft delete. Returns the media paths so the caller can unlink the files —
 * the DB drops its rows by cascade, but the bytes on the volume are ours to clean.
 */
export function softDeleteGrievance(id) {
  const db = getDb();
  const paths = mediaPaths('grievance_media', id);
  const ts = now();

  const run = db.transaction(() => {
    db.prepare('UPDATE grievances SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(ts, ts, id);
    softDeleteRecordFor('grievances', id);
    // Duplicate links are machine-derived and point both ways; closing them
    // rather than deleting keeps the fact that they once matched.
    db.prepare(`UPDATE entity_links SET invalid_at = ?
                 WHERE (src_id = ? OR dst_id = ?) AND relation = ?`)
      .run(ts, id, id, DUPLICATE_RELATION);
  });
  run();
  return paths;
}

/** Bulk load for the backfill. One transaction for the whole batch. */
export function replaceAllGrievances(items) {
  const db = getDb();
  const run = db.transaction(list => {
    db.prepare('DELETE FROM grievances').run();
    db.prepare("DELETE FROM records WHERE source_table = 'grievances'").run();
    for (const g of list) {
      insertGrievance(g, { media: g.media?.length ? g.media : legacyMedia(g) });
    }
    // Duplicate links are restored after every row exists, so a pair that
    // references a grievance later in the list still links.
    for (const g of list) {
      for (const other of g.linked_grievance_ids || []) {
        if (list.some(x => x.id === other)) linkDuplicates(g.id, other);
      }
    }
  });
  run(items);
  return getDb().prepare('SELECT COUNT(*) n FROM grievances').get().n;
}

// Older records carry the singular pair instead of a media array.
function legacyMedia(g) {
  return g.image_path ? [{ path: g.image_path, type: g.media_type || 'image', mime: '' }] : [];
}
