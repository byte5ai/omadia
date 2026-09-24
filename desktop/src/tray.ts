import { Tray, Menu, nativeImage, shell, app } from 'electron';
import { log, logFile } from './log';
import { resolveTrayIconPath, trayIconCandidates } from './icons';

/**
 * System tray icon + menu. Lets omadia keep running in the background (the local
 * stack stays up) while giving quick access to Open / Restart / Logs / Updates /
 * Quit.
 */
export interface TrayActions {
  open: () => void;
  restart: () => void;
  checkForUpdates: () => void;
  quit: () => void;
}

let tray: Tray | null = null;

export function createTray(actions: TrayActions): Tray {
  const icon = loadTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('omadia');
  rebuildMenu(actions, 'running');
  tray.on('click', () => actions.open());
  return tray;
}

export function setTrayStatus(actions: TrayActions, status: 'starting' | 'running' | 'error'): void {
  rebuildMenu(actions, status);
}

function rebuildMenu(actions: TrayActions, status: string): void {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: `omadia — ${status}`, enabled: false },
    { type: 'separator' },
    { label: 'Open omadia', click: () => actions.open() },
    { label: 'Restart', click: () => actions.restart() },
    { label: 'Open Logs', click: () => void shell.openPath(logFile()) },
    { label: 'Check for Updates…', click: () => actions.checkForUpdates() },
    { type: 'separator' },
    { label: 'Quit', click: () => actions.quit() },
  ]);
  tray.setContextMenu(menu);
}

function loadTrayIcon(): Electron.NativeImage {
  const appPath = app.getAppPath();
  const found = resolveTrayIconPath(appPath);
  if (found === null) {
    // Still fall back to an empty image — a missing asset must not stop the app
    // from starting — but say so. An empty tray image is invisible in the menu
    // bar, which makes every action behind the tray (Restart, Logs, Quit)
    // unreachable, and #1002 points users at Tray → Restart. Three beta rounds
    // shipped this silently (OM-53/OM-63); it will not go quiet again.
    log.warn(
      '[tray] no tray icon found, the menu bar entry will be invisible. Looked in: ' +
        trayIconCandidates(appPath).join(', ') +
        '. Run `npm run icons` in desktop/ to regenerate the assets.',
    );
    return nativeImage.createEmpty();
  }
  const img = nativeImage.createFromPath(found);
  // macOS tints a template image for the light and the dark menu bar. Harmless
  // elsewhere: Windows and Linux ignore the flag.
  img.setTemplateImage(true);
  return img;
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}
