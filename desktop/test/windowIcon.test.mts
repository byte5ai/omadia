/**
 * Unit test for the window/taskbar icon path (OM-53).
 *
 * The platform branch is the whole point: on macOS the window and Dock are drawn
 * from the signed .app bundle icon set by electron-builder, so BrowserWindow must
 * be given no `icon` (passing one is ignored). On Windows and Linux there is no
 * bundle icon, so the window needs the explicit PNG from dist/assets. An
 * untested branch here is how the OM-53 default-atom shipped in the first place.
 *
 * Runs under the electron stub (--import ./test/helpers/stub-electron.mjs), which
 * redirects `import 'electron'` so assetPath's `app.getAppPath()` resolves to a
 * temp dir instead of reaching a real Electron.
 */
import { describe, it, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import path from 'node:path';
import { windowIcon } from '../src/assetPath.ts';

const realPlatform = process.platform;

/** Run `body` with `process.platform` pinned to `value`, then restore it. */
function onPlatform(value: NodeJS.Platform, body: () => void): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
  try {
    body();
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  }
}

describe('windowIcon', () => {
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  });

  it('returns no icon on macOS (the signed bundle icon is used instead)', () => {
    onPlatform('darwin', () => {
      assert.equal(windowIcon(), undefined);
    });
  });

  it('points at the bundled PNG on Windows', () => {
    onPlatform('win32', () => {
      const icon = windowIcon();
      assert.equal(path.basename(icon ?? ''), 'icon.png');
      assert.ok(
        (icon ?? '').endsWith(path.join('dist', 'assets', 'icon.png')),
        `expected a dist/assets/icon.png path, got ${icon}`,
      );
    });
  });

  it('points at the bundled PNG on Linux', () => {
    onPlatform('linux', () => {
      assert.ok((windowIcon() ?? '').endsWith(path.join('dist', 'assets', 'icon.png')));
    });
  });
});
