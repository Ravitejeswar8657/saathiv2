// server/db/conversations.js
// Ask Saathi's threads. Ported from brain's orchestrator conversation lifecycle
// (services/core/modules/orchestrator/service.py + memory/repository.py).
//
// Replaces db.json's flat `chat_messages` array: one endless conversation, no
// titles, and a "Clear" button whose only granularity was everything.
import { getDb } from './connection.js';
import { ulid, now } from './ids.js';

// A thread with no activity for this long is closed lazily on the next message —
// resolved when it matters rather than by a background sweep, which would be one
// more job to monitor and get wrong.
const IDLE_MINUTES = Number(process.env.CONVERSATION_IDLE_MINUTES || 120);
// The trash is bounded so the database does not grow on the strength of things
// the user threw away.
const TRASH_LIMIT = Number(process.env.CONVERSATION_TRASH_LIMIT || 10);
const TRASH_DAYS = Number(process.env.CONVERSATION_TRASH_DAYS || 30);

// ── cursors ──────────────────────────────────────────────────────────────
// Keyset pagination on the id, which is a ULID and therefore already in time
// order. Base64 so the client cannot be tempted to construct one.
//
// The trap this encodes: `id < '<base64 string>'` is perfectly valid SQL that
// matches almost everything, so forgetting to decode returns page one forever
// instead of erroring. Decoding is not optional and it is not defensive.
export function encodeCursor(id) {
  return Buffer.from(String(id), 'utf8').toString('base64');
}

export function decodeCursor(cursor) {
  if (!cursor) return null;
  const decoded = Buffer.from(String(cursor), 'base64').toString('utf8');
  // A ULID is 26 chars of Crockford base32; anything else was not one of ours.
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(decoded) ? decoded : null;
}

// ── reads ────────────────────────────────────────────────────────────────

function toRecord(row) {
  if (!row) return null;
  const out = { ...row };
  try { out.meta = JSON.parse(out.meta); } catch { out.meta = {}; }
  delete out.deleted_at;
  return out;
}

export function getConversation(id, { includeDeleted = false } = {}) {
  return toRecord(getDb().prepare(`
    SELECT * FROM conversations
     WHERE id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`).get(id));
}

export function listConversations({ channel = 'web', status = null, limit = 30, cursor = null } = {}) {
  const where = ['channel = @channel', 'deleted_at IS NULL'];
  const params = { channel, limit: limit + 1 };
  if (status) { where.push('status = @status'); params.status = status; }

  const after = decodeCursor(cursor);
  if (after) { where.push('id < @after'); params.after = after; }

  const rows = getDb().prepare(`
    SELECT * FROM conversations WHERE ${where.join(' AND ')}
     ORDER BY id DESC LIMIT @limit`).all(params);

  // Over-fetch by one to learn whether another page exists, without a COUNT.
  const items = rows.slice(0, limit).map(toRecord);
  return {
    items,
    next_cursor: rows.length > limit ? encodeCursor(items[items.length - 1].id) : null,
  };
}

export function listMessages(conversationId, { limit = 200, cursor = null } = {}) {
  const where = ['conversation_id = @id'];
  const params = { id: conversationId, limit: limit + 1 };
  const after = decodeCursor(cursor);
  if (after) { where.push('id > @after'); params.after = after; }

  // Oldest first: a transcript reads forwards.
  const rows = getDb().prepare(`
    SELECT * FROM messages WHERE ${where.join(' AND ')}
     ORDER BY id ASC LIMIT @limit`).all(params);

  const items = rows.slice(0, limit).map(m => {
    let grounding = [];
    try { grounding = JSON.parse(m.grounding); } catch { grounding = []; }
    return { ...m, grounding };
  });
  return {
    items,
    next_cursor: rows.length > limit ? encodeCursor(items[items.length - 1].id) : null,
  };
}

export function countMessages(conversationId) {
  return getDb().prepare(
    'SELECT COUNT(*) n FROM messages WHERE conversation_id = ?').get(conversationId).n;
}

// ── lifecycle ────────────────────────────────────────────────────────────

/**
 * The active thread for a channel, opening one if there is none.
 *
 * THE ONE-ACTIVE INVARIANT: at most one active conversation per channel, because
 * "which thread does the next message land in" is resolved by exactly this query.
 * Everything that opens a thread closes the current one first.
 */
export function resolveConversation(channel = 'web') {
  const db = getDb();
  const active = db.prepare(`
    SELECT * FROM conversations
     WHERE channel = ? AND status = 'active' AND deleted_at IS NULL
     ORDER BY last_message_at DESC LIMIT 1`).get(channel);

  if (active) {
    const idleMs = Date.now() - new Date(active.last_message_at).getTime();
    if (idleMs < IDLE_MINUTES * 60_000) return toRecord(active);
    // Idle-close resolved lazily, on the next message rather than by a sweep.
    db.prepare("UPDATE conversations SET status = 'closed' WHERE id = ?").run(active.id);
  }
  return createConversation(channel).conversation;
}

/**
 * Open a thread.
 *
 * An untitled thread with no messages is REUSED rather than duplicated —
 * otherwise the "New chat" button writes a row every time someone opens the page
 * and changes their mind, and the list grows without bound. `created` tells the
 * route whether to answer 201 or 200.
 */
export function createConversation(channel = 'web') {
  const db = getDb();
  const empty = db.prepare(`
    SELECT c.* FROM conversations c
     WHERE c.channel = ? AND c.deleted_at IS NULL AND c.title IS NULL
       AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
     ORDER BY c.id DESC LIMIT 1`).get(channel);

  if (empty) {
    db.prepare("UPDATE conversations SET status = 'active', last_message_at = ? WHERE id = ?")
      .run(now(), empty.id);
    return { conversation: getConversation(empty.id), created: false };
  }

  const ts = now();
  const id = ulid();
  const run = db.transaction(() => {
    // Close whatever was active first — the invariant above.
    db.prepare("UPDATE conversations SET status = 'closed' WHERE channel = ? AND status = 'active'")
      .run(channel);
    db.prepare(`INSERT INTO conversations (id, channel, status, started_at, last_message_at)
                VALUES (?, ?, 'active', ?, ?)`).run(id, channel, ts, ts);
  });
  run();
  return { conversation: getConversation(id), created: true };
}

/** Rename or archive. Only these two fields — `meta` is never client-writable. */
export function updateConversation(id, { title, status }) {
  const existing = getConversation(id);
  if (!existing) return null;

  const db = getDb();
  const run = db.transaction(() => {
    if (title !== undefined) {
      db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title || null, id);
    }
    if (status !== undefined) {
      // Re-activating must not break the one-active invariant.
      if (status === 'active') {
        db.prepare("UPDATE conversations SET status = 'closed' WHERE channel = ? AND status = 'active' AND id <> ?")
          .run(existing.channel, id);
      }
      db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run(status, id);
    }
  });
  run();
  return getConversation(id);
}

/**
 * Soft delete, with a bounded trash.
 *
 * Archive and delete are different verbs and both exist: archive closes the
 * thread (still listed, still readable, just not where the next message goes),
 * delete hides it and starts a retention clock. Deleting also purges the oldest
 * thread beyond the cap immediately, so the trash cannot grow without bound.
 */
export function deleteConversation(id) {
  const db = getDb();
  const existing = getConversation(id);
  if (!existing) return false;

  const run = db.transaction(() => {
    db.prepare("UPDATE conversations SET deleted_at = ?, status = 'closed' WHERE id = ?")
      .run(now(), id);

    const overflow = db.prepare(`
      SELECT id FROM conversations
       WHERE channel = ? AND deleted_at IS NOT NULL
       ORDER BY deleted_at DESC LIMIT -1 OFFSET ?`).all(existing.channel, TRASH_LIMIT);
    for (const row of overflow) purge(row.id);
  });
  run();
  return true;
}

/**
 * Restore from the trash — always as `closed`, never `active`.
 *
 * Restoring straight to active while another thread is open would break the
 * one-active invariant, and the user has almost certainly started a new thread
 * since deleting this one.
 */
export function restoreConversation(id) {
  const existing = getConversation(id, { includeDeleted: true });
  if (!existing) return null;
  getDb().prepare("UPDATE conversations SET deleted_at = NULL, status = 'closed' WHERE id = ?").run(id);
  return getConversation(id);
}

export function listTrash({ channel = 'web' } = {}) {
  const items = getDb().prepare(`
    SELECT * FROM conversations
     WHERE channel = ? AND deleted_at IS NOT NULL
     ORDER BY deleted_at DESC`).all(channel).map(row => ({
    ...toRecord({ ...row, deleted_at: undefined }),
    deleted_at: row.deleted_at,
    message_count: countMessages(row.id),
  }));
  return { items, limit: TRASH_LIMIT, retention_days: TRASH_DAYS };
}

function purge(id) {
  // messages cascade on the FK.
  getDb().prepare('DELETE FROM conversations WHERE id = ?').run(id);
}

/**
 * Drop trashed threads past the retention window.
 *
 * Runs DAILY, not on the same schedule as the window: a 30-day window swept every
 * 30 days lets a thread live 60, which makes "deleted after 30 days" wrong by a
 * factor of two.
 */
export function purgeExpiredTrash() {
  const cutoff = new Date(Date.now() - TRASH_DAYS * 86_400_000).toISOString();
  const rows = getDb().prepare(
    'SELECT id FROM conversations WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(cutoff);
  for (const row of rows) purge(row.id);
  return rows.length;
}

// ── messages ─────────────────────────────────────────────────────────────

export function appendMessage(conversationId, { role, body, model = null, rawEventId = null, grounding = [] }) {
  const db = getDb();
  const ts = now();
  const id = ulid();
  const run = db.transaction(() => {
    db.prepare(`INSERT INTO messages
                  (id, conversation_id, role, body, model, raw_event_id, grounding, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, conversationId, role, body, model, rawEventId, JSON.stringify(grounding), ts);
    db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(ts, conversationId);
  });
  run();
  return { id, conversation_id: conversationId, role, body, model, grounding, created_at: ts };
}

/**
 * Name a thread from its first user message.
 *
 * Derived in code, not by a model: free, deterministic, never a hallucination,
 * and no added latency before the first token.
 */
export function deriveTitle(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= 60) return clean || 'New chat';
  const cut = clean.slice(0, 60);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 30 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

/** Set the title only if the thread does not have one. Returns true if it did. */
export function titleIfUntitled(conversationId, text) {
  const info = getDb().prepare(
    'UPDATE conversations SET title = ? WHERE id = ? AND title IS NULL')
    .run(deriveTitle(text), conversationId);
  return info.changes > 0;
}
