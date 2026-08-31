import { Tray, Menu, nativeImage, shell, app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { log, logFile } from './log';
import { assetPath } from './assetPath';

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
  // The bundled template icon (shipped to dist/assets by scripts/copy-assets.mjs).
  // If it is ever missing we still fall back to an empty image so a packaging slip
  // never crashes startup — but we log it, because an empty tray icon is invisible
  // (OM-63) and a silent fallback is exactly how that shipped unnoticed before.
  const candidates = [
    assetPath('trayTemplate.png'),
    path.join(app.getAppPath(), 'assets', 'trayTemplate.png'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const img = nativeImage.createFromPath(p);
      img.setTemplateImage(true);
      return img;
    }
  }
  log.warn(`tray icon asset not found (looked in: ${candidates.join(', ')}); the menu-bar icon will be invisible`);
  return nativeImage.createEmpty();
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}
