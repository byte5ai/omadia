/**
 * #2085 — side-channel data on both orchestrator output paths (spec 2042
 * §5.13): a turn that called `deliver_data` carries the table on the
 * buffered `ChatTurnResult` / `SemanticAnswer` and on the streamed `done`
 * (rendered into `answer` before the AI disclosure, `textWithoutData`
 * beside it); the model's next request holds the status, not the rows; a
 * verifier re-entry on the same request keeps the table; an answer that
 * discretion (#2079) refuses as a whole goes out without its rows.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ChatStreamEvent, ChatTurnInput } from '@omadia/channel-sdk';
import type { LlmProvider, LlmRequest, LlmResponse, LlmStreamEvent } from '@omadia/llm-provider';
import type { KnowledgeGraph } from '@omadia/plugin-api';
import {
  addTurnLabels,
  NativeToolRegistry,
  Orchestrator,
  readersOf,
  ToolReplayLedger,
  turnContext,
  type DiscretionPort,
  type OrchestratorOptions,
} from '@omadia/orchestrator';

import { createDataActionRunner } from '../src/triggers/dataActions.js';
import { createDeliverDataHandler, DELIVER_DATA_TOOL_NAME, deliverDataToolSpec } from '../src/triggers/deliverDataTool.js';

const SECRET_ROW = 'RE-2026-0412';
const LINE = 'Diese Antwort wurde von einem KI-System erzeugt.';
const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } as const;

/** Calls `deliver_data` once per turn, then answers in prose. Records every request. */
function scriptedProvider(requests: LlmRequest[]): LlmProvider {
  const respond = (req: LlmRequest): LlmResponse => {
    requests.push(req);
    const last = JSON.stringify(req.messages[req.messages.length - 1] ?? {});
    const answered = last.includes('tool_result');
    return {
      content: answered
        ? [{ type: 'text', text: 'Hier sind die offenen Rechnungen.' }]
        : [{ type: 'tool_call', id: 'c1', name: DELIVER_DATA_TOOL_NAME, input: { tool: 'odoo_open_invoices', title: 'Offen' } }],
      finishReason: answered ? 'stop' : 'tool_calls',
      model: 'test',
      usage,
    } as unknown as LlmResponse;
  };
  return {
    id: 'anthropic',
    capabilities: { tools: true, vision: true, streaming: true, promptCaching: true, forcedToolChoice: true, parallelToolCalls: true },
    complete: async (req: LlmRequest): Promise<LlmResponse> => respond(req),
    stream: (req: LlmRequest): AsyncIterable<LlmStreamEvent> => ({
      async *[Symbol.asyncIterator]() {
        const response = respond(req);
        for (const part of response.content) if (part.type === 'text') yield { type: 'text_delta', text: part.text };
        yield { type: 'final', response };
      },
    }),
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

function build(requests: LlmRequest[], extra: Partial<OrchestratorOptions> = {}, onRead?: () => void): Orchestrator {
  const registry = new NativeToolRegistry();
  const runner = createDataActionRunner(() =>
    new Map([
      [
        'odoo_open_invoices',
        async () => {
          onRead?.();
          return JSON.stringify([{ number: SECRET_ROW, amount: 1234.5 }]);
        },
      ],
    ]),
  );
  registry.register(DELIVER_DATA_TOOL_NAME, {
    handler: createDeliverDataHandler({ dataActions: runner }),
    spec: deliverDataToolSpec,
  });
  return new Orchestrator({
    provider: scriptedProvider(requests),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 3,
    domainTools: [],
    nativeToolRegistry: registry,
    ...extra,
  });
}

/** Canonical id = channel id: enough identity for the roster rule. */
const knowledgeGraph = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === 'resolveOrCreateChannelIdentity') {
        return async (input: { channelUserId: string }) => ({ omadiaUserId: input.channelUserId });
      }
      return undefined;
    },
  },
) as unknown as KnowledgeGraph;

const discretion: DiscretionPort = {
  declarationOf: async () => undefined,
  labelsOf: async () => new Map(),
  persistLabels: async () => undefined,
  audit: () => undefined,
};

/** A group turn whose read brings in what only a and b may know. */
function narrowGroupTurn(): { orchestrator: Orchestrator; input: ChatTurnInput; participants: () => Promise<unknown[]> } {
  const orchestrator = build([], { agentId: 'mira', knowledgeGraph, discretion } as Partial<OrchestratorOptions>, () =>
    addTurnLabels([{ kind: 'context', key: 'telegram:dm-ab', readers: readersOf(['a', 'b']) }]),
  );
  const participants = Object.assign(
    async () => ['a', 'b', 'c'].map((id) => ({ kind: 'user', channelUserId: id, displayName: id })),
    { completeRoster: true },
  );
  const input = {
    userMessage: 'Offene Rechnungen?',
    sessionScope: 'teams-group-1',
    userId: 'a',
    origin: {
      channelType: 'telegram',
      scope: { kind: 'conversation', conversationId: 'group-1' },
      conversationType: 'group',
      channelConversationId: 'group-1',
    },
  } as ChatTurnInput;
  return { orchestrator, input, participants };
}

async function streamDone(o: Orchestrator, input: ChatTurnInput): Promise<Extract<ChatStreamEvent, { type: 'done' }>> {
  let done: Extract<ChatStreamEvent, { type: 'done' }> | undefined;
  for await (const ev of o.chatStream(input)) if (ev.type === 'done') done = ev;
  assert.ok(done, 'no done event');
  return done;
}

const modelSaw = (requests: readonly LlmRequest[]): string => JSON.stringify(requests.map((r) => r.messages));

describe('#2085 side channel through the orchestrator', () => {
  it('buffered: the answer carries the table, the model only the status', async () => {
    const requests: LlmRequest[] = [];
    const answer = await build(requests).chat({ userMessage: 'Offene Rechnungen?', sessionScope: 'sc-1' });
    assert.equal(answer.data?.length, 1);
    assert.ok(answer.text.includes(`| ${SECRET_ROW} | 1234.5 |`), answer.text);
    assert.ok(answer.text.endsWith(LINE), 'disclosure after the table');
    assert.equal(answer.textWithoutData, `Hier sind die offenen Rechnungen.\n\n${LINE}`);
    assert.equal(modelSaw(requests).includes(SECRET_ROW), false, 'a row reached the model');
    assert.ok(modelSaw(requests).includes('"rows\\":1'), 'the model got the row count');
  });

  it('stream: the done event carries the table, rendered before the disclosure', async () => {
    const requests: LlmRequest[] = [];
    const done = await streamDone(build(requests), { userMessage: 'Offene Rechnungen?', sessionScope: 'sc-2' });
    assert.equal(done.data?.length, 1);
    assert.ok(done.answer.startsWith('Hier sind die offenen Rechnungen.\n\n**Offen**'), done.answer);
    assert.ok(done.answer.endsWith(LINE));
    assert.equal(done.textWithoutData, `Hier sind die offenen Rechnungen.\n\n${LINE}`);
    assert.equal(modelSaw(requests).includes(SECRET_ROW), false, 'a row reached the model');
  });

  it('a verifier re-entry replays deliver_data and keeps the table', async () => {
    const requests: LlmRequest[] = [];
    const o = build(requests);
    const input: ChatTurnInput = { userMessage: 'Offene Rechnungen?', sessionScope: 'sc-3' };
    const ledger = new ToolReplayLedger();
    const release = o.bindToolReplayLedger(input, ledger);
    const first = await streamDone(o, input);
    ledger.beginReentry();
    const retryInput: ChatTurnInput = { ...input, extraSystemHint: 'Korrigiere.' };
    const releaseRetry = o.bindToolReplayLedger(retryInput, ledger);
    const retry = await streamDone(o, retryInput);
    release();
    releaseRetry();
    assert.equal(first.data?.length, 1);
    assert.deepEqual(retry.data, first.data, 'the retry answer carries the first pass table');
  });

  it('a turn without deliver_data is unchanged', async () => {
    const o = new Orchestrator({
      provider: {
        ...scriptedProvider([]),
        complete: async () =>
          ({ content: [{ type: 'text', text: 'Hallo.' }], finishReason: 'stop', model: 'test', usage }) as unknown as LlmResponse,
      } as LlmProvider,
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 3,
      domainTools: [],
      nativeToolRegistry: new NativeToolRegistry(),
    });
    const answer = await o.chat({ userMessage: 'Hi', sessionScope: 'sc-4' });
    assert.equal(answer.data, undefined);
    assert.equal(answer.textWithoutData, undefined);
  });

  it('an answer discretion refuses as a whole carries no rows (#2079)', async () => {
    const buffered = narrowGroupTurn();
    const answer = await turnContext.runWithChatParticipants(buffered.participants as never, () =>
      buffered.orchestrator.chat(buffered.input),
    );
    assert.match(answer.text, /nicht alle hier|not everyone here/);
    assert.equal(answer.data, undefined, 'the rows were withheld with the answer');
    assert.equal(answer.text.includes(SECRET_ROW), false);

    const streamed = narrowGroupTurn();
    const done = await turnContext.runWithChatParticipants(streamed.participants as never, () =>
      streamDone(streamed.orchestrator, streamed.input),
    );
    assert.equal(done.data, undefined, 'the streamed done carries no rows either');
    assert.equal(done.answer.includes(SECRET_ROW), false);
  });
});
