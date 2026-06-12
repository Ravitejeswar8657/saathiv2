// scripts/setup_db.js - Convert Excel to JSON + compute PPS scores
import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';

const wb = XLSX.readFile('/mnt/user-data/uploads/political_contacts_sample_2000.xlsx');
const ws = wb.Sheets[wb.SheetNames[0]];
const raw = XLSX.utils.sheet_to_json(ws);

console.log(`Read ${raw.length} contacts from Excel`);

// Priority level to tier + numeric
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

function daysSince(dateStr) {
  if (!dateStr) return 180;
  try {
    // Handle Excel serial date numbers
    if (typeof dateStr === 'number') {
      const d = XLSX.SSF.parse_date_code(dateStr);
      const dt = new Date(d.y, d.m - 1, d.d);
      return Math.round((Date.now() - dt.getTime()) / 86400000);
    }
    // Handle string dates like "29/12/2025" or "03/03/2025"
    const parts = String(dateStr).split('/');
    if (parts.length === 3) {
      const dt = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
      return Math.round((Date.now() - dt.getTime()) / 86400000);
    }
    return 180;
  } catch { return 180; }
}

function computePPS(c) {
  const priority = c['Priority Level'] || 'L4';
  const base = PRIORITY_SCORE_MAP[priority] || 30;
  const role = c['Position / Role'] || 'Other';
  const roleMult = ROLE_MULT[role] || 1.0;
  const reach = REACH_MAP[c['Area of Influence']] || 200;
  const influence = Math.min(Math.log(reach + 1) * roleMult / 17.6, 1.0);
  
  const days = daysSince(c['Last Interaction Date']);
  const tier = TIER_MAP[priority] || 'T3';
  const halflife = tier === 'T1' ? 14 : tier === 'T2' ? 30 : 90;
  const decay = 1 - Math.exp(-days / halflife);
  
  // Trigger: has open grievances?
  const hasGrievance = c['Open Grievances / Requests'] ? 0.6 : 0;
  
  // Reciprocity: has previous requests/commitments?
  const reciprocity = c['Previous Requests / Commitments'] ? 0.4 : 0;
  
  // Affinity boost
  const affinity = c['Party Affiliation'] === 'TDP' ? 0.8 :
                   c['Krishna Sir Follower'] === 'Yes' ? 0.9 : 0.3;
  
  // Weights (governance mode)
  const raw = 0.20 * influence + 0.22 * decay + 0.18 * hasGrievance +
              0.15 * reciprocity + 0.18 * affinity + 0.07 * (base / 100);
  
  return Math.min(Math.round(raw * 100), 99);
}

function inferMandal(village) {
  // Map villages to mandals based on known AP geography
  const mandalMap = {
    'Sattenapalli': 'Sattenapalli', 'Narasaraopet Rural': 'Narasaraopet',
    'Guntur': 'Guntur Urban', 'Tenali': 'Tenali', 'Mangalagiri': 'Mangalagiri',
    'Pedakakani': 'Pedakakani', 'Tadikonda': 'Tadikonda', 'Ponnur': 'Ponnur',
    'Vatluru': 'Vatluru', 'Kakumanu': 'Kakumanu', 'Lankalakoderu': 'Lankalakoderu',
    'Vissannapeta': 'Vissannapeta', 'Gudivada Rural': 'Gudivada',
    'Jaggampeta': 'Jaggampeta', 'Lemalle': 'Lemalle', 'Sidhantam': 'Narasaraopet',
    'Tallapudi': 'Tallapudi', 'Nuzvid Rural': 'Nuzvid', 'Unguturu': 'Unguturu',
    'Kovvur': 'Kovvur', 'Bantumilli': 'Bantumilli', 'Bhimavaram': 'Bhimavaram',
    'Rajavommangi': 'Rajanagaram', 'Nallajerla': 'Nallajerla',
    'Eluru': 'Eluru Urban', 'Vijayawada': 'Vijayawada Urban',
  };
  return mandalMap[village] || village || 'Unknown';
}

const contacts = raw.map((c, i) => {
  const pps = computePPS(c);
  const tier = TIER_MAP[c['Priority Level']] || 'T3';
  const days = daysSince(c['Last Interaction Date']);
  
  // Determine top drivers
  const drivers = [];
  if (days > 30) drivers.push('decay');
  if (c['Open Grievances / Requests']) drivers.push('trigger');
  if (c['Previous Requests / Commitments']) drivers.push('reciprocity_debt');
  if (c['Priority Level'] === 'L1' || c['Priority Level'] === 'L2') drivers.push('influence');
  if (!drivers.length) drivers.push('strategic_value');

  return {
    id: `C${String(i + 1).padStart(4, '0')}`,
    name: c['Full Name'] || '',
    phone: String(c['Mobile Number'] || ''),
    village: c['Village'] || '',
    mandal: inferMandal(c['Village']),
    dob: c['Date of Birth'] || '',
    gender: c['Gender'] || '',
    occupation: c['Occupation'] || '',
    party: c['Party Affiliation'] || 'Neutral',
    krishna_follower: c['Krishna Sir Follower'] === 'Yes',
    role: c['Position / Role'] || 'Other',
    area_of_influence: c['Area of Influence'] || 'Village',
    religion: c['Religion'] || '',
    caste: c['Caste / Community'] || '',
    additional_identity: c['Additional Identity'] || '',
    last_interaction: c['Last Interaction Date'] || null,
    days_since_contact: days,
    remarks: c['Remarks'] || '',
    open_grievance: c['Open Grievances / Requests'] || '',
    previous_commitment: c['Previous Requests / Commitments'] || '',
    priority_level: c['Priority Level'] || 'L4',
    tier,
    pps_score: pps,
    top_drivers: drivers.slice(0, 2),
    affinity: c['Party Affiliation'] === 'TDP' ? 'supportive' :
              c['Party Affiliation'] === 'YSRCP' ? 'opposition' : 'neutral',
    estimated_reach: REACH_MAP[c['Area of Influence']] || 200,
  };
});

// Sort by PPS
contacts.sort((a, b) => b.pps_score - a.pps_score);

// Generate template-based AI reason
function makeReason(c) {
  const parts = [];
  if (c.days_since_contact > 60)
    parts.push(`No contact in ${c.days_since_contact} days — ${c.tier} contact risk of going cold.`);
  if (c.open_grievance)
    parts.push(`Open grievance: "${c.open_grievance.slice(0, 80)}".`);
  if (c.previous_commitment)
    parts.push(`Pending commitment: "${c.previous_commitment.slice(0, 80)}".`);
  if (c.krishna_follower)
    parts.push(`Krishna Sir follower — high loyalty, expects personal attention.`);
  if (!parts.length)
    parts.push(`${c.tier} contact in ${c.village}, ${c.role.toLowerCase()}, ${c.days_since_contact} days since last contact.`);
  const action = c.tier === 'T1' ? 'Recommend direct MP call today.' :
                 c.open_grievance ? 'Recommend PA follow-up call on grievance.' :
                 'Recommend WhatsApp check-in.';
  return parts.join(' ') + ' ' + action;
}

contacts.forEach(c => { c.ai_reason = makeReason(c); });

// Build issue summary from grievances
const grievanceClusters = {};
contacts.forEach(c => {
  if (!c.open_grievance) return;
  const key = c.mandal;
  if (!grievanceClusters[key]) grievanceClusters[key] = { mandal: key, count: 0, examples: [] };
  grievanceClusters[key].count++;
  if (grievanceClusters[key].examples.length < 3)
    grievanceClusters[key].examples.push(c.open_grievance.slice(0, 60));
});

const issueRadar = Object.values(grievanceClusters)
  .sort((a, b) => b.count - a.count)
  .slice(0, 10)
  .map(g => ({
    mandal: g.mandal,
    count: g.count,
    heat: Math.min(g.count / 20, 1),
    trend: g.count > 10 ? 'rising' : g.count > 5 ? 'stable' : 'low',
    examples: g.examples,
  }));

// Coverage by mandal
const mandalCoverage = {};
contacts.forEach(c => {
  const m = c.mandal;
  if (!mandalCoverage[m]) mandalCoverage[m] = { mandal: m, contacts: 0, min_days: Infinity };
  mandalCoverage[m].contacts++;
  if (c.days_since_contact < mandalCoverage[m].min_days)
    mandalCoverage[m].min_days = c.days_since_contact;
});
const coverage = Object.values(mandalCoverage).map(m => ({
  ...m,
  last_touch_days: m.min_days === Infinity ? null : m.min_days,
  health: m.min_days < 14 ? 'healthy' : m.min_days < 30 ? 'moderate' :
          m.min_days < 60 ? 'warning' : 'critical',
})).sort((a, b) => (a.min_days || 999) - (b.min_days || 999));

const db = {
  metadata: {
    total_contacts: contacts.length,
    generated_at: new Date().toISOString(),
    constituency: 'Guntur (AP)',
    source: 'Excel import - political_contacts_sample_2000.xlsx',
  },
  contacts,
  todays_brief: contacts.slice(0, 15),
  issue_radar: issueRadar,
  coverage,
  news: [],          // journalist submissions land here
  schedule: [],      // PA schedule uploads land here
  whatsapp_log: [],  // sent brief log
};

fs.writeFileSync('/home/claude/saathi_v2/data/db.json', JSON.stringify(db, null, 2));
console.log(`✓ DB created: ${contacts.length} contacts`);
console.log(`✓ Today's brief: ${db.todays_brief.length} contacts`);
console.log(`✓ Issue radar: ${db.issue_radar.length} clusters`);
console.log(`✓ Coverage: ${db.coverage.length} mandals`);
console.log('\nTop 5 by PPS:');
contacts.slice(0, 5).forEach((c, i) => {
  console.log(`  ${i+1}. ${c.name} (${c.village}) PPS:${c.pps_score} ${c.tier} — ${c.top_drivers.join(', ')}`);
});
