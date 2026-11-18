/**
 * Sub-agent model fallback: a `LocalSubAgent` whose configured model the
 * provider does not serve continues on the orchestrator's model of the turn
 * instead of failing the delegation, and skips the broken model on the
 * following runs for the cooldown.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LlmProvider, LlmRequest, LlmResponse, LlmStreamEvent } from '@omadia/llm-provider';

import { LocalSubAgent } from '../packages/harness-orchestrator/src/localSubAgent.js';
import {
  PrimaryModelCooldown,
  orchestratorFallbackFor,
} from '../packages/harness-orchestrator/src/subAgentModelFallback.js';
import {
  turnContext,
  type OrchestratorExecution,
  type TurnContextValue,
} from '../packages/harness-orchestrator/src/turnContext.js';

const CAPS = {
  tools: true,
  vision: false,
  streaming: true,
  promptCaching: false,
  forcedToolChoice: false,
  parallelToolCalls: false,
} as const;

function response(text: string, model: string): LlmResponse {
  return {
    content: [{ type: 'text', text }],
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

/** A provider that serves only `servedModel` and 404s every other model. */
function serving(id: string, servedModel: string, calls: string[]): LlmProvider {
  return {
    id,
    capabilities: CAPS,
    complete: async (req: LlmRequest) => response('ok', req.model),
    stream: (req: LlmRequest) => ({
      async *[Symbol.asyncIterator]() {
        calls.push(`${id}:${req.model}`);
        if (req.model !== servedModel) {
          throw Object.assign(new Error(`model_not_found: ${req.model}`), { status: 404 });
        }
        yield { type: 'text_delta', text: `answer from ${req.model}` } as LlmStreamEvent;
        yield { type: 'final', response: response(`answer from ${req.model}`, req.model) } as LlmStreamEvent;
      },
    }),
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

/**
 * A provider that answers its first call with a tool call and fails every
 * later one with a transient (rate limit) or 404 error — a failure AFTER the
 * transcript already carries this provider's tool_use/tool_result pair.
 */
function failingAfterToolCall(id: string, kind: 'rate_limit' | 'model_not_found', calls: string[]): LlmProvider {
  let n = 0;
  return {
    id,
    capabilities: CAPS,
    complete: async (req: LlmRequest) => response('ok', req.model),
    stream: (req: LlmRequest) => ({
      async *[Symbol.asyncIterator]() {
        calls.push(`${id}:${req.model}`);
        n++;
        if (n === 1) {
          yield {
            type: 'final',
            response: {
              content: [{ type: 'tool_call', id: 'c1', name: 'lookup', input: {} }],
              finishReason: 'tool_calls',
              providerFinishReason: 'tool_use',
              model: req.model,
              usage: { inputTokens: 1, outputTokens: 1 },
            },
          } as LlmStreamEvent;
          return;
        }
        throw Object.assign(new Error(`${id} ${kind}`), { status: kind === 'rate_limit' ? 429 : 404 });
      },
    }),
    classifyError: () => ({ retryable: false, kind: kind === 'rate_limit' ? ('rate_limit' as const) : ('other' as const) }),
  } as unknown as LlmProvider;
}

const LOOKUP_TOOL = {
  spec: { name: 'lookup', description: 'lookup', input_schema: { type: 'object', properties: {} } },
  handle: async () => 'result',
};

function subAgent(provider: LlmProvider, model: string, withTool = false): LocalSubAgent {
  return new LocalSubAgent({
    name: 'accounting',
    provider,
    model,
    maxTokens: 64,
    maxIterations: 3,
    systemPrompt: 'test',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: withTool ? [LOOKUP_TOOL as any] : [],
  });
}

function inTurn<T>(exec: OrchestratorExecution | undefined, fn: () => Promise<T>): Promise<T> {
  const ctx: TurnContextValue = {
    turnId: 't1',
    turnDate: '2026-10-15',
    orchestratorExecution: exec ? { value: exec } : {},
  };
  return turnContext.run(ctx, fn);
}

describe('LocalSubAgent model fallback', () => {
  it('continues on the orchestrator model when its own model is not found', async () => {
    const calls: string[] = [];
    const provider = serving('seibertgpt', 'deepseek-v41', calls);
    const agent = subAgent(provider, 'claude-sonnet-4-5');
    const answer = await inTurn({ provider, model: 'deepseek-v41' }, () => agent.ask('OPOS?'));
    assert.equal(answer, 'answer from deepseek-v41');
    assert.deepEqual(calls, ['seibertgpt:claude-sonnet-4-5', 'seibertgpt:deepseek-v41']);
  });

  it('skips the broken model on the next run (cooldown)', async () => {
    const calls: string[] = [];
    const provider = serving('seibertgpt', 'deepseek-v41', calls);
    const agent = subAgent(provider, 'claude-sonnet-4-5');
    await inTurn({ provider, model: 'deepseek-v41' }, () => agent.ask('first'));
    calls.length = 0;
    const answer = await inTurn({ provider, model: 'deepseek-v41' }, () => agent.ask('second'));
    assert.equal(answer, 'answer from deepseek-v41');
    assert.deepEqual(calls, ['seibertgpt:deepseek-v41']);
  });

  it('still fails outside an orchestrator turn (no fallback to hop to)', async () => {
    const calls: string[] = [];
    const provider = serving('seibertgpt', 'deepseek-v41', calls);
    const agent = subAgent(provider, 'claude-sonnet-4-5');
    await assert.rejects(() => inTurn(undefined, () => agent.ask('OPOS?')), /model_not_found/);
  });

  it('does not hop to another provider after the first iteration', async () => {
    const calls: string[] = [];
    const primary = failingAfterToolCall('anthropic', 'model_not_found', calls);
    const orchestrator = serving('seibertgpt', 'deepseek-v41', calls);
    const agent = subAgent(primary, 'claude-sonnet-4-5', true);
    await assert.rejects(
      () => inTurn({ provider: orchestrator, model: 'deepseek-v41' }, () => agent.ask('OPOS?')),
      /model_not_found/,
    );
    assert.ok(!calls.includes('seibertgpt:deepseek-v41'), `unexpected hop: ${calls.join(', ')}`);
  });

  it('hops to another model on the same provider after the first iteration', async () => {
    const calls: string[] = [];
    let n = 0;
    const base = serving('seibertgpt', 'deepseek-v41', calls);
    const provider = {
      ...base,
      stream: (req: LlmRequest) => {
        n++;
        if (n === 1) return failingAfterToolCall('seibertgpt', 'model_not_found', calls).stream(req);
        return base.stream(req);
      },
    } as LlmProvider;
    const agent = subAgent(provider, 'claude-sonnet-4-5', true);
    const answer = await inTurn({ provider, model: 'deepseek-v41' }, () => agent.ask('OPOS?'));
    assert.equal(answer, 'answer from deepseek-v41');
  });

  it('does not hop to the same provider on a provider-wide failure', async () => {
    const calls: string[] = [];
    const provider = {
      ...serving('seibertgpt', 'deepseek-v41', calls),
      stream: (req: LlmRequest) => ({
        async *[Symbol.asyncIterator]() {
          calls.push(`seibertgpt:${req.model}`);
          throw Object.assign(new Error('unauthorized'), { status: 401 });
        },
      }),
      classifyError: () => ({ retryable: false, kind: 'auth' as const }),
    } as unknown as LlmProvider;
    const agent = subAgent(provider, 'claude-sonnet-4-5');
    await assert.rejects(
      () => inTurn({ provider, model: 'deepseek-v41' }, () => agent.ask('OPOS?')),
      /unauthorized/,
    );
    assert.deepEqual(calls, ['seibertgpt:claude-sonnet-4-5']);
  });

  it('a transient cross-provider hop does not open the cooldown', async () => {
    const calls: string[] = [];
    let n = 0;
    const primary = {
      ...serving('anthropic', 'claude-sonnet-4-5', calls),
      stream: (req: LlmRequest) => ({
        async *[Symbol.asyncIterator]() {
          calls.push(`anthropic:${req.model}`);
          n++;
          // First run: the endpoint is unreachable — a transient failure.
          if (n === 1) throw Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' });
          yield { type: 'final', response: response('primary', req.model) } as LlmStreamEvent;
        },
      }),
    } as unknown as LlmProvider;
    const orchestrator = serving('seibertgpt', 'deepseek-v41', calls);
    const agent = subAgent(primary, 'claude-sonnet-4-5');
    const exec = { provider: orchestrator, model: 'deepseek-v41' };
    assert.equal(await inTurn(exec, () => agent.ask('first')), 'answer from deepseek-v41');
    calls.length = 0;
    // The next run starts on the primary again.
    assert.equal(await inTurn(exec, () => agent.ask('second')), 'primary');
    assert.deepEqual(calls, ['anthropic:claude-sonnet-4-5']);
  });
});

describe('orchestratorFallbackFor', () => {
  const provider = serving('p', 'm', []);

  it('is the turn execution when it differs from the primary', async () => {
    const fb = await inTurn({ provider, model: 'other' }, async () =>
      orchestratorFallbackFor({ provider, model: 'm' }),
    );
    assert.equal(fb?.model, 'other');
  });

  it('is withheld when it is the same provider and model', async () => {
    const fb = await inTurn({ provider, model: 'm' }, async () =>
      orchestratorFallbackFor({ provider, model: 'm' }),
    );
    assert.equal(fb, undefined);
  });
});

describe('PrimaryModelCooldown', () => {
  it('opens only for configuration failures and expires', () => {
    let now = 1_000;
    const cooldown = new PrimaryModelCooldown(() => now, 100);
    assert.equal(cooldown.recordFallback('rate_limit'), false);
    assert.equal(cooldown.isActive(), false);
    assert.equal(cooldown.recordFallback('model_not_found'), true);
    assert.equal(cooldown.isActive(), true);
    now += 100;
    assert.equal(cooldown.isActive(), false);
  });
});
