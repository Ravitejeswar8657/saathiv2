import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fontkitPath = path.join(__dirname, '..', 'node_modules', 'fontkit', 'dist', 'main.cjs');

if (!fs.existsSync(fontkitPath)) {
  console.log('fontkit not found, skipping patch');
  process.exit(0);
}

let src = fs.readFileSync(fontkitPath, 'utf8');

const oldCode = `    getAnchor(anchor) {
        // TODO: contour point, device tables
        let x = anchor.xCoordinate;
        let y = anchor.yCoordinate;`;

const newCode = `    getAnchor(anchor) {
        // TODO: contour point, device tables
        if (!anchor) return { x: 0, y: 0 };
        let x = anchor.xCoordinate || 0;
        let y = anchor.yCoordinate || 0;`;

if (src.includes('if (!anchor) return')) {
  console.log('fontkit already patched');
  process.exit(0);
}

if (!src.includes(oldCode)) {
  console.log('fontkit source changed, patch may not apply');
  process.exit(0);
}

src = src.replace(oldCode, newCode);
fs.writeFileSync(fontkitPath, src);
console.log('fontkit patched: null anchor guard added for Telugu GPOS support');
