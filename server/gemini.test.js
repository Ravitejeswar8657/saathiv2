import { test } from 'node:test';
import assert from 'node:assert/strict';

// Set before the import: the model chain and the backoff base are read once, at
// module load. A 1ms base is what keeps this suite instant instead of sleeping
// through the real ~0.5s/1s/2s ladder.
process.env.GEMINI_API_KEY = 'test-key';
process.env.GEMINI_MODELS = 'model-a,model-b';
process.env.GEMINI_RETRY_BASE_MS = '1';

const { extractGrievanceFromText } = await import('./gemini.js');

// Every retried failure logs the provider's raw body for the server log. That is the
// point of the feature, but it would bury the test output.
console.error = () => {};

const CATEGORIES = [{ key: 'roads', label: 'Roads and drainage' }];

const EXTRACTED = {
  issue_description: 'Street light out near the temple',
  category: 'roads',
  urgency: 'Medium',
  is_grievance: true,
  confidence: 'High',
  sentiment: 'Neutral',
};

const ok = () => ({
  ok: true,
  status: 200,
  json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(EXTRACTED) }] } }] }),
});

// The real 503 body, which is exactly what must never reach a PA's screen.
const fail = status => ({
  ok: false,
  status,
  text: async () => `{"error":{"code":${status},"message":"The model is overloaded. Please try again later.","status":"UNAVAILABLE"}}`,
});

// Returns the list of URLs called, so a test can assert which model served.
function stubFetch(responses) {
  const calls = [];
  global.fetch = async url => {
    calls.push(String(url));
    const next = responses.shift();
    assert.ok(next, `unexpected extra request: ${url}`);
    return next();
  };
  return calls;
}

const modelsCalled = calls => calls.map(u => u.match(/models\/([^:]+):/)[1]);

test('retries a transient 503 and succeeds on the same model', async () => {
  const calls = stubFetch([() => fail(503), ok]);
  assert.deepEqual(await extractGrievanceFromText('street light out', CATEGORIES), EXTRACTED);
  assert.deepEqual(modelsCalled(calls), ['model-a', 'model-a']);
});

test('falls back to the next model when the first stays overloaded', async () => {
  const calls = stubFetch([() => fail(503), () => fail(503), () => fail(503), ok]);
  assert.deepEqual(await extractGrievanceFromText('street light out', CATEGORIES), EXTRACTED);
  assert.deepEqual(modelsCalled(calls), ['model-a', 'model-a', 'model-a', 'model-b']);
});

test('a model the key cannot use is skipped without retrying it', async () => {
  const calls = stubFetch([() => fail(404), ok]);
  assert.deepEqual(await extractGrievanceFromText('street light out', CATEGORIES), EXTRACTED);
  assert.deepEqual(modelsCalled(calls), ['model-a', 'model-b']);
});

test('a rejected key fails at once, with no retry and no fallback', async () => {
  const calls = stubFetch([() => fail(401)]);
  await assert.rejects(
    extractGrievanceFromText('street light out', CATEGORIES),
    e => /key was rejected/.test(e.message) && e.status === 401,
  );
  assert.equal(calls.length, 1);
});

test('an exhausted chain reports plainly and never leaks the provider body', async () => {
  const calls = stubFetch(Array.from({ length: 6 }, () => () => fail(503)));
  await assert.rejects(extractGrievanceFromText('street light out', CATEGORIES), e => {
    assert.match(e.message, /busy right now \(tried 2 models\)/);
    assert.doesNotMatch(e.message, /overloaded|UNAVAILABLE|503/);
    assert.equal(e.status, 503);
    assert.equal(e.retriable, true);
    return true;
  });
  assert.equal(calls.length, 6);
});
