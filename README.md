# Saathi v2 — Real Working Prototype

## What's inside
- **2000 real contacts** from your Excel file, scored and ranked
- **Team Dashboard** — full workbench with contacts, issues, coverage map
- **PA Schedule Upload** — add tomorrow's events, system shows nearby contacts automatically
- **News Desk** — journalist submits news, appears in brief immediately
- **WhatsApp Brief** — sends formatted brief to 9652345570 using Baileys

## How to run locally

```bash
node --version   # needs v18 or above
npm install
node scripts/setup_db.js    # import Excel → JSON database
node server/index.js        # start the server
```

Open http://localhost:3000

## WhatsApp Setup (first time)

1. Start the server: `node server/index.js`
2. A QR code will appear in the terminal
3. Open WhatsApp on your phone → Settings → Linked Devices → Link a Device
4. Scan the QR code
5. Once connected, the "Send Brief Now" button will send to 9652345570
6. Auth is saved — you only scan once per session

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
- WhatsApp status: `/api/wa-status`

## Files
```
saathi_v2/
├── server/
│   ├── index.js        # Express API server
│   └── whatsapp.js     # Baileys WhatsApp sender
├── public/
│   ├── index.html      # Team dashboard
│   └── news.html       # Journalist form
├── scripts/
│   └── setup_db.js     # Excel → JSON importer
├── data/
│   └── db.json         # Live database (JSON)
└── package.json
```
