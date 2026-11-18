import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';

import cookieParser from 'cookie-parser';
import express from 'express';
import { SignJWT } from 'jose';

import { createOperatorAuthAccessor } from '../../src/auth/operatorAuthAccessor.js';
import {
  createRequireAuth,
  evaluateSessionToken,
  SESSION_COOKIE,
} from '../../src/auth/requireAuth.js';
import { signSession } from '../../src/auth/sessionJwt.js';
import {
  accountVouchesFor,
  SessionRevocationGuard,
  type RevokedPrincipal,
  type SessionAccount,
  type SessionAccountSource,
} from '../../src/auth/sessionRevocation.js';
import { EmailWhitelist } from '../../src/auth/whitelist.js';
import { listenLoopback } from '../_helpers/listenLoopback.js';

/**
 * Server-side session revocation: the guard and the one verdict path every
 * consumer shares (`evaluateSessionToken` → `requireAuth`, `ctx.operatorAuth`).
 * A signature-valid cookie is refused once its `users` row is gone, disabled,
 * replaced, or has moved its `session_version` past the token's `sv` — and a
 * failed lookup is an outage (503 / `false`), never a verdict on the cookie.
 */

const KEY = new TextEncoder().encode('r'.repeat(64));
const WHITELIST = new EmailWhitelist('entra@example.com');
const SUB = 'admin@example.com';
const ROW_ID = 'row-uuid-1';
/** When the fixture rows were created: long before any session in here. */
const ROW_CREATED = new Date(Date.now() - 30 * 24 * 3600 * 1000);

class AccountRows implements SessionAccountSource {
  readonly rows = new Map<string, SessionAccount>();
  lookups = 0;
  failWith: Error | undefined;

  put(provider: string, sub: string, account: SessionAccount): void {
    this.rows.set(`${provider}:${sub}`, account);
  }

  async findByProviderUserId(provider: string, sub: string): Promise<SessionAccount | null> {
    this.lookups += 1;
    if (this.failWith) throw this.failWith;
    return this.rows.get(`${provider}:${sub}`) ?? null;
  }
}

function account(overrides: Partial<SessionAccount> = {}): SessionAccount {
  return { id: ROW_ID, status: 'active', sessionVersion: 0, createdAt: ROW_CREATED, ...overrides };
}

async function token(claims: { sv?: number; uid?: string; provider?: string } = {}): Promise<string> {
  return signSession(
    {
      sub: SUB,
      email: SUB,
      display_name: 'Admin',
      role: 'admin',
      provider: claims.provider ?? 'local',
      ...(claims.sv !== undefined ? { sv: claims.sv } : {}),
      uid: claims.uid ?? ROW_ID,
    },
    KEY,
    '4h',
  );
}

/**
 * A token as minted before the revocation claims existed: no sv/sid/uid, and
 * signed in `signedInAgoS` seconds ago (also its `auth_time`).
 */
async function legacyToken(signedInAgoS = 0): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: SUB, email: SUB, display_name: 'Admin', role: 'admin', provider: 'local' })
    .setProtectedHeader({ alg: 'HS512' })
    .setIssuer('omadia')
    .setIssuedAt(now - signedInAgoS)
    .setExpirationTime(now + 3600)
    .sign(KEY);
}

function guardOver(rows: AccountRows): SessionRevocationGuard {
  const guard = new SessionRevocationGuard(() => undefined);
  guard.attach(rows);
  return guard;
}

let servers: Server[] = [];

afterEach(async () => {
  const open = servers;
  servers = [];
  await Promise.all(open.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

/** `/api/ping` behind the real `requireAuth`, wired with `sessions`. */
async function gatedApp(guard: SessionRevocationGuard): Promise<string> {
  const app = express();
  app.use(cookieParser());
  app.use('/api', createRequireAuth({ signingKey: KEY, whitelist: WHITELIST, sessions: guard }));
  app.get('/api/ping', (req, res) => {
    res.json({ sub: req.session?.sub });
  });
  const server = await listenLoopback(app);
  servers.push(server);
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

async function ping(base: string, cookie: string): Promise<{ status: number; code?: string }> {
  const res = await fetch(`${base}/api/ping`, {
    headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
  });
  const body = (await res.json()) as { code?: string };
  return { status: res.status, ...(body.code ? { code: body.code } : {}) };
}

describe('accountVouchesFor', () => {
  const SIGNED_IN = 1_790_000_000; // epoch s
  const at = (epochS: number): Date => new Date(epochS * 1000);
  const session = { provider: 'local', sub: SUB, sv: 2, uid: ROW_ID, auth_time: SIGNED_IN };

  it('vouches only for an existing, active, same-row account at the same version', () => {
    assert.equal(accountVouchesFor(account({ sessionVersion: 2 }), session), true);
    assert.equal(accountVouchesFor(null, session), false, 'deleted');
    assert.equal(
      accountVouchesFor(account({ sessionVersion: 2, status: 'disabled' }), session),
      false,
      'disabled',
    );
    assert.equal(accountVouchesFor(account({ sessionVersion: 3 }), session), false, 'bumped');
    assert.equal(
      accountVouchesFor(account({ sessionVersion: 2, id: 'row-uuid-new' }), session),
      false,
      're-created row',
    );
  });

  it('binds a token with uid by id alone, whenever its row was created', () => {
    const later = account({ sessionVersion: 2, createdAt: at(SIGNED_IN + 3600) });
    assert.equal(accountVouchesFor(later, session), true);
  });

  it('binds a token without uid to the row that existed when it signed in', () => {
    const legacy = { provider: 'local', sub: SUB, sv: 0, auth_time: SIGNED_IN };
    assert.equal(accountVouchesFor(account({ createdAt: at(SIGNED_IN - 86_400) }), legacy), true);
    // `auth_time` is whole seconds: a row created within the sign-in's second
    // (the setup wizard, an OIDC first sign-in) is still that sign-in's row.
    assert.equal(
      accountVouchesFor(account({ createdAt: new Date(SIGNED_IN * 1000 + 999) }), legacy),
      true,
    );
    // Created in a later second: deleted and re-created after the sign-in,
    // back at version 0 like the old cookie, and still not its row.
    assert.equal(accountVouchesFor(account({ createdAt: at(SIGNED_IN + 1) }), legacy), false);
    assert.equal(
      accountVouchesFor(account({ createdAt: new Date(Number.NaN) }), legacy),
      false,
      'an unreadable creation time refuses',
    );
    // Its version is checked all the same.
    assert.equal(accountVouchesFor(account({ sessionVersion: 1 }), legacy), false);
  });
});

describe('evaluateSessionToken — revocation', () => {
  it('without `sessions` the verdict stays signature-only (existing harnesses)', async () => {
    // No account exists anywhere and sv is arbitrary: without a guard nothing
    // but the signature, the expiry and the whitelist gate decide.
    const result = await evaluateSessionToken(await token({ sv: 5 }), {
      signingKey: KEY,
      whitelist: WHITELIST,
    });
    assert.equal(result.ok, true);
  });

  it('an unattached guard (no users table) passes a signature-valid session', async () => {
    const guard = new SessionRevocationGuard(() => undefined);
    assert.equal(guard.isAttached, false);
    const result = await evaluateSessionToken(await token({ sv: 5 }), {
      signingKey: KEY,
      whitelist: WHITELIST,
      sessions: guard,
    });
    assert.equal(result.ok, true);
  });

  it('never consults the store for a token that fails the signature', async () => {
    const rows = new AccountRows();
    const result = await evaluateSessionToken('not-a-jwt', {
      signingKey: KEY,
      whitelist: WHITELIST,
      sessions: guardOver(rows),
    });
    assert.deepEqual(result.ok ? 'ok' : result.code, 'auth.invalid');
    assert.equal(rows.lookups, 0);
  });

  it('reports a failed lookup as auth.unavailable, not as an invalid cookie', async () => {
    const rows = new AccountRows();
    rows.failWith = new Error('connection terminated');
    const logged: string[] = [];
    const guard = new SessionRevocationGuard((line) => logged.push(line));
    guard.attach(rows);
    assert.equal(
      await guard.check({ provider: 'local', sub: SUB, sv: 0, auth_time: 0 }),
      'unavailable',
    );
    const result = await evaluateSessionToken(await token(), {
      signingKey: KEY,
      whitelist: WHITELIST,
      sessions: guard,
    });
    assert.equal(result.ok ? 'ok' : result.code, 'auth.unavailable');
    assert.equal(logged.length, 2);
    assert.match(logged[0] ?? '', /provider=local/);
    assert.doesNotMatch(logged[0] ?? '', /admin@example\.com/, 'never log the sub');
  });

  it('treats a check implementation that throws as an outage as well', async () => {
    const result = await evaluateSessionToken(await token(), {
      signingKey: KEY,
      whitelist: WHITELIST,
      sessions: {
        check: () => Promise.reject(new Error('boom')),
      },
    });
    assert.equal(result.ok ? 'ok' : result.code, 'auth.unavailable');
  });
});

describe('requireAuth — a revoked session is refused on the next request', () => {
  it('answers 200 while the row vouches for the session', async () => {
    const rows = new AccountRows();
    rows.put('local', SUB, account());
    const base = await gatedApp(guardOver(rows));
    assert.deepEqual(await ping(base, await token({ sv: 0 })), { status: 200 });
  });

  it('refuses a session whose row is gone (401 auth.revoked)', async () => {
    const base = await gatedApp(guardOver(new AccountRows()));
    assert.deepEqual(await ping(base, await token()), { status: 401, code: 'auth.revoked' });
  });

  it('refuses a disabled account immediately, not at its next renewal', async () => {
    const rows = new AccountRows();
    rows.put('local', SUB, account({ status: 'disabled' }));
    const base = await gatedApp(guardOver(rows));
    assert.deepEqual(await ping(base, await token()), { status: 401, code: 'auth.revoked' });
  });

  it('refuses a token whose sv is behind the row (sign-out / password reset)', async () => {
    const rows = new AccountRows();
    rows.put('local', SUB, account({ sessionVersion: 1 }));
    const base = await gatedApp(guardOver(rows));
    assert.deepEqual(await ping(base, await token({ sv: 0 })), {
      status: 401,
      code: 'auth.revoked',
    });
    assert.deepEqual(await ping(base, await token({ sv: 1 })), { status: 200 });
  });

  it('refuses a token minted for an earlier row under the same identity', async () => {
    const rows = new AccountRows();
    // Deleted and re-created: new id, version back at 0 — same sv as the old cookie.
    rows.put('local', SUB, account({ id: 'row-uuid-recreated' }));
    const base = await gatedApp(guardOver(rows));
    assert.deepEqual(await ping(base, await token({ sv: 0, uid: ROW_ID })), {
      status: 401,
      code: 'auth.revoked',
    });
  });

  it('accepts a legacy token (no sv) at version 0 and refuses it after a bump', async () => {
    const rows = new AccountRows();
    rows.put('local', SUB, account());
    const base = await gatedApp(guardOver(rows));
    const legacy = await legacyToken();
    assert.deepEqual(await ping(base, legacy), { status: 200 });
    rows.put('local', SUB, account({ sessionVersion: 1 }));
    assert.deepEqual(await ping(base, legacy), { status: 401, code: 'auth.revoked' });
  });

  it('refuses a legacy token (no uid) once its row was deleted and re-created', async () => {
    const rows = new AccountRows();
    rows.put('local', SUB, account());
    const base = await gatedApp(guardOver(rows));
    const legacy = await legacyToken(3600); // signed in an hour ago
    assert.deepEqual(await ping(base, legacy), { status: 200 });
    // Deleted and re-created just now: a new row back at version 0, the
    // version the legacy token claims, but created after its sign-in.
    rows.put('local', SUB, account({ id: 'row-uuid-recreated', createdAt: new Date() }));
    assert.deepEqual(await ping(base, legacy), { status: 401, code: 'auth.revoked' });
  });

  it('answers 503 auth.unavailable when the account cannot be read', async () => {
    const rows = new AccountRows();
    rows.failWith = new Error('pool exhausted');
    const base = await gatedApp(guardOver(rows));
    assert.deepEqual(await ping(base, await token()), {
      status: 503,
      code: 'auth.unavailable',
    });
  });

  it('keeps the whitelist gate ahead of the store (403, no lookup)', async () => {
    const rows = new AccountRows();
    const base = await gatedApp(guardOver(rows));
    const res = await fetch(`${base}/api/ping`, {
      headers: {
        cookie: `${SESSION_COOKIE}=${await signSession(
          { sub: 'oid-1', email: 'gone@example.com', display_name: 'X', role: 'admin', provider: 'entra' },
          KEY,
        )}`,
      },
    });
    assert.equal(res.status, 403);
    assert.equal(rows.lookups, 0);
  });
});

describe('ctx.operatorAuth — plugin admin surfaces inherit the revocation', () => {
  it('flips hasValidSession to false once the version moves on', async () => {
    const rows = new AccountRows();
    rows.put('local', SUB, account());
    const accessor = createOperatorAuthAccessor({
      signingKey: KEY,
      whitelist: WHITELIST,
      sessions: guardOver(rows),
    });
    const header = `${SESSION_COOKIE}=${await token({ sv: 0 })}`;
    assert.equal(await accessor.hasValidSession(header), true);
    rows.put('local', SUB, account({ sessionVersion: 1 }));
    assert.equal(await accessor.hasValidSession(header), false);
  });

  it('resolves false — never throws — when the lookup fails', async () => {
    const rows = new AccountRows();
    rows.failWith = new Error('db down');
    const accessor = createOperatorAuthAccessor({
      signingKey: KEY,
      whitelist: WHITELIST,
      sessions: guardOver(rows),
    });
    assert.equal(await accessor.hasValidSession(`${SESSION_COOKIE}=${await token()}`), false);
    const throwing = createOperatorAuthAccessor({
      signingKey: KEY,
      whitelist: WHITELIST,
      sessions: { check: () => Promise.reject(new Error('boom')) },
    });
    assert.equal(await throwing.hasValidSession(`${SESSION_COOKIE}=${await token()}`), false);
  });
});

describe('SessionRevocationGuard — announcements', () => {
  it('delivers announce() to every listener until it unsubscribes', () => {
    const guard = new SessionRevocationGuard(() => undefined);
    const heard: RevokedPrincipal[] = [];
    const stop = guard.onRevoked((who) => heard.push(who));
    guard.announce({ provider: 'local', sub: SUB });
    stop();
    guard.announce({ provider: 'local', sub: 'other@example.com' });
    assert.deepEqual(heard, [{ provider: 'local', sub: SUB }]);
  });

  it('keeps notifying the rest when one listener throws, and logs it', () => {
    const logged: string[] = [];
    const guard = new SessionRevocationGuard((line) => logged.push(line));
    const heard: string[] = [];
    guard.onRevoked(() => {
      throw new Error('listener broke');
    });
    guard.onRevoked((who) => heard.push(who.sub));
    assert.doesNotThrow(() => guard.announce({ provider: 'entra', sub: 'oid-1' }));
    assert.deepEqual(heard, ['oid-1']);
    assert.match(logged.join('\n'), /listener threw: listener broke/);
  });
});
