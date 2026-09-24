/**
 * @omadia/orchestrator-extras — CaptureFilteringKnowledgeGraph
 * (palaia Phase 2 / OB-71).
 *
 * Decorator over an arbitrary `KnowledgeGraph` implementation that runs the
 * `CaptureFilter` ahead of `ingestTurn`. Only `ingestTurn` is intercepted —
 * every other method (entities, facts, search, runs, …) is forwarded
 * verbatim to the inner KG. Both Neon and the in-memory backend benefit
 * from the same wrapper without backend-specific glue.
 *
 * Behaviour:
 *   - At `level=off` the filter passes through; the inner KG sees the raw
 *     text and the schema defaults take over.
 *   - At `level=minimal` privacy + hint cleanup runs; the inner KG receives
 *     stripped text and the hint-derived classification (or schema
 *     defaults). No turns are dropped.
 *   - At `level=normal|aggressive` the scorer runs; turns below the
 *     threshold are written as a TAIL-ONLY record (#1096, see below).
 *
 * #1096 — what "below the threshold" may and may not decide.
 * Until #1096 a sub-threshold turn was not written at all: the inner
 * `ingestTurn` was skipped and a synthetic `TurnIngestResult` returned. But
 * `getSession().turns` is also the ONLY source of the orchestrator's
 * in-session context tail, so an LLM-scored number was deciding whether a
 * message had happened *at all* as far as the model was concerned. Short
 * turns ("ok", "pong", "Farbe: blau") score 0.00–0.10 and vanished, and the
 * user and the model then disagreed about what was said.
 *
 * A sub-threshold turn is therefore still written, flagged `tailOnly`, which
 * splits the two jobs that used to ride on one boolean:
 *   - *conversation* (the session record the tail reads) — always written;
 *   - *knowledge* (embedding, cross-session recall, promotion) — still gated
 *     by significance. Backends honouring `tailOnly` write no embedding and
 *     keep the row out of every recall query; both promotion paths decline
 *     the row explicitly (`promotion.ts`, `bulkPromotion.ts`) — the capture
 *     and promotion thresholds are configured independently, so a
 *     sub-threshold score is NOT necessarily below the promotion bar.
 * So the capture filter keeps deciding what costs money, and stops deciding
 * what the model remembers.
 *
 * A failed tail-only write propagates like any other ingest failure: the
 * session logger already catches it without failing the turn, counts it as
 * `turn-ingest-failed` and skips the run-trace write that would point at the
 * missing Turn.
 */

import type {
  KnowledgeGraph,
  TurnIngest,
  TurnIngestResult,
  EntityIngest,
  EntityIngestResult,
  FactIngest,
  FactIngestResult,
  RunTrace,
  RunIngestResult,
  RunTraceView,
  SessionView,
  SessionFilter,
  SessionSummary,
  GraphNode,
  PlanIngest,
  PlanIngestResult,
  PlanDeleteResult,
  PlanStepIngest,
  PlanStepIngestResult,
  PlanStepStatus,
  GraphStats,
  SearchTurnsOptions,
  TurnSearchHit,
  EntityCapturedTurnsOptions,
  EntityCapturedTurnsHit,
  SearchTurnsByEmbeddingOptions,
  FindEntitiesOptions,
  ChannelIdentityIngest,
  ResolveOrCreateChannelIdentityResult,
  MemorableKnowledgeIngest,
  MemorableKnowledgeIngestResult,
  MemorableKnowledgeUpdate,
  ListMemorableKnowledgeOptions,
  AclAuditEntry,
  AclMutationOptions,
  MemorableKnowledgePurgeFilter,
  PalaiaExcerptNode,
  PalaiaExcerptUpdate,
  MemorableKnowledgeSearchOptions,
  MemorableKnowledgeHit,
  ExcerptSearchOptions,
  PalaiaExcerptHit,
  CreateInconsistencyInput,
  CreateExcerptMergeCandidateInput,
  CreateMergeCandidateInput,
  ExcerptMergeCandidateNode,
  ExcerptMergeResolution,
  InconsistencyNode,
  InconsistencyResolution,
  InconsistencyStatus,
  KgWalkEdge,
  KgWalkNode,
  ListExcerptMergeCandidatesOptions,
  ListInconsistenciesOptions,
  ListMemoriesForScopeOptions,
  ListMergeCandidatesOptions,
  MemoriesProvenanceView,
  MergeCandidateNode,
  MergeCandidateResolution,
  TopicNamingSource,
  TopicNode,
  DatasetIngest,
  DatasetIngestResult,
  DatasetQueryOptions,
  DatasetQueryResult,
  DatasetSummary,
} from '@omadia/plugin-api';

import type { CaptureFilter } from './captureFilter.js';

export interface CaptureFilteringKnowledgeGraphOptions {
  inner: KnowledgeGraph;
  filter: CaptureFilter;
  /** Optional log sink. Defaults to `console.error`. */
  log?: (msg: string) => void;
}

export class CaptureFilteringKnowledgeGraph implements KnowledgeGraph {
  private readonly inner: KnowledgeGraph;
  private readonly filter: CaptureFilter;
  private readonly log: (msg: string) => void;

  /**
   * Optional on the interface (plugin-api back-compat). Mirrors the inner
   * graph's support instead of fabricating a capped count: the route treats
   * absence as "backend cannot count" and the UI then warns instead of
   * rendering a confidently wrong total.
   */
  readonly countDatasets?: (opts: { ownerOmadiaUserId: string }) => Promise<number>;

  constructor(opts: CaptureFilteringKnowledgeGraphOptions) {
    this.inner = opts.inner;
    this.filter = opts.filter;
    this.log = opts.log ?? ((msg): void => console.error(msg));
    const innerCount = opts.inner.countDatasets?.bind(opts.inner);
    if (innerCount) this.countDatasets = innerCount;
  }

  async ingestTurn(turn: TurnIngest): Promise<TurnIngestResult> {
    const decision = await this.filter.classify({
      userMessage: turn.userMessage,
      assistantAnswer: turn.assistantAnswer,
    });

    if (!decision.persist) {
      // #1096 — sub-threshold: keep the conversation, drop the knowledge.
      // `entityRefs` are deliberately dropped with it — entity-anchored
      // recall is a knowledge path, and no CAPTURED edge means no way for a
      // tail-only turn to re-enter recall through the side door.
      this.log(
        `[capture-filter] turn tail-only (significance=${decision.significance?.toFixed(2) ?? 'null'}) reasons=[${decision.reasons.join('|')}]`,
      );
      const tailOnly: TurnIngest = {
        ...turn,
        userMessage: decision.cleanUserMessage,
        assistantAnswer: decision.cleanAssistantAnswer,
        entryType: decision.entryType,
        visibility: decision.visibility,
        significance: decision.significance,
        entityRefs: [],
        tailOnly: true,
      };
      // Not swallowed: a synthetic success would bypass the caller's own
      // failure handling and book the lost tail entry — the #1096 symptom —
      // under the wrong telemetry bucket (`run-ingest-failed`).
      return this.inner.ingestTurn(tailOnly);
    }

    const cleaned: TurnIngest = {
      ...turn,
      userMessage: decision.cleanUserMessage,
      assistantAnswer: decision.cleanAssistantAnswer,
      entryType: decision.entryType,
      visibility: decision.visibility,
      significance: decision.significance,
    };

    if (decision.reasons.length > 0) {
      this.log(
        `[capture-filter] turn classified entry_type=${decision.entryType} significance=${decision.significance?.toFixed(2) ?? 'null'} visibility=${decision.visibility} reasons=[${decision.reasons.join('|')}]`,
      );
    }

    return this.inner.ingestTurn(cleaned);
  }

  // -------------------------------------------------------------------------
  // Pass-through methods. The capture-filter only governs Turn-write. Every
  // other surface (entities, facts, search, runs, …) forwards verbatim to
  // the inner KG. We could codegen these from the interface, but explicit
  // forwards keep the wrapper greppable and the type system catches
  // additions.
  // -------------------------------------------------------------------------

  ingestEntities(entities: EntityIngest[]): Promise<EntityIngestResult> {
    return this.inner.ingestEntities(entities);
  }

  ingestFacts(facts: FactIngest[]): Promise<FactIngestResult> {
    return this.inner.ingestFacts(facts);
  }

  ingestRun(trace: RunTrace): Promise<RunIngestResult> {
    return this.inner.ingestRun(trace);
  }

  ingestPlan(input: PlanIngest): Promise<PlanIngestResult> {
    return this.inner.ingestPlan(input);
  }

  upsertPlanStep(input: PlanStepIngest): Promise<PlanStepIngestResult> {
    return this.inner.upsertPlanStep(input);
  }

  getPlan(planExternalId: string): Promise<GraphNode | null> {
    return this.inner.getPlan(planExternalId);
  }

  getPlanSteps(planExternalId: string): Promise<GraphNode[]> {
    return this.inner.getPlanSteps(planExternalId);
  }

  getPlanStepsForPlans(
    planExternalIds: string[],
  ): Promise<Map<string, GraphNode[]>> {
    return this.inner.getPlanStepsForPlans(planExternalIds);
  }

  setPlanStepStatus(
    stepExternalId: string,
    status: PlanStepStatus,
    opts?: { resultSummary?: string },
  ): Promise<void> {
    return this.inner.setPlanStepStatus(stepExternalId, status, opts);
  }

  listPlansForScope(scope: string): Promise<GraphNode[]> {
    return this.inner.listPlansForScope(scope);
  }

  deletePlan(planExternalId: string): Promise<PlanDeleteResult> {
    return this.inner.deletePlan(planExternalId);
  }

  listRecentPlans(opts: {
    userId?: string;
    limit?: number;
    openOnly?: boolean;
  }): Promise<GraphNode[]> {
    return this.inner.listRecentPlans(opts);
  }

  getRunForTurn(turnExternalId: string): Promise<RunTraceView | null> {
    return this.inner.getRunForTurn(turnExternalId);
  }

  getSession(scope: string): Promise<SessionView | null> {
    return this.inner.getSession(scope);
  }

  listSessions(filter?: SessionFilter): Promise<SessionSummary[]> {
    return this.inner.listSessions(filter);
  }

  getNeighbors(nodeId: string): Promise<GraphNode[]> {
    return this.inner.getNeighbors(nodeId);
  }

  stats(): Promise<GraphStats> {
    return this.inner.stats();
  }

  searchTurns(opts: SearchTurnsOptions): Promise<TurnSearchHit[]> {
    return this.inner.searchTurns(opts);
  }

  findEntityCapturedTurns(
    opts: EntityCapturedTurnsOptions,
  ): Promise<EntityCapturedTurnsHit[]> {
    return this.inner.findEntityCapturedTurns(opts);
  }

  searchTurnsByEmbedding(
    opts: SearchTurnsByEmbeddingOptions,
  ): Promise<TurnSearchHit[]> {
    return this.inner.searchTurnsByEmbedding(opts);
  }

  findEntities(opts: FindEntitiesOptions): Promise<GraphNode[]> {
    return this.inner.findEntities(opts);
  }

  resolveOrCreateChannelIdentity(
    ingest: ChannelIdentityIngest,
  ): Promise<ResolveOrCreateChannelIdentityResult> {
    return this.inner.resolveOrCreateChannelIdentity(ingest);
  }

  createMemorableKnowledge(
    input: MemorableKnowledgeIngest,
  ): Promise<MemorableKnowledgeIngestResult> {
    return this.inner.createMemorableKnowledge(input);
  }

  getMemorableKnowledge(
    memorableKnowledgeNodeId: string,
    viewerOmadiaUserId?: string,
  ): Promise<GraphNode | null> {
    return this.inner.getMemorableKnowledge(
      memorableKnowledgeNodeId,
      viewerOmadiaUserId,
    );
  }

  listMemorableKnowledgeFor(
    omadiaUserId: string,
    opts?: ListMemorableKnowledgeOptions,
  ): Promise<GraphNode[]> {
    return this.inner.listMemorableKnowledgeFor(omadiaUserId, opts);
  }

  addOwner(
    memorableKnowledgeNodeId: string,
    omadiaUserIdToAdd: string,
    actor: AclMutationOptions,
  ): Promise<string[]> {
    return this.inner.addOwner(
      memorableKnowledgeNodeId,
      omadiaUserIdToAdd,
      actor,
    );
  }

  removeOwner(
    memorableKnowledgeNodeId: string,
    omadiaUserIdToRemove: string,
    actor: AclMutationOptions,
  ): Promise<string[]> {
    return this.inner.removeOwner(
      memorableKnowledgeNodeId,
      omadiaUserIdToRemove,
      actor,
    );
  }

  deleteMemory(
    memorableKnowledgeNodeId: string,
    actor: AclMutationOptions,
  ): Promise<void> {
    return this.inner.deleteMemory(memorableKnowledgeNodeId, actor);
  }

  countMemorableKnowledge(
    filter: MemorableKnowledgePurgeFilter,
  ): Promise<{ count: number }> {
    return this.inner.countMemorableKnowledge(filter);
  }

  purgeMemorableKnowledge(
    filter: MemorableKnowledgePurgeFilter,
  ): Promise<{ deletedNodes: number }> {
    return this.inner.purgeMemorableKnowledge(filter);
  }

  listMemoryAclAudit(
    memorableKnowledgeNodeId: string,
    opts?: { limit?: number },
  ): Promise<AclAuditEntry[]> {
    return this.inner.listMemoryAclAudit(memorableKnowledgeNodeId, opts);
  }

  updateMemorableKnowledge(
    memorableKnowledgeNodeId: string,
    patch: MemorableKnowledgeUpdate,
    actor: AclMutationOptions,
  ): Promise<GraphNode> {
    return this.inner.updateMemorableKnowledge(
      memorableKnowledgeNodeId,
      patch,
      actor,
    );
  }

  listExcerptsForMemory(
    memorableKnowledgeNodeId: string,
  ): Promise<PalaiaExcerptNode[]> {
    return this.inner.listExcerptsForMemory(memorableKnowledgeNodeId);
  }

  updateExcerpt(
    memorableKnowledgeNodeId: string,
    position: number,
    patch: PalaiaExcerptUpdate,
    actor: AclMutationOptions,
  ): Promise<PalaiaExcerptNode> {
    return this.inner.updateExcerpt(
      memorableKnowledgeNodeId,
      position,
      patch,
      actor,
    );
  }

  searchMemorableKnowledgeByEmbedding(
    opts: MemorableKnowledgeSearchOptions,
  ): Promise<MemorableKnowledgeHit[]> {
    return this.inner.searchMemorableKnowledgeByEmbedding(opts);
  }

  searchExcerptsByEmbedding(
    opts: ExcerptSearchOptions,
  ): Promise<PalaiaExcerptHit[]> {
    return this.inner.searchExcerptsByEmbedding(opts);
  }

  listInconsistencies(
    opts: ListInconsistenciesOptions,
  ): Promise<InconsistencyNode[]> {
    return this.inner.listInconsistencies(opts);
  }

  getInconsistency(
    inconsistencyExternalId: string,
    viewerOmadiaUserId: string,
  ): Promise<InconsistencyNode | null> {
    return this.inner.getInconsistency(
      inconsistencyExternalId,
      viewerOmadiaUserId,
    );
  }

  createInconsistency(
    input: CreateInconsistencyInput,
  ): Promise<InconsistencyNode | null> {
    return this.inner.createInconsistency(input);
  }

  resolveInconsistency(
    inconsistencyExternalId: string,
    resolution: InconsistencyResolution,
    actor: AclMutationOptions,
  ): Promise<InconsistencyNode> {
    return this.inner.resolveInconsistency(
      inconsistencyExternalId,
      resolution,
      actor,
    );
  }

  listMemoriesForScope(
    scope: string | undefined,
    opts?: ListMemoriesForScopeOptions,
  ): Promise<MemoriesProvenanceView> {
    return this.inner.listMemoriesForScope(scope, opts);
  }

  getMemorableKnowledgeSubgraph(
    rootExternalIds: string[],
    opts?: { maxHops?: number; maxNodes?: number },
  ): Promise<{ nodes: KgWalkNode[]; edges: KgWalkEdge[] }> {
    return this.inner.getMemorableKnowledgeSubgraph(rootExternalIds, opts);
  }

  listMemorableKnowledgeIdsForBulkInconsistencyCheck(opts: {
    limit: number;
  }): Promise<string[]> {
    return this.inner.listMemorableKnowledgeIdsForBulkInconsistencyCheck(opts);
  }

  countMemorableKnowledgeInconsistencyCheckBuckets(): Promise<{
    unchecked: number;
    alreadyChecked: number;
    withoutEmbedding: number;
  }> {
    return this.inner.countMemorableKnowledgeInconsistencyCheckBuckets();
  }

  markMemorableKnowledgeInconsistencyChecked(
    memorableKnowledgeNodeId: string,
  ): Promise<void> {
    return this.inner.markMemorableKnowledgeInconsistencyChecked(
      memorableKnowledgeNodeId,
    );
  }

  listMergeCandidates(
    opts: ListMergeCandidatesOptions,
  ): Promise<MergeCandidateNode[]> {
    return this.inner.listMergeCandidates(opts);
  }

  getMergeCandidate(
    mergeCandidateExternalId: string,
    viewerOmadiaUserId: string,
  ): Promise<MergeCandidateNode | null> {
    return this.inner.getMergeCandidate(
      mergeCandidateExternalId,
      viewerOmadiaUserId,
    );
  }

  createMergeCandidate(
    input: CreateMergeCandidateInput,
  ): Promise<MergeCandidateNode | null> {
    return this.inner.createMergeCandidate(input);
  }

  resolveMergeCandidate(
    mergeCandidateExternalId: string,
    resolution: MergeCandidateResolution,
    actor: AclMutationOptions,
  ): Promise<MergeCandidateNode> {
    return this.inner.resolveMergeCandidate(
      mergeCandidateExternalId,
      resolution,
      actor,
    );
  }

  listMemorableKnowledgeIdsForBulkMergeCheck(opts: {
    limit: number;
  }): Promise<string[]> {
    return this.inner.listMemorableKnowledgeIdsForBulkMergeCheck(opts);
  }

  countMemorableKnowledgeMergeCheckBuckets(): Promise<{
    unchecked: number;
    alreadyChecked: number;
    withoutEmbedding: number;
  }> {
    return this.inner.countMemorableKnowledgeMergeCheckBuckets();
  }

  markMemorableKnowledgeMergeChecked(
    memorableKnowledgeNodeId: string,
  ): Promise<void> {
    return this.inner.markMemorableKnowledgeMergeChecked(
      memorableKnowledgeNodeId,
    );
  }

  listTopics(): Promise<TopicNode[]> {
    return this.inner.listTopics();
  }

  getTopic(topicExternalId: string): Promise<TopicNode | null> {
    return this.inner.getTopic(topicExternalId);
  }

  listTopicMembers(topicExternalId: string): Promise<GraphNode[]> {
    return this.inner.listTopicMembers(topicExternalId);
  }

  listMemorableKnowledgeWithEmbeddings(): Promise<
    Array<{ mk: GraphNode; embedding: number[] }>
  > {
    return this.inner.listMemorableKnowledgeWithEmbeddings();
  }

  deleteAllTopics(): Promise<number> {
    return this.inner.deleteAllTopics();
  }

  createTopic(input: {
    name: string;
    description: string;
    namingSource: TopicNamingSource;
    memberMkIds: readonly string[];
  }): Promise<TopicNode> {
    return this.inner.createTopic(input);
  }

  listTopicMembershipEdges(): Promise<Array<{ from: string; to: string }>> {
    return this.inner.listTopicMembershipEdges();
  }

  listAllIssues(opts?: { status?: InconsistencyStatus }): Promise<{
    inconsistencies: InconsistencyNode[];
    mergeCandidates: MergeCandidateNode[];
    excerptMergeCandidates: ExcerptMergeCandidateNode[];
    edges: Array<{
      from: string;
      to: string;
      type: 'CONFLICTS_WITH' | 'DUPLICATE_OF' | 'DUPLICATE_EXCERPT_OF';
    }>;
  }> {
    return this.inner.listAllIssues(opts);
  }

  // Slice 12 delegates
  listExcerptMergeCandidates(
    opts: ListExcerptMergeCandidatesOptions,
  ): Promise<ExcerptMergeCandidateNode[]> {
    return this.inner.listExcerptMergeCandidates(opts);
  }
  getExcerptMergeCandidate(
    externalId: string,
    viewerOmadiaUserId: string,
  ): Promise<ExcerptMergeCandidateNode | null> {
    return this.inner.getExcerptMergeCandidate(externalId, viewerOmadiaUserId);
  }
  createExcerptMergeCandidate(
    input: CreateExcerptMergeCandidateInput,
  ): Promise<ExcerptMergeCandidateNode | null> {
    return this.inner.createExcerptMergeCandidate(input);
  }
  resolveExcerptMergeCandidate(
    externalId: string,
    resolution: ExcerptMergeResolution,
    actor: AclMutationOptions,
  ): Promise<ExcerptMergeCandidateNode> {
    return this.inner.resolveExcerptMergeCandidate(
      externalId,
      resolution,
      actor,
    );
  }
  deleteExcerpt(
    memorableKnowledgeNodeId: string,
    position: number,
    actor: AclMutationOptions,
  ): Promise<void> {
    return this.inner.deleteExcerpt(memorableKnowledgeNodeId, position, actor);
  }
  listPalaiaExcerptIdsForBulkMergeCheck(opts: {
    limit: number;
  }): Promise<string[]> {
    return this.inner.listPalaiaExcerptIdsForBulkMergeCheck(opts);
  }
  countPalaiaExcerptMergeCheckBuckets(): Promise<{
    unchecked: number;
    alreadyChecked: number;
    withoutEmbedding: number;
  }> {
    return this.inner.countPalaiaExcerptMergeCheckBuckets();
  }
  markPalaiaExcerptMergeChecked(excerptExternalId: string): Promise<void> {
    return this.inner.markPalaiaExcerptMergeChecked(excerptExternalId);
  }

  // #430 — structured dataset ingestion. Not turn-shaped, so the
  // capture-filter has nothing to classify here; forwards verbatim.
  ingestDataset(input: DatasetIngest): Promise<DatasetIngestResult> {
    return this.inner.ingestDataset(input);
  }
  listDatasets(opts: {
    ownerOmadiaUserId: string;
    limit?: number;
    offset?: number;
  }): Promise<DatasetSummary[]> {
    return this.inner.listDatasets(opts);
  }
  getDataset(
    datasetId: string,
    viewerOmadiaUserId: string,
  ): Promise<DatasetSummary | null> {
    return this.inner.getDataset(datasetId, viewerOmadiaUserId);
  }
  queryDatasetRows(
    datasetId: string,
    viewerOmadiaUserId: string,
    opts?: DatasetQueryOptions,
  ): Promise<DatasetQueryResult | null> {
    return this.inner.queryDatasetRows(datasetId, viewerOmadiaUserId, opts);
  }
  deleteDataset(
    datasetId: string,
    actor: AclMutationOptions,
  ): Promise<boolean> {
    return this.inner.deleteDataset(datasetId, actor);
  }
}
