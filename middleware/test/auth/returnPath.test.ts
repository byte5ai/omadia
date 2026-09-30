import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import cookieParser from 'cookie-parser';
import express from 'express';

import type { OidcProvider } from '../../src/auth/providers/AuthProvider.js';
import { ProviderRegistry } from '../../src/auth/providerRegistry.js';
import type { UserStore } from '../../src/auth/userStore.js';
import { createAuthRouter } from '../../src/routes/auth.js';
import { listenLoopback } from '../_helpers/listenLoopback.js';

/**
 * The auth router takes a `?return=` path on two routes: the back-compat
 * `GET /login`, which copies it into the web UI's `/login?return=`, and the
 * OIDC `GET /login/:id/start`, which carries it through the IdP round trip
 * and appends it to `publicBaseUrl` on the callback. Both sinks stay on this
 * origin, but the router must not copy a value into a first-party link that
 * a browser would resolve elsewhere: a browser reads `\` as `/` and drops
 * TAB/LF/CR before parsing, so `/\evil.com` and `/<TAB>/evil.com` both load
 * `https://evil.com/`. The web UI re-checks the value (`returnPath.ts`); this
 * pins the server's own check.
 */

const PUBLIC_BASE_URL = 'http://localhost';
const PROVIDER_ID = 'stuboidc';
const PKCE_COOKIE = `harness_auth_pkce_${PROVIDER_ID}`;

/** Dropped: resolves off-origin once a browser parses it, or is not a path. */
const HOSTILE = [
  '//evil.com',
  '/\\evil.com',
  '/\\/evil.com',
  '/\t/evil.com',
  '/\n/evil.com',
  '/\r/evil.com',
  '/x\u0000y',
  '/x\u001by',
  '/x\u007fy',
  'https://evil.com/',
  'javascript:alert(1)',
  'evil.com',
];

/** Kept verbatim. A backslash past the leading slash cannot change the host. */
const ACCEPTED = ['/chat?thread=42', '/admin/providers', '/chat?q=a\\b'];

describe('auth router ?return= handling', () => {
  let server: Server;
  let baseUrl: string;
  const begun: Array<string | null> = [];

  before(async () => {
    const oidc: OidcProvider = {
      id: PROVIDER_ID,
      displayName: 'Stub OIDC',
      kind: 'oidc',
      beginLogin: (input) => {
        begun.push(input.returnPath);
        return Promise.resolve({
          redirectUrl: 'http://idp.invalid/authorize',
          pendingState: JSON.stringify({ returnPath: input.returnPath }),
        });
      },
      handleCallback: () =>
        Promise.resolve({
          outcome: 'success',
          providerUserId: 'sub-1',
          email: 'user@example.com',
          displayName: 'User',
        }),
    };
    const registry = new ProviderRegistry();
    registry.replaceActive([oidc]);
    const userStore = {
      upsertOidcIdentity: () => Promise.resolve({ id: 'row-1' }),
      markLoginNow: () => Promise.resolve(),
    };

    const app = express();
    app.use(cookieParser());
    app.use(
      '/api/v1/auth',
      createAuthRouter({
        registry,
        userStore: userStore as unknown as UserStore,
        signingKey: new TextEncoder().encode('k'.repeat(64)),
        publicBaseUrl: PUBLIC_BASE_URL,
        defaultReturnPath: '/',
        setupAllowed: false,
      }),
    );
    server = await listenLoopback(app);
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function redirectTarget(path: string, cookie?: string): Promise<URL> {
    const res = await fetch(`${baseUrl}${path}`, {
      redirect: 'manual',
      ...(cookie ? { headers: { cookie } } : {}),
    });
    assert.equal(res.status, 302);
    const location = res.headers.get('location');
    assert.ok(location, 'redirect without a Location header');
    return new URL(location);
  }

  async function backCompatReturn(value: string): Promise<string | null> {
    const target = await redirectTarget(
      `/api/v1/auth/login?return=${encodeURIComponent(value)}`,
    );
    assert.equal(target.origin, PUBLIC_BASE_URL);
    assert.equal(target.pathname, '/login');
    return target.searchParams.get('return');
  }

  it('GET /login drops a return value a browser would resolve off-origin', async () => {
    for (const value of HOSTILE) {
      assert.equal(await backCompatReturn(value), null, JSON.stringify(value));
    }
  });

  it('GET /login keeps an ordinary same-origin path', async () => {
    for (const value of ACCEPTED) {
      assert.equal(await backCompatReturn(value), value, JSON.stringify(value));
    }
  });

  it('GET /login/:id/start hands the provider only a safe return path', async () => {
    for (const value of [...HOSTILE, ...ACCEPTED]) {
      begun.length = 0;
      await redirectTarget(
        `/api/v1/auth/login/${PROVIDER_ID}/start?return=${encodeURIComponent(value)}`,
      );
      const expected = ACCEPTED.includes(value) ? value : null;
      assert.deepEqual(begun, [expected], JSON.stringify(value));
    }
  });

  it('the OIDC callback falls back to the default path for a crafted pending state', async () => {
    const callback = (returnPath: string): Promise<URL> =>
      redirectTarget(
        `/api/v1/auth/login/${PROVIDER_ID}/cb?code=x&state=y`,
        `${PKCE_COOKIE}=${Buffer.from(JSON.stringify({ returnPath })).toString('base64url')}`,
      );
    for (const value of HOSTILE) {
      const target = await callback(value);
      assert.equal(target.href, `${PUBLIC_BASE_URL}/`, JSON.stringify(value));
    }
    const kept = await callback('/chat?thread=42');
    assert.equal(kept.href, `${PUBLIC_BASE_URL}/chat?thread=42`);
  });
});
