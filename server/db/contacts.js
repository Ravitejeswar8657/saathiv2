// server/db/contacts.js
// Every SQL statement that touches `contacts` lives here. Route handlers call
// these functions; they never see a query. See connection.js for why.
//
// Return shape is deliberately identical to the old db.json contact object —
// same keys, same types — so the strangle step can swap call sites in
// server/index.js without touching a single HTML page or PDF generator.
import { getDb } from './connection.js';
import { upsertRecord, softDeleteRecordFor } from './records.js';

// JSON-valued columns. SQLite has no array type, and these are the only three
// contact fields that are genuinely list/object shaped.
const JSON_COLUMNS = ['top_drivers', 'issues', 'last_log'];

const COLUMNS = [
  'id', 'name', 'phone', 'village', 'mandal', 'constituency', 'occupation',
  'party', 'role', 'area_of_influence', 'krishna_follower', 'tier',
  'priority_level', 'pps_score', 'estimated_reach', 'affinity', 'top_drivers',
  'last_interaction', 'days_since_contact', 'open_grievance',
  'previous_commitment', 'issues', 'last_log', 'remarks', 'ai_reason',
  'manual_brief', 'dob', 'gender', 'religion', 'caste', 'additional_identity',
  'created_at', 'updated_at',
];

// ── row <-> object ───────────────────────────────────────────────────────
function toRecord(row) {
  if (!row) return null;
  const out = { ...row };
  for (const col of JSON_COLUMNS) {
    if (out[col] === null || out[col] === undefined) {
      out[col] = col === 'last_log' ? null : [];
    } else {
      try {
        out[col] = JSON.parse(out[col]);
      } catch {
        // A malformed blob must not take down a list view; the field degrades,
        // the record still renders.
        out[col] = col === 'last_log' ? null : [];
      }
    }
  }
  out.krishna_follower = Boolean(out.krishna_follower);
  delete out.deleted_at;
  return out;
}

function toRow(contact) {
  const now = new Date().toISOString();
  return {
    id: contact.id,
    name: contact.name ?? '',
    phone: contact.phone ?? '',
    village: contact.village ?? '',
    mandal: contact.mandal ?? '',
    constituency: contact.constituency ?? '',
    occupation: contact.occupation ?? '',
    party: contact.party ?? '',
    role: contact.role ?? '',
    area_of_influence: contact.area_of_influence ?? '',
    krishna_follower: contact.krishna_follower ? 1 : 0,
    tier: contact.tier ?? '',
    priority_level: contact.priority_level ?? '',
    pps_score: contact.pps_score ?? 0,
    estimated_reach: contact.estimated_reach ?? 0,
    affinity: contact.affinity ?? '',
    top_drivers: JSON.stringify(contact.top_drivers ?? []),
    last_interaction: contact.last_interaction ?? null,
    days_since_contact: contact.days_since_contact ?? 0,
    open_grievance: contact.open_grievance ?? '',
    previous_commitment: contact.previous_commitment ?? '',
    issues: JSON.stringify(contact.issues ?? []),
    last_log: contact.last_log ? JSON.stringify(contact.last_log) : null,
    remarks: contact.remarks ?? '',
    ai_reason: contact.ai_reason ?? '',
    manual_brief: contact.manual_brief ?? '',
    dob: contact.dob ?? null,
    gender: contact.gender ?? null,
    religion: contact.religion ?? null,
    caste: contact.caste ?? null,
    additional_identity: contact.additional_identity ?? null,
    created_at: contact.created_at ?? now,
    updated_at: now,
  };
}

// What a contact contributes to the retrieval corpus.
//
// Deliberately excludes remarks and ai_reason: remarks holds 4 distinct values
// across 3,252 rows ("TDP Leader" on 2,761 of them) and ai_reason is templated,
// so indexing them makes every contact match every other contact's query.
//
// Also excludes religion/caste/additional_identity, which are declared but
// unpopulated. They must not reach the corpus, because the corpus is what the
// chat assistant is grounded on — GET /api/contacts still lists `caste` as a Fuse
// key today, which is the kind of thing that stops being harmless the moment the
// column has data in it.
function projectContact(contact) {
  return {
    type: 'contact',
    sourceTable: 'contacts',
    sourceId: contact.id,
    title: contact.name || 'Unnamed contact',
    body: [contact.village, contact.mandal, contact.constituency, contact.role,
      contact.area_of_influence, contact.party, contact.occupation,
      contact.open_grievance, contact.previous_commitment].filter(Boolean).join(' · '),
    summary: [contact.role, [contact.village, contact.mandal].filter(Boolean).join(', ')]
      .filter(Boolean).join(' · '),
    // Tier drives how much a contact matters to the office, so it drives how a
    // tie between two equally-matching hits is broken. T1 → 5, T2 → 4, else 3.
    importance: contact.tier === 'T1' ? 5 : contact.tier === 'T2' ? 4 : 3,
    occurredAt: contact.last_interaction || null,
    mentions: [
      { kind: 'person', name: contact.name },
      { kind: 'place', name: contact.village },
      { kind: 'place', name: contact.mandal },
    ].filter(m => m.name),
  };
}

// ── reads ────────────────────────────────────────────────────────────────
export function listContacts({ includeDeleted = false } = {}) {
  const db = getDb();
  const where = includeDeleted ? '' : 'WHERE deleted_at IS NULL';
  return db.prepare(`SELECT ${COLUMNS.join(', ')} FROM contacts ${where}`)
    .all().map(toRecord);
}

export function getContact(id) {
  const db = getDb();
  return toRecord(db.prepare(
    `SELECT ${COLUMNS.join(', ')} FROM contacts WHERE id = ? AND deleted_at IS NULL`).get(id));
}

export function countContacts() {
  return getDb().prepare('SELECT COUNT(*) n FROM contacts WHERE deleted_at IS NULL').get().n;
}

/**
 * The proximity query behind POST /api/schedule and the pre-visit brief.
 *
 * Preserves the ordering rule from server/index.js:441-459 exactly: when a
 * village is given, that village's contacts come first (PPS descending), then
 * the rest of the mandal (PPS descending). Without it, every village in a
 * mandal produces the same list, which is the whole reason the rule exists.
 *
 * `rowid` is the tiebreaker and it is load-bearing, not decoration. PPS scores
 * tie constantly (they come off a formula with few distinct outputs), and the
 * old code sorted with Array#sort, which is stable — so ties kept db.json's
 * order. SQL tie order is arbitrary, so without this the LIMIT picks a
 * DIFFERENT 20 contacts than the JSON version did: 89 of 100 mandal/village
 * combinations returned a different set. rowid is insertion order, and the
 * backfill inserts in db.json order, so this reproduces the old list exactly.
 */
export function findNearby({ mandal, village, limit = 20 }) {
  const db = getDb();
  if (!mandal) return [];

  return db.prepare(`
    SELECT ${COLUMNS.join(', ')} FROM contacts
     WHERE deleted_at IS NULL
       AND (LOWER(mandal) = LOWER(@mandal) OR (@village <> '' AND LOWER(village) = LOWER(@village)))
     ORDER BY CASE WHEN @village <> '' AND LOWER(village) = LOWER(@village) THEN 0 ELSE 1 END,
              pps_score DESC,
              rowid
     LIMIT @limit
  `).all({ mandal, village: village || '', limit }).map(toRecord);
}

export function distinctValues(column) {
  if (!['mandal', 'constituency', 'party', 'role', 'village'].includes(column)) {
    throw new Error(`distinctValues: ${column} is not an allowed column`);
  }
  return getDb().prepare(
    `SELECT DISTINCT ${column} v FROM contacts
      WHERE deleted_at IS NULL AND ${column} <> '' ORDER BY ${column}`)
    .all().map(r => r.v);
}

// ── writes ───────────────────────────────────────────────────────────────
export function upsertContact(contact) {
  const db = getDb();
  const row = toRow(contact);
  const cols = Object.keys(row);
  db.prepare(`
    INSERT INTO contacts (${cols.join(', ')}) VALUES (${cols.map(c => `@${c}`).join(', ')})
    ON CONFLICT(id) DO UPDATE SET
      ${cols.filter(c => c !== 'id' && c !== 'created_at').map(c => `${c} = excluded.${c}`).join(', ')}
  `).run(row);

  upsertRecord(projectContact(contact));
  return getContact(contact.id);
}

export function updateContact(id, patch) {
  const existing = getContact(id);
  if (!existing) return null;
  return upsertContact({ ...existing, ...patch, id });
}

export function softDeleteContact(id) {
  const db = getDb();
  const info = db.prepare(
    'UPDATE contacts SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(new Date().toISOString(), new Date().toISOString(), id);
  if (info.changes) softDeleteRecordFor('contacts', id);
  return info.changes > 0;
}

/**
 * Bulk load, used by the backfill and by the Excel importer.
 *
 * One transaction for the whole batch: 3,255 individual commits would take
 * minutes and leave a partial import behind if it died halfway.
 */
export function replaceAllContacts(contacts) {
  const db = getDb();
  const run = db.transaction(items => {
    db.prepare('DELETE FROM contacts').run();
    // The corpus rows go with them. Their FTS entries follow via the delete
    // trigger, and their entity_links via the next syncRecordEntities — link rows
    // are machine-derived, so a stale one costs a rebuild and never data.
    db.prepare("DELETE FROM records WHERE source_table = 'contacts'").run();
    for (const c of items) upsertContact(c);
  });
  run(contacts);
  return countContacts();
}
