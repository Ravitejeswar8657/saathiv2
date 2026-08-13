-- 007_event_coverage.sql — give a scheduled event somewhere to record what came
-- of it: press/media links, photos from the ground, and whether the team posted
-- about it on social media.
--
-- Until now an event was write-once. POST /api/schedule created it, DELETE
-- removed it, and the only editable surface was the brief-prep wizard
-- (PATCH /api/schedule/:id/prep), which touches speech points, contact briefs
-- and creative touches — never the event's own fields. So everything that
-- happens AFTER the event lived outside the system: the coverage link the PA
-- WhatsApps around, the photos on somebody's phone, whether social went out.
--
-- Two shapes, because the two kinds of coverage are not alike:
--
--   * Links are small, ordered, always read with their parent and never queried
--     on their own — the same profile as `news_selected` and `creative_touches`,
--     which are already JSON columns on this table. A child table for them would
--     buy referential integrity over data that has no referent.
--
--   * Files are bytes on the volume with a lifecycle (upload, remove, unlink on
--     delete), so they get a real child table with the ON DELETE CASCADE that
--     stops a media row outliving its event. event_media is social_post_media
--     (002_domain.sql) plus the `label` column grievance_media/campaign_media
--     carry, so server/db/media.js drives all four through one registry entry.
--
-- ALTER TABLE ADD COLUMN is enough here — no CHECK is being changed, so none of
-- the 005-style table rebuild is needed. Existing rows take the defaults, which
-- are exactly what "no coverage recorded yet" means.

ALTER TABLE events ADD COLUMN media_links    TEXT    NOT NULL DEFAULT '[]';
ALTER TABLE events ADD COLUMN social_posted  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN social_links   TEXT    NOT NULL DEFAULT '[]';
ALTER TABLE events ADD COLUMN coverage_notes TEXT    NOT NULL DEFAULT '';

-- Both link columns hold [{"url": "...", "label": "..."}].

CREATE TABLE event_media (
    id         TEXT PRIMARY KEY,
    event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    position   INTEGER NOT NULL,
    file_path  TEXT NOT NULL,
    mime       TEXT NOT NULL DEFAULT '',
    type       TEXT NOT NULL DEFAULT 'image',
    label      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (event_id, position),
    CHECK (type IN ('image','audio','pdf','video'))
);
