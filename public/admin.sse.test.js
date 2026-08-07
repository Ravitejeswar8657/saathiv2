// public/admin.sse.test.js
// The chat stream reader in admin.html, tested against the failure it exists to
// prevent.
//
// The reader is extracted from the page's inline <script> rather than duplicated
// here. Duplicating it would test a copy — and a copy that drifts from the page
// passes forever while the page is broken.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadReadSSE() {
  const html = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
  const start = html.indexOf('async function* readSSE(');
  assert.notEqual(start, -1, 'readSSE is no longer in admin.html — this test is stale');

  // Take to the end of the function by brace matching from its opening brace.
  const open = html.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  const source = html.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(`${source}; return readSSE;`)();
}

const readSSE = loadReadSSE();

// A ReadableStream that hands back exactly the chunks given, so the test controls
// where the boundaries fall.
function streamOf(chunks) {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) return controller.close();
      controller.enqueue(encoder.encode(chunks[i++]));
    },
  });
}

async function collect(chunks) {
  const frames = [];
  for await (const frame of readSSE(streamOf(chunks))) frames.push(frame);
  return frames;
}

const TURN =
  'event: start\ndata: {"conversation_id":"C1","message_id":"M1"}\n\n' +
  'event: token\ndata: {"text":"Hel"}\n\n' +
  'event: token\ndata: {"text":"lo there"}\n\n' +
  'event: done\ndata: {"conversation_id":"C1","message_id":"M2","grounding":[]}\n\n';

test('reads a well-framed stream', async () => {
  const frames = await collect([TURN]);
  assert.deepEqual(frames.map(f => f.event), ['start', 'token', 'token', 'done']);
  assert.equal(frames[0].data.conversation_id, 'C1');
  assert.equal(frames.filter(f => f.event === 'token').map(f => f.data.text).join(''), 'Hello there');
});

test('survives a boundary at EVERY byte position', async () => {
  // This is the bug the leftover buffer exists to prevent: chunk boundaries fall
  // mid-line and mid-JSON, and parsing per chunk only fails on a slow network —
  // which is exactly when streaming matters. Splitting at every offset covers
  // every way the network could have cut it.
  for (let i = 1; i < TURN.length; i++) {
    const frames = await collect([TURN.slice(0, i), TURN.slice(i)]);
    assert.deepEqual(
      frames.map(f => f.event), ['start', 'token', 'token', 'done'],
      `frames lost when split at byte ${i}`);
    assert.equal(
      frames.filter(f => f.event === 'token').map(f => f.data.text).join(''),
      'Hello there', `text corrupted when split at byte ${i}`);
  }
});

test('survives one byte at a time', async () => {
  const frames = await collect([...TURN]);
  assert.deepEqual(frames.map(f => f.event), ['start', 'token', 'token', 'done']);
});

test('a malformed frame is skipped, and the terminal frame still arrives', async () => {
  // A frame that fails to parse must not tear the stream down: the UI settles on
  // `done`, so losing `done` means a spinner that never stops.
  const frames = await collect([
    'event: start\ndata: {"conversation_id":"C1"}\n\n',
    'event: token\ndata: {this is not json}\n\n',
    'event: token\ndata: {"text":"ok"}\n\n',
    'event: done\ndata: {"message_id":"M2"}\n\n',
  ]);
  assert.deepEqual(frames.map(f => f.event), ['start', 'token', 'done']);
  assert.equal(frames[1].data.text, 'ok');
});

test('an unterminated trailing frame is dropped rather than half-parsed', async () => {
  // A stream cut mid-frame (the server died) must not yield a partial object the
  // UI would treat as real.
  const frames = await collect([
    'event: start\ndata: {"conversation_id":"C1"}\n\n',
    'event: token\ndata: {"text":"par',
  ]);
  assert.deepEqual(frames.map(f => f.event), ['start']);
});

test('text containing blank lines and colons survives framing', async () => {
  // SSE frames are delimited by a blank line, and `data:` is split on the first
  // colon — so a reply containing either must not confuse the reader.
  const text = 'Line one.\n\nLine two: with a colon.';
  const frames = await collect([`event: token\ndata: ${JSON.stringify({ text })}\n\n`]);
  assert.equal(frames[0].data.text, text);
});

test('an empty stream yields nothing and does not hang', async () => {
  assert.deepEqual(await collect([]), []);
  assert.deepEqual(await collect(['']), []);
});
