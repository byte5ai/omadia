// Regenerates the committed PNG icon assets from the one master logo.
//
//   (repo) $ cd desktop && npm run gen-icons
//
// The PNGs are checked in (so a normal `npm run build` needs no rasteriser and
// the shipped bytes are stable); run this only when the master logo changes.
// Output is deterministic — sharp writes no timestamp and metadata is stripped —
// so a regen with the same source and sharp version reproduces identical bytes.
//
//   buildResources/icon-source.png  → buildResources/icon.png        (1024, installer/About; electron-builder derives .icns/.ico)
//                                   → src/assets/icon.png            (512, BrowserWindow icon on win/linux)
//                                   → src/assets/trayTemplate.png    (16, macOS menu-bar template)
//                                   → src/assets/trayTemplate@2x.png  (32, retina)
//
// The tray variants are NOT the colour logo shrunk: a macOS template image must
// be pure black + alpha (the OS tints it), so we derive a monochrome glyph — the
// coloured body of the mark becomes black and the light "5" is knocked out to
// transparent, so it reads as the 5 in negative space instead of a black blob.
import sharp from 'sharp';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const buildResources = path.join(here, '..', 'buildResources');
const assets = path.join(here, '..', 'src', 'assets');

const source = path.join(buildResources, 'icon-source.png');

/** Scale the colour logo to a square PNG of the given edge length. */
async function renderApp(size, out) {
  await sharp(source)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(out);
  console.log(`[gen-icons] ${path.relative(here, out)} (${size}px, colour)`);
}

// A pixel is "on" (drawn black) when it is opaque AND not near-white. The blue
// mark clears this; the white "5" and the transparent corners do not — so the 5
// falls out as a hole. Threshold on Rec.709 luma; 190 sits well above the blue
// (~130) and below white (255), so antialiased edges resolve the right way.
const LUMA_ON_MAX = 190;

/** Build the monochrome menu-bar template at source resolution, then downscale. */
async function renderTray(size, out) {
  const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const mask = Buffer.alloc(info.width * info.height * 4); // RGBA, all black; alpha set below
  for (let i = 0; i < info.width * info.height; i++) {
    const p = i * info.channels;
    const luma = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
    const on = data[p + 3] > 128 && luma < LUMA_ON_MAX;
    mask[i * 4 + 3] = on ? 255 : 0;
  }
  await sharp(mask, { raw: { width: info.width, height: info.height, channels: 4 } })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(out);
  console.log(`[gen-icons] ${path.relative(here, out)} (${size}px, template)`);
}

await renderApp(1024, path.join(buildResources, 'icon.png'));
await renderApp(512, path.join(assets, 'icon.png'));
await renderTray(16, path.join(assets, 'trayTemplate.png'));
await renderTray(32, path.join(assets, 'trayTemplate@2x.png'));
