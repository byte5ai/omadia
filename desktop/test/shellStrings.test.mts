/**
 * Unit tests for the shell dictionary (#935 / OM-59).
 *
 * The bug these pin: the Electron shell — native dialogs, loading screen, menu
 * headings — had no language source at all, so a German user was asked in
 * English whether the program may close and touch their data.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  createShellTranslate,
  fillPlaceholders,
  languageOf,
} from '../src/shellStrings.ts';

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
