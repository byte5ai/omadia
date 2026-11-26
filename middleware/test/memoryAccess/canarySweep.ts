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
  webAccountOrigin,
  type ChatParticipantsProvider,
} from '@omadia/orchestrator';
import {
  EDIT_PROCESS_TOOL_NAME,
  QUERY_PROCESSES_TOOL_NAME,
  RUN_STORED_PROCESS_TOOL_NAME,
  WRITE_PROCESS_TOOL_NAME,
  createEditProcessHandler,
  createQueryProcessesHandler,
  createRunStoredProcessHandler,
  createWriteProcessHandler,
  editProcessToolSpec,
  queryProcessesToolSpec,
  runStoredProcessToolSpec,
  writeProcessToolSpec,
} from '@omadia/orchestrator/dist/tools/processMemoryTool.js';
import { ContextRetriever } from '@omadia/orchestrator-extras';
import type { EmbeddingClient, KnowledgeGraph, MemoryStore, ProcessMemoryService } from '@omadia/plugin-api';
import { EntityRefBus, InMemoryNudgeRegistry, nativeToolResultText } from '@omadia/plugin-api';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';
import { parseSessionScope } from '../../packages/harness-channel-sdk/src/scopeId.js';
import type { TurnOrigin } from '../../packages/harness-channel-sdk/src/turnOrigin.js';

import { borrowPool } from '../../src/platform/borrowedPool.js';
import { KG_METHOD_ACCESS } from '../../src/platform/boundedGraphServices.js';
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
  | 'plugin-neighbors'
  /**
   * ADR-0044 — the same plugin's `ctx.services.get('knowledgeGraph' |
   * 'memoryStore' | 'processMemory')`: what a plugin declaring
   * `requires: ["knowledgeGraph@^1"]` (and the others) reads with the service.
   */
  | 'plugin-service';

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
  /** Neon only: what `edit_process` / `write_process` passed on to the store. */
  readonly processWrites?: ProcessWriteLog;
}

/**
 * #2223 — the write probe. Every turn tries to edit every process of its
 * tenant and to write into another agent's scope and into an unqualified
 * one. The store behind the two write tools is dry: it records what reached
 * it and changes nothing, so the seeded world stays as it is for the next
 * turn.
 */
export interface ProcessWriteLog {
  /** Process ids `edit_process` passed to `service.edit`. */
  readonly edited: string[];
  /** Scopes `write_process` passed to `service.write`. */
  readonly written: string[];
}

/** The unqualified scope the write probe asks for. */
export const PROBE_WRITE_SCOPE = 'probe-write';

function dryProcesses(raw: ProcessMemoryService, log: ProcessWriteLog): ProcessMemoryService {
  return {
    ...raw,
    get: (id) => raw.get(id),
    async edit(input) {
      log.edited.push(input.id);
      return { ok: false, reason: 'not-found' };
    },
    async write(input) {
      log.written.push(input.scope);
      return { ok: false, reason: 'invalid-title', message: 'dry run' };
    },
  };
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

function firstProbe(writeProbe: readonly { tool: string; input: unknown }[] = []): ModelStep {
  return {
    tools: [
      ...writeProbe,
      ...MEMORY_PROBES.map((path) => ({ tool: 'memory', input: { command: 'view', path } })),
      { tool: 'query_knowledge_graph', input: { query: 'stats' } },
      { tool: 'query_knowledge_graph', input: { query: 'list_sessions', limit: 100 } },
      { tool: 'query_knowledge_graph', input: { query: 'find_entity', name_contains: 'CANARY', limit: 100 } },
      // Only offered where the store has process memory (Neon); elsewhere the
      // orchestrator answers "unknown tool".
      { tool: QUERY_PROCESSES_TOOL_NAME, input: { query: 'Ablauf Schritte', limit: 50 } },
      { tool: PROBE_TOOL, input: { part: 'search' } },
      { tool: PROBE_TOOL, input: { part: 'neighbors' } },
      { tool: PROBE_TOOL, input: { part: 'service' } },
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
      // Built per viewer from the seeded omadia id (`sweepTurn`).
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

/** Where `/memories` keeps each tree: every directory and file the store has. */
async function allMemoryPaths(memory: MemoryStore): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = async (path: string): Promise<void> => {
    if (seen.has(path)) return;
    seen.add(path);
    out.push(path);
    for (const e of await memory.list(path)) {
      if (e.isDirectory) await walk(e.virtualPath);
      else if (!seen.has(e.virtualPath)) {
        seen.add(e.virtualPath);
        out.push(e.virtualPath);
      }
    }
  };
  await walk('/memories');
  return out;
}

/**
 * ADR-0044 — a plugin that declared the graph services reads with them. The
 * probe aims every read at the whole seeded world: it learns the scopes, node
 * ids, paths and process ids from the RAW stores (test-side knowledge), then
 * asks the bounded services for each. Refusals are recorded as text; they
 * carry no canary.
 */
async function probeServices(
  services: ReturnType<typeof createPluginContext>['services'],
  rawGraph: KnowledgeGraph,
  rawMemory: MemoryStore,
  rawProcesses: ProcessMemoryService | undefined,
): Promise<unknown[]> {
  const out: unknown[] = [];
  const attempt = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      out.push({ [label]: await fn() });
    } catch (err) {
      out.push({ [label]: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
    }
  };
  const kg = services.get<KnowledgeGraph>('knowledgeGraph');
  const memory = services.get<MemoryStore>('memoryStore');
  const processes = rawProcesses ? services.get<ProcessMemoryService>('processMemory') : undefined;
  if (!kg || !memory) throw new Error('probe plugin: services not granted');

  // Everything the raw graph holds: scopes, turn and entity node ids.
  const scopes = new Set((await rawGraph.listSessions()).map((s) => s.scope));
  const nodeIds = new Set<string>();
  for (const query of ALL_KEYWORDS) {
    for (const h of await rawGraph.searchTurns({ query, limit: 100 })) {
      nodeIds.add(h.turnId);
      scopes.add(h.scope);
    }
  }
  for (const e of await rawGraph.findEntities({ model: 'res.partner', nameContains: 'CANARY', limit: 200 })) {
    nodeIds.add(e.id);
  }

  for (const query of ALL_KEYWORDS) await attempt('searchTurns', () => kg.searchTurns({ query, limit: 100 }));
  const everything = await sweepEmbedder.embed(ALL_KEYWORDS.join(' '));
  await attempt('searchTurnsByEmbedding', () =>
    kg.searchTurnsByEmbedding({ queryEmbedding: everything, limit: 200, minSimilarity: -1 }),
  );
  await attempt('findEntityCapturedTurns', () =>
    kg.findEntityCapturedTurns({ terms: ['CANARY-ENTITY'], limit: 100 } as never),
  );
  await attempt('findEntities', () => kg.findEntities({ model: 'res.partner', nameContains: 'CANARY', limit: 200 }));
  for (const scope of scopes) {
    await attempt('getSession', () => kg.getSession(scope));
    await attempt('listPlansForScope', () => kg.listPlansForScope(scope));
  }
  for (const id of nodeIds) await attempt('getNeighbors', () => kg.getNeighbors(id));
  // Every kernel-only method, called bare: refused before it reads.
  for (const [method, access] of Object.entries(KG_METHOD_ACCESS)) {
    if (access !== 'kernel-only') continue;
    const fn = (kg as unknown as Record<string, unknown>)[method];
    if (typeof fn === 'function') {
      await attempt(method, async () => (fn as (...a: unknown[]) => Promise<unknown>).call(kg, {}));
    }
  }

  for (const path of await allMemoryPaths(rawMemory)) {
    // Labels never name the path: seeded file names carry their canary.
    await attempt('list', () => memory.list(path));
    await attempt('read', () => memory.readFile(path));
  }
  // Escapes the path check must see through.
  for (const path of ['/memories/core/../orchestrators', '/memories//sessions', 'memories/chat-sessions']) {
    await attempt('list', () => memory.list(path));
  }

  if (processes && rawProcesses) {
    await attempt('processes.query', () => processes.query({ query: 'Ablauf Schritte', limit: 200 }));
    for (const hit of await rawProcesses.query({ query: 'Ablauf Schritte', limit: 200 })) {
      await attempt('processes.get', () => processes.get(hit.record.id));
      await attempt('processes.history', () => processes.history(hit.record.id));
    }
  }
  return out;
}

/**
 * A plugin domain tool that reads what a domain tool may read mid-turn:
 * `ctx.knowledgeGraph` (`searchTurns`, `findEntityCapturedTurns`,
 * `getNeighbors` of every hit) and `ctx.memory` (its own tree, plus escapes
 * the accessor must refuse). Its context comes from the real
 * `createPluginContext`, so the turn's graph boundary applies as in
 * production.
 */
function probePlugin(graph: KnowledgeGraph, memory: MemoryStore, processes?: ProcessMemoryService) {
  const services = new ServiceRegistry();
  services.provide('knowledgeGraph', graph, '@omadia/knowledge-graph');
  services.provide('memoryStore', memory, '@omadia/memory');
  if (processes) services.provide('processMemory', processes, '@omadia/knowledge-graph-neon');
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
      // ADR-0044 — declared, so `ctx.services.get` hands the services over.
      requires: ['knowledgeGraph@^1', 'memoryStore@^1', 'processMemory@^1'],
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
    if (part === 'service') return JSON.stringify(await probeServices(ctx.services, graph, memory, processes));
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
  writeLog?: ProcessWriteLog,
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
    if (writeLog) {
      const dry = dryProcesses(stores.processes, writeLog);
      nativeToolRegistry.register(EDIT_PROCESS_TOOL_NAME, {
        handler: createEditProcessHandler(dry),
        spec: editProcessToolSpec,
      });
      nativeToolRegistry.register(WRITE_PROCESS_TOOL_NAME, {
        handler: createWriteProcessHandler(dry),
        spec: writeProcessToolSpec,
      });
    }
  }
  built.orchestrator.registerDomainTool(
    probePlugin(graph, stores.memory, stores.processes) as unknown as Parameters<typeof built.orchestrator.registerDomainTool>[0],
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
  const writeLog: ProcessWriteLog | undefined = seeded.stores[viewer.tenant].processes
    ? { edited: [], written: [] }
    : undefined;
  const writeProbe = writeLog ? processWriteProbe(seeded, viewer) : [];
  let round = 0;
  const model = scriptedModel((request) => {
    round += 1;
    return round === 1 ? firstProbe(writeProbe) : followUps(request, round);
  });
  const { orchestrator } = buildAgent(
    seeded,
    viewer.tenant,
    viewer.agent,
    mode,
    model.provider,
    viewer.shielded,
    recall,
    writeLog,
  );

  const origin = originOf(viewer.context);
  /** What the client was sent besides the tool calls (the model's view covers those). */
  const toClient: unknown[] = [];
  const run = async (): Promise<void> => {
    for await (const event of orchestrator.chatStream({
      // Names every conversation (turn legs) and every entity (entity leg).
      userMessage: `Was wissen wir zu CANARY-ENTITY ${ALL_KEYWORDS.join(' ')}?`,
      sessionScope: conversationOf(viewer.context, viewer.user),
      // Like production: on the web the session's omadia id and the account
      // origin built from it (#1774, `webTurnOrigin`); on Teams the raw
      // channel id plus the channel identity (orchestratorDispatcher).
      ...(origin
        ? {
            origin,
            userId: USERS[viewer.user],
            channelIdentity: { channelKind: 'teams' as const, channelUserId: USERS[viewer.user] },
          }
        : {
            userId: seeded.users[viewer.tenant][viewer.user],
            origin: webAccountOrigin(seeded.users[viewer.tenant][viewer.user]),
          }),
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
    // The write probe names the ids itself (they embed the title's slug); what
    // it reaches is checked through `processWrites`, not by canaries.
    if (e.tool === EDIT_PROCESS_TOOL_NAME || e.tool === WRITE_PROCESS_TOOL_NAME) continue;
    record(
      e.tool === 'memory'
        ? 'memory-tool'
        : e.tool === QUERY_PROCESSES_TOOL_NAME || e.tool === RUN_STORED_PROCESS_TOOL_NAME
          ? 'process-tool'
          : e.tool === PROBE_TOOL
            ? e.input['part'] === 'neighbors'
              ? 'plugin-neighbors'
              : e.input['part'] === 'service'
                ? 'plugin-service'
                : 'plugin-accessor'
            : 'graph-tool',
      e.result,
    );
  }
  record('client-stream', JSON.stringify(toClient));
  return { viewer, mode, sightings, ...(writeLog ? { processWrites: writeLog } : {}) };
}

/** Edit every process of the viewer's tenant; write into another agent's scope and an unqualified one. */
function processWriteProbe(seeded: Seeded, viewer: Viewer): { tool: string; input: unknown }[] {
  const ids = seeded.world.byStore.process
    .filter((p) => p.tenant === viewer.tenant)
    .map((p) => seeded.location.get(p.canary))
    .filter((id): id is string => id !== undefined);
  const other = AGENT_KEYS.find((a) => a !== viewer.agent)!;
  const write = (scope: string) => ({
    tool: WRITE_PROCESS_TOOL_NAME,
    input: { title: 'Probe: Schreibversuch', steps: ['a'], scope },
  });
  return [
    ...ids.map((id) => ({ tool: EDIT_PROCESS_TOOL_NAME, input: { id, title: 'Probe: Geaendert' } })),
    write(`${AGENTS[other]}::probe`),
    write(PROBE_WRITE_SCOPE),
  ];
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


/**
 * ADR-0044 — the probe plugin's services read outside any turn (activation,
 * a job, a webhook): turn, session, plan, neighbour and process reads are
 * refused, the private `/memories` trees too. Returns every canary it got.
 */
export async function sweepPluginServicesOutsideTurn(seeded: Seeded): Promise<string[]> {
  const stores = seeded.stores.main;
  const probe = probePlugin(sweepGraph(stores.graph), stores.memory, stores.processes);
  const text = await probe.handle({ part: 'service' });
  return [...new Set((text.match(CANARY) ?? []).map((c) => c.toUpperCase()))];
}

/**
 * ADR-0255 — a plugin holding the borrowed `graphPool` reads the kernel's
 * graph and process tables. Every probe goes through the guarded pool a
 * granted upload gets; returns every canary that came back. `control` runs
 * the same probes on the raw pool, which must find them.
 */
export async function sweepPluginGraphPool(seeded: Seeded, control = false): Promise<string[]> {
  const raw = seeded.pool;
  if (!raw) throw new Error('graphPool probe: the backend has no pool');
  const pool = control ? raw : borrowPool(raw, '@acme/granted-upload', { guardStatements: true });
  const texts: string[] = [];
  for (const sql of [
    'SELECT properties::text AS t FROM graph_nodes',
    'SELECT properties::text AS t FROM public.graph_nodes',
    'SELECT properties::text AS t FROM "graph_nodes"',
    'SELECT properties::text AS t FROM GRAPH_NODES',
    'SELECT n.properties::text AS t FROM graph_edges e JOIN graph_nodes n ON n.id = e.from_node',
    'WITH x AS (SELECT properties::text AS t FROM graph_nodes) SELECT t FROM x',
    'SELECT row_to_json(p)::text AS t FROM processes p',
    'SELECT row_to_json(h)::text AS t FROM process_history h',
    "SELECT query_to_xml('select properties from graph_' || 'nodes', true, true, '')::text AS t",
  ]) {
    try {
      const res = await pool.query<{ t: string }>(sql);
      texts.push(...res.rows.map((r) => String(r.t)));
    } catch (err) {
      texts.push(err instanceof Error ? err.message : String(err));
    }
  }
  return [...new Set((texts.join('\n').match(CANARY) ?? []).map((c) => c.toUpperCase()))];
}

