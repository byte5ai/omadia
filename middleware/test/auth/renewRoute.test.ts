import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, it } from 'node:test';

import cookieParser from 'cookie-parser';
import express from 'express';
import { SignJWT } from 'jose';

import type { AuditEntryInput } from '../../src/auth/adminAuditLog.js';
import type {
  OidcProvider,
  SessionRevalidation,
} from '../../src/auth/providers/AuthProvider.js';
import { LocalPasswordProvider } from '../../src/auth/providers/LocalPasswordProvider.js';
import { ProviderRegistry } from '../../src/auth/providerRegistry.js';
import { signSession, verifySession } from '../../src/auth/sessionJwt.js';
import type { UserRecord, UserStore } from '../../src/auth/userStore.js';
import { EmailWhitelist } from '../../src/auth/whitelist.js';
import { createAuthRouter } from '../../src/routes/auth.js';
import { listenLoopback } from '../_helpers/listenLoopback.js';

/**
 * #965 — `POST /api/v1/auth/renew` ("I'm still here"). Drives the real
 * router over real Express + fetch. Every refusal path must answer without
 * a `Set-Cookie`; the happy path must carry `auth_time` over, extend `exp`
 * and write exactly one audit row BEFORE the cookie.
 */

const KEY = new TextEncoder().encode('k'.repeat(64));
const HOUR = 60 * 60;
const CAP_S = 12 * HOUR;

const LOCAL_SUB = 'admin@example.com';
const ENTRA_SUB = 'aad-oid-1';
const ENTRA_EMAIL = 'entra@example.com';

function nowS(): number {
  return Math.floor(Date.now() / 1000);
}

function user(overrides: Partial<UserRecord>): UserRecord {
  const now = new Date();
  return {
    id: 'row-uuid-local',
    email: LOCAL_SUB,
    provider: 'local',
    providerUserId: LOCAL_SUB,
    displayName: 'Admin',
    role: 'admin',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
    ...overrides,
  };
}

class InMemoryUserStore {
  rows: UserRecord[] = [
    user({}),
    user({
      id: 'row-uuid-entra',
      email: ENTRA_EMAIL,
      provider: 'entra',
      providerUserId: ENTRA_SUB,
    }),
    user({
      id: 'row-uuid-plain',
      email: 'plain@example.com',
      provider: 'plainoidc',
      providerUserId: 'plain-sub',
    }),
  ];

  async count(): Promise<number> {
    return this.rows.length;
  }

  async findByProviderUserId(provider: string, sub: string): Promise<UserRecord | null> {
    return this.rows.find((r) => r.provider === provider && r.providerUserId === sub) ?? null;
  }
}

function stubOidc(
  id: string,
  revalidate: SessionRevalidation | 'missing',
): OidcProvider {
  const base: OidcProvider = {
    id,
    displayName: id,
    kind: 'oidc',
    beginLogin: () => Promise.resolve({ redirectUrl: 'http://idp', pendingState: '{}' }),
    handleCallback: () =>
      Promise.resolve({ outcome: 'error', code: 'idp_error', message: 'stub' }),
  };
  if (revalidate === 'missing') return base;
  return { ...base, revalidateSession: () => Promise.resolve(revalidate) };
}

interface Harness {
  baseUrl: string;
  audits: AuditEntryInput[];
  forgotten: string[];
  store: InMemoryUserStore;
}

interface HarnessOpts {
  withRenewal?: boolean;
  auditThrows?: boolean;
  entraVerdict?: SessionRevalidation | 'missing';
  activeProviders?: readonly string[];
}

let servers: Server[] = [];

afterEach(async () => {
  const open = servers;
  servers = [];
  await Promise.all(
    open.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

async function start(opts: HarnessOpts = {}): Promise<Harness> {
  const store = new InMemoryUserStore();
  const audits: AuditEntryInput[] = [];
  const forgotten: string[] = [];
  const all = [
    new LocalPasswordProvider(store as unknown as UserStore),
    stubOidc('entra', opts.entraVerdict ?? { outcome: 'ok' }),
    stubOidc('plainoidc', 'missing'),
  ];
  const active = opts.activeProviders ?? all.map((p) => p.id);
  const registry = new ProviderRegistry();
  registry.replaceActive(all.filter((p) => active.includes(p.id)));

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/v1/auth',
    createAuthRouter({
      registry,
      userStore: store as unknown as UserStore,
      signingKey: KEY,
      publicBaseUrl: 'http://localhost',
      defaultReturnPath: '/',
      setupAllowed: false,
      ...(opts.withRenewal === false
        ? {}
        : {
            renewal: {
              whitelist: new EmailWhitelist(ENTRA_EMAIL),
              audit: {
                record: async (entry: AuditEntryInput) => {
                  if (opts.auditThrows) throw new Error('audit db down');
                  audits.push(entry);
                },
              },
              refreshStore: {
                forget: async (email: string) => {
                  forgotten.push(email);
                },
              },
              maxLifetimeSeconds: CAP_S,
            },
          }),
    }),
  );
  const server = await listenLoopback(app);
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { baseUrl: `http://127.0.0.1:${port}`, audits, forgotten, store };
}

async function localToken(opts: { authTime?: number; exp?: number } = {}): Promise<string> {
  return signSession(
    {
      sub: LOCAL_SUB,
      email: LOCAL_SUB,
      display_name: 'Admin',
      role: 'admin',
      provider: 'local',
      omadia_user_id: 'omadia-user-1',
      ...(opts.authTime !== undefined ? { auth_time: opts.authTime } : {}),
    },
    KEY,
    opts.exp ?? '4h',
  );
}

async function oidcToken(provider: string, sub: string, email: string): Promise<string> {
  return signSession(
    { sub, email, display_name: 'X', role: 'admin', provider },
    KEY,
    '4h',
  );
}

/** A token as minted before #965: no `auth_time` claim at all. */
async function legacyToken(iat: number, exp: number): Promise<string> {
  return new SignJWT({
    sub: LOCAL_SUB,
    email: LOCAL_SUB,
    display_name: 'Admin',
    role: 'admin',
    provider: 'local',
  })
    .setProtectedHeader({ alg: 'HS512' })
    .setIssuer('omadia')
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(KEY);
}

async function renew(h: Harness, token?: string): Promise<Response> {
  return fetch(`${h.baseUrl}/api/v1/auth/renew`, {
    method: 'POST',
    headers: token ? { cookie: `omadia_session=${token}` } : {},
  });
}

function cookieToken(res: Response): string | null {
  const raw = res.headers.get('set-cookie');
  const match = raw?.match(/omadia_session=([^;]+)/);
  return match?.[1] ?? null;
}

async function expectRefusal(res: Response, status: number, code: string): Promise<void> {
  const body = (await res.json()) as { code?: string };
  assert.equal(res.status, status, JSON.stringify(body));
  assert.equal(body.code, code);
  assert.equal(res.headers.get('set-cookie'), null, 'a refusal must not set a cookie');
}

describe('POST /api/v1/auth/renew (#965)', () => {
  it('renews a valid local session: same auth_time, later exp, one audit row', async () => {
    const h = await start();
    const authTime = nowS() - 3 * HOUR;
    const oldToken = await localToken({ authTime, exp: nowS() + 4 * 60 });
    const old = await verifySession(oldToken, KEY);
    const res = await renew(h, oldToken);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, number>;

    const token = cookieToken(res);
    assert.ok(token, 'renewal must set a fresh session cookie');
    const renewed = await verifySession(token, KEY);
    assert.equal(renewed.auth_time, authTime, 'auth_time is carried over');
    assert.ok(renewed.exp > old.exp, 'exp moves forward');
    assert.ok(Math.abs(renewed.exp - (nowS() + 4 * HOUR)) <= 2);
    assert.equal(renewed.omadia_user_id, 'omadia-user-1', 'claims are re-signed as-is');
    assert.equal(renewed.sub, LOCAL_SUB);

    assert.equal(body['expires_at'], renewed.exp);
    assert.equal(typeof body['server_now'], 'number');
    assert.equal(body['renewable_until'], authTime + CAP_S);

    assert.equal(h.audits.length, 1);
    assert.equal(h.audits[0]?.action, 'auth.session_renew');
    assert.equal(h.audits[0]?.actor.id, 'row-uuid-local', 'actor.id is the users-row uuid (#775)');
    assert.equal(h.audits[0]?.target, 'user:row-uuid-local');
  });

  it('refuses without a cookie (auth.missing) and with an expired one (auth.invalid)', async () => {
    const h = await start();
    await expectRefusal(await renew(h), 401, 'auth.missing');
    const expired = await legacyToken(nowS() - 5 * HOUR, nowS() - HOUR);
    await expectRefusal(await renew(h, expired), 401, 'auth.invalid');
    assert.equal(h.audits.length, 0);
  });

  it('refuses past the absolute cap measured from auth_time', async () => {
    const h = await start();
    const token = await localToken({ authTime: nowS() - 13 * HOUR, exp: nowS() + HOUR });
    await expectRefusal(await renew(h, token), 401, 'auth.renew_expired');
    assert.equal(h.audits.length, 0);
  });

  it('refuses when the window is already clamped at the cap (no gain)', async () => {
    const h = await start();
    const authTime = nowS() - 10 * HOUR;
    const token = await localToken({ authTime, exp: authTime + CAP_S });
    await expectRefusal(await renew(h, token), 401, 'auth.renew_expired');
  });

  it('clamps the renewed exp to auth_time + cap', async () => {
    const h = await start();
    const authTime = nowS() - 9 * HOUR;
    const res = await renew(h, await localToken({ authTime, exp: nowS() + 60 }));
    assert.equal(res.status, 200);
    const renewed = await verifySession(cookieToken(res) ?? '', KEY);
    assert.equal(renewed.exp, authTime + CAP_S);
  });

  it('treats iat as auth_time for a legacy token without the claim', async () => {
    const h = await start();
    const stale = await legacyToken(nowS() - 13 * HOUR, nowS() + HOUR);
    await expectRefusal(await renew(h, stale), 401, 'auth.renew_expired');

    const iat = nowS() - HOUR;
    const res = await renew(h, await legacyToken(iat, iat + 4 * HOUR));
    assert.equal(res.status, 200);
    const renewed = await verifySession(cookieToken(res) ?? '', KEY);
    assert.equal(renewed.auth_time, iat, 'the old iat becomes the carried auth_time');
  });

  it('applies the whitelist gate (403 auth.not_whitelisted)', async () => {
    const h = await start();
    const token = await oidcToken('entra', ENTRA_SUB, 'gone@example.com');
    await expectRefusal(await renew(h, token), 403, 'auth.not_whitelisted');
  });

  it('refuses a disabled or missing users row (auth.renew_denied)', async () => {
    const h = await start();
    const row = h.store.rows[0];
    assert.ok(row);
    h.store.rows[0] = { ...row, status: 'disabled' };
    await expectRefusal(await renew(h, await localToken()), 401, 'auth.renew_denied');
    h.store.rows.splice(0, 1);
    await expectRefusal(await renew(h, await localToken()), 401, 'auth.renew_denied');
    assert.equal(h.audits.length, 0);
  });

  it('refuses when the session provider is no longer active', async () => {
    const h = await start({ activeProviders: ['entra'] });
    await expectRefusal(await renew(h, await localToken()), 401, 'auth.renew_denied');
  });

  it('asks the IdP for OIDC sessions and fails closed', async () => {
    const entra = (): Promise<string> => oidcToken('entra', ENTRA_SUB, ENTRA_EMAIL);

    const denied = await start({ entraVerdict: { outcome: 'denied', message: 'invalid_grant' } });
    await expectRefusal(await renew(denied, await entra()), 401, 'auth.renew_denied');
    assert.equal(denied.audits.length, 0);

    const down = await start({ entraVerdict: { outcome: 'unavailable', message: '503' } });
    await expectRefusal(await renew(down, await entra()), 502, 'auth.renew_idp_unavailable');

    const ok = await start({ entraVerdict: { outcome: 'ok' } });
    const res = await renew(ok, await entra());
    assert.equal(res.status, 200);
    assert.ok(cookieToken(res));
    assert.equal(ok.audits[0]?.actor.id, 'row-uuid-entra');
  });

  it('refuses an OIDC provider that cannot re-validate', async () => {
    const h = await start();
    const token = await oidcToken('plainoidc', 'plain-sub', 'plain@example.com');
    await expectRefusal(await renew(h, token), 401, 'auth.renew_denied');
  });

  it('answers 500 without a cookie when the audit write fails', async () => {
    const h = await start({ auditThrows: true });
    const res = await renew(h, await localToken());
    assert.equal(res.status, 500);
    assert.equal(res.headers.get('set-cookie'), null);
  });

  it('answers 503 auth.renew_unavailable when renewal is not wired', async () => {
    const h = await start({ withRenewal: false });
    await expectRefusal(await renew(h, await localToken()), 503, 'auth.renew_unavailable');
  });
});

describe('GET /me and POST /logout — renewal wiring (#965)', () => {
  it('/me reports renewable_until = auth_time + cap', async () => {
    const h = await start();
    const authTime = nowS() - 2 * HOUR;
    const res = await fetch(`${h.baseUrl}/api/v1/auth/me`, {
      headers: { cookie: `omadia_session=${await localToken({ authTime })}` },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body['renewable_until'], authTime + CAP_S);
  });

  it('/me reports renewable_until = null when renewal is not wired', async () => {
    const h = await start({ withRenewal: false });
    const res = await fetch(`${h.baseUrl}/api/v1/auth/me`, {
      headers: { cookie: `omadia_session=${await localToken()}` },
    });
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body['renewable_until'], null);
  });

  it('/logout forgets the Entra refresh token, not for local sessions', async () => {
    const h = await start();
    const logout = async (token: string): Promise<void> => {
      const res = await fetch(`${h.baseUrl}/api/v1/auth/logout`, {
        method: 'POST',
        headers: { cookie: `omadia_session=${token}` },
      });
      assert.equal(res.status, 200);
    };
    await logout(await localToken());
    assert.deepEqual(h.forgotten, []);
    await logout(await oidcToken('entra', ENTRA_SUB, ENTRA_EMAIL));
    assert.deepEqual(h.forgotten, [ENTRA_EMAIL]);
  });
});
