/**
 * #1569 — the Quality Guard ignored `agent_overrides` and the agent's own
 * `quality` settings, because the orchestrator called `getRules` with neither
 * an agent id nor a profile. Every agent got the plugin default.
 *
 * These tests run a real orchestrator turn against the real Quality Guard
 * service and read the system prompt the provider received.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import type { ProfileQualityConfig } from '@omadia/plugin-api';
import {
  NativeToolRegistry,
  Orchestrator,
} from '../../packages/harness-orchestrator/src/index.js';
import {
  parseAgentQuality,
  responseGuardProfileFor,
} from '../../packages/harness-orchestrator/src/agentQuality.js';
import { createResponseGuardService } from '../../packages/harness-plugin-quality-guard/src/plugin.js';
import { SYCOPHANCY_SECTION_HEADING } from '../../packages/harness-plugin-quality-guard/src/sycophancyGuard.js';

function recordingProvider(seen: LlmRequest[]): LlmProvider {
  const final: LlmStreamEvent = {
    type: 'final',
    response: {
      content: [{ type: 'text', text: 'ok' }],
      finishReason: 'stop',
      providerFinishReason: 'end_turn',
      model: 'test',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
  } as LlmStreamEvent;
  return {
    id: 'anthropic',
    capabilities: {
      tools: true,
      vision: true,
      streaming: true,
      promptCaching: true,
      forcedToolChoice: true,
      parallelToolCalls: true,
    },
    complete: async (): Promise<LlmResponse> => {
      throw new Error('complete() not scripted');
    },
    stream: (req: LlmRequest): AsyncIterable<LlmStreamEvent> => {
      seen.push(req);
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text_delta', text: 'ok' } as LlmStreamEvent;
          yield final;
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

async function systemPromptFor(opts: {
  readonly agentId: string;
  readonly overrides: Record<string, 'off' | 'low' | 'medium' | 'high'>;
  readonly agentQuality?: ProfileQualityConfig;
}): Promise<string> {
  const guard = createResponseGuardService({
    defaults: { sycophancy: 'medium', boundaries: { presets: [], custom: [] } },
    agentOverrides: opts.overrides,
  });
  const seen: LlmRequest[] = [];
  const orchestrator = new Orchestrator({
    provider: recordingProvider(seen),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 3,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    agentId: opts.agentId,
    responseGuard: () => guard,
    ...(opts.agentQuality ? { agentQuality: opts.agentQuality } : {}),
  });
  for await (const _ev of orchestrator.chatStream({ userMessage: 'Reply only with: ok' })) {
    // drain
  }
  const request = seen[0];
  assert.ok(request, 'provider received no request');
  return JSON.stringify(request.system ?? '');
}

describe('Quality Guard resolves per agent (#1569)', () => {
  it('without an override the plugin default applies (control)', async () => {
    const prompt = await systemPromptFor({ agentId: 'fallback', overrides: {} });
    assert.ok(prompt.includes(SYCOPHANCY_SECTION_HEADING));
  });

  it('agent_overrides "off" for this agent removes the block', async () => {
    const prompt = await systemPromptFor({ agentId: 'fallback', overrides: { fallback: 'off' } });
    assert.ok(!prompt.includes(SYCOPHANCY_SECTION_HEADING));
  });

  it('an override for another agent leaves this one on the default', async () => {
    const prompt = await systemPromptFor({ agentId: 'sales', overrides: { fallback: 'off' } });
    assert.ok(prompt.includes(SYCOPHANCY_SECTION_HEADING));
  });

  it('an agent with its own level gets no second block from the plugin', async () => {
    // Its own level is compiled into its prompt ("## Anti-Sycophancy
    // Protocol …"); the plugin adding its default on top was #1570's two
    // blocks of different strength.
    const prompt = await systemPromptFor({
      agentId: 'fallback',
      overrides: {},
      agentQuality: { sycophancy: 'high' },
    });
    assert.ok(!prompt.includes(SYCOPHANCY_SECTION_HEADING));
  });
});

describe('agent quality helpers (#1569)', () => {
  it('parses the stored JSONB field by field, dropping unknown values', () => {
    assert.deepEqual(parseAgentQuality({ sycophancy: 'high' }), { sycophancy: 'high' });
    assert.deepEqual(parseAgentQuality({ sycophancy: 'extreme', boundaries: { presets: ['legal', 3] } }), {
      boundaries: { presets: ['legal'] },
    });
    assert.equal(parseAgentQuality(null), undefined);
    assert.equal(parseAgentQuality({}), undefined);
    assert.equal(parseAgentQuality('high'), undefined);
  });

  it('silences the guard only for the fields the agent set itself', () => {
    assert.equal(responseGuardProfileFor(undefined), undefined);
    assert.deepEqual(responseGuardProfileFor({ sycophancy: 'low' }), { sycophancy: 'off' });
    assert.deepEqual(responseGuardProfileFor({ boundaries: { presets: ['legal'] } }), {
      boundaries: { presets: [], custom: [] },
    });
    // Empty boundaries are not a setting; the plugin's own still apply.
    assert.equal(responseGuardProfileFor({ boundaries: { presets: [], custom: [' '] } }), undefined);
  });
});
