import { app, dialog, type MessageBoxOptions } from 'electron';
import { autoUpdater } from 'electron-updater';
import fs from 'node:fs';
import { embeddedDbDir, snapshotDir, updateAttemptsFile } from './paths';
import { getActiveSupervisor } from './supervisor';
import { log, logFile } from './log';
import {
  clearUpdateAttempts,
  installKeepsFailing,
  nextAttempt,
  readUpdateAttempts,
  writeUpdateAttempts,
} from './updateAttempts';
import { SNAPSHOTS_TO_KEEP } from './snapshotRetention';
import { takeDbSnapshot, type SnapshotIo } from './dbSnapshot';
import { prepareInstall } from './installPreflight';

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

  // We are running, so whatever we last handed to the installer either landed
  // (running version matches) or is stale history for a version we have since
  // moved past. Either way the counter has done its job (#926).
  reconcileUpdateHistory();

  autoUpdater.on('error', (err) => {
    log.error(`[updater] ${String(err)}`);
    if (!takeManualCheckPending()) return;
    void showUpdaterDialog({
      type: 'error',
      title: 'Update check failed',
      message: 'omadia could not check for updates.',
      detail: String(err),
    });
  });
  autoUpdater.on('update-available', (info) => {
    log.info(`[updater] update available: ${info.version}`);
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

    // Offering the same version a third time, having twice failed to apply it,
    // is the loop the tester hit: three prompts in nine minutes, three DB
    // snapshots, no error, and the machine still on the old build. Say what is
    // happening once instead (#926).
    const history = readUpdateAttempts(updateAttemptsFile());
    if (installKeepsFailing(history, info.version, app.getVersion())) {
      log.error(
        `[updater] ${info.version} was handed to the installer ${history?.attempts ?? 0}x ` +
          `and we are still on ${app.getVersion()}; not offering it again`,
      );
      await showUpdaterDialog({
        type: 'warning',
        title: 'Update could not be applied',
        message: `omadia could not install ${info.version}.`,
        detail:
          `The update was downloaded and applied ${history?.attempts ?? 0} times, but omadia is ` +
          `still running ${app.getVersion()}. Something is preventing the installed ` +
          'application from being replaced.\n\n' +
          `Please install ${info.version} manually from the omadia releases page, and attach ` +
          `this log if you report it:\n${logFile()}`,
      });
      return;
    }

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

    installing = true;
    if (!(await quiesceForInstall(info.version))) {
      // Handing a live stack to Squirrel is what caused the loop: ShipIt cannot
      // replace a bundle whose kernel and Postgres are still running out of it,
      // so it waits forever and the next launch is the old version again. Stop
      // here instead of installing "anyway" (#926/#927).
      installing = false;
      return;
    }

    try {
      writeUpdateAttempts(
        updateAttemptsFile(),
        nextAttempt(history, info.version, new Date()),
      );
    } catch (err) {
      // Losing the counter only costs us the ability to notice a repeat; it must
      // not block an update the user just approved.
      log.warn(`[updater] ${String(err)}`);
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

/**
 * Clear the marker once the version it recorded is the one we are running.
 *
 * Running that version at all proves the handoff finally worked, so the count
 * has done its job. A marker for some *other* version is left in place on
 * purpose: whether it still matters is decided later, per offer, by the version
 * comparisons in `installKeepsFailing` and `nextAttempt`.
 */
function reconcileUpdateHistory(): void {
  const file = updateAttemptsFile();
  const history = readUpdateAttempts(file);
  if (history === null) return;
  if (history.version === app.getVersion()) {
    log.info(`[updater] ${history.version} installed successfully; clearing attempt marker`);
    clearUpdateAttempts(file);
  }
}

/**
 * Bring the stack down and snapshot the database, and report whether the app
 * bundle is actually free for the installer to replace.
 *
 * Quiescing FIRST matters for the snapshot too: a live cpSync could capture a
 * torn, unrestorable copy.
 */
async function quiesceForInstall(version: string): Promise<boolean> {
  const sup = getActiveSupervisor();
  const result = await prepareInstall(
    { stop: sup ? () => sup.stop() : null, snapshot: snapshotDbDir },
    version,
  );
  if (result.ok) return true;

  // Both branches leave the stack down, so both have to tell the user how to
  // get back to a working app. Saying only "your data was not changed" left
  // them looking at a dead window.
  const relaunch =
    'Your data was not changed. Quit omadia completely and start it again, then retry the update.';

  if (result.reason === 'unclean') {
    log.error(
      `[updater] aborting install of ${version}: still running - ${result.survivors.join(', ')}`,
    );
    await showUpdaterDialog({
      type: 'error',
      title: 'Update not applied',
      message: `omadia could not shut down cleanly, so ${version} was not installed.`,
      detail:
        `These parts of omadia did not stop: ${result.survivors.join(', ')}.\n\n` +
        `${relaunch}\n\nIf it keeps happening, attach this log:\n${logFile()}`,
    });
    return false;
  }

  log.error(`[updater] pre-install stop/snapshot failed for ${version}: ${result.error}`);
  await showUpdaterDialog({
    type: 'error',
    title: 'Update not applied',
    message: `omadia could not prepare for the update, so ${version} was not installed.`,
    detail: `${result.error}\n\n${relaunch}\n\nLog:\n${logFile()}`,
  });
  return false;
}

/** Copy the embedded DB directory into a snapshot unique to this attempt. */
function snapshotDbDir(version: string): void {
  takeDbSnapshot(realSnapshotIo, {
    sourceDir: embeddedDbDir(),
    snapshotRoot: snapshotDir(),
    version,
    now: new Date(),
    keep: SNAPSHOTS_TO_KEEP,
  });
}

/** The real filesystem, behind the snapshot module's port. */
const realSnapshotIo: SnapshotIo = {
  exists: (dir) => fs.existsSync(dir),
  listDirectories: (root) =>
    fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  copy: (source, destination) => fs.cpSync(source, destination, { recursive: true }),
  remove: (dir) => fs.rmSync(dir, { recursive: true, force: true }),
  info: (message) => log.info(`[updater] ${message}`),
  error: (message) => log.warn(`[updater] ${message}`),
};
