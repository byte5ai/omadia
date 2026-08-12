import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { LlmProvider, LlmResponse } from '@omadia/llm-provider';
import type { PrivacyGuardService } from '@omadia/plugin-api';
import { NativeToolRegistry, Orchestrator } from '@omadia/orchestrator';

/**
 * W4 guard — the CHAT path's handling of a tool exception must stay unchanged.
 *
 * `ToolDispatchService` (the loopback / public-MCP entry point) now masks a
 * throwing handler's message before returning it. That is a DELIBERATE
 * divergence from the chat path, whose reader is the operator: an operator
 * debugging their own integration needs the driver's real message, and silently
 * digesting it would be a behaviour change nobody asked for.
 *
 * This file is the fence around that divergence. It drives the REAL
 * `Orchestrator` with a real privacy handle installed on `turnContext` — the
 * exact configuration in which the chat path DOES mask successful results — and
 * asserts the exception text still arrives verbatim. If someone later "unifies"
 * the two paths by moving `maskErrorText` into `dispatchToolDeadlined`, this
 * fails.
 *
 * Mutation-check discipline: the assertion reads the tool_result CONTENT the
 * orchestrator hands back to the model, and the handle below performs a REAL
 * redaction, so a masking call that did happen would be visible as the absence
 * of the raw string.
 */

const EMAIL = 'erika.mustermann@example.com';
const PII_ERROR = `Fault: Invalid field 'x' on record {"email":"${EMAIL}"}`;
const PII_RESULT = `{"email":"${EMAIL}"}`;

const usage = {
  inputTokens: 10,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
} as const;

function toolCallResponse(name: string): LlmResponse {
  return {
    content: [{ type: 'tool_call', id: 'use-1', name, input: {} }],
    finishReason: 'tool_calls',
    providerFinishReason: 'tool_use',
    model: 'test',
    usage,
  } as unknown as LlmResponse;
}

function textResponse(text: string): LlmResponse {
  return {
    content: [{ type: 'text', text }],
    finishReason: 'stop',
    providerFinishReason: 'end_turn',
    model: 'test',
    usage,
  } as unknown as LlmResponse;
}

/** Records every message list handed to the provider, so the tool_result the
 *  model would have seen can be inspected directly. */
function recordingProvider(responses: readonly LlmResponse[]): {
  provider: LlmProvider;
  seen: unknown[][];
} {
  const seen: unknown[][] = [];
  let idx = 0;
  const provider = {
    id: 'anthropic',
    capabilities: {
      tools: true,
      vision: true,
      streaming: true,
      promptCaching: true,
      forcedToolChoice: true,
      parallelToolCalls: true,
    },
    complete: (request: { messages?: unknown[] }) => {
      seen.push(request.messages ?? []);
      const response = responses[idx];
      idx += 1;
      if (!response) throw new Error('recordingProvider: no scripted response left');
      return Promise.resolve(response);
    },
    stream: () => {
      throw new Error('not used');
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  };
  return { provider: provider as unknown as LlmProvider, seen };
}

/**
 * The REAL `privacyGuard` seam the orchestrator builds its per-turn handle from
 * — not a handle injected into `turnContext`, which `runTurn` would overwrite
 * with its own. Redacts for real, so "masking ran" is observable as a missing
 * raw string rather than as a call count.
 */
function maskingPrivacyService(): PrivacyGuardService {
  return {
    async internToolResultV4(request: { toolName: string; rawResult: string }) {
      return {
        digestText: `«dataset:${request.toolName}» ${request.rawResult.replaceAll(EMAIL, '[masked:email]')}`,
        datasetId: `ds-${request.toolName}`,
      };
    },
    async recordBypassedTool() {},
    async runV4Tool() {
      return { resultText: '' };
    },
    async subAgentResultV4() {
      return { resultText: '' };
    },
    async takeRenderedAnswerV4() {
      return undefined;
    },
    v4ToolSpecs() {
      return [];
    },
    async finalizeTurn() {
      return undefined;
    },
  } as unknown as PrivacyGuardService;
}

function registryWith(name: string, behaviour: () => Promise<string>): NativeToolRegistry {
  const registry = new NativeToolRegistry();
  registry.register(name, {
    handler: behaviour,
    spec: {
      name,
      description: 'test tool',
      input_schema: { type: 'object' as const, properties: {}, required: [] },
    } as never,
    domain: 'test.pii',
  });
  return registry;
}

function toolResultTexts(messages: readonly unknown[][]): string[] {
  const out: string[] = [];
  for (const list of messages) {
    for (const message of list) {
      const content = (message as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const b = block as { type?: string; content?: unknown };
        if (b.type === 'tool_result' && typeof b.content === 'string') out.push(b.content);
      }
    }
  }
  return out;
}

function orchestratorWith(
  provider: LlmProvider,
  registry: NativeToolRegistry,
): Orchestrator {
  return new Orchestrator({
    provider,
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 3,
    domainTools: [],
    nativeToolRegistry: registry,
    // The production seam: `runTurn` mints its own per-turn handle from this
    // and threads it through `turnContext` itself.
    privacyGuard: () => maskingPrivacyService(),
  });
}

describe('chat path — tool exception text (W4 fence)', () => {
  it('still hands the RAW exception message to the model, unmasked', async () => {
    const { provider, seen } = recordingProvider([
      toolCallResponse('odoo_search_partner'),
      textResponse('done'),
    ]);
    const orchestrator = orchestratorWith(
      provider,
      registryWith('odoo_search_partner', () => {
        throw new Error(PII_ERROR);
      }),
    );

    await orchestrator.runTurn({ userMessage: 'go' });

    const results = toolResultTexts(seen);
    assert.equal(results.length, 1, 'exactly one tool_result should have reached the model');
    assert.equal(
      results[0]?.includes(EMAIL),
      true,
      'the chat path must NOT have started masking exception text — that divergence is deliberate',
    );
    assert.equal(
      results[0]?.includes('[masked:email]'),
      false,
      'a digest here means the dispatcher-only error masking bled into the chat path',
    );
  });

  it('and STILL masks a successful result in the same configuration', async () => {
    // The control. Without this, the test above would also pass if the privacy
    // handle were simply never consulted — which would make it vacuous.
    const { provider, seen } = recordingProvider([
      toolCallResponse('odoo_read_partner'),
      textResponse('done'),
    ]);
    const orchestrator = orchestratorWith(
      provider,
      registryWith('odoo_read_partner', () => Promise.resolve(PII_RESULT)),
    );

    await orchestrator.runTurn({ userMessage: 'go' });

    const results = toolResultTexts(seen);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.includes(EMAIL), false, 'the chat path must still mask RESULTS');
    assert.match(results[0] ?? '', /\[masked:email\]/);
  });
});
