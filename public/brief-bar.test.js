// public/brief-bar.test.js
// The single "Prepare brief" control that replaced the per-date brief buttons.
//
// It runs on every render of the dashboard and the PA schedule, and it decides
// which date the brief opens for — pick the wrong one and staff prepare the
// wrong day's brief without any error to warn them. The date arithmetic is pure,
// so it is testable without a DOM.
//
// The real file is executed rather than reimplemented here, for the reason
// event-coverage.test.js gives: a copy that drifts passes forever while the page
// is broken.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadSaathiUI() {
  const source = fs.readFileSync(path.join(__dirname, 'js', 'saathi-ui.js'), 'utf8');
  const window = {};
  const document = { getElementById: () => null };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', source)(window, document);
  assert.ok(window.SaathiUI, 'saathi-ui.js no longer exports SaathiUI');
  return window.SaathiUI;
}

const SaathiUI = loadSaathiUI();

const TODAY = '2026-08-13';
const SCHEDULE = [
  { date: '2026-08-18', event_name: 'Cadre meeting' },
  { date: '2026-08-13', event_name: 'Public meeting' },
  { date: '2026-08-15', event_name: 'Inauguration' },
  { date: '2026-08-13', event_name: 'Grievance camp' },
  { date: '2026-08-01', event_name: 'Condolence visit' },
];

function selectedDate(html) {
  const m = html.match(/value="([^"]+)" selected/);
  return m ? m[1] : null;
}

test('one row per date, chronological, counting the events on each', () => {
  // Several events on one day collapsing into one row is the whole point: the
  // old UI drew a brief button per date group and repeated itself down the page.
  assert.deepStrictEqual(SaathiUI.briefDates(SCHEDULE, TODAY), [
    { date: '2026-08-01', count: 1, label: 'Sat, 1 Aug · 1 event' },
    { date: '2026-08-13', count: 2, label: 'Today · 2 events' },
    { date: '2026-08-15', count: 1, label: 'Sat, 15 Aug · 1 event' },
    { date: '2026-08-18', count: 1, label: 'Tue, 18 Aug · 1 event' },
  ]);
});

test('only dates that have events are offered', () => {
  // The wizard dead-ends on "No events for this date", so an offered date that
  // has none is a trap. 14 Aug and 16 Aug must not appear.
  const html = SaathiUI.briefBarHTML(SCHEDULE, { todayIST: TODAY });
  const offered = [...html.matchAll(/value="([^"]+)"/g)].map(m => m[1]);
  assert.deepStrictEqual(offered, ['2026-08-01', '2026-08-13', '2026-08-15', '2026-08-18']);
});

test('today is preselected when today has events', () => {
  assert.strictEqual(selectedDate(SaathiUI.briefBarHTML(SCHEDULE, { todayIST: TODAY })), TODAY);
});

test('with nothing on today, the next upcoming date is preselected — not a past one', () => {
  const html = SaathiUI.briefBarHTML(
    [{ date: '2026-08-01' }, { date: '2026-08-15' }, { date: '2026-08-18' }],
    { todayIST: TODAY },
  );
  assert.strictEqual(selectedDate(html), '2026-08-15');
});

test('with everything in the past, the most recent past date is preselected', () => {
  const html = SaathiUI.briefBarHTML([{ date: '2026-08-01' }, { date: '2026-08-05' }], { todayIST: TODAY });
  assert.strictEqual(selectedDate(html), '2026-08-05');
});

test('an explicit selection wins — clicking a calendar day preloads that date', () => {
  const html = SaathiUI.briefBarHTML(SCHEDULE, { todayIST: TODAY, selected: '2026-08-01' });
  assert.strictEqual(selectedDate(html), '2026-08-01');
});

test('a selected date with no events falls back rather than offering an empty brief', () => {
  const html = SaathiUI.briefBarHTML(SCHEDULE, { todayIST: TODAY, selected: '2026-08-14' });
  assert.strictEqual(selectedDate(html), TODAY);
  assert.ok(!html.includes('2026-08-14'), 'an eventless date leaked into the dropdown');
});

test('an empty schedule renders nothing at all', () => {
  // The callers inject this straight into a container, so '' is what makes the
  // bar disappear instead of offering a brief for no events.
  assert.strictEqual(SaathiUI.briefBarHTML([], { todayIST: TODAY }), '');
  assert.strictEqual(SaathiUI.briefBarHTML(undefined, { todayIST: TODAY }), '');
});

test('events without a date are ignored rather than producing a blank option', () => {
  const html = SaathiUI.briefBarHTML([{ event_name: 'Unscheduled' }, { date: TODAY }], { todayIST: TODAY });
  assert.strictEqual([...html.matchAll(/<option /g)].length, 1);
  assert.strictEqual(selectedDate(html), TODAY);
});

test('the select id is threaded through to the button, so two bars cannot collide', () => {
  const html = SaathiUI.briefBarHTML(SCHEDULE, { todayIST: TODAY, id: 'dash-brief-date' });
  assert.ok(html.includes('<select id="dash-brief-date"'));
  assert.ok(html.includes(`SaathiUI.openBrief('dash-brief-date')`));
});
