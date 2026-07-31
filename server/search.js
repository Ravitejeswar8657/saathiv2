// server/search.js
// Multi-collection fuzzy search over the app's own records, using the same Fuse.js
// convention already used for contact search and grievance duplicate-detection in
// server/index.js (threshold: 0.35). No SQL, no vector DB — this app is a single
// JSON file, so "search" means Fuse.js across each collection, merged by score.
import Fuse from 'fuse.js';

const PER_COLLECTION_CAP = 8;

// Each entry: which db collection, which fields to search, and how to label a hit
// so the visible search UI and the chat grounding step can render one uniform shape
// without re-deriving titles/subtitles twice.
const COLLECTIONS = [
  {
    source: 'contacts',
    keys: ['name', 'village', 'mandal', 'role', 'remarks'],
    label(c) {
      const subtitle = [c.role, [c.village, c.mandal].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
      return { title: c.name || 'Unnamed contact', subtitle };
    },
  },
  {
    source: 'grievances',
    keys: ['full_name', 'village', 'mandal', 'issue_description', 'category'],
    label(g) {
      const place = [g.village, g.mandal].filter(Boolean).join(', ');
      const subtitle = [g.category, place, g.resolution_status].filter(Boolean).join(' · ');
      return { title: g.full_name || g.issue_description?.slice(0, 60) || 'Grievance', subtitle };
    },
  },
  {
    source: 'schedule',
    keys: ['event_name', 'description', 'mandal', 'village'],
    label(s) {
      const place = [s.village, s.mandal].filter(Boolean).join(', ');
      const subtitle = [s.date, place].filter(Boolean).join(' · ');
      return { title: s.event_name || 'Event', subtitle };
    },
  },
  {
    source: 'news',
    keys: ['headline', 'source'],
    label(n) {
      return { title: n.headline || n.title || 'News item', subtitle: n.source || '' };
    },
  },
  {
    source: 'campaign_reports',
    keys: ['title', 'description', 'mandal', 'village'],
    label(r) {
      const place = [r.village, r.mandal].filter(Boolean).join(', ');
      const subtitle = [r.type, place, r.status].filter(Boolean).join(' · ');
      return { title: r.title || 'Report', subtitle };
    },
  },
  {
    source: 'social_posts',
    keys: ['caption'],
    label(p) {
      return { title: (p.caption || 'Social post').slice(0, 60), subtitle: p.date || '' };
    },
  },
];

export function searchAll(db, query, { limit = 30 } = {}) {
  if (!query || !query.trim()) return [];

  const merged = [];
  for (const { source, keys, label } of COLLECTIONS) {
    const items = db[source] || [];
    if (!items.length) continue;
    const fuse = new Fuse(items, { keys, threshold: 0.35, includeScore: true });
    fuse.search(query).slice(0, PER_COLLECTION_CAP).forEach(r => {
      const { title, subtitle } = label(r.item);
      merged.push({ source, id: r.item.id, title, subtitle, score: r.score ?? 1 });
    });
  }

  merged.sort((a, b) => a.score - b.score);
  return merged.slice(0, limit);
}
