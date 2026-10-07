/**
 * The `Secure` flag on the auth cookies (#1310, docs/security-architecture.md
 * §10o).
 *
 * The defect these lock down: the cookie writers' `secure:` came from
 * `x-forwarded-proto` read straight off the request, so the sender decided
 * whether its own cookies were marked TLS-only — `Secure` on a plain-HTTP
 * login that sent the header, and no `Secure` behind a TLS proxy that did not.
 *
 * Every case drives a REAL express listener over a real plain-HTTP connection,
 * because the property under test is Express's own `trust proxy` evaluation
 * and a hand-built `Request` double cannot exercise it. The reporter's repro
 * is the first case. All three writers the report names are driven, the OIDC
 * PKCE cookie included: they share one helper, and a test per writer is what
 * keeps a future fourth from quietly opting out of it.
 *
 * The second case is the half a hop count cannot express. Express counts
 * trusted hops from the server INCLUDING the immediate peer, so `1` would
 * trust this test's own direct client; naming an address the client does not
 * have is the only setting that refuses the forgery, and `loopback` is how a
 * client that IS the proxy gets believed.
 */

import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';

import express, { type Express } from 'express';

import {
  LOGIN_DEVICE_COOKIE,
  setLoginDeviceCookie,
} from '../../src/auth/loginDeviceCookie.js';
import { SESSION_COOKIE } from '../../src/auth/requireAuth.js';
import { SESSION_WINDOW_S, setSessionCookie } from '../../src/auth/sessionCookie.js';
import {
  parseTrustedProxies,
  PUBLIC_SCHEME_SETTING,
  requestIsSecure,
  type PublicSchemeMode,
  type TrustedProxySetting,
} from '../../src/http/requestTrust.js';

/** `pkceCookieNameFor('entra')` — the shape `routes/auth.ts` writes. */
const PKCE_COOKIE = 'omadia_pkce_entra';

const closers: (() => Promise<void>)[] = [];

after(async () => {
  for (const close of closers) await close();
});

interface AppOptions {
  /** `TRUSTED_PROXY_ADDRESSES`, in its env spelling. */
  readonly trustedProxies?: string;
  /** `PUBLIC_SCHEME`; omitted = the app sets none, i.e. the `auto` default. */
  readonly publicScheme?: PublicSchemeMode;
}

/**
 * The boot wiring of `src/index.ts`: the same `trust proxy` value and the same
 * app setting, so what the login path does to a cookie is what these cases see.
 */
function buildApp(opts: AppOptions = {}): Express {
  const app = express();
  const trusted: TrustedProxySetting = parseTrustedProxies(opts.trustedProxies ?? '');
  app.set('trust proxy', trusted);
  if (opts.publicScheme !== undefined) {
    app.set(PUBLIC_SCHEME_SETTING, opts.publicScheme);
  }
  app.post('/login', (req, res) => {
    setSessionCookie(req, res, 'session-token', SESSION_WINDOW_S);
    setLoginDeviceCookie(req, res, 'v3.device.cookie.value.tag');
    // The OIDC PKCE cookie (`routes/auth.ts`) is written inline there rather
    // than through a helper, so it is reproduced inline here — same attributes,
    // same `requestIsSecure` call, so a drift in either shows up.
    res.cookie(PKCE_COOKIE, 'pending-state', {
      httpOnly: true,
      secure: requestIsSecure(req),
      sameSite: 'lax',
      maxAge: 600_000,
      path: '/',
    });
    res.status(204).end();
  });
  return app;
}

/** POST /login over plain HTTP with `headers`, and the Set-Cookie lines back. */
async function login(
  app: Express,
  headers: Record<string, string> = {},
): Promise<string[]> {
  const server = app.listen(0, '127.0.0.1');
  closers.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${String(port)}/login`, {
    method: 'POST',
    headers,
  });
  assert.equal(res.status, 204, 'precondition: the login route answered');
  return res.headers.getSetCookie();
}

/** The one Set-Cookie line for `name`. */
function cookie(lines: string[], name: string): string {
  const line = lines.find((l) => l.startsWith(`${name}=`));
  assert.ok(line, `expected a Set-Cookie for ${name}, got ${JSON.stringify(lines)}`);
  return line;
}

/** Whether a Set-Cookie line carries the `Secure` attribute. */
function hasSecure(line: string): boolean {
  return line
    .split(';')
    .slice(1)
    .some((attr) => attr.trim().toLowerCase() === 'secure');
}

function assertSecureFlags(lines: string[], expected: boolean): void {
  for (const name of [SESSION_COOKIE, LOGIN_DEVICE_COOKIE, PKCE_COOKIE]) {
    const line = cookie(lines, name);
    assert.equal(
      hasSecure(line),
      expected,
      `${name} should ${expected ? '' : 'NOT '}be Secure: ${line}`,
    );
  }
}

describe('auth cookie Secure — an untrusted hop cannot set it', () => {
  it('a forged x-forwarded-proto on a direct HTTP connection sets no Secure (the #1310 repro)', async () => {
    const lines = await login(buildApp(), { 'x-forwarded-proto': 'https' });

    assertSecureFlags(lines, false);
  });

  it('is unchanged by the header being absent — plain HTTP is plain HTTP either way', async () => {
    const lines = await login(buildApp());

    assertSecureFlags(lines, false);
  });

  it('ignores a multi-valued forged header (`https, http`, the Fly-shaped spelling)', async () => {
    const lines = await login(buildApp(), { 'x-forwarded-proto': 'https, http' });

    assertSecureFlags(lines, false);
  });

  it('still ignores it when a DIFFERENT proxy address is the trusted one', async () => {
    const lines = await login(buildApp({ trustedProxies: '10.1.2.3' }), {
      'x-forwarded-proto': 'https',
    });

    assertSecureFlags(lines, false);
  });

  it('keeps the other attributes the cookies always carried', async () => {
    const lines = await login(buildApp());
    const session = cookie(lines, SESSION_COOKIE);

    assert.match(session, /HttpOnly/i);
    assert.match(session, /SameSite=Lax/i);
    assert.match(session, /Path=\//);
  });
});

describe('auth cookie Secure — a trusted hop can set it', () => {
  it('honours x-forwarded-proto from a proxy the operator named', async () => {
    // The test client connects over loopback, so `loopback` makes it the
    // trusted hop — the shape of a desktop install, where the shell really is
    // the proxy. Its header is believed; the case above shows that naming any
    // other address is not.
    const lines = await login(buildApp({ trustedProxies: 'loopback' }), {
      'x-forwarded-proto': 'https',
    });

    assertSecureFlags(lines, true);
  });

  it('marks nothing Secure when that same trusted hop reports http', async () => {
    const lines = await login(buildApp({ trustedProxies: 'loopback' }), {
      'x-forwarded-proto': 'http',
    });

    assertSecureFlags(lines, false);
  });

  it('accepts a CIDR block, not just a bare address', async () => {
    const lines = await login(buildApp({ trustedProxies: '127.0.0.0/8' }), {
      'x-forwarded-proto': 'https',
    });

    assertSecureFlags(lines, true);
  });
});

describe('PUBLIC_SCHEME — the operator declaration', () => {
  it('`https` marks every auth cookie Secure behind a proxy that sets no header', async () => {
    // The failure mode narrowing `trust proxy` cannot reach: TLS is terminated
    // upstream, the proxy says nothing, and the connection here is plain HTTP.
    const lines = await login(buildApp({ publicScheme: 'https' }));

    assertSecureFlags(lines, true);
  });

  it('`http` marks none of them, even on a header from a trusted hop', async () => {
    const lines = await login(
      buildApp({ trustedProxies: 'loopback', publicScheme: 'http' }),
      { 'x-forwarded-proto': 'https' },
    );

    assertSecureFlags(lines, false);
  });

  it('`auto` is the default an app that sets nothing gets', async () => {
    const explicit = await login(buildApp({ publicScheme: 'auto' }), {
      'x-forwarded-proto': 'https',
    });
    const implicit = await login(buildApp(), { 'x-forwarded-proto': 'https' });

    assertSecureFlags(explicit, false);
    assertSecureFlags(implicit, false);
  });
});
