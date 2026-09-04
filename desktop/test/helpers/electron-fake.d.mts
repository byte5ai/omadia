/**
 * Types for the test-only Electron fake, so a test can import its control
 * surface (`__setDialogHandler`, `__lastClipboardText`) under `typecheck:test`.
 * Runtime behaviour lives in `electron-fake.mjs`; keep the two in step.
 */
import type { MessageBoxOptions, MessageBoxReturnValue, BrowserWindow } from 'electron';

export type DialogHandler = (
  ...args: [BrowserWindow, MessageBoxOptions] | [MessageBoxOptions]
) => Promise<MessageBoxReturnValue>;

/** Install the handler every `dialog.showMessageBox` call is forwarded to. */
export function __setDialogHandler(handler: DialogHandler | null): void;

/** The last text written through `clipboard.writeText`, or null. */
export function __lastClipboardText(): string | null;
