import { app, BrowserWindow, clipboard, dialog } from 'electron';
import { installApplicationMenu } from './menu';
import path from 'node:path';
import { Supervisor, setActiveSupervisor, BootProgress } from './supervisor';
import { registerIpc } from './ipc';
import { CH } from './ipcTypes';
import { createTray, setTrayStatus, destroyTray, TrayActions } from './tray';
import { checkForUpdatesManually, initUpdater, isUpdateInstalling } from './updater';
import {
  isSetupComplete,
  markRecoveryKeyShown,
  needsRecoveryKeyReminder,
} from './setupState';
import { exportRecoveryKey } from './secrets';
import { log, logFile, onLog } from './log';
import { classifyBootFailure, describeError } from './bootFailure';
import { shouldRecoverFromLoadFailure, type LoadFailureEvent } from './loadFailure';
import {
  beginNavigation,
  commitNavigation,
  initialViewState,
  mayCommitNavigation,
  mayStartNavigation,
  type NavSource,
  type ShellView,
  type ViewState,
} from './shellView';
import {
  createShellTranslate,
  fillPlaceholders,
  type ShellTranslate,
} from './shellStrings';

// Stable app identity so userData resolves to ".../omadia" in both dev and
// packaged builds (in dev the Electron CLI would otherwise name it "Electron").
app.setName('omadia');

const LOADING_PAGE = 'loading.html';
const WIZARD_PAGE = 'wizard.html';

let win: BrowserWindow | null = null;
let supervisor: Supervisor | null = null;
let quitting = false;
// While true, every log line is mirrored to the wizard/loading UI so the user
// sees what's happening during the (potentially ~90s) install/boot. Turned off
// once the admin UI takes over so normal operation isn't streamed to a page that
// no longer listens.
let streamBootLogs = false;

/**
 * Who owns the window right now (OM-58).
 *
 * Three independent code paths used to end in an unconditional `loadURL`, so a
 * boot finishing while the first-run wizard was open overwrote it and dropped
 * the user on the sign-in form mid-setup — skipping the data-directory step and,
 * worse, the recovery-key step. Every navigation now goes through the arbiter in
 * `shellView.ts`. See that file for the two rules.
 */
let viewState: ViewState = initialViewState();

/**
 * `app.getLocale()` is only meaningful after the ready event, so the translator
 * is built in `onReady`. Until then the identity translator keeps every call
 * site honest rather than forcing null checks into error paths.
 */
let t: ShellTranslate = (_key, fallback) => fallback;

function rendererPath(file: string): string {
  return path.join(app.getAppPath(), 'dist', 'renderer', file);
}

/**
 * Take ownership of the window for `source`, or refuse.
 *
 * Returns the navigation token to hand back to {@link finishNavigation}, or
 * `null` when the arbiter refused — refusals are logged, never silent, because
 * a silently dropped navigation is how the original bug hid.
 */
function startNavigation(target: ShellView, source: NavSource): number | null {
  const decision = mayStartNavigation(viewState, source);
  if (!decision.allowed) {
    log.warn(`[main] navigation refused: ${decision.reason}`);
    return null;
  }
  const next = beginNavigation(viewState, target);
  viewState = next.state;
  return next.token;
}

/** Whether a navigation that began with `token` may still commit. */
function finishNavigation(token: number, target: ShellView, source: NavSource): boolean {
  const decision = mayCommitNavigation(viewState, token, source);
  if (!decision.allowed) {
    log.warn(`[main] navigation not committed: ${decision.reason}`);
    return false;
  }
  viewState = commitNavigation(viewState, target);
  return true;
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 880,
    minHeight: 620,
    show: false,
    title: 'omadia',
    backgroundColor: '#0b0d12',
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  w.once('ready-to-show', () => w.show());
  w.on('close', (e) => {
    // Closing the window hides omadia to the tray; the local stack keeps running.
    if (!quitting) {
      e.preventDefault();
      w.hide();
    }
  });
  installRendererGuards(w);
  return w;
}

/**
 * Renderer failure handling (OM-57).
 *
 * Without these the window had exactly one behaviour when the web-ui died under
 * a running navigation: it showed `backgroundColor`. A black rectangle, no
 * error, no spinner — the tester could not tell whether it was his credentials,
 * the app, or himself. The filtering rules (why ERR_ABORTED and subframes must
 * be ignored) are in `loadFailure.ts`.
 */
function installRendererGuards(w: BrowserWindow): void {
  w.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      const failure: LoadFailureEvent = { errorCode, isMainFrame, validatedURL };
      if (!shouldRecoverFromLoadFailure(failure, LOADING_PAGE)) return;
      log.error(
        `[main] renderer load failed (${errorCode} ${errorDescription}) for ${validatedURL}`,
      );
      void recoverRenderer(t('shell.loadFailed.uiGone', 'The connection to the interface was lost.'));
    },
  );

  w.webContents.on('render-process-gone', (_event, details) => {
    log.error(`[main] render process gone: ${details.reason} (exitCode ${details.exitCode})`);
    void recoverRenderer(t('shell.loadFailed.uiGone', 'The connection to the interface was lost.'));
  });

  w.webContents.on('unresponsive', () => {
    // Deliberately NOT navigating away. A hung renderer is often temporary, and
    // replacing it would throw away whatever the user had on screen — the same
    // class of harm as the wizard being overwritten. Surface it and let the user
    // decide via tray → Restart.
    log.warn('[main] renderer unresponsive');
    setTrayStatus(trayActions(), 'error');
  });
}

/**
 * Put the loading screen back up and say what happened.
 *
 * No automatic retry: a reload loop against a genuinely dead stack is worse
 * than a screen that names the problem, and the tray already offers Restart.
 */
async function recoverRenderer(message: string): Promise<void> {
  if (!win || win.isDestroyed()) return;
  const target: ShellView = viewState.showing === 'wizard' ? 'wizard' : 'boot';
  const token = startNavigation(target, 'recover');
  if (token === null) return;
  const page = target === 'wizard' ? WIZARD_PAGE : LOADING_PAGE;
  try {
    await win.loadFile(rendererPath(page));
    if (!finishNavigation(token, target, 'recover')) return;
    if (target === 'boot') {
      sendBootProgress({ phase: 'error', message });
    }
    setTrayStatus(trayActions(), 'error');
  } catch (err) {
    log.error(`[main] renderer recovery failed: ${describeError(err)}`);
  }
}

function sendBootProgress(progress: BootProgress): void {
  if (win && !win.isDestroyed()) win.webContents.send(CH.bootProgress, progress);
}

function checkForUpdatesAction(): void {
  // The updater reports every terminal outcome itself via dialogs/logs, so the
  // menu and tray can deliberately fire-and-forget the async request.
  void checkForUpdatesManually();
}

/**
 * Show the vault recovery key on demand (OM-58).
 *
 * The wizard offered it exactly once, in a step that could be skipped without
 * the user noticing. This is the second path, always available, and viewing it
 * here is the one moment the shell can honestly record as "the user has seen
 * their key" — which is what stops the reminder.
 */
async function showRecoveryKeyAction(): Promise<void> {
  let key: string;
  try {
    key = exportRecoveryKey();
  } catch (err) {
    log.error(`[main] recovery key unavailable: ${describeError(err)}`);
    await dialog.showMessageBox({
      type: 'error',
      title: t('recovery.unavailableTitle', 'Recovery key unavailable'),
      message: t('recovery.unavailableTitle', 'Recovery key unavailable'),
      detail: fillPlaceholders(
        t(
          'recovery.unavailableDetail',
          'The key could not be read: {error}\n\nLog file: {logFile}',
        ),
        { error: describeError(err), logFile: logFile() },
      ),
    });
    return;
  }

  // Recorded before the dialog closes: the key is on screen at this point, and
  // a user who dismisses with the window manager has still seen it.
  markRecoveryKeyShown();

  const copyLabel = t('recovery.copy', 'Copy to clipboard');
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: t('recovery.title', 'Recovery key'),
    message: t('recovery.message', 'Keep this key somewhere safe.'),
    detail: fillPlaceholders(
      t(
        'recovery.detail',
        'This key encrypts your secrets vault. You need it if you ever move omadia to another machine. Losing it makes stored secrets unrecoverable.\n\n{key}',
      ),
      { key },
    ),
    buttons: [copyLabel, t('recovery.close', 'Close')],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) clipboard.writeText(key);
}

/**
 * Ask once whether the user has their recovery key (OM-58).
 *
 * Fires only for a boot-verified install that has never displayed the key
 * through the menu. A user who did read it off the wizard's last step will see
 * this once — an acceptable trade, because the shell genuinely cannot observe
 * that step, and one extra prompt is cheaper than an unrecoverable vault.
 */
async function maybeRemindRecoveryKey(): Promise<void> {
  if (!needsRecoveryKeyReminder()) return;
  const menuItem = t('recovery.menuItem', 'Show recovery key…');
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: t('recovery.reminder.title', 'Recovery key not saved yet'),
    message: t('recovery.reminder.message', 'You have not viewed your recovery key yet.'),
    detail: fillPlaceholders(
      t(
        'recovery.reminder.detail',
        'omadia runs a local database. Without this key, stored secrets cannot be recovered after a machine change.\n\nYou can find it any time under "Help" → "{menuItem}".',
      ),
      { menuItem },
    ),
    buttons: [
      t('recovery.reminder.show', 'Show now'),
      t('recovery.reminder.later', 'Later'),
    ],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) await showRecoveryKeyAction();
}

function trayActions(): TrayActions {
  return {
    open: () => {
      if (win) {
        win.show();
        win.focus();
      }
    },
    restart: async () => {
      if (!supervisor || !win) return;
      const token = startNavigation('boot', 'restart');
      if (token === null) return;
      await win.loadFile(rendererPath(LOADING_PAGE));
      setTrayStatus(trayActions(), 'starting');
      supervisor.on('progress', forwardProgress);
      streamBootLogs = true;
      try {
        const uiUrl = await supervisor.restart();
        streamBootLogs = false;
        if (!finishNavigation(token, 'app', 'restart')) return;
        await win.loadURL(uiUrl);
        setTrayStatus(trayActions(), 'running');
      } catch (err) {
        log.error(`[main] restart failed: ${describeError(err)}`);
        setTrayStatus(trayActions(), 'error');
      } finally {
        streamBootLogs = false;
        supervisor.off('progress', forwardProgress);
      }
    },
    checkForUpdates: checkForUpdatesAction,
    quit: () => {
      quitting = true;
      app.quit();
    },
  };
}

function forwardProgress(p: BootProgress): void {
  if (win && !win.isDestroyed()) win.webContents.send(CH.bootProgress, p);
}

// Mirror log lines (kernel/web-ui/DB output all funnel through `log`) to the
// boot UI for install verbosity. Subscribed once; gated by `streamBootLogs`.
onLog((level, msg) => {
  if (streamBootLogs && win && !win.isDestroyed()) {
    win.webContents.send(CH.bootLog, { level, msg });
  }
});

async function bootExistingInstall(): Promise<void> {
  if (!win || !supervisor) return;
  const token = startNavigation('boot', 'boot-existing');
  if (token === null) return;
  await win.loadFile(rendererPath(LOADING_PAGE));
  supervisor.on('progress', forwardProgress);
  streamBootLogs = true;
  try {
    const uiUrl = await supervisor.start();
    streamBootLogs = false;
    if (!finishNavigation(token, 'app', 'boot-existing')) return;
    await win.loadURL(uiUrl);
    setTrayStatus(trayActions(), 'running');
    await maybeRemindRecoveryKey();
  } catch (err) {
    streamBootLogs = false;
    await presentBootFailure(err);
  } finally {
    streamBootLogs = false;
    supervisor.off('progress', forwardProgress);
  }
}

/**
 * Turn a rejected boot into something a user can act on (OM-56).
 *
 * The old code interpolated the raw rejection into the dialog, so `Error: boot
 * superseded` — a deliberate internal state during an update — was presented as
 * a failure with two buttons that could both do damage. A superseded boot now
 * gets an explanation and a single harmless acknowledgement; only a genuine
 * failure still offers setup or quit, and the developer text moves into a
 * clearly-labelled support section instead of being the headline.
 */
async function presentBootFailure(err: unknown): Promise<void> {
  if (!win) return;
  const failure = classifyBootFailure(err);

  if (failure.kind === 'superseded') {
    log.info(`[main] boot superseded (expected during an update): ${failure.detail}`);
    setTrayStatus(trayActions(), 'starting');
    await dialog.showMessageBox(win, {
      type: 'info',
      title: t('boot.superseded.title', 'Applying update'),
      message: t('boot.superseded.message', 'omadia is applying an update.'),
      detail: t(
        'boot.superseded.detail',
        'Please wait until it finishes. The window will refresh by itself.',
      ),
      buttons: [t('boot.superseded.ok', 'OK')],
      defaultId: 0,
      cancelId: 0,
    });
    return;
  }

  log.error(`[main] boot failed: ${failure.detail}`);
  setTrayStatus(trayActions(), 'error');
  const { response } = await dialog.showMessageBox(win, {
    type: 'error',
    title: t('boot.failed.title', 'omadia failed to start'),
    message: t('boot.failed.message', 'omadia could not start its local services.'),
    detail: fillPlaceholders(
      t(
        'boot.failed.detail',
        'You can re-run setup or quit.\n\nTechnical details for support:\n{error}\n\nLog file: {logFile}',
      ),
      { error: failure.detail, logFile: logFile() },
    ),
    buttons: [
      t('boot.failed.rerunSetup', 'Re-run setup'),
      t('boot.failed.quit', 'Quit'),
    ],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) {
    startWizard();
  } else {
    quitting = true;
    app.quit();
  }
}

function startWizard(): void {
  if (!win) return;
  // 'wizard-complete' is the source that may replace an open wizard, and
  // re-showing the wizard over itself is exactly that: a deliberate restart of
  // first-run setup, requested by the user from the failure dialog.
  const token = startNavigation('wizard', 'wizard-complete');
  if (token === null) return;
  void win.loadFile(rendererPath(WIZARD_PAGE)).then(
    () => {
      finishNavigation(token, 'wizard', 'wizard-complete');
    },
    (err: unknown) => {
      log.error(`[main] wizard failed to load: ${describeError(err)}`);
    },
  );
}

async function onReady(): Promise<void> {
  // `app.getLocale()` is valid from here on (OM-59).
  t = createShellTranslate(app.getLocale());
  // OM-41 — replace Electron's default menu (which shipped a second
  // fullscreen item and a DevTools accelerator into customer builds).
  installApplicationMenu({
    checkForUpdates: checkForUpdatesAction,
    showRecoveryKey: () => void showRecoveryKeyAction(),
  });
  supervisor = new Supervisor();
  setActiveSupervisor(supervisor);

  win = createWindow();
  createTray(trayActions());
  registerIpc({
    boot: async (forward) => {
      supervisor!.on('progress', forward);
      streamBootLogs = true;
      try {
        return await supervisor!.start();
      } finally {
        streamBootLogs = false;
        supervisor!.off('progress', forward);
      }
    },
    onReady: (uiUrl) => {
      // Reached only from the wizard's `complete` handler, i.e. the user
      // finished setup. That is the one legitimate wizard-to-app transition, so
      // it is allowed to replace the wizard — unlike a background boot.
      const token = startNavigation('app', 'wizard-complete');
      if (token === null) return;
      if (!finishNavigation(token, 'app', 'wizard-complete')) return;
      void win?.loadURL(uiUrl);
      setTrayStatus(trayActions(), 'running');
    },
  });

  initUpdater();

  if (isSetupComplete()) {
    await bootExistingInstall();
  } else {
    startWizard();
  }
}

// Single-instance: a second launch focuses the existing window instead of
// starting a second stack on different ports.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(onReady).catch((err) => {
    log.error(`[main] fatal during startup: ${describeError(err)}`);
    app.quit();
  });

  app.on('activate', () => {
    // macOS dock click with no windows open.
    if (win) {
      win.show();
    } else if (BrowserWindow.getAllWindows().length === 0) {
      void onReady();
    }
  });

  app.on('window-all-closed', () => {
    // Intentionally do nothing: omadia stays alive in the tray until the user
    // explicitly quits, so the local stack remains available.
  });

  let quitHandled = false;
  app.on('before-quit', (e) => {
    quitting = true;
    destroyTray();
    // During an update install, electron-updater drives the quit and runs the
    // installer on `will-quit`. It already stopped the supervisor, so we must
    // NOT preventDefault + app.exit() here — that would bypass the install.
    if (isUpdateInstalling()) return;
    if (quitHandled || !supervisor) return;
    // Block the quit just long enough to flush + close the embedded DB and
    // terminate the children cleanly, then exit for real.
    quitHandled = true;
    e.preventDefault();
    void (async () => {
      try {
        await supervisor!.stop();
      } catch (err) {
        log.error(`[main] shutdown error: ${describeError(err)}`);
      } finally {
        app.exit(0);
      }
    })();
  });
}
