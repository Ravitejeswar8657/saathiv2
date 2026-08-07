-- 002_domain.sql — the typed tables.
--
-- brain keeps `memories` as the retrieval corpus and `contacts`/`tasks`/`meetings`
-- as typed tables alongside it. Saathi does the same, for a concrete reason: a
-- grievance carries ~30 fields that staff edit in a form and that are exported to
-- Excel and PDF. Folding those into records.meta JSON would throw away exactly the
-- constraints this schema exists to add.
--
-- Every row here has a companion row in `records` (idx_records_source keeps it
-- one-to-one). The typed row is what a page renders and a report exports; the
-- record is what retrieval ranks.
--
-- Column choices follow the shape of the LIVE data, not the shape of db.json's
-- JSON: values that are integers stay integers, booleans become 0/1, and only
-- genuinely list-valued fields stay JSON. Enum values are lifted verbatim from the
-- Sets in server/index.js so the CHECK and the validator cannot drift apart.


-- ── contacts ─────────────────────────────────────────────────────────────
-- 3,255 rows, the only collection in db.json holding real data.
--
-- Sensitive identity columns (religion, caste, additional_identity, dob, gender)
-- are declared but are 0/3255 populated today. They exist so the migration can
-- round-trip an existing record without loss; they are excluded from the chat
-- prompt and from the retrieval corpus on purpose.
CREATE TABLE contacts (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL DEFAULT '',
    phone               TEXT NOT NULL DEFAULT '',
    village             TEXT NOT NULL DEFAULT '',
    mandal              TEXT NOT NULL DEFAULT '',
    constituency        TEXT NOT NULL DEFAULT '',
    occupation          TEXT NOT NULL DEFAULT '',
    party               TEXT NOT NULL DEFAULT '',
    role                TEXT NOT NULL DEFAULT '',
    area_of_influence   TEXT NOT NULL DEFAULT '',
    krishna_follower    INTEGER NOT NULL DEFAULT 0,

    -- Scoring, computed at import time by scripts/setup_db.js.
    tier                TEXT NOT NULL DEFAULT '',
    priority_level      TEXT NOT NULL DEFAULT '',
    pps_score           INTEGER NOT NULL DEFAULT 0,
    estimated_reach     INTEGER NOT NULL DEFAULT 0,
    affinity            TEXT NOT NULL DEFAULT '',
    top_drivers         TEXT NOT NULL DEFAULT '[]',   -- JSON array

    -- Engagement state.
    last_interaction    TEXT,
    days_since_contact  INTEGER NOT NULL DEFAULT 0,
    open_grievance      TEXT NOT NULL DEFAULT '',
    previous_commitment TEXT NOT NULL DEFAULT '',
    issues              TEXT NOT NULL DEFAULT '[]',   -- JSON array
    -- Written by POST /api/issue but absent from the seed, so it exists only on
    -- contacts that have had an issue logged. That silent divergence is exactly
    -- what a declared schema is for.
    last_log            TEXT,                         -- JSON object {type, at}

    -- Free text. Boilerplate in practice (remarks holds 4 distinct values across
    -- 3,252 rows), which is why neither reaches a model prompt.
    remarks             TEXT NOT NULL DEFAULT '',
    ai_reason           TEXT NOT NULL DEFAULT '',
    manual_brief        TEXT NOT NULL DEFAULT '',

    -- Declared, unpopulated, never prompted. See header.
    dob                 TEXT,
    gender              TEXT,
    religion            TEXT,
    caste               TEXT,
    additional_identity TEXT,

    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    deleted_at          TEXT
);

-- The access patterns that exist today: the nearby-contact finder filters by
-- mandal/village and sorts by pps_score, the heatmap groups by mandal, and every
-- list view hides soft-deleted rows.
CREATE INDEX idx_contacts_mandal  ON contacts (mandal, pps_score DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_contacts_village ON contacts (village, pps_score DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_contacts_phone   ON contacts (phone) WHERE deleted_at IS NULL;


-- ── grievances ───────────────────────────────────────────────────────────
-- The register. `entry_type = 'feedback'` is non-actionable intelligence the AI
-- did not read as a grievance but staff chose to keep.
--
-- Two channel values are historical: whatsapp_text/whatsapp_voice records still
-- exist from before that intake was removed, so the CHECK must accept them even
-- though nothing produces new ones.
CREATE TABLE grievances (
    id                    TEXT PRIMARY KEY,
    channel               TEXT NOT NULL DEFAULT 'walk_in',
    entry_type            TEXT NOT NULL DEFAULT 'grievance',
    sentiment             TEXT NOT NULL DEFAULT '',
    intake_mode           TEXT NOT NULL DEFAULT 'typed',
    logged_by             TEXT NOT NULL DEFAULT '',

    full_name             TEXT NOT NULL DEFAULT '',
    address               TEXT NOT NULL DEFAULT '',
    village               TEXT NOT NULL DEFAULT '',
    mandal                TEXT NOT NULL DEFAULT '',
    assembly_constituency TEXT NOT NULL DEFAULT '',
    reference_name        TEXT NOT NULL DEFAULT '',
    reference_number      TEXT NOT NULL DEFAULT '',
    contact_number        TEXT NOT NULL DEFAULT '',
    email                 TEXT NOT NULL DEFAULT '',
    date_of_visit         TEXT NOT NULL DEFAULT '',

    issue_description     TEXT NOT NULL DEFAULT '',
    action_taken          TEXT NOT NULL DEFAULT '',
    action_to_be_taken    TEXT NOT NULL DEFAULT '',
    assigned_officer      TEXT NOT NULL DEFAULT '',
    resolution_status     TEXT NOT NULL DEFAULT 'Pending',
    deadline              TEXT NOT NULL DEFAULT '',

    category              TEXT NOT NULL DEFAULT 'others',
    urgency               TEXT NOT NULL DEFAULT 'Medium',
    urgency_reason        TEXT NOT NULL DEFAULT '',
    -- Deterministic: categoryWeight*0.4 + urgencyWeight*0.6. Stored rather than
    -- computed on read so triage ordering stays auditable after the weights change.
    priority_score        INTEGER NOT NULL DEFAULT 0,

    ocr_confidence        TEXT NOT NULL DEFAULT '',
    transcript            TEXT NOT NULL DEFAULT '',

    escalated_at            TEXT NOT NULL DEFAULT '',
    suggested_response      TEXT NOT NULL DEFAULT '',
    suggested_next_action   TEXT NOT NULL DEFAULT '',
    drafted_letter_subject  TEXT NOT NULL DEFAULT '',
    drafted_letter_body     TEXT NOT NULL DEFAULT '',

    source_event_id       TEXT REFERENCES raw_events(id),
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL,
    deleted_at            TEXT,

    CHECK (channel IN ('walk_in','phone_call','whatsapp_text','whatsapp_voice')),
    CHECK (entry_type IN ('grievance','feedback')),
    CHECK (sentiment IN ('','Positive','Neutral','Negative','Mixed')),
    CHECK (intake_mode IN ('typed','ocr','dictated','mixed')),
    CHECK (resolution_status IN ('Pending','In Progress','Resolved')),
    CHECK (urgency IN ('High','Medium','Low'))
);

-- The register's list view filters by date range, then by status/category/channel.
CREATE INDEX idx_grievances_date     ON grievances (date_of_visit DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_grievances_status   ON grievances (resolution_status, priority_score DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_grievances_category ON grievances (category) WHERE deleted_at IS NULL;
CREATE INDEX idx_grievances_mandal   ON grievances (mandal, village) WHERE deleted_at IS NULL;
-- Duplicate detection's exact-match signal. normalizePhone() runs in JS, so the
-- normalized form is stored alongside rather than recomputed per comparison.
CREATE INDEX idx_grievances_phone    ON grievances (contact_number) WHERE deleted_at IS NULL;

-- Attachments, one row each. Replaces BOTH the `media[]` JSON array and the
-- legacy singular image_path/media_type pair that mirrored its first element —
-- the repository synthesizes those two fields from position 0 so every existing
-- reader (table media button, delete cleanup, exports) keeps working unchanged.
--
-- ON DELETE CASCADE is why connection.js turns foreign_keys ON: without the
-- pragma this clause is decoration and media rows outlive their grievance.
CREATE TABLE grievance_media (
    id           TEXT PRIMARY KEY,
    grievance_id TEXT NOT NULL REFERENCES grievances(id) ON DELETE CASCADE,
    position     INTEGER NOT NULL,
    file_path    TEXT NOT NULL,
    mime         TEXT NOT NULL DEFAULT '',
    type         TEXT NOT NULL DEFAULT 'image',
    label        TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL,
    UNIQUE (grievance_id, position),
    CHECK (type IN ('image','audio','pdf','video'))
);


-- ── events (db.json's `schedule`) ────────────────────────────────────────
-- Renamed for clarity; the repository still returns the `schedule` key shape so
-- pa_schedule.html and brief_workflow.html are untouched.
CREATE TABLE events (
    id                  TEXT PRIMARY KEY,
    event_name          TEXT NOT NULL DEFAULT '',
    date                TEXT NOT NULL DEFAULT '',
    time                TEXT NOT NULL DEFAULT '',
    address             TEXT NOT NULL DEFAULT '',
    village             TEXT NOT NULL DEFAULT '',
    mandal              TEXT NOT NULL DEFAULT '',
    description         TEXT NOT NULL DEFAULT '',
    event_type          TEXT NOT NULL DEFAULT '',
    audience_cohort     TEXT NOT NULL DEFAULT '',

    -- Manual-first content layers. All start empty/unreviewed: the PA fills these
    -- in and the system only ever offers a draft suggestion.
    contacts_approved       INTEGER NOT NULL DEFAULT 0,
    contacts_approved_at    TEXT,
    speech_points           TEXT NOT NULL DEFAULT '',
    speech_points_reviewed  INTEGER NOT NULL DEFAULT 0,
    speech_skipped          INTEGER NOT NULL DEFAULT 0,
    creative_touches        TEXT NOT NULL DEFAULT '{"selected":[],"custom":[],"reviewed":false}',
    news_selected           TEXT NOT NULL DEFAULT '[]',

    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    deleted_at          TEXT
);

CREATE INDEX idx_events_date ON events (date DESC) WHERE deleted_at IS NULL;

-- Replaces schedule[].nearby_contacts[], which embedded frozen COPIES of contact
-- fields (name, phone, role, tier, pps_score) that never refreshed. A contact who
-- changed village stayed in the old village on every event already scheduled.
--
-- Only the occasion-specific, PA-written brief is stored here; everything else is
-- joined live from `contacts`. This is a human-written table and so gets its own
-- table rather than an entity_links row — the rule being that a link row can be
-- deleted and recomputed without losing work, and event_brief cannot.
CREATE TABLE event_contacts (
    id             TEXT PRIMARY KEY,
    event_id       TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    contact_id     TEXT NOT NULL REFERENCES contacts(id),
    position       INTEGER NOT NULL,
    event_brief    TEXT NOT NULL DEFAULT '',
    brief_reviewed INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL,
    UNIQUE (event_id, contact_id)
);

CREATE INDEX idx_event_contacts_event   ON event_contacts (event_id, position);
CREATE INDEX idx_event_contacts_contact ON event_contacts (contact_id);


-- ── news ─────────────────────────────────────────────────────────────────
CREATE TABLE news (
    id              TEXT PRIMARY KEY,
    headline        TEXT NOT NULL DEFAULT '',
    body            TEXT NOT NULL DEFAULT '',
    source          TEXT NOT NULL DEFAULT 'Field correspondent',
    -- `scope` is new. db.json overloads `mandal` to hold "National"/"International"
    -- as well as actual mandal names, and admin.html's News Dashboard filter then
    -- pattern-matches on those two magic strings. Splitting the axis means a
    -- national item can also carry a mandal, and the filter is a column comparison.
    scope           TEXT NOT NULL DEFAULT 'mandal',
    mandal          TEXT NOT NULL DEFAULT 'General',
    priority        TEXT NOT NULL DEFAULT 'medium',
    link            TEXT NOT NULL DEFAULT '',
    has_attachment  INTEGER NOT NULL DEFAULT 0,
    attachment_name TEXT,
    submitted_at    TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    deleted_at      TEXT,
    CHECK (scope IN ('mandal','national','international')),
    CHECK (priority IN ('high','medium','low'))
);

-- The dashboard lists by submission date, filtered by scope.
CREATE INDEX idx_news_submitted ON news (submitted_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_news_scope     ON news (scope, submitted_at DESC) WHERE deleted_at IS NULL;


-- ── campaign_reports ─────────────────────────────────────────────────────
CREATE TABLE campaign_reports (
    id                         TEXT PRIMARY KEY,
    title                      TEXT NOT NULL DEFAULT '(untitled report)',
    type                       TEXT NOT NULL DEFAULT 'Other',
    status                     TEXT NOT NULL DEFAULT 'Planned',
    mandal                     TEXT NOT NULL DEFAULT '',
    village                    TEXT NOT NULL DEFAULT '',
    description                TEXT NOT NULL DEFAULT '',
    event_date                 TEXT NOT NULL DEFAULT '',
    key_people_mentioned       TEXT NOT NULL DEFAULT '',
    attendance_or_beneficiaries TEXT NOT NULL DEFAULT '',
    sentiment                  TEXT NOT NULL DEFAULT '',
    confidence                 TEXT NOT NULL DEFAULT '',
    ocr_confidence             TEXT NOT NULL DEFAULT '',
    transcript                 TEXT NOT NULL DEFAULT '',
    intake_mode                TEXT NOT NULL DEFAULT 'mixed',
    logged_by                  TEXT NOT NULL DEFAULT '',
    source_event_id            TEXT REFERENCES raw_events(id),
    created_at                 TEXT NOT NULL,
    updated_at                 TEXT NOT NULL,
    deleted_at                 TEXT,
    CHECK (type IN ('Campaign','Government Scheme','Cluster Report','Other')),
    CHECK (status IN ('Planned','Ongoing','Completed','Delayed')),
    CHECK (sentiment IN ('','Positive','Neutral','Negative','Mixed')),
    CHECK (intake_mode IN ('typed','ocr','dictated','mixed'))
);

CREATE INDEX idx_campaign_reports_type   ON campaign_reports (type, status) WHERE deleted_at IS NULL;
CREATE INDEX idx_campaign_reports_mandal ON campaign_reports (mandal, village) WHERE deleted_at IS NULL;

-- The legacy singular `attachment` column is deliberately absent: it was already
-- always null for new records, mirrored by the media array beside it.
CREATE TABLE campaign_media (
    id         TEXT PRIMARY KEY,
    report_id  TEXT NOT NULL REFERENCES campaign_reports(id) ON DELETE CASCADE,
    position   INTEGER NOT NULL,
    file_path  TEXT NOT NULL,
    mime       TEXT NOT NULL DEFAULT '',
    type       TEXT NOT NULL DEFAULT 'image',
    label      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (report_id, position),
    CHECK (type IN ('image','audio','pdf','video'))
);


-- ── social_posts ─────────────────────────────────────────────────────────
CREATE TABLE social_posts (
    id         TEXT PRIMARY KEY,
    date       TEXT NOT NULL DEFAULT '',
    caption    TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
);

CREATE INDEX idx_social_posts_date ON social_posts (date) WHERE deleted_at IS NULL;

CREATE TABLE social_post_media (
    id         TEXT PRIMARY KEY,
    post_id    TEXT NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
    position   INTEGER NOT NULL,
    file_path  TEXT NOT NULL,
    mime       TEXT NOT NULL DEFAULT '',
    type       TEXT NOT NULL DEFAULT 'image',
    created_at TEXT NOT NULL,
    UNIQUE (post_id, position),
    CHECK (type IN ('image','audio','pdf','video'))
);


-- ── ttd_letters ──────────────────────────────────────────────────────────
-- The reference is TTD/<year>/<seq> and is quoted to the temple, so a duplicate
-- would be a real-world collision, not just a data problem. It was computed by
-- counting matching rows in a JSON array, which two concurrent requests could do
-- simultaneously and both get the same answer.
CREATE TABLE ttd_letters (
    id                     TEXT PRIMARY KEY,
    reference              TEXT NOT NULL,
    date                   TEXT NOT NULL DEFAULT '',
    name                   TEXT NOT NULL DEFAULT '',
    darshan_type           TEXT NOT NULL DEFAULT '',
    phone                  TEXT NOT NULL DEFAULT '',
    aadhar                 TEXT NOT NULL DEFAULT '',
    referred_by            TEXT NOT NULL DEFAULT '',
    remarks                TEXT NOT NULL DEFAULT '',
    party_size             INTEGER,
    review_status          TEXT NOT NULL DEFAULT 'Confirmed',
    -- Was a free-floating string id into another JSON array; now a real FK.
    source_visitor_form_id TEXT REFERENCES grievances(id),
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL,
    deleted_at             TEXT,
    CHECK (review_status IN ('Confirmed','Pending Review'))
);

CREATE UNIQUE INDEX idx_ttd_letters_reference ON ttd_letters (reference);
CREATE INDEX idx_ttd_letters_date   ON ttd_letters (date DESC) WHERE deleted_at IS NULL;
-- The Aadhar duplicate check, which is the page's headline feature. Stored
-- normalized (digits only) because normalizeAadhar() strips spaces and dashes and
-- an index cannot help a comparison that rewrites both sides.
CREATE INDEX idx_ttd_letters_aadhar ON ttd_letters (aadhar) WHERE deleted_at IS NULL;
