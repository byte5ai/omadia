/**
 * Who can crowd whom out of the password sign-in limiter
 * (docs/security-architecture.md §10m), with a fake clock. The kind of client
 * key decides which layers apply:
 *
 *   shared   the TCP peer, a proxy every browser behind it shares: no client
 *            layer, because one sender would exhaust it for all of them;
 *   address  an address a trusted proxy vouched for: the client layer brakes it;
 *   device   a valid device cookie: no client layer (its pair is stricter),
 *            and a reserve in the global capacity nobody else can use. All
 *            device ids of one account share one pair, so a second id buys
 *            neither a second budget nor a second share of that reserve.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  createLoginRateLimiter,
  DEFAULT_LOGIN_LIMITER_CONFIG,
  type LoginAdmission,
  type LoginKeys,
  type LoginLimiterConfig,
  type LoginRateLimiter,
} from '../../src/auth/loginRateLimiter.js';

const SECOND = 1000;
const D = DEFAULT_LOGIN_LIMITER_CONFIG;
const UNKNOWN_BROWSER_PER_MINUTE = D.globalMaxPerMinute - D.globalDeviceReservePerMinute;
const UNKNOWN_BROWSER_IN_FLIGHT = D.globalMaxInFlight - D.globalDeviceReserveInFlight;

function setup(overrides: Partial<LoginLimiterConfig> = {}): {
  limiter: LoginRateLimiter;
  clock: { advance: (ms: number) => void };
} {
  let t = 1_700_000_000_000;
  const limiter = createLoginRateLimiter({ ...D, ...overrides }, () => t);
  return { limiter, clock: { advance: (ms) => (t += ms) } };
}

const shared = (accountKey: string): LoginKeys => ({
  clientKey: '10.0.0.5',
  clientKind: 'shared',
  accountKey,
});
const address = (clientKey: string, accountKey: string): LoginKeys => ({
  clientKey,
  clientKind: 'address',
  accountKey,
});
const device = (id: string, accountKey: string): LoginKeys => ({
  clientKey: `device:${id}`,
  clientKind: 'device',
  accountKey,
});

function failOnce(limiter: LoginRateLimiter, k: LoginKeys): void {
  const a = limiter.admit(k);
  assert.equal(a.allowed, true, `expected ${JSON.stringify(k)} to be admitted`);
  if (a.allowed) a.attempt.fail();
}

function scopeOf(a: LoginAdmission): string {
  assert.equal(a.allowed, false, 'expected a refusal');
  return a.allowed ? 'admitted' : a.scope;
}

/** Admit (and fail) attempts from `next(i)` until one is refused; returns how many got in. */
function admitUntilRefused(
  limiter: LoginRateLimiter,
  next: (i: number) => LoginKeys,
  limit = 1000,
): { admitted: number; scope: string } {
  for (let i = 0; i < limit; i += 1) {
    const a = limiter.admit(next(i));
    if (!a.allowed) return { admitted: i, scope: a.scope };
    a.attempt.fail();
  }
  assert.fail(`no refusal within ${String(limit)} attempts`);
}

describe('shared key: one sender cannot starve every browser behind the proxy', () => {
  it('a sender that keeps taking every opening never refuses another account’s attempt', () => {
    const { limiter, clock } = setup();
    // What used to fill the shared bucket: 100 failures on fresh accounts...
    for (let i = 0; i < D.clientMaxFailures; i += 1) {
      failOnce(limiter, shared(`local:nobody${String(i)}@example.com`));
    }
    // ...then one more attempt every second for ten minutes, while the owner
    // of another account (no device cookie) tries every 30 s.
    const ownerTries: boolean[] = [];
    for (let s = 0; s < 600; s += 1) {
      const a = limiter.admit(shared(`local:spray${String(s)}@example.com`));
      if (a.allowed) a.attempt.fail();
      if (s % 30 === 0) {
        const owner = limiter.admit(shared('local:owner@example.com'));
        ownerTries.push(owner.allowed);
        if (owner.allowed) owner.attempt.succeed();
      }
      clock.advance(SECOND);
    }
    const refused = ownerTries.filter((ok) => !ok).length;
    assert.equal(refused, 0, `owner refused on ${String(refused)} of ${String(ownerTries.length)} tries`);
  });

  it('the global capacity for unknown browsers is what bounds such a sender', () => {
    const { limiter } = setup();
    const run = admitUntilRefused(limiter, (i) => shared(`local:nobody${String(i)}@example.com`));
    assert.deepEqual(run, { admitted: UNKNOWN_BROWSER_PER_MINUTE, scope: 'global' });
  });

  it('the pair layer still applies: five free failures, then the backoff', () => {
    const { limiter } = setup();
    for (let i = 0; i < D.accountFreeFailures; i += 1) failOnce(limiter, shared('local:victim@x'));
    assert.equal(scopeOf(limiter.admit(shared('local:victim@x'))), 'account');
  });

  it('keeps no per-client state for it', () => {
    const { limiter } = setup();
    for (let i = 0; i < 10; i += 1) failOnce(limiter, shared(`local:n${String(i)}@x`));
    assert.equal(limiter.stats().clients, 0);
  });
});

describe('address key: the client layer brakes one vouched-for address', () => {
  it('refuses that address once its burst is spent; another address is unaffected', () => {
    const { limiter } = setup();
    const run = admitUntilRefused(limiter, (i) => address('203.0.113.1', `local:n${String(i)}@x`));
    assert.deepEqual(run, { admitted: D.clientMaxFailures, scope: 'client' });
    assert.equal(limiter.admit(address('203.0.113.2', 'local:owner@x')).allowed, true);
  });
});

describe('device key: the account’s known-browser pair is its only limit', () => {
  it('skips the client layer and meets the pair backoff after five failures', () => {
    const { limiter } = setup({ clientMaxFailures: 2 });
    for (let i = 0; i < D.accountFreeFailures; i += 1) {
      failOnce(limiter, device('owner-browser', 'local:owner@x'));
    }
    assert.equal(scopeOf(limiter.admit(device('owner-browser', 'local:owner@x'))), 'account');
    assert.equal(limiter.stats().clients, 0);
  });

  it('every device id of one account shares that one pair', () => {
    const { limiter } = setup();
    for (let i = 0; i < D.accountFreeFailures; i += 1) {
      failOnce(limiter, device(`browser-${String(i)}`, 'local:owner@x'));
    }
    assert.equal(scopeOf(limiter.admit(device('yet-another-browser', 'local:owner@x'))), 'account');
    // Another account's known browsers, and the account's address pairs, are apart.
    assert.equal(limiter.admit(device('yet-another-browser', 'local:other@x')).allowed, true);
    assert.equal(limiter.admit(shared('local:owner@x')).allowed, true);
  });

  it('so one account’s device ids take at most the free budget of the reserve', () => {
    const { limiter } = setup();
    admitUntilRefused(limiter, (i) => shared(`local:n${String(i)}@x`));
    const run = admitUntilRefused(limiter, (i) => device(`browser-${String(i)}`, 'local:former@x'));
    assert.deepEqual(run, { admitted: D.accountFreeFailures, scope: 'account' });
    assert.equal(limiter.admit(device('owner-browser', 'local:owner@x')).allowed, true);
  });
});

describe('global capacity: a reserve for browsers with a device cookie', () => {
  it('many client keys fill the budget for unknown browsers; a device-keyed attempt still gets in', () => {
    const { limiter } = setup();
    // A fresh IPv6 /64 per attempt — one /48 holds 65,536 of them.
    const run = admitUntilRefused(limiter, (i) =>
      address(`2001:db8:${i.toString(16)}:1::/64`, `local:g${String(i)}@x`),
    );
    assert.deepEqual(run, { admitted: UNKNOWN_BROWSER_PER_MINUTE, scope: 'global' });
    assert.equal(limiter.admit(device('owner-browser', 'local:owner@x')).allowed, true);
  });

  it('known browsers may use the whole budget, the reserve included, and no more', () => {
    const { limiter } = setup();
    admitUntilRefused(limiter, (i) => shared(`local:n${String(i)}@x`));
    const run = admitUntilRefused(limiter, (i) => device(`browser-${String(i)}`, `local:k${String(i)}@x`));
    assert.deepEqual(run, { admitted: D.globalDeviceReservePerMinute, scope: 'global' });
  });

  it('unknown browsers cannot hold the in-flight slot reserved for known ones', () => {
    const { limiter } = setup();
    const held: LoginAdmission[] = [];
    for (let i = 0; i < 10; i += 1) {
      const a = limiter.admit(address(`198.51.100.${String(i)}`, `local:h${String(i)}@x`));
      if (!a.allowed) {
        assert.equal(a.scope, 'global');
        break;
      }
      held.push(a);
    }
    assert.equal(held.length, UNKNOWN_BROWSER_IN_FLIGHT);
    assert.equal(limiter.acquireSlot(), null, 'the setup wizard is an unknown browser too');

    const known = limiter.admit(device('owner-browser', 'local:owner@x'));
    assert.equal(known.allowed, true);
    assert.equal(scopeOf(limiter.admit(device('other-browser', 'local:other@x'))), 'global');

    for (const a of [...held, known]) if (a.allowed) a.attempt.fail();
    assert.equal(limiter.stats().inFlight, 0);
  });

  it('with AUTH_LOGIN_MAX_INFLIGHT=1 there is nothing to reserve', () => {
    const { limiter } = setup({ globalMaxInFlight: 1 });
    const a = limiter.admit(address('198.51.100.1', 'local:a@x'));
    assert.equal(a.allowed, true);
    assert.equal(scopeOf(limiter.admit(device('owner-browser', 'local:owner@x'))), 'global');
    if (a.allowed) a.attempt.fail();
    assert.equal(limiter.admit(address('198.51.100.2', 'local:b@x')).allowed, true);
  });
});
