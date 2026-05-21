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
  CreateInconsistencyInput,
  EntityCapturedTurnsHit,
  EntityCapturedTurnsOptions,
  EntityIngest,
  EntityIngestResult,
  ExcerptSearchOptions,
  FactIngest,
  FactIngestResult,
  FindEntitiesOptions,
  GraphNode,
  GraphStats,
  InconsistencyDetectorService,
  InconsistencyNode,
  InconsistencyResolution,
  KnowledgeGraph,
  ListInconsistenciesOptions,
  ListMemoriesForScopeOptions,
  ListMemorableKnowledgeOptions,
  MemoriesProvenanceView,
  MemorableKnowledgeHit,
  MemorableKnowledgeIngest,
  MemorableKnowledgeIngestResult,
  MemorableKnowledgeSearchOptions,
  MemorableKnowledgeUpdate,
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
}
