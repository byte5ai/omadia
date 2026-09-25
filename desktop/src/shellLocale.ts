import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { log } from './log';
import { uiLocaleFile } from './paths';
import { createShellTranslate, type ShellTranslate } from './shellStrings';

/**
 * The shell's language source (#1074, OM-91 residual).
 *
 * THIS IS THE ONLY MODULE THAT READS `app.getLocale()`. Every main-process
 * translator (dialogs, updater, menu headings) goes through the store below; a
 * source census in `test/shellLocale.test.mts` keeps it that way.
 *
 * Before this, each of them read the OS locale on its own. A user on an English
 * OS who switched the web-ui to German therefore got English dialogs, because
 * the UI language lives in the renderer (the `NEXT_LOCALE` cookie) and nothing
 * told the main process about it. Reading that cookie from here would be async
 * and would add a failure source to dialogs that fire on error paths, which
 * OM-91 rejected. So the direction is reversed: the web-ui PUSHES the language
 * it is showing over `omadia:uiLocale`, and this store caches it.
 *
 * The value is also persisted under `userData`, because some dialogs fire
 * before the renderer is up (a boot failure, the updater at startup). With no
 * valid value from the UI, the OS locale is still the fallback, so a fresh
 * install behaves as before.
 *
 * The helpers take the file path and never throw, like `updateAttempts.ts`, so
 * node:test drives them without Electron.
 */

/** The languages the web-ui offers (`web-ui/i18n/locales.ts`). Nothing else is accepted. */
export const SHELL_UI_LOCALES = ['en', 'de'] as const;
export type ShellUiLocale = (typeof SHELL_UI_LOCALES)[number];

/**
 * Strict: exact `'en'` or `'de'` only. The value arrives over IPC from a
 * renderer, so anything else (a region tag, another casing, a non-string) is
 * rejected rather than coerced, and the OS locale stays in charge.
 */
export function parseUiLocale(value: unknown): ShellUiLocale | null {
  if (typeof value !== 'string') return null;
  return (SHELL_UI_LOCALES as readonly string[]).includes(value) ? (value as ShellUiLocale) : null;
}

interface PersistedUiLocale {
  readonly locale: ShellUiLocale;
}

/** The persisted UI language, or null when the file is absent, corrupt or invalid. */
export function readPersistedUiLocale(file: string): ShellUiLocale | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parseUiLocale((parsed as Record<string, unknown>)['locale']);
  } catch {
    // Absent is the normal case (the UI never reported), and a corrupt file
    // must never break a dialog: fall back to the OS locale.
    return null;
  }
}

/** Best effort. Returns whether the value reached disk; never throws. */
export function writePersistedUiLocale(file: string, locale: ShellUiLocale): boolean {
  try {
    const record: PersistedUiLocale = { locale };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

export interface ShellLocaleStore {
  /** The UI language when known, else the OS locale. */
  current(): string;
  /** Accepts a value from the renderer. True only when the language actually changed. */
  setUiLocale(value: unknown): boolean;
  /** A translator for the current language, resolved at call time. */
  translator(): ShellTranslate;
}

export interface ShellLocaleStoreOptions {
  /** Resolved lazily: `app.getPath` must not run at import time. */
  readonly file: () => string;
  readonly osLocale: () => string;
  /** Told when a new value could not be persisted. */
  readonly warn?: (message: string) => void;
}

export function createShellLocaleStore(options: ShellLocaleStoreOptions): ShellLocaleStore {
  const warn = options.warn ?? (() => undefined);
  let loaded = false;
  let uiLocale: ShellUiLocale | null = null;

  function resolveFile(): string | null {
    try {
      return options.file();
    } catch (err) {
      warn(`[shellLocale] no path for the UI language file: ${String(err)}`);
      return null;
    }
  }

  function known(): ShellUiLocale | null {
    if (!loaded) {
      loaded = true;
      const file = resolveFile();
      uiLocale = file === null ? null : readPersistedUiLocale(file);
    }
    return uiLocale;
  }

  function current(): string {
    return known() ?? options.osLocale();
  }

  function setUiLocale(value: unknown): boolean {
    const next = parseUiLocale(value);
    if (next === null || next === known()) return false;
    // Memory first: the language on screen wins for this launch even if the
    // disk write fails; only the next launch's early dialogs lose it.
    uiLocale = next;
    const file = resolveFile();
    if (file !== null && !writePersistedUiLocale(file, next)) {
      warn(`[shellLocale] could not persist the UI language to ${file}`);
    }
    return true;
  }

  return {
    current,
    setUiLocale,
    translator: () => createShellTranslate(current()),
  };
}

/** The store the shell uses. */
export const shellLocale = createShellLocaleStore({
  file: uiLocaleFile,
  osLocale: () => app.getLocale(),
  warn: (message) => log.warn(message),
});
