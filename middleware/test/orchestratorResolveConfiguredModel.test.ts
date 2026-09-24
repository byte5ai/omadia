/**
 * `resolveConfiguredModel`: configured model REFS (class refs, aliases,
 * provider-qualified and bare ids) become the bare vendor id for the active
 * provider — and a class ref is NEVER passed through raw (the vendor API
 * would 404 on `class:frontier`).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import {
  clearExternalModels,
  LlmProviderCatalog,
  type LlmProviderDescriptor,
} from '@omadia/llm-provider';
import {
  DEFAULT_ORCHESTRATOR_MODEL,
  resolveConfiguredModel,
} from '@omadia/orchestrator';

const fixture: LlmProviderDescriptor[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    wireFormat: 'anthropic',
    baseURL: 'https://api.anthropic.com',
    models: [
      { id: 'anthropic:claude-opus-9', provider: 'anthropic', modelId: 'claude-opus-9', label: 'Opus 9', class: 'frontier', maxTokens: 1, contextWindow: 2, vision: true, aliases: ['opus'] },
      { id: 'anthropic:claude-sonnet-9', provider: 'anthropic', modelId: 'claude-sonnet-9', label: 'Sonnet 9', class: 'balanced', maxTokens: 1, contextWindow: 2, vision: true, aliases: ['sonnet'] },
    ],
  },
  {
    // A provider that serves ONLY a fast model — class:frontier must degrade.
    id: 'tiny',
    label: 'Tiny',
    wireFormat: 'openai-compatible',
    baseURL: 'http://tiny.local/v1',
    models: [
      { id: 'tiny:small-1', provider: 'tiny', modelId: 'small-1', label: 'Small', class: 'fast', maxTokens: 1, contextWindow: 2, vision: false },
    ],
  },
];

let catalog: LlmProviderCatalog;
beforeEach(() => {
  clearExternalModels();
  catalog = new LlmProviderCatalog();
  for (const d of fixture) catalog.register(d);
});
afterEach(() => {
  catalog.clear();
  clearExternalModels();
});

test('the shipped default is a class ref, not a model id', () => {
  assert.equal(DEFAULT_ORCHESTRATOR_MODEL, 'class:frontier');
});

test('class refs resolve to the active provider current class model', () => {
  assert.equal(resolveConfiguredModel('class:frontier', 'anthropic'), 'claude-opus-9');
  assert.equal(resolveConfiguredModel('class:balanced', 'anthropic'), 'claude-sonnet-9');
  // no provider given → the anthropic default
  assert.equal(resolveConfiguredModel('class:frontier', undefined), 'claude-opus-9');
});

test('aliases, provider-qualified and bare ids resolve; unknown ids pass through', () => {
  assert.equal(resolveConfiguredModel('opus', 'anthropic'), 'claude-opus-9');
  assert.equal(resolveConfiguredModel('anthropic:claude-sonnet-9', 'anthropic'), 'claude-sonnet-9');
  assert.equal(resolveConfiguredModel('claude-opus-9', 'anthropic'), 'claude-opus-9');
  // registry-unknown same-provider id: the curated set is not the universe
  assert.equal(resolveConfiguredModel('claude-opus-4-1-20250805', 'anthropic'), 'claude-opus-4-1-20250805');
});

test('a class the provider does not serve degrades to the nearest served class, never raw', () => {
  assert.equal(resolveConfiguredModel('class:frontier', 'tiny'), 'small-1');
  assert.equal(resolveConfiguredModel('class:balanced', 'tiny'), 'small-1');
  // anthropic fixture has no fast model → frontier is the nearest served
  assert.equal(resolveConfiguredModel('class:fast', 'anthropic'), 'claude-opus-9');
});

test('a class ref for a provider the registry knows nothing about yields undefined (caller falls back)', () => {
  assert.equal(resolveConfiguredModel('class:frontier', 'ghost'), undefined);
});

test('empty refs yield undefined; a cross-provider concrete id yields undefined', () => {
  assert.equal(resolveConfiguredModel('', 'anthropic'), undefined);
  assert.equal(resolveConfiguredModel('   ', 'anthropic'), undefined);
  assert.equal(resolveConfiguredModel('small-1', 'anthropic'), undefined);
});
