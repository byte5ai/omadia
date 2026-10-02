import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET as pairingDiscovery } from '@/app/pairing-discovery/route';
import { proxy } from '@/proxy';

/**
 * The operator front's login gate (`web-ui/proxy.ts`).
 *
 * Every page and `/bot-api/*` call needs an unexpired `omadia_session`
 * cookie, and `isPublicPath` is the only way past the gate without one. These
 * cases pin that allowlist from both sides:
 *
 *   - The pairing-discovery descriptor is reachable WITHOUT a session. A
 *     desktop client asks for it before it has signed in (the descriptor is
 *     what tells it where to sign in). Next runs the proxy before the
 *     `next.config.ts` rewrite, so the canonical `/.well-known/omadia-ui` and
 *     the handler path it is rewritten to, `/pairing-discovery`, are both
 *     checked.
 *   - Every operator route keeps bouncing to `/login`, and the exemption is
 *     exact-match: a sibling or a longer path does not ride along.
 *
 * Pass-through is asserted the way Next's router reads it:
 * `NextResponse.next()` stamps `x-middleware-next: 1` and sets no `Location`.
 * The session cookie is a hand-made three-segment JWT. The gate decodes `exp`
 * only; verifying the signature is the middleware's `requireAuth`.
 */

const ORIGIN = 'http://web-ui.local';
const SESSION_COOKIE = 'omadia_session';
const LOCAL_PROVIDER = { id: 'local', displayName: 'Local', kind: 'password' };

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** A synthetic session token whose `exp` lies `secondsFromNow` away. */
function sessionToken(secondsFromNow: number): string {
  const exp = Math.floor(Date.now() / 1000) + secondsFromNow;
  return `${base64url({ alg: 'HS512', typ: 'JWT' })}.${base64url({ exp })}.synthetic-signature`;
}

function request(path: string, token?: string): NextRequest {
  return new NextRequest(
    `${ORIGIN}${path}`,
    token === undefined ? undefined : { headers: { cookie: `${SESSION_COOKIE}=${token}` } },
  );
}

function expectPassThrough(res: Response): void {
  expect(res.status).toBe(200);
  expect(res.headers.get('x-middleware-next')).toBe('1');
  expect(res.headers.get('location')).toBeNull();
}

function expectLoginRedirect(res: Response): void {
  expect(res.status).toBe(302);
  expect(res.headers.get('x-middleware-next')).toBeNull();
  expect(res.headers.get('location')).toMatch(/^http:\/\/web-ui\.local\/login\?return=/);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('proxy — pairing discovery needs no session', () => {
  it('GET /.well-known/omadia-ui without a cookie passes the gate', () => {
    const res = proxy(request('/.well-known/omadia-ui'));

    expectPassThrough(res);
    // Public paths short-circuit before the session branch, so no
    // `x-pathname` is forwarded. Only pages read it (authRedirect.ts).
    expect(res.headers.get('x-middleware-request-x-pathname')).toBeNull();
  });

  it('GET /pairing-discovery (the rewrite target) without a cookie passes the gate', () => {
    const res = proxy(request('/pairing-discovery'));

    expectPassThrough(res);
    expect(res.headers.get('x-middleware-request-x-pathname')).toBeNull();
  });

  it.each(['/.well-known/omadia-ui', '/pairing-discovery'])(
    'an expired omadia_session cookie on %s is ignored, not deleted',
    (path) => {
      const res = proxy(request(path, sessionToken(-60)));

      expectPassThrough(res);
      expect(res.headers.get('set-cookie')).toBeNull();
    },
  );

  it('a cookie-less GET /.well-known/omadia-ui on the operator origin gets the JSON descriptor', async () => {
    vi.stubEnv('OMADIA_UI_PUBLIC_WS_URL', undefined);
    vi.stubEnv('OMADIA_UI_INSTANCE_NAME', undefined);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ providers: [LOCAL_PROVIDER] }),
    );
    const req = new NextRequest(`${ORIGIN}/.well-known/omadia-ui`, {
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'ops.example.com' },
    });

    // Both halves of the operator origin, in the order Next runs them: the
    // gate lets the request through, then the rewritten handler answers.
    expectPassThrough(proxy(req));
    const res = await pairingDiscovery(req);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({
      name: 'ops.example.com',
      protocolVersion: '1.0',
      protocolVersions: ['1.0'],
      wsUrl: 'wss://ops.example.com/omadia-ui/canvas',
      auth: {
        mode: 'password',
        providers: [LOCAL_PROVIDER],
        loginStartUrl: 'https://ops.example.com/bot-api/v1/auth',
      },
    });
  });
});

describe('proxy — operator routes stay protected', () => {
  it.each([
    ['/', 'http://web-ui.local/login?return=%2F'],
    ['/admin/agents?tab=1', 'http://web-ui.local/login?return=%2Fadmin%2Fagents%3Ftab%3D1'],
    ['/bot-api/v1/agents', 'http://web-ui.local/login?return=%2Fbot-api%2Fv1%2Fagents'],
    ['/store', 'http://web-ui.local/login?return=%2Fstore'],
  ])('%s without a cookie redirects to /login', (path, location) => {
    const res = proxy(request(path));

    expectLoginRedirect(res);
    expect(res.headers.get('location')).toBe(location);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it.each(['/', '/admin/agents?tab=1', '/bot-api/v1/agents', '/store'])(
    '%s with an expired cookie redirects to /login and clears the cookie',
    (path) => {
      const res = proxy(request(path, sessionToken(-60)));

      expectLoginRedirect(res);
      expect(res.headers.get('set-cookie')).toBe(
        'omadia_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      );
    },
  );

  it('a malformed cookie counts as no session', () => {
    const res = proxy(request('/admin', 'not-a-jwt'));

    expectLoginRedirect(res);
    expect(res.headers.get('set-cookie')).toMatch(/^omadia_session=;/);
  });
});

describe('proxy — the discovery exemption is exact-match, not a prefix', () => {
  it.each([
    '/pairing-discovery/x',
    '/pairing-discoveryx',
    '/.well-known/omadia-ui/x',
    '/.well-known/omadia-uix',
    '/.well-known/other',
  ])('%s without a cookie redirects to /login', (path) => {
    expectLoginRedirect(proxy(request(path)));
  });
});

describe('proxy — existing exemptions keep working', () => {
  it.each([
    '/login',
    '/setup',
    '/bot-api/v1/auth/providers',
    '/_next/webpack-hmr',
    '/health',
    '/favicon.ico',
    '/p/teams-tab/x',
  ])('%s passes without a cookie', (path) => {
    expectPassThrough(proxy(request(path)));
  });

  it('a fresh session passes and carries x-pathname', () => {
    const res = proxy(request('/admin', sessionToken(3600)));

    expectPassThrough(res);
    expect(res.headers.get('x-middleware-request-x-pathname')).toBe('/admin');
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});
