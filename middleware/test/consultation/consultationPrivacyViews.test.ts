/**
 * Spec 2042 §5.4 step 3 / §6 criterion 3 — the two views of a consultation
 * with the privacy shield active, end to end: a REAL consulting orchestrator
 * (A) and a REAL consulted orchestrator (B), each with the REAL privacy-guard
 * service, joined by the REAL consultation broker.
 *
 *  - the user view (`contributions[]`) carries the value restored for the user;
 *  - A's model (including the consult tool result) and B's model only ever
 *    see the masked form.
 *
 * Sub-claim (c) — a member without the right to a field sees it redacted:
 * in a group where one member's `privacy:field:personal` is denied, B's
 * contribution keeps the masked value for the whole room.
 *
 * Spec §5.4 step 4 — A's model gets the contribution header (id, colleague)
 * outside the privacy digest, so it can refer to `c1`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LlmProvider, LlmRequest, LlmResponse } from '@omadia/llm-provider';
import { InMemoryGrantStore, makePrincipal, type Principal } from '@omadia/channel-sdk';
import type { KnowledgeGraph } from '@omadia/plugin-api';
import { InMemoryKnowledgeGraph } from '@omadia/knowledge-graph-inmemory';
import { MemberBaselineGrantStore, NativeToolRegistry, Orchestrator, fieldCapability, turnContext } from '@omadia/orchestrator';

import { createConsultationBroker, type ConsultRegistryEntry } from '../../src/consultation/consultationBroker.js';
import type { ConsultationGrant } from '../../src/consultation/consultationStore.js';
import { RAW_EMAIL, countingService, echoingProvider, textResponse } from '../_helpers/privacyEgressHarness.js';
import { toolResultContents } from '../_helpers/replayTurnFixture.js';

/** A `user:` principal; `makePrincipal` only refuses an empty id. */
function user(id: string): Principal {
  const principal = makePrincipal('user', id);
  if (!principal) throw new Error(`no principal for ${id}`);
  return principal;
}

const ANY_EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

const capabilities = {
  tools: true,
  vision: true,
  streaming: true,
  promptCaching: true,
  forcedToolChoice: true,
  parallelToolCalls: true,
} as const;

/** A's model: consults Ben about the first e-mail it sees, then refers to `c1`. */
function consultingProvider(requests: string[]): LlmProvider {
  let calls = 0;
  const complete = async (req: LlmRequest): Promise<LlmResponse> => {
    const serialized = JSON.stringify(req);
    requests.push(serialized);
    calls += 1;
    if (calls === 1) {
      const email = ANY_EMAIL.exec(JSON.stringify((req as { messages?: unknown }).messages))?.[0] ?? 'niemand';
      return {
        content: [{ type: 'tool_call', id: 'use-consult-1', name: 'consult', input: { agent: 'ben', request: `Was weißt du über ${email}?` } }],
        finishReason: 'tool_calls',
        providerFinishReason: 'tool_use',
        model: 'test',
        usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      } as unknown as LlmResponse;
    }
    return textResponse('Ben hat dazu etwas beigetragen (c1).');
  };
  return {
    id: 'anthropic',
    capabilities,
    complete,
    stream: () => {
      throw new Error('not streamed');
    },
    classifyError: () => ({ retryable: false, kind: 'other' as const }),
  } as unknown as LlmProvider;
}

function grant(): ConsultationGrant {
  return {
    fromAgentId: 'a',
    toAgentId: 'b',
    channelScope: null,
    allowedCapabilities: [],
    memoryAccess: 'none',
    disclosure: {},
    maxCallsPerTurn: 2,
    maxCallsPerDay: 50,
    createdBy: 'op',
    createdAt: new Date(),
    updatedBy: null,
    updatedAt: new Date(),
  };
}

/** Canonical id = channel id: enough identity for the roster. */
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

/** The member baseline, with the personal-field right denied to `denied`. */
function grants(denied?: string): MemberBaselineGrantStore {
  const inner = new InMemoryGrantStore();
  if (denied) inner.denyToPrincipal(user(denied), fieldCapability('personal'));
  return new MemberBaselineGrantStore(inner);
}

/** Anna consults Ben; both run with the real shield. `denied` loses the field right. */
async function consultation(opts: { readonly denied?: string; readonly group?: boolean } = {}) {
  const bRequests: string[] = [];
  const ben = new Orchestrator({
    provider: echoingProvider(bRequests, (email) => `Ich kenne ${email} aus dem Vertrieb`),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 3,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    agentId: 'ben',
    privacyGuard: () => countingService().service,
    knowledgeGraph,
    audienceGrants: grants(opts.denied),
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
      getGrant: async () => grant(),
      startCall: async () => true,
      finishCall: async () => undefined,
      listActivePairs: async () => [{ fromSlug: 'anna', toSlug: 'ben' }],
    },
    getRegistry: () => registry,
  });
  await broker.refresh();
  const aRequests: string[] = [];
  const anna = new Orchestrator({
    provider: consultingProvider(aRequests),
    model: 'test',
    maxTokens: 1024,
    maxToolIterations: 3,
    domainTools: [],
    nativeToolRegistry: new NativeToolRegistry(),
    agentId: 'anna',
    knowledgeGraph: opts.group ? knowledgeGraph : new InMemoryKnowledgeGraph(),
    audienceGrants: grants(opts.denied),
    consultation: broker,
    privacyGuard: () => countingService().service,
  } as never);
  return { anna, aRequests, bRequests };
}

const GROUP_ORIGIN = {
  channelType: 'telegram',
  scope: { kind: 'conversation', conversationId: 'group-1' },
  conversationType: 'group',
  channelConversationId: 'group-1',
};
const groupParticipants = Object.assign(
  async () => ['u-anna', 'u-ben', 'u-carl'].map((id) => ({ kind: 'user', channelUserId: id, displayName: id })),
  { completeRoster: true },
);

describe('consultation views with the privacy shield active (criterion 3)', () => {
  it('criterion 3: the user view carries the restored value, A\'s model view stays masked', async () => {
    const { anna, aRequests, bRequests } = await consultation();
    const result = await anna.runTurn({
      userMessage: `Was wissen wir über ${RAW_EMAIL} heute`,
      sessionScope: 's-anna',
      userId: 'u-anna',
    });
    // (a) The user view: B's contribution carries the value restored for the user.
    assert.equal(result.contributions?.length, 1);
    const [contribution] = result.contributions ?? [];
    assert.equal(contribution?.status, 'delivered');
    assert.equal(contribution?.speaker.slug, 'ben');
    assert.ok(contribution?.text.includes(RAW_EMAIL), 'the user sees the real value');
    // (b) The model views: neither A's model (its consult result included)
    // nor B's model ever received the real value.
    assert.equal(aRequests.length, 2);
    assert.ok(aRequests.every((r) => !r.includes(RAW_EMAIL)), "A's model view stays masked");
    assert.ok(bRequests.length > 0 && bRequests.every((r) => !r.includes(RAW_EMAIL)), "B's model view stays masked");
    const consultResult = toolResultContents(JSON.parse(aRequests[1] ?? '{}') as LlmRequest);
    assert.equal(consultResult.length, 1, 'the consult result reached A as a tool result');
    assert.ok(!consultResult[0]!.includes(RAW_EMAIL));
    assert.ok(!result.answer.includes(RAW_EMAIL), "A's own text carries nothing restored from B");
    // Spec §5.4 step 4 — the header stays readable outside the digest, so A
    // can refer to the contribution by its id.
    assert.ok(consultResult[0]!.startsWith('[contribution c1 from Ben'), 'A sees the contribution id');
  });

  it('criterion 3c: a member without the field right sees it redacted in the contribution', async () => {
    const run = async (denied?: string) => {
      const { anna, aRequests, bRequests } = await consultation({ denied, group: true });
      const result = await turnContext.runWithChatParticipants(groupParticipants as never, () =>
        anna.runTurn({
          userMessage: `Was wissen wir über ${RAW_EMAIL} heute`,
          sessionScope: 's-anna-group',
          userId: 'u-anna',
          origin: GROUP_ORIGIN,
        } as never),
      );
      return { result, aRequests, bRequests };
    };
    const redacted = await run('u-carl');
    const [contribution] = redacted.result.contributions ?? [];
    assert.equal(contribution?.status, 'delivered');
    assert.equal(contribution?.text.includes(RAW_EMAIL), false, 'the room sees the field redacted');
    assert.ok(redacted.aRequests.every((r) => !r.includes(RAW_EMAIL)), "A's model view stays masked");
    assert.ok(redacted.bRequests.every((r) => !r.includes(RAW_EMAIL)), "B's model view stays masked");
    // Control: the same room where everyone may know it gets the restored value.
    const restored = await run(undefined);
    assert.ok(restored.result.contributions?.[0]?.text.includes(RAW_EMAIL), 'restored when everyone may know it');
  });
});
