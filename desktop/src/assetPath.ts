import { app } from 'electron';
import path from 'node:path';

/**
 * Absolute path to a packaged runtime asset. Assets live in `dist/assets`,
 * staged there from `src/assets` by `scripts/copy-assets.mjs` and shipped inside
 * the asar via `files: dist/**` — so both the main process (window icon) and the
 * tray resolve them through the one place instead of respelling the directory.
 */
export function assetPath(name: string): string {
  return path.join(app.getAppPath(), 'dist', 'assets', name);
}

/**
 * The window/taskbar icon on Windows and Linux. macOS draws the window and Dock
 * from the signed .app bundle icon (set via electron-builder), so passing an
 * `icon` there is ignored — we only need it on the other platforms.
 */
export function windowIcon(): string | undefined {
  if (process.platform === 'darwin') return undefined;
  return assetPath('icon.png');
}
