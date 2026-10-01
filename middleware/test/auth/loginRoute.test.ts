/**
 * `POST /api/v1/auth/login/:providerId` under the password sign-in limiter
 * (docs/security-architecture.md §10f), driven through the real auth router
 * with `invoke` (no listening socket). Every case builds its own router and
 * limiter: the suite runs files concurrently and every `invoke` request shares
 * the client key 'unknown' unless it sets a socket address, so a shared limiter
 * would leak budget between cases.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  createLoginDeviceCookies,
  LOGIN_DEVICE_COOKIE,
  LOGIN_DEVICE_TTL_S,
} from '../../src/auth/loginDeviceCookie.js';
import { usersTableEpochs } from '../../src/auth/loginDevices.js';
import { DEFAULT_LOGIN_LIMITER_CONFIG } from '../../src/auth/loginRateLimiter.js';
import type { AuthResult, PasswordProvider } from '../../src/auth/providers/AuthProvider.js';
import { LOCAL_PROVIDER_ID } from '../../src/auth/providers/LocalPasswordProvider.js';
import { invoke } from '../_helpers/httpInvoke.js';
import {
  ADMIN,
  assertBusy,
  assertRateLimited,
  deviceCookieFrom,
  harness,
  json,
  login,
  right,
  SECOND,
  setCookies,
  SIGNING_KEY,
  until,
  wrong,
} from './loginHarness.js';

// ─── cases ─────────────────────────────────────────────────────────────────

describe('POST /login/:id — account layer', () => {
  it('the 6th wrong password for one account from one client answers 429 with Retry-After', async () => {
    const h = await harness();
    for (let i = 0; i < 5; i += 1) {
      const res = await login(h, wrong());
      assert.equal(res.status, 401, `attempt ${String(i + 1)}`);
    }
    for (let i = 5; i < 25; i += 1) assertRateLimited(await login(h, wrong()));
    assert.equal(h.verifies.calls, 5, 'refused attempts never reach argon2');
  });

  it('while blocked, even the correct password is refused without being verified', async () => {
    const h = await harness();
    for (let i = 0; i < 5; i += 1) await login(h, wrong());
    const before = h.verifies.calls;
    assertRateLimited(await login(h, right()));
    assert.equal(h.verifies.calls, before, 'no argon2 run, so no oracle either');
  });

  it('a correct sign-in after the block resets the pair: the next typo is a 401 again', async () => {
    const h = await harness();
    for (let i = 0; i < 5; i += 1) await login(h, wrong());
    assertRateLimited(await login(h, wrong()));
    h.clock.t += SECOND;
    const ok = await login(h, right());
    assert.equal(ok.status, 200);
    assert.equal(json(ok)['ok'], true);
    assert.equal((await login(h, wrong())).status, 401);
  });

  it('account keys are normalised: case and whitespace do not open a new budget', async () => {
    const h = await harness();
    for (const email of [ADMIN, 'ADMIN@example.com', ` ${ADMIN} `, 'Admin@Example.com', ADMIN]) {
      assert.equal((await login(h, wrong(email))).status, 401);
    }
    assertRateLimited(await login(h, wrong(' admin@EXAMPLE.com')));
  });

  it('without a loginLimiter dep the router still limits (the guard cannot be forgotten)', async () => {
    const h = await harness({ unwired: true });
    for (let i = 0; i < 5; i += 1) assert.equal((await login(h, wrong())).status, 401);
    assertRateLimited(await login(h, wrong()));
  });
});

describe('POST /login/:id — client layer and provider lookup', () => {
  // The client layer brakes an address a trusted edge vouched for; the shared
  // TCP peer skips it (loginLockoutDos.test.ts).
  const EDGE = { kind: 'header', name: 'fly-client-ip' } as const;
  const from = { headers: { 'fly-client-ip': '203.0.113.50' } };

  it('unknown-email spam from one client trips the client layer', async () => {
    const h = await harness({ clientAddress: EDGE, config: { clientMaxFailures: 20 } });
    for (let i = 0; i < 20; i += 1) {
      const res = await login(h, wrong(`nobody${String(i)}@example.com`), from);
      assert.equal(res.status, 401);
    }
    const refused = await login(h, wrong('nobody-else@example.com'), from);
    assertRateLimited(refused);
    assert.equal(h.verifies.calls, 20);
  });

  it('an unknown provider stays 404 and consumes no budget', async () => {
    const h = await harness({ clientAddress: EDGE, config: { clientMaxFailures: 3 } });
    for (let i = 0; i < 10; i += 1) {
      const res = await invoke(h.app, 'POST', '/api/v1/auth/login/nope', { json: wrong(), ...from });
      assert.equal(res.status, 404);
    }
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await login(h, wrong(`u${String(i)}@example.com`), from)).status, 401);
    }
    assertRateLimited(await login(h, wrong('u9@example.com'), from));
  });
});

describe('POST /login/:id — client address policy', () => {
  it('xff:1 keys by the right-most X-Forwarded-For entry; a forged left-most entry changes nothing', async () => {
    const h = await harness({ clientAddress: { kind: 'xff', trustedHops: 1 } });
    for (let i = 0; i < 5; i += 1) {
      const forged = `6.6.6.${String(i)}, 203.0.113.1`;
      const res = await login(h, wrong(), { headers: { 'x-forwarded-for': forged } });
      assert.equal(res.status, 401);
    }
    assertRateLimited(
      await login(h, wrong(), { headers: { 'x-forwarded-for': '7.7.7.7, 203.0.113.1' } }),
    );
    const other = await login(h, wrong(), { headers: { 'x-forwarded-for': '203.0.113.2' } });
    assert.equal(other.status, 401, 'a different right-most entry is a different client');
  });

  it('socket ignores X-Forwarded-For entirely', async () => {
    const h = await harness({ clientAddress: { kind: 'socket' } });
    for (let i = 0; i < 5; i += 1) {
      await login(h, wrong(), {
        remoteAddress: '198.51.100.9',
        headers: { 'x-forwarded-for': `203.0.113.${String(i)}` },
      });
    }
    assertRateLimited(
      await login(h, wrong(), {
        remoteAddress: '198.51.100.9',
        headers: { 'x-forwarded-for': '203.0.113.200' },
      }),
    );
    const otherPeer = await login(h, wrong(), { remoteAddress: '198.51.100.10' });
    assert.equal(otherPeer.status, 401);
  });
});

describe('POST /login/:id — lockout-DoS behind a shared client key', () => {
  it('a device cookie from an earlier sign-in keeps the operator out of the attacker’s budget', async () => {
    const h = await harness();
    const shared = { remoteAddress: '10.0.0.5' }; // every browser behind the web-ui proxy
    const ok = await login(h, right(), shared);
    assert.equal(ok.status, 200);
    const device = deviceCookieFrom(ok);
    assert.match(
      setCookies(ok).find((c) => c.startsWith(LOGIN_DEVICE_COOKIE)) ?? '',
      /HttpOnly.*SameSite=Lax|SameSite=Lax.*HttpOnly/i,
    );

    // An attacker behind the same proxy burns the (admin, shared) pair.
    for (let i = 0; i < 5; i += 1) await login(h, wrong(), shared);
    assertRateLimited(await login(h, wrong(), shared));

    // The operator's browser presents its device cookie: its own bucket.
    const back = await login(h, right(), { ...shared, headers: { cookie: device } });
    assert.equal(back.status, 200);
    // And a typo from that device is an honest 401, not the attacker's 429.
    const typo = await login(h, wrong(), { ...shared, headers: { cookie: device } });
    assert.equal(typo.status, 401);
  });

  it('a forged, expired, foreign, stale or old-format device cookie falls back to the address key', async () => {
    const h = await harness();
    const shared = { remoteAddress: '10.0.0.5' };
    for (let i = 0; i < 5; i += 1) await login(h, wrong(), shared);
    assertRateLimited(await login(h, wrong(), shared));

    const epoch = await usersTableEpochs(h.store)(LOCAL_PROVIDER_ID, ADMIN);
    assert.ok(epoch);
    const cookies = createLoginDeviceCookies(SIGNING_KEY);
    const otherKey = createLoginDeviceCookies(new TextEncoder().encode('x'.repeat(64)));
    const nowS = Math.floor(Date.now() / 1000);
    const candidates = [
      `${LOGIN_DEVICE_COOKIE}=v2.forged`,
      `${LOGIN_DEVICE_COOKIE}=${otherKey.mint(`local:${ADMIN}`, epoch)}`,
      `${LOGIN_DEVICE_COOKIE}=${cookies.mint('local:someone-else@example.com', epoch)}`,
      `${LOGIN_DEVICE_COOKIE}=${cookies.mint(`local:${ADMIN}`, epoch, { nowS: nowS - LOGIN_DEVICE_TTL_S - 1 })}`,
      // Minted under credentials the account no longer has (a reset since).
      `${LOGIN_DEVICE_COOKIE}=${cookies.mint(`local:${ADMIN}`, 'an epoch before a password reset')}`,
      // The first format, which was bound to nothing but the account.
      `${LOGIN_DEVICE_COOKIE}=v1.${'A'.repeat(22)}.${String(nowS + 60)}.${'B'.repeat(43)}`,
    ];
    for (const cookie of candidates) {
      assertRateLimited(await login(h, right(), { ...shared, headers: { cookie } }));
    }
    // Control: a genuine cookie under the account's current epoch does get through.
    const genuine = `${LOGIN_DEVICE_COOKIE}=${cookies.mint(`local:${ADMIN}`, epoch)}`;
    assert.equal((await login(h, right(), { ...shared, headers: { cookie: genuine } })).status, 200);
  });

  // What this does NOT show: that the owner gets in. A sender that keeps
  // failing on the same pair renews each wait, so a cookie-less owner who
  // shares the pair stays out while it keeps going (§10f residual risks).
  it('on one pair, each wait stays within the 2-minute cap', async () => {
    const h = await harness();
    for (let i = 0; i < 40; i += 1) {
      const res = await login(h, wrong());
      if (res.status === 429) {
        const retry = Number(json(res)['retry_after_s']);
        assert.ok(retry <= DEFAULT_LOGIN_LIMITER_CONFIG.accountMaxBlockMs / SECOND);
        h.clock.t += retry * SECOND;
      }
    }
  });
});

describe('POST /login/:id — global capacity', () => {
  it('holds at most the unreserved in-flight slots for unknown browsers; the next gets 503 auth.busy', async () => {
    const pending: Array<(r: AuthResult) => void> = [];
    const slow: PasswordProvider = {
      id: LOCAL_PROVIDER_ID,
      displayName: 'slow',
      kind: 'password',
      verify: () =>
        new Promise<AuthResult>((resolve) => {
          pending.push(resolve);
        }),
    };
    const h = await harness({ provider: slow });
    const D = DEFAULT_LOGIN_LIMITER_CONFIG;
    // One slot stays reserved for browsers with a device cookie
    // (loginLockoutDos.test.ts shows one taking it).
    const max = D.globalMaxInFlight - D.globalDeviceReserveInFlight;
    const inFlight = Array.from({ length: max }, (_, i) =>
      login(h, wrong(`p${String(i)}@example.com`), { remoteAddress: `203.0.113.${String(i)}` }),
    );
    await until(() => pending.length === max);

    assertBusy(await login(h, wrong('p9@example.com'), { remoteAddress: '203.0.113.9' }));

    pending.shift()?.({ outcome: 'error', code: 'invalid_credentials', message: 'no' });
    assert.equal((await inFlight[0])?.status, 401);
    const next = login(h, wrong('p9@example.com'), { remoteAddress: '203.0.113.9' });
    await until(() => pending.length === max);
    for (const resolve of pending.splice(0)) {
      resolve({ outcome: 'error', code: 'invalid_credentials', message: 'no' });
    }
    assert.equal((await next).status, 401);
    await Promise.all(inFlight);
  });

  it('a verify that throws still releases its slot', async () => {
    let throwNext = true;
    const flaky: PasswordProvider = {
      id: LOCAL_PROVIDER_ID,
      displayName: 'flaky',
      kind: 'password',
      verify: async () => {
        if (throwNext) throw new Error('database unreachable');
        return { outcome: 'error', code: 'invalid_credentials', message: 'no' };
      },
    };
    const h = await harness({ provider: flaky, config: { globalMaxInFlight: 1 } });
    // Express 5 turns the rejection into a 500 through its default handler.
    assert.equal((await login(h, wrong())).status, 500);
    throwNext = false;
    assert.equal((await login(h, wrong('b@example.com'))).status, 401);
    assert.equal(h.limiter.stats().inFlight, 0);
  });
});

describe('POST /login/:id — observability', () => {
  it('audits the first refusal of an episode, without the account', async () => {
    const h = await harness();
    for (let i = 0; i < 5; i += 1) await login(h, wrong(), { remoteAddress: '203.0.113.7' });
    for (let i = 0; i < 3; i += 1) await login(h, wrong(), { remoteAddress: '203.0.113.7' });
    await new Promise((r) => setImmediate(r));
    assert.equal(h.audit.length, 1, 'one row per episode, not per refused request');
    const row = h.audit[0];
    assert.equal(row?.action, 'auth.login_rate_limited');
    assert.equal(row?.target, 'login-client:203.0.113.7');
    assert.deepEqual(row?.after, { scope: 'account', retry_after_s: 1 });
    assert.ok(!JSON.stringify(row).includes(ADMIN), 'the account never reaches the audit row');
  });
});

describe('POST /setup — shares the capacity gate and hands out a device cookie', () => {
  const setupBody = { email: 'first@example.com', password: 'first-admin-pw', display_name: 'First' };

  it('refuses with 503 auth.busy while every argon2 slot is taken', async () => {
    const h = await harness({ emptyStore: true, config: { globalMaxInFlight: 1 } });
    const release = h.limiter.acquireSlot();
    assert.ok(release);
    const res = await invoke(h.app, 'POST', '/api/v1/auth/setup', { json: setupBody });
    assert.equal(res.status, 503);
    assert.equal(json(res)['code'], 'auth.busy');
    assert.equal(h.store.rows.size, 0, 'nothing was created');
    release();
    const ok = await invoke(h.app, 'POST', '/api/v1/auth/setup', { json: setupBody });
    assert.equal(ok.status, 200);
    const device = setCookies(ok).find((c) => c.startsWith(`${LOGIN_DEVICE_COOKIE}=`));
    assert.ok(device, 'the first admin’s browser is a known device from the start');
    assert.equal(h.limiter.stats().inFlight, 0);
  });
});

describe('configuration is discoverable', () => {
  it('documents every knob in .env.example', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const envExample = readFileSync(join(here, '..', '..', '.env.example'), 'utf8');
    for (const knob of [
      'AUTH_LOGIN_CLIENT_ADDRESS',
      'AUTH_LOGIN_IPV6_PREFIX',
      'AUTH_LOGIN_MAX_INFLIGHT',
    ]) {
      assert.ok(envExample.includes(knob), knob);
    }
  });
});
