/**
 * `SUB_AGENT_EFFORT`: a `LocalSubAgent` sends the configured reasoning effort
 * on its model calls — only to a model whose catalogue entry declares the
 * level (the Anthropic adapter forwards `output_config.effort` unchecked, and
 * a model without the knob answers 400) — and nothing when it is unset.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  EffortLevel,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';

import { LocalSubAgent } from '../packages/harness-orchestrator/src/localSubAgent.js';
import {
  subAgentEffortFor,
  type SubAgentEffortFor,
} from '../packages/harness-orchestrator/src/subAgentEffort.js';
import {
  turnContext,
  type OrchestratorExecution,
} from '../packages/harness-orchestrator/src/turnContext.js';
import { useBuiltinProviders } from './_helpers/builtinProviders.js';

const CAPS = {
  tools: true,
  vision: false,
  streaming: true,
  promptCaching: false,
  forcedToolChoice: false,
  parallelToolCalls: false,
} as const;

function response(model: string): LlmResponse {
  return {
    content: [{ type: 'text', text: 'ok' }],
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

/** Records the effort of every streamed request; serves only `servedModel`. */
function recording(servedModel: string, seen: Array<{ model: string; effort: EffortLevel | undefined }>): LlmProvider {
  return {
    id: 'anthropic',
    capabilities: CAPS,
    complete: async (req: LlmRequest) => response(req.model),
    stream: (req: LlmRequest) => ({
      async *[Symbol.asyncIterator]() {
        seen.push({ model: req.model, effort: req.effort });
        if (req.model !== servedModel) {
          throw Object.assign(new Error(`model_not_found: ${req.model}`), { status: 404 });
        }
        yield { type: 'final', response: response(req.model) } as LlmStreamEvent;
      },
    }),
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

function ask(provider: LlmProvider, model: string, effortFor: SubAgentEffortFor | undefined, exec?: OrchestratorExecution) {
  const agent = new LocalSubAgent({
    name: 'odoo-accounting',
    provider,
    model,
    maxTokens: 16_000,
    maxIterations: 4,
    systemPrompt: 'test',
    tools: [],
    ...(effortFor !== undefined ? { effortFor } : {}),
  });
  return turnContext.run(
    { turnId: 't1', turnDate: '2026-10-30', orchestratorExecution: exec ? { value: exec } : {} },
    () => agent.ask('Offene Posten?'),
  );
}

describe('subAgentEffortFor', () => {
  useBuiltinProviders();

  it('is absent when no effort is configured', () => {
    assert.equal(subAgentEffortFor(undefined), undefined);
  });

  it('returns the level for a model that declares it', () => {
    assert.equal(subAgentEffortFor('low')?.('anthropic', 'claude-opus-5'), 'low');
  });

  it('returns nothing for a model without effort levels or an unknown model', () => {
    const effortFor = subAgentEffortFor('low');
    assert.equal(effortFor?.('anthropic', 'claude-haiku-4-5-20251001'), undefined);
    assert.equal(effortFor?.('anthropic', 'no-such-model'), undefined);
  });
});

describe('LocalSubAgent effort', () => {
  useBuiltinProviders();

  it('sends the configured effort on its model calls', async () => {
    const seen: Array<{ model: string; effort: EffortLevel | undefined }> = [];
    await ask(recording('claude-opus-5', seen), 'claude-opus-5', subAgentEffortFor('low'));
    assert.deepEqual(seen, [{ model: 'claude-opus-5', effort: 'low' }]);
  });

  it('sends no effort when none is configured', async () => {
    const seen: Array<{ model: string; effort: EffortLevel | undefined }> = [];
    await ask(recording('claude-opus-5', seen), 'claude-opus-5', undefined);
    assert.deepEqual(seen, [{ model: 'claude-opus-5', effort: undefined }]);
  });

  it('checks the fallback model on its own: no effort for a model without the knob', async () => {
    const seen: Array<{ model: string; effort: EffortLevel | undefined }> = [];
    const provider = recording('claude-haiku-4-5-20251001', seen);
    await ask(provider, 'claude-opus-5-retired', subAgentEffortFor('low'), {
      provider,
      model: 'claude-haiku-4-5-20251001',
    });
    assert.deepEqual(seen.at(-1), { model: 'claude-haiku-4-5-20251001', effort: undefined });
  });
});
