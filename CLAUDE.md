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
- `setOnIncomingMessage(cb)` — registered by `index.js` to handle MP replies of the form `approve <ISS…>` or `reject <ISS…>`.

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
| `index.html` | Main team dashboard — contacts, schedule, brief, news |
| `news.html` | Journalist submission form |
| `pa_schedule.html` | PA schedule upload |
| `pa_issues.html` | Issue/grievance logging |
| `admin.html` | Pending approval confirmations |
| `heatmap.html` | Mandal-level coverage heatmap (Leaflet + OpenStreetMap, no API key) — contact density and average priority score per mandal, joined against `public/assets/mandal_coords.json` (generated once via `scripts/geocode_mandals.js`) |
| `journalist.html` | Alternate journalist form |
| `ttd_letters.html` | TTD reference letter register — calendar view, Aadhar duplicate check, Excel/PDF exports, per-letter PDF |
| `visitor_forms.html` | Visitor form register — office staff upload photographed paper visitor forms; Gemini AI OCR-extracts fields and assigns a category/urgency, staff review/correct in an editable preview before saving; category pills, calendar, status tracking, Excel/PDF exports |
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
| POST | `/api/issue` | Log issue against a contact |
| POST | `/api/issue/approve` | Admin approve/reject |
| GET | `/api/pending-approvals` | All pending issues |
| POST | `/api/news` | Submit news item (multipart, optional attachment) |
| POST | `/api/send-brief` | Trigger WhatsApp send |
| GET | `/api/generate-brief` | Regenerate brief text without sending |
| GET | `/api/brief-preview` | Last generated brief text |
| POST | `/api/send-approval-request` | Send approval request to MP via WhatsApp |
| GET | `/api/wa-responses` | Unconfirmed MP WhatsApp replies |
| POST | `/api/wa-response/confirm` | Admin confirms/overrides WA response |
| GET | `/api/wa-status` | WhatsApp connection state + QR data |
| GET | `/api/live-news` | Cached Google News RSS (Palanadu keywords) |
| GET | `/api/stats` | Aggregate counts |
| GET | `/api/ttd-letters` | List TTD reference letters (filterable by `from`/`to`) |
| GET | `/api/ttd-letters/check-duplicate` | Check for existing letters by Aadhar |
| POST | `/api/ttd-letters` | Create TTD reference letter |
| PATCH | `/api/ttd-letters/:id` | Edit TTD reference letter |
| DELETE | `/api/ttd-letters/:id` | Remove TTD reference letter |
| GET | `/api/ttd-letters/export.xlsx` | Export TTD letters as Excel |
| GET | `/api/ttd-letters/export-pdf` | Export TTD letters register as PDF |
| GET | `/api/ttd-letters/:id/letter-pdf` | Generate a single formal TTD letter PDF |
| GET | `/api/visitor-forms/categories` | List the visitor-form issue category taxonomy |
| POST | `/api/visitor-forms/upload` | Upload photographed form images (multipart, field `images`, up to 20); Gemini OCR-extracts + categorizes each, returns results for review — does not write to DB |
| POST | `/api/visitor-forms` | Commit the (staff-reviewed/edited) extracted items to the register |
| GET | `/api/visitor-forms` | List visitor forms (filterable by `from`/`to`/`category`/`status`) |
| PATCH | `/api/visitor-forms/:id` | Edit a visitor form record (partial update) |
| DELETE | `/api/visitor-forms/:id` | Remove a visitor form record (and its stored photo) |
| GET | `/api/visitor-forms/:id/image` | Retrieve the original uploaded photo for a record |
| GET | `/api/visitor-forms/export.xlsx` | Export visitor forms as Excel |
| GET | `/api/visitor-forms/export-pdf` | Export visitor forms register as PDF |
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
| `GEMINI_API_KEY` | (none) | Google Gemini API key for OCR + categorization of uploaded visitor form photos (`server/gemini.js`). If unset, the visitor-forms upload endpoint fails fast with a clear error rather than crashing — staff can still use the register manually. |

### Grievance extraction (`server/gemini.js`)

Lazy-imported on first use (same pattern as `whatsapp.js`) so a missing `GEMINI_API_KEY` doesn't crash the server. All calls share one `callGemini(parts, responseSchema, timeoutMs)` helper and a common field schema; three entry points wrap it:

- `extractGrievanceFromImage(buffer, mimeType, categories)` — OCRs a photographed walk-in form; adds `ocr_confidence`.
- `extractGrievanceFromText(text, categories)` — triages a typed phone-call summary or WhatsApp message; adds `is_grievance` + `confidence` so non-grievances (greetings, spam) can be gated out of the register.
- `extractGrievanceFromAudio(buffer, mimeType, categories)` — transcribes dictated audio or a WhatsApp voice note (Telugu/English/mixed, original script) and extracts from the transcript; adds `transcript`, and runs on a 45s timeout instead of the 30s default.

Each constrains Gemini with a JSON `responseSchema` including a `category` enum built from `ISSUE_CATEGORIES` in `server/index.js` and an AI-judged `urgency`. The server then computes a deterministic `priority_score` from the category's fixed weight and the urgency, so triage ordering stays auditable. Source media is persisted to `VOLUME/grievance_media/` for later manual re-verification of low-confidence reads.

## WhatsApp reset

If the session is broken, delete `data/wa_auth/` and restart the server to get a new QR code.
