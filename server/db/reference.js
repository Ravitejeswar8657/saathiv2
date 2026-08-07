// server/db/reference.js
// Canonical reference data, seeded into `entities`.
//
// This replaces the MANDAL_ALIAS map and EXCLUDED_MANDALS set hardcoded in
// public/admin.html — reference data that lived in one page's <script> tag,
// invisible to every other consumer, and wrong in two ways:
//
//   · It had no entry for "Ipur", which is how 170 contacts spell their mandal.
//     The canonical list says "Ipuru", so those contacts silently failed to join
//     and simply did not appear in the mandal rollups.
//   · It mapped "Sattenapalli" to "Sattenapalle" — but the canonical list says
//     "Sattenapalli". The alias rewrote a correct name into one that exists
//     nowhere, breaking the mandal it was supposed to fix.
//
// Both are the same class of failure: a lookup miss returns nothing, and nothing
// is indistinguishable from "no data in that mandal" on a dashboard.
import { getDb } from './connection.js';
import { resolveEntity, addAliases } from './records.js';

// The 28 mandals of the constituency, spelled as public/js/saathi-ui.js spells
// them, each with the spellings that actually occur in the imported data.
export const MANDALS = [
  { name: 'Amaravathi' },
  { name: 'Atchampet' },
  { name: 'Bellamkonda' },
  { name: 'Krosuru' },
  { name: 'Muppalla' },
  { name: 'Nekarikallu' },
  { name: 'Pedakurapadu' },
  { name: 'Rajupalem' },
  { name: 'Sattenapalli', aliases: ['Sattenapalle'] },
  { name: 'Bollapalle' },
  { name: 'Chilakaluripet', aliases: ['Chilakaluripeta'] },
  { name: 'Edlapadu' },
  { name: 'Ipuru', aliases: ['Ipur'] },
  { name: 'Nadendla' },
  { name: 'Narasaraopet' },
  { name: 'Nuzendla' },
  { name: 'Rompicherla' },
  { name: 'Savalyapuram' },
  { name: 'Vinukonda' },
  { name: 'Dachepalle', aliases: ['Dachepalli'] },
  { name: 'Durgi' },
  { name: 'Gurazala', aliases: ['Gurajala'] },
  { name: 'Karempudi' },
  { name: 'Machavaram' },
  { name: 'Macherla' },
  { name: 'Piduguralla', aliases: ['Pidugurala'] },
  { name: 'Rentachintala' },
  { name: 'Veldurthi' },
];

// Places that appear in the data but are not mandals of this constituency. They
// are seeded so that a reader can see WHY they are absent from a rollup, rather
// than discovering the exclusion in a page's JavaScript.
export const NON_CONSTITUENCY_PLACES = ['Thummalacheruvu', 'Veerapuram'];

/**
 * Seed the canonical places. Must run BEFORE any collection is loaded: entity
 * resolution matches the canonical name first and its aliases second, so a
 * contact whose mandal reads "Ipur" only lands on the "Ipuru" node if that node
 * already carries the alias.
 *
 * Idempotent — resolveEntity finds the existing row, addAliases dedupes.
 */
export function seedReference() {
  const db = getDb();
  const run = db.transaction(() => {
    for (const { name, aliases } of MANDALS) {
      const entity = resolveEntity('place', name);
      if (aliases?.length) addAliases(entity.id, aliases);
      markMeta(entity.id, { mandal: true, constituency: true });
    }
    for (const name of NON_CONSTITUENCY_PLACES) {
      const entity = resolveEntity('place', name);
      markMeta(entity.id, { mandal: true, constituency: false });
    }
  });
  run();
  return MANDALS.length + NON_CONSTITUENCY_PLACES.length;
}

function markMeta(entityId, patch) {
  const db = getDb();
  const row = db.prepare('SELECT meta FROM entities WHERE id = ?').get(entityId);
  let meta = {};
  try { meta = JSON.parse(row?.meta || '{}'); } catch { meta = {}; }
  db.prepare('UPDATE entities SET meta = ? WHERE id = ?')
    .run(JSON.stringify({ ...meta, ...patch }), entityId);
}

/**
 * Resolve a written mandal name to its canonical spelling.
 *
 * The replacement for normalizeMandalName() in admin.html. Returns the input
 * unchanged when nothing matches, so an unknown place stays visible as itself
 * rather than vanishing.
 */
export function canonicalMandal(name) {
  const entity = resolveEntity('place', name);
  return entity ? entity.name : name;
}

/** Mandals of this constituency, canonical spelling, for dropdowns and rollups. */
export function listMandals({ includeNonConstituency = false } = {}) {
  return getDb().prepare(`
    SELECT name, meta FROM entities
     WHERE kind = 'place' AND deleted_at IS NULL
       AND json_extract(meta, '$.mandal') = 1
       ${includeNonConstituency ? '' : "AND json_extract(meta, '$.constituency') = 1"}
     ORDER BY name`).all().map(r => r.name);
}
