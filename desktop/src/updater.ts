import { app, dialog, type MessageBoxOptions } from 'electron';
import { autoUpdater } from 'electron-updater';
import fs from 'node:fs';
import path from 'node:path';
import { embeddedDbDir, snapshotDir } from './paths';
import { getActiveSupervisor } from './supervisor';
import { log } from './log';
import { recordCheckFailed, recordCheckReachedFeed } from './updaterCheckHealth';

let installing = false;
// This flag is only safe because electron-updater's own checkForUpdates()
// dedupes internally — a call while one is already in flight (e.g. a manual
// click landing during the silent startup check) returns the SAME promise
// instead of firing a second request, so there is always exactly one
// terminal event to gate a dialog on. Do not add a second concurrent
// checkForUpdates() call path without re-checking that guarantee still holds.
let manualCheckPending = false;
/** True once the user accepted an update and we're handing off to the installer. */
export function isUpdateInstalling(): boolean {
  return installing;
}

function takeManualCheckPending(): boolean {
  if (!manualCheckPending) return false;
  manualCheckPending = false;
  return true;
}

async function showUpdaterDialog(options: MessageBoxOptions): Promise<void> {
  try {
    // These status dialogs are intentionally unbounded: the point of a manual
    // check is to stay visible until the user has seen the updater outcome.
    await dialog.showMessageBox(options);
  } catch (err) {
    log.error(`[updater] failed to show dialog "${options.title}": ${String(err)}`);
  }
}

/**
 * Auto-update via electron-updater against GitHub Releases.
 *
 * Critical extra step: before an update is installed we snapshot the embedded DB
 * directory, because a new app version may ship newer (idempotent) kernel
 * migrations that run on first boot, and an embedded DB has no managed backups.
 * If a migration goes wrong, the user can restore the snapshot.
 */
export function initUpdater(): void {
  if (!app.isPackaged) {
    log.info('[updater] skipped (not packaged)');
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false; // we control install timing (after snapshot)

  autoUpdater.on('error', (err) => {
    log.error(`[updater] ${String(err)}`);
    const manual = takeManualCheckPending();
    const { consecutiveFailures, shouldNotify } = recordCheckFailed(manual);
    if (manual) {
      void showUpdaterDialog({
        type: 'error',
        title: 'Update check failed',
        message: 'omadia could not check for updates.',
        detail: String(err),
      });
      return;
    }
    // The silent startup check. Logging and nothing else is what let a dead
    // update channel look exactly like "already up to date" (#928/OM-69), so
    // break the silence — once per streak, so it can never become a nag.
    if (!shouldNotify) return;
    void showUpdaterDialog({
      type: 'warning',
      title: 'Update check keeps failing',
      message: `omadia could not check for updates on the last ${consecutiveFailures} starts.`,
      detail:
        `You are still running ${app.getVersion()}. omadia will keep trying in the background. ` +
        'If this persists, download the current version from ' +
        'https://github.com/byte5ai/omadia/releases.\n\n' +
        `Last error: ${String(err)}`,
    });
  });
  autoUpdater.on('update-available', (info) => {
    log.info(`[updater] update available: ${info.version}`);
    recordCheckReachedFeed();
    if (!takeManualCheckPending()) return;
    void showUpdaterDialog({
      type: 'info',
      title: 'Update found',
      message: `omadia ${info.version} is downloading now.`,
      detail: 'The download is running in the background. You will be prompted to restart once it is ready to install.',
    });
  });
  autoUpdater.on('update-not-available', (info) => {
    log.info(`[updater] up to date: ${info.version}`);
    recordCheckReachedFeed();
    if (!takeManualCheckPending()) return;
    void showUpdaterDialog({
      type: 'info',
      title: 'No update available',
      message: "You're already on the latest version of omadia.",
      detail: `Current version: ${info.version}`,
    });
  });
  autoUpdater.on('update-downloaded', async (info) => {
    log.info(`[updater] downloaded ${info.version}`);
    // This restart decision is intentionally unbounded: installing an update
    // without explicit user consent would be worse than waiting for it here.
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `omadia ${info.version} is ready to install.`,
      detail: 'omadia will close, back up your local data, and restart to apply the update.',
    });
    if (response !== 0) return;

    // Quiesce the stack FIRST so the embedded DB is flushed + closed before we
    // copy its directory — a live cpSync could capture a torn, unrestorable
    // snapshot. Then snapshot, then hand off to the installer.
    installing = true;
    try {
      const sup = getActiveSupervisor();
      if (sup) await sup.stop();
      snapshotDbDir(info.version);
    } catch (err) {
      log.error(`[updater] pre-install stop/snapshot failed (installing anyway): ${String(err)}`);
    }
    // quitAndInstall drives the app quit itself; main's before-quit checks
    // isUpdateInstalling() and steps aside so the installer isn't bypassed.
    autoUpdater.quitAndInstall();
  });

  // electron-updater owns the request lifetime and its own network timeouts; we
  // deliberately wait for its promise/events instead of racing a second timer.
  autoUpdater.checkForUpdates().catch((err) => log.error(`[updater] check failed: ${String(err)}`));
}

export async function checkForUpdatesManually(): Promise<void> {
  if (!app.isPackaged) {
    await showUpdaterDialog({
      type: 'info',
      title: 'Update check unavailable',
      message: 'Update checks are only available in packaged builds.',
      detail: 'This development run does not have a published release feed to query.',
    });
    return;
  }

  manualCheckPending = true;
  try {
    // electron-updater owns the request lifetime and its own network timeouts;
    // the promise plus its events are the supported completion signal here.
    await autoUpdater.checkForUpdates();
  } catch (err) {
    if (!takeManualCheckPending()) return;
    await showUpdaterDialog({
      type: 'error',
      title: 'Update check failed',
      message: 'omadia could not check for updates.',
      detail: String(err),
    });
  }
}

/** Copy the embedded DB directory into a timestamp-free, version-named snapshot. */
function snapshotDbDir(version: string): void {
  const src = embeddedDbDir();
  if (!fs.existsSync(src)) return;
  const dest = path.join(snapshotDir(), `pgdata-pre-${version}`);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  log.info(`[updater] snapshotted DB → ${dest}`);
}
