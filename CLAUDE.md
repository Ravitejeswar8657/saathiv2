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
| GET | `/health` | Railway health check |

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Server listen port |
| `RAILWAY_VOLUME_MOUNT_PATH` | `./data` | Path for `db.json` and `wa_auth/` |
| `EXCEL_PATH` | `./combined_clean.xlsx` | Input file for `setup_db.js` |

## WhatsApp reset

If the session is broken, delete `data/wa_auth/` and restart the server to get a new QR code.
