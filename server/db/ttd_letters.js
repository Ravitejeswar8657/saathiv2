// server/db/ttd_letters.js
// The TTD reference letter register.
//
// Two real defects fixed here, both invisible in a JSON array:
//
//   · The reference (TTD/<year>/<seq>) was computed by COUNTING matching entries
//     in the array. Two requests in flight at once both counted the same number
//     and both minted TTD/2026/007 — and that number is quoted to the temple, so
//     the collision is in the world, not just the data. `reference` is now UNIQUE,
//     and nextReference() runs inside the insert's transaction so the count and
//     the write cannot be separated.
//   · `source_visitor_form_id` was a free-floating string into another array. It
//     is a foreign key now, so a letter cannot point at a grievance that is not
//     there.
import { getDb } from './connection.js';
import { ulid, now } from './ids.js';
import { upsertRecord, softDeleteRecordFor } from './records.js';

const COLUMNS = [
  'id', 'reference', 'date', 'name', 'darshan_type', 'phone', 'aadhar',
  'referred_by', 'remarks', 'party_size', 'review_status',
  'source_visitor_form_id', 'created_at',
];

const REVIEW_STATUSES = ['Confirmed', 'Pending Review'];

/** Aadhar comparison strips spaces and dashes; stored normalized so an index helps. */
export function normalizeAadhar(a) {
  return String(a || '').replace(/[\s-]/g, '');
}

function toRecord(row) {
  if (!row) return null;
  const out = { ...row };
  delete out.updated_at;
  delete out.deleted_at;
  return out;
}

function toRow(l) {
  const ts = now();
  const row = {};
  for (const c of COLUMNS) row[c] = l[c] ?? '';
  row.id = l.id;
  row.aadhar = normalizeAadhar(l.aadhar);
  row.party_size = l.party_size == null || l.party_size === '' ? null : Number(l.party_size);
  row.review_status = REVIEW_STATUSES.includes(row.review_status) ? row.review_status : 'Confirmed';
  row.source_visitor_form_id = l.source_visitor_form_id || null;
  row.created_at = l.created_at || ts;
  row.updated_at = ts;
  return row;
}

function projectLetter(l) {
  return {
    type: 'letter',
    sourceTable: 'ttd_letters',
    sourceId: l.id,
    title: `${l.reference} — ${l.name || 'unnamed'}`,
    body: [l.name, l.remarks, l.referred_by, l.darshan_type, l.phone]
      .filter(Boolean).join('\n'),
    summary: [l.darshan_type, l.date, l.review_status].filter(Boolean).join(' · '),
    occurredAt: l.date || null,
    mentions: [
      { kind: 'person', name: l.name },
      { kind: 'person', name: l.referred_by },
      { kind: 'org', name: 'TTD' },
    ].filter(m => m.name),
  };
}

/**
 * The next reference for a year. Call only inside the insert transaction — the
 * count and the row it predicts must be written together or two callers agree on
 * the same answer.
 */
function nextReference(dateStr) {
  const year = (dateStr || new Date().toISOString()).slice(0, 4);
  const n = getDb().prepare(
    "SELECT COUNT(*) n FROM ttd_letters WHERE reference LIKE ?").get(`TTD/${year}/%`).n;
  return `TTD/${year}/${String(n + 1).padStart(3, '0')}`;
}

export function getLetter(id) {
  return toRecord(getDb().prepare(
    'SELECT * FROM ttd_letters WHERE id = ? AND deleted_at IS NULL').get(id));
}

export function listLetters({ from, to } = {}) {
  const where = ['deleted_at IS NULL'];
  const params = {};
  if (from) { where.push('date >= @from'); params.from = from; }
  if (to)   { where.push('date <= @to');   params.to = to; }
  return getDb().prepare(`
    SELECT * FROM ttd_letters WHERE ${where.join(' AND ')}
     ORDER BY date DESC, id DESC`).all(params).map(toRecord);
}

/** The page's headline feature: has this Aadhar been given a letter before? */
export function findByAadhar(aadhar, excludeId = null) {
  const norm = normalizeAadhar(aadhar);
  if (!norm) return [];
  return getDb().prepare(`
    SELECT * FROM ttd_letters
     WHERE deleted_at IS NULL AND aadhar = ? AND id <> COALESCE(?, '')`)
    .all(norm, excludeId).map(toRecord);
}

export function insertLetter(letter) {
  const db = getDb();
  const run = db.transaction(() => {
    const row = toRow({ ...letter, id: letter.id || ulid() });
    if (!row.reference) row.reference = nextReference(row.date);
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO ttd_letters (${cols.join(', ')})
                VALUES (${cols.map(c => `@${c}`).join(', ')})`).run(row);
    upsertRecord(projectLetter(row));
    return row.id;
  });
  return getLetter(run());
}

export function updateLetter(id, patch) {
  const existing = getLetter(id);
  if (!existing) return null;
  const row = toRow({ ...existing, ...patch, id });
  const db = getDb();
  const run = db.transaction(() => {
    const sets = Object.keys(row).filter(c => c !== 'id' && c !== 'created_at');
    db.prepare(`UPDATE ttd_letters SET ${sets.map(c => `${c} = @${c}`).join(', ')}
                 WHERE id = @id`).run(row);
    upsertRecord(projectLetter(row));
  });
  run();
  return getLetter(id);
}

export function softDeleteLetter(id) {
  const ts = now();
  const info = getDb().prepare(
    'UPDATE ttd_letters SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(ts, ts, id);
  if (info.changes) softDeleteRecordFor('ttd_letters', id);
  return info.changes > 0;
}

export function replaceAllLetters(items) {
  const db = getDb();
  const run = db.transaction(list => {
    db.prepare('DELETE FROM ttd_letters').run();
    db.prepare("DELETE FROM records WHERE source_table = 'ttd_letters'").run();
    for (const l of list) insertLetter(l);
  });
  run(items);
  return getDb().prepare('SELECT COUNT(*) n FROM ttd_letters').get().n;
}
