import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FRAME_ANCESTORS_ENV_KEY,
  applyOperatorUiSecurityHeaders,
  isFramedProxyPath,
  operatorUiSecurityHeaders,
  parseFrameAncestors,
} from '../securityHeaders';

/**
 * The header table and its two inputs: the framed-prefix exemption and the
 * `UI_FRAME_ANCESTORS` override. `proxySecurityHeaders.test.ts` asserts the
 * same behaviour end to end through `proxy()`.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isFramedProxyPath', () => {
  it.each([
    '/p',
    '/p/',
    '/p/demo/ui/index.html',
    '/p/channel-teams/tab-config',
    '/bot-api',
    '/bot-api/v1/auth/login',
    '/bot-api/v1/builder/drafts/1/preview/ui-route/r',
  ])('exempts %s', (path) => {
    expect(isFramedProxyPath(path)).toBe(true);
  });

  it.each([
    '/',
    '/login',
    '/setup',
    '/store/abc',
    '/plugin-ui/demo',
    '/pairing-discovery',
    '/prefs',
    '/bot-apix',
    '/store/p/x',
    '/health',
    '/_next/static/chunk.js',
  ])('does not exempt %s', (path) => {
    expect(isFramedProxyPath(path)).toBe(false);
  });
});

describe('operatorUiSecurityHeaders', () => {
  it('pins the documented env knob name', () => {
    expect(FRAME_ANCESTORS_ENV_KEY).toBe('UI_FRAME_ANCESTORS');
  });

  it('defaults to no framing at all, nosniff and a cross-origin-safe referrer policy', () => {
    expect(operatorUiSecurityHeaders({})).toEqual([
      ['Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'none'"],
      ['X-Frame-Options', 'DENY'],
      ['X-Content-Type-Options', 'nosniff'],
      ['Referrer-Policy', 'strict-origin-when-cross-origin'],
    ]);
  });

  it('never ships a script or style policy (Next renders inline scripts and styles)', () => {
    for (const env of [{}, { UI_FRAME_ANCESTORS: "'self'" }]) {
      const csp = new Map(operatorUiSecurityHeaders(env)).get('Content-Security-Policy') ?? '';
      expect(csp).not.toMatch(/script-src|style-src|default-src/);
    }
  });

  it('uses the override as the frame-ancestors source list and drops X-Frame-Options', () => {
    const headers = new Map(
      operatorUiSecurityHeaders({
        UI_FRAME_ANCESTORS: "  'self'   https://teams.microsoft.com\thttps://*.teams.microsoft.com ",
      }),
    );
    expect(headers.get('Content-Security-Policy')).toBe(
      "frame-ancestors 'self' https://teams.microsoft.com https://*.teams.microsoft.com; object-src 'none'; base-uri 'none'",
    );
    expect(headers.has('X-Frame-Options')).toBe(false);
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });

  it("treats an explicit 'none' like the default and keeps X-Frame-Options DENY", () => {
    expect(operatorUiSecurityHeaders({ UI_FRAME_ANCESTORS: "'NONE'" })).toEqual(
      operatorUiSecurityHeaders({}),
    );
  });

  it('falls back to the default for an invalid override and warns once per value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const env = { UI_FRAME_ANCESTORS: "'self'; script-src *" };
    expect(operatorUiSecurityHeaders(env)).toEqual(operatorUiSecurityHeaders({}));
    operatorUiSecurityHeaders(env);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('UI_FRAME_ANCESTORS');
  });
});

describe('parseFrameAncestors', () => {
  it.each([undefined, '', '   ', "'none'"])('reads %j as the default', (raw) => {
    expect(parseFrameAncestors(raw)).toEqual({ kind: 'default' });
  });

  it.each([
    ["'self'", "'self'"],
    ["'SELF'", "'self'"],
    ['https:', 'https:'],
    ['*', '*'],
    ['https://portal.example.com:8443/tabs/', 'https://portal.example.com:8443/tabs/'],
    ['*.example.com localhost:3000', '*.example.com localhost:3000'],
  ])('accepts %j', (raw, sources) => {
    expect(parseFrameAncestors(raw)).toEqual({ kind: 'custom', sources });
  });

  it.each([
    "'self'; script-src *",
    'https://a.example.com,https://b.example.com',
    "'unsafe-inline'",
    "'none' https://a.example.com",
    'javascript:alert(1)',
    "'self'\r\nX-Injected: 1",
    'https://exa mple.com"',
  ])('rejects %j', (raw) => {
    expect(parseFrameAncestors(raw)).toEqual({ kind: 'invalid', raw });
  });
});

describe('applyOperatorUiSecurityHeaders', () => {
  it('sets the headers on an operator route and returns the same response', () => {
    const res = new Response(null);
    expect(applyOperatorUiSecurityHeaders('/login', res, {})).toBe(res);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('never touches a framed proxy response, even one that already carries its own policy', () => {
    const res = new Response(null, {
      headers: { 'content-security-policy': "frame-ancestors 'self'" },
    });
    applyOperatorUiSecurityHeaders('/p/demo/ui/index.html', res, {});
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
    expect(res.headers.get('x-frame-options')).toBeNull();
  });
});
