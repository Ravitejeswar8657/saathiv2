// server/index.js
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Fuse from 'fuse.js';

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
  const contacts = [...db.contacts];
  const now = Date.now();
  const upcoming = (db.schedule || []).filter(s => {
    const d = new Date(s.date).getTime();
    return d >= now - 86400000 && d <= now + 86400000 * 2;
  });
  const scheduledMandals = new Set(upcoming.map(s => s.mandal));
  contacts.forEach(c => {
    c._boosted_pps = Math.min((c.pps_score || 0) + (scheduledMandals.has(c.mandal) ? 15 : 0), 99);
  });
  contacts.sort((a, b) => (b._boosted_pps || b.pps_score) - (a._boosted_pps || a.pps_score));
  db.todays_brief = contacts.slice(0, 15).map(c => ({
    ...c,
    schedule_event: upcoming.find(s => s.mandal === c.mandal) || null,
  }));
  return db;
}

// ── WhatsApp ────────────────────────────────────────────────────────────────
async function sendWhatsAppBrief(brief, news) {
  const lines = [
    `*🌅 Saathi Daily Brief — ${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}*`,
    `_Palanadu District · TDP_\n`,
    `*📞 Top contacts for today:*`,
  ];
  brief.slice(0, 10).forEach((c, i) => {
    lines.push(`${i + 1}. *${c.name}* (${c.village}, ${c.constituency})`);
    lines.push(`   ${c.role} · ${c.tier} · PPS ${c.pps_score}`);
    if (c.open_grievance) lines.push(`   ⚠️ ${c.open_grievance.slice(0, 60)}`);
    if (c.schedule_event) lines.push(`   📍 Near: ${c.schedule_event.event_name}`);
    lines.push('');
  });
  if (news?.length) {
    lines.push(`*📰 Latest news:*`);
    news.slice(0, 3).forEach(n => lines.push(`• ${n.headline}`));
    lines.push('');
  }
  lines.push(`_Sent by Saathi · ${new Date().toLocaleTimeString('en-IN')}_`);
  const message = lines.join('\n');

  const logEntry = {
    sent_at: new Date().toISOString(),
    to: '9652345570',
    message,
    status: 'pending',
  };

  try {
    const wa = await import('./whatsapp.js');
    await wa.default(message, '9652345570');
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
  const { q, tier, party, mandal } = req.query;
  if (q) {
    const fuse = new Fuse(contacts, {
      keys: ['name', 'village', 'mandal', 'role', 'caste', 'open_grievance'],
      threshold: 0.35,
    });
    contacts = fuse.search(q).map(r => r.item);
  }
  if (tier) contacts = contacts.filter(c => c.tier === tier);
  if (party) contacts = contacts.filter(c => c.party === party);
  if (mandal) contacts = contacts.filter(c =>
    c.mandal.toLowerCase().includes(mandal.toLowerCase()));
  res.json({ contacts: contacts.slice(0, 200), total: contacts.length });
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
