// server/db/raw_events.js
// The inbox. Everything inbound lands here BEFORE it reaches Gemini or a
// repository, so no failure downstream can lose what was actually submitted.
//
// Today a photographed grievance form goes straight into extraction: if Gemini
// throws, or times out, or the staff member closes the review screen, there is no
// record the form was ever handed in. A bulk upload of 20 forms that dies on form
// 14 loses six of them, and the only evidence is a citizen who says they came in.
//
// The lifecycle is deliberately about PROCESSING, not about the grievance:
//   pending      → received, not yet extracted
//   compiled     → extraction produced a record (which one is in meta.record_id)
//   needs_review → extracted, but low confidence; a human must look
//   skipped      → deliberately not turned into a record (a duplicate, a greeting)
//   failed       → extraction errored; the bytes are still here to retry
import crypto from 'crypto';
import { getDb } from './connection.js';
import { ulid, now } from './ids.js';

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Record an inbound submission.
 *
 * `hash` enables the dedupe path below; pass it for anything with bytes. It is
 * stored inside `meta` and read through the expression index declared in
 * 001_core.sql — a plain index on `meta` would never be used.
 */
export function record({ source, kind, sender = null, body = null, filePath = null, hash = null, meta = {} }) {
  const id = ulid();
  const payload = hash ? { ...meta, sha256: hash } : meta;
  getDb().prepare(`
    INSERT INTO raw_events (id, source, kind, sender, body, file_path, status, meta, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
    .run(id, source, kind, sender, body, filePath, JSON.stringify(payload), now());
  return id;
}

/**
 * The event for a hash, if this exact input has been seen before.
 *
 * Staff re-photograph forms constantly — the same page, a second time, because
 * the first shot was blurry or because two people uploaded the same batch. Left
 * alone that produces two grievances for one citizen.
 */
export function findByHash(hash) {
  if (!hash) return null;
  return getDb().prepare(`
    SELECT * FROM raw_events
     WHERE json_extract(meta, '$.sha256') = ?
     ORDER BY created_at DESC LIMIT 1`).get(hash) || null;
}

/** Move an event out of `pending`. `recordId` is stored for the audit trail. */
export function markStatus(id, status, { recordId = null, error = null } = {}) {
  const db = getDb();
  const row = db.prepare('SELECT meta FROM raw_events WHERE id = ?').get(id);
  if (!row) return false;

  let meta = {};
  try { meta = JSON.parse(row.meta); } catch { meta = {}; }
  if (recordId) meta.record_id = recordId;
  if (error) meta.error = String(error).slice(0, 500);

  const info = db.prepare(`
    UPDATE raw_events SET status = ?, meta = ?,
           compiled_at = CASE WHEN ? IN ('compiled','skipped') THEN ? ELSE compiled_at END
     WHERE id = ?`)
    .run(status, JSON.stringify(meta), status, now(), id);
  return info.changes > 0;
}

export function getEvent(id) {
  return getDb().prepare('SELECT * FROM raw_events WHERE id = ?').get(id) || null;
}

/**
 * Submissions that never became a record. This is the queue that did not exist
 * before — the answer to "did anything we received today get dropped?".
 */
export function listUnresolved({ limit = 100 } = {}) {
  return getDb().prepare(`
    SELECT * FROM raw_events
     WHERE status IN ('pending','failed','needs_review')
     ORDER BY created_at DESC LIMIT ?`).all(limit);
}

export function statusCounts() {
  return getDb().prepare(
    'SELECT status, COUNT(*) n FROM raw_events GROUP BY status ORDER BY status').all();
}
