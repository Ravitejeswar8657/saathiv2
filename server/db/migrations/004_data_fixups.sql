-- 004_data_fixups.sql — one-off corrections to existing data.
--
-- This is what a migration runner is FOR, and it replaces the pattern it is named
-- after. server/index.js used to carry this as a boot-time IIFE
-- (`migratePensionWelfareCategory`) that, on EVERY start, parsed the whole 3 MB
-- db.json, scanned every grievance, and rewrote the file if anything matched —
-- all inside a try/catch that logged and continued. Three problems with that
-- shape, none of which are visible while it happens to work:
--
--   · it re-ran forever, because nothing recorded that it had already run;
--   · a failure was indistinguishable from a no-op, because the catch swallowed it;
--   · a second fixup would have meant a second IIFE, in boot order, with the same
--     properties.
--
-- Here it runs once, inside a transaction, and its ledger row is committed with
-- it. A crash rolls back both.


-- The 'pension_welfare' category was merged into the broader 'social_welfare_bc'
-- ("Social Welfare & BC/Minority Welfare"). The key no longer appears in
-- ISSUE_CATEGORIES, so any surviving row would fail the category lookup and be
-- rendered as its raw key.
UPDATE grievances
   SET category = 'social_welfare_bc', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE category = 'pension_welfare';

-- The corpus row carries the category in its summary and its meta, so it has to
-- move with it. Left alone, retrieval would keep matching the retired key.
UPDATE records
   SET meta = json_set(meta, '$.category', 'social_welfare_bc'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE source_table = 'grievances'
   AND json_extract(meta, '$.category') = 'pension_welfare';
