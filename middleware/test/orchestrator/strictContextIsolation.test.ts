/**
 * `enforce-strict` context memory, end to end: knowledge stays with the
 * context that owns it.
 *
 * Measured on main b137610d: with the agent in `enforce-strict`, the context
 * notes were separated, but an earlier Teams conversation still reached a
 * Telegram turn of the same agent three ways:
 *
 *   (a) the `memory` tool could read its transcript under `/memories/sessions/`
 *       (`ro:core` kept the transcript trees readable);
 *   (b) `query_knowledge_graph` searched the whole tenant graph;
 *   (c) automatic recall pulled it into the prompt without any tool call.
 *
 * These tests run real orchestrator turns — the binder, the session logger,
 * the graph and the recall assembler are the production classes, only the
 * model is scripted — and inspect what actually went into the model's
 * requests. The control runs the same script in `enforce`, where cross-
 * conversation recall within the agent is the documented behaviour, and must
 * show the leak: otherwise these tests could pass because the content never
 * existed rather than because it was kept out.
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { LlmProvider, LlmResponse, LlmStreamEvent } from '@omadia/llm-provider';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { InMemoryMemoryStore, MemoryToolHandler } from '@omadia/memory';
import {
  MemoryBinder,
  NativeToolRegistry,
  Orchestrator,
  SessionLogger,
  type ContextMemoryMode,
} from '@omadia/orchestrator';
import { ContextRetriever } from '@omadia/orchestrator-extras';
import type { TurnOrigin } from '../../packages/harness-channel-sdk/src/turnOrigin.js';
import { parseSessionScope } from '../../packages/harness-channel-sdk/src/scopeId.js';

const AGENT = 'strict-agent';
/** Only the Teams turn says this; it must not reach the Telegram turn. */
const SECRET = 'Budget von 4,2 Mio Euro';
const TEAMS_SCOPE = 'msteams::conv-kranich';
const TELEGRAM_SCOPE = 'telegram::-1009876543210';

const teamsOrigin: TurnOrigin = {
  channelType: 'teams',
  scope: parseSessionScope(TEAMS_SCOPE),
  container: { kind: 'team', id: 'team-alpha' },
};
const telegramOrigin: TurnOrigin = {
  channelType: 'telegram',
  scope: parseSessionScope(TELEGRAM_SCOPE),
};

const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };

function toolCall(id: string, name: string, input: unknown): LlmStreamEvent[] {
  return [
    {
      type: 'final',
      response: {
        content: [{ type: 'tool_call', id, name, input }],
        finishReason: 'tool_calls',
        providerFinishReason: 'tool_use',
        model: 'test',
        usage,
      },
    } as LlmStreamEvent,
  ];
}

function answer(text: string): LlmStreamEvent[] {
  return [
    { type: 'text_delta', text },
    {
      type: 'final',
      response: {
        content: [{ type: 'text', text }],
        finishReason: 'stop',
        providerFinishReason: 'end_turn',
        model: 'test',
        usage,
      },
    } as LlmStreamEvent,
  ];
}

/** Scripted provider that records every request it is sent. */
function recordingProvider(streams: LlmStreamEvent[][], requests: string[]): LlmProvider {
  let idx = 0;
  const take = (req: unknown): LlmStreamEvent[] => {
    requests.push(JSON.stringify(req));
    const events = streams[idx];
    if (!events) throw new Error(`no scripted stream for provider call ${String(idx + 1)}`);
    idx += 1;
    return events;
  };
  return {
    id: 'anthropic',
    capabilities: {
      tools: true,
      vision: false,
      streaming: true,
      promptCaching: false,
      forcedToolChoice: false,
      parallelToolCalls: false,
    },
    complete: async (req: unknown): Promise<LlmResponse> =>
      Promise.resolve((take(req).at(-1) as { response: LlmResponse }).response),
    stream: (req: unknown): AsyncIterable<LlmStreamEvent> => {
      const events = take(req);
      return {
        async *[Symbol.asyncIterator]() {
          for (const ev of events) yield ev;
        },
      };
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

interface Run {
  /** Every request of the Telegram turn, serialised. */
  readonly telegramRequests: string[];
  readonly telegramAnswer: string;
}

/**
 * Teams turn (states the secret), then a Telegram turn of the same agent that
 * calls `query_knowledge_graph`, then lists `/memories/sessions` via the
 * memory tool, then answers.
 */
async function teamsThenTelegram(mode: ContextMemoryMode): Promise<Run> {
  const root = new InMemoryMemoryStore();
  const graph = new InMemoryKnowledgeGraph();
  const requests: string[] = [];
  const orchestrator = new Orchestrator({
    provider: recordingProvider(
      [
        answer('Notiert.'),
        toolCall('tu-kg', 'query_knowledge_graph', { query: 'search_turns', text: 'Kranich' }),
        toolCall('tu-mem', 'memory', { command: 'view', path: '/memories/sessions' }),
        answer('Dazu habe ich hier nichts.'),
      ],
      requests,
    ),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 5,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    agentId: AGENT,
    knowledgeGraph: graph,
    contextRetriever: new ContextRetriever(graph),
    // Agent-qualified graph scopes, as every logger the orchestrator plugin builds.
    sessionLogger: new SessionLogger(root, graph, undefined, AGENT),
    memoryToolHandler: new MemoryToolHandler(root),
    memoryBinder: new MemoryBinder({ agentSlug: AGENT, root, mode }),
  } as unknown as ConstructorParameters<typeof Orchestrator>[0]);

  for await (const _ of orchestrator.chatStream({
    userMessage: `Projekt Kranich hat ein ${SECRET}.`,
    sessionScope: TEAMS_SCOPE,
    userId: 'same-human',
    origin: teamsOrigin,
  })) {
    // drain
  }
  // The Teams turn really was stored where the Telegram turn could look.
  const stored = await graph.searchTurns({ query: 'Kranich', limit: 5 });
  assert.ok(
    stored.some((h) => h.userMessage.includes(SECRET)),
    'precondition: the Teams turn was not stored in the graph',
  );

  const before = requests.length;
  let telegramAnswer = '';
  for await (const ev of orchestrator.chatStream({
    // Both words occur in the Teams turn; the FTS leg ANDs every word, like
    // `plainto_tsquery`, so a question with filler words would recall nothing.
    userMessage: 'Kranich Budget',
    sessionScope: TELEGRAM_SCOPE,
    userId: 'same-human',
    origin: telegramOrigin,
  })) {
    if (ev.type === 'done') telegramAnswer = String((ev as { answer?: string }).answer ?? '');
  }
  return { telegramRequests: requests.slice(before), telegramAnswer };
}

describe('enforce-strict keeps another channel’s conversation out of a turn', () => {
  it('CONTROL: in enforce the Teams content reaches the Telegram turn', async () => {
    const run = await teamsThenTelegram('enforce');
    // Each of the three paths on its own, so each strict assertion below is
    // backed by a control that shows it CAN fail.
    assert.ok(run.telegramRequests[0]!.includes(SECRET), 'control: recall did not carry the Teams turn');
    assert.ok(run.telegramRequests[1]!.includes(SECRET), 'control: the graph tool did not find the Teams turn');
    assert.ok(run.telegramRequests[2]!.includes('conv-kranich'), 'control: the memory tool did not list the transcript');
  });

  it('enforce-strict: no recall, no graph hit and no transcript from the Teams conversation', async () => {
    const run = await teamsThenTelegram('enforce-strict');
    assert.equal(run.telegramRequests.length, 3, 'the scripted Telegram turn did not run to its end');

    // (c) automatic recall — the FIRST request is built before any tool runs.
    assert.ok(
      !run.telegramRequests[0]!.includes(SECRET),
      'automatic recall put the Teams conversation into the Telegram prompt',
    );
    // (b) query_knowledge_graph — its result is in the SECOND request.
    assert.ok(
      !run.telegramRequests[1]!.includes(SECRET),
      'query_knowledge_graph returned the Teams conversation',
    );
    // (a) the memory tool — its result is in the THIRD request.
    assert.ok(
      !run.telegramRequests[2]!.includes('conv-kranich'),
      'the memory tool listed the Teams transcript',
    );
    assert.ok(!run.telegramRequests.some((r) => r.includes(SECRET)));
    assert.ok(run.telegramAnswer.startsWith('Dazu habe ich hier nichts.'));
  });
});
