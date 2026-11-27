/**
 * Spec 2042 §5.11 / §6 criteria 18 and 27 through a real turn:
 *
 *  - a group turn recalls a turn that kept the label of a narrower room
 *    (persisted transitively); the model paraphrases it; the answer is
 *    refused AS A WHOLE for the group — nothing of it reaches the people
 *    there, and the session log keeps only the line that replaced it;
 *  - the same recall where everyone present may know it answers normally;
 *  - the written turn keeps its label set (transitive persistence).
 *
 * Real `Orchestrator`, scripted model, fake retriever and stores.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { KnowledgeGraph } from '@omadia/plugin-api';

import type { ChatTurnInput } from '../../packages/harness-channel-sdk/src/chatAgent.js';
import { NativeToolRegistry } from '../../packages/harness-orchestrator/src/nativeToolRegistry.js';
import { Orchestrator, type OrchestratorOptions } from '../../packages/harness-orchestrator/src/orchestrator.js';
import { turnContext } from '../../packages/harness-orchestrator/src/turnContext.js';
import { readersOf, unionLabels, type LabelSet } from '../../packages/harness-orchestrator/src/discretion/labels.js';
import { createDiscretionTurnState } from '../../packages/harness-orchestrator/src/discretion/turnLabels.js';
import type { DiscretionAuditEntry, DiscretionPort } from '../../packages/harness-orchestrator/src/discretion/port.js';
import { scriptedModel, text, toolCalls } from '../_helpers/replayTurnFixture.js';
import type { LlmProvider, LlmRequest, LlmResponse } from '@omadia/llm-provider';
import {
  NativeToolRegistry as DistNativeToolRegistry,
  Orchestrator as DistOrchestrator,
  turnContext as distTurnContext,
} from '@omadia/orchestrator';
import { RAW_EMAIL, countingService } from '../_helpers/privacyEgressHarness.js';

const SECRET = 'Paula verlässt das Unternehmen zum Monatsende';

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

function groupTurn(members: string[]): { input: ChatTurnInput; participants: () => Promise<unknown[]> } {
  const participants = Object.assign(
    async () => members.map((id) => ({ kind: 'user', channelUserId: id, displayName: id })),
    { completeRoster: true },
  );
  return {
    input: {
      userMessage: 'Was gibt es Neues im Team?',
      sessionScope: 'teams-group-1',
      userId: members[0],
      origin: {
        channelType: 'telegram',
        scope: { kind: 'conversation', conversationId: 'group-1' },
        conversationType: 'group',
        channelConversationId: 'group-1',
      },
    } as ChatTurnInput,
    participants,
  };
}

/** The scripted model, streaming its text in chunks before the final response. */
function streamingInChunks(model: ReturnType<typeof scriptedModel>): ReturnType<typeof scriptedModel> {
  const inner = model.provider;
  const provider = {
    ...inner,
    stream: (request: LlmRequest) => ({
      async *[Symbol.asyncIterator]() {
        for await (const event of inner.stream(request) as AsyncIterable<{ type: string; response?: LlmResponse }>) {
          const answer = event.response?.content.find((c) => c.type === 'text');
          if (answer?.type === 'text') {
            for (let i = 0; i < answer.text.length; i += 7) yield { type: 'text_delta', text: answer.text.slice(i, i + 7) };
          }
          yield event;
        }
      },
    }),
  } as unknown as LlmProvider;
  return { ...model, provider };
}

const SIGNED_LINK = 'https://files.example.test/report.xlsx?sig=w42-signed';

function build(recalledLabels: LabelSet, opts: { streamChunks?: boolean; withTool?: boolean } = {}) {
  const scripted = scriptedModel([
    ...(opts.withTool ? [toolCalls(['report_tool', {}])] : []),
    text(`Kurz gesagt: ${SECRET}.`),
  ]);
  const nativeToolRegistry = new NativeToolRegistry();
  if (opts.withTool) {
    nativeToolRegistry.register('report_tool', {
      handler: async () => `Bericht erstellt: ${SIGNED_LINK}`,
      spec: { name: 'report_tool', description: 'd', input_schema: { type: 'object', properties: {} } },
      domain: 'test.report',
    });
  }
  const model = opts.streamChunks ? streamingInChunks(scripted) : scripted;
  const logged: Array<{ assistantAnswer: string }> = [];
  const persisted = new Map<string, LabelSet>();
  const audits: DiscretionAuditEntry[] = [];
  const discretion: DiscretionPort = {
    declarationOf: async () => undefined,
    labelsOf: async (_kind, ids) => new Map(ids.filter((id) => id === 'turn-old').map((id) => [id, recalledLabels])),
    persistLabels: async (_kind, id, _agent, labels) => {
      persisted.set(id, labels);
    },
    audit: (entry) => audits.push(entry),
  };
  const orchestrator = new Orchestrator({
    provider: model.provider,
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 4,
    domainTools: [],
    nativeToolRegistry,
    agentId: 'mira',
    knowledgeGraph,
    discretion,
    contextRetriever: {
      assembleForBudget: async () => ({
        text: `\n[früherer Turn] ${SECRET}`,
        included: [{ turnId: 'turn-old', score: 1, chars: 10, reason: 'fts', origin: 'fts' }],
        excluded: [],
        recalled: { plans: [], processes: [], insights: [] },
        stats: { candidatePool: 1, compactMode: false, tokensUsed: 10 },
      }),
    },
    sessionLogger: {
      log: async (entry: { assistantAnswer: string }) => {
        logged.push(entry);
        return { turnExternalId: 'turn-new' };
      },
    },
  } as unknown as OrchestratorOptions);
  return { orchestrator, model, logged, persisted, audits };
}

describe('the answer egress (criterion 18)', () => {
  it('an answer carrying a narrower room is refused as a whole and never stored', async () => {
    // The recalled turn was written where only a and b were present.
    const narrow = unionLabels([{ kind: 'context', key: 'telegram:dm-ab', readers: readersOf(['a', 'b']) }]);
    const { orchestrator, logged, persisted, audits } = build(narrow);
    const { input, participants } = groupTurn(['a', 'b', 'c']);
    const result = await turnContext.runWithChatParticipants(participants as never, () => orchestrator.chat(input));
    assert.equal(result.text.includes('Paula'), false, 'nothing of it reaches the group');
    assert.match(result.text, /nicht alle hier|not everyone here/);
    assert.equal(logged.length, 1);
    assert.equal(logged[0]!.assistantAnswer.includes('Paula'), false, 'the stored row keeps only the replacement');
    const refusal = audits.find((a) => a.egress === 'people' && !a.allowed);
    assert.ok(refusal, 'the refusal is audited');
    assert.ok(refusal.violations.includes('context:telegram:dm-ab:readers_not_covered'));
    assert.equal(JSON.stringify(audits).includes('Paula'), false, 'the audit never carries content');
    // Criterion 27 — the written turn kept the recalled label (transitively).
    const kept = persisted.get('turn-new');
    assert.ok(kept?.labels.some((l) => l.kind === 'context' && l.key === 'telegram:dm-ab'));
  });

  it('the same recall answers normally when everyone present may know it', async () => {
    const wide = unionLabels([{ kind: 'context', key: 'telegram:dm-ab', readers: readersOf(['a', 'b', 'c']) }]);
    const { orchestrator, logged } = build(wide);
    const { input, participants } = groupTurn(['a', 'b', 'c']);
    const result = await turnContext.runWithChatParticipants(participants as never, () => orchestrator.chat(input));
    assert.match(result.text, /Paula/);
    assert.match(logged[0]!.assistantAnswer, /Paula/);
  });

  it('a streamed answer that is withheld takes back the text it already streamed', async () => {
    const narrow = unionLabels([{ kind: 'context', key: 'telegram:dm-ab', readers: readersOf(['a', 'b']) }]);
    const { orchestrator } = build(narrow, { streamChunks: true });
    const { input, participants } = groupTurn(['a', 'b', 'c']);
    const events: Array<{ type: string; text?: string; chars?: number; answer?: string }> = [];
    await turnContext.runWithChatParticipants(participants as never, async () => {
      for await (const event of orchestrator.chatStream(input)) events.push(event as never);
    });
    const streamed = events.filter((e) => e.type === 'text_delta').map((e) => e.text ?? '').join('');
    assert.match(streamed, /Paula/, 'the model streamed the draft');
    // What a client shows: the deltas, trimmed by every retract.
    let preview = '';
    for (const e of events) {
      if (e.type === 'text_delta') preview += e.text ?? '';
      if (e.type === 'text_retract') preview = preview.slice(0, Math.max(0, preview.length - (e.chars ?? 0)));
    }
    assert.equal(preview, '', 'nothing of the draft stays in the preview');
    const retractAt = events.findIndex((e) => e.type === 'text_retract');
    const doneAt = events.findIndex((e) => e.type === 'done');
    assert.ok(retractAt >= 0 && retractAt < doneAt, 'the retract comes before the done');
    const done = events[doneAt]!;
    assert.equal(done.answer?.includes('Paula'), false);
    assert.match(done.answer ?? '', /nicht alle hier|not everyone here/);
  });

  it('#2342 · a withheld streamed answer never sends the tool outputs of its turn', async () => {
    const narrow = unionLabels([{ kind: 'context', key: 'telegram:dm-ab', readers: readersOf(['a', 'b']) }]);
    const { orchestrator } = build(narrow, { streamChunks: true, withTool: true });
    const { input, participants } = groupTurn(['a', 'b', 'c']);
    const events: Array<{ type: string; output?: string; answer?: string }> = [];
    await turnContext.runWithChatParticipants(participants as never, async () => {
      for await (const event of orchestrator.chatStream(input)) events.push(event as never);
    });
    const results = events.filter((e) => e.type === 'tool_result');
    assert.equal(results.length, 1, 'one result per call: the row shows the call finished');
    assert.equal(JSON.stringify(results).includes('w42-signed'), false, 'no tool output reaches the client');
    assert.match(events.find((e) => e.type === 'done')?.answer ?? '', /nicht alle hier|not everyone here/);
  });

  it('#2342 · an answer everyone may know streams its tool output live, once', async () => {
    const wide = unionLabels([{ kind: 'context', key: 'telegram:dm-ab', readers: readersOf(['a', 'b', 'c']) }]);
    const { orchestrator } = build(wide, { streamChunks: true, withTool: true });
    const { input, participants } = groupTurn(['a', 'b', 'c']);
    const events: Array<{ type: string; id?: string; output?: string }> = [];
    await turnContext.runWithChatParticipants(participants as never, async () => {
      for await (const event of orchestrator.chatStream(input)) events.push(event as never);
    });
    const results = events.filter((e) => e.type === 'tool_result');
    assert.equal(results.length, 1, 'one result per call');
    assert.match(results[0]!.output ?? '', /w42-signed/);
    // Live: the result comes before the answer's text, not held to the end.
    const resultAt = events.indexOf(results[0] as never);
    const firstText = events.findIndex((e) => e.type === 'text_delta');
    assert.ok(resultAt < firstText, 'the output streams as the tool finishes');
  });

  it('a streamed answer everyone may know is not retracted', async () => {
    const wide = unionLabels([{ kind: 'context', key: 'telegram:dm-ab', readers: readersOf(['a', 'b', 'c']) }]);
    const { orchestrator } = build(wide, { streamChunks: true });
    const { input, participants } = groupTurn(['a', 'b', 'c']);
    const types: string[] = [];
    await turnContext.runWithChatParticipants(participants as never, async () => {
      for await (const event of orchestrator.chatStream(input)) types.push(event.type);
    });
    assert.ok(types.includes('text_delta'));
    assert.equal(types.includes('text_retract'), false);
  });

  it('a withheld answer goes out without anything derived from it', async () => {
    const narrow = unionLabels([{ kind: 'context', key: 'telegram:dm-ab', readers: readersOf(['a', 'b']) }]);
    const { orchestrator } = build(narrow);
    const discretion = createDiscretionTurnState({
      contextKey: 'telegram:group-1',
      resolveReaders: async () => readersOf(['a', 'b', 'c']),
      initial: narrow,
    });
    const full = {
      answer: SECRET,
      toolCalls: 2,
      iterations: 3,
      turnId: 'turn-new',
      attachments: [{ kind: 'diagram' }],
      fileAttachments: [{ name: 'export.xlsx' }],
      followUpOptions: [{ label: SECRET }],
      pendingUserChoice: { question: SECRET },
      surface: { kind: 'canvas' },
      recalled: { plans: [] },
      contributions: [{ id: 'c1', text: SECRET }],
    };
    const guarded = (await turnContext.run({ turnId: 'turn-new', turnDate: '2026-11-20', discretion }, () =>
      (orchestrator as unknown as { guardAnswerEgress(r: unknown, l: string): Promise<Record<string, unknown>> })
        .guardAnswerEgress(full, 'de'),
    )) as Record<string, unknown>;
    assert.equal(JSON.stringify(guarded).includes('Paula'), false);
    assert.deepEqual(Object.keys(guarded).sort(), ['answer', 'iterations', 'toolCalls', 'turnId']);
  });

  it('a web-chat turn (no origin) keeps its owner as its one reader', async () => {
    const { orchestrator, persisted } = build(unionLabels([]));
    await orchestrator.chat({ userMessage: 'Notiz für mich', sessionScope: 'web-a', userId: 'a' } as ChatTurnInput);
    const kept = persisted.get('turn-new');
    const owner = kept?.labels.find((l) => l.kind === 'context');
    assert.deepEqual(owner, { kind: 'context', key: 'owner:a', readers: readersOf(['a']) });
  });
});

/**
 * The shield masks classified fields for the model whoever is present (the
 * REAL privacy-guard service, built orchestrator). Field rights per member
 * (bypass, restore, render, classification egress) are covered in
 * `fieldRights.test.ts`.
 */
describe('mask at entry with the privacy shield (criterion 18)', () => {
  const RECORD = JSON.stringify([{ name: 'Jana Beispiel', email: RAW_EMAIL, salary_band: 'E13' }]);
  const ANY_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

  /** A model that reads the record, then "paraphrases" whatever e-mail it was given. */
  function paraphrasingModel(requests: string[]): LlmProvider {
    let calls = 0;
    const complete = async (req: LlmRequest): Promise<LlmResponse> => {
      const messages = JSON.stringify((req as { messages?: unknown }).messages);
      requests.push(JSON.stringify(req));
      calls += 1;
      if (calls === 1) return toolCalls(['query_hr_people', { query: 'Jana' }]);
      const seen = messages.includes(RAW_EMAIL) ? RAW_EMAIL : ANY_EMAIL.exec(messages)?.[0];
      return text(`Umschrieben: die Adresse lautet ${seen ?? 'unbekannt'}, vor dem @ steht ${(seen ?? '').split('@')[0]}`);
    };
    return {
      id: 'anthropic',
      capabilities: { tools: true, vision: true, streaming: true, promptCaching: true, forcedToolChoice: true, parallelToolCalls: true },
      complete,
      stream: () => {
        throw new Error('not streamed');
      },
      classifyError: () => ({ retryable: false, kind: 'other' as const }),
    } as unknown as LlmProvider;
  }

  it('criterion 18: in a group the model never receives the classified field, and its paraphrase carries nothing of it', async () => {
    const requests: string[] = [];
    const orchestrator = new DistOrchestrator({
      provider: paraphrasingModel(requests),
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 3,
      domainTools: [
        {
          name: 'query_hr_people',
          domain: 'hr',
          agentId: '@omadia/odoo-hr',
          spec: { name: 'query_hr_people', description: 'HR people', input_schema: { type: 'object', properties: {}, required: [] } },
          handle: async () => RECORD,
        },
      ],
      nativeToolRegistry: new DistNativeToolRegistry(),
      agentId: 'mira',
      knowledgeGraph,
      privacyGuard: () => countingService().service,
    } as never);
    const { input, participants } = groupTurn(['a', 'b', 'c']);
    const result = await distTurnContext.runWithChatParticipants(participants as never, () =>
      orchestrator.chat({ ...input, userMessage: 'Umschreib bitte die E-Mail-Adresse von Jana.' }),
    );
    assert.ok(requests.length >= 2, 'the model read the record and answered');
    assert.ok(
      requests.every((r) => !r.includes(RAW_EMAIL) && !r.includes('jana.beispiel')),
      'the model never received the field',
    );
    assert.equal(result.text.includes(RAW_EMAIL), false, 'nothing of it reaches the group');
    assert.equal(result.text.includes('jana.beispiel'), false);
  });
});
