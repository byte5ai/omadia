/**
 * Tests for the provider factory (phase 4): resolveLlmProvider builds the right
 * adapter from a scope's vault credentials by configured provider id, returning
 * undefined when no key is set (so the caller skips publishing, as before).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveLlmProvider } from '@omadia/llm-provider';

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
    providerId: 'mistral',
    getSecret: vaultGet({ 'provider:mistral/api_key': 'x' }),
    baseURL: 'https://api.mistral.ai/v1',
  });
  assert.equal(p?.id, 'mistral');
});

test('non-openai provider without a baseURL throws (no silent api.openai.com)', async () => {
  await assert.rejects(
    () =>
      resolveLlmProvider({
        providerId: 'mistral',
        getSecret: vaultGet({ 'provider:mistral/api_key': 'x' }),
      }),
    /requires a baseURL/,
  );
  await assert.rejects(
    () =>
      resolveLlmProvider({
        providerId: 'openai-compatible',
        getSecret: vaultGet({ 'provider:openai-compatible/api_key': 'x' }),
      }),
    /requires a baseURL/,
  );
});

test('a missing key short-circuits before the baseURL guard', async () => {
  // No key configured → undefined (skip), never reaching the baseURL check.
  const p = await resolveLlmProvider({
    providerId: 'mistral',
    getSecret: vaultGet({}),
  });
  assert.equal(p, undefined);
});
