/**
 * Unit tests for the shell's language source (#1074, OM-91 residual).
 *
 * The bug these pin: every main-process translator was built from
 * `app.getLocale()`, the OS locale. A user on an English OS who switched the
 * web-ui to German still got English updater and shell dialogs, because
 * nothing ever told the main process what the UI was showing.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SHELL_UI_LOCALES,
  createShellLocaleStore,
  parseUiLocale,
  readPersistedUiLocale,
  writePersistedUiLocale,
} from '../src/shellLocale.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..', 'src');
const WEB_UI = path.join(here, '..', '..', 'web-ui');

const EN_TITLE = 'omadia could not start';
const DE_TITLE = 'omadia konnte nicht starten';

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omadia-ui-locale-'));
  return path.join(dir, 'ui-locale.json');
}

function store(file: string, osLocale: string) {
  return createShellLocaleStore({ file: () => file, osLocale: () => osLocale });
}

describe('parseUiLocale', () => {
  it('accepts exactly the two web-ui locales', () => {
    assert.equal(parseUiLocale('en'), 'en');
    assert.equal(parseUiLocale('de'), 'de');
  });

  it('rejects everything else', () => {
    for (const value of ['de-DE', 'DE', 'fr', '', ' de', 'de'.repeat(10_000), null, undefined, 42, {}, ['de']]) {
      assert.equal(parseUiLocale(value), null, `accepted ${JSON.stringify(value)?.slice(0, 20)}`);
    }
  });
});

describe('createShellLocaleStore', () => {
  it('falls back to the OS locale when the UI never reported one', () => {
    assert.equal(store(tmpFile(), 'de-DE').translator()('boot.failed.title', EN_TITLE), DE_TITLE);
    assert.equal(store(tmpFile(), 'en-US').translator()('boot.failed.title', EN_TITLE), EN_TITLE);
    assert.equal(store(tmpFile(), 'en-US').current(), 'en-US');
  });

  it('speaks German on an English OS once the UI says German (the #1074 scenario)', () => {
    const s = store(tmpFile(), 'en-US');
    assert.equal(s.setUiLocale('de'), true);
    assert.equal(s.current(), 'de');
    assert.equal(s.translator()('boot.failed.title', EN_TITLE), DE_TITLE);
  });

  it('speaks English on a German OS once the UI says English', () => {
    const s = store(tmpFile(), 'de-DE');
    assert.equal(s.setUiLocale('en'), true);
    assert.equal(s.translator()('boot.failed.title', EN_TITLE), EN_TITLE);
  });

  it('reports no change, and skips the disk write, when the value is the same', () => {
    const file = tmpFile();
    const s = store(file, 'en-US');
    assert.equal(s.setUiLocale('de'), true);
    // Replace the file with a sentinel: a second write would overwrite it.
    fs.writeFileSync(file, 'sentinel', 'utf8');
    assert.equal(s.setUiLocale('de'), false);
    assert.equal(fs.readFileSync(file, 'utf8'), 'sentinel');
  });

  it('ignores invalid input without touching state or disk', () => {
    const file = tmpFile();
    const s = store(file, 'en-US');
    assert.equal(s.setUiLocale('de'), true);
    const before = fs.readFileSync(file, 'utf8');
    for (const bad of ['fr', 'de-DE', {}, null, 7]) {
      assert.equal(s.setUiLocale(bad), false);
    }
    assert.equal(s.current(), 'de');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  });

  it('does not write anything for invalid input on a fresh store', () => {
    const file = tmpFile();
    assert.equal(store(file, 'en-US').setUiLocale('fr'), false);
    assert.equal(fs.existsSync(file), false);
  });

  it('remembers the UI language across a restart, before the renderer is up', () => {
    const file = tmpFile();
    store(file, 'en-US').setUiLocale('de');
    const afterRestart = store(file, 'en-US');
    assert.equal(afterRestart.current(), 'de');
    assert.equal(afterRestart.translator()('boot.failed.title', EN_TITLE), DE_TITLE);
  });

  it('does not rewrite a persisted value the UI repeats after a restart', () => {
    const file = tmpFile();
    store(file, 'en-US').setUiLocale('de');
    const afterRestart = store(file, 'en-US');
    assert.equal(afterRestart.setUiLocale('de'), false);
  });

  it('falls back to the OS locale for a corrupt or invalid file, without throwing', () => {
    for (const content of ['not json', '{"locale":"fr"}', '"de"', 'null', '{"locale":42}']) {
      const file = tmpFile();
      fs.writeFileSync(file, content, 'utf8');
      assert.equal(store(file, 'en-US').current(), 'en-US', `content ${content}`);
    }
  });

  it('keeps the new language in memory when the file cannot be written', () => {
    const file = tmpFile();
    fs.mkdirSync(file); // a directory where the file should be
    const warnings: string[] = [];
    const s = createShellLocaleStore({
      file: () => file,
      osLocale: () => 'en-US',
      warn: (msg) => warnings.push(msg),
    });
    assert.equal(s.setUiLocale('de'), true);
    assert.equal(s.current(), 'de');
    assert.equal(warnings.length, 1);
  });

  it('survives a file path that cannot be resolved', () => {
    const s = createShellLocaleStore({
      file: () => {
        throw new Error('userData not available');
      },
      osLocale: () => 'de-DE',
    });
    assert.equal(s.current(), 'de-DE');
    assert.equal(s.setUiLocale('en'), true);
    assert.equal(s.current(), 'en');
  });
});

describe('persistence helpers', () => {
  it('round-trip a valid locale', () => {
    const file = tmpFile();
    assert.equal(writePersistedUiLocale(file, 'de'), true);
    assert.equal(readPersistedUiLocale(file), 'de');
  });

  it('read an absent file as null', () => {
    assert.equal(readPersistedUiLocale(tmpFile()), null);
  });
});

describe('source census — one reader of the OS locale', () => {
  /**
   * Every main-process translator used to call `app.getLocale()` on its own,
   * which is exactly how three of them ended up ignoring the UI language. The
   * store is now the only place allowed to read it.
   *
   * IF THIS GOES RED: build the translator from `shellLocale` instead of
   * reading the OS locale directly. Do NOT add the file to an ignore list.
   */
  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return /\.(ts|js)$/.test(entry.name) ? [full] : [];
    });
  }

  it('finds app.getLocale( only in shellLocale.ts', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => path.basename(file) !== 'shellLocale.ts')
      .filter((file) => fs.readFileSync(file, 'utf8').includes('app.getLocale('))
      .map((file) => path.relative(SRC, file));
    assert.deepEqual(offenders, []);
  });

  it('still finds it in shellLocale.ts', () => {
    assert.ok(fs.readFileSync(path.join(SRC, 'shellLocale.ts'), 'utf8').includes('app.getLocale('));
  });
});

/**
 * The store above is only half the fix: the value has to travel preload →
 * ipcMain → store, and main's translator has to read the store per dialog.
 * None of that runs under node:test (no Electron), so pin it as source.
 */
describe('wiring — the web-ui push reaches every dialog (source contract)', () => {
  const src = (file: string): string => fs.readFileSync(path.join(SRC, file), 'utf8');

  it('carries the value preload → ipcMain → store, and rebuilds the menu on a change', () => {
    assert.match(src('preload.ts'), /setUiLocale: \(locale: string\): void => ipcRenderer\.send\(CH\.uiLocale, locale\)/);
    assert.match(src('ipc.ts'), /ipcMain\.on\(CH\.uiLocale, \(_e, locale: unknown\) => deps\.onUiLocale\(locale\)\)/);
    assert.match(src('main.ts'), /onUiLocale: \(locale\) => \{\s*if \(shellLocale\.setUiLocale\(locale\)\) installApplicationMenu\(menuActions, t\);/);
  });

  it("resolves main's translator per dialog, so a switch reaches the next one", () => {
    assert.match(src('main.ts'), /\bt = \(key, fallback\) => shellLocale\.translator\(\)\(key, fallback\);/);
  });

  it('accepts exactly the locales the web-ui offers, under the bridge name it calls', () => {
    const locales = fs.readFileSync(path.join(WEB_UI, 'i18n', 'locales.ts'), 'utf8');
    const offered = /export const LOCALES = \[([^\]]*)\]/.exec(locales)?.[1]?.match(/'([^']+)'/g)?.map((q) => q.slice(1, -1));
    assert.deepEqual([...(offered ?? [])].sort(), [...SHELL_UI_LOCALES].sort());
    const bridge = fs.readFileSync(path.join(WEB_UI, 'app', '_lib', 'desktopShell.ts'), 'utf8');
    assert.match(bridge, /readonly setUiLocale\?: \(locale: string\) => void;/);
  });
});
