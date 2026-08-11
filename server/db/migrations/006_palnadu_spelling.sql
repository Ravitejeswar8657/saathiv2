-- 006_palnadu_spelling.sql — correct the district's name in the settings row.
--
-- The district is Palnadu. The codebase spelled it "Palanadu" in 32 places,
-- fixed in the commit before this one — but one of those places was
-- `setSetting('constituency', 'Palanadu (AP)')` in scripts/setup_db.js, which
-- means the misspelling was not only in the source, it was WRITTEN INTO every
-- database that ever ran the Excel import. Fixing the source does not fix those:
-- setup_db.js only runs on a manual re-import, so a deployed volume keeps the old
-- value indefinitely.
--
-- It is not cosmetic-in-the-database-only either. `/api/dashboard` returns
-- `{ ...db.metadata, ...allSettings() }` (server/index.js) — settings spread
-- LAST — so this row overrides the hardcoded constituency in readDB()'s metadata
-- getter. On a database carrying the old row, the corrected code still serves the
-- misspelling to every page that reads dashboard metadata.
--
-- The WHERE clause matches the exact old value rather than the key, so this
-- cannot clobber a constituency someone has since set by hand.
UPDATE settings
   SET value = 'Palnadu (AP)', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE key = 'constituency'
   AND value = 'Palanadu (AP)';

-- Deliberately NOT swept: staff- and citizen-entered free text (grievance
-- descriptions, addresses, news titles, event names). The district name reaches
-- the typed tables only through this setting — `contacts.constituency` holds
-- ASSEMBLY constituencies (Narasaraopet, Gurajala, Vinukonda, …), never the
-- district, and no row in the db.json snapshot carries the misspelling in any
-- other column. Rewriting free text would edit what a citizen said in order to
-- fix what the app wrote, and would leave the `records` projection and its FTS
-- index to be rebuilt behind it. If such rows ever turn up, they want their own
-- migration with a `records`/`records_fts` refresh attached.
