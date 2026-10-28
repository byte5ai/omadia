import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

import deMessages from '../../../messages/de.json';
import enMessages from '../../../messages/en.json';
import { packageErrorText, storeErrorText, UPLOAD_ERRORS } from '../packageErrorText';

/**
 * #1401 — the Hub upload showed the middleware's German rejection text in the
 * English UI ("Version 0.3.3 von … ist bereits hochgeladen."). Known codes are
 * now rendered from the catalog with the `params` the server sends.
 */

function tFor(locale: 'en' | 'de') {
  const t = createTranslator({
    locale,
    messages: (locale === 'en' ? enMessages : deMessages) as Record<string, unknown>,
    namespace: 'store.upload.errors',
  });
  return (key: string, values?: Record<string, string>): string =>
    (t as unknown as (k: string, v?: Record<string, string>) => string)(key, values);
}

const GERMAN =
  'Version 0.3.3 von @omadia/integration-confluence ist bereits hochgeladen. Version anheben oder DELETE aufrufen.';
const PARAMS = { pluginId: '@omadia/integration-confluence', version: '0.3.3' };

describe('packageErrorText', () => {
  it('renders duplicate_version in English for the English UI', () => {
    expect(packageErrorText('package.duplicate_version', PARAMS, GERMAN, tFor('en'))).toBe(
      'Version 0.3.3 of @omadia/integration-confluence is already uploaded. Bump the version, or remove the uploaded package on its Store page first.',
    );
  });

  it('renders it in German for the German UI', () => {
    expect(packageErrorText('package.duplicate_version', PARAMS, GERMAN, tFor('de'))).toContain(
      'ist bereits hochgeladen',
    );
  });

  it('renders param-less codes', () => {
    expect(packageErrorText('package.manifest_missing', undefined, 'x', tFor('en'))).toBe(
      'No manifest.yaml found at the root of the zip.',
    );
  });

  it('keeps the server message when params are missing (older server)', () => {
    expect(packageErrorText('package.duplicate_version', undefined, GERMAN, tFor('en'))).toBe(
      GERMAN,
    );
    expect(
      packageErrorText('package.duplicate_version', { pluginId: 'x' }, GERMAN, tFor('en')),
    ).toBe(GERMAN);
  });

  it('keeps the server message for an unmapped code', () => {
    expect(packageErrorText('zip.mystery', undefined, 'server text', tFor('en'))).toBe(
      'server text',
    );
  });
});

describe('#1488 — zip refusals in the operator locale', () => {
  it('names the offending entry of a path escape', () => {
    expect(
      packageErrorText('zip.path_escape', { entry: '../evil.txt' }, 'x', tFor('en')),
    ).toBe(
      'The archive contains an entry that points outside the package: ../evil.txt. Rebuild the package without it.',
    );
    expect(
      packageErrorText('zip.path_escape', { entry: '../evil.txt' }, 'x', tFor('de')),
    ).toContain('../evil.txt');
  });
});

describe('storeErrorText (#1477) — one text for drawer, update and upload', () => {
  function tRootFor(locale: 'en' | 'de') {
    const t = createTranslator({
      locale,
      messages: (locale === 'en' ? enMessages : deMessages) as Record<string, unknown>,
    });
    return (key: string): string => (t as unknown as (k: string) => string)(key);
  }

  it('renders a Hub-install duplicate_version in English, not the German server text', () => {
    expect(
      storeErrorText(
        { code: 'package.duplicate_version', message: GERMAN, params: PARAMS },
        'fallback',
        tFor('en'),
        tRootFor('en'),
      ),
    ).toMatch(/^Version 0\.3\.3 of @omadia\/integration-confluence is already uploaded/);
  });

  it('falls back to the error-help catalogue for install codes', () => {
    expect(
      storeErrorText(
        { code: 'install.wrong_state', message: "job is in state 'failed'" },
        'fallback',
        tFor('en'),
        tRootFor('en'),
      ),
    ).toBe(
      `${enMessages.errorHelp.install.wrong_state.what} ${enMessages.errorHelp.install.wrong_state.next}`,
    );
  });

  it('keeps the server message for a code nobody explains, then the fallback', () => {
    expect(storeErrorText({ code: 'x.y', message: 'srv' }, 'fb', tFor('en'), tRootFor('en'))).toBe('srv');
    expect(storeErrorText(null, 'fb', tFor('en'), tRootFor('en'))).toBe('fb');
  });
});

describe('UPLOAD_ERRORS stays in step with the server', () => {
  // The params each code needs are hand-mirrored from the middleware. A
  // renamed param there would silently fall back to the server text, so the
  // server source is scanned: every code must be emitted, and every param
  // name the client requires must appear in the object literal that follows.
  const sources = [
    '../../../../middleware/src/plugins/packageUploadService.ts',
    '../../../../middleware/src/routes/packages.ts',
    '../../../../middleware/src/plugins/zipExtractor.ts',
  ].map((rel) => readFileSync(path.resolve(__dirname, rel), 'utf-8'));

  for (const [code, [, needed]] of Object.entries(UPLOAD_ERRORS)) {
    it(`${code} is emitted with ${needed.join(', ') || 'no params'}`, () => {
      const needle = code.startsWith('upload.') ? "'LIMIT_FILE_SIZE'" : `'${code}'`;
      const source = sources.find((s) => s.includes(needle));
      expect(source, `${code} not found in the server source`).toBeDefined();
      const at = (source as string).lastIndexOf(needle);
      const window = (source as string).slice(at, at + 900);
      for (const name of needed) expect(window, `${code} → ${name}`).toMatch(new RegExp(`\\b${name}:`));
    });
  }

  it('has a catalog entry for every mapped code in both locales', () => {
    for (const messages of [enMessages, deMessages]) {
      const errors = messages.store.upload.errors as Record<string, string>;
      for (const [key] of Object.values(UPLOAD_ERRORS)) expect(errors[key], key).toBeTruthy();
    }
  });
});
