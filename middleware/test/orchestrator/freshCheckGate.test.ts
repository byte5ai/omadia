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

// --- verbatim `MemoryToolHandler` output shapes ------------------------------
// The gate reads the handler's own reply to tell a delivered file from a
// directory listing or a failure, so the fakes have to speak its exact dialect.
const DIR_LISTING = (path: string): string =>
  `Here're the files and directories up to 2 levels deep in ${path}, excluding hidden items and node_modules:\n0B\t${path}/observations`;
const FILE_CONTENT = (path: string): string =>
  `Here's the content of ${path} with line numbers:\n     1\t# Routine`;
const WRITE_OK = 'The memory file has been edited.';
const READ_FAILED = 'Error: MemoryNotFoundError: no such file';

type Origin = 'tail' | 'entity' | 'fts';
type Reason = 'tail' | 'entity' | 'fts' | 'manual-boost' | 'agent-boost';

type OrchestratorOpts = ConstructorParameters<typeof Orchestrator>[0];

/**
 * Stand-in for the real `ContextRetriever`. The orchestrator only ever calls
 * `assembleForBudget` on it, so a one-method fake is the whole seam — and it
 * lets each case pin the exact origin/reason mix the real retriever would emit.
 */
function fakeRetriever(opts: {
  hits: Array<{ origin: Origin; reason?: Reason }>;
  insights?: number;
}): NonNullable<OrchestratorOpts['contextRetriever']> {
  const retriever = {
    assembleForBudget: async () => ({
      text: opts.hits.length > 0 ? '## Letzte Turns in diesem Chat\n…' : '',
      included: opts.hits.map((hit, i) => ({
        turnId: `turn:scope-a:${String(i)}`,
        score: 1,
        chars: 10,
        reason: hit.reason ?? hit.origin,
        origin: hit.origin,
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
      stats: { candidatePool: opts.hits.length, compactMode: false, tokensUsed: 42 },
    }),
  };
  return retriever as unknown as NonNullable<OrchestratorOpts['contextRetriever']>;
}

/** Minimal `privacy.redact@1` service — enough that the orchestrator mints a
 *  privacy handle, which is what makes `dispatchTool` re-enter a nested scope
 *  holding a SHALLOW COPY of the turn store. */
function stubPrivacyGuard(): NonNullable<OrchestratorOpts['privacyGuard']> {
  // Every member `privacyHandle.ts` reaches for — a missing one throws rather
  // than degrading, and the point of this stub is only to make the handle exist.
  const service = {
    v4ToolSpecs: () => [],
    runV4Tool: async () => ({ text: '[v4]' }),
    internToolResultV4: async () => ({ digestText: '[digest]', datasetId: 'ds-1' }),
    subAgentResultV4: async () => ({ digestText: '[digest]' }),
    takeRenderedAnswerV4: () => undefined,
    recordBypassedTool: async () => undefined,
    // The prompt-masking members are OPTIONAL on the contract; omitting them
    // makes the handle report `disabled` and keeps this stub about the one
    // thing under test — that a privacy handle EXISTS, which is what makes
    // dispatch re-enter a nested (shallow-copied) turn scope.
    finalizeTurn: async () => undefined,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return () => service as any;
}

function buildOrchestrator(opts: {
  messages: AnyMessage[];
  hits?: Array<{ origin: Origin; reason?: Reason }>;
  insights?: number;
  memoryResult?: string;
  withPrivacyGuard?: boolean;
}): Orchestrator {
  return new Orchestrator({
    provider: fakeCreateProvider(opts.messages),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 5,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    contextRetriever: fakeRetriever({
      hits: opts.hits ?? [],
      ...(opts.insights !== undefined ? { insights: opts.insights } : {}),
    }),
    memoryToolHandler: {
      handle: async () => opts.memoryResult ?? WRITE_OK,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    ...(opts.withPrivacyGuard ? { privacyGuard: stubPrivacyGuard() } : {}),
  });
}

const turn = { userMessage: 'ping', sessionScope: 'scope-a' };
const TAIL_ONLY: Array<{ origin: Origin }> = [
  { origin: 'tail' },
  { origin: 'tail' },
];

describe('Fresh-Check gate — recalled context vs. the live tail', () => {
  it('stays off when the block carried ONLY the current chat tail', async () => {
    // The field-reported case: "ping" → "Pong." in a running conversation.
    const orch = buildOrchestrator({
      messages: [textMsg('Pong.')],
      hits: TAIL_ONLY,
    });
    const result = await orch.runTurn(turn);
    assert.equal(result.memoryUsed, undefined);
  });

  it('stays off when nothing was retrieved at all', async () => {
    const orch = buildOrchestrator({ messages: [textMsg('Pong.')], hits: [] });
    const result = await orch.runTurn(turn);
    assert.equal(result.memoryUsed, undefined);
  });

  it('stays off for a tail turn whose `reason` an agent-priority boost rewrote', async () => {
    // `reason` is presentational — a boost overwrites the leg that found the
    // hit. Branching on it would arm the gate on a pure-tail turn.
    const orch = buildOrchestrator({
      messages: [textMsg('Pong.')],
      hits: [{ origin: 'tail', reason: 'agent-boost' }],
    });
    const result = await orch.runTurn(turn);
    assert.equal(result.memoryUsed, undefined);
  });

  it('arms on an FTS hit alongside the tail', async () => {
    const orch = buildOrchestrator({
      messages: [textMsg('Antwort.')],
      hits: [{ origin: 'tail' }, { origin: 'fts' }],
    });
    const result = await orch.runTurn(turn);
    assert.equal(result.memoryUsed, true);
  });

  it('arms on an entity hit (recall from other sessions by construction)', async () => {
    const orch = buildOrchestrator({
      messages: [textMsg('Antwort.')],
      hits: [{ origin: 'entity' }],
    });
    const result = await orch.runTurn(turn);
    assert.equal(result.memoryUsed, true);
  });

  it('arms on a cross-session insight even when `included` is tail-only', async () => {
    // Plans/processes/insights never enter `included` — they render as their
    // own block, so the gate has to read the recall probe separately.
    const orch = buildOrchestrator({
      messages: [textMsg('Antwort.')],
      hits: TAIL_ONLY,
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
      hits: TAIL_ONLY,
      memoryResult: DIR_LISTING('/memories'),
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
      hits: TAIL_ONLY,
      memoryResult: DIR_LISTING('/memories/observations'),
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
      hits: TAIL_ONLY,
      memoryResult: FILE_CONTENT('/memories/observations/urlaubsantraege-routine.md'),
    });
    const result = await orch.runTurn(turn);
    assert.equal(result.memoryUsed, true);
  });

  it('arms on an extension-less memory file — the RESULT decides, not the path', async () => {
    const orch = buildOrchestrator({
      messages: [
        memoryToolMsg({ command: 'view', path: '/memories/observations/urlaub' }),
        textMsg('Antwort.'),
      ],
      hits: TAIL_ONLY,
      memoryResult: FILE_CONTENT('/memories/observations/urlaub'),
    });
    const result = await orch.runTurn(turn);
    assert.equal(result.memoryUsed, true);
  });

  it('stays off when the read FAILED — nothing was contributed', async () => {
    const orch = buildOrchestrator({
      messages: [
        memoryToolMsg({ command: 'view', path: '/memories/weg.md' }),
        textMsg('Pong.'),
      ],
      hits: TAIL_ONLY,
      memoryResult: READ_FAILED,
    });
    const result = await orch.runTurn(turn);
    assert.equal(result.memoryUsed, undefined);
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
      hits: TAIL_ONLY,
      memoryResult: WRITE_OK,
    });
    const result = await orch.runTurn(turn);
    assert.equal(result.memoryUsed, undefined);
  });
});

describe('Fresh-Check gate — survives the privacy guard (regression)', () => {
  // With a `privacy.redact@1` provider installed — the production
  // configuration — `dispatchTool` re-enters a nested turn scope holding a
  // SHALLOW COPY of the store. A memory read recorded on a plain field would
  // land on that copy and be discarded when the scope returns, so the gate
  // would work only on guard-less hosts. The flag is a mutable holder for
  // exactly this reason; without it this test fails and the others do not.
  it('still arms on a memory file read when a privacy guard is installed', async () => {
    const orch = buildOrchestrator({
      messages: [
        memoryToolMsg({ command: 'view', path: '/memories/observations/routine.md' }),
        textMsg('Antwort.'),
      ],
      hits: TAIL_ONLY,
      memoryResult: FILE_CONTENT('/memories/observations/routine.md'),
      withPrivacyGuard: true,
    });
    const result = await orch.runTurn(turn);
    assert.equal(result.memoryUsed, true);
  });

  it('still stays off on a tail-only turn when a privacy guard is installed', async () => {
    const orch = buildOrchestrator({
      messages: [
        memoryToolMsg({ command: 'view', path: '/memories' }),
        textMsg('Pong.'),
      ],
      hits: TAIL_ONLY,
      memoryResult: DIR_LISTING('/memories'),
      withPrivacyGuard: true,
    });
    const result = await orch.runTurn(turn);
    assert.equal(result.memoryUsed, undefined);
  });
});
