// Regenerates every raster icon from the two committed SVG sources (#888).
//
// WHY a script and not hand-exported binaries: the desktop app needs the same
// artwork in six shapes (icns, ico, a 1024 png, a window png, and two tray
// template pngs). Hand-exporting them drifts — one gets updated, five keep the
// old mark. Here the SVGs are the source of truth and the rasters are output.
//
// The generated files ARE committed: `npm run build` must not need librsvg, and
// CI must not need a rasteriser. Run this only when the artwork changes:
//
//     npm run icons
//
// Requirements for regeneration (not for building or running the app):
//   * `sharp` — resolved from any sibling workspace that already has it
//     (middleware/web-ui). Deliberately NOT a desktop dependency: it is a
//     ~30MB native module for a script that runs when the logo changes.
//   * `iconutil` — macOS only, and the canonical way to build an .icns.
//     On Linux/Windows the script writes the .iconset and skips the .icns.
//
// The .ico is written by hand (see `buildIco`): an ICO is a directory of PNGs,
// so writing the 22-byte header ourselves removes an ImageMagick dependency.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const repo = path.join(desktop, '..');
const buildResources = path.join(desktop, 'buildResources');
const assets = path.join(desktop, 'assets');

const APP_SVG = path.join(buildResources, 'icon.svg');
const TRAY_SVG = path.join(buildResources, 'trayTemplate.svg');

/** Apple's expected iconset members: [file suffix, pixel size]. */
const ICONSET = [
  ['16x16', 16],
  ['16x16@2x', 32],
  ['32x32', 32],
  ['32x32@2x', 64],
  ['128x128', 128],
  ['128x128@2x', 256],
  ['256x256', 256],
  ['256x256@2x', 512],
  ['512x512', 512],
  ['512x512@2x', 1024],
];

/** Sizes Windows shells actually pick from, smallest first. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function loadSharp() {
  const require = createRequire(import.meta.url);
  const candidates = [
    path.join(desktop, 'node_modules'),
    path.join(repo, 'middleware', 'node_modules'),
    path.join(repo, 'web-ui', 'node_modules'),
  ];
  try {
    return require(require.resolve('sharp', { paths: candidates }));
  } catch {
    throw new Error(
      'make-icons needs `sharp` to rasterise the SVGs. It is not a desktop\n' +
        'dependency on purpose — install the middleware or web-ui workspace\n' +
        '(`npm install` in either) and run this again. The committed PNG/ICNS/ICO\n' +
        'files mean the normal build never needs it.',
    );
  }
}

/**
 * Renders an SVG at an exact pixel size.
 *
 * `density` is scaled with the target so librsvg rasterises at the final
 * resolution instead of upscaling a 96dpi bitmap — without it the 1024px icon
 * comes out visibly soft.
 */
async function render(sharp, svg, size) {
  const density = Math.max(72, Math.round((size / 236) * 96 * 2));
  return sharp(svg, { density })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * Forces every pixel to black while keeping the alpha channel.
 *
 * A macOS template image is read through its alpha; the RGB is irrelevant to
 * macOS but not to a human opening the file, and antialiasing leaves grey
 * fringes that look like a bug. Zeroing RGB makes the file say what it is.
 */
async function toTemplate(sharp, buffer, size) {
  const { data } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 0;
    data[i + 1] = 0;
    data[i + 2] = 0;
  }
  return sharp(data, { raw: { width: size, height: size, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * Assembles a multi-size .ico from PNG payloads.
 *
 * Layout: a 6-byte ICONDIR, then one 16-byte ICONDIRENTRY per image, then the
 * PNG bytes. A 256px image records its width/height as 0, which is how the
 * format spells "256" in a single byte.
 */
function buildIco(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const entries = Buffer.alloc(count * 16);
  let offset = 6 + count * 16;
  images.forEach(({ size, png }, i) => {
    const at = i * 16;
    entries.writeUInt8(size >= 256 ? 0 : size, at + 0);
    entries.writeUInt8(size >= 256 ? 0 : size, at + 1);
    entries.writeUInt8(0, at + 2); // palette size
    entries.writeUInt8(0, at + 3); // reserved
    entries.writeUInt16LE(1, at + 4); // colour planes
    entries.writeUInt16LE(32, at + 6); // bits per pixel
    entries.writeUInt32LE(png.length, at + 8);
    entries.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });

  return Buffer.concat([header, entries, ...images.map((i) => i.png)]);
}

function write(file, buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buffer);
  const kb = (buffer.length / 1024).toFixed(1);
  console.log(`[make-icons] ${path.relative(desktop, file)} (${kb} KB)`);
}

async function main() {
  const sharp = loadSharp();
  for (const svg of [APP_SVG, TRAY_SVG]) {
    if (!fs.existsSync(svg)) throw new Error(`missing icon source: ${svg}`);
  }

  // Linux target + the largest master.
  write(path.join(buildResources, 'icon.png'), await render(sharp, APP_SVG, 1024));

  // Window icon (Windows/Linux read it at runtime; macOS uses the bundle icon).
  write(path.join(assets, 'icon.png'), await render(sharp, APP_SVG, 512));

  // Windows installer + shell.
  const icoImages = [];
  for (const size of ICO_SIZES) {
    icoImages.push({ size, png: await render(sharp, APP_SVG, size) });
  }
  write(path.join(buildResources, 'icon.ico'), buildIco(icoImages));

  // macOS bundle icon, via a real iconset.
  const iconset = path.join(os.tmpdir(), `omadia-icon-${process.pid}.iconset`);
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset, { recursive: true });
  for (const [suffix, size] of ICONSET) {
    fs.writeFileSync(path.join(iconset, `icon_${suffix}.png`), await render(sharp, APP_SVG, size));
  }
  const icns = path.join(buildResources, 'icon.icns');
  if (process.platform === 'darwin') {
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', icns], { stdio: 'inherit' });
    const kb = (fs.statSync(icns).size / 1024).toFixed(1);
    console.log(`[make-icons] ${path.relative(desktop, icns)} (${kb} KB)`);
  } else {
    console.log(`[make-icons] SKIPPED icon.icns — iconutil is macOS-only. Iconset: ${iconset}`);
  }
  fs.rmSync(iconset, { recursive: true, force: true });

  // macOS menu bar: template images, 1x and 2x side by side so
  // `nativeImage.createFromPath` picks the retina variant on its own.
  write(
    path.join(assets, 'trayTemplate.png'),
    await toTemplate(sharp, await render(sharp, TRAY_SVG, 16), 16),
  );
  write(
    path.join(assets, 'trayTemplate@2x.png'),
    await toTemplate(sharp, await render(sharp, TRAY_SVG, 32), 32),
  );
}

await main();
