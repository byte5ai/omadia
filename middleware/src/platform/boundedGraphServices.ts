/**
 * ADR-0044 — the bounded form of the graph services a plugin resolves.
 *
 * ADR-0040 gave every turn one graph read boundary (`GraphReadScope`) and put
 * the plugin accessors (`ctx.knowledgeGraph`) behind it. A plugin that
 * declared `requires: ["knowledgeGraph@^1"]` (or `processMemory`,
 * `memoryStore`) still got the RAW service from `ctx.services.get` and read
 * past the boundary. This module is what such a plugin gets instead:
 *
 *  - `knowledgeGraph@1`: every method of the contract is classified
 *    ({@link KG_METHOD_ACCESS}; the compiler makes a new method pick one).
 *    Entity and fact writes stay in the plugin's declared entity systems
 *    (ADR-0167); master-data reads and stats pass; turn,
 *    session, neighbour and plan reads go through the turn's boundary and are
 *    refused outside a turn; cross-user methods are kernel-only.
 *  - `processMemory@1`: reads see what the process tools see
 *    (`currentProcessReadFilter`); outside a turn they are refused.
 *  - `memoryStore@1`: the private trees (agents, contexts, transcripts, web
 *    chat copies) are never reachable; shared trees (`core`, `_*`, a plugin's
 *    own top-level tree such as `pairings`) are, in and outside a turn.
 *  - `topicClustering@1`: kernel-only. Its reads take the viewer as an
 *    argument and its re-cluster rebuilds every account's topics.
 *
 * Outside a turn there is no boundary, and the bounded form does not invent
 * one. Kernel code that must read the tenant's graph outside a turn (recall,
 * review jobs, purges) holds the raw service — the providers and the modules
 * that implement the boundary, {@link GRAPH_BOUNDARY_IMPLEMENTERS}. That is
 * the explicit form: a module on that list, reviewed in this repository.
 *
 * `graphPool` has no bounded form: it is a SQL pool, granted by the operator
 * (`permissions.sql`, C7) and borrowed, never a read path of the boundary.
 */
import { posix } from 'node:path';

import {
  GraphServiceRefusedError,
  KgEntityNamespaceError,
  MemoryPathError,
  agentScopePrefix,
  neighborsOfType,
  scopeBelongsToAgent,
  type EditProcessInput,
  type EditProcessResult,
  type EntityIngest,
  type FactIngest,
  type GraphNode,
  type KnowledgeGraph,
  type MemoryEntry,
  type MemoryStore,
  type ProcessMemoryService,
  type ProcessQueryHit,
  type ProcessRecord,
  type QueryProcessesInput,
  type TopicClusteringService,
  type TurnSearchHit,
  TOPIC_CLUSTERING_SERVICE_NAME,
} from '@omadia/plugin-api';
import {
  currentGraphNodeViewer,
  currentProcessBoundary,
  currentProcessReadFilter,
  graphNodeFilter,
  graphScopeFor,
  graphSessionAccess,
  turnContext,
  type GraphReadScope,
} from '@omadia/orchestrator';

import type { PluginCatalog } from '../plugins/manifestLoader.js';
import { neighborsForPlugin } from './shieldedNeighbors.js';

// ---------------------------------------------------------------------------
// Who holds the raw services
// ---------------------------------------------------------------------------

/**
 * The bundled modules that hold the raw graph services, because they provide
 * them or implement the boundary itself (recall, tenant review jobs). CLOSED
 * SET, keyed by id and honoured only for `origin === 'bundled'`: an upload or
 * a local-dev package claiming one of these ids gets the bounded form, as it
 * inherits no legacy grant either (#789).
 *
 * Not on the list, by decision (ADR-0044): `@omadia/verifier` (reads master
 * data through `findEntities` only), `@omadia/plugin-plan-runner` (its own
 * plans; processes like the process tools), `@omadia/diagrams` (`_brand`).
 */
export const GRAPH_BOUNDARY_IMPLEMENTERS: ReadonlySet<string> = new Set([
  '@omadia/orchestrator',
  '@omadia/orchestrator-extras',
  '@omadia/knowledge-graph-neon',
  '@omadia/knowledge-graph-inmemory',
  '@omadia/memory',
  '@omadia/memory-postgres',
]);

/** Service names that have a bounded form. */
export const BOUNDED_GRAPH_SERVICE_NAMES: ReadonlySet<string> = new Set([
  'knowledgeGraph',
  'processMemory',
  'memoryStore',
  // Topics are content of every member's memory (ADR-0045): `list` takes any
  // viewer id and `recluster` rebuilds every account's topics. Kernel-only.
  TOPIC_CLUSTERING_SERVICE_NAME,
]);

/** Whether this plugin resolves the raw graph services. */
export function holdsRawGraphServices(agentId: string, catalog: PluginCatalog): boolean {
  return GRAPH_BOUNDARY_IMPLEMENTERS.has(agentId) && catalog.get(agentId)?.origin === 'bundled';
}

/**
 * The form of `service` (registered under `name`) that `pluginId` gets.
 * Names without a bounded form come back unchanged. One wrapper per
 * (plugin, service object), so repeated lookups return the same object.
 * `entitySystems` is the plugin's `permissions.graph.entity_systems`
 * (ADR-0167: what its `knowledgeGraph@1` entity and fact writes may name).
 */
export function boundGraphService<T>(
  name: string,
  service: T,
  pluginId: string,
  entitySystems: readonly string[] = [],
): T {
  if (!BOUNDED_GRAPH_SERVICE_NAMES.has(name) || typeof service !== 'object' || service === null) {
    return service;
  }
  // The entity systems are part of the key: a plugin updated in place with
  // other `entity_systems` must not keep the wrapper of its old manifest.
  const key = `${pluginId}\u0000${name}\u0000${[...entitySystems].sort().join(',')}`;
  let perService = wrapperCache.get(service);
  if (!perService) {
    perService = new Map();
    wrapperCache.set(service, perService);
  }
  const cached = perService.get(key);
  if (cached !== undefined) return cached as T;
  const wrapped =
    name === 'knowledgeGraph'
      ? boundKnowledgeGraph(service as unknown as KnowledgeGraph, pluginId, entitySystems)
      : name === 'processMemory'
        ? boundProcessMemory(service as unknown as ProcessMemoryService, pluginId)
        : name === TOPIC_CLUSTERING_SERVICE_NAME
          ? boundTopicClustering(pluginId)
          : boundMemoryStore(service as unknown as MemoryStore, pluginId);
  perService.set(key, wrapped);
  return wrapped as T;
}

const wrapperCache = new WeakMap<object, Map<string, unknown>>();

// ---------------------------------------------------------------------------
// Entity writes: the plugin's own entity systems (ADR-0167)
// ---------------------------------------------------------------------------

/** The system of an entity external id (`<system>:<model>:<id>`). */
function systemOfEntityId(externalId: string): string {
  const colon = externalId.indexOf(':');
  return colon < 0 ? externalId : externalId.slice(0, colon);
}

/** The node-id namespace of a fact (`factNodeId`). */
const FACT_ID_PREFIX = 'fact:';

/**
 * ADR-0167 — the check on a plugin's entity and fact writes: an entity's
 * `system`, and the system prefix of every id a fact mentions, must be one
 * of the plugin's declared `permissions.graph.entity_systems`. A fact's own
 * id must be a fact id (`fact:…`): the providers upsert the node by that id
 * whatever its type, so `odoo:res.partner:42` would write into the partner.
 * Throws `KgEntityNamespaceError` naming the first system outside them.
 */
export function entityWriteGuard(pluginId: string, entitySystems: readonly string[]) {
  const allowed = new Set(entitySystems);
  const assertSystem = (system: string): void => {
    if (!allowed.has(system)) throw new KgEntityNamespaceError(pluginId, system);
  };
  return {
    entities(entities: readonly EntityIngest[]): void {
      for (const entity of entities) assertSystem(entity.system);
    },
    facts(facts: readonly FactIngest[]): void {
      for (const fact of facts) {
        if (!fact.factId.startsWith(FACT_ID_PREFIX)) {
          throw new KgEntityNamespaceError(pluginId, systemOfEntityId(fact.factId));
        }
        for (const id of fact.mentionedEntityIds ?? []) assertSystem(systemOfEntityId(id));
      }
    },
  };
}

/** Plugins already warned about undeclared entity writes (once per process). */
const undeclaredEntityWriters = new Set<string>();

/**
 * The bounded `ingestEntities` / `ingestFacts`. A plugin that declares
 * `entity_systems` writes only there. One that declares none still writes
 * (ADR-0167: the shipped Odoo and Confluence syncs declare none yet), with a
 * warning once per plugin, until the strict rule replaces the transition.
 */
function boundedEntityWrites(kg: KnowledgeGraph, pluginId: string, entitySystems: readonly string[]) {
  const guard = entitySystems.length > 0 ? entityWriteGuard(pluginId, entitySystems) : undefined;
  const warnUndeclared = (method: string): void => {
    if (undeclaredEntityWriters.has(pluginId)) return;
    undeclaredEntityWriters.add(pluginId);
    console.warn(
      `[security-audit] plugin '${pluginId}' writes entities through knowledgeGraph@1.${method} without declaring permissions.graph.entity_systems — allowed during the ADR-0167 transition, refused once it ends`,
    );
  };
  return {
    async ingestEntities(entities: EntityIngest[]): ReturnType<KnowledgeGraph['ingestEntities']> {
      if (guard) guard.entities(entities);
      else if (entities.length > 0) warnUndeclared('ingestEntities');
      return kg.ingestEntities(entities);
    },
    async ingestFacts(facts: FactIngest[]): ReturnType<KnowledgeGraph['ingestFacts']> {
      if (guard) guard.facts(facts);
      else if (facts.length > 0) warnUndeclared('ingestFacts');
      return kg.ingestFacts(facts);
    },
  };
}

// ---------------------------------------------------------------------------
// The turn's boundary
// ---------------------------------------------------------------------------

/** The current turn's graph read boundary; undefined = none is set. */
function currentBoundary(): GraphReadScope | undefined {
  return turnContext.current()?.graphReadScope?.value;
}

function shieldActive(): boolean {
  return turnContext.current()?.privacyHandle !== undefined;
}

/**
 * The current turn's graph boundary (`TurnContextValue.graphReadScope`)
 * applied to a plugin's turn search: the options to pass down plus an exact
 * scope check for the hits (the `agentScopePrefix` pre-filter is a LIKE).
 * `null` = this search sees no turns — the turn may see none, or no boundary
 * is set (ADR-0044: outside a turn, or in a turn before its boundary is
 * bound, a plugin search sees nothing).
 */
export function boundTurnSearch<
  T extends {
    agentScopePrefix?: string;
    audienceOwners?: readonly string[];
    userId?: string;
    excludeUnprotected?: boolean;
  },
>(
  rawOptions: T,
): { options: T; scopeAllowed: (scope: string) => boolean } | null {
  // #1507 — inside a turn that runs under a Privacy Shield, a plugin's turn
  // search skips turns stored `unprotected`, like the recall legs do.
  const options: T = shieldActive() ? { ...rawOptions, excludeUnprotected: true } : rawOptions;
  const bound = currentBoundary();
  if (!bound || bound.kind === 'nothing') return null;
  if (bound.kind === 'user') {
    // `off` / `enforce` (#2204): this agent's turns the turn's user sent.
    if (!bound.userId) return null;
    return {
      options: { ...options, agentScopePrefix: bound.agentScopePrefix, userId: bound.userId },
      scopeAllowed: (scope) => scopeBelongsToAgent(scope, bound.agentScopePrefix),
    };
  }
  if (bound.kind === 'members') {
    if (!bound.audience) return null;
    return {
      options: { ...options, agentScopePrefix: bound.agentScopePrefix, audienceOwners: bound.audience },
      scopeAllowed: (scope) => scope.startsWith(bound.agentScopePrefix),
    };
  }
  const only = bound.scope;
  if (!only) return null;
  return { options: { ...options, agentScopePrefix: only }, scopeAllowed: (scope) => scope === only };
}

type TurnReadGraph = Pick<
  KnowledgeGraph,
  | 'searchTurns'
  | 'findEntityCapturedTurns'
  | 'searchTurnsByEmbedding'
  | 'getNeighbors'
  | 'getNeighborsOfType'
  | 'getSession'
  | 'findEntities'
>;

/**
 * The turn reads a plugin may make, held to the turn's boundary: shared by
 * the bounded `knowledgeGraph@1` service and the `ctx.knowledgeGraph`
 * accessor. Each throws `no-boundary` when no boundary is set.
 */
export function boundedTurnReads(kg: () => TurnReadGraph, pluginId: string, capability: string) {
  const requireBoundary = (method: string): GraphReadScope => {
    const bound = currentBoundary();
    if (!bound) throw new GraphServiceRefusedError(pluginId, capability, method, 'no-boundary');
    return bound;
  };
  const filterHits = <H extends { scope: string }>(hits: H[], allowed: (scope: string) => boolean): H[] =>
    hits.filter((h) => allowed(h.scope));
  return {
    async searchTurns(opts: Parameters<KnowledgeGraph['searchTurns']>[0]): Promise<TurnSearchHit[]> {
      requireBoundary('searchTurns');
      const bounded = boundTurnSearch(opts);
      if (bounded === null) return [];
      return filterHits(await kg().searchTurns(bounded.options), bounded.scopeAllowed);
    },
    async findEntityCapturedTurns(
      opts: Parameters<KnowledgeGraph['findEntityCapturedTurns']>[0],
    ): ReturnType<KnowledgeGraph['findEntityCapturedTurns']> {
      requireBoundary('findEntityCapturedTurns');
      const bounded = boundTurnSearch(opts);
      if (bounded === null) return [];
      const hits = await kg().findEntityCapturedTurns(bounded.options);
      return hits
        .map((hit) => ({ ...hit, turns: hit.turns.filter((t) => bounded.scopeAllowed(t.scope)) }))
        .filter((hit) => hit.turns.length > 0);
    },
    async searchTurnsByEmbedding(
      opts: Parameters<KnowledgeGraph['searchTurnsByEmbedding']>[0],
    ): Promise<TurnSearchHit[]> {
      requireBoundary('searchTurnsByEmbedding');
      const bounded = boundTurnSearch(opts);
      if (bounded === null) return [];
      return filterHits(await kg().searchTurnsByEmbedding(bounded.options), bounded.scopeAllowed);
    },
    // #1540 — under a shield, no content of a turn stored `unprotected`
    // (shieldedNeighbors.ts). #2208 — only the neighbours the turn may see
    // (graphNodeAccess.ts), as its searches.
    async getNeighbors(nodeId: string): Promise<GraphNode[]> {
      requireBoundary('getNeighbors');
      const graph = kg();
      const shielded = await neighborsForPlugin(graph, nodeId, shieldActive());
      const viewer = currentGraphNodeViewer();
      if (!viewer) return [];
      const visible = graphNodeFilter(graph, viewer);
      const keep = await Promise.all(shielded.map(visible));
      return shielded.filter((_, i) => keep[i]);
    },
    // Entity nodes are global in `off` / `enforce` (ADR-0040) and outside a
    // turn (synced master data, no viewer). In a context-bound turn an entity
    // a conversation captured is reached only through a turn the boundary
    // admits, as the graph tool and the node filter reach it; an entity no
    // turn captured (an Odoo or Confluence sync) stays master data.
    async findEntities(opts: Parameters<KnowledgeGraph['findEntities']>[0]): Promise<GraphNode[]> {
      const graph = kg();
      const hits = await graph.findEntities(opts);
      const bound = currentBoundary();
      if (!bound || bound.kind === 'user') return hits;
      if (hits.length === 0) return hits;
      const viewer = currentGraphNodeViewer();
      const visible = viewer ? graphNodeFilter(graph, viewer) : async () => false;
      // One neighbour query for every hit; the filter reads each session once.
      const capturing = await neighborsOfType(
        graph,
        hits.map((entity) => entity.id),
        'Turn',
      );
      const keep = await Promise.all(
        hits.map(async (entity) => {
          const turns = capturing.get(entity.id) ?? [];
          if (turns.length === 0) return true;
          for (const t of turns) if (await visible(t)) return true;
          return false;
        }),
      );
      return hits.filter((_, i) => keep[i]);
    },
    // A session the boundary admits, read the way the graph tool reads it
    // (agent, user or audience). The caller's own options do not widen it.
    // Outside the turn's own conversation a tail-only turn, and under a
    // shield an `unprotected` one, stays out, as in recall and the node
    // filter (#1096, #1507).
    async getSession(scope: string): ReturnType<KnowledgeGraph['getSession']> {
      const bound = requireBoundary('getSession');
      const access = graphSessionAccess(kg(), bound);
      if (!access.scopeAllowed(scope)) return null;
      const session = await access.readSession(scope);
      if (!session || scope === currentGraphNodeViewer()?.ownScope) return session;
      const shielded = shieldActive();
      const turns = session.turns.filter(
        (t) => t.turn.props['tailOnly'] !== true && !(shielded && t.turn.props['unprotected'] === true),
      );
      return turns.length > 0 ? { ...session, turns } : null;
    },
    requireBoundary,
  };
}

// ---------------------------------------------------------------------------
// knowledgeGraph@1
// ---------------------------------------------------------------------------

/**
 * How the bounded form treats a method:
 *  - `entity-write`: entity and fact writes, held to the plugin's declared
 *    entity systems ({@link boundedEntityWrites}, ADR-0167).
 *  - `pass`: graph stats.
 *  - `entities`: master data; in a context-bound turn only what the boundary
 *    reaches ({@link boundedTurnReads}' `findEntities`).
 *  - `turn-read`: held to the turn's boundary ({@link boundedTurnReads}).
 *  - `plan`: plan reads and writes, inside a turn and its own conversation.
 *  - `own-plans`: plans of the turn's own conversation, in `off` / `enforce`.
 *  - `kernel-only`: across users or agents; refused.
 *  - `absent`: an optional kernel helper left off the bounded object, so
 *    `neighborsOfType` falls back to the bounded `getNeighbors`.
 */
type KgMethodAccess = 'absent' | 'entity-write' | 'pass' | 'entities' | 'turn-read' | 'plan' | 'own-plans' | 'kernel-only';

/** Every method of the contract, classified. A new method must pick one. */
export const KG_METHOD_ACCESS: { readonly [K in keyof Required<KnowledgeGraph>]: KgMethodAccess } =
  Object.freeze({
    ingestEntities: 'entity-write',
    ingestFacts: 'entity-write',
    findEntities: 'entities',
    stats: 'pass',

    searchTurns: 'turn-read',
    findEntityCapturedTurns: 'turn-read',
    searchTurnsByEmbedding: 'turn-read',
    getNeighbors: 'turn-read',
    // The batched read the bounded `findEntities` uses. Not on the bounded
    // object: a plugin walks with `getNeighbors`, which the node filter
    // bounds, and `neighborsOfType` falls back to it.
    getNeighborsOfType: 'absent',
    getSession: 'turn-read',

    ingestPlan: 'plan',
    upsertPlanStep: 'plan',
    getPlan: 'plan',
    getPlanSteps: 'plan',
    getPlanStepsForPlans: 'plan',
    setPlanStepStatus: 'plan',
    deletePlan: 'plan',
    listPlansForScope: 'own-plans',

    // Turns and runs are the kernel's record of a conversation.
    ingestTurn: 'kernel-only',
    amendTurn: 'kernel-only',
    ingestRun: 'kernel-only',
    getRunForTurn: 'kernel-only',
    listSessions: 'kernel-only',
    listRecentPlans: 'kernel-only',
    resolveOrCreateChannelIdentity: 'kernel-only',
    // Curated memory, its ACL and its review queues.
    createMemorableKnowledge: 'kernel-only',
    getMemorableKnowledge: 'kernel-only',
    listMemorableKnowledgeFor: 'kernel-only',
    addOwner: 'kernel-only',
    removeOwner: 'kernel-only',
    deleteMemory: 'kernel-only',
    countMemorableKnowledge: 'kernel-only',
    purgeMemorableKnowledge: 'kernel-only',
    countConversationHistory: 'kernel-only',
    purgeConversationHistory: 'kernel-only',
    listMemoryAclAudit: 'kernel-only',
    updateMemorableKnowledge: 'kernel-only',
    listExcerptsForMemory: 'kernel-only',
    updateExcerpt: 'kernel-only',
    deleteExcerpt: 'kernel-only',
    searchMemorableKnowledgeByEmbedding: 'kernel-only',
    searchExcerptsByEmbedding: 'kernel-only',
    listInconsistencies: 'kernel-only',
    getInconsistency: 'kernel-only',
    createInconsistency: 'kernel-only',
    resolveInconsistency: 'kernel-only',
    listMemorableKnowledgeIdsForBulkInconsistencyCheck: 'kernel-only',
    countMemorableKnowledgeInconsistencyCheckBuckets: 'kernel-only',
    markMemorableKnowledgeInconsistencyChecked: 'kernel-only',
    listMergeCandidates: 'kernel-only',
    getMergeCandidate: 'kernel-only',
    createMergeCandidate: 'kernel-only',
    resolveMergeCandidate: 'kernel-only',
    listMemorableKnowledgeIdsForBulkMergeCheck: 'kernel-only',
    countMemorableKnowledgeMergeCheckBuckets: 'kernel-only',
    markMemorableKnowledgeMergeChecked: 'kernel-only',
    listExcerptMergeCandidates: 'kernel-only',
    getExcerptMergeCandidate: 'kernel-only',
    createExcerptMergeCandidate: 'kernel-only',
    resolveExcerptMergeCandidate: 'kernel-only',
    listPalaiaExcerptIdsForBulkMergeCheck: 'kernel-only',
    countPalaiaExcerptMergeCheckBuckets: 'kernel-only',
    markPalaiaExcerptMergeChecked: 'kernel-only',
    listTopics: 'kernel-only',
    getTopic: 'kernel-only',
    listTopicMembers: 'kernel-only',
    listMemorableKnowledgeWithEmbeddings: 'kernel-only',
    deleteAllTopics: 'kernel-only',
    createTopic: 'kernel-only',
    listTopicMembershipEdges: 'kernel-only',
    listAllIssues: 'kernel-only',
    listMemoriesForScope: 'kernel-only',
    getMemorableKnowledgeSubgraph: 'kernel-only',
    // Datasets carry their own owner ACL, checked by the kernel's tool.
    ingestDataset: 'kernel-only',
    listDatasets: 'kernel-only',
    countDatasets: 'kernel-only',
    getDataset: 'kernel-only',
    queryDatasetRows: 'kernel-only',
    deleteDataset: 'kernel-only',
  });

type AnyMethod = (...args: unknown[]) => unknown;

/**
 * The bounded `knowledgeGraph@1`. A plain object with the contract's methods
 * only: a method the provider has beyond the contract is not reachable, and
 * an optional one the provider lacks stays absent.
 */
export function boundKnowledgeGraph(
  kg: KnowledgeGraph,
  pluginId: string,
  entitySystems: readonly string[] = [],
): KnowledgeGraph {
  const capability = 'knowledgeGraph';
  const reads = boundedTurnReads(() => kg, pluginId, capability);
  const writes = boundedEntityWrites(kg, pluginId, entitySystems);
  const plans = boundedPlans(kg, pluginId, reads.requireBoundary);
  const target = kg as unknown as Record<string, unknown>;
  const out: Record<string, AnyMethod> = {};
  for (const [method, access] of Object.entries(KG_METHOD_ACCESS) as [string, KgMethodAccess][]) {
    const fn = target[method];
    if (typeof fn !== 'function') continue;
    const call = (fn as AnyMethod).bind(kg);
    switch (access) {
      case 'absent':
        break;
      case 'pass':
        out[method] = call;
        break;
      case 'entity-write':
        out[method] = (writes as unknown as Record<string, AnyMethod>)[method]!;
        break;
      case 'entities':
      case 'turn-read':
        out[method] = (reads as unknown as Record<string, AnyMethod>)[method]!;
        break;
      case 'plan':
        out[method] = plans[method as keyof typeof plans] as unknown as AnyMethod;
        break;
      case 'own-plans':
        // Plans carry no owners: like the node filter and recall, only in
        // `off` / `enforce` (`user`), and only the turn's own conversation.
        out[method] = async (...args) => {
          const bound = reads.requireBoundary(method);
          return bound.kind === 'user' && args[0] === ownPlanScope() ? call(...args) : [];
        };
        break;
      case 'kernel-only':
        out[method] = () =>
          Promise.reject(new GraphServiceRefusedError(pluginId, capability, method, 'kernel-only'));
        break;
    }
  }
  return Object.freeze(out) as unknown as KnowledgeGraph;
}

/**
 * Plan reads and writes by id, held to the turn's own conversation: a plan
 * or step of another scope reads as missing and is never written. Plans
 * carry no owners, so the conversation is the only bound there is (the plan
 * runner touches only its own turn's plans).
 */
function boundedPlans(
  kg: KnowledgeGraph,
  pluginId: string,
  requireBoundary: (method: string) => GraphReadScope,
) {
  const capability = 'knowledgeGraph';
  const outOfScope = (method: string): GraphServiceRefusedError =>
    new GraphServiceRefusedError(pluginId, capability, method, 'out-of-scope');
  const ownScope = (method: string): string => {
    requireBoundary(method);
    const scope = ownPlanScope();
    if (!scope) throw outOfScope(method);
    return scope;
  };
  const ownPlan = async (method: string, planExternalId: string): Promise<GraphNode | null> => {
    const scope = ownScope(method);
    const plan = await kg.getPlan(planExternalId);
    return plan && plan.props['scope'] === scope ? plan : null;
  };
  return {
    async ingestPlan(input: Parameters<KnowledgeGraph['ingestPlan']>[0]) {
      if (input.scope !== ownScope('ingestPlan')) throw outOfScope('ingestPlan');
      return kg.ingestPlan(input);
    },
    async upsertPlanStep(input: Parameters<KnowledgeGraph['upsertPlanStep']>[0]) {
      if (input.scope !== ownScope('upsertPlanStep')) throw outOfScope('upsertPlanStep');
      return kg.upsertPlanStep(input);
    },
    getPlan: (planExternalId: string) => ownPlan('getPlan', planExternalId),
    async getPlanSteps(planExternalId: string): Promise<GraphNode[]> {
      return (await ownPlan('getPlanSteps', planExternalId)) ? kg.getPlanSteps(planExternalId) : [];
    },
    async getPlanStepsForPlans(planExternalIds: string[]): Promise<Map<string, GraphNode[]>> {
      const own: string[] = [];
      for (const id of planExternalIds) if (await ownPlan('getPlanStepsForPlans', id)) own.push(id);
      return own.length > 0 ? kg.getPlanStepsForPlans(own) : new Map();
    },
    async setPlanStepStatus(...args: Parameters<KnowledgeGraph['setPlanStepStatus']>): Promise<void> {
      const scope = ownScope('setPlanStepStatus');
      const plan = (await kg.getNeighbors(args[0])).find((n) => n.type === 'Plan');
      if (plan?.props['scope'] !== scope) throw outOfScope('setPlanStepStatus');
      return kg.setPlanStepStatus(...args);
    },
    async deletePlan(planExternalId: string): ReturnType<KnowledgeGraph['deletePlan']> {
      if (!(await ownPlan('deletePlan', planExternalId))) throw outOfScope('deletePlan');
      return kg.deletePlan(planExternalId);
    },
  };
}

/** The graph scope the turn's plans live under (as the plan runner writes them). */
function ownPlanScope(): string | undefined {
  const ctx = turnContext.current();
  if (!ctx) return undefined;
  const raw = ctx.sessionScope ?? ctx.turnId;
  return raw ? graphScopeFor(ctx.agentSlug, raw) : undefined;
}

// ---------------------------------------------------------------------------
// processMemory@1
// ---------------------------------------------------------------------------


/**
 * The bounded `processMemory@1`: reads see what `query_processes` /
 * `run_stored_process` see in this turn (this agent's processes; none in a
 * context-bound `enforce-strict` / `members` turn). An edit of a process the
 * turn may not read answers like a missing one; a write lands only in this
 * agent's scopes.
 */
export function boundProcessMemory(service: ProcessMemoryService, pluginId: string): ProcessMemoryService {
  const capability = 'processMemory';
  const readFilter = (method: string): ((record: Pick<ProcessRecord, 'scope'>) => boolean) | null => {
    if (!currentBoundary()) throw new GraphServiceRefusedError(pluginId, capability, method, 'no-boundary');
    return currentProcessReadFilter();
  };
  const readableRecord = async (method: string, id: string): Promise<ProcessRecord | null> => {
    const filter = readFilter(method);
    if (!filter) return null;
    const record = await service.get(id);
    return record && filter(record) ? record : null;
  };
  return Object.freeze({
    // A process lands only in this agent's scopes: another agent's
    // `query_processes` and plan reuse would serve it (INV-2).
    async write(input) {
      if (!currentBoundary()) throw new GraphServiceRefusedError(pluginId, capability, 'write', 'no-boundary');
      const prefix = agentScopePrefix(turnContext.current()?.agentSlug ?? 'default');
      if (!scopeBelongsToAgent(input.scope, prefix)) {
        throw new GraphServiceRefusedError(pluginId, capability, 'write', 'out-of-scope');
      }
      return service.write(input);
    },
    async edit(input: EditProcessInput): Promise<EditProcessResult> {
      if (!(await readableRecord('edit', input.id))) return { ok: false, reason: 'not-found' };
      return service.edit(input);
    },
    async query(input: QueryProcessesInput): Promise<readonly ProcessQueryHit[]> {
      const filter = readFilter('query');
      if (!filter) return [];
      const boundary = currentProcessBoundary();
      // The store filters to this agent before `limit` (plugin-api 1.95.0);
      // `filter` re-checks for a provider that ignores the option.
      const hits = await service.query({
        ...input,
        ...(boundary.kind === 'agent' ? { agentScopePrefix: boundary.prefix } : {}),
        ...(shieldActive() ? { excludeUnprotected: true } : {}),
      });
      return hits.filter((h) => filter(h.record));
    },
    get: (id: string) => readableRecord('get', id),
    async history(id: string): Promise<readonly ProcessRecord[]> {
      return (await readableRecord('history', id)) ? service.history(id) : [];
    },
  } satisfies ProcessMemoryService);
}

// ---------------------------------------------------------------------------
// memoryStore@1
// ---------------------------------------------------------------------------

const MEMORIES_ROOT = '/memories';

/**
 * First segments under `/memories` a plugin never reaches through the
 * service: each agent's private root (and every plugin's `ctx.memory` inside
 * it), every plugin's plugin-wide and legacy tree (`agents`,
 * `ctx.memory.pluginWide`), the per-context trees, the session transcripts,
 * the web chat copies and the per-user UI preferences. A plugin reads its
 * own notes through `ctx.memory`.
 */
const PRIVATE_TREES: ReadonlySet<string> = new Set([
  'orchestrators',
  'agents',
  'contexts',
  'sessions',
  'chat-sessions',
  'ui-prefs',
]);

/**
 * A shared tree a plugin may read but not change (ADR-0033: the operator
 * promotion log), and what contains it. The `_*` trees: see {@link writable}.
 */
const READ_ONLY_PREFIXES: readonly string[] = ['/memories/core/audit'];

/** Normalised absolute path; `..`, duplicate and trailing slashes resolved. */
function canonical(path: string): string {
  const normalized = posix.normalize(path.startsWith('/') ? path : `/${path}`);
  return normalized.length > 1 ? normalized.replace(/\/$/, '') : normalized;
}

function underRoot(path: string): boolean {
  return path === MEMORIES_ROOT || path.startsWith(`${MEMORIES_ROOT}/`);
}

function segments(path: string): string[] {
  return path === MEMORIES_ROOT ? [] : path.slice(MEMORIES_ROOT.length + 1).split('/');
}

/**
 * Readable: under `/memories`, outside the private trees. `inTree`: the path
 * lies inside a top-level tree, not at the root, where an agent's notes from
 * before the namespacer may still lie as loose files.
 */
function readable(path: string, inTree: boolean): boolean {
  if (!underRoot(path)) return false;
  const [tree] = segments(path);
  if (tree === undefined) return !inTree;
  // A case-insensitive filesystem store resolves `Orchestrators` to the
  // private tree.
  if (PRIVATE_TREES.has(tree.toLowerCase())) return false;
  return !inTree || segments(path).length >= 2;
}

/**
 * Writable: inside a shared tree, not in or above a read-only tree. The `_*`
 * trees are operator-seeded (`_rules`, `_brand`): read-only for plugins.
 */
function writable(path: string): boolean {
  if (!readable(path, true)) return false;
  if (segments(path)[0]!.startsWith('_')) return false;
  const lower = path.toLowerCase();
  return !READ_ONLY_PREFIXES.some(
    (prefix) => lower === prefix || lower.startsWith(`${prefix}/`) || prefix.startsWith(`${lower}/`),
  );
}

/** A listing entry the plugin may see: a top-level tree, or inside one. */
function listable(entry: MemoryEntry): boolean {
  const path = canonical(entry.virtualPath);
  return segments(path).length === 1 ? entry.isDirectory && readable(path, false) : readable(path, true);
}

/**
 * The bounded `memoryStore@1`: the shared `/memories` trees, without the
 * private ones. A listing drops what it may not show.
 */
export function boundMemoryStore(store: MemoryStore, pluginId: string): MemoryStore {
  type Access = 'read' | 'read-tree' | 'write';
  const check = (raw: string, access: Access): string => {
    const path = canonical(raw);
    const ok = access === 'write' ? writable(path) : readable(path, access === 'read-tree');
    if (!ok) {
      // Names the tree at most, never the path: a file name can carry what
      // the file holds (a chat title, a person).
      const parts = segments(path);
      const tree = underRoot(path) && parts.length >= 2 ? `/memories/${parts[0]!}` : 'this path';
      throw new MemoryPathError(
        `plugin '${pluginId}' may not ${access === 'write' ? 'change' : 'read'} ${tree} through memoryStore@1: ` +
          'agent, context, transcript and chat trees are private, and the _* trees and core/audit are read-only (ADR-0044)',
      );
    }
    return path;
  };
  return Object.freeze({
    async list(virtualPath: string): Promise<MemoryEntry[]> {
      const entries = await store.list(check(virtualPath, 'read'));
      return entries.filter(listable);
    },
    fileExists: async (p: string) => store.fileExists(check(p, 'read-tree')),
    directoryExists: async (p: string) => store.directoryExists(check(p, 'read')),
    readFile: async (p: string) => store.readFile(check(p, 'read-tree')),
    createFile: async (p: string, content: string) => store.createFile(check(p, 'write'), content),
    writeFile: async (p: string, content: string) => store.writeFile(check(p, 'write'), content),
    delete: async (p: string) => store.delete(check(p, 'write')),
    rename: async (from: string, to: string) => store.rename(check(from, 'write'), check(to, 'write')),
  } satisfies MemoryStore);
}

// ---------------------------------------------------------------------------
// topicClustering@1
// ---------------------------------------------------------------------------

/** Every method of the contract; a new one must be added here to exist. */
const TOPIC_CLUSTERING_METHODS: ReadonlyArray<keyof TopicClusteringService> = [
  'list',
  'getWithMembers',
  'recluster',
];

/**
 * The bounded `topicClustering@1`: every method is kernel-only. `list` and
 * `getWithMembers` take the viewer as an argument, so a plugin could name
 * any account; `recluster` deletes and rebuilds every account's topics.
 * The admin topic routes call the raw service.
 */
export function boundTopicClustering(pluginId: string): TopicClusteringService {
  const refuse = (method: string) => (): Promise<never> =>
    Promise.reject(new GraphServiceRefusedError(pluginId, TOPIC_CLUSTERING_SERVICE_NAME, method, 'kernel-only'));
  return Object.freeze(
    Object.fromEntries(TOPIC_CLUSTERING_METHODS.map((m) => [m, refuse(m)])),
  ) as unknown as TopicClusteringService;
}
