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

/**
 * Fresh-Check gate (`ChatTurnResult.memoryUsed`) — what the Teams card renders
 * its "🔄 Fresh Check (ohne Memory)" button from.
 *
 * The rule under test: the button appears only when memory could actually have
 * changed the answer. The verbatim tail of the running conversation and the
 * read-convention's `/memories` directory listing happen on nearly every turn
 * and must NOT arm it — that was the field report (a bare "ping" → "Pong."
 * turn still offered a fresh check).
 */

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

function toLlmResponse(msg: AnyMessage): LlmResponse {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const content: ContentPart[] = (msg.content as any[]).map((block) => {
    if (block.type === 'text') {
      return { type: 'text', text: block.text as string };
    }
    return {
      type: 'tool_call',
      id: block.id as string,
      name: block.name as string,
      input: block.input,
    };
  });
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

function fakeCreateProvider(messages: AnyMessage[]): LlmProvider {
  let idx = 0;
  const provider = {
    id: 'anthropic',
    capabilities: providerCapabilities,
    complete: async (_req: LlmRequest): Promise<LlmResponse> => {
      const m = messages[idx];
      idx += 1;
      return toLlmResponse(m);
    },
    stream: (): AsyncIterable<LlmStreamEvent> => {
      throw new Error('fakeCreateProvider: stream() not scripted');
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  };
  return provider as unknown as LlmProvider;
}

const textMsg = (text: string): AnyMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
});

const memoryToolMsg = (input: Record<string, unknown>): AnyMessage => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id: 'mem-1', name: 'memory', input }],
  stop_reason: 'tool_use',
});

type Reason = 'tail' | 'entity' | 'fts' | 'manual-boost' | 'agent-boost';

/**
 * Stand-in for the real `ContextRetriever`. The orchestrator only ever calls
 * `assembleForBudget` on it, so a one-method fake is the whole seam — and it
 * lets each case pin the exact `reason` mix the real retriever would emit.
 */
function fakeRetriever(opts: {
  reasons: Reason[];
  insights?: number;
}): NonNullable<ConstructorParameters<typeof Orchestrator>[0]['contextRetriever']> {
  const retriever = {
    assembleForBudget: async () => ({
      text: opts.reasons.length > 0 ? '## Letzte Turns in diesem Chat\n…' : '',
      included: opts.reasons.map((reason, i) => ({
        turnId: `turn:scope-a:${String(i)}`,
        score: 1,
        chars: 10,
        reason,
      })),
      excluded: [],
      recalled: {
        plans: [],
        processes: [],
        insights: Array.from({ length: opts.insights ?? 0 }, (_, i) => ({
          mkId: `mk-${String(i)}`,
          kind: 'observation',
          summary: 'etwas aus einer früheren Session',
          score: 0.9,
        })),
      },
      stats: { candidatePool: opts.reasons.length, compactMode: false, tokensUsed: 42 },
    }),
  };
  return retriever as unknown as NonNullable<
    ConstructorParameters<typeof Orchestrator>[0]['contextRetriever']
  >;
}

function buildOrchestrator(opts: {
  messages: AnyMessage[];
  reasons?: Reason[];
  insights?: number;
}): Orchestrator {
  return new Orchestrator({
    provider: fakeCreateProvider(opts.messages),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 5,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    contextRetriever: fakeRetriever({
      reasons: opts.reasons ?? [],
      ...(opts.insights !== undefined ? { insights: opts.insights } : {}),
    }),
    memoryToolHandler: {
      handle: async () => 'ok',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  });
}

const turn = { userMessage: 'ping', sessionScope: 'scope-a' };

describe('Fresh-Check gate — recalled context vs. the live tail', () => {
  it('stays off when the block carried ONLY the current chat tail', async () => {
    // The field-reported case: "ping" → "Pong." in a running conversation.
    const orch = buildOrchestrator({
      messages: [textMsg('Pong.')],
      reasons: ['tail', 'tail', 'tail'],
    });
    const result = await orch.runTurn(turn);
    assert.equal(result.memoryUsed, undefined);
  });

  it('stays off when nothing was retrieved at all', async () => {
    const orch = buildOrchestrator({ messages: [textMsg('Pong.')], reasons: [] });
    const result = await orch.runTurn(turn);
    assert.equal(result.memoryUsed, undefined);
  });

  it('arms on an FTS hit alongside the tail', async () => {
    const orch = buildOrchestrator({
      messages: [textMsg('Antwort.')],
      reasons: ['tail', 'fts'],
    });
    const result = await orch.runTurn(turn);
    assert.equal(result.memoryUsed, true);
  });

  it('arms on an entity hit (recall from other sessions by construction)', async () => {
    const orch = buildOrchestrator({
      messages: [textMsg('Antwort.')],
      reasons: ['entity'],
    });
    const result = await orch.runTurn(turn);
    assert.equal(result.memoryUsed, true);
  });

  it('arms on a cross-session insight even when `included` is tail-only', async () => {
    // Plans/processes/insights never enter `included` — they render as their
    // own block, so the gate has to read the recall probe separately.
    const orch = buildOrchestrator({
      messages: [textMsg('Antwort.')],
      reasons: ['tail'],
      insights: 1,
    });
    const result = await orch.runTurn(turn);
    assert.equal(result.memoryUsed, true);
  });
});

describe('Fresh-Check gate — memory tool calls', () => {
  it('stays off for the read-convention `/memories` directory listing', async () => {
    const orch = buildOrchestrator({
      messages: [memoryToolMsg({ command: 'view', path: '/memories' }), textMsg('Pong.')],
      reasons: ['tail'],
    });
    const result = await orch.runTurn(turn);
    assert.equal(result.memoryUsed, undefined);
  });

  it('stays off for a sub-directory listing', async () => {
    const orch = buildOrchestrator({
      messages: [
        memoryToolMsg({ command: 'view', path: '/memories/observations' }),
        textMsg('Pong.'),
      ],
      reasons: ['tail'],
    });
    const result = await orch.runTurn(turn);
    assert.equal(result.memoryUsed, undefined);
  });

  it('arms when an actual memory FILE was read', async () => {
    const orch = buildOrchestrator({
      messages: [
        memoryToolMsg({
          command: 'view',
          path: '/memories/observations/urlaubsantraege-routine.md',
        }),
        textMsg('Antwort.'),
      ],
      reasons: ['tail'],
    });
    const result = await orch.runTurn(turn);
    assert.equal(result.memoryUsed, true);
  });

  it('stays off for a memory WRITE — it records the turn, it does not feed it', async () => {
    const orch = buildOrchestrator({
      messages: [
        memoryToolMsg({
          command: 'str_replace',
          path: '/memories/observations/notiz.md',
          old_str: 'a',
          new_str: 'b',
        }),
        textMsg('Notiert.'),
      ],
      reasons: ['tail'],
    });
    const result = await orch.runTurn(turn);
    assert.equal(result.memoryUsed, undefined);
  });
});
