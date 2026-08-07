// server/db/media.js
// Attachments for grievances, campaign reports and social posts.
//
// All three stored their attachments as a JSON `media[]` array on the parent
// record, and two of them ALSO kept legacy singular fields mirroring the first
// element (grievances: image_path/media_type; campaign reports: attachment).
// Three tables with an identical shape and a FK is the same data with referential
// integrity and an ON DELETE CASCADE, which is what stops a media row outliving
// the grievance it belongs to.
//
// The repositories rebuild the old `media[]` array — and the legacy singular
// fields — on read, so no page, export or PDF generator changes.
import { getDb } from './connection.js';
import { ulid, now } from './ids.js';

// Each media table names its parent column differently; everything else matches.
const TABLES = {
  grievance_media:   { parent: 'grievance_id', label: true },
  campaign_media:    { parent: 'report_id',    label: true },
  social_post_media: { parent: 'post_id',      label: false },
};

function spec(table) {
  const s = TABLES[table];
  if (!s) throw new Error(`media: unknown table ${table}`);
  return s;
}

/** Attachments for one parent, in stored order. */
export function listMedia(table, parentId) {
  const { parent, label } = spec(table);
  const cols = `file_path, mime, type${label ? ', label' : ''}, position`;
  return getDb().prepare(
    `SELECT ${cols} FROM ${table} WHERE ${parent} = ? ORDER BY position`).all(parentId);
}

/**
 * Replace a parent's attachments wholesale.
 *
 * Wholesale rather than incremental because `position` is part of a UNIQUE key
 * and the callers all rewrite the whole list anyway — an incremental update would
 * have to reconcile positions, which is a sort with a UNIQUE constraint attached
 * and no upside.
 */
export function replaceMedia(table, parentId, items) {
  const { parent, label } = spec(table);
  const db = getDb();
  const ts = now();

  const cols = ['id', parent, 'position', 'file_path', 'mime', 'type',
    ...(label ? ['label'] : []), 'created_at'];
  const insert = db.prepare(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(c => `@${c}`).join(', ')})`);

  const run = db.transaction(list => {
    db.prepare(`DELETE FROM ${table} WHERE ${parent} = ?`).run(parentId);
    list.forEach((m, i) => {
      const row = {
        id: ulid(),
        [parent]: parentId,
        position: i,
        // The JSON shapes disagree: grievances/campaign reports call it `path`,
        // social posts call it `filename`. Accept either rather than making every
        // caller normalize first.
        file_path: m.file_path ?? m.path ?? m.filename ?? '',
        mime: m.mime ?? '',
        type: normalizeType(m.type, m.mime),
        created_at: ts,
      };
      if (label) row.label = m.label ?? '';
      if (row.file_path) insert.run(row);
    });
  });
  run(list_(items));
  return listMedia(table, parentId);
}

function list_(items) {
  return Array.isArray(items) ? items : [];
}

// The `type` column is CHECKed, and the JSON arrays carry whatever the intake
// path happened to set — including nothing. Falling back to the mime type keeps a
// PDF from being stored as an image, and 'image' is the historical default.
function normalizeType(type, mime) {
  const t = String(type || '').toLowerCase();
  if (['image', 'audio', 'pdf', 'video'].includes(t)) return t;
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  if (m.includes('pdf')) return 'pdf';
  return 'image';
}

/** Every stored file path under one parent — what delete cleanup needs. */
export function mediaPaths(table, parentId) {
  const { parent } = spec(table);
  return getDb().prepare(
    `SELECT file_path FROM ${table} WHERE ${parent} = ?`).all(parentId).map(r => r.file_path);
}
