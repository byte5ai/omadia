/**
 * Tests for the external model overlay + LlmProviderCatalog (provider-plugin
 * seam). The frozen core registry must stay intact; plugin-contributed models
 * are visible through the same lookups, validated against the combined set, and
 * removable on dispose/unregister.
 */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import {
  clearExternalModels,
  getModel,
  LlmProviderCatalog,
  listModels,
  listModelsByProvider,
  modelForClass,
  registerExternalModels,
  resolveModelRef,
  type LlmProviderDescriptor,
  type ModelInfo,
} from '@omadia/llm-provider';

const M3: ModelInfo = {
  id: 'minimax:MiniMax-M3',
  provider: 'minimax',
  modelId: 'MiniMax-M3',
  label: 'MiniMax M3',
  class: 'frontier',
  maxTokens: 131072,
  contextWindow: 1048576,
  vision: true,
};

const M25: ModelInfo = {
  id: 'minimax:MiniMax-M2.5',
  provider: 'minimax',
  modelId: 'MiniMax-M2.5',
  label: 'MiniMax M2.5',
  class: 'balanced',
  maxTokens: 65536,
  contextWindow: 204800,
  vision: false,
};

beforeEach(() => clearExternalModels());

test('overlay models appear in lookups; the frozen core ships zero static models', () => {
  // The llm-provider package is provider-agnostic now — no static built-in models.
  assert.equal(listModels().length, 0);
  assert.equal(listModelsByProvider('minimax').length, 0);

  registerExternalModels([M3, M25]);

  assert.equal(listModelsByProvider('minimax').length, 2);
  assert.deepEqual(getModel('minimax:MiniMax-M3'), M3);
  assert.equal(resolveModelRef('minimax:MiniMax-M3')?.modelId, 'MiniMax-M3');
  assert.equal(resolveModelRef('MiniMax-M3')?.provider, 'minimax');
  assert.equal(modelForClass('frontier', 'minimax')?.id, 'minimax:MiniMax-M3');
  // exactly the overlay fixtures are visible — nothing else
  assert.equal(listModels().length, 2);
});

test('dispose removes exactly the registered overlay models', () => {
  const dispose = registerExternalModels([M3, M25]);
  assert.equal(listModelsByProvider('minimax').length, 2);
  dispose();
  assert.equal(listModelsByProvider('minimax').length, 0);
  assert.equal(getModel('minimax:MiniMax-M3'), undefined);
});

test('overlay validates against the combined set (rejects duplicate id vs already-registered)', () => {
  // First registration succeeds; a second batch re-using an id collides against
  // the COMBINED set (core + already-registered external), proving the overlay
  // validates against everything, not just within its own batch.
  registerExternalModels([M3]);
  assert.throws(
    () => registerExternalModels([{ ...M25, id: 'minimax:MiniMax-M3', modelId: 'MiniMax-M3' }]),
    /duplicate id/,
  );
});

test('overlay rejects a malformed id (id !== provider:modelId)', () => {
  assert.throws(
    () => registerExternalModels([{ ...M3, id: 'minimax:wrong' }]),
    /must equal/,
  );
});

test('catalog.register registers models; unregister removes them', () => {
  const catalog = new LlmProviderCatalog();
  const desc: LlmProviderDescriptor = {
    id: 'minimax',
    label: 'MiniMax',
    wireFormat: 'openai-compatible',
    baseURL: 'https://api.minimax.io/v1',
    quirks: { maxTokensField: 'max_completion_tokens', dropToolChoice: true },
    models: [M3, M25],
  };

  catalog.register(desc);
  assert.equal(catalog.get('minimax')?.label, 'MiniMax');
  assert.equal(catalog.list().length, 1);
  assert.equal(listModelsByProvider('minimax').length, 2);

  catalog.unregister('minimax');
  assert.equal(catalog.get('minimax'), undefined);
  assert.equal(listModelsByProvider('minimax').length, 0);
});

test('catalog.register is idempotent (re-register replaces, no dup-id throw)', () => {
  const catalog = new LlmProviderCatalog();
  const desc: LlmProviderDescriptor = {
    id: 'minimax',
    label: 'MiniMax',
    wireFormat: 'openai-compatible',
    baseURL: 'https://api.minimax.io/v1',
    models: [M3],
  };
  catalog.register(desc);
  catalog.register(desc); // must not throw on duplicate model id
  assert.equal(listModelsByProvider('minimax').length, 1);
});
