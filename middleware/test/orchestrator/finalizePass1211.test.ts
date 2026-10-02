/**
 * #1211 — the finalize pass must not rewrite the request prefix.
 *
 * Both tool loops used to send `tools: []` on the last iteration and append the
 * finalize directive to `system`. `tools` comes FIRST in the Anthropic cache
 * order, so emptying it (and rewriting `system`) invalidated the prompt cache
 * for the finalize call and, on models that replay preserved thinking, every
 * thinking block bound to that prefix.
 *
 * The replacement is append-only: the tool list and the system blocks stay
 * byte-identical across the turn's requests, the directive rides as a text
 * block on the newest user turn, and tool use is suppressed with
 * `tool_choice: { type: 'none' }`.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type {
  ContentPart,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamEvent,
} from '@omadia/llm-provider';
import { NativeToolRegistry, Orchestrator } from '@omadia/orchestrator';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMessage = any;

const providerCapabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

const TOOL_NAME = 'probe_tool';

/** Iteration 0 asks for a tool; iteration 1 is the finalize pass and answers. */
const SCRIPT: AnyMessage[] = [
  {
    content: [{ type: 'tool_use', id: 'call-1', name: TOOL_NAME, input: {} }],
    stop_reason: 'tool_use',
  },
  {
    content: [{ type: 'text', text: 'best effort' }],
    stop_reason: 'end_turn',
  },
];

function toLlmResponse(msg: AnyMessage): LlmResponse {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const content: ContentPart[] = (msg.content as any[]).map((block) =>
    block.type === 'text'
      ? { type: 'text', text: block.text as string }
      : {
          type: 'tool_call',
          id: block.id as string,
          name: block.name as string,
          input: block.input,
        },
  );
  const stopReason = msg.stop_reason as string;
  return {
    content,
    finishReason: stopReason === 'tool_use' ? 'tool_calls' : 'stop',
    providerFinishReason: stopReason,
    model: 'test',
    usage: {
      inputTokens: 10,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  };
}

function scriptedProvider(
  seen: LlmRequest[],
  capabilities: Record<string, unknown> = providerCapabilities,
): LlmProvider {
  let idx = 0;
  const next = (req: LlmRequest): LlmResponse => {
    seen.push(req);
    const msg = SCRIPT[idx];
    idx += 1;
    assert.ok(msg, `provider called ${String(idx)}× — script exhausted`);
    return toLlmResponse(msg);
  };
  const provider = {
    id: 'anthropic',
    capabilities,
    complete: async (req: LlmRequest): Promise<LlmResponse> => next(req),
    stream: (req: LlmRequest): AsyncIterable<LlmStreamEvent> => {
      const response = next(req);
      return {
        async *[Symbol.asyncIterator]() {
          for (const part of response.content) {
            if (part.type === 'text') {
              yield { type: 'text_delta', text: part.text };
            }
          }
          yield { type: 'final', response };
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  };
  return provider as unknown as LlmProvider;
}

function orchestratorWithTool(
  seen: LlmRequest[],
  capabilities: Record<string, unknown> = providerCapabilities,
): Orchestrator {
  const registry = new NativeToolRegistry();
  registry.register(TOOL_NAME, {
    handler: async () => 'probe output',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spec: {
      name: TOOL_NAME,
      description: 'probe tool for testing',
      input_schema: { type: 'object', properties: {}, required: [] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  });
  return new Orchestrator({
    provider: scriptedProvider(seen, capabilities),
    model: 'test',
    maxTokens: 1024,
    // Two iterations: the first calls the tool, the second IS the finalize pass.
    maxToolIterations: 2,
    domainTools: [],
    nativeToolRegistry: registry,
  });
}

const toolNames = (req: LlmRequest): string[] =>
  (req.tools ?? []).map((tool) => tool.name);

/** Assert the finalize-pass invariants on a recorded [normal, finalize] pair. */
function assertFinalizePrefixStable(seen: LlmRequest[]): void {
  assert.equal(seen.length, 2, 'expected exactly two model calls');
  const first = seen[0]!;
  const finalize = seen[1]!;

  // 1. The tool block is unchanged — same names, same order, still non-empty.
  assert.ok(toolNames(first).length > 0, 'first call must advertise tools');
  assert.deepEqual(
    toolNames(finalize),
    toolNames(first),
    'finalize pass must keep the tool list byte-stable (it prefixes the cache)',
  );
  assert.ok(
    toolNames(finalize).includes(TOOL_NAME),
    'finalize pass must still advertise the registered tool',
  );

  // 2. The system blocks are unchanged — the directive no longer rides there.
  assert.deepEqual(
    finalize.system,
    first.system,
    'finalize pass must not rewrite `system`',
  );

  // 3. Tool use is suppressed via tool_choice instead of an empty array.
  assert.equal(first.toolChoice, undefined, 'normal iteration forces nothing');
  assert.deepEqual(finalize.toolChoice, { type: 'none' });

  // 4. The directive is appended to the newest user turn, AFTER its
  //    tool_result blocks — append-only, so every earlier turn is untouched.
  const last = finalize.messages[finalize.messages.length - 1]!;
  assert.equal(last.role, 'user');
  const parts = [...last.content];
  const directive = parts[parts.length - 1]!;
  assert.equal(directive.type, 'text');
  assert.ok(
    directive.type === 'text' && directive.text.includes('Tool-Budget'),
    `last block must be the finalize directive, got: ${JSON.stringify(directive)}`,
  );
  assert.ok(
    parts.some((p) => p.type === 'tool_result'),
    'the directive must ride on the tool_results turn, not a fresh one',
  );

  // 5. Everything before that turn is byte-identical to the first request.
  assert.deepEqual(
    finalize.messages.slice(0, finalize.messages.length - 2),
    first.messages,
    'earlier turns must not be rewritten',
  );
}

/** A provider whose adapter drops `tool_choice` before the wire (the
 *  OpenAI-compatible `dropToolChoice` quirk, e.g. MiniMax). */
const CANT_SUPPRESS = { ...providerCapabilities, toolChoiceNone: false };

describe('#1211 — finalize pass keeps the request prefix stable', () => {
  it('buffered loop: same tools, same system, tool_choice none', async () => {
    const seen: LlmRequest[] = [];
    const answer = await orchestratorWithTool(seen).chat({
      userMessage: 'go',
    });
    assert.ok(answer.text.includes('best effort'), 'finalize answer must reach the caller');
    assertFinalizePrefixStable(seen);
  });

  it('streaming loop: same tools, same system, tool_choice none', async () => {
    const seen: LlmRequest[] = [];
    for await (const _ev of orchestratorWithTool(seen).chatStream({
      userMessage: 'go',
    })) {
      // drain
    }
    assertFinalizePrefixStable(seen);
  });

  it('falls back to no tools when the provider cannot honour tool_choice none', async () => {
    // A `tool_choice` the adapter drops would leave the model holding every
    // tool on the last iteration — a `tool_use` there ends the turn in the raw
    // "exceeded maxToolIterations" error instead of a best-effort answer. The
    // pass gives up the cache on that one call rather than the guarantee.
    const seen: LlmRequest[] = [];
    for await (const _ev of orchestratorWithTool(seen, CANT_SUPPRESS).chatStream({
      userMessage: 'go',
    })) {
      // drain
    }
    assert.equal(seen.length, 2, 'expected exactly two model calls');
    assert.ok(toolNames(seen[0]!).length > 0, 'first call must advertise tools');
    assert.deepEqual(toolNames(seen[1]!), [], 'finalize pass must offer no tools');
    assert.equal(
      seen[1]!.toolChoice,
      undefined,
      'no tool_choice without tools — the adapter would drop it anyway',
    );
    // The directive still rides on the newest user turn, not in `system`.
    assert.deepEqual(seen[1]!.system, seen[0]!.system);
    const last = seen[1]!.messages[seen[1]!.messages.length - 1]!;
    const directive = last.content[last.content.length - 1]!;
    assert.ok(directive.type === 'text' && directive.text.includes('Tool-Budget'));
  });
});
