/**
 * Where the shell finds its own artwork (#888).
 *
 * Two consumers, one lookup rule, kept out of both of them so it can be tested
 * without Electron: the tray needs a macOS template image and the window needs
 * a square app icon on Windows and Linux (macOS takes the window icon from the
 * signed bundle instead).
 *
 * Both live under `assets/`, which `scripts/copy-assets.mjs` mirrors into
 * `dist/assets/` at build time. That is why every lookup tries `dist/assets`
 * first and `assets` second: the packaged app only ships `dist/**` (see
 * `files:` in electron-builder.yml), while a dev run resolves `app.getAppPath()`
 * to the `desktop/` directory itself and finds the sources.
 *
 * Resolution returns a path or `null` — never a fallback image. The caller
 * decides what a missing asset means, and says so out loud; a silent empty
 * image is how OM-53/OM-63 stayed invisible for three beta rounds.
 */
import fs from 'node:fs';
import path from 'node:path';

/** File names, relative to whichever assets directory exists. */
const TRAY_TEMPLATE = 'trayTemplate.png';
const APP_ICON = 'icon.png';

/** `dist/assets` (packaged) before `assets` (dev run from source). */
function candidates(appPath: string, file: string): string[] {
  return [path.join(appPath, 'dist', 'assets', file), path.join(appPath, 'assets', file)];
}

function firstExisting(paths: readonly string[]): string | null {
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * The macOS menu-bar icon.
 *
 * `nativeImage.createFromPath` picks up the `@2x` neighbour on its own, so only
 * the 1x path is resolved here; both files ship side by side.
 */
export function resolveTrayIconPath(appPath: string): string | null {
  return firstExisting(candidates(appPath, TRAY_TEMPLATE));
}

/** The window/taskbar icon for Windows and Linux. */
export function resolveAppIconPath(appPath: string): string | null {
  return firstExisting(candidates(appPath, APP_ICON));
}

/** Every path a tray lookup would try, in order — for diagnostics and tests. */
export function trayIconCandidates(appPath: string): string[] {
  return candidates(appPath, TRAY_TEMPLATE);
}

/** Every path an app-icon lookup would try, in order. */
export function appIconCandidates(appPath: string): string[] {
  return candidates(appPath, APP_ICON);
}
