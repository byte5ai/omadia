import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { detectSyncedLocation } from './syncedPaths';
import { log } from './log';

/**
 * Resolves every on-disk location the desktop app needs, transparently handling
 * the two layouts:
 *   - packaged:  omadia runtime lives under `process.resourcesPath/omadia/*`
 *                (placed there as extraResources by electron-builder).
 *   - dev:       omadia runtime is the sibling `middleware/` + `web-ui/` of this
 *                workspace in the repo checkout.
 *
 * All mutable state (vault, embedded DB, secrets, plugin uploads) lives under
 * Electron's per-user `userData` dir so uninstall is clean and nothing is
 * written inside the read-only app bundle.
 */

const isDev = process.env['OMADIA_DESKTOP_DEV'] === '1' || !app.isPackaged;

/** One notice per launch, not one per snapshot call. */
let syncedSnapshotNoticeLogged = false;

function runtimeRoot(): string {
  if (isDev) {
    // desktop/ is a sibling of middleware/ and web-ui/ in the repo.
    return path.resolve(__dirname, '..', '..');
  }
  return path.join(process.resourcesPath, 'omadia');
}

function devRuntimeRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

/** Entry script for the middleware kernel (`node dist/index.js`). */
export function kernelEntry(): string {
  const root = runtimeRoot();
  return isDev
    ? path.join(devRuntimeRoot(), 'middleware', 'dist', 'index.js')
    : path.join(root, 'middleware', 'dist', 'index.js');
}

/** Working directory for the kernel process (so relative asset/migration paths resolve). */
export function kernelCwd(): string {
  return isDev
    ? path.join(devRuntimeRoot(), 'middleware')
    : path.join(runtimeRoot(), 'middleware');
}

/** Entry script for the web-ui Next standalone server (`node server.js`). */
export function webUiEntry(): string {
  return isDev
    ? path.join(devRuntimeRoot(), 'web-ui', '.next', 'standalone', 'server.js')
    : path.join(runtimeRoot(), 'web-ui', 'server.js');
}

export function webUiCwd(): string {
  return isDev
    ? path.join(devRuntimeRoot(), 'web-ui', '.next', 'standalone')
    : path.join(runtimeRoot(), 'web-ui');
}

/** Root for all mutable per-user state. Honours a custom data dir chosen in the wizard. */
export function dataRoot(): string {
  const custom = readDataDirOverride();
  const root = custom ?? app.getPath('userData');
  ensureDir(root);
  return root;
}

/** PLATFORM_DATA_DIR for the kernel (vault, drafts.db, installed plugins). */
export function platformDataDir(): string {
  const dir = path.join(dataRoot(), 'platform-data');
  ensureDir(dir);
  return dir;
}

/** Directory the embedded Postgres (PGlite) persists into. */
export function embeddedDbDir(): string {
  const dir = path.join(dataRoot(), 'pgdata');
  ensureDir(dir);
  return dir;
}

/** Encrypted secrets blob (vault master key + provider API keys). */
export function secretsFile(): string {
  return path.join(dataRoot(), 'secrets.enc');
}

/** First-run setup state (non-secret config). */
export function setupFile(): string {
  return path.join(dataRoot(), 'setup.json');
}

/**
 * Where a pre-update DB snapshot is written.
 *
 * Normally next to the data it protects, under the chosen data dir. But when
 * that dir sits in a cloud-synced folder the snapshots are moved to `userData`
 * instead: a full copy of the cluster per update attempt is exactly the kind of
 * bulk a sync client should never be asked to carry, and a backup that a sync
 * client may evict or fork into a conflict copy is not a backup (#934).
 */
export function snapshotDir(): string {
  const root = dataRoot();
  const synced = detectSyncedLocation(root, os.homedir());
  const base = synced === null ? root : app.getPath('userData');
  if (synced !== null && !syncedSnapshotNoticeLogged) {
    syncedSnapshotNoticeLogged = true;
    log.info(`[paths] data dir is in ${synced}; keeping DB snapshots in userData instead`);
  }
  const dir = path.join(base, 'snapshots');
  ensureDir(dir);
  return dir;
}

/** Marker recording which version we last handed to the installer (#926). */
export function updateAttemptsFile(): string {
  return path.join(app.getPath('userData'), 'update-attempts.json');
}

/** A file under userData recording an operator-chosen alternate data dir. */
function dataDirOverrideFile(): string {
  return path.join(app.getPath('userData'), 'datadir.txt');
}

export function setDataDirOverride(dir: string): void {
  fs.writeFileSync(dataDirOverrideFile(), dir, 'utf8');
}

function readDataDirOverride(): string | null {
  try {
    const p = dataDirOverrideFile();
    if (!fs.existsSync(p)) return null;
    const dir = fs.readFileSync(p, 'utf8').trim();
    return dir.length > 0 ? dir : null;
  } catch {
    return null;
  }
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export const runtimeIsDev = isDev;
