/**
 * #1033 W2 — the model policy: deny-default parsing, write-time validation
 * against the live catalogue + key presence, and the runtime resolution the
 * registry applies (pinned primary switches triage off; a primary on another
 * provider is deferred with its effort still honoured).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ModelInfo } from '@omadia/llm-provider';

import {
  ConfigValidationError,
} from '../packages/harness-orchestrator/src/registry/configStore.js';
import {
  DEFAULT_MODEL_POLICY,
  parseModelPolicy,
  parseModelRef,
  resolveModelPolicyRuntime,
  validateModelPolicy,
  type ModelPolicyValidationContext,
} from '../packages/harness-orchestrator/src/registry/modelPolicy.js';

const CATALOG: Record<string, ModelInfo> = {
  'anthropic:claude-opus-4-8': {
    id: 'anthropic:claude-opus-4-8',
    provider: 'anthropic',
    modelId: 'claude-opus-4-8',
    label: 'Opus',
    class: 'frontier',
    maxTokens: 1,
    contextWindow: 1,
    vision: true,
    effortLevels: ['low', 'medium', 'high', 'xhigh'],
  },
  'openai:gpt-5.5': {
    id: 'openai:gpt-5.5',
    provider: 'openai',
    modelId: 'gpt-5.5',
    label: 'GPT',
    class: 'frontier',
    maxTokens: 1,
    contextWindow: 1,
    vision: false,
  },
};

function ctx(keyed: readonly string[]): ModelPolicyValidationContext {
  return {
    resolveModel: (provider, model) => CATALOG[`${provider}:${model}`],
    usable: async (provider) => keyed.includes(provider),
  };
}

describe('parseModelPolicy', () => {
  it('reads the default for NULL, garbage and half-known shapes', () => {
    assert.deepEqual(parseModelPolicy(null), DEFAULT_MODEL_POLICY);
    assert.deepEqual(parseModelPolicy('auto'), DEFAULT_MODEL_POLICY);
    assert.deepEqual(parseModelPolicy({ primary: 'auto' }), DEFAULT_MODEL_POLICY);
    assert.deepEqual(parseModelPolicy({ primary: 'auto', fallback: 'always' }), DEFAULT_MODEL_POLICY);
    assert.deepEqual(
      parseModelPolicy({ primary: { provider: 'anthropic' }, fallback: 'none' }),
      DEFAULT_MODEL_POLICY,
    );
  });

  it('keeps a well-formed policy, trimming refs and dropping unknown effort', () => {
    assert.deepEqual(
      parseModelPolicy({
        primary: { provider: ' anthropic ', model: 'claude-opus-4-8', effort: 'xhigh' },
        fallback: { provider: 'openai', model: 'gpt-5.5' },
      }),
      {
        primary: { provider: 'anthropic', model: 'claude-opus-4-8', effort: 'xhigh' },
        fallback: { provider: 'openai', model: 'gpt-5.5' },
      },
    );
    assert.equal(parseModelRef({ provider: 'a', model: 'm', effort: 'ultra' }), undefined);
  });
});

describe('validateModelPolicy', () => {
  it('accepts primary and fallback on DIFFERENT providers and reports vision', async () => {
    const out = await validateModelPolicy(
      {
        primary: { provider: 'anthropic', model: 'claude-opus-4-8', effort: 'high' },
        fallback: { provider: 'openai', model: 'gpt-5.5' },
      },
      ctx(['anthropic', 'openai']),
    );
    assert.deepEqual(out, { primaryVision: true, fallbackVision: false });
  });

  it('rejects an unknown model, an unkeyed provider, an undeclared effort, and fallback = primary', async () => {
    await assert.rejects(
      validateModelPolicy({ primary: { provider: 'anthropic', model: 'nope' }, fallback: 'none' }, ctx(['anthropic'])),
      (e: unknown) => e instanceof ConfigValidationError && /not registered/.test(e.message),
    );
    await assert.rejects(
      validateModelPolicy({ primary: 'auto', fallback: { provider: 'openai', model: 'gpt-5.5' } }, ctx(['anthropic'])),
      (e: unknown) => e instanceof ConfigValidationError && /no API key/.test(e.message),
    );
    await assert.rejects(
      validateModelPolicy(
        { primary: { provider: 'openai', model: 'gpt-5.5', effort: 'high' }, fallback: 'none' },
        ctx(['openai']),
      ),
      (e: unknown) => e instanceof ConfigValidationError && /declares no effort levels/.test(e.message),
    );
    await assert.rejects(
      validateModelPolicy(
        {
          primary: { provider: 'anthropic', model: 'claude-opus-4-8' },
          fallback: { provider: 'anthropic', model: 'claude-opus-4-8', effort: 'low' },
        },
        ctx(['anthropic']),
      ),
      (e: unknown) => e instanceof ConfigValidationError && /fallback must differ/.test(e.message),
    );
  });

  it('the default policy validates without touching the catalogue', async () => {
    assert.deepEqual(await validateModelPolicy(DEFAULT_MODEL_POLICY, ctx([])), {});
  });
});

describe('resolveModelPolicyRuntime', () => {
  it('auto pins nothing', () => {
    assert.deepEqual(resolveModelPolicyRuntime(DEFAULT_MODEL_POLICY, 'anthropic'), { pinned: false });
  });

  it('an explicit primary on the active provider pins model + effort', () => {
    assert.deepEqual(
      resolveModelPolicyRuntime(
        { primary: { provider: 'anthropic', model: 'claude-opus-4-8', effort: 'xhigh' }, fallback: 'none' },
        'anthropic',
      ),
      { pinned: true, model: 'claude-opus-4-8', effort: 'xhigh' },
    );
  });

  it('an explicit primary on ANOTHER provider is deferred — effort kept, model not switched', () => {
    assert.deepEqual(
      resolveModelPolicyRuntime(
        { primary: { provider: 'openai', model: 'gpt-5.5', effort: 'medium' }, fallback: 'none' },
        'anthropic',
      ),
      { pinned: true, deferredProvider: 'openai', effort: 'medium' },
    );
  });
});
