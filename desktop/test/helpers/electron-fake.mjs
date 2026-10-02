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
  getLocale: () => locale,
  on: () => app,
  quit: () => {},
};

/**
 * The shell falls back to `app.getLocale()` while the web-ui has not reported
 * its language (OM-59, OM-91, #1074: `shellLocale.ts`), so a test that asserts
 * on dialog copy has to be able to move it.
 */
let locale = 'en-US';
export function __setLocale(next) {
  locale = next;
}

const SAFE_STORAGE_DEFAULTS = {
  isEncryptionAvailable: () => false,
  encryptString: () => Buffer.from(''),
  decryptString: () => '',
};

export const safeStorage = { ...SAFE_STORAGE_DEFAULTS };

/**
 * Replace `safeStorage` methods for a test (null restores the defaults), e.g. to
 * make encryption available and decryption throw like a refused keychain.
 *
 * The methods are swapped ON the exported object rather than the export being
 * reassigned: `secrets.ts` imports `safeStorage` by name, so only a mutation of
 * the object it already holds reaches it.
 */
export function __setSafeStorage(impl) {
  Object.assign(safeStorage, SAFE_STORAGE_DEFAULTS, impl ?? {});
}

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
let clipboardFailure = null;
export function __lastClipboardText() {
  return clipboardText;
}
/** Make the next `clipboard.writeText` reject with `error`. */
export function __failNextClipboardWrite(error) {
  clipboardFailure = error;
}
// Async like Electron 44's W3C-shaped clipboard, so a caller that drops the
// promise is caught by a test instead of by a user.
export const clipboard = {
  writeText: async (text) => {
    if (clipboardFailure) {
      const error = clipboardFailure;
      clipboardFailure = null;
      throw error;
    }
    clipboardText = text;
  },
};

/**
 * A surface a test can opt into, like `dialog`: every property read is
 * forwarded to the fake installed with the named setter, so the production code
 * runs against the calls it really makes (`registerIpc` registering its
 * channels, the preload exposing its bridge). Without a fake it throws like
 * every other unstubbed surface.
 */
function optIn(name, setter, current) {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        const fake = current();
        if (fake === null) {
          throw new Error(`electron.${name}.${String(prop)} is not stubbed; call ${setter} first`);
        }
        return fake[prop];
      },
    },
  );
}

let ipcMainFake = null;
/** Install the object `ipcMain.handle` / `ipcMain.on` are forwarded to. */
export function __setIpcMain(fake) {
  ipcMainFake = fake;
}
export const ipcMain = optIn('ipcMain', '__setIpcMain', () => ipcMainFake);

let contextBridgeFake = null;
/** Install the object `contextBridge.exposeInMainWorld` is forwarded to. */
export function __setContextBridge(fake) {
  contextBridgeFake = fake;
}
export const contextBridge = optIn('contextBridge', '__setContextBridge', () => contextBridgeFake);

export const Menu = unavailable('Menu');
export const Tray = unavailable('Tray');
export const shell = unavailable('shell');
export const nativeImage = unavailable('nativeImage');
export const BrowserWindow = unavailable('BrowserWindow');
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
