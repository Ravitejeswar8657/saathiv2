# Saathi v2 — Real Working Prototype

## What's inside
- **Real contacts** from your Excel file, scored and ranked
- **Team Dashboard** — full workbench with contacts, issues, coverage map
- **PA Schedule Upload** — add tomorrow's events, system shows nearby contacts automatically
- **News Desk** — journalist submits news, appears in brief immediately
- **Daily Brief PDF** — generated on demand from schedule/news/grievance data (`/api/brief-pdf`)

There is no WhatsApp integration in this project — see `CLAUDE.md` for the current architecture.

## How to run locally

```bash
node --version   # needs v18 or above
npm install
node scripts/setup_db.js    # import Excel → JSON database
node server/index.js        # start the server
```

Open http://localhost:3000

## Deploy to Railway (recommended - free)

1. Go to railway.app → New Project → Deploy from GitHub
2. Or: `npm install -g @railway/cli && railway login && railway up`
3. Railway auto-detects Node.js and starts `node server/index.js`
4. Set environment variable: `PORT=3000`

## Deploy to Render (free tier)

1. Push this folder to GitHub
2. New Web Service → connect repo
3. Build command: `npm install`
4. Start command: `node server/index.js`

## Journalist form
Share the link: `https://your-domain/news`
No login needed. They fill the form, it appears in the MP's brief immediately.

## URLs
- Dashboard: `/`
- Journalist form: `/news`
- API: `/api/dashboard`, `/api/contacts`, `/api/stats`

## Files
```
saathi_v2/
├── server/
│   └── index.js        # Express API server
├── public/
│   ├── index.html      # Team dashboard
│   └── news.html       # Journalist form
├── scripts/
│   └── setup_db.js     # Excel → JSON importer
├── data/
│   └── db.json         # Live database (JSON)
└── package.json
```
