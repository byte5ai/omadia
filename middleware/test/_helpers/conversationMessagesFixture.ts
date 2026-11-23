// Shared fixture for the 'conversationMessages@2' suites (#2043, #2089): a
// hub over any store, with facilitators `mara`, `nora`, `ida` and a standard
// agent `hr`, a builder for the events a channel adapter would emit, and the
// process a test reads through.

import type { ConversationMessageEvent } from '@omadia/channel-sdk';
import type { ChannelReadinessReport, ProcessMessageScope } from '@omadia/plugin-api';

import { ConversationMessageHub, type ProcessAccess } from '../../src/channels/conversationMessages/hub.js';
import type { ConversationMessageStore } from '../../src/channels/conversationMessages/store.js';

export const ENGINE = '@omadia/agent-facilitator';
export const CONVERSATION = '19:offsite@thread.v2';
export const MARA_KEY = '28:AAAA-MARA';
export const NORA_KEY = '28:bbbb-nora';

/** What a process may read when it holds the conversation and has an open scope. */
export const FULL_ACCESS: ProcessAccess = { reserved: true, everReserved: true, openScope: true };
/** A process the kernel knows nothing of: no scope, never held a conversation. */
export const NO_ACCESS: ProcessAccess = { reserved: false, everReserved: false, openScope: false };

export interface HubFixture {
  readonly hub: ConversationMessageHub;
  readonly logs: string[];
  present: Set<string>;
  /** What the channel's readiness provider reports; `undefined` = ready. */
  readiness: ChannelReadinessReport | undefined;
  /** `false` = the channel type registered no readiness provider. */
  hasReadinessProvider: boolean;
  /** Agent slug → why its subscriptions lost their ground (for `reconcile`). */
  lostGround: Map<string, string>;
  /**
   * What the execution scopes and reservations say about a process, by
   * `<plugin id>|<process id>`. A process that is not listed: every process
   * of the engine plugin has full access, a process of any other plugin has
   * none (it could not have opened a scope).
   */
  access: Map<string, ProcessAccess>;
}

const READY: ChannelReadinessReport = {
  ready: true,
  installed: true,
  canReadAllMessages: true,
  canPost: true,
  missing: [],
};

export interface FixtureAgent {
  readonly id: string;
  readonly slug: string;
  readonly archetype: 'standard' | 'facilitator';
  readonly channelKey?: string;
}

export const DEFAULT_AGENTS: readonly FixtureAgent[] = [
  { id: '00000000-0000-0000-0000-0000000000f1', slug: 'mara', archetype: 'facilitator', channelKey: MARA_KEY },
  { id: '00000000-0000-0000-0000-0000000000f2', slug: 'nora', archetype: 'facilitator', channelKey: NORA_KEY },
  { id: '00000000-0000-0000-0000-0000000000f3', slug: 'ida', archetype: 'facilitator' },
  { id: '00000000-0000-0000-0000-0000000000a1', slug: 'hr', archetype: 'standard', channelKey: '28:cccc-hr' },
];

export function hubFixture(
  store: ConversationMessageStore,
  agents: readonly FixtureAgent[] = DEFAULT_AGENTS,
): HubFixture {
  const logs: string[] = [];
  const fixture: HubFixture = {
    logs,
    present: new Set([MARA_KEY.toLowerCase(), NORA_KEY.toLowerCase()]),
    readiness: undefined,
    hasReadinessProvider: true,
    lostGround: new Map(),
    access: new Map(),
    hub: new ConversationMessageHub({
      store,
      resolveAgent: (slug) => agents.find((a) => a.slug === slug),
      identityFor: (slug) => {
        const key = agents.find((a) => a.slug === slug)?.channelKey;
        return key ? { channelKey: key } : undefined;
      },
      isBotPresent: (_type, _conversation, channelKey) => Promise.resolve(fixture.present.has(channelKey)),
      // `undefined` = the channel registered no readiness provider.
      checkReadiness: () => Promise.resolve(fixture.hasReadinessProvider ? (fixture.readiness ?? READY) : undefined),
      groundFor: (subscription) => Promise.resolve(fixture.lostGround.get(subscription.agentSlug)),
      processAccess: ({ pluginId, processId }) =>
        Promise.resolve(fixture.access.get(`${pluginId}|${processId}`) ?? (pluginId === ENGINE ? FULL_ACCESS : NO_ACCESS)),
      resolvePrincipal: (_type, author) => Promise.resolve(`user:${author.id.toLowerCase()}`),
      log: (m) => logs.push(m),
    }),
  };
  return fixture;
}

let clock = Date.parse('2026-11-18T09:00:00.000Z');

/** A platform event as the Teams adapter would emit it. Each call is one
 *  second later than the last, so `occurredAt` orders them. */
export function messageEvent(overrides: Partial<ConversationMessageEvent> = {}): ConversationMessageEvent {
  clock += 1000;
  return {
    channelId: '@omadia/channel-teams',
    channelType: 'teams',
    conversationId: CONVERSATION,
    conversationType: 'group',
    receivedByChannelKey: MARA_KEY.toLowerCase(),
    messageId: 'm1',
    revision: 0,
    kind: 'created',
    author: { kind: 'teams-aad', id: 'AAD-Anna', displayName: 'Anna Köhler' },
    tenantId: 'tenant-1',
    text: 'A > C > B',
    occurredAt: new Date(clock).toISOString(),
    ...overrides,
  };
}

export const scopeOf = (agentSlug: string, conversationId = CONVERSATION) => ({
  agentSlug,
  channelType: 'teams',
  conversationId,
});

/** The process a test reads a conversation through. One per agent unless a
 *  test names another: `process-of-<slug>`. */
export const processOf = (
  agentSlug: string,
  conversationId = CONVERSATION,
  processId = `process-of-${agentSlug}`,
): ProcessMessageScope => ({ agentSlug, channelType: 'teams', conversationId, processId });

/** The engine's process of the agent reads every message of the conversation.
 *  Returns the outcome, so a test that expects a refusal can look at it. */
export const readAll = (
  fixture: Pick<HubFixture, 'hub'>,
  agentSlug: string,
  conversationId = CONVERSATION,
  processId?: string,
) => fixture.hub.subscribeProcess(processOf(agentSlug, conversationId, processId), 'all', ENGINE);
