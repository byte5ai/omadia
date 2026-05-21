import { randomUUID } from 'node:crypto';

import {
  agentInvocationNodeId,
  channelIdentityNodeId,
  entityNodeId,
  memorableKnowledgeNodeId,
  runNodeId,
  sessionNodeId,
  toolCallNodeId,
  turnNodeId,
  userNodeId,
  type ChannelIdentityIngest,
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
  type MemorableKnowledgeIngest,
  type MemorableKnowledgeIngestResult,
  type MemorableKnowledgeUpdate,
  type ResolveOrCreateChannelIdentityResult,
  type RunAgentInvocationView,
  type RunIngestResult,
  type RunToolCallView,
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
      props: {
        kind: input.kind,
        summary: input.summary,
        ...(input.rationale ? { rationale: input.rationale } : {}),
        ...(input.significance !== undefined
          ? { significance: input.significance }
          : {}),
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
    // Drop the node + every edge touching it.
    this.nodes.delete(node.id);
    for (const [key, edge] of this.edges.entries()) {
      if (edge.from === node.id || edge.to === node.id) this.edges.delete(key);
    }
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
