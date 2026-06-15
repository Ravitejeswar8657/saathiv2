// server/index.js
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, URL as NodeURL } from 'url';
import { createRequire } from 'module';
import Fuse from 'fuse.js';

const require = createRequire(import.meta.url);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ── Railway persistent volume awareness ────────────────────────────────────
// On Railway: mount a volume at /data, set RAILWAY_VOLUME_MOUNT_PATH=/data
// Locally: just uses ./data/
const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(ROOT, 'data');
const DB_PATH = path.join(VOLUME, 'db.json');
const WA_AUTH_PATH = path.join(VOLUME, 'wa_auth');

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

// ── Scoring helpers ─────────────────────────────────────────────────────────
function recomputeBrief(db) {
  const now = Date.now();
  const upcoming = (db.schedule || []).filter(s => {
    const d = new Date(s.date).getTime();
    // Today, Yesterday, Tomorrow
    return d >= now - 86400000 && d <= now + 86400000 * 2;
  });

  if (upcoming.length === 0) {
    db.todays_brief = [];
    return db;
  }

  // Use nearby contacts from upcoming schedules
  const briefMap = new Map();
  upcoming.forEach(event => {
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
let newsCache = { data: null, fetchedAt: 0 };
const NEWS_CACHE_MS = 15 * 60 * 1000; // 15 minutes

async function fetchGoogleNews() {
  const now = Date.now();
  if (newsCache.data && (now - newsCache.fetchedAt) < NEWS_CACHE_MS) {
    return newsCache.data;
  }
  const url = 'https://news.google.com/rss/search?q=Palanadu+OR+Narasaraopet+OR+Palnadu&hl=en-IN&gl=IN&ceid=IN:en';
  const resp = await fetch(url);
  const xml = await resp.text();

  // Simple regex XML parsing for <item> blocks
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = block.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1')?.trim() || '';
    const link = block.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() || '';
    const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() || '';
    const source = block.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1')?.trim() || '';
    items.push({ title, link, pubDate, source });
  }

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
function generateBriefText(brief, news) {
  const lines = [
    `*🌅 Saathi Daily Brief — ${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}*`,
    `_Palanadu District · TDP_\n`,
  ];

  if (brief.length > 0) {
    lines.push(`*📞 Top contacts for today:*`);
    brief.slice(0, 10).forEach((c, i) => {
      lines.push(`${i + 1}. *${c.name}* (${c.phone})`);
      lines.push(`   ${c.village}, ${c.role} · PPS ${c.pps_score}`);
      if (c.open_grievance) lines.push(`   ⚠️ ${c.open_grievance.slice(0, 60)}`);
      if (c.schedule_event) lines.push(`   📍 Near: ${c.schedule_event.event_name}`);
      lines.push('');
    });
  } else {
    lines.push(`_No upcoming schedule events to display nearby contacts._\n`);
  }

  if (news?.length) {
    lines.push(`*📰 Latest news:*`);
    news.slice(0, 3).forEach((n, i) => lines.push(`${i + 1}. ${n.headline}`));
    lines.push('');
  }
  lines.push(`_Sent by Saathi · ${new Date().toLocaleTimeString('en-IN')}_`);
  return lines.join('\n');
}

async function sendWhatsAppBrief(brief, news) {
  const message = generateBriefText(brief, news);

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

app.get('/api/generate-brief', (req, res) => {
  const db = recomputeBrief(readDB());
  const message = generateBriefText(db.todays_brief, db.news || []);
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
  const { event_name, date, time, address, village, mandal, description } = req.body;
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
    nearby_contacts: nearby.map(c => ({
      id: c.id, name: c.name, phone: c.phone,
      village: c.village, role: c.role, tier: c.tier,
      pps_score: c.pps_score, open_grievance: c.open_grievance || '',
    })),
    nearby_count: nearby.length,
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
  const result = await sendWhatsAppBrief(db.todays_brief, db.news || []);
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

  // Join URL fragments — PDFs wrap long URLs mid-word across lines
  const lines = [];
  for (const line of rawLines) {
    if (lines.length > 0) {
      const prev = lines[lines.length - 1];
      const prevIsPartialUrl =
        prev.startsWith('http') &&
        !/\.(ece|html?|php|aspx|com|org|net|in|pdf|json)\b/.test(prev);
      const lineIsUrlFrag =
        !line.includes(' ') && /^[a-zA-Z0-9\/\-\._?=%&#]+$/.test(line);
      if (prevIsPartialUrl && (line.startsWith('/') || lineIsUrlFrag)) {
        lines[lines.length - 1] = prev + line;
        continue;
      }
    }
    lines.push(line);
  }

  // Extract date
  const dateMatch = rawText.match(/Date[:\s]+(.+)/i);
  const briefDate = dateMatch ? dateMatch[1].trim() : '';

  // Strip known noise / header rows
  const NOISE = new Set([
    'Sl.', 'No.', 'Topic', 'News Summary', 'Link',
    'National News', 'International News',
    'Topic News Summary Link', 'Sl. No. Topic News Summary Link',
    'Sl. No.', 'Topic News Summary Link',
  ]);
  const clean = lines.filter(l => !NOISE.has(l) && !/^Date[:\s]/i.test(l));

  const items = [];
  let i = 0;

  while (i < clean.length) {
    if (!/^\d+$/.test(clean[i])) { i++; continue; }
    i++; // skip item number

    const chunk = [];
    while (i < clean.length && !/^\d+$/.test(clean[i])) {
      chunk.push(clean[i]);
      i++;
    }
    if (!chunk.length) continue;

    // Extract URL from the end of the chunk
    let link = '';
    while (chunk.length && chunk[chunk.length - 1].startsWith('http')) {
      link = chunk.pop();
    }

    // Classify by URL path (/national/ vs /international/)
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
      items.push({ headline: headline || body.slice(0, 80), body, link, category, briefDate });
    }
  }

  return { briefDate, items };
}

app.post('/api/upload-news-brief', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'PDF file required' });
  if (!req.file.originalname.toLowerCase().endsWith('.pdf'))
    return res.status(400).json({ error: 'Only PDF files are accepted' });

  try {
    const pdfParse = require('pdf-parse');
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
