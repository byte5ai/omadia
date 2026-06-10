import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { PlanScopeCache } from '../src/routes/planScopeCache.js';

// #133 — TTL cache backing the dev graph `/plans` overlay. Clock is injected
// so expiry is deterministic (no real timers).

describe('PlanScopeCache', () => {
  it('returns a cached value within the TTL window', () => {
    let now = 1000;
    const cache = new PlanScopeCache<number[]>({ ttlMs: 500, now: () => now });
    cache.set('sess-A', [1, 2, 3]);
    now = 1400; // < 1000 + 500
    assert.deepEqual(cache.get('sess-A'), [1, 2, 3]);
  });

  it('expires (and evicts) an entry once the TTL elapses', () => {
    let now = 1000;
    const cache = new PlanScopeCache<number[]>({ ttlMs: 500, now: () => now });
    cache.set('sess-A', [1]);
    assert.equal(cache.size, 1);
    now = 1500; // == expiresAt → expired (>= boundary)
    assert.equal(cache.get('sess-A'), undefined);
    assert.equal(cache.size, 0, 'expired entry is evicted on read');
  });

  it('isolates scopes and misses unknown ones', () => {
    const cache = new PlanScopeCache<string>({ ttlMs: 1000, now: () => 0 });
    cache.set('a', 'A');
    cache.set('b', 'B');
    assert.equal(cache.get('a'), 'A');
    assert.equal(cache.get('b'), 'B');
    assert.equal(cache.get('c'), undefined);
  });

  it('invalidate(scope) drops one entry; invalidate() clears all', () => {
    const cache = new PlanScopeCache<string>({ ttlMs: 1000, now: () => 0 });
    cache.set('a', 'A');
    cache.set('b', 'B');
    cache.invalidate('a');
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.get('b'), 'B');
    cache.invalidate();
    assert.equal(cache.size, 0);
    assert.equal(cache.get('b'), undefined);
  });
});
