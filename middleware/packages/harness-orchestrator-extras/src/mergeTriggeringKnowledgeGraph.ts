/**
 * @omadia/orchestrator-extras — KG wrapper that fires the
 * MergeCandidate-Detector after every MemorableKnowledge mutation
 * (Slice 10).
 *
 * Symmetric to `InconsistencyTriggeringKnowledgeGraph` (Slice 9):
 * decorates the same three mutation points (createMK, updateMK,
 * resolveInconsistency a_wins/b_wins) plus `resolveMergeCandidate`
 * itself when `keep_a` / `keep_b` deletes the loser → may change the
 * near-duplicate landscape on the surviving MK. Detection is
 * fire-and-forget.
 *
 * Wrapper-Stack on `activate()` (outer → inner):
 *   MergeTrigger → InconsistencyTrigger → CaptureFilter → original
 *
 * That way both triggers fire on the same set of mutations and the
 * `services.replace` chain stays symmetric on dispose. The merge-
 * detector runs AFTER the inconsistency-detector, which is fine since
 * they don't depend on each other's output.
 */

import type {
  AclAuditEntry,
  AclMutationOptions,
  ChannelIdentityIngest,
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
  PlanStepIngest,
  PlanStepIngestResult,
  GraphStats,
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
  MergeCandidateDetectorService,
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

export interface MergeTriggeringKnowledgeGraphOptions {
  inner: KnowledgeGraph;
  detector: MergeCandidateDetectorService;
  log?: (msg: string) => void;
}

export class MergeTriggeringKnowledgeGraph implements KnowledgeGraph {
  private readonly inner: KnowledgeGraph;
  private readonly detector: MergeCandidateDetectorService;
  private readonly log: (msg: string) => void;

  constructor(opts: MergeTriggeringKnowledgeGraphOptions) {
    this.inner = opts.inner;
    this.detector = opts.detector;
    this.log = opts.log ?? ((msg: string): void => { console.error(msg); });
  }

  private fire(mkId: string): void {
    void this.detector
      .detectFor(mkId)
      .then((stats) => {
        if (stats.mergeCandidatesCreated > 0) {
          this.log(
            `[merge-trigger] ${mkId}: scanned=${String(stats.candidatesScanned)} created=${String(stats.mergeCandidatesCreated)}`,
          );
        }
      })
      .catch((err: unknown) => {
        this.log(
          `[merge-trigger] ${mkId}: detector failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  /** Slice 12 — fire the excerpt-side merge detector. */
  private fireExcerpt(excerptId: string): void {
    void this.detector
      .detectForExcerpt(excerptId)
      .then((stats) => {
        if (stats.excerptMergeCandidatesCreated > 0) {
          this.log(
            `[merge-trigger-excerpt] ${excerptId}: scanned=${String(stats.candidatesScanned)} created=${String(stats.excerptMergeCandidatesCreated)}`,
          );
        }
      })
      .catch((err: unknown) => {
        this.log(
          `[merge-trigger-excerpt] ${excerptId}: detector failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  // ─── Decorated MK mutations ──────────────────────────────────────

  async createMemorableKnowledge(
    input: MemorableKnowledgeIngest,
  ): Promise<MemorableKnowledgeIngestResult> {
    const result = await this.inner.createMemorableKnowledge(input);
    this.fire(result.memorableKnowledgeNodeId);
    // Slice 12 — also fire the excerpt detector for each excerpt the
    // batch produced (the MemorableKnowledgeIngestResult doesn't carry
    // their ids back, so we list them post-COMMIT from the KG). Skips
    // silently when the MK had no excerpts.
    if (input.palaiaExcerpts && input.palaiaExcerpts.texts.length > 0) {
      void this.inner
        .listExcerptsForMemory(result.memorableKnowledgeNodeId)
        .then((excerpts) => {
          for (const e of excerpts) this.fireExcerpt(e.id);
        })
        .catch((err: unknown) => {
          this.log(
            `[merge-trigger-excerpt] listExcerpts failed for ${result.memorableKnowledgeNodeId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }
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

  // Slice 12 — Excerpt-level mutations. updateExcerpt is the natural
  // post-COMMIT hook; resolveExcerptMergeCandidate keep_a/keep_b
  // re-fires the surviving excerpt.
  async updateExcerpt(
    memorableKnowledgeNodeId: string,
    position: number,
    patch: PalaiaExcerptUpdate,
    actor: AclMutationOptions,
  ): Promise<PalaiaExcerptNode> {
    const result = await this.inner.updateExcerpt(
      memorableKnowledgeNodeId,
      position,
      patch,
      actor,
    );
    this.fireExcerpt(result.id);
    return result;
  }

  async resolveExcerptMergeCandidate(
    excerptMergeCandidateExternalId: string,
    resolution: ExcerptMergeResolution,
    actor: AclMutationOptions,
  ): Promise<ExcerptMergeCandidateNode> {
    const result = await this.inner.resolveExcerptMergeCandidate(
      excerptMergeCandidateExternalId,
      resolution,
      actor,
    );
    if (resolution === 'keep_a') this.fireExcerpt(result.duplicateExcerptOf[0]);
    else if (resolution === 'keep_b') this.fireExcerpt(result.duplicateExcerptOf[1]);
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
    // a_wins / b_wins delete the loser → re-fire merge detection on
    // the survivor in case the surviving MK has a new near-duplicate
    // landscape (rare but possible).
    if (resolution === 'a_wins') this.fire(result.conflictsWith[0]);
    else if (resolution === 'b_wins') this.fire(result.conflictsWith[1]);
    return result;
  }

  async resolveMergeCandidate(
    mergeCandidateExternalId: string,
    resolution: MergeCandidateResolution,
    actor: AclMutationOptions,
  ): Promise<MergeCandidateNode> {
    const result = await this.inner.resolveMergeCandidate(
      mergeCandidateExternalId,
      resolution,
      actor,
    );
    if (resolution === 'keep_a') this.fire(result.duplicateOf[0]);
    else if (resolution === 'keep_b') this.fire(result.duplicateOf[1]);
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
  // updateExcerpt is decorated above (Slice 12); no passthrough entry.
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

  // Slice 12 — Excerpt-side delegates. The MergeTriggering wrapper
  // additionally decorates `updateExcerpt` so the merge-detector fires
  // for the freshly updated excerpt (see the override above the
  // passthrough block when Slice 12 detector is wired).
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
  // resolveExcerptMergeCandidate is decorated above (Slice 12); no
  // passthrough entry.
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
