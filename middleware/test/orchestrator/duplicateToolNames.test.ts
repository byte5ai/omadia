/**
 * `400 tools: Tool names must be unique.` — the Anthropic API rejects the
 * WHOLE request when two tools share a name, on every model (measured
 * 2026-09-23 against opus-5, opus-5-5 and fable-5-1). `buildToolsList()` fills
 * its segments independently (kernel specs, plugin native specs, domain tools,
 * Privacy v4), so one plugin shipping a name the kernel already advertises
 * turned every turn of that agent into an error (seen in prod on a Teams turn
 * of the `strategy` agent right after a model switch rebuilt it).
 *
 * These tests pin:
 *   - a kernel/native collision is advertised exactly once,
 *   - the survivor is the spec whose handler dispatch actually runs (native
 *     registry beats the kernel tool — `dispatchToolInner` order),
 *   - without a collision the kernel spec is advertised unchanged.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import {
  AskUserChoiceTool,
  ChatParticipantsTool,
  NativeToolRegistry,
  Orchestrator,
  turnContext,
} from '../../packages/harness-orchestrator/src/index.js';

const TOOL = 'get_chat_participants';
const PLUGIN_DESCRIPTION = 'plugin-provided roster tool';

const finalTextStream: LlmStreamEvent[] = [
  { type: 'text_delta', text: 'done' },
  {
    type: 'final',
    response: {
      content: [{ type: 'text', text: 'done' }],
      finishReason: 'stop',
      providerFinishReason: 'end_turn',
      model: 'test',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
  },
];

function recordingProvider(seen: LlmRequest[]): LlmProvider {
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
          for (const ev of finalTextStream) yield ev;
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

async function runTeamsTurn(opts: { pluginCollides: boolean }): Promise<LlmRequest> {
  const registry = new NativeToolRegistry();
  if (opts.pluginCollides) {
    registry.register(TOOL, {
      handler: async () => 'plugin roster',
      spec: {
        name: TOOL,
        description: PLUGIN_DESCRIPTION,
        input_schema: { type: 'object', properties: {} },
      },
    });
  }
  const seen: LlmRequest[] = [];
  const orchestrator = new Orchestrator({
    provider: recordingProvider(seen),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 5,
    domainTools: [],
    nativeToolRegistry: registry,
    chatParticipantsTool: new ChatParticipantsTool(),
  });
  await turnContext.runWithChatParticipants(async () => [], async () => {
    for await (const _ev of orchestrator.chatStream({ userMessage: 'go' })) {
      // drain
    }
  });
  const request = seen[0];
  assert.ok(request, 'provider received no request');
  return request;
}

const named = (request: LlmRequest) =>
  (request.tools ?? []).filter((tool) => tool.name === TOOL);

describe('buildToolsList never offers the same tool name twice', () => {
  it('a plugin native tool colliding with a kernel tool is advertised once', async () => {
    const request = await runTeamsTurn({ pluginCollides: true });
    const names = (request.tools ?? []).map((tool) => tool.name);
    assert.equal(new Set(names).size, names.length, `duplicate names in ${names.join(', ')}`);
    assert.equal(named(request).length, 1);
  });

  it('keeps the spec dispatch serves (native registry beats the kernel tool)', async () => {
    const request = await runTeamsTurn({ pluginCollides: true });
    assert.equal(named(request)[0]?.description, PLUGIN_DESCRIPTION);
  });

  it('kernel tools #1143 registers into the native registry are advertised once', async () => {
    // The prod failure: the orchestrator constructor registers its OWN spec
    // constants (ask_user_choice, suggest_follow_ups, …) into the native
    // registry for the CLI loopback, so the same OBJECT reached the list from
    // the kernel segment and from the native segment.
    const seen: LlmRequest[] = [];
    const orchestrator = new Orchestrator({
      provider: recordingProvider(seen),
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 5,
      domainTools: [],
      nativeToolRegistry: new NativeToolRegistry(),
      askUserChoiceTool: new AskUserChoiceTool(),
    });
    for await (const _ev of orchestrator.chatStream({ userMessage: 'go' })) {
      // drain
    }
    const names = (seen[0]?.tools ?? []).map((tool) => tool.name);
    assert.equal(names.filter((n) => n === 'ask_user_choice').length, 1, names.join(', '));
    assert.equal(new Set(names).size, names.length, `duplicate names in ${names.join(', ')}`);
  });

  it('without a collision the kernel spec is advertised unchanged', async () => {
    const request = await runTeamsTurn({ pluginCollides: false });
    assert.equal(named(request).length, 1);
    assert.notEqual(named(request)[0]?.description, PLUGIN_DESCRIPTION);
  });
});
