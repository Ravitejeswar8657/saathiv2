// server/news-categories.js
// The one place that answers "which heading does this news item print under?".
//
// Lives outside server/index.js because index.js starts the HTTP server on
// import, so nothing defined in it can be unit-tested.
//
// The reason this module exists at all: news items reach the brief PDF in three
// different shapes, and only one of them carries the field the PDF used to read.
//
//   - SQLite rows (`listNews`)            → `scope`, lowercase, see server/db/news.js
//   - Excel/PDF import items (in-flight)  → `category`, title-case, see parseNewsExcel
//   - Google/publisher RSS (`fetchGoogleNews`) → neither; only a `mandal_tag`
//
// `category` was the db.json-era field and it is NOT a column any more —
// 005_news_scopes.sql moved that axis to `scope`. buildBriefPDF kept reading
// `n.category` off DB rows, got `undefined` every time, and defaulted all four
// categories into 'District', so the INTERNATIONAL/NATIONAL/STATE headings never
// rendered. Resolve through newsCategory() rather than touching either field
// directly, and that cannot silently happen again.
import { SCOPES } from './db/news.js';

export const CATEGORY_ORDER = ['National', 'International', 'State', 'District'];

// scope value (server/db/news.js SCOPES) → PDF heading. 'mandal' folds into
// District on purpose: it is a field-correspondent submission tagged to one
// mandal, which is still district-level coverage. admin.html's News Dashboard
// filter makes the same pairing (ND_SCOPE_LABELS / the District button).
export const SCOPE_TO_CATEGORY = {
  district: 'District',
  mandal: 'District',
  state: 'State',
  national: 'National',
  international: 'International',
};

// Free-text category from a spreadsheet column or a source URL.
export function normalizeCategory(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (v.includes('inter')) return 'International';
  if (v.includes('nat')) return 'National';
  if (v.includes('stat')) return 'State';
  return 'District';
}

export function newsCategory(item) {
  if (!item) return 'District';

  // Already resolved — an item the PA picked in brief_workflow.html round-trips
  // through event.news_selected carrying the heading it was shown under.
  if (CATEGORY_ORDER.includes(item.category)) return item.category;

  // A row out of the news table. This is the branch the PDF was missing.
  const fromScope = SCOPE_TO_CATEGORY[String(item.scope || '').trim().toLowerCase()];
  if (fromScope) return fromScope;

  // Legacy/free-text category ('national', 'Intl news', …).
  if (item.category) return normalizeCategory(item.category);

  // Auto-scraped live news has no category axis at all. The scraper does tag
  // items it matched to a Palnadu mandal, so those are district coverage; the
  // rest of the feed is the broader AP/Guntur query, i.e. state.
  return item.mandal_tag ? 'District' : 'State';
}

// Guard for the next migration that widens news.scope: a scope with no heading
// would fall through to the live-news branch and be filed as State.
export function unmappedScopes() {
  return SCOPES.filter(s => !SCOPE_TO_CATEGORY[s]);
}
