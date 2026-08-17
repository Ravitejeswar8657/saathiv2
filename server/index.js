// server/index.js
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, URL as NodeURL } from 'url';
import { createRequire } from 'module';
import Fuse from 'fuse.js';
import PDFDocument from 'pdfkit';
import XLSX from 'xlsx';
import { search as searchService, status as searchStatus, searchAll } from './search.js';

// ── Persistence ────────────────────────────────────────────────────────────
// Every SQL statement in this app lives behind one of these modules. No route
// handler opens a connection or writes a query; see server/db/connection.js.
import { migrate } from './db/migrate.js';
import { getDb, SQLITE_PATH } from './db/connection.js';
import { ulid } from './db/ids.js';
import { seedReference, canonicalMandal, listMandals } from './db/reference.js';
import * as rawEvents from './db/raw_events.js';
import { getSetting, setSetting, allSettings, logTimeline, rebuildFts } from './db/records.js';
import {
  getConversation, listConversations, listMessages, resolveConversation,
  createConversation, updateConversation, deleteConversation, restoreConversation,
  listTrash, purgeExpiredTrash, appendMessage, titleIfUntitled,
} from './db/conversations.js';
import { buildContext, FALLBACK_REPLY } from './chat.js';
import {
  listContacts, getContact, countContacts, findNearby, distinctValues,
  upsertContact, updateContact, replaceAllContacts,
} from './db/contacts.js';
import {
  listGrievances, getGrievance, insertGrievance, updateGrievance,
  softDeleteGrievance, replaceAllGrievances, linkDuplicates, linkTtdLetter,
  countOpenGrievances, countFeedback, findByPhone,
} from './db/grievances.js';
import {
  listEvents, getEvent, insertEvent, updateEvent, softDeleteEvent,
  replaceAllEvents, setEventContactBrief, countUpcomingEvents,
} from './db/events.js';
import {
  listNews, getNewsItem, insertNews, updateNews, softDeleteNews, replaceAllNews, countNews,
} from './db/news.js';
import { CATEGORY_ORDER, normalizeCategory, newsCategory } from './news-categories.js';
import {
  listReports, getReport, insertReport, updateReport, softDeleteReport, replaceAllReports,
  REPORT_TAXONOMY,
} from './db/campaign_reports.js';
import {
  listPosts, getPost, insertPost, updatePost, softDeletePost, replaceAllPosts, countPostsBetween,
} from './db/social_posts.js';
import {
  listLetters, getLetter, insertLetter, updateLetter, softDeleteLetter,
  replaceAllLetters, findByAadhar, normalizeAadhar as normalizeAadharDb,
} from './db/ttd_letters.js';

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ── Railway persistent volume awareness ────────────────────────────────────
// On Railway: mount a volume at /data, set RAILWAY_VOLUME_MOUNT_PATH=/data
// Locally: just uses ./data/
const RAILWAY_VOLUME = '/data';
const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH
  || (fs.existsSync(RAILWAY_VOLUME) ? RAILWAY_VOLUME : null)
  || path.join(ROOT, 'data');
const DB_PATH = path.join(VOLUME, 'db.json');
const GRIEVANCE_MEDIA_PATH = path.join(VOLUME, 'grievance_media');
const SOCIAL_MEDIA_PATH = path.join(VOLUME, 'social_calendar_media');
const CAMPAIGN_MEDIA_PATH = path.join(VOLUME, 'campaign_media');
const EVENT_MEDIA_PATH = path.join(VOLUME, 'event_media');
const BASE_URL = process.env.BASE_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 'http://localhost:3000');
const TELUGU_FONT_PATH = path.join(ROOT, 'public', 'fonts', 'NotoSansTelugu.ttf');

// Ensure dirs exist
fs.mkdirSync(VOLUME, { recursive: true });
fs.mkdirSync(GRIEVANCE_MEDIA_PATH, { recursive: true });
fs.mkdirSync(SOCIAL_MEDIA_PATH, { recursive: true });
fs.mkdirSync(CAMPAIGN_MEDIA_PATH, { recursive: true });
fs.mkdirSync(EVENT_MEDIA_PATH, { recursive: true });

// Sweep pending recordings abandoned mid-review (browser closed before the preview
// was saved or discarded). Anything still named tmp_* after a day is orphaned.
function sweepPendingMedia(dir) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith('tmp_')) continue;
      const p = path.join(dir, name);
      if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
    }
  } catch (e) {
    console.error('Pending media sweep skipped:', e.message);
  }
}
sweepPendingMedia(GRIEVANCE_MEDIA_PATH);
sweepPendingMedia(CAMPAIGN_MEDIA_PATH);

// ── Schema ─────────────────────────────────────────────────────────────────
// Migrations run at boot, before the first request. They are numbered, checksummed
// and applied inside a transaction with their ledger row (server/db/migrate.js), so
// this is safe to run on every start: a fully-migrated database is a no-op.
//
// This replaces the boot-time `migratePensionWelfareCategory()` IIFE, which read,
// rewrote and re-saved the entire 3 MB JSON file on every single start inside a
// try/catch that swallowed the failure. Its work now lives in 004_data_fixups.sql,
// where it runs once and is recorded as having run.
const migrationsApplied = migrate({ log: line => console.log(line) }).current;

// First boot on a volume that only has db.json: import it. The backfill is
// idempotent and asserts its own row counts, and it never modifies db.json, so
// there is always a way back until Phase F deletes it.
if (countContacts() === 0) {
  const seedJson = fs.existsSync(DB_PATH) ? DB_PATH
    : (fs.existsSync(path.join(ROOT, 'data', 'db.json')) ? path.join(ROOT, 'data', 'db.json') : null);
  if (seedJson) {
    console.log('Empty database — importing from', seedJson);
    seedReference();
    const json = JSON.parse(fs.readFileSync(seedJson, 'utf8'));
    replaceAllContacts(json.contacts || []);
    replaceAllGrievances(json.grievances || []);
    replaceAllLetters(json.ttd_letters || []);
    replaceAllEvents(json.schedule || []);
    replaceAllNews(json.news || []);
    replaceAllReports(json.campaign_reports || []);
    replaceAllPosts(json.social_posts || []);
    console.log(`✓ Imported ${countContacts()} contacts`);
  }
}
// Reference data is cheap and idempotent; re-seeding every boot means a newly
// added mandal alias ships with a deploy rather than needing a manual script.
seedReference();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(ROOT, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
// Separate instance for grievance media — walk-in form photos run larger than the 10MB
// cap above (a day's forms are uploaded together, up to 20 files at once), and dictated
// audio is bulkier still.
const uploadGrievanceMedia = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 20 } });
// Universal "Log Grievance" intake — one grievance's own attachments (not a batch of
// different forms like /upload), so a smaller cap than the bulk uploader's 20.
const logGrievanceMedia = uploadGrievanceMedia.fields([
  { name: 'images', maxCount: 10 },
  { name: 'audio', maxCount: 1 },
]);
// Social media calendar posts can include video, which runs much larger than photos.
const uploadSocialMedia = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024, files: 10 } });
// Post-event coverage attached from the schedule page's event modal — photos and
// clips from the ground, so the same generous cap as the social calendar.
const uploadEventMedia = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024, files: 10 } });
// Universal "Log Political Report" intake — one report's own attachments (photos/PDF + audio).
const uploadCampaignReportMedia = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 11 } });
const logCampaignReportMedia = uploadCampaignReportMedia.fields([
  { name: 'images', maxCount: 10 },
  { name: 'audio', maxCount: 1 },
]);

// ── DB helpers ─────────────────────────────────────────────────────────────
// `readDB()` used to parse the whole 3 MB db.json on every one of ~70 routes.
// It now returns a lazy VIEW over SQLite with the same key names, so every
// existing read site works unchanged while the storage underneath is a real
// database. Each collection is loaded on first access and memoized for the life
// of the call, which reproduces the old semantics exactly: one snapshot per
// request.
//
// There is deliberately no `writeDB`. Writes go through the repositories in
// server/db/, which is what makes "the schema is owned by one module" enforceable
// rather than aspirational. The properties below are getters with no setters, so
// a leftover `db.grievances = [...]` throws a TypeError in module scope instead of
// silently doing nothing — every write site had to be converted, and this is what
// guaranteed none was missed.
function readDB() {
  const cache = {};
  const lazy = load => ({
    enumerable: true,
    get() {
      if (!(load.name in cache)) cache[load.name] = load();
      return cache[load.name];
    },
  });
  return Object.defineProperties({}, {
    contacts:         lazy(function contacts() { return listContacts(); }),
    grievances:       lazy(function grievances() { return listGrievances(); }),
    schedule:         lazy(function schedule() { return listEvents(); }),
    news:             lazy(function news() { return listNews(); }),
    campaign_reports: lazy(function campaign_reports() { return listReports(); }),
    social_posts:     lazy(function social_posts() { return listPosts(); }),
    ttd_letters:      lazy(function ttd_letters() { return listLetters(); }),
    // Derived rather than stored. db.json kept `coverage` as a precomputed 26-row
    // rollup that went stale the moment a contact was added, and `metadata`
    // cached a contact count beside the contacts themselves.
    coverage:         lazy(function coverage() { return coverageRollup(); }),
    metadata:         lazy(function metadata() {
      return { total_contacts: countContacts(), constituency: 'Palnadu' };
    }),
  });
}

// The mandal rollup db.json stored as a frozen array. Computed from the contacts
// themselves so it cannot disagree with them.
function coverageRollup() {
  return getDb().prepare(`
    SELECT mandal, constituency, COUNT(*) contacts,
           CAST(AVG(days_since_contact) AS INTEGER) last_touch_days
      FROM contacts
     WHERE deleted_at IS NULL AND mandal <> ''
     GROUP BY mandal, constituency
     ORDER BY contacts DESC`).all()
    .map(r => ({ ...r, health: r.last_touch_days <= 30 ? 'good' : r.last_touch_days <= 90 ? 'fair' : 'poor' }));
}

// ── IST date helper ─────────────────────────────────────────────────────────
function getISTDateStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD
}

// ── Time helpers ────────────────────────────────────────────────────────────
function parseTimeToMinutes(t) {
  if (!t) return 9999;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
}
function formatTime12h(t) {
  if (!t) return '';
  const [hStr, mStr] = t.split(':');
  let h = parseInt(hStr, 10);
  const m = mStr || '00';
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

// ── News cache ──────────────────────────────────────────────────────────────
// Two sources, fetched in parallel and merged:
//  1. Real AP-newspaper section feeds (AP_PUBLISHER_FEEDS) — actual publisher RSS, not Google's
//     JS-obfuscated redirect links, so the URLs really open the article. Verified live by hand
//     (curl) before shipping: The Hindu's AP and Vijayawada section feeds and Sakshi's AP feed
//     all return real <item> XML. Eenadu (410 Gone) and Andhra Jyothy (404) have no working RSS
//     at all — don't add them. There is no true Guntur/Palnadu *district-edition* feed for any
//     major AP paper; Vijayawada (the nearest city hub) is the closest real "local" proxy.
//  2. A couple of broad Google News queries (English + Telugu) as a supplement — lower-quality
//     links, but they catch stories the three curated feeds miss.
// "Local relevance" is done by substring-tagging titles against the constituency's mandal names,
// not by firing a separate weak query per mandal (which is what made the old approach noisy).
let newsCache = { data: null, fetchedAt: 0 };
const NEWS_CACHE_MS = 15 * 60 * 1000; // 15 minutes
const linkResolveCache = new Map(); // google redirect link -> resolved publisher URL

const TELUGU_PLACE_TERMS = 'పల్నాడు OR నరసరావుపేట OR సత్తెనపల్లి OR మాచర్ల OR గురజాల';

const PALNADU_MANDALS = [
  'Amaravathi', 'Atchampet', 'Bellamkonda', 'Krosuru', 'Muppalla', 'Nekarikallu', 'Pedakurapadu',
  'Rajupalem', 'Sattenapalli', 'Bollapalle', 'Chilakaluripet', 'Edlapadu', 'Ipuru', 'Nadendla',
  'Narasaraopet', 'Nuzendla', 'Rompicherla', 'Savalyapuram', 'Vinukonda', 'Dachepalle', 'Durgi',
  'Gurazala', 'Karempudi', 'Machavaram', 'Macherla', 'Piduguralla', 'Rentachintala', 'Veldurthi',
];

const AP_PUBLISHER_FEEDS = [
  { url: 'https://www.thehindu.com/news/national/andhra-pradesh/feeder/default.rss', source: 'The Hindu · AP', lang: 'en' },
  { url: 'https://www.thehindu.com/news/cities/Vijayawada/feeder/default.rss', source: 'The Hindu · Vijayawada', lang: 'en' },
  { url: 'https://www.sakshi.com/rss/andhra-pradesh.xml', source: 'Sakshi · AP', lang: 'te' },
  { url: 'https://timesofindia.indiatimes.com/rssfeeds/3947067.cms', source: 'TOI · Andhra Pradesh', lang: 'en' },
  { url: 'https://www.ndtv.com/feeds/andhra-pradesh', source: 'NDTV · AP', lang: 'en' },
];

function stripHtml(s) {
  return (s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function tagMandal(title) {
  const lower = (title || '').toLowerCase();
  return PALNADU_MANDALS.find(m => lower.includes(m.toLowerCase())) || '';
}

function parseRssItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = block.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1')?.trim() || '';
    const link = block.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1')?.trim() || '';
    const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() || '';
    const source = block.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1')?.trim() || '';
    items.push({ title, link, pubDate, source });
  }
  return items;
}

async function fetchOneGoogleQuery({ q, hl, gl, ceid, lang }) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const xml = await resp.text();
  // Note: Google News RSS <description> is just "<a href=link>TITLE</a> SOURCE" — no real
  // snippet text, so we don't bother parsing it. Real detail comes from on-demand full-article
  // extraction (see /api/live-news/extract) rather than batch-scraping every refresh.
  return parseRssItems(xml).map(it => ({ ...it, mandal_tag: tagMandal(it.title), lang }));
}

async function fetchOnePublisherFeed({ url, source, lang }) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`${url} returned HTTP ${resp.status}`);
  const xml = await resp.text();
  return parseRssItems(xml).map(it => ({
    title: it.title, link: it.link, pubDate: it.pubDate,
    source: it.source || source, mandal_tag: tagMandal(it.title), lang, is_publisher_feed: true,
  }));
}

// Note: Google News' <link> is a JS/RPC-obfuscated interstitial, not a real HTTP redirect —
// following it server-side just returns Google's own page, not the publisher URL (verified by
// hand: no 3xx, the real article URL isn't present anywhere in the HTML, just an encoded blob
// Google decodes client-side). So this only helps for sources that *do* use real redirects or
// already give us a direct link (e.g. the uploaded News Brief PDF, or the AP_PUBLISHER_FEEDS
// above, which already give real article links and don't need resolving). For Google News items
// the original link is still the right thing to show — it works fine when a human opens it in a
// browser, which is the only place that JS redirect can run.
async function resolveNewsLink(link) {
  if (!link) return link;
  if (linkResolveCache.has(link)) return linkResolveCache.get(link);
  try {
    const resp = await fetch(link, { redirect: 'follow', signal: AbortSignal.timeout(3000) });
    const resolved = (resp.url && resp.url !== link && !resp.url.includes('news.google.com')) ? resp.url : link;
    linkResolveCache.set(link, resolved);
    return resolved;
  } catch {
    linkResolveCache.set(link, link);
    return link;
  }
}

async function fetchGoogleNews() {
  const now = Date.now();
  if (newsCache.data && (now - newsCache.fetchedAt) < NEWS_CACHE_MS) {
    return newsCache.data;
  }

  const googleQueries = [
    { q: 'Palnadu OR Narasaraopet', hl: 'en-IN', gl: 'IN', ceid: 'IN:en', lang: 'en' },
    { q: 'Andhra Pradesh News OR Guntur News', hl: 'en-IN', gl: 'IN', ceid: 'IN:en', lang: 'en' },
    { q: TELUGU_PLACE_TERMS, hl: 'te', gl: 'IN', ceid: 'IN:te', lang: 'te' },
  ];

  const [googleResults, publisherResults] = await Promise.all([
    Promise.allSettled(googleQueries.map(fetchOneGoogleQuery)),
    Promise.allSettled(AP_PUBLISHER_FEEDS.map(fetchOnePublisherFeed)),
  ]);
  publisherResults.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.log(`News feed unavailable, skipping: ${AP_PUBLISHER_FEEDS[i].source} — ${r.reason?.message}`);
    }
  });
  // Publisher feeds first so that when the same story appears in both, the dedupe below keeps
  // the curated publisher's own link rather than Google's redirect-only copy.
  const all = [...publisherResults, ...googleResults].flatMap(r => r.status === 'fulfilled' ? r.value : []);

  // Dedupe across sources by normalized title; keep the mandal tag if any copy had one.
  const seen = new Map();
  all.forEach(item => {
    const key = item.title.toLowerCase().replace(/[^a-z0-9అ-౿]/gi, '').slice(0, 80);
    if (!key) return;
    if (!seen.has(key)) seen.set(key, item);
    else if (!seen.get(key).mandal_tag && item.mandal_tag) seen.get(key).mandal_tag = item.mandal_tag;
  });

  // Reserve quotas so the curated, verified sources can't be drowned out by Google's much larger
  // result volume: mandal-relevant items first, then the curated AP publisher feeds, then
  // whatever's left from the broader Google query fills the remaining cap.
  const byRecency = (a, b) => new Date(b.pubDate) - new Date(a.pubDate);
  const deduped = [...seen.values()];
  const mandalItems = deduped.filter(i => i.mandal_tag).sort(byRecency);
  const mandalKeys = new Set(mandalItems);
  const publisherItems = deduped.filter(i => !mandalKeys.has(i) && i.is_publisher_feed).sort(byRecency);
  const publisherKeys = new Set(publisherItems);
  const googleItems = deduped.filter(i => !mandalKeys.has(i) && !publisherKeys.has(i)).sort(byRecency);
  const MANDAL_QUOTA = 12, PUBLISHER_QUOTA = 18;
  const items = [
    ...mandalItems.slice(0, MANDAL_QUOTA),
    ...publisherItems.slice(0, PUBLISHER_QUOTA),
    ...googleItems,
  ].slice(0, 40);

  newsCache = { data: items, fetchedAt: now };
  return items;
}


// ── ROUTES ──────────────────────────────────────────────────────────────────

app.get('/api/dashboard', (req, res) => {
  const db = readDB();
  res.json({
    metadata: { ...db.metadata, ...allSettings() },
    all_contacts: db.contacts,
    // `issue_radar` was an empty array in db.json that nothing ever wrote to.
    // Kept as a key so the dashboard's destructuring is unchanged.
    issue_radar: [],
    coverage: db.coverage,
    news: (db.news || []).slice(0, 20),
    schedule: db.schedule || [],
  });
});

app.patch('/api/metadata', (req, res) => {
  const { mp_name } = req.body;
  if (mp_name !== undefined) setSetting('mp_name', mp_name);
  res.json({ ok: true, metadata: { ...readDB().metadata, ...allSettings() } });
});

app.get('/api/contacts', (req, res) => {
  const db = readDB();
  let contacts = db.contacts;
  const { q, tier, party, mandal, constituency, village, role } = req.query;
  if (q) {
    const fuse = new Fuse(contacts, {
      keys: ['name', 'village', 'mandal', 'constituency', 'role', 'caste', 'open_grievance'],
      threshold: 0.35,
    });
    contacts = fuse.search(q).map(r => r.item);
  }
  if (tier) contacts = contacts.filter(c => c.tier === tier);
  if (party) contacts = contacts.filter(c => c.party === party);
  if (mandal) contacts = contacts.filter(c =>
    c.mandal.toLowerCase() === mandal.toLowerCase());
  if (constituency) contacts = contacts.filter(c =>
    c.constituency.toLowerCase() === constituency.toLowerCase());
  if (village) contacts = contacts.filter(c =>
    c.village.toLowerCase() === village.toLowerCase());
  if (role) contacts = contacts.filter(c => c.role === role);
  const limit = Math.min(parseInt(req.query.limit) || 200, 10000);
  res.json({ contacts: contacts.slice(0, limit), total: contacts.length });
});

// ── Cross-collection search (contacts/grievances/schedule/news/campaign_reports/
// social_posts) — powers both the admin.html search box and the chat assistant's
// grounding step. Fuse.js only; no SQL/vector DB in this app.
// ── Search ─────────────────────────────────────────────────────────────────
// Hybrid retrieval over the app's own records: SQLite FTS5 (BM25) and Fuse.js
// fuzzy matching, fanned out concurrently, fused with reciprocal rank fusion, then
// widened by a bounded one-hop expansion over the entity graph. See server/search.js.

// The full contract. `filters.sources` narrows to named collections.
app.post('/api/search', (req, res) => {
  const { query, k, filters } = req.body || {};
  res.json(searchService(query, { k: Math.min(parseInt(k) || 10, 100), filters: filters || {} }));
});

// The flat-list form the current widget calls. Kept so the page keeps working
// while it moves to POST; the ranking underneath is the new pipeline either way.
app.get('/api/search', (req, res) => {
  const { q, limit } = req.query;
  if (!q) return res.json({ results: [] });
  const { results, degraded, sources } = searchService(q, {
    k: Math.min(parseInt(limit) || 30, 100),
  });
  res.json({ results, degraded, sources });
});

// Exists because "search isn't answering" has several very different causes and
// an operator cannot act until they know which one it is.
app.get('/api/search/status', (req, res) => {
  res.json(searchStatus());
});

// Rebuild the FTS index from `records`. External-content FTS5 keeps no copy of
// the text, so this re-derives every entry — the repair path for an index
// restored from a backup taken mid-write.
app.post('/api/search/reindex', (req, res) => {
  res.json({ ok: true, records: rebuildFts() });
});

app.get('/api/filter-options', (req, res) => {
  const contacts = readDB().contacts;
  const mandals = [...new Set(contacts.map(c => c.mandal).filter(Boolean))].sort();
  const constituencies = [...new Set(contacts.map(c => c.constituency).filter(Boolean))].sort();
  const parties = [...new Set(contacts.map(c => c.party).filter(Boolean))].sort();
  const roles = [...new Set(contacts.map(c => c.role).filter(Boolean))].sort();
  // map: constituency → sorted list of mandals that have contacts there
  const mandalsByConstituency = {};
  contacts.forEach(c => {
    if (!c.constituency || !c.mandal) return;
    if (!mandalsByConstituency[c.constituency]) mandalsByConstituency[c.constituency] = new Set();
    mandalsByConstituency[c.constituency].add(c.mandal);
  });
  Object.keys(mandalsByConstituency).forEach(k => {
    mandalsByConstituency[k] = [...mandalsByConstituency[k]].sort();
  });
  const villagesByMandal = {};
  contacts.forEach(c => {
    if (!c.mandal || !c.village) return;
    if (!villagesByMandal[c.mandal]) villagesByMandal[c.mandal] = new Set();
    villagesByMandal[c.mandal].add(c.village);
  });
  Object.keys(villagesByMandal).forEach(k => {
    villagesByMandal[k] = [...villagesByMandal[k]].sort();
  });
  res.json({ mandals, constituencies, parties, roles, mandalsByConstituency, villagesByMandal });
});

app.get('/api/contact/:id', (req, res) => {
  const c = getContact(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(c);
});

app.post('/api/log-interaction', (req, res) => {
  const { contact_id, type } = req.body;
  const contact = getContact(contact_id);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  updateContact(contact_id, {
    days_since_contact: 0,
    pps_score: Math.max((contact.pps_score || 50) - 15, 10),
    last_log: { type, at: new Date().toISOString() },
  });
  res.json({ ok: true });
});

// Audience/community cohorts a schedule event can be tagged with — independent of
// event_type (which describes the event's nature, e.g. Public Meeting vs. Condolence
// Visit, and drives the speech-point templates below). Optional: most events won't
// target a specific cohort. Derived from the Strategic Cohorts doc; "Forward Castes
// (OC)" is intentionally omitted (not tracked as a caste-named group), and Vaishyas
// are folded into "Business & Commerce" rather than named by caste.
const COHORTS = [
  { key: 'political_fronts',    label: 'Mainstream Political Fronts',            group: 'Political Ecosystem' },
  { key: 'muslim_minority',     label: 'Muslim Minority',                        group: 'Communities — Religion' },
  { key: 'christian_community', label: 'Christian Community',                    group: 'Communities — Religion' },
  { key: 'sc',                  label: 'Scheduled Castes (SC)',                  group: 'Communities — Caste' },
  { key: 'bc',                  label: 'Backward Castes (BC)',                   group: 'Communities — Caste' },
  { key: 'st',                  label: 'Scheduled Tribes (ST)',                  group: 'Communities — Caste' },
  { key: 'youth_students',      label: 'Young Voters & Student Activists',       group: 'Demographics' },
  { key: 'women_shg',           label: 'Women — Self-Help Groups & Business Owners', group: 'Demographics' },
  { key: 'general_demographics',label: 'Special Interest & Focus Groups',        group: 'Demographics' },
  { key: 'labour_workforce',    label: 'Labour & Workforce (Unorganized Sector & Unions)', group: 'Working Groups' },
  { key: 'business_commerce',   label: 'Business & Commerce',                    group: 'Working Groups' },
  { key: 'government_sector',   label: 'Government Sector (Public Admin & Frontline Workers)', group: 'Working Groups' },
  { key: 'education_sector',    label: 'Education Sector',                       group: 'Working Groups' },
  { key: 'professionals',       label: 'Professionals',                          group: 'Working Groups' },
  { key: 'local_influencers',   label: 'Local Business Owners & Hubs',           group: 'Other Local Influencers' },
  { key: 'civic_social',        label: 'Civic & Social Networks',                group: 'Community Engagement' },
];
const COHORT_KEYS = new Set(COHORTS.map(c => c.key));

app.get('/api/schedule/cohorts', (req, res) => {
  res.json({ cohorts: COHORTS });
});

app.post('/api/schedule', (req, res) => {
  const { event_name, date, time, address, village, mandal, description, event_type, audience_cohort } = req.body;
  if (!mandal || !event_name || !date)
    return res.status(400).json({ error: 'event_name, date and mandal required' });
  const db = readDB();
  const byPPS = (a, b) => b.pps_score - a.pps_score;
  const mandalKey = mandal.toLowerCase();
  const villageKey = village?.toLowerCase();
  // When a village is selected, village contacts come first so different
  // villages within the same mandal produce meaningfully different lists.
  let nearby;
  if (villageKey) {
    const villageContacts = db.contacts
      .filter(c => c.village?.toLowerCase() === villageKey)
      .sort(byPPS);
    const villageIds = new Set(villageContacts.map(c => c.id));
    const mandalRest = db.contacts
      .filter(c => c.mandal?.toLowerCase() === mandalKey && !villageIds.has(c.id))
      .sort(byPPS);
    nearby = [...villageContacts, ...mandalRest].slice(0, 20);
  } else {
    nearby = db.contacts
      .filter(c => c.mandal?.toLowerCase() === mandalKey)
      .sort(byPPS)
      .slice(0, 20);
  }

  // The contact list is stored as a join, not as embedded copies. Everything the
  // old `nearby_contacts` objects carried (name, phone, role, tier, pps_score) is
  // read back live from `contacts`, so a contact who moves village or changes
  // tier is no longer wrong on every event already scheduled. Only the
  // occasion-specific, PA-written brief lives on the join row.
  const event = insertEvent({
    event_name, date, time: time || '',
    address: address || '', village: village || '',
    mandal, description: description || '',
    event_type: event_type || '',
    audience_cohort: COHORT_KEYS.has(audience_cohort) ? audience_cohort : '',
  }, { contactIds: nearby.map(c => c.id) });

  res.json({ ok: true, event_id: event.id, nearby_count: event.nearby_count, nearby_contacts: event.nearby_contacts });
});

app.get('/api/schedule', (req, res) => {
  res.json({ schedule: readDB().schedule || [] });
});

app.delete('/api/schedule/:id', (req, res) => {
  for (const filePath of softDeleteEvent(req.params.id)) {
    const p = path.join(EVENT_MEDIA_PATH, path.basename(filePath));
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  res.json({ ok: true });
});

// ── Post-event coverage ───────────────────────────────────────────────────────
// What came of an event, recorded after the fact from the event modal on
// index.html / pa_schedule.html: press and media links, photos from the ground,
// whether social went out, and a note on how it went.
//
// Deliberately not part of POST /api/schedule — none of this exists at the
// moment an event is booked, so the create form stays a plain JSON post.

const COVERAGE_LINK_LIMIT = 20;

/**
 * Link rows arrive as a JSON string because the request is multipart — files
 * ride along in the same submit.
 *
 * Malformed input is an error rather than an empty list on purpose: a staffer
 * whose links silently vanished on save has no way to tell that from a link
 * they forgot to type.
 */
function parseCoverageLinks(raw, field) {
  if (raw === undefined) return { links: undefined };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: `${field} must be valid JSON` };
  }
  if (!Array.isArray(parsed)) return { error: `${field} must be an array` };
  if (parsed.length > COVERAGE_LINK_LIMIT) {
    return { error: `At most ${COVERAGE_LINK_LIMIT} links` };
  }
  const links = [];
  for (const item of parsed) {
    const url = String(item?.url ?? '').trim();
    if (!url) continue; // a row the staffer added and left blank
    if (!/^https?:\/\//i.test(url)) return { error: `Not a valid link: ${url}` };
    links.push({ url, label: String(item?.label ?? '').trim() });
  }
  return { links };
}

app.patch('/api/schedule/:id', uploadEventMedia.array('media', 10), (req, res) => {
  const event = getEvent(req.params.id);
  // DELETE above is deliberately lenient; this is not. An edit that lands
  // nowhere has to be visible, or staff keep re-entering the same coverage.
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const mediaLinks = parseCoverageLinks(req.body.media_links, 'media_links');
  if (mediaLinks.error) return res.status(400).json({ error: mediaLinks.error });
  const socialLinks = parseCoverageLinks(req.body.social_links, 'social_links');
  if (socialLinks.error) return res.status(400).json({ error: socialLinks.error });

  const patch = {};
  if (mediaLinks.links !== undefined) patch.media_links = mediaLinks.links;
  if (req.body.coverage_notes !== undefined) patch.coverage_notes = req.body.coverage_notes;

  if (req.body.social_posted !== undefined) {
    const posted = req.body.social_posted === 'true' || req.body.social_posted === '1';
    patch.social_posted = posted;
    // The answer and its evidence are one statement: answering "no" clears the
    // links, so a stale list cannot resurface if it is ever flipped back to yes.
    patch.social_links = posted ? (socialLinks.links ?? event.social_links) : [];
  } else if (socialLinks.links !== undefined) {
    patch.social_links = socialLinks.links;
  }

  // replaceMedia is wholesale, so the full desired list is assembled here: what
  // is already attached, minus what the modal staged for removal, plus the new
  // uploads. Touched only when the request actually says something about media.
  let removed = [];
  if (req.body.remove_media !== undefined || req.files?.length) {
    let removeList;
    try {
      removeList = req.body.remove_media ? JSON.parse(req.body.remove_media) : [];
    } catch {
      return res.status(400).json({ error: 'remove_media must be valid JSON' });
    }
    if (!Array.isArray(removeList)) return res.status(400).json({ error: 'remove_media must be an array' });
    const drop = new Set(removeList.map(f => path.basename(String(f))));

    const existing = event.media || [];
    const kept = existing.filter(m => !drop.has(path.basename(m.filename)));
    removed = existing.filter(m => drop.has(path.basename(m.filename)));

    const added = [];
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      // Same allowlist as the social calendar — an event's coverage is the same
      // photos, clips and PDFs, so there is nothing to diverge on.
      const info = SOCIAL_MEDIA_MIMES[file.mimetype];
      if (!info) return res.status(400).json({ error: `Unsupported file type: ${file.mimetype}` });
      // The timestamp is load-bearing: an event can be added to more than once,
      // and `${id}_${i}` alone would overwrite the first upload on the second.
      const filename = `${event.id}_${Date.now()}_${i}.${info.ext}`;
      fs.writeFileSync(path.join(EVENT_MEDIA_PATH, filename), file.buffer);
      added.push({ filename, mime: file.mimetype, type: info.type, label: '' });
    }
    patch.media = [...kept, ...added];
  }

  const saved = updateEvent(event.id, patch);

  // Unlink only once the write has committed, so a failed update never leaves
  // the record pointing at files that are already gone.
  for (const m of removed) {
    const p = path.join(EVENT_MEDIA_PATH, path.basename(m.filename));
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  res.json({ ok: true, event: saved });
});

app.get('/api/schedule/media/:filename', (req, res) => {
  const safeName = path.basename(req.params.filename);
  const p = path.join(EVENT_MEDIA_PATH, safeName);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'File not found' });
  res.sendFile(p);
});

// ── Event prep — draft suggestions the PA reviews/edits, never the final answer ────────────
// Event types where the MP actually addresses a room — a speech-points step makes sense.
// Grievance Camp (listening, not speaking), Condolence Visit (template itself says "not a
// campaign moment"), Festival ("not a policy speech"), and Other/unset default to skipped —
// the PA can always force the step open if they want it anyway.
const SPEECH_EVENT_TYPES = new Set(['Public Meeting', 'Inauguration', 'Party Cadre Meeting']);
function isSpeechApplicable(eventType) {
  return SPEECH_EVENT_TYPES.has(eventType);
}

// Speech-point starter drafts, keyed by event type. Placeholders are filled from real event/
// contact data in buildSpeechDraft(). These are seeds for an editable textarea, not output.
const SPEECH_TEMPLATES = {
  'Public Meeting': [
    'Greet {village} and acknowledge {top_contact} and other local leaders by name.',
    'Reaffirm the development commitments for {mandal}.',
    '{grievance_line}',
    'Reference today\'s local news to show you are tracking ground realities.',
    'Close with a direct appeal to the youth and first-time voters.',
  ],
  'Grievance Camp': [
    'Acknowledge the specific issues raised by {village} residents.',
    '{grievance_line}',
    'Commit to a concrete follow-up timeline, not just acknowledgement.',
    'Thank {top_contact} and the local team for coordinating the camp.',
  ],
  'Inauguration': [
    'Thank the contractors, officials and {top_contact} for the work completed.',
    'Connect this project to the broader development plan for {mandal}.',
    'Invite local youth for a photo at the new facility.',
  ],
  'Condolence Visit': [
    'Keep remarks brief, personal and respectful — this is not a campaign moment.',
    'Acknowledge the family\'s standing in {village} and offer concrete support if appropriate.',
    'Avoid party/political references entirely.',
  ],
  'Party Cadre Meeting': [
    'Thank the cadre for their ground work in {mandal}.',
    'Set clear expectations for the next phase.',
    '{grievance_line}',
    'Recognize {top_contact} and other senior workers by name.',
  ],
  'Festival': [
    'Open with festival greetings in Telugu.',
    'Keep it warm and informal — this is a goodwill visit, not a policy speech.',
    'Spend extra time with youngsters and families for photos.',
  ],
  'Other': [
    'Greet {village} and acknowledge {top_contact} and the local team.',
    '{grievance_line}',
    'Close with a clear, specific commitment.',
  ],
};

function buildSpeechDraft(eventType, event, contactsForEvent) {
  const template = SPEECH_TEMPLATES[eventType] || SPEECH_TEMPLATES['Other'];
  const topContact = contactsForEvent[0]?.name || 'the local leaders';
  const grievanceContact = contactsForEvent.find(c => c.open_grievance);
  const grievanceLine = grievanceContact
    ? `Name and commit to a follow-up date for: "${grievanceContact.open_grievance.slice(0, 80)}".`
    : 'Invite questions or concerns from those present.';
  const village = event.village || event.mandal || '';
  return template
    .map(line => line
      .replace('{village}', village)
      .replace('{mandal}', event.mandal || '')
      .replace('{top_contact}', topContact)
      .replace('{grievance_line}', grievanceLine))
    .filter(Boolean)
    .map(line => `• ${line}`)
    .join('\n');
}

// Creative-touch suggestion menu — a checklist the PA picks from, never auto-applied.
const CREATIVE_LIBRARY = {
  'Public Meeting': [
    { id: 'coffee', label: 'Arrive 15 min early for tea/chai with local karyakartas' },
    { id: 'photo', label: 'Photo-op with the senior-most contact present' },
    { id: 'youth', label: 'Separate 5-10 min huddle with youth / first-time voters' },
  ],
  'Grievance Camp': [
    { id: 'grievance_ack', label: 'Personally acknowledge the pending issue and commit a follow-up date', condition: 'hasGrievance' },
    { id: 'photo', label: 'Photo-op handing over a written acknowledgement' },
  ],
  'Inauguration': [
    { id: 'ribbon', label: 'Ribbon-cutting / inaugural photo with contractors and officials' },
    { id: 'youth', label: 'Invite local youth for a group photo at the new facility' },
  ],
  'Condolence Visit': [
    { id: 'low_key', label: 'Keep it low-key — no banners, no large entourage' },
  ],
  'Party Cadre Meeting': [
    { id: 'recognize', label: 'Publicly recognize 2-3 senior cadre workers by name' },
  ],
  'Festival': [
    { id: 'sweets', label: 'Distribute sweets / take part in the local custom' },
    { id: 'selfie', label: 'Click a selfie/group photo with families and youngsters' },
  ],
  'Other': [
    { id: 'coffee', label: 'Arrive early for an informal tea/chai stop nearby' },
    { id: 'selfie', label: 'Click a selfie with the youth/volunteers present' },
  ],
};
const GLOBAL_CREATIVE_EXTRAS = [
  { id: 'coffee_stop', label: 'Stop for chai/coffee at a known spot en route' },
  { id: 'walk_market', label: 'A short walk through the local market/main street' },
  { id: 'youth_separate', label: 'Meet youngsters separately, away from the main crowd' },
];

function buildCreativeSuggestions(eventType, contactsForEvent) {
  const base = CREATIVE_LIBRARY[eventType] || CREATIVE_LIBRARY['Other'];
  const hasGrievance = contactsForEvent.some(c => c.open_grievance);
  const filtered = base.filter(s => !s.condition || (s.condition === 'hasGrievance' && hasGrievance));
  const merged = [...filtered, ...GLOBAL_CREATIVE_EXTRAS];
  const seen = new Set();
  return merged.filter(s => (seen.has(s.id) ? false : (seen.add(s.id), true)));
}

app.get('/api/daily-prep', async (req, res) => {
  const db = readDB();
  const dateStr = req.query.date || getISTDateStr();
  const events = (db.schedule || []).filter(s => s.date === dateStr)
    .sort((a, b) => parseTimeToMinutes(a.time) - parseTimeToMinutes(b.time));

  if (!events.length) return res.json({ events: [], contacts: [], news_suggestions: [], field_news: [] });

  const contactsById = new Map(db.contacts.map(c => [c.id, c]));
  const allContacts = [];

  events.forEach(event => {
    (event.nearby_contacts || []).forEach(nc => {
      const c = contactsById.get(nc.id);
      allContacts.push({
        id: nc.id, name: nc.name, phone: nc.phone, village: nc.village, role: nc.role,
        tier: nc.tier, pps_score: nc.pps_score, open_grievance: nc.open_grievance,
        note: nc.event_brief || '', note_reviewed: nc.brief_reviewed || false,
        event_id: event.id,
        event_name: event.event_name,
        reference: { remarks: c?.remarks || '', ai_reason: c?.ai_reason || '', standing_note: c?.manual_brief || '' },
      });
    });
  });

  let newsSuggestions = [];
  try {
    const liveNews = await fetchGoogleNews(db);
    const mandals = new Set(events.map(e => e.mandal));
    const tagged = liveNews.filter(n => mandals.has(n.mandal_tag));
    const rest = liveNews.filter(n => !mandals.has(n.mandal_tag));
    newsSuggestions = [...tagged, ...rest].slice(0, 10);
  } catch { /* best-effort */ }

  const todayIST = getISTDateStr();
  const fieldNews = (db.news || [])
    .filter(n => {
      if (!n.submitted_at) return false;
      const nDate = new Date(n.submitted_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      return nDate === dateStr || nDate === todayIST;
    })
    // `category` is derived from the row's `scope` column — see newsCategory in
    // server/news-categories.js. Reading `n.category` here returned undefined for
    // every row and filed the whole day's news under District.
    .map(n => ({ title: n.headline, link: n.link || '', source: n.source || 'Field report', mandal_tag: n.mandal || '', is_field: true, category: newsCategory(n), body: n.body || '' }));

  const combinedNewsSelected = [];
  const seenLinks = new Set();
  events.forEach(ev => {
    (ev.news_selected || []).forEach(n => {
      if (n.link && seenLinks.has(n.link)) return;
      if (n.link) seenLinks.add(n.link);
      combinedNewsSelected.push(n);
    });
  });

  res.json({
    date: dateStr,
    events: events.map(ev => ({
      id: ev.id, event_name: ev.event_name, time: ev.time, mandal: ev.mandal,
      village: ev.village, event_type: ev.event_type, description: ev.description,
      speech_points: ev.speech_points || '',
      creative_touches: ev.creative_touches || { selected: [], custom: [] },
      speech_applicable: isSpeechApplicable(ev.event_type),
    })),
    contacts: allContacts,
    news_suggestions: newsSuggestions,
    field_news: fieldNews,
    news_selected: combinedNewsSelected,
  });
});

app.patch('/api/daily-prep', (req, res) => {
  const db = readDB();
  const dateStr = req.body.date || getISTDateStr();
  const events = (db.schedule || []).filter(s => s.date === dateStr);
  if (!events.length) return res.status(404).json({ error: 'No events for this date' });

  const { contacts, news_selected, event_updates } = req.body;

  // A contact without an event_id applies to every event on the date — the PA
  // wrote one note for a person they will meet more than once that day.
  if (contacts) {
    for (const c of contacts) {
      const targets = c.event_id ? events.filter(e => e.id === c.event_id) : events;
      for (const ev of targets) {
        if ((ev.nearby_contacts || []).some(nc => nc.id === c.id)) {
          setEventContactBrief(ev.id, c.id, { event_brief: c.note, brief_reviewed: true });
        }
      }
    }
  }

  const patches = new Map();
  const patch = (id, fields) => patches.set(id, { ...(patches.get(id) || {}), ...fields });

  if (news_selected) for (const ev of events) patch(ev.id, { news_selected });

  if (event_updates) {
    for (const u of event_updates) {
      if (!events.some(e => e.id === u.id)) continue;
      const fields = {};
      if (u.speech_points !== undefined) {
        fields.speech_points = u.speech_points;
        fields.speech_points_reviewed = !!u.speech_points.trim();
      }
      if (u.creative_touches !== undefined) fields.creative_touches = u.creative_touches;
      patch(u.id, fields);
    }
  }

  // One write per event rather than one rewrite of the whole file, and each is a
  // transaction — a failure part-way leaves the other events untouched instead of
  // half-applying a 3 MB overwrite.
  for (const [id, fields] of patches) updateEvent(id, fields);
  res.json({ ok: true });
});

app.get('/api/schedule/:id/prep', async (req, res) => {
  const db = readDB();
  const event = getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const contactsById = new Map(db.contacts.map(c => [c.id, c]));
  // Default view is name + phone + whatever note the PA already wrote — never an auto-phrased
  // comment. The old reason text still exists, but only behind an explicit opt-in `reference`
  // the PA has to choose to look at (see "show comment from records" in the wizard UI).
  const contacts = (event.nearby_contacts || []).map(nc => {
    const c = contactsById.get(nc.id);
    return {
      id: nc.id, name: nc.name, phone: nc.phone, village: nc.village, role: nc.role,
      tier: nc.tier, pps_score: nc.pps_score, open_grievance: nc.open_grievance,
      note: nc.event_brief || '', note_reviewed: nc.brief_reviewed || false,
      reference: { remarks: c?.remarks || '', ai_reason: c?.ai_reason || '', standing_note: c?.manual_brief || '' },
    };
  });

  let newsSuggestions = [];
  try {
    const liveNews = await fetchGoogleNews(db);
    const tagged = liveNews.filter(n => n.mandal_tag === event.mandal);
    const rest = liveNews.filter(n => n.mandal_tag !== event.mandal);
    newsSuggestions = [...tagged, ...rest].slice(0, 8);
  } catch { /* news is best-effort here */ }

  const todayIST = getISTDateStr();
  const evDate = event.date || todayIST;
  const fieldNews = (db.news || [])
    .filter(n => {
      if (!n.submitted_at) return false;
      const nDate = new Date(n.submitted_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      return nDate === evDate || nDate === todayIST;
    })
    // `category` is derived from the row's `scope` column — see newsCategory in
    // server/news-categories.js. Reading `n.category` here returned undefined for
    // every row and filed the whole day's news under District.
    .map(n => ({ title: n.headline, link: n.link || '', source: n.source || 'Field report', mandal_tag: n.mandal || '', is_field: true, category: newsCategory(n), body: n.body || '' }));

  res.json({
    event: { ...event, speech_applicable: isSpeechApplicable(event.event_type) },
    contacts,
    news_suggestions: newsSuggestions,
    field_news: fieldNews,
  });
});

// On-demand only — the wizard calls this when the PA explicitly clicks "insert a suggestion."
// Keeping this out of the main GET /prep response is what stops auto-phrasing from creeping
// back in (it happened twice already across rounds 1-2).
app.get('/api/schedule/:id/suggestions', (req, res) => {
  const db = readDB();
  const event = getEvent(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  const kind = req.query.kind;
  const allContacts = event.nearby_contacts || [];

  if (kind === 'speech') {
    return res.json({ speech_draft: buildSpeechDraft(event.event_type, event, allContacts) });
  }
  if (kind === 'creative') {
    return res.json({ creative_suggestions: buildCreativeSuggestions(event.event_type, allContacts) });
  }
  res.status(400).json({ error: 'kind must be speech or creative' });
});

app.patch('/api/schedule/:id/prep', (req, res) => {
  const db = readDB();
  const idx = (db.schedule || []).findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Event not found' });
  const event = db.schedule[idx];

  const {
    event_type, contact_briefs, contacts_approved,
    speech_points, speech_points_reviewed, speech_skipped,
    creative_touches, news_selected,
  } = req.body;

  if (event_type !== undefined) event.event_type = event_type;

  if (contact_briefs) {
    for (const nc of event.nearby_contacts || []) {
      const update = contact_briefs[nc.id];
      if (!update) continue;
      // "Save to contact" promotes the occasion-specific brief into the contact's
      // reusable draft seed. Two different records, deliberately: the event brief
      // is about this occasion, manual_brief is about the person.
      if (update.save_to_contact) updateContact(nc.id, { manual_brief: update.event_brief || '' });
      setEventContactBrief(event.id, nc.id, {
        event_brief: update.event_brief,
        brief_reviewed: update.brief_reviewed,
      });
    }
  }

  // The review-and-approve gate: a deliberate event-level flag, separate from the per-contact
  // "reviewed" marker, that the wizard uses to unlock the next step.
  if (contacts_approved !== undefined) {
    event.contacts_approved = !!contacts_approved;
    event.contacts_approved_at = contacts_approved ? new Date().toISOString() : null;
  }

  if (speech_points !== undefined) event.speech_points = speech_points;
  if (speech_points_reviewed !== undefined) event.speech_points_reviewed = !!speech_points_reviewed;
  if (speech_skipped !== undefined) event.speech_skipped = !!speech_skipped;

  if (creative_touches) {
    event.creative_touches = {
      selected: Array.isArray(creative_touches.selected) ? creative_touches.selected : (event.creative_touches?.selected || []),
      custom: Array.isArray(creative_touches.custom) ? creative_touches.custom : (event.creative_touches?.custom || []),
      reviewed: creative_touches.reviewed !== undefined ? !!creative_touches.reviewed : (event.creative_touches?.reviewed || false),
    };
  }

  if (Array.isArray(news_selected)) event.news_selected = news_selected;

  // nearby_contacts is a join, not a column — updateEvent ignores it, and
  // setEventContactBrief above has already written the only part a human edited.
  //
  // `media` is stripped instead of ignored: updateEvent DOES act on it, and this
  // route hands back the whole event object, so leaving it in would push the
  // unchanged attachment list through replaceMedia's delete-and-reinsert on
  // every prep save — new row ids for no reason.
  const { media, ...prepPatch } = event;
  const saved = updateEvent(event.id, prepPatch);
  res.json({ ok: true, event: { ...saved, speech_applicable: isSpeechApplicable(saved.event_type) } });
});

app.post('/api/contact', (req, res) => {
  const { name, phone, village, mandal, role, tier, constituency } = req.body;
  if (!name || !phone || !mandal) return res.status(400).json({ error: 'name, phone, and mandal required' });
  
  // `C${Date.now()}` collided for two contacts added in the same millisecond and
  // sorted as a string. ULIDs are unique and time-ordered; the imported C0001-style
  // ids are left alone, since other records reference them.
  const newContact = upsertContact({
    id: `C${ulid()}`,
    name, phone, village: village || '', mandal, constituency: constituency || '',
    role: role || 'Other', tier: tier || 'T3',
    pps_score: 50, days_since_contact: 0,
    created_at: new Date().toISOString(),
    issues: [],
  });
  res.json({ ok: true, contact: newContact });
});

app.post('/api/issue', (req, res) => {
  const { contact_id, type, description } = req.body;
  if (!contact_id || !type) return res.status(400).json({ error: 'contact_id and type required' });
  
  const contact = getContact(contact_id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });

  const issue = {
    id: `ISS${ulid()}`,
    type, // 'General', 'Recommendation Letter', 'TTD Darshan'
    description: description || '',
    status: (type === 'General') ? 'none' : 'pending',
    created_at: new Date().toISOString(),
  };

  updateContact(contact_id, {
    issues: [...(contact.issues || []), issue],
    // Also update open_grievance for backward compatibility
    open_grievance: description,
  });
  res.json({ ok: true, issue });
});

app.get('/api/news', (req, res) => {
  const db = readDB();
  let items = db.news || [];
  if (req.query.date) {
    const istOpts = { timeZone: 'Asia/Kolkata' };
    items = items.filter(n => n.submitted_at &&
      new Date(n.submitted_at).toLocaleDateString('en-CA', istOpts) === req.query.date);
  }
  res.json({ news: items });
});

app.post('/api/news', upload.single('attachment'), (req, res) => {
  const { headline, body, source, mandal, priority, link } = req.body;
  if (!headline) return res.status(400).json({ error: 'headline required' });
  // The old `.slice(0, 50)` cap is gone: it existed because every submission
  // rewrote the whole collection and the file had to stay small. An indexed table
  // does not need to forget last month's news.
  const item = insertNews({
    headline, body: body || '',
    source: source || 'Field correspondent',
    mandal: mandal || 'General',
    priority: priority || 'medium',
    link: link || '',
    submitted_at: new Date().toISOString(),
    has_attachment: !!req.file,
    attachment_name: req.file?.originalname || null,
  });
  res.json({ ok: true, id: item.id, message: 'Submitted. Appearing in today\'s brief now.' });
});

app.patch('/api/news/:id', (req, res) => {
  if (!getNewsItem(req.params.id)) return res.status(404).json({ error: 'News item not found' });
  const { headline, link, source, body, mandal, priority } = req.body;
  const patch = {};
  for (const [k, v] of Object.entries({ headline, link, source, body, mandal, priority })) {
    if (v !== undefined) patch[k] = v;
  }
  res.json({ ok: true, item: updateNews(req.params.id, patch) });
});

app.delete('/api/news/:id', (req, res) => {
  softDeleteNews(req.params.id);
  res.json({ ok: true });
});

// ── TTD Reference Letters ───────────────────────────────────────────────────
const TTD_DARSHAN_TYPES = ['Break Darshan', 'Supadam'];
const TTD_PARTY_LIMITS = { 'Break Darshan': 6, 'Supadam': 10 };
function validatePartySize(darshan_type, party_size) {
  if (party_size == null || party_size === '') return null;
  const n = Number(party_size);
  if (!Number.isInteger(n) || n < 1) return 'party_size must be a positive integer';
  const limit = TTD_PARTY_LIMITS[darshan_type];
  if (limit && n > limit) return `${darshan_type} is limited to ${limit} people (got ${n})`;
  return null;
}
// The letter's reference (TTD/<year>/<seq>) is minted inside insertLetter's
// transaction now. It used to be a COUNT over a JSON array, so two requests in
// flight at once both read the same number and both minted TTD/2026/007 — and
// that number is quoted to the temple, which makes the collision a real-world
// problem rather than a data one. `reference` is UNIQUE as a backstop.
const normalizeAadhar = normalizeAadharDb;

// The duplicate check the register's headline feature runs on. Aadhar is stored
// normalized (digits only), so this is an indexed equality rather than a scan
// that rewrote both sides of every comparison.
function ttdDuplicateMatches(aadhar, excludeId = null) {
  return findByAadhar(aadhar, excludeId)
    .map(l => ({ id: l.id, date: l.date, reference: l.reference, name: l.name, darshan_type: l.darshan_type }));
}
function ttdStatus(dateStr) {
  return (dateStr || '') < getISTDateStr() ? 'Given' : 'Upcoming';
}

app.get('/api/ttd-letters', (req, res) => {
  const db = readDB();
  let items = db.ttd_letters || [];
  const { from, to } = req.query;
  if (from) items = items.filter(l => l.date >= from);
  if (to) items = items.filter(l => l.date <= to);
  items = [...items].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  res.json({ letters: items });
});

app.get('/api/ttd-letters/check-duplicate', (req, res) => {
  res.json({ matches: ttdDuplicateMatches(req.query.aadhar) });
});

app.post('/api/ttd-letters', (req, res) => {
  const { date, name, phone, aadhar, referred_by, remarks, darshan_type, party_size } = req.body;
  if (!date || !name || !darshan_type || !TTD_DARSHAN_TYPES.includes(darshan_type))
    return res.status(400).json({ error: 'date, name, and a valid darshan_type are required' });
  const partySizeError = validatePartySize(darshan_type, party_size);
  if (partySizeError) return res.status(400).json({ error: partySizeError });

  // The duplicate check runs BEFORE the insert, so the new letter cannot match
  // itself. The reference itself is minted inside insertLetter's transaction —
  // it used to be a COUNT over a JSON array, which two concurrent requests both
  // read as the same number and both used.
  const duplicate_warning = ttdDuplicateMatches(aadhar);
  const item = insertLetter({
    date, name, phone, aadhar, referred_by, remarks, darshan_type, party_size,
    review_status: 'Confirmed',
  });
  res.json({ ok: true, item, duplicate_warning });
});

app.patch('/api/ttd-letters/:id', (req, res) => {
  const db = readDB();
  const item = getLetter(req.params.id);
  if (!item) return res.status(404).json({ error: 'Letter not found' });
  const { date, name, phone, aadhar, referred_by, remarks, darshan_type, party_size, review_status } = req.body;
  if (darshan_type !== undefined && !TTD_DARSHAN_TYPES.includes(darshan_type))
    return res.status(400).json({ error: 'invalid darshan_type' });
  if (party_size !== undefined) {
    const partySizeError = validatePartySize(darshan_type !== undefined ? darshan_type : item.darshan_type, party_size);
    if (partySizeError) return res.status(400).json({ error: partySizeError });
  }
  if (review_status !== undefined && !['Pending Review', 'Confirmed'].includes(review_status))
    return res.status(400).json({ error: 'invalid review_status' });

  if (review_status === 'Confirmed') {
    const finalDate = date !== undefined ? date : item.date;
    const finalDarshanType = darshan_type !== undefined ? darshan_type : item.darshan_type;
    const finalPartySize = party_size !== undefined ? party_size : item.party_size;
    if (!finalDate || !finalDarshanType || !TTD_DARSHAN_TYPES.includes(finalDarshanType) || finalPartySize == null)
      return res.status(400).json({ error: 'Set Darshan Type, date, and party size before confirming' });
    const partySizeError = validatePartySize(finalDarshanType, finalPartySize);
    if (partySizeError) return res.status(400).json({ error: partySizeError });
  }

  const patch = {};
  for (const [k, v] of Object.entries({ date, name, phone, aadhar, referred_by,
    remarks, darshan_type, party_size, review_status })) {
    if (v !== undefined) patch[k] = v;
  }
  const saved = updateLetter(item.id, patch);
  const duplicate_warning = aadhar !== undefined ? ttdDuplicateMatches(aadhar, item.id) : [];
  res.json({ ok: true, item: saved, duplicate_warning });
});

app.delete('/api/ttd-letters/:id', (req, res) => {
  softDeleteLetter(req.params.id);
  res.json({ ok: true });
});

// ── Visitor Forms (AI OCR + categorization) ────────────────────────────────
// `department`/`recipientTitle` are used only by the "draft letter to department" feature
// (buildDepartmentLetterPDF) to address the letter — they don't affect triage/scoring.
const ISSUE_CATEGORIES = [
  { key: 'cmrf_medical',          label: 'CMRF/Medical Assistance',                  weight: 90, department: 'CMRF / Medical Assistance',                department_head: 'The District Collector (CMRF Cell)' },
  { key: 'police_law_order',      label: 'Police Department',                        weight: 85, department: 'Police Department',                        department_head: 'The Superintendent of Police (SP)' },
  { key: 'public_grievance',      label: 'Public Grievance',                         weight: 75, department: 'Public Grievance',                         department_head: 'The District Collector' },
  { key: 'irrigation_water',      label: 'Irrigation / Water Resources Department',  weight: 75, department: 'Irrigation / Water Resources Department',  department_head: 'The Executive Engineer, Irrigation Department' },
  { key: 'medical_health_dept',   label: 'Medical and Health Department',            weight: 75, department: 'Medical and Health Department',            department_head: 'The District Medical & Health Officer (DM&HO)' },
  { key: 'social_welfare_bc',     label: 'Social Welfare & BC/Minority Welfare',     weight: 70, department: 'Social Welfare & BC/Minority Welfare',     department_head: 'The District Social Welfare Officer' },
  { key: 'housing',               label: 'Housing',                                 weight: 70, department: 'Housing',                                 department_head: 'The Project Officer, AP State Housing Corporation' },
  { key: 'electricity',           label: 'Electricity',                             weight: 65, department: 'Electricity',                             department_head: 'The Assistant Divisional Engineer (ADE), Electricity' },
  { key: 'revenue_land',          label: 'Revenue Department',                      weight: 65, department: 'Revenue Department',                      department_head: 'The Tehsildar / District Revenue Officer' },
  { key: 'panchayat_raj_rural',   label: 'Panchayat Raj & Rural Development',        weight: 65, department: 'Panchayat Raj & Rural Development',        department_head: 'The District Panchayat Officer' },
  { key: 'civil_supplies',        label: 'Civil Supplies Department',               weight: 60, department: 'Civil Supplies Department',               department_head: 'The District Supply Officer' },
  { key: 'roads_infrastructure',  label: 'Roads and Buildings (R&B)',               weight: 60, department: 'Roads and Buildings (R&B)',               department_head: 'The Executive Engineer, R&B' },
  { key: 'education_fee',         label: 'Education Department',                    weight: 60, department: 'Education Department',                    department_head: 'The District Educational Officer (DEO)' },
  { key: 'agriculture',           label: 'Agriculture Department',                  weight: 60, department: 'Agriculture Department',                  department_head: 'The Joint Director of Agriculture' },
  { key: 'transport_dept',        label: 'Transport Department',                    weight: 55, department: 'Transport Department',                    department_head: 'The Regional Transport Officer (RTO)' },
  { key: 'banking_financial',     label: 'Institutional and Commercial Banks',      weight: 55, department: 'Institutional and Commercial Banks',      department_head: 'The Lead District Manager (LDM)' },
  { key: 'employee_transfer',     label: 'Employee Transfer',                       weight: 50, department: 'MP Office (internal)',                    department_head: 'The District Collector' },
  { key: 'mplads',                label: 'MPLADS',                                  weight: 50, department: 'MP Office (internal)',                    department_head: 'The District Collector' },
  { key: 'horticulture',          label: 'Horticulture Department',                 weight: 50, department: 'Horticulture Department',                 department_head: 'The Deputy Director of Horticulture' },
  { key: 'fisheries',             label: 'Fisheries Department',                    weight: 50, department: 'Fisheries Department',                    department_head: 'The Assistant Director of Fisheries' },
  { key: 'recommendation_letter', label: 'Recommendation/Request Letter',           weight: 45, department: 'MP Office (internal)',                    department_head: 'The District Collector' },
  { key: 'ttd_letter',            label: 'TTD Recommendation Letter',               weight: 40, department: 'TTD (uses its own dedicated letter flow)', department_head: 'The Executive Officer, TTD' },
  { key: 'nominated_posts',       label: 'Nominated Posts',                         weight: 40, department: 'MP Office (internal)',                    department_head: 'The District Collector' },
  { key: 'party_organizational',  label: 'Party/Organizational Matter',             weight: 35, department: 'MP Office (internal)',                    department_head: 'The District Collector' },
  { key: 'others',                label: 'Others',                                 weight: 30, department: 'General / Others',                        department_head: 'The District Collector' },
];
const ISSUE_CATEGORY_KEYS = new Set(ISSUE_CATEGORIES.map(c => c.key));
function categoryDepartmentInfo(key) {
  return ISSUE_CATEGORIES.find(c => c.key === key) || ISSUE_CATEGORIES.find(c => c.key === 'others');
}
const RESOLUTION_STATUSES = new Set(['Pending', 'In Progress', 'Resolved']);
const URGENCY_WEIGHTS = { High: 100, Medium: 60, Low: 30 };
// 'feedback' is non-actionable input (opinions, sentiment) the AI didn't read as a
// grievance (is_grievance:false) that staff chose to keep as intelligence input rather
// than force-save as a grievance or discard.
const ENTRY_TYPES = new Set(['grievance', 'feedback']);
const SENTIMENTS = new Set(['Positive', 'Neutral', 'Negative', 'Mixed']);

function categoryWeight(key) {
  return ISSUE_CATEGORIES.find(c => c.key === key)?.weight ?? ISSUE_CATEGORIES.find(c => c.key === 'others').weight;
}
function computePriorityScore(category, urgency) {
  const cw = categoryWeight(category);
  const uw = URGENCY_WEIGHTS[urgency] ?? URGENCY_WEIGHTS.Medium;
  return Math.round(cw * 0.4 + uw * 0.6);
}

// How a grievance reached the office. Walk-ins are photographed paper forms; phone
// calls are typed or dictated by staff; the WhatsApp channels arrive on their own.
const GRIEVANCE_CHANNELS = new Set(['walk_in', 'phone_call', 'whatsapp_text', 'whatsapp_voice']);
// Gemini's supported inline-audio types. Rejecting here gives staff a clear message
// instead of an opaque 400 from the API.
const GRIEVANCE_AUDIO_MIMES = {
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
  'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/flac': 'flac',
};
const AI_UNCONFIGURED_ERROR =
  'AI extraction is not configured (GEMINI_API_KEY missing) — contact admin, or enter forms manually.';

// NOTE ON ROUTE ORDER: every fixed-segment route below (/categories, /upload,
// /log-text, /log-audio, /export.xlsx, /export-pdf) must stay registered ahead of the
// /:id routes, or Express will match the literal segment as an id.

app.get('/api/grievances/categories', (req, res) => {
  res.json({ categories: ISSUE_CATEGORIES });
});

// Live duplicate check for the Log Grievance / edit UI — same phone+text+name/village
// signals buildGrievanceRecord uses on save, so what staff see while typing matches
// what actually gets linked when they save.
app.get('/api/grievances/duplicate-check', (req, res) => {
  const { phone, text, name, village, exclude } = req.query;
  const db = readDB();
  const matches = findGrievanceDuplicates(db, {
    contact_number: phone || '', issue_description: text || '',
    full_name: name || '', village: village || '',
  }, exclude);
  res.json({ matches });
});

app.post('/api/grievances/upload', uploadGrievanceMedia.array('images', 20), async (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'At least one form image required' });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: AI_UNCONFIGURED_ERROR });

  const allowedMimes = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
  const gemini = await import('./gemini.js');

  const results = await Promise.all(req.files.map(async (file, idx) => {
    const tmp_id = `tmp${Date.now()}_${idx}`;
    if (!allowedMimes.has(file.mimetype)) {
      return { tmp_id, filename: file.originalname, error: `Unsupported file type: ${file.mimetype}` };
    }
    try {
      const extracted = await gemini.extractGrievanceFromImage(file.buffer, file.mimetype, ISSUE_CATEGORIES);
      const category = ISSUE_CATEGORY_KEYS.has(extracted.category) ? extracted.category : 'others';
      const urgency = URGENCY_WEIGHTS[extracted.urgency] !== undefined ? extracted.urgency : 'Medium';
      return {
        tmp_id,
        filename: file.originalname,
        channel: 'walk_in',
        intake_mode: 'ocr',
        extracted: { ...extracted, category, urgency },
        priority_score: computePriorityScore(category, urgency),
        image_base64: file.buffer.toString('base64'),
        image_mime: file.mimetype,
      };
    } catch (e) {
      return { tmp_id, filename: file.originalname, channel: 'walk_in', intake_mode: 'ocr', error: e.message };
    }
  }));

  res.json({ ok: true, items: results, count: results.length });
});

// Universal single-grievance intake — any combination of typed text, photo(s)/PDF,
// and audio (recorded or attached) submitted together become ONE merged grievance,
// not one record per attachment (that's what the bulk /upload digitizer is for).
// Priority order across sources reflects which one is most likely to hold a given
// kind of detail: a photographed form has dedicated printed boxes for identity/
// location fields, so OCR wins those; dictation tends to carry the fullest verbal
// description of the actual problem, so it wins the category/urgency judgement.
function mergeGrievanceExtraction({ imageResults, audioResult, textResult, typedText, known }) {
  const scalarFields = [
    'full_name', 'address', 'village', 'mandal', 'assembly_constituency',
    'reference_name', 'reference_number', 'contact_number', 'email', 'date_of_visit',
    'assigned_officer', 'deadline', 'action_taken', 'action_to_be_taken',
  ];
  const successfulImages = imageResults.filter(r => r.ok).map(r => r.extracted);
  const scalarSources = [
    ...successfulImages,
    ...(audioResult?.ok ? [audioResult.extracted] : []),
    ...(textResult?.ok ? [textResult.extracted] : []),
  ];

  const merged = {};
  for (const field of scalarFields) {
    merged[field] = '';
    for (const src of scalarSources) {
      if (src[field]) { merged[field] = src[field]; break; }
    }
  }

  // category/urgency/urgency_reason are chosen as one coherent bundle from a single
  // richest source — never mix category from one source with urgency from another.
  const bundleSource = audioResult?.ok ? audioResult.extracted
    : (successfulImages[0] || (textResult?.ok ? textResult.extracted : null));
  merged.category = (bundleSource && ISSUE_CATEGORY_KEYS.has(bundleSource.category)) ? bundleSource.category : 'others';
  merged.urgency = (bundleSource && URGENCY_WEIGHTS[bundleSource.urgency] !== undefined) ? bundleSource.urgency : 'Medium';
  merged.urgency_reason = bundleSource?.urgency_reason || '';
  merged.confidence = (bundleSource && bundleSource.confidence) || '';
  merged.sentiment = (bundleSource && SENTIMENTS.has(bundleSource.sentiment)) ? bundleSource.sentiment : '';
  merged.ocr_confidence = imageResults.find(r => r.ok)?.extracted?.ocr_confidence || '';
  merged.transcript = audioResult?.ok ? (audioResult.extracted.transcript || '') : '';

  // A photographed form is inherently a valid intake regardless of this flag; only
  // gate it out when every non-image source that ran explicitly said "not a grievance".
  const succeededNonImage = [audioResult, textResult].filter(r => r && r.ok);
  const allExplicitFalse = succeededNonImage.length > 0 && succeededNonImage.every(r => r.extracted.is_grievance === false);
  merged.is_grievance = successfulImages.length > 0 ? true : !allExplicitFalse;

  // issue_description is concatenated, never chosen — every present source
  // contributes its own labeled paragraph so nothing is silently dropped.
  const parts = [];
  if (audioResult) {
    parts.push(audioResult.ok
      ? `[From voice note]: ${audioResult.extracted.transcript || ''}`
      : `[From voice note]: (extraction failed — ${audioResult.error})`);
  }
  if (typedText) parts.push(`[Typed note]: ${typedText}`);
  imageResults.forEach((r, i) => {
    const label = `[From attached photo ${i + 1}${r.file ? ' — ' + r.file : ''}]`;
    parts.push(r.ok
      ? `${label}: ${r.extracted.issue_description || ''}`
      : `${label}: (extraction failed — ${r.error})`);
  });
  merged.issue_description = parts.join('\n\n');

  // Staff-typed known fields always win outright over anything AI-extracted.
  for (const [k, v] of Object.entries(known)) if (v) merged[k] = v;

  return merged;
}

app.post('/api/grievances/log', logGrievanceMedia, async (req, res) => {
  const text = String(req.body.text || '').trim();
  const images = req.files?.images || [];
  const audioFile = req.files?.audio?.[0];
  if (!text && !images.length && !audioFile) {
    return res.status(400).json({ error: 'Add at least one of: typed text, a photo/PDF, or audio.' });
  }
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: AI_UNCONFIGURED_ERROR });

  const allowedImageMimes = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
  for (const f of images) {
    if (!allowedImageMimes.has(f.mimetype)) {
      return res.status(400).json({ error: `Unsupported file type: ${f.mimetype}` });
    }
  }
  let audioExt = null;
  if (audioFile) {
    audioExt = GRIEVANCE_AUDIO_MIMES[audioFile.mimetype];
    if (!audioExt) {
      return res.status(400).json({
        error: `Unsupported audio type: ${audioFile.mimetype}. Use WAV, MP3, M4A, AAC, OGG or FLAC.`,
      });
    }
  }

  const { channel, logged_by, full_name, contact_number, village } = req.body;
  const ch = GRIEVANCE_CHANNELS.has(channel) ? channel : 'phone_call';
  const known = { full_name, contact_number, village };

  // Park every attachment to disk immediately — nothing is lost if a Gemini call
  // below fails, and it sidesteps express.json's 10mb cap for this multipart path.
  const media = [];
  try {
    images.forEach((f, i) => {
      const ext = f.mimetype.includes('png') ? 'png' : f.mimetype.includes('pdf') ? 'pdf' : f.mimetype.includes('webp') ? 'webp' : 'jpg';
      const filename = `tmp_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
      fs.writeFileSync(path.join(GRIEVANCE_MEDIA_PATH, filename), f.buffer);
      media.push({ pending_media: filename, mime: f.mimetype, type: f.mimetype === 'application/pdf' ? 'pdf' : 'image', label: `Attached photo ${i + 1}` });
    });
    if (audioFile) {
      const filename = `tmp_${Date.now()}_audio_${Math.random().toString(36).slice(2, 8)}.${audioExt}`;
      fs.writeFileSync(path.join(GRIEVANCE_MEDIA_PATH, filename), audioFile.buffer);
      media.push({ pending_media: filename, mime: audioFile.mimetype, type: 'audio', label: 'Voice note' });
    }
  } catch (e) {
    return res.status(500).json({ error: `Could not store attachment(s): ${e.message}` });
  }

  const gemini = await import('./gemini.js');
  const [imageResults, audioResult, textResult] = await Promise.all([
    Promise.all(images.map(async (f, i) => {
      try {
        const extracted = await gemini.extractGrievanceFromImage(f.buffer, f.mimetype, ISSUE_CATEGORIES);
        return { ok: true, idx: i, file: f.originalname, extracted };
      } catch (e) {
        return { ok: false, idx: i, file: f.originalname, error: e.message };
      }
    })),
    audioFile
      ? gemini.extractGrievanceFromAudio(audioFile.buffer, audioFile.mimetype, ISSUE_CATEGORIES)
          .then(extracted => ({ ok: true, extracted }))
          .catch(e => ({ ok: false, error: e.message }))
      : null,
    text
      ? gemini.extractGrievanceFromText(text, ISSUE_CATEGORIES)
          .then(extracted => ({ ok: true, extracted }))
          .catch(e => ({ ok: false, error: e.message }))
      : null,
  ]);

  const merged = mergeGrievanceExtraction({ imageResults, audioResult, textResult, typedText: text, known });
  const tmp_id = `tmp${Date.now()}_0`;
  const item = {
    tmp_id,
    channel: ch,
    intake_mode: 'mixed',
    logged_by: logged_by || '',
    extracted: merged,
    transcript: merged.transcript || '',
    priority_score: computePriorityScore(merged.category, merged.urgency),
    media,
  };
  res.json({ ok: true, items: [item], count: 1 });
});

// Called when staff discard a preview, so abandoned recordings don't pile up.
app.delete('/api/grievances/pending-media/:filename', (req, res) => {
  const safeName = path.basename(req.params.filename);
  if (!safeName.startsWith('tmp_')) return res.status(400).json({ error: 'Not a pending upload' });
  const p = path.join(GRIEVANCE_MEDIA_PATH, safeName);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  res.json({ ok: true });
});

function normalizeNameVillage(s) {
  return String(s || '').trim().toLowerCase();
}

// Three duplicate signals, in decreasing order of reliability. Only an exact phone
// match is trustworthy enough to auto-link both records; a similar description or a
// matching name+village is surfaced to staff as a "possible" match, never linked
// automatically — merging on those alone would be too easy to get wrong.
function findGrievanceDuplicates(db, { contact_number, full_name, village, issue_description }, excludeId) {
  const all = (db.grievances || []).filter(g => g.id !== excludeId);
  const results = [];
  const seen = new Set();
  const summarize = (g, match_type) => ({
    id: g.id, date_of_visit: g.date_of_visit, channel: g.channel,
    category: g.category, issue_description: g.issue_description, match_type,
  });

  const phone = contact_number ? normalizePhone(contact_number) : '';
  if (phone) {
    for (const g of all) {
      if (g.contact_number && normalizePhone(g.contact_number) === phone) {
        results.push(summarize(g, 'phone'));
        seen.add(g.id);
      }
    }
  }

  if (issue_description && issue_description.trim().length >= 8) {
    const pool = all.filter(g => !seen.has(g.id) && g.issue_description);
    const fuse = new Fuse(pool, { keys: ['issue_description'], threshold: 0.35 });
    fuse.search(issue_description).slice(0, 5).forEach(r => {
      results.push(summarize(r.item, 'text'));
      seen.add(r.item.id);
    });
  }

  const nameKey = normalizeNameVillage(full_name);
  const villageKey = normalizeNameVillage(village);
  if (nameKey && villageKey) {
    for (const g of all) {
      if (seen.has(g.id)) continue;
      if (normalizeNameVillage(g.full_name) === nameKey && normalizeNameVillage(g.village) === villageKey) {
        results.push(summarize(g, 'name_village'));
        seen.add(g.id);
      }
    }
  }

  return results;
}

// The single write path into the grievance register. Every channel goes through
// this — the staff-reviewed commit below and the universal /log intake — so media
// handling, TTD auto-linking and duplicate detection can't drift between them.
//
// It BUILDS but no longer persists: it returns the record, its adopted media, the
// duplicates to link and the warnings to show staff. persistGrievance() below
// writes all of that in one transaction. Splitting the two is what lets the
// duplicate links be created after both rows exist, instead of writing an id into
// a JSON array and hoping the other side gets written too.
function buildGrievanceRecord(db, it, id) {
  const category = ISSUE_CATEGORY_KEYS.has(it.category) ? it.category : 'others';
  const resolution_status = RESOLUTION_STATUSES.has(it.resolution_status) ? it.resolution_status : 'Pending';
  const urgency = URGENCY_WEIGHTS[it.urgency] !== undefined ? it.urgency : 'Medium';
  const channel = GRIEVANCE_CHANNELS.has(it.channel) ? it.channel : 'walk_in';
  const entry_type = ENTRY_TYPES.has(it.entry_type) ? it.entry_type : 'grievance';
  const sentiment = SENTIMENTS.has(it.sentiment) ? it.sentiment : '';

  // Media arrives one of two shapes: the new universal intake's `media` array (each
  // entry a pending_media filename parked on disk, one grievance can carry several
  // attachments), or the legacy singular shape used by /upload, the bulk-upload
  // preview commit, and the WhatsApp inbox promote path — a single `pending_media`
  // (parked by /log-audio historically, or a promoted voice-note inbox entry) or
  // inline `image_base64` (form photos). The legacy path is kept byte-identical;
  // either way we end up with one `media` array on the record.
  let media = [];
  if (Array.isArray(it.media) && it.media.length) {
    media = it.media.map((m, idx) => {
      let filePath = '';
      if (m.pending_media) {
        const safeName = path.basename(String(m.pending_media));
        const src = path.join(GRIEVANCE_MEDIA_PATH, safeName);
        if (fs.existsSync(src)) {
          try {
            const filename = `${id}_${idx}${path.extname(safeName)}`;
            fs.renameSync(src, path.join(GRIEVANCE_MEDIA_PATH, filename));
            filePath = filename;
          } catch (e) {
            console.error('Failed to adopt pending grievance media:', e.message);
          }
        }
      } else if (m.image_base64) {
        try {
          const mime = m.mime || '';
          const ext = mime.includes('png') ? 'png' : mime.includes('pdf') ? 'pdf' : mime.includes('webp') ? 'webp' : 'jpg';
          const filename = `${id}_${idx}.${ext}`;
          fs.writeFileSync(path.join(GRIEVANCE_MEDIA_PATH, filename), Buffer.from(m.image_base64, 'base64'));
          filePath = filename;
        } catch (e) {
          console.error('Failed to persist grievance image:', e.message);
        }
      }
      return filePath ? { path: filePath, mime: m.mime || '', type: m.type || 'image', label: m.label || '' } : null;
    }).filter(Boolean);
  } else {
    let image_path = '';
    let media_type = '';
    if (it.pending_media) {
      const safeName = path.basename(String(it.pending_media));
      const src = path.join(GRIEVANCE_MEDIA_PATH, safeName);
      if (fs.existsSync(src)) {
        try {
          const filename = `${id}${path.extname(safeName)}`;
          fs.renameSync(src, path.join(GRIEVANCE_MEDIA_PATH, filename));
          image_path = filename;
          media_type = it.media_type === 'audio' ? 'audio' : 'image';
        } catch (e) {
          console.error('Failed to adopt pending grievance media:', e.message);
        }
      }
    } else if (it.image_base64) {
      try {
        const mime = it.image_mime || '';
        const ext = mime.includes('png') ? 'png' : mime.includes('pdf') ? 'pdf' : 'jpg';
        const filename = `${id}.${ext}`;
        fs.writeFileSync(path.join(GRIEVANCE_MEDIA_PATH, filename), Buffer.from(it.image_base64, 'base64'));
        image_path = filename;
        media_type = ext === 'pdf' ? 'pdf' : 'image';
      } catch (e) {
        console.error('Failed to persist grievance image:', e.message);
      }
    }
    if (image_path) media = [{ path: image_path, mime: it.image_mime || '', type: media_type, label: media_type === 'audio' ? 'Audio' : 'Attachment' }];
  }

  const record = {
    id,
    channel,
    entry_type,
    sentiment,
    intake_mode: ['typed', 'ocr', 'dictated', 'mixed'].includes(it.intake_mode) ? it.intake_mode : 'typed',
    logged_by: it.logged_by || '',
    full_name: it.full_name || '',
    address: it.address || '',
    village: it.village || '',
    mandal: it.mandal || '',
    assembly_constituency: it.assembly_constituency || '',
    reference_name: it.reference_name || '',
    reference_number: it.reference_number || '',
    contact_number: it.contact_number || '',
    email: it.email || '',
    date_of_visit: it.date_of_visit || getISTDateStr(),
    issue_description: it.issue_description || '',
    action_taken: it.action_taken || '',
    action_to_be_taken: it.action_to_be_taken || '',
    assigned_officer: it.assigned_officer || '',
    resolution_status,
    deadline: it.deadline || '',
    category,
    urgency,
    urgency_reason: it.urgency_reason || '',
    ocr_confidence: it.ocr_confidence || '',
    transcript: it.transcript || '',
    priority_score: computePriorityScore(category, urgency),
    // Legacy singular fields mirror the first attachment so every existing reader
    // (table row media button, delete cleanup, exports) keeps working unchanged.
    image_path: media[0]?.path || '',
    media_type: media[0]?.type || '',
    media,
    ttd_letter_refs: [],
    linked_grievance_ids: [],
    escalated_at: '',
    suggested_response: '',
    suggested_next_action: '',
    drafted_letter_subject: '',
    drafted_letter_body: '',
    created_at: new Date().toISOString(),
  };

  const duplicates = findGrievanceDuplicates(db, {
    contact_number: record.contact_number, full_name: record.full_name,
    village: record.village, issue_description: record.issue_description,
  }, record.id);

  // A phone match is an exact-match signal and is linked automatically; the fuzzy
  // matches are only ever shown to staff as "possible duplicate" hints.
  return {
    record,
    media,
    linkTo: duplicates.filter(d => d.match_type === 'phone').map(d => d.id),
    duplicate_warnings: duplicates.filter(d => d.match_type !== 'phone'),
  };
}

// Write one built grievance and everything that hangs off it, in one transaction.
function persistGrievance(built) {
  const { record, media, linkTo } = built;
  const saved = insertGrievance(record, { media });

  for (const otherId of linkTo) linkDuplicates(saved.id, otherId);

  // A TTD request logged as a grievance opens the letter record straight away,
  // whatever channel it came in on.
  if (saved.category === 'ttd_letter') {
    const letter = insertLetter({
      date: saved.date_of_visit,
      name: saved.full_name,
      phone: saved.contact_number,
      referred_by: saved.reference_name,
      remarks: saved.issue_description,
      review_status: 'Pending Review',
      source_visitor_form_id: saved.id,
    });
    linkTtdLetter(saved.id, letter.id);
  }

  // Re-read so linked_grievance_ids and ttd_letter_refs come back populated —
  // both are derived from links now, not stored on the row.
  return getGrievance(saved.id);
}

app.post('/api/grievances', (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items array required' });

  const db = readDB();
  // `VF${ts}_${idx}` existed because `VF${Date.now()}` collided inside a batch —
  // the workaround was the tell that the single-record paths had the same bug and
  // no workaround. ULIDs are unique and ordered without an index suffix.
  const built = items.map(it => buildGrievanceRecord(db, it, ulid()));
  const saved = built.map(persistGrievance);

  res.json({
    ok: true, count: saved.length, items: saved,
    duplicate_warnings: built.map(b => b.duplicate_warnings),
  });
});

// Shared by the list view and both exports so a filter can't apply in one and not
// the other. Records predating the channel field are walk-ins.
function filterGrievances(db, { from, to, category, status, channel, entry_type }) {
  let items = db.grievances || [];
  if (from) items = items.filter(v => v.date_of_visit >= from);
  if (to) items = items.filter(v => v.date_of_visit <= to);
  if (category) items = items.filter(v => v.category === category);
  if (status) items = items.filter(v => v.resolution_status === status);
  if (channel) items = items.filter(v => (v.channel || 'walk_in') === channel);
  if (entry_type) items = items.filter(v => (v.entry_type || 'grievance') === entry_type);
  return items;
}

app.get('/api/grievances', (req, res) => {
  const items = filterGrievances(readDB(), req.query)
    .slice()
    .sort((a, b) => (b.date_of_visit || '').localeCompare(a.date_of_visit || ''));
  res.json({ items });
});

app.get('/api/grievances/export.xlsx', (req, res) => {
  const { from, to } = req.query;
  const items = filterGrievances(readDB(), req.query)
    .slice()
    .sort((a, b) => (a.date_of_visit || '').localeCompare(b.date_of_visit || ''));

  const rows = items.map(v => ({
    'Date Reported': v.date_of_visit, Channel: channelLabel(v.channel),
    'Entry Type': v.entry_type === 'feedback' ? 'Feedback' : 'Grievance',
    Sentiment: v.sentiment || '', Name: v.full_name,
    Village: v.village, Mandal: v.mandal,
    'Assembly Constituency': v.assembly_constituency, Contact: v.contact_number, Email: v.email,
    'Reference Name': v.reference_name, 'Reference Number': v.reference_number,
    Category: categoryLabel(v.category), Urgency: v.urgency, 'Priority Score': v.priority_score,
    'Issue Description': v.issue_description, 'Action Taken': v.action_taken,
    'Action To Be Taken': v.action_to_be_taken, 'Assigned Officer': v.assigned_officer,
    Status: v.resolution_status, Deadline: v.deadline, 'Logged By': v.logged_by || '',
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Grievances');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="grievances-${from || 'all'}-to-${to || 'now'}.xlsx"`);
  res.send(buf);
});

app.get('/api/grievances/export-pdf', (req, res) => {
  const { from, to } = req.query;
  const items = filterGrievances(readDB(), req.query)
    .slice()
    .sort((a, b) => (a.date_of_visit || '').localeCompare(b.date_of_visit || ''));

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="grievances-${from || 'all'}-to-${to || 'now'}.pdf"`);

  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  doc.pipe(res);
  try {
    buildGrievancesRegisterPDF(doc, items, from, to);
  } catch (e) {
    console.error('Grievances register PDF generation error:', e);
  }
  doc.end();
});

app.patch('/api/grievances/:id', (req, res) => {
  const db = readDB();
  const item = getGrievance(req.params.id);
  if (!item) return res.status(404).json({ error: 'Grievance not found' });

  const fields = [
    'full_name', 'address', 'village', 'mandal', 'assembly_constituency',
    'reference_name', 'reference_number', 'contact_number', 'email',
    'date_of_visit', 'issue_description', 'action_taken', 'action_to_be_taken',
    'assigned_officer', 'deadline', 'transcript',
    'drafted_letter_subject', 'drafted_letter_body',
  ];
  for (const f of fields) if (req.body[f] !== undefined) item[f] = req.body[f];

  if (req.body.category !== undefined)
    item.category = ISSUE_CATEGORY_KEYS.has(req.body.category) ? req.body.category : item.category;
  if (req.body.resolution_status !== undefined)
    item.resolution_status = RESOLUTION_STATUSES.has(req.body.resolution_status) ? req.body.resolution_status : item.resolution_status;
  if (req.body.urgency !== undefined && URGENCY_WEIGHTS[req.body.urgency] !== undefined)
    item.urgency = req.body.urgency;
  if (req.body.entry_type !== undefined && ENTRY_TYPES.has(req.body.entry_type))
    item.entry_type = req.body.entry_type;
  if (req.body.sentiment !== undefined)
    item.sentiment = SENTIMENTS.has(req.body.sentiment) ? req.body.sentiment : item.sentiment;

  item.priority_score = computePriorityScore(item.category, item.urgency);
  // updateGrievance snapshots the previous state into record_versions first, so a
  // re-triaged category or a reassigned officer is recoverable — every correction
  // used to overwrite the previous value with no way back.
  res.json({ ok: true, item: updateGrievance(item.id, item) });
});

// On-demand only — never called automatically on save. Writes only the two
// suggestion fields; action_taken/action_to_be_taken (the audit-trail fields) are
// untouched here, so nothing "acted on" changes until staff explicitly copy it over.
app.post('/api/grievances/:id/suggest-response', async (req, res) => {
  const db = readDB();
  const item = getGrievance(req.params.id);
  if (!item) return res.status(404).json({ error: 'Grievance not found' });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: AI_UNCONFIGURED_ERROR });

  try {
    const gemini = await import('./gemini.js');
    const suggestion = await gemini.suggestGrievanceResponse(item);
    const saved = updateGrievance(item.id, {
      suggested_response: suggestion.suggested_response || '',
      suggested_next_action: suggestion.suggested_next_action || '',
    });
    res.json({ ok: true, item: saved });
  } catch (e) {
    res.status(502).json({ error: `AI suggestion failed: ${e.message}` });
  }
});

// Advisory only, auto-saved on generation (same precedent as suggest-response) so
// the AI call isn't lost if staff navigate away before manually saving; staff can
// still hand-edit the text afterwards via PATCH.
app.post('/api/grievances/:id/draft-letter', async (req, res) => {
  const db = readDB();
  const item = getGrievance(req.params.id);
  if (!item) return res.status(404).json({ error: 'Grievance not found' });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: AI_UNCONFIGURED_ERROR });

  try {
    const gemini = await import('./gemini.js');
    const dept = categoryDepartmentInfo(item.category);
    const draft = await gemini.draftDepartmentLetter(item, dept, getSetting('mp_name'));
    const saved = updateGrievance(item.id, {
      drafted_letter_subject: draft.subject || '',
      drafted_letter_body: draft.body || '',
    });
    res.json({ ok: true, item: saved });
  } catch (e) {
    res.status(502).json({ error: `AI letter draft failed: ${e.message}` });
  }
});

app.get('/api/grievances/:id/department-letter-pdf', (req, res) => {
  const db = readDB();
  const item = getGrievance(req.params.id);
  if (!item) return res.status(404).json({ error: 'Grievance not found' });
  if (!item.drafted_letter_subject && !item.drafted_letter_body)
    return res.status(400).json({ error: 'Draft a letter first.' });

  const dept = categoryDepartmentInfo(item.category);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="department-letter-${item.id}.pdf"`);

  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  doc.pipe(res);
  try {
    buildDepartmentLetterPDF(doc, item, dept, db.metadata?.mp_name);
  } catch (e) {
    console.error('Department letter PDF generation error:', e);
  }
  doc.end();
});

app.post('/api/grievances/:id/create-ttd-letter', (req, res) => {
  const db = readDB();
  const visitorForm = getGrievance(req.params.id);
  if (!visitorForm) return res.status(404).json({ error: 'Grievance not found' });

  const { date, darshan_type, phone, aadhar, referred_by, remarks, party_size } = req.body;
  if (!date || !darshan_type || !TTD_DARSHAN_TYPES.includes(darshan_type))
    return res.status(400).json({ error: 'date and a valid darshan_type are required' });
  const partySizeError = validatePartySize(darshan_type, party_size);
  if (partySizeError) return res.status(400).json({ error: partySizeError });

  const duplicate_warning = ttdDuplicateMatches(aadhar);
  const item = insertLetter({
    date, name: visitorForm.full_name, phone, aadhar, referred_by, remarks, darshan_type, party_size,
    review_status: 'Confirmed', source_visitor_form_id: visitorForm.id,
  });
  // ttd_letter_refs is derived from the link, not stored on the grievance, so
  // deleting the letter can no longer leave a dangling reference behind.
  linkTtdLetter(visitorForm.id, item.id);
  res.json({ ok: true, item, duplicate_warning, visitor_form: getGrievance(visitorForm.id) });
});

app.delete('/api/grievances/:id', (req, res) => {
  // The DB drops the media rows by cascade; the bytes on the volume are ours to
  // clean, so softDeleteGrievance hands back the paths it just detached.
  for (const filePath of softDeleteGrievance(req.params.id)) {
    const p = path.join(GRIEVANCE_MEDIA_PATH, path.basename(filePath));
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  res.json({ ok: true });
});

// Serves whatever media the record carries — a form photo, a PDF, or dictated audio.
// Records saved before media_type existed are all images.
const GRIEVANCE_MEDIA_CONTENT_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
};

app.get('/api/grievances/:id/media/:index?', (req, res) => {
  const db = readDB();
  const item = getGrievance(req.params.id);
  if (!item) return res.status(404).json({ error: 'Grievance not found' });
  const mediaList = item.media?.length ? item.media
    : (item.image_path ? [{ path: item.image_path, mime: '', type: item.media_type || 'image' }] : []);
  const idx = req.params.index !== undefined ? parseInt(req.params.index, 10) : 0;
  const entry = mediaList[idx];
  if (!entry) return res.status(404).json({ error: 'No media on file' });
  const p = path.join(GRIEVANCE_MEDIA_PATH, path.basename(entry.path));
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'Media file missing' });
  const contentType = entry.mime || GRIEVANCE_MEDIA_CONTENT_TYPES[path.extname(p).toLowerCase()];
  if (contentType) res.setHeader('Content-Type', contentType);
  res.sendFile(p);
});

// ── Social Media Calendar ───────────────────────────────────────────────────
const SOCIAL_MEDIA_MIMES = {
  'image/jpeg': { type: 'image', ext: 'jpg' },
  'image/png':  { type: 'image', ext: 'png' },
  'image/webp': { type: 'image', ext: 'webp' },
  'video/mp4':       { type: 'video', ext: 'mp4' },
  'video/quicktime': { type: 'video', ext: 'mov' },
  'video/webm':      { type: 'video', ext: 'webm' },
  'application/pdf': { type: 'pdf', ext: 'pdf' },
};

app.get('/api/social-calendar', (req, res) => {
  const db = readDB();
  let posts = db.social_posts || [];
  const { from, to } = req.query;
  if (from) posts = posts.filter(p => p.date >= from);
  if (to) posts = posts.filter(p => p.date <= to);
  res.json({ posts });
});

app.post('/api/social-calendar', uploadSocialMedia.array('media', 10), (req, res) => {
  const { date, caption } = req.body;
  if (!date) return res.status(400).json({ error: 'date is required' });
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'At least one media file is required' });

  const id = ulid();
  const media = [];
  for (let i = 0; i < req.files.length; i++) {
    const file = req.files[i];
    const info = SOCIAL_MEDIA_MIMES[file.mimetype];
    if (!info) return res.status(400).json({ error: `Unsupported file type: ${file.mimetype}` });
    const filename = `${id}_${i}.${info.ext}`;
    fs.writeFileSync(path.join(SOCIAL_MEDIA_PATH, filename), file.buffer);
    media.push({ filename, mime: file.mimetype, type: info.type });
  }

  const item = insertPost({ id, date, caption: caption || '' }, { media });
  res.json({ ok: true, item });
});

app.patch('/api/social-calendar/:id', (req, res) => {
  if (!getPost(req.params.id)) return res.status(404).json({ error: 'Post not found' });
  const { date, caption } = req.body;
  const patch = {};
  if (date !== undefined) patch.date = date;
  if (caption !== undefined) patch.caption = caption;
  res.json({ ok: true, item: updatePost(req.params.id, patch) });
});

app.delete('/api/social-calendar/:id', (req, res) => {
  for (const filePath of softDeletePost(req.params.id)) {
    const p = path.join(SOCIAL_MEDIA_PATH, path.basename(filePath));
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  res.json({ ok: true });
});

app.get('/api/social-calendar/media/:filename', (req, res) => {
  const safeName = path.basename(req.params.filename);
  const p = path.join(SOCIAL_MEDIA_PATH, safeName);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'File not found' });
  res.sendFile(p);
});

// ── Campaign & Scheme Reports (AI-assisted political intake) ──────────────
// Mirrors the grievance universal-intake shape: any combination of typed text,
// photo(s)/PDF, and audio describing ONE campaign/scheme/cluster item is merged
// into a single AI-extracted preview record staff review and edit before saving.
// The vocabulary itself lives in server/db/campaign_reports.js, next to the
// coercion that enforces it on write — see REPORT_TAXONOMY there. These Sets are
// derived, so a route's idea of a valid type cannot disagree with the register's.
// The same object is handed to server/gemini.js as a parameter (that module
// deliberately imports nothing, so it stays lazily loadable) and served to the
// page by GET /api/campaign-reports/taxonomy.
const CAMPAIGN_REPORT_TYPES = new Set(REPORT_TAXONOMY.types.map(t => t.value));
const CAMPAIGN_REPORT_STATUSES = new Set(REPORT_TAXONOMY.statuses);
// Unified mime map for this intake's single parking path (unlike grievances, which
// split an image-only allowlist for the bulk /upload route from GRIEVANCE_AUDIO_MIMES
// for /log — campaign reports have only one intake route, so one map covers it all).
const CAMPAIGN_MEDIA_MIMES = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
  'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/flac': 'flac',
};

// NOTE ON ROUTE ORDER: /log and /pending-media/:filename must stay registered ahead
// of /:id routes below, or Express will match the literal segment as an id.

app.get('/api/campaign-reports', (req, res) => {
  const db = readDB();
  let items = db.campaign_reports || [];
  const { type, mandal, status } = req.query;
  if (type) items = items.filter(r => r.type === type);
  if (mandal) items = items.filter(r => r.mandal.toLowerCase() === mandal.toLowerCase());
  if (status) items = items.filter(r => r.status === status);
  items = items.slice().sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  res.json({ items });
});

// The taxonomy the page builds its type/status <select>s from, so those cannot
// drift from what the server validates. Mirrors GET /api/grievances/categories.
app.get('/api/campaign-reports/taxonomy', (req, res) => {
  res.json(REPORT_TAXONOMY);
});

// Universal intake — extracts a preview only, does not write to the DB.
app.post('/api/campaign-reports/log', logCampaignReportMedia, async (req, res) => {
  const text = String(req.body.text || '').trim();
  const images = req.files?.images || [];
  const audioFile = req.files?.audio?.[0];
  if (!text && !images.length && !audioFile) {
    return res.status(400).json({ error: 'Add at least one of: typed text, a photo/PDF, or audio.' });
  }
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: AI_UNCONFIGURED_ERROR });

  for (const f of images) {
    if (!CAMPAIGN_MEDIA_MIMES[f.mimetype] || f.mimetype.startsWith('audio/')) {
      return res.status(400).json({ error: `Unsupported file type: ${f.mimetype}` });
    }
  }
  let audioExt = null;
  if (audioFile) {
    audioExt = CAMPAIGN_MEDIA_MIMES[audioFile.mimetype];
    if (!audioExt || !audioFile.mimetype.startsWith('audio/')) {
      return res.status(400).json({
        error: `Unsupported audio type: ${audioFile.mimetype}. Use WAV, MP3, M4A, AAC, OGG or FLAC.`,
      });
    }
  }

  const { title, mandal, village, logged_by } = req.body;
  const known = { title, mandal, village };

  // Park every attachment to disk immediately — nothing is lost if a Gemini call
  // below fails, and it sidesteps express.json's 10mb cap for this multipart path.
  const media = [];
  try {
    images.forEach((f, i) => {
      const ext = CAMPAIGN_MEDIA_MIMES[f.mimetype];
      const filename = `tmp_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
      fs.writeFileSync(path.join(CAMPAIGN_MEDIA_PATH, filename), f.buffer);
      media.push({ pending_media: filename, mime: f.mimetype, type: f.mimetype === 'application/pdf' ? 'pdf' : 'image', label: `Attached photo ${i + 1}` });
    });
    if (audioFile) {
      const filename = `tmp_${Date.now()}_audio_${Math.random().toString(36).slice(2, 8)}.${audioExt}`;
      fs.writeFileSync(path.join(CAMPAIGN_MEDIA_PATH, filename), audioFile.buffer);
      media.push({ pending_media: filename, mime: audioFile.mimetype, type: 'audio', label: 'Voice note' });
    }
  } catch (e) {
    return res.status(500).json({ error: `Could not store attachment(s): ${e.message}` });
  }

  const gemini = await import('./gemini.js');
  const [imageResults, audioResult, textResult] = await Promise.all([
    Promise.all(images.map(async (f, i) => {
      try {
        const extracted = await gemini.extractReportFromImage(f.buffer, f.mimetype, REPORT_TAXONOMY);
        return { ok: true, idx: i, file: f.originalname, extracted };
      } catch (e) {
        return { ok: false, idx: i, file: f.originalname, error: e.message };
      }
    })),
    audioFile
      ? gemini.extractReportFromAudio(audioFile.buffer, audioFile.mimetype, REPORT_TAXONOMY)
          .then(extracted => ({ ok: true, extracted }))
          .catch(e => ({ ok: false, error: e.message }))
      : null,
    text
      ? gemini.extractReportFromText(text, REPORT_TAXONOMY)
          .then(extracted => ({ ok: true, extracted }))
          .catch(e => ({ ok: false, error: e.message }))
      : null,
  ]);

  const merged = mergeReportExtraction({ imageResults, audioResult, textResult, typedText: text, known });
  const tmp_id = `tmp${Date.now()}_0`;
  const item = {
    tmp_id,
    intake_mode: 'mixed',
    logged_by: logged_by || '',
    extracted: merged,
    media,
  };
  res.json({ ok: true, items: [item], count: 1 });
});

// Called when staff discard a preview, so abandoned attachments don't pile up.
app.delete('/api/campaign-reports/pending-media/:filename', (req, res) => {
  const safeName = path.basename(req.params.filename);
  if (!safeName.startsWith('tmp_')) return res.status(400).json({ error: 'Not a pending upload' });
  const p = path.join(CAMPAIGN_MEDIA_PATH, safeName);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  res.json({ ok: true });
});

// Merge across text/photo(s)/audio into ONE report — same discipline as
// mergeGrievanceExtraction: scalar fields first-source-wins in priority order
// image→audio→text; {type, status} chosen as one coherent bundle from a single
// richest source (never mixed); description concatenated per-source, never chosen,
// so nothing is silently dropped; staff-typed known fields always win outright.
function mergeReportExtraction({ imageResults, audioResult, textResult, typedText, known }) {
  const scalarFields = ['title', 'mandal', 'village', 'event_date', 'key_people_mentioned', 'attendance_or_beneficiaries'];
  const successfulImages = imageResults.filter(r => r.ok).map(r => r.extracted);
  const scalarSources = [
    ...successfulImages,
    ...(audioResult?.ok ? [audioResult.extracted] : []),
    ...(textResult?.ok ? [textResult.extracted] : []),
  ];

  const merged = {};
  for (const field of scalarFields) {
    merged[field] = '';
    for (const src of scalarSources) {
      if (src[field]) { merged[field] = src[field]; break; }
    }
  }

  const bundleSource = audioResult?.ok ? audioResult.extracted
    : (successfulImages[0] || (textResult?.ok ? textResult.extracted : null));
  merged.type = (bundleSource && CAMPAIGN_REPORT_TYPES.has(bundleSource.type)) ? bundleSource.type : 'Other';
  merged.status = (bundleSource && CAMPAIGN_REPORT_STATUSES.has(bundleSource.status)) ? bundleSource.status : 'Planned';
  merged.sentiment = (bundleSource && SENTIMENTS.has(bundleSource.sentiment)) ? bundleSource.sentiment : '';
  merged.confidence = bundleSource?.confidence || '';
  merged.ocr_confidence = imageResults.find(r => r.ok)?.extracted?.ocr_confidence || '';
  merged.transcript = audioResult?.ok ? (audioResult.extracted.transcript || '') : '';

  const parts = [];
  if (audioResult) {
    parts.push(audioResult.ok
      ? `[From voice note]: ${audioResult.extracted.transcript || ''}`
      : `[From voice note]: (extraction failed — ${audioResult.error})`);
  }
  if (typedText) parts.push(`[Typed note]: ${typedText}`);
  imageResults.forEach((r, i) => {
    const label = `[From attached photo ${i + 1}${r.file ? ' — ' + r.file : ''}]`;
    parts.push(r.ok
      ? `${label}: ${r.extracted.description || ''}`
      : `${label}: (extraction failed — ${r.error})`);
  });
  merged.description = parts.join('\n\n');

  for (const [k, v] of Object.entries(known)) if (v) merged[k] = v;

  return merged;
}

// Single write path into db.campaign_reports, whether committed from the AI-intake
// preview or (in future) any other source — id format and media handling can't drift.
function buildCampaignReportRecord(it, id) {
  const type = CAMPAIGN_REPORT_TYPES.has(it.type) ? it.type : 'Other';
  const status = CAMPAIGN_REPORT_STATUSES.has(it.status) ? it.status : 'Planned';
  const sentiment = SENTIMENTS.has(it.sentiment) ? it.sentiment : '';

  const media = (Array.isArray(it.media) ? it.media : []).map((m, idx) => {
    if (!m.pending_media) return null;
    const safeName = path.basename(String(m.pending_media));
    const src = path.join(CAMPAIGN_MEDIA_PATH, safeName);
    if (!fs.existsSync(src)) return null;
    const filename = `${id}_${idx}${path.extname(safeName)}`;
    try {
      fs.renameSync(src, path.join(CAMPAIGN_MEDIA_PATH, filename));
    } catch (e) {
      console.error('Failed to adopt pending campaign report media:', e.message);
      return null;
    }
    return { path: filename, mime: m.mime || '', type: m.type || 'image', label: m.label || '' };
  }).filter(Boolean);

  return {
    id,
    title: (it.title || '').trim() || '(untitled report)',
    type, status,
    mandal: (it.mandal || '').trim(), village: (it.village || '').trim(),
    description: it.description || '',
    event_date: it.event_date || '',
    key_people_mentioned: it.key_people_mentioned || '',
    attendance_or_beneficiaries: it.attendance_or_beneficiaries || '',
    sentiment, confidence: it.confidence || '', ocr_confidence: it.ocr_confidence || '',
    transcript: it.transcript || '',
    intake_mode: it.intake_mode || 'mixed',
    logged_by: it.logged_by || '',
    attachment: null, // new records never populate the legacy singular field
    media,
    created_at: new Date().toISOString(),
  };
}

// Commit the staff-reviewed/edited preview item(s) to the register.
app.post('/api/campaign-reports', (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items array required' });
  const saved = items.map(it => {
    const built = buildCampaignReportRecord(it, ulid());
    return insertReport(built, { media: built.media });
  });
  res.json({ ok: true, count: saved.length, items: saved });
});

app.patch('/api/campaign-reports/:id', (req, res) => {
  if (!getReport(req.params.id)) return res.status(404).json({ error: 'Report not found' });
  const { title, type, mandal, village, status, description } = req.body;
  const patch = {};
  if (title !== undefined) patch.title = title.trim();
  if (type !== undefined && CAMPAIGN_REPORT_TYPES.has(type)) patch.type = type;
  if (mandal !== undefined) patch.mandal = mandal.trim();
  if (village !== undefined) patch.village = village.trim();
  if (status !== undefined && CAMPAIGN_REPORT_STATUSES.has(status)) patch.status = status;
  if (description !== undefined) patch.description = description.trim();
  res.json({ ok: true, item: updateReport(req.params.id, patch) });
});

app.delete('/api/campaign-reports/:id', (req, res) => {
  for (const filePath of softDeleteReport(req.params.id)) {
    const p = path.join(CAMPAIGN_MEDIA_PATH, path.basename(filePath));
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  res.json({ ok: true });
});

app.get('/api/campaign-reports/:id/media/:index?', (req, res) => {
  const db = readDB();
  const item = getReport(req.params.id);
  if (!item) return res.status(404).json({ error: 'Report not found' });
  const idx = parseInt(req.params.index || '0', 10) || 0;
  if (item.media?.length) {
    const m = item.media[idx];
    if (!m) return res.status(404).json({ error: 'No attachment at that index' });
    const p = path.join(CAMPAIGN_MEDIA_PATH, m.path);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'File missing' });
    res.setHeader('Content-Type', m.mime || 'application/octet-stream');
    return res.sendFile(p);
  }
  if (item.attachment) {
    const p = path.join(CAMPAIGN_MEDIA_PATH, item.attachment.filename);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'File missing' });
    res.setHeader('Content-Type', item.attachment.mimetype);
    return res.sendFile(p);
  }
  res.status(404).json({ error: 'No attachment on file' });
});

// ── Ask Saathi (read-only streaming chat, admin.html) ──────────────────────
// Ported from brain's orchestrator (services/core/modules/orchestrator/router.py).
//
// The load-bearing property is not the streaming: it is that THE USER'S MESSAGE IS
// WRITTEN TO THE DATABASE BEFORE ANY MODEL IS CALLED, and that a terminal frame is
// always emitted even when the model never answered. Everything else — thread
// history, rename, archive, a bounded trash — is layered on that.
//
// Read-only by design. No tools, so the assistant can describe the register but
// can never write to it.

// Frame helper. SSE is `event: <name>\ndata: <json>\n\n`.
function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Detached writes, held at module scope. When a client disconnects mid-stream the
// request scope is torn down, so the partial reply has to be persisted outside it —
// and a reference has to be kept, or the write can be collected before it lands.
const pendingWrites = new Set();
function persistDetached(fn) {
  const task = Promise.resolve().then(fn).catch(e => console.error('chat: detached write failed:', e.message));
  pendingWrites.add(task);
  task.finally(() => pendingWrites.delete(task));
}

app.post('/api/chat', async (req, res) => {
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'message required' });
  const channel = req.body?.channel || 'web';

  // Resolve the thread and PERSIST FIRST. A Gemini timeout, a killed process or a
  // closed tab can lose the answer from here on; it can no longer lose the question.
  const conversation = req.body?.conversation_id
    ? getConversation(req.body.conversation_id)
    : resolveConversation(channel);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

  const rawEventId = rawEvents.record({
    source: 'chat', kind: 'text', sender: channel, body: message,
  });
  const userMessage = appendMessage(conversation.id, {
    role: 'user', body: message, rawEventId,
  });
  rawEvents.markStatus(rawEventId, 'compiled', { recordId: userMessage.id });

  // The thread names itself from its first message, in code — free, deterministic,
  // never a hallucination, and no latency before the first token.
  const titled = titleIfUntitled(conversation.id, message);

  // X-Accel-Buffering is not optional: nginx buffers proxied responses by default,
  // which holds every token until completion and silently defeats streaming.
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  sse(res, 'start', {
    conversation_id: conversation.id,
    message_id: userMessage.id,
    raw_event_id: rawEventId,
    title_changed: titled,
  });

  const parts = [];
  let grounding = [];
  let clientGone = false;
  let settled = false;
  // Bound before the first await, so a client that disconnects during context
  // building is still handled.
  res.on('close', () => {
    clientGone = true;
    // The reply must survive a closed tab. Without this, history keeps a question
    // with no answer, and the next turn asks the model to answer both at once.
    if (!settled && parts.length) {
      const partial = parts.join('').trim();
      if (partial) {
        persistDetached(() => appendMessage(conversation.id, {
          role: 'assistant', body: partial, model: 'gemini-flash-latest', grounding,
        }));
      }
    }
  });

  try {
    const context = buildContext(conversation.id, message, { istDate: getISTDateStr() });
    grounding = context.grounding;

    if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
    const gemini = await import('./gemini.js');

    for await (const chunk of gemini.streamChat(context.messages)) {
      if (clientGone) break;
      parts.push(chunk);
      sse(res, 'token', { text: chunk });
    }

    const body = parts.join('').trim() || FALLBACK_REPLY;
    settled = true;
    const reply = appendMessage(conversation.id, {
      role: 'assistant', body, model: 'gemini-flash-latest', grounding,
    });
    if (!clientGone) {
      sse(res, 'done', {
        conversation_id: conversation.id, message_id: reply.id,
        model: 'gemini-flash-latest', degraded: false, grounding,
      });
      res.end();
    }
  } catch (e) {
    console.error('chat: turn failed:', e.message);
    // The normal error envelope cannot be used — status and headers are already
    // sent — so a mid-stream failure is reported INSIDE the stream. A UI that only
    // stops its spinner on success would otherwise hang forever on exactly the
    // path where the user most needs to be told something broke.
    settled = true;
    const body = parts.join('').trim() || FALLBACK_REPLY;
    const reply = appendMessage(conversation.id, {
      role: 'assistant', body, model: null, grounding,
    });
    if (!clientGone) {
      sse(res, 'error', {
        code: 'chat_failed',
        message: 'The assistant could not answer. Your message was saved.',
        conversation_id: conversation.id, message_id: reply.id,
      });
      // `done` always arrives, error or not, so the client settles on one path.
      sse(res, 'done', {
        conversation_id: conversation.id, message_id: reply.id,
        model: null, degraded: true, grounding,
      });
      res.end();
    }
  }
});

// ── Conversations ──────────────────────────────────────────────────────────
// ROUTE ORDER IS LOAD-BEARING: /active and /trash must be registered BEFORE
// /:id, or the path parameter swallows them and both return "not found" for a
// conversation whose id is literally "active".

app.get('/api/conversations/active', (req, res) => {
  res.json(resolveConversation(req.query.channel || 'web'));
});

app.get('/api/conversations/trash', (req, res) => {
  res.json(listTrash({ channel: req.query.channel || 'web' }));
});

app.get('/api/conversations', (req, res) => {
  const { channel = 'web', status, limit, cursor } = req.query;
  res.json(listConversations({
    channel, status,
    limit: Math.min(parseInt(limit) || 30, 100),
    cursor,
  }));
});

app.post('/api/conversations', (req, res) => {
  const { conversation, created } = createConversation(req.body?.channel || 'web');
  // 200 rather than 201 when an unused thread was reused, so the client can tell
  // that "New chat" did not actually write a row.
  res.status(created ? 201 : 200).json(conversation);
});

app.get('/api/conversations/:id/messages', (req, res) => {
  if (!getConversation(req.params.id)) return res.status(404).json({ error: 'Conversation not found' });
  res.json(listMessages(req.params.id, {
    limit: Math.min(parseInt(req.query.limit) || 200, 500),
    cursor: req.query.cursor,
  }));
});

app.patch('/api/conversations/:id', (req, res) => {
  const { title, status } = req.body || {};
  if (status !== undefined && !['active', 'closed'].includes(status)) {
    return res.status(400).json({ error: 'status must be active or closed' });
  }
  // Only title and status are accepted. `meta` is deliberately not exposed: it is
  // server-side state, and a client that can PATCH it can set things the user
  // never saw.
  const updated = updateConversation(req.params.id, { title, status });
  if (!updated) return res.status(404).json({ error: 'Conversation not found' });
  res.json(updated);
});

app.delete('/api/conversations/:id', (req, res) => {
  if (!deleteConversation(req.params.id)) return res.status(404).json({ error: 'Conversation not found' });
  res.status(204).end();
});

app.post('/api/conversations/:id/restore', (req, res) => {
  const restored = restoreConversation(req.params.id);
  if (!restored) return res.status(404).json({ error: 'Conversation not found' });
  res.json(restored);
});

// The purge sweep runs DAILY, not on the retention cadence. A 30-day window swept
// every 30 days lets a thread live 60 — "deleted after 30 days" would be wrong by
// a factor of two.
setInterval(() => {
  try {
    const purged = purgeExpiredTrash();
    if (purged) console.log(`Purged ${purged} expired conversation(s) from the trash`);
  } catch (e) {
    console.error('Conversation trash sweep failed:', e.message);
  }
}, 24 * 60 * 60 * 1000).unref();


app.get('/api/stats', (req, res) => {
  const db = readDB();
  const c = db.contacts || [];
  res.json({
    total: c.length,
    t1: c.filter(x => x.tier === 'T1').length,
    t2: c.filter(x => x.tier === 'T2').length,
    t3: c.filter(x => x.tier === 'T3').length,
    tdp: c.filter(x => x.party === 'TDP').length,
    ysrcp: c.filter(x => x.party === 'YSRCP').length,
    with_grievances: c.filter(x => x.open_grievance).length,
    open_grievances_register: (db.grievances || []).filter(g => g.resolution_status !== 'Resolved' && (g.entry_type || 'grievance') === 'grievance').length,
    feedback_count: (db.grievances || []).filter(g => g.entry_type === 'feedback').length,
    news_count: (db.news || []).length,
    schedule_count: (db.schedule || []).length,
  });
});

// Stage 2 outcomes: which villages/mandals/cohorts the team is actually engaging
// (inferred from schedule events — no separate attendance-tracking step), and which
// are being neglected. Also surfaces individual "Influencer"-role contacts going
// stale, reusing the existing days_since_contact field.
app.get('/api/coverage-report', (req, res) => {
  const db = readDB();
  const staleDays = parseInt(req.query.stale_days, 10) || 90;
  const staleCutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const contacts = db.contacts || [];
  const events = db.schedule || [];

  // Universe = places that matter (have contacts), joined against actual visits —
  // same case-insensitive matching level already used by the nearby-contacts finder.
  // contextField carries along a secondary field (e.g. a village's mandal) so a bare
  // place name isn't ambiguous once the list runs into the hundreds (villages reuse
  // names across mandals; mandals don't need this, so contextField is optional).
  function buildPlaceCoverage(field, contextField) {
    const universe = new Map();
    for (const c of contacts) {
      const v = (c[field] || '').trim();
      if (!v) continue;
      const key = v.toLowerCase();
      if (!universe.has(key)) {
        universe.set(key, { name: v, context: contextField ? (c[contextField] || '').trim() : '' });
      }
    }
    const visits = new Map();
    for (const ev of events) {
      const v = (ev[field] || '').trim();
      if (!v) continue;
      const key = v.toLowerCase();
      const u = universe.get(key);
      const name = u ? u.name : v;
      const context = u ? u.context : (contextField ? (ev[contextField] || '').trim() : '');
      const entry = visits.get(key) || { name, context, visit_count: 0, last_visit_date: '' };
      entry.visit_count += 1;
      if (!entry.last_visit_date || ev.date > entry.last_visit_date) entry.last_visit_date = ev.date;
      visits.set(key, entry);
    }
    const visited = [...visits.values()].sort((a, b) => (a.last_visit_date || '').localeCompare(b.last_visit_date || ''));
    const never_visited = [...universe.entries()]
      .filter(([key]) => !visits.has(key))
      .map(([, u]) => ({ name: u.name, context: u.context }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const stale = visited.filter(v => v.last_visit_date && v.last_visit_date < staleCutoff);
    return { visited, never_visited, stale };
  }

  const mandals = buildPlaceCoverage('mandal');
  const villages = buildPlaceCoverage('village', 'mandal');

  const cohortStats = new Map(COHORTS.map(c => [c.key, { ...c, meeting_count: 0, last_meeting_date: '' }]));
  for (const ev of events) {
    const entry = cohortStats.get(ev.audience_cohort);
    if (!entry) continue;
    entry.meeting_count += 1;
    if (!entry.last_meeting_date || ev.date > entry.last_meeting_date) entry.last_meeting_date = ev.date;
  }
  const cohorts = [...cohortStats.values()].sort((a, b) => (a.last_meeting_date || '').localeCompare(b.last_meeting_date || ''));
  const never_engaged_cohorts = cohorts.filter(c => c.meeting_count === 0).map(({ key, label, group }) => ({ key, label, group }));

  const stale_influencers = contacts
    .filter(c => c.role === 'Influencer')
    .slice()
    .sort((a, b) => (b.days_since_contact ?? 0) - (a.days_since_contact ?? 0))
    .slice(0, 25)
    .map(c => ({
      id: c.id, name: c.name, phone: c.phone, village: c.village, mandal: c.mandal,
      days_since_contact: c.days_since_contact ?? null, pps_score: c.pps_score,
    }));

  res.json({ stale_days: staleDays, mandals, villages, cohorts, never_engaged_cohorts, stale_influencers });
});

// ── Google News RSS ────────────────────────────────────────────────────────
app.get('/api/live-news', async (req, res) => {
  try {
    const items = await fetchGoogleNews();
    res.json({ news: items, cached: (Date.now() - newsCache.fetchedAt) < 1000 ? false : true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch news', detail: e.message });
  }
});

// On-demand full-article fetch — deliberately per-item, never batch. Google News RSS only
// gives a title + link, so "more detail" has to mean actually reading the article behind the
// link, not scraping every refresh (slow, flaky on regional sites, and a ToS grey area at scale).
const articleExtractCache = new Map(); // resolved url -> { title, excerpt, text, fetchedAt }
const ARTICLE_CACHE_MS = 60 * 60 * 1000; // 1 hour

app.get('/api/live-news/extract', async (req, res) => {
  const link = req.query.link;
  if (!link) return res.status(400).json({ error: 'link required' });

  try {
    const resolved = await resolveNewsLink(link);
    const cached = articleExtractCache.get(resolved);
    if (cached && (Date.now() - cached.fetchedAt) < ARTICLE_CACHE_MS) {
      return res.json({ ok: true, ...cached, url: resolved, cached: true });
    }

    const resp = await fetch(resolved, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SaathiBriefBot/1.0)' },
    });
    if (!resp.ok) throw new Error(`Article page returned ${resp.status}`);
    const html = await resp.text();

    const { JSDOM } = require('jsdom');
    const { Readability } = require('@mozilla/readability');
    const dom = new JSDOM(html, { url: resolved });
    const article = new Readability(dom.window.document).parse();

    if (!article || !article.textContent || article.textContent.trim().length < 40) {
      const hint = resolved.includes('news.google.com')
        ? 'Google News links open the real article via JavaScript in a browser, so this server can\'t pull the text — open the link directly to read it.'
        : 'Could not extract readable article text from this page.';
      return res.status(422).json({ error: hint });
    }

    const result = {
      title: article.title || '',
      excerpt: stripHtml(article.excerpt || '').slice(0, 300),
      text: stripHtml(article.textContent).slice(0, 4000),
      fetchedAt: Date.now(),
    };
    articleExtractCache.set(resolved, result);
    res.json({ ok: true, ...result, url: resolved, cached: false });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch/extract article: ' + e.message });
  }
});

// normalizePhone is shared grievance-duplicate-detection infrastructure (findGrievanceDuplicates
// below matches on it) — not WhatsApp-specific, kept even though WhatsApp/broadcast is gone.
function normalizePhone(phone) {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits[0] === '0') return `91${digits.slice(1)}`;
  return digits; // already has country code or unusual format
}

// ── News Brief PDF parser ───────────────────────────────────────────────────
function parseNewsBriefText(rawText) {
  const rawLines = rawText.split('\n').map(l => l.trim()).filter(Boolean);

  // Extract date
  const dateMatch = rawText.match(/Date[:\s]+(.+)/i);
  const briefDate = dateMatch ? dateMatch[1].trim() : '';

  // Collect all URLs in document order — PDFs sometimes split URLs across lines,
  // so first join fragments (a line with no spaces immediately following a partial URL).
  const joinedLines = [];
  for (const line of rawLines) {
    if (joinedLines.length > 0) {
      const prev = joinedLines[joinedLines.length - 1];
      if (/^https?:\/\//.test(prev) && !line.includes(' ') &&
          /^[a-zA-Z0-9\/\-\._?=%&#]+$/.test(line)) {
        joinedLines[joinedLines.length - 1] = prev + line;
        continue;
      }
    }
    joinedLines.push(line);
  }

  // All HTTP links in order — item N gets allLinks[N-1]
  const allLinks = joinedLines.filter(l => /^https?:\/\//.test(l));

  // Text lines with noise and URLs stripped
  const NOISE = new Set([
    'Sl.', 'No.', 'Topic', 'News Summary', 'Link',
    'National News', 'International News',
    'Topic News Summary Link', 'Sl. No. Topic News Summary Link',
    'Sl. No.', 'Topic News Summary Link',
  ]);
  const textLines = joinedLines.filter(l =>
    !NOISE.has(l) && !/^Date[:\s]/i.test(l) && !/^https?:\/\//.test(l));

  const items = [];
  let i = 0;

  while (i < textLines.length) {
    if (!/^\d+$/.test(textLines[i])) { i++; continue; }
    const serialNum = parseInt(textLines[i], 10);
    i++;

    const chunk = [];
    while (i < textLines.length && !/^\d+$/.test(textLines[i])) {
      chunk.push(textLines[i]);
      i++;
    }
    if (!chunk.length) continue;

    // Match link by serial number (1-indexed)
    const link = allLinks[serialNum - 1] || '';
    const category = link.includes('/international/') ? 'International' : 'National';

    // Split topic (short title-case phrases) from body (sentence prose)
    const topicParts = [];
    const bodyParts = [];
    let inBody = false;
    for (const ln of chunk) {
      if (!inBody) {
        const words = ln.split(/\s+/);
        const hasMidLower = words.slice(1).some(w => /^[a-z]/.test(w) && w.length > 2);
        if (hasMidLower || ln.length > 60) { inBody = true; bodyParts.push(ln); }
        else topicParts.push(ln);
      } else {
        bodyParts.push(ln);
      }
    }

    const headline = topicParts.join(' ').trim();
    const body = bodyParts.join(' ').trim();
    if (headline || body) {
      items.push({ serialNum, headline: headline || body.slice(0, 80), body, link, category, briefDate });
    }
  }

  // Ensure order matches the PDF's serial numbers
  items.sort((a, b) => a.serialNum - b.serialNum);

  return { briefDate, items };
}

// Fallback for simpler PDFs that are just a flat "title / link" list — no serial numbers,
// no Topic/Summary columns, no National/International sections. Each item is either a single
// line "<headline> <url>" or a headline line immediately followed by a URL-only line.
function parseGenericTitleLinkList(rawText) {
  const rawLines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
  const URL_RE = /(https?:\/\/\S+)/;
  const HEADER_RE = /^(title|headline|topic)\s+(link|url)$/i;

  const items = [];
  let pendingHeadline = '';

  for (const line of rawLines) {
    if (HEADER_RE.test(line)) continue;

    const match = line.match(URL_RE);
    if (!match) {
      pendingHeadline = line;
      continue;
    }

    const link = match[1].trim();
    const before = line.slice(0, match.index).trim();
    const headline = (before || pendingHeadline).replace(/[-–:\s]+$/, '').trim();
    pendingHeadline = '';
    if (!headline) continue;

    items.push({ serialNum: items.length + 1, headline, body: '', link, category: '' });
  }

  return { briefDate: '', items };
}

app.post('/api/upload-news-brief', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'PDF file required' });
  if (!req.file.originalname.toLowerCase().endsWith('.pdf'))
    return res.status(400).json({ error: 'Only PDF files are accepted' });

  try {
    const pdfParse = require('pdf-parse/lib/pdf-parse.js');
    const parsed = await pdfParse(req.file.buffer);
    let { briefDate, items } = parseNewsBriefText(parsed.text);

    if (!items.length) {
      const generic = parseGenericTitleLinkList(parsed.text);
      items = generic.items;
      if (!briefDate) briefDate = generic.briefDate;
    }

    if (!items.length)
      return res.status(422).json({ error: 'No news items found. Make sure this is a News Brief PDF.' });

    if (req.query.preview === '1')
      return res.json({ ok: true, briefDate, items, count: items.length });

    // Commit to DB
    const db = readDB();
    const saved = items.map(item => {
      const dateLabel = item.briefDate || briefDate;
      const sourceParts = ['Brief', item.category, dateLabel].filter(Boolean);
      return insertNews({
        headline: item.headline,
        body: item.body,
        source: sourceParts.join(' · '),
        // `category` held 'National'/'International' and was ALSO written into
        // `mandal`, which is the overload the `scope` column now replaces.
        scope: String(item.category || 'National').toLowerCase(),
        mandal: 'General',
        priority: 'high',
        link: item.link || '',
        submitted_at: new Date().toISOString(),
      });
    });

    res.json({ ok: true, count: saved.length, briefDate });
  } catch (e) {
    res.status(500).json({ error: 'PDF parse failed: ' + e.message });
  }
});

function parseNewsExcel(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const items = [];
  wb.SheetNames.forEach((sheetName, sheetIdx) => {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
    for (const row of rows) {
      const byKey = {};
      for (const key of Object.keys(row)) byKey[key.trim().toLowerCase()] = row[key];
      const headline = String(byKey['title'] || '').trim();
      if (!headline) continue;
      const category = sheetIdx === 0
        ? 'District'
        : normalizeCategory(byKey['category'] || byKey['type']);
      items.push({
        headline,
        link: String(byKey['link'] || '').trim(),
        source: String(byKey['websource'] || '').trim(),
        body: String(byKey['description'] || byKey['desc'] || byKey['summary'] || '').trim(),
        category,
      });
    }
  });
  return items;
}

app.post('/api/upload-news-excel', upload.single('excel'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Excel file required' });
  const name = req.file.originalname.toLowerCase();
  if (!name.endsWith('.xlsx') && !name.endsWith('.xls'))
    return res.status(400).json({ error: 'Only .xlsx or .xls files are accepted' });

  try {
    const items = parseNewsExcel(req.file.buffer);
    if (!items.length)
      return res.status(422).json({ error: 'No news items found. Make sure the sheet has title/link/websource columns.' });

    if (req.query.preview === '1')
      return res.json({ ok: true, items, count: items.length });

    // Commit to DB
    const saved = items.map(item => insertNews({
      headline: item.headline,
      body: item.body || '',
      source: item.source || 'Excel import',
      // scope is the category axis (district/state/national/international) -
      // all four are real SCOPES values now, see server/db/news.js. mandal is
      // the *place* axis and the tracker's spreadsheet carries no place column,
      // so it stays 'General'. Do not read the category back off mandal: that
      // was the old db.json overload, and the News Dashboard still filtering on
      // it is what made these categories look like they had vanished.
      scope: String(item.category || 'national').toLowerCase(),
      mandal: 'General',
      priority: 'medium',
      link: item.link || '',
      submitted_at: new Date().toISOString(),
    }));

    res.json({ ok: true, count: saved.length });
  } catch (e) {
    res.status(500).json({ error: 'Excel parse failed: ' + e.message });
  }
});

// ── Daily brief PDF ─────────────────────────────────────────────────────────
function metByForTier(tier) {
  if (tier === 'T1') return 'MP personally';
  if (tier === 'T2') return 'PA / team';
  return 'WhatsApp / call';
}

function formatDateLong(dateStr) {
  // dateStr is YYYY-MM-DD; build the Date at noon UTC so timezone shifts can't roll it to the
  // previous/next day.
  const d = new Date(`${dateStr}T12:00:00Z`);
  return d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

const PDF_LEFT = 40, PDF_RIGHT = 555, PDF_WIDTH = PDF_RIGHT - PDF_LEFT;
// Per-category ceiling for the auto (nobody-picked-anything) news section.
// Four categories, so the brief stays bounded at 20 items.
const PDF_NEWS_PER_CATEGORY = 5;
const PDF_COLORS = {
  amber: '#B45309', amberTint: '#FFF7ED', amberBorder: '#B45309',
  ink: '#1F2937', slate: '#475569', green: '#15803D',
  grievance: '#92400E', linkBlue: '#1D4ED8', white: '#ffffff',
};

function buildBriefPDF(doc, db, dateStr, liveNews) {
  let teluguFontOk = false;
  try {
    doc.registerFont('Body', TELUGU_FONT_PATH);
    doc.registerFont('Body-Bold', TELUGU_FONT_PATH); // the variable font has no separate bold instance; weight comes from size/color
    teluguFontOk = true;
  } catch {
    // Falls back to PDFKit's built-in Helvetica — Telugu names will render as boxes, but the
    // PDF still generates rather than failing outright.
  }
  const bodyFont = teluguFontOk ? 'Body' : 'Helvetica';
  const boldFont = teluguFontOk ? 'Body-Bold' : 'Helvetica-Bold';
  const C = PDF_COLORS;

  function safeText(text, opts) {
    try { doc.text(text, opts); }
    catch { doc.font('Helvetica').fontSize(9).text(text, opts); doc.font(bodyFont); }
  }
  function safeHeight(text, opts) {
    try { return doc.heightOfString(text, opts); }
    catch { return Math.ceil(text.length / 80) * 14; }
  }

  const events = (db.schedule || [])
    .filter(s => s.date === dateStr)
    .sort((a, b) => parseTimeToMinutes(a.time) - parseTimeToMinutes(b.time));

  // ── Header band ──────────────────────────────────────────────────────────
  doc.rect(0, 0, doc.page.width, 86).fill(C.slate);
  doc.fillColor(C.white).font(boldFont).fontSize(20).text('The morning brief', PDF_LEFT, 24);
  doc.font(bodyFont).fontSize(11).fillColor('#FFF7ED').text('Narasaraopet Constituency · Palnadu District', PDF_LEFT, 52);
  doc.y = 104;
  doc.x = PDF_LEFT;

  // ── Greeting ─────────────────────────────────────────────────────────────
  // Plain text only — the bundled variable Telugu font is not guaranteed to carry emoji glyphs.
  const mpName = db.metadata?.mp_name;
  doc.font(boldFont).fontSize(13).fillColor(C.amber).text(`good morning sir`, PDF_LEFT);
  doc.font(bodyFont).fontSize(11).fillColor(C.ink).text(`Here is your brief for ${formatDateLong(dateStr)}.`, PDF_LEFT);
  const preparedAt = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
  doc.fontSize(9).fillColor(C.slate).text(`Prepared ${preparedAt} IST · ${events.length} engagement${events.length === 1 ? '' : 's'}`, PDF_LEFT);
  doc.moveDown(0.8);

  if (events.length === 0) {
    doc.font(bodyFont).fontSize(11).fillColor(C.ink).text('No engagements scheduled for this date.', PDF_LEFT);
  }

  const contactsById = new Map(db.contacts.map(c => [c.id, c]));

  events.forEach((event, i) => {
    if (doc.y > doc.page.height - 160) doc.addPage();

    const boxStartPage = doc.bufferedPageRange().count + doc._pageBufferStart;
    const boxTop = doc.y;
    const titleStripHeight = 24;

    doc.rect(PDF_LEFT, boxTop, PDF_WIDTH, titleStripHeight).fill(C.slate);
    doc.fillColor(C.white).font(boldFont).fontSize(10.5)
      .text(`${i + 1}. ${event.event_name}${event.time ? ' · ' + formatTime12h(event.time) : ''}${event.event_type ? ' · ' + event.event_type : ''}`,
        PDF_LEFT + 10, boxTop + 6, { width: PDF_WIDTH - 20 });

    doc.x = PDF_LEFT + 12;
    doc.y = boxTop + titleStripHeight + 8;

    const venue = [event.village, event.mandal].filter(Boolean).join(', ');
    if (venue) doc.font(bodyFont).fontSize(9).fillColor(C.slate).text(`Venue: ${venue}`, { width: PDF_WIDTH - 24 });
    if (event.description) doc.font(bodyFont).fontSize(9).fillColor(C.ink).text(event.description, { width: PDF_WIDTH - 24 });
    doc.moveDown(0.4);

    const allContacts = event.nearby_contacts || [];
    const shown = allContacts.slice(0, 8);
    if (shown.length) {
      doc.x = PDF_LEFT + 12;
      doc.font(boldFont).fontSize(9).fillColor(C.green).text('CONTACTS TO MEET', { width: PDF_WIDTH - 24 });
      doc.moveDown(0.15);
      shown.forEach(nc => {
        if (doc.y > doc.page.height - 60) doc.addPage();
        const c = contactsById.get(nc.id);
        const manualBrief = nc.event_brief && nc.event_brief.trim();
        const fallbackBrief = c?.manual_brief || c?.remarks || c?.ai_reason || '';
        const briefText = manualBrief || fallbackBrief;
        const isAuto = !manualBrief;

        const metByText = nc.tier === 'T1' ? '' : ` · Met by: ${metByForTier(nc.tier)}`;
        const metaStr = `  ${nc.tier} · ${nc.role || ''}${metByText}${nc.phone ? ' · ' + nc.phone : ''}`;

        doc.x = PDF_LEFT + 12;
        doc.font(boldFont).fontSize(9.5).fillColor(C.ink);
        safeText(nc.name, { width: PDF_WIDTH - 24 });
        doc.x = PDF_LEFT + 12;
        doc.font(bodyFont).fontSize(8.5).fillColor(C.slate);
        safeText(metaStr.trim(), { width: PDF_WIDTH - 24 });
        if (briefText) {
          doc.x = PDF_LEFT + 12;
          doc.font(bodyFont).fontSize(8.5).fillColor(isAuto ? '#9ca3af' : C.ink);
          safeText(`${isAuto ? '(auto-draft) ' : ''}${briefText}`, { width: PDF_WIDTH - 24 });
        }
        if (nc.open_grievance) {
          doc.x = PDF_LEFT + 12;
          doc.font(boldFont).fontSize(8.5).fillColor(C.grievance);
          safeText(`Open issue: ${nc.open_grievance}`, { width: PDF_WIDTH - 24 });
        }
        doc.moveDown(0.35);
      });
      if (allContacts.length > shown.length) {
        doc.x = PDF_LEFT + 12;
        doc.font(bodyFont).fontSize(9).fillColor('#9ca3af')
          .text(`+ ${allContacts.length - shown.length} more priority contacts in the app.`, { width: PDF_WIDTH - 24 });
      }
      doc.moveDown(0.3);
    }

    if (event.speech_points && event.speech_points.trim()) {
      if (doc.y > doc.page.height - 80) doc.addPage();
      doc.x = PDF_LEFT + 12;
      doc.font(boldFont).fontSize(9).fillColor(C.green);
      safeText('SPEECH POINTS', { width: PDF_WIDTH - 24 });
      doc.font(bodyFont).fontSize(9).fillColor(C.ink);
      const spW = PDF_WIDTH - 24;
      const paras = event.speech_points.split(/\n/);
      paras.forEach(para => {
        if (!para.trim()) { doc.moveDown(0.3); return; }
        const pH = safeHeight(para, { width: spW });
        if (doc.y + pH > doc.page.height - 40) doc.addPage();
        doc.x = PDF_LEFT + 12;
        safeText(para, { width: spW });
      });
      doc.moveDown(0.3);
    }

    const selected = event.creative_touches?.selected || [];
    const custom = event.creative_touches?.custom || [];
    if (selected.length || custom.length) {
      if (doc.y > doc.page.height - 80) doc.addPage();
      const suggestionLabels = buildCreativeSuggestions(event.event_type, allContacts)
        .filter(s => selected.includes(s.id)).map(s => s.label);
      doc.x = PDF_LEFT + 12;
      doc.font(boldFont).fontSize(9).fillColor(C.green);
      safeText('CREATIVE TOUCHES', { width: PDF_WIDTH - 24 });
      [...suggestionLabels, ...custom].forEach(label => {
        if (doc.y > doc.page.height - 40) doc.addPage();
        doc.x = PDF_LEFT + 12;
        doc.font(bodyFont).fontSize(9).fillColor(C.ink);
        safeText(`• ${label}`, { width: PDF_WIDTH - 24 });
      });
      doc.moveDown(0.3);
    }

    // Draw event border — single-page gets a rounded rect, cross-page gets a bottom line only.
    // NEVER use doc.save()/doc.restore() — it resets fill colors and blanks subsequent content.
    const boxEndPage = doc.bufferedPageRange().count + doc._pageBufferStart;
    const boxBottom = doc.y + 6;

    doc.lineWidth(1).strokeColor(C.amberBorder);
    if (boxEndPage === boxStartPage) {
      doc.roundedRect(PDF_LEFT, boxTop, PDF_WIDTH, boxBottom - boxTop, 4).stroke();
    } else {
      doc.moveTo(PDF_LEFT, boxBottom).lineTo(PDF_LEFT + PDF_WIDTH, boxBottom).stroke();
    }

    doc.x = PDF_LEFT;
    doc.y = boxBottom + 14;
    doc.fillColor(C.ink).strokeColor(C.ink);
  });

  // News — shared across the whole day. PA-picked items win; fall back to the top auto-scraped
  // items (clearly labelled) only if nobody picked any for any event that day.
  const pickedNews = [];
  const seenLinks = new Set();
  events.forEach(ev => (ev.news_selected || []).forEach(n => {
    if (n.link && !seenLinks.has(n.link)) {
      seenLinks.add(n.link);
      pickedNews.push(n);
    } else if (!n.link) {
      pickedNews.push(n);
    }
  }));
  const fieldNewsForPdf = (db.news || [])
    .filter(n => {
      if (!n.submitted_at) return false;
      const nDate = new Date(n.submitted_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      return nDate === dateStr || nDate === getISTDateStr();
    })
    .map(n => ({ title: n.headline, link: n.link || '', source: n.source || 'Field report', category: newsCategory(n), body: n.body || '' }));

  const newsIsAuto = pickedNews.length === 0;
  // No flat cap here any more: slicing before the grouping below meant whichever
  // category sorted first ate the whole allowance and the rest of the headings
  // never rendered. The auto list is capped per category instead (see
  // PDF_NEWS_PER_CATEGORY), so every category with news is represented.
  const newsToShow = newsIsAuto ? [...fieldNewsForPdf, ...(liveNews || [])] : pickedNews;

  if (newsToShow.length) {
    if (doc.y > doc.page.height - 120) doc.addPage();
    doc.x = PDF_LEFT;
    const newsLabel = newsIsAuto
      ? (fieldNewsForPdf.length ? ' (field reports + auto-scraped)' : ' (auto-scraped — not reviewed)')
      : '';
    doc.x = PDF_LEFT;
    doc.font(boldFont).fontSize(12).fillColor(C.green).text(`News for this brief${newsLabel}`, { width: PDF_WIDTH });
    doc.moveDown(0.2);

    const grouped = {};
    newsToShow.forEach(n => {
      const cat = newsCategory(n);
      (grouped[cat] = grouped[cat] || []).push(n);
    });

    CATEGORY_ORDER.forEach(cat => {
      // Picked news is never truncated — the PA chose those items deliberately.
      const list = newsIsAuto
        ? (grouped[cat] || []).slice(0, PDF_NEWS_PER_CATEGORY)
        : (grouped[cat] || []);
      if (!list.length) return;

      if (doc.y > doc.page.height - 60) doc.addPage();
      doc.x = PDF_LEFT;
      doc.font(boldFont).fontSize(9.5).fillColor(C.green).text(cat.toUpperCase(), { width: PDF_WIDTH });
      doc.moveDown(0.1);

      list.forEach((n, i) => {
        if (doc.y > doc.page.height - 40) doc.addPage();
        const title = n.title || n.headline || 'News item';
        const sourceStr = n.source ? ` (${n.source})` : '';
        doc.x = PDF_LEFT;
        doc.font(bodyFont).fontSize(9).fillColor(C.ink);
        safeText(`${i + 1}. ${title}${sourceStr}`, { width: PDF_WIDTH });

        if (n.link) {
          if (doc.y > doc.page.height - 40) doc.addPage();
          doc.x = PDF_LEFT + 10;
          doc.font(bodyFont).fontSize(8).fillColor(C.linkBlue);
          safeText(n.link, { width: PDF_WIDTH - 10, link: n.link, underline: true });
        }

        if (n.body) {
          if (doc.y > doc.page.height - 40) doc.addPage();
          doc.x = PDF_LEFT + 10;
          doc.font(bodyFont).fontSize(8.5).fillColor('#9ca3af');
          const snippet = n.body.length > 200 ? n.body.slice(0, 200) + '…' : n.body;
          safeText(snippet, { width: PDF_WIDTH - 10 });
        }

        doc.fillColor(C.ink);
        doc.moveDown(0.2);
      });
    });
  }
}

app.get('/api/brief-pdf', async (req, res) => {
  const dateStr = req.query.date || getISTDateStr();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });

  const db = readDB();
  let liveNews = [];
  try { liveNews = await fetchGoogleNews(db); } catch { /* news is best-effort in the PDF too */ }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="saathi-brief-${dateStr}.pdf"`);

  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  doc.pipe(res);
  try {
    buildBriefPDF(doc, db, dateStr, liveNews);
  } catch (e) {
    console.error('PDF generation error:', e);
  }
  doc.end();
});

function buildTtdRegisterPDF(doc, letters, from, to) {
  let teluguFontOk = false;
  try {
    doc.registerFont('Body', TELUGU_FONT_PATH);
    doc.registerFont('Body-Bold', TELUGU_FONT_PATH);
    teluguFontOk = true;
  } catch { /* falls back to Helvetica */ }
  const bodyFont = teluguFontOk ? 'Body' : 'Helvetica';
  const boldFont = teluguFontOk ? 'Body-Bold' : 'Helvetica-Bold';
  const C = PDF_COLORS;

  const cols = [
    { label: 'Date', width: 55 },
    { label: 'Name', width: 95 },
    { label: 'Phone', width: 65 },
    { label: 'Aadhar', width: 78 },
    { label: 'Reference', width: 78 },
    { label: 'Type', width: 68 },
    { label: 'Status', width: 55 },
  ];

  function drawRow(values, font, size, color) {
    doc.font(font).fontSize(size).fillColor(color);
    const y = doc.y;
    let x = PDF_LEFT;
    cols.forEach((c, i) => {
      doc.text(String(values[i] ?? ''), x, y, { width: c.width - 6, lineBreak: false, ellipsis: true });
      x += c.width;
    });
    doc.y = y + size + 8;
  }

  doc.rect(0, 0, doc.page.width, 70).fill(C.slate);
  doc.fillColor(C.white).font(boldFont).fontSize(17).text('TTD Reference Letters — Register', PDF_LEFT, 22);
  doc.font(bodyFont).fontSize(10).fillColor('#FFF7ED').text(
    (from || to) ? `${from || 'start'} to ${to || 'today'}` : 'All records', PDF_LEFT, 46
  );
  doc.y = 92;
  doc.x = PDF_LEFT;

  drawRow(cols.map(c => c.label), boldFont, 9, C.green);

  doc.font(bodyFont).fontSize(8.5).fillColor(C.ink);
  letters.forEach(l => {
    if (doc.y > doc.page.height - 40) {
      doc.addPage();
      doc.y = 40;
      drawRow(cols.map(c => c.label), boldFont, 9, C.green);
    }
    const maskedAadhar = l.aadhar ? `••••${String(l.aadhar).slice(-4)}` : '';
    drawRow([l.date, l.name, l.phone, maskedAadhar, l.reference, l.darshan_type, ttdStatus(l.date)], bodyFont, 8.5, C.ink);
  });

  if (!letters.length) {
    doc.font(bodyFont).fontSize(10).fillColor(C.ink).text('No letters in this range.', PDF_LEFT, doc.y + 6);
  }
}

function darshanLabel(type) {
  return type === 'Supadam' ? 'Supadam (Suprabhata Seva)' : (type || 'Special Darshan');
}
function buildTtdLetterPDF(doc, letter, mpName) {
  let teluguFontOk = false;
  try {
    doc.registerFont('Body', TELUGU_FONT_PATH);
    doc.registerFont('Body-Bold', TELUGU_FONT_PATH);
    teluguFontOk = true;
  } catch { /* falls back to Helvetica */ }
  const bodyFont = teluguFontOk ? 'Body' : 'Helvetica';
  const boldFont = teluguFontOk ? 'Body-Bold' : 'Helvetica-Bold';
  const C = PDF_COLORS;

  doc.font(boldFont).fontSize(14).fillColor(C.ink)
    .text(mpName || 'Member of Parliament, Palnadu', PDF_LEFT, 40, { width: PDF_WIDTH, align: 'center' });
  doc.font(bodyFont).fontSize(10).fillColor(C.slate)
    .text('Narasaraopet Constituency · Palnadu District', PDF_LEFT, doc.y, { width: PDF_WIDTH, align: 'center' });
  doc.moveDown(2);
  doc.x = PDF_LEFT;

  doc.font(bodyFont).fontSize(10).fillColor(C.ink);
  doc.text(`Reference No: ${letter.reference}`, PDF_LEFT);
  doc.text(`Date: ${formatDateLong(letter.date)}`, PDF_LEFT);
  doc.moveDown(1.5);

  doc.text('To,', PDF_LEFT);
  doc.text('The Executive Officer,', PDF_LEFT);
  doc.text('Tirumala Tirupati Devasthanams (TTD),', PDF_LEFT);
  doc.text('Tirumala.', PDF_LEFT);
  doc.moveDown(1.5);

  doc.font(boldFont).text(`Sub: Recommendation for ${darshanLabel(letter.darshan_type)}`, PDF_LEFT, doc.y, { underline: true });
  doc.moveDown(1);

  doc.font(bodyFont).text('Respected Sir/Madam,', PDF_LEFT);
  doc.moveDown(0.5);
  doc.text(
    `This is to recommend ${letter.name}` +
    `${letter.aadhar ? ` (Aadhar No. ${letter.aadhar})` : ''}` +
    `${letter.phone ? `, contact number ${letter.phone},` : ''} for ${darshanLabel(letter.darshan_type)} ` +
    `at Tirumala on ${formatDateLong(letter.date)}. Kind cooperation in this regard is requested.`,
    PDF_LEFT, doc.y, { width: PDF_WIDTH, align: 'justify' }
  );

  if (letter.remarks) {
    doc.moveDown(0.8);
    doc.text(`Remarks: ${letter.remarks}`, PDF_LEFT, doc.y, { width: PDF_WIDTH });
  }
  if (letter.referred_by) {
    doc.moveDown(0.5);
    doc.text(`Referred by: ${letter.referred_by}`, PDF_LEFT, doc.y, { width: PDF_WIDTH });
  }

  doc.moveDown(3);
  doc.font(bodyFont).text('Thanking you,', PDF_LEFT);
  doc.moveDown(2);
  doc.font(boldFont).text(mpName || 'Member of Parliament', PDF_LEFT);
  doc.font(bodyFont).fontSize(9).fillColor(C.slate).text('Palnadu Parliamentary Constituency', PDF_LEFT);

  doc.fontSize(8).fillColor('#9ca3af').text(
    '(Draft v1 letter format — wording to be finalized.)',
    PDF_LEFT, doc.page.height - 60, { width: PDF_WIDTH, align: 'center' }
  );
}

// "Draft letter to department" — advisory AI-drafted letter for a grievance's
// category, addressed via that category's department/department_head. Modeled
// closely on buildTtdLetterPDF above (same layout constants/font/disclaimer).
function buildDepartmentLetterPDF(doc, grievance, departmentInfo, mpName) {
  let teluguFontOk = false;
  try {
    doc.registerFont('Body', TELUGU_FONT_PATH);
    doc.registerFont('Body-Bold', TELUGU_FONT_PATH);
    teluguFontOk = true;
  } catch { /* falls back to Helvetica */ }
  const bodyFont = teluguFontOk ? 'Body' : 'Helvetica';
  const boldFont = teluguFontOk ? 'Body-Bold' : 'Helvetica-Bold';
  const C = PDF_COLORS;

  doc.font(boldFont).fontSize(14).fillColor(C.ink)
    .text(mpName || 'Member of Parliament, Palnadu', PDF_LEFT, 40, { width: PDF_WIDTH, align: 'center' });
  doc.font(bodyFont).fontSize(10).fillColor(C.slate)
    .text('Narasaraopet Constituency · Palnadu District', PDF_LEFT, doc.y, { width: PDF_WIDTH, align: 'center' });
  doc.moveDown(2);
  doc.x = PDF_LEFT;

  doc.font(bodyFont).fontSize(10).fillColor(C.ink);
  doc.text(`Ref: ${grievance.id}`, PDF_LEFT);
  doc.text(`Date: ${formatDateLong(getISTDateStr())}`, PDF_LEFT);
  doc.moveDown(1.5);

  doc.text('To,', PDF_LEFT);
  doc.text(`${departmentInfo.department_head},`, PDF_LEFT);
  doc.text(`${departmentInfo.department},`, PDF_LEFT);
  doc.text(`${grievance.mandal || grievance.village || 'Palnadu District'}.`, PDF_LEFT);
  doc.moveDown(1.5);

  doc.font(boldFont).text(`Sub: ${grievance.drafted_letter_subject}`, PDF_LEFT, doc.y, { underline: true, width: PDF_WIDTH });
  doc.moveDown(1);

  doc.font(bodyFont).text('Respected Sir/Madam,', PDF_LEFT);
  doc.moveDown(0.5);
  doc.text(grievance.drafted_letter_body, PDF_LEFT, doc.y, { width: PDF_WIDTH, align: 'justify' });

  doc.moveDown(3);
  doc.font(bodyFont).text('Thanking you,', PDF_LEFT);
  doc.moveDown(2);
  doc.font(boldFont).text(mpName || 'Member of Parliament', PDF_LEFT);
  doc.font(bodyFont).fontSize(9).fillColor(C.slate).text('Palnadu Parliamentary Constituency', PDF_LEFT);

  doc.fontSize(8).fillColor('#9ca3af').text(
    '(Draft v1 letter format — wording to be finalized.)',
    PDF_LEFT, doc.page.height - 60, { width: PDF_WIDTH, align: 'center' }
  );
}

app.get('/api/ttd-letters/export.xlsx', (req, res) => {
  const db = readDB();
  let items = db.ttd_letters || [];
  const { from, to } = req.query;
  if (from) items = items.filter(l => l.date >= from);
  if (to) items = items.filter(l => l.date <= to);
  items = [...items].sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  const rows = items.map(l => ({
    Date: l.date, Name: l.name, Phone: l.phone, Aadhar: l.aadhar,
    Reference: l.reference, 'Darshan Type': l.darshan_type,
    'Referred By': l.referred_by, Remarks: l.remarks,
    Status: ttdStatus(l.date),
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'TTD Letters');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="ttd-letters-${from || 'all'}-to-${to || 'now'}.xlsx"`);
  res.send(buf);
});

app.get('/api/ttd-letters/export-pdf', (req, res) => {
  const db = readDB();
  let items = db.ttd_letters || [];
  const { from, to } = req.query;
  if (from) items = items.filter(l => l.date >= from);
  if (to) items = items.filter(l => l.date <= to);
  items = [...items].sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="ttd-letters-${from || 'all'}-to-${to || 'now'}.pdf"`);

  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  doc.pipe(res);
  try {
    buildTtdRegisterPDF(doc, items, from, to);
  } catch (e) {
    console.error('TTD register PDF generation error:', e);
  }
  doc.end();
});

app.get('/api/ttd-letters/:id/letter-pdf', (req, res) => {
  const db = readDB();
  const letter = getLetter(req.params.id);
  if (!letter) return res.status(404).json({ error: 'Letter not found' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="ttd-letter-${letter.reference.replace(/\//g, '-')}.pdf"`);

  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  doc.pipe(res);
  try {
    buildTtdLetterPDF(doc, letter, db.metadata?.mp_name);
  } catch (e) {
    console.error('TTD letter PDF generation error:', e);
  }
  doc.end();
});

function categoryLabel(key) {
  return ISSUE_CATEGORIES.find(c => c.key === key)?.label || key;
}

const GRIEVANCE_CHANNEL_LABELS = {
  walk_in: 'Walk-in',
  phone_call: 'Phone call',
  whatsapp_text: 'WhatsApp',
  whatsapp_voice: 'WhatsApp voice',
};
function channelLabel(key) {
  return GRIEVANCE_CHANNEL_LABELS[key] || GRIEVANCE_CHANNEL_LABELS.walk_in;
}

function buildGrievancesRegisterPDF(doc, items, from, to) {
  let teluguFontOk = false;
  try {
    doc.registerFont('Body', TELUGU_FONT_PATH);
    doc.registerFont('Body-Bold', TELUGU_FONT_PATH);
    teluguFontOk = true;
  } catch { /* falls back to Helvetica */ }
  const bodyFont = teluguFontOk ? 'Body' : 'Helvetica';
  const boldFont = teluguFontOk ? 'Body-Bold' : 'Helvetica-Bold';
  const C = PDF_COLORS;

  // Widths total 515pt — the A4 text column at the 40pt margins used below.
  const cols = [
    { label: 'Date', width: 58 },
    { label: 'Channel', width: 62 },
    { label: 'Type', width: 40 },
    { label: 'Name', width: 85 },
    { label: 'Village/Mandal', width: 80 },
    { label: 'Category', width: 80 },
    { label: 'Urgency', width: 45 },
    { label: 'Status', width: 65 },
  ];

  // pdfkit's lineBreak:false still wraps long values, and rows advance by a fixed
  // step — a wrapped cell overlaps the row below. Hard-truncate to the column width.
  function fitToWidth(text, width) {
    let s = String(text ?? '');
    if (doc.widthOfString(s) <= width) return s;
    while (s.length && doc.widthOfString(s + '…') > width) s = s.slice(0, -1);
    return s + '…';
  }

  function drawRow(values, font, size, color) {
    doc.font(font).fontSize(size).fillColor(color);
    const y = doc.y;
    let x = PDF_LEFT;
    cols.forEach((c, i) => {
      doc.text(fitToWidth(values[i], c.width - 6), x, y, { width: c.width - 6, lineBreak: false });
      x += c.width;
    });
    doc.y = y + size + 8;
  }

  doc.rect(0, 0, doc.page.width, 70).fill(C.slate);
  doc.fillColor(C.white).font(boldFont).fontSize(17).text('Grievances — Register', PDF_LEFT, 22);
  doc.font(bodyFont).fontSize(10).fillColor('#FFF7ED').text(
    (from || to) ? `${from || 'start'} to ${to || 'today'}` : 'All records', PDF_LEFT, 46
  );
  doc.y = 92;
  doc.x = PDF_LEFT;

  drawRow(cols.map(c => c.label), boldFont, 9, C.green);

  doc.font(bodyFont).fontSize(8.5).fillColor(C.ink);
  items.forEach(v => {
    if (doc.y > doc.page.height - 40) {
      doc.addPage();
      doc.y = 40;
      drawRow(cols.map(c => c.label), boldFont, 9, C.green);
    }
    const villageMandal = [v.village, v.mandal].filter(Boolean).join(', ');
    drawRow(
      [v.date_of_visit, channelLabel(v.channel), v.entry_type === 'feedback' ? 'Feedback' : 'Grievance',
        v.full_name, villageMandal, categoryLabel(v.category), v.urgency, v.resolution_status],
      bodyFont, 8.5, C.ink
    );
  });

  if (!items.length) {
    doc.font(bodyFont).fontSize(10).fillColor(C.ink).text('No grievances in this range.', PDF_LEFT, doc.y + 6);
  }
}

// Health check for Railway
// Reports the SQLITE database, not db.json. It used to stat the JSON file, which
// after the migration is absent on a perfectly healthy volume — so the platform's
// health probe answered `db_size: "MISSING"` on a working deploy, which is the
// kind of signal that sends someone chasing a problem that is not there.
//
// `status` is degraded rather than ok when the database cannot be queried at all:
// the process is up but cannot serve a single page, and a health check that
// cannot tell those apart is not doing its job.
app.get('/health', (req, res) => {
  let db_size = 'MISSING';
  let contacts = null;
  let status = 'ok';

  try {
    if (fs.existsSync(SQLITE_PATH)) {
      db_size = `${(fs.statSync(SQLITE_PATH).size / 1024).toFixed(0)} KB`;
    }
    contacts = countContacts();
  } catch (e) {
    status = 'degraded';
    console.error('health: database unreachable:', e.message);
  }

  res.status(status === 'ok' ? 200 : 503).json({
    status,
    uptime: process.uptime(),
    volume: VOLUME,
    db_path: SQLITE_PATH,
    db_size,
    contacts,
    migrations: migrationsApplied,
    env_volume: process.env.RAILWAY_VOLUME_MOUNT_PATH || 'not set',
    volume_exists: fs.existsSync(RAILWAY_VOLUME),
  });
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Saathi running on port ${PORT}`);
  console.log(`   Volume/DB: ${DB_PATH}`);
  console.log(`   Environment: ${process.env.RAILWAY_ENVIRONMENT || 'local'}\n`);
});
