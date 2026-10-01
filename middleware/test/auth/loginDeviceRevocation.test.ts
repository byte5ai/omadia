/**
 * Device cookies of the password sign-in limiter (docs/security-architecture.md
 * §10f) can be neither multiplied nor kept past the account's credentials.
 * Driven through the real auth and admin users routers:
 *
 *  - only a password sign-in mints one; a session alone (GET /me) does not;
 *  - all known browsers of an account share one budget, so more device ids
 *    buy no more guesses and no more of the capacity kept for known browsers;
 *  - a password reset, a disable or a delete through the admin routes makes
 *    every earlier cookie of the account an unknown browser again;
 *  - a sign-in verified against the old password while a reset lands gets a
 *    cookie for the old password only, never one the new password counts.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { LOGIN_DEVICE_COOKIE } from '../../src/auth/loginDeviceCookie.js';
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
  SECOND,
  setCookies,
  SIGNING_KEY,
  until,
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

function deviceCookiesSetBy(res: InvokeResult): string[] {
  return setCookies(res).filter((c) => c.startsWith(`${LOGIN_DEVICE_COOKIE}=`));
}

/** The device id inside a `name=v3.<id>.…` cookie pair. */
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

/** Device cookies of `n` password sign-ins to `email`, a minute apart (capacity drains). */
async function signIns(h: Harness, n: number, email = ADMIN, password?: string): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const res = await login(h, right(email, password), PROXY);
    assert.equal(res.status, 200);
    out.push(deviceCookieFrom(res));
    h.clock.t += 60 * SECOND;
  }
  return out;
}

describe('only a password sign-in makes a known browser', () => {
  it('GET /me sets no device cookie, so a session alone buys no budget', async () => {
    const h = await harness();
    const signedIn = await session(ADMIN, SIGNED_IN_AT);
    for (let i = 0; i < 3; i += 1) {
      const res = await me(h, signedIn);
      assert.equal(res.status, 200);
      assert.deepEqual(deviceCookiesSetBy(res), []);
    }
    for (let i = 0; i < FREE; i += 1) await login(h, wrong(), PROXY);
    assertRateLimited(await login(h, wrong(), { ...PROXY, headers: { cookie: signedIn } }));
  });
});

describe('the known browsers of an account share one budget', () => {
  it('six device ids for one account still get five wrong guesses in all', async () => {
    const h = await harness();
    const cookies = await signIns(h, 6);
    assert.equal(new Set(cookies.map(idOf)).size, 6);

    assert.equal(await admittedGuesses(h, cookies, FREE), FREE);
  });

  it('one account’s device ids cannot take the capacity kept for known browsers', async () => {
    const h = await harness({ config: SMALL_CAPACITY });
    const operator = deviceCookieFrom(await login(h, right(), PROXY));
    await h.store.addLocalUser(FORMER, FORMER_PASSWORD);
    const banked = await signIns(h, 10, FORMER, FORMER_PASSWORD);

    await admittedGuesses(h, banked, 3, FORMER);
    const back = await login(h, right(), { ...PROXY, headers: { cookie: operator } });
    assert.equal(back.status, 200, 'the operator’s browser still finds room');
  });
});

describe('a password reset, a disable or a delete ends earlier device cookies', () => {
  it('after a reset, earlier cookies are only the shared address: no extra guesses', async () => {
    const h = await harness();
    const banked = await signIns(h, 3);

    const reset = await admin(h, 'POST', `/${h.store.idOf(ADMIN)}/reset-password`, {
      password: NEW_PASSWORD,
    });
    assert.equal(reset.status, 200);

    // Without cookies the shared address gets the free budget...
    assert.equal(await admittedGuesses(h, [undefined], 2 * FREE), FREE);
    // ...and the three earlier cookies add nothing to it.
    assert.equal(await admittedGuesses(h, banked, FREE), 0);
  });

  it('a session from before the reset gets no new cookie: only the new password mints one', async () => {
    const h = await harness();
    const signedIn = await session(ADMIN, SIGNED_IN_AT);
    const reset = await admin(h, 'POST', `/${h.store.idOf(ADMIN)}/reset-password`, {
      password: NEW_PASSWORD,
    });
    assert.equal(reset.status, 200);

    assert.deepEqual(deviceCookiesSetBy(await me(h, signedIn)), []);
    const signedInAgain = await login(h, right(ADMIN, NEW_PASSWORD), PROXY);
    assert.equal(signedInAgain.status, 200);
    assert.equal(await admittedGuesses(h, [deviceCookieFrom(signedInAgain)], 2 * FREE), FREE);
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

    // Re-enabling without a reset lets the cookie count again (§10f): it was
    // minted by a sign-in with that same, unchanged password.
    assert.equal((await admin(h, 'PATCH', `/${id}`, { status: 'active' })).status, 200);
    assert.equal(await admittedGuesses(h, [undefined], FREE, FORMER), FREE);
    const known = await login(h, wrong(FORMER), { ...PROXY, headers: { cookie: device } });
    assert.equal(known.status, 401);
  });

  it('cookies of a deleted account are no known browsers', async () => {
    const h = await harness({ config: SMALL_CAPACITY });
    const operator = deviceCookieFrom(await login(h, right(), PROXY));
    await h.store.addLocalUser(FORMER, FORMER_PASSWORD);
    const banked = await signIns(h, 3, FORMER, FORMER_PASSWORD);
    assert.equal((await admin(h, 'DELETE', `/${h.store.idOf(FORMER)}`)).status, 204);

    // They are the shared address now: one budget between all of them.
    assert.equal(await admittedGuesses(h, banked, FREE, FORMER), FREE);
    const back = await login(h, right(), { ...PROXY, headers: { cookie: operator } });
    assert.equal(back.status, 200, 'the operator’s browser still finds room');
  });
});

/**
 * Holds the next users-table read after it has read the row, until `resume`:
 * a sign-in paused between reading the stored hash and comparing it.
 */
function holdNextRead(h: Harness): { isHeld: () => boolean; resume: () => void } {
  const read = h.store.findByEmailWithHash.bind(h.store);
  let held = false;
  let resume: () => void = () => undefined;
  h.store.findByEmailWithHash = async (provider, email) => {
    const row = await read(provider, email);
    if (!held) {
      held = true;
      await new Promise<void>((r) => {
        resume = r;
      });
    }
    return row;
  };
  return { isHeld: () => held, resume: () => resume() };
}

describe('a reset that lands while a sign-in is being verified', () => {
  it('the sign-in that proved the old password gets no cookie the new password counts', async () => {
    const h = await harness();
    const gate = holdNextRead(h);
    const racing = login(h, right(), PROXY);
    await until(gate.isHeld);

    const reset = await admin(h, 'POST', `/${h.store.idOf(ADMIN)}/reset-password`, {
      password: NEW_PASSWORD,
    });
    assert.equal(reset.status, 200);
    gate.resume();
    // It compares against the hash it read: the old password signs in once more.
    const res = await racing;
    assert.equal(res.status, 200);

    // Its device cookie is bound to the password it checked, the old one:
    // once the shared address has spent its budget, the cookie is that
    // address too, no known browser.
    const raced = deviceCookiesSetBy(res).map((c) => c.split(';')[0] ?? '');
    assert.equal(raced.length, 1);
    assert.equal(await admittedGuesses(h, [undefined], 2 * FREE), FREE);
    assertRateLimited(await login(h, wrong(), { ...PROXY, headers: { cookie: raced[0] ?? '' } }));
    // Only a sign-in with the new password makes a known browser.
    h.clock.t += DEFAULT_LOGIN_LIMITER_CONFIG.accountMaxBlockMs;
    const signedIn = await login(h, right(ADMIN, NEW_PASSWORD), PROXY);
    assert.equal(signedIn.status, 200);
    assert.equal(await admittedGuesses(h, [deviceCookieFrom(signedIn)], 2 * FREE), FREE);
  });
});
