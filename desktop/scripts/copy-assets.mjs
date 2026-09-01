// Copies static runtime assets (the tray template + window icon) from src/assets
// into dist/assets, next to the compiled main bundle. tray.ts resolves the tray
// image at app.getAppPath()/dist/assets, and `files: dist/**` ships it inside the
// asar — so without this step the packaged tray falls back to an empty image.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src', 'assets');
const dest = path.join(here, '..', 'dist', 'assets');

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
// Ship the raster assets only; the SVG sources stay out of the bundle.
for (const entry of fs.readdirSync(src)) {
  if (entry.endsWith('.png')) fs.copyFileSync(path.join(src, entry), path.join(dest, entry));
}

console.log(`[copy-assets] ${src} → ${dest}`);
