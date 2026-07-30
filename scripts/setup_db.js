// scripts/setup_db.js - Convert real Excel data to JSON + compute PPS scores
import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';

const EXCEL_PATH = process.env.EXCEL_PATH || './combined_clean.xlsx';

if (!fs.existsSync(EXCEL_PATH)) {
  console.error(`❌ Error: Excel file not found at ${EXCEL_PATH}`);
  console.log('💡 Tip: Set EXCEL_PATH env var to point to combined_clean.xlsx');
  process.exit(0);
}

const wb = XLSX.readFile(EXCEL_PATH);
const ws = wb.Sheets[wb.SheetNames[0]];
const raw = XLSX.utils.sheet_to_json(ws);

console.log(`Read ${raw.length} contacts from Excel`);

// ── Normalization helpers ──────────────────────────────────────────────────

function normalizeMandal(m) {
  if (!m) return '';
  return m
    .replace(/\s+Mandal$/i, '')       // "Nadendla Mandal" → "Nadendla"
    .replace(/\s+(Rural|Town)$/i, '') // "Chilakaluripeta Rural" → "Chilakaluripeta"
    .replace(/^Sathenapalli$/i, 'Sattenapalli')
    .replace(/^Eadlapadu$/i, 'Edlapadu')
    .replace(/^Bollapalli$/i, 'Bollapalle')
    .replace(/^Karampudi$/i, 'Karempudi')
    .replace(/^Ipuru$/i, 'Ipur')
    .trim();
}

function normalizeParty(p) {
  const v = (p || '').trim().toUpperCase();
  if (v === 'TDP' || v === 'TDP MANDAL COMMISSION') return 'TDP';
  if (v === 'JANASENA') return 'Janasena';
  if (v === 'BJP') return 'BJP';
  if (v === 'NEUTRAL') return 'Neutral';
  return 'Other';
}

function isKrishnaFollower(comment) {
  return /follower of krishna sir/i.test(comment || '');
}

// ── Role inference from Comments ──────────────────────────────────────────

function inferRole(comment) {
  const c = (comment || '').toLowerCase();
  if (/mandal (president|commission)/i.test(comment)) return 'Mandal President';
  if (/\bsarpanch\b/i.test(comment)) return 'Sarpanch';
  if (/\bzptc\b/i.test(comment)) return 'ZPTC';
  if (/\bmptc\b/i.test(comment)) return 'MPTC';
  if (/booth (convener|president)/i.test(comment)) return 'Booth President';
  if (/\b(cluster|unit)\s+(incharge|in-charge|inchar)\b/i.test(comment)) return 'Community Leader';
  if (/\bnayakulu\b|\bsr\. nayakulu\b|\bsenior nayakulu\b/i.test(comment)) return 'Community Leader';
  if (/\b(tdp|janasena|bjp)\s+leader\b/i.test(comment)) return 'Party Worker';
  if (/follower of krishna sir/i.test(comment)) return 'Influencer';
  if (/other party leader/i.test(comment)) return 'Party Worker';
  return 'Other';
}

// ── Priority inference ─────────────────────────────────────────────────────

function inferPriority(party, comment) {
  const c = (comment || '');
  if (/follower of krishna sir/i.test(c)) return 'L1';
  if (/nayakulu|mandal (president|commission)/i.test(c)) return 'L1';
  if (/\bsarpanch\b|ex[\.\s]?sarpanch|unit incharge|cluster inchar|sr\. nayakulu/i.test(c)) return 'L2';
  if (party === 'TDP' && /tdp leader/i.test(c)) return 'L2';
  if (/janasena leader/i.test(c)) return 'L3';
  if (/other party leader/i.test(c)) return 'L4';
  return 'L3';
}

// ── Area of influence inference ────────────────────────────────────────────

function inferAreaOfInfluence(role, comment) {
  if (/mandal president|mandal commission/i.test(comment)) return 'Mandal';
  if (/cluster/i.test(comment)) return 'Cluster of Villages';
  if (role === 'ZPTC') return 'Multiple Mandals';
  if (role === 'Community Leader') return 'Cluster of Villages';
  if (role === 'Influencer') return 'Village';
  return 'Village';
}

// ── Scoring maps ───────────────────────────────────────────────────────────

const TIER_MAP = { L1: 'T1', L2: 'T1', L3: 'T2', L4: 'T3' };
const PRIORITY_SCORE_MAP = { L1: 90, L2: 75, L3: 55, L4: 30 };
const ROLE_MULT = {
  'Mandal President': 2.2, 'Sarpanch': 2.0, 'ZPTC': 1.9, 'MPTC': 1.8,
  'Booth President': 1.8, 'Community Leader': 1.6, 'Business Leader': 1.5,
  'Influencer': 1.5, 'Party Worker': 1.1, 'Other': 1.0
};
const REACH_MAP = {
  'Multiple Mandals': 3000, 'Mandal': 1200, 'Cluster of Villages': 500,
  'Village': 200, 'Individual': 50
};

function computePPS(priority, role, areaOfInfluence, party, krishnaFollower) {
  const base = PRIORITY_SCORE_MAP[priority] || 30;
  const roleMult = ROLE_MULT[role] || 1.0;
  const reach = REACH_MAP[areaOfInfluence] || 200;
  const influence = Math.min(Math.log(reach + 1) * roleMult / 17.6, 1.0);

  // No last-interaction data — use a default moderate decay
  const decay = 0.5;

  // No grievance/commitment data in real dataset
  const hasGrievance = 0;
  const reciprocity = 0;

  const affinity = party === 'TDP' ? 0.8 :
                   krishnaFollower ? 0.9 : 0.3;

  const raw = 0.20 * influence + 0.22 * decay + 0.18 * hasGrievance +
              0.15 * reciprocity + 0.18 * affinity + 0.07 * (base / 100);

  return Math.min(Math.round(raw * 100), 99);
}

// ── Build contacts ─────────────────────────────────────────────────────────

const contacts = raw.map((r, i) => {
  const party = normalizeParty(r['party '] || r['party'] || '');
  const comment = (r['Comments'] || '').trim();
  const krishnaFollower = isKrishnaFollower(comment);
  const priority = inferPriority(party, comment);
  const role = inferRole(comment);
  const areaOfInfluence = inferAreaOfInfluence(role, comment);
  const tier = TIER_MAP[priority] || 'T3';
  const pps = computePPS(priority, role, areaOfInfluence, party, krishnaFollower);
  const mandal = normalizeMandal(r['Mandal'] || '');
  const constituency = (r['Constituency'] || '').trim();

  const drivers = [];
  if (priority === 'L1' || priority === 'L2') drivers.push('influence');
  if (krishnaFollower) drivers.push('loyalty');
  if (!drivers.length) drivers.push('strategic_value');

  const affinity = party === 'TDP' ? 'supportive' :
                   party === 'Janasena' ? 'neutral' :
                   party === 'Neutral' ? 'neutral' : 'neutral';

  return {
    id: `C${String(i + 1).padStart(4, '0')}`,
    name: (r['Name'] || '').trim(),
    phone: String(r['Phone Number'] || '').trim(),
    village: (r['Village'] || '').trim(),
    mandal,
    constituency,
    dob: '',
    gender: '',
    occupation: '',
    party,
    krishna_follower: krishnaFollower,
    role,
    area_of_influence: areaOfInfluence,
    religion: '',
    caste: '',
    additional_identity: '',
    last_interaction: null,
    days_since_contact: 90, // default — no date in source data
    remarks: comment,
    manual_brief: '',
    open_grievance: '',
    previous_commitment: '',
    priority_level: priority,
    tier,
    pps_score: pps,
    top_drivers: drivers.slice(0, 2),
    affinity,
    estimated_reach: REACH_MAP[areaOfInfluence] || 200,
    issues: [],
  };
});

// Sort by PPS descending
contacts.sort((a, b) => b.pps_score - a.pps_score);

// ── AI reason ─────────────────────────────────────────────────────────────

function makeReason(c) {
  const parts = [];
  if (c.krishna_follower)
    parts.push(`Krishna Sir follower — high loyalty, expects personal attention.`);
  if (c.role === 'Mandal President' || c.role === 'Sarpanch')
    parts.push(`${c.role} in ${c.mandal} — key local leader.`);
  if (c.party === 'TDP')
    parts.push(`TDP ${c.role.toLowerCase()} in ${c.village}, ${c.mandal}.`);
  if (!parts.length)
    parts.push(`${c.tier} contact — ${c.role} in ${c.village}, ${c.mandal}.`);
  const action = c.tier === 'T1' ? 'Recommend direct MP call.' :
                 c.tier === 'T2' ? 'Recommend PA follow-up call.' :
                 'Recommend WhatsApp check-in.';
  return parts.join(' ') + ' ' + action;
}

contacts.forEach(c => { c.ai_reason = makeReason(c); });

// ── Coverage by mandal ─────────────────────────────────────────────────────

const mandalCoverage = {};
contacts.forEach(c => {
  const m = c.mandal;
  if (!mandalCoverage[m]) mandalCoverage[m] = { mandal: m, contacts: 0, constituency: c.constituency };
  mandalCoverage[m].contacts++;
});

const coverage = Object.values(mandalCoverage).map(m => ({
  ...m,
  last_touch_days: 90,
  health: 'moderate',
})).sort((a, b) => b.contacts - a.contacts);

// ── Issue radar (empty — no grievance data in source) ─────────────────────

const issueRadar = [];

// ── Assemble DB ────────────────────────────────────────────────────────────

const db = {
  metadata: {
    total_contacts: contacts.length,
    generated_at: new Date().toISOString(),
    constituency: 'Palanadu (AP)',
    source: 'Excel import - combined_clean.xlsx',
  },
  contacts,
  issue_radar: issueRadar,
  coverage,
  news: [],
  schedule: [],
};

const OUTPUT_PATH = path.join(process.cwd(), 'data', 'db.json');
fs.writeFileSync(OUTPUT_PATH, JSON.stringify(db, null, 2));
console.log(`✓ DB created: ${contacts.length} contacts`);
console.log(`✓ Coverage: ${db.coverage.length} mandals`);
console.log('\nTop 5 by PPS:');
contacts.slice(0, 5).forEach((c, idx) => {
  console.log(`  ${idx + 1}. ${c.name} (${c.village}, ${c.mandal}) PPS:${c.pps_score} ${c.tier} — ${c.top_drivers.join(', ')}`);
});
