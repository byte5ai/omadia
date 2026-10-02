// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { sanitiseReturnPath } from '../returnPath';

/**
 * /login and /setup are client components, but Next renders them on the
 * server first, where there is no `window`. The helper has to work there and
 * give the answer the browser will give: the OIDC link on /login is part of
 * the server HTML, so a different answer would hydrate a different href.
 */
describe('sanitiseReturnPath without a window', () => {
  it('is safe and deterministic when no window exists (server render of the client page)', () => {
    expect(typeof window).toBe('undefined');
    expect(sanitiseReturnPath('/chat?x=1')).toBe('/chat?x=1');
    expect(sanitiseReturnPath('/chat?thread=42#c')).toBe('/chat?thread=42#c');
    expect(sanitiseReturnPath('/a/../b')).toBe('/b');
    expect(sanitiseReturnPath('/\\evil.example')).toBe('/');
    expect(sanitiseReturnPath('/\t/evil.example')).toBe('/');
    expect(sanitiseReturnPath('/..//evil.example')).toBe('/');
    expect(sanitiseReturnPath('/login?x=1')).toBe('/');
    expect(sanitiseReturnPath(null)).toBe('/');
  });

  it('never leaks the base it parses against', () => {
    for (const input of [
      '/chat',
      '/a/../b',
      '/%2e%2e/x',
      '//evil.example',
      'https://evil.example',
      '/\\evil.example',
      '/login',
      '',
    ]) {
      const out = sanitiseReturnPath(input);
      expect(out.startsWith('/') && !out.startsWith('//'), JSON.stringify(input)).toBe(true);
      expect(out, JSON.stringify(input)).not.toContain('.invalid');
    }
  });
});
