// server/db/campaign_reports.js
// Campaigns, government schemes and cluster-wise field reports.
//
// The legacy singular `attachment` field is gone rather than mirrored: unlike
// grievances' image_path, it was already always null on new records, with the
// media array beside it carrying everything. The repository still returns it as
// null so any reader that destructures it keeps working.
import { getDb } from './connection.js';
import { ulid, now } from './ids.js';
import { listMedia, replaceMedia, mediaPaths } from './media.js';
import { upsertRecord, softDeleteRecordFor, getRecordFor, captureVersion } from './records.js';

const COLUMNS = [
  'id', 'title', 'type', 'status', 'mandal', 'village', 'description',
  'event_date', 'key_people_mentioned', 'attendance_or_beneficiaries',
  'sentiment', 'confidence', 'ocr_confidence', 'transcript', 'intake_mode',
  'logged_by', 'source_event_id', 'created_at',
];

/**
 * The report vocabulary — the one place these values are written down in JS.
 *
 * They used to be restated in eight: this file's ENUMS, the CHECK constraints in
 * 002_domain.sql, two Sets in server/index.js, the Gemini response schema, all
 * three extraction prompts, and the page's own <select>s. Nothing warned when
 * they drifted, and the failure was silent in the worst direction — a type only
 * one copy knew about was quietly rewritten to 'Other' on save.
 *
 * `hint` is prompt-only: server/gemini.js renders it into the extraction prompt
 * and nothing persists it. It lives here anyway, so that adding a type is one
 * edit rather than one edit plus three places that must be kept to agree.
 *
 * The CHECK constraints in 002_domain.sql are the one copy that CANNOT derive
 * from this, because an applied migration must never be edited. Widening the
 * vocabulary is therefore a two-step change: add the value here AND add a
 * migration widening the CHECK — exactly what 005_news_scopes.sql did for
 * news.scope. Skip the migration and SQLite rejects the row outright.
 */
export const REPORT_TAXONOMY = {
  types: [
    { value: 'Campaign', hint: 'a political/public event, rally, health camp, etc.' },
    { value: 'Government Scheme', hint: 'a scheme rollout/progress update' },
    { value: 'Cluster Report', hint: 'a village/mandal-cluster field report, which may include notes about local leaders' },
    { value: 'Other', hint: '' },
  ],
  statuses: ['Planned', 'Ongoing', 'Completed', 'Delayed'],
};

const ENUMS = {
  type:        { values: REPORT_TAXONOMY.types.map(t => t.value), fallback: 'Other' },
  status:      { values: [...REPORT_TAXONOMY.statuses],           fallback: 'Planned' },
  // Not part of the report taxonomy: these two are shaped by the intake pipeline
  // rather than by what staff choose, and no prompt or <select> offers them.
  sentiment:   { values: ['', 'Positive', 'Neutral', 'Negative', 'Mixed'],             fallback: '' },
  intake_mode: { values: ['typed', 'ocr', 'dictated', 'mixed'],                        fallback: 'mixed' },
};

function toRecord(row) {
  if (!row) return null;
  const out = { ...row };
  delete out.updated_at;
  delete out.deleted_at;
  out.media = listMedia('campaign_media', row.id)
    .map(m => ({ path: m.file_path, mime: m.mime, type: m.type, label: m.label }));
  out.attachment = null;   // legacy field, always null; kept so readers destructure cleanly
  return out;
}

function toRow(r) {
  const ts = now();
  const row = {};
  for (const c of COLUMNS) row[c] = r[c] ?? '';
  for (const [col, { values, fallback }] of Object.entries(ENUMS)) {
    if (!values.includes(row[col])) row[col] = fallback;
  }
  row.id = r.id;
  row.title = String(row.title).trim() || '(untitled report)';
  row.mandal = String(row.mandal).trim();
  row.village = String(row.village).trim();
  row.source_event_id = r.source_event_id || null;
  row.created_at = r.created_at || ts;
  row.updated_at = ts;
  return row;
}

function projectReport(r) {
  const place = [r.village, r.mandal].filter(Boolean).join(', ');
  return {
    type: 'report',
    sourceTable: 'campaign_reports',
    sourceId: r.id,
    title: r.title || 'Report',
    body: [r.description, r.key_people_mentioned, r.attendance_or_beneficiaries,
      r.transcript, place, r.type].filter(Boolean).join('\n'),
    summary: [r.type, place, r.status].filter(Boolean).join(' · '),
    occurredAt: r.event_date || r.created_at || null,
    sourceEventId: r.source_event_id || null,
    meta: { type: r.type, status: r.status },
    mentions: [
      { kind: 'place', name: r.village },
      { kind: 'place', name: r.mandal },
      ...(r.type === 'Government Scheme' ? [{ kind: 'scheme', name: r.title }] : []),
    ].filter(m => m.name),
  };
}

export function getReport(id) {
  return toRecord(getDb().prepare(
    'SELECT * FROM campaign_reports WHERE id = ? AND deleted_at IS NULL').get(id));
}

export function listReports({ type, mandal, status } = {}) {
  const where = ['deleted_at IS NULL'];
  const params = {};
  if (type)   { where.push('type = @type');     params.type = type; }
  if (mandal) { where.push('mandal = @mandal'); params.mandal = mandal; }
  if (status) { where.push('status = @status'); params.status = status; }
  return getDb().prepare(`
    SELECT * FROM campaign_reports WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC, id DESC`).all(params).map(toRecord);
}

export function insertReport(report, { media = [] } = {}) {
  const db = getDb();
  const row = toRow({ ...report, id: report.id || ulid() });
  const run = db.transaction(() => {
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO campaign_reports (${cols.join(', ')})
                VALUES (${cols.map(c => `@${c}`).join(', ')})`).run(row);
    if (media.length) replaceMedia('campaign_media', row.id, media);
    upsertRecord(projectReport(row));
  });
  run();
  return getReport(row.id);
}

export function updateReport(id, patch, { editedBy = 'staff', media } = {}) {
  const existing = getReport(id);
  if (!existing) return null;
  const merged = { ...existing, ...patch, id };
  const row = toRow(merged);
  const db = getDb();
  const run = db.transaction(() => {
    const rec = getRecordFor('campaign_reports', id);
    if (rec) captureVersion(rec.id, existing, editedBy);
    const sets = Object.keys(row).filter(c => c !== 'id' && c !== 'created_at');
    db.prepare(`UPDATE campaign_reports SET ${sets.map(c => `${c} = @${c}`).join(', ')}
                 WHERE id = @id`).run(row);
    if (media !== undefined) replaceMedia('campaign_media', id, media);
    upsertRecord(projectReport(merged));
  });
  run();
  return getReport(id);
}

/** Soft delete; returns stored file paths so the caller can unlink the bytes. */
export function softDeleteReport(id) {
  const paths = mediaPaths('campaign_media', id);
  const ts = now();
  const info = getDb().prepare(
    'UPDATE campaign_reports SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(ts, ts, id);
  if (info.changes) softDeleteRecordFor('campaign_reports', id);
  return paths;
}

export function replaceAllReports(items) {
  const db = getDb();
  const run = db.transaction(list => {
    db.prepare('DELETE FROM campaign_reports').run();
    db.prepare("DELETE FROM records WHERE source_table = 'campaign_reports'").run();
    for (const r of list) insertReport(r, { media: r.media || [] });
  });
  run(items);
  return getDb().prepare('SELECT COUNT(*) n FROM campaign_reports').get().n;
}
