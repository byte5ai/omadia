/**
 * Types for the test-only Electron fake, so a test can import its control
 * surface (`__setDialogHandler`, `__setOpenDialogHandler`, `__lastClipboardText`,
 * `__setSafeStorage`, `__setIpcMain`, `__setContextBridge`) under `typecheck:test`. Runtime
 * behaviour lives in `electron-fake.mjs`; keep the two in step.
 */
import type {
  MessageBoxOptions,
  MessageBoxReturnValue,
  OpenDialogOptions,
  OpenDialogReturnValue,
  BrowserWindow,
  IpcMainEvent,
  IpcMainInvokeEvent,
} from 'electron';

export type DialogHandler = (
  ...args: [BrowserWindow, MessageBoxOptions] | [MessageBoxOptions]
) => Promise<MessageBoxReturnValue>;

/** Install the handler every `dialog.showMessageBox` call is forwarded to. */
export function __setDialogHandler(handler: DialogHandler | null): void;

export type OpenDialogHandler = (
  ...args: [BrowserWindow | undefined, OpenDialogOptions] | [OpenDialogOptions]
) => Promise<OpenDialogReturnValue>;

/** Install the handler every `dialog.showOpenDialog` call is forwarded to. */
export function __setOpenDialogHandler(handler: OpenDialogHandler | null): void;

/** The last text written through `clipboard.writeText`, or null. */
export function __lastClipboardText(): string | null;

/** Make the next `clipboard.writeText` reject with `error`. */
export function __failNextClipboardWrite(error: Error): void;

/** Set what `app.getLocale()` returns, so dialog copy can be asserted on. */
export function __setLocale(locale: string): void;

/** The `safeStorage` methods a test may replace; unset ones keep their defaults. */
export interface SafeStorageOverride {
  isEncryptionAvailable?: () => boolean;
  encryptString?: (plainText: string) => Buffer;
  decryptString?: (encrypted: Buffer) => string;
}

/** Swap `safeStorage` methods in place; null restores the defaults (no encryption). */
export function __setSafeStorage(impl: SafeStorageOverride | null): void;

/** What `registerIpc` hands `ipcMain.handle`; a test calls it like Electron would. */
export type FakeInvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
/** What `registerIpc` hands `ipcMain.on`. */
export type FakeOnListener = (event: IpcMainEvent, ...args: unknown[]) => void;

/** The part of `ipcMain` that `registerIpc` calls. */
export interface FakeIpcMain {
  handle(channel: string, handler: FakeInvokeHandler): void;
  on(channel: string, listener: FakeOnListener): unknown;
}

/** Install the object `ipcMain.handle` / `ipcMain.on` are forwarded to. */
export function __setIpcMain(fake: FakeIpcMain | null): void;

/** The part of `contextBridge` the preload calls. */
export interface FakeContextBridge {
  exposeInMainWorld(apiKey: string, api: unknown): void;
}

/** Install the object `contextBridge.exposeInMainWorld` is forwarded to. */
export function __setContextBridge(fake: FakeContextBridge | null): void;
