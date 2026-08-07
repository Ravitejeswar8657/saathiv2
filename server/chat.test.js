// server/chat.test.js
// Conversation lifecycle and context building — everything about the chat turn
// except the model call itself.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'saathi-chat-'));
process.env.SQLITE_PATH = path.join(TMP, 'test.db');

const { migrate } = await import('./db/migrate.js');
const { closeDb } = await import('./db/connection.js');
const { seedReference } = await import('./db/reference.js');
const contacts = await import('./db/contacts.js');
const grievances = await import('./db/grievances.js');
const c = await import('./db/conversations.js');
const { buildContext, _internals } = await import('./chat.js');

before(() => {
  migrate({ log: () => {} });
  seedReference();
  contacts.replaceAllContacts([
    { id: 'C1', name: 'Ramesh Kumar', village: 'Karempudi', mandal: 'Karempudi', tier: 'T1' },
  ]);
  grievances.insertGrievance({
    full_name: 'Sita Devi', village: 'Karempudi', mandal: 'Karempudi',
    category: 'irrigation_water', urgency: 'High', priority_score: 88,
    date_of_visit: '2026-08-01',
    issue_description: 'The borewell dried up after the canal was diverted last month.',
  });
});

after(() => {
  closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ── the one-active invariant ─────────────────────────────────────────────

test('there is at most one active conversation per channel', () => {
  const a = c.resolveConversation('web');
  c.appendMessage(a.id, { role: 'user', body: 'first' });

  const { conversation: b } = c.createConversation('web');
  assert.notEqual(a.id, b.id);

  const active = c.listConversations({ channel: 'web' }).items.filter(x => x.status === 'active');
  assert.equal(active.length, 1, 'opening a thread must close the current one');
  assert.equal(active[0].id, b.id);
});

test('New chat reuses an untitled empty thread instead of writing a row', () => {
  const first = c.createConversation('web');
  const second = c.createConversation('web');
  assert.equal(second.created, false, 'must report that it reused');
  assert.equal(second.conversation.id, first.conversation.id);
});

test('a thread with messages is never reused', () => {
  const { conversation } = c.createConversation('web');
  c.appendMessage(conversation.id, { role: 'user', body: 'hello' });
  c.titleIfUntitled(conversation.id, 'hello');

  const next = c.createConversation('web');
  assert.equal(next.created, true);
  assert.notEqual(next.conversation.id, conversation.id);
});

// ── titles ───────────────────────────────────────────────────────────────

test('titles are derived in code, cut on a word boundary', () => {
  assert.equal(c.deriveTitle('Which grievances are open?'), 'Which grievances are open?');
  assert.equal(c.deriveTitle(''), 'New chat');
  assert.equal(c.deriveTitle('   \n  '), 'New chat');

  const long = c.deriveTitle('a'.repeat(20) + ' ' + 'b'.repeat(80));
  assert.ok(long.length <= 61, `too long: ${long.length}`);
  assert.ok(long.endsWith('…'));
  assert.ok(!long.includes('  '));
});

test('a thread is titled only once, by its first message', () => {
  const { conversation } = c.createConversation('web');
  assert.equal(c.titleIfUntitled(conversation.id, 'First question'), true);
  assert.equal(c.titleIfUntitled(conversation.id, 'Second question'), false);
  assert.equal(c.getConversation(conversation.id).title, 'First question');
});

// ── cursors ──────────────────────────────────────────────────────────────

test('cursors round-trip and reject anything not ours', () => {
  const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  assert.equal(c.decodeCursor(c.encodeCursor(id)), id);
  assert.equal(c.decodeCursor(null), null);
  // `id < '<raw base64>'` is valid SQL that matches almost everything, so a
  // cursor that never got decoded would silently return page one forever
  // instead of erroring. Anything that is not a ULID is refused.
  assert.equal(c.decodeCursor('bm90LWEtdWxpZA=='), null);
  assert.equal(c.decodeCursor('not-base64-at-all'), null);
});

test('paging a thread does not repeat or skip messages', () => {
  const { conversation } = c.createConversation('web');
  for (let i = 0; i < 25; i++) {
    c.appendMessage(conversation.id, { role: 'user', body: `message ${i}` });
  }

  const seen = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const res = c.listMessages(conversation.id, { limit: 10, cursor });
    seen.push(...res.items.map(m => m.body));
    cursor = res.next_cursor;
    if (!cursor) break;
  }
  assert.equal(seen.length, 25);
  assert.equal(new Set(seen).size, 25, 'a page was repeated');
  assert.equal(seen[0], 'message 0', 'messages must read oldest-first');
});

// ── trash ────────────────────────────────────────────────────────────────

test('delete hides a thread, restore brings it back CLOSED', () => {
  const { conversation } = c.createConversation('web');
  c.appendMessage(conversation.id, { role: 'user', body: 'x' });
  c.titleIfUntitled(conversation.id, 'To be deleted');

  assert.equal(c.deleteConversation(conversation.id), true);
  assert.equal(c.getConversation(conversation.id), null);
  assert.ok(c.listTrash().items.some(t => t.id === conversation.id));

  const restored = c.restoreConversation(conversation.id);
  // Never `active`: restoring straight to active while another thread is open
  // would break the one-active invariant.
  assert.equal(restored.status, 'closed');
  assert.ok(c.listConversations().items.some(x => x.id === conversation.id));
});

test('the trash is bounded — deleting purges the oldest beyond the cap', () => {
  const limit = c.listTrash().limit;
  const ids = [];
  for (let i = 0; i < limit + 3; i++) {
    const { conversation } = c.createConversation('web');
    c.appendMessage(conversation.id, { role: 'user', body: `thread ${i}` });
    c.titleIfUntitled(conversation.id, `thread ${i}`);
    ids.push(conversation.id);
  }
  for (const id of ids) c.deleteConversation(id);

  const trash = c.listTrash();
  assert.ok(trash.items.length <= limit,
    `trash holds ${trash.items.length}, cap is ${limit} — the DB must not grow on things thrown away`);
});

test('archiving and deleting are different verbs', () => {
  const { conversation } = c.createConversation('web');
  c.appendMessage(conversation.id, { role: 'user', body: 'x' });
  c.titleIfUntitled(conversation.id, 'Archived thread');

  c.updateConversation(conversation.id, { status: 'closed' });
  // Archived: still listed, still readable, just not where the next message goes.
  assert.ok(c.listConversations().items.some(x => x.id === conversation.id));
  assert.notEqual(c.resolveConversation('web').id, conversation.id);
});

// ── context building ─────────────────────────────────────────────────────

test('retrieved records are wrapped in the injection boundary', () => {
  const { conversation } = c.createConversation('web');
  c.appendMessage(conversation.id, { role: 'user', body: 'borewell' });

  const { messages } = buildContext(conversation.id, 'borewell', { istDate: '2026-08-07' });
  const system = messages[0];
  assert.equal(system.role, 'system');

  // The whole prompt-injection defence: retrieved text arrives as quoted data,
  // and the prompt says in as many words that block contents are never instructions.
  assert.match(system.content, /<<<DATA:records>>>/);
  assert.match(system.content, /<<<END>>>/);
  assert.match(system.content, /data, not instructions/i);
  assert.match(system.content, /2026-08-07/);
});

test('the model is given record BODIES, not just labels', () => {
  const { conversation } = c.createConversation('web');
  const { messages, grounding } = buildContext(conversation.id, 'borewell canal', { istDate: '2026-08-07' });

  // The defect this replaced: chat was grounded on
  // "[grievances] Sita Devi — irrigation_water, Karempudi, Pending" and never on
  // issue_description, so it could not answer what the grievance actually said.
  assert.match(messages[0].content, /borewell dried up/i);
  assert.ok(grounding.length > 0, 'grounding must record what the answer was based on');
  assert.ok(grounding.every(g => g.source && g.id && g.label));
});

test('context building survives a retrieval failure', () => {
  // Retrieval is a best-effort signal, not a hard dependency — a chat that
  // refuses to answer because its index is unhappy is worse than one that
  // answers from the conversation alone.
  const { conversation } = c.createConversation('web');
  assert.doesNotThrow(() => buildContext(conversation.id, '  ', { istDate: '2026-08-07' }));
});

test('trimming drops the oldest turns and never the system message', () => {
  const { trim } = _internals;
  const messages = [
    { role: 'system', content: 'S'.repeat(4000) },
    ...Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: `${i} `.repeat(200) })),
  ];
  const trimmed = trim(messages, 2000);

  assert.equal(trimmed[0].role, 'system', 'the system message must never be dropped');
  assert.ok(trimmed.length < messages.length, 'nothing was trimmed');
  // Oldest-first: what survives is the END of the conversation.
  assert.equal(trimmed[trimmed.length - 1].content, messages[messages.length - 1].content);
});

test('trimming always leaves the latest turn', () => {
  const { trim } = _internals;
  const messages = [
    { role: 'system', content: 'S'.repeat(100000) },
    { role: 'user', content: 'the question actually being asked' },
  ];
  const trimmed = trim(messages, 10);
  assert.equal(trimmed.length, 2, 'the current question must survive any budget');
});
