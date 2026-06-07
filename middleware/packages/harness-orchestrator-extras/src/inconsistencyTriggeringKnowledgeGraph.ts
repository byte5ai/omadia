/**
 * @omadia/orchestrator-extras — KG wrapper that fires the
 * Inconsistency-Detector after every MemorableKnowledge mutation
 * (Slice 9).
 *
 * Decorates `createMemorableKnowledge`, `updateMemorableKnowledge`,
 * and `resolveInconsistency` (a_wins / b_wins delete the loser → may
 * change the inconsistency landscape on the surviving MK). Detection
 * is fire-and-forget: the caller's promise resolves with the original
 * result; the detector runs detached on the event loop.
 *
 * Wired in `activate()` AFTER CaptureFilteringKnowledgeGraph so the
 * detect call sees the same filtered KG as live recall — and so a
 * `services.replace` chain stays symmetric on dispose.
 */

import type {
  AclAuditEntry,
  AclMutationOptions,
  ChannelIdentityIngest,
  MemorableKnowledgePurgeFilter,
  CreateInconsistencyInput,
  CreateExcerptMergeCandidateInput,
  CreateMergeCandidateInput,
  ExcerptMergeCandidateNode,
  ExcerptMergeResolution,
  ListExcerptMergeCandidatesOptions,
  EntityCapturedTurnsHit,
  EntityCapturedTurnsOptions,
  EntityIngest,
  EntityIngestResult,
  ExcerptSearchOptions,
  FactIngest,
  FactIngestResult,
  FindEntitiesOptions,
  GraphNode,
  PlanIngest,
  PlanIngestResult,
  PlanDeleteResult,
  PlanStepIngest,
  PlanStepIngestResult,
  PlanStepStatus,
  GraphStats,
  InconsistencyDetectorService,
  InconsistencyNode,
  InconsistencyResolution,
  InconsistencyStatus,
  KnowledgeGraph,
  ListInconsistenciesOptions,
  ListMemoriesForScopeOptions,
  ListMemorableKnowledgeOptions,
  ListMergeCandidatesOptions,
  MemoriesProvenanceView,
  MemorableKnowledgeHit,
  MemorableKnowledgeIngest,
  MemorableKnowledgeIngestResult,
  MemorableKnowledgeSearchOptions,
  MemorableKnowledgeUpdate,
  MergeCandidateNode,
  MergeCandidateResolution,
  TopicNamingSource,
  TopicNode,
  PalaiaExcerptHit,
  PalaiaExcerptNode,
  PalaiaExcerptUpdate,
  ResolveOrCreateChannelIdentityResult,
  RunIngestResult,
  RunTrace,
  RunTraceView,
  SearchTurnsByEmbeddingOptions,
  SearchTurnsOptions,
  SessionFilter,
  SessionSummary,
  SessionView,
  TurnIngest,
  TurnIngestResult,
  TurnSearchHit,
} from '@omadia/plugin-api';

export interface InconsistencyTriggeringKnowledgeGraphOptions {
  inner: KnowledgeGraph;
  detector: InconsistencyDetectorService;
  log?: (msg: string) => void;
}

export class InconsistencyTriggeringKnowledgeGraph implements KnowledgeGraph {
  private readonly inner: KnowledgeGraph;
  private readonly detector: InconsistencyDetectorService;
  private readonly log: (msg: string) => void;

  constructor(opts: InconsistencyTriggeringKnowledgeGraphOptions) {
    this.inner = opts.inner;
    this.detector = opts.detector;
    this.log = opts.log ?? ((msg: string): void => { console.error(msg); });
  }

  private fire(mkId: string): void {
    void this.detector
      .detectFor(mkId)
      .then((stats) => {
        if (stats.inconsistenciesCreated > 0) {
          this.log(
            `[inconsistency-trigger] ${mkId}: scanned=${String(stats.candidatesScanned)} created=${String(stats.inconsistenciesCreated)}`,
          );
        }
      })
      .catch((err: unknown) => {
        this.log(
          `[inconsistency-trigger] ${mkId}: detector failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  // ─── Decorated MK mutations ──────────────────────────────────────

  async createMemorableKnowledge(
    input: MemorableKnowledgeIngest,
  ): Promise<MemorableKnowledgeIngestResult> {
    const result = await this.inner.createMemorableKnowledge(input);
    this.fire(result.memorableKnowledgeNodeId);
    return result;
  }

  async updateMemorableKnowledge(
    memorableKnowledgeNodeId: string,
    patch: MemorableKnowledgeUpdate,
    actor: AclMutationOptions,
  ): Promise<GraphNode> {
    const result = await this.inner.updateMemorableKnowledge(
      memorableKnowledgeNodeId,
      patch,
      actor,
    );
    this.fire(memorableKnowledgeNodeId);
    return result;
  }

  async resolveInconsistency(
    inconsistencyExternalId: string,
    resolution: InconsistencyResolution,
    actor: AclMutationOptions,
  ): Promise<InconsistencyNode> {
    const result = await this.inner.resolveInconsistency(
      inconsistencyExternalId,
      resolution,
      actor,
    );
    if (resolution === 'a_wins') this.fire(result.conflictsWith[0]);
    else if (resolution === 'b_wins') this.fire(result.conflictsWith[1]);
    return result;
  }

  // ─── Pure passthroughs ───────────────────────────────────────────

  ingestTurn(turn: TurnIngest): Promise<TurnIngestResult> {
    return this.inner.ingestTurn(turn);
  }
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
  searchTurns(opts: SearchTurnsOptions): Promise<TurnSearchHit[]> {
    return this.inner.searchTurns(opts);
  }
  searchTurnsByEmbedding(
    opts: SearchTurnsByEmbeddingOptions,
  ): Promise<TurnSearchHit[]> {
    return this.inner.searchTurnsByEmbedding(opts);
  }
  findEntities(opts: FindEntitiesOptions): Promise<GraphNode[]> {
    return this.inner.findEntities(opts);
  }
  findEntityCapturedTurns(
    opts: EntityCapturedTurnsOptions,
  ): Promise<EntityCapturedTurnsHit[]> {
    return this.inner.findEntityCapturedTurns(opts);
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
  resolveOrCreateChannelIdentity(
    ingest: ChannelIdentityIngest,
  ): Promise<ResolveOrCreateChannelIdentityResult> {
    return this.inner.resolveOrCreateChannelIdentity(ingest);
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
    return this.inner.addOwner(memorableKnowledgeNodeId, omadiaUserIdToAdd, actor);
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
  listMemoriesForScope(
    scope: string | undefined,
    opts?: ListMemoriesForScopeOptions,
  ): Promise<MemoriesProvenanceView> {
    return this.inner.listMemoriesForScope(scope, opts);
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
    return this.inner.resolveExcerptMergeCandidate(externalId, resolution, actor);
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
}
