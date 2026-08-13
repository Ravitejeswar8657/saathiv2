// public/event-coverage.test.js
// The coverage summary strip on the schedule cards.
//
// chipsHTML is the one part of the coverage modal that runs on every render of
// both schedule pages, before anybody clicks anything — so a throw in it takes
// out the whole schedule list, not just the modal. It is also the only piece
// that is pure enough to test without a DOM.
//
// The real file is executed rather than reimplemented here, for the reason
// admin.sse.test.js gives: a copy that drifts passes forever while the page is
// broken.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEventCoverage() {
  const source = fs.readFileSync(path.join(__dirname, 'js', 'event-coverage.js'), 'utf8');
  // The module injects its stylesheet at load time; this is the whole DOM it
  // needs to get as far as defining its API.
  const document = {
    createElement: () => ({ textContent: '' }),
    head: { appendChild() {} },
  };
  const window = {};
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', source)(window, document);
  assert.ok(window.EventCoverage, 'event-coverage.js no longer exports EventCoverage');
  return window.EventCoverage;
}

const EventCoverage = loadEventCoverage();

test('an event with nothing recorded says so, rather than rendering blank', () => {
  // A blank strip is indistinguishable from a styling bug. The point of the
  // strip is telling staff which events still need writing up.
  const html = EventCoverage.chipsHTML({ id: 'E1', event_name: 'Village meeting' });
  assert.match(html, /No coverage yet/);
});

test('the strip counts links and files and flags a social post', () => {
  const html = EventCoverage.chipsHTML({
    media_links: [{ url: 'https://a' }, { url: 'https://b' }],
    media: [{ filename: 'x.jpg' }],
    social_posted: true,
    coverage_notes: 'went well',
  });
  assert.match(html, />2</, 'two media links');
  assert.match(html, />1</, 'one attachment');
  assert.match(html, /cov-chip-posted/);
  assert.doesNotMatch(html, /No coverage yet/);
});

test('social_posted false is not a coverage chip', () => {
  // Answering "no" is an answer, but it is not something to badge — only a post
  // that actually went out earns the Posted chip.
  const html = EventCoverage.chipsHTML({ media_links: [{ url: 'https://a' }], social_posted: false });
  assert.doesNotMatch(html, /cov-chip-posted/);
});

test('an event straight from POST /api/schedule renders without throwing', () => {
  // A freshly created event has none of the coverage keys at all — the card is
  // rendered from the list response the moment it is added.
  assert.doesNotThrow(() => EventCoverage.chipsHTML({ id: 'E2', date: '2026-08-14' }));
});
