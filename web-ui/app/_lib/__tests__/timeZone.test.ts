import path from 'node:path';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  FALLBACK_TIME_ZONE,
  TIME_ZONE_COOKIE,
  isValidTimeZone,
  parseTimeZoneCookie,
  serverFallbackTimeZone,
} from '../timeZone';

/**
 * Issue #1091 — every absolute timestamp in the admin UI rendered in the
 * SERVER's zone (UTC in the shipped container), because `i18n/request.ts`
 * resolved `Intl.DateTimeFormat().resolvedOptions().timeZone` inside the
 * request config, which runs server-side. The operator's browser zone now
 * travels in a cookie; this module is the contract for reading it back.
 *
 * The cookie is attacker-writable in the sense that anything on the client can
 * set it, and its value flows straight into `Intl.DateTimeFormat`, which throws
 * a RangeError on an unknown zone. Server-side that is a 500 on every page, not
 * a formatting glitch — so the parser must never return a value Intl rejects.
 */
describe('#1091 — time-zone cookie contract', () => {
  it('names a non-secret cookie the client can write', () => {
    expect(TIME_ZONE_COOKIE).toBe('omadia-tz');
  });

  it('falls back to a fixed literal, never to the host zone', () => {
    // Deliberately NOT resolvedOptions().timeZone: that is the bug.
    expect(FALLBACK_TIME_ZONE).toBe('UTC');
  });

  it('returns a valid IANA zone unchanged', () => {
    expect(parseTimeZoneCookie('Europe/Berlin')).toBe('Europe/Berlin');
    expect(parseTimeZoneCookie('America/Argentina/Buenos_Aires')).toBe(
      'America/Argentina/Buenos_Aires',
    );
    expect(parseTimeZoneCookie('UTC')).toBe('UTC');
    expect(parseTimeZoneCookie('Etc/GMT+5')).toBe('Etc/GMT+5');
  });

  it('decodes a percent-encoded value', () => {
    // `document.cookie` writers encodeURIComponent the value, so the slash
    // arrives as %2F.
    expect(parseTimeZoneCookie('Europe%2FBerlin')).toBe('Europe/Berlin');
  });

  it('falls back when the cookie is absent or empty', () => {
    expect(parseTimeZoneCookie(undefined)).toBe(FALLBACK_TIME_ZONE);
    expect(parseTimeZoneCookie('')).toBe(FALLBACK_TIME_ZONE);
  });

  it.each([
    ['unknown zone', 'Mars/Olympus_Mons'],
    ['locale tag, not a zone', 'de-DE'],
    ['markup', 'Europe/Berlin<script>'],
    ['whitespace injection', 'Europe/Berlin Europe/Paris'],
    ['malformed percent escape', '%E0%A4%A'],
    ['overlong value', `Europe/${'a'.repeat(200)}`],
    ['newline', 'Europe/Berlin\nX'],
  ])('falls back on %s', (_label, raw) => {
    expect(parseTimeZoneCookie(raw)).toBe(FALLBACK_TIME_ZONE);
  });

  it('never returns a value Intl.DateTimeFormat rejects', () => {
    const inputs = [
      undefined,
      '',
      'Europe/Berlin',
      'Europe%2FBerlin',
      'Mars/Olympus_Mons',
      '%%%',
      'a'.repeat(500),
      '../../etc/passwd',
    ];
    for (const raw of inputs) {
      const zone = parseTimeZoneCookie(raw);
      expect(() => new Intl.DateTimeFormat('en', { timeZone: zone })).not.toThrow();
    }
  });

  it('accepts a caller-supplied fallback', () => {
    expect(parseTimeZoneCookie(undefined, 'Europe/Berlin')).toBe('Europe/Berlin');
    expect(parseTimeZoneCookie('Mars/Olympus_Mons', 'Europe/Berlin')).toBe(
      'Europe/Berlin',
    );
  });

  it('refuses an invalid caller-supplied fallback', () => {
    // The fallback reaches Intl too — a bad one would 500 every page just as a
    // bad cookie would.
    expect(parseTimeZoneCookie(undefined, 'Mars/Olympus_Mons')).toBe(
      FALLBACK_TIME_ZONE,
    );
  });

  it('validates zones without throwing on junk', () => {
    expect(isValidTimeZone('Europe/Berlin')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

/**
 * A deliberately configured container zone is not the #1091 bug. #1091 is about
 * PREFERRING the host zone over the operator's; a self-hoster who runs the image
 * with `TZ=Europe/Berlin` has stated a better guess than UTC for the requests
 * where no browser has spoken yet (first visit, blocked cookies, e2e runs).
 * Nothing in the repo sets TZ, so an explicit value is always operator intent.
 */
describe('#1091 — container TZ as the cookie-less fallback', () => {
  it('honours an explicitly configured TZ', () => {
    expect(serverFallbackTimeZone({ TZ: 'Europe/Berlin' })).toBe('Europe/Berlin');
  });

  it('falls back to UTC when TZ is unset or empty', () => {
    expect(serverFallbackTimeZone({})).toBe(FALLBACK_TIME_ZONE);
    expect(serverFallbackTimeZone({ TZ: '' })).toBe(FALLBACK_TIME_ZONE);
    expect(serverFallbackTimeZone({ TZ: undefined })).toBe(FALLBACK_TIME_ZONE);
  });

  it('refuses a TZ this runtime cannot format in', () => {
    expect(serverFallbackTimeZone({ TZ: 'Mars/Olympus_Mons' })).toBe(
      FALLBACK_TIME_ZONE,
    );
    expect(serverFallbackTimeZone({ TZ: ':/etc/localtime' })).toBe(
      FALLBACK_TIME_ZONE,
    );
  });
});

/**
 * The regression this guards is a single expression in a single file. #821 put
 * it there to silence next-intl's ENVIRONMENT_FALLBACK IntlError (one per
 * rendered table row on /admin/datasets) — so the fix is NOT to drop the
 * `timeZone` key, and both halves need pinning: the host zone must stay gone,
 * and the key must stay present.
 */
describe('#1091 — i18n/request.ts does not resolve the host zone', () => {
  const source = readFileSync(
    path.resolve(__dirname, '../../../i18n/request.ts'),
    'utf8',
  );

  // Comments explaining WHY the call was removed must not count as the call
  // coming back, and — the other direction — must not satisfy the check that
  // the key is still set. Same stripping as `i18n-structural.test.ts`.
  const code = source
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');

  it('never reads the zone off resolvedOptions()', () => {
    // Matched on `resolvedOptions()` alone, not on `.timeZone` after it: the
    // narrower form is evaded by `const o = …resolvedOptions(); o.timeZone`.
    expect(code).not.toMatch(/resolvedOptions\(/);
  });

  it('never calls the browser-zone helper', () => {
    // `resolveBrowserTimeZone()` is the same expression behind a name, and it
    // lives in a module this file already imports from — `timeZone:
    // resolveBrowserTimeZone()` would reinstate #1091 verbatim while the
    // regex above stayed green.
    expect(code).not.toContain('resolveBrowserTimeZone');
  });

  it('still sets an explicit timeZone key (the #821 IntlError guard)', () => {
    // Deliberately anchored to a KEY in the returned object. A bare /timeZone/
    // over the whole file passes on the parameter name and on the prose above
    // it — so it stays green while the key itself is gone, which is precisely
    // the regression this is here to catch.
    expect(code).toMatch(/^\s*timeZone[,:]/m);
  });

  it('sources the zone from the cookie contract', () => {
    expect(code).toContain('TIME_ZONE_COOKIE');
    expect(code).toContain('parseTimeZoneCookie');
  });

  it('seeds the cookie-less fallback from the container TZ', () => {
    expect(code).toContain('serverFallbackTimeZone');
  });
});
