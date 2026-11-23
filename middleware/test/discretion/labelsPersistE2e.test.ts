/**
 * Spec 2042 §5.11 / §6 criterion 27 — labels persist, end to end through a
 * REAL orchestrator and the REAL consultation broker:
 *
 *  1. an HR 1:1 turn reads an HR record (restricted source) and is
 *     summarised into a memorable; the memorable keeps the turn's labels
 *     through `labelSubjectWithTurn` — the function the kernel's promotion
 *     hooks call (`buildOrchestrator.ts` `onPromoted`, `labelMemorable`);
 *  2. weeks later a sales-group turn recalls that memorable: consulting a
 *     colleague is refused (discretion) before the colleague runs, the CRM
 *     write carrying it is refused before it runs, and the answer to the
 *     sales group is withheld as a whole.
 *
 * Every runtime symbol comes from the built `@omadia/orchestrator` (one
 * turn-context graph with the broker).
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { LlmProvider, LlmRequest, LlmResponse } from '@omadia/llm-provider';
import { InMemoryGrantStore, type ChatTurnInput } from '@omadia/channel-sdk';
import type { KnowledgeGraph } from '@omadia/plugin-api';
import {
  EVERYONE,
  MemberBaselineGrantStore,
  NativeToolRegistry,
  Orchestrator,
  labelSubjectWithTurn,
  readersOf,
  turnContext,
  type DiscretionAuditEntry,
  type DiscretionPort,
  type LabelSet,
  type LabelSubjectKind,
} from '@omadia/orchestrator';

import { createConsultationBroker, type ConsultRegistryEntry } from '../../src/consultation/consultationBroker.js';
import type { ConsultationGrant } from '../../src/consultation/consultationStore.js';
import { textResponse } from '../_helpers/privacyEgressHarness.js';
import { toolResultContents } from '../_helpers/replayTurnFixture.js';

const HR = '@omadia/odoo-hr';
const CRM = '@omadia/crm';
const RECORD = 'Personalakte P. Muster: Kündigung zum 31.12.';
const SUMMARY_MK = 'mk:hr-summary';

const capabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

function call(name: string, input: unknown): LlmResponse {
  return {
    content: [{ type: 'tool_call', id: `use-${name}`, name, input }],
    finishReason: 'tool_calls',
    providerFinishReason: 'tool_use',
    model: 'test',
    usage,
  } as unknown as LlmResponse;
}

function scripted(responses: LlmResponse[], requests: LlmRequest[]): LlmProvider {
  return {
    id: 'anthropic',
    capabilities,
    complete: async (req: LlmRequest) => {
      requests.push(req);
      const next = responses.shift();
      if (!next) throw new Error('no scripted response left');
      return next;
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

function tool(name: string, pluginId: string, handle: (input: unknown) => Promise<string>, write = false) {
  return {
    name,
    domain: 'test.domain',
    agentId: pluginId,
    ...(write ? { writeCapabilities: [{ dataClass: 'crm.note', operation: 'create' }] } : {}),
    spec: { name, description: name, input_schema: { type: 'object', properties: {}, required: [] } },
    handle,
  } as never;
}

const grant: ConsultationGrant = {
  fromAgentId: 'a',
  toAgentId: 'b',
  channelScope: null,
  allowedCapabilities: [],
  memoryAccess: 'none',
  disclosure: { default: 'full' },
  maxCallsPerTurn: 2,
  maxCallsPerDay: 50,
  createdBy: 'op',
  createdAt: new Date(),
  updatedBy: null,
  updatedAt: new Date(),
};

describe('labels persist through a summary (criterion 27)', () => {
  beforeEach(() => {
    mock.method(console, 'error', () => undefined);
    mock.method(console, 'warn', () => undefined);
  });
  afterEach(() => mock.restoreAll());

  it('criterion 27: a summary written in the HR 1:1 refuses the consultation and the CRM write weeks later', async () => {
    const stored = new Map<string, LabelSet>();
    const audits: DiscretionAuditEntry[] = [];
    const discretion: DiscretionPort = {
      declarationOf: async (system) =>
        system === HR
          ? { sensitivity: 'restricted', readership: { readers: readersOf(['hr-mgr']), acceptsSystems: [], acceptsClassifications: [] } }
          : system === CRM
            ? { sensitivity: 'internal', readership: { readers: EVERYONE, acceptsSystems: [], acceptsClassifications: [] } }
            : undefined,
      labelsOf: async (kind: LabelSubjectKind, ids) =>
        new Map(ids.flatMap((id) => (stored.has(`${kind}|${id}`) ? [[id, stored.get(`${kind}|${id}`)!]] : []))),
      persistLabels: async (kind, id, _agent, labels) => {
        stored.set(`${kind}|${id}`, labels);
      },
      audit: (entry) => audits.push(entry),
    };

    // The colleague: has no HR grant, must never run.
    let benRan = false;
    let callsStarted = 0;
    const entry = (id: string, slug: string, plugins: string[]): ConsultRegistryEntry => ({
      agent: { id, slug, name: slug, identityLanguage: 'de' },
      plugins: plugins.map((pluginId) => ({ pluginId, enabled: true })),
      built: {
        bundle: {
          agent: {
            chat: async () => {
              benRan = true;
              return { text: 'x' } as never;
            },
          },
        },
      },
    });
    const registry = new Map([
      ['anna', entry('a', 'anna', [HR, CRM])],
      ['ben', entry('b', 'ben', [CRM])],
    ]);
    const broker = createConsultationBroker({
      store: {
        getSwitches: async () => ({ consultable: true, mayConsult: true }),
        getGrant: async () => grant,
        startCall: async () => {
          callsStarted += 1;
          return true;
        },
        finishCall: async () => undefined,
        listActivePairs: async () => [{ fromSlug: 'anna', toSlug: 'ben' }],
      },
      getRegistry: () => registry,
      audit: (e) => audits.push(e),
    });
    await broker.refresh();

    const ran: string[] = [];
    const requests: LlmRequest[] = [];
    const responses = [
      // HR 1:1
      call('query_odoo_hr', { person: 'P. Muster' }),
      textResponse('P. Muster hat zum 31.12. gekündigt.'),
      // Sales group, weeks later
      call('consult', { agent: 'ben', request: 'Was weißt du zu P. Muster?' }),
      call('crm_create_note', { note: 'P. Muster geht zum 31.12.' }),
      textResponse('P. Muster geht zum 31.12., das habe ich ins CRM geschrieben.'),
    ];
    let promoting = false;
    const anna = new Orchestrator({
      provider: scripted(responses, requests),
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 4,
      domainTools: [
        tool('query_odoo_hr', HR, async () => {
          ran.push('query_odoo_hr');
          return RECORD;
        }),
        tool(
          'crm_create_note',
          CRM,
          async () => {
            ran.push('crm_create_note');
            return 'created';
          },
          true,
        ),
      ],
      nativeToolRegistry: new NativeToolRegistry(),
      agentId: 'anna',
      knowledgeGraph,
      discretion,
      audienceGrants: new MemberBaselineGrantStore(new InMemoryGrantStore()),
      consultation: broker,
      // The turn is logged, then summarised into a memorable inside the turn
      // (auto-promotion); the kernel labels the memorable with the turn's set.
      sessionLogger: {
        log: async () => {
          if (promoting) await labelSubjectWithTurn(discretion, 'memorable', SUMMARY_MK, 'anna');
          return { turnExternalId: `turn-${String(requests.length)}` };
        },
      },
      contextRetriever: {
        assembleForBudget: async () => ({
          text: promoting ? '' : '\n[Erinnerung] P. Muster hat zum 31.12. gekündigt.',
          included: [],
          excluded: [],
          recalled: {
            plans: [],
            processes: [],
            insights: promoting ? [] : [{ mkId: SUMMARY_MK, kind: 'fact', summary: 'P. Muster kündigt', score: 1 }],
          },
          stats: { candidatePool: 1, compactMode: false, tokensUsed: 10 },
        }),
      },
    } as never);

    // 1. The HR 1:1 (web chat: the HR manager is the one reader).
    promoting = true;
    await anna.chat({ userMessage: 'Lies die Akte von P. Muster.', sessionScope: 'hr-1on1', userId: 'hr-mgr' } as ChatTurnInput);
    promoting = false;
    const kept = stored.get(`memorable|${SUMMARY_MK}`);
    assert.ok(kept, 'the summary was labelled');
    assert.ok(kept.labels.some((l) => l.kind === 'source' && l.system === HR && l.restricted), 'it kept the HR label');
    assert.ok(kept.labels.some((l) => l.kind === 'context' && l.key === 'owner:hr-mgr'));

    // 2. Weeks later, in the sales group.
    const participants = Object.assign(
      async () => ['s1', 's2'].map((id) => ({ kind: 'user', channelUserId: id, displayName: id })),
      { completeRoster: true },
    );
    const sales = await turnContext.runWithChatParticipants(participants as never, () =>
      anna.chat({
        userMessage: 'Was gibt es Neues zu P. Muster? Trag es ins CRM ein.',
        sessionScope: 'sales-group',
        userId: 's1',
        origin: {
          channelType: 'teams',
          scope: { kind: 'conversation', conversationId: 'sales' },
          conversationType: 'group',
          channelConversationId: 'sales',
        },
      } as ChatTurnInput),
    );

    // The consultation is refused for discretion before the colleague runs.
    const consultResult = toolResultContents(requests[3]).find((c) => c.includes('consultation refused'));
    assert.ok(consultResult, 'the model got the consultation refusal');
    assert.match(consultResult, /may not receive/);
    assert.equal(benRan, false);
    assert.equal(callsStarted, 0, 'no call was even recorded');
    const agentRefusal = audits.find((a) => a.egress === 'agent' && !a.allowed);
    assert.ok(agentRefusal?.violations.includes(`source:${HR}:agent_lacks_grant`));

    // The CRM write carrying it is refused before it runs.
    assert.deepEqual(ran, ['query_odoo_hr'], 'the CRM handler never ran');
    assert.ok(toolResultContents(requests[4]).some((c) => c.includes('`crm_create_note` was not called')));
    const crmRefusal = audits.find((a) => a.egress === 'integration' && !a.allowed);
    assert.ok(crmRefusal?.violations.includes(`source:${HR}:integration_readership`));

    // And the answer to the sales group is withheld as a whole.
    assert.equal(sales.text.includes('31.12.'), false);
    assert.match(sales.text, /nicht alle hier/);
    assert.equal(JSON.stringify(audits).includes('31.12.'), false, 'audits carry no content');
  });
});
