// One-time script: geocode the 28 official Palnadu district mandals via the
// free OpenStreetMap Nominatim API and write their centroid coordinates to
// public/assets/mandal_coords.json. No API key required.
//
// Usage: node scripts/geocode_mandals.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, '..', 'public', 'assets', 'mandal_coords.json');

const MANDALS = [
  'Amaravathi', 'Atchampet', 'Bellamkonda', 'Bollapalle', 'Chilakaluripet',
  'Dachepalle', 'Durgi', 'Edlapadu', 'Gurazala', 'Ipur', 'Karempudi',
  'Krosuru', 'Machavaram', 'Macherla', 'Muppalla', 'Nadendla',
  'Narasaraopet', 'Nekarikallu', 'Nuzendla', 'Pedakurapadu', 'Piduguralla',
  'Rajupalem', 'Rentachintala', 'Rompicherla', 'Sattenapalle',
  'Savalyapuram', 'Veldurthi', 'Vinukonda',
];

const USER_AGENT = 'Saathi-v2-Palnadu-Heatmap/1.0 (one-time mandal geocoding; contact: ravitejeswarravi@gmail.com)';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for query "${query}"`);
  const data = await res.json();
  if (!data.length) return null;
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
}

async function main() {
  const results = {};
  const failures = [];

  for (const mandal of MANDALS) {
    const primaryQuery = `${mandal} mandal, Palnadu district, Andhra Pradesh, India`;
    let coords = null;
    try {
      coords = await geocode(primaryQuery);
    } catch (err) {
      console.error(`Error geocoding "${mandal}": ${err.message}`);
    }

    if (!coords) {
      await sleep(1100);
      const fallbackQuery = `${mandal}, Andhra Pradesh, India`;
      try {
        coords = await geocode(fallbackQuery);
      } catch (err) {
        console.error(`Error on fallback for "${mandal}": ${err.message}`);
      }
    }

    if (coords) {
      results[mandal] = coords;
      console.log(`OK   ${mandal.padEnd(16)} -> ${coords.lat}, ${coords.lng}`);
    } else {
      failures.push(mandal);
      console.log(`FAIL ${mandal.padEnd(16)} -> no result`);
    }

    await sleep(1100); // Nominatim usage policy: max 1 req/sec
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(results, null, 2) + '\n');
  console.log(`\nWrote ${Object.keys(results).length}/${MANDALS.length} mandals to ${OUT_PATH}`);
  if (failures.length) {
    console.log(`Failed to geocode: ${failures.join(', ')} — add these manually.`);
  }
}

main();
