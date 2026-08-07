// server/db/events.js
// The schedule. `events` in SQL, `schedule` in the API — the repository returns
// the old key shape so pa_schedule.html, brief_workflow.html and the daily-brief
// PDF are untouched.
//
// The substantive change is nearby_contacts. db.json embedded frozen COPIES of
// each contact (name, phone, role, tier, pps_score) inside the event, so a
// contact who moved village or changed tier stayed wrong on every event already
// scheduled — and there was no way to notice. Those fields are now JOINED from
// `contacts` at read time. Only the occasion-specific, PA-written brief is stored
// on the join row, because that is the part a human wrote and a recompute would
// destroy.
import { getDb } from './connection.js';
import { ulid, now } from './ids.js';
import { upsertRecord, softDeleteRecordFor, logTimeline } from './records.js';

const COLUMNS = [
  'id', 'event_name', 'date', 'time', 'address', 'village', 'mandal',
  'description', 'event_type', 'audience_cohort', 'contacts_approved',
  'contacts_approved_at', 'speech_points', 'speech_points_reviewed',
  'speech_skipped', 'creative_touches', 'news_selected', 'created_at',
];

const JSON_COLUMNS = ['creative_touches', 'news_selected'];
const BOOL_COLUMNS = ['contacts_approved', 'speech_points_reviewed', 'speech_skipped'];

const EMPTY_TOUCHES = { selected: [], custom: [], reviewed: false };

function toRecord(row) {
  if (!row) return null;
  const out = { ...row };
  delete out.updated_at;
  delete out.deleted_at;

  for (const c of JSON_COLUMNS) {
    try {
      out[c] = JSON.parse(out[c]);
    } catch {
      // A malformed blob must not take down the schedule page; the field
      // degrades to its empty shape and the event still renders.
      out[c] = c === 'creative_touches' ? { ...EMPTY_TOUCHES } : [];
    }
  }
  for (const c of BOOL_COLUMNS) out[c] = Boolean(out[c]);

  out.nearby_contacts = listEventContacts(row.id);
  out.nearby_count = out.nearby_contacts.length;
  return out;
}

function toRow(e) {
  const ts = now();
  const row = {};
  for (const c of COLUMNS) row[c] = e[c] ?? '';
  row.id = e.id;
  for (const c of JSON_COLUMNS) {
    row[c] = typeof e[c] === 'string' ? e[c]
      : JSON.stringify(e[c] ?? (c === 'creative_touches' ? EMPTY_TOUCHES : []));
  }
  for (const c of BOOL_COLUMNS) row[c] = e[c] ? 1 : 0;
  row.contacts_approved_at = e.contacts_approved_at || null;
  row.created_at = e.created_at || ts;
  row.updated_at = ts;
  return row;
}

function projectEvent(e) {
  const place = [e.village, e.mandal].filter(Boolean).join(', ');
  return {
    type: 'event',
    sourceTable: 'events',
    sourceId: e.id,
    title: e.event_name || 'Event',
    body: [e.description, e.address, place, e.event_type, e.speech_points]
      .filter(Boolean).join('\n'),
    summary: [e.date, place].filter(Boolean).join(' · '),
    occurredAt: e.date || null,
    mentions: [
      { kind: 'place', name: e.village },
      { kind: 'place', name: e.mandal },
    ].filter(m => m.name),
  };
}

// ── event_contacts ───────────────────────────────────────────────────────

/**
 * The event's contact list, in the order the proximity query produced.
 *
 * Everything except event_brief/brief_reviewed comes from `contacts` live. A
 * contact soft-deleted after the event was scheduled drops out (INNER JOIN),
 * which is the behaviour the old embedded copies could not have.
 */
export function listEventContacts(eventId) {
  return getDb().prepare(`
    SELECT c.id, c.name, c.phone, c.village, c.role, c.tier, c.pps_score,
           c.open_grievance, ec.event_brief, ec.brief_reviewed
      FROM event_contacts ec
      JOIN contacts c ON c.id = ec.contact_id AND c.deleted_at IS NULL
     WHERE ec.event_id = ?
     ORDER BY ec.position`).all(eventId)
    .map(r => ({ ...r, brief_reviewed: Boolean(r.brief_reviewed) }));
}

/** Attach contacts to an event, preserving the caller's ordering. */
export function setEventContacts(eventId, contactIds) {
  const db = getDb();
  const ts = now();
  const insert = db.prepare(`
    INSERT INTO event_contacts (id, event_id, contact_id, position, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (event_id, contact_id) DO NOTHING`);
  const run = db.transaction(ids => {
    db.prepare('DELETE FROM event_contacts WHERE event_id = ?').run(eventId);
    ids.forEach((cid, i) => insert.run(ulid(), eventId, cid, i, ts));
  });
  run(contactIds);
}

/** The PA's per-contact brief. The one field on this join a human writes. */
export function setEventContactBrief(eventId, contactId, { event_brief, brief_reviewed }) {
  const info = getDb().prepare(`
    UPDATE event_contacts SET event_brief = COALESCE(?, event_brief),
           brief_reviewed = COALESCE(?, brief_reviewed)
     WHERE event_id = ? AND contact_id = ?`)
    .run(event_brief ?? null,
         brief_reviewed === undefined ? null : (brief_reviewed ? 1 : 0),
         eventId, contactId);
  return info.changes > 0;
}

// ── reads ────────────────────────────────────────────────────────────────

export function getEvent(id) {
  return toRecord(getDb().prepare(
    'SELECT * FROM events WHERE id = ? AND deleted_at IS NULL').get(id));
}

export function listEvents({ from, to } = {}) {
  const where = ['deleted_at IS NULL'];
  const params = {};
  if (from) { where.push('date >= @from'); params.from = from; }
  if (to)   { where.push('date <= @to');   params.to = to; }
  return getDb().prepare(`
    SELECT * FROM events WHERE ${where.join(' AND ')}
     ORDER BY date DESC, id DESC`).all(params).map(toRecord);
}

export function countUpcomingEvents(today) {
  return getDb().prepare(
    'SELECT COUNT(*) n FROM events WHERE deleted_at IS NULL AND date >= ?').get(today).n;
}

// ── writes ───────────────────────────────────────────────────────────────

export function insertEvent(event, { contactIds = [] } = {}) {
  const db = getDb();
  const row = toRow({ ...event, id: event.id || ulid() });

  const run = db.transaction(() => {
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO events (${cols.join(', ')})
                VALUES (${cols.map(c => `@${c}`).join(', ')})`).run(row);
    if (contactIds.length) setEventContacts(row.id, contactIds);
    upsertRecord(projectEvent({ ...event, id: row.id }));
    logTimeline({
      kind: 'event.scheduled', refType: 'event', refId: row.id,
      text: `Event scheduled: ${row.event_name} (${row.date})`, at: row.created_at,
    });
  });
  run();
  return getEvent(row.id);
}

export function updateEvent(id, patch) {
  const existing = getEvent(id);
  if (!existing) return null;
  const merged = { ...existing, ...patch, id };
  const row = toRow(merged);

  const db = getDb();
  const run = db.transaction(() => {
    const sets = Object.keys(row).filter(c => c !== 'id' && c !== 'created_at');
    db.prepare(`UPDATE events SET ${sets.map(c => `${c} = @${c}`).join(', ')} WHERE id = @id`)
      .run(row);
    upsertRecord(projectEvent(merged));
  });
  run();
  return getEvent(id);
}

export function softDeleteEvent(id) {
  const ts = now();
  const info = getDb().prepare(
    'UPDATE events SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(ts, ts, id);
  if (info.changes) softDeleteRecordFor('events', id);
  return info.changes > 0;
}

export function replaceAllEvents(items) {
  const db = getDb();
  const run = db.transaction(list => {
    db.prepare('DELETE FROM events').run();
    db.prepare("DELETE FROM records WHERE source_table = 'events'").run();
    for (const e of list) {
      const contactIds = (e.nearby_contacts || []).map(c => c.id).filter(Boolean);
      insertEvent(e, { contactIds });
      // The PA-written briefs are the part that cannot be recomputed, so they are
      // carried across explicitly rather than left to the join.
      for (const c of e.nearby_contacts || []) {
        if (c.event_brief || c.brief_reviewed) {
          setEventContactBrief(e.id, c.id, {
            event_brief: c.event_brief, brief_reviewed: c.brief_reviewed,
          });
        }
      }
    }
  });
  run(items);
  return getDb().prepare('SELECT COUNT(*) n FROM events').get().n;
}
