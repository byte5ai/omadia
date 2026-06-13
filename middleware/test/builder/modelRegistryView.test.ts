/**
 * Zero-behavior-change guard for the builder model registry after it was
 * refactored to source its vendor model ids from the global
 * `@omadia/llm-provider` registry (phase 3). The builder's emitted
 * `anthropicModelId` / `maxTokens` / `label` per slug MUST be byte-identical to
 * the pre-refactor values, since they flow straight into Anthropic SDK calls
 * (builderChat / builderPreview / index). This is the end-to-end assertion the
 * global-registry tests cannot make on their own.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BuilderModelRegistry } from '../../src/plugins/builder/modelRegistry.js';

test('builder slugs emit the exact historical Anthropic model ids + budgets', () => {
  const haiku = BuilderModelRegistry.get('haiku');
  assert.equal(haiku.anthropicModelId, 'claude-haiku-4-5-20251001');
  assert.equal(haiku.maxTokens, 8192);
  assert.equal(haiku.label, 'Haiku 4.5');

  const sonnet = BuilderModelRegistry.get('sonnet');
  assert.equal(sonnet.anthropicModelId, 'claude-sonnet-4-6');
  assert.equal(sonnet.maxTokens, 16_384);
  assert.equal(sonnet.label, 'Sonnet 4.6');

  const opus = BuilderModelRegistry.get('opus');
  assert.equal(opus.anthropicModelId, 'claude-opus-4-8');
  assert.equal(opus.maxTokens, 16_384);
  assert.equal(opus.label, 'Opus 4.8');
});

test('builder registry list/has/defaults unchanged', () => {
  assert.deepEqual(
    BuilderModelRegistry.list().map((m) => m.id),
    ['haiku', 'sonnet', 'opus'],
  );
  assert.equal(BuilderModelRegistry.has('opus'), true);
  assert.equal(BuilderModelRegistry.has('gpt-4.1'), false);
  assert.equal(BuilderModelRegistry.defaultCodegen(), 'opus');
  assert.equal(BuilderModelRegistry.defaultPreview(), 'sonnet');
});
