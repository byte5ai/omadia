import { createHash } from 'node:crypto';
import type { EntityRef } from './entityRef.js';

/**
 * The knowledge-graph surface the rest of the middleware talks to. Ingests
 * are driven from the session logger on every completed turn; queries feed
 * the dev UI's graph view and (later) an agent-facing tool. The interface
 * is intentionally narrow so an in-memory implementation, a Kùzu-embedded
 * store, or a Neo4j/FalkorDB-backed sidecar can be swapped without touching
 * callers.
 */
export interface KnowledgeGraph {
  ingestTurn(turn: TurnIngest): Promise<TurnIngestResult>;
  /**
   * Upsert a batch of standalone business entities (no Turn relationship).
   * Used by integration plugins to populate built-in or generic entity
   * nodes proactively so `findEntityCapturedTurns` (name
   * match) works even before a user mentions the entity in a chat.
   *
   * Returns the external ids of the rows that were inserted or updated in
   * the store-specific representation. Idempotent per (tenant, externalId).
   */
  ingestEntities(entities: EntityIngest[]): Promise<EntityIngestResult>;
  /**
   * Persist a batch of atomic facts extracted from a Turn. Each fact becomes
   * a `Fact` node with a `DERIVED_FROM` edge to its source turn and optional
   * `MENTIONS` edges to referenced entity nodes. Idempotent
   * by (tenant, factId): re-running the extractor on the same turn doesn't
   * duplicate.
   */
  ingestFacts(facts: FactIngest[]): Promise<FactIngestResult>;
  /**
   * Record the agentic run trace for the turn ingested in {@link ingestTurn}.
   * Writes Run / AgentInvocation / ToolCall nodes + the BELONGS_TO /
   * EXECUTED / INVOKED_* / PRODUCED edges. Safe to call independently of
   * {@link ingestTurn}; missing Turn/Entity nodes are tolerated (edges
   * pointing at non-existent external ids are skipped rather than aborting).
   */
  ingestRun(trace: RunTrace): Promise<RunIngestResult>;
  /**
   * Structured run-subgraph for a single Turn: Run node + AgentInvocations
   * with their ToolCalls + orchestrator-level ToolCalls + produced entities.
   * Returns `null` when no Run has been ingested yet for the given turn.
   */
  getRunForTurn(turnExternalId: string): Promise<RunTraceView | null>;
  /** Returns one snapshot of the session, turns in chronological order. */
  getSession(scope: string): Promise<SessionView | null>;
  /**
   * List sessions. When `userId` is provided, only sessions whose Session node
   * carries that userId are returned — legacy sessions without a userId are
   * excluded. Omit `userId` to see every session (admin view).
   */
  listSessions(filter?: SessionFilter): Promise<SessionSummary[]>;
  /** Graph-walk helper: returns every direct neighbour of a node. */
  getNeighbors(nodeId: string): Promise<GraphNode[]>;
  /** Coarse counts for the UI header / sanity checks. */
  stats(): Promise<GraphStats>;
  /**
   * Full-text search over past Turn nodes. Used by the context retriever to
   * surface prior conversations semantically related to the current user
   * message. Results are ordered by relevance-rank first, recency as a
   * tiebreak. Scope + turn filters let callers exclude the ongoing chat/turn
   * so the model doesn't see its own current prompt as "context".
   */
  searchTurns(opts: SearchTurnsOptions): Promise<TurnSearchHit[]>;
  /**
   * Entity-anchored lookup. Takes a short list of candidate terms from the
   * user message (extracted names, ids) and returns the matching entity
   * nodes with the last few Turns that captured them. Powers the
   * "remembering the customer we discussed yesterday" use case without
   * embeddings.
   */
  findEntityCapturedTurns(
    opts: EntityCapturedTurnsOptions,
  ): Promise<EntityCapturedTurnsHit[]>;
  /**
   * Semantic search over Turn nodes via a pre-computed query embedding.
   * Backends without embedding support return []; the retriever then falls
   * back to `searchTurns` (FTS). Implementations should cap the similarity
   * distance to a reasonable minimum (e.g. cosine similarity ≥ 0.2) so
   * dissimilar turns don't pollute the context.
   */
  searchTurnsByEmbedding(
    opts: SearchTurnsByEmbeddingOptions,
  ): Promise<TurnSearchHit[]>;
  /**
   * Lookup of business entities by model + optional name substring. Used by
   * the sub-agents' `query_graph` tool to resolve stable master data
   * (journals, departments, partners, etc.) without a live source round-trip.
   * Scope-filtering is up to the caller — the graph returns every match.
   */
  findEntities(opts: FindEntitiesOptions): Promise<GraphNode[]>;
  /**
   * Upsert NorthData companies. Idempotent per (tenant, externalId) where
   * externalId is NorthData's permalink fragment (e.g. `/hr/Berlin/HRB/123`).
   * Merges `extras` into `properties` so a later sync can add fields without
   * clobbering earlier ones.
   */
  ingestCompanies(companies: CompanyIngest[]): Promise<CompanyIngestResult>;
  /**
   * Upsert NorthData persons (GFs, shareholders). Same idempotency contract
   * as {@link ingestCompanies}. Only public register metadata — never full
   * birth date or private address.
   */
  ingestPersons(persons: PersonIngest[]): Promise<PersonIngestResult>;
  /**
   * Upsert verflechtungs-edges between Companies / Persons. The three shapes
   * share one batch call so a full NorthData company-details response can be
   * persisted in a single round-trip.
   */
  ingestCompanyRelations(
    relations: CompanyRelationsIngest,
  ): Promise<CompanyRelationsResult>;
  /**
   * Cross-link a NorthData `Company` to a known entity in the integration
   * graph (typically a customer/partner record) via VAT or trade-register
   * match. Writes a single `REFERS_TO` edge — never mutates the integration.
   * Tolerates a missing entity node (returns `{linked:false}`).
   */
  linkCompanyToEntity(
    opts: LinkCompanyToEntityOptions,
  ): Promise<LinkCompanyToEntityResult>;
  /**
   * Upsert one or more `FinancialSnapshot` nodes. Each snapshot is keyed by
   * `(companyExternalId, fiscalYear)` and linked to its Company via a
   * `HAS_FINANCIALS {fiscalYear, consolidated}` edge. Missing parent Company
   * → snapshot skipped (tolerated, counted). Idempotent per key.
   */
  ingestFinancialSnapshots(
    snapshots: FinancialSnapshotIngest[],
  ): Promise<FinancialSnapshotIngestResult>;
}

export interface SessionFilter {
  userId?: string;
}

export type GraphNodeType =
  | 'Session'
  | 'Turn'
  | 'OdooEntity'
  | 'ConfluencePage'
  /** OB-29-2 — generic plugin-namespaced entity. system+model+id live in
   *  `props`; the namespace string is what the plugin declared in its
   *  manifest's `permissions.graph.entity_systems`. */
  | 'PluginEntity'
  | 'User'
  | 'Run'
  | 'AgentInvocation'
  | 'ToolCall'
  | 'Fact'
  | 'Company'
  | 'Person'
  | 'FinancialSnapshot';
export type GraphEdgeType =
  | 'IN_SESSION'
  | 'NEXT_TURN'
  | 'CAPTURED'
  | 'BELONGS_TO'
  | 'EXECUTED'
  | 'INVOKED_AGENT'
  | 'INVOKED_TOOL'
  | 'PRODUCED'
  | 'DERIVED_FROM'
  | 'MENTIONS'
  | 'MANAGES'
  | 'SHAREHOLDER_OF'
  | 'SUCCEEDED_BY'
  | 'REFERS_TO'
  | 'HAS_FINANCIALS';

export type CompanyStatus = 'active' | 'liquidation' | 'terminated';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type FactSeverity = 'info' | 'warning' | 'critical';

// ---------------------------------------------------------------------------
// Palaia-Integration · Phase 1 (OB-70) — additive memory-classification axes.
// All fields are optional on read so consumers that pre-date the uplift keep
// working unchanged. Defaults applied at the storage boundary (DB column
// defaults for Neon, Turn-ingest for the in-memory mirror).
// ---------------------------------------------------------------------------

/** Memory-typing axis: long-term recall vs. how-to vs. open work item. */
export type EntryType = 'memory' | 'process' | 'task';

/**
 * Visibility scope of a memory entry. `'shared:<project>'` is a free-form
 * suffix (no DB CHECK constraint) so per-project shares can scale without
 * a schema migration.
 *
 * NOTE: distinct from `graph_nodes.scope` (the session-scope, e.g. 'demo'),
 * which is unrelated to memory visibility.
 */
export type Visibility = 'private' | 'team' | 'public' | `shared:${string}`;

/** Lifecycle bucket: HOT = active recall, WARM = aging, COLD = archival. */
export type Tier = 'HOT' | 'WARM' | 'COLD';

/** Open / closed state for `entryType === 'task'` rows. */
export type TaskStatus = 'open' | 'done';

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  props: Readonly<Record<string, unknown>>;
  // --- Palaia fields. Optional so legacy callers compile unchanged; the
  //     Neon backend always projects them, the in-memory backend sets
  //     defaults on Turn ingest. Meaningfully populated for `Turn` nodes;
  //     other node types carry the DB defaults but typically aren't
  //     consulted for them.
  entryType?: EntryType;
  visibility?: Visibility;
  tier?: Tier;
  accessedAt?: string | null;
  accessCount?: number;
  decayScore?: number;
  contentHash?: string | null;
  manuallyAuthored?: boolean;
  taskStatus?: TaskStatus | null;
  /** Significance score in [0, 1]; null = not classified yet (Phase 2). */
  significance?: number | null;
}

export interface GraphEdge {
  type: GraphEdgeType;
  from: string;
  to: string;
  props?: Readonly<Record<string, unknown>>;
}

/**
 * One business entity staged into the graph outside a turn context. Mirrors
 * the shape that would otherwise arrive via `EntityRef` on a completed turn,
 * but carries enough metadata to stand on its own — display label + optional
 * extra properties for the UI (e.g. partner email, employee department).
 *
 * `system` is a free-form string namespace identifying the source the entity
 * was ingested from (e.g. an integration plugin's id). Two `system` values
 * are reserved as built-ins that map to first-class GraphNodeTypes used by
 * the kernel's type schema (`'OdooEntity'`, `'ConfluencePage'`); every other
 * `system` value maps to GraphNodeType `'PluginEntity'`. Plugins MUST declare
 * their custom system strings in `permissions.graph.entity_systems` and
 * ingest through `ctx.knowledgeGraph` so the accessor can enforce the
 * namespace.
 */
export interface EntityIngest {
  system: string;
  model: string;
  /** External id in the source system. */
  id: string | number;
  displayName?: string;
  /** Free-form extras stored on the node properties. Keep small — this is
   *  indexed via GIN, so huge blobs hurt. */
  extras?: Record<string, unknown>;
}

export interface EntityIngestResult {
  /** External ids ("<system>:<model>:<id>") in the order they were inserted. */
  entityIds: string[];
  inserted: number;
  updated: number;
}

/**
 * NorthData Company upsert payload. `externalId` must be `register.uniqueKey`
 * from the API response — the only stable identifier NorthData exposes for
 * companies (the internal `id` field is documented as volatile).
 *
 * Optional fields mirror the subset of the NorthData Company definition we
 * flatten into Company-node properties. Fields that only exist as nested
 * structures in the API (relations, capital, full history) are modelled via
 * their own nodes/edges rather than duplicated here.
 */
export interface CompanyIngest {
  externalId: string;
  name: string;
  rawName?: string;
  legalForm?: string;
  registerCourt?: string;
  registerNumber?: string;
  registerCountry?: string;
  status?: CompanyStatus;
  terminated?: boolean;
  address?: string;
  /** Hoisted from `extras.items[id=vatId]`; only set when `extras=true`. */
  vatId?: string;
  proxyPolicy?: string;
  northDataUrl?: string;
  segmentCodes?: Record<string, string[]>;
  /** Derived at ingest. */
  riskLevel?: RiskLevel;
  /** Derived at ingest. */
  riskSignals?: string[];
  isWatched?: boolean;
  /** Extra fields stored on `properties` JSONB (GIN-indexed — keep small). */
  extras?: Record<string, unknown>;
}

export interface CompanyIngestResult {
  /** External ids (`company:<externalId>`) in input order. */
  companyIds: string[];
  inserted: number;
  updated: number;
}

/**
 * NorthData Person upsert payload. `externalId` is a synthetic deterministic
 * hash (see {@link personSyntheticId}) because NorthData's own Person.id is
 * documented as volatile and must not be persisted as an identity key.
 */
export interface PersonIngest {
  /** sha1(lastName|firstName|birthDate|city) — use {@link personSyntheticId}. */
  externalId: string;
  /** Full display name, typically `${title} ${firstName} ${lastName}`. */
  name: string;
  firstName?: string;
  lastName: string;
  /** Public-register birth date (ISO `YYYY-MM-DD`). */
  birthDate?: string;
  city?: string;
  /** The API's volatile internal id, kept only for freshness lookup. */
  internalNorthDataId?: string;
  extras?: Record<string, unknown>;
}

export interface PersonIngestResult {
  personIds: string[];
  inserted: number;
  updated: number;
}

export interface ManagesEdgeIngest {
  personExternalId: string;
  companyExternalId: string;
  role?: string;
  since?: string;
  until?: string;
}

export interface ShareholderEdgeIngest {
  /** Either a Person or a Company node acting as shareholder. */
  holderExternalId: string;
  holderType: 'Person' | 'Company';
  companyExternalId: string;
  sharePercent?: number;
  since?: string;
  until?: string;
}

export interface SucceededByEdgeIngest {
  fromCompanyExternalId: string;
  toCompanyExternalId: string;
  reason?: string;
}

export interface CompanyRelationsIngest {
  manages?: ManagesEdgeIngest[];
  shareholders?: ShareholderEdgeIngest[];
  successions?: SucceededByEdgeIngest[];
}

export interface CompanyRelationsResult {
  manages: number;
  shareholders: number;
  successions: number;
  /** Edges dropped because at least one endpoint was missing. */
  skipped: number;
}

export interface LinkCompanyToEntityOptions {
  companyExternalId: string;
  /** External id in the shape `<system>:<model>:<id>`. Must already exist
   *  — caller looks this up via `findEntities({model, nameContains:…})` or
   *  another identifier match. */
  entityExternalId: string;
}

export interface LinkCompanyToEntityResult {
  linked: boolean;
}

/** One Financial indicator row as it comes out of NorthData. */
export interface FinancialIndicator {
  id: string;
  name?: string;
  value?: number;
  unit?: string;
  estimate?: boolean;
  note?: string;
}

/** Structured annual-financials upsert. */
export interface FinancialSnapshotIngest {
  companyExternalId: string;
  fiscalYear: number;
  /** ISO date the figures were published for. */
  date?: string;
  consolidated?: boolean;
  sourceName?: string;
  items: FinancialIndicator[];
}

export interface FinancialSnapshotIngestResult {
  snapshotIds: string[];
  inserted: number;
  updated: number;
  /** Skipped because the parent Company node didn't exist. */
  skipped: number;
}

/**
 * A single atomic fact extracted from a Turn. Subject-predicate-object triples
 * are the Haiku classifier's output shape — keep them short so they stay
 * composable across sessions. `sourceTurnId` is the external id of the Turn
 * that produced the fact (scheme `turn:<scope>:<time>`); the graph uses it to
 * wire the `DERIVED_FROM` edge.
 */
export interface FactIngest {
  /** Stable deterministic id from `factNodeId(sourceTurnId, subject, predicate, object)`. */
  factId: string;
  sourceTurnId: string;
  subject: string;
  predicate: string;
  object: string;
  /** Haiku-reported confidence in [0, 1]. Lets us filter on recall later. */
  confidence?: number;
  /** Cross-fact severity axis. `critical` ranks insolvency above a name change. */
  severity?: FactSeverity;
  /** External ids of entities this fact references (`<system>:<model>:<id>`). */
  mentionedEntityIds?: string[];
}

export interface FactIngestResult {
  factIds: string[];
  inserted: number;
  updated: number;
}

export interface TurnIngest {
  scope: string;
  /** ISO timestamp at turn completion. */
  time: string;
  userMessage: string;
  assistantAnswer: string;
  toolCalls?: number;
  iterations?: number;
  entityRefs: EntityRef[];
  /**
   * Stable identifier of the human behind the turn (Teams AAD object id,
   * HTTP `x-user-id` header, …). Stored on the Session + Turn nodes so the
   * dev UI and later cross-session recall can filter to one user's history.
   * Optional — legacy ingests without identity stay NULL-scoped.
   */
  userId?: string;
  /**
   * Palaia (OB-71) — optional Capture-Pipeline classification result. When
   * the orchestrator-extras `CaptureFilter` runs ahead of the write, it
   * routes its `CaptureFilterDecision` through these fields. Backends MUST
   * fall through to the schema defaults (`memory`/`team`/`null`) when
   * undefined so legacy callers stay unchanged.
   */
  entryType?: EntryType;
  visibility?: Visibility;
  significance?: number | null;
}

export interface TurnIngestResult {
  sessionId: string;
  turnId: string;
  entityNodeIds: string[];
}

// ---------------------------------------------------------------------------
// Palaia-Integration (OB-81) · Capture-Disclosure
//
// Slim, channel-agnostic projection of the Phase-2 (OB-71) `CaptureFilter`
// decision plus the resulting graph-write outcome. Surfaced to chat clients
// (Teams Adaptive Card, inline-chat React UI) so users can audit what the
// orchestrator actually persisted into Palaia / the knowledge graph for any
// given turn.
//
// Track-A introduces only the wire shape: every field is optional, so a turn
// without an active capture-pipeline simply omits the object. Track-B (after
// OB-71 lands) wires the real Decision through the orchestrator response.
// ---------------------------------------------------------------------------

/**
 * What ended up in the knowledge graph for a single turn — including
 * deterministic transforms (privacy-strip, hint-parse) that ran even when
 * the capture-pipeline was effectively in pass-through mode.
 *
 * Fields are intentionally projection-friendly: counts instead of contents,
 * enums instead of raw text, no PII. Connectors render this object as-is
 * without further interpretation.
 */
export interface CaptureDisclosure {
  /** Was the turn persisted to the knowledge graph at all? */
  persisted: boolean;
  /**
   * Human-readable reason markers from the filter (`"privacy-strip:1"`,
   * `"hint-override:type=process"`, `"scorer-skipped:level=minimal"`,
   * `"dropped:significance<threshold"`). Free-form, observability only.
   */
  reasons: readonly string[];
  /**
   * Final entry-type written to the Turn node. Mirrors the
   * `entry_type` column on `graph_nodes` introduced in migration 0007.
   * Null when the turn was not persisted.
   */
  entryType: 'memory' | 'process' | 'task' | null;
  /**
   * Final visibility/scope. Free-form to match the `scope` column
   * (`'private' | 'team' | 'public' | 'shared:<project>'`). Null when the
   * turn was not persisted.
   */
  visibility: string | null;
  /**
   * Significance score in [0, 1] when the LLM scorer ran successfully.
   * Null at `capture_level=minimal/off`, on scorer timeout, or when a
   * capture-hint with `force="true"` short-circuited scoring.
   */
  significance: number | null;
  /** Did the embedding sidecar compute and write a vector for this turn? */
  embedded: boolean;
  /** Number of `<private>...</private>` blocks removed before persistence. */
  privacyBlocksStripped: number;
  /** Number of `<palaia-hint .../>` tags consumed. */
  hintTagsProcessed: number;
  /**
   * Knowledge-graph identifiers touched by this turn. Optional — exposed
   * mainly for the inline-chat dev surface (clickable graph deep-links).
   * Connectors that cannot link out (Teams: no graph UI) MAY omit display.
   */
  graphRefs?: {
    sessionId: string;
    turnId: string;
    entityNodeIds: readonly string[];
  };
}

// ---------------------------------------------------------------------------
// Agentic run-graph (Track B1)
// ---------------------------------------------------------------------------

export type RunStatus = 'success' | 'error';

export interface RunToolCall {
  /** Unique id within the turn — orchestrator tool_use id or nanoid from the
   * sub-agent. Becomes part of the ToolCall node's external id. */
  callId: string;
  toolName: string;
  durationMs: number;
  isError: boolean;
  /** Orchestrator-level tool: 'orchestrator'. Sub-agent tool: the agent name. */
  agentContext: string;
  /** External ids of entities produced by this call (one per integration,
   *  in the shape `<system>://…`). Wired by the entity-ref bus, same source
   *  as TurnIngest.entityRefs. */
  producedEntityIds?: string[];
}

export interface RunAgentInvocation {
  /** 0-based index across the Run — ties back the INVOKED_AGENT edge ordering. */
  index: number;
  agentName: string;
  durationMs: number;
  subIterations: number;
  status: RunStatus;
  toolCalls: RunToolCall[];
}

export interface RunTrace {
  /** Must match the turn-id returned by a matching ingestTurn call. */
  turnId: string;
  scope: string;
  userId?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: RunStatus;
  iterations: number;
  /** Top-level tool calls the orchestrator issued directly (memory, graph, …). */
  orchestratorToolCalls: RunToolCall[];
  /** One entry per sub-agent invocation in invocation-order. */
  agentInvocations: RunAgentInvocation[];
  error?: string;
}

export interface RunIngestResult {
  runId: string;
  agentInvocationIds: string[];
  toolCallIds: string[];
  userNodeId?: string;
}

export interface RunToolCallView {
  node: GraphNode;
  producedEntities: GraphNode[];
}

export interface RunAgentInvocationView {
  node: GraphNode;
  toolCalls: RunToolCallView[];
}

export interface RunTraceView {
  turn: GraphNode;
  run: GraphNode;
  user?: GraphNode;
  orchestratorToolCalls: RunToolCallView[];
  agentInvocations: RunAgentInvocationView[];
}

export interface SessionSummary {
  id: string;
  scope: string;
  turnCount: number;
  firstAt: string;
  lastAt: string;
}

export interface SessionView {
  session: GraphNode;
  turns: Array<{
    turn: GraphNode;
    entities: GraphNode[];
  }>;
}

export interface GraphStats {
  nodes: number;
  edges: number;
  byNodeType: Record<GraphNodeType, number>;
  byEdgeType: Record<GraphEdgeType, number>;
}

export interface SearchTurnsOptions {
  /** Free-text query. Empty string / whitespace → returns []. */
  query: string;
  /** Restrict to turns belonging to this user. Recommended for production. */
  userId?: string;
  /** Drop hits from this session scope (usually the ongoing chat). */
  excludeScope?: string;
  /** Drop specific Turn external ids (usually the current turn). */
  excludeTurnIds?: readonly string[];
  /** Hard cap on returned hits. Defaults to 5. */
  limit?: number;
}

export interface TurnSearchHit {
  turnId: string;
  scope: string;
  time: string;
  userMessage: string;
  assistantAnswer: string;
  /** Normalised relevance score in [0, 1]; higher is better. */
  rank: number;
  // Palaia-Phase-5 (OB-74) — additive Felder für den Token-Budget-Assembler.
  // Optional + backwards-kompat: backends ohne Palaia-Schema lassen sie weg.
  /** Memory-Klassifikation des Turns. Optional — undefined = unbekannt. */
  entryType?: EntryType;
  /** True wenn der Turn manuell autorisiert wurde (Operator/Admin-Capture).
   *  Der Assembler wendet einen Score-Boost auf TRUE-Hits an. */
  manuallyAuthored?: boolean;
}

export interface SearchTurnsByEmbeddingOptions {
  /** Query vector, same dim as the column (currently 768 for nomic-embed-text). */
  queryEmbedding: readonly number[];
  /** Restrict to turns belonging to this user. */
  userId?: string;
  /** Drop hits from this session scope. */
  excludeScope?: string;
  /** Drop specific Turn external ids. */
  excludeTurnIds?: readonly string[];
  /** Hard cap on returned hits. Defaults to 5. */
  limit?: number;
  /** Drop matches with cosine similarity below this threshold. Default 0.3. */
  minSimilarity?: number;

  // ---------------------------------------------------------------------------
  // Palaia Phase 3 (OB-72) — Hybrid-Retrieval. All five fields are optional;
  // omitting them keeps the pure-cosine behaviour callers had before. When
  // `ftsQuery` is provided the backend switches to a hybrid score:
  //   `0.4 · normalized_bm25 + 0.6 · cosine_similarity`
  //   `× type_weight(entry_type) × exp(-recallRecencyBoost · age_days)`
  // ---------------------------------------------------------------------------

  /**
   * Optional FTS query string. When provided, hybrid scoring kicks in:
   * `0.4 · normalized_bm25 + 0.6 · cosine_similarity`. When absent or empty,
   * behaviour matches the pre-OB-72 pure-cosine path (backwards-compat).
   */
  ftsQuery?: string;

  /**
   * Minimum hybrid score in [0, 1]. Hits below are dropped post-ranking.
   * Defaults to 0 (no threshold). Distinct from `minSimilarity`, which only
   * filters on the cosine component.
   */
  recallMinScore?: number;

  /**
   * Decay rate for recency boost: hits are multiplied by
   * `exp(-recallRecencyBoost · age_days)`. Default 0.05 (≈ half-life of
   * 14 days). Set to 0 to disable recency weighting.
   */
  recallRecencyBoost?: number;

  /**
   * Type-weight multipliers per entry_type. Default neutral
   * `{ memory: 1.0, process: 1.0, task: 1.0 }`. Operators can up-weight
   * `process` (workflow knowledge) or `task` (open work) once benchmarks
   * show it helps. Multiplicative on the raw score.
   */
  typeWeights?: Partial<Record<EntryType, number>>;

  /**
   * Hard-filter on entry_type. Defaults to all types. Applied as a
   * `WHERE` clause before scoring (no wasted cosine math on excluded rows).
   */
  entryTypes?: readonly EntryType[];

  /**
   * Include `tier='COLD'` rows. Default false (HOT + WARM only). Phase 4
   * (OB-73) starts populating COLD; until then the filter is effectively
   * a no-op but the convention is in place.
   */
  includeCold?: boolean;
}

export interface EntityCapturedTurnsOptions {
  /** Candidate terms extracted from the current user message. */
  terms: readonly string[];
  /** Restrict the returned turns to this user. */
  userId?: string;
  /** Drop capturing turns from this scope. */
  excludeScope?: string;
  /** Max turns to return per matched entity. Default 2. */
  perEntityLimit?: number;
  /** Hard cap on distinct entities to return. Default 5. */
  entityLimit?: number;
}

export interface FindEntitiesOptions {
  /** Source-system model name, e.g. `res.partner`, `hr.department`. */
  model: string;
  /** Optional case-insensitive substring match against `displayName` or `id`. */
  nameContains?: string;
  /** Hard cap. Default 25, max 200. */
  limit?: number;
}

export interface EntityCapturedTurnsHit {
  entity: GraphNode;
  turns: Array<{
    turnId: string;
    scope: string;
    time: string;
    userMessage: string;
    assistantAnswer: string;
  }>;
}

// ---------------------------------------------------------------------------
// Shared id helpers. Keeping them in one place means every implementation
// agrees on node identity — critical once we add a second backing store.
// ---------------------------------------------------------------------------

export function sessionNodeId(scope: string): string {
  return `session:${scope}`;
}

export function turnNodeId(scope: string, time: string): string {
  return `turn:${scope}:${time}`;
}

export function entityNodeId(ref: EntityRef): string {
  return `${ref.system}:${ref.model}:${String(ref.id)}`;
}

/** Stable external id for a NorthData Company node. */
export function companyNodeId(externalId: string): string {
  return `company:${externalId}`;
}

/** Stable external id for a NorthData Person node. */
export function personNodeId(externalId: string): string {
  return `person:${externalId}`;
}

/**
 * Deterministic synthetic id for a natural person. Used instead of
 * NorthData's `Person.id` because the API marks that id as volatile. Inputs
 * are normalised (trim + lowercase) so trivial formatting differences across
 * syncs collapse into the same node.
 *
 * Collision note: two distinct people with the same `(lastName, firstName,
 * birthDate, city)` quadruple are indistinguishable here. Without birthDate,
 * the chance is real — callers should prefer sources where birthDate is
 * populated. Caller must pass at least `lastName`; the other components
 * default to empty strings so a hash is always computable.
 */
export function personSyntheticId(parts: {
  lastName: string;
  firstName?: string;
  birthDate?: string;
  city?: string;
}): string {
  const norm = (s?: string): string => (s ?? '').trim().toLowerCase();
  const joined = [
    norm(parts.lastName),
    norm(parts.firstName),
    norm(parts.birthDate),
    norm(parts.city),
  ].join('|');
  return createHash('sha1').update(joined).digest('hex').slice(0, 16);
}

/** External id for a `FinancialSnapshot` node keyed by (company, fiscalYear). */
export function financialSnapshotNodeId(
  companyExternalId: string,
  fiscalYear: number,
): string {
  return `finsnap:${companyExternalId}:${String(fiscalYear)}`;
}

export function userNodeId(userId: string): string {
  return `user:${userId}`;
}

export function runNodeId(turnExternalId: string): string {
  return `run:${turnExternalId}`;
}

export function agentInvocationNodeId(
  turnExternalId: string,
  agentName: string,
  index: number,
): string {
  return `agent:${turnExternalId}:${agentName}:${index}`;
}

export function toolCallNodeId(turnExternalId: string, callId: string): string {
  return `tool:${turnExternalId}:${callId}`;
}

/**
 * Deterministic fact id: the same (turn, subject, predicate, object) always
 * maps to the same node — makes the extractor idempotent on retry. Colons
 * are forbidden in the source fields (extractor normalises) to keep the
 * overall id parseable.
 */
export function factNodeId(
  sourceTurnId: string,
  subject: string,
  predicate: string,
  object: string,
): string {
  const clean = (s: string): string =>
    s.toLowerCase().replace(/[:\s]+/g, '_').slice(0, 80);
  return `fact:${sourceTurnId}:${clean(subject)}:${clean(predicate)}:${clean(object)}`;
}
