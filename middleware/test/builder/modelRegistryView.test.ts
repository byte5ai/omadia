/**
 * Guard for the builder model registry after #297 made it source models from the
 * global `@omadia/llm-provider` registry. With no provider registered (the
 * default test process state) it falls back to the offline Anthropic seed
 * slugs, so the emitted vendor model ids / budgets / labels stay stable for
 * the cold-boot path. With a provider registered (live-discovered or seed)
 * the registry wins — see llmProviderModelRegistry.test.ts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BuilderModelRegistry } from '../../src/plugins/builder/modelRegistry.js';

test('builder slugs emit the offline seed Anthropic model ids + budgets', () => {
  const haiku = BuilderModelRegistry.get('haiku');
  assert.equal(haiku.modelId, 'claude-haiku-4-5-20251001');
  assert.equal(haiku.provider, 'anthropic');
  assert.equal(haiku.maxTokens, 8192);
  assert.equal(haiku.label, 'Haiku 4.5');

  const sonnet = BuilderModelRegistry.get('sonnet');
  assert.equal(sonnet.modelId, 'claude-sonnet-5');
  assert.equal(sonnet.provider, 'anthropic');
  assert.equal(sonnet.maxTokens, 16_384);
  assert.equal(sonnet.label, 'Sonnet 5');

  const opus = BuilderModelRegistry.get('opus');
  assert.equal(opus.modelId, 'claude-opus-5');
  assert.equal(opus.provider, 'anthropic');
  assert.equal(opus.maxTokens, 16_384);
  assert.equal(opus.label, 'Opus 5');
});

test('builder registry resolve/has/defaults', () => {
  assert.deepEqual(BuilderModelRegistry.resolve('opus'), {
    provider: 'anthropic',
    modelId: 'claude-opus-5',
  });
  assert.deepEqual(
    BuilderModelRegistry.list().map((m) => m.id),
    [
      'anthropic:claude-haiku-4-5-20251001',
      'anthropic:claude-sonnet-5',
      'anthropic:claude-opus-5',
    ],
  );
  assert.equal(BuilderModelRegistry.has('opus'), true);
  assert.equal(BuilderModelRegistry.has('gpt-4.1'), false);
  assert.equal(BuilderModelRegistry.defaultCodegen(), 'opus');
  assert.equal(BuilderModelRegistry.defaultPreview(), 'sonnet');
});

test('unregistered model reference throws an actionable error', () => {
  assert.throws(
    () => BuilderModelRegistry.get('openai:gpt-4.1'),
    /registriert/,
  );
});
