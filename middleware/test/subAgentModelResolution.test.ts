/**
 * Sub-agent model-ref resolution (issue #296 MAJOR 3).
 *
 * `LocalSubAgent` sends its `model` RAW to the provider adapter — exactly like
 * the orchestrator main loop. So a picker-stored provider-qualified id or alias
 * must be resolved to the active provider's bare `modelId` before it reaches the
 * sub-agent, or every delegated turn 404s. `resolveSubAgentModel` is the pure
 * resolver the builder uses; tested directly (the resolved id is otherwise
 * private on `LocalSubAgent`).
 */

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import {
  clearExternalModels,
  registerExternalModels,
  type LlmProvider,
  type ModelInfo,
} from '@omadia/llm-provider';

import { resolveSubAgentModel } from '../packages/harness-orchestrator/src/registry/subAgentTools.js';

const OPUS: ModelInfo = {
  id: 'anthropic:claude-opus-4-8',
  provider: 'anthropic',
  modelId: 'claude-opus-4-8',
  label: 'Claude Opus 4.8',
  class: 'frontier',
  maxTokens: 16384,
  contextWindow: 200000,
  vision: true,
  aliases: ['opus'],
};
const GPT: ModelInfo = {
  id: 'openai:gpt-5.5',
  provider: 'openai',
  modelId: 'gpt-5.5',
  label: 'GPT-5.5',
  class: 'frontier',
  maxTokens: 16384,
  contextWindow: 400000,
  vision: true,
  aliases: [],
};

const DEFAULT_MODEL = 'claude-sonnet-4-6';

function deps(providerId?: string): {
  provider: LlmProvider;
  defaultModel: string;
} {
  return {
    provider: (providerId ? { id: providerId } : {}) as LlmProvider,
    defaultModel: DEFAULT_MODEL,
  };
}

beforeEach(() => {
  clearExternalModels();
  registerExternalModels([OPUS, GPT]);
});

test('null / empty / whitespace ref → parent default model (inherit)', () => {
  assert.equal(resolveSubAgentModel(null, deps('anthropic')), DEFAULT_MODEL);
  assert.equal(resolveSubAgentModel(undefined, deps('anthropic')), DEFAULT_MODEL);
  assert.equal(resolveSubAgentModel('', deps('anthropic')), DEFAULT_MODEL);
  assert.equal(resolveSubAgentModel('   ', deps('anthropic')), DEFAULT_MODEL);
});

test('provider-qualified id, alias, and bare id all resolve to the bare modelId', () => {
  assert.equal(
    resolveSubAgentModel('anthropic:claude-opus-4-8', deps('anthropic')),
    'claude-opus-4-8',
  );
  assert.equal(resolveSubAgentModel('opus', deps('anthropic')), 'claude-opus-4-8');
  assert.equal(
    resolveSubAgentModel('claude-opus-4-8', deps('anthropic')),
    'claude-opus-4-8',
  );
});

test('cross-provider pick → parent default (would 404 on the wrong adapter)', () => {
  assert.equal(
    resolveSubAgentModel('openai:gpt-5.5', deps('anthropic')),
    DEFAULT_MODEL,
    'openai model on an anthropic-bound parent is dropped',
  );
});

test('registry-unknown ref → passed through raw (curated registry is not the universe of valid ids; writes are validation-guarded)', () => {
  // A non-empty ref the registry does not list is passed through unchanged —
  // the API may still serve it (e.g. an undated id). New writes are blocked by
  // the `validateModelRef` guard, so this only matters for stale configs.
  assert.equal(
    resolveSubAgentModel('made-up-model-9', deps('anthropic')),
    'made-up-model-9',
  );
});

test('no active provider id → resolves against the anthropic default, no cross-provider drop', () => {
  // A deps with no provider id (older boot / stub) still resolves a known ref to
  // its bare modelId; the cross-provider guard is simply skipped.
  assert.equal(resolveSubAgentModel('opus', deps()), 'claude-opus-4-8');
});
