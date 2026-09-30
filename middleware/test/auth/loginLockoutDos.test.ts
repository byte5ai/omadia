/**
 * Lockout-DoS through the password sign-in limiter
 * (docs/security-architecture.md §10f): what one sender can and cannot do to
 * everybody else, driven through the real auth router.
 *
 *  - Behind the web-ui proxy every browser reaches the middleware from one
 *    TCP peer (`socket`, the default). That shared key is not braked as one
 *    client, so a sender cannot exhaust it for the rest.
 *  - The global capacity keeps a reserve for browsers with a device cookie,
 *    so no number of client keys (IPv6 /64s included) can drain it for them.
 *  - GET /me hands a signed-in browser its device cookie, so browsers that
 *    were signed in before the limiter shipped are known devices too.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { LOGIN_DEVICE_COOKIE } from '../../src/auth/loginDeviceCookie.js';
import { LOCAL_PROVIDER_ID } from '../../src/auth/providers/LocalPasswordProvider.js';
import { signSession } from '../../src/auth/sessionJwt.js';
import { invoke, type InvokeResult } from '../_helpers/httpInvoke.js';
import {
  ADMIN,
  assertBusy,
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
const OTHER_USER = 'colleague@example.com';
const OTHER_PASSWORD = 'a different long passphrase';

/** Wrong passwords for fresh unknown accounts until one is refused; returns the refusal. */
async function sprayUntilRefused(
  h: Harness,
  extra: (i: number) => RequestExtras,
  limit = 60,
): Promise<InvokeResult> {
  for (let i = 0; i < limit; i += 1) {
    const res = await login(h, wrong(`nobody${String(i)}@example.com`), extra(i));
    if (res.status !== 401) return res;
  }
  assert.fail(`no refusal within ${String(limit)} attempts`);
}

function meWith(h: Harness, cookie: string): Promise<InvokeResult> {
  return invoke(h.app, 'GET', '/api/v1/auth/me', { headers: { cookie } });
}

function sessionFor(provider: string, email: string): Promise<string> {
  return signSession(
    { sub: email, email, display_name: email, role: 'admin', provider },
    SIGNING_KEY,
  );
}

describe('a shared TCP peer (every browser behind the web-ui proxy)', () => {
  it('one sender exhausting it cannot stop other users with the right password', async () => {
    // A small client burst, so the old behaviour (the shared address braked
    // as one client) would lock everyone out after three failures.
    const h = await harness({ config: { clientMaxFailures: 3 } });
    await h.store.addLocalUser(OTHER_USER, OTHER_PASSWORD);

    for (let i = 0; i < 6; i += 1) {
      await login(h, wrong(`nobody${String(i)}@example.com`), PROXY);
    }
    // The operator, same proxy address, no device cookie.
    assert.equal((await login(h, right(), PROXY)).status, 200);

    // The sender keeps going; a colleague still gets in.
    for (let i = 6; i < 9; i += 1) {
      await login(h, wrong(`nobody${String(i)}@example.com`), PROXY);
    }
    assert.equal((await login(h, right(OTHER_USER, OTHER_PASSWORD), PROXY)).status, 200);
  });

  it('what bounds a sender there is the global capacity, and a known browser has a reserve in it', async () => {
    const h = await harness({ config: { globalMaxPerMinute: 6, globalDeviceReservePerMinute: 2 } });
    // The operator signed in from this browser before: it holds a device cookie.
    const first = await login(h, right(), PROXY);
    assert.equal(first.status, 200);
    const device = deviceCookieFrom(first);

    // A sender on the same address drives admitted attempts until unknown
    // browsers get 503 auth.busy.
    assertBusy(await sprayUntilRefused(h, () => PROXY));
    assertBusy(await login(h, right(), PROXY));

    // The operator's browser is not an unknown browser.
    const back = await login(h, right(), { ...PROXY, headers: { cookie: device } });
    assert.equal(back.status, 200);
  });
});

describe('many client keys (IPv6 /64s out of one allocation)', () => {
  const FLY = { kind: 'header', name: 'fly-client-ip' } as const;
  const fromIp = (ip: string, cookie?: string): RequestExtras => ({
    headers: { 'fly-client-ip': ip, ...(cookie ? { cookie } : {}) },
  });

  it('cannot drain the capacity for a browser with a device cookie', async () => {
    const h = await harness({
      clientAddress: FLY,
      config: { globalMaxPerMinute: 8, globalDeviceReservePerMinute: 3 },
    });
    const first = await login(h, right(), fromIp('198.51.100.20'));
    const device = deviceCookieFrom(first);

    // One /48, a fresh /64 for every attempt: each is a client key of its own.
    const busy = await sprayUntilRefused(h, (i) => fromIp(`2001:db8:77:${(i + 1).toString(16)}::1`));
    assertBusy(busy);

    const back = await login(h, right(), fromIp('198.51.100.20', device));
    assert.equal(back.status, 200);
  });

  it('AUTH_LOGIN_IPV6_PREFIX=48 folds the allocation into one client key', async () => {
    const h = await harness({
      clientAddress: FLY,
      ipv6PrefixBits: 48,
      config: { clientMaxFailures: 3 },
    });
    const refused = await sprayUntilRefused(h, (i) => fromIp(`2001:db8:77:${(i + 1).toString(16)}::1`));
    assertRateLimited(refused);
    assert.equal(
      (await login(h, wrong('elsewhere@example.com'), fromIp('2001:db8:78:1::1'))).status,
      401,
      'another /48 is another client',
    );
  });
});

describe('GET /me — a signed-in browser becomes a known device', () => {
  it('sets the device cookie for a password session, and sign-in honours it', async () => {
    const h = await harness();
    const session = `omadia_session=${await sessionFor(LOCAL_PROVIDER_ID, ADMIN)}`;
    const me = await meWith(h, session);
    assert.equal(me.status, 200);
    const device = deviceCookieFrom(me);

    const again = await meWith(h, `${session}; ${device}`);
    assert.equal(again.status, 200);
    assert.deepEqual(
      setCookies(again).filter((c) => c.startsWith(`${LOGIN_DEVICE_COOKIE}=`)),
      [],
      'a genuine device cookie is left alone',
    );

    // Later the session has run out, and a sender on the shared proxy
    // address holds the (admin, proxy) pair shut...
    for (let i = 0; i < 5; i += 1) await login(h, wrong(), PROXY);
    assertRateLimited(await login(h, right(), PROXY));
    // ...but the browser that was signed in has its own budget.
    const back = await login(h, right(), { ...PROXY, headers: { cookie: device } });
    assert.equal(back.status, 200);
  });

  it('sets no device cookie for a provider without password sign-in, or without a session', async () => {
    const h = await harness();
    const oidc = await meWith(h, `omadia_session=${await sessionFor('entra', 'e@example.com')}`);
    assert.equal(oidc.status, 200);
    assert.deepEqual(setCookies(oidc), []);

    const anonymous = await invoke(h.app, 'GET', '/api/v1/auth/me');
    assert.equal(anonymous.status, 401);
    assert.deepEqual(setCookies(anonymous), []);
  });
});
