-- 003_chat.sql — Ask Saathi's persisted threads.
--
-- Ported from brain's conversations/messages (memory/migrations/001_initial.sql
-- §3.11 and 004_conversation_soft_delete.sql), which is where the invariants below
-- were paid for.
--
-- Replaces db.json's flat `chat_messages` array: one endless conversation, no
-- threads, no titles, and a "Clear" button whose only granularity was everything.


-- ── conversations ────────────────────────────────────────────────────────
-- `status` and `deleted_at` are deliberately SEPARATE axes.
--
--   status  = active | closed   — where does the next message land
--   deleted = hidden, restorable for a retention window
--
-- A deleted thread is closed AND hidden. Folding the two into one column makes
-- "restore" ambiguous about which state it restores to — and the answer matters,
-- because restoring straight to `active` while another thread is open breaks the
-- one-active invariant below.
--
-- THE ONE-ACTIVE INVARIANT: at most one active conversation per channel. It is
-- load-bearing because "which thread does the next message land in" is resolved by
-- SELECT ... WHERE channel = ? AND status = 'active'. Anything that opens a thread
-- must close the current one first.
--
-- `channel` is open text rather than a CHECK: this app has one channel today
-- ('web'), and SQLite cannot alter a CHECK constraint, so a constraint here would
-- have to be paid for with a full table rebuild the first time an intake page
-- wanted its own thread.
CREATE TABLE conversations (
    id              TEXT PRIMARY KEY,
    channel         TEXT NOT NULL DEFAULT 'web',
    -- NULL until the first user message names it. `POST /api/conversations`
    -- reuses an untitled, empty thread rather than writing a new row every time
    -- someone opens the page and changes their mind.
    title           TEXT,
    status          TEXT NOT NULL DEFAULT 'active',
    started_at      TEXT NOT NULL,
    last_message_at TEXT NOT NULL,
    -- Not exposed through PATCH. Reserved for server-side state.
    meta            TEXT NOT NULL DEFAULT '{}',
    deleted_at      TEXT,
    CHECK (status IN ('active','closed'))
);

-- Conversation resolution runs this on every inbound turn.
CREATE INDEX idx_conversations_active
    ON conversations (channel, status, last_message_at);

-- Partial: the trash list, the retention cap and the purge sweep all scan
-- `deleted_at IS NOT NULL`, which is a handful of rows, while every other query on
-- this table filters it out. A full index would carry the whole table to serve the
-- small half.
CREATE INDEX idx_conversations_deleted
    ON conversations (deleted_at) WHERE deleted_at IS NOT NULL;


-- ── messages ─────────────────────────────────────────────────────────────
-- The user's turn is written here BEFORE any model call. That is the property the
-- whole chat design rests on: a Gemini timeout, a killed process or a closed tab
-- can lose the *answer*, but never the question.
--
-- `raw_event_id` closes the loop with 001_core: an inbound chat turn is an ingest
-- event like a photographed form is, and lands in the same inbox.
--
-- `grounding` is the JSON list of retrieval hits the reply was built from —
-- {source, id, label} — so the UI can show what an answer was based on and a
-- later reader can tell whether a wrong answer was bad retrieval or bad generation.
CREATE TABLE messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,
    body            TEXT NOT NULL,
    -- NULL when the reply came from the degraded fallback path rather than a model.
    model           TEXT,
    raw_event_id    TEXT REFERENCES raw_events(id),
    grounding       TEXT NOT NULL DEFAULT '[]',
    created_at      TEXT NOT NULL,
    CHECK (role IN ('user','assistant','system'))
);

-- Thread history pages oldest-first by (conversation, time); ids are sortable and
-- time-ordered, so this index also serves the keyset cursor without a second sort.
CREATE INDEX idx_messages_conv ON messages (conversation_id, created_at);
