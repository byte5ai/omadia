/**
 * Tests for the provider factory (phase 4): resolveLlmProvider builds the right
 * adapter from a scope's vault credentials by configured provider id, returning
 * undefined when no key is set (so the caller skips publishing, as before).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { registerAnthropicAdapter } from '@omadia/llm-adapter-anthropic';
import { registerOpenAiAdapter } from '@omadia/llm-adapter-openai';
import {
  defaultLlmAdapters,
  knownProviderBaseUrl,
  resolveLlmProvider,
} from '@omadia/llm-provider';

// resolveLlmProvider resolves via the wire-format adapter registry; the app
// registers the bundled adapters at boot. Tests run without boot, so register
// them into the process-default registry here (idempotent).
registerAnthropicAdapter(defaultLlmAdapters);
registerOpenAiAdapter(defaultLlmAdapters);

function vaultGet(store: Record<string, string>) {
  return (key: string): Promise<string | undefined> =>
    Promise.resolve(store[key]);
}

test('anthropic: builds the Anthropic provider from the canonical key', async () => {
  const p = await resolveLlmProvider({
    providerId: 'anthropic',
    getSecret: vaultGet({ 'provider:anthropic/api_key': 'sk-ant-x' }),
    maxRetries: 5,
  });
  assert.equal(p?.id, 'anthropic');
});

test('anthropic: falls back to the legacy key (existing installs)', async () => {
  const p = await resolveLlmProvider({
    providerId: 'anthropic',
    getSecret: vaultGet({ anthropic_api_key: 'sk-ant-legacy' }),
  });
  assert.equal(p?.id, 'anthropic');
});

test('anthropic: undefined when no key is configured', async () => {
  const p = await resolveLlmProvider({
    providerId: 'anthropic',
    getSecret: vaultGet({}),
  });
  assert.equal(p, undefined);
});

test('openai: builds the OpenAI provider from the canonical key', async () => {
  const p = await resolveLlmProvider({
    providerId: 'openai',
    getSecret: vaultGet({ 'provider:openai/api_key': 'sk-openai' }),
  });
  assert.equal(p?.id, 'openai');
});

test('openai: no legacy fallback — a flat openai_api_key is ignored', async () => {
  const p = await resolveLlmProvider({
    providerId: 'openai',
    getSecret: vaultGet({ openai_api_key: 'sk-ignored' }),
  });
  assert.equal(p, undefined);
});

test('openai-compatible: baseURL yields the openai-compatible id', async () => {
  const p = await resolveLlmProvider({
    providerId: 'openai-compatible',
    getSecret: vaultGet({ 'provider:openai-compatible/api_key': 'x' }),
    baseURL: 'http://localhost:11434/v1',
  });
  assert.equal(p?.id, 'openai-compatible');
});

test('custom compatible id is preserved on the provider', async () => {
  const p = await resolveLlmProvider({
    providerId: 'my-local-llm',
    getSecret: vaultGet({ 'provider:my-local-llm/api_key': 'x' }),
    baseURL: 'http://localhost:8000/v1',
  });
  assert.equal(p?.id, 'my-local-llm');
});

test('knownProviderBaseUrl: mistral has a default endpoint; openai/anthropic/unknown do not', () => {
  assert.equal(knownProviderBaseUrl('mistral'), 'https://api.mistral.ai/v1');
  assert.equal(knownProviderBaseUrl('openai'), undefined);
  assert.equal(knownProviderBaseUrl('anthropic'), undefined);
  assert.equal(knownProviderBaseUrl('totally-custom'), undefined);
});

test('mistral: builds WITHOUT an explicit baseURL (known default is applied)', async () => {
  const p = await resolveLlmProvider({
    providerId: 'mistral',
    getSecret: vaultGet({ 'provider:mistral/api_key': 'x' }),
  });
  // No baseURL passed, yet it resolves (default api.mistral.ai/v1) and keeps
  // its own id — it routes to the OpenAI-compatible adapter, not Anthropic.
  assert.equal(p?.id, 'mistral');
});

test('an explicit baseURL still overrides the known default (self-hosted gateway)', async () => {
  const p = await resolveLlmProvider({
    providerId: 'mistral',
    getSecret: vaultGet({ 'provider:mistral/api_key': 'x' }),
    baseURL: 'https://mistral.internal.acme.example/v1',
  });
  assert.equal(p?.id, 'mistral');
});

test('a non-openai id with NO known baseURL default still throws (no silent api.openai.com)', async () => {
  // openai-compatible and arbitrary custom ids have no default → must throw.
  await assert.rejects(
    () =>
      resolveLlmProvider({
        providerId: 'openai-compatible',
        getSecret: vaultGet({ 'provider:openai-compatible/api_key': 'x' }),
      }),
    /requires a baseURL/,
  );
  await assert.rejects(
    () =>
      resolveLlmProvider({
        providerId: 'my-local-llm',
        getSecret: vaultGet({ 'provider:my-local-llm/api_key': 'x' }),
      }),
    /requires a baseURL/,
  );
});

test('a missing key short-circuits before the baseURL guard', async () => {
  // No key configured → undefined (skip), never reaching the baseURL check.
  const p = await resolveLlmProvider({
    providerId: 'openai-compatible',
    getSecret: vaultGet({}),
  });
  assert.equal(p, undefined);
});
