// server/db/social_posts.js
// The social media content calendar: one date can hold many posts, one post can
// hold many media files.
//
// Media keys stay `filename` here rather than `path` — that is what
// social_calendar.html and GET /api/social-calendar/media/:filename read, and the
// point of this layer is that no page changes.
import { getDb } from './connection.js';
import { ulid, now } from './ids.js';
import { listMedia, replaceMedia, mediaPaths } from './media.js';
import { upsertRecord, softDeleteRecordFor } from './records.js';

function toRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    date: row.date,
    caption: row.caption,
    media: listMedia('social_post_media', row.id)
      .map(m => ({ filename: m.file_path, mime: m.mime, type: m.type })),
    created_at: row.created_at,
  };
}

function projectPost(p) {
  return {
    type: 'post',
    sourceTable: 'social_posts',
    sourceId: p.id,
    title: (p.caption || 'Social post').slice(0, 60),
    body: p.caption || '',
    summary: p.date || '',
    occurredAt: p.date || null,
    mentions: [],
  };
}

export function getPost(id) {
  return toRecord(getDb().prepare(
    'SELECT * FROM social_posts WHERE id = ? AND deleted_at IS NULL').get(id));
}

export function listPosts({ from, to } = {}) {
  const where = ['deleted_at IS NULL'];
  const params = {};
  if (from) { where.push('date >= @from'); params.from = from; }
  if (to)   { where.push('date <= @to');   params.to = to; }
  return getDb().prepare(`
    SELECT * FROM social_posts WHERE ${where.join(' AND ')}
     ORDER BY date DESC, id DESC`).all(params).map(toRecord);
}

export function countPostsBetween(from, to) {
  return getDb().prepare(`
    SELECT COUNT(*) n FROM social_posts
     WHERE deleted_at IS NULL AND date >= ? AND date <= ?`).get(from, to).n;
}

export function insertPost(post, { media = [] } = {}) {
  const db = getDb();
  const ts = now();
  const id = post.id || ulid();
  const run = db.transaction(() => {
    db.prepare(`INSERT INTO social_posts (id, date, caption, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)`)
      .run(id, post.date ?? '', post.caption ?? '', post.created_at || ts, ts);
    if (media.length) replaceMedia('social_post_media', id, media);
    upsertRecord(projectPost({ ...post, id }));
  });
  run();
  return getPost(id);
}

export function updatePost(id, patch) {
  const existing = getPost(id);
  if (!existing) return null;
  const merged = { ...existing, ...patch, id };
  const db = getDb();
  const run = db.transaction(() => {
    db.prepare('UPDATE social_posts SET date = ?, caption = ?, updated_at = ? WHERE id = ?')
      .run(merged.date ?? '', merged.caption ?? '', now(), id);
    if (patch.media !== undefined) replaceMedia('social_post_media', id, patch.media);
    upsertRecord(projectPost(merged));
  });
  run();
  return getPost(id);
}

/** Soft delete; returns stored file paths so the caller can unlink the bytes. */
export function softDeletePost(id) {
  const paths = mediaPaths('social_post_media', id);
  const ts = now();
  const info = getDb().prepare(
    'UPDATE social_posts SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(ts, ts, id);
  if (info.changes) softDeleteRecordFor('social_posts', id);
  return paths;
}

export function replaceAllPosts(items) {
  const db = getDb();
  const run = db.transaction(list => {
    db.prepare('DELETE FROM social_posts').run();
    db.prepare("DELETE FROM records WHERE source_table = 'social_posts'").run();
    for (const p of list) insertPost(p, { media: p.media || [] });
  });
  run(items);
  return getDb().prepare('SELECT COUNT(*) n FROM social_posts').get().n;
}
