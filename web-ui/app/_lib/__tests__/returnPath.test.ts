import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_RETURN_PATH,
  MAX_RETURN_PATH_LENGTH,
  sanitiseReturnPath,
} from '../returnPath';

/**
 * `?return=` on /login and /setup comes from the URL, so anyone who can send
 * an operator a link chooses it. Whatever it holds, the pages may only ever
 * navigate to a path on their own origin.
 *
 * A `startsWith('/')` check is not enough, because the browser normalises
 * first: the WHATWG URL parser reads `\` as `/` in http(s) URLs and drops
 * TAB/LF/CR before it parses, so `/\evil.example` and `/<TAB>/evil.example` look like
 * paths but load `https://evil.example/`. Dot segments are the other trap:
 * `/..//evil.example` resolves on the right origin, but its normalised path is
 * `//evil.example`, which is protocol-relative again once it is used as a link.
 */

/** Origins the web UI is really served from: dev server, a deployment, the desktop shell. */
const ORIGINS = ['http://localhost:3000', 'https://omadia.example', 'http://127.0.0.1:3300'];

/** Each of these resolves off-origin, runs script, or is not a root-relative path. */
const HOSTILE = [
  '//evil.example',
  '//evil',
  '/\\evil.example',
  '/\\evil',
  '/\\\\evil.example',
  '/\\/evil.example',
  '\\evil.example',
  '\\\\evil.example',
  '\\/evil.example',
  '/\t/evil.example',
  '/\n/evil.example',
  '/\r/evil.example',
  '/\t\\evil.example',
  'https://evil.example/x',
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  'data:text/html,x',
  'evil.example/chat',
  ' /chat',
  '/x\u0000y',
  '/x\u001by',
  '/x\u007fy',
  '/..//evil.example',
  '/.//evil.example',
  '/%2e%2e//evil.example',
  '/a/..//evil.example',
  '/a/%2E%2E//evil.example',
  '/./\\evil.example',
];

/** Values that must come back as a normalised same-origin path. */
const NORMALISED: ReadonlyArray<readonly [string, string]> = [
  ['/a?b#c', '/a?b#c'],
  ['/chat?thread=42#c', '/chat?thread=42#c'],
  ['/', '/'],
  ['/a/../b', '/b'],
  ['/%2e%2e/x', '/x'],
  ['/admin/plugins?tab=a%20b', '/admin/plugins?tab=a%20b'],
  // A percent-encoded backslash is a literal path character, not a separator.
  ['/%5Cevil.example', '/%5Cevil.example'],
  // Past the leading slash a backslash is only a path separator ...
  ['/chat\\x', '/chat/x'],
  // ... and in the query a literal character that `location.search` keeps,
  // so the producers forward it verbatim and it must not bounce to '/'.
  ['/chat?q=a\\b', '/chat?q=a\\b'],
  ['/a b', '/a%20b'],
  ['/chat?', '/chat'],
  ['/@evil.example', '/@evil.example'],
];

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

describe('sanitiseReturnPath', () => {
  it('rejects every form the WHATWG parser would resolve off-origin', () => {
    for (const value of HOSTILE) {
      expect(sanitiseReturnPath(value), JSON.stringify(value)).toBe(DEFAULT_RETURN_PATH);
    }
  });

  it('rejects absolute URLs even on the same origin, non-strings and oversized input', () => {
    for (const value of [
      'http://localhost:3000/chat',
      '',
      null,
      undefined,
      42,
      {},
      ['/chat'],
      `/${'a'.repeat(MAX_RETURN_PATH_LENGTH)}`,
      // Short on the way in, too long once the parser percent-encodes it.
      `/${'　'.repeat(MAX_RETURN_PATH_LENGTH / 2)}`,
    ]) {
      expect(sanitiseReturnPath(value), JSON.stringify(value)).toBe('/');
    }
    // The cap is inclusive.
    const longest = `/${'a'.repeat(MAX_RETURN_PATH_LENGTH - 1)}`;
    expect(sanitiseReturnPath(longest)).toBe(longest);
  });

  it('returns only path + query + fragment, normalised', () => {
    for (const [input, expected] of NORMALISED) {
      expect(sanitiseReturnPath(input), JSON.stringify(input)).toBe(expected);
    }
  });

  it('never returns a value that resolves off-origin', () => {
    const inputs = [
      ...HOSTILE,
      ...NORMALISED.map(([input]) => input),
      '/%2F%2Fevil.example',
      '/%09/evil.example',
      '/.%2e//evil.example',
      '/..\\\\evil.example',
      '/:evil.example',
      '/chat#\\evil.example',
      '/chat?next=//evil.example',
      '/ /evil.example',
      '/　/evil.example',
      '/／/evil.example',
      '/x y',
      '/a\ud800b',
      '/login/',
    ];
    for (const input of inputs) {
      const out = sanitiseReturnPath(input);
      const label = JSON.stringify(input);
      for (const origin of ORIGINS) {
        expect(new URL(out, origin).origin, `${label} on ${origin}`).toBe(origin);
      }
      expect(out.startsWith('/'), label).toBe(true);
      expect(out.startsWith('//'), label).toBe(false);
      expect(out.startsWith('/\\'), label).toBe(false);
      expect(hasControlChar(out), label).toBe(false);
      expect(out, label).not.toContain('.invalid');
      // Sanitising twice changes nothing; the /login -> /setup hop does that.
      expect(sanitiseReturnPath(out), label).toBe(out);
    }
  });

  it('sends the auth pages themselves to /', () => {
    for (const value of [
      '/login',
      '/login?x=1',
      '/login/',
      '/login#a',
      '/setup',
      '/setup#a',
      '/setup?return=%2Fchat',
    ]) {
      expect(sanitiseReturnPath(value), value).toBe('/');
    }
    // Pathname equality, not a prefix match.
    for (const value of ['/login-history', '/setup-guide', '/admin/login']) {
      expect(sanitiseReturnPath(value), value).toBe(value);
    }
  });

  describe('does not depend on window.location', () => {
    const realLocation = window.location;

    afterEach(() => {
      Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    });

    it.each([
      ['the default jsdom location', null],
      ['a stub without an origin', { pathname: '/chat', search: '?thread=42' }],
      ['an opaque origin', { origin: 'null', href: 'about:blank' }],
    ])('gives the same answer under %s', (_name, stub) => {
      if (stub) Object.defineProperty(window, 'location', { configurable: true, value: stub });
      expect(sanitiseReturnPath('/chat?thread=42')).toBe('/chat?thread=42');
      expect(sanitiseReturnPath('/\\evil.example')).toBe('/');
    });
  });
});
