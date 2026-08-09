// server/db/news.js
// Journalist and field-correspondent submissions.
//
// One shape fix carried in: db.json overloads `mandal` to hold "National" and
// "International" alongside real mandal names, and admin.html's News Dashboard
// filter pattern-matches those two magic strings. `scope` is now its own column,
// so a national item can also carry the mandal it concerns, and the filter is a
// column comparison rather than string equality against a place name.
//
// The old 50-item cap (`.slice(0, 50)` on every write) is gone. It existed
// because the whole collection was rewritten on each submission and the file had
// to stay small; a table with an index does not need to forget last month's news.
import { getDb } from './connection.js';
import { ulid, now } from './ids.js';
import { upsertRecord, softDeleteRecordFor } from './records.js';

const COLUMNS = [
  'id', 'headline', 'body', 'source', 'scope', 'mandal', 'priority', 'link',
  'has_attachment', 'attachment_name', 'submitted_at', 'created_at',
];

// 'district' and 'state' were missing here until they were traced as the cause
// of the media tracker's categories disappearing from the News Dashboard. The
// tracker's Excel import emits four categories (District/State/National/
// International, see normalizeCategory in server/index.js), but inferScope only
// recognised the last two - so every District and State row fell through to the
// 'mandal' default and the district's own coverage ended up indistinguishable
// from statewide AP politics in the same bucket. 'mandal' stays for backward
// compatibility: rows already in the table carry it, and it remains the
// fallback for field-correspondent submissions that name a real place.
const SCOPES = ['district', 'mandal', 'state', 'national', 'international'];
const PRIORITIES = ['high', 'medium', 'low'];

// db.json's magic mandal values, mapped onto the new axis. Anything else is a
// real place and stays one.
export function inferScope(item) {
  if (SCOPES.includes(item.scope)) return item.scope;
  const m = String(item.mandal || '').trim().toLowerCase();
  if (m === 'national') return 'national';
  if (m === 'international') return 'international';
  return 'mandal';
}

function toRecord(row) {
  if (!row) return null;
  const out = { ...row };
  delete out.updated_at;
  delete out.deleted_at;
  out.has_attachment = Boolean(out.has_attachment);
  return out;
}

function toRow(n) {
  const ts = now();
  const row = {};
  for (const c of COLUMNS) row[c] = n[c] ?? '';
  row.id = n.id;
  row.scope = inferScope(n);
  // A national item keeps a readable mandal value rather than the magic string
  // that used to encode its scope.
  if (row.scope !== 'mandal' && ['national', 'international'].includes(String(row.mandal).toLowerCase())) {
    row.mandal = 'General';
  }
  row.mandal = row.mandal || 'General';
  row.source = row.source || 'Field correspondent';
  row.priority = PRIORITIES.includes(row.priority) ? row.priority : 'medium';
  row.has_attachment = n.has_attachment ? 1 : 0;
  row.attachment_name = n.attachment_name || null;
  row.submitted_at = n.submitted_at || ts;
  row.created_at = n.created_at || row.submitted_at;
  row.updated_at = ts;
  return row;
}

function projectNews(n) {
  return {
    type: 'news',
    sourceTable: 'news',
    sourceId: n.id,
    title: n.headline || 'News item',
    body: [n.body, n.source, n.mandal, n.link].filter(Boolean).join('\n'),
    summary: n.source || '',
    importance: n.priority === 'high' ? 4 : n.priority === 'low' ? 2 : 3,
    occurredAt: n.submitted_at || null,
    meta: { scope: n.scope, priority: n.priority },
    mentions: n.mandal && n.mandal !== 'General' ? [{ kind: 'place', name: n.mandal }] : [],
  };
}

export function getNewsItem(id) {
  return toRecord(getDb().prepare(
    'SELECT * FROM news WHERE id = ? AND deleted_at IS NULL').get(id));
}

export function listNews({ date, scope, limit = 200 } = {}) {
  const where = ['deleted_at IS NULL'];
  const params = {};
  if (date)  { where.push("substr(submitted_at, 1, 10) = @date"); params.date = date; }
  if (scope) { where.push('scope = @scope');                      params.scope = scope; }
  return getDb().prepare(`
    SELECT * FROM news WHERE ${where.join(' AND ')}
     ORDER BY submitted_at DESC, id DESC LIMIT @limit`)
    .all({ ...params, limit }).map(toRecord);
}

export function countNews() {
  return getDb().prepare('SELECT COUNT(*) n FROM news WHERE deleted_at IS NULL').get().n;
}

export function insertNews(item) {
  const db = getDb();
  const row = toRow({ ...item, id: item.id || ulid() });
  const run = db.transaction(() => {
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO news (${cols.join(', ')})
                VALUES (${cols.map(c => `@${c}`).join(', ')})`).run(row);
    upsertRecord(projectNews(row));
  });
  run();
  return getNewsItem(row.id);
}

export function updateNews(id, patch) {
  const existing = getNewsItem(id);
  if (!existing) return null;
  const row = toRow({ ...existing, ...patch, id });
  const db = getDb();
  const run = db.transaction(() => {
    const sets = Object.keys(row).filter(c => c !== 'id' && c !== 'created_at');
    db.prepare(`UPDATE news SET ${sets.map(c => `${c} = @${c}`).join(', ')} WHERE id = @id`).run(row);
    upsertRecord(projectNews(row));
  });
  run();
  return getNewsItem(id);
}

export function softDeleteNews(id) {
  const ts = now();
  const info = getDb().prepare(
    'UPDATE news SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(ts, ts, id);
  if (info.changes) softDeleteRecordFor('news', id);
  return info.changes > 0;
}

export function replaceAllNews(items) {
  const db = getDb();
  const run = db.transaction(list => {
    db.prepare('DELETE FROM news').run();
    db.prepare("DELETE FROM records WHERE source_table = 'news'").run();
    for (const n of list) insertNews(n);
  });
  run(items);
  return countNews();
}
