// Copies the renderer assets (wizard + loading HTML/CSS/JS) into dist/renderer
// so they sit next to the compiled main/preload bundles.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src', 'renderer');
const dest = path.join(here, '..', 'dist', 'renderer');

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
fs.cpSync(src, dest, { recursive: true });

console.log(`[copy-renderer] ${src} → ${dest}`);
