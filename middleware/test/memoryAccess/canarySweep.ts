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
import {
  QUERY_PROCESSES_TOOL_NAME,
  RUN_STORED_PROCESS_TOOL_NAME,
  createQueryProcessesHandler,
  createRunStoredProcessHandler,
  queryProcessesToolSpec,
  runStoredProcessToolSpec,
} from '@omadia/orchestrator/dist/tools/processMemoryTool.js';
import { ContextRetriever } from '@omadia/orchestrator-extras';
import type { EmbeddingClient, KnowledgeGraph, MemoryStore } from '@omadia/plugin-api';
import { EntityRefBus, InMemoryNudgeRegistry, nativeToolResultText } from '@omadia/plugin-api';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';
import { parseSessionScope } from '../../packages/harness-channel-sdk/src/scopeId.js';
import type { TurnOrigin } from '../../packages/harness-channel-sdk/src/turnOrigin.js';

import { createPluginContext } from '../../src/platform/pluginContext.js';
import { ServiceRegistry } from '../../src/platform/serviceRegistry.js';
import type { PluginCatalog } from '../../src/plugins/manifestLoader.js';
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
  | 'graph-tool'
  /** Stream events the client gets besides tool calls: recall cards, the graph walk, the answer. */
  | 'client-stream'
  /** `query_processes` / `run_stored_process` (Neon: process memory). */
  | 'process-tool'
  /** A plugin's domain tool: `ctx.knowledgeGraph` turn searches and `ctx.memory`. */
  | 'plugin-accessor'
  /** The same plugin: `ctx.knowledgeGraph.getNeighbors` of every node it found. */
  | 'plugin-neighbors';

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
      // Only offered where the store has process memory (Neon); elsewhere the
      // orchestrator answers "unknown tool".
      { tool: QUERY_PROCESSES_TOOL_NAME, input: { query: 'Ablauf Schritte', limit: 50 } },
      { tool: PROBE_TOOL, input: { part: 'search' } },
      { tool: PROBE_TOOL, input: { part: 'neighbors' } },
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
  const opened = new Set(
    seen.filter((e) => e.tool === RUN_STORED_PROCESS_TOOL_NAME).map((e) => String(e.input['id'])),
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
    if (e.tool === QUERY_PROCESSES_TOOL_NAME) {
      for (const m of e.result.matchAll(/"id":"([^"]+)"/g)) {
        const id = m[1]!;
        if (!opened.has(id)) {
          opened.add(id);
          next.push({ tool: RUN_STORED_PROCESS_TOOL_NAME, input: { id } });
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
 * The seeded graph as a sweep turn sees it: the turn's own writes (session
 * logger, run trace) are dropped, so every turn reads exactly the seeded
 * world. Identity resolution is the real one.
 */
function sweepGraph(graph: KnowledgeGraph): KnowledgeGraph {
  return new Proxy(graph, {
    get(target, prop, receiver) {
      if (prop === 'ingestRun') return async () => ({ runId: 'sweep' });
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
/**
 * How much recall returns. `wide` opens every limit, so the prompt shows
 * everything the ACL lets through. `production` keeps the plugin's defaults
 * (top few hits): what is recalled then drives what the graph walk around it
 * reaches, which a wide recall would crowd out under the walk's node cap.
 */
export type RecallLimits = 'wide' | 'production';

const PRODUCTION_RECALL = { teamVisibility: true } as const;

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

export const PROBE_TOOL = 'query_probe_plugin';
const PROBE_PLUGIN = '@omadia/memory-access-probe';

/**
 * A plugin domain tool that reads what a domain tool may read mid-turn:
 * `ctx.knowledgeGraph` (`searchTurns`, `findEntityCapturedTurns`,
 * `getNeighbors` of every hit) and `ctx.memory` (its own tree, plus escapes
 * the accessor must refuse). Its context comes from the real
 * `createPluginContext`, so the turn's graph boundary applies as in
 * production.
 */
function probePlugin(graph: KnowledgeGraph, memory: MemoryStore) {
  const services = new ServiceRegistry();
  services.provide('knowledgeGraph', graph, '@omadia/knowledge-graph');
  services.provide('memoryStore', memory, '@omadia/memory');
  const entry = {
    plugin: {
      id: PROBE_PLUGIN,
      kind: 'integration',
      name: PROBE_PLUGIN,
      version: '0.1.0',
      domain: 'test',
      setup_fields: [],
      permissions_summary: {
        memory_reads: [],
        memory_writes: [],
        graph_reads: [],
        graph_writes: [],
        network_outbound: [],
        graph_entity_systems: ['odoo'],
      },
      depends_on: [],
      provides: [],
      requires: [],
    },
    manifest: { permissions: { memory: { reads: ['*'], writes: ['*'] } } },
    source_path: '/abs/probe/manifest.yaml',
    source_kind: 'manifest-v1',
    origin: 'installed',
  };
  const catalog = {
    list: () => [entry],
    get: (id: string) => (id === PROBE_PLUGIN ? entry : undefined),
  } as unknown as PluginCatalog;
  type Opts = Parameters<typeof createPluginContext>[0];
  const ctx = createPluginContext({
    agentId: PROBE_PLUGIN,
    vault: { get: async () => undefined, listKeys: async () => [] } as unknown as Opts['vault'],
    registry: { has: () => true, list: () => [], get: () => ({ config: {} }) } as unknown as Opts['registry'],
    catalog,
    serviceRegistry: services,
    nativeToolRegistry: {
      register: () => () => undefined,
      registerHandler: () => () => undefined,
      get: () => undefined,
    } as unknown as Opts['nativeToolRegistry'],
    routeRegistry: { register: () => () => undefined, disposeBySource: () => 0 } as unknown as Opts['routeRegistry'],
    jobScheduler: { register: () => () => undefined, stopForPlugin: () => undefined } as unknown as Opts['jobScheduler'],
    // Not used by the accessors probed here.
    notificationRouter: {} as Opts['notificationRouter'],
    uiRouteCatalog: {} as Opts['uiRouteCatalog'],
  });
  const kg = ctx.knowledgeGraph;
  const mem = ctx.memory;
  if (!kg || !mem) throw new Error('probe plugin: accessors not granted');
  const handle = async (input: unknown): Promise<string> => {
    const part = (input as { part?: string } | undefined)?.part;
    const found: unknown[] = [];
    const nodeIds = new Set<string>();
    for (const query of ALL_KEYWORDS) {
      const hits = await kg.searchTurns({ query, limit: 50 });
      found.push(hits);
      for (const h of hits) nodeIds.add(h.turnId);
    }
    const captured = await kg.findEntityCapturedTurns({ terms: ['CANARY-ENTITY'], limit: 100 } as never);
    found.push(captured);
    for (const hit of captured) {
      nodeIds.add(hit.entity.id);
      for (const t of hit.turns) nodeIds.add(t.turnId);
    }
    if (part === 'neighbors') {
      const neighbors: unknown[] = [];
      for (const id of nodeIds) neighbors.push(await kg.getNeighbors(id));
      return JSON.stringify(neighbors);
    }
    const out: unknown[] = [found];
    for (const path of ['', 'memories', '../../core', '/memories/core', '..']) {
      try {
        const listed = await mem.list(path);
        out.push(listed);
        for (const e of listed) if (!e.isDirectory) out.push(await mem.readFile(e.relPath));
      } catch (err) {
        out.push(String(err));
      }
    }
    return JSON.stringify(out);
  };
  return {
    name: PROBE_TOOL,
    domain: 'test',
    agentId: PROBE_PLUGIN,
    spec: {
      name: PROBE_TOOL,
      description: 'Memory-access probe.',
      input_schema: {
        type: 'object' as const,
        properties: { part: { type: 'string', description: 'search or neighbors' } },
        required: [],
      },
    },
    handle,
  };
}

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
  recall: RecallLimits = 'wide',
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
      contextRetriever: new ContextRetriever(
        graph,
        recall === 'wide' ? WIDE_RECALL : PRODUCTION_RECALL,
        sweepEmbedder,
        undefined,
        stores.processes,
      ),
      ...(stores.processes ? { processMemory: stores.processes } : {}),
      audienceGrants: new MemberBaselineGrantStore(new InMemoryGrantStore()),
    },
  );
  // Registered the way the orchestrator plugin registers them, once a
  // `processMemory@1` provider runs (plugin.ts).
  if (stores.processes) {
    nativeToolRegistry.register(QUERY_PROCESSES_TOOL_NAME, {
      handler: createQueryProcessesHandler(stores.processes),
      spec: queryProcessesToolSpec,
    });
    nativeToolRegistry.register(RUN_STORED_PROCESS_TOOL_NAME, {
      handler: createRunStoredProcessHandler(stores.processes),
      spec: runStoredProcessToolSpec,
    });
  }
  built.orchestrator.registerDomainTool(
    probePlugin(graph, stores.memory) as unknown as Parameters<typeof built.orchestrator.registerDomainTool>[0],
  );
  return { orchestrator: built.orchestrator, nativeToolRegistry };
}

/** One real turn of `viewer` in `mode`; every canary the model was sent. */
export async function sweepTurn(
  seeded: Seeded,
  viewer: Viewer,
  mode: Mode,
  recall: RecallLimits = 'wide',
): Promise<TurnSweep> {
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
    recall,
  );

  const origin = originOf(viewer.context);
  /** What the client was sent besides the tool calls (the model's view covers those). */
  const toClient: unknown[] = [];
  const run = async (): Promise<void> => {
    for await (const event of orchestrator.chatStream({
      // Names every conversation (turn legs) and every entity (entity leg).
      userMessage: `Was wissen wir zu CANARY-ENTITY ${ALL_KEYWORDS.join(' ')}?`,
      sessionScope: conversationOf(viewer.context, viewer.user),
      // Like production: the session's omadia id on the web; the raw channel
      // id plus the channel identity on Teams (orchestratorDispatcher).
      ...(origin
        ? {
            origin,
            userId: USERS[viewer.user],
            channelIdentity: { channelKind: 'teams' as const, channelUserId: USERS[viewer.user] },
          }
        : { userId: seeded.users[viewer.tenant][viewer.user] }),
    })) {
      if (!/^(tool_|sub_)/.test(event.type)) toClient.push(event);
    }
  };
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
    record(
      e.tool === 'memory'
        ? 'memory-tool'
        : e.tool === QUERY_PROCESSES_TOOL_NAME || e.tool === RUN_STORED_PROCESS_TOOL_NAME
          ? 'process-tool'
          : e.tool === PROBE_TOOL
            ? e.input['part'] === 'neighbors'
              ? 'plugin-neighbors'
              : 'plugin-accessor'
            : 'graph-tool',
      e.result,
    );
  }
  record('client-stream', JSON.stringify(toClient));
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

