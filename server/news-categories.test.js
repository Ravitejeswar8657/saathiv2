import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CATEGORY_ORDER, SCOPE_TO_CATEGORY, normalizeCategory, newsCategory, unmappedScopes,
} from './news-categories.js';

// Every shape that reaches buildBriefPDF's news section, and the heading it must
// print under. The `scope` rows are the regression: they used to resolve to
// 'District' across the board, so INTERNATIONAL/NATIONAL/STATE never rendered.
const CASES = [
  // SQLite rows out of listNews() — lowercase `scope`, no `category`.
  ['db row, international', { headline: 'x', scope: 'international' }, 'International'],
  ['db row, national',      { headline: 'x', scope: 'national' },      'National'],
  ['db row, state',         { headline: 'x', scope: 'state' },         'State'],
  ['db row, district',      { headline: 'x', scope: 'district' },      'District'],
  // 'mandal' is the pre-005 field submission — still district-level coverage.
  ['db row, mandal',        { headline: 'x', scope: 'mandal', mandal: 'Narasaraopet' }, 'District'],

  // Items the PA picked in brief_workflow.html, round-tripped through
  // event.news_selected with the category they were shown under.
  ['picked item', { title: 'x', category: 'National' }, 'National'],

  // Legacy / free-text category values.
  ['legacy lowercase category', { title: 'x', category: 'national' },   'National'],
  // Matching is substring-based ('inter'/'nat'/'stat'), so 'Intl' would NOT match.
  ['free-text category',        { title: 'x', category: 'International Affairs' }, 'International'],

  // Auto-scraped RSS: no category axis at all, only the scraper's mandal tag.
  ['live news, mandal-tagged', { title: 'x', link: 'https://e.g', mandal_tag: 'Narasaraopet' }, 'District'],
  ['live news, untagged',      { title: 'x', link: 'https://e.g' },                             'State'],
];

test('newsCategory resolves every news shape onto a brief heading', () => {
  for (const [name, item, expected] of CASES) {
    assert.equal(newsCategory(item), expected, name);
  }
});

test('newsCategory always returns a heading the PDF actually prints', () => {
  for (const [name, item] of CASES) {
    assert.ok(CATEGORY_ORDER.includes(newsCategory(item)), `${name} is in CATEGORY_ORDER`);
  }
  assert.ok(CATEGORY_ORDER.includes(newsCategory({})));
  assert.ok(CATEGORY_ORDER.includes(newsCategory(null)));
});

test('scope wins over a stale category field', () => {
  // The db.json-era overload: a row can still carry both. The column is the
  // truth, because that is what 005_news_scopes.sql migrated the axis onto.
  assert.equal(newsCategory({ scope: 'international', category: 'somethingelse' }), 'International');
});

// Guards the next migration that widens news.scope: an unmapped scope would
// fall through to the live-news branch and be filed as State without erroring.
test('every SCOPES value maps to a category', () => {
  assert.deepEqual(unmappedScopes(), []);
});

test('normalizeCategory buckets the tracker spreadsheet vocabulary', () => {
  assert.equal(normalizeCategory('International'), 'International');
  assert.equal(normalizeCategory('  NATIONAL '),   'National');
  assert.equal(normalizeCategory('State/Region'),  'State');
  assert.equal(normalizeCategory(''),              'District');
  assert.equal(normalizeCategory(undefined),       'District');
});

test('SCOPE_TO_CATEGORY only produces known headings', () => {
  for (const cat of Object.values(SCOPE_TO_CATEGORY)) {
    assert.ok(CATEGORY_ORDER.includes(cat), `${cat} is in CATEGORY_ORDER`);
  }
});
