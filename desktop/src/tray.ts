import { Tray, Menu, nativeImage, shell, app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { logFile } from './log';

/**
 * System tray icon + menu. Lets omadia keep running in the background (the local
 * stack stays up) while giving quick access to Open / Restart / Logs / Quit.
 */
export interface TrayActions {
  open: () => void;
  restart: () => void;
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
    { type: 'separator' },
    { label: 'Quit', click: () => actions.quit() },
  ]);
  tray.setContextMenu(menu);
}

function loadTrayIcon(): Electron.NativeImage {
  // Prefer a bundled template icon; fall back to an empty image so a missing asset
  // never crashes startup (the tray still works, just without artwork).
  const candidates = [
    path.join(app.getAppPath(), 'dist', 'assets', 'trayTemplate.png'),
    path.join(app.getAppPath(), 'assets', 'trayTemplate.png'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const img = nativeImage.createFromPath(p);
      img.setTemplateImage(true);
      return img;
    }
  }
  return nativeImage.createEmpty();
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}
