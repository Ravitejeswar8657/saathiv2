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

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ── Railway persistent volume awareness ────────────────────────────────────
// On Railway: mount a volume at /data, set RAILWAY_VOLUME_MOUNT_PATH=/data
// Locally: just uses ./data/
const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(ROOT, 'data');
const DB_PATH = path.join(VOLUME, 'db.json');
const WA_AUTH_PATH = path.join(VOLUME, 'wa_auth');
const BASE_URL = process.env.BASE_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 'http://localhost:3000');
const TELUGU_FONT_PATH = path.join(ROOT, 'public', 'fonts', 'NotoSansTelugu.ttf');

// Ensure dirs exist
fs.mkdirSync(VOLUME, { recursive: true });
fs.mkdirSync(WA_AUTH_PATH, { recursive: true });

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

// ── Google News RSS cache ──────────────────────────────────────────────────
// Multi-query: a broad English query, a Telugu-language query (most genuine
// local AP coverage is Telugu and invisible to English-only search), plus
// per-mandal queries biased toward wherever the MP has events in the next
// 7 days — bounded to 6 mandals so a busy schedule can't hammer Google News.
let newsCache = { data: null, fetchedAt: 0, mandalKey: '' };
const NEWS_CACHE_MS = 15 * 60 * 1000; // 15 minutes
const linkResolveCache = new Map(); // google redirect link -> resolved publisher URL

const TELUGU_PLACE_TERMS = 'పల్నాడు OR నరసరావుపేట OR సత్తెనపల్లి OR మాచర్ల OR గురజాల';

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

function buildNewsQueries(db) {
  const queries = [
    { q: 'Palanadu OR Narasaraopet OR Palnadu', hl: 'en-IN', gl: 'IN', ceid: 'IN:en', lang: 'en', mandal_tag: '' },
    { q: TELUGU_PLACE_TERMS, hl: 'te', gl: 'IN', ceid: 'IN:te', lang: 'te', mandal_tag: '' },
  ];
  const todayIST = getISTDateStr();
  const weekAhead = new Date();
  weekAhead.setDate(weekAhead.getDate() + 7);
  const weekAheadStr = weekAhead.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const upcomingMandals = [...new Set(
    (db.schedule || [])
      .filter(s => s.date >= todayIST && s.date <= weekAheadStr)
      .map(s => s.mandal)
      .filter(Boolean)
  )].slice(0, 6);
  upcomingMandals.forEach(m => {
    queries.push({ q: `"${m}"`, hl: 'en-IN', gl: 'IN', ceid: 'IN:en', lang: 'en', mandal_tag: m });
  });
  return queries;
}

async function fetchOneNewsQuery({ q, hl, gl, ceid, lang, mandal_tag }) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
  const resp = await fetch(url);
  const xml = await resp.text();

  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = block.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1')?.trim() || '';
    const link = block.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() || '';
    const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() || '';
    const source = block.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1')?.trim() || '';
    // Note: Google News RSS <description> is just "<a href=link>TITLE</a> SOURCE" — no real
    // snippet text, so we don't bother parsing it. Real detail comes from on-demand full-article
    // extraction (see /api/live-news/extract) rather than batch-scraping every refresh.
    items.push({ title, link, pubDate, source, mandal_tag, lang });
  }
  return items;
}

// Note: Google News' <link> is a JS/RPC-obfuscated interstitial, not a real HTTP redirect —
// following it server-side just returns Google's own page, not the publisher URL (verified by
// hand: no 3xx, the real article URL isn't present anywhere in the HTML, just an encoded blob
// Google decodes client-side). So this only helps for sources that *do* use real redirects or
// already give us a direct link (e.g. the uploaded News Brief PDF). For Google News items the
// original link is still the right thing to show — it works fine when a human opens it in a
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

async function fetchGoogleNews(db) {
  const now = Date.now();
  const queries = buildNewsQueries(db || readDB());
  const mandalKey = queries.map(q => q.mandal_tag).join('|');
  if (newsCache.data && newsCache.mandalKey === mandalKey && (now - newsCache.fetchedAt) < NEWS_CACHE_MS) {
    return newsCache.data;
  }

  const results = await Promise.allSettled(queries.map(fetchOneNewsQuery));
  const all = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);

  // Dedupe across queries by normalized title; keep the mandal tag if any copy had one.
  const seen = new Map();
  all.forEach(item => {
    const key = item.title.toLowerCase().replace(/[^a-z0-9అ-౿]/gi, '').slice(0, 80);
    if (!key) return;
    if (!seen.has(key)) seen.set(key, item);
    else if (!seen.get(key).mandal_tag && item.mandal_tag) seen.get(key).mandal_tag = item.mandal_tag;
  });

  // Reserve a quota for mandal-tagged items (biased toward where the MP has events coming up) so
  // they can't be entirely crowded out by a busy general-news day, but cap that quota so they also
  // can't crowd out the broad constituency/Telugu coverage — best of both, not all-or-nothing.
  const byRecency = (a, b) => new Date(b.pubDate) - new Date(a.pubDate);
  const deduped = [...seen.values()];
  const mandalItems = deduped.filter(i => i.mandal_tag).sort(byRecency);
  const generalItems = deduped.filter(i => !i.mandal_tag).sort(byRecency);
  const MANDAL_QUOTA = 12;
  const items = [...mandalItems.slice(0, MANDAL_QUOTA), ...generalItems].slice(0, 40);

  newsCache = { data: items, fetchedAt: now, mandalKey };
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
    `*Morning Brief — ${dateStr}*`,
    `*Palanadu Constituency*\n`,
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

  if (todaysNews.length) {
    lines.push(`*📰 Submitted Reports:*`);
    todaysNews.slice(0, 6).forEach((n, i) => {
      lines.push(`${i + 1}. ${n.headline}${n.source ? ' (' + n.source + ')' : ''}`);
    });
    lines.push('');
  }

  // Auto-scraped local news — display-only suggestions, not a replacement for field reports.
  // Skip anything that's already a submitted headline so the same story isn't listed twice.
  const submittedTitles = new Set(todaysNews.map(n => (n.headline || '').toLowerCase().trim()));
  const autoItems = (liveNews || [])
    .filter(n => !submittedTitles.has((n.title || '').toLowerCase().trim()))
    .slice(0, 5);
  if (autoItems.length) {
    lines.push(`*📡 In the News (auto-scraped):*`);
    autoItems.forEach((n, i) => {
      lines.push(`${i + 1}. ${n.title}${n.source ? ' (' + n.source + ')' : ''}`);
      lines.push(`   🔗 ${n.link}`);
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

app.get('/api/contacts', (req, res) => {
  const db = readDB();
  let contacts = db.contacts;
  const { q, tier, party, mandal, constituency, role } = req.query;
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
    c.mandal.toLowerCase().includes(mandal.toLowerCase()));
  if (constituency) contacts = contacts.filter(c =>
    c.constituency.toLowerCase().includes(constituency.toLowerCase()));
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
  res.json({ mandals, constituencies, parties, roles, mandalsByConstituency });
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
  const fuse = new Fuse(db.contacts, { keys: ['mandal', 'village'], threshold: 0.4 });
  const fuzzy = fuse.search(mandal).map(r => r.item);
  const exact = db.contacts.filter(c =>
    c.mandal.toLowerCase().includes(mandal.toLowerCase()) ||
    (village && c.village.toLowerCase().includes(village.toLowerCase()))
  );
  const seen = new Map();
  [...fuzzy, ...exact].forEach(c => seen.set(c.id, c));
  const nearby = [...seen.values()]
    .sort((a, b) => b.pps_score - a.pps_score)
    .slice(0, 20);

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
    speech_points: '', speech_points_reviewed: false,
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

app.get('/api/schedule/:id/prep', async (req, res) => {
  const db = readDB();
  const event = (db.schedule || []).find(s => s.id === req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const contactsById = new Map(db.contacts.map(c => [c.id, c]));
  const contacts = (event.nearby_contacts || []).map(nc => {
    const c = contactsById.get(nc.id);
    const standingNote = c?.manual_brief || '';
    return {
      ...nc,
      ai_reason: c?.ai_reason || '',
      remarks: c?.remarks || '',
      standing_note: standingNote,
      // What to show as the starting draft if the PA hasn't written an event-specific brief yet.
      suggested_brief: nc.event_brief || standingNote || c?.remarks || c?.ai_reason || '',
    };
  });

  let newsSuggestions = [];
  try {
    const liveNews = await fetchGoogleNews(db);
    const tagged = liveNews.filter(n => n.mandal_tag === event.mandal);
    const rest = liveNews.filter(n => n.mandal_tag !== event.mandal);
    newsSuggestions = [...tagged, ...rest].slice(0, 8);
  } catch { /* news is best-effort here */ }

  res.json({
    event,
    contacts,
    speech_draft: buildSpeechDraft(event.event_type, event, event.nearby_contacts || []),
    creative_suggestions: buildCreativeSuggestions(event.event_type, event.nearby_contacts || []),
    news_suggestions: newsSuggestions,
  });
});

app.patch('/api/schedule/:id/prep', (req, res) => {
  const db = readDB();
  const idx = (db.schedule || []).findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Event not found' });
  const event = db.schedule[idx];

  const { event_type, contact_briefs, speech_points, speech_points_reviewed, creative_touches, news_selected } = req.body;

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

  if (speech_points !== undefined) event.speech_points = speech_points;
  if (speech_points_reviewed !== undefined) event.speech_points_reviewed = !!speech_points_reviewed;

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
  res.json({ ok: true, event });
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
  const { headline, body, source, mandal, priority } = req.body;
  if (!headline) return res.status(400).json({ error: 'headline required' });
  const db = readDB();
  const item = {
    id: `NEWS${Date.now()}`,
    headline, body: body || '',
    source: source || 'Field correspondent',
    mandal: mandal || 'General',
    priority: priority || 'medium',
    submitted_at: new Date().toISOString(),
    has_attachment: !!req.file,
    attachment_name: req.file?.originalname || null,
  };
  db.news = [item, ...(db.news || [])].slice(0, 50);
  writeDB(db);
  res.json({ ok: true, id: item.id, message: 'Submitted. Appearing in today\'s brief now.' });
});

app.delete('/api/news/:id', (req, res) => {
  const db = readDB();
  db.news = (db.news || []).filter(n => n.id !== req.params.id);
  writeDB(db);
  res.json({ ok: true });
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

app.post('/api/broadcast-lists', (req, res) => {
  const { name, tier, mandal, party } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  const db = readDB();
  let filtered = db.contacts;
  if (tier) filtered = filtered.filter(c => c.tier === tier);
  if (mandal) filtered = filtered.filter(c => c.mandal.toLowerCase().includes(mandal.toLowerCase()));
  if (party) filtered = filtered.filter(c => c.party === party);
  const phones = [...new Set(filtered.map(c => c.phone).filter(Boolean))];
  const list = {
    id: `BL${Date.now()}`,
    name: name.trim(),
    filters: { tier: tier || null, mandal: mandal || null, party: party || null },
    phones,
    contact_count: phones.length,
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
  const { tier, mandal, party } = list.filters;
  let filtered = db.contacts;
  if (tier) filtered = filtered.filter(c => c.tier === tier);
  if (mandal) filtered = filtered.filter(c => c.mandal.toLowerCase().includes(mandal.toLowerCase()));
  if (party) filtered = filtered.filter(c => c.party === party);
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

app.post('/api/broadcast-lists/:id/send', async (req, res) => {
  const { message, delay_ms } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message required' });
  const db = readDB();
  const list = (db.broadcast_lists || []).find(l => l.id === req.params.id);
  if (!list) return res.status(404).json({ error: 'List not found' });
  if (list.phones.length === 0) return res.status(400).json({ error: 'List has no phone numbers' });
  const delayMs = Math.max(parseInt(delay_ms) || 2500, 1000); // min 1s to avoid WA ban
  const jobId = `JOB${Date.now()}`;
  broadcastJobs.set(jobId, {
    listId: list.id, listName: list.name,
    total: list.phones.length, done: 0, sent: 0, failed: 0,
    status: 'running', startedAt: new Date().toISOString(), finishedAt: null,
  });
  res.json({ ok: true, job_id: jobId, total: list.phones.length });

  (async () => {
    const job = broadcastJobs.get(jobId);
    try {
      const wa = await import('./whatsapp.js');
      for (const phone of list.phones) {
        if (job.status === 'cancelled') break;
        const normalized = normalizePhone(phone);
        try {
          await wa.default(message.trim(), normalized);
          job.sent++;
        } catch {
          job.failed++;
        }
        job.done++;
        await new Promise(r => setTimeout(r, delayMs));
      }
      job.status = job.status === 'cancelled' ? 'cancelled' : 'done';
      job.finishedAt = new Date().toISOString();
      const db2 = readDB();
      const li = (db2.broadcast_lists || []).find(l => l.id === list.id);
      if (li) {
        li.last_sent_at = job.finishedAt;
        li.send_history = [
          { sent_at: job.finishedAt, sent: job.sent, failed: job.failed, total: job.total, message: message.trim().slice(0, 120) },
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

app.post('/api/upload-news-brief', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'PDF file required' });
  if (!req.file.originalname.toLowerCase().endsWith('.pdf'))
    return res.status(400).json({ error: 'Only PDF files are accepted' });

  try {
    const pdfParse = require('pdf-parse/lib/pdf-parse.js');
    const parsed = await pdfParse(req.file.buffer);
    const { briefDate, items } = parseNewsBriefText(parsed.text);

    if (!items.length)
      return res.status(422).json({ error: 'No news items found. Make sure this is a News Brief PDF.' });

    if (req.query.preview === '1')
      return res.json({ ok: true, briefDate, items, count: items.length });

    // Commit to DB
    const db = readDB();
    const ts = Date.now();
    const saved = items.map((item, idx) => ({
      id: `NEWS${ts}_${idx}`,
      headline: item.headline,
      body: item.body,
      source: `Brief · ${item.category} · ${item.briefDate || briefDate}`,
      mandal: item.category,   // 'National' or 'International'
      priority: 'high',
      link: item.link || '',
      submitted_at: new Date().toISOString(),
    }));

    db.news = [...saved, ...(db.news || [])].slice(0, 100);
    writeDB(db);
    res.json({ ok: true, count: saved.length, briefDate });
  } catch (e) {
    res.status(500).json({ error: 'PDF parse failed: ' + e.message });
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

  const events = (db.schedule || [])
    .filter(s => s.date === dateStr)
    .sort((a, b) => parseTimeToMinutes(a.time) - parseTimeToMinutes(b.time));

  doc.font(boldFont).fontSize(18).fillColor('#1a1208').text('Saathi - MP Daily Brief');
  doc.font(bodyFont).fontSize(11).fillColor('#6b7280').text('Palanadu Constituency');
  doc.moveDown(0.3);
  doc.fontSize(12).fillColor('#1a1208').text(formatDateLong(dateStr));
  const preparedAt = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
  doc.fontSize(9).fillColor('#6b7280').text(`Prepared ${preparedAt} IST · ${events.length} engagement${events.length === 1 ? '' : 's'}`);
  doc.moveDown(1);

  if (events.length === 0) {
    doc.font(bodyFont).fontSize(11).fillColor('#374151').text('No engagements scheduled for this date.');
  }

  events.forEach((event, i) => {
    if (i > 0) {
      doc.moveDown(0.5);
      doc.moveTo(doc.x, doc.y).lineTo(555, doc.y).strokeColor('#e5e5e5').stroke();
      doc.moveDown(0.5);
    }

    const venue = [event.village, event.mandal].filter(Boolean).join(', ');
    doc.font(boldFont).fontSize(13).fillColor('#1a1208')
      .text(`${i + 1}. ${event.event_name}${event.time ? ' · ' + formatTime12h(event.time) : ''}${event.event_type ? ' · ' + event.event_type : ''}`);
    if (venue) doc.font(bodyFont).fontSize(10).fillColor('#6b7280').text(`Venue: ${venue}`);
    if (event.description) doc.font(bodyFont).fontSize(10).fillColor('#374151').text(event.description);
    doc.moveDown(0.5);

    // Contacts — top 8 by priority, same cap as the prep panel, so what the PA reviewed is
    // what prints. Manual content wins; auto-draft is a clearly labelled fallback.
    const contactsById = new Map(db.contacts.map(c => [c.id, c]));
    const allContacts = event.nearby_contacts || [];
    const shown = allContacts.slice(0, 8);
    if (shown.length) {
      doc.font(boldFont).fontSize(10).fillColor('#1a1208').text('Contacts to meet');
      doc.moveDown(0.2);
      shown.forEach(nc => {
        const c = contactsById.get(nc.id);
        const manualBrief = nc.event_brief && nc.event_brief.trim();
        const fallbackBrief = c?.manual_brief || c?.remarks || c?.ai_reason || '';
        const briefText = manualBrief || fallbackBrief;
        const isAuto = !manualBrief;

        doc.font(boldFont).fontSize(10).fillColor('#1a1208')
          .text(`${nc.name}`, { continued: true })
          .font(bodyFont).fillColor('#6b7280')
          .text(`  ${nc.tier} · ${nc.role || ''} · Met by: ${metByForTier(nc.tier)}${nc.phone ? ' · ' + nc.phone : ''}`);
        if (briefText) {
          doc.font(bodyFont).fontSize(9).fillColor(isAuto ? '#9ca3af' : '#374151')
            .text(`${isAuto ? '(auto-draft) ' : ''}${briefText}`, { width: 500 });
        }
        if (nc.open_grievance) {
          doc.font(bodyFont).fontSize(9).fillColor('#b45309').text(`⚠ ${nc.open_grievance}`, { width: 500 });
        }
        doc.moveDown(0.35);
      });
      if (allContacts.length > shown.length) {
        doc.font(bodyFont).fontSize(9).fillColor('#9ca3af')
          .text(`+ ${allContacts.length - shown.length} more priority contacts in the app.`);
      }
      doc.moveDown(0.3);
    }

    // Speech points — manual content if reviewed/non-empty, else the template draft, clearly marked.
    const speechIsAuto = !(event.speech_points && event.speech_points.trim());
    const speechText = speechIsAuto ? buildSpeechDraft(event.event_type, event, allContacts) : event.speech_points;
    if (speechText) {
      doc.font(boldFont).fontSize(10).fillColor('#1a1208').text(`Speech points${speechIsAuto ? ' (auto-draft — not reviewed)' : ''}`);
      doc.font(bodyFont).fontSize(9).fillColor('#374151').text(speechText, { width: 500 });
      doc.moveDown(0.3);
    }

    // Creative touches — only what the PA actually selected/typed. Never auto-inject suggestions.
    const selected = event.creative_touches?.selected || [];
    const custom = event.creative_touches?.custom || [];
    if (selected.length || custom.length) {
      const suggestionLabels = buildCreativeSuggestions(event.event_type, allContacts)
        .filter(s => selected.includes(s.id)).map(s => s.label);
      doc.font(boldFont).fontSize(10).fillColor('#1a1208').text('Creative touches');
      [...suggestionLabels, ...custom].forEach(label => {
        doc.font(bodyFont).fontSize(9).fillColor('#374151').text(`• ${label}`, { width: 500 });
      });
      doc.moveDown(0.3);
    }
  });

  // News — shared across the whole day. PA-picked items win; fall back to the top auto-scraped
  // items (clearly labelled) only if nobody picked any for any event that day.
  const pickedNews = [];
  const seenLinks = new Set();
  events.forEach(ev => (ev.news_selected || []).forEach(n => {
    if (!seenLinks.has(n.link)) { seenLinks.add(n.link); pickedNews.push(n); }
  }));
  const newsIsAuto = pickedNews.length === 0;
  const newsToShow = newsIsAuto ? (liveNews || []).slice(0, 5) : pickedNews;

  if (newsToShow.length) {
    doc.moveDown(0.5);
    doc.moveTo(doc.x, doc.y).lineTo(555, doc.y).strokeColor('#e5e5e5').stroke();
    doc.moveDown(0.5);
    doc.font(boldFont).fontSize(12).fillColor('#1a1208').text(`News for this brief${newsIsAuto ? ' (auto-scraped — not reviewed)' : ''}`);
    doc.moveDown(0.2);
    newsToShow.forEach((n, i) => {
      doc.font(bodyFont).fontSize(9).fillColor('#374151').text(`${i + 1}. ${n.title}${n.source ? ' (' + n.source + ')' : ''}`, { width: 500 });
      doc.fontSize(8).fillColor('#b45309').text(n.link, { width: 500, link: n.link, underline: true });
      doc.moveDown(0.15);
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

// Health check for Railway
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

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
