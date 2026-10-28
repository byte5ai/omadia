import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  providerCredentialPurgeBlocker,
  isProviderCredentialKey,
  LLM_CREDENTIAL_SCOPES,
  purgeProviderCredentials,
} from '../src/platform/providerCredentialPurge.js';
import { InMemorySecretVault } from '../src/secrets/vault.js';

/**
 * #1468 — uninstalling a provider plugin must take the key it left in the
 * three LLM scopes with it, and nothing else.
 */
describe('#1468 — purgeProviderCredentials', () => {
  async function seeded(): Promise<InMemorySecretVault> {
    const vault = new InMemorySecretVault();
    for (const scope of LLM_CREDENTIAL_SCOPES) {
      await vault.setMany(scope, {
        'provider:ollama/api_key': 'ollama-test-123',
        'provider:ollama/verified_at': '2026-10-27T08:16:44Z',
        'provider:ollama/oauth_refresh_token': 'r',
        'provider:ollama-cloud/api_key': 'keep-prefix-sibling',
        'provider:anthropic/api_key': 'keep-other-provider',
        anthropic_api_key: 'keep-legacy',
      });
    }
    await vault.setMany('@omadia/plugin-llm-ollama', {
      'provider:ollama/api_key': 'not-an-llm-scope',
    });
    return vault;
  }

  it('removes every provider:<id>/* leaf from all three LLM scopes, nothing else', async () => {
    const vault = await seeded();
    const removed = await purgeProviderCredentials(vault, 'ollama');

    assert.equal(removed.length, 9);
    for (const scope of LLM_CREDENTIAL_SCOPES) {
      assert.deepEqual((await vault.listKeys(scope)).sort(), [
        'anthropic_api_key',
        'provider:anthropic/api_key',
        'provider:ollama-cloud/api_key',
      ]);
    }
    assert.deepEqual(await vault.listKeys('@omadia/plugin-llm-ollama'), [
      'provider:ollama/api_key',
    ]);
    // Names only — a value never reaches the log line.
    assert.ok(!removed.join(' ').includes('ollama-test-123'));
  });

  it('keeps purging the other scopes when one cannot be read', async () => {
    const vault = await seeded();
    const failing = {
      listKeys: (scope: string) =>
        scope === '@omadia/verifier'
          ? Promise.reject(new Error('locked'))
          : vault.listKeys(scope),
      deleteKey: (scope: string, key: string) => vault.deleteKey(scope, key),
    };
    const errors: string[] = [];
    const removed = await purgeProviderCredentials(failing, 'ollama', {
      onError: (scope) => errors.push(scope),
    });
    assert.equal(removed.length, 6);
    assert.deepEqual(errors, ['@omadia/verifier']);
  });

  it('refuses an empty or nested id instead of widening the match', async () => {
    const vault = await seeded();
    assert.deepEqual(await purgeProviderCredentials(vault, ''), []);
    assert.deepEqual(await purgeProviderCredentials(vault, 'ollama/x'), []);
    assert.equal(isProviderCredentialKey('provider:ollama/a/b', 'ollama'), false);
    assert.equal(isProviderCredentialKey('provider:ollama/', 'ollama'), false);
  });

  it('is blocked for a built-in id and for an id another installed plugin declares', () => {
    const builtinIds = new Set(['anthropic', 'openai-chatgpt']);
    assert.match(
      providerCredentialPurgeBlocker('openai-chatgpt', { builtinIds, otherPluginsDeclaring: [] }) ?? '',
      /built-in/,
    );
    assert.match(
      providerCredentialPurgeBlocker('minimax', {
        builtinIds,
        otherPluginsDeclaring: ['@acme/minimax-fork'],
      }) ?? '',
      /@acme\/minimax-fork/,
    );
    assert.equal(
      providerCredentialPurgeBlocker('ollama', { builtinIds, otherPluginsDeclaring: [] }),
      undefined,
    );
  });
});
