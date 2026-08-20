import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { reapOrphanedSandboxes } from '../../packages/harness-sandbox/src/reaper.js';
import { InMemorySandboxRegistry } from '../../packages/harness-sandbox/src/sandboxRegistry.js';
import { resolveAgentComputerProfile } from '../../packages/harness-sandbox/src/agentComputerProfile.js';

/**
 * #576 P3 — reaper tests. Every test supplies `now` explicitly and never lets
 * the reaper derive it — the #709/#710 anchor-independence property is the
 * thing under test as much as the reaping logic itself.
 */

const HOUR_MS = 60 * 60 * 1000;

describe('reapOrphanedSandboxes', () => {
  it('never reaps a persistent sandbox, no matter how idle', async () => {
    const registry = new InMemorySandboxRegistry();
    const longAgo = new Date(Date.now() - 100 * HOUR_MS);
    await registry.upsert({
      scopeKey: 'personal:persistent-user',
      backend: 'docker',
      sandboxRef: 'omadia-sbx-abc',
      profile: resolveAgentComputerProfile({ persistent: true }),
      now: longAgo,
    });
    const teardownCalls: string[] = [];
    const result = await reapOrphanedSandboxes({
      registry,
      teardown: async (ref) => {
        teardownCalls.push(ref);
      },
      now: new Date(),
      idleThresholdMs: HOUR_MS,
    });
    assert.deepEqual(result.reapedScopeKeys, []);
    assert.deepEqual(teardownCalls, []);
    assert.ok(await registry.get('personal:persistent-user'), 'entry must remain registered');
  });

  it('reaps a non-persistent sandbox idle past the threshold', async () => {
    const registry = new InMemorySandboxRegistry();
    const longAgo = new Date(Date.now() - 2 * HOUR_MS);
    await registry.upsert({
      scopeKey: 'personal:idle-user',
      backend: 'docker',
      sandboxRef: 'omadia-sbx-idle',
      profile: resolveAgentComputerProfile({ persistent: false }),
      now: longAgo,
    });
    const teardownCalls: string[] = [];
    const result = await reapOrphanedSandboxes({
      registry,
      teardown: async (ref) => {
        teardownCalls.push(ref);
      },
      now: new Date(),
      idleThresholdMs: HOUR_MS,
    });
    assert.deepEqual(result.reapedScopeKeys, ['personal:idle-user']);
    assert.deepEqual(teardownCalls, ['omadia-sbx-idle']);
    assert.equal(await registry.get('personal:idle-user'), undefined, 'entry must be removed after reaping');
  });

  it('does NOT reap a non-persistent sandbox still within the idle threshold', async () => {
    const registry = new InMemorySandboxRegistry();
    const recentlyUsed = new Date(Date.now() - 5_000); // 5 seconds ago
    await registry.upsert({
      scopeKey: 'personal:active-user',
      backend: 'docker',
      sandboxRef: 'omadia-sbx-active',
      profile: resolveAgentComputerProfile({ persistent: false }),
      now: recentlyUsed,
    });
    const result = await reapOrphanedSandboxes({
      registry,
      teardown: async () => undefined,
      now: new Date(),
      idleThresholdMs: HOUR_MS,
    });
    assert.deepEqual(result.reapedScopeKeys, []);
    assert.ok(await registry.get('personal:active-user'));
  });

  it('the anchor is the CALLER-supplied `now`, not anything derived from the entries', async () => {
    // Regression guard for the #709/#710 self-referential-clock bug: if the
    // reaper ever "helpfully" computed now from e.g. the newest lastUsedAt in
    // the registry, this test would start failing the moment there is only
    // one entry (now === that entry's own lastUsedAt => never idle). Passing
    // an explicit `now` far in the future proves the anchor is external.
    const registry = new InMemorySandboxRegistry();
    const justNow = new Date();
    await registry.upsert({
      scopeKey: 'personal:solo-user',
      backend: 'docker',
      sandboxRef: 'omadia-sbx-solo',
      profile: resolveAgentComputerProfile({ persistent: false }),
      now: justNow,
    });
    const farFuture = new Date(justNow.getTime() + 10 * HOUR_MS);
    const result = await reapOrphanedSandboxes({
      registry,
      teardown: async () => undefined,
      now: farFuture,
      idleThresholdMs: HOUR_MS,
    });
    assert.deepEqual(result.reapedScopeKeys, ['personal:solo-user']);
  });

  it('a teardown failure leaves the registry row intact and is reported as failed, not silently dropped', async () => {
    const registry = new InMemorySandboxRegistry();
    const longAgo = new Date(Date.now() - 2 * HOUR_MS);
    await registry.upsert({
      scopeKey: 'personal:flaky-teardown',
      backend: 'docker',
      sandboxRef: 'omadia-sbx-flaky',
      profile: resolveAgentComputerProfile({ persistent: false }),
      now: longAgo,
    });
    const result = await reapOrphanedSandboxes({
      registry,
      teardown: async () => {
        throw new Error('docker daemon unreachable');
      },
      now: new Date(),
      idleThresholdMs: HOUR_MS,
    });
    assert.deepEqual(result.reapedScopeKeys, []);
    assert.deepEqual(result.failedScopeKeys, ['personal:flaky-teardown']);
    assert.ok(await registry.get('personal:flaky-teardown'), 'entry must survive a failed teardown for retry');
  });

  it('a teardown failure for one entry does not stop the sweep for the rest', async () => {
    const registry = new InMemorySandboxRegistry();
    const longAgo = new Date(Date.now() - 2 * HOUR_MS);
    await registry.upsert({
      scopeKey: 'personal:fails',
      backend: 'docker',
      sandboxRef: 'ref-fails',
      profile: resolveAgentComputerProfile({ persistent: false }),
      now: longAgo,
    });
    await registry.upsert({
      scopeKey: 'personal:succeeds',
      backend: 'docker',
      sandboxRef: 'ref-succeeds',
      profile: resolveAgentComputerProfile({ persistent: false }),
      now: longAgo,
    });
    const result = await reapOrphanedSandboxes({
      registry,
      teardown: async (ref) => {
        if (ref === 'ref-fails') throw new Error('boom');
      },
      now: new Date(),
      idleThresholdMs: HOUR_MS,
    });
    assert.deepEqual(result.reapedScopeKeys, ['personal:succeeds']);
    assert.deepEqual(result.failedScopeKeys, ['personal:fails']);
  });
});
