/**
 * #1080 — a credential written to the orchestrator's vault scope reaches the
 * kernel provider pool: a key saved after a keyless boot arms the provider
 * without a restart, a rotation re-resolves, a removal revokes, and an API-key
 * change resets that provider's breaker.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createLlmProviderPool, readProviderApiKey } from '@omadia/llm-provider';
import type { LlmProvider } from '@omadia/llm-provider-api';

import {
  classifyProviderCredentialKey,
  createProviderPoolCredentialListener,
  type InvalidatablePool,
} from '../src/platform/providerPoolInvalidation.js';
import { InMemorySecretVault } from '../src/secrets/vault.js';

const SCOPE = '@omadia/orchestrator';

interface SpyPool extends InvalidatablePool {
  readonly calls: string[];
}

function spyPool(unhealthy: readonly string[] = []): SpyPool {
  const calls: string[] = [];
  return {
    calls,
    invalidate: (id) => calls.push(`invalidate:${id}`),
    invalidateAll: () => calls.push('invalidateAll'),
    health: {
      markHealthy: (id) => calls.push(`markHealthy:${id}`),
      snapshot: () =>
        unhealthy.map((providerId) => ({
          providerId,
          cooldownUntil: Number.MAX_SAFE_INTEGER,
          reason: 'test',
          failedAt: 0,
        })),
    },
  };
}

function listen(pool: InvalidatablePool): ReturnType<typeof createProviderPoolCredentialListener> {
  return createProviderPoolCredentialListener({ pool, scope: SCOPE, log: () => {} });
}

describe('#1080 — classifyProviderCredentialKey', () => {
  it('recognises api keys (canonical + legacy) and the oauth access token only', () => {
    assert.deepEqual(classifyProviderCredentialKey('provider:anthropic/api_key'), {
      providerId: 'anthropic',
      kind: 'api_key',
    });
    assert.deepEqual(classifyProviderCredentialKey('anthropic_api_key'), {
      providerId: 'anthropic',
      kind: 'api_key',
    });
    assert.deepEqual(classifyProviderCredentialKey('provider:openai-chatgpt/oauth_access_token'), {
      providerId: 'openai-chatgpt',
      kind: 'oauth_access',
    });
    for (const ignored of [
      'provider:anthropic/verified_at',
      'provider:openai-chatgpt/oauth_refresh_token',
      'provider:openai-chatgpt/oauth_expires_at',
      'provider:openai-chatgpt/oauth_updated_at',
      'llm_provider',
      'openai_api_key',
    ]) {
      assert.equal(classifyProviderCredentialKey(ignored), undefined, ignored);
    }
  });
});

describe('#1080 — provider pool credential listener (spy pool)', () => {
  it('an api-key write invalidates that provider and resets its breaker', () => {
    const pool = spyPool();
    listen(pool)({ scope: SCOPE, keys: ['provider:anthropic/api_key'] });
    assert.deepEqual(pool.calls, ['invalidate:anthropic', 'markHealthy:anthropic']);
  });

  it('the legacy anthropic_api_key maps to anthropic', () => {
    const pool = spyPool();
    listen(pool)({ scope: SCOPE, keys: ['anthropic_api_key'] });
    assert.deepEqual(pool.calls, ['invalidate:anthropic', 'markHealthy:anthropic']);
  });

  it('an oauth access-token write invalidates without touching the breaker', () => {
    const pool = spyPool();
    listen(pool)({ scope: SCOPE, keys: ['provider:openai/oauth_access_token'] });
    assert.deepEqual(pool.calls, ['invalidate:openai']);
  });

  it('verified_at and the other oauth leaves are no-ops', () => {
    const pool = spyPool();
    listen(pool)({
      scope: SCOPE,
      keys: [
        'provider:x/verified_at',
        'provider:x/oauth_refresh_token',
        'provider:x/oauth_expires_at',
        'provider:x/oauth_updated_at',
      ],
    });
    assert.deepEqual(pool.calls, []);
  });

  it('a write to another scope is ignored', () => {
    const pool = spyPool();
    listen(pool)({ scope: '@omadia/verifier', keys: ['provider:anthropic/api_key'] });
    listen(pool)({ scope: '@omadia/verifier', purged: true });
    assert.deepEqual(pool.calls, []);
  });

  it('a batch touching both leaves of one provider invalidates once and resets', () => {
    const pool = spyPool();
    listen(pool)({
      scope: SCOPE,
      keys: ['provider:openai/oauth_access_token', 'provider:openai/api_key'],
    });
    assert.deepEqual(pool.calls, ['invalidate:openai', 'markHealthy:openai']);
  });

  it('a purge drops everything and clears every breaker', () => {
    const pool = spyPool(['anthropic', 'openai']);
    listen(pool)({ scope: SCOPE, purged: true });
    assert.deepEqual(pool.calls, [
      'invalidateAll',
      'markHealthy:anthropic',
      'markHealthy:openai',
    ]);
  });
});

describe('#1080 — real vault + real pool', () => {
  function setup(): {
    vault: InMemorySecretVault;
    pool: ReturnType<typeof createLlmProviderPool>;
  } {
    const vault = new InMemorySecretVault();
    const pool = createLlmProviderPool(
      { getSecret: (k) => vault.get(SCOPE, k) },
      // Same credential read as the real factory, without building an SDK client.
      async (opts) => {
        const key = await readProviderApiKey(opts.getSecret, opts.providerId);
        return key === undefined
          ? undefined
          : ({ id: opts.providerId, key } as unknown as LlmProvider);
      },
    );
    vault.onWrite(listen(pool));
    return { vault, pool };
  }

  const keyOf = (p: LlmProvider | undefined): string | undefined =>
    (p as unknown as { key?: string } | undefined)?.key;

  it('a key saved after a keyless boot arms the provider without a restart', async () => {
    const { vault, pool } = setup();
    assert.equal(await pool.get('anthropic'), undefined, 'boot without a key');
    await vault.setMany(SCOPE, { 'provider:anthropic/api_key': 'sk-ant-A' });
    assert.equal(keyOf(await pool.get('anthropic')), 'sk-ant-A');
  });

  it('a rotated key re-resolves and a removed key revokes', async () => {
    const { vault, pool } = setup();
    await vault.set(SCOPE, 'provider:anthropic/api_key', 'sk-ant-A');
    assert.equal(keyOf(await pool.get('anthropic')), 'sk-ant-A');
    await vault.set(SCOPE, 'provider:anthropic/api_key', 'sk-ant-B');
    assert.equal(keyOf(await pool.get('anthropic')), 'sk-ant-B');
    await vault.deleteKey(SCOPE, 'provider:anthropic/api_key');
    assert.equal(await pool.get('anthropic'), undefined);
  });

  it('an uninstall purge revokes every provider of the scope', async () => {
    const { vault, pool } = setup();
    await vault.set(SCOPE, 'provider:openai/api_key', 'sk-o');
    assert.notEqual(await pool.get('openai'), undefined);
    await vault.purge(SCOPE);
    assert.equal(await pool.get('openai'), undefined);
  });

  it('an api-key change clears the breaker; an oauth rotation does not', async () => {
    const { vault, pool } = setup();
    pool.health.markFailed('anthropic', '401');
    await vault.set(SCOPE, 'provider:anthropic/oauth_access_token', 'tok');
    assert.equal(pool.health.inCooldown('anthropic'), true);
    await vault.set(SCOPE, 'provider:anthropic/verified_at', 'now');
    assert.equal(pool.health.inCooldown('anthropic'), true);
    await vault.set(SCOPE, 'provider:anthropic/api_key', 'sk-ant-new');
    assert.equal(pool.health.inCooldown('anthropic'), false);
  });
});
