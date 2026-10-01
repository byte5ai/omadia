/**
 * Device cookies of the password sign-in limiter (docs/security-architecture.md
 * §10f) can be neither multiplied nor kept past the account's credentials.
 * Driven through the real auth and admin users routers:
 *
 *  - GET /me hands out ONE device id per sign-in, however often it runs;
 *  - all known browsers of an account share one budget, so more device ids
 *    buy no more guesses and no more of the capacity kept for known browsers;
 *  - a password reset, a disable or a delete through the admin routes makes
 *    every earlier cookie of the account an unknown browser again.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { DEFAULT_LOGIN_LIMITER_CONFIG } from '../../src/auth/loginRateLimiter.js';
import { LOCAL_PROVIDER_ID } from '../../src/auth/providers/LocalPasswordProvider.js';
import { signSession } from '../../src/auth/sessionJwt.js';
import { invoke, type InvokeResult } from '../_helpers/httpInvoke.js';
import {
  ADMIN,
  admin,
  assertRateLimited,
  deviceCookieFrom,
  harness,
  login,
  right,
  setCookies,
  SIGNING_KEY,
  wrong,
  type Harness,
  type RequestExtras,
} from './loginHarness.js';

/** The web-ui container, as the middleware sees every browser behind it. */
const PROXY: RequestExtras = { remoteAddress: '10.0.0.5' };
const FORMER = 'former@example.com';
const FORMER_PASSWORD = 'a password that once worked';
const NEW_PASSWORD = 'the new password after the reset';
const FREE = DEFAULT_LOGIN_LIMITER_CONFIG.accountFreeFailures;
/** A sign-in time (epoch seconds) for forged session cookies. */
const SIGNED_IN_AT = 1_790_000_000;
/** Ten admitted attempts a minute, four of them only for known browsers. */
const SMALL_CAPACITY = { globalMaxPerMinute: 10, globalDeviceReservePerMinute: 4 };

/** A session cookie pair for `email`, signed in at `authTime`. */
async function session(email: string, authTime: number): Promise<string> {
  const token = await signSession(
    {
      sub: email,
      email,
      display_name: email,
      role: 'admin',
      provider: LOCAL_PROVIDER_ID,
      auth_time: authTime,
    },
    SIGNING_KEY,
  );
  return `omadia_session=${token}`;
}

function me(h: Harness, cookie: string): Promise<InvokeResult> {
  return invoke(h.app, 'GET', '/api/v1/auth/me', { headers: { cookie } });
}

/** `n` calls of GET /me with a session and no device cookie: the device cookies they set. */
async function harvest(h: Harness, sessionCookie: string, n: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const res = await me(h, sessionCookie);
    assert.equal(res.status, 200);
    out.push(deviceCookieFrom(res));
  }
  return out;
}

/** The device id inside a `name=v2.<id>.…` cookie pair. */
function idOf(cookie: string): string {
  return cookie.slice(cookie.indexOf('=') + 1).split('.')[1] ?? '';
}

/** `perCookie` wrong passwords per cookie (undefined: none) from the shared address; how many got a 401. */
async function admittedGuesses(
  h: Harness,
  cookies: ReadonlyArray<string | undefined>,
  perCookie: number,
  email = ADMIN,
): Promise<number> {
  let admitted = 0;
  for (const cookie of cookies) {
    for (let i = 0; i < perCookie; i += 1) {
      const res = await login(h, wrong(email), {
        ...PROXY,
        ...(cookie ? { headers: { cookie } } : {}),
      });
      if (res.status === 401) admitted += 1;
    }
  }
  return admitted;
}

/** Device cookies of ten different sign-ins of `email`, each through GET /me. */
async function tenSignIns(h: Harness, email: string): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    out.push(...(await harvest(h, await session(email, SIGNED_IN_AT + i), 1)));
  }
  return out;
}

describe('GET /me — one device id per sign-in', () => {
  it('twenty calls with one session hand out one id; another sign-in gets another', async () => {
    const h = await harness();
    const ids = new Set((await harvest(h, await session(ADMIN, SIGNED_IN_AT), 20)).map(idOf));
    assert.equal(ids.size, 1, 'every /me of one sign-in hands out the same device id');
    const later = await harvest(h, await session(ADMIN, SIGNED_IN_AT + 60), 1);
    assert.equal(ids.has(idOf(later[0] ?? '')), false, 'a new sign-in is a new device id');
  });
});

describe('the known browsers of an account share one budget', () => {
  it('six device ids for one account still get five wrong guesses in all', async () => {
    const h = await harness();
    const cookies: string[] = [];
    for (let i = 0; i < 5; i += 1) cookies.push(deviceCookieFrom(await login(h, right(), PROXY)));
    cookies.push(...(await harvest(h, await session(ADMIN, SIGNED_IN_AT), 1)));
    assert.equal(new Set(cookies.map(idOf)).size, 6);

    assert.equal(await admittedGuesses(h, cookies, FREE), FREE);
  });

  it('one account’s device ids cannot take the capacity kept for known browsers', async () => {
    const h = await harness({ config: SMALL_CAPACITY });
    const operator = deviceCookieFrom(await login(h, right(), PROXY));
    await h.store.addLocalUser(FORMER, FORMER_PASSWORD);
    const banked = await tenSignIns(h, FORMER);

    await admittedGuesses(h, banked, 3, FORMER);
    const back = await login(h, right(), { ...PROXY, headers: { cookie: operator } });
    assert.equal(back.status, 200, 'the operator’s browser still finds room');
  });
});

describe('a password reset, a disable or a delete ends earlier device cookies', () => {
  it('after a reset, banked cookies are only the shared address: no extra guesses', async () => {
    const h = await harness();
    const banked = await harvest(h, await session(ADMIN, SIGNED_IN_AT), 20);
    banked.push(deviceCookieFrom(await login(h, right(), PROXY)));

    const reset = await admin(h, 'POST', `/${h.store.idOf(ADMIN)}/reset-password`, {
      password: NEW_PASSWORD,
    });
    assert.equal(reset.status, 200);

    // Without cookies the shared address gets the free budget...
    assert.equal(await admittedGuesses(h, [undefined], 2 * FREE), FREE);
    // ...and 21 banked cookies add nothing to it.
    assert.equal(await admittedGuesses(h, banked, FREE), 0);
  });

  it('a session that outlives the reset is one known browser again: one budget, not twenty', async () => {
    const h = await harness();
    const signedIn = await session(ADMIN, SIGNED_IN_AT);
    await harvest(h, signedIn, 20);
    const reset = await admin(h, 'POST', `/${h.store.idOf(ADMIN)}/reset-password`, {
      password: NEW_PASSWORD,
    });
    assert.equal(reset.status, 200);

    const again = await harvest(h, signedIn, 20);
    assert.equal(new Set(again.map(idOf)).size, 1);
    assert.equal(await admittedGuesses(h, again, FREE), FREE);
  });

  it('a disabled account’s cookies do not count while it stays disabled', async () => {
    const h = await harness();
    await h.store.addLocalUser(FORMER, FORMER_PASSWORD);
    const device = deviceCookieFrom(await login(h, right(FORMER, FORMER_PASSWORD), PROXY));
    const id = h.store.idOf(FORMER);
    assert.equal((await admin(h, 'PATCH', `/${id}`, { status: 'disabled' })).status, 200);

    // The shared address spends the account's free budget...
    assert.equal(await admittedGuesses(h, [undefined], FREE, FORMER), FREE);
    // ...and the cookie is that address now: refused, not a budget of its own.
    assertRateLimited(await login(h, wrong(FORMER), { ...PROXY, headers: { cookie: device } }));
    // GET /me hands a disabled account's session no device cookie either.
    const signedIn = await me(h, await session(FORMER, SIGNED_IN_AT));
    assert.equal(signedIn.status, 200);
    assert.deepEqual(setCookies(signedIn), []);

    // Re-enabling without a reset lets the cookie count again (§10f).
    assert.equal((await admin(h, 'PATCH', `/${id}`, { status: 'active' })).status, 200);
    assert.equal(await admittedGuesses(h, [undefined], FREE, FORMER), FREE);
    const known = await login(h, wrong(FORMER), { ...PROXY, headers: { cookie: device } });
    assert.equal(known.status, 401);
  });

  it('cookies of a deleted account are no known browsers and cannot take their capacity', async () => {
    const h = await harness({ config: SMALL_CAPACITY });
    const operator = deviceCookieFrom(await login(h, right(), PROXY));
    await h.store.addLocalUser(FORMER, FORMER_PASSWORD);
    const banked = await tenSignIns(h, FORMER);
    const signedIn = await session(FORMER, SIGNED_IN_AT);
    assert.equal((await admin(h, 'DELETE', `/${h.store.idOf(FORMER)}`)).status, 204);

    for (const cookie of banked) {
      await login(h, wrong(FORMER), { ...PROXY, headers: { cookie } });
    }
    const back = await login(h, right(), { ...PROXY, headers: { cookie: operator } });
    assert.equal(back.status, 200, 'the operator’s browser still finds room');
    assert.deepEqual(setCookies(await me(h, signedIn)), [], 'and /me mints nothing for it');
  });
});
