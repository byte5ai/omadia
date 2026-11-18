/**
 * OB-81 — `captureDisclosure` was declared on the wire and rendered by the chat,
 * but nothing produced it: no turn ever carried one. These tests pin the chain
 * from the capture filter's decision to the stream's `done` event, including
 * the three ways a `done` gets its Turn id: written inside the turn, committed
 * by a verifier, and written by the fast path.
 *
 * The chain runs on the real decorator, the real `SessionLogger` and the real
 * in-memory graph. All values are synthetic.
 */

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import type { ChatAgent, ChatStreamEvent, ChatTurnInput } from '@omadia/channel-sdk';
import type { LlmProvider, LlmRequest, LlmResponse, LlmStreamEvent } from '@omadia/llm-provider';
import { NativeToolRegistry, Orchestrator } from '@omadia/orchestrator';
import type { CaptureDisclosure, KnowledgeGraph, TurnIngestResult } from '@omadia/plugin-api';

import { InMemoryMemoryStore } from '../packages/harness-memory/src/inMemoryMemoryStore.js';
import { InMemoryKnowledgeGraph } from '../packages/harness-knowledge-graph-inmemory/src/inMemoryKnowledgeGraph.js';
import { CaptureFilter, type CaptureLevel } from '../packages/harness-orchestrator-extras/src/captureFilter.js';
import { CaptureFilteringKnowledgeGraph } from '../packages/harness-orchestrator-extras/src/captureFilteringKnowledgeGraph.js';
import { wrapChatAgentWithFastPath } from '../packages/harness-orchestrator/src/fastPathAgent.js';
import { RequestTurnRecord } from '../packages/harness-orchestrator/src/requestTurnRecord.js';
import { SessionLogger, type SessionLogEntry } from '../packages/harness-orchestrator/src/sessionLogger.js';
import { TurnRecordWriter } from '../packages/harness-orchestrator/src/turnRecordWriter.js';
import { withheldDone } from '../packages/harness-orchestrator/src/verifierDelivery.js';
import { finishRequestDone } from '../packages/harness-orchestrator/src/verifierReentry.js';
import type { ToolReplayLedger } from '../packages/harness-orchestrator/src/toolReplayLedger.js';

type DoneEvent = Extract<ChatStreamEvent, { type: 'done' }>;

const THRESHOLD = 0.2;
const SCOPE = 'tab_capture_disclosure';

function filtered(
  level: CaptureLevel,
  score: number | undefined,
  inner: KnowledgeGraph = new InMemoryKnowledgeGraph(),
): CaptureFilteringKnowledgeGraph {
  return new CaptureFilteringKnowledgeGraph({
    inner,
    filter: new CaptureFilter({
      captureLevel: level,
      defaultVisibility: 'team',
      significanceThreshold: THRESHOLD,
      ...(score === undefined ? {} : { significanceScorer: { score: async () => ({ score }) } }),
      log: () => {},
    }),
    log: () => {},
  });
}

function loggerOver(graph: KnowledgeGraph): SessionLogger {
  return new SessionLogger(new InMemoryMemoryStore(), graph);
}

async function disclosureOf(
  graph: KnowledgeGraph,
  userMessage = 'Wie lautet das Passwort?',
  assistantAnswer = 'Das steht im Tresor.',
): Promise<CaptureDisclosure | undefined> {
  const { captureDisclosure } = await loggerOver(graph).log({
    scope: SCOPE,
    userMessage,
    assistantAnswer,
    toolCalls: 0,
    iterations: 1,
  });
  return captureDisclosure;
}

describe('capture filter decision → SessionLogger.log', () => {
  it('discloses a persisted turn: classification, score and what was stripped', async () => {
    const disclosure = await disclosureOf(
      filtered('normal', 0.8),
      'Hallo <private>geheim</private> <palaia-hint type="process" />',
      'Antwort',
    );
    assert.ok(disclosure);
    assert.equal(disclosure.persisted, true);
    assert.equal(disclosure.entryType, 'process');
    assert.equal(disclosure.visibility, 'team');
    assert.equal(disclosure.significance, 0.8);
    assert.equal(disclosure.privacyBlocksStripped, 1);
    assert.equal(disclosure.hintTagsProcessed, 1);
    assert.ok(disclosure.reasons.includes('scored=0.80'), disclosure.reasons.join('|'));
  });

  it('a sub-threshold turn reads as not persisted and keeps the score that filtered it', async () => {
    const disclosure = await disclosureOf(filtered('normal', 0.05));
    assert.ok(disclosure);
    assert.equal(disclosure.persisted, false);
    assert.equal(disclosure.entryType, null);
    assert.equal(disclosure.visibility, null);
    assert.equal(disclosure.significance, 0.05);
    assert.equal(disclosure.embedded, false);
    assert.ok(disclosure.reasons.some((r) => r.startsWith('dropped:')), disclosure.reasons.join('|'));
  });

  it('level=minimal discloses without a score', async () => {
    const disclosure = await disclosureOf(filtered('minimal', undefined));
    assert.ok(disclosure);
    assert.equal(disclosure.persisted, true);
    assert.equal(disclosure.significance, null);
  });

  it('level=off decides nothing, so there is nothing to disclose', async () => {
    assert.equal(await disclosureOf(filtered('off', undefined)), undefined);
  });

  it('a graph without a capture filter discloses nothing', async () => {
    assert.equal(await disclosureOf(new InMemoryKnowledgeGraph()), undefined);
  });

  it('`embedded` follows what the backend scheduled', async () => {
    const backend = new InMemoryKnowledgeGraph();
    const ingestTurn = backend.ingestTurn.bind(backend);
    backend.ingestTurn = async (turn): Promise<TurnIngestResult> => ({
      ...(await ingestTurn(turn)),
      embeddingScheduled: true,
    });
    assert.equal((await disclosureOf(filtered('minimal', undefined, backend)))?.embedded, true);
    assert.equal(
      (await disclosureOf(filtered('minimal', undefined)))?.embedded,
      false,
      'a backend without vectors schedules none',
    );
  });

  it('never carries the turn’s text', async () => {
    const disclosure = await disclosureOf(filtered('normal', 0.8), 'NUTZERTEXT', 'ANTWORTTEXT');
    const wire = JSON.stringify(disclosure);
    assert.ok(!wire.includes('NUTZERTEXT'), wire);
    assert.ok(!wire.includes('ANTWORTTEXT'), wire);
  });

  it('a failed ingest discloses nothing — the turn was not written', async () => {
    const graph = filtered('normal', 0.8);
    graph.ingestTurn = () => Promise.reject(new Error('graph down'));
    assert.equal(await disclosureOf(graph), undefined);
  });
});

const DISCLOSURE: CaptureDisclosure = {
  persisted: true,
  reasons: ['scored=0.80'],
  entryType: 'memory',
  visibility: 'team',
  significance: 0.8,
  embedded: false,
  privacyBlocksStripped: 0,
  hintTagsProcessed: 0,
};

describe('TurnRecordWriter pending disclosures', () => {
  function writerWith(captureDisclosure: CaptureDisclosure | undefined): TurnRecordWriter {
    let row = 0;
    const sessionLogger = {
      log: async () => ({
        turnExternalId: `turn:${String((row += 1))}`,
        ...(captureDisclosure ? { captureDisclosure } : {}),
      }),
    } as unknown as SessionLogger;
    return new TurnRecordWriter({ sessionLogger, factExtractor: undefined });
  }

  const entry = { scope: SCOPE, userMessage: 'u', assistantAnswer: 'a', toolCalls: 0, iterations: 1 };

  it('hands a written row’s disclosure out once', async () => {
    const writer = writerWith(DISCLOSURE);
    const turnId = await writer.writeRow(entry, 'test');
    assert.deepEqual(writer.takeCaptureDisclosure(turnId), DISCLOSURE);
    assert.equal(writer.takeCaptureDisclosure(turnId), undefined);
    assert.equal(writer.takeCaptureDisclosure(undefined), undefined);
  });

  it('stays bounded when no `done` takes them (non-streaming turns)', async () => {
    const writer = writerWith(DISCLOSURE);
    const first = await writer.writeRow(entry, 'test');
    let last: string | undefined;
    for (let i = 0; i < 256; i += 1) last = await writer.writeRow(entry, 'test');
    assert.equal(writer.takeCaptureDisclosure(first), undefined, 'the oldest entry is evicted');
    assert.deepEqual(writer.takeCaptureDisclosure(last), DISCLOSURE);
  });

  it('a deferred row brings its disclosure through the commit to `done`', async () => {
    const writer = writerWith(DISCLOSURE);
    const turnRecord = new RequestTurnRecord();
    const ledger = {
      pass: 0,
      turnRecord,
      receipts: { merged: () => undefined, rowId: undefined, commit: async () => {} },
    } as unknown as ToolReplayLedger;
    writer.offerRow(ledger, { entry, entityRefs: [] }, 'test');

    const offered: DoneEvent = { type: 'done', answer: 'a', toolCalls: 0, iterations: 1 };
    const { done } = await finishRequestDone(offered, 0, ledger);
    assert.deepEqual(done.captureDisclosure, DISCLOSURE);
    assert.equal(done.turnId, 'turn:1');
  });
});

describe('`done` carries the disclosure', () => {
  it('survives a withheld answer: it holds no answer content', () => {
    const { done } = withheldDone(
      { type: 'done', answer: 'zurückgehalten', toolCalls: 0, iterations: 1, captureDisclosure: DISCLOSURE },
      { status: 'blocked' } as never,
      'de',
    );
    assert.deepEqual(done.captureDisclosure, DISCLOSURE);
  });

  function provider(answerText: string): LlmProvider {
    const response = {
      content: [{ type: 'text', text: answerText }],
      finishReason: 'stop',
      providerFinishReason: 'end_turn',
      model: 'test',
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    } as unknown as LlmResponse;
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
      complete: async (): Promise<LlmResponse> => response,
      stream: (_req: LlmRequest): AsyncIterable<LlmStreamEvent> => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'text_delta', text: answerText };
          yield { type: 'final', response };
        },
      }),
      classifyError: () => ({ retryable: false, kind: 'other' as const }),
    } as unknown as LlmProvider;
  }

  async function streamDone(agent: Pick<ChatAgent, 'chatStream'>, input: ChatTurnInput): Promise<DoneEvent> {
    let done: DoneEvent | undefined;
    for await (const event of agent.chatStream(input)) {
      if (event.type === 'done') done = event;
    }
    assert.ok(done, 'no done event');
    return done;
  }

  it('on an orchestrator turn that wrote its row', async () => {
    const orchestrator = new Orchestrator({
      provider: provider('Antwort.'),
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 3,
      domainTools: [],
      nativeToolRegistry: new NativeToolRegistry(),
      sessionLogger: loggerOver(filtered('normal', 0.8)) as never,
    });
    const done = await streamDone(orchestrator, { userMessage: 'Frage', sessionScope: SCOPE });
    assert.ok(done.turnId, 'the row was written inside the turn');
    assert.equal(done.captureDisclosure?.persisted, true);
    assert.equal(done.captureDisclosure?.significance, 0.8);
  });

  it('not on a turn without a session scope: no row, nothing to disclose', async () => {
    const orchestrator = new Orchestrator({
      provider: provider('Antwort.'),
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 3,
      domainTools: [],
      nativeToolRegistry: new NativeToolRegistry(),
      sessionLogger: loggerOver(filtered('normal', 0.8)) as never,
    });
    const done = await streamDone(orchestrator, { userMessage: 'Frage' });
    assert.equal(done.captureDisclosure, undefined);
  });

  it('on the record of a subscription-CLI turn', async () => {
    const orchestrator = new Orchestrator({
      provider: provider('unused'),
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 3,
      domainTools: [],
      nativeToolRegistry: new NativeToolRegistry(),
      sessionLogger: loggerOver(filtered('minimal', undefined)) as never,
    });
    const record = await orchestrator.recordCliTurn(
      { userMessage: 'Frage', sessionScope: SCOPE },
      {
        turnId: 'cli-turn',
        answer: 'Antwort.',
        toolCalls: 0,
        iterations: 1,
        runTrace: {
          scope: SCOPE,
          startedAt: '2026-11-04T10:00:00.000Z',
          finishedAt: '2026-11-04T10:00:01.000Z',
          durationMs: 1000,
          status: 'success',
          iterations: 1,
          orchestratorToolCalls: [],
          agentInvocations: [],
        },
      },
    );
    assert.equal(record.captureDisclosure?.persisted, true);
  });

  it('on a fast-path answer', async () => {
    const logger = loggerOver(filtered('minimal', undefined));
    const agent = wrapChatAgentWithFastPath({} as ChatAgent, {
      fastPath: () => ({
        channelEnabled: () => true,
        triageChatTurn: () =>
          Promise.resolve({ kind: 'answer', text: 'rows', tool: 'odoo_query', rows: 2, toolCalls: 1, ms: 30 }),
      }),
      logSession: (entry: SessionLogEntry) => logger.log(entry),
      privacyGuarded: () => false,
      permittedTools: () => new Set(['odoo_query']),
      log: () => {},
    } as never);
    const done = await streamDone(agent, { userMessage: 'Offene Posten?', sessionScope: 'tab_1' });
    assert.equal(done.captureDisclosure?.persisted, true);
  });
});
