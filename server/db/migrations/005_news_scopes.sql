-- 005_news_scopes.sql — widen the news.scope CHECK to the four categories the
-- media tracker actually emits.
--
-- 002_domain.sql gave `scope` its own column but constrained it to
-- ('mandal','national','international'). The Palnadu media tracker's Excel
-- import (server/index.js, parseNewsExcel/normalizeCategory) classifies every
-- row as District, State, National or International — so two of its four
-- categories had nowhere to land. Before 005 they did not error, because
-- inferScope silently defaulted anything it did not recognise to 'mandal':
-- 43 State rows and 14 District rows on 2026-08-09 all went into the same
-- bucket, and the district's own coverage became indistinguishable from
-- statewide AP politics. Once inferScope stopped defaulting them, the insert
-- hit this CHECK instead.
--
-- 'mandal' is kept alongside 'district'. They are not redundant: 'district' is
-- the tracker's district-wide Local Coverage sheet, 'mandal' is a
-- field-correspondent submission tagged to one specific mandal, and every row
-- written before this migration carries it. The dashboard's District filter
-- matches both.
--
-- SQLite cannot ALTER a CHECK constraint, so this is the documented table
-- rebuild (https://sqlite.org/lang_altertable.html): new table, copy, drop,
-- rename, recreate indexes. No table has a foreign key onto news, so the
-- drop/rename is safe as written. Data is preserved verbatim — nothing is
-- reclassified here, because
-- the old rows genuinely are indistinguishable now; they age out of the
-- dashboard's date-filtered view within a day.

CREATE TABLE news_new (
    id              TEXT PRIMARY KEY,
    headline        TEXT NOT NULL DEFAULT '',
    body            TEXT NOT NULL DEFAULT '',
    source          TEXT NOT NULL DEFAULT 'Field correspondent',
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
    CHECK (scope IN ('district','mandal','state','national','international')),
    CHECK (priority IN ('high','medium','low'))
);

INSERT INTO news_new SELECT
    id, headline, body, source, scope, mandal, priority, link,
    has_attachment, attachment_name, submitted_at, created_at,
    updated_at, deleted_at
  FROM news;

DROP TABLE news;
ALTER TABLE news_new RENAME TO news;

CREATE INDEX idx_news_submitted ON news (submitted_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_news_scope     ON news (scope, submitted_at DESC) WHERE deleted_at IS NULL;
