/**
 * The password sign-in limiter (docs/security-architecture.md §10f), driven
 * with a fake clock. Every threshold asserted here is a default an operator
 * relies on, so the cases read DEFAULT_LOGIN_LIMITER_CONFIG instead of
 * restating numbers where they can.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  createLoginRateLimiter,
  DEFAULT_LOGIN_LIMITER_CONFIG,
  loginAccountKey,
  readLoginAccountId,
  type LoginAdmission,
  type LoginClientKind,
  type LoginKeys,
  type LoginLimiterConfig,
  type LoginRateLimiter,
} from '../../src/auth/loginRateLimiter.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const D = DEFAULT_LOGIN_LIMITER_CONFIG;

class FakeClock {
  t = 1_700_000_000_000;
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

function setup(overrides: Partial<LoginLimiterConfig> = {}): {
  limiter: LoginRateLimiter;
  clock: FakeClock;
} {
  const clock = new FakeClock();
  return { limiter: createLoginRateLimiter({ ...D, ...overrides }, clock.now), clock };
}

/** An address a trusted proxy vouched for, unless said otherwise (see loginRateLimiterFairness.test.ts). */
function keys(
  clientKey: string,
  accountKey: string,
  clientKind: LoginClientKind = 'address',
): LoginKeys {
  return { clientKey, clientKind, accountKey };
}

/** Admit one attempt and settle it as a failure; asserts it was admitted. */
function failOnce(limiter: LoginRateLimiter, k: LoginKeys): void {
  const a = limiter.admit(k);
  assert.equal(a.allowed, true, `expected ${JSON.stringify(k)} to be admitted`);
  if (a.allowed) a.attempt.fail();
}

function refusal(a: LoginAdmission): { scope: string; retryAfterS: number; report: boolean } {
  assert.equal(a.allowed, false, 'expected a refusal');
  if (a.allowed) throw new Error('unreachable');
  return { scope: a.scope, retryAfterS: a.retryAfterS, report: a.report };
}

describe('defaults', () => {
  it('pins the documented thresholds', () => {
    assert.equal(D.clientMaxFailures, 100);
    assert.equal(D.clientWindowMs, 10 * MINUTE);
    assert.equal(D.clientMaxRetryAfterMs, 15 * SECOND);
    assert.equal(D.accountFreeFailures, 5);
    assert.equal(D.accountBaseBlockMs, SECOND);
    assert.equal(D.accountMaxBlockMs, 2 * MINUTE);
    assert.equal(D.globalMaxInFlight, 4);
    assert.equal(D.globalDeviceReserveInFlight, 1);
    assert.equal(D.globalMaxPerMinute, 300);
    assert.equal(D.globalDeviceReservePerMinute, 60);
    assert.equal(D.maxTrackedKeys, 10_000);
  });
});

describe('client layer — a CPU brake per client key', () => {
  it('admits a burst of clientMaxFailures failures, then refuses with a short integer Retry-After', () => {
    const { limiter } = setup();
    // Distinct accounts, so the account layer never trips first.
    for (let i = 0; i < D.clientMaxFailures; i += 1) {
      failOnce(limiter, keys('203.0.113.1', `local:user${String(i)}@example.com`));
    }
    const r = refusal(limiter.admit(keys('203.0.113.1', 'local:fresh@example.com')));
    assert.equal(r.scope, 'client');
    assert.ok(Number.isInteger(r.retryAfterS));
    assert.ok(r.retryAfterS >= 1 && r.retryAfterS <= 15, `retryAfterS=${String(r.retryAfterS)}`);
  });

  // Each wait is short, but a sender that keeps the bucket full takes every
  // step as it opens: whoever else shares the address (a NAT) waits as long
  // as it keeps going. Hence the layer never brakes the shared TCP peer.
  it('pinned semantics: once full, ONE failure per drain step (6 s), each wait at most 15 s', () => {
    const { limiter, clock } = setup();
    for (let i = 0; i < D.clientMaxFailures; i += 1) {
      failOnce(limiter, keys('203.0.113.1', `local:u${String(i)}@example.com`));
    }
    const r = refusal(limiter.admit(keys('203.0.113.1', 'local:x@example.com')));
    clock.advance(r.retryAfterS * SECOND);
    failOnce(limiter, keys('203.0.113.1', 'local:x@example.com'));
    // The bucket is full again, so the very next attempt waits one step...
    assert.equal(refusal(limiter.admit(keys('203.0.113.1', 'local:y@example.com'))).scope, 'client');
    // ...and each wait is within the cap.
    clock.advance(16 * SECOND);
    assert.equal(limiter.admit(keys('203.0.113.1', 'local:y@example.com')).allowed, true);
  });

  it('a whole window of silence restores the full burst', () => {
    const { limiter, clock } = setup();
    for (let i = 0; i < D.clientMaxFailures; i += 1) {
      failOnce(limiter, keys('203.0.113.1', `local:u${String(i)}@example.com`));
    }
    clock.advance(D.clientWindowMs);
    for (let i = 0; i < D.clientMaxFailures; i += 1) {
      failOnce(limiter, keys('203.0.113.1', `local:v${String(i)}@example.com`));
    }
  });

  it('another client key is unaffected', () => {
    const { limiter } = setup();
    for (let i = 0; i < D.clientMaxFailures; i += 1) {
      failOnce(limiter, keys('203.0.113.1', `local:u${String(i)}@example.com`));
    }
    assert.equal(limiter.admit(keys('203.0.113.2', 'local:u1@example.com')).allowed, true);
  });
});

describe('account layer — per (account, client) pair backoff', () => {
  const victim = 'local:admin@example.com';

  it('5 free failures, then blocks of 1 s, 2 s, 4 s … capped at 120 s', () => {
    const { limiter, clock } = setup();
    for (let i = 0; i < D.accountFreeFailures; i += 1) failOnce(limiter, keys('c1', victim));

    const expected = [1, 2, 4, 8, 16, 32, 64, 120, 120, 120];
    for (const blockS of expected) {
      const r = refusal(limiter.admit(keys('c1', victim)));
      assert.equal(r.scope, 'account');
      assert.equal(r.retryAfterS, blockS);
      clock.advance(blockS * SECOND - 1);
      assert.equal(limiter.admit(keys('c1', victim)).allowed, false, 'still blocked 1 ms early');
      clock.advance(1);
      failOnce(limiter, keys('c1', victim));
    }
  });

  it('lockout-DoS: an attacker blocking (victim, attacker) leaves (victim, victim-client) open', () => {
    const { limiter } = setup();
    for (let i = 0; i < 12; i += 1) {
      const a = limiter.admit(keys('attacker', victim));
      if (a.allowed) a.attempt.fail();
    }
    assert.equal(refusal(limiter.admit(keys('attacker', victim))).scope, 'account');
    assert.equal(limiter.admit(keys('victim-client', victim)).allowed, true);
  });

  it('shared client key (every browser behind one proxy): the pair still backs off, a device-keyed victim gets in', () => {
    const { limiter, clock } = setup();
    const shared = '10.0.0.5';
    // An attacker behind the same proxy keeps the (victim, shared) pair hot.
    for (let round = 0; round < 20; round += 1) {
      const a = limiter.admit(keys(shared, victim, 'shared'));
      if (a.allowed) a.attempt.fail();
      else clock.advance(a.retryAfterS * SECOND);
    }
    // Whatever the last round did, the attacker fails once more right now.
    const last = limiter.admit(keys(shared, victim, 'shared'));
    if (last.allowed) last.attempt.fail();
    // Each wait is within the cap, but the attacker renews it: a victim
    // without a device cookie stays out while it keeps going (§10f residual).
    const blocked = refusal(limiter.admit(keys(shared, victim, 'shared')));
    assert.equal(blocked.scope, 'account');
    assert.ok(blocked.retryAfterS <= D.accountMaxBlockMs / SECOND, 'each wait within the cap');
    // The victim's browser carries a device cookie for this account: its own key.
    assert.equal(limiter.admit(keys('device:abc', victim, 'device')).allowed, true);
  });

  it('a success clears the pair but not the client layer', () => {
    const { limiter, clock } = setup({ clientMaxFailures: 8 });
    for (let i = 0; i < D.accountFreeFailures; i += 1) failOnce(limiter, keys('c1', victim));
    clock.advance(SECOND);
    const ok = limiter.admit(keys('c1', victim));
    assert.equal(ok.allowed, true);
    if (ok.allowed) ok.attempt.succeed();
    // Free budget again: back-to-back failures are admitted without a block
    // (an uncleared pair would refuse the second one)...
    for (let i = 0; i < 3; i += 1) failOnce(limiter, keys('c1', victim));
    // ...but the client layer still remembers all eight failures.
    assert.equal(refusal(limiter.admit(keys('c1', 'local:other@example.com'))).scope, 'client');
  });

  it('parallel attempts are counted at admission: the free budget cannot be raced', () => {
    // Enough global slots that only the account layer can say no.
    const { limiter } = setup({ globalMaxInFlight: 16 });
    const held = [];
    for (let i = 0; i < D.accountFreeFailures; i += 1) {
      const a = limiter.admit(keys('c1', victim));
      assert.equal(a.allowed, true);
      held.push(a);
    }
    const sixth = refusal(limiter.admit(keys('c1', victim)));
    assert.equal(sixth.scope, 'account');
    assert.equal(sixth.retryAfterS, 1);
    for (const a of held) if (a.allowed) a.attempt.fail();
    assert.equal(refusal(limiter.admit(keys('c1', victim))).retryAfterS, 1);
  });

  it('once the free budget is spent, one attempt per pair at a time', () => {
    const { limiter, clock } = setup();
    for (let i = 0; i < D.accountFreeFailures; i += 1) failOnce(limiter, keys('c1', victim));
    clock.advance(SECOND);
    const first = limiter.admit(keys('c1', victim));
    assert.equal(first.allowed, true);
    assert.equal(refusal(limiter.admit(keys('c1', victim))).scope, 'account');
    if (first.allowed) first.attempt.fail();
  });

  it('forgets a pair accountStateTtlMs after its last failure', () => {
    const { limiter, clock } = setup();
    for (let i = 0; i < 8; i += 1) {
      const a = limiter.admit(keys('c1', victim));
      if (a.allowed) a.attempt.fail();
      else clock.advance(a.retryAfterS * SECOND);
    }
    clock.advance(D.accountStateTtlMs);
    for (let i = 0; i < D.accountFreeFailures; i += 1) failOnce(limiter, keys('c1', victim));
  });
});

describe('global layer — argon2 capacity', () => {
  it('acquireSlot() refuses once the unreserved slots are held, and recovers on release', () => {
    const { limiter } = setup();
    const releases: Array<() => void> = [];
    // The wizard is an unknown browser: the device reserve is not its to take.
    for (let i = 0; i < D.globalMaxInFlight - D.globalDeviceReserveInFlight; i += 1) {
      const r = limiter.acquireSlot();
      assert.ok(r);
      releases.push(r);
    }
    assert.equal(limiter.acquireSlot(), null);
    const busy = refusal(limiter.admit(keys('c9', 'local:a@example.com')));
    assert.equal(busy.scope, 'global');
    assert.ok(busy.retryAfterS >= 1 && busy.retryAfterS <= 2);
    releases[0]?.();
    releases[0]?.(); // idempotent: a double release must not free a second slot
    const again = limiter.acquireSlot();
    assert.ok(again);
    assert.equal(limiter.acquireSlot(), null);
  });

  it('an admitted attempt holds a slot until it settles', () => {
    const { limiter } = setup({ globalMaxInFlight: 1 });
    const a = limiter.admit(keys('c1', 'local:a@example.com'));
    assert.equal(a.allowed, true);
    assert.equal(refusal(limiter.admit(keys('c2', 'local:b@example.com'))).scope, 'global');
    if (a.allowed) {
      a.attempt.fail();
      a.attempt.fail(); // settling twice is a no-op
    }
    assert.equal(limiter.admit(keys('c2', 'local:b@example.com')).allowed, true);
  });

  it('refuses unknown browsers past the unreserved part of the per-minute budget', () => {
    const { limiter, clock } = setup();
    for (let i = 0; i < D.globalMaxPerMinute - D.globalDeviceReservePerMinute; i += 1) {
      failOnce(limiter, keys(`198.51.100.${String(i % 250)}-${String(i)}`, `local:g${String(i)}@x`));
    }
    const r = refusal(limiter.admit(keys('fresh-client', 'local:fresh@x')));
    assert.equal(r.scope, 'global');
    assert.equal(r.retryAfterS, 1);
    clock.advance(SECOND);
    assert.equal(limiter.admit(keys('fresh-client', 'local:fresh@x')).allowed, true);
  });

  it('attempts refused by the client or account layer never consume global budget', () => {
    const { limiter } = setup({ globalMaxPerMinute: 10, globalDeviceReservePerMinute: 0 });
    for (let i = 0; i < D.accountFreeFailures; i += 1) failOnce(limiter, keys('c1', 'local:v@x'));
    for (let i = 0; i < 500; i += 1) {
      assert.equal(refusal(limiter.admit(keys('c1', 'local:v@x'))).scope, 'account');
    }
    // 5 of 10 admitted-attempt tokens used; the 500 refusals took none.
    for (let i = 0; i < 5; i += 1) failOnce(limiter, keys(`other-${String(i)}`, 'local:w@x'));
    assert.equal(refusal(limiter.admit(keys('late', 'local:z@x'))).scope, 'global');
  });
});

describe('reporting — one log/audit line per refusal episode, not per request', () => {
  it('flags the first refusal per (scope, client) and again after reportIntervalMs', () => {
    const { limiter, clock } = setup();
    for (let i = 0; i < D.accountFreeFailures; i += 1) failOnce(limiter, keys('c1', 'local:v@x'));
    assert.equal(refusal(limiter.admit(keys('c1', 'local:v@x'))).report, true);
    assert.equal(refusal(limiter.admit(keys('c1', 'local:v@x'))).report, false);
    clock.advance(SECOND);
    failOnce(limiter, keys('c1', 'local:v@x'));
    assert.equal(refusal(limiter.admit(keys('c1', 'local:v@x'))).report, false);
    clock.advance(D.reportIntervalMs);
    const a = limiter.admit(keys('c1', 'local:v@x'));
    if (a.allowed) a.attempt.fail();
    assert.equal(refusal(limiter.admit(keys('c1', 'local:v@x'))).report, true);
  });
});

describe('memory bounds, sweep and operator unlock', () => {
  it('never tracks more than maxTrackedKeys pairs; the least recently used is evicted', () => {
    const { limiter } = setup({ maxTrackedKeys: 3, clientMaxFailures: 1000 });
    for (let i = 0; i < D.accountFreeFailures; i += 1) failOnce(limiter, keys('c1', 'local:old@x'));
    assert.equal(limiter.admit(keys('c1', 'local:old@x')).allowed, false);
    for (const n of ['a', 'b', 'c']) failOnce(limiter, keys('c1', `local:${n}@x`));
    const stats = limiter.stats();
    assert.equal(stats.pairs, 3);
    assert.ok(stats.clients <= 3);
    // The blocked pair was the least recently used one, so it fell out.
    assert.equal(limiter.admit(keys('c1', 'local:old@x')).allowed, true);
  });

  it('client keys are bounded the same way', () => {
    const { limiter } = setup({ maxTrackedKeys: 5 });
    for (let i = 0; i < 50; i += 1) failOnce(limiter, keys(`client-${String(i)}`, `local:${String(i)}@x`));
    assert.ok(limiter.stats().clients <= 5);
    assert.ok(limiter.stats().pairs <= 5);
  });

  it('sweep() drops drained clients and expired pairs; admit() sweeps on its own too', () => {
    const { limiter, clock } = setup();
    failOnce(limiter, keys('c1', 'local:a@x'));
    failOnce(limiter, keys('c2', 'local:b@x'));
    assert.deepEqual(
      { clients: limiter.stats().clients, pairs: limiter.stats().pairs },
      { clients: 2, pairs: 2 },
    );
    clock.advance(D.accountStateTtlMs);
    limiter.sweep();
    assert.deepEqual(
      { clients: limiter.stats().clients, pairs: limiter.stats().pairs },
      { clients: 0, pairs: 0 },
    );

    failOnce(limiter, keys('c3', 'local:c@x'));
    clock.advance(D.accountStateTtlMs + D.sweepIntervalMs);
    // No explicit sweep: a router built without the index.ts interval still stays bounded.
    const a = limiter.admit(keys('c4', 'local:d@x'));
    if (a.allowed) a.attempt.fail();
    assert.equal(limiter.stats().pairs, 1);
  });

  it('clearAccount() removes every pair of that account and nothing else', () => {
    const { limiter } = setup();
    for (const client of ['c1', 'c2']) {
      for (let i = 0; i < D.accountFreeFailures; i += 1) failOnce(limiter, keys(client, 'local:v@x'));
      assert.equal(limiter.admit(keys(client, 'local:v@x')).allowed, false);
    }
    for (let i = 0; i < D.accountFreeFailures; i += 1) failOnce(limiter, keys('c1', 'local:w@x'));
    limiter.clearAccount('local:v@x');
    assert.equal(limiter.admit(keys('c1', 'local:v@x')).allowed, true);
    assert.equal(limiter.admit(keys('c2', 'local:v@x')).allowed, true);
    assert.equal(limiter.admit(keys('c1', 'local:w@x')).allowed, false);
  });

  it('an attempt settled after clearAccount() does not resurrect or corrupt state', () => {
    const { limiter } = setup();
    for (let i = 0; i < 4; i += 1) failOnce(limiter, keys('c1', 'local:v@x'));
    const inFlight = limiter.admit(keys('c1', 'local:v@x'));
    assert.equal(inFlight.allowed, true);
    limiter.clearAccount('local:v@x');
    if (inFlight.allowed) inFlight.attempt.fail();
    for (let i = 0; i < D.accountFreeFailures; i += 1) failOnce(limiter, keys('c1', 'local:v@x'));
    assert.equal(limiter.stats().inFlight, 0);
  });
});

describe('account keys', () => {
  it('normalise like the users table (trim + lower-case) and namespace by provider', () => {
    assert.equal(loginAccountKey('local', ' Admin@Example.COM '), 'local:admin@example.com');
    assert.equal(loginAccountKey('local', 'admin@example.com'), 'local:admin@example.com');
  });

  it("collapse a missing, empty or oversized id to '-'", () => {
    assert.equal(loginAccountKey('local', undefined), 'local:-');
    assert.equal(loginAccountKey('local', '   '), 'local:-');
    assert.equal(loginAccountKey('local', `${'a'.repeat(250)}@x.de`), 'local:-');
  });

  it('read the account id from the login body: email, else username', () => {
    assert.equal(readLoginAccountId({ email: 'a@x', password: 'p' }), 'a@x');
    assert.equal(readLoginAccountId({ username: 'bob', password: 'p' }), 'bob');
    assert.equal(readLoginAccountId({ email: 42 }), undefined);
    assert.equal(readLoginAccountId(undefined), undefined);
    assert.equal(readLoginAccountId('a@x'), undefined);
  });
});
