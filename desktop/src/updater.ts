import { app, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';
import fs from 'node:fs';
import path from 'node:path';
import { embeddedDbDir, snapshotDir } from './paths';
import { getActiveSupervisor } from './supervisor';
import { log } from './log';

let installing = false;
/** True once the user accepted an update and we're handing off to the installer. */
export function isUpdateInstalling(): boolean {
  return installing;
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

  autoUpdater.on('error', (err) => log.error(`[updater] ${String(err)}`));
  autoUpdater.on('update-available', (info) =>
    log.info(`[updater] update available: ${info.version}`),
  );
  autoUpdater.on('update-downloaded', async (info) => {
    log.info(`[updater] downloaded ${info.version}`);
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

  autoUpdater.checkForUpdates().catch((err) => log.error(`[updater] check failed: ${String(err)}`));
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
