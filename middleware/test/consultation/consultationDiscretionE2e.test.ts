/**
 * Spec 2042 §5.4 / §5.11 — discretion across agents, end to end: a REAL
 * consulting orchestrator (A, in a sales group) and a REAL consulted
 * orchestrator (B, `members` context memory, `discreet` memory access), joined
 * by the REAL consultation broker.
 *
 *  - criterion 16: B recalls a memory entry it learned in an HR group (P is
 *    leaving; labelled with the HR context). Consulted from the sales chat,
 *    B's contribution says nothing about it; at disclosure level `existence`
 *    it says only that B can help;
 *  - criterion 38: what the user sees from A when the information exists but
 *    is withheld at `none` is the same as when it does not exist (answer,
 *    contribution, trace) — and A's model cannot tell either.
 *
 * B's model is a stand-in for a real one: it answers from whatever its prompt
 * holds, so the only difference between the scenarios is B's memory.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { LlmProvider, LlmRequest, LlmResponse } from '@omadia/llm-provider';
import { InMemoryGrantStore, type ChatTurnInput } from '@omadia/channel-sdk';
import { InMemoryMemoryStore } from '@omadia/memory';
import type { KnowledgeGraph } from '@omadia/plugin-api';
import {
  MemberBaselineGrantStore,
  MemoryBinder,
  NativeToolRegistry,
  Orchestrator,
  readersOf,
  turnContext,
  unionLabels,
  type DiscretionAuditEntry,
  type DiscretionPort,
  type DisclosurePolicy,
} from '@omadia/orchestrator';

import { createConsultationBroker, type ConsultRegistryEntry } from '../../src/consultation/consultationBroker.js';
import type { ConsultationGrant } from '../../src/consultation/consultationStore.js';
import { textResponse } from '../_helpers/privacyEgressHarness.js';
import { toolResultContents } from '../_helpers/replayTurnFixture.js';

const SECRET = 'P verlässt das Unternehmen zum Monatsende';
const NOTHING = 'Dazu liegt mir nichts vor.';
const HR_CONTEXT = 'teams:hr-group';
const SALES = ['s1', 's2'];

const capabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

function provider(answer: (req: LlmRequest, call: number) => LlmResponse, requests: LlmRequest[]): LlmProvider {
  return {
    id: 'anthropic',
    capabilities,
    complete: async (req: LlmRequest) => {
      requests.push(req);
      return answer(req, requests.length);
    },
    stream: () => {
      throw new Error('not streamed');
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
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

function grant(disclosure: DisclosurePolicy): ConsultationGrant {
  return {
    fromAgentId: 'a',
    toAgentId: 'b',
    channelScope: null,
    allowedCapabilities: [],
    memoryAccess: 'discreet',
    disclosure,
    maxCallsPerTurn: 2,
    maxCallsPerDay: 50,
    createdBy: 'op',
    createdAt: new Date(),
    updatedBy: null,
    updatedAt: new Date(),
  };
}

interface Scenario {
  /** B holds the HR memory entry (else: nothing about P exists). */
  readonly hrMemory: boolean;
  readonly disclosure: DisclosurePolicy;
}

async function consultFromSales(scenario: Scenario) {
  const audits: DiscretionAuditEntry[] = [];
  const hrLabels = unionLabels([{ kind: 'context', key: HR_CONTEXT, readers: readersOf(['hr-mgr', 'b-owner']) }]);
  const discretion: DiscretionPort = {
    declarationOf: async () => undefined,
    labelsOf: async (kind, ids) =>
      new Map(kind === 'memorable' && scenario.hrMemory ? ids.filter((id) => id === 'mk:p').map((id) => [id, hrLabels]) : []),
    persistLabels: async () => undefined,
    audit: (entry) => audits.push(entry),
  };
  const bRequests: LlmRequest[] = [];
  let recalls = 0;
  const ben = new Orchestrator({
    // Answers from its prompt: knows about P only when the memory is in it.
    provider: provider((req) => textResponse(JSON.stringify(req).includes('verlässt') ? `${SECRET}.` : NOTHING), bRequests),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 3,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    agentId: 'ben',
    knowledgeGraph,
    discretion,
    memoryBinder: new MemoryBinder({ agentSlug: 'ben', root: new InMemoryMemoryStore(), mode: 'members' }),
    contextRetriever: {
      assembleForBudget: async () => {
        recalls += 1;
        return scenario.hrMemory
          ? {
              text: `\n[Erinnerung] ${SECRET}`,
              included: [],
              excluded: [],
              recalled: { plans: [], processes: [], insights: [{ mkId: 'mk:p', kind: 'fact', summary: SECRET, score: 1 }] },
              stats: { candidatePool: 1, compactMode: false, tokensUsed: 10 },
            }
          : {
              text: '',
              included: [],
              excluded: [],
              recalled: { plans: [], processes: [], insights: [] },
              stats: { candidatePool: 0, compactMode: false, tokensUsed: 0 },
            };
      },
    },
  } as never);
  const entry = (id: string, slug: string, name: string, orch?: Orchestrator): ConsultRegistryEntry => ({
    agent: { id, slug, name, identityLanguage: 'de' },
    plugins: [],
    built: { bundle: { agent: { chat: (input) => (orch ? orch.chat(input) : Promise.reject(new Error('n/a'))) } } },
  });
  const registry = new Map([
    ['anna', entry('a', 'anna', 'Anna')],
    ['ben', entry('b', 'ben', 'Ben', ben)],
  ]);
  const broker = createConsultationBroker({
    store: {
      getSwitches: async () => ({ consultable: true, mayConsult: true }),
      getGrant: async () => grant(scenario.disclosure),
      startCall: async () => true,
      finishCall: async () => undefined,
      listActivePairs: async () => [{ fromSlug: 'anna', toSlug: 'ben' }],
    },
    getRegistry: () => registry,
    audit: (entry) => audits.push(entry),
  });
  await broker.refresh();
  const aRequests: LlmRequest[] = [];
  const anna = new Orchestrator({
    provider: provider(
      (_req, call) =>
        call === 1
          ? ({
              content: [{ type: 'tool_call', id: 'use-c', name: 'consult', input: { agent: 'ben', request: 'Gibt es Neuigkeiten zu P?' } }],
              finishReason: 'tool_calls',
              providerFinishReason: 'tool_use',
              model: 'test',
              usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
            } as unknown as LlmResponse)
          : textResponse('Ich habe Ben gefragt, seine Antwort steht oben.'),
      aRequests,
    ),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 3,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    agentId: 'anna',
    knowledgeGraph,
    discretion,
    audienceGrants: new MemberBaselineGrantStore(new InMemoryGrantStore()),
    consultation: broker,
  } as never);
  const participants = Object.assign(
    async () => SALES.map((id) => ({ kind: 'user', channelUserId: id, displayName: id })),
    { completeRoster: true },
  );
  const input = {
    userMessage: 'Wie steht es um P im Vertrieb?',
    sessionScope: 'sales-group',
    userId: 's1',
    origin: {
      channelType: 'teams',
      scope: { kind: 'conversation', conversationId: 'sales' },
      conversationType: 'group',
      channelConversationId: 'sales',
    },
  } as ChatTurnInput;
  const answer = await turnContext.runWithChatParticipants(participants as never, () => anna.chat(input));
  return { answer, aRequests, bRequests, audits, recalls: () => recalls };
}

/** Fields that differ between any two runs (timings, generated ids). */
const VOLATILE = new Set(['durationMs', 'startedAt', 'finishedAt', 'turnId', 'runId']);

/** What the user can see of A's answer, without timings and generated ids. */
function visible(answer: Awaited<ReturnType<typeof consultFromSales>>['answer']): unknown {
  return JSON.parse(JSON.stringify(answer, (key, value: unknown) => (VOLATILE.has(key) ? undefined : value))) as unknown;
}

describe('discretion across agents through real orchestrators', () => {
  beforeEach(() => {
    mock.method(console, 'error', () => undefined);
    mock.method(console, 'warn', () => undefined);
    mock.method(console, 'log', () => undefined);
  });
  afterEach(() => mock.restoreAll());

  it('criterion 16: B recalled the HR entry, yet its contribution to the sales chat says nothing of it', async () => {
    const run = await consultFromSales({ hrMemory: true, disclosure: {} });
    assert.ok(run.recalls() >= 1, 'B did recall its memory in the first attempt');
    assert.ok(
      run.bRequests.some((r) => JSON.stringify(r).includes('verlässt')),
      'B\'s model saw the HR entry in its first attempt',
    );
    const [contribution] = run.answer.contributions ?? [];
    assert.equal(contribution?.speaker.slug, 'ben');
    assert.equal(contribution?.status, 'delivered');
    assert.equal(contribution?.text, NOTHING, 'regenerated from permitted context only');
    assert.equal(JSON.stringify(run.answer).includes('verlässt'), false, 'nothing of it reaches the sales chat');
    assert.equal(JSON.stringify(run.aRequests).includes('verlässt'), false, 'nor A\'s model');
    const refused = run.audits.find((a) => a.egress === 'agent' && !a.allowed);
    assert.ok(refused?.violations.includes(`context:${HR_CONTEXT}:readers_not_covered`));
    assert.equal(JSON.stringify(run.audits).includes('verlässt'), false, 'the audit carries no content');
  });

  it('criterion 16: at disclosure level `existence` the contribution says only that Ben can help', async () => {
    const run = await consultFromSales({ hrMemory: true, disclosure: { context: 'existence' } });
    const [contribution] = run.answer.contributions ?? [];
    assert.equal(contribution?.status, 'delivered');
    assert.equal(contribution?.text, 'Ben kann dazu etwas beitragen, aber nicht hier. Frag Ben am besten direkt.');
    assert.equal(JSON.stringify(run.answer).includes('verlässt'), false);
    assert.equal(JSON.stringify(run.aRequests).includes('verlässt'), false);
  });

  it('criterion 38: withheld at `none` and non-existent look the same to the user and to A\'s model', async () => {
    const withheld = await consultFromSales({ hrMemory: true, disclosure: { context: 'none' } });
    const absent = await consultFromSales({ hrMemory: false, disclosure: { context: 'none' } });
    assert.ok(
      withheld.bRequests.some((r) => JSON.stringify(r).includes('verlässt')),
      'the information exists and B read it',
    );
    // Final answer, contributions, labels and every other field the user gets.
    assert.equal(withheld.bRequests.length, 2, 'withheld: B ran again without memory');
    assert.equal(absent.bRequests.length, 1);
    assert.deepEqual(visible(withheld.answer), visible(absent.answer));
    assert.equal(withheld.answer.text, absent.answer.text);
    assert.deepEqual(withheld.answer.contributions, absent.answer.contributions);
    // A's model view of the consultation is identical as well.
    assert.deepEqual(toolResultContents(withheld.aRequests[1]), toolResultContents(absent.aRequests[1]));
  });
});
