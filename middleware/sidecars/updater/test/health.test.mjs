import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { waitForHealthyVersion } from '../src/health.mjs';

/** Deterministic clock so the timeout path never depends on wall time. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
}

describe('waitForHealthyVersion (#432)', () => {
  it('passes once the NEW version is actually serving', async () => {
    const clock = fakeClock();
    let attempts = 0;
    const result = await waitForHealthyVersion({
      url: 'http://middleware:8080/health',
      expectVersion: 'v0.75.0',
      ...clock,
      probeImpl: async () => {
        attempts += 1;
        // The old build answers first — restarting takes a moment.
        return attempts < 3
          ? { ok: true, version: 'v0.74.0' }
          : { ok: true, version: 'v0.75.0' };
      },
    });

    assert.deepEqual(result, {
      ok: true,
      reason: 'version_match',
      observedVersion: 'v0.75.0',
    });
    assert.equal(attempts, 3);
  });

  it('does NOT pass while the old version is still answering', async () => {
    const clock = fakeClock();
    const result = await waitForHealthyVersion({
      url: 'http://middleware:8080/health',
      expectVersion: 'v0.75.0',
      timeoutMs: 30_000,
      ...clock,
      probeImpl: async () => ({ ok: true, version: 'v0.74.0' }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'version_never_matched');
    assert.equal(result.observedVersion, 'v0.74.0');
  });

  it('reports unreachable separately from wrong-version', async () => {
    const clock = fakeClock();
    const result = await waitForHealthyVersion({
      url: 'http://middleware:8080/health',
      expectVersion: 'v0.75.0',
      timeoutMs: 10_000,
      ...clock,
      probeImpl: async () => ({ ok: false, version: null }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'never_reachable');
  });

  it('accepts reachability alone for an unstamped (locally built) image', async () => {
    const clock = fakeClock();
    const logs = [];
    const result = await waitForHealthyVersion({
      url: 'http://middleware:8080/health',
      expectVersion: 'v0.75.0',
      ...clock,
      log: (m) => logs.push(m),
      probeImpl: async () => ({ ok: true, version: null }),
    });

    assert.equal(result.ok, true);
    assert.equal(result.reason, 'reachable_unstamped');
    assert.ok(
      logs.some((l) => l.includes('no version stamp')),
      'the weaker guarantee has to be visible in the step trail',
    );
  });
});
