# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install                          # install dependencies
EXCEL_PATH=./combined_clean.xlsx node scripts/setup_db.js   # seed data/db.json from Excel
node server/index.js                 # start server on port 3000 (or $PORT)
```

There is no test suite. Verification is manual via browser and API calls.

## Architecture

Saathi v2 is a political contact management system for an MP's team in the Palanadu constituency (AP). It has two server files and several static HTML pages — no build step for the frontend.

### Data flow

- `scripts/setup_db.js` reads an Excel file (`combined_clean.xlsx`) and writes `data/db.json` — the single source of truth. This script is run once to seed the database; all subsequent reads/writes go through `server/index.js` helpers (`readDB()` / `writeDB()`).
- On Railway, `RAILWAY_VOLUME_MOUNT_PATH` redirects `db.json` and `wa_auth/` to a persistent volume. Locally they live in `data/`.
- If `db.json` is absent on startup (e.g., fresh Railway deploy before a volume write), the server copies the bundled `data/db.json` snapshot.

### Server (`server/index.js`)

Single Express file (ES Modules). Key responsibilities:
- Serves `public/` as static files; falls back to `public/index.html` for all unmatched routes.
- `recomputeBrief(db)` — rebuilds `todays_brief` from schedule events whose date is within ±1 day, pulling the top-PPS nearby contacts from each event.
- `generateBriefText()` — formats the WhatsApp message.
- Lazy-imports `./whatsapp.js` on first use to avoid crashing when Baileys is unavailable.
- Google News RSS is fetched and cached in-memory for 15 minutes (`/api/live-news`).

### WhatsApp (`server/whatsapp.js`)

Wraps `@whiskeysockets/baileys`. On module load it immediately calls `init()`, which opens a Baileys socket with multi-file auth stored in `data/wa_auth/`. The module exports:
- `default` (= `sendMessage(text, phone)`) — sends a message; throws if not connected.
- `getStatus()` / `getQR()` — used by `/api/wa-status`.
- `setOnIncomingMessage(cb)` — registered by `index.js` to handle MP replies of the form `approve <ISS…>` or `reject <ISS…>`, recording them to `db.wa_responses`. This array is now write-only: the admin UI/endpoints that used to read and confirm it were removed, so replies are still captured but nothing surfaces or acts on them.
- `setOnPublicMessage(cb)` — registered by `index.js` to handle open grievance intake: any 1:1 sender other than the MP's own number, text or a voice note (`ptt` audio). Group messages are always ignored. A per-sender in-memory rate guard (5 messages / 10 min) tags floods as `rateLimited` so the caller can skip the Gemini call rather than drop the message.

WhatsApp reconnects automatically on non-logout disconnects. On logout it wipes `wa_auth/` and resets for a new QR scan.

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

| Page | Purpose |
|---|---|
| `index.html` | Main team dashboard — contacts, schedule, brief, news, grievance-register stat tile |
| `news.html` | Journalist submission form |
| `pa_schedule.html` | PA schedule upload |
| `pa_issues.html` | Issue/grievance logging |
| `admin.html` | Chief of Staff intelligence hub — no WhatsApp status or brief-sending UI here (the daily brief now goes out as a PDF via a different flow); today's schedule, Personal/Political/Governance Intelligence pillars, News Dashboard/Live News pulse, plus sidebar Campaign Summaries and AI-Suggested Daily Actions. Nothing on this page reads `/api/contacts` — the mandal/village governance report, grievance category breakdown, social-media and WhatsApp-inbox queues are the only real-data widgets (all sourced from `/api/grievances`, `/api/social-calendar`, `/api/grievance-inbox`, `/api/schedule`, `/api/stats`); Constituency Health Score, Voter Sentiment Map, Media Sentiment, Opposition Activity, Campaign Summaries, Government Scheme Progress, Scheme Fund Utilization, and Daily Actions are clearly-tagged illustrative placeholders |
| `heatmap.html` | Mandal-level coverage heatmap (Leaflet + OpenStreetMap, no API key) — contact density, average priority score, and grievance-register hotspots (count/top category/avg priority per mandal, from `/api/grievances`, additive to the legacy `contact.open_grievance` count) per mandal, joined against `public/assets/mandal_coords.json` (generated once via `scripts/geocode_mandals.js`) |
| `journalist.html` | Alternate journalist form |
| `ttd_letters.html` | TTD reference letter register — calendar view, Aadhar duplicate check, Excel/PDF exports, per-letter PDF |
| `grievances.html` | Unified grievance register across intake channels. Bulk "Upload Forms": staff photograph/scan many paper forms at once, Gemini OCR-extracts each into its own record. "Log Grievance" is a universal single-grievance intake — any combination of typed text, photo(s)/PDF (camera capture or file picker), and audio (mic recording or attached file) submitted together merge into one AI-reviewed record, never one-per-attachment. Every route assigns a category/urgency that staff review and correct in an editable preview before saving; channel column and filter, category pills, calendar, status tracking, Excel/PDF exports, live duplicate-check banner, linked-grievance badges, an on-demand AI-suggested-response panel (advisory only — never auto-populates the action fields), and an on-demand "Draft letter to department" panel (advisory AI-drafted letter to the grievance category's department head, editable, downloadable as PDF) |
| `grievance_inbox.html` | WhatsApp Inbox — staff triage queue for open public WhatsApp intake (`server/whatsapp.js`'s `setOnPublicMessage`). Every 1:1 message/voice note from a number other than the MP's own lands here first with its AI classification; nothing reaches `grievances.html` until staff Promote (which also sends the sender a WhatsApp acknowledgement with the new grievance's id) or Dismiss it. History toggle shows past promoted/dismissed entries |
| `social_calendar.html` | Social media content calendar — calendar view where each date can hold multiple posts, each post carrying one or more media files (images/video/PDF) plus a caption |

### Key API endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/dashboard` | Full data payload for the main dashboard |
| GET | `/api/contacts` | Filterable/searchable contact list (Fuse.js fuzzy search via `?q=`) |
| GET | `/api/contact/:id` | Single contact |
| POST | `/api/contact` | Add new contact |
| POST | `/api/schedule` | Add event; auto-finds nearby contacts by mandal using Fuse.js |
| DELETE | `/api/schedule/:id` | Remove event |
| POST | `/api/issue` | Log issue against a contact (still used by `pa_issues.html`; issues logged this way stay `pending` — the admin approve/reject workflow that used to resolve them was removed) |
| POST | `/api/news` | Submit news item (multipart, optional attachment) |
| POST | `/api/send-brief` | Trigger WhatsApp send |
| GET | `/api/generate-brief` | Regenerate brief text without sending |
| GET | `/api/brief-preview` | Last generated brief text |
| GET | `/api/wa-status` | WhatsApp connection state + QR data |
| GET | `/api/live-news` | Cached Google News RSS (Palanadu keywords) |
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
| GET | `/api/grievance-inbox` | List WhatsApp Inbox entries (filterable by `?status=pending_review\|promoted\|dismissed`) |
| POST | `/api/grievance-inbox/:id/promote` | Save a reviewed inbox entry into `db.grievances` (channel `whatsapp_text`/`whatsapp_voice`) and send the sender a WhatsApp acknowledgement |
| POST | `/api/grievance-inbox/:id/dismiss` | Mark an inbox entry as not a grievance; no reply sent |
| DELETE | `/api/grievance-inbox/:id` | Remove an inbox entry (and its voice-note file, if unpromoted) |
| GET | `/api/grievance-inbox/:id/audio` | Stream a queued voice-note entry's audio |
| GET | `/api/social-calendar` | List social media posts (filterable by `from`/`to`) |
| POST | `/api/social-calendar` | Create a post (multipart: `date`, `caption`, up to 10 files under `media`) |
| PATCH | `/api/social-calendar/:id` | Edit a post's `date`/`caption` |
| DELETE | `/api/social-calendar/:id` | Remove a post and its stored media files |
| GET | `/api/social-calendar/media/:filename` | Retrieve a stored media file |
| GET | `/health` | Railway health check |

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Server listen port |
| `RAILWAY_VOLUME_MOUNT_PATH` | `./data` | Path for `db.json` and `wa_auth/` |
| `EXCEL_PATH` | `./combined_clean.xlsx` | Input file for `setup_db.js` |
| `GEMINI_API_KEY` | (none) | Google Gemini API key for the grievance extraction paths — form-photo OCR, typed-summary triage and audio transcription (`server/gemini.js`). If unset, those endpoints fail fast with a clear error rather than crashing — staff can still use the register manually. |

### Grievance extraction (`server/gemini.js`)

Lazy-imported on first use (same pattern as `whatsapp.js`) so a missing `GEMINI_API_KEY` doesn't crash the server. All calls share one `callGemini(parts, responseSchema, timeoutMs)` helper and a common field schema; entry points wrap it:

- `extractGrievanceFromImage(buffer, mimeType, categories)` — OCRs a photographed walk-in form; adds `ocr_confidence`.
- `extractGrievanceFromText(text, categories)` — triages a typed phone-call summary or WhatsApp message; adds `is_grievance` + `confidence` so non-grievances (greetings, spam) can be gated out of the register.
- `extractGrievanceFromAudio(buffer, mimeType, categories)` — transcribes dictated audio or a WhatsApp voice note (Telugu/English/mixed, original script) and extracts from the transcript; adds `transcript`, and runs on a 45s timeout instead of the 30s default.
- `suggestGrievanceResponse(grievance)` — on-demand, text-only draft of a citizen-facing reply plus an internal next-action note; advisory only, never wired into the save/commit path.
- `draftDepartmentLetter(grievance, departmentInfo, mpName)` — on-demand, text-only draft of a formal letter (`subject`/`body`) to a government department head for the grievance's category; advisory only, auto-saved on generation but never auto-printed/sent.

`POST /api/grievances/log` (the universal intake) calls `extractGrievanceFromImage`/`extractGrievanceFromAudio`/`extractGrievanceFromText` in whatever combination the submission includes, then merges the results into one record via `mergeGrievanceExtraction` in `server/index.js` (image OCR wins scalar identity/location fields; audio dictation wins the category/urgency judgement; `issue_description` is concatenated per-source, never chosen, so nothing is silently dropped).

Each extraction path constrains Gemini with a JSON `responseSchema` including a `category` enum built from `ISSUE_CATEGORIES` in `server/index.js` and an AI-judged `urgency`. The server then computes a deterministic `priority_score` from the category's fixed weight and the urgency, so triage ordering stays auditable. Source media is persisted to `VOLUME/grievance_media/` for later manual re-verification of low-confidence reads.

### Duplicate detection and MP escalation (`server/index.js`)

`findGrievanceDuplicates` runs on every `buildGrievanceRecord` call (walk-in/phone commit and WhatsApp inbox promote alike): an exact `normalizePhone` match auto-links both records' `linked_grievance_ids` bidirectionally; a Fuse.js match on `issue_description` or a matching name+village are returned as unlinked "possible" warnings for staff to check.

`generateBriefText` includes a "🚨 High-Priority Grievances" section for unresolved records that are `urgency: High` or `priority_score >= 80`, re-surfacing after 3 days if still unresolved. `escalated_at` is stamped only by an actual WhatsApp send (`sendWhatsAppBrief`), never by the preview/generate-only path.

## WhatsApp reset

If the session is broken, delete `data/wa_auth/` and restart the server to get a new QR code.
