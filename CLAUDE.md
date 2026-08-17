# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                          # install dependencies
node server/db/migrate.js            # apply schema migrations (idempotent)
npm run backfill                     # import data/db.json into SQLite (idempotent, asserts row counts)
EXCEL_PATH=./combined_clean.xlsx npm run setup-db   # re-import contacts from Excel into SQLite
npm test                             # node --test "server/**/*.test.js" "public/**/*.test.js"
node server/index.js                 # start server on port 3000 (or $PORT)
```

`npm test` is the gate. Migrations also run at boot, and a database with no
contacts imports `db.json` on first start, so a fresh clone needs only
`npm install && node server/index.js`.

### Deployment

Railway builds from `./Dockerfile` (`builder = "DOCKERFILE"` in `railway.toml`), not
Nixpacks. The reason is `better-sqlite3`: it is a native addon, it installs a
prebuilt binary when one exists for the running Node ABI and compiles with node-gyp
when one does not, and the Nixpacks image has no Python — so the first Node major
without a published prebuild failed the build outright rather than falling back.

The image is multi-stage. The build stage carries `python3 make g++` so a missing
prebuild is a slower build instead of a failed deploy; the runtime stage carries
none of them. Two ordering constraints in there are load-bearing:

- `scripts/patch-fontkit.js` is copied **before** `npm ci`, because `postinstall`
  runs it and the install exits non-zero if the file is absent. The patch guards a
  null-anchor crash in fontkit's GPOS handling — it is what lets the daily-brief
  PDF render Telugu at all.
- `.dockerignore` excludes `node_modules`, so the `COPY . .` in the runtime stage
  cannot overwrite the native binary copied from the build stage with a host build
  for a different ABI or libc.

The base is `bookworm-slim` (glibc) and deliberately not alpine: better-sqlite3's
prebuilds are built against glibc, so musl would force a source build every time.

Local:

```bash
docker build -t saathi .
docker run -p 3000:3000 -v "$PWD/data:/data" -e RAILWAY_VOLUME_MOUNT_PATH=/data saathi
```

The container runs as root, deliberately — the app writes `saathi.db` and three
media directories into a volume whose ownership the platform decides, and a
permission failure there is a hard outage. Worth revisiting with an entrypoint that
chowns the mount.

### The Node version is pinned, deliberately

`engines.node` is `>=20.0.0 <23.0.0` and `.nvmrc` says `22`. **Do not widen this
without checking prebuilt binaries first.**

`better-sqlite3` is the only native addon in the tree. It installs a prebuilt
binary when one exists for the running Node ABI, and falls back to compiling with
node-gyp when one does not — and the Railway Nixpacks image has no Python, so that
fallback fails the build outright:

```
prebuild-install warn install No prebuilt binaries found (target=24.10.0 ...)
gyp ERR! find Python  Could not find any Python installation to use
```

That is what `engines: ">=18.0.0"` caused: the range let Railway pick whatever the
newest Node was, it moved to 24, and 11.10.0 publishes no `node-v137` binary.
Confirmed available for 11.10.0: `node-v115` (Node 20) and `node-v127` (Node 22);
`node-v137` (Node 24) returns 404. Upgrading is not an escape — as of 13.0.3 the
release carries no linux-x64 prebuilds at all.

When bumping Node or `better-sqlite3`, check the release assets first:

```bash
curl -sIL -o /dev/null -w '%{http_code}\n' \
  https://github.com/WiseLibs/better-sqlite3/releases/download/v<VER>/better-sqlite3-v<VER>-node-v<ABI>-linux-x64.tar.gz
```

Node 20 = ABI 115, Node 22 = 127, Node 24 = 137.

## Architecture

Saathi v2 is a political contact management system for an MP's team in the Palnadu constituency (AP). It has one main server file, a `server/db/` persistence layer, lazily-imported Gemini/chat/search modules, and several static HTML pages — no build step for the frontend. There is no WhatsApp integration in this codebase — it was fully removed (see "Removed features" below).

### Data flow

Storage is **SQLite** (`better-sqlite3`), modelled on the design in `/root/brain` —
see `brain/docs/03-database-design.md` and `brain/docs/integration-brief-chat-search.md`.

- `server/db/` owns every SQL statement. Route handlers call repository functions; none of them opens a connection or writes a query. `connection.js` is the only place a handle is created (WAL, `foreign_keys=ON`, `busy_timeout=5000`).
- Migrations are numbered `.sql` files under `server/db/migrations/`, applied in order by `server/db/migrate.js`. Each is checksummed and commits together with its ledger row, and the runner refuses to start on a gap, a duplicate version, or an edited migration that already ran. **Never edit an applied migration — add a new one.**
- `data/db.json` is no longer read or written at runtime. It survives as the first-boot import source and a rollback snapshot; the server imports it automatically when the database has no contacts.
- On Railway, `RAILWAY_VOLUME_MOUNT_PATH` points at the persistent volume; `saathi.db` and the media directories live there.
- `readDB()` in `server/index.js` is a **lazy view over SQLite** carrying db.json's old key names, so the ~60 existing read sites work unchanged. Each collection loads on first access and is memoized for the life of the request. There is deliberately no `writeDB`: the view's properties are getters with no setters, so a leftover write throws rather than silently doing nothing.

### Schema (`server/db/migrations/`)

| Migration | Contents |
|---|---|
| `001_core.sql` | `raw_events` (the ingest inbox), `records` + `records_fts` (the retrieval corpus — external-content FTS5 kept current by triggers), `record_versions`, `entities` + `entity_links` (the graph), `timeline`, `settings` |
| `002_domain.sql` | `contacts`, `grievances`, `events`, `event_contacts`, `news`, `campaign_reports`, `social_posts`, `ttd_letters`, plus three media child tables |
| `003_chat.sql` | `conversations`, `messages` |
| `004_data_fixups.sql` | One-off data corrections (replaces a boot-time IIFE that re-ran on every start) |
| `005_news_scopes.sql` | Widens `news.scope` to the four categories the media tracker emits (`district`/`state` alongside `mandal`/`national`/`international`) |
| `006_palnadu_spelling.sql` | Corrects the `constituency` setting written as `Palanadu (AP)` by an earlier `setup_db.js` |
| `007_event_coverage.sql` | Post-event coverage on `events` (`media_links`, `social_posted`, `social_links`, `coverage_notes` — links as JSON columns) plus the `event_media` child table for uploaded files |

Every typed row projects a companion row into `records` — that is what retrieval ranks and what the chat assistant is grounded on. `idx_records_source` keeps the projection one-to-one, and `records` can always be rebuilt from the typed tables.

Conventions: ULID ids (`server/db/ids.js`), so lexical order is chronological order; UTC ISO-8601 timestamps; `meta` JSON columns; `deleted_at` soft deletes; a `CHECK` constraint on every enum.

### Retrieval (`server/search.js`)

Hybrid, ported from `brain/services/core/modules/search/service.py`:

1. FTS5/BM25 over `records_fts` and Fuse.js fuzzy matching over a cached projection of `records`, both fanned out at `max(2k, 16)`, filters applied *inside* each retriever.
2. Fused with reciprocal rank fusion (k=60); each hit tagged `fts` / `fuzzy` / `hybrid`.
3. Widened by a bounded one-hop expansion over `entity_links`, only when there are already ≥3 results, scored strictly below the worst direct hit.

Response is `{query, k, degraded, sources, results[]}`. `sources` is **sparse** — an origin that contributed nothing is omitted. A retriever that fails sets `degraded`; search never 500s. `GET /api/search/status` distinguishes an empty corpus from a broken index from an absent retriever.

FTS matching requires every term first, then relaxes to any term with stopwords removed. Without that relaxation the chat assistant retrieves nothing, because it feeds the user's whole sentence in as the query.

The vector retriever is a declared no-op (`vectorSearch()`). Adding embeddings later means implementing that one function; fusion, expansion, hydration, response shape and UI are unchanged.

### Ask Saathi (`server/chat.js`, `server/db/conversations.js`)

Streaming, thread-persisted, **read-only** — no tools, so the assistant can describe the register but never write to it.

- `POST /api/chat` returns SSE: exactly one `start`, zero or more `token`, exactly one `done` (or `error` then `done`). Headers include `X-Accel-Buffering: no`, without which a proxy buffers every token until completion and silently defeats streaming.
- The user's message is written to the database **before any model call**, and a terminal frame is always emitted. A closed tab persists the partial reply through a detached write held at module scope.
- The prompt is a versioned template on disk (`server/prompts/chat_v1.md`). Retrieved records render inside `<<<DATA:…>>>` blocks and the prompt states they are data, never instructions. The system message is exempt from trimming, because a provider truncating from the front would remove exactly that rule.
- One `active` conversation per channel; `POST /api/conversations` reuses an untitled empty thread (200) rather than writing a row (201). Titles derive from the first user message in code, not from a model. Delete is a soft delete with a capped, restorable trash swept daily.
- Route order is load-bearing: `/api/conversations/active` and `/trash` register **before** `/:id`. Cursors are base64 and must be decoded before reaching SQL.

### Server (`server/index.js`)

Single Express file (ES Modules). Key responsibilities:
- Serves `public/` as static files; falls back to `public/index.html` for all unmatched routes.
- Google News RSS is fetched and cached in-memory for 15 minutes (`/api/live-news`).
- The "Daily brief" PDF (`buildBriefPDF`, `GET /api/brief-pdf`) is the live brief-generation flow, driven from `pa_schedule.html`/`brief_workflow.html` — it reads `db.schedule`/contact data directly and has no WhatsApp dependency.

### News categories in the brief (`server/news-categories.js`)

`newsCategory(item)` is the only thing allowed to decide which heading
(`National`/`International`/`State`/`District`) a news item prints under, because three
different shapes reach the brief: SQLite rows carry lowercase **`scope`**, in-flight Excel/PDF
import items carry title-case `category`, and auto-scraped RSS carries neither (only
`mandal_tag` → District if set, else State). `mandal` folds into District, matching the News
Dashboard's District filter.

`category` was the db.json-era field and `005_news_scopes.sql` moved that axis to the `scope`
column. `buildBriefPDF` kept reading `n.category` off DB rows, got `undefined` every time and
defaulted everything to `'District'` — so the INTERNATIONAL/NATIONAL/STATE headings never
rendered even when the media tracker had imported items in all four. Never read `.category` or
`.scope` off a news item in a brief path; call the resolver. The module is separate from
`index.js` because importing `index.js` starts the HTTP server, so nothing in it is testable
(`server/news-categories.test.js` also asserts every `SCOPES` value has a heading — that is what
catches the next migration widening `news.scope`).

The auto (nobody-picked-anything) news section is capped **per category**
(`PDF_NEWS_PER_CATEGORY`, 5), not by a flat total: a flat slice before grouping let whichever
category sorted first eat the whole allowance. PA-picked news is never truncated.

### PPS scoring (`scripts/setup_db.js`)

Priority & Proximity Score is computed once at import time. Formula components:
- **influence** — log-scaled estimated reach × role multiplier
- **decay** — hardcoded 0.5 (no last-interaction data in source Excel)
- **affinity** — 0.8 for TDP, 0.9 for Krishna-follower, 0.3 otherwise
- **base** — maps priority levels L1–L4 to scores 90/75/55/30

Weights: `0.20×influence + 0.22×decay + 0.18×hasGrievance + 0.15×reciprocity + 0.18×affinity + 0.07×(base/100)`.

The Excel column mapping is: `Name`, `Phone Number`, `Village`, `Mandal`, `Constituency`, `party` (or `party `), `Comments`.

### Frontend pages (`public/`)

All pages are vanilla HTML/JS with no framework or bundler. They call the REST API and render directly.

Shared scripts: `public/js/saathi-ui.js` (toast, confirm dialog, mandal list) and
`public/js/event-coverage.js` — the post-event coverage modal, injected into the page on
first open and used identically by `index.html` and `pa_schedule.html`. It records what
came of an event (press/media links, uploaded photos/video/PDF, whether social went out
and the post links, plus notes); the event's own fields are read-only in it, because
booking details are edited nowhere and the wizard owns prep.

| Page | Purpose |
|---|---|
| `index.html` | Main team dashboard — contacts, schedule, news, grievance-register stat tile. Upcoming-event cards open the shared coverage modal; a corner `Prepare brief →` link keeps the old route into `brief_workflow.html` |
| `news.html` | Journalist submission form |
| `pa_schedule.html` | PA schedule upload. Event cards are clickable and open the post-event coverage modal |
| `pa_issues.html` | Issue/grievance logging |
| `admin.html` | Chief of Staff intelligence hub, MP-facing only (no data-entry UI on this page). Today's schedule, Personal/Political/Governance Intelligence pillars, News Dashboard/Live News pulse, plus sidebar Campaign Summaries and AI-Suggested Daily Actions. Nothing on this page reads `/api/contacts` — the mandal/village governance report, grievance category breakdown, and social-media queue are the only real-data widgets (all sourced from `/api/grievances`, `/api/social-calendar`, `/api/schedule`, `/api/stats`); Constituency Health Score, Voter Sentiment Map, Media Sentiment, Opposition Activity, Campaign Summaries, Government Scheme Progress, Scheme Fund Utilization, and Daily Actions are clearly-tagged illustrative placeholders |
| `heatmap.html` | Mandal-level coverage heatmap (Leaflet + OpenStreetMap, no API key) — contact density, average priority score, and grievance-register hotspots (count/top category/avg priority per mandal, from `/api/grievances`, additive to the legacy `contact.open_grievance` count) per mandal, joined against `public/assets/mandal_coords.json` (generated once via `scripts/geocode_mandals.js`) |
| `journalist.html` | Alternate journalist form |
| `ttd_letters.html` | TTD reference letter register — calendar view, Aadhar duplicate check, Excel/PDF exports, per-letter PDF. Not in the sidebar nav (reachable by direct URL only); the page and its API are otherwise unchanged |
| `grievances.html` | Unified grievance register across intake channels. Bulk "Upload Forms": staff photograph/scan many paper forms at once, Gemini OCR-extracts each into its own record. "Log Grievance" is a universal single-grievance intake — any combination of typed text, photo(s)/PDF (camera capture or file picker), and audio (mic recording or attached file) submitted together merge into one AI-reviewed record, never one-per-attachment. Every route assigns a category/urgency that staff review and correct in an editable preview before saving; channel column and filter, category pills, calendar, status tracking, Excel/PDF exports, live duplicate-check banner, linked-grievance badges, an on-demand AI-suggested-response panel (advisory only — never auto-populates the action fields), and an on-demand "Draft letter to department" panel (advisory AI-drafted letter to the grievance category's department head, editable, downloadable as PDF). `walk_in`/`phone_call` are the only live intake channels now; `whatsapp_text`/`whatsapp_voice` remain as historical channel values on old records (the WhatsApp Inbox intake that produced them was removed) |
| `campaign_reports.html` | Third intake page (alongside schedule and news), titled "Political Intake", for campaigns, government schemes, and cluster-wise field reports. Intake is universal and AI-assisted, built on the same discipline as the grievance register: any combination of typed text, photo(s)/PDF (camera capture or file picker) and audio (mic recording or attached file) submitted together merge into ONE record, never one-per-attachment. Staff review and correct the extraction in an editable preview before saving — nothing reaches the register until they hit Save. Plus a type/status-filtered listing with inline edit/delete. Not wired into admin.html's illustrative Campaign Summaries/Scheme Progress/Fund Utilization widgets yet |
| `social_calendar.html` | Social media content calendar — calendar view where each date can hold multiple posts, each post carrying one or more media files (images/video/PDF) plus a caption |

### Key API endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/dashboard` | Full data payload for the main dashboard |
| GET | `/api/contacts` | Filterable/searchable contact list (Fuse.js fuzzy search via `?q=`) |
| GET | `/api/contact/:id` | Single contact |
| POST | `/api/contact` | Add new contact |
| POST | `/api/schedule` | Add event; auto-finds nearby contacts by mandal using Fuse.js |
| PATCH | `/api/schedule/:id` | Record post-event coverage (multipart: `media_links`/`social_links` JSON, `social_posted`, `coverage_notes`, `remove_media` JSON, up to 10 files under `media`). Coverage only — it does not edit the event's own fields |
| GET | `/api/schedule/media/:filename` | Retrieve a stored event coverage file |
| DELETE | `/api/schedule/:id` | Remove event (and unlink its coverage media) |
| POST | `/api/issue` | Log issue against a contact (still used by `pa_issues.html`; issues logged this way stay `pending` — the admin approve/reject workflow that used to resolve them was removed) |
| POST | `/api/news` | Submit news item (multipart, optional attachment) |
| GET | `/api/brief-pdf` | Generate the daily brief PDF for a date (`buildBriefPDF`) |
| GET | `/api/live-news` | Cached Google News RSS (Palnadu keywords) |
| GET | `/api/stats` | Aggregate counts, including `open_grievances_register` (unresolved `db.grievances`, distinct from the legacy `with_grievances` contact-flag count) |
| GET | `/api/ttd-letters` | List TTD reference letters (filterable by `from`/`to`) |
| GET | `/api/ttd-letters/check-duplicate` | Check for existing letters by Aadhar |
| POST | `/api/ttd-letters` | Create TTD reference letter |
| PATCH | `/api/ttd-letters/:id` | Edit TTD reference letter |
| DELETE | `/api/ttd-letters/:id` | Remove TTD reference letter |
| GET | `/api/ttd-letters/export.xlsx` | Export TTD letters as Excel |
| GET | `/api/ttd-letters/export-pdf` | Export TTD letters register as PDF |
| GET | `/api/ttd-letters/:id/letter-pdf` | Generate a single formal TTD letter PDF |
| GET | `/api/grievances/categories` | List the grievance issue category taxonomy (each entry also carries `department`/`department_head`, used only by the draft-letter feature) |
| POST | `/api/grievances/upload` | Upload photographed form images (multipart, field `images`, up to 20); Gemini OCR-extracts + categorizes each into its own record for review — does not write to DB |
| POST | `/api/grievances/log` | Universal single-grievance intake (multipart: optional `text`, optional `images[]` up to 10, optional `audio`) — runs whichever of OCR/transcription/text-triage apply and merges them into ONE reviewable record (`intake_mode: 'mixed'`); attachments are parked server-side as `pending_media` (same abandonment sweep as below) |
| DELETE | `/api/grievances/pending-media/:filename` | Drop a parked attachment when staff discard the review (a startup sweep also clears `tmp_*` files older than 24h) |
| POST | `/api/grievances` | Commit the (staff-reviewed/edited) items to the register; claims any `pending_media`/`media[]` |
| GET | `/api/grievances` | List grievances (filterable by `from`/`to`/`category`/`status`/`channel`) |
| PATCH | `/api/grievances/:id` | Edit a grievance record (partial update) |
| DELETE | `/api/grievances/:id` | Remove a grievance record (and all of its stored media) |
| GET | `/api/grievances/:id/media/:index?` | Retrieve one of the record's source media files — form photo, PDF or audio; `:index` defaults to 0 (the first/legacy single attachment) |
| GET | `/api/grievances/export.xlsx` | Export grievances as Excel |
| GET | `/api/grievances/export-pdf` | Export the grievances register as PDF |
| POST | `/api/grievances/:id/create-ttd-letter` | Manually create a TTD reference letter from an existing grievance record (paper forms don't capture darshan type/Aadhar, so staff supply those) |
| GET | `/api/grievances/duplicate-check` | Live duplicate check by `phone`/`text`/`name`/`village` — phone is an exact-match signal, the rest are fuzzy "possible match" hints |
| POST | `/api/grievances/:id/suggest-response` | On-demand AI draft of a citizen reply + internal next action (advisory — writes only `suggested_response`/`suggested_next_action`, never `action_taken`/`action_to_be_taken`) |
| POST | `/api/grievances/:id/draft-letter` | On-demand AI draft of a formal letter to the grievance category's department head (advisory — auto-saves only `drafted_letter_subject`/`drafted_letter_body`) |
| GET | `/api/grievances/:id/department-letter-pdf` | Render the (possibly staff-edited) drafted letter as a PDF, addressed via the category's `department`/`department_head` — 400s if no draft exists yet |
| GET | `/api/social-calendar` | List social media posts (filterable by `from`/`to`) |
| POST | `/api/social-calendar` | Create a post (multipart: `date`, `caption`, up to 10 files under `media`) |
| PATCH | `/api/social-calendar/:id` | Edit a post's `date`/`caption` |
| DELETE | `/api/social-calendar/:id` | Remove a post and its stored media files |
| GET | `/api/social-calendar/media/:filename` | Retrieve a stored media file |
| GET | `/api/campaign-reports` | List campaign/scheme/cluster reports (filterable by `type`/`mandal`/`status`) |
| GET | `/api/campaign-reports/taxonomy` | The `type`/`status` vocabulary the page builds its `<select>`s from (see "The report taxonomy") |
| POST | `/api/campaign-reports/log` | Universal single-report intake, mirroring `/api/grievances/log` (multipart: optional `text`, optional `images[]` up to 10, optional `audio`, plus staff-typed `title`/`mandal`/`village`/`logged_by`) — runs whichever of OCR/transcription/text-triage apply and merges them into ONE reviewable preview (`intake_mode: 'mixed'`); attachments are parked as `pending_media` and **nothing is written to the register** |
| DELETE | `/api/campaign-reports/pending-media/:filename` | Drop a parked attachment when staff discard the preview (the same startup sweep clears `tmp_*` files older than 24h) |
| POST | `/api/campaign-reports` | Commit the (staff-reviewed/edited) preview to the register — JSON `{items:[…]}`, **not** multipart; claims any `pending_media`/`media[]` |
| PATCH | `/api/campaign-reports/:id` | Edit a report's fields (`title`/`type`/`mandal`/`village`/`status`/`description`) |
| DELETE | `/api/campaign-reports/:id` | Remove a report and its stored attachments |
| GET | `/api/campaign-reports/:id/media/:index?` | Retrieve one of the report's attachments; `:index` defaults to 0 (the first/legacy single attachment) |
| POST | `/api/search` | Hybrid retrieval (`{query, k, filters}`) → `{query, k, degraded, sources, results[]}` |
| GET | `/api/search` | Flat-list form of the above (`?q=`), kept for existing callers |
| GET | `/api/search/status` | Corpus size, per-retriever health, fusion settings |
| POST | `/api/search/reindex` | Rebuild `records_fts` from `records` |
| POST | `/api/chat` | Streaming chat turn (SSE: `start` / `token`* / `done` \| `error`) |
| GET | `/api/conversations` | List threads (`?channel=&status=&limit=&cursor=`) |
| GET | `/api/conversations/active` | The thread the next message lands in |
| GET | `/api/conversations/trash` | Deleted threads, with the cap and retention window |
| POST | `/api/conversations` | Open a thread — 201 new, 200 if it reused an empty one |
| PATCH | `/api/conversations/:id` | Rename (`title`) or archive (`status`); `meta` is never exposed |
| DELETE | `/api/conversations/:id` | Soft delete (204) |
| POST | `/api/conversations/:id/restore` | Restore from trash, always as `closed` |
| GET | `/api/conversations/:id/messages` | Thread history, oldest first (`?limit=&cursor=`) |
| GET | `/health` | Railway health check |

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Server listen port |
| `RAILWAY_VOLUME_MOUNT_PATH` | `./data` | Path for `saathi.db`, `db.json` and stored media (`grievance_media/`, `social_calendar_media/`, `campaign_media/`, `event_media/`) |
| `SQLITE_PATH` | `<volume>/saathi.db` | Override the database file location |
| `CHAT_MAX_TOKENS` | `6000` | Context budget for a chat turn |
| `CONVERSATION_IDLE_MINUTES` | `120` | Idle time after which a thread auto-closes (resolved lazily) |
| `CONVERSATION_TRASH_LIMIT` | `10` | Deleted threads retained per channel |
| `CONVERSATION_TRASH_DAYS` | `30` | Retention window before a deleted thread is purged |
| `EXCEL_PATH` | `./combined_clean.xlsx` | Input file for `setup_db.js` |
| `GEMINI_API_KEY` | (none) | Google Gemini API key for the extraction paths — form-photo OCR, typed-summary triage and audio transcription, for both the grievance register and the campaign-report intake (`server/gemini.js`). If unset, those endpoints fail fast with a clear error rather than crashing — staff can still use both registers manually. |

### AI extraction (`server/gemini.js`)

Lazy-imported on first use so a missing `GEMINI_API_KEY` doesn't crash the server. All calls share one `callGemini(parts, responseSchema, timeoutMs)` helper (30s default, 45s for audio) over two families of field schema — grievance and report; entry points wrap it:

- `extractGrievanceFromImage(buffer, mimeType, categories)` — OCRs a photographed walk-in form; adds `ocr_confidence`.
- `extractGrievanceFromText(text, categories)` — triages a typed phone-call summary or message; adds `is_grievance` + `confidence` so non-grievances (greetings, spam) can be gated out of the register.
- `extractGrievanceFromAudio(buffer, mimeType, categories)` — transcribes dictated audio (Telugu/English/mixed, original script) and extracts from the transcript; adds `transcript`, and runs on a 45s timeout instead of the 30s default.
- `suggestGrievanceResponse(grievance)` — on-demand, text-only draft of a citizen-facing reply plus an internal next-action note; advisory only, never wired into the save/commit path.
- `draftDepartmentLetter(grievance, departmentInfo, mpName)` — on-demand, text-only draft of a formal letter (`subject`/`body`) to a government department head for the grievance's category; advisory only, auto-saved on generation but never auto-printed/sent.

The campaign-report intake has its own trio, same shape but no category taxonomy or `is_grievance` gate — they judge `{type, status}` instead:

- `extractReportFromImage(buffer, mimeType)` — OCRs a photographed report or notice.
- `extractReportFromText(text)` — extracts from a typed field report.
- `extractReportFromAudio(buffer, mimeType)` — transcribes dictated audio and extracts from the transcript; adds `transcript`, on the same 45s timeout.

`POST /api/grievances/log` (the universal intake) calls `extractGrievanceFromImage`/`extractGrievanceFromAudio`/`extractGrievanceFromText` in whatever combination the submission includes, then merges the results into one record via `mergeGrievanceExtraction` in `server/index.js` (image OCR wins scalar identity/location fields; audio dictation wins the category/urgency judgement; `issue_description` is concatenated per-source, never chosen, so nothing is silently dropped).

`POST /api/campaign-reports/log` does the same for reports, merging via `mergeReportExtraction` in `server/index.js`. The merge rules are deliberately parallel: scalar fields are first-source-wins in priority order image→audio→text, `description` is concatenated per-source rather than chosen, and staff-typed fields always win outright. `{type, status}` is taken as one coherent bundle from a single richest source and never mixed across sources, because a type from one reading paired with a status from another describes a report that nobody filed.

Each grievance extraction path constrains Gemini with a JSON `responseSchema` including a `category` enum built from `ISSUE_CATEGORIES` in `server/index.js` and an AI-judged `urgency`. The server then computes a deterministic `priority_score` from the category's fixed weight and the urgency, so triage ordering stays auditable. Report extraction is constrained the same way, and additionally judges `confidence`/`sentiment`. Its `type`/`status` enums come from `REPORT_TAXONOMY` in `server/db/campaign_reports.js` — see "The report taxonomy" below.

Source media is persisted to `VOLUME/grievance_media/` and `VOLUME/campaign_media/` for later manual re-verification of low-confidence reads; both directories get the same startup sweep of abandoned `tmp_*` uploads.

### The report taxonomy (`server/db/campaign_reports.js`)

`REPORT_TAXONOMY` is the single source for campaign-report `type`/`status`. Everything else derives from it:

| Consumer | How it derives |
|---|---|
| Write-time coercion (`ENUMS` in the same file) | `REPORT_TAXONOMY.types.map(t => t.value)` |
| Route validation (`CAMPAIGN_REPORT_TYPES`/`CAMPAIGN_REPORT_STATUSES`, `server/index.js`) | Sets built from the import |
| Gemini response schema | `withReportEnums(schema, taxonomy)`, mirroring `withCategoryEnum` |
| All three extraction prompts | `reportEnumInstructions(taxonomy)` — one renderer, using each type's prompt-only `hint` |
| The page's four `<select>`s | `GET /api/campaign-reports/taxonomy` |

These were eight independent copies before, and a drift between them failed silently in the worst direction: a type only one copy knew about was rewritten to `Other` on save, with no error.

**Adding a value is a two-step change.** The `CHECK` constraints in `002_domain.sql` cannot derive from JS — an applied migration must never be edited — so a new value needs both a `REPORT_TAXONOMY` entry *and* a migration widening the `CHECK`, the same way `005_news_scopes.sql` widened `news.scope`. Skip the migration and the insert fails loudly on the constraint, which is the intended behaviour: it is the one duplication left, and it errors rather than corrupting.

`public/campaign_reports.html` still keeps `TYPE_TAG_CLASS`/`STATUS_CLASS` locally. Those are CSS-class lookups, not vocabulary, and both already fall back (`|| 'tag-other'`, `|| 'status-planned'`), so a new value renders unstyled rather than breaking.

### Duplicate detection (`server/index.js`)

`findGrievanceDuplicates` runs on every `buildGrievanceRecord` call: an exact `normalizePhone` match auto-links both records' `linked_grievance_ids` bidirectionally; a Fuse.js match on `issue_description` or a matching name+village are returned as unlinked "possible" warnings for staff to check. `normalizePhone` itself has no WhatsApp dependency — it's just phone-number normalization, kept after the WhatsApp/broadcast removal because grievance duplicate-detection relies on it.

## Removed features

WhatsApp integration (Baileys), the Broadcast feature (`broadcast.html`, WhatsApp group/list messaging), and the WhatsApp Inbox (`grievance_inbox.html`, open public grievance intake via WhatsApp) have all been fully removed — no code, routes, or dependencies remain. The legacy WhatsApp-brief-send plumbing (`generateBriefText`, `sendWhatsAppBrief`, `recomputeBrief`, `/api/send-brief`, `/api/generate-brief`, `/api/brief-preview`, `/api/wa-status`) went with it; it was already orphaned (no page called it) since the daily brief moved to the PDF flow (`/api/brief-pdf`). Old grievance records with `channel: whatsapp_text`/`whatsapp_voice` remain in the register as historical data — that intake channel just no longer produces new ones. TTD Letters (`ttd_letters.html`) was not removed, only unlisted from the sidebar nav; it's still fully functional at its direct URL.
