import { app, BrowserWindow, dialog } from 'electron';
import path from 'node:path';
import { Supervisor, setActiveSupervisor, BootProgress } from './supervisor';
import { registerIpc } from './ipc';
import { CH } from './ipcTypes';
import { createTray, setTrayStatus, destroyTray, TrayActions } from './tray';
import { initUpdater, isUpdateInstalling } from './updater';
import { isSetupComplete } from './setupState';
import { log } from './log';

// Stable app identity so userData resolves to ".../omadia" in both dev and
// packaged builds (in dev the Electron CLI would otherwise name it "Electron").
app.setName('omadia');

let win: BrowserWindow | null = null;
let supervisor: Supervisor | null = null;
let quitting = false;

function rendererPath(file: string): string {
  return path.join(app.getAppPath(), 'dist', 'renderer', file);
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
  return w;
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
      await win.loadFile(rendererPath('loading.html'));
      setTrayStatus(trayActions(), 'starting');
      supervisor.on('progress', forwardProgress);
      try {
        const uiUrl = await supervisor.restart();
        await win.loadURL(uiUrl);
        setTrayStatus(trayActions(), 'running');
      } catch (err) {
        log.error(`[main] restart failed: ${String(err)}`);
        setTrayStatus(trayActions(), 'error');
      } finally {
        supervisor.off('progress', forwardProgress);
      }
    },
    quit: () => {
      quitting = true;
      app.quit();
    },
  };
}

function forwardProgress(p: BootProgress): void {
  if (win && !win.isDestroyed()) win.webContents.send(CH.bootProgress, p);
}

async function bootExistingInstall(): Promise<void> {
  if (!win || !supervisor) return;
  await win.loadFile(rendererPath('loading.html'));
  supervisor.on('progress', forwardProgress);
  try {
    const uiUrl = await supervisor.start();
    await win.loadURL(uiUrl);
    setTrayStatus(trayActions(), 'running');
  } catch (err) {
    log.error(`[main] boot failed: ${String(err)}`);
    setTrayStatus(trayActions(), 'error');
    const { response } = await dialog.showMessageBox(win, {
      type: 'error',
      title: 'omadia failed to start',
      message: 'omadia could not start its local services.',
      detail: `${String(err)}\n\nYou can re-run setup or quit. Logs: tray → Open Logs.`,
      buttons: ['Re-run setup', 'Quit'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      startWizard();
    } else {
      quitting = true;
      app.quit();
    }
  } finally {
    supervisor.off('progress', forwardProgress);
  }
}

function startWizard(): void {
  if (!win) return;
  void win.loadFile(rendererPath('wizard.html'));
}

async function onReady(): Promise<void> {
  supervisor = new Supervisor();
  setActiveSupervisor(supervisor);

  win = createWindow();
  createTray(trayActions());
  registerIpc({
    boot: async (forward) => {
      supervisor!.on('progress', forward);
      try {
        return await supervisor!.start();
      } finally {
        supervisor!.off('progress', forward);
      }
    },
    onReady: (uiUrl) => {
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
    log.error(`[main] fatal during startup: ${String(err)}`);
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
        log.error(`[main] shutdown error: ${String(err)}`);
      } finally {
        app.exit(0);
      }
    })();
  });
}
