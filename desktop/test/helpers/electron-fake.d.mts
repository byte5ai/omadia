/**
 * Types for the test-only Electron fake, so a test can import its control
 * surface (`__setDialogHandler`, `__lastClipboardText`, `__setIpcMain`,
 * `__setContextBridge`) under `typecheck:test`. Runtime behaviour lives in
 * `electron-fake.mjs`; keep the two in step.
 */
import type {
  MessageBoxOptions,
  MessageBoxReturnValue,
  BrowserWindow,
  IpcMainEvent,
  IpcMainInvokeEvent,
} from 'electron';

export type DialogHandler = (
  ...args: [BrowserWindow, MessageBoxOptions] | [MessageBoxOptions]
) => Promise<MessageBoxReturnValue>;

/** Install the handler every `dialog.showMessageBox` call is forwarded to. */
export function __setDialogHandler(handler: DialogHandler | null): void;

/** The last text written through `clipboard.writeText`, or null. */
export function __lastClipboardText(): string | null;

/** Set what `app.getLocale()` returns, so dialog copy can be asserted on. */
export function __setLocale(locale: string): void;

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
