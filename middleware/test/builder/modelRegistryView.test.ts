/**
 * Guard for the builder model registry after #297 made it source models from the
 * global `@omadia/llm-provider` registry. With no provider registered (the
 * default test process state) it falls back to the historical Anthropic slugs,
 * so the emitted vendor model ids / budgets / labels stay byte-identical to the
 * pre-refactor values that flow into provider calls.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BuilderModelRegistry } from '../../src/plugins/builder/modelRegistry.js';

test('builder slugs emit the exact historical Anthropic model ids + budgets', () => {
  const haiku = BuilderModelRegistry.get('haiku');
  assert.equal(haiku.modelId, 'claude-haiku-4-5-20251001');
  assert.equal(haiku.provider, 'anthropic');
  assert.equal(haiku.maxTokens, 8192);
  assert.equal(haiku.label, 'Haiku 4.5');

  const sonnet = BuilderModelRegistry.get('sonnet');
  assert.equal(sonnet.modelId, 'claude-sonnet-4-6');
  assert.equal(sonnet.provider, 'anthropic');
  assert.equal(sonnet.maxTokens, 16_384);
  assert.equal(sonnet.label, 'Sonnet 4.6');

  const opus = BuilderModelRegistry.get('opus');
  assert.equal(opus.modelId, 'claude-opus-4-8');
  assert.equal(opus.provider, 'anthropic');
  assert.equal(opus.maxTokens, 16_384);
  assert.equal(opus.label, 'Opus 4.8');
});

test('builder registry resolve/has/defaults', () => {
  assert.deepEqual(BuilderModelRegistry.resolve('opus'), {
    provider: 'anthropic',
    modelId: 'claude-opus-4-8',
  });
  assert.deepEqual(
    BuilderModelRegistry.list().map((m) => m.id),
    [
      'anthropic:claude-haiku-4-5-20251001',
      'anthropic:claude-sonnet-4-6',
      'anthropic:claude-opus-4-8',
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
