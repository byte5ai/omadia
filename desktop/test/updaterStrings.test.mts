/**
 * The updater speaks the user's language (OM-91).
 *
 * OM-59 localized the shell's dialogs, but it reached only `shellDialogs.ts`.
 * `updater.ts` builds its `MessageBoxOptions` inline, so it kept its English
 * literals — a German beta tester was told "omadia X is ready to install" and,
 * worse, was handed English recovery instructions at the one moment an update
 * had failed and the app was sitting in a half-stopped state.
 *
 * Two things are pinned here:
 *
 *   1. A German locale really produces German copy for every updater dialog.
 *   2. No dialog literal is left behind in `updater.ts`. That source scan is
 *      the part that survives: a new dialog added next year fails this test
 *      the moment it is written in English, which is exactly when it is cheap
 *      to fix. Asserting only on the dictionary would go green while the new
 *      dialog shipped untranslated.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createShellTranslate, fillPlaceholders } from '../src/shellStrings.ts';

const UPDATER_SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'updater.ts',
);

const source = fs.readFileSync(UPDATER_SRC, 'utf8');

/** Keys the updater renders, with the placeholders each one must carry. */
const UPDATER_KEYS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['updater.checkFailed.title', []],
  ['updater.checkFailed.message', []],
  ['updater.unreachable.title', []],
  ['updater.unreachable.message', ['count']],
  ['updater.unreachable.detail', ['version', 'releasesUrl', 'error']],
  ['updater.available.title', []],
  ['updater.available.message', ['version']],
  ['updater.available.detail', []],
  ['updater.upToDate.title', []],
  ['updater.upToDate.message', []],
  ['updater.upToDate.detail', ['version']],
  ['updater.installFailed.title', []],
  ['updater.installFailed.message', ['version']],
  ['updater.installFailed.detail', ['attempts', 'current', 'version', 'logFile']],
  ['updater.ready.title', []],
  ['updater.ready.message', ['version']],
  ['updater.ready.detail', []],
  ['updater.ready.restartNow', []],
  ['updater.ready.later', []],
  ['updater.unpackaged.title', []],
  ['updater.unpackaged.message', []],
  ['updater.unpackaged.detail', []],
  ['updater.notApplied.title', []],
  ['updater.notApplied.relaunch', []],
  ['updater.notApplied.uncleanMessage', ['version']],
  ['updater.notApplied.uncleanDetail', ['survivors', 'relaunch', 'logFile']],
  ['updater.notApplied.prepareMessage', ['version']],
  ['updater.notApplied.prepareDetail', ['error', 'relaunch', 'logFile']],
];

const de = createShellTranslate('de-DE');
const en = createShellTranslate('en-GB');

/** A fallback distinctive enough that a missing key cannot pass unnoticed. */
const MISS = '__UNTRANSLATED__';

describe('updater dialog copy (OM-91)', () => {
  it('translates every updater key into German', () => {
    for (const [key] of UPDATER_KEYS) {
      const translated = de(key, MISS);
      assert.notEqual(translated, MISS, `missing German string for ${key}`);
      assert.ok(translated.trim().length > 0, `empty German string for ${key}`);
    }
  });

  it('keeps every placeholder the call site fills', () => {
    // A dictionary entry that drops `{version}` renders a dialog with the
    // version silently missing; one that renames it renders a literal brace.
    for (const [key, placeholders] of UPDATER_KEYS) {
      const translated = de(key, MISS);
      for (const name of placeholders) {
        assert.ok(
          translated.includes(`{${name}}`),
          `German ${key} lost the {${name}} placeholder`,
        );
      }
      const leftover = translated.match(/\{(\w+)\}/g) ?? [];
      assert.equal(
        leftover.length,
        placeholders.length,
        `German ${key} has placeholders the call site does not fill: ${leftover.join(', ')}`,
      );
    }
  });

  it('renders a German install prompt end to end', () => {
    assert.equal(de('updater.ready.title', MISS), 'Update bereit');
    assert.equal(
      fillPlaceholders(de('updater.ready.message', MISS), { version: '0.159.0' }),
      'omadia 0.159.0 kann installiert werden.',
    );
    assert.equal(de('updater.ready.restartNow', MISS), 'Jetzt neu starten');
    assert.equal(de('updater.ready.later', MISS), 'Später');
  });

  it('translates the failure paths, not just the happy one', () => {
    // These are the dialogs the tester actually hit, and the ones where an
    // untranslated string costs the most: the app is down and the text is the
    // only instruction the user has.
    const detail = fillPlaceholders(de('updater.installFailed.detail', MISS), {
      attempts: '3',
      current: '0.158.0',
      version: '0.159.0',
      logFile: '/tmp/omadia.log',
    });
    assert.ok(detail.includes('0.159.0 manuell'), detail);
    assert.ok(!detail.includes('{'), `unfilled placeholder left in: ${detail}`);
    assert.ok(
      de('updater.notApplied.relaunch', MISS).startsWith('Deine Daten'),
    );
  });

  it('falls back to the English source text for an unknown locale', () => {
    // A partial translation must degrade to mixed language, never to an empty
    // dialog — the caller always passes its English text as the fallback.
    assert.equal(en('updater.ready.title', 'Update ready'), 'Update ready');
    assert.equal(de('updater.nope.notAKey', 'Fallback wins'), 'Fallback wins');
  });
});

describe('updater.ts leaves no untranslated dialog copy (OM-91)', () => {
  /**
   * Every `title:` / `message:` / `detail:` in a `MessageBoxOptions` literal
   * has to be a `t(...)` call, a `fillPlaceholders(...)` wrapper around one, a
   * bare identifier holding one, or `String(err)` — a raw error string is data,
   * not copy, and translating it would be a lie.
   */
  const ALLOWED = /^(t\(|fillPlaceholders\(|String\(|title,?$|[a-zA-Z]+,?$)/;

  it('has no hardcoded English title/message/detail', () => {
    const offenders: string[] = [];
    const pattern = /^\s*(title|message|detail):\s*(.*)$/gm;
    for (const match of source.matchAll(pattern)) {
      const [, field, rest] = match;
      if (rest !== undefined && !ALLOWED.test(rest.trim())) {
        offenders.push(`${field ?? '?'}: ${rest.trim()}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `untranslated dialog copy in updater.ts:\n${offenders.join('\n')}`,
    );
  });

  it('has no hardcoded button labels', () => {
    // `buttons: ['Restart now', 'Later']` was the original OM-91 sighting.
    assert.ok(
      !/buttons:\s*\[\s*'/.test(source),
      'updater.ts still has a raw string in a buttons array',
    );
  });
});
