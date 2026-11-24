/**
 * Canary sweep (memory-ACL plan step 3): real orchestrator turns over the
 * seeded world, one per viewer and context-memory mode. Only the model is
 * scripted; binder, recall assembler, memory tool and graph tool are the
 * production classes. The model probes every in-turn read path and follows
 * what the tools hand back (listed files, listed sessions), so a path the
 * probe does not name up front is still reached.
 *
 * Every canary found in what the model was sent is checked against the
 * oracle: a canary the viewer may not obtain is a leak, wherever it came from.
 */
import { InMemoryGrantStore } from '@omadia/channel-sdk';
import type { LlmProvider, LlmRequest } from '@omadia/llm-provider';
import {
  MemberBaselineGrantStore,
  NativeToolRegistry,
  buildOrchestratorForAgent,
  turnContext,
  type ChatParticipantsProvider,
} from '@omadia/orchestrator';
import { ContextRetriever } from '@omadia/orchestrator-extras';
import type { EmbeddingClient, KnowledgeGraph, MemoryStore } from '@omadia/plugin-api';
import { EntityRefBus, InMemoryNudgeRegistry, nativeToolResultText } from '@omadia/plugin-api';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';
import { parseSessionScope } from '../../packages/harness-channel-sdk/src/scopeId.js';
import type { TurnOrigin } from '../../packages/harness-channel-sdk/src/turnOrigin.js';

import { scriptedModel, type ModelStep } from '../_helpers/scriptedModel.js';
import { expected, type Mode, type Verdict } from './oracle.js';
import { EMBEDDING_DIM, axis, turnQueryVector, type Seeded } from './seed.js';
import {
  AGENTS,
  AGENT_KEYS,
  CONTEXTS,
  CONTEXT_KEYS,
  NATIVE_CONVERSATION,
  TEAMS_TEAM_ID,
  USERS,
  USER_KEYS,
  conversationOf,
  presentIn,
  turnKeyword,

  type AgentKey,
  type ContextKey,
  type Item,
  type UserKey,
  type Viewer,
} from './world.js';

/** Where a canary reached the model. */
export type EntryPoint =
  /** The first request: recall, session tail, memory index, briefing. */
  | 'context'
  | 'memory-tool'
  | 'graph-tool';

export interface Sighting {
  readonly entry: EntryPoint;
  readonly canary: string;
  readonly item: Item;
  readonly verdict: Verdict;
}

export interface TurnSweep {
  readonly viewer: Viewer;
  readonly mode: Mode;
  readonly sightings: readonly Sighting[];
}

const CANARY = /CANARY-[A-Z]+-\d{5}Z/gi;

/** Every (agent, context, sender) conversation keyword in the world. */
export const ALL_KEYWORDS: readonly string[] = [...AGENT_KEYS, 'legacy' as const].flatMap((agent) =>
  CONTEXT_KEYS.flatMap((context) =>
    (context === 'web' ? USER_KEYS : (CONTEXTS[context].members as readonly UserKey[]).slice(0, 1)).map(
      (sender) => turnKeyword({ agent, context, sender }),
    ),
  ),
);

const KEYWORD = /kx(atlas|boreas|legacy)(dm|room1|room2|web)(alice|bob|carol)/g;

/**
 * The sum of the axes of every conversation keyword in the text (normalised),
 * so a probe naming every conversation is similar to every seeded turn;
 * anything else lands on an unused axis.
 */
export const sweepEmbedder: EmbeddingClient = {
  async embed(text: string) {
    const v = Array.from({ length: EMBEDDING_DIM }, () => 0);
    let n = 0;
    for (const m of text.matchAll(KEYWORD)) {
      const axisVector = turnQueryVector({
        agent: m[1] as AgentKey | 'legacy',
        context: m[2] as ContextKey,
        sender: m[3] as UserKey,
      });
      axisVector.forEach((x, i) => (v[i]! += x));
      n += 1;
    }
    if (n === 0) return axis(EMBEDDING_DIM - 1);
    const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
    return v.map((x) => x / norm);
  },
};

/** Paths the probe views first; everything a listing names is viewed after. */
const MEMORY_PROBES = [
  '/memories',
  '/memories/core',
  '/memories/_rules',
  '/memories/sessions',
  '/memories/chat-sessions',
  '/memories/~team',
  '/memories/~agent',
  '/memories/orchestrators',
  '/memories/contexts',
];

function firstProbe(): ModelStep {
  return {
    tools: [
      ...MEMORY_PROBES.map((path) => ({ tool: 'memory', input: { command: 'view', path } })),
      { tool: 'query_knowledge_graph', input: { query: 'stats' } },
      { tool: 'query_knowledge_graph', input: { query: 'list_sessions', limit: 100 } },
      { tool: 'query_knowledge_graph', input: { query: 'find_entity', name_contains: 'CANARY', limit: 100 } },
      ...ALL_KEYWORDS.flatMap((text) => [
        { tool: 'query_knowledge_graph', input: { query: 'search_turns', text, limit: 100 } },
        { tool: 'query_knowledge_graph', input: { query: 'search_turns_semantic', text, limit: 100 } },
      ]),
    ],
  };
}

interface ToolExchange {
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly result: string;
}

/** The tool calls of a request's history with their results. */
function exchanges(request: LlmRequest): ToolExchange[] {
  const calls = new Map<string, { tool: string; input: Record<string, unknown> }>();
  const out: ToolExchange[] = [];
  for (const message of request.messages) {
    if (typeof message.content === 'string') continue;
    for (const part of message.content as unknown as readonly Record<string, unknown>[]) {
      if (part['type'] === 'tool_call') {
        calls.set(String(part['id']), {
          tool: String(part['name']),
          input: (part['input'] ?? {}) as Record<string, unknown>,
        });
      } else if (part['type'] === 'tool_result') {
        const call = calls.get(String(part['toolCallId']));
        const content = part['content'];
        const result =
          typeof content === 'string'
            ? content
            : (content as readonly { text?: string }[]).map((c) => c.text ?? '').join('\n');
        if (call) out.push({ ...call, result });
      }
    }
  }
  return out;
}

/** Follow-up calls for what the last round of tool results named. */
function followUps(request: LlmRequest, round: number): ModelStep {
  if (round >= 6) return { text: 'Fertig.' };
  const seen = exchanges(request);
  const viewed = new Set(
    seen.filter((e) => e.tool === 'memory').map((e) => String(e.input['path'])),
  );
  const summarised = new Set(
    seen
      .filter((e) => e.tool === 'query_knowledge_graph' && e.input['query'] === 'session_summary')
      .map((e) => String(e.input['scope'])),
  );
  const next: { tool: string; input: unknown }[] = [];
  for (const e of seen) {
    if (e.tool === 'memory') {
      for (const m of e.result.matchAll(/\t(\/memories\/\S+)/g)) {
        const path = m[1]!;
        if (!viewed.has(path)) {
          viewed.add(path);
          next.push({ tool: 'memory', input: { command: 'view', path } });
        }
      }
    }
    if (e.tool === 'query_knowledge_graph') {
      for (const m of e.result.matchAll(/"scope":"([^"]+)"/g)) {
        const scope = m[1]!;
        if (!summarised.has(scope)) {
          summarised.add(scope);
          next.push({ tool: 'query_knowledge_graph', input: { query: 'session_summary', scope, limit: 100 } });
        }
      }
    }
  }
  return next.length > 0 ? { tools: next } : { text: 'Fertig.' };
}

let probeTurns = 0;

/**
 * The seeded graph as a sweep turn sees it: identity resolution maps each
 * world user's channel id onto their world uuid, and the turn's own ingest
 * (session logger) is dropped, so every turn reads exactly the seeded world.
 */
function sweepGraph(graph: KnowledgeGraph): KnowledgeGraph {
  const known = new Set(Object.values(USERS));
  return new Proxy(graph, {
    get(target, prop, receiver) {
      if (prop === 'resolveOrCreateChannelIdentity') {
        return async (ingest: { channelUserId: string }) =>
          known.has(ingest.channelUserId)
            ? { omadiaUserId: ingest.channelUserId, created: false }
            : target.resolveOrCreateChannelIdentity(ingest as never);
      }
      if (prop === 'ingestTurn') {
        return async () => {
          probeTurns += 1;
          return { sessionId: 'sweep', turnId: `sweep-${String(probeTurns)}`, entityNodeIds: [] };
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** The seeded `/memories` store, read-only: the turn's transcript is not written. */
function readOnly(store: MemoryStore): MemoryStore {
  const skip = async (): Promise<void> => undefined;
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === 'createFile' || prop === 'writeFile' || prop === 'delete' || prop === 'rename') return skip;
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

function originOf(ctx: ContextKey): TurnOrigin | undefined {
  switch (ctx) {
    case 'web':
      return undefined;
    case 'dm':
      return { channelType: 'teams', scope: { kind: 'personal', userId: USERS.alice } };
    case 'room1':
    case 'room2':
      return {
        channelType: 'teams',
        scope: parseSessionScope(`msteams::${NATIVE_CONVERSATION[ctx]}`),
        container: { kind: 'team', id: TEAMS_TEAM_ID },
      };
  }
}

function rosterOf(ctx: ContextKey, sender: UserKey): ChatParticipantsProvider {
  const list = presentIn(ctx, sender).map((u) => ({
    channelUserId: USERS[u],
    aadObjectId: USERS[u],
    displayName: u,
    email: null,
    userPrincipalName: null,
  }));
  return Object.assign(async () => Promise.resolve(list), { completeRoster: true as const });
}

/**
 * Recall limits opened wide, so the prompt shows everything the ACL lets
 * through instead of the top few: the sweep tests who may see, not ranking.
 * The ACL-relevant options are production's (`teamVisibility` on, pinned).
 */
const WIDE_RECALL = {
  teamVisibility: true,
  tailSize: 100,
  ftsLimit: 100,
  entityLimit: 100,
  defaultBudgetTokens: 10_000_000,
  maxChars: 100_000_000,
  memoryLimit: 2_000,
  excerptsPerMemory: 5,
  memoryMinSimilarity: -1,
  durableReservedSlots: 2_000,
  durableMinSimilarity: -1,
  planLimit: 1_000,
  planOpenOnly: false,
  recallRequiresTerms: false,
  recallRelevanceJudgeDisabled: true,
  durableRelevanceJudgeEnabled: false,
  compactModeThreshold: 1_000_000,
} as const;

/**
 * An agent built the way production builds one (`buildOrchestratorForAgent`):
 * binder, namespacer, shield wiring, session logger, the default-on audience
 * floor with the member baseline. Only the model is scripted.
 */
function buildAgent(
  seeded: Seeded,
  tenant: Viewer['tenant'],
  agent: AgentKey,
  mode: Mode,
  provider: LlmProvider,
  shielded: boolean,
) {
  const stores = seeded.stores[tenant];
  const graph = sweepGraph(stores.graph);
  const privacy = shielded ? createPrivacyGuardService({ readConfig: () => undefined }) : undefined;
  const nativeToolRegistry = new NativeToolRegistry();
  const built = buildOrchestratorForAgent(
    {
      agentId: AGENTS[agent],
      model: 'test',
      maxTokens: 1024,
      maxToolIterations: 8,
      contextMemory: mode,
    },
    {
      provider,
      knowledgeGraph: graph,
      memoryStore: readOnly(stores.memory),
      entityRefBus: new EntityRefBus(),
      nativeToolRegistry,
      nudgeRegistry: new InMemoryNudgeRegistry(),
      responseGuard: () => undefined,
      privacyGuard: () => privacy,
      embeddingClient: sweepEmbedder,
      contextRetriever: new ContextRetriever(graph, WIDE_RECALL, sweepEmbedder),
      audienceGrants: new MemberBaselineGrantStore(new InMemoryGrantStore()),
    },
  );
  return { orchestrator: built.orchestrator, nativeToolRegistry };
}

/** One real turn of `viewer` in `mode`; every canary the model was sent. */
export async function sweepTurn(seeded: Seeded, viewer: Viewer, mode: Mode): Promise<TurnSweep> {
  let round = 0;
  const model = scriptedModel((request) => {
    round += 1;
    return round === 1 ? firstProbe() : followUps(request, round);
  });
  const { orchestrator } = buildAgent(
    seeded,
    viewer.tenant,
    viewer.agent,
    mode,
    model.provider,
    viewer.shielded,
  );

  const origin = originOf(viewer.context);
  const run = () =>
    orchestrator.chat({
      // Names every conversation (turn legs) and every entity (entity leg).
      userMessage: `Was wissen wir zu CANARY-ENTITY ${ALL_KEYWORDS.join(' ')}?`,
      sessionScope: conversationOf(viewer.context, viewer.user),
      userId: USERS[viewer.user],
      ...(origin ? { origin } : {}),
    });
  await (CONTEXTS[viewer.context].kind === 'group'
    ? turnContext.runWithChatParticipants(rosterOf(viewer.context, viewer.user), run)
    : run());

  const byCanary = new Map(seeded.world.items.map((i) => [i.canary, i]));
  const sightings: Sighting[] = [];
  const record = (entry: EntryPoint, text: string): void => {
    for (const m of new Set([...text.matchAll(CANARY)].map((x) => x[0].toUpperCase()))) {
      const item = byCanary.get(m);
      if (!item) continue;
      sightings.push({ entry, canary: m, item, verdict: expected(viewer, mode, item) });
    }
  };
  const first = model.requests[0];
  if (first) record('context', JSON.stringify({ system: first.system, messages: first.messages }));
  const last = model.requests.at(-1);
  for (const e of last ? exchanges(last) : []) {
    record(e.tool === 'memory' ? 'memory-tool' : 'graph-tool', e.result);
  }
  return { viewer, mode, sightings };
}

/**
 * The kernel-native registration of `query_knowledge_graph` (the
 * subscription-CLI path), called the way that path calls it: outside any turn.
 */
export async function sweepRegisteredGraphTool(
  seeded: Seeded,
  agent: AgentKey,
  mode: Mode,
): Promise<string[]> {
  const { nativeToolRegistry: registry } = buildAgent(
    seeded,
    'main',
    agent,
    mode,
    {} as LlmProvider,
    false,
  );
  const handler = registry.get('query_knowledge_graph')?.handler;
  if (!handler) throw new Error('query_knowledge_graph is not registered');
  const texts: string[] = [];
  for (const input of [
    { query: 'list_sessions', limit: 100 },
    { query: 'find_entity', name_contains: 'CANARY', limit: 100 },
    ...ALL_KEYWORDS.map((text) => ({ query: 'search_turns', text, limit: 100 })),
  ]) {
    texts.push(nativeToolResultText(await handler(input)));
  }
  return [...new Set(texts.join('\n').match(CANARY) ?? [])];
}

