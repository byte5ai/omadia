import { randomUUID } from 'node:crypto';

import {
  agentInvocationNodeId,
  channelIdentityNodeId,
  entityNodeId,
  excerptMergeCandidateNodeId,
  inconsistencyNodeId,
  memorableKnowledgeNodeId,
  mergeCandidateNodeId,
  palaiaExcerptNodeId,
  planNodeId,
  planStepNodeId,
  runNodeId,
  sessionNodeId,
  toolCallNodeId,
  topicNodeId,
  turnNodeId,
  userNodeId,
  type ChannelIdentityIngest,
  type CreateMergeCandidateInput,
  type EntityRef,
  type EntityCapturedTurnsHit,
  type EntityCapturedTurnsOptions,
  type EntityIngest,
  type EntityIngestResult,
  type FactIngest,
  type FactIngestResult,
  type FindEntitiesOptions,
  type GraphEdge,
  type GraphEdgeType,
  type GraphNode,
  type GraphNodeType,
  type GraphStats,
  type KnowledgeGraph,
  type AclAction,
  type AclAuditEntry,
  type AclMutationOptions,
  type ListMemorableKnowledgeOptions,
  type ListMergeCandidatesOptions,
  type CreateInconsistencyInput,
  type ExcerptSearchOptions,
  type ExcerptSource,
  type InconsistencyNode,
  type InconsistencyResolution,
  type InconsistencyStatus,
  type ListInconsistenciesOptions,
  type ListMemoriesForScopeOptions,
  type MemorableKnowledgeHit,
  type MemoriesProvenanceView,
  type MemoryProvenanceEdge,
  type MemoryWithAncestors,
  type MemorableKnowledgeIngest,
  type MemorableKnowledgeIngestResult,
  type MemorableKnowledgePurgeFilter,
  type MemorableKnowledgeSearchOptions,
  type MemorableKnowledgeUpdate,
  type MergeCandidateNode,
  type MergeCandidateResolution,
  type MergeCandidateStatus,
  type CreateExcerptMergeCandidateInput,
  type ExcerptMergeCandidateNode,
  type ExcerptMergeResolution,
  type ExcerptMergeStatus,
  type ListExcerptMergeCandidatesOptions,
  type TopicNamingSource,
  type TopicNode,
  type PalaiaExcerptHit,
  type PalaiaExcerptInput,
  type PalaiaExcerptNode,
  type PalaiaExcerptUpdate,
  type ResolveOrCreateChannelIdentityResult,
  type RunAgentInvocationView,
  type RunIngestResult,
  type RunToolCallView,
  type PlanIngest,
  type PlanIngestResult,
  type PlanDeleteResult,
  type PlanStepIngest,
  type PlanStepIngestResult,
  type PlanStepStatus,
  type RunTrace,
  type RunTraceView,
  type SearchTurnsByEmbeddingOptions,
  type SearchTurnsOptions,
  type SessionFilter,
  type SessionSummary,
  type SessionView,
  type TurnIngest,
  type TurnIngestResult,
  type TurnSearchHit,
} from '@omadia/plugin-api';

/**
 * Per-orchestrator KG isolation parity with the Neon backend's
 * `scope LIKE $prefix || '%' OR ($prefix='default::' AND scope NOT LIKE '%::%')`
 * clause. Returns true when the scope belongs to the Agent identified by
 * `prefix` (`<agentSlug>::`). `undefined` prefix = legacy cross-agent view
 * (matches everything). The `default::` branch admits legacy unqualified
 * scopes (no `::` separator) so pre-isolation data stays reachable.
 */
function matchesAgentScopePrefix(
  scope: string,
  prefix: string | undefined,
): boolean {
  if (!prefix) return true;
  if (scope.startsWith(prefix)) return true;
  if (prefix === 'default::' && !scope.includes('::')) return true;
  return false;
}

/**
 * In-memory knowledge graph. Lives in the middleware process, lost on
 * restart — the session transcripts on disk remain the source of truth, a
 * backfill job can rebuild the graph on demand. Good enough for local dev,
 * tests, and the first round of UI work. Swap for an embedded or remote
 * store once the data model stabilises.
 */
export class InMemoryKnowledgeGraph implements KnowledgeGraph {
  private readonly nodes = new Map<string, GraphNode>();
  /** `from|type|to` → edge. Dedupes multi-ingest of the same turn. */
  private readonly edges = new Map<string, GraphEdge>();
  /** For each session, the chronologically ordered turn-ids. */
  private readonly sessionTurns = new Map<string, string[]>();
  /** Slice 3 — per-memory append-only ACL audit log. */
  private readonly aclAudit = new Map<string, AclAuditEntry[]>();

  /** Slice 7 — embedding cache keyed by node externalId. The InMemory
   *  backend has no `embedding` column on its node bag, so we keep a
   *  parallel map. Tests can seed entries directly via `setEmbedding`
   *  for cosine-search round-trips without an embedding provider. */
  private readonly embeddings = new Map<string, number[]>();

  /** Slice 7 — test/seed helper to attach a vector to an existing
   *  node. Mirrors a successful Neon backfill row. Does NOT validate
   *  the node exists; callers are tests in control of the substrate. */
  setEmbedding(externalId: string, vector: number[]): void {
    this.embeddings.set(externalId, [...vector]);
  }

  async ingestTurn(turn: TurnIngest): Promise<TurnIngestResult> {
    const sessionId = sessionNodeId(turn.scope);
    const turnId = turnNodeId(turn.scope, turn.time);

    this.upsertNode({
      id: sessionId,
      type: 'Session',
      props: {
        scope: turn.scope,
        ...(turn.userId ? { userId: turn.userId } : {}),
      },
    });

    this.upsertNode({
      id: turnId,
      type: 'Turn',
      props: {
        scope: turn.scope,
        time: turn.time,
        userMessage: turn.userMessage,
        assistantAnswer: turn.assistantAnswer,
        toolCalls: turn.toolCalls,
        iterations: turn.iterations,
        ...(turn.userId ? { userId: turn.userId } : {}),
      },
      // Palaia (OB-70 / OB-71) — mirror the Neon DB defaults on Turn
      // ingest so the in-memory backend exposes the same axes to consumers.
      // Nullable axes (accessedAt/contentHash/taskStatus) stay null. From
      // OB-71 the optional `entryType`/`visibility`/`significance` fields
      // on `TurnIngest` carry the CaptureFilter verdict; we fall back to
      // the legacy defaults when the orchestrator skipped the filter.
      entryType: turn.entryType ?? 'memory',
      visibility: turn.visibility ?? 'team',
      tier: 'HOT',
      accessedAt: null,
      accessCount: 0,
      decayScore: 1.0,
      contentHash: null,
      manuallyAuthored: false,
      taskStatus: null,
      significance: turn.significance ?? null,
    });

    this.addEdge({ type: 'IN_SESSION', from: turnId, to: sessionId });

    // Chronological chain. We preserve insertion order per session; if a
    // turn lands out-of-order (shouldn't happen with the session logger but
    // defensive matters), we still link it to the previous-by-time turn
    // rather than always to the last-inserted.
    const existing = this.sessionTurns.get(sessionId) ?? [];
    const sorted = [...existing, turnId].sort((a, b) => {
      const ta = this.nodes.get(a)?.props['time'] as string | undefined;
      const tb = this.nodes.get(b)?.props['time'] as string | undefined;
      return (ta ?? '').localeCompare(tb ?? '');
    });
    this.sessionTurns.set(sessionId, sorted);

    // Rebuild NEXT_TURN edges for this session. Drop any stale edges from a
    // previous ingest first — an out-of-order turn can render prior NEXT_TURN
    // links obsolete (e.g. t=12 → t=11 got inserted, need to repoint the chain).
    const turnSet = new Set(sorted);
    for (const [key, edge] of this.edges) {
      if (edge.type === 'NEXT_TURN' && turnSet.has(edge.from) && turnSet.has(edge.to)) {
        this.edges.delete(key);
      }
    }
    for (let i = 0; i < sorted.length - 1; i++) {
      const from = sorted[i];
      const to = sorted[i + 1];
      if (from && to) this.addEdge({ type: 'NEXT_TURN', from, to });
    }

    const entityNodeIds: string[] = [];
    for (const ref of turn.entityRefs) {
      const nodeId = entityNodeId(ref);
      entityNodeIds.push(nodeId);
      this.upsertEntityNode(nodeId, ref);
      this.addEdge({ type: 'CAPTURED', from: turnId, to: nodeId });
    }

    return { sessionId, turnId, entityNodeIds };
  }

  async getRunForTurn(turnExternalId: string): Promise<RunTraceView | null> {
    const turn = this.nodes.get(turnExternalId);
    if (!turn || turn.type !== 'Turn') return null;
    const runId = runNodeId(turnExternalId);
    const run = this.nodes.get(runId);
    if (!run) return null;

    // Pick the User the turn belongs to (BELONGS_TO edge).
    let user: GraphNode | undefined;
    for (const edge of this.edges.values()) {
      if (edge.type === 'BELONGS_TO' && edge.from === turnExternalId) {
        const u = this.nodes.get(edge.to);
        if (u && u.type === 'User') {
          user = u;
          break;
        }
      }
    }

    const collectProduced = (toolCallId: string): GraphNode[] => {
      const out: GraphNode[] = [];
      for (const edge of this.edges.values()) {
        if (edge.type === 'PRODUCED' && edge.from === toolCallId) {
          const n = this.nodes.get(edge.to);
          if (n) out.push(n);
        }
      }
      return out;
    };

    const orchestratorToolCalls: RunToolCallView[] = [];
    const agentInvocationIds: string[] = [];
    for (const edge of this.edges.values()) {
      if (edge.from !== runId) continue;
      if (edge.type === 'INVOKED_TOOL') {
        const tc = this.nodes.get(edge.to);
        if (tc) {
          orchestratorToolCalls.push({
            node: tc,
            producedEntities: collectProduced(edge.to),
          });
        }
      } else if (edge.type === 'INVOKED_AGENT') {
        agentInvocationIds.push(edge.to);
      }
    }
    // Stable order: respect stored invocation index.
    agentInvocationIds.sort((a, b) => {
      const ia = (this.nodes.get(a)?.props['index'] as number) ?? 0;
      const ib = (this.nodes.get(b)?.props['index'] as number) ?? 0;
      return ia - ib;
    });

    const agentInvocations: RunAgentInvocationView[] = [];
    for (const invId of agentInvocationIds) {
      const invNode = this.nodes.get(invId);
      if (!invNode) continue;
      const toolCalls: RunToolCallView[] = [];
      for (const edge of this.edges.values()) {
        if (edge.type === 'INVOKED_TOOL' && edge.from === invId) {
          const tc = this.nodes.get(edge.to);
          if (tc) {
            toolCalls.push({
              node: tc,
              producedEntities: collectProduced(edge.to),
            });
          }
        }
      }
      agentInvocations.push({ node: invNode, toolCalls });
    }

    return {
      turn,
      run,
      ...(user ? { user } : {}),
      orchestratorToolCalls,
      agentInvocations,
    };
  }

  async getSession(scope: string): Promise<SessionView | null> {
    const sessionId = sessionNodeId(scope);
    const session = this.nodes.get(sessionId);
    if (!session) return null;
    const turnIds = this.sessionTurns.get(sessionId) ?? [];
    const turns = turnIds.map((turnId) => {
      const turnNode = this.nodes.get(turnId);
      const entityIds: string[] = [];
      for (const edge of this.edges.values()) {
        if (edge.type === 'CAPTURED' && edge.from === turnId) {
          entityIds.push(edge.to);
        }
      }
      const entities = entityIds
        .map((id) => this.nodes.get(id))
        .filter((n): n is GraphNode => n !== undefined);
      return { turn: turnNode as GraphNode, entities };
    });
    // Slice 1b-channel-web — User-Cluster as first-class neighbor.
    const sessionUserId = session.props['userId'];
    const user =
      typeof sessionUserId === 'string' && sessionUserId.length > 0
        ? this.nodes.get(userNodeId(sessionUserId))
        : undefined;
    return { session, turns, ...(user ? { user } : {}) };
  }

  async listSessions(filter?: SessionFilter): Promise<SessionSummary[]> {
    const out: SessionSummary[] = [];
    for (const [sessionId, turnIds] of this.sessionTurns.entries()) {
      const session = this.nodes.get(sessionId);
      if (!session) continue;
      if (filter?.userId && session.props['userId'] !== filter.userId) continue;
      const times = turnIds
        .map((id) => this.nodes.get(id)?.props['time'] as string | undefined)
        .filter((t): t is string => typeof t === 'string');
      if (times.length === 0) continue;
      out.push({
        id: sessionId,
        scope: session.props['scope'] as string,
        turnCount: turnIds.length,
        firstAt: times[0] ?? '',
        lastAt: times[times.length - 1] ?? '',
      });
    }
    return out.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }

  async getNeighbors(nodeId: string): Promise<GraphNode[]> {
    const neighbors: GraphNode[] = [];
    const seen = new Set<string>();
    for (const edge of this.edges.values()) {
      let other: string | null = null;
      if (edge.from === nodeId) other = edge.to;
      else if (edge.to === nodeId) other = edge.from;
      if (other === null || seen.has(other)) continue;
      seen.add(other);
      const node = this.nodes.get(other);
      if (node) neighbors.push(node);
    }
    return neighbors;
  }

  async stats(): Promise<GraphStats> {
    const byNodeType: Record<GraphNodeType, number> = {
      Session: 0,
      Turn: 0,
      OdooEntity: 0,
      ConfluencePage: 0,
      PluginEntity: 0,
      User: 0,
      ChannelIdentity: 0,
      Run: 0,
      AgentInvocation: 0,
      ToolCall: 0,
      Fact: 0,
      MemorableKnowledge: 0,
      PalaiaExcerpt: 0,
      Inconsistency: 0,
      MergeCandidate: 0,
      Topic: 0,
      ExcerptMergeCandidate: 0,
      Plan: 0,
      PlanStep: 0,
    };
    for (const n of this.nodes.values()) byNodeType[n.type]++;

    const byEdgeType: Record<GraphEdgeType, number> = {
      IN_SESSION: 0,
      NEXT_TURN: 0,
      CAPTURED: 0,
      BELONGS_TO: 0,
      EXECUTED: 0,
      INVOKED_AGENT: 0,
      INVOKED_TOOL: 0,
      PRODUCED: 0,
      DERIVED_FROM: 0,
      MENTIONS: 0,
      IS_IDENTITY_OF: 0,
      INVOLVED: 0,
      REQUIRES: 0,
      EXCERPT_OF: 0,
      CONFLICTS_WITH: 0,
      DUPLICATE_OF: 0,
      HAS_TOPIC: 0,
      DUPLICATE_EXCERPT_OF: 0,
      STEP_OF: 0,
      DEPENDS_ON: 0,
      PLAN_OF: 0,
    };
    for (const e of this.edges.values()) byEdgeType[e.type]++;

    return {
      nodes: this.nodes.size,
      edges: this.edges.size,
      byNodeType,
      byEdgeType,
    };
  }

  async ingestRun(trace: RunTrace): Promise<RunIngestResult> {
    const runId = runNodeId(trace.turnId);
    const userNode = trace.userId ? userNodeId(trace.userId) : undefined;

    // Slice 1b — `trace.userId` is the cluster-root `omadiaUserId`. The
    // User-Cluster must already exist (created via
    // `resolveOrCreateChannelIdentity`). We refresh `lastSeenAt` and link
    // via BELONGS_TO; we do NOT auto-create the cluster here.
    if (userNode && trace.userId) {
      const existing = this.nodes.get(userNode);
      if (!existing) {
        throw new Error(
          `ingestRun: User-Cluster ${userNode} not found — call resolveOrCreateChannelIdentity first`,
        );
      }
      this.upsertNode({
        id: userNode,
        type: 'User',
        props: { ...existing.props, lastSeenAt: trace.finishedAt },
      });
      this.addEdge({ type: 'BELONGS_TO', from: trace.turnId, to: userNode });
    }

    this.upsertNode({
      id: runId,
      type: 'Run',
      props: {
        turnId: trace.turnId,
        scope: trace.scope,
        startedAt: trace.startedAt,
        finishedAt: trace.finishedAt,
        durationMs: trace.durationMs,
        status: trace.status,
        iterations: trace.iterations,
        toolCalls:
          trace.orchestratorToolCalls.length +
          trace.agentInvocations.reduce(
            (acc, inv) => acc + inv.toolCalls.length,
            0,
          ),
        ...(trace.error ? { error: trace.error } : {}),
      },
    });
    this.addEdge({ type: 'EXECUTED', from: trace.turnId, to: runId });

    const toolCallIds: string[] = [];
    for (const call of trace.orchestratorToolCalls) {
      const tcId = toolCallNodeId(trace.turnId, call.callId);
      toolCallIds.push(tcId);
      this.upsertNode({
        id: tcId,
        type: 'ToolCall',
        props: {
          runId,
          toolName: call.toolName,
          durationMs: call.durationMs,
          isError: call.isError,
          agentContext: 'orchestrator',
        },
      });
      this.addEdge({ type: 'INVOKED_TOOL', from: runId, to: tcId });
      for (const producedId of call.producedEntityIds ?? []) {
        if (this.nodes.has(producedId)) {
          this.addEdge({ type: 'PRODUCED', from: tcId, to: producedId });
        }
      }
    }

    const agentInvocationIds: string[] = [];
    for (const inv of trace.agentInvocations) {
      const invId = agentInvocationNodeId(
        trace.turnId,
        inv.agentName,
        inv.index,
      );
      agentInvocationIds.push(invId);
      this.upsertNode({
        id: invId,
        type: 'AgentInvocation',
        props: {
          runId,
          agentName: inv.agentName,
          index: inv.index,
          durationMs: inv.durationMs,
          subIterations: inv.subIterations,
          subToolCount: inv.toolCalls.length,
          status: inv.status,
        },
      });
      this.addEdge({ type: 'INVOKED_AGENT', from: runId, to: invId });

      for (const call of inv.toolCalls) {
        const tcId = toolCallNodeId(trace.turnId, call.callId);
        toolCallIds.push(tcId);
        this.upsertNode({
          id: tcId,
          type: 'ToolCall',
          props: {
            runId,
            toolName: call.toolName,
            durationMs: call.durationMs,
            isError: call.isError,
            agentContext: inv.agentName,
          },
        });
        this.addEdge({ type: 'INVOKED_TOOL', from: invId, to: tcId });
        for (const producedId of call.producedEntityIds ?? []) {
          if (this.nodes.has(producedId)) {
            this.addEdge({ type: 'PRODUCED', from: tcId, to: producedId });
          }
        }
      }
    }

    const result: RunIngestResult = {
      runId,
      agentInvocationIds,
      toolCallIds,
    };
    if (userNode) result.userNodeId = userNode;
    return result;
  }

  async searchTurns(opts: SearchTurnsOptions): Promise<TurnSearchHit[]> {
    const query = opts.query.trim().toLowerCase();
    if (query.length === 0) return [];
    const tokens = query.split(/\s+/).filter((t) => t.length >= 2);
    if (tokens.length === 0) return [];

    const limit = Math.max(1, Math.min(opts.limit ?? 5, 50));
    const excludeTurnIds = new Set(opts.excludeTurnIds ?? []);

    const scored: Array<TurnSearchHit & { time: string }> = [];
    for (const node of this.nodes.values()) {
      if (node.type !== 'Turn') continue;
      if (excludeTurnIds.has(node.id)) continue;
      const scope = String(node.props['scope'] ?? '');
      if (opts.excludeScope && scope === opts.excludeScope) continue;
      if (!matchesAgentScopePrefix(scope, opts.agentScopePrefix)) continue;
      if (opts.userId && node.props['userId'] !== opts.userId) continue;

      const haystack = (
        String(node.props['userMessage'] ?? '') +
        ' ' +
        String(node.props['assistantAnswer'] ?? '')
      ).toLowerCase();

      let matches = 0;
      for (const tok of tokens) if (haystack.includes(tok)) matches++;
      if (matches === 0) continue;

      scored.push({
        turnId: node.id,
        scope,
        time: String(node.props['time'] ?? ''),
        userMessage: String(node.props['userMessage'] ?? ''),
        assistantAnswer: String(node.props['assistantAnswer'] ?? ''),
        rank: matches / tokens.length,
        ...(node.entryType ? { entryType: node.entryType } : {}),
        ...(node.manuallyAuthored !== undefined
          ? { manuallyAuthored: node.manuallyAuthored }
          : {}),
      });
    }

    scored.sort((a, b) => {
      if (b.rank !== a.rank) return b.rank - a.rank;
      return b.time.localeCompare(a.time);
    });
    return scored.slice(0, limit);
  }

  async searchTurnsByEmbedding(
    opts: SearchTurnsByEmbeddingOptions,
  ): Promise<TurnSearchHit[]> {
    // OB-72 (Phase 3): minimal hybrid parity. The in-memory backend never
    // stored embeddings (cosine ≡ 0), so without an FTS query there's still
    // nothing to score and we return []. With an FTS query, we score the
    // BM25-leg via simple token-overlap and apply the same type-weight +
    // recency multipliers as the Neon path so tests can assert hybrid
    // behaviour against this backend.
    const ftsQuery = opts.ftsQuery?.trim();
    if (!ftsQuery) return [];

    const limit = Math.max(1, Math.min(opts.limit ?? 5, 50));
    const recallMinScore = Math.max(0, Math.min(opts.recallMinScore ?? 0, 1));
    const recallRecencyBoost = Math.max(0, opts.recallRecencyBoost ?? 0.05);
    const includeCold = opts.includeCold === true;
    const entryTypesFilter = opts.entryTypes?.length
      ? new Set(opts.entryTypes)
      : null;
    const weights = {
      memory: opts.typeWeights?.['memory'] ?? 1.0,
      process: opts.typeWeights?.['process'] ?? 1.0,
      task: opts.typeWeights?.['task'] ?? 1.0,
    };
    const excludeTurnIds = new Set(opts.excludeTurnIds ?? []);

    const tokens = ftsQuery.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
    if (tokens.length === 0) return [];

    const now = Date.now();
    const scored: Array<TurnSearchHit & { _hybrid: number }> = [];
    for (const node of this.nodes.values()) {
      if (node.type !== 'Turn') continue;
      if (excludeTurnIds.has(node.id)) continue;
      const scope = String(node.props['scope'] ?? '');
      if (opts.excludeScope && scope === opts.excludeScope) continue;
      if (!matchesAgentScopePrefix(scope, opts.agentScopePrefix)) continue;
      if (opts.userId && node.props['userId'] !== opts.userId) continue;

      const entryType = (node.entryType ?? 'memory') as 'memory' | 'process' | 'task';
      if (entryTypesFilter && !entryTypesFilter.has(entryType)) continue;
      const tier = node.tier ?? 'HOT';
      if (!includeCold && tier === 'COLD') continue;

      const haystack = (
        String(node.props['userMessage'] ?? '') +
        ' ' +
        String(node.props['assistantAnswer'] ?? '')
      ).toLowerCase();
      let matches = 0;
      for (const tok of tokens) if (haystack.includes(tok)) matches++;
      if (matches === 0) continue;
      const bm25Norm = matches / tokens.length; // already in [0,1]

      // No embeddings → cosine ≡ 0; hybrid score is the BM25 leg only,
      // proportionally weighted as the Neon path would: `0.4 · bm25_norm`
      // when ftsActive (which it is here).
      const baseScore = 0.4 * bm25Norm;
      const typeMultiplier = weights[entryType] ?? 1.0;
      const time = String(node.props['time'] ?? '');
      const ageMs = time ? Math.max(0, now - new Date(time).getTime()) : 0;
      const ageDays = ageMs / 86_400_000;
      const recencyMultiplier =
        recallRecencyBoost === 0 ? 1 : Math.exp(-recallRecencyBoost * ageDays);
      const hybridRaw = baseScore * typeMultiplier * recencyMultiplier;
      const hybrid = Math.max(0, Math.min(1, hybridRaw));
      if (hybrid < recallMinScore) continue;

      scored.push({
        turnId: node.id,
        scope,
        time,
        userMessage: String(node.props['userMessage'] ?? ''),
        assistantAnswer: String(node.props['assistantAnswer'] ?? ''),
        rank: hybrid,
        entryType,
        ...(node.manuallyAuthored !== undefined
          ? { manuallyAuthored: node.manuallyAuthored }
          : {}),
        _hybrid: hybrid,
      });
    }
    scored.sort((a, b) => b._hybrid - a._hybrid);
    return scored.slice(0, limit).map(({ _hybrid: _, ...hit }) => hit);
  }

  async resolveOrCreateChannelIdentity(
    ingest: ChannelIdentityIngest,
  ): Promise<ResolveOrCreateChannelIdentityResult> {
    const identityExtId = channelIdentityNodeId(
      ingest.channelKind,
      ingest.channelUserId,
    );
    const now = new Date().toISOString();
    const normalizedEmail = ingest.email?.trim().toLowerCase();
    const verifiedEmail =
      normalizedEmail && ingest.emailVerified === true ? normalizedEmail : null;

    // Fast path: exact ChannelIdentity already exists.
    const existing = this.nodes.get(identityExtId);
    if (existing && existing.type === 'ChannelIdentity') {
      const link = [...this.edges.values()].find(
        (e) => e.type === 'IS_IDENTITY_OF' && e.from === identityExtId,
      );
      const cluster = link ? this.nodes.get(link.to) : undefined;
      if (cluster && cluster.type === 'User') {
        const clusterOmadiaUserId = String(cluster.props['omadiaUserId'] ?? '');
        this.upsertNode({
          id: identityExtId,
          type: 'ChannelIdentity',
          props: { ...existing.props, lastSeenAt: now },
        });
        this.upsertNode({
          id: cluster.id,
          type: 'User',
          props: { ...cluster.props, lastSeenAt: now },
        });
        return {
          channelIdentityNodeId: identityExtId,
          userNodeId: cluster.id,
          omadiaUserId: clusterOmadiaUserId,
          isNewIdentity: false,
          isNewCluster: false,
        };
      }
    }

    // Merge strategy (mirrors NeonKnowledgeGraph.resolveOrCreateChannelIdentity):
    //   1. AAD-oid match: any kind in single-tenant in-memory store
    //      carrying the same aadObjectId.
    //   2. Verified-email match.
    let clusterId: string | undefined;
    let clusterOmadiaUserId: string | undefined;
    let isNewCluster = false;

    const findClusterForIdentity = (
      predicate: (n: GraphNode) => boolean,
    ): { clusterId: string; omadiaUserId: string } | undefined => {
      for (const n of this.nodes.values()) {
        if (n.type !== 'ChannelIdentity') continue;
        if (!predicate(n)) continue;
        const link = [...this.edges.values()].find(
          (e) => e.type === 'IS_IDENTITY_OF' && e.from === n.id,
        );
        if (!link) continue;
        const c = this.nodes.get(link.to);
        if (c && c.type === 'User') {
          return {
            clusterId: c.id,
            omadiaUserId: String(c.props['omadiaUserId'] ?? ''),
          };
        }
      }
      return undefined;
    };

    if (ingest.aadObjectId) {
      const hit = findClusterForIdentity(
        (n) => n.props['aadObjectId'] === ingest.aadObjectId,
      );
      if (hit) {
        clusterId = hit.clusterId;
        clusterOmadiaUserId = hit.omadiaUserId;
      }
    }

    if (!clusterId && verifiedEmail) {
      const hit = findClusterForIdentity((n) => {
        const ne = String(n.props['email'] ?? '').toLowerCase();
        const verified = n.props['emailVerified'] === true;
        return ne === verifiedEmail && verified;
      });
      if (hit) {
        clusterId = hit.clusterId;
        clusterOmadiaUserId = hit.omadiaUserId;
      }
    }

    if (clusterId) {
      // Refresh the existing cluster's lastSeenAt.
      const c = this.nodes.get(clusterId);
      if (c && c.type === 'User') {
        this.upsertNode({
          id: c.id,
          type: 'User',
          props: { ...c.props, lastSeenAt: now },
        });
      }
    }

    // No match — fresh 1:1 cluster.
    if (!clusterId || !clusterOmadiaUserId) {
      clusterOmadiaUserId = randomUUID();
      clusterId = userNodeId(clusterOmadiaUserId);
      this.upsertNode({
        id: clusterId,
        type: 'User',
        props: {
          omadiaUserId: clusterOmadiaUserId,
          firstSeenAt: now,
          lastSeenAt: now,
          ...(ingest.displayName ? { displayName: ingest.displayName } : {}),
        },
      });
      isNewCluster = true;
    }

    // Write the ChannelIdentity + edge.
    this.upsertNode({
      id: identityExtId,
      type: 'ChannelIdentity',
      props: {
        channelKind: ingest.channelKind,
        channelUserId: ingest.channelUserId,
        firstSeenAt: now,
        lastSeenAt: now,
        ...(ingest.displayName ? { displayName: ingest.displayName } : {}),
        ...(normalizedEmail ? { email: normalizedEmail } : {}),
        ...(ingest.emailVerified !== undefined
          ? { emailVerified: ingest.emailVerified }
          : {}),
        ...(ingest.aadObjectId ? { aadObjectId: ingest.aadObjectId } : {}),
        ...(ingest.internalChannelData
          ? { internalChannelData: ingest.internalChannelData }
          : {}),
      },
    });
    this.addEdge({
      type: 'IS_IDENTITY_OF',
      from: identityExtId,
      to: clusterId,
    });

    return {
      channelIdentityNodeId: identityExtId,
      userNodeId: clusterId,
      omadiaUserId: clusterOmadiaUserId,
      isNewIdentity: true,
      isNewCluster,
    };
  }

  async createMemorableKnowledge(
    input: MemorableKnowledgeIngest,
  ): Promise<MemorableKnowledgeIngestResult> {
    const memorableUuid = randomUUID();
    const mkExtId = memorableKnowledgeNodeId(memorableUuid);
    const now = new Date().toISOString();
    let skippedInvolved = 0;
    let skippedRequired = 0;
    let skippedDerivedFrom = 0;

    const initialOwners = input.aclOwners ?? [];
    this.upsertNode({
      id: mkExtId,
      type: 'MemorableKnowledge',
      // WS5 — reflect an explicit initial visibility on the node so
      // `GraphNode.visibility` carries the value the reaper requested
      // (team-wide). Omitted → undefined, the historical default.
      ...(input.visibility !== undefined
        ? { visibility: input.visibility }
        : {}),
      props: {
        kind: input.kind,
        summary: input.summary,
        ...(input.rationale ? { rationale: input.rationale } : {}),
        ...(input.significance !== undefined
          ? { significance: input.significance }
          : {}),
        ...(input.originAgent ? { origin_agent: input.originAgent } : {}),
        acl_owners: initialOwners,
        created_at: now,
        created_by: input.createdBy,
      },
    });
    // Slice 3 — unconditional `create` audit row.
    const auditActor =
      input.actorOmadiaUserId ??
      initialOwners[0] ??
      '00000000-0000-0000-0000-000000000000';
    this.appendAclAudit({
      memoryExternalId: mkExtId,
      actorOmadiaUserId: auditActor,
      actorChannelIdentityId: input.createdBy,
      action: 'create',
      beforeOwners: [],
      afterOwners: initialOwners,
    });

    for (const omadiaUserId of input.involvedOmadiaUserIds ?? []) {
      const userExtId = userNodeId(omadiaUserId);
      if (!this.nodes.has(userExtId)) {
        skippedInvolved++;
        continue;
      }
      this.addEdge({ type: 'INVOLVED', from: mkExtId, to: userExtId });
    }

    for (const entityExtId of input.requiredEntityIds ?? []) {
      const node = this.nodes.get(entityExtId);
      if (
        !node ||
        (node.type !== 'OdooEntity' &&
          node.type !== 'ConfluencePage' &&
          node.type !== 'PluginEntity')
      ) {
        skippedRequired++;
        continue;
      }
      this.addEdge({ type: 'REQUIRES', from: mkExtId, to: entityExtId });
    }

    for (const turnExtId of input.derivedFromTurnIds ?? []) {
      const node = this.nodes.get(turnExtId);
      if (!node || node.type !== 'Turn') {
        skippedDerivedFrom++;
        continue;
      }
      this.addEdge({ type: 'DERIVED_FROM', from: mkExtId, to: turnExtId });
    }

    // Slice 6.5 — atomic excerpt persistence. Mirrors NeonKnowledgeGraph.
    if (input.palaiaExcerpts && input.palaiaExcerpts.texts.length > 0) {
      this.writeExcerpts(mkExtId, input.palaiaExcerpts, now);
    }

    return {
      memorableKnowledgeNodeId: mkExtId,
      skippedInvolved,
      skippedRequired,
      skippedDerivedFrom,
    };
  }

  async getMemorableKnowledge(
    memorableKnowledgeNodeId: string,
    viewerOmadiaUserId?: string,
  ): Promise<GraphNode | null> {
    const node = this.nodes.get(memorableKnowledgeNodeId);
    if (!node || node.type !== 'MemorableKnowledge') return null;
    if (viewerOmadiaUserId !== undefined) {
      const owners = Array.isArray(node.props['acl_owners'])
        ? (node.props['acl_owners'] as string[])
        : [];
      if (!owners.includes(viewerOmadiaUserId)) return null;
    }
    return node;
  }

  async listMemorableKnowledgeFor(
    omadiaUserId: string,
    opts: ListMemorableKnowledgeOptions = {},
  ): Promise<GraphNode[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    const userExtId = userNodeId(omadiaUserId);
    if (!this.nodes.has(userExtId)) return [];
    const hits: GraphNode[] = [];
    for (const edge of this.edges.values()) {
      if (edge.type !== 'INVOLVED' || edge.to !== userExtId) continue;
      const mk = this.nodes.get(edge.from);
      if (!mk || mk.type !== 'MemorableKnowledge') continue;
      if (opts.kind && mk.props['kind'] !== opts.kind) continue;
      // Slice 3 — gate by acl_owners; empty owners ⇒ invisible.
      const owners = Array.isArray(mk.props['acl_owners'])
        ? (mk.props['acl_owners'] as string[])
        : [];
      if (!owners.includes(omadiaUserId)) continue;
      hits.push(mk);
    }
    hits.sort((a, b) => {
      const at = String(a.props['created_at'] ?? '');
      const bt = String(b.props['created_at'] ?? '');
      return bt.localeCompare(at);
    });
    return hits.slice(0, limit);
  }

  // ─── Slice 3 — ACL mutations + audit ──────────────────────────────────

  private appendAclAudit(entry: {
    memoryExternalId: string;
    actorOmadiaUserId: string;
    actorChannelIdentityId?: string;
    action: AclAction;
    beforeOwners: string[];
    afterOwners: string[] | null;
    reason?: string;
  }): void {
    const row: AclAuditEntry = {
      id: randomUUID(),
      memoryExternalId: entry.memoryExternalId,
      actorOmadiaUserId: entry.actorOmadiaUserId,
      ...(entry.actorChannelIdentityId
        ? { actorChannelIdentityId: entry.actorChannelIdentityId }
        : {}),
      action: entry.action,
      beforeOwners: [...entry.beforeOwners],
      afterOwners: entry.afterOwners === null ? null : [...entry.afterOwners],
      ...(entry.reason ? { reason: entry.reason } : {}),
      createdAt: new Date().toISOString(),
    };
    const list = this.aclAudit.get(entry.memoryExternalId) ?? [];
    list.push(row);
    this.aclAudit.set(entry.memoryExternalId, list);
  }

  private requireMkOrThrow(memorableKnowledgeNodeId: string): GraphNode {
    const node = this.nodes.get(memorableKnowledgeNodeId);
    if (!node || node.type !== 'MemorableKnowledge') {
      throw Object.assign(new Error('memory_not_found'), {
        code: 'memory_not_found',
      });
    }
    return node;
  }

  async addOwner(
    memorableKnowledgeNodeId: string,
    omadiaUserIdToAdd: string,
    actor: AclMutationOptions,
  ): Promise<string[]> {
    const node = this.requireMkOrThrow(memorableKnowledgeNodeId);
    const owners = Array.isArray(node.props['acl_owners'])
      ? (node.props['acl_owners'] as string[])
      : [];
    if (!owners.includes(actor.actorOmadiaUserId)) {
      throw Object.assign(new Error('not_an_owner'), { code: 'not_an_owner' });
    }
    const next = owners.includes(omadiaUserIdToAdd)
      ? owners
      : [...owners, omadiaUserIdToAdd];
    this.upsertNode({
      id: node.id,
      type: 'MemorableKnowledge',
      props: { ...node.props, acl_owners: next },
    });
    this.appendAclAudit({
      memoryExternalId: memorableKnowledgeNodeId,
      actorOmadiaUserId: actor.actorOmadiaUserId,
      ...(actor.actorChannelIdentityId
        ? { actorChannelIdentityId: actor.actorChannelIdentityId }
        : {}),
      action: 'expand',
      beforeOwners: owners,
      afterOwners: next,
      ...(actor.reason ? { reason: actor.reason } : {}),
    });
    return next;
  }

  async removeOwner(
    memorableKnowledgeNodeId: string,
    omadiaUserIdToRemove: string,
    actor: AclMutationOptions,
  ): Promise<string[]> {
    const node = this.requireMkOrThrow(memorableKnowledgeNodeId);
    const owners = Array.isArray(node.props['acl_owners'])
      ? (node.props['acl_owners'] as string[])
      : [];
    if (!owners.includes(actor.actorOmadiaUserId)) {
      throw Object.assign(new Error('not_an_owner'), { code: 'not_an_owner' });
    }
    const next = owners.filter((id) => id !== omadiaUserIdToRemove);
    if (owners.includes(omadiaUserIdToRemove) && next.length === 0) {
      throw Object.assign(new Error('cannot_remove_last_owner'), {
        code: 'cannot_remove_last_owner',
      });
    }
    this.upsertNode({
      id: node.id,
      type: 'MemorableKnowledge',
      props: { ...node.props, acl_owners: next },
    });
    this.appendAclAudit({
      memoryExternalId: memorableKnowledgeNodeId,
      actorOmadiaUserId: actor.actorOmadiaUserId,
      ...(actor.actorChannelIdentityId
        ? { actorChannelIdentityId: actor.actorChannelIdentityId }
        : {}),
      action: 'shrink',
      beforeOwners: owners,
      afterOwners: next,
      ...(actor.reason ? { reason: actor.reason } : {}),
    });
    return next;
  }

  async deleteMemory(
    memorableKnowledgeNodeId: string,
    actor: AclMutationOptions,
  ): Promise<void> {
    const node = this.requireMkOrThrow(memorableKnowledgeNodeId);
    const owners = Array.isArray(node.props['acl_owners'])
      ? (node.props['acl_owners'] as string[])
      : [];
    if (!owners.includes(actor.actorOmadiaUserId)) {
      throw Object.assign(new Error('not_an_owner'), { code: 'not_an_owner' });
    }
    // Audit BEFORE delete (matches Neon semantics).
    this.appendAclAudit({
      memoryExternalId: memorableKnowledgeNodeId,
      actorOmadiaUserId: actor.actorOmadiaUserId,
      ...(actor.actorChannelIdentityId
        ? { actorChannelIdentityId: actor.actorChannelIdentityId }
        : {}),
      action: 'delete',
      beforeOwners: owners,
      afterOwners: null,
      ...(actor.reason ? { reason: actor.reason } : {}),
    });
    // Slice 6.5 — cascade-delete attached PalaiaExcerpt nodes BEFORE
    // dropping the parent + its edges; otherwise the edge-purge loop
    // below would orphan the excerpt nodes themselves.
    const excerptIdsToDrop: string[] = [];
    for (const edge of this.edges.values()) {
      if (edge.type === 'EXCERPT_OF' && edge.to === node.id) {
        excerptIdsToDrop.push(edge.from);
      }
    }
    for (const exId of excerptIdsToDrop) this.nodes.delete(exId);

    // Drop the node + every edge touching it (or any cascaded excerpt).
    const droppedIds = new Set<string>([node.id, ...excerptIdsToDrop]);
    this.nodes.delete(node.id);
    for (const [key, edge] of this.edges.entries()) {
      if (droppedIds.has(edge.from) || droppedIds.has(edge.to)) {
        this.edges.delete(key);
      }
    }
    // Slice 7 — also drop the embeddings for the deleted MK + cascade-
    // deleted excerpts so cosine-search can never resurrect a tombstoned
    // memory by keeping its vector around.
    for (const id of droppedIds) this.embeddings.delete(id);
  }

  /**
   * True when an MK node matches a Danger-Zone purge filter. The
   * in-memory store is single-tenant, so `filter.tenantId` is accepted
   * for interface parity but not matched against (every node is in the
   * one implicit tenant).
   */
  private matchesMkPurgeFilter(
    node: GraphNode,
    filter: MemorableKnowledgePurgeFilter,
  ): boolean {
    if (node.type !== 'MemorableKnowledge') return false;
    if (
      filter.originAgent !== undefined &&
      node.props['origin_agent'] !== filter.originAgent
    ) {
      return false;
    }
    if (filter.aclOwner !== undefined) {
      const owners = Array.isArray(node.props['acl_owners'])
        ? (node.props['acl_owners'] as string[])
        : [];
      if (!owners.includes(filter.aclOwner)) return false;
    }
    return true;
  }

  async countMemorableKnowledge(
    filter: MemorableKnowledgePurgeFilter,
  ): Promise<{ count: number }> {
    let count = 0;
    for (const node of this.nodes.values()) {
      if (this.matchesMkPurgeFilter(node, filter)) count++;
    }
    return { count };
  }

  async purgeMemorableKnowledge(
    filter: MemorableKnowledgePurgeFilter,
  ): Promise<{ deletedNodes: number }> {
    const mkIds: string[] = [];
    for (const node of this.nodes.values()) {
      if (this.matchesMkPurgeFilter(node, filter)) mkIds.push(node.id);
    }
    if (mkIds.length === 0) return { deletedNodes: 0 };
    const mkIdSet = new Set(mkIds);
    // Cascade-delete attached PalaiaExcerpt nodes BEFORE dropping parents
    // + their edges (mirrors deleteMemory's Slice 6.5 cascade).
    const excerptIds: string[] = [];
    for (const edge of this.edges.values()) {
      if (edge.type === 'EXCERPT_OF' && mkIdSet.has(edge.to)) {
        excerptIds.push(edge.from);
      }
    }
    const droppedIds = new Set<string>([...mkIds, ...excerptIds]);
    for (const id of droppedIds) this.nodes.delete(id);
    for (const [key, edge] of this.edges.entries()) {
      if (droppedIds.has(edge.from) || droppedIds.has(edge.to)) {
        this.edges.delete(key);
      }
    }
    for (const id of droppedIds) this.embeddings.delete(id);
    return { deletedNodes: mkIds.length };
  }

  async updateMemorableKnowledge(
    memorableKnowledgeNodeId: string,
    patch: MemorableKnowledgeUpdate,
    actor: AclMutationOptions,
  ): Promise<GraphNode> {
    const hasField =
      patch.kind !== undefined ||
      patch.summary !== undefined ||
      patch.rationale !== undefined ||
      patch.significance !== undefined;
    if (!hasField) {
      throw Object.assign(new Error('empty_patch'), { code: 'empty_patch' });
    }
    const node = this.requireMkOrThrow(memorableKnowledgeNodeId);
    const owners = Array.isArray(node.props['acl_owners'])
      ? (node.props['acl_owners'] as string[])
      : [];
    if (!owners.includes(actor.actorOmadiaUserId)) {
      throw Object.assign(new Error('not_an_owner'), { code: 'not_an_owner' });
    }

    const next: Record<string, unknown> = { ...node.props };
    if (patch.kind !== undefined) next['kind'] = patch.kind;
    if (patch.summary !== undefined) next['summary'] = patch.summary;
    if (patch.rationale === null) {
      delete next['rationale'];
    } else if (patch.rationale !== undefined) {
      next['rationale'] = patch.rationale;
    }
    if (patch.significance !== undefined) {
      next['significance'] = patch.significance;
    }
    // InMemory backend does no Zod-validation (mirrors the existing
    // `createMemorableKnowledge` pattern in this file). Production
    // strict-validation lives in NeonKnowledgeGraph via the
    // MemorableKnowledgePropsSchema; tests against InMemory can call
    // `validateNodeProps` directly from `@omadia/knowledge-graph-neon`
    // when they need to assert the schema-side guarantees.
    node.props = next;

    // Slice 7 — drop the now-stale embedding so cosine-search stops
    // matching against the old summary text. Mirrors the Neon
    // UPDATE … SET embedding = NULL clause.
    this.embeddings.delete(node.id);

    this.appendAclAudit({
      memoryExternalId: memorableKnowledgeNodeId,
      actorOmadiaUserId: actor.actorOmadiaUserId,
      ...(actor.actorChannelIdentityId
        ? { actorChannelIdentityId: actor.actorChannelIdentityId }
        : {}),
      action: 'edit',
      beforeOwners: owners,
      afterOwners: owners,
      ...(actor.reason ? { reason: actor.reason } : {}),
    });
    return { ...node, props: { ...node.props } };
  }

  // ─── Slice 6.5 — PalaiaExcerpt persistence ──────────────────────────

  /**
   * Write a Palaia-Excerpt batch attached to the given parent MK.
   * Mirrors the Neon implementation's pre-insert validation
   * (`excerpt_count_exceeded` >5, `excerpt_text_too_long` >300 chars).
   */
  private writeExcerpts(
    parentMkExtId: string,
    input: PalaiaExcerptInput,
    nowIso: string,
  ): void {
    if (input.texts.length > 5) {
      throw Object.assign(new Error('excerpt_count_exceeded'), {
        code: 'excerpt_count_exceeded',
      });
    }
    for (const t of input.texts) {
      if (t.length === 0 || t.length > 300) {
        throw Object.assign(new Error('excerpt_text_too_long'), {
          code: 'excerpt_text_too_long',
        });
      }
    }
    for (let i = 0; i < input.texts.length; i++) {
      const text = input.texts[i]!;
      const excerptExtId = palaiaExcerptNodeId(randomUUID());
      this.upsertNode({
        id: excerptExtId,
        type: 'PalaiaExcerpt',
        props: {
          text,
          position: i,
          source: input.source,
          created_at: nowIso,
        },
      });
      this.addEdge({
        type: 'EXCERPT_OF',
        from: excerptExtId,
        to: parentMkExtId,
      });
    }
  }

  async listExcerptsForMemory(
    memorableKnowledgeNodeId: string,
  ): Promise<PalaiaExcerptNode[]> {
    const result: PalaiaExcerptNode[] = [];
    for (const edge of this.edges.values()) {
      if (edge.type !== 'EXCERPT_OF' || edge.to !== memorableKnowledgeNodeId) {
        continue;
      }
      const node = this.nodes.get(edge.from);
      if (!node || node.type !== 'PalaiaExcerpt') continue;
      result.push({
        id: node.id,
        type: 'PalaiaExcerpt' as const,
        props: {
          text: node.props['text'] as string,
          position: node.props['position'] as number,
          source: node.props['source'] as ExcerptSource,
          created_at: node.props['created_at'] as string,
        },
      });
    }
    result.sort((a, b) => a.props.position - b.props.position);
    return result;
  }

  async updateExcerpt(
    memorableKnowledgeNodeId: string,
    position: number,
    patch: PalaiaExcerptUpdate,
    actor: AclMutationOptions,
  ): Promise<PalaiaExcerptNode> {
    const hasField = patch.text !== undefined || patch.source !== undefined;
    if (!hasField) {
      throw Object.assign(new Error('empty_patch'), { code: 'empty_patch' });
    }
    if (
      patch.text !== undefined &&
      (patch.text.length === 0 || patch.text.length > 300)
    ) {
      throw Object.assign(new Error('excerpt_text_too_long'), {
        code: 'excerpt_text_too_long',
      });
    }
    const mk = this.requireMkOrThrow(memorableKnowledgeNodeId);
    const owners = Array.isArray(mk.props['acl_owners'])
      ? (mk.props['acl_owners'] as string[])
      : [];
    if (!owners.includes(actor.actorOmadiaUserId)) {
      throw Object.assign(new Error('not_an_owner'), { code: 'not_an_owner' });
    }

    let target: GraphNode | undefined;
    for (const edge of this.edges.values()) {
      if (edge.type !== 'EXCERPT_OF' || edge.to !== memorableKnowledgeNodeId) {
        continue;
      }
      const candidate = this.nodes.get(edge.from);
      if (
        candidate &&
        candidate.type === 'PalaiaExcerpt' &&
        candidate.props['position'] === position
      ) {
        target = candidate;
        break;
      }
    }
    if (!target) {
      throw Object.assign(new Error('excerpt_not_found'), {
        code: 'excerpt_not_found',
      });
    }

    const next: Record<string, unknown> = { ...target.props };
    if (patch.text !== undefined) next['text'] = patch.text;
    if (patch.source !== undefined) next['source'] = patch.source;
    target.props = next;

    // Slice 7 — drop the now-stale excerpt embedding.
    this.embeddings.delete(target.id);

    this.appendAclAudit({
      memoryExternalId: memorableKnowledgeNodeId,
      actorOmadiaUserId: actor.actorOmadiaUserId,
      ...(actor.actorChannelIdentityId
        ? { actorChannelIdentityId: actor.actorChannelIdentityId }
        : {}),
      action: 'edit_excerpt',
      beforeOwners: owners,
      afterOwners: owners,
      ...(actor.reason ? { reason: actor.reason } : {}),
    });

    return {
      id: target.id,
      type: 'PalaiaExcerpt' as const,
      props: {
        text: next['text'] as string,
        position: next['position'] as number,
        source: next['source'] as ExcerptSource,
        created_at: next['created_at'] as string,
      },
    };
  }

  // ─── Slice 7 — Memory + Excerpt semantic search ─────────────────────

  async searchMemorableKnowledgeByEmbedding(
    opts: MemorableKnowledgeSearchOptions,
  ): Promise<MemorableKnowledgeHit[]> {
    if (opts.queryEmbedding.length === 0) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? 5, 50));
    const minSimilarity = opts.minSimilarity ?? 0.3;
    const hits: MemorableKnowledgeHit[] = [];
    for (const node of this.nodes.values()) {
      if (node.type !== 'MemorableKnowledge') continue;
      const owners = Array.isArray(node.props['acl_owners'])
        ? (node.props['acl_owners'] as string[])
        : [];
      // Per-orchestrator isolation: owner-gated MK is additionally constrained
      // to the viewing Agent. Legacy MK with no origin_agent stays visible to
      // the owner; team/public bypasses (cross-agent sharing preserved).
      const originAgent = node.props['origin_agent'];
      const agentMatch =
        opts.viewerAgentSlug === undefined ||
        !originAgent ||
        originAgent === opts.viewerAgentSlug;
      const ownerMatch =
        owners.includes(opts.viewerOmadiaUserId) && agentMatch;
      // Mirror neon's `COALESCE(visibility, 'team')`: an MK with no explicit
      // visibility is team-visible by default; `private` is never admitted
      // by the team branch.
      const teamMatch =
        opts.teamVisibility === true &&
        ['team', 'public'].includes(node.visibility ?? 'team');
      if (!ownerMatch && !teamMatch) continue;
      const vector = this.embeddings.get(node.id);
      if (!vector) continue;
      const sim = cosine(opts.queryEmbedding, vector);
      if (!Number.isFinite(sim) || sim < minSimilarity) continue;
      hits.push({ mk: node, cosineSim: sim });
    }
    hits.sort((a, b) => b.cosineSim - a.cosineSim);
    return hits.slice(0, limit);
  }

  async searchExcerptsByEmbedding(
    opts: ExcerptSearchOptions,
  ): Promise<PalaiaExcerptHit[]> {
    if (opts.queryEmbedding.length === 0) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? 10, 50));
    const minSimilarity = opts.minSimilarity ?? 0.3;
    const hits: PalaiaExcerptHit[] = [];
    for (const node of this.nodes.values()) {
      if (node.type !== 'PalaiaExcerpt') continue;
      const vector = this.embeddings.get(node.id);
      if (!vector) continue;
      // Resolve parent MK via EXCERPT_OF edge.
      let parentMkId: string | null = null;
      for (const edge of this.edges.values()) {
        if (edge.type === 'EXCERPT_OF' && edge.from === node.id) {
          parentMkId = edge.to;
          break;
        }
      }
      if (parentMkId === null) continue;
      const parent = this.nodes.get(parentMkId);
      if (!parent || parent.type !== 'MemorableKnowledge') continue;
      const owners = Array.isArray(parent.props['acl_owners'])
        ? (parent.props['acl_owners'] as string[])
        : [];
      // Per-orchestrator isolation against the parent MK's origin_agent.
      const originAgent = parent.props['origin_agent'];
      const agentMatch =
        opts.viewerAgentSlug === undefined ||
        !originAgent ||
        originAgent === opts.viewerAgentSlug;
      const ownerMatch =
        owners.includes(opts.viewerOmadiaUserId) && agentMatch;
      // Excerpts inherit the parent MK's ACL + visibility.
      const teamMatch =
        opts.teamVisibility === true &&
        ['team', 'public'].includes(parent.visibility ?? 'team');
      if (!ownerMatch && !teamMatch) continue;
      const sim = cosine(opts.queryEmbedding, vector);
      if (!Number.isFinite(sim) || sim < minSimilarity) continue;
      hits.push({
        excerpt: {
          id: node.id,
          type: 'PalaiaExcerpt' as const,
          props: {
            text: node.props['text'] as string,
            position: node.props['position'] as number,
            source: node.props['source'] as ExcerptSource,
            created_at: node.props['created_at'] as string,
          },
        },
        parentMkId,
        cosineSim: sim,
      });
    }
    hits.sort((a, b) => b.cosineSim - a.cosineSim);
    return hits.slice(0, limit);
  }

  // ─── Slice 9 — Inconsistency persistence + resolve ──────────────────

  private hydrateInconsistency(externalId: string): InconsistencyNode | null {
    const node = this.nodes.get(externalId);
    if (!node || node.type !== 'Inconsistency') return null;
    // Source of truth = the mk_pair property (survives a_wins/b_wins).
    const pair = node.props['mk_pair'];
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    return {
      id: node.id,
      type: 'Inconsistency' as const,
      props: {
        summary: node.props['summary'] as string,
        severity: node.props['severity'] as InconsistencyNode['props']['severity'],
        status: node.props['status'] as InconsistencyStatus,
        resolution:
          (node.props['resolution'] as InconsistencyResolution | null) ?? null,
        created_at: node.props['created_at'] as string,
        resolved_at: (node.props['resolved_at'] as string | null) ?? null,
        resolved_by: (node.props['resolved_by'] as string | null) ?? null,
      },
      conflictsWith: [pair[0] as string, pair[1] as string],
    };
  }

  async createInconsistency(
    input: CreateInconsistencyInput,
  ): Promise<InconsistencyNode | null> {
    if (input.mkAExternalId === input.mkBExternalId) return null;
    const sortedPair: [string, string] = [
      input.mkAExternalId,
      input.mkBExternalId,
    ].sort() as [string, string];

    // Fail-fast: both MKs must exist.
    const mkA = this.nodes.get(sortedPair[0]);
    const mkB = this.nodes.get(sortedPair[1]);
    if (
      !mkA ||
      mkA.type !== 'MemorableKnowledge' ||
      !mkB ||
      mkB.type !== 'MemorableKnowledge'
    ) {
      return null;
    }

    // Idempotency: check if any Inconsistency already wires the pair.
    for (const node of this.nodes.values()) {
      if (node.type !== 'Inconsistency') continue;
      const existing = this.hydrateInconsistency(node.id);
      if (
        existing &&
        existing.conflictsWith[0] === sortedPair[0] &&
        existing.conflictsWith[1] === sortedPair[1]
      ) {
        return null;
      }
    }

    const now = new Date().toISOString();
    const externalId = inconsistencyNodeId(randomUUID());
    this.upsertNode({
      id: externalId,
      type: 'Inconsistency',
      props: {
        summary: input.summary,
        severity: input.severity,
        status: 'open',
        resolution: null,
        created_at: now,
        resolved_at: null,
        resolved_by: null,
        mk_pair: sortedPair,
      },
    });
    this.addEdge({
      type: 'CONFLICTS_WITH',
      from: externalId,
      to: sortedPair[0],
    });
    this.addEdge({
      type: 'CONFLICTS_WITH',
      from: externalId,
      to: sortedPair[1],
    });
    return this.hydrateInconsistency(externalId);
  }

  async listInconsistencies(
    opts: ListInconsistenciesOptions,
  ): Promise<InconsistencyNode[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const out: InconsistencyNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.type !== 'Inconsistency') continue;
      if (
        opts.status !== undefined &&
        node.props['status'] !== opts.status
      ) {
        continue;
      }
      const hydrated = this.hydrateInconsistency(node.id);
      if (!hydrated) continue;
      // Union-ACL: viewer must own one of the two MKs.
      const ownsAtLeastOne = hydrated.conflictsWith.some((mkId) => {
        const mk = this.nodes.get(mkId);
        const owners = mk?.props['acl_owners'];
        return (
          Array.isArray(owners) &&
          (owners as string[]).includes(opts.viewerOmadiaUserId)
        );
      });
      if (!ownsAtLeastOne) continue;
      out.push(hydrated);
      if (out.length >= limit) break;
    }
    return out;
  }

  async getInconsistency(
    externalId: string,
    viewerOmadiaUserId: string,
  ): Promise<InconsistencyNode | null> {
    const hydrated = this.hydrateInconsistency(externalId);
    if (!hydrated) return null;
    const ownsAtLeastOne = hydrated.conflictsWith.some((mkId) => {
      const mk = this.nodes.get(mkId);
      const owners = mk?.props['acl_owners'];
      return (
        Array.isArray(owners) &&
        (owners as string[]).includes(viewerOmadiaUserId)
      );
    });
    return ownsAtLeastOne ? hydrated : null;
  }

  async resolveInconsistency(
    externalId: string,
    resolution: InconsistencyResolution,
    actor: AclMutationOptions,
  ): Promise<InconsistencyNode> {
    const existing = await this.getInconsistency(
      externalId,
      actor.actorOmadiaUserId,
    );
    if (!existing) {
      throw Object.assign(new Error('inconsistency_not_found'), {
        code: 'inconsistency_not_found',
      });
    }
    if (existing.props.status !== 'open') {
      throw Object.assign(new Error('already_resolved'), {
        code: 'already_resolved',
      });
    }

    if (resolution === 'a_wins') {
      await this.deleteMemory(existing.conflictsWith[1], actor);
    } else if (resolution === 'b_wins') {
      await this.deleteMemory(existing.conflictsWith[0], actor);
    }

    const node = this.nodes.get(externalId);
    if (!node) {
      throw Object.assign(new Error('inconsistency_not_found'), {
        code: 'inconsistency_not_found',
      });
    }
    const now = new Date().toISOString();
    node.props = {
      ...node.props,
      status: resolution === 'dismiss' ? 'dismissed' : 'resolved',
      resolution,
      resolved_at: now,
      resolved_by: actor.actorOmadiaUserId,
    };
    return this.hydrateInconsistency(externalId)!;
  }

  // ─── Slice 9.5 — Bulk Inconsistency Detect markers ───────────────────

  async listMemorableKnowledgeIdsForBulkInconsistencyCheck(opts: {
    limit: number;
  }): Promise<string[]> {
    const limit = Math.max(1, Math.min(opts.limit, 200));
    const candidates: { id: string; createdAt: string }[] = [];
    for (const node of this.nodes.values()) {
      if (node.type !== 'MemorableKnowledge') continue;
      if (!this.embeddings.has(node.id)) continue;
      if (node.props['last_inconsistency_check_at'] !== undefined) continue;
      const createdAt = String(node.props['created_at'] ?? '');
      candidates.push({ id: node.id, createdAt });
    }
    candidates.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return candidates.slice(0, limit).map((c) => c.id);
  }

  async countMemorableKnowledgeInconsistencyCheckBuckets(): Promise<{
    unchecked: number;
    alreadyChecked: number;
    withoutEmbedding: number;
  }> {
    let unchecked = 0;
    let alreadyChecked = 0;
    let withoutEmbedding = 0;
    for (const node of this.nodes.values()) {
      if (node.type !== 'MemorableKnowledge') continue;
      const hasMarker =
        node.props['last_inconsistency_check_at'] !== undefined;
      const hasEmbedding = this.embeddings.has(node.id);
      if (hasMarker) {
        alreadyChecked++;
      } else if (!hasEmbedding) {
        withoutEmbedding++;
      } else {
        unchecked++;
      }
    }
    return { unchecked, alreadyChecked, withoutEmbedding };
  }

  async markMemorableKnowledgeInconsistencyChecked(
    memorableKnowledgeNodeId: string,
  ): Promise<void> {
    const node = this.nodes.get(memorableKnowledgeNodeId);
    if (!node || node.type !== 'MemorableKnowledge') return;
    node.props = {
      ...node.props,
      last_inconsistency_check_at: new Date().toISOString(),
    };
  }

  // ─── Slice 10 — MergeCandidate persistence + resolve ─────────────────

  private hydrateMergeCandidate(externalId: string): MergeCandidateNode | null {
    const node = this.nodes.get(externalId);
    if (!node || node.type !== 'MergeCandidate') return null;
    const pair = node.props['mk_pair'];
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    return {
      id: node.id,
      type: 'MergeCandidate' as const,
      props: {
        cosine_sim: node.props['cosine_sim'] as number,
        status: node.props['status'] as MergeCandidateStatus,
        resolution:
          (node.props['resolution'] as MergeCandidateResolution | null) ?? null,
        created_at: node.props['created_at'] as string,
        resolved_at: (node.props['resolved_at'] as string | null) ?? null,
        resolved_by: (node.props['resolved_by'] as string | null) ?? null,
      },
      duplicateOf: [pair[0] as string, pair[1] as string],
    };
  }

  async createMergeCandidate(
    input: CreateMergeCandidateInput,
  ): Promise<MergeCandidateNode | null> {
    if (input.mkAExternalId === input.mkBExternalId) return null;
    const sortedPair: [string, string] = [
      input.mkAExternalId,
      input.mkBExternalId,
    ].sort() as [string, string];

    const mkA = this.nodes.get(sortedPair[0]);
    const mkB = this.nodes.get(sortedPair[1]);
    if (
      !mkA ||
      mkA.type !== 'MemorableKnowledge' ||
      !mkB ||
      mkB.type !== 'MemorableKnowledge'
    ) {
      return null;
    }

    for (const node of this.nodes.values()) {
      if (node.type !== 'MergeCandidate') continue;
      const existing = this.hydrateMergeCandidate(node.id);
      if (
        existing &&
        existing.duplicateOf[0] === sortedPair[0] &&
        existing.duplicateOf[1] === sortedPair[1]
      ) {
        return null;
      }
    }

    const now = new Date().toISOString();
    const externalId = mergeCandidateNodeId(randomUUID());
    this.upsertNode({
      id: externalId,
      type: 'MergeCandidate',
      props: {
        cosine_sim: input.cosineSim,
        status: 'open',
        resolution: null,
        created_at: now,
        resolved_at: null,
        resolved_by: null,
        mk_pair: sortedPair,
      },
    });
    this.addEdge({
      type: 'DUPLICATE_OF',
      from: externalId,
      to: sortedPair[0],
    });
    this.addEdge({
      type: 'DUPLICATE_OF',
      from: externalId,
      to: sortedPair[1],
    });
    return this.hydrateMergeCandidate(externalId);
  }

  async listMergeCandidates(
    opts: ListMergeCandidatesOptions,
  ): Promise<MergeCandidateNode[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const out: MergeCandidateNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.type !== 'MergeCandidate') continue;
      if (opts.status !== undefined && node.props['status'] !== opts.status) {
        continue;
      }
      const hydrated = this.hydrateMergeCandidate(node.id);
      if (!hydrated) continue;
      const ownsAtLeastOne = hydrated.duplicateOf.some((mkId) => {
        const mk = this.nodes.get(mkId);
        const owners = mk?.props['acl_owners'];
        return (
          Array.isArray(owners) &&
          (owners as string[]).includes(opts.viewerOmadiaUserId)
        );
      });
      if (!ownsAtLeastOne) continue;
      out.push(hydrated);
      if (out.length >= limit) break;
    }
    return out;
  }

  async getMergeCandidate(
    externalId: string,
    viewerOmadiaUserId: string,
  ): Promise<MergeCandidateNode | null> {
    const hydrated = this.hydrateMergeCandidate(externalId);
    if (!hydrated) return null;
    const ownsAtLeastOne = hydrated.duplicateOf.some((mkId) => {
      const mk = this.nodes.get(mkId);
      const owners = mk?.props['acl_owners'];
      return (
        Array.isArray(owners) &&
        (owners as string[]).includes(viewerOmadiaUserId)
      );
    });
    return ownsAtLeastOne ? hydrated : null;
  }

  async resolveMergeCandidate(
    externalId: string,
    resolution: MergeCandidateResolution,
    actor: AclMutationOptions,
  ): Promise<MergeCandidateNode> {
    const existing = await this.getMergeCandidate(
      externalId,
      actor.actorOmadiaUserId,
    );
    if (!existing) {
      throw Object.assign(new Error('merge_candidate_not_found'), {
        code: 'merge_candidate_not_found',
      });
    }
    if (existing.props.status !== 'open') {
      throw Object.assign(new Error('already_resolved'), {
        code: 'already_resolved',
      });
    }
    if (resolution === 'keep_a') {
      await this.deleteMemory(existing.duplicateOf[1], actor);
    } else if (resolution === 'keep_b') {
      await this.deleteMemory(existing.duplicateOf[0], actor);
    }

    const node = this.nodes.get(externalId);
    if (!node) {
      throw Object.assign(new Error('merge_candidate_not_found'), {
        code: 'merge_candidate_not_found',
      });
    }
    const now = new Date().toISOString();
    node.props = {
      ...node.props,
      status: resolution === 'not_duplicate' ? 'dismissed' : 'resolved',
      resolution,
      resolved_at: now,
      resolved_by: actor.actorOmadiaUserId,
    };
    return this.hydrateMergeCandidate(externalId)!;
  }

  async listMemorableKnowledgeIdsForBulkMergeCheck(opts: {
    limit: number;
  }): Promise<string[]> {
    const limit = Math.max(1, Math.min(opts.limit, 500));
    const candidates: { id: string; createdAt: string }[] = [];
    for (const node of this.nodes.values()) {
      if (node.type !== 'MemorableKnowledge') continue;
      if (!this.embeddings.has(node.id)) continue;
      if (node.props['last_merge_check_at'] !== undefined) continue;
      const createdAt = String(node.props['created_at'] ?? '');
      candidates.push({ id: node.id, createdAt });
    }
    candidates.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return candidates.slice(0, limit).map((c) => c.id);
  }

  async countMemorableKnowledgeMergeCheckBuckets(): Promise<{
    unchecked: number;
    alreadyChecked: number;
    withoutEmbedding: number;
  }> {
    let unchecked = 0;
    let alreadyChecked = 0;
    let withoutEmbedding = 0;
    for (const node of this.nodes.values()) {
      if (node.type !== 'MemorableKnowledge') continue;
      const hasMarker = node.props['last_merge_check_at'] !== undefined;
      const hasEmbedding = this.embeddings.has(node.id);
      if (hasMarker) {
        alreadyChecked++;
      } else if (!hasEmbedding) {
        withoutEmbedding++;
      } else {
        unchecked++;
      }
    }
    return { unchecked, alreadyChecked, withoutEmbedding };
  }

  async markMemorableKnowledgeMergeChecked(
    memorableKnowledgeNodeId: string,
  ): Promise<void> {
    const node = this.nodes.get(memorableKnowledgeNodeId);
    if (!node || node.type !== 'MemorableKnowledge') return;
    node.props = {
      ...node.props,
      last_merge_check_at: new Date().toISOString(),
    };
  }

  // ─── Slice 11 — Topic clustering ─────────────────────────────────

  private hydrateTopic(node: GraphNode): TopicNode | null {
    if (node.type !== 'Topic') return null;
    return {
      id: node.id,
      type: 'Topic' as const,
      props: {
        name: node.props['name'] as string,
        description: (node.props['description'] as string) ?? '',
        member_count: (node.props['member_count'] as number) ?? 0,
        created_at: node.props['created_at'] as string,
        updated_at: node.props['updated_at'] as string,
        naming_source: node.props['naming_source'] as TopicNamingSource,
      },
    };
  }

  async listTopics(): Promise<TopicNode[]> {
    const out: TopicNode[] = [];
    for (const node of this.nodes.values()) {
      const t = this.hydrateTopic(node);
      if (t) out.push(t);
    }
    out.sort((a, b) => {
      if (b.props.member_count !== a.props.member_count) {
        return b.props.member_count - a.props.member_count;
      }
      return a.props.name.localeCompare(b.props.name);
    });
    return out;
  }

  async getTopic(externalId: string): Promise<TopicNode | null> {
    const node = this.nodes.get(externalId);
    return node ? this.hydrateTopic(node) : null;
  }

  async listTopicMembers(topicExternalId: string): Promise<GraphNode[]> {
    const members: GraphNode[] = [];
    for (const edge of this.edges.values()) {
      if (edge.type !== 'HAS_TOPIC') continue;
      if (edge.to !== topicExternalId) continue;
      const mk = this.nodes.get(edge.from);
      if (mk && mk.type === 'MemorableKnowledge') members.push(mk);
    }
    return members;
  }

  async listMemorableKnowledgeWithEmbeddings(): Promise<
    Array<{ mk: GraphNode; embedding: number[] }>
  > {
    const out: Array<{ mk: GraphNode; embedding: number[] }> = [];
    for (const node of this.nodes.values()) {
      if (node.type !== 'MemorableKnowledge') continue;
      const vec = this.embeddings.get(node.id);
      if (!vec || vec.length === 0) continue;
      out.push({ mk: node, embedding: [...vec] });
    }
    return out;
  }

  async deleteAllTopics(): Promise<number> {
    let deleted = 0;
    for (const node of [...this.nodes.values()]) {
      if (node.type === 'Topic') {
        this.nodes.delete(node.id);
        deleted++;
      }
    }
    for (const [key, edge] of [...this.edges.entries()]) {
      if (edge.type === 'HAS_TOPIC') this.edges.delete(key);
    }
    return deleted;
  }

  async createTopic(input: {
    name: string;
    description: string;
    namingSource: TopicNamingSource;
    memberMkIds: readonly string[];
  }): Promise<TopicNode> {
    const now = new Date().toISOString();
    const externalId = topicNodeId(randomUUID());
    this.upsertNode({
      id: externalId,
      type: 'Topic',
      props: {
        name: input.name,
        description: input.description,
        member_count: input.memberMkIds.length,
        created_at: now,
        updated_at: now,
        naming_source: input.namingSource,
      },
    });
    for (const mkId of input.memberMkIds) {
      const mk = this.nodes.get(mkId);
      if (!mk || mk.type !== 'MemorableKnowledge') continue;
      this.addEdge({
        type: 'HAS_TOPIC',
        from: mkId,
        to: externalId,
      });
    }
    return this.hydrateTopic(this.nodes.get(externalId)!)!;
  }

  // ─── Slice 11.5 — Dev-UI overlays ─────────────────────────────────

  async listTopicMembershipEdges(): Promise<
    Array<{ from: string; to: string }>
  > {
    const out: Array<{ from: string; to: string }> = [];
    for (const edge of this.edges.values()) {
      if (edge.type !== 'HAS_TOPIC') continue;
      const from = this.nodes.get(edge.from);
      const to = this.nodes.get(edge.to);
      if (
        from?.type === 'MemorableKnowledge' &&
        to?.type === 'Topic'
      ) {
        out.push({ from: edge.from, to: edge.to });
      }
    }
    return out;
  }

  async listAllIssues(opts?: { status?: InconsistencyStatus }): Promise<{
    inconsistencies: InconsistencyNode[];
    mergeCandidates: MergeCandidateNode[];
    excerptMergeCandidates: ExcerptMergeCandidateNode[];
    edges: Array<{
      from: string;
      to: string;
      type: 'CONFLICTS_WITH' | 'DUPLICATE_OF' | 'DUPLICATE_EXCERPT_OF';
    }>;
  }> {
    const status = opts?.status;
    const inconsistencies: InconsistencyNode[] = [];
    const mergeCandidates: MergeCandidateNode[] = [];
    const excerptMergeCandidates: ExcerptMergeCandidateNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.type === 'Inconsistency') {
        if (status !== undefined && node.props['status'] !== status) continue;
        const h = this.hydrateInconsistency(node.id);
        if (h) inconsistencies.push(h);
      } else if (node.type === 'MergeCandidate') {
        if (status !== undefined && node.props['status'] !== status) continue;
        const h = this.hydrateMergeCandidate(node.id);
        if (h) mergeCandidates.push(h);
      } else if (node.type === 'ExcerptMergeCandidate') {
        if (status !== undefined && node.props['status'] !== status) continue;
        const h = this.hydrateExcerptMergeCandidate(node.id);
        if (h) excerptMergeCandidates.push(h);
      }
    }
    const edges: Array<{
      from: string;
      to: string;
      type: 'CONFLICTS_WITH' | 'DUPLICATE_OF' | 'DUPLICATE_EXCERPT_OF';
    }> = [];
    for (const edge of this.edges.values()) {
      if (
        edge.type === 'CONFLICTS_WITH' ||
        edge.type === 'DUPLICATE_OF' ||
        edge.type === 'DUPLICATE_EXCERPT_OF'
      ) {
        edges.push({ from: edge.from, to: edge.to, type: edge.type });
      }
    }
    return { inconsistencies, mergeCandidates, excerptMergeCandidates, edges };
  }

  // ─── Slice 12 — ExcerptMergeCandidate + deleteExcerpt ─────────────

  private hydrateExcerptMergeCandidate(
    externalId: string,
  ): ExcerptMergeCandidateNode | null {
    const node = this.nodes.get(externalId);
    if (!node || node.type !== 'ExcerptMergeCandidate') return null;
    const pair = node.props['excerpt_pair'];
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    return {
      id: node.id,
      type: 'ExcerptMergeCandidate' as const,
      props: {
        cosine_sim: node.props['cosine_sim'] as number,
        status: node.props['status'] as ExcerptMergeStatus,
        resolution:
          (node.props['resolution'] as ExcerptMergeResolution | null) ?? null,
        created_at: node.props['created_at'] as string,
        resolved_at: (node.props['resolved_at'] as string | null) ?? null,
        resolved_by: (node.props['resolved_by'] as string | null) ?? null,
      },
      duplicateExcerptOf: [pair[0] as string, pair[1] as string],
    };
  }

  async createExcerptMergeCandidate(
    input: CreateExcerptMergeCandidateInput,
  ): Promise<ExcerptMergeCandidateNode | null> {
    if (input.excerptAExternalId === input.excerptBExternalId) return null;
    const sortedPair: [string, string] = [
      input.excerptAExternalId,
      input.excerptBExternalId,
    ].sort() as [string, string];

    const exA = this.nodes.get(sortedPair[0]);
    const exB = this.nodes.get(sortedPair[1]);
    if (
      !exA ||
      exA.type !== 'PalaiaExcerpt' ||
      !exB ||
      exB.type !== 'PalaiaExcerpt'
    ) {
      return null;
    }

    for (const node of this.nodes.values()) {
      if (node.type !== 'ExcerptMergeCandidate') continue;
      const existing = this.hydrateExcerptMergeCandidate(node.id);
      if (
        existing &&
        existing.duplicateExcerptOf[0] === sortedPair[0] &&
        existing.duplicateExcerptOf[1] === sortedPair[1]
      ) {
        return null;
      }
    }

    const now = new Date().toISOString();
    const externalId = excerptMergeCandidateNodeId(randomUUID());
    this.upsertNode({
      id: externalId,
      type: 'ExcerptMergeCandidate',
      props: {
        cosine_sim: input.cosineSim,
        status: 'open',
        resolution: null,
        created_at: now,
        resolved_at: null,
        resolved_by: null,
        excerpt_pair: sortedPair,
      },
    });
    this.addEdge({
      type: 'DUPLICATE_EXCERPT_OF',
      from: externalId,
      to: sortedPair[0],
    });
    this.addEdge({
      type: 'DUPLICATE_EXCERPT_OF',
      from: externalId,
      to: sortedPair[1],
    });
    return this.hydrateExcerptMergeCandidate(externalId);
  }

  async listExcerptMergeCandidates(
    opts: ListExcerptMergeCandidatesOptions,
  ): Promise<ExcerptMergeCandidateNode[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const out: ExcerptMergeCandidateNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.type !== 'ExcerptMergeCandidate') continue;
      if (opts.status !== undefined && node.props['status'] !== opts.status) {
        continue;
      }
      const hydrated = this.hydrateExcerptMergeCandidate(node.id);
      if (!hydrated) continue;
      // ACL: viewer must own one of the two parent MKs.
      const ownsAtLeastOne = hydrated.duplicateExcerptOf.some((exId) => {
        const parentMkExternalId = this.findParentMkExternalId(exId);
        if (!parentMkExternalId) return false;
        const mk = this.nodes.get(parentMkExternalId);
        const owners = mk?.props['acl_owners'];
        return (
          Array.isArray(owners) &&
          (owners as string[]).includes(opts.viewerOmadiaUserId)
        );
      });
      if (!ownsAtLeastOne) continue;
      out.push(hydrated);
      if (out.length >= limit) break;
    }
    return out;
  }

  private findParentMkExternalId(excerptExternalId: string): string | null {
    for (const edge of this.edges.values()) {
      if (edge.type !== 'EXCERPT_OF') continue;
      if (edge.from !== excerptExternalId) continue;
      return edge.to;
    }
    return null;
  }

  async getExcerptMergeCandidate(
    externalId: string,
    viewerOmadiaUserId: string,
  ): Promise<ExcerptMergeCandidateNode | null> {
    const hydrated = this.hydrateExcerptMergeCandidate(externalId);
    if (!hydrated) return null;
    const ownsAtLeastOne = hydrated.duplicateExcerptOf.some((exId) => {
      const parentMkExternalId = this.findParentMkExternalId(exId);
      if (!parentMkExternalId) return false;
      const mk = this.nodes.get(parentMkExternalId);
      const owners = mk?.props['acl_owners'];
      return (
        Array.isArray(owners) &&
        (owners as string[]).includes(viewerOmadiaUserId)
      );
    });
    return ownsAtLeastOne ? hydrated : null;
  }

  async resolveExcerptMergeCandidate(
    externalId: string,
    resolution: ExcerptMergeResolution,
    actor: AclMutationOptions,
  ): Promise<ExcerptMergeCandidateNode> {
    const existing = await this.getExcerptMergeCandidate(
      externalId,
      actor.actorOmadiaUserId,
    );
    if (!existing) {
      throw Object.assign(new Error('excerpt_merge_candidate_not_found'), {
        code: 'excerpt_merge_candidate_not_found',
      });
    }
    if (existing.props.status !== 'open') {
      throw Object.assign(new Error('already_resolved'), {
        code: 'already_resolved',
      });
    }

    const loser =
      resolution === 'keep_a'
        ? existing.duplicateExcerptOf[1]
        : resolution === 'keep_b'
          ? existing.duplicateExcerptOf[0]
          : null;
    if (loser) {
      const parentMkExternalId = this.findParentMkExternalId(loser);
      const ex = this.nodes.get(loser);
      const position = ex?.props['position'];
      if (parentMkExternalId && typeof position === 'number') {
        await this.deleteExcerpt(parentMkExternalId, position, actor);
      }
    }

    const node = this.nodes.get(externalId);
    if (!node) {
      throw Object.assign(new Error('excerpt_merge_candidate_not_found'), {
        code: 'excerpt_merge_candidate_not_found',
      });
    }
    const now = new Date().toISOString();
    node.props = {
      ...node.props,
      status: resolution === 'not_duplicate' ? 'dismissed' : 'resolved',
      resolution,
      resolved_at: now,
      resolved_by: actor.actorOmadiaUserId,
    };
    return this.hydrateExcerptMergeCandidate(externalId)!;
  }

  async deleteExcerpt(
    memorableKnowledgeNodeId: string,
    position: number,
    actor: AclMutationOptions,
  ): Promise<void> {
    const mk = this.nodes.get(memorableKnowledgeNodeId);
    if (!mk || mk.type !== 'MemorableKnowledge') {
      throw Object.assign(new Error('memory_not_found'), {
        code: 'memory_not_found',
      });
    }
    const owners = Array.isArray(mk.props['acl_owners'])
      ? (mk.props['acl_owners'] as string[])
      : [];
    if (!owners.includes(actor.actorOmadiaUserId)) {
      throw Object.assign(new Error('not_an_owner'), {
        code: 'not_an_owner',
      });
    }

    let excerptExternalId: string | null = null;
    for (const edge of this.edges.values()) {
      if (edge.type !== 'EXCERPT_OF') continue;
      if (edge.to !== memorableKnowledgeNodeId) continue;
      const ex = this.nodes.get(edge.from);
      if (ex?.type === 'PalaiaExcerpt' && ex.props['position'] === position) {
        excerptExternalId = ex.id;
        break;
      }
    }
    if (!excerptExternalId) {
      throw Object.assign(new Error('excerpt_not_found'), {
        code: 'excerpt_not_found',
      });
    }

    // Drop the excerpt + its EXCERPT_OF edge.
    this.nodes.delete(excerptExternalId);
    for (const [key, edge] of [...this.edges.entries()]) {
      if (edge.type !== 'EXCERPT_OF') continue;
      if (edge.from !== excerptExternalId) continue;
      this.edges.delete(key);
    }

    // Audit-row on the MK.
    const audit = this.aclAudit.get(memorableKnowledgeNodeId) ?? [];
    audit.push({
      id: randomUUID(),
      memoryExternalId: memorableKnowledgeNodeId,
      actorOmadiaUserId: actor.actorOmadiaUserId,
      ...(actor.actorChannelIdentityId
        ? { actorChannelIdentityId: actor.actorChannelIdentityId }
        : {}),
      action: 'delete_excerpt',
      beforeOwners: [...owners],
      afterOwners: [...owners],
      ...(actor.reason ? { reason: actor.reason } : {}),
      createdAt: new Date().toISOString(),
    });
    this.aclAudit.set(memorableKnowledgeNodeId, audit);
  }

  async listPalaiaExcerptIdsForBulkMergeCheck(opts: {
    limit: number;
  }): Promise<string[]> {
    const limit = Math.max(1, Math.min(opts.limit, 500));
    const candidates: { id: string; createdAt: string }[] = [];
    for (const node of this.nodes.values()) {
      if (node.type !== 'PalaiaExcerpt') continue;
      if (!this.embeddings.has(node.id)) continue;
      if (node.props['last_excerpt_merge_check_at'] !== undefined) continue;
      const createdAt = String(node.props['created_at'] ?? '');
      candidates.push({ id: node.id, createdAt });
    }
    candidates.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return candidates.slice(0, limit).map((c) => c.id);
  }

  async countPalaiaExcerptMergeCheckBuckets(): Promise<{
    unchecked: number;
    alreadyChecked: number;
    withoutEmbedding: number;
  }> {
    let unchecked = 0;
    let alreadyChecked = 0;
    let withoutEmbedding = 0;
    for (const node of this.nodes.values()) {
      if (node.type !== 'PalaiaExcerpt') continue;
      const hasMarker =
        node.props['last_excerpt_merge_check_at'] !== undefined;
      const hasEmbedding = this.embeddings.has(node.id);
      if (hasMarker) {
        alreadyChecked++;
      } else if (!hasEmbedding) {
        withoutEmbedding++;
      } else {
        unchecked++;
      }
    }
    return { unchecked, alreadyChecked, withoutEmbedding };
  }

  async markPalaiaExcerptMergeChecked(
    excerptExternalId: string,
  ): Promise<void> {
    const node = this.nodes.get(excerptExternalId);
    if (!node || node.type !== 'PalaiaExcerpt') return;
    node.props = {
      ...node.props,
      last_excerpt_merge_check_at: new Date().toISOString(),
    };
  }

  async listMemoryAclAudit(
    memorableKnowledgeNodeId: string,
    opts: { limit?: number } = {},
  ): Promise<AclAuditEntry[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
    const list = this.aclAudit.get(memorableKnowledgeNodeId) ?? [];
    // Newest-first via insertion-order reverse — timestamp sort would
    // be unstable when two audit rows land in the same millisecond
    // (e.g. createMemorableKnowledge followed by addOwner in the same
    // test tick).
    return [...list].reverse().slice(0, limit);
  }

  async listMemoriesForScope(
    scope: string | undefined,
    opts: ListMemoriesForScopeOptions = {},
  ): Promise<MemoriesProvenanceView> {
    const limit = Math.max(1, Math.min(opts.limit ?? 200, 500));
    const includeExcerpts = opts.includeExcerpts !== false;

    const allMks: GraphNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.type !== 'MemorableKnowledge') continue;
      if (scope !== undefined) {
        let inScope = false;
        for (const edge of this.edges.values()) {
          if (edge.type !== 'DERIVED_FROM' || edge.from !== node.id) continue;
          const turn = this.nodes.get(edge.to);
          if (turn?.type === 'Turn' && turn.props['scope'] === scope) {
            inScope = true;
            break;
          }
        }
        if (!inScope) continue;
      }
      allMks.push(node);
    }
    allMks.sort((a, b) => {
      const at = String(a.props['created_at'] ?? '');
      const bt = String(b.props['created_at'] ?? '');
      return bt.localeCompare(at);
    });
    const mks = allMks.slice(0, limit);
    if (mks.length === 0) return { memories: [], edges: [] };

    const mkIds = new Set(mks.map((m) => m.id));
    const edges: MemoryProvenanceEdge[] = [];

    const level1ByMk = new Map<string, GraphNode[]>();
    const level2ByMk = new Map<string, GraphNode[]>();
    const turnsByMk = new Map<string, GraphNode[]>();

    for (const mk of mks) {
      const lvl1: GraphNode[] = [];
      const turns: GraphNode[] = [];
      const seen = new Set<string>();
      for (const edge of this.edges.values()) {
        if (edge.from !== mk.id) continue;
        if (
          edge.type !== 'DERIVED_FROM' &&
          edge.type !== 'INVOLVED' &&
          edge.type !== 'REQUIRES'
        )
          continue;
        const target = this.nodes.get(edge.to);
        if (!target || seen.has(target.id)) continue;
        seen.add(target.id);
        lvl1.push(target);
        edges.push({ from: mk.id, to: target.id, type: edge.type });
        if (edge.type === 'DERIVED_FROM' && target.type === 'Turn') {
          turns.push(target);
        }
      }
      level1ByMk.set(mk.id, lvl1);
      turnsByMk.set(mk.id, turns);
    }

    for (const [mkId, turns] of turnsByMk) {
      const sessions: GraphNode[] = [];
      const seen = new Set<string>();
      for (const turn of turns) {
        for (const edge of this.edges.values()) {
          if (edge.type !== 'IN_SESSION' || edge.from !== turn.id) continue;
          const session = this.nodes.get(edge.to);
          if (!session || seen.has(session.id)) continue;
          seen.add(session.id);
          sessions.push(session);
          edges.push({ from: turn.id, to: session.id, type: 'IN_SESSION' });
        }
      }
      if (sessions.length > 0) level2ByMk.set(mkId, sessions);
    }

    const excerptsByMk = new Map<string, GraphNode[]>();
    if (includeExcerpts) {
      for (const edge of this.edges.values()) {
        if (edge.type !== 'EXCERPT_OF') continue;
        if (!mkIds.has(edge.to)) continue;
        const excerpt = this.nodes.get(edge.from);
        if (!excerpt || excerpt.type !== 'PalaiaExcerpt') continue;
        const list = excerptsByMk.get(edge.to) ?? [];
        list.push(excerpt);
        excerptsByMk.set(edge.to, list);
        edges.push({ from: excerpt.id, to: edge.to, type: 'EXCERPT_OF' });
      }
      for (const list of excerptsByMk.values()) {
        list.sort((a, b) => {
          const ap =
            typeof a.props['position'] === 'number'
              ? (a.props['position'] as number)
              : Number.MAX_SAFE_INTEGER;
          const bp =
            typeof b.props['position'] === 'number'
              ? (b.props['position'] as number)
              : Number.MAX_SAFE_INTEGER;
          return ap - bp;
        });
      }
    }

    const memories: MemoryWithAncestors[] = [];
    for (const mk of mks) {
      const lvl1 = level1ByMk.get(mk.id) ?? [];
      const lvl2 = level2ByMk.get(mk.id) ?? [];
      memories.push({ node: mk, level1: lvl1, level2: lvl2 });
      for (const excerpt of excerptsByMk.get(mk.id) ?? []) {
        memories.push({ node: excerpt, level1: [mk], level2: lvl1 });
      }
    }
    return { memories, edges };
  }

  async findEntities(opts: FindEntitiesOptions): Promise<GraphNode[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 25, 200));
    const nameLower = opts.nameContains?.trim().toLowerCase();
    const out: GraphNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.type !== 'OdooEntity' && node.type !== 'ConfluencePage') continue;
      if (String(node.props['model'] ?? '') !== opts.model) continue;
      if (nameLower && nameLower.length > 0) {
        const hay =
          String(node.props['displayName'] ?? '').toLowerCase() +
          ' ' +
          String(node.props['id'] ?? '').toLowerCase();
        if (!hay.includes(nameLower)) continue;
      }
      out.push(node);
      if (out.length >= limit) break;
    }
    out.sort((a, b) =>
      String(a.props['displayName'] ?? '').localeCompare(
        String(b.props['displayName'] ?? ''),
      ),
    );
    return out;
  }

  async ingestFacts(facts: FactIngest[]): Promise<FactIngestResult> {
    const ids: string[] = [];
    let inserted = 0;
    let updated = 0;
    const extractedAt = new Date().toISOString();
    for (const f of facts) {
      const isUpdate = this.nodes.has(f.factId);
      this.upsertNode({
        id: f.factId,
        type: 'Fact',
        props: {
          sourceTurnId: f.sourceTurnId,
          subject: f.subject,
          predicate: f.predicate,
          object: f.object,
          extractedAt,
          ...(f.confidence !== undefined ? { confidence: f.confidence } : {}),
          ...(f.severity ? { severity: f.severity } : {}),
        },
      });
      ids.push(f.factId);
      if (isUpdate) updated++;
      else inserted++;

      if (this.nodes.has(f.sourceTurnId)) {
        this.addEdge({ type: 'DERIVED_FROM', from: f.factId, to: f.sourceTurnId });
      }
      for (const entId of f.mentionedEntityIds ?? []) {
        if (this.nodes.has(entId)) {
          this.addEdge({ type: 'MENTIONS', from: f.factId, to: entId });
        }
      }
    }
    return { factIds: ids, inserted, updated };
  }

  async ingestEntities(entities: EntityIngest[]): Promise<EntityIngestResult> {
    const ids: string[] = [];
    let inserted = 0;
    let updated = 0;
    for (const ent of entities) {
      const id = entityNodeId({
        system: ent.system,
        model: ent.model,
        id: ent.id,
        op: 'read',
      });
      const nodeType: GraphNodeType =
        ent.system === 'odoo'
          ? 'OdooEntity'
          : ent.system === 'confluence'
            ? 'ConfluencePage'
            : 'PluginEntity';
      const isUpdate = this.nodes.has(id);
      this.upsertNode({
        id,
        type: nodeType,
        props: {
          system: ent.system,
          model: ent.model,
          id: ent.id,
          ...(ent.displayName ? { displayName: ent.displayName } : {}),
          ...(ent.extras ?? {}),
        },
      });
      ids.push(id);
      if (isUpdate) updated++;
      else inserted++;
    }
    return { entityIds: ids, inserted, updated };
  }

  async findEntityCapturedTurns(
    opts: EntityCapturedTurnsOptions,
  ): Promise<EntityCapturedTurnsHit[]> {
    const terms = opts.terms
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length >= 2);
    if (terms.length === 0) return [];

    const perEntityLimit = Math.max(1, Math.min(opts.perEntityLimit ?? 2, 10));
    const entityLimit = Math.max(1, Math.min(opts.entityLimit ?? 5, 25));

    const matchedEntities: GraphNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.type !== 'OdooEntity' && node.type !== 'ConfluencePage') continue;
      const displayName = String(node.props['displayName'] ?? '').toLowerCase();
      const entityId = String(node.props['externalId'] ?? node.props['id'] ?? '').toLowerCase();
      const hit = terms.some(
        (t) => (displayName.length > 0 && displayName.includes(t)) || entityId === t,
      );
      if (hit) matchedEntities.push(node);
      if (matchedEntities.length >= entityLimit) break;
    }

    if (matchedEntities.length === 0) return [];

    const hits: EntityCapturedTurnsHit[] = [];
    for (const entity of matchedEntities) {
      const capturingTurns: GraphNode[] = [];
      for (const edge of this.edges.values()) {
        if (edge.type === 'CAPTURED' && edge.to === entity.id) {
          const turnNode = this.nodes.get(edge.from);
          if (!turnNode || turnNode.type !== 'Turn') continue;
          if (opts.userId && turnNode.props['userId'] !== opts.userId) continue;
          if (opts.excludeScope && turnNode.props['scope'] === opts.excludeScope) continue;
          // Entity node stays global; entity-anchored recall is agent-isolated.
          if (
            !matchesAgentScopePrefix(
              String(turnNode.props['scope'] ?? ''),
              opts.agentScopePrefix,
            )
          )
            continue;
          capturingTurns.push(turnNode);
        }
      }
      capturingTurns.sort((a, b) =>
        String(b.props['time'] ?? '').localeCompare(String(a.props['time'] ?? '')),
      );
      const top = capturingTurns.slice(0, perEntityLimit);
      if (top.length === 0) continue;
      hits.push({
        entity,
        turns: top.map((t) => ({
          turnId: t.id,
          scope: String(t.props['scope'] ?? ''),
          time: String(t.props['time'] ?? ''),
          userMessage: String(t.props['userMessage'] ?? ''),
          assistantAnswer: String(t.props['assistantAnswer'] ?? ''),
        })),
      });
    }

    return hits;
  }

  // ------------------------------------------------------------------------
  // Mutation helpers — private, only called from ingest paths.
  // ------------------------------------------------------------------------

  // --- #133 (plan-as-data) — Plan / PlanStep persistence -------------------

  async ingestPlan(input: PlanIngest): Promise<PlanIngestResult> {
    const planExtId = planNodeId(input.planId);
    this.upsertNode({
      id: planExtId,
      type: 'Plan',
      props: {
        planId: input.planId,
        scope: input.scope,
        // Neon stores userId in the `user_id` column; the in-memory backend
        // has no such column, so it rides in props to keep `listRecentPlans`
        // userId-filtering at parity. Conditional so plans ingested without a
        // userId keep their existing prop shape.
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.turnExternalId ? { turnId: input.turnExternalId } : {}),
        ...(input.strategy ? { strategy: input.strategy } : {}),
        ...(input.createdBy ? { createdBy: input.createdBy } : {}),
        ...(input.requestSummary
          ? { requestSummary: input.requestSummary }
          : {}),
        createdAt: input.createdAt,
      },
    });
    if (input.turnExternalId && this.nodes.has(input.turnExternalId)) {
      this.addEdge({
        type: 'PLAN_OF',
        from: planExtId,
        to: input.turnExternalId,
      });
    }
    return { planExternalId: planExtId };
  }

  async upsertPlanStep(
    input: PlanStepIngest,
  ): Promise<PlanStepIngestResult> {
    const stepExtId = planStepNodeId(input.stepId);
    const planExtId = planNodeId(input.planId);
    if (!this.nodes.has(planExtId)) {
      throw new Error(
        `upsertPlanStep: Plan ${planExtId} not found — call ingestPlan first`,
      );
    }
    this.upsertNode({
      id: stepExtId,
      type: 'PlanStep',
      props: {
        planId: input.planId,
        stepId: input.stepId,
        scope: input.scope,
        goal: input.goal,
        order: input.order,
        status: input.status ?? 'pending',
        ...(input.exitCondition ? { exitCondition: input.exitCondition } : {}),
        ...(input.toolHint ? { toolHint: input.toolHint } : {}),
        ...(input.dependsOnStepIds
          ? { dependsOn: input.dependsOnStepIds }
          : {}),
        ...(input.sideEffecting !== undefined
          ? { sideEffecting: input.sideEffecting }
          : {}),
        ...(input.resultSummary ? { resultSummary: input.resultSummary } : {}),
      },
    });
    this.addEdge({ type: 'STEP_OF', from: stepExtId, to: planExtId });
    for (const depId of input.dependsOnStepIds ?? []) {
      const depExtId = planStepNodeId(depId);
      if (this.nodes.has(depExtId)) {
        this.addEdge({ type: 'DEPENDS_ON', from: stepExtId, to: depExtId });
      }
    }
    return { stepExternalId: stepExtId };
  }

  async getPlan(planExternalId: string): Promise<GraphNode | null> {
    const node = this.nodes.get(planExternalId);
    return node && node.type === 'Plan' ? node : null;
  }

  async getPlanSteps(planExternalId: string): Promise<GraphNode[]> {
    const steps = [...this.edges.values()]
      .filter((e) => e.type === 'STEP_OF' && e.to === planExternalId)
      .map((e) => this.nodes.get(e.from))
      .filter(
        (n): n is GraphNode => n !== undefined && n.type === 'PlanStep',
      );
    return steps.sort((a, b) => {
      const ao = a.props['order'];
      const bo = b.props['order'];
      const an = typeof ao === 'number' ? ao : 0;
      const bn = typeof bo === 'number' ? bo : 0;
      return an - bn;
    });
  }

  async setPlanStepStatus(
    stepExternalId: string,
    status: PlanStepStatus,
    opts?: { resultSummary?: string },
  ): Promise<void> {
    const node = this.nodes.get(stepExternalId);
    if (!node || node.type !== 'PlanStep') return;
    this.upsertNode({
      ...node,
      props: {
        ...node.props,
        status,
        ...(opts?.resultSummary !== undefined
          ? { resultSummary: opts.resultSummary }
          : {}),
      },
    });
  }

  async listPlansForScope(scope: string): Promise<GraphNode[]> {
    return [...this.nodes.values()]
      .filter((n) => n.type === 'Plan' && n.props['scope'] === scope)
      .sort((a, b) =>
        String(b.props['createdAt'] ?? '').localeCompare(
          String(a.props['createdAt'] ?? ''),
        ),
      );
  }

  async deletePlan(planExternalId: string): Promise<PlanDeleteResult> {
    const plan = this.nodes.get(planExternalId);
    if (!plan || plan.type !== 'Plan') {
      return { deleted: false, deletedSteps: 0 };
    }
    // Steps are linked Plan-ward via STEP_OF (from = step, to = plan).
    const stepIds = [...this.edges.values()]
      .filter((e) => e.type === 'STEP_OF' && e.to === planExternalId)
      .map((e) => e.from)
      .filter((id) => this.nodes.get(id)?.type === 'PlanStep');
    const doomed = new Set<string>([planExternalId, ...stepIds]);
    // Drop every edge that touches the plan or any of its steps
    // (STEP_OF, DEPENDS_ON between steps, PLAN_OF to the turn).
    for (const [key, edge] of this.edges) {
      if (doomed.has(edge.from) || doomed.has(edge.to)) this.edges.delete(key);
    }
    for (const id of doomed) this.nodes.delete(id);
    return { deleted: true, deletedSteps: stepIds.length };
  }

  async listRecentPlans(opts: {
    userId?: string;
    limit?: number;
    openOnly?: boolean;
    agentScopePrefix?: string;
  }): Promise<GraphNode[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 5, 50));
    let plans = [...this.nodes.values()].filter((n) => n.type === 'Plan');
    if (opts.userId !== undefined) {
      plans = plans.filter((n) => n.props['userId'] === opts.userId);
    }
    if (opts.agentScopePrefix !== undefined) {
      plans = plans.filter((n) =>
        matchesAgentScopePrefix(
          String(n.props['scope'] ?? ''),
          opts.agentScopePrefix,
        ),
      );
    }
    if (opts.openOnly === true) {
      plans = plans.filter((p) => {
        const steps = [...this.edges.values()]
          .filter((e) => e.type === 'STEP_OF' && e.to === p.id)
          .map((e) => this.nodes.get(e.from))
          .filter(
            (n): n is GraphNode => n !== undefined && n.type === 'PlanStep',
          );
        return steps.some((s) => {
          const st = s.props['status'];
          return st === 'pending' || st === 'in_progress';
        });
      });
    }
    return plans
      .sort((a, b) =>
        String(b.props['createdAt'] ?? '').localeCompare(
          String(a.props['createdAt'] ?? ''),
        ),
      )
      .slice(0, limit);
  }

  private upsertNode(node: GraphNode): void {
    const existing = this.nodes.get(node.id);
    if (!existing) {
      this.nodes.set(node.id, node);
      return;
    }
    // Merge props. Later ingests can refine a node (e.g. a displayName
    // arriving on a subsequent call) without clobbering earlier fields.
    this.nodes.set(node.id, {
      ...existing,
      props: { ...existing.props, ...node.props },
    });
  }

  private upsertEntityNode(nodeId: string, ref: EntityRef): void {
    const type: GraphNodeType = ref.system === 'confluence' ? 'ConfluencePage' : 'OdooEntity';
    const props: Record<string, unknown> = {
      system: ref.system,
      model: ref.model,
      externalId: ref.id,
    };
    if (ref.displayName !== undefined) props['displayName'] = ref.displayName;
    this.upsertNode({ id: nodeId, type, props });
  }

  private addEdge(edge: GraphEdge): void {
    const key = `${edge.from}|${edge.type}|${edge.to}`;
    this.edges.set(key, edge);
  }
}

/**
 * Slice 7 — cosine similarity helper for the InMemory search loops.
 * Returns NaN on length mismatch / zero-norm so callers can drop with
 * a single `Number.isFinite` guard.
 */
function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return Number.NaN;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return Number.NaN;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
