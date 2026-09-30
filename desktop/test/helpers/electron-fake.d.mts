/**
 * Types for the test-only Electron fake, so a test can import its control
 * surface (`__setDialogHandler`, `__lastClipboardText`, `__setSafeStorage`)
 * under `typecheck:test`.
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
