import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createRateLimiter } from '../../packages/harness-channel-api/src/rateLimiter.js';

describe('channelApi/rateLimiter', () => {
  it('allows up to the configured per-minute capacity, then trips', () => {
    const limiter = createRateLimiter();
    const capacity = 3;
    for (let i = 0; i < capacity; i++) {
      assert.equal(limiter.tryConsume('key-1', capacity), true, `call ${i + 1} within budget`);
    }
    assert.equal(limiter.tryConsume('key-1', capacity), false, 'call over budget is rejected');
  });

  it('tracks each key independently', () => {
    const limiter = createRateLimiter();
    assert.equal(limiter.tryConsume('key-a', 1), true);
    assert.equal(limiter.tryConsume('key-a', 1), false, 'key-a is over budget');
    assert.equal(limiter.tryConsume('key-b', 1), true, 'key-b has its own bucket');
  });
});
