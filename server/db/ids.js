// server/db/ids.js
// ULIDs. One id generator for the whole app, replacing the `${PREFIX}${Date.now()}`
// pattern that every collection used (`SCH…`, `NEWS…`, `TTD…`, `SM…`, `CHAT…`).
//
// That pattern had two real defects:
//
//   · Two records created in the same millisecond got the SAME id. The bulk paths
//     already knew this and worked around it by hand (`VF${ts}_${idx}`,
//     `CR${ts}_${idx}`), which is the tell — the single-record paths had the same
//     bug and no workaround.
//   · Millisecond-resolution ids sort by string, not by time, once the digit count
//     changes. Every "newest first" list was really an insertion-order list that
//     happened to agree.
//
// A ULID is a 48-bit timestamp followed by 80 bits of randomness, Crockford
// base32, 26 characters, fixed width. Fixed width is the point: LEXICAL ORDER IS
// CHRONOLOGICAL ORDER, so `ORDER BY id` is a time sort, `id < ?` is a keyset
// cursor, and neither needs a parsed date or a second column.
//
// Adapted from ../../../brain/services/core/lib/ids.py, where the same property
// carries the conversation and message cursors.
import crypto from 'crypto';

// Crockford base32: no I, L, O or U, so an id cannot be misread aloud or retyped
// into a different id. Staff do read these off screens when reconciling paper.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = -1;
let lastRandom = null;

function encodeTime(ms) {
  let out = '';
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out = ALPHABET[ms % 32] + out;
    ms = Math.floor(ms / 32);
  }
  return out;
}

function randomBytes() {
  const bytes = crypto.randomBytes(RANDOM_LEN);
  // One byte per character, masked to 5 bits. Wasteful of entropy and completely
  // adequate: 80 bits of randomness per millisecond.
  return Array.from(bytes, b => b & 0x1f);
}

// Increment the random component in place, base-32, least-significant first.
// Used only for ids minted inside a single millisecond, so that a batch insert
// stays strictly ordered instead of relying on luck.
function incrementRandom(values) {
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] < 31) {
      values[i] += 1;
      return values;
    }
    values[i] = 0;
  }
  // Overflowed all 80 bits within one millisecond. Not reachable in this app;
  // re-seeding is still the right answer if it ever is.
  return randomBytes();
}

/**
 * A new ULID. Monotonic: two calls in the same millisecond are strictly ordered,
 * so a bulk insert's ids sort the way the batch was written.
 */
export function ulid(now = Date.now()) {
  if (now === lastTime && lastRandom) {
    lastRandom = incrementRandom(lastRandom);
  } else {
    lastTime = now;
    lastRandom = randomBytes();
  }
  return encodeTime(now) + lastRandom.map(v => ALPHABET[v]).join('');
}

/**
 * A prefixed id, for tables whose ids are read by humans (`G01J…` on a grievance
 * printout is easier to place than a bare ULID). The prefix sits OUTSIDE the
 * sortable part, so ids only sort chronologically within one prefix — which is
 * all any query needs, since prefixes do not mix within a table.
 */
export function prefixedId(prefix) {
  return `${prefix}${ulid()}`;
}

/** The timestamp a ULID was minted at. Handy in tests and in data forensics. */
export function ulidTime(id) {
  const time = id.slice(-26, -RANDOM_LEN);
  let ms = 0;
  for (const ch of time) {
    const v = ALPHABET.indexOf(ch);
    if (v === -1) return null;
    ms = ms * 32 + v;
  }
  return new Date(ms);
}

/** UTC ISO-8601, milliseconds included, fixed width. The only timestamp format. */
export function now() {
  return new Date().toISOString();
}
