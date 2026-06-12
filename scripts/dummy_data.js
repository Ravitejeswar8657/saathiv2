import fs from 'fs';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'data', 'db.json');

if (!fs.existsSync(DB_PATH)) {
  console.log('No db.json found. Please run setup-db first.');
  process.exit(1);
}

const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));

// 1. Add Dummy Issues (Pending Approvals)
const dummyIssues = [
  { type: 'Recommendation Letter', desc: 'Requesting recommendation for daughter\'s college admission.' },
  { type: 'TTD Darshan', desc: 'VIP break darshan requested for family of 4 on 25th.' },
  { type: 'Medical Help', desc: 'CM Relief Fund application for heart surgery.' }
];

let issueCount = 0;
for (let i = 0; i < 3; i++) {
  const c = db.contacts[i];
  if (!c.issues) c.issues = [];
  c.issues.push({
    id: `ISS_DUMMY_${Date.now()}_${i}`,
    type: dummyIssues[i].type,
    description: dummyIssues[i].desc,
    status: 'pending',
    created_at: new Date().toISOString()
  });
  issueCount++;
}

// 2. Add Dummy Schedule Event
db.schedule = db.schedule || [];
db.schedule.push({
  id: `SCH_DUMMY_${Date.now()}`,
  event_name: 'Palanadu Zilla Parishad Review',
  date: new Date(Date.now() + 86400000).toISOString().split('T')[0], // Tomorrow
  time: '10:00',
  mandal: 'Narasaraopet',
  description: 'Monthly review meeting with all mandal presidents.',
  nearby_count: 3,
  nearby_contacts: db.contacts.slice(0, 3).map(c => ({
    id: c.id, name: c.name, phone: c.phone, village: c.village, tier: c.tier
  })),
  created_at: new Date().toISOString()
});

// 3. Add Dummy News
db.news = db.news || [];
db.news.push({
  id: `NEWS_DUMMY_${Date.now()}`,
  headline: 'Heavy rains in Vinukonda mandal cause crop damage',
  body: 'Farmers report significant damage to cotton crops due to unseasonal rainfall. Requesting immediate assessment by agriculture officials.',
  source: 'Local Reporter, TV9',
  mandal: 'Vinukonda',
  priority: 'high',
  submitted_at: new Date().toISOString(),
  has_attachment: false
});

fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
console.log(`✓ Dummy data injected! Added ${issueCount} issues, 1 event, and 1 news item.`);
