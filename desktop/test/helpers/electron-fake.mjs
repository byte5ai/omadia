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

/**
 * `dialog` is opt-in: a test installs a handler with `__setDialogHandler`, and
 * every `showMessageBox` call is forwarded to it with the exact arguments the
 * production code passed (so a test can assert on the parent window, OM-71).
 * Without a handler it throws like every other unstubbed surface.
 */
let dialogHandler = null;
export function __setDialogHandler(handler) {
  dialogHandler = handler;
}
export const dialog = {
  showMessageBox: (...args) => {
    if (dialogHandler === null) {
      throw new Error('electron.dialog.showMessageBox is not stubbed; call __setDialogHandler first');
    }
    return dialogHandler(...args);
  },
};

/** Records the last text written, so a "copy" button can be asserted on. */
let clipboardText = null;
export function __lastClipboardText() {
  return clipboardText;
}
export const clipboard = {
  writeText: (text) => {
    clipboardText = text;
  },
};
export const ipcMain = unavailable('ipcMain');
export const Menu = unavailable('Menu');
export const Tray = unavailable('Tray');
export const shell = unavailable('shell');
export const nativeImage = unavailable('nativeImage');
export const BrowserWindow = unavailable('BrowserWindow');
export const contextBridge = unavailable('contextBridge');
export const ipcRenderer = unavailable('ipcRenderer');

export default {
  app,
  safeStorage,
  dialog,
  clipboard,
  ipcMain,
  Menu,
  Tray,
  shell,
  nativeImage,
  BrowserWindow,
};
