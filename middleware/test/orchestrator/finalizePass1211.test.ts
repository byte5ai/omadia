/**
 * #1211 — what the finalize pass (the last tool-loop iteration, which must end
 * the turn in text) sends, in both tool loops.
 *
 * A provider that declares `capabilities.toolChoiceNone === true` keeps the
 * full tool list and gets `tool_choice: { type: 'none' }`: `tools` comes first
 * in Anthropic's cache order, so the unchanged list keeps the turn's cached
 * prefix. Every other provider gets `tools: []`, the pre-#1211 shape. Opt-in,
 * because an OpenAI-compatible server may accept `tool_choice` and ignore it —
 * a `tool_use` on the last iteration would then be dispatched and the turn
 * would end in "exceeded maxToolIterations". Either way the finalize directive
 * rides in the per-turn system hint, never in a user message, and a fallback
 * request gets the pair computed for its own provider.
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
import { createProviderHealth } from '@omadia/llm-provider';
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

/** Declares that `tool_choice: { type: 'none' }` is honoured (as the Anthropic
 *  adapter does). */
const SUPPRESSES = { ...providerCapabilities, toolChoiceNone: true };

/** The OpenAI-compatible adapter under its `dropToolChoice` quirk (MiniMax). */
const CANT_SUPPRESS = { ...providerCapabilities, toolChoiceNone: false };

const TOOL_NAME = 'probe_tool';

/** The opening of `FINALIZE_DIRECTIVE` (the stable prompt mentions "Tool-Budget" on its own). */
const DIRECTIVE_MARKER = 'Das Tool-Budget für diesen Turn ist aufgebraucht';

const TOOL_CALL_TURN: AnyMessage = {
  content: [{ type: 'tool_use', id: 'call-1', name: TOOL_NAME, input: {} }],
  stop_reason: 'tool_use',
};

const BEST_EFFORT_TURN: AnyMessage = {
  content: [{ type: 'text', text: 'best effort' }],
  stop_reason: 'end_turn',
};

/** Iteration 0 asks for a tool; iteration 1 is the finalize pass and answers. */
const SCRIPT: AnyMessage[] = [TOOL_CALL_TURN, BEST_EFFORT_TURN];

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
  script: AnyMessage[] = SCRIPT,
  id = 'anthropic',
): LlmProvider {
  let idx = 0;
  const next = (req: LlmRequest): LlmResponse => {
    seen.push(req);
    const msg = script[idx];
    idx += 1;
    assert.ok(msg, `provider called ${String(idx)}× — script exhausted`);
    return toLlmResponse(msg);
  };
  const provider = {
    id,
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

/** A primary whose endpoint refuses the connection. `fallbackReasonFor` maps
 *  that to `unreachable`, so both loops hop to the fallback at once instead of
 *  spending the stream retry budget first. */
function unreachableProvider(
  seen: LlmRequest[],
  capabilities: Record<string, unknown>,
): LlmProvider {
  const refuse = (req: LlmRequest): never => {
    seen.push(req);
    throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
      code: 'ECONNREFUSED',
    });
  };
  const provider = {
    id: 'anthropic',
    capabilities,
    complete: async (req: LlmRequest): Promise<LlmResponse> => refuse(req),
    stream: (req: LlmRequest): AsyncIterable<LlmStreamEvent> => ({
      async *[Symbol.asyncIterator]() {
        refuse(req);
      },
    }),
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  };
  return provider as unknown as LlmProvider;
}

function registryWithProbeTool(): NativeToolRegistry {
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
  return registry;
}

function orchestratorWithTool(
  seen: LlmRequest[],
  capabilities: Record<string, unknown>,
): Orchestrator {
  return new Orchestrator({
    provider: scriptedProvider(seen, capabilities),
    model: 'test',
    maxTokens: 1024,
    // Two iterations: the first calls the tool, the second IS the finalize pass.
    maxToolIterations: 2,
    domainTools: [],
    nativeToolRegistry: registryWithProbeTool(),
  });
}

/** A primary that refuses the connection, with a fallback on ANOTHER provider
 *  that answers in text. */
function orchestratorWithFallback(opts: {
  primarySeen: LlmRequest[];
  fallbackSeen: LlmRequest[];
  primaryCapabilities: Record<string, unknown>;
  fallbackCapabilities: Record<string, unknown>;
}): Orchestrator {
  const primary = unreachableProvider(opts.primarySeen, opts.primaryCapabilities);
  const fallback = scriptedProvider(
    opts.fallbackSeen,
    opts.fallbackCapabilities,
    [BEST_EFFORT_TURN],
    'openai',
  );
  return new Orchestrator({
    provider: primary,
    model: 'claude-opus-4-8',
    maxTokens: 1024,
    // One iteration: iteration 0 is the finalize pass, and the only one on
    // which a cross-provider hop may happen.
    maxToolIterations: 1,
    domainTools: [],
    nativeToolRegistry: registryWithProbeTool(),
    providerPool: {
      get: async (id: string) =>
        id === 'openai' ? fallback : id === 'anthropic' ? primary : undefined,
      health: createProviderHealth({ now: () => 1_000 }),
    },
    fallbackRef: { provider: 'openai', model: 'gpt-5.5' },
  } as never);
}

type Loop = 'buffered' | 'streaming';
const LOOPS: readonly Loop[] = ['buffered', 'streaming'];

/** Runs one turn through the chosen tool loop; returns the answer text. */
async function runTurn(orchestrator: Orchestrator, loop: Loop): Promise<string> {
  if (loop === 'buffered') {
    const answer = await orchestrator.chat({ userMessage: 'go' });
    return answer.text;
  }
  let text = '';
  for await (const ev of orchestrator.chatStream({ userMessage: 'go' })) {
    if (ev.type === 'text_delta') text += ev.text;
  }
  return text;
}

const toolNames = (req: LlmRequest): string[] =>
  (req.tools ?? []).map((tool) => tool.name);

function systemBlocks(req: LlmRequest): unknown[] {
  const { system } = req;
  if (system === undefined) return [];
  return typeof system === 'string' ? [system] : [...system];
}

function systemTexts(req: LlmRequest): string[] {
  const { system } = req;
  if (system === undefined) return [];
  return typeof system === 'string' ? [system] : system.map((block) => block.text);
}

function assertNormalIteration(req: LlmRequest): void {
  assert.ok(
    toolNames(req).includes(TOOL_NAME),
    'a normal iteration advertises the registered tool',
  );
  assert.equal(req.toolChoice, undefined, 'a normal iteration forces nothing');
  assert.ok(
    !systemTexts(req).some((text) => text.includes(DIRECTIVE_MARKER)),
    'a normal iteration carries no finalize directive',
  );
}

/** The directive rides in the per-turn system hint — the LAST `system` block —
 *  and in no message of the transcript. */
function assertDirectiveInSystemHint(req: LlmRequest): void {
  const last = systemTexts(req).at(-1);
  assert.ok(
    last !== undefined && last.includes(DIRECTIVE_MARKER),
    `the last system block must carry the finalize directive, got: ${JSON.stringify(last)}`,
  );
  assert.ok(
    !JSON.stringify(req.messages).includes(DIRECTIVE_MARKER),
    'the finalize directive must not ride in any message',
  );
}

describe('#1211 — finalize pass: tool suppression is opt-in per provider', () => {
  for (const loop of LOOPS) {
    it(`${loop} loop: toolChoiceNone=true keeps the tools and sends tool_choice none`, async () => {
      const seen: LlmRequest[] = [];
      const text = await runTurn(orchestratorWithTool(seen, SUPPRESSES), loop);
      assert.ok(text.includes('best effort'), 'the finalize answer must reach the caller');
      assert.equal(seen.length, 2, 'expected exactly two model calls');
      const first = seen[0]!;
      const finalize = seen[1]!;

      assertNormalIteration(first);
      assert.deepEqual(
        toolNames(finalize),
        toolNames(first),
        'the finalize pass keeps the tool list unchanged (it prefixes the cache)',
      );
      assert.deepEqual(finalize.toolChoice, { type: 'none' });
      assertDirectiveInSystemHint(finalize);

      // Only the trailing hint block differs: every block before it — the
      // cache-marked ones included — goes out as the first request sent it.
      const finalizeBlocks = systemBlocks(finalize);
      assert.deepEqual(
        finalizeBlocks.slice(0, -1),
        systemBlocks(first).slice(0, finalizeBlocks.length - 1),
        'system blocks before the hint must not change',
      );
      // The transcript is append-only: the first request's turns are untouched.
      assert.deepEqual(
        finalize.messages.slice(0, first.messages.length),
        first.messages,
        'earlier turns must not be rewritten',
      );
    });

    for (const [label, capabilities] of [
      ['unset', providerCapabilities],
      ['false', CANT_SUPPRESS],
    ] as const) {
      it(`${loop} loop: toolChoiceNone ${label} → no tools and no tool_choice on the finalize pass`, async () => {
        const seen: LlmRequest[] = [];
        const text = await runTurn(orchestratorWithTool(seen, capabilities), loop);
        assert.ok(text.includes('best effort'), 'the finalize answer must reach the caller');
        assert.equal(seen.length, 2, 'expected exactly two model calls');
        const finalize = seen[1]!;

        assertNormalIteration(seen[0]!);
        assert.deepEqual(toolNames(finalize), [], 'the finalize pass must offer no tools');
        assert.equal(
          finalize.toolChoice,
          undefined,
          'no tool_choice without tools — a server may ignore it anyway',
        );
        assertDirectiveInSystemHint(finalize);
      });
    }
  }
});

describe('#1211 — a cross-provider fallback on the finalize pass gets its own tool params', () => {
  for (const loop of LOOPS) {
    it(`${loop} loop: primary suppresses, fallback cannot → the fallback gets no tools and no tool_choice`, async () => {
      const primarySeen: LlmRequest[] = [];
      const fallbackSeen: LlmRequest[] = [];
      const text = await runTurn(
        orchestratorWithFallback({
          primarySeen,
          fallbackSeen,
          primaryCapabilities: SUPPRESSES,
          fallbackCapabilities: providerCapabilities,
        }),
        loop,
      );
      assert.ok(text.includes('best effort'), 'the fallback answer must reach the caller');

      assert.equal(primarySeen.length, 1, 'the primary is tried once');
      assert.ok(toolNames(primarySeen[0]!).includes(TOOL_NAME));
      assert.deepEqual(primarySeen[0]!.toolChoice, { type: 'none' });

      assert.equal(fallbackSeen.length, 1, 'the fallback answers the finalize pass');
      const hop = fallbackSeen[0]!;
      assert.equal(hop.model, 'gpt-5.5');
      assert.deepEqual(toolNames(hop), [], 'the fallback must not inherit the primary’s tools');
      assert.equal(
        hop.toolChoice,
        undefined,
        'the primary’s tool_choice must not leak into the fallback request',
      );
      assertDirectiveInSystemHint(hop);
    });

    it(`${loop} loop: primary cannot suppress, fallback can → the fallback keeps the tools with tool_choice none`, async () => {
      const primarySeen: LlmRequest[] = [];
      const fallbackSeen: LlmRequest[] = [];
      const text = await runTurn(
        orchestratorWithFallback({
          primarySeen,
          fallbackSeen,
          primaryCapabilities: providerCapabilities,
          fallbackCapabilities: SUPPRESSES,
        }),
        loop,
      );
      assert.ok(text.includes('best effort'), 'the fallback answer must reach the caller');

      assert.equal(primarySeen.length, 1, 'the primary is tried once');
      assert.deepEqual(toolNames(primarySeen[0]!), []);
      assert.equal(primarySeen[0]!.toolChoice, undefined);

      assert.equal(fallbackSeen.length, 1, 'the fallback answers the finalize pass');
      const hop = fallbackSeen[0]!;
      assert.equal(hop.model, 'gpt-5.5');
      assert.ok(
        toolNames(hop).includes(TOOL_NAME),
        'the fallback must not inherit the primary’s empty tool list',
      );
      assert.deepEqual(hop.toolChoice, { type: 'none' });
      assertDirectiveInSystemHint(hop);
    });
  }
});
