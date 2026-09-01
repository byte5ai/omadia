// Read-back tests for the shipped icon assets (OM-53 / OM-63).
//
// The failure these guard against is silent: a missing or empty icon does not
// crash anything, it just ships an unbranded app and an invisible menu-bar icon.
// So we assert against the actual bytes on disk — the PNG signature and the
// dimensions read out of the IHDR chunk — not against the SVG sources, and we
// run copy-assets to prove the tray image really lands where tray.ts looks.
//
// Run: node --test desktop/scripts/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Read a PNG's real dimensions from its IHDR chunk, asserting the signature. */
function readPng(file) {
  const buf = fs.readFileSync(file);
  assert.ok(buf.subarray(0, 8).equals(PNG_SIGNATURE), `${file} is not a PNG`);
  assert.equal(buf.toString('ascii', 12, 16), 'IHDR', `${file} has no IHDR chunk`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test('the app icon is a 1024² PNG (electron-builder derives .icns/.ico from it)', () => {
  const { width, height } = readPng(path.join(desktop, 'buildResources', 'icon.png'));
  assert.equal(width, 1024);
  assert.equal(height, 1024);
});

test('the window icon is a square PNG of at least 512px', () => {
  const { width, height } = readPng(path.join(desktop, 'src', 'assets', 'icon.png'));
  assert.equal(width, height);
  assert.ok(width >= 512, `expected >=512, got ${width}`);
});

test('the tray template ships base and @2x variants', () => {
  assert.deepEqual(readPng(path.join(desktop, 'src', 'assets', 'trayTemplate.png')), {
    width: 16,
    height: 16,
  });
  assert.deepEqual(readPng(path.join(desktop, 'src', 'assets', 'trayTemplate@2x.png')), {
    width: 32,
    height: 32,
  });
});

// tray.ts marks the image with setTemplateImage(true); macOS only tints it
// correctly if it is pure black + alpha. A coloured source passes the dimension
// tests above yet renders as a wrong-colour blob in the menu bar — the exact
// OM-63 symptom. So read the actual pixels back: every opaque pixel must be black.
test('the tray template is a valid macOS template image (opaque pixels are pure black)', async () => {
  for (const name of ['trayTemplate.png', 'trayTemplate@2x.png']) {
    const file = path.join(desktop, 'src', 'assets', name);
    const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.channels, 4, `${name} must carry an alpha channel`);
    let opaque = 0;
    let colouredOpaque = 0;
    for (let i = 0; i < data.length; i += info.channels) {
      if (data[i + 3] <= 10) continue; // transparent — the OS ignores it
      opaque++;
      if (data[i] > 10 || data[i + 1] > 10 || data[i + 2] > 10) colouredOpaque++;
    }
    assert.ok(opaque > 0, `${name} is fully transparent — nothing would draw`);
    assert.equal(colouredOpaque, 0, `${name} has ${colouredOpaque} non-black opaque pixels`);
  }
});

test('copy-assets lands the tray image where tray.ts resolves it', async () => {
  await import('./copy-assets.mjs');
  const shipped = path.join(desktop, 'dist', 'assets', 'trayTemplate.png');
  assert.ok(fs.existsSync(shipped), 'trayTemplate.png missing from dist/assets');
  // Read the bytes back: the shipped copy must equal the committed source.
  assert.ok(
    fs
      .readFileSync(shipped)
      .equals(fs.readFileSync(path.join(desktop, 'src', 'assets', 'trayTemplate.png'))),
    'shipped tray image differs from source',
  );
  // The SVG source must NOT be shipped — only rasters go into the bundle.
  assert.ok(
    !fs.existsSync(path.join(desktop, 'dist', 'assets', 'trayTemplate.svg')),
    'SVG source leaked into dist/assets',
  );
});
