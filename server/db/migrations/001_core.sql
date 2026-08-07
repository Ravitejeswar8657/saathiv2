-- 001_core.sql — the spine.
--
-- Adapted from ../../../brain/services/core/modules/memory/migrations/001_initial.sql
-- and the design in brain/docs/03-database-design.md §2-3. The shapes are brain's;
-- the vocabulary is saathi's.
--
-- Conventions, applied to every table below:
--   · ids are sortable TEXT (see ids.js) — lexical order IS chronological order,
--     so nothing has to be parsed to sort or paginate;
--   · timestamps are UTC ISO-8601, fixed width, stored as TEXT, for the same reason;
--   · `meta` columns hold JSON;
--   · rows are soft-deleted via `deleted_at`, never removed;
--   · every enum is a CHECK constraint, not a convention someone remembers.
--
-- PRAGMAs are connection-level, not schema-level, so they live in connection.js.
-- Setting them here would apply only to the migrating connection and silently not
-- to the ones serving requests.
--
-- The runner wraps this file in a transaction; do not open one here.


-- ── raw_events — the inbox ───────────────────────────────────────────────
-- Every inbound thing lands here BEFORE any processing, so no failure downstream
-- can lose what a citizen or staff member actually submitted.
--
-- This matters more in saathi than it does in brain. Today a photographed
-- grievance form goes straight into Gemini (server/index.js POST
-- /api/grievances/upload); if extraction throws, or the staff member closes the
-- review screen, there is no record the form was ever handed in. A bulk upload of
-- 20 forms that dies on form 14 loses six. The paper is back in the constituency
-- office and the citizen is not.
--
-- `status` is the processing lifecycle, not the grievance's status:
--   pending      — received, not yet extracted
--   compiled     — extraction produced a record
--   needs_review — extracted with low confidence; a human must look
--   skipped      — deliberately not turned into a record (a duplicate, a greeting)
--   failed       — extraction errored; the bytes are still here to retry
CREATE TABLE raw_events (
    id          TEXT PRIMARY KEY,
    source      TEXT NOT NULL,          -- 'grievance_upload' | 'campaign_intake' | 'chat' | 'excel_import' | …
    kind        TEXT NOT NULL,          -- 'image' | 'audio' | 'text' | 'pdf'
    sender      TEXT,                   -- staff member / channel identifier, when known
    body        TEXT,                   -- the text, when the input was text
    file_path   TEXT,                   -- path under the volume, when the input was bytes
    status      TEXT NOT NULL DEFAULT 'pending',
    meta        TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL,
    compiled_at TEXT,
    CHECK (status IN ('pending','compiled','skipped','failed','needs_review'))
);

CREATE INDEX idx_raw_events_status ON raw_events (status, created_at);

-- Upload dedupe: re-submitting the same photograph must resolve to the existing
-- event rather than creating a second one — staff re-photograph forms constantly.
--
-- The hash lives inside `meta` JSON, so this index HAS to be expression-based. A
-- plain index on `meta` would be built and then never used by the planner, which
-- is the quiet kind of wrong: the query still returns the right answer, just by
-- scanning every row forever.
CREATE INDEX idx_raw_events_sha256 ON raw_events (json_extract(meta, '$.sha256'));


-- ── records — the central searchable corpus ──────────────────────────────
-- brain's `memories`, renamed. One row per retrievable thing in the app:
-- grievance, feedback note, event, news item, campaign/scheme report, social
-- post, TTD letter, contact.
--
-- The typed columns of each of those live in their own table (002_domain.sql).
-- THIS table is what retrieval ranks over, and `source_table`/`source_id` is how a
-- hit is resolved back to the row a page can render. Keeping the two separate is
-- deliberate: a grievance has ~30 staff-edited fields that get exported to Excel
-- and PDF, and folding those into `meta` JSON would throw away exactly the
-- constraints this schema exists to add.
--
-- title/body/summary are the retrieval surface. `body` is load-bearing and was the
-- single biggest gap in the old design: the chat assistant was grounded on result
-- LABELS ("[grievances] Ramesh Kumar — Housing, Piduguralla") and never on
-- issue_description, so it structurally could not answer a question about what a
-- grievance actually said.
CREATE TABLE records (
    id            TEXT PRIMARY KEY,
    type          TEXT NOT NULL,
    title         TEXT NOT NULL,
    body          TEXT NOT NULL,
    summary       TEXT,
    status        TEXT NOT NULL DEFAULT 'active',
    importance    INTEGER NOT NULL DEFAULT 3,

    -- Supersession, rather than editing history away: a corrected grievance
    -- points at the version that replaced it and drops out of default retrieval.
    superseded_by TEXT REFERENCES records(id),

    -- What arrived, and what it became.
    source_event_id TEXT REFERENCES raw_events(id),
    source_table  TEXT,
    source_id     TEXT,

    -- When the thing happened in the world, as against when we learned about it
    -- (created_at). A grievance filed today about a canal breach last month sorts
    -- by the breach, not by the paperwork.
    occurred_at   TEXT,

    meta          TEXT NOT NULL DEFAULT '{}',
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    deleted_at    TEXT,

    CHECK (type IN ('grievance','feedback','event','news','report','post','letter','contact')),
    CHECK (status IN ('active','archived','resolved')),
    CHECK (importance BETWEEN 1 AND 5),
    -- A record superseding itself makes the chain a cycle and hangs any
    -- "walk to the current version" query.
    CHECK (superseded_by IS NULL OR superseded_by <> id)
);

-- One record per domain row. NULLs compare distinct in SQLite unique indexes, so
-- records with no typed row behind them (should any appear) are unconstrained.
CREATE UNIQUE INDEX idx_records_source ON records (source_table, source_id);

CREATE INDEX idx_records_status ON records (status, updated_at);
CREATE INDEX idx_records_type   ON records (type, occurred_at);

-- Retrieval excludes superseded records by default, so that predicate is on the
-- hot path. Partial, because the column is almost always NULL.
CREATE INDEX idx_records_superseded ON records (superseded_by) WHERE superseded_by IS NOT NULL;


-- ── records_fts — full-text, external-content ────────────────────────────
-- EXTERNAL CONTENT (content='records'): the index stores no copy of the text, it
-- points at records.rowid. One source of truth, half the disk.
--
-- The cost is that it does NOT self-synchronise — without the three triggers
-- below it serves stale rows forever and nothing errors. That is precisely why
-- this replaced the hand-maintained standalone index the first draft of this
-- schema had: there, every repository had to remember to call indexRecord() on
-- every write, and the one that forgot was undetectable until someone noticed
-- search was quietly wrong.
--
-- unicode61 + remove_diacritics: mandal and village names are transliterated
-- Telugu and are written with and without diacritics interchangeably.
CREATE VIRTUAL TABLE records_fts USING fts5(
    title,
    body,
    summary,
    content = 'records',
    content_rowid = 'rowid',
    tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER records_fts_ai AFTER INSERT ON records BEGIN
    INSERT INTO records_fts (rowid, title, body, summary)
    VALUES (new.rowid, new.title, new.body, new.summary);
END;

-- The 'delete' command row is how an external-content FTS5 index is told to forget
-- an entry, and it MUST be given the OLD values: FTS5 recomputes the tokens from
-- them to find what to remove. Passing the new values corrupts the index instead
-- of updating it, and the corruption surfaces much later as results that cannot
-- be explained by any row in the table.
CREATE TRIGGER records_fts_ad AFTER DELETE ON records BEGIN
    INSERT INTO records_fts (records_fts, rowid, title, body, summary)
    VALUES ('delete', old.rowid, old.title, old.body, old.summary);
END;

CREATE TRIGGER records_fts_au AFTER UPDATE ON records BEGIN
    INSERT INTO records_fts (records_fts, rowid, title, body, summary)
    VALUES ('delete', old.rowid, old.title, old.body, old.summary);
    INSERT INTO records_fts (rowid, title, body, summary)
    VALUES (new.rowid, new.title, new.body, new.summary);
END;


-- ── record_versions — edit history ───────────────────────────────────────
-- Staff correct grievances constantly (PATCH /api/grievances/:id): a category is
-- re-triaged, an officer is reassigned, an OCR'd name is fixed. None of that was
-- recoverable before — the previous value was simply overwritten in db.json.
--
-- `edited_by` is free text today because the app has no accounts. It is here so
-- that when it does, the history is already shaped to hold the answer.
CREATE TABLE record_versions (
    id         TEXT PRIMARY KEY,
    record_id  TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
    version    INTEGER NOT NULL,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    summary    TEXT,
    snapshot   TEXT NOT NULL DEFAULT '{}',   -- the typed row as it stood, JSON
    edited_by  TEXT NOT NULL DEFAULT 'staff',
    created_at TEXT NOT NULL,
    UNIQUE (record_id, version)
);


-- ── entities + entity_links — the graph ──────────────────────────────────
-- The things records are *about*, resolved to one row each so that "everything in
-- Piduguralla" is a join rather than six spelling-tolerant string comparisons.
--
-- `aliases` is where the mandal-spelling problem finally belongs. Today
-- public/admin.html hardcodes a MANDAL_ALIAS map (Chilakaluripeta →
-- Chilakaluripet, Dachepalli → Dachepalle, Gurajala → Gurazala, Sattenapalli →
-- Sattenapalle) plus an EXCLUDED_MANDALS set, because the imported data does not
-- agree with the canonical list in public/js/saathi-ui.js. That is reference data
-- living in a page's <script> tag, invisible to every other consumer.
CREATE TABLE entities (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    name       TEXT NOT NULL,
    aliases    TEXT NOT NULL DEFAULT '[]',   -- JSON array of alternate spellings
    meta       TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    UNIQUE (kind, name),
    CHECK (kind IN ('person','place','org','topic','scheme'))
);

-- Entity resolution matches on a normalized name before creating a new entity.
-- Without this index that lookup is a full scan on every extracted name, which is
-- the innermost loop of every intake.
CREATE INDEX idx_entities_name_nocase ON entities (kind, lower(name));

-- Polymorphic on purpose: a link joins any two of the app's addressable things.
-- src_type/dst_type cannot be foreign keys for that reason, which is the price of
-- one graph table instead of nine join tables.
CREATE TABLE entity_links (
    id         TEXT PRIMARY KEY,
    src_id     TEXT NOT NULL,
    src_type   TEXT NOT NULL,
    dst_id     TEXT NOT NULL,
    dst_type   TEXT NOT NULL,
    relation   TEXT NOT NULL,
    weight     REAL NOT NULL DEFAULT 1.0,

    -- Bi-temporal: valid_at/invalid_at are when the relationship was true in the
    -- world; created_at is when the app learned it. A ward member who moves
    -- village, an officer who is transferred — both are edits that destroy history
    -- unless the link can be closed rather than deleted. Cheap now and impossible
    -- to backfill: a year of links written without them means the history was
    -- never recorded at all.
    valid_at   TEXT,
    invalid_at TEXT,
    created_at TEXT NOT NULL,

    UNIQUE (src_id, dst_id, relation),
    -- src_type/dst_type name WHAT THE ID POINTS AT, so that a reader can resolve
    -- a link without guessing which table to look in. 'record' means a row in
    -- `records`; the others mean a row in the table of that name. Getting this
    -- wrong is silent — the id still stores fine — so the CHECK is the only thing
    -- standing between a typo and a link nothing can follow.
    CHECK (src_type IN ('entity','record','contact','event','grievance','ttd_letter')),
    CHECK (dst_type IN ('entity','record','contact','event','grievance','ttd_letter')),
    CHECK (invalid_at IS NULL OR valid_at IS NULL OR invalid_at >= valid_at)
);

CREATE INDEX idx_entity_links_src   ON entity_links (src_id, relation);
CREATE INDEX idx_entity_links_dst   ON entity_links (dst_id, relation);
CREATE INDEX idx_entity_links_valid ON entity_links (invalid_at, valid_at);


-- ── timeline — the activity feed ─────────────────────────────────────────
-- Append-only. "What happened in the office today" is currently answerable only
-- by diffing db.json against a backup.
CREATE TABLE timeline (
    id         TEXT PRIMARY KEY,
    at         TEXT NOT NULL,
    kind       TEXT NOT NULL,      -- 'grievance.logged' | 'letter.drafted' | 'event.scheduled' | …
    ref_type   TEXT,
    ref_id     TEXT,
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_timeline_at ON timeline (at DESC);


-- ── settings — key/value ─────────────────────────────────────────────────
-- Replaces db.json's `metadata` blob. `total_contacts` does not move here: it was
-- a cached COUNT(*) that drifted from the truth the first time a contact was
-- added, and a query answers it correctly for free.
CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
