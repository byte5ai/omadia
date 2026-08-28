import { app, BrowserWindow } from 'electron';
import { installApplicationMenu } from './menu';
import path from 'node:path';
import { Supervisor, setActiveSupervisor, BootProgress } from './supervisor';
import { registerIpc } from './ipc';
import { CH } from './ipcTypes';
import { createTray, setTrayStatus, destroyTray, TrayActions } from './tray';
import { checkForUpdatesManually, initUpdater, isUpdateInstalling } from './updater';
import { isSetupComplete } from './setupState';
import { log, logFile, onLog } from './log';
import { classifyBootFailure, describeError } from './bootFailure';
import {
  clearRecoveryBudget,
  initialRecoveryBudget,
  nextRecoveryAttempt,
  shouldRecoverFromLoadFailure,
  type LoadFailureEvent,
  type RecoveryBudget,
} from './loadFailure';
import {
  abandonNavigation,
  beginNavigation,
  commitNavigation,
  initialViewState,
  mayCommitNavigation,
  mayStartNavigation,
  type NavSource,
  type ShellView,
  type ViewState,
} from './shellView';
import { createShellTranslate, type ShellTranslate } from './shellStrings';
import {
  showBootFailure,
  showRecoveryExhausted,
  showRestartRefused,
  showSupersededBoot,
} from './shellDialogs';
import { maybeRemindRecoveryKey, showRecoveryKeyAction } from './recoveryKeyActions';

// Stable app identity so userData resolves to ".../omadia" in both dev and
// packaged builds (in dev the Electron CLI would otherwise name it "Electron").
app.setName('omadia');

const LOADING_PAGE = 'loading.html';
const WIZARD_PAGE = 'wizard.html';
/** Marks a wizard load as following a crash, so the reset to step 0 is explained. */
const RECOVERED_HASH = 'recovered';

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

/** Bounded budget for replacing a dead renderer (OM-57). See `loadFailure.ts`. */
let recoveryBudget: RecoveryBudget = initialRecoveryBudget();

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

/** Which page a recovery would load, and the view it establishes. */
function recoveryTarget(): { readonly view: ShellView; readonly page: string } {
  return viewState.showing === 'wizard'
    ? { view: 'wizard', page: WIZARD_PAGE }
    : { view: 'boot', page: LOADING_PAGE };
}

/**
 * Renderer failure handling (OM-57).
 *
 * Without these the window had exactly one behaviour when the web-ui died under
 * a running navigation: it showed `backgroundColor`. A black rectangle, no
 * error, no spinner — the tester could not tell whether it was his credentials,
 * the app, or himself.
 *
 * The filtering rules live in `loadFailure.ts`, and so does the reason the
 * filter alone is not enough: the identity check has to be made against the page
 * a recovery would ACTUALLY load, and everything it cannot see needs a bounded
 * budget behind it.
 */
function installRendererGuards(w: BrowserWindow): void {
  w.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      const failure: LoadFailureEvent = { errorCode, isMainFrame, validatedURL };
      // Compare against the page we would load, NOT a hardcoded one: recovery
      // can target the wizard, and hardcoding `loading.html` here let a failing
      // wizard reload itself forever.
      if (!shouldRecoverFromLoadFailure(failure, recoveryTarget().page)) return;
      log.error(
        `[main] renderer load failed (${errorCode} ${errorDescription}) for ${validatedURL}`,
      );
      void recoverRenderer();
    },
  );

  w.webContents.on('render-process-gone', (_event, details) => {
    // No URL to compare here at all, so the budget is the only guard.
    log.error(`[main] render process gone: ${details.reason} (exitCode ${details.exitCode})`);
    void recoverRenderer();
  });

  w.webContents.on('unresponsive', () => {
    // Deliberately NOT navigating away. A hung renderer is often temporary, and
    // replacing it would throw away whatever the user had on screen — the same
    // class of harm as the wizard being overwritten. Surface it and let the user
    // decide via tray → Restart.
    log.warn('[main] renderer unresponsive');
    setTrayStatus(trayActions(), 'error');
  });

  w.webContents.on('responsive', () => {
    // Without this the tray stayed red forever after a transient hang, which
    // undercuts the whole reason `unresponsive` does not navigate away.
    log.info('[main] renderer responsive again');
    setTrayStatus(trayActions(), viewState.showing === 'app' ? 'running' : 'starting');
  });

  w.webContents.on('did-finish-load', () => {
    // Something rendered, so by definition the shell is not looping.
    recoveryBudget = clearRecoveryBudget();
  });
}

/**
 * Put a working page back up and say what happened.
 *
 * No automatic retry of the page that died: a reload loop against a genuinely
 * dead stack is worse than a screen that names the problem, and the tray already
 * offers Restart. The budget bounds even the recovery itself, so a fallback page
 * that cannot load reaches a terminal, explained state instead of spinning.
 */
async function recoverRenderer(): Promise<void> {
  if (!win || win.isDestroyed()) return;
  const { view, page } = recoveryTarget();

  const attempt = nextRecoveryAttempt(recoveryBudget, page);
  recoveryBudget = attempt.budget;
  if (!attempt.allowed) {
    log.error(`[main] giving up recovering ${page} after ${attempt.budget.attempts - 1} attempts`);
    setTrayStatus(trayActions(), 'error');
    await showRecoveryExhausted(t, logFile());
    return;
  }

  const token = startNavigation(view, 'recover');
  if (token === null) return;
  try {
    // A recovered wizard restarts at step 0 and loses what was entered, so the
    // page is told to explain that rather than leaving the user guessing.
    await win.loadFile(
      rendererPath(page),
      view === 'wizard' ? { hash: RECOVERED_HASH } : {},
    );
    if (!finishNavigation(token, view, 'recover')) return;
    if (view === 'boot') {
      sendBootProgress({
        phase: 'error',
        message: t(
          'shell.loadFailed.uiGone',
          'The connection to the interface was lost. You can restart omadia from the menu-bar icon.',
        ),
      });
    }
    setTrayStatus(trayActions(), 'error');
  } catch (err) {
    // The load itself rejected; release the claim so the arbiter is not frozen.
    viewState = abandonNavigation(viewState, view);
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
      if (token === null) {
        // The arbiter refused (first-run setup is open). Say so: a menu action
        // that visibly does nothing is its own small version of this bug class.
        await showRestartRefused(t);
        return;
      }
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
        await maybeRemindRecoveryKey(t);
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
    await maybeRemindRecoveryKey(t);
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
 * a failure with two buttons that could both do damage. See `bootFailure.ts`.
 */
async function presentBootFailure(err: unknown): Promise<void> {
  if (!win) return;
  const failure = classifyBootFailure(err);

  if (failure.kind === 'superseded') {
    log.info(`[main] boot superseded (expected during an update): ${failure.detail}`);
    setTrayStatus(trayActions(), 'starting');
    await showSupersededBoot(win, t);
    return;
  }

  log.error(`[main] boot failed: ${failure.detail}`);
  setTrayStatus(trayActions(), 'error');
  if ((await showBootFailure(win, t, failure.detail, logFile())) === 'rerun-setup') {
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
      // Release the optimistic claim. Leaving it would freeze the arbiter on
      // 'wizard' forever, refusing every later boot and restart with no way back.
      viewState = abandonNavigation(viewState, 'boot');
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
    showRecoveryKey: () => void showRecoveryKeyAction(t),
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
