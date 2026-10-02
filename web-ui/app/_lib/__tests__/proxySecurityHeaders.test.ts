import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it } from 'vitest';
import { proxy } from '@/proxy';

/**
 * Operator-UI response headers, asserted on what `proxy()` actually returns.
 *
 * The headers are set per request in the proxy rather than in
 * next.config.ts `headers()`: Next freezes `headers()` into the build, so an
 * operator's `UI_FRAME_ANCESTORS` would do nothing against a published image.
 * The "re-reads UI_FRAME_ANCESTORS on every request" case below pins that.
 *
 * `/p/*` and `/bot-api/*` must come back WITHOUT these headers: Next copies
 * proxy response headers onto the outgoing response before the route handler
 * runs and then refuses to overwrite them, so a header set here would replace
 * the middleware's own `frame-ancestors` on the plugin UI and preview iframes.
 */

const SECURITY_HEADERS = [
  'content-security-policy',
  'x-frame-options',
  'x-content-type-options',
  'referrer-policy',
] as const;

const DEFAULT_CSP = "frame-ancestors 'none'; object-src 'none'; base-uri 'none'";

const savedFrameAncestors = process.env.UI_FRAME_ANCESTORS;

afterEach(() => {
  if (savedFrameAncestors === undefined) delete process.env.UI_FRAME_ANCESTORS;
  else process.env.UI_FRAME_ANCESTORS = savedFrameAncestors;
});

/** Synthetic, unsigned session token — the proxy only decodes `exp`. */
function sessionCookie(): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `omadia_session=${encode({ alg: 'HS256' })}.${encode({ exp })}.sig`;
}

function request(path: string, withSession = false): NextRequest {
  return new NextRequest(`http://web-ui.local${path}`, {
    headers: withSession ? { cookie: sessionCookie() } : {},
  });
}

function expectDefaultHeaders(res: Response): void {
  expect(res.headers.get('content-security-policy')).toBe(DEFAULT_CSP);
  expect(res.headers.get('x-frame-options')).toBe('DENY');
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
}

function expectNoSecurityHeaders(res: Response): void {
  for (const name of SECURITY_HEADERS) {
    expect(res.headers.get(name), name).toBeNull();
  }
}

describe('proxy — operator UI security headers', () => {
  it('sets the default header set on a public operator page (/login)', () => {
    expectDefaultHeaders(proxy(request('/login')));
  });

  it('sets them on a signed-in page render and keeps the x-pathname forwarding', () => {
    const res = proxy(request('/store/abc', true));
    expectDefaultHeaders(res);
    expect(res.headers.get('x-middleware-request-x-pathname')).toBe('/store/abc');
  });

  it('sets them on the redirect to /login when the session is missing', () => {
    const res = proxy(request('/admin/agents'));
    expect(res.status).toBe(302);
    expectDefaultHeaders(res);
  });

  it.each([
    ['/bot-apix', false],
    ['/plugin-ui/demo', true],
    ['/pairing-discovery', false],
    ['/health', false],
  ])('treats %s as an operator route (the exemption is segment-exact)', (path, withSession) => {
    expectDefaultHeaders(proxy(request(path, withSession)));
  });

  it.each([
    ['/p', false],
    ['/p/demo/ui/index.html', false],
    ['/p/channel-teams/hub', false],
    ['/bot-api/v1/auth/login', false],
    ['/bot-api/v1/builder/drafts/1/preview/ui-route/r', true],
    ['/bot-api', true],
  ])('leaves the framed proxy path %s untouched', (path, withSession) => {
    expectNoSecurityHeaders(proxy(request(path, withSession)));
  });

  it('leaves an unauthenticated /bot-api redirect untouched as well', () => {
    const res = proxy(request('/bot-api/v1/operator/agents'));
    expect(res.status).toBe(302);
    expectNoSecurityHeaders(res);
  });

  it('re-reads UI_FRAME_ANCESTORS on every request and drops X-Frame-Options when it is set', () => {
    process.env.UI_FRAME_ANCESTORS = "'self' https://teams.microsoft.com";
    const overridden = proxy(request('/login'));
    expect(overridden.headers.get('content-security-policy')).toBe(
      "frame-ancestors 'self' https://teams.microsoft.com; object-src 'none'; base-uri 'none'",
    );
    expect(overridden.headers.get('x-frame-options')).toBeNull();
    expect(overridden.headers.get('x-content-type-options')).toBe('nosniff');

    delete process.env.UI_FRAME_ANCESTORS;
    expectDefaultHeaders(proxy(request('/login')));
  });

  it('falls back to the default when UI_FRAME_ANCESTORS carries another directive', () => {
    process.env.UI_FRAME_ANCESTORS = "'self'; script-src *";
    expectDefaultHeaders(proxy(request('/login')));
  });
});
