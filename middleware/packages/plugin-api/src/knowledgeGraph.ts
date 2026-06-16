import type { EntityRef } from './entityRef.js';
import type {
  CreateInconsistencyInput,
  InconsistencyNode,
  InconsistencyResolution,
  InconsistencyStatus,
  ListInconsistenciesOptions,
} from './inconsistency.js';
import type {
  CreateMergeCandidateInput,
  ListMergeCandidatesOptions,
  MergeCandidateNode,
  MergeCandidateResolution,
} from './mergeCandidate.js';
import type { TopicNamingSource, TopicNode } from './topic.js';
import type {
  CreateExcerptMergeCandidateInput,
  ExcerptMergeCandidateNode,
  ExcerptMergeResolution,
  ListExcerptMergeCandidatesOptions,
} from './excerptMerge.js';

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
   * Used by the Odoo / Confluence sync to populate `OdooEntity` and
   * `ConfluencePage` nodes proactively so `findEntityCapturedTurns` (name
   * match) works even before a user mentions the entity in a chat.
   *
   * Returns the external ids of the rows that were inserted or updated in
   * the store-specific representation. Idempotent per (tenant, externalId).
   */
  ingestEntities(entities: EntityIngest[]): Promise<EntityIngestResult>;
  /**
   * Persist a batch of atomic facts extracted from a Turn. Each fact becomes
   * a `Fact` node with a `DERIVED_FROM` edge to its source turn and optional
   * `MENTIONS` edges to any referenced OdooEntity / ConfluencePage. Idempotent
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
   * #133 (plan-as-data) — persist a per-turn Plan node. Optionally links the
   * Plan to its Turn via a `PLAN_OF` edge when `turnExternalId` resolves to an
   * existing Turn. Idempotent by (tenant, `plan:<planId>`).
   */
  ingestPlan(input: PlanIngest): Promise<PlanIngestResult>;
  /**
   * #133 — upsert a PlanStep node under a Plan. Writes a `STEP_OF` edge to the
   * Plan (which must already exist) and `DEPENDS_ON` edges to any prerequisite
   * steps that already exist. Idempotent by (tenant, `planstep:<stepId>`):
   * re-calling refines the step's properties (e.g. status). Step status lives
   * in `props.status` (pending|in_progress|done|failed|skipped).
   */
  upsertPlanStep(input: PlanStepIngest): Promise<PlanStepIngestResult>;
  /** #133 — read a Plan node by its external id (`plan:<planId>`). */
  getPlan(planExternalId: string): Promise<GraphNode | null>;
  /** #133 — read a Plan's steps, ordered by `props.order` ascending. */
  getPlanSteps(planExternalId: string): Promise<GraphNode[]>;
  /**
   * #133 — batched {@link getPlanSteps}: load the steps for many plans in a
   * single round-trip. Returns a Map keyed by plan external id; an unknown id
   * or a step-less plan maps to `[]`. Each list is ordered by `props.order`
   * ascending, identically to {@link getPlanSteps}. Collapses the per-plan N+1
   * on the plan-recall (context build) and graph-overlay hot paths.
   */
  getPlanStepsForPlans(
    planExternalIds: string[],
  ): Promise<Map<string, GraphNode[]>>;
  /**
   * #133 (E3) — patch a PlanStep's status (and optional resultSummary) in
   * place, leaving its other props intact. No-op when the step id is unknown.
   */
  setPlanStepStatus(
    stepExternalId: string,
    status: PlanStepStatus,
    opts?: { resultSummary?: string },
  ): Promise<void>;
  /**
   * #133 (E6/E7) — list `Plan` nodes for a scope, most-recent first. Powers
   * the graph-view plan overlay and the verifier-replan lookup (a verifier
   * retry is a fresh turn, so the prior turn's plan is found by scope, not id).
   */
  listPlansForScope(scope: string): Promise<GraphNode[]>;
  /**
   * #237 (plan GC) — hard-delete a Plan node, all its PlanStep nodes, and every
   * edge touching them (`STEP_OF` / `DEPENDS_ON` / `PLAN_OF`). Idempotent:
   * deleting a missing or non-Plan node is a no-op (`deleted: false`). Used by
   * the plan-runner to garbage-collect prior semantic-duplicate plans for a
   * scope, keeping only the latest. Callers MUST NOT pass an in-flight plan.
   */
  deletePlan(planExternalId: string): Promise<PlanDeleteResult>;
  /**
   * Cross-session plan recall — list `Plan` nodes tenant-wide (the team
   * scope), optionally narrowed to a single `userId`, most-recent first
   * (by `props.createdAt`). When `openOnly` is set, only plans that still
   * have at least one `pending`/`in_progress` step are returned — i.e.
   * unfinished work worth resuming. Powers the per-turn KG-recall probe;
   * `listPlansForScope` is the single-session variant. `limit` is clamped
   * to [1, 50] and defaults to 5.
   */
  listRecentPlans(opts: {
    userId?: string;
    limit?: number;
    openOnly?: boolean;
    /**
     * Restrict recall to plans whose `scope` begins with this agent prefix
     * (`<agentSlug>::`). Omit for the legacy global view. See
     * {@link agentScopePrefix} — per-orchestrator KG isolation.
     */
    agentScopePrefix?: string;
  }): Promise<GraphNode[]>;
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
   * (journals, departments, partners, etc.) without round-tripping to Odoo.
   * Scope-filtering is up to the caller — the graph returns every match.
   */
  findEntities(opts: FindEntitiesOptions): Promise<GraphNode[]>;
  /**
   * Slice 1b — resolve an incoming channel-bound identity to a User-Cluster.
   * Creates the `ChannelIdentity` node if missing and either joins it to an
   * existing User-Cluster (when `email` + `emailVerified=true` matches another
   * ChannelIdentity in the same tenant) or spins up a fresh 1:1 cluster.
   *
   * Idempotent: re-calling with the same `(channelKind, channelUserId)` pair
   * returns the same `(channelIdentityNodeId, omadiaUserId)` and does NOT
   * create duplicate edges.
   *
   * Tenant-strict: cross-tenant email matches are NEVER merged — each
   * tenant gets its own clusters even for the same human.
   */
  resolveOrCreateChannelIdentity(
    ingest: ChannelIdentityIngest,
  ): Promise<ResolveOrCreateChannelIdentityResult>;
  /**
   * Slice 2 — create a MemorableKnowledge node + its INVOLVED / REQUIRES
   * / DERIVED_FROM edges in one transaction. Missing endpoints
   * (User-Cluster, Entity, Turn) are silently skipped + counted in
   * `skipped*` so the call doesn't abort on a single stale id. Returns
   * the new MK external_id (`mk:<uuid>`).
   */
  createMemorableKnowledge(
    input: MemorableKnowledgeIngest,
  ): Promise<MemorableKnowledgeIngestResult>;
  /**
   * Slice 2 / 3 — read a MemorableKnowledge node by external_id. When
   * `viewerOmadiaUserId` is provided, the result is gated by the
   * Slice 3 ACL: the viewer must be in `props.acl_owners` or `null`
   * is returned. Pass `undefined` to bypass the ACL gate (internal /
   * admin paths only).
   */
  getMemorableKnowledge(
    memorableKnowledgeNodeId: string,
    viewerOmadiaUserId?: string,
  ): Promise<GraphNode | null>;
  /**
   * Slice 2 / 3 — list MemorableKnowledge nodes the given User is
   * INVOLVED in. Slice 3 adds an additional ACL gate: the caller is
   * implicitly the viewer (same `omadiaUserId`) and must be in each
   * MK's `acl_owners` array; rows that fail the check are dropped.
   * MKs with empty `acl_owners` are invisible to everyone (admin-only,
   * see Decision-Lock L_s3.8).
   */
  listMemorableKnowledgeFor(
    omadiaUserId: string,
    opts?: ListMemorableKnowledgeOptions,
  ): Promise<GraphNode[]>;
  /**
   * Slice 3 — add a cluster-root user to a MemorableKnowledge's
   * `acl_owners`. The actor must already be in `acl_owners`. Returns
   * the new owner list. No-op (idempotent) if the user is already an
   * owner; still writes an audit row.
   */
  addOwner(
    memorableKnowledgeNodeId: string,
    omadiaUserIdToAdd: string,
    actor: AclMutationOptions,
  ): Promise<string[]>;
  /**
   * Slice 3 — remove a cluster-root user from `acl_owners`. The actor
   * must be in `acl_owners`. Removing the last owner throws
   * `cannot_remove_last_owner` — use `deleteMemory` for explicit
   * teardown.
   */
  removeOwner(
    memorableKnowledgeNodeId: string,
    omadiaUserIdToRemove: string,
    actor: AclMutationOptions,
  ): Promise<string[]>;
  /**
   * Slice 3 — hard-delete a MemorableKnowledge (and its edges via
   * cascade). The actor must be in `acl_owners`. The audit row
   * survives the delete (no FK on `memory_external_id`).
   */
  deleteMemory(
    memorableKnowledgeNodeId: string,
    actor: AclMutationOptions,
  ): Promise<void>;
  /**
   * Danger-Zone purge — count the MemorableKnowledge nodes that
   * {@link purgeMemorableKnowledge} WOULD delete for the same filter.
   * Read-only; used by the admin dry-run preview. Never throws on an
   * empty match — returns `{ deletedNodes: 0 }`-shaped `{ count: 0 }`.
   */
  countMemorableKnowledge(
    filter: MemorableKnowledgePurgeFilter,
  ): Promise<{ count: number }>;
  /**
   * Danger-Zone purge — hard-delete every MemorableKnowledge node
   * matching `filter` (and its incident edges) in ONE transaction.
   *
   *   - No filter beyond `tenantId` ⇒ ALL MemorableKnowledge for the
   *     tenant.
   *   - `originAgent` matches the `properties->>'origin_agent'` prop.
   *   - `aclOwner` matches membership in `properties->'acl_owners'`.
   *
   * Only `type = 'MemorableKnowledge'` rows are removed — other node
   * types are never touched. Attached `PalaiaExcerpt` nodes are cascaded
   * (mirrors {@link deleteMemory}). Unlike `deleteMemory`, this is an
   * operator-level bulk action: it does NOT enforce per-MK ownership and
   * does NOT write per-MK ACL audit rows (the admin layer writes a single
   * `memory_purge_audit` row for the whole operation).
   */
  purgeMemorableKnowledge(
    filter: MemorableKnowledgePurgeFilter,
  ): Promise<{ deletedNodes: number }>;
  /**
   * Slice 3 — read the ACL audit-log for a single MemorableKnowledge.
   * Returns newest-first. Survives delete of the MK.
   */
  listMemoryAclAudit(
    memorableKnowledgeNodeId: string,
    opts?: { limit?: number },
  ): Promise<AclAuditEntry[]>;
  /**
   * Slice 5 — partial content-update on a MemorableKnowledge. Only the
   * fields present in `patch` are changed; passing `rationale: null`
   * explicitly removes the rationale property. The actor must be in
   * `acl_owners`. Writes an `'edit'` audit row (beforeOwners and
   * afterOwners identical — content-edits don't affect ownership but
   * still belong on the trail). Returns the updated node.
   */
  updateMemorableKnowledge(
    memorableKnowledgeNodeId: string,
    patch: MemorableKnowledgeUpdate,
    actor: AclMutationOptions,
  ): Promise<GraphNode>;
  /**
   * Slice 6.5 — list all Palaia-Excerpt nodes attached to a
   * MemorableKnowledge, ordered by `position` ascending. Returns an
   * empty array when the MK has no excerpts (legacy MKs from before
   * Slice 6.5, or post-promotion where the extractor returned none).
   * Does NOT enforce ACL — callers are expected to gate via
   * `getMemorableKnowledge(id, viewer)` first.
   */
  listExcerptsForMemory(
    memorableKnowledgeNodeId: string,
  ): Promise<PalaiaExcerptNode[]>;
  /**
   * Slice 6.5 — partial update on a single Palaia-Excerpt identified by
   * its parent MK + position. The actor must be in the MK's
   * `acl_owners`. Writes an `'edit_excerpt'` audit row on the parent
   * MK (beforeOwners and afterOwners identical — content-edits don't
   * affect ownership). Empty patch throws `empty_patch`; missing
   * excerpt throws `excerpt_not_found`.
   */
  updateExcerpt(
    memorableKnowledgeNodeId: string,
    position: number,
    patch: PalaiaExcerptUpdate,
    actor: AclMutationOptions,
  ): Promise<PalaiaExcerptNode>;
  /**
   * Slice 12 — hard-delete one PalaiaExcerpt of the given parent MK
   * + position. Emits a `'delete_excerpt'` audit row on the parent
   * MK. Actor must be in the parent MK's `acl_owners`. Leaves the
   * remaining excerpts' positions untouched (sparse position array
   * is allowed; the position-CHECK in migration 0018 only enforces
   * the [0, 4] range, not density). Throws `excerpt_not_found` when
   * no excerpt exists at the given position.
   */
  deleteExcerpt(
    memorableKnowledgeNodeId: string,
    position: number,
    actor: AclMutationOptions,
  ): Promise<void>;
  /**
   * Slice 7 — semantic search over MemorableKnowledge nodes. Cosine
   * similarity on the `embedding` column (Slice-7 backfill writes the
   * `summary + rationale` joint embedding). ACL-gated via
   * `acl_owners @> [viewerOmadiaUserId]` — non-bypassable, no admin
   * mode. Empty query embedding short-circuits to `[]`.
   */
  searchMemorableKnowledgeByEmbedding(
    opts: MemorableKnowledgeSearchOptions,
  ): Promise<MemorableKnowledgeHit[]>;
  /**
   * Slice 7 — semantic search over PalaiaExcerpt nodes. ACL-gated
   * indirectly: each excerpt is JOINed back to its parent
   * MemorableKnowledge via `EXCERPT_OF`, then the parent's
   * `acl_owners` is checked against the viewer. Returns hits with
   * `parentMkId` so callers can render the excerpt in context of its
   * curated memory.
   */
  searchExcerptsByEmbedding(
    opts: ExcerptSearchOptions,
  ): Promise<PalaiaExcerptHit[]>;
  /**
   * Slice 9 — list inconsistency markers visible to the viewer.
   * ACL gate: viewer must own at least one of the two conflicting
   * MKs (union, not intersection — single-owner pairs would
   * otherwise be invisible to anyone). Filtered by status when
   * provided; default lists all.
   */
  listInconsistencies(
    opts: ListInconsistenciesOptions,
  ): Promise<InconsistencyNode[]>;
  /**
   * Slice 9 — read a single Inconsistency. Returns null when the
   * viewer doesn't own at least one of the conflicting MKs (404
   * doesn't leak existence to non-owners).
   */
  getInconsistency(
    inconsistencyExternalId: string,
    viewerOmadiaUserId: string,
  ): Promise<InconsistencyNode | null>;
  /**
   * Slice 9 — persist a new Inconsistency between two MKs. Idempotent:
   * returns null when an Inconsistency between the same two MKs
   * (regardless of order) already exists, even if it's already
   * resolved or dismissed (operator already saw it; don't re-flag).
   */
  createInconsistency(
    input: CreateInconsistencyInput,
  ): Promise<InconsistencyNode | null>;
  /**
   * Slice 9 — operator resolves an open Inconsistency. The actor
   * must own at least one of the two conflicting MKs. Side-effects
   * depend on `resolution`:
   *   - `a_wins`  → deletes mkB via `deleteMemory(mkB, actor)`
   *   - `b_wins`  → deletes mkA via `deleteMemory(mkA, actor)`
   *   - `both`    → no MK changes; conflict marked resolved
   *   - `dismiss` → no MK changes; conflict marked dismissed
   * Throws `inconsistency_not_found`, `not_an_owner`, or
   * `already_resolved` accordingly.
   */
  resolveInconsistency(
    inconsistencyExternalId: string,
    resolution: InconsistencyResolution,
    actor: AclMutationOptions,
  ): Promise<InconsistencyNode>;
  /**
   * Slice 9.5 — list `MemorableKnowledge` external_ids that still need a
   * bulk inconsistency-check pass: embedding column populated AND no
   * `last_inconsistency_check_at` marker on the row. Ordered by
   * `created_at` ascending (oldest first — most likely source of
   * historical conflicts that predate Slice 9). Clamped to [1, 200].
   * Returns external_ids (`mk:<uuid>`), not internal uuids, so callers
   * can feed them straight into `inconsistencyDetector.detectFor()`.
   */
  listMemorableKnowledgeIdsForBulkInconsistencyCheck(opts: {
    limit: number;
  }): Promise<string[]>;
  /**
   * Slice 9.5 — preview-stats for the bulk inconsistency-detect panel.
   * `unchecked` = candidates the next run would process. Tenant-scoped.
   */
  countMemorableKnowledgeInconsistencyCheckBuckets(): Promise<{
    unchecked: number;
    alreadyChecked: number;
    withoutEmbedding: number;
  }>;
  /**
   * Slice 9.5 — set the `last_inconsistency_check_at` marker on an MK to
   * `now()`. Called by `inconsistencyDetector.detectFor()` at the end
   * of every successful run (whether 0 or N Inconsistencies were
   * created) so the bulk-job dedupes correctly. Idempotent: re-writing
   * the marker just refreshes the timestamp.
   */
  markMemorableKnowledgeInconsistencyChecked(
    memorableKnowledgeNodeId: string,
  ): Promise<void>;
  /**
   * Slice 10 — list near-duplicate-candidate markers visible to the
   * viewer. ACL gate identical to {@link listInconsistencies}: viewer
   * must own at least one of the two near-duplicate MKs. Filtered by
   * status when provided.
   */
  listMergeCandidates(
    opts: ListMergeCandidatesOptions,
  ): Promise<MergeCandidateNode[]>;
  /**
   * Slice 10 — read a single MergeCandidate. Returns null when the
   * viewer doesn't own at least one of the near-duplicate MKs.
   */
  getMergeCandidate(
    mergeCandidateExternalId: string,
    viewerOmadiaUserId: string,
  ): Promise<MergeCandidateNode | null>;
  /**
   * Slice 10 — persist a near-duplicate marker between two MKs.
   * Idempotent: returns null when a MergeCandidate between the same
   * two MKs (regardless of order, regardless of status) already
   * exists — operator already saw it. Returns null also when one of
   * the MKs is missing (race with deleteMemory). The MK pair is
   * sorted ascending on persist so dedupe-checks are
   * direction-independent.
   */
  createMergeCandidate(
    input: CreateMergeCandidateInput,
  ): Promise<MergeCandidateNode | null>;
  /**
   * Slice 10 — operator resolves an open MergeCandidate. The actor
   * must own at least one of the two near-duplicate MKs. Side-effects
   * depend on `resolution`:
   *   - `keep_a`         → deletes mkB via `deleteMemory(mkB, actor)`
   *   - `keep_b`         → deletes mkA via `deleteMemory(mkA, actor)`
   *   - `not_duplicate`  → no MK changes; candidate marked dismissed
   * Throws `merge_candidate_not_found`, `not_an_owner`, or
   * `already_resolved` accordingly.
   */
  resolveMergeCandidate(
    mergeCandidateExternalId: string,
    resolution: MergeCandidateResolution,
    actor: AclMutationOptions,
  ): Promise<MergeCandidateNode>;
  /**
   * Slice 10 — list `MemorableKnowledge` external_ids still needing a
   * bulk merge-detect pass: embedding column populated AND no
   * `last_merge_check_at` marker. Ordered created_at ascending,
   * clamped to [1, 500]. Mirrors
   * {@link listMemorableKnowledgeIdsForBulkInconsistencyCheck} but
   * tracks a separate marker so the two bulk passes are independent.
   */
  listMemorableKnowledgeIdsForBulkMergeCheck(opts: {
    limit: number;
  }): Promise<string[]>;
  /**
   * Slice 10 — preview-stats for the bulk merge-detect panel.
   * Mirrors {@link countMemorableKnowledgeInconsistencyCheckBuckets}
   * but reads the `last_merge_check_at` marker.
   */
  countMemorableKnowledgeMergeCheckBuckets(): Promise<{
    unchecked: number;
    alreadyChecked: number;
    withoutEmbedding: number;
  }>;
  /**
   * Slice 10 — set the `last_merge_check_at` marker on an MK to
   * `now()`. Called by the merge-detector at the end of every
   * successful run. Idempotent.
   */
  markMemorableKnowledgeMergeChecked(
    memorableKnowledgeNodeId: string,
  ): Promise<void>;
  /**
   * Slice 12 — list near-duplicate Excerpt-Candidate markers visible
   * to the viewer. ACL gate: viewer must own at least one of the two
   * parent MKs of the excerpts. Mirrors `listMergeCandidates`.
   */
  listExcerptMergeCandidates(
    opts: ListExcerptMergeCandidatesOptions,
  ): Promise<ExcerptMergeCandidateNode[]>;
  /**
   * Slice 12 — read a single ExcerptMergeCandidate. Returns null
   * when the viewer doesn't own at least one of the involved parent
   * MKs.
   */
  getExcerptMergeCandidate(
    externalId: string,
    viewerOmadiaUserId: string,
  ): Promise<ExcerptMergeCandidateNode | null>;
  /**
   * Slice 12 — persist a near-duplicate marker between two excerpts.
   * Idempotent: returns null when an ExcerptMergeCandidate between the
   * same two excerpts (regardless of order, regardless of status)
   * already exists; also null if one of the excerpts is missing.
   * The excerpt pair is sorted ascending on persist.
   */
  createExcerptMergeCandidate(
    input: CreateExcerptMergeCandidateInput,
  ): Promise<ExcerptMergeCandidateNode | null>;
  /**
   * Slice 12 — operator resolves an open ExcerptMergeCandidate. The
   * actor must own at least one of the two excerpts' parent MKs.
   * Side-effects:
   *   - `keep_a`        → deletes excerpt B via `deleteExcerpt`
   *   - `keep_b`        → deletes excerpt A via `deleteExcerpt`
   *   - `not_duplicate` → no excerpt changes; candidate marked dismissed
   */
  resolveExcerptMergeCandidate(
    externalId: string,
    resolution: ExcerptMergeResolution,
    actor: AclMutationOptions,
  ): Promise<ExcerptMergeCandidateNode>;
  /**
   * Slice 12 — list PalaiaExcerpt external_ids still needing a bulk
   * merge-detect pass: embedding column populated AND no
   * `last_excerpt_merge_check_at` marker. Ordered created_at ASC,
   * clamped to [1, 500]. Mirrors the Slice 10 MK selection.
   */
  listPalaiaExcerptIdsForBulkMergeCheck(opts: {
    limit: number;
  }): Promise<string[]>;
  /**
   * Slice 12 — preview-stats for the bulk excerpt-merge-detect panel.
   */
  countPalaiaExcerptMergeCheckBuckets(): Promise<{
    unchecked: number;
    alreadyChecked: number;
    withoutEmbedding: number;
  }>;
  /**
   * Slice 12 — set the `last_excerpt_merge_check_at` marker on an
   * Excerpt to `now()`. Idempotent.
   */
  markPalaiaExcerptMergeChecked(excerptExternalId: string): Promise<void>;
  /**
   * Slice 11 — list all Topic nodes for the tenant. Tenant-scoped only;
   * Topics are aggregate metadata so the read is not ACL-gated.
   */
  listTopics(): Promise<TopicNode[]>;
  /**
   * Slice 11 — read one Topic by external_id. Null when missing.
   */
  getTopic(topicExternalId: string): Promise<TopicNode | null>;
  /**
   * Slice 11 — return the MK members of a Topic. ACL-gating happens in
   * the route layer (per-member `getMemorableKnowledge(id, viewer)`).
   */
  listTopicMembers(topicExternalId: string): Promise<GraphNode[]>;
  /**
   * Slice 11 — pull every MK with a populated embedding column. Used
   * by the clustering pass; tenant-scoped, no ACL filter (re-cluster
   * is a dev/admin action).
   */
  listMemorableKnowledgeWithEmbeddings(): Promise<
    Array<{ mk: GraphNode; embedding: number[] }>
  >;
  /**
   * Slice 11 — wipe every Topic node and its HAS_TOPIC edges for the
   * tenant. Returns the number of Topics removed. Run BEFORE
   * `createTopic` calls in a re-cluster pass.
   */
  deleteAllTopics(): Promise<number>;
  /**
   * Slice 11 — persist one Topic + n HAS_TOPIC edges in a single
   * transaction. Missing MK external_ids are silently skipped.
   */
  createTopic(input: {
    name: string;
    description: string;
    namingSource: TopicNamingSource;
    memberMkIds: readonly string[];
  }): Promise<TopicNode>;
  /**
   * Slice 11.5 — every `HAS_TOPIC` edge in the tenant (MK → Topic),
   * exposed as external-id pairs for the Dev-UI to overlay on the
   * `/graph` canvas. ACL is intentionally NOT enforced — the endpoint
   * exposing this (`GET /dev/graph/topics`) sits behind
   * `DEV_ENDPOINTS_ENABLED` and is never reachable in production.
   */
  listTopicMembershipEdges(): Promise<Array<{ from: string; to: string }>>;
  /**
   * Slice 11.5 + 12.5 — every open + resolved + dismissed Inconsistency,
   * MergeCandidate, and ExcerptMergeCandidate in the tenant, plus the
   * MK-side / Excerpt-side edges expressed as external-id pairs. Same
   * dev-bypass as {@link listTopicMembershipEdges}: not ACL-gated.
   *
   * Edge types:
   *  - CONFLICTS_WITH:        Inconsistency → MemorableKnowledge
   *  - DUPLICATE_OF:          MergeCandidate → MemorableKnowledge
   *  - DUPLICATE_EXCERPT_OF:  ExcerptMergeCandidate → PalaiaExcerpt
   */
  listAllIssues(opts?: { status?: InconsistencyStatus }): Promise<{
    inconsistencies: InconsistencyNode[];
    mergeCandidates: MergeCandidateNode[];
    excerptMergeCandidates: ExcerptMergeCandidateNode[];
    edges: Array<{
      from: string;
      to: string;
      type: 'CONFLICTS_WITH' | 'DUPLICATE_OF' | 'DUPLICATE_EXCERPT_OF';
    }>;
  }>;
  /**
   * Dev-UI · Memory Focused View — list every memory (MemorableKnowledge
   * + PalaiaExcerpt) anchored to the given scope along with its 2-hop
   * provenance ancestors, pre-resolved in a single round-trip. ACL is
   * intentionally NOT enforced: the endpoint that exposes this method
   * (`GET /dev/graph/memories`) sits behind `DEV_ENDPOINTS_ENABLED` and
   * is never reachable in production.
   *
   * Provenance chain (per `schema.ts`):
   *   `PalaiaExcerpt -EXCERPT_OF-> MK -DERIVED_FROM-> Turn -IN_SESSION-> Session`
   *   `MK -INVOLVED-> User`, `MK -REQUIRES-> Entity`
   *
   * Per-memory `level1` / `level2` contents:
   *   - MK:      L1 = Turn + INVOLVED Users + REQUIRES Entities;
   *              L2 = Session
   *   - Excerpt: L1 = parent MK;
   *              L2 = MK's own L1 (Turn + Users + Entities)
   *
   * When `scope` is omitted, returns memories across every session
   * (cap remains `limit`). The companion `edges` array carries the real
   * graph_edges rows so the canvas can render them with their actual
   * labels instead of guessing.
   */
  listMemoriesForScope(
    scope: string | undefined,
    opts?: ListMemoriesForScopeOptions,
  ): Promise<MemoriesProvenanceView>;

  /**
   * KG-walk chat visualization — given the top recalled MemorableKnowledge
   * external ids (the recall frontier, hop 0), BFS outward over `graph_edges`
   * in BOTH directions, tenant-scoped, up to `maxHops` (default 2) and capped
   * at `maxNodes` (default ~40). Returns the surfaced neighbourhood as a flat
   * node/edge list for the frontend to animate. Read-only and best-effort:
   * callers wrap it so it can never affect or delay the turn / the LLM.
   *
   * `KgWalkEdge.hop` is the BFS discovery layer of the edge = (BFS distance of
   * its nearer endpoint) + 1, i.e. the hop at which the edge was first crossed.
   * Edges and nodes beyond `maxNodes` are dropped; every emitted edge is
   * guaranteed to reference two emitted nodes.
   */
  getMemorableKnowledgeSubgraph(
    rootExternalIds: string[],
    opts?: { maxHops?: number; maxNodes?: number },
  ): Promise<{ nodes: KgWalkNode[]; edges: KgWalkEdge[] }>;
}

// ---------------------------------------------------------------------------
// KG-walk chat visualization — per-turn graph payload of the Knowledge-Graph
// neighbourhood the recall surfaced. Emitted as a sibling `kg_graph`
// turn-annotation next to `kg_recall`; consumed by the frontend to animate
// iterating through the recalled subgraph. UI-only, additive, opaque to the
// model.
// ---------------------------------------------------------------------------

/** One node in the recalled KG neighbourhood. */
export interface KgWalkNode {
  /** Graph `external_id` (matches `GraphNode.id`'s key space). */
  id: string;
  /** Human label — from `properties.summary` / `name` / `title`, else type. */
  label: string;
  /** Node `type` (e.g. `MemorableKnowledge`, `Turn`, `Entity`). */
  kind: string;
  /** Recall hit score; set only on root (hop-0) nodes when available. */
  score?: number;
  /**
   * True when this node was WRITTEN into the KG by the current turn (e.g. the
   * auto-promoted MemorableKnowledge + its Turn). Carried by the `kg_insert`
   * follow-up annotation so the UI can visually distinguish a fresh insert
   * (a "NEW" / pulse) from the recalled neighbourhood.
   */
  inserted?: boolean;
}

/** One edge in the recalled KG neighbourhood. */
export interface KgWalkEdge {
  /** Source node `external_id`. */
  from: string;
  /** Target node `external_id`. */
  to: string;
  /** Edge `type` (e.g. `DERIVED_FROM`, `INVOLVED`, `REQUIRES`). */
  type: string;
  /** BFS discovery layer of the edge from the nearest root (1..N). */
  hop: number;
  /** True when this edge was created by the current turn (see KgWalkNode). */
  inserted?: boolean;
}

/** Per-turn KG-walk payload carried by the `kg_graph` turn-annotation. */
export interface KgWalkPayload {
  /** Top recalled MemorableKnowledge node ids (frontier seeds, hop 0). */
  rootIds: string[];
  nodes: KgWalkNode[];
  /** `hop` = BFS distance from the nearest root (1..N). */
  edges: KgWalkEdge[];
}

/**
 * Single memory row + its 2-hop provenance neighbours. See
 * {@link KnowledgeGraph.listMemoriesForScope} for the level semantics.
 */
export interface MemoryWithAncestors {
  node: GraphNode;
  level1: GraphNode[];
  level2: GraphNode[];
}

/**
 * Edge row exposed alongside {@link MemoryWithAncestors}. `from` and
 * `to` are `external_id`s (matching `GraphNode.id`) so the frontend can
 * dedupe via the same key space it already uses.
 */
export interface MemoryProvenanceEdge {
  from: string;
  to: string;
  type: GraphEdgeType;
}

/** Top-level payload returned by `listMemoriesForScope`. */
export interface MemoriesProvenanceView {
  memories: MemoryWithAncestors[];
  edges: MemoryProvenanceEdge[];
}

/** Options for {@link KnowledgeGraph.listMemoriesForScope}. */
export interface ListMemoriesForScopeOptions {
  /** Max MK count returned. Excerpts are bounded by their parent MK's
   *  presence in the result. Clamped to [1, 500]. Default 200. */
  limit?: number;
  /** When false, omits PalaiaExcerpt rows from the result entirely.
   *  Default true. */
  includeExcerpts?: boolean;
}

/** Slice 7 — input for `searchMemorableKnowledgeByEmbedding`. */
export interface MemorableKnowledgeSearchOptions {
  queryEmbedding: number[];
  /** Cluster-root id of the viewer. ACL is non-bypassable. */
  viewerOmadiaUserId: string;
  /** Max hits, clamped to [1, 50]. Default 5. */
  limit?: number;
  /** Hits below this cosine similarity dropped. Default 0.3. */
  minSimilarity?: number;
  /**
   * Opt-in team-scope recall. When true, the ACL gate also admits rows
   * whose `visibility` is `team` or `public` within the same tenant — not
   * just rows the viewer directly owns via `acl_owners`. `visibility`
   * `private` stays strictly owner-only regardless. Default false (the
   * historical owner-only behaviour).
   */
  teamVisibility?: boolean;
  /**
   * Per-orchestrator isolation — the recalling Agent's slug. When set,
   * owner-gated MK is additionally constrained to rows the viewing Agent
   * produced (`origin_agent = viewerAgentSlug`); MK with no `origin_agent`
   * (legacy / single-agent) stays visible to the owner. team/public rows
   * bypass this constraint (cross-agent sharing preserved). Omit on legacy
   * callers → no agent constraint.
   */
  viewerAgentSlug?: string;
  /**
   * Durable-tier filter. When true, only `manually_authored = true` MK are
   * returned — applied at the SQL level so the always-surface durable recall
   * leg ranks durable knowledge among itself, instead of over-fetching from
   * the general pool (where higher-cosine session noise would crowd it out).
   * Default false.
   */
  manuallyAuthoredOnly?: boolean;
}

/** Slice 7 — single MK hit from semantic search. */
export interface MemorableKnowledgeHit {
  mk: GraphNode;
  cosineSim: number;
}

/** Slice 7 — input for `searchExcerptsByEmbedding`. Same shape as
 *  the MK search; the JOIN to parent-MK is internal. */
export interface ExcerptSearchOptions {
  queryEmbedding: number[];
  viewerOmadiaUserId: string;
  limit?: number;
  minSimilarity?: number;
  /**
   * Opt-in team-scope recall — mirrors
   * {@link MemorableKnowledgeSearchOptions.teamVisibility}. The gate runs
   * against the parent MK's `visibility`. Default false.
   */
  teamVisibility?: boolean;
  /**
   * Per-orchestrator isolation — mirrors
   * {@link MemorableKnowledgeSearchOptions.viewerAgentSlug}. Constrains the
   * owner branch to the parent MK's `origin_agent`. Omit on legacy callers.
   */
  viewerAgentSlug?: string;
}

/** Slice 7 — single excerpt hit, carries the parent-MK external_id
 *  so callers can dedupe-merge against MK-hits. */
export interface PalaiaExcerptHit {
  excerpt: PalaiaExcerptNode;
  parentMkId: string;
  cosineSim: number;
}

// ---------------------------------------------------------------------------
// Cross-session recall probe — structured payload of what the per-turn probe
// surfaced from PRIOR sessions. Defined here (the lowest common type package)
// so both the recall producer (@omadia/orchestrator-extras) and the
// channel-facing answer contract (@omadia/channel-sdk · SemanticAnswer /
// ChatTurnResult) can reference it without a circular dependency.
// ---------------------------------------------------------------------------

/** One resumable plan from a PRIOR session. `openStepGoals` are the goals of
 *  its still-pending/in-progress steps. */
export interface RecalledPlan {
  /** External id `plan:<planId>`. */
  planId: string;
  scope: string;
  strategy?: string;
  createdAt?: string;
  openStepGoals: string[];
  doneCount: number;
  totalCount: number;
}

/** One stored process matching the current message. */
export interface RecalledProcess {
  /** External id `process:<scope>:<slug>`. */
  id: string;
  title: string;
  scope: string;
  stepCount: number;
  score: number;
}

/** One curated insight (MemorableKnowledge) recalled cross-session. */
export interface RecalledInsight {
  mkId: string;
  kind: string;
  summary: string;
  score: number;
}

/** What the cross-session probe surfaced this turn. Empty arrays when a leg
 *  found nothing or was disabled. Powers both the prompt-injected recall
 *  blocks and the visible recall card / Teams Adaptive Card. */
export interface RecalledContext {
  plans: RecalledPlan[];
  processes: RecalledProcess[];
  insights: RecalledInsight[];
}

/** Slice 5 — partial content-patch on a MemorableKnowledge. All fields
 *  optional; `rationale: null` removes the field. */
export interface MemorableKnowledgeUpdate {
  kind?: MemorableKind;
  summary?: string;
  /** Pass `null` to delete the rationale; `undefined` (default) to
   *  leave it untouched; a string to set/replace. */
  rationale?: string | null;
  significance?: number;
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
  /** Slice 1b — channel-agnostic Omadia identity (cluster root). */
  | 'User'
  /** Slice 1b — channel-bound leaf node carrying raw platform id +
   *  optional verified email for cross-channel cluster-merge. */
  | 'ChannelIdentity'
  | 'Run'
  | 'AgentInvocation'
  | 'ToolCall'
  | 'Fact'
  /** Slice 2 — first-class curated memory entity between atomic Fact
   *  and verbatim Turn. Carries the ACL (Slice 3) and is the sink for
   *  the Palaia significance-promotion pipeline (Slice 4). */
  | 'MemorableKnowledge'
  /** Slice 6.5 — verbatim text snippet from the original turn that
   *  underpins a MemorableKnowledge. Stable provenance anchor;
   *  carries `text`, `position` (0-4), `source` ('llm'|'hint'|
   *  'fallback') in `props`. Linked to its parent MK via
   *  `EXCERPT_OF`. */
  | 'PalaiaExcerpt'
  /** Slice 9 — contradiction marker between two semantically-similar
   *  MemorableKnowledge nodes whose content disagrees. Carries
   *  `summary`, `severity`, `status`, `resolution` in `props`. Linked
   *  to BOTH offending MKs via `CONFLICTS_WITH`. */
  | 'Inconsistency'
  /** Slice 10 — near-duplicate marker between two MKs whose cosine
   *  similarity is ≥ 0.95. No contradiction; just redundancy. Carries
   *  `cosine_sim`, `status`, `resolution` in `props`. Linked to BOTH
   *  MKs via `DUPLICATE_OF`. */
  | 'MergeCandidate'
  /** Slice 11 — cluster of semantically-related MemorableKnowledge
   *  nodes, named by Haiku. Aggregate metadata; lifetime is until the
   *  next operator-triggered re-cluster. */
  | 'Topic'
  /** Slice 12 — near-duplicate marker between two PalaiaExcerpts
   *  (cosine ≥ 0.97). Mirror of Slice 10 MergeCandidate at the
   *  excerpt layer. Linked to BOTH excerpts via DUPLICATE_EXCERPT_OF. */
  | 'ExcerptMergeCandidate'
  /** #133 (plan-as-data) — per-turn plan DAG root. */
  | 'Plan'
  /** #133 — typed sub-goal node under a Plan; status lives in `props.status`. */
  | 'PlanStep';
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
  /** Slice 1b — ChannelIdentity → User-Cluster cross-link. */
  | 'IS_IDENTITY_OF'
  /** Slice 2 — MemorableKnowledge → User-Cluster, participating users. */
  | 'INVOLVED'
  /** Slice 2 — MemorableKnowledge → Entity (Odoo/Confluence/Plugin),
   *  domain references the MK is anchored to. */
  | 'REQUIRES'
  /** Slice 6.5 — PalaiaExcerpt → MemorableKnowledge. The verbatim
   *  source-snippet "belongs to" the curated memory it underpins. */
  | 'EXCERPT_OF'
  /** Slice 9 — Inconsistency → MemorableKnowledge. Two edges per
   *  Inconsistency, one per conflicting MK. Direction: from the
   *  marker to the MKs it flags. */
  | 'CONFLICTS_WITH'
  /** Slice 10 — MergeCandidate → MemorableKnowledge. Two edges per
   *  MergeCandidate, one per near-duplicate MK. Same direction
   *  convention as CONFLICTS_WITH. */
  | 'DUPLICATE_OF'
  /** Slice 11 — MemorableKnowledge → Topic. 1:1 per MK; re-cluster
   *  wipes and rebuilds every edge so the cardinality stays clean. */
  | 'HAS_TOPIC'
  /** Slice 12 — ExcerptMergeCandidate → PalaiaExcerpt. Two edges per
   *  ExcerptMergeCandidate, one per near-duplicate excerpt. Same
   *  direction convention as DUPLICATE_OF. */
  | 'DUPLICATE_EXCERPT_OF'
  /** #133 (plan-as-data) — PlanStep → Plan membership. */
  | 'STEP_OF'
  /** #133 — PlanStep → PlanStep DAG dependency. */
  | 'DEPENDS_ON'
  /** #133 — Plan → Turn provenance. */
  | 'PLAN_OF';

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
 * `system` is a free-form string namespace (OB-29-2). Built-in values:
 *   - `'odoo'` → maps to GraphNodeType `'OdooEntity'`
 *   - `'confluence'` → maps to GraphNodeType `'ConfluencePage'`
 *   - any other string → maps to GraphNodeType `'PluginEntity'` (generic
 *     plugin-namespaced entity). Plugins MUST declare their custom system
 *     strings in `permissions.graph.entity_systems` and ingest through
 *     `ctx.knowledgeGraph` so the accessor can enforce the namespace.
 */
export interface EntityIngest {
  system: string;
  model: string;
  /** External id in the source system (Odoo numeric id, Confluence page id). */
  id: string | number;
  displayName?: string;
  /** Free-form extras stored on the node properties. Keep small — this is
   *  indexed via GIN, so huge blobs hurt. */
  extras?: Record<string, unknown>;
}

export interface EntityIngestResult {
  /** External ids ("odoo:res.partner:42") in the order they were inserted. */
  entityIds: string[];
  inserted: number;
  updated: number;
}

// ---------------------------------------------------------------------------
// Slice 1b — Channel-aware identity resolution.
// ---------------------------------------------------------------------------

/** Supported platform discriminators for ChannelIdentity nodes. `web` is
 *  the admin UI (and any future end-user surface served from the same
 *  middleware); the channelUserId there is the local `users.id` uuid. */
export type ChannelKind = 'teams' | 'telegram' | 'slack' | 'email' | 'web';

/**
 * Payload for {@link KnowledgeGraph.resolveOrCreateChannelIdentity}.
 *
 * `email` paired with `emailVerified=true` is the cross-channel merge key:
 * two ChannelIdentities sharing a verified email in the same tenant join
 * the same User-Cluster. Anything else (no email, unverified email,
 * different tenant) gets its own 1:1 cluster.
 */
export interface ChannelIdentityIngest {
  channelKind: ChannelKind;
  /** Raw platform id (Teams AAD oid, Telegram numeric chat-id, …). */
  channelUserId: string;
  displayName?: string;
  email?: string;
  emailVerified?: boolean;
  /**
   * Microsoft AAD object id (`claims.oid`). First-class merge key —
   * when set, the resolver matches existing identities in the same
   * tenant via this oid BEFORE falling back to the verified-email
   * merge. Stable AAD identifier (cannot be renamed at the IdP), so
   * cross-channel links for Microsoft-authenticated users are more
   * robust than the email path. Both the Admin-UI entra-login and the
   * Teams plugin (when it nachzieht) populate this field, which lets
   * them deterministically land on the same User-Cluster.
   */
  aadObjectId?: string;
  /** Free-form channel-side payload (Telegram from-object, etc.).
   *  AAD oid is NOT stored here — it has its own first-class field. */
  internalChannelData?: Record<string, unknown>;
}

export interface ResolveOrCreateChannelIdentityResult {
  /** External id of the ChannelIdentity node (`<channelKind>:<channelUserId>`). */
  channelIdentityNodeId: string;
  /** External id of the User-Cluster node (`user:<omadiaUserId>`). */
  userNodeId: string;
  /** Opaque cluster-root uuid, also stored on `Run.user_id` / `Turn.userId`. */
  omadiaUserId: string;
  /** True if the ChannelIdentity was newly created in this call. */
  isNewIdentity: boolean;
  /** True if a fresh User-Cluster was spun up (vs. joining an existing one). */
  isNewCluster: boolean;
}

// ---------------------------------------------------------------------------
// Slice 2 — MemorableKnowledge ingest.
// ---------------------------------------------------------------------------

/** Taxonomy of the curated memory entity. Matches `MEMORABLE_KINDS` in
 *  `@omadia/knowledge-graph-neon` — kept in sync manually for now since
 *  the plugin-api layer is the public contract. */
export type MemorableKind =
  | 'decision'
  | 'insight'
  | 'preference'
  | 'reference';

export interface MemorableKnowledgeIngest {
  kind: MemorableKind;
  /** Short headline (≤ 2000 chars). What recall surfaces first. */
  summary: string;
  /** Optional longer-form reasoning (≤ 10000 chars). */
  rationale?: string;
  /** Palaia significance in [0, 1]. Optional — Slice 4 fills it in. */
  significance?: number;
  /** ChannelIdentity external_id of the channel-bound identity that
   *  produced this MK (e.g. `web:<users.uuid>` or `teams:<aad-oid>`). */
  createdBy: string;
  /** Cluster-root `omadiaUserId`s the MK is about. Wired as INVOLVED
   *  edges. Missing User-Clusters are silently skipped + counted. */
  involvedOmadiaUserIds?: string[];
  /** External ids of referenced Entities. Wired as REQUIRES edges.
   *  Target node MUST be OdooEntity / ConfluencePage / PluginEntity —
   *  others are silently skipped + counted. */
  requiredEntityIds?: string[];
  /** Turn external ids the MK was derived from. Wired as DERIVED_FROM
   *  edges (re-uses the existing edge type). Missing Turns skipped. */
  derivedFromTurnIds?: string[];
  /**
   * Slice 3 — initial cluster-root owners (snapshot at-creation). The
   * caller is responsible for resolving the right set (e.g. all
   * verified Teams-channel members for a Teams-sourced MK, just the
   * web-session user for an Admin-UI save). When omitted, defaults to
   * `[]` — the MK is invisible to every viewer (admin-only).
   * `createMemorableKnowledge` writes a `create` row to the audit-log
   * regardless of whether owners are set.
   */
  aclOwners?: string[];
  /**
   * Initial visibility for the new MK. Omitted → backend default
   * (admin-only / private). Used by the scratch-promotion reaper to publish
   * consolidated agent knowledge team-wide.
   */
  visibility?: Visibility;
  /**
   * Per-orchestrator isolation — the Agent slug that produced this MK,
   * stamped as the `origin_agent` property. Recall default-isolates by
   * origin agent (an Agent only sees its own MK) while team/public-promoted
   * MK stays shareable across Agents. Omit on legacy / single-agent boots →
   * the MK has no origin agent and is matched only via the team/public or
   * user-ACL branches.
   */
  originAgent?: string;
  /**
   * Slice 3 — cluster-root that triggered the create. Audited as the
   * `actor_omadia_user_id` of the `create` row. Falls back to
   * `aclOwners[0]` when omitted; if both are missing, the actor is
   * the zero-uuid (`00000000-…`) which marks the create as
   * system-driven.
   */
  actorOmadiaUserId?: string;
  /**
   * Slice 6.5 — verbatim source snippets that underpin this MK,
   * persisted atomically in the same transaction. The Palaia-Excerpt-
   * Extractor fills `texts` (0-5 entries, each ≤300 chars) and
   * tags the batch with a single `source` discriminator. The
   * provenance is read-only via {@link KnowledgeGraph.listExcerptsForMemory}
   * and editable via {@link KnowledgeGraph.updateExcerpt}.
   */
  palaiaExcerpts?: PalaiaExcerptInput;
  /**
   * Durable-curation marker. When `true`, the new MK is written with the
   * top-level `manually_authored` column set, which makes it eligible for the
   * always-surface durable recall tier (see ContextRetriever durable leg).
   * Default `false` → ordinary fuzzy/session MK. Set by the durable-promotion
   * pipeline (the `_rules/`-write hook and high-significance auto-promotion),
   * never by raw auto-harvesting.
   */
  manuallyAuthored?: boolean;
}

/**
 * Slice 6.5 — provenance discriminator for a Palaia-Excerpt batch.
 *   - 'llm'      — Haiku-extracted from the cleaned assistant answer.
 *   - 'hint'     — derived from an explicit `<palaia-hint>` annotation
 *                  in the user message.
 *   - 'fallback' — degraded extractor output (parse failure / empty
 *                  answer). Should rarely be persisted — extractors
 *                  prefer to return `undefined` instead.
 */
export type ExcerptSource = 'llm' | 'hint' | 'fallback';

/** Slice 6.5 — input shape for the optional Excerpt batch on
 *  `createMemorableKnowledge`. Length 0 is allowed (caller filtered all
 *  excerpts out); >5 throws `excerpt_count_exceeded`. */
export interface PalaiaExcerptInput {
  texts: readonly string[];
  source: ExcerptSource;
}

/** Slice 6.5 — Excerpt-node read shape. `position` is dense in
 *  [0, n-1] for the n excerpts of a parent MK; the order is the LLM's
 *  document order at extract-time and is preserved across edits. */
export interface PalaiaExcerptNode {
  /** External id, scheme `excerpt:<uuid-v4>`. */
  id: string;
  type: 'PalaiaExcerpt';
  props: {
    text: string;
    position: number;
    source: ExcerptSource;
    created_at: string;
  };
}

/** Slice 6.5 — partial update shape. At least one of `text` / `source`
 *  must be present, else `empty_patch` is thrown. */
export interface PalaiaExcerptUpdate {
  text?: string;
  source?: ExcerptSource;
}

export interface MemorableKnowledgeIngestResult {
  /** External id of the new MK node (`mk:<uuid>`). */
  memorableKnowledgeNodeId: string;
  /** Cluster-roots in `involvedOmadiaUserIds` that didn't resolve. */
  skippedInvolved: number;
  /** Entries in `requiredEntityIds` that didn't resolve OR weren't an
   *  Entity-typed node. */
  skippedRequired: number;
  /** Entries in `derivedFromTurnIds` that didn't resolve to a Turn. */
  skippedDerivedFrom: number;
}

export interface ListMemorableKnowledgeOptions {
  limit?: number;
  /** Filter to a single kind. */
  kind?: MemorableKind;
}

// ---------------------------------------------------------------------------
// Slice 3 — ACL on MemorableKnowledge.
// ---------------------------------------------------------------------------

/** Action recorded in the audit-log. `create` is logged by
 *  `createMemorableKnowledge` when `aclOwners.length > 0` (so the
 *  initial-owner snapshot is auditable). `edit_excerpt` (Slice 6.5)
 *  is written by `updateExcerpt` and shares the no-op-owners
 *  invariant with `'edit'`. */
export type AclAction =
  | 'create'
  | 'expand'
  | 'shrink'
  | 'delete'
  | 'edit'
  | 'edit_excerpt'
  /** Slice 12 — emitted by `deleteExcerpt` when an operator picks
   *  keep_a/keep_b on an ExcerptMergeCandidate, removing the loser
   *  excerpt from the parent MK's excerpt batch. */
  | 'delete_excerpt';

/** Append-only audit-log row. Survives a `deleteMemory` (the
 *  underlying table has no FK on `memory_external_id`). */
export interface AclAuditEntry {
  id: string;
  memoryExternalId: string;
  actorOmadiaUserId: string;
  actorChannelIdentityId?: string;
  action: AclAction;
  beforeOwners: string[];
  /** `null` only when `action === 'delete'`. */
  afterOwners: string[] | null;
  reason?: string;
  createdAt: string;
}

/** Args every owner-mutating call shares. Actor must already be in
 *  `acl_owners` of the target MK. */
export interface AclMutationOptions {
  actorOmadiaUserId: string;
  /** Optional ChannelIdentity external_id, e.g. `web:<users.uuid>` —
   *  used for audit context only, not for authorisation. */
  actorChannelIdentityId?: string;
  /** Optional rationale shown in the audit trail. */
  reason?: string;
}

/**
 * Danger-Zone bulk-purge selector for MemorableKnowledge. `tenantId` is
 * always required (purge is never cross-tenant). `originAgent` and
 * `aclOwner` are additive AND-narrowing filters; omitting both means
 * "all MemorableKnowledge for the tenant". Used by
 * `countMemorableKnowledge` (preview) and `purgeMemorableKnowledge`.
 */
export interface MemorableKnowledgePurgeFilter {
  /** Tenant whose MemorableKnowledge is in scope. Required. */
  tenantId: string;
  /** Restrict to MK whose `properties->>'origin_agent'` equals this slug. */
  originAgent?: string;
  /** Restrict to MK whose `properties->'acl_owners'` contains this user id. */
  aclOwner?: string;
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
  /** External ids of entities produced by this call (odoo://…, confluence://…).
   * Wired by the entity-ref bus, same source as TurnIngest.entityRefs. */
  producedEntityIds?: string[];
  /** #130 — set when the bridge ran an optional output Zod schema on the
   * tool's return value and it failed. The verifier converts this into a
   * `tool_postcondition` claim which drives the existing correctionPrompt
   * retry loop. Absent on every successful call. */
  postcondition?: {
    issues: readonly string[];
  };
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

/** #133 (plan-as-data) — lifecycle status of a single PlanStep. */
export type PlanStepStatus =
  | 'pending'
  | 'in_progress'
  | 'done'
  | 'failed'
  | 'skipped';

/** #133 — input to {@link KnowledgeGraph.ingestPlan}. */
export interface PlanIngest {
  /** Opaque plan id (stable per turn). Becomes `plan:<planId>`. */
  planId: string;
  scope: string;
  /** Turn external id to link via `PLAN_OF`. Skipped silently if absent. */
  turnExternalId?: string;
  userId?: string;
  /** Free-form planning strategy label (e.g. the gate's rationale, or the
   *  title of the stored process a reused plan was materialised from). */
  strategy?: string;
  /** Provenance of the plan: `gate` (Haiku materialiser), `manual`, or
   *  `process` (materialised from a reused {@link ProcessMemoryService}
   *  record — no LLM re-planning). */
  createdBy?: 'gate' | 'manual' | 'process';
  createdAt: string;
  /**
   * #237 (plan GC) — a short summary of the originating user request, stored on
   * the Plan node so the plan-GC pass can compare plans for semantic
   * equivalence (same task, re-planned) without re-reading turn text. The
   * caller caps the length. Absent on legacy plans → those are skipped by the
   * semantic GC comparison.
   */
  requestSummary?: string;
}

export interface PlanIngestResult {
  planExternalId: string;
}

/** #237 — result of {@link KnowledgeGraph.deletePlan}. */
export interface PlanDeleteResult {
  /** True when a Plan node was found and removed. */
  deleted: boolean;
  /** Number of PlanStep nodes removed alongside the plan. */
  deletedSteps: number;
}

/** #133 — input to {@link KnowledgeGraph.upsertPlanStep}. */
export interface PlanStepIngest {
  /** Opaque step id (stable). Becomes `planstep:<stepId>`. */
  stepId: string;
  /** Raw plan id this step belongs to (the Plan must already exist). */
  planId: string;
  scope: string;
  goal: string;
  /** Execution order within the plan (ascending). */
  order: number;
  /** Defaults to `'pending'` when omitted. Stored in `props.status`. */
  status?: PlanStepStatus;
  exitCondition?: string;
  toolHint?: string;
  /** Raw step ids this step depends on; `DEPENDS_ON` edges are written for
   *  the ones that already exist. */
  dependsOnStepIds?: string[];
  /** When true, the step is unsafe to replay on resume (write/send). */
  sideEffecting?: boolean;
  resultSummary?: string;
}

export interface PlanStepIngestResult {
  stepExternalId: string;
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
  /**
   * Slice 1b-channel-web — User-Cluster the session belongs to. Resolved
   * via `session.props.userId` (= `omadiaUserId`) so graph viewers and
   * audit consumers can render the user as a first-class neighbor of the
   * session without an extra round-trip. Undefined when the session has
   * no `userId` (anonymous or pre-Slice-1b).
   */
  user?: GraphNode;
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
  /**
   * Restrict to turns whose `scope` begins with this agent prefix
   * (`<agentSlug>::`). Omit for the legacy cross-agent view. See
   * {@link agentScopePrefix} — per-orchestrator KG isolation.
   */
  agentScopePrefix?: string;
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
  // Palaia-Phase-5 (OB-74) — additive fields for the Token-Budget Assembler.
  // Optional + backwards-compatible: backends without the palaia schema omit them.
  /** Memory classification of the turn. Optional — undefined = unknown. */
  entryType?: EntryType;
  /** True when the turn was manually authored (operator/admin capture).
   *  The assembler applies a score boost to TRUE hits. */
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
  /**
   * Restrict to turns whose `scope` begins with this agent prefix
   * (`<agentSlug>::`). Omit for the legacy cross-agent view. See
   * {@link agentScopePrefix} — per-orchestrator KG isolation.
   */
  agentScopePrefix?: string;
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
  /**
   * Restrict the capturing turns to those whose `scope` begins with this
   * agent prefix (`<agentSlug>::`). Entity NODES stay global (shared
   * vocabulary); only the CAPTURED→Turn recall is agent-isolated. Omit for
   * the legacy cross-agent view. See {@link agentScopePrefix}.
   */
  agentScopePrefix?: string;
  /** Max turns to return per matched entity. Default 2. */
  perEntityLimit?: number;
  /** Hard cap on distinct entities to return. Default 5. */
  entityLimit?: number;
}

export interface FindEntitiesOptions {
  /** Odoo/Confluence model name, e.g. `res.partner`, `hr.department`. */
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
// Per-orchestrator KG scope qualification.
//
// Each Agent (orchestrator) owns a slice of the single-tenant graph. We carry
// the Agent identity inside the existing free-string `scope` (reusing the
// `(tenant_id, scope, type)` index — no schema migration) by prefixing the
// conversation scope with `<agentSlug>::`. Reads then constrain to
// `scope LIKE '<agentSlug>::%'`, so Orchestrator A never recalls Orchestrator
// B's turns/plans while WITHIN-agent cross-conversation recall still works
// (the current conversation is dropped via `excludeScope`).
//
// CRITICAL: qualify exactly ONCE, at the orchestrator boundary. `turnNodeId`
// / `sessionNodeId` derive node ids FROM the scope, so an unqualified scope at
// any write/read site silently breaks recall (no error, just misses).
// ---------------------------------------------------------------------------

/** Separator between the agent slug and the conversation scope. */
export const AGENT_SCOPE_SEP = '::';

/** Build the graph scope an Agent writes: `<agentSlug>::<conversationScope>`. */
export function qualifyScope(agentSlug: string, conversationScope: string): string {
  return `${agentSlug}${AGENT_SCOPE_SEP}${conversationScope}`;
}

/** The `LIKE` prefix (`<agentSlug>::`) that selects one Agent's scopes. */
export function agentScopePrefix(agentSlug: string): string {
  return `${agentSlug}${AGENT_SCOPE_SEP}`;
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

/** #133 — external id for a per-turn Plan node. */
export function planNodeId(planId: string): string {
  return `plan:${planId}`;
}

/** #133 — external id for a PlanStep node. */
export function planStepNodeId(stepId: string): string {
  return `planstep:${stepId}`;
}

export function entityNodeId(ref: EntityRef): string {
  return `${ref.system}:${ref.model}:${String(ref.id)}`;
}

/**
 * Slice 1b — User-Cluster external id. Argument is the opaque
 * `omadiaUserId` (uuid), not a channel-bound platform id.
 */
export function userNodeId(omadiaUserId: string): string {
  return `user:${omadiaUserId}`;
}

/**
 * Slice 1b — ChannelIdentity external id. Matches the v1
 * `PlatformIdentity.platformId` shape from `@omadia/channel-sdk`
 * (`${channelKind}:${platformId}`) so channel adapters can pass either
 * verbatim.
 */
export function channelIdentityNodeId(
  channelKind: ChannelKind,
  channelUserId: string,
): string {
  return `${channelKind}:${channelUserId}`;
}

/**
 * Slice 2 — MemorableKnowledge external id. Argument is an opaque
 * uuid (caller-generated or `randomUUID()`-derived); the prefix
 * disambiguates from User-Cluster (`user:<uuid>`).
 */
export function memorableKnowledgeNodeId(memorableId: string): string {
  return `mk:${memorableId}`;
}

/**
 * Slice 6.5 — external_id for a PalaiaExcerpt node. The uuid is
 * generated per-excerpt on persist; the parent MK is reachable via
 * the EXCERPT_OF edge, so the external_id deliberately does NOT
 * encode mkId or position (would force a rewrite on cascade-renumber).
 */
export function palaiaExcerptNodeId(excerptId: string): string {
  return `excerpt:${excerptId}`;
}

/**
 * Slice 9 — external_id for an Inconsistency node. Stable uuid
 * generated per-conflict on persist; the offending MKs are reachable
 * via the two CONFLICTS_WITH edges.
 */
export function inconsistencyNodeId(inconsistencyId: string): string {
  return `inconsistency:${inconsistencyId}`;
}

/**
 * Slice 10 — external_id for a MergeCandidate node. Stable uuid
 * generated per-pair on persist; the near-duplicate MKs are reachable
 * via the two DUPLICATE_OF edges.
 */
export function mergeCandidateNodeId(mergeId: string): string {
  return `merge:${mergeId}`;
}

/**
 * Slice 11 — external_id for a Topic node. Generated per re-cluster
 * pass; old ids are wiped by the destructive rebuild.
 */
export function topicNodeId(topicId: string): string {
  return `topic:${topicId}`;
}

/**
 * Slice 12 — external_id for an ExcerptMergeCandidate node. The two
 * near-duplicate excerpts are reachable via the DUPLICATE_EXCERPT_OF
 * edges. Scheme `excerpt-merge:<uuid>`.
 */
export function excerptMergeCandidateNodeId(id: string): string {
  return `excerpt-merge:${id}`;
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
