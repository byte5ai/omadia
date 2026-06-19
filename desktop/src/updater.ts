import { app, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';
import fs from 'node:fs';
import path from 'node:path';
import { embeddedDbDir, snapshotDir } from './paths';
import { log } from './log';

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
    try {
      snapshotDbDir(info.version);
    } catch (err) {
      log.error(`[updater] snapshot failed, not auto-installing: ${String(err)}`);
      return;
    }
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `omadia ${info.version} is ready to install.`,
      detail: 'Your data has been snapshotted. omadia will restart to apply the update.',
    });
    if (response === 0) {
      autoUpdater.quitAndInstall();
    }
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
