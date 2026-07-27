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
const WA_AUTH_PATH = path.join(VOLUME, 'wa_auth');
const VISITOR_IMAGES_PATH = path.join(VOLUME, 'visitor_form_images');
const SOCIAL_MEDIA_PATH = path.join(VOLUME, 'social_calendar_media');
const BASE_URL = process.env.BASE_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 'http://localhost:3000');
const TELUGU_FONT_PATH = path.join(ROOT, 'public', 'fonts', 'NotoSansTelugu.ttf');

// Ensure dirs exist
fs.mkdirSync(VOLUME, { recursive: true });
fs.mkdirSync(WA_AUTH_PATH, { recursive: true });
fs.mkdirSync(VISITOR_IMAGES_PATH, { recursive: true });
fs.mkdirSync(SOCIAL_MEDIA_PATH, { recursive: true });

// Seed db.json from bundled snapshot if volume is empty
const SEED_PATH = path.join(ROOT, 'data', 'db.json');
if (!fs.existsSync(DB_PATH) && fs.existsSync(SEED_PATH)) {
  fs.copyFileSync(SEED_PATH, DB_PATH);
  console.log('✓ Database seeded from bundled snapshot');
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(ROOT, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
// Separate instance for visitor-form photo batches — phone camera photos run larger than
// the 10MB cap above, and a day's forms are uploaded together (up to 20 files at once).
const uploadVisitorForms = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 20 } });
// Social media calendar posts can include video, which runs much larger than photos.
const uploadSocialMedia = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024, files: 10 } });

// ── DB helpers ─────────────────────────────────────────────────────────────
function readDB() {
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}
function writeDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
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

// ── Scoring helpers ─────────────────────────────────────────────────────────
function recomputeBrief(db) {
  const todayIST = getISTDateStr();
  const todaysEvents = (db.schedule || [])
    .filter(s => s.date === todayIST)
    .sort((a, b) => parseTimeToMinutes(a.time) - parseTimeToMinutes(b.time));

  db.todays_schedule = todaysEvents;

  if (todaysEvents.length === 0) {
    db.todays_brief = [];
    return db;
  }

  const briefMap = new Map();
  todaysEvents.forEach(event => {
    (event.nearby_contacts || []).forEach(c => {
      if (!briefMap.has(c.id)) {
        briefMap.set(c.id, { ...c, schedule_event: event });
      }
    });
  });

  db.todays_brief = Array.from(briefMap.values()).sort((a, b) => b.pps_score - a.pps_score);
  return db;
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
    { q: 'Palanadu OR Narasaraopet OR Palnadu', hl: 'en-IN', gl: 'IN', ceid: 'IN:en', lang: 'en' },
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

// ── WhatsApp incoming message handler registration ─────────────────────────
(async () => {
  try {
    const wa = await import('./whatsapp.js');
    wa.setOnIncomingMessage(async ({ action, identifier, rawText, sender }) => {
      const db = readDB();
      if (!db.wa_responses) db.wa_responses = [];

      // Resolve identifier: could be "ISS..." or a number (index in pending list)
      let issueId = null;
      let contactId = null;
      let contactName = '';
      let issueType = '';

      if (identifier.toUpperCase().startsWith('ISS')) {
        issueId = identifier.toUpperCase();
      } else {
        // Try as a 1-based index into pending list
        const num = parseInt(identifier, 10);
        if (!isNaN(num) && num > 0) {
          const pending = [];
          db.contacts.forEach(c => {
            (c.issues || []).forEach(iss => {
              if (iss.status === 'pending') {
                pending.push({ issue_id: iss.id, contact_id: c.id, contact_name: c.name, issue_type: iss.type });
              }
            });
          });
          if (num <= pending.length) {
            const p = pending[num - 1];
            issueId = p.issue_id;
            contactId = p.contact_id;
            contactName = p.contact_name;
            issueType = p.issue_type;
          }
        }
      }

      // If we have an issue ID but no contact info yet, look it up
      if (issueId && !contactId) {
        for (const c of db.contacts) {
          const iss = (c.issues || []).find(i => i.id === issueId);
          if (iss) {
            contactId = c.id;
            contactName = c.name;
            issueType = iss.type;
            break;
          }
        }
      }

      if (!issueId) {
        console.log(`WhatsApp: Could not resolve identifier "${identifier}" from MP message`);
        return;
      }

      const responseEntry = {
        issue_id: issueId,
        contact_id: contactId || 'unknown',
        contact_name: contactName || 'unknown',
        issue_type: issueType || 'unknown',
        mp_response: action,
        mp_message: rawText,
        responded_at: new Date().toISOString(),
        confirmed: false,
      };

      db.wa_responses.push(responseEntry);
      writeDB(db);
      console.log(`WhatsApp: MP ${action} ${issueId} — stored for admin confirmation`);
    });
    console.log('✓ WhatsApp incoming message handler registered');
  } catch (e) {
    console.log('WhatsApp incoming handler setup deferred:', e.message);
  }
})();

// ── WhatsApp ────────────────────────────────────────────────────────────────
function generateBriefText(brief, news, schedule, liveNews) {
  const istOpts = { timeZone: 'Asia/Kolkata' };
  const dateStr = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', ...istOpts });
  const timeStr = new Date().toLocaleTimeString('en-IN', istOpts);

  const lines = [
    `*The morning brief — ${dateStr}*`,
    `good morning sir\n`,
  ];

  // Today's schedule with event-specific contacts
  const todaySchedule = schedule || [];
  if (todaySchedule.length) {
    lines.push(`*📅 Today's Engagements:*`);
    todaySchedule.forEach((ev, i) => {
      const time12 = formatTime12h(ev.time);
      const timeLabel = time12 ? ` · ${time12}` : '';
      const venue = [ev.village, ev.mandal].filter(Boolean).join(', ');
      lines.push(`${i + 1}. *${ev.event_name}*${timeLabel}`);
      if (venue) lines.push(`   📍 ${venue}`);
      if (ev.description) lines.push(`   ${ev.description}`);
      const contacts = (ev.nearby_contacts || []).slice(0, 3);
      if (contacts.length) {
        lines.push(`   👥 Key contacts:`);
        contacts.forEach(c => {
          const detail = [c.role, c.village].filter(Boolean).join(', ');
          lines.push(`   • *${c.name}*${detail ? ' — ' + detail : ''}`);
          if (c.phone) lines.push(`     📞 ${c.phone}`);
          if (c.open_grievance) lines.push(`     ⚠️ ${c.open_grievance.slice(0, 60)}`);
        });
      }
      lines.push('');
    });
  } else {
    lines.push(`_No engagements scheduled for today._\n`);
  }

  // News submitted today (IST)
  const todayIST = getISTDateStr();
  const todaysNews = (news || []).filter(n => {
    if (!n.submitted_at) return false;
    return new Date(n.submitted_at).toLocaleDateString('en-CA', istOpts) === todayIST;
  });

  // Priority news selected in workflow for today's events
  const selectedNews = [];
  const seenNewsLinks = new Set();
  todaySchedule.forEach(ev => {
    (ev.news_selected || []).forEach(n => {
      if (n.link && !seenNewsLinks.has(n.link)) {
        seenNewsLinks.add(n.link);
        selectedNews.push(n);
      } else if (!n.link) {
        selectedNews.push(n);
      }
    });
  });

  const mergedNews = [...selectedNews];
  const seenMergedLinks = new Set(selectedNews.map(n => n.link).filter(Boolean));
  todaysNews.forEach(n => {
    if (n.link && !seenMergedLinks.has(n.link)) {
      seenMergedLinks.add(n.link);
      mergedNews.push(n);
    } else if (!n.link) {
      mergedNews.push(n);
    }
  });

  if (mergedNews.length) {
    lines.push(`*📰 Submitted Reports:*`);
    mergedNews.slice(0, 10).forEach((n, i) => {
      const headline = n.headline || n.title || 'News item';
      if (n.link) {
        lines.push(`${i + 1}. ${headline} — ${n.link}${n.source ? ' (' + n.source + ')' : ''}`);
      } else {
        lines.push(`${i + 1}. ${headline}${n.source ? ' (' + n.source + ')' : ''}`);
      }
    });
    lines.push('');
  }

  // Auto-scraped local news — display-only suggestions, not a replacement for field reports.
  // Skip anything that's already a submitted headline so the same story isn't listed twice.
  const submittedTitles = new Set(mergedNews.map(n => (n.headline || '').toLowerCase().trim()));
  const autoItems = (liveNews || [])
    .filter(n => !submittedTitles.has((n.title || '').toLowerCase().trim()) && (!n.link || !seenMergedLinks.has(n.link)))
    .slice(0, 5);
  if (autoItems.length) {
    lines.push(`*📡 In the News (auto-scraped):*`);
    autoItems.forEach((n, i) => {
      const title = n.title || 'News item';
      if (n.link) {
        lines.push(`${i + 1}. ${title} — ${n.link}${n.source ? ' (' + n.source + ')' : ''}`);
      } else {
        lines.push(`${i + 1}. ${title}${n.source ? ' (' + n.source + ')' : ''}`);
      }
    });
    lines.push('');
  }

  lines.push(`📊 *News Dashboard:* ${BASE_URL}/admin.html#news-dashboard\n`);
  lines.push(`_Prepared by Saathi · ${timeStr}_`);
  return lines.join('\n');
}

async function sendWhatsAppBrief(brief, news, schedule, liveNews) {
  const message = generateBriefText(brief, news, schedule, liveNews);

  const logEntry = {
    sent_at: new Date().toISOString(),
    to: '9652345570',
    message,
    status: 'pending',
  };

  try {
    const wa = await import('./whatsapp.js');
    // Add the Indian country code '91' to the beginning of the number
    await wa.default(message, '919652345570');
    logEntry.status = 'sent';
  } catch (e) {
    logEntry.status = e.message.includes('QR') || e.message.includes('not connected')
      ? 'preview_only' : 'error';
    logEntry.note = e.message;
  }

  const db = readDB();
  db.whatsapp_log = [logEntry, ...(db.whatsapp_log || [])].slice(0, 20);
  db.last_brief_message = message;
  writeDB(db);
  return logEntry;
}

// ── ROUTES ──────────────────────────────────────────────────────────────────

app.get('/api/generate-brief', async (req, res) => {
  const db = recomputeBrief(readDB());
  const liveNews = await fetchGoogleNews(db).catch(() => []);
  const message = generateBriefText(db.todays_brief, db.news || [], db.todays_schedule || [], liveNews);
  db.last_brief_message = message;
  writeDB(db);
  res.json({ message });
});

app.get('/api/dashboard', (req, res) => {
  const db = recomputeBrief(readDB());
  res.json({
    metadata: db.metadata,
    todays_brief: db.todays_brief,
    all_contacts: db.contacts,
    issue_radar: db.issue_radar,
    coverage: db.coverage,
    news: (db.news || []).slice(0, 20),
    schedule: db.schedule || [],
    whatsapp_log: (db.whatsapp_log || []).slice(0, 10),
    last_brief_message: db.last_brief_message || null,
  });
});

app.patch('/api/metadata', (req, res) => {
  const { mp_name } = req.body;
  const db = readDB();
  db.metadata = db.metadata || {};
  if (mp_name !== undefined) db.metadata.mp_name = mp_name;
  writeDB(db);
  res.json({ ok: true, metadata: db.metadata });
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
  const c = readDB().contacts.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(c);
});

app.post('/api/log-interaction', (req, res) => {
  const { contact_id, type } = req.body;
  const db = readDB();
  const idx = db.contacts.findIndex(c => c.id === contact_id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.contacts[idx].days_since_contact = 0;
  db.contacts[idx].pps_score = Math.max((db.contacts[idx].pps_score || 50) - 15, 10);
  db.contacts[idx].last_log = { type, at: new Date().toISOString() };
  writeDB(db);
  res.json({ ok: true });
});

app.post('/api/schedule', (req, res) => {
  const { event_name, date, time, address, village, mandal, description, event_type } = req.body;
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

  const event = {
    id: `SCH${Date.now()}`,
    event_name, date, time: time || '',
    address: address || '', village: village || '',
    mandal, description: description || '',
    event_type: event_type || '',
    nearby_contacts: nearby.map(c => ({
      id: c.id, name: c.name, phone: c.phone,
      village: c.village, role: c.role, tier: c.tier,
      pps_score: c.pps_score, open_grievance: c.open_grievance || '',
      // Occasion-specific, PA-written brief for this contact at this event — starts empty.
      // (The reusable "draft seed" — ai_reason/manual_brief — is looked up live from the
      // contact record at prep time, not frozen here, so edits to a contact stay fresh.)
      event_brief: '', brief_reviewed: false,
    })),
    nearby_count: nearby.length,
    // Manual-first content layers — see GET/PATCH /api/schedule/:id/prep. All start empty/
    // unreviewed; the PA fills these in, the system only ever offers a draft suggestion.
    contacts_approved: false, contacts_approved_at: null,
    speech_points: '', speech_points_reviewed: false, speech_skipped: false,
    creative_touches: { selected: [], custom: [], reviewed: false },
    news_selected: [],
    created_at: new Date().toISOString(),
  };
  db.schedule = [event, ...(db.schedule || [])];
  writeDB(db);
  res.json({ ok: true, event_id: event.id, nearby_count: event.nearby_count, nearby_contacts: event.nearby_contacts });
});

app.get('/api/schedule', (req, res) => {
  res.json({ schedule: readDB().schedule || [] });
});

app.delete('/api/schedule/:id', (req, res) => {
  const db = readDB();
  db.schedule = (db.schedule || []).filter(s => s.id !== req.params.id);
  writeDB(db);
  res.json({ ok: true });
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
    .map(n => ({ title: n.headline, link: n.link || '', source: n.source || 'Field report', mandal_tag: n.mandal || '', is_field: true, category: n.category || 'District', body: n.body || '' }));

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

  if (contacts) {
    contacts.forEach(c => {
      if (c.event_id) {
        const ev = events.find(e => e.id === c.event_id);
        if (!ev) return;
        const nc = (ev.nearby_contacts || []).find(nc => nc.id === c.id);
        if (nc) { nc.event_brief = c.note; nc.brief_reviewed = true; }
      } else {
        events.forEach(event => {
          const nc = (event.nearby_contacts || []).find(nc => nc.id === c.id);
          if (nc) { nc.event_brief = c.note; nc.brief_reviewed = true; }
        });
      }
    });
  }

  if (news_selected) {
    events.forEach(ev => { ev.news_selected = news_selected; });
  }

  if (event_updates) {
    event_updates.forEach(u => {
      const ev = events.find(e => e.id === u.id);
      if (!ev) return;
      if (u.speech_points !== undefined) { ev.speech_points = u.speech_points; ev.speech_points_reviewed = !!u.speech_points.trim(); }
      if (u.creative_touches !== undefined) ev.creative_touches = u.creative_touches;
    });
  }

  writeDB(db);
  res.json({ ok: true });
});

app.get('/api/schedule/:id/prep', async (req, res) => {
  const db = readDB();
  const event = (db.schedule || []).find(s => s.id === req.params.id);
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
    .map(n => ({ title: n.headline, link: n.link || '', source: n.source || 'Field report', mandal_tag: n.mandal || '', is_field: true, category: n.category || 'District', body: n.body || '' }));

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
  const event = (db.schedule || []).find(s => s.id === req.params.id);
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
    event.nearby_contacts = (event.nearby_contacts || []).map(nc => {
      const update = contact_briefs[nc.id];
      if (!update) return nc;
      if (update.save_to_contact) {
        const cIdx = db.contacts.findIndex(c => c.id === nc.id);
        if (cIdx !== -1) db.contacts[cIdx].manual_brief = update.event_brief || '';
      }
      return {
        ...nc,
        event_brief: update.event_brief !== undefined ? update.event_brief : nc.event_brief,
        brief_reviewed: update.brief_reviewed !== undefined ? !!update.brief_reviewed : nc.brief_reviewed,
      };
    });
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

  db.schedule[idx] = event;
  writeDB(db);
  res.json({ ok: true, event: { ...event, speech_applicable: isSpeechApplicable(event.event_type) } });
});

app.post('/api/contact', (req, res) => {
  const { name, phone, village, mandal, role, tier, constituency } = req.body;
  if (!name || !phone || !mandal) return res.status(400).json({ error: 'name, phone, and mandal required' });
  
  const db = readDB();
  const newContact = {
    id: `C${Date.now()}`,
    name, phone, village: village || '', mandal, constituency: constituency || '',
    role: role || 'Other', tier: tier || 'T3',
    pps_score: 50, days_since_contact: 0,
    created_at: new Date().toISOString(),
    issues: []
  };
  db.contacts.push(newContact);
  writeDB(db);
  res.json({ ok: true, contact: newContact });
});

app.post('/api/issue', (req, res) => {
  const { contact_id, type, description } = req.body;
  if (!contact_id || !type) return res.status(400).json({ error: 'contact_id and type required' });
  
  const db = readDB();
  const idx = db.contacts.findIndex(c => c.id === contact_id);
  if (idx === -1) return res.status(404).json({ error: 'Contact not found' });
  
  const issue = {
    id: `ISS${Date.now()}`,
    type, // 'General', 'Recommendation Letter', 'TTD Darshan'
    description: description || '',
    status: (type === 'General') ? 'none' : 'pending',
    created_at: new Date().toISOString()
  };
  
  if (!db.contacts[idx].issues) db.contacts[idx].issues = [];
  db.contacts[idx].issues.push(issue);
  // Also update open_grievance for backward compatibility
  db.contacts[idx].open_grievance = description;
  
  writeDB(db);
  res.json({ ok: true, issue });
});

app.get('/api/pending-approvals', (req, res) => {
  const db = readDB();
  const pending = [];
  db.contacts.forEach(c => {
    (c.issues || []).forEach(iss => {
      if (iss.status === 'pending') {
        pending.push({ ...iss, contact_name: c.name, contact_id: c.id, mandal: c.mandal });
      }
    });
  });
  res.json({ pending });
});

app.post('/api/issue/approve', (req, res) => {
  const { contact_id, issue_id, status } = req.body; // status: 'approved' or 'rejected'
  if (!contact_id || !issue_id || !status) return res.status(400).json({ error: 'Missing params' });
  
  const db = readDB();
  const cIdx = db.contacts.findIndex(c => c.id === contact_id);
  if (cIdx === -1) return res.status(404).json({ error: 'Contact not found' });
  
  const issIdx = (db.contacts[cIdx].issues || []).findIndex(iss => iss.id === issue_id);
  if (issIdx === -1) return res.status(404).json({ error: 'Issue not found' });
  
  db.contacts[cIdx].issues[issIdx].status = status;
  db.contacts[cIdx].issues[issIdx].resolved_at = new Date().toISOString();
  
  writeDB(db);
  res.json({ ok: true });
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
  const db = readDB();
  const item = {
    id: `NEWS${Date.now()}`,
    headline, body: body || '',
    source: source || 'Field correspondent',
    mandal: mandal || 'General',
    priority: priority || 'medium',
    link: link || '',
    submitted_at: new Date().toISOString(),
    has_attachment: !!req.file,
    attachment_name: req.file?.originalname || null,
  };
  db.news = [item, ...(db.news || [])].slice(0, 50);
  writeDB(db);
  res.json({ ok: true, id: item.id, message: 'Submitted. Appearing in today\'s brief now.' });
});

app.patch('/api/news/:id', (req, res) => {
  const db = readDB();
  const item = (db.news || []).find(n => n.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'News item not found' });
  const { headline, link, source, body, mandal, priority } = req.body;
  if (headline !== undefined) item.headline = headline;
  if (link !== undefined) item.link = link;
  if (source !== undefined) item.source = source;
  if (body !== undefined) item.body = body;
  if (mandal !== undefined) item.mandal = mandal;
  if (priority !== undefined) item.priority = priority;
  writeDB(db);
  res.json({ ok: true, item });
});

app.delete('/api/news/:id', (req, res) => {
  const db = readDB();
  db.news = (db.news || []).filter(n => n.id !== req.params.id);
  writeDB(db);
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
function buildTtdLetterItem(db, { date, name, phone, aadhar, referred_by, remarks, darshan_type, party_size, review_status, source_visitor_form_id }) {
  return {
    id: `TTD${Date.now()}`,
    reference: computeTtdReference(db, date),
    date, name,
    darshan_type: darshan_type || '',
    phone: phone || '',
    aadhar: aadhar || '',
    referred_by: referred_by || '',
    remarks: remarks || '',
    party_size: party_size ?? null,
    review_status: review_status || 'Confirmed',
    source_visitor_form_id: source_visitor_form_id || null,
    created_at: new Date().toISOString(),
  };
}
function computeTtdReference(db, dateStr) {
  const year = (dateStr || getISTDateStr()).slice(0, 4);
  const count = (db.ttd_letters || []).filter(l => (l.reference || '').includes(`/${year}/`)).length;
  return `TTD/${year}/${String(count + 1).padStart(3, '0')}`;
}
function normalizeAadhar(a) {
  return String(a || '').replace(/[\s-]/g, '');
}
function findTtdDuplicates(db, aadhar, excludeId) {
  const norm = normalizeAadhar(aadhar);
  if (!norm) return [];
  return (db.ttd_letters || [])
    .filter(l => l.id !== excludeId && normalizeAadhar(l.aadhar) === norm)
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
  const db = readDB();
  res.json({ matches: findTtdDuplicates(db, req.query.aadhar) });
});

app.post('/api/ttd-letters', (req, res) => {
  const { date, name, phone, aadhar, referred_by, remarks, darshan_type, party_size } = req.body;
  if (!date || !name || !darshan_type || !TTD_DARSHAN_TYPES.includes(darshan_type))
    return res.status(400).json({ error: 'date, name, and a valid darshan_type are required' });
  const partySizeError = validatePartySize(darshan_type, party_size);
  if (partySizeError) return res.status(400).json({ error: partySizeError });

  const db = readDB();
  const duplicate_warning = findTtdDuplicates(db, aadhar);
  const item = buildTtdLetterItem(db, { date, name, phone, aadhar, referred_by, remarks, darshan_type, party_size, review_status: 'Confirmed' });
  db.ttd_letters = [item, ...(db.ttd_letters || [])];
  writeDB(db);
  res.json({ ok: true, item, duplicate_warning });
});

app.patch('/api/ttd-letters/:id', (req, res) => {
  const db = readDB();
  const item = (db.ttd_letters || []).find(l => l.id === req.params.id);
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

  if (date !== undefined) item.date = date;
  if (name !== undefined) item.name = name;
  if (phone !== undefined) item.phone = phone;
  if (aadhar !== undefined) item.aadhar = aadhar;
  if (referred_by !== undefined) item.referred_by = referred_by;
  if (remarks !== undefined) item.remarks = remarks;
  if (darshan_type !== undefined) item.darshan_type = darshan_type;
  if (party_size !== undefined) item.party_size = party_size;
  if (review_status !== undefined) item.review_status = review_status;
  writeDB(db);
  const duplicate_warning = aadhar !== undefined ? findTtdDuplicates(db, aadhar, item.id) : [];
  res.json({ ok: true, item, duplicate_warning });
});

app.delete('/api/ttd-letters/:id', (req, res) => {
  const db = readDB();
  db.ttd_letters = (db.ttd_letters || []).filter(l => l.id !== req.params.id);
  writeDB(db);
  res.json({ ok: true });
});

// ── Visitor Forms (AI OCR + categorization) ────────────────────────────────
const ISSUE_CATEGORIES = [
  { key: 'cmrf_medical',          label: 'CMRF/Medical Assistance',        weight: 90 },
  { key: 'police_law_order',      label: 'Police/Law & Order',             weight: 85 },
  { key: 'public_grievance',      label: 'Public Grievance',               weight: 75 },
  { key: 'irrigation_water',      label: 'Irrigation & Water Resources',   weight: 75 },
  { key: 'pension_welfare',       label: 'Pension & Social Welfare',       weight: 70 },
  { key: 'housing',               label: 'Housing',                        weight: 70 },
  { key: 'electricity',           label: 'Electricity',                    weight: 65 },
  { key: 'revenue_land',          label: 'Revenue & Land Issues',          weight: 65 },
  { key: 'roads_infrastructure',  label: 'Roads & Infrastructure',         weight: 60 },
  { key: 'education_fee',         label: 'Education/Fee Concession',       weight: 60 },
  { key: 'agriculture',           label: 'Agriculture',                    weight: 60 },
  { key: 'banking_financial',     label: 'Banking & Financial Issues',     weight: 55 },
  { key: 'employee_transfer',     label: 'Employee Transfer',              weight: 50 },
  { key: 'mplads',                label: 'MPLADS',                         weight: 50 },
  { key: 'recommendation_letter', label: 'Recommendation/Request Letter',  weight: 45 },
  { key: 'ttd_letter',            label: 'TTD Recommendation Letter',      weight: 40 },
  { key: 'nominated_posts',       label: 'Nominated Posts',                weight: 40 },
  { key: 'party_organizational',  label: 'Party/Organizational Matter',    weight: 35 },
  { key: 'others',                label: 'Others',                        weight: 30 },
];
const ISSUE_CATEGORY_KEYS = new Set(ISSUE_CATEGORIES.map(c => c.key));
const RESOLUTION_STATUSES = new Set(['Pending', 'In Progress', 'Resolved']);
const URGENCY_WEIGHTS = { High: 100, Medium: 60, Low: 30 };

function categoryWeight(key) {
  return ISSUE_CATEGORIES.find(c => c.key === key)?.weight ?? ISSUE_CATEGORIES.find(c => c.key === 'others').weight;
}
function computePriorityScore(category, urgency) {
  const cw = categoryWeight(category);
  const uw = URGENCY_WEIGHTS[urgency] ?? URGENCY_WEIGHTS.Medium;
  return Math.round(cw * 0.4 + uw * 0.6);
}

app.get('/api/visitor-forms/categories', (req, res) => {
  res.json({ categories: ISSUE_CATEGORIES });
});

app.post('/api/visitor-forms/upload', uploadVisitorForms.array('images', 20), async (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'At least one form image required' });
  if (!process.env.GEMINI_API_KEY)
    return res.status(500).json({ error: 'AI extraction is not configured (GEMINI_API_KEY missing) — contact admin, or enter forms manually.' });

  const allowedMimes = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
  const gemini = await import('./gemini.js');

  const results = await Promise.all(req.files.map(async (file, idx) => {
    const tmp_id = `tmp${Date.now()}_${idx}`;
    if (!allowedMimes.has(file.mimetype)) {
      return { tmp_id, filename: file.originalname, error: `Unsupported file type: ${file.mimetype}` };
    }
    try {
      const extracted = await gemini.extractVisitorForm(file.buffer, file.mimetype, ISSUE_CATEGORIES);
      const category = ISSUE_CATEGORY_KEYS.has(extracted.category) ? extracted.category : 'others';
      const urgency = URGENCY_WEIGHTS[extracted.urgency] !== undefined ? extracted.urgency : 'Medium';
      return {
        tmp_id,
        filename: file.originalname,
        extracted: { ...extracted, category, urgency },
        priority_score: computePriorityScore(category, urgency),
        image_base64: file.buffer.toString('base64'),
        image_mime: file.mimetype,
      };
    } catch (e) {
      return { tmp_id, filename: file.originalname, error: e.message };
    }
  }));

  res.json({ ok: true, items: results, count: results.length });
});

app.post('/api/visitor-forms', (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items array required' });

  const db = readDB();
  const ts = Date.now();
  const saved = items.map((it, idx) => {
    const category = ISSUE_CATEGORY_KEYS.has(it.category) ? it.category : 'others';
    const resolution_status = RESOLUTION_STATUSES.has(it.resolution_status) ? it.resolution_status : 'Pending';
    const urgency = URGENCY_WEIGHTS[it.urgency] !== undefined ? it.urgency : 'Medium';
    const id = `VF${ts}_${idx}`;

    let image_path = '';
    if (it.image_base64) {
      try {
        const ext = (it.image_mime || '').includes('png') ? 'png' : (it.image_mime || '').includes('pdf') ? 'pdf' : 'jpg';
        const filename = `${id}.${ext}`;
        fs.writeFileSync(path.join(VISITOR_IMAGES_PATH, filename), Buffer.from(it.image_base64, 'base64'));
        image_path = filename;
      } catch (e) {
        console.error('Failed to persist visitor form image:', e.message);
      }
    }

    return {
      id,
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
      priority_score: computePriorityScore(category, urgency),
      image_path,
      ttd_letter_refs: [],
      created_at: new Date().toISOString(),
    };
  });

  db.ttd_letters = db.ttd_letters || [];
  for (const vf of saved) {
    if (vf.category !== 'ttd_letter') continue;
    const ttdItem = buildTtdLetterItem(db, {
      date: vf.date_of_visit,
      name: vf.full_name,
      phone: vf.contact_number,
      referred_by: vf.reference_name,
      remarks: vf.issue_description,
      review_status: 'Pending Review',
      source_visitor_form_id: vf.id,
    });
    db.ttd_letters = [ttdItem, ...db.ttd_letters];
    vf.ttd_letter_refs.push(ttdItem.reference);
  }

  db.visitor_forms = [...saved, ...(db.visitor_forms || [])];
  writeDB(db);
  res.json({ ok: true, count: saved.length, items: saved });
});

app.get('/api/visitor-forms', (req, res) => {
  const db = readDB();
  let items = db.visitor_forms || [];
  const { from, to, category, status } = req.query;
  if (from) items = items.filter(v => v.date_of_visit >= from);
  if (to) items = items.filter(v => v.date_of_visit <= to);
  if (category) items = items.filter(v => v.category === category);
  if (status) items = items.filter(v => v.resolution_status === status);
  items = [...items].sort((a, b) => (b.date_of_visit || '').localeCompare(a.date_of_visit || ''));
  res.json({ items });
});

app.patch('/api/visitor-forms/:id', (req, res) => {
  const db = readDB();
  const item = (db.visitor_forms || []).find(v => v.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Visitor form not found' });

  const fields = [
    'full_name', 'address', 'village', 'mandal', 'assembly_constituency',
    'reference_name', 'reference_number', 'contact_number', 'email',
    'date_of_visit', 'issue_description', 'action_taken', 'action_to_be_taken',
    'assigned_officer', 'deadline',
  ];
  for (const f of fields) if (req.body[f] !== undefined) item[f] = req.body[f];

  if (req.body.category !== undefined)
    item.category = ISSUE_CATEGORY_KEYS.has(req.body.category) ? req.body.category : item.category;
  if (req.body.resolution_status !== undefined)
    item.resolution_status = RESOLUTION_STATUSES.has(req.body.resolution_status) ? req.body.resolution_status : item.resolution_status;
  if (req.body.urgency !== undefined && URGENCY_WEIGHTS[req.body.urgency] !== undefined)
    item.urgency = req.body.urgency;

  item.priority_score = computePriorityScore(item.category, item.urgency);
  writeDB(db);
  res.json({ ok: true, item });
});

app.post('/api/visitor-forms/:id/create-ttd-letter', (req, res) => {
  const db = readDB();
  const visitorForm = (db.visitor_forms || []).find(v => v.id === req.params.id);
  if (!visitorForm) return res.status(404).json({ error: 'Visitor form not found' });

  const { date, darshan_type, phone, aadhar, referred_by, remarks, party_size } = req.body;
  if (!date || !darshan_type || !TTD_DARSHAN_TYPES.includes(darshan_type))
    return res.status(400).json({ error: 'date and a valid darshan_type are required' });
  const partySizeError = validatePartySize(darshan_type, party_size);
  if (partySizeError) return res.status(400).json({ error: partySizeError });

  const duplicate_warning = findTtdDuplicates(db, aadhar);
  const item = buildTtdLetterItem(db, {
    date, name: visitorForm.full_name, phone, aadhar, referred_by, remarks, darshan_type, party_size,
    review_status: 'Confirmed', source_visitor_form_id: visitorForm.id,
  });
  db.ttd_letters = [item, ...(db.ttd_letters || [])];
  visitorForm.ttd_letter_refs = [...(visitorForm.ttd_letter_refs || []), item.reference];
  writeDB(db);
  res.json({ ok: true, item, duplicate_warning, visitor_form: visitorForm });
});

app.delete('/api/visitor-forms/:id', (req, res) => {
  const db = readDB();
  const item = (db.visitor_forms || []).find(v => v.id === req.params.id);
  if (item?.image_path) {
    const p = path.join(VISITOR_IMAGES_PATH, item.image_path);
    fs.existsSync(p) && fs.unlinkSync(p);
  }
  db.visitor_forms = (db.visitor_forms || []).filter(v => v.id !== req.params.id);
  writeDB(db);
  res.json({ ok: true });
});

app.get('/api/visitor-forms/:id/image', (req, res) => {
  const db = readDB();
  const item = (db.visitor_forms || []).find(v => v.id === req.params.id);
  if (!item || !item.image_path) return res.status(404).json({ error: 'No image on file' });
  const p = path.join(VISITOR_IMAGES_PATH, item.image_path);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'Image file missing' });
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

  const id = `SM${Date.now()}`;
  const media = [];
  for (let i = 0; i < req.files.length; i++) {
    const file = req.files[i];
    const info = SOCIAL_MEDIA_MIMES[file.mimetype];
    if (!info) return res.status(400).json({ error: `Unsupported file type: ${file.mimetype}` });
    const filename = `${id}_${i}.${info.ext}`;
    fs.writeFileSync(path.join(SOCIAL_MEDIA_PATH, filename), file.buffer);
    media.push({ filename, mime: file.mimetype, type: info.type });
  }

  const item = { id, date, caption: caption || '', media, created_at: new Date().toISOString() };
  const db = readDB();
  db.social_posts = [item, ...(db.social_posts || [])];
  writeDB(db);
  res.json({ ok: true, item });
});

app.patch('/api/social-calendar/:id', (req, res) => {
  const db = readDB();
  const item = (db.social_posts || []).find(p => p.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Post not found' });
  const { date, caption } = req.body;
  if (date !== undefined) item.date = date;
  if (caption !== undefined) item.caption = caption;
  writeDB(db);
  res.json({ ok: true, item });
});

app.delete('/api/social-calendar/:id', (req, res) => {
  const db = readDB();
  const item = (db.social_posts || []).find(p => p.id === req.params.id);
  if (item) {
    (item.media || []).forEach(m => {
      const p = path.join(SOCIAL_MEDIA_PATH, m.filename);
      fs.existsSync(p) && fs.unlinkSync(p);
    });
  }
  db.social_posts = (db.social_posts || []).filter(p => p.id !== req.params.id);
  writeDB(db);
  res.json({ ok: true });
});

app.get('/api/social-calendar/media/:filename', (req, res) => {
  const safeName = path.basename(req.params.filename);
  const p = path.join(SOCIAL_MEDIA_PATH, safeName);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'File not found' });
  res.sendFile(p);
});

app.post('/api/send-brief', async (req, res) => {
  const db = recomputeBrief(readDB());
  const liveNews = await fetchGoogleNews(db).catch(() => []);
  const result = await sendWhatsAppBrief(db.todays_brief, db.news || [], db.todays_schedule || [], liveNews);
  res.json(result);
});

app.get('/api/brief-preview', (req, res) => {
  res.json({ message: readDB().last_brief_message || null });
});

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
    news_count: (db.news || []).length,
    schedule_count: (db.schedule || []).length,
    last_brief_sent: db.whatsapp_log?.[0]?.sent_at || null,
  });
});

app.get('/api/wa-status', async (req, res) => {
  try {
    const wa = await import('./whatsapp.js');
    res.json({ ...wa.getStatus(), qr: wa.getQR() });
  } catch (e) {
    res.json({ connected: false, hasQR: false, qr: null, error: e.message });
  }
});

app.post('/api/wa-logout', async (req, res) => {
  try {
    const wa = await import('./whatsapp.js');
    await wa.logout();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
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

// ── WhatsApp response routes ───────────────────────────────────────────────
app.get('/api/wa-responses', (req, res) => {
  const db = readDB();
  const unconfirmed = (db.wa_responses || []).filter(r => !r.confirmed);
  res.json({ responses: unconfirmed });
});

app.post('/api/wa-response/confirm', (req, res) => {
  const { issue_id, action } = req.body;
  if (!issue_id || !action) return res.status(400).json({ error: 'issue_id and action required' });
  if (!['approved', 'rejected'].includes(action)) return res.status(400).json({ error: 'action must be approved or rejected' });

  const db = readDB();
  if (!db.wa_responses) return res.status(404).json({ error: 'No WA responses found' });

  const respIdx = db.wa_responses.findIndex(r => r.issue_id === issue_id && !r.confirmed);
  if (respIdx === -1) return res.status(404).json({ error: 'No unconfirmed response for this issue' });

  // Mark as confirmed
  db.wa_responses[respIdx].confirmed = true;
  db.wa_responses[respIdx].confirmed_at = new Date().toISOString();

  // Update the actual issue status
  let updated = false;
  for (const c of db.contacts) {
    const iss = (c.issues || []).find(i => i.id === issue_id);
    if (iss) {
      iss.status = action;
      iss.resolved_at = new Date().toISOString();
      updated = true;
      break;
    }
  }

  writeDB(db);
  res.json({ ok: true, issue_updated: updated });
});

app.post('/api/send-approval-request', async (req, res) => {
  const { contact_id, issue_id } = req.body;
  if (!contact_id || !issue_id) return res.status(400).json({ error: 'contact_id and issue_id required' });

  const db = readDB();
  const contact = db.contacts.find(c => c.id === contact_id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });

  const issue = (contact.issues || []).find(i => i.id === issue_id);
  if (!issue) return res.status(404).json({ error: 'Issue not found' });

  const message = [
    `🔔 *Approval Request*`,
    ``,
    `*Type:* ${issue.type}`,
    `*For:* ${contact.name} (${contact.mandal})`,
    `*Details:* ${issue.description || 'No details provided'}`,
    ``,
    `Reply: *approve ${issue_id}* or *reject ${issue_id}*`,
  ].join('\n');

  const logEntry = {
    sent_at: new Date().toISOString(),
    to: '919652345570',
    type: 'approval_request',
    issue_id,
    contact_id,
    contact_name: contact.name,
    status: 'pending',
  };

  try {
    const wa = await import('./whatsapp.js');
    await wa.default(message, '919652345570');
    logEntry.status = 'sent';
  } catch (e) {
    logEntry.status = e.message.includes('QR') || e.message.includes('not connected')
      ? 'preview_only' : 'error';
    logEntry.note = e.message;
  }

  db.whatsapp_log = [logEntry, ...(db.whatsapp_log || [])].slice(0, 50);
  writeDB(db);
  res.json({ ok: true, log: logEntry, message_preview: message });
});

// ── Broadcast lists ─────────────────────────────────────────────────────────
const broadcastJobs = new Map(); // jobId → { total, done, sent, failed, status, ... }

function normalizePhone(phone) {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits[0] === '0') return `91${digits.slice(1)}`;
  return digits; // already has country code or unusual format
}

app.get('/api/broadcast-lists', (req, res) => {
  const db = readDB();
  res.json({ lists: db.broadcast_lists || [] });
});

app.get('/api/wa-groups', async (req, res) => {
  try {
    const wa = await import('./whatsapp.js');
    const groups = await wa.getGroups();
    res.json({ groups });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/broadcast-lists', async (req, res) => {
  const { name, tier, mandal, party, constituency, village, excluded_contact_ids, group_ids } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  const db = readDB();
  let filtered = db.contacts;
  if (tier) filtered = filtered.filter(c => c.tier === tier);
  if (mandal) filtered = filtered.filter(c => c.mandal.toLowerCase() === mandal.toLowerCase());
  if (party) filtered = filtered.filter(c => c.party === party);
  if (constituency) filtered = filtered.filter(c => c.constituency.toLowerCase() === constituency.toLowerCase());
  if (village) filtered = filtered.filter(c => c.village.toLowerCase() === village.toLowerCase());
  const excludedIds = Array.isArray(excluded_contact_ids) ? excluded_contact_ids : [];
  if (excludedIds.length) {
    const excludedSet = new Set(excludedIds);
    filtered = filtered.filter(c => !excludedSet.has(c.id));
  }
  const phones = [...new Set(filtered.map(c => c.phone).filter(Boolean))];

  const groupIds = Array.isArray(group_ids) ? group_ids : [];
  let groups = [];
  if (groupIds.length) {
    try {
      const wa = await import('./whatsapp.js');
      const allGroups = await wa.getGroups();
      const idSet = new Set(groupIds);
      groups = allGroups.filter(g => idSet.has(g.id)).map(g => ({ id: g.id, subject: g.subject, size: g.size }));
    } catch (e) {
      return res.status(400).json({ error: `Could not load selected groups: ${e.message}` });
    }
  }

  const list = {
    id: `BL${Date.now()}`,
    name: name.trim(),
    filters: { tier: tier || null, mandal: mandal || null, party: party || null, constituency: constituency || null, village: village || null },
    excluded_ids: excludedIds,
    phones,
    contact_count: phones.length,
    groups,
    created_at: new Date().toISOString(),
    last_sent_at: null,
    send_history: [],
  };
  if (!db.broadcast_lists) db.broadcast_lists = [];
  db.broadcast_lists.push(list);
  writeDB(db);
  res.json({ ok: true, list });
});

app.put('/api/broadcast-lists/:id/refresh', (req, res) => {
  const db = readDB();
  const idx = (db.broadcast_lists || []).findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'List not found' });
  const list = db.broadcast_lists[idx];
  const { tier, mandal, party, constituency, village } = list.filters;
  let filtered = db.contacts;
  if (tier) filtered = filtered.filter(c => c.tier === tier);
  if (mandal) filtered = filtered.filter(c => c.mandal.toLowerCase() === mandal.toLowerCase());
  if (party) filtered = filtered.filter(c => c.party === party);
  if (constituency) filtered = filtered.filter(c => c.constituency.toLowerCase() === constituency.toLowerCase());
  if (village) filtered = filtered.filter(c => c.village.toLowerCase() === village.toLowerCase());
  if (list.excluded_ids && list.excluded_ids.length) {
    const excludedSet = new Set(list.excluded_ids);
    filtered = filtered.filter(c => !excludedSet.has(c.id));
  }
  list.phones = [...new Set(filtered.map(c => c.phone).filter(Boolean))];
  list.contact_count = list.phones.length;
  list.refreshed_at = new Date().toISOString();
  writeDB(db);
  res.json({ ok: true, contact_count: list.contact_count });
});

app.delete('/api/broadcast-lists/:id', (req, res) => {
  const db = readDB();
  db.broadcast_lists = (db.broadcast_lists || []).filter(l => l.id !== req.params.id);
  writeDB(db);
  res.json({ ok: true });
});

// Broadcast pacing/safety knobs — reduces risk of WA flagging the linked session
const BROADCAST_JITTER_MIN = 0.7;              // jitter floor, ×base delay
const BROADCAST_JITTER_MAX = 1.5;              // jitter ceiling, ×base delay
const BROADCAST_REST_EVERY = 50;               // messages between rest breaks
const BROADCAST_REST_MIN_MS = 30 * 1000;       // 30s
const BROADCAST_REST_MAX_MS = 60 * 1000;       // 60s
const BROADCAST_MAX_CONSECUTIVE_FAILURES = 5;  // abort threshold
const BROADCAST_SLEEP_STEP_MS = 500;           // interruptible-sleep polling granularity

async function interruptibleSleep(totalMs, job) {
  let elapsed = 0;
  while (elapsed < totalMs) {
    if (job.status === 'cancelled') return;
    const step = Math.min(BROADCAST_SLEEP_STEP_MS, totalMs - elapsed);
    await new Promise(r => setTimeout(r, step));
    elapsed += step;
  }
}

app.post('/api/broadcast-lists/:id/send', upload.single('attachment'), async (req, res) => {
  const { message, delay_ms } = req.body;
  const hasMessage = !!message?.trim();
  if (!hasMessage && !req.file) return res.status(400).json({ error: 'message or attachment required' });
  const db = readDB();
  const list = (db.broadcast_lists || []).find(l => l.id === req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found' });
  const targets = [...list.phones.map(normalizePhone), ...(list.groups || []).map(g => g.id)];
  if (targets.length === 0) return res.status(400).json({ error: 'List has no phone numbers or groups' });
  const delayMs = Math.max(parseInt(delay_ms) || 2500, 1000); // min 1s to avoid WA ban
  const jobId = `JOB${Date.now()}`;

  let payload;
  if (req.file) {
    const { buffer, mimetype, originalname } = req.file;
    const caption = hasMessage ? message.trim() : undefined;
    if (mimetype.startsWith('image/')) payload = { image: buffer, mimetype, caption };
    else if (mimetype.startsWith('video/')) payload = { video: buffer, mimetype, caption };
    else if (mimetype.startsWith('audio/')) payload = { audio: buffer, mimetype };
    else payload = { document: buffer, mimetype, fileName: originalname, caption };
  } else {
    payload = message.trim();
  }

  broadcastJobs.set(jobId, {
    listId: list.id, listName: list.name,
    total: targets.length, done: 0, sent: 0, failed: 0,
    status: 'running', startedAt: new Date().toISOString(), finishedAt: null,
    resting: false, restUntil: null, consecutiveFailures: 0,
  });
  res.json({ ok: true, job_id: jobId, total: targets.length });

  (async () => {
    const job = broadcastJobs.get(jobId);
    try {
      const wa = await import('./whatsapp.js');
      for (const target of targets) {
        if (job.status === 'cancelled') break;
        let sendError = null;
        try {
          await wa.default(payload, target);
          job.sent++;
          job.consecutiveFailures = 0;
        } catch (e) {
          sendError = e;
          job.failed++;
          job.consecutiveFailures++;
        }
        job.done++;

        // A "not connected"/"scan the QR code" error means every remaining send will fail
        // identically — abort immediately instead of waiting for the failure count to climb.
        const isConnectionDown = sendError && /not connected|scan the qr code/i.test(sendError.message || '');
        if (isConnectionDown) job.consecutiveFailures = BROADCAST_MAX_CONSECUTIVE_FAILURES;

        if (job.consecutiveFailures >= BROADCAST_MAX_CONSECUTIVE_FAILURES) {
          job.status = 'error';
          job.error = isConnectionDown
            ? 'WhatsApp disconnected mid-send — aborted.'
            : `Aborted after ${BROADCAST_MAX_CONSECUTIVE_FAILURES} consecutive failures — WhatsApp may be throttling this session.`;
          break;
        }

        if (job.status === 'cancelled') break;

        if (job.done < job.total) {
          if (job.done % BROADCAST_REST_EVERY === 0) {
            job.resting = true;
            const restMs = BROADCAST_REST_MIN_MS + Math.round(Math.random() * (BROADCAST_REST_MAX_MS - BROADCAST_REST_MIN_MS));
            job.restUntil = new Date(Date.now() + restMs).toISOString();
            await interruptibleSleep(restMs, job);
            job.resting = false;
            job.restUntil = null;
          } else {
            const jitterMs = Math.round(delayMs * (BROADCAST_JITTER_MIN + Math.random() * (BROADCAST_JITTER_MAX - BROADCAST_JITTER_MIN)));
            await interruptibleSleep(jitterMs, job);
          }
        }
      }
      if (job.status !== 'cancelled' && job.status !== 'error') job.status = 'done';
      job.finishedAt = new Date().toISOString();
      const db2 = readDB();
      const li = (db2.broadcast_lists || []).find(l => l.id === list.id);
      if (li) {
        li.last_sent_at = job.finishedAt;
        li.send_history = [
          {
            sent_at: job.finishedAt, sent: job.sent, failed: job.failed, total: job.total,
            message: (hasMessage ? message.trim() : '(attachment)').slice(0, 120),
            status: job.status,
            ...(job.status === 'error' && job.error ? { error: job.error } : {}),
          },
          ...(li.send_history || []),
        ].slice(0, 10);
        writeDB(db2);
      }
    } catch (e) {
      const job = broadcastJobs.get(jobId);
      if (job) { job.status = 'error'; job.error = e.message; job.finishedAt = new Date().toISOString(); }
    }
  })();
});

app.get('/api/broadcast-jobs/:jobId', (req, res) => {
  const job = broadcastJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.delete('/api/broadcast-jobs/:jobId', (req, res) => {
  const job = broadcastJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status === 'running') job.status = 'cancelled';
  res.json({ ok: true });
});

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
    const ts = Date.now();
    const saved = items.map((item, idx) => {
      const dateLabel = item.briefDate || briefDate;
      const sourceParts = ['Brief', item.category, dateLabel].filter(Boolean);
      return {
        id: `NEWS${ts}_${idx}`,
        headline: item.headline,
        body: item.body,
        source: sourceParts.join(' · '),
        mandal: item.category,   // 'National' or 'International' when known
        category: item.category || 'National',
        priority: 'high',
        link: item.link || '',
        submitted_at: new Date().toISOString(),
      };
    });

    db.news = [...saved, ...(db.news || [])].slice(0, 100);
    writeDB(db);
    res.json({ ok: true, count: saved.length, briefDate });
  } catch (e) {
    res.status(500).json({ error: 'PDF parse failed: ' + e.message });
  }
});

const CATEGORY_ORDER = ['National', 'International', 'State', 'District'];
function normalizeCategory(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (v.includes('inter')) return 'International';
  if (v.includes('nat')) return 'National';
  if (v.includes('stat')) return 'State';
  return 'District';
}

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
    const db = readDB();
    const ts = Date.now();
    const saved = items.map((item, idx) => ({
      id: `NEWS${ts}_${idx}`,
      headline: item.headline,
      body: item.body || '',
      source: item.source || 'Excel import',
      mandal: 'General',
      category: item.category,
      priority: 'medium',
      link: item.link || '',
      submitted_at: new Date().toISOString(),
    }));

    db.news = [...saved, ...(db.news || [])].slice(0, 100);
    writeDB(db);
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
  doc.font(bodyFont).fontSize(11).fillColor('#FFF7ED').text('Narasaraopet Constituency · Palanadu District', PDF_LEFT, 52);
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
    .map(n => ({ title: n.headline, link: n.link || '', source: n.source || 'Field report', category: n.category || 'District', body: n.body || '' }));

  const newsIsAuto = pickedNews.length === 0;
  const newsToShow = newsIsAuto ? [...fieldNewsForPdf, ...(liveNews || [])].slice(0, 8) : pickedNews;

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
      const cat = CATEGORY_ORDER.includes(n.category) ? n.category : 'District';
      (grouped[cat] = grouped[cat] || []).push(n);
    });

    CATEGORY_ORDER.forEach(cat => {
      const list = grouped[cat] || [];
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
    .text(mpName || 'Member of Parliament, Palanadu', PDF_LEFT, 40, { width: PDF_WIDTH, align: 'center' });
  doc.font(bodyFont).fontSize(10).fillColor(C.slate)
    .text('Narasaraopet Constituency · Palanadu District', PDF_LEFT, doc.y, { width: PDF_WIDTH, align: 'center' });
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
  doc.font(bodyFont).fontSize(9).fillColor(C.slate).text('Palanadu Parliamentary Constituency', PDF_LEFT);

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
  const letter = (db.ttd_letters || []).find(l => l.id === req.params.id);
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

function buildVisitorFormsRegisterPDF(doc, items, from, to) {
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
    { label: 'Date', width: 60 },
    { label: 'Name', width: 95 },
    { label: 'Village/Mandal', width: 100 },
    { label: 'Category', width: 110 },
    { label: 'Urgency', width: 50 },
    { label: 'Status', width: 100 },
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
  doc.fillColor(C.white).font(boldFont).fontSize(17).text('Visitor Forms — Register', PDF_LEFT, 22);
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
      [v.date_of_visit, v.full_name, villageMandal, categoryLabel(v.category), v.urgency, v.resolution_status],
      bodyFont, 8.5, C.ink
    );
  });

  if (!items.length) {
    doc.font(bodyFont).fontSize(10).fillColor(C.ink).text('No visitor forms in this range.', PDF_LEFT, doc.y + 6);
  }
}

app.get('/api/visitor-forms/export.xlsx', (req, res) => {
  const db = readDB();
  let items = db.visitor_forms || [];
  const { from, to, category, status } = req.query;
  if (from) items = items.filter(v => v.date_of_visit >= from);
  if (to) items = items.filter(v => v.date_of_visit <= to);
  if (category) items = items.filter(v => v.category === category);
  if (status) items = items.filter(v => v.resolution_status === status);
  items = [...items].sort((a, b) => (a.date_of_visit || '').localeCompare(b.date_of_visit || ''));

  const rows = items.map(v => ({
    'Date of Visit': v.date_of_visit, Name: v.full_name, Village: v.village, Mandal: v.mandal,
    'Assembly Constituency': v.assembly_constituency, Contact: v.contact_number, Email: v.email,
    'Reference Name': v.reference_name, 'Reference Number': v.reference_number,
    Category: categoryLabel(v.category), Urgency: v.urgency, 'Priority Score': v.priority_score,
    'Issue Description': v.issue_description, 'Action Taken': v.action_taken,
    'Action To Be Taken': v.action_to_be_taken, 'Assigned Officer': v.assigned_officer,
    Status: v.resolution_status, Deadline: v.deadline,
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Visitor Forms');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="visitor-forms-${from || 'all'}-to-${to || 'now'}.xlsx"`);
  res.send(buf);
});

app.get('/api/visitor-forms/export-pdf', (req, res) => {
  const db = readDB();
  let items = db.visitor_forms || [];
  const { from, to, category, status } = req.query;
  if (from) items = items.filter(v => v.date_of_visit >= from);
  if (to) items = items.filter(v => v.date_of_visit <= to);
  if (category) items = items.filter(v => v.category === category);
  if (status) items = items.filter(v => v.resolution_status === status);
  items = [...items].sort((a, b) => (a.date_of_visit || '').localeCompare(b.date_of_visit || ''));

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="visitor-forms-${from || 'all'}-to-${to || 'now'}.pdf"`);

  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  doc.pipe(res);
  try {
    buildVisitorFormsRegisterPDF(doc, items, from, to);
  } catch (e) {
    console.error('Visitor forms register PDF generation error:', e);
  }
  doc.end();
});

// Health check for Railway
app.get('/health', (req, res) => {
  const dbExists = fs.existsSync(DB_PATH);
  const dbSize = dbExists ? (fs.statSync(DB_PATH).size / 1024).toFixed(0) + ' KB' : 'MISSING';
  res.json({
    status: 'ok', uptime: process.uptime(),
    volume: VOLUME, db_path: DB_PATH, db_size: dbSize,
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
