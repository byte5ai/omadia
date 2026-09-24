/**
 * #1080 / OB-61 — the shared host Anthropic client follows the vault key in
 * BOTH directions: it is armed when a key is saved and revoked (to the env
 * key, or to an unauthenticated client) when the key is removed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSharedAnthropicClientRefresher } from '../src/platform/sharedAnthropicClientRefresher.js';

function harness(opts: { envKey?: string; vaultKey?: string } = {}): {
  applied: string[];
  logs: string[];
  setVault: (k: string | undefined) => void;
  refresh: () => Promise<void>;
} {
  let vaultKey = opts.vaultKey;
  const applied: string[] = [];
  const logs: string[] = [];
  const r = createSharedAnthropicClientRefresher({
    readVaultKey: async () => vaultKey,
    ...(opts.envKey !== undefined ? { envKey: opts.envKey } : {}),
    apply: (k) => applied.push(k),
    log: (m) => logs.push(m),
    logError: (m) => logs.push(m),
  });
  return {
    applied,
    logs,
    setVault: (k) => {
      vaultKey = k;
    },
    refresh: () => r.refresh(),
  };
}

describe('#1080 — shared anthropic client refresher', () => {
  it('no env and no vault key: the boot refresh is a no-op', async () => {
    const h = harness();
    await h.refresh();
    assert.deepEqual(h.applied, []);
  });

  it('arms on a saved key and does not churn on the same key', async () => {
    const h = harness();
    h.setVault('sk-A');
    await h.refresh();
    await h.refresh();
    assert.deepEqual(h.applied, ['sk-A']);
  });

  it('revokes to an unauthenticated client when the key is removed and no env key exists', async () => {
    const h = harness({ vaultKey: 'sk-A' });
    await h.refresh();
    h.setVault(undefined);
    await h.refresh();
    assert.deepEqual(h.applied, ['sk-A', '']);
    assert.match(h.logs.at(-1) ?? '', /revoked/);
  });

  it('revokes to the env key when one is set', async () => {
    const h = harness({ envKey: 'sk-E', vaultKey: 'sk-A' });
    await h.refresh();
    h.setVault(undefined);
    await h.refresh();
    assert.deepEqual(h.applied, ['sk-A', 'sk-E']);
  });

  it('env key equal to the vault key at boot is a no-op', async () => {
    const h = harness({ envKey: 'sk-E', vaultKey: 'sk-E' });
    await h.refresh();
    assert.deepEqual(h.applied, []);
  });

  it('env key only, empty vault: nothing to swap at boot', async () => {
    const h = harness({ envKey: 'sk-E' });
    await h.refresh();
    assert.deepEqual(h.applied, []);
  });

  it('concurrent refreshes are serialized and the last vault state wins', async () => {
    // The first read is slow and returns the OLD key; the second sees the key
    // removed. Unserialized, the slow stale read would be applied last.
    const reads: Array<() => Promise<string | undefined>> = [
      async () => {
        await new Promise((res) => setTimeout(res, 20));
        return 'sk-A';
      },
      async () => undefined,
    ];
    let inFlight = 0;
    let maxInFlight = 0;
    const applied: string[] = [];
    const r = createSharedAnthropicClientRefresher({
      readVaultKey: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          return await (reads.shift() ?? (async () => undefined))();
        } finally {
          inFlight -= 1;
        }
      },
      apply: (k) => applied.push(k),
      log: () => {},
    });
    await Promise.all([r.refresh(), r.refresh()]);
    assert.equal(maxInFlight, 1);
    assert.deepEqual(applied, ['sk-A', '']);
  });

  it('a failing vault read is logged and never rejects', async () => {
    const logs: string[] = [];
    const r = createSharedAnthropicClientRefresher({
      readVaultKey: async () => {
        throw new Error('vault down');
      },
      apply: () => assert.fail('must not apply'),
      log: () => {},
      logError: (m) => logs.push(m),
    });
    await r.refresh();
    assert.equal(logs.length, 1);
  });
});
