/**
 * Tests for the provider credential vault-key scheme (phase 4 of
 * docs/plans/llm-provider-interface-plan.md): canonical key naming + the
 * non-destructive canonical-then-legacy read that guarantees existing Anthropic
 * installs never lose their key.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  legacyProviderApiKeyVaultKey,
  providerApiKeyVaultKey,
  readProviderApiKey,
} from '@omadia/llm-provider';

function vaultGet(store: Record<string, string>) {
  return (key: string): Promise<string | undefined> =>
    Promise.resolve(store[key]);
}

test('providerApiKeyVaultKey produces provider-namespaced keys', () => {
  assert.equal(providerApiKeyVaultKey('anthropic'), 'provider:anthropic/api_key');
  assert.equal(providerApiKeyVaultKey('openai'), 'provider:openai/api_key');
  assert.equal(
    providerApiKeyVaultKey('openai-compatible'),
    'provider:openai-compatible/api_key',
  );
});

test('legacyProviderApiKeyVaultKey only exists for anthropic', () => {
  assert.equal(legacyProviderApiKeyVaultKey('anthropic'), 'anthropic_api_key');
  assert.equal(legacyProviderApiKeyVaultKey('openai'), undefined);
});

test('readProviderApiKey prefers the canonical key', async () => {
  const get = vaultGet({
    'provider:anthropic/api_key': 'sk-ant-canonical',
    anthropic_api_key: 'sk-ant-legacy',
  });
  assert.equal(await readProviderApiKey(get, 'anthropic'), 'sk-ant-canonical');
});

test('readProviderApiKey falls back to the legacy key (existing installs)', async () => {
  const get = vaultGet({ anthropic_api_key: 'sk-ant-legacy' });
  assert.equal(await readProviderApiKey(get, 'anthropic'), 'sk-ant-legacy');
});

test('readProviderApiKey treats a blank canonical value as absent and falls back', async () => {
  const get = vaultGet({
    'provider:anthropic/api_key': '   ',
    anthropic_api_key: 'sk-ant-legacy',
  });
  assert.equal(await readProviderApiKey(get, 'anthropic'), 'sk-ant-legacy');
});

test('readProviderApiKey trims and returns undefined when nothing is set', async () => {
  assert.equal(await readProviderApiKey(vaultGet({}), 'anthropic'), undefined);
  const get = vaultGet({ 'provider:anthropic/api_key': '  sk-ant-x  ' });
  assert.equal(await readProviderApiKey(get, 'anthropic'), 'sk-ant-x');
});

test('readProviderApiKey has NO legacy fallback for non-Anthropic providers', async () => {
  // openai only ever uses the canonical key; a stray flat key is not read.
  const get = vaultGet({ openai_api_key: 'sk-should-be-ignored' });
  assert.equal(await readProviderApiKey(get, 'openai'), undefined);
  const get2 = vaultGet({ 'provider:openai/api_key': 'sk-openai' });
  assert.equal(await readProviderApiKey(get2, 'openai'), 'sk-openai');
});
