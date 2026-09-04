/**
 * The desktop app's own artwork (#888, OM-53 / OM-63).
 *
 * Three beta rounds shipped with Electron's default atom icon and a guaranteed
 * empty tray image, because nothing failed: `electron-builder.yml` named no
 * icon and `tray.ts` fell back to `nativeImage.createEmpty()`. Both silences
 * are now covered here.
 *
 * The container formats are parsed by hand rather than through a tool: `sips`,
 * `iconutil` and ImageMagick are all absent from a Linux CI runner, and a test
 * that skips itself there would restore the original silence. Reading a PNG
 * IHDR or an ICO directory is a dozen lines and works everywhere.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveTrayIconPath,
  resolveAppIconPath,
  trayIconCandidates,
  appIconCandidates,
} from '../src/icons.ts';

const desktopDir = path.join(import.meta.dirname, '..');
const buildResources = path.join(desktopDir, 'buildResources');
const assets = path.join(desktopDir, 'assets');

/** Width, height, bit depth and colour type straight out of a PNG's IHDR. */
function readPng(file: string): {
  width: number;
  height: number;
  depth: number;
  colourType: number;
  bytes: number;
} {
  const buf = fs.readFileSync(file);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(buf.subarray(0, 8).equals(signature), `${file} is not a PNG`);
  assert.equal(buf.subarray(12, 16).toString('latin1'), 'IHDR', `${file} has no leading IHDR`);
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    depth: buf.readUInt8(24),
    colourType: buf.readUInt8(25),
    bytes: buf.length,
  };
}

describe('icon assets are present and shaped correctly (#888)', () => {
  it('ships a 1024px master PNG for Linux', () => {
    const png = readPng(path.join(buildResources, 'icon.png'));
    assert.equal(png.width, 1024);
    assert.equal(png.height, 1024);
    assert.ok(png.bytes > 1024, 'icon.png must not be a stub');
    // An icon rendered at absurd resolution and downscaled bloats the repo.
    assert.ok(png.bytes < 512 * 1024, `icon.png is ${png.bytes} bytes, expected well under 512KB`);
  });

  it('ships a 512px window icon with an alpha channel', () => {
    const png = readPng(path.join(assets, 'icon.png'));
    assert.equal(png.width, 512);
    assert.equal(png.height, 512);
    assert.equal(png.colourType, 6, 'window icon must be RGBA so the corners stay transparent');
  });

  it('ships tray template images at 16 and 32 px, both RGBA', () => {
    // macOS reads a template image through its alpha channel and tints the
    // shape itself, so RGBA is the requirement. `scripts/make-icons.mjs`
    // additionally zeroes the RGB, which `magick -format %[fx:maxima]` reports
    // as 0 — asserted at generation time rather than by decoding IDAT here.
    const one = readPng(path.join(assets, 'trayTemplate.png'));
    assert.equal(one.width, 16);
    assert.equal(one.height, 16);
    assert.equal(one.colourType, 6);

    const two = readPng(path.join(assets, 'trayTemplate@2x.png'));
    assert.equal(two.width, 32);
    assert.equal(two.height, 32);
    assert.equal(two.colourType, 6);
  });

  it('ships an .icns whose header agrees with the file size', () => {
    const file = path.join(buildResources, 'icon.icns');
    const buf = fs.readFileSync(file);
    assert.equal(buf.subarray(0, 4).toString('latin1'), 'icns', 'missing icns magic');
    assert.equal(buf.readUInt32BE(4), buf.length, 'icns length field disagrees with the file');
    assert.ok(buf.length > 10 * 1024, 'an icns this small cannot hold the 512@2x member');
    assert.ok(buf.length < 2 * 1024 * 1024, `icns is ${buf.length} bytes, expected under 2MB`);
  });

  it('ships an .ico carrying every size a Windows shell asks for', () => {
    const buf = fs.readFileSync(path.join(buildResources, 'icon.ico'));
    assert.equal(buf.readUInt16LE(0), 0, 'ICONDIR reserved field');
    assert.equal(buf.readUInt16LE(2), 1, 'ICONDIR type must be 1 (icon)');
    const count = buf.readUInt16LE(4);

    const sizes: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const at = 6 + i * 16;
      // The format spells 256 as 0, because the field is one byte wide.
      const width = buf.readUInt8(at) === 0 ? 256 : buf.readUInt8(at);
      const length = buf.readUInt32LE(at + 8);
      const offset = buf.readUInt32LE(at + 12);
      assert.ok(length > 0, `entry ${i} has no payload`);
      assert.ok(offset + length <= buf.length, `entry ${i} points past the end of the file`);
      sizes.push(width);
    }
    assert.deepEqual(sizes, [16, 24, 32, 48, 64, 128, 256]);
  });
});

describe('electron-builder names icons that actually exist (#888)', () => {
  /** Every `icon:`-ish value in the config, e.g. `icon`, `installerIcon`. */
  function referencedIcons(): string[] {
    const yml = fs.readFileSync(path.join(desktopDir, 'electron-builder.yml'), 'utf8');
    return [...yml.matchAll(/^\s*\w*[iI]con\w*:\s*(\S+)\s*$/gm)].map((m) => m[1]!);
  }

  it('names one icon per platform target', () => {
    // Counting references is not enough: with four Windows entries in the file,
    // a count-based check stays green after the macOS icon is deleted. Each
    // required file is asserted by name instead. The bug this guards is that
    // electron-builder's convention scan silently falls back to Electron's own
    // atom icon, which is how OM-53 shipped three times.
    const referenced = referencedIcons();
    for (const required of [
      'buildResources/icon.icns', // macOS bundle
      'buildResources/icon.ico', // Windows shell + NSIS
      'buildResources/icon.png', // Linux AppImage/deb
    ]) {
      assert.ok(
        referenced.includes(required),
        `electron-builder.yml must name ${required}; it references ${JSON.stringify(referenced)}`,
      );
    }
  });

  it('every icon path in the config resolves to a file', () => {
    const referenced = referencedIcons();
    assert.ok(referenced.length > 0, 'no icon: entries found at all');
    for (const rel of referenced) {
      assert.ok(
        fs.existsSync(path.join(desktopDir, rel)),
        `electron-builder.yml references ${rel}, which does not exist`,
      );
    }
  });
});

describe('icon lookup (#888)', () => {
  /** A throwaway app directory with the given files created empty-but-present. */
  function appDir(files: readonly string[]): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omadia-icons-'));
    for (const rel of files) {
      const target = path.join(root, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'x');
    }
    return root;
  }

  it('finds the tray icon in a packaged layout', () => {
    const root = appDir(['dist/assets/trayTemplate.png']);
    assert.equal(resolveTrayIconPath(root), path.join(root, 'dist', 'assets', 'trayTemplate.png'));
  });

  it('finds the tray icon in a dev layout', () => {
    const root = appDir(['assets/trayTemplate.png']);
    assert.equal(resolveTrayIconPath(root), path.join(root, 'assets', 'trayTemplate.png'));
  });

  it('prefers the packaged copy when both exist', () => {
    const root = appDir(['dist/assets/trayTemplate.png', 'assets/trayTemplate.png']);
    assert.equal(resolveTrayIconPath(root), path.join(root, 'dist', 'assets', 'trayTemplate.png'));
  });

  it('returns null rather than a blank image when nothing is there', () => {
    const root = appDir([]);
    assert.equal(resolveTrayIconPath(root), null);
    assert.equal(resolveAppIconPath(root), null);
  });

  it('resolves both icons against the real desktop directory', () => {
    // Proves the committed assets sit where the lookup looks. Deliberately does
    // NOT pin which candidate wins: after `npm run build` the copy in
    // `dist/assets` exists and correctly takes precedence, so asserting the
    // `assets/` path would pass or fail depending on whether the tree happens
    // to be built.
    for (const [resolved, wanted] of [
      [resolveTrayIconPath(desktopDir), trayIconCandidates(desktopDir)],
      [resolveAppIconPath(desktopDir), appIconCandidates(desktopDir)],
    ] as const) {
      assert.notEqual(resolved, null, `expected to find one of ${wanted.join(', ')}`);
      assert.ok(wanted.includes(resolved!), `${resolved} is not one of the candidates`);
      assert.ok(fs.statSync(resolved!).size > 0, `${resolved} is empty`);
    }
  });

  it('reports the paths it tried, for the warning the tray logs', () => {
    const root = appDir([]);
    assert.deepEqual(trayIconCandidates(root), [
      path.join(root, 'dist', 'assets', 'trayTemplate.png'),
      path.join(root, 'assets', 'trayTemplate.png'),
    ]);
    assert.deepEqual(appIconCandidates(root), [
      path.join(root, 'dist', 'assets', 'icon.png'),
      path.join(root, 'assets', 'icon.png'),
    ]);
  });
});
