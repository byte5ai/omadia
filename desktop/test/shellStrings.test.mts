/**
 * Unit tests for the shell dictionary (#935 / OM-59).
 *
 * The bug these pin: the Electron shell — native dialogs, loading screen, menu
 * headings — had no language source at all, so a German user was asked in
 * English whether the program may close and touch their data.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createShellTranslate,
  fillPlaceholders,
  languageOf,
} from '../src/shellStrings.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..', 'src');

// NB: these files are type-STRIPPED by `npm test`, not typechecked. Until #932
// wires `typecheck:test`, run tsc over `test/*.test.mts` by hand when editing.

describe('languageOf', () => {
  it('keeps the language and drops the region', () => {
    assert.equal(languageOf('de-DE'), 'de');
    assert.equal(languageOf('de-AT'), 'de');
    assert.equal(languageOf('de'), 'de');
    assert.equal(languageOf('EN-GB'), 'en');
  });

  it('tolerates a missing or non-string locale', () => {
    assert.equal(languageOf(undefined), '');
    assert.equal(languageOf(''), '');
  });
});

describe('createShellTranslate', () => {
  it('translates a known key into German for any German region', () => {
    for (const locale of ['de', 'de-DE', 'de-AT', 'DE-ch']) {
      const t = createShellTranslate(locale);
      assert.equal(t('menu.file', 'File'), 'Datei', `failed for ${locale}`);
    }
  });

  it('falls back to the English source text for an unknown key', () => {
    const t = createShellTranslate('de');
    assert.equal(t('does.not.exist', 'English source'), 'English source');
  });

  it('returns the English source text for an unsupported locale', () => {
    const t = createShellTranslate('fr-FR');
    assert.equal(t('menu.file', 'File'), 'File');
  });

  it('does not leak inherited Object properties as translations', () => {
    const t = createShellTranslate('de');
    assert.equal(t('constructor', 'English source'), 'English source');
    assert.equal(t('toString', 'English source'), 'English source');
  });

  it('translates every menu heading, so no bar is half German', () => {
    const t = createShellTranslate('de');
    for (const key of ['menu.file', 'menu.edit', 'menu.view', 'menu.window', 'menu.help']) {
      assert.notEqual(t(key, 'UNTRANSLATED'), 'UNTRANSLATED', `${key} is missing`);
    }
  });

  it('translates the boot-failure and superseded dialogs', () => {
    const t = createShellTranslate('de');
    for (const key of [
      'boot.failed.title',
      'boot.failed.detail',
      'boot.failed.rerunSetup',
      'boot.superseded.title',
      'boot.superseded.detail',
    ]) {
      assert.notEqual(t(key, 'UNTRANSLATED'), 'UNTRANSLATED', `${key} is missing`);
    }
  });
});

describe('fillPlaceholders', () => {
  it('substitutes every named placeholder', () => {
    assert.equal(
      fillPlaceholders('{a} then {b}', { a: 'first', b: 'second' }),
      'first then second',
    );
  });

  it('leaves an unknown placeholder literal instead of throwing', () => {
    // These run on error paths. A dictionary that forgets a placeholder must
    // degrade to visible text, never add a second failure to a failing dialog.
    assert.equal(fillPlaceholders('{missing} here', {}), '{missing} here');
  });

  it('interpolates a German template and its English fallback identically', () => {
    const de = createShellTranslate('de');
    const en = createShellTranslate('en');
    const values = { error: 'kaboom', logFile: '/tmp/omadia.log' };
    const fallback = 'Details: {error}\nLog file: {logFile}';
    for (const t of [de, en]) {
      const filled = fillPlaceholders(t('boot.failed.detail', fallback), values);
      assert.match(filled, /kaboom/);
      assert.match(filled, /omadia\.log/);
      assert.doesNotMatch(filled, /\{error\}|\{logFile\}/);
    }
  });

  it('replaces repeated occurrences of the same placeholder', () => {
    assert.equal(fillPlaceholders('{x}-{x}', { x: 'a' }), 'a-a');
  });
});

describe('the new shell dialogs are translated', () => {
  const t = createShellTranslate('de');

  it('translates the exhausted-recovery dialog', () => {
    for (const key of [
      'shell.loadFailed.exhausted.title',
      'shell.loadFailed.exhausted.message',
      'shell.loadFailed.exhausted.detail',
      'shell.loadFailed.exhausted.ok',
    ]) {
      assert.notEqual(t(key, 'UNTRANSLATED'), 'UNTRANSLATED', `${key} is missing`);
    }
  });

  it('translates the refused-restart dialog', () => {
    for (const key of [
      'shell.restartRefused.title',
      'shell.restartRefused.message',
      'shell.restartRefused.detail',
      'shell.restartRefused.ok',
    ]) {
      assert.notEqual(t(key, 'UNTRANSLATED'), 'UNTRANSLATED', `${key} is missing`);
    }
  });

  it('keeps the {logFile} placeholder in the exhausted detail', () => {
    const filled = fillPlaceholders(t('shell.loadFailed.exhausted.detail', '{logFile}'), {
      logFile: '/tmp/omadia-desktop.log',
    });
    assert.match(filled, /omadia-desktop\.log/);
    assert.doesNotMatch(filled, /\{logFile\}/);
  });

  it('promises no automatic reload, in either language', () => {
    // The German for this key once said "omadia versucht, sie neu zu laden"
    // while the code deliberately does not retry, and the English fallback said
    // nothing of the sort. Two variants of one live key must not differ on what
    // the product actually does.
    const german = createShellTranslate('de')('shell.loadFailed.uiGone', 'x');
    assert.doesNotMatch(german, /neu zu laden|lädt sie neu/i);
  });
});

describe('dictionary hygiene — every key is actually used', () => {
  /**
   * A source census, because the orphaned key that review found
   * (`shell.loadFailed.exhausted.quit`, referenced nowhere) slipped precisely
   * because nothing checked. That is the same defect class this PR is cleaning
   * up in the user-facing strings, so it gets a guard rather than another round
   * of manual counting.
   *
   * IF THIS GOES RED: either a key is dead (delete it) or a call site was
   * removed (delete the key). Do NOT add the key to an ignore list.
   */
  function readSourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return readSourceFiles(full);
      return /\.(ts|js)$/.test(entry.name) ? [fs.readFileSync(full, 'utf8')] : [];
    });
  }

  const dictionarySource = fs.readFileSync(path.join(SRC, 'shellStrings.ts'), 'utf8');
  const consumers = readSourceFiles(SRC)
    .filter((text) => text !== dictionarySource)
    .join('\n');
  const keys = [...dictionarySource.matchAll(/^\s{2}'([a-z][\w.]+)':/gim)].map(
    (match) => match[1] as string,
  );

  it('found the dictionary keys to check', () => {
    assert.ok(keys.length > 20, `only found ${keys.length} keys — the parser needs updating`);
  });

  it('has no orphaned keys', () => {
    const orphans = keys.filter((key) => !consumers.includes(`'${key}'`));
    assert.deepEqual(
      orphans,
      [],
      `dictionary keys referenced nowhere in src/: ${orphans.join(', ')}`,
    );
  });
});
