/**
 * Minimal stand-in for the `electron` module, so the desktop lifecycle code can
 * be unit-tested in plain node (#932).
 *
 * Only the surface the modules under test touch at import time or on the paths
 * they exercise. Anything else throws loudly rather than returning undefined,
 * so a test that wanders into unstubbed Electron territory fails with a clear
 * message instead of a confusing TypeError.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omadia-electron-fake-'));

export const app = {
  isPackaged: false,
  getVersion: () => '0.0.0-test',
  getPath: (name) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  },
  getName: () => 'omadia',
  on: () => app,
  quit: () => {},
};

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: () => Buffer.from(''),
  decryptString: () => '',
};

function unavailable(name) {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(
          `electron.${name}.${String(prop)} is not stubbed; this test should not reach Electron`,
        );
      },
    },
  );
}

export const dialog = unavailable('dialog');
export const ipcMain = unavailable('ipcMain');
export const Menu = unavailable('Menu');
export const Tray = unavailable('Tray');
export const shell = unavailable('shell');
export const nativeImage = unavailable('nativeImage');
export const BrowserWindow = unavailable('BrowserWindow');
export const contextBridge = unavailable('contextBridge');
export const ipcRenderer = unavailable('ipcRenderer');

export default { app, safeStorage, dialog, ipcMain, Menu, Tray, shell, nativeImage, BrowserWindow };
