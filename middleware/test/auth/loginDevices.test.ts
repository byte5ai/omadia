/**
 * Device cookies of the password sign-in limiter (docs/security-architecture.md
 * §10m), unit by unit: the v3 cookie codec, the account epoch a cookie is
 * bound to, which account and which epoch a cookie is minted for (the ones the
 * sign-in verified) and checked against, and the cached lookup that decides
 * whether a browser is a known device. The route-level picture is
 * loginDeviceRevocation.test.ts and loginAccountAliases.test.ts.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { Request, Response } from 'express';

import {
  createLoginDeviceCookies,
  LOGIN_DEVICE_COOKIE,
  LOGIN_DEVICE_TTL_S,
} from '../../src/auth/loginDeviceCookie.js';
import {
  createLoginDevices,
  credentialEpoch,
  EPOCH_CACHE_TTL_MS,
  usersTableEpochs,
  type LoginAccountEpochs,
} from '../../src/auth/loginDevices.js';
import type { UserRecord } from '../../src/auth/userStore.js';
import { pgLower } from './loginHarness.js';

const KEY = new TextEncoder().encode('device-cookie-unit-test-signing-key-'.repeat(2));
/** The device key of OWNER (`loginDeviceAccountKey`). */
const ACCOUNT_KEY = 'local:owner@example.com';
/** As a sign-in body names it: ASCII case and whitespace do not matter. */
const OWNER = { providerId: 'local', accountId: ' Owner@Example.com ' };
/** As the users table stores it, the address a sign-in verified, under the epoch it checked. */
const VERIFIED = { providerId: 'local', email: 'Owner@Example.com', epoch: 'epoch-1' };
const NOW_S = 1_790_000_000;

describe('device cookie codec (v3)', () => {
  const cookies = createLoginDeviceCookies(KEY);

  it('reads back what it minted, for that account only, within the cookie size cap', () => {
    const raw = cookies.mint(ACCOUNT_KEY, 'epoch-1', { nowS: NOW_S });
    const read = cookies.read(raw, ACCOUNT_KEY, NOW_S);
    assert.ok(read);
    assert.match(read.id, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(cookies.read(raw, 'local:someone-else@example.com', NOW_S), null);
    assert.ok(raw.length <= 128, `length ${String(raw.length)}`);
  });

  it('tells the epoch it was minted under from any other', () => {
    const read = cookies.read(cookies.mint(ACCOUNT_KEY, 'epoch-1', { nowS: NOW_S }), ACCOUNT_KEY, NOW_S);
    assert.ok(read);
    assert.equal(cookies.isCurrent(read, 'epoch-1'), true);
    assert.equal(cookies.isCurrent(read, 'epoch-2'), false);
  });

  it('gives every cookie a fresh device id', () => {
    const ids = new Set(
      Array.from({ length: 5 }, () => cookies.mint(ACCOUNT_KEY, 'epoch-1', { nowS: NOW_S }).split('.')[1]),
    );
    assert.equal(ids.size, 5);
  });

  it('refuses an expired, re-pointed, foreign-key, older-format or malformed value', () => {
    const raw = cookies.mint(ACCOUNT_KEY, 'epoch-1', { nowS: NOW_S });
    assert.equal(cookies.read(raw, ACCOUNT_KEY, NOW_S + LOGIN_DEVICE_TTL_S), null, 'expired');

    // Swapping in the fingerprint of another epoch breaks the tag.
    const [format, id, exp, , tag] = raw.split('.');
    const otherEp = cookies.mint(ACCOUNT_KEY, 'epoch-2', { nowS: NOW_S }).split('.')[3];
    const repointed = [format, id, exp, otherEp, tag].join('.');
    assert.equal(cookies.read(repointed, ACCOUNT_KEY, NOW_S), null, 're-pointed');

    const foreign = createLoginDeviceCookies(new TextEncoder().encode('x'.repeat(64)));
    assert.equal(cookies.read(foreign.mint(ACCOUNT_KEY, 'epoch-1', { nowS: NOW_S }), ACCOUNT_KEY, NOW_S), null);
    // v2 cookies were bound to the address as typed; v1 to nothing but the account.
    assert.equal(cookies.read(raw.replace(/^v3\./, 'v2.'), ACCOUNT_KEY, NOW_S), null, 'v2');
    assert.equal(cookies.read(`v1.${String(id)}.${String(exp)}.${String(tag)}`, ACCOUNT_KEY, NOW_S), null);
    for (const junk of [undefined, 42, '', 'v3', `${raw}.extra`, `${raw}${'x'.repeat(100)}`]) {
      assert.equal(cookies.read(junk, ACCOUNT_KEY, NOW_S), null, String(junk).slice(0, 20));
    }
  });
});

describe('usersTableEpochs — the epoch of a users-table account', () => {
  const base: UserRecord = {
    id: 'row-1',
    email: 'owner@example.com',
    provider: 'local',
    providerUserId: 'owner@example.com',
    passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA',
    displayName: 'Owner',
    role: 'admin',
    status: 'active',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    lastLoginAt: null,
    sessionVersion: 0,
  };
  const epochOf = (row: UserRecord | null): Promise<string | null> =>
    usersTableEpochs({ findByEmailWithHash: async () => row })('local', 'owner@example.com');

  it('is null for a missing, disabled or hash-less account', async () => {
    assert.equal(await epochOf(null), null);
    assert.equal(await epochOf({ ...base, status: 'disabled' }), null);
    const { passwordHash: _hash, ...withoutHash } = base;
    assert.equal(await epochOf(withoutHash), null);
  });

  it('moves with the password hash and with the row, and hides both', async () => {
    const epoch = await epochOf(base);
    assert.ok(epoch);
    assert.equal(await epochOf({ ...base, updatedAt: new Date(1), lastLoginAt: new Date(1) }), epoch);
    assert.notEqual(await epochOf({ ...base, passwordHash: `${String(base.passwordHash)}x` }), epoch);
    assert.notEqual(await epochOf({ ...base, id: 'row-2' }), epoch);
    assert.ok(!epoch.includes('argon2') && !epoch.includes('row-1'));
  });

  it('is the credential epoch of the row, the one a sign-in mints under', async () => {
    // A sign-in mints under credentialEpoch() of the row and hash it compared;
    // a check reads it back through this lookup. They must agree exactly.
    assert.equal(await epochOf(base), credentialEpoch({ id: 'row-1', passwordHash: String(base.passwordHash) }));
  });
});

// ─── createLoginDevices ────────────────────────────────────────────────────

/** A genuine device cookie for OWNER, minted under `epoch` (valid for a year from now). */
function genuine(epoch: string): string {
  return createLoginDeviceCookies(KEY).mint(ACCOUNT_KEY, epoch);
}

function reqWith(cookie?: string): Request {
  return {
    headers: {},
    cookies: cookie === undefined ? {} : { [LOGIN_DEVICE_COOKIE]: cookie },
  } as unknown as Request;
}

function resJar(): { res: Response; set: Map<string, string> } {
  const set = new Map<string, string>();
  const res = {
    cookie: (name: string, value: string) => {
      set.set(name, value);
    },
  } as unknown as Response;
  return { res, set };
}

/** An epoch source over a mutable table that records what it was asked for. */
function table(initial: string | null): {
  epochs: LoginAccountEpochs;
  current: { epoch: string | null };
  asked: string[];
  lookups: () => number;
} {
  const current = { epoch: initial };
  const asked: string[] = [];
  return {
    current,
    asked,
    lookups: () => asked.length,
    epochs: async (_providerId, accountId) => {
      asked.push(accountId);
      return current.epoch;
    },
  };
}

function setup(initial: string | null = 'epoch-1') {
  const source = table(initial);
  const clock = { t: 1_800_000_000_000 };
  const devices = createLoginDevices({
    signingKey: KEY,
    epochs: source.epochs,
    now: () => clock.t,
  });
  /** A cookie `remember` hands out for the account a sign-in verified, under the epoch it checked. */
  const issue = (verified = VERIFIED): string => {
    const { res, set } = resJar();
    devices.remember(reqWith(), res, verified);
    const value = set.get(LOGIN_DEVICE_COOKIE);
    assert.ok(value, 'remember set a device cookie');
    return value;
  };
  return { devices, source, clock, issue };
}

describe('createLoginDevices — which browsers are known', () => {
  it('looks nothing up for a request without a genuine cookie', async () => {
    const { devices, source } = setup();
    for (const cookie of [undefined, 'v3.forged', `v1.${'A'.repeat(22)}.1.${'B'.repeat(43)}`]) {
      assert.equal(await devices.knownDeviceOf(reqWith(cookie), OWNER), null);
    }
    assert.equal(source.lookups(), 0);
  });

  it('honours a current cookie, and no longer once the epoch moves', async () => {
    const { devices, source, issue } = setup();
    const cookie = issue();
    assert.ok(await devices.knownDeviceOf(reqWith(cookie), OWNER));
    source.current.epoch = 'epoch-2';
    devices.forget(ACCOUNT_KEY);
    assert.equal(await devices.knownDeviceOf(reqWith(cookie), OWNER), null);
    source.current.epoch = null;
    devices.forget(ACCOUNT_KEY);
    assert.equal(await devices.knownDeviceOf(reqWith(cookie), OWNER), null);
  });

  it('mints for the verified account by its stored address, and checks the typed one by ASCII case only', async () => {
    const { devices, source, issue } = setup();
    const cookie = issue();
    assert.equal(source.lookups(), 0, 'minting reads nothing: it takes the epoch the sign-in checked');

    assert.ok(await devices.knownDeviceOf(reqWith(cookie), { providerId: 'local', accountId: 'OWNER@EXAMPLE.COM' }));
    assert.deepEqual(source.asked, ['owner@example.com'], 'a check looks up the ASCII-lower-cased address');
    const accented = { providerId: 'local', accountId: '\u00d6wner@example.com' };
    assert.equal(await devices.knownDeviceOf(reqWith(cookie), accented), null);
    assert.equal(source.lookups(), 1, 'another spelling is another key: no lookup');
  });

  it('mints under the epoch the sign-in checked, never the one the account has by then', async () => {
    // The sign-in compared the password with epoch-1's hash; a reset moved
    // the account to epoch-2 before the cookie was minted.
    const { devices, source, issue } = setup('epoch-2');
    const raced = issue({ ...VERIFIED, epoch: 'epoch-1' });
    assert.equal(source.lookups(), 0);
    assert.equal(await devices.knownDeviceOf(reqWith(raced), OWNER), null, 'stale from the start');

    // A sign-in that checked the new password mints one that counts.
    const fresh = issue({ ...VERIFIED, epoch: 'epoch-2' });
    assert.ok(await devices.knownDeviceOf(reqWith(fresh), OWNER));
  });

  it('never counts one account’s cookie for another the users table keeps apart', async () => {
    // Postgres LOWER() turns A's alias with a capital İ into A's address,
    // and keeps B's combining dot.
    const A = 'iiii@example.com';
    const B = 'i\u0307iii@example.com';
    const rows = new Map([
      [pgLower(A), 'epoch-a'],
      [pgLower(B), 'epoch-b'],
    ]);
    const devices = createLoginDevices({
      signingKey: KEY,
      epochs: async (_p, accountId) => rows.get(pgLower(accountId)) ?? null,
    });
    /** What a sign-in that verified `email`'s row mints. */
    const mint = (email: string): string => {
      const { res, set } = resJar();
      devices.remember(reqWith(), res, { providerId: 'local', email, epoch: String(rows.get(pgLower(email))) });
      return String(set.get(LOGIN_DEVICE_COOKIE));
    };
    const known = (cookie: string, typed: string): Promise<string | null> =>
      devices.knownDeviceOf(reqWith(cookie), { providerId: 'local', accountId: typed });
    const cookieA = mint(A);
    const cookieB = mint(B);

    assert.ok(await known(cookieA, 'IIII@EXAMPLE.COM'));
    assert.ok(await known(cookieB, 'I\u0307III@EXAMPLE.COM'));
    assert.equal(await known(cookieA, B), null, 'A’s cookie is no known browser of B');
    assert.equal(await known(cookieB, A), null, 'nor B’s of A');
    assert.equal(await known(cookieB, '\u0130iii@example.com'), null, 'nor under a spelling that finds A');
    assert.equal(await known(cookieA, '\u0130iii@example.com'), null, 'that spelling is no device key at all');
  });

  it(`reuses a looked-up epoch for ${String(EPOCH_CACHE_TTL_MS)} ms; forget() re-reads at once`, async () => {
    const { devices, source, clock } = setup();
    const cookie = genuine('epoch-1');
    for (let i = 0; i < 20; i += 1) await devices.knownDeviceOf(reqWith(cookie), OWNER);
    assert.equal(source.lookups(), 1, 'a stream of requests is one lookup');
    clock.t += EPOCH_CACHE_TTL_MS;
    await devices.knownDeviceOf(reqWith(cookie), OWNER);
    assert.equal(source.lookups(), 2);
    devices.forget(ACCOUNT_KEY);
    await devices.knownDeviceOf(reqWith(cookie), OWNER);
    assert.equal(source.lookups(), 3);
  });

  it('a lookup that overlaps forget() does not fill the cache', async () => {
    // A source that answers only when told to; the clock never moves.
    let answer: (epoch: string) => void = () => undefined;
    let lookups = 0;
    const gated: LoginAccountEpochs = () => {
      lookups += 1;
      return new Promise<string>((resolve) => {
        answer = resolve;
      });
    };
    const devices = createLoginDevices({ signingKey: KEY, epochs: gated, now: () => 0 });
    const cookie = genuine('epoch-1');

    const first = devices.knownDeviceOf(reqWith(cookie), OWNER);
    assert.equal(lookups, 1);
    devices.forget(ACCOUNT_KEY); // a password reset lands meanwhile...
    answer('epoch-1'); // ...after the lookup read the old row
    assert.ok(await first);

    const second = devices.knownDeviceOf(reqWith(cookie), OWNER);
    assert.equal(lookups, 2, 'the overlapping answer was not cached');
    answer('epoch-2');
    assert.equal(await second, null);
  });

  it('concurrent checks for one account share one lookup', async () => {
    let answer: (epoch: string) => void = () => undefined;
    let lookups = 0;
    const gated: LoginAccountEpochs = () => {
      lookups += 1;
      return new Promise<string>((resolve) => {
        answer = resolve;
      });
    };
    const devices = createLoginDevices({ signingKey: KEY, epochs: gated, now: () => 0 });
    const cookie = genuine('epoch-1');

    const checks = Array.from({ length: 50 }, () => devices.knownDeviceOf(reqWith(cookie), OWNER));
    assert.equal(lookups, 1, 'fifty requests at once, one query');
    answer('epoch-1');
    const ids = await Promise.all(checks);
    assert.ok(ids.every((id) => id !== null));
    assert.equal(lookups, 1);
  });

  it('remember() sets nothing without an address', () => {
    const { devices, source } = setup();
    const { res, set } = resJar();
    devices.remember(reqWith(), res, { ...VERIFIED, email: '   ' });
    assert.equal(set.size, 0);
    assert.equal(source.lookups(), 0);
  });

  it('remember() hands out a fresh device id per sign-in', () => {
    const { issue } = setup();
    const ids = new Set<string>();
    for (let i = 0; i < 5; i += 1) ids.add(issue().split('.')[1] ?? 'no id');
    assert.equal(ids.size, 5);
    assert.ok(!ids.has('no id'));
  });

  it('a failing lookup counts the browser as unknown and warns at most once a minute', async () => {
    const failing: LoginAccountEpochs = async () => {
      throw new Error('database unreachable');
    };
    const cookie = genuine('epoch-1');
    const clock = { t: 0 };
    const warnings: string[] = [];
    const devices = createLoginDevices({
      signingKey: KEY,
      epochs: failing,
      now: () => clock.t,
      warn: (m) => warnings.push(m),
    });
    assert.equal(await devices.knownDeviceOf(reqWith(cookie), OWNER), null);
    assert.equal(await devices.knownDeviceOf(reqWith(cookie), OWNER), null);
    // Minting reads nothing, so an outage costs a sign-in no device cookie.
    const { res, set } = resJar();
    devices.remember(reqWith(), res, VERIFIED);
    assert.equal(set.size, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /database unreachable/);
    assert.ok(!(warnings[0] ?? '').toLowerCase().includes('owner@example.com'), 'never the account');
    clock.t += 60_000;
    await devices.knownDeviceOf(reqWith(cookie), OWNER);
    assert.equal(warnings.length, 2);
  });
});
