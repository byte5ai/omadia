/**
 * Issue #474 (review round 5) — OAuthReadinessTracker.refresh() derives
 * automatic OAuth-connection readiness from the vault, mirroring what
 * `ctx.oauthTokens.get()` (pluginContext.ts) already reads, without
 * requiring the plugin to call `ctx.status.report(...)` itself.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { adaptManifestV1 } from '../../src/plugins/manifestLoader.js';
import type { PluginCatalogEntry } from '../../src/plugins/manifestLoader.js';
import { OAuthReadinessTracker } from '../../src/plugins/oauth/oauthReadinessTracker.js';
import { writeStoredTokens } from '../../src/plugins/oauth/tokenStore.js';
import type { SecretVault } from '../../src/secrets/vault.js';

const ID = '@test/oauth-readiness';

class FakeVault implements SecretVault {
  readonly store = new Map<string, string>();
  async get(agentId: string, key: string): Promise<string | undefined> {
    return this.store.get(`${agentId}::${key}`);
  }
  async set(agentId: string, key: string, value: string): Promise<void> {
    this.store.set(`${agentId}::${key}`, value);
  }
  async setMany(agentId: string, entries: Record<string, string>): Promise<void> {
    for (const [k, v] of Object.entries(entries)) await this.set(agentId, k, v);
  }
  async listKeys(): Promise<string[]> {
    return [];
  }
  async purge(): Promise<void> {}
  async deleteKey(agentId: string, key: string): Promise<void> {
    this.store.delete(`${agentId}::${key}`);
  }
}

function entryWithFields(fields: Array<Record<string, unknown>>): PluginCatalogEntry {
  const plugin = adaptManifestV1({
    schema_version: '1',
    identity: {
      id: ID,
      kind: 'tool',
      domain: 'test',
      name: 'OAuth Readiness Test Plugin',
      version: '0.1.0',
    },
    setup: { fields },
  })!;
  return { plugin, manifest: {}, source_path: '/dev/null', source_kind: 'manifest-v1' };
}

describe('OAuthReadinessTracker', () => {
  it('stays connected for a plugin with no oauth field', async () => {
    const tracker = new OAuthReadinessTracker();
    const entry = entryWithFields([
      { key: 'api_key', type: 'secret', label: 'API Key' },
    ]);
    const vault = new FakeVault();

    await tracker.refresh(ID, entry, vault);

    assert.equal(tracker.isConnected(ID), true);
  });

  it('marks a plugin with an unconnected oauth field as not-ready', async () => {
    const tracker = new OAuthReadinessTracker();
    const entry = entryWithFields([
      { key: 'connection', type: 'oauth', label: 'Connect', provider: 'github' },
    ]);
    const vault = new FakeVault();

    // No tokens ever written — mirrors the exact repro: install completes,
    // activate() runs and registers tools, but Connect was never clicked.
    await tracker.refresh(ID, entry, vault);

    assert.equal(tracker.isConnected(ID), false);
  });

  it('marks a plugin ready once its oauth field has stored tokens', async () => {
    const tracker = new OAuthReadinessTracker();
    const entry = entryWithFields([
      { key: 'connection', type: 'oauth', label: 'Connect', provider: 'github' },
    ]);
    const vault = new FakeVault();
    await writeStoredTokens(vault, ID, 'connection', {
      accessToken: 'tok',
      refreshToken: '',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      scope: '',
    });

    await tracker.refresh(ID, entry, vault);

    assert.equal(tracker.isConnected(ID), true);
  });

  it('requires EVERY declared oauth field to be connected', async () => {
    const tracker = new OAuthReadinessTracker();
    const entry = entryWithFields([
      { key: 'primary', type: 'oauth', label: 'Primary', provider: 'github' },
      { key: 'secondary', type: 'oauth', label: 'Secondary', provider: 'slack' },
    ]);
    const vault = new FakeVault();
    await writeStoredTokens(vault, ID, 'primary', {
      accessToken: 'tok',
      refreshToken: '',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      scope: '',
    });
    // 'secondary' never connected.

    await tracker.refresh(ID, entry, vault);

    assert.equal(tracker.isConnected(ID), false);
  });

  it('re-derives on every refresh (self-heals after Connect completes)', async () => {
    const tracker = new OAuthReadinessTracker();
    const entry = entryWithFields([
      { key: 'connection', type: 'oauth', label: 'Connect', provider: 'github' },
    ]);
    const vault = new FakeVault();

    await tracker.refresh(ID, entry, vault);
    assert.equal(tracker.isConnected(ID), false);

    // Simulate the Connect flow completing, then the post-callback
    // reactivate() re-running activate() → refresh().
    await writeStoredTokens(vault, ID, 'connection', {
      accessToken: 'tok',
      refreshToken: '',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      scope: '',
    });
    await tracker.refresh(ID, entry, vault);

    assert.equal(tracker.isConnected(ID), true);
  });

  it('clear() resets a plugin back to connected', async () => {
    const tracker = new OAuthReadinessTracker();
    const entry = entryWithFields([
      { key: 'connection', type: 'oauth', label: 'Connect', provider: 'github' },
    ]);
    const vault = new FakeVault();
    await tracker.refresh(ID, entry, vault);
    assert.equal(tracker.isConnected(ID), false);

    tracker.clear(ID);

    assert.equal(tracker.isConnected(ID), true);
  });

  it('treats an unknown plugin (no catalog entry) as connected — nothing to gate', async () => {
    const tracker = new OAuthReadinessTracker();
    const vault = new FakeVault();

    await tracker.refresh(ID, undefined, vault);

    assert.equal(tracker.isConnected(ID), true);
  });

  /**
   * Issue #474 (review round 10) — `refresh()` previously treated
   * `tokens !== undefined` alone as "connected", i.e. it only checked that
   * SOME token bundle was stored, not that it was actually usable.
   * `ctx.oauthTokens.get()` (pluginContext.ts) throws
   * `OAuthTokenError('refresh_failed')` for an expired token with no refresh
   * token — that plugin's tool must not be reported ready either.
   */
  it('marks a plugin with an expired, non-refreshable token as NOT ready', async () => {
    const tracker = new OAuthReadinessTracker();
    const entry = entryWithFields([
      { key: 'connection', type: 'oauth', label: 'Connect', provider: 'github' },
    ]);
    const vault = new FakeVault();
    // Concrete failing input from the review: expired, empty refresh token.
    await writeStoredTokens(vault, ID, 'connection', {
      accessToken: 'old',
      refreshToken: '',
      expiresAt: '2020-01-01T00:00:00.000Z',
      scope: '',
    });

    await tracker.refresh(ID, entry, vault);

    assert.equal(tracker.isConnected(ID), false);
  });

  it('keeps a plugin with an expired BUT refreshable token ready (refresh is expected to succeed transparently)', async () => {
    const tracker = new OAuthReadinessTracker();
    const entry = entryWithFields([
      { key: 'connection', type: 'oauth', label: 'Connect', provider: 'github' },
    ]);
    const vault = new FakeVault();
    await writeStoredTokens(vault, ID, 'connection', {
      accessToken: 'old',
      refreshToken: 'has-a-refresh-token',
      expiresAt: '2020-01-01T00:00:00.000Z',
      scope: '',
    });

    await tracker.refresh(ID, entry, vault);

    assert.equal(tracker.isConnected(ID), true);
  });

  it('keeps a plugin with a valid, unexpired token ready', async () => {
    const tracker = new OAuthReadinessTracker();
    const entry = entryWithFields([
      { key: 'connection', type: 'oauth', label: 'Connect', provider: 'github' },
    ]);
    const vault = new FakeVault();
    await writeStoredTokens(vault, ID, 'connection', {
      accessToken: 'fresh',
      refreshToken: '',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      scope: '',
    });

    await tracker.refresh(ID, entry, vault);

    assert.equal(tracker.isConnected(ID), true);
  });

  /**
   * Issue #474 (review round 12) — `isConnected()` must re-evaluate
   * freshness against the CURRENT wall clock on every call, not read a
   * boolean verdict computed once inside `refresh()`. Concrete failing
   * input the review gave: a token with 10 minutes of freshness left and no
   * refresh token activates (caches "ready"); 6 minutes later — no new
   * activate()/refresh() call — the token is inside `ctx.oauthTokens.get()`'s
   * 5-minute refresh margin, where a real call would throw
   * `OAuthTokenError('refresh_failed')`. A purely activation-cached boolean
   * would still report ready for that entire window; this test proves the
   * tracker doesn't. Uses `t.mock.timers` (already the repo convention — see
   * office.test.ts) instead of a real sleep so the assertion is
   * deterministic.
   */
  it('isConnected() flips to false once the cached token crosses into its refresh margin — WITHOUT a new refresh() call', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    try {
      const tracker = new OAuthReadinessTracker();
      const entry = entryWithFields([
        { key: 'connection', type: 'oauth', label: 'Connect', provider: 'github' },
      ]);
      const vault = new FakeVault();
      // 10 minutes of freshness left, no refresh token — exactly the review's
      // concrete failing input.
      await writeStoredTokens(vault, ID, 'connection', {
        accessToken: 'tok',
        refreshToken: '',
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        scope: '',
      });

      // Single activation — mirrors ToolPluginRuntime/DynamicAgentRuntime's
      // activate() calling refresh() once.
      await tracker.refresh(ID, entry, vault);
      assert.equal(
        tracker.isConnected(ID),
        true,
        'ready immediately after activation, 10 minutes of freshness left',
      );

      // Advance the clock 6 minutes — now inside tokenStore.ts's 5-minute
      // OAUTH_REFRESH_MARGIN_MS — WITHOUT calling refresh() again.
      t.mock.timers.tick(6 * 60_000);

      assert.equal(
        tracker.isConnected(ID),
        false,
        'must recompute freshness at read time, not serve the activation-time verdict',
      );
    } finally {
      t.mock.timers.reset();
    }
  });
});
