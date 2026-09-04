/**
 * #1033 W1 — the provider pool memoises per provider id, shares in-flight
 * resolutions, caches a negative answer, and forgets on invalidate.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLlmProviderPool } from '@omadia/llm-provider';
import type { LlmProvider } from '@omadia/llm-provider-api';

function fakeProvider(id: string): LlmProvider {
  return { id } as unknown as LlmProvider;
}

test('resolves once per id and hands the same instance back', async () => {
  const calls: string[] = [];
  const pool = createLlmProviderPool({ getSecret: async () => undefined }, async (opts) => {
    calls.push(opts.providerId);
    return fakeProvider(opts.providerId);
  });
  const a1 = await pool.get('anthropic');
  const a2 = await pool.get('anthropic');
  const o1 = await pool.get('openai');
  assert.equal(a1, a2);
  assert.notEqual(a1, o1);
  assert.deepEqual(calls, ['anthropic', 'openai']);
  assert.deepEqual([...pool.cachedIds()].sort(), ['anthropic', 'openai']);
});

test('concurrent first calls share one resolution', async () => {
  let calls = 0;
  const pool = createLlmProviderPool({ getSecret: async () => undefined }, async (opts) => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 5));
    return fakeProvider(opts.providerId);
  });
  const [x, y] = await Promise.all([pool.get('openai'), pool.get('openai')]);
  assert.equal(x, y);
  assert.equal(calls, 1);
});

test('a negative answer (no key) is cached until invalidated; usable() mirrors it', async () => {
  let keyed = false;
  let calls = 0;
  const pool = createLlmProviderPool({ getSecret: async () => undefined }, async (opts) => {
    calls += 1;
    return keyed ? fakeProvider(opts.providerId) : undefined;
  });
  assert.equal(await pool.usable('mistral'), false);
  assert.equal(await pool.usable('mistral'), false);
  assert.equal(calls, 1, 'the vault is not re-read on every turn');
  keyed = true;
  pool.invalidate('mistral');
  assert.equal(await pool.usable('mistral'), true);
  assert.equal(calls, 2);
  pool.invalidateAll();
  assert.deepEqual(pool.cachedIds(), []);
});

test('a throwing factory does not poison the cache', async () => {
  let attempt = 0;
  const pool = createLlmProviderPool({ getSecret: async () => undefined }, async (opts) => {
    attempt += 1;
    if (attempt === 1) throw new Error('vault unreachable');
    return fakeProvider(opts.providerId);
  });
  await assert.rejects(pool.get('anthropic'), /vault unreachable/);
  assert.equal((await pool.get('anthropic'))?.id, 'anthropic');
});
