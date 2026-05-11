import {
  agentInvocationNodeId,
  companyNodeId,
  entityNodeId,
  financialSnapshotNodeId,
  personNodeId,
  runNodeId,
  sessionNodeId,
  toolCallNodeId,
  turnNodeId,
  userNodeId,
  type CompanyIngest,
  type EntityRef,
  type CompanyIngestResult,
  type CompanyRelationsIngest,
  type CompanyRelationsResult,
  type EntityCapturedTurnsHit,
  type EntityCapturedTurnsOptions,
  type EntityIngest,
  type EntityIngestResult,
  type FactIngest,
  type FactIngestResult,
  type FinancialSnapshotIngest,
  type FinancialSnapshotIngestResult,
  type FindEntitiesOptions,
  type GraphEdge,
  type GraphEdgeType,
  type GraphNode,
  type GraphNodeType,
  type GraphStats,
  type KnowledgeGraph,
  type LinkCompanyToEntityOptions,
  type LinkCompanyToEntityResult,
  type PersonIngest,
  type PersonIngestResult,
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
    return { session, turns };
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
      Run: 0,
      AgentInvocation: 0,
      ToolCall: 0,
      Fact: 0,
      Company: 0,
      Person: 0,
      FinancialSnapshot: 0,
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
      MANAGES: 0,
      SHAREHOLDER_OF: 0,
      SUCCEEDED_BY: 0,
      REFERS_TO: 0,
      HAS_FINANCIALS: 0,
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

    if (userNode && trace.userId) {
      this.upsertNode({
        id: userNode,
        type: 'User',
        props: {
          userId: trace.userId,
          firstSeenAt: trace.startedAt,
          lastSeenAt: trace.finishedAt,
        },
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

  async ingestCompanies(
    companies: CompanyIngest[],
  ): Promise<CompanyIngestResult> {
    const companyIds: string[] = [];
    let inserted = 0;
    let updated = 0;
    const lastSyncedAt = new Date().toISOString();
    for (const c of companies) {
      const id = companyNodeId(c.externalId);
      const isUpdate = this.nodes.has(id);
      this.upsertNode({
        id,
        type: 'Company',
        props: {
          system: 'northdata',
          externalId: c.externalId,
          name: c.name,
          lastSyncedAt,
          ...(c.rawName ? { rawName: c.rawName } : {}),
          ...(c.legalForm ? { legalForm: c.legalForm } : {}),
          ...(c.registerCourt ? { registerCourt: c.registerCourt } : {}),
          ...(c.registerNumber ? { registerNumber: c.registerNumber } : {}),
          ...(c.registerCountry ? { registerCountry: c.registerCountry } : {}),
          ...(c.status ? { status: c.status } : {}),
          ...(c.terminated !== undefined ? { terminated: c.terminated } : {}),
          ...(c.address ? { address: c.address } : {}),
          ...(c.vatId ? { vatId: c.vatId } : {}),
          ...(c.proxyPolicy ? { proxyPolicy: c.proxyPolicy } : {}),
          ...(c.northDataUrl ? { northDataUrl: c.northDataUrl } : {}),
          ...(c.segmentCodes ? { segmentCodes: c.segmentCodes } : {}),
          ...(c.riskLevel ? { riskLevel: c.riskLevel } : {}),
          ...(c.riskSignals && c.riskSignals.length > 0
            ? { riskSignals: c.riskSignals }
            : {}),
          ...(c.isWatched !== undefined ? { isWatched: c.isWatched } : {}),
          ...(c.extras ?? {}),
        },
      });
      companyIds.push(id);
      if (isUpdate) updated++;
      else inserted++;
    }
    return { companyIds, inserted, updated };
  }

  async ingestPersons(persons: PersonIngest[]): Promise<PersonIngestResult> {
    const personIds: string[] = [];
    let inserted = 0;
    let updated = 0;
    const lastSyncedAt = new Date().toISOString();
    for (const p of persons) {
      const id = personNodeId(p.externalId);
      const isUpdate = this.nodes.has(id);
      this.upsertNode({
        id,
        type: 'Person',
        props: {
          system: 'northdata',
          externalId: p.externalId,
          name: p.name,
          lastName: p.lastName,
          lastSyncedAt,
          ...(p.firstName ? { firstName: p.firstName } : {}),
          ...(p.birthDate ? { birthDate: p.birthDate } : {}),
          ...(p.city ? { city: p.city } : {}),
          ...(p.internalNorthDataId
            ? { internalNorthDataId: p.internalNorthDataId }
            : {}),
          ...(p.extras ?? {}),
        },
      });
      personIds.push(id);
      if (isUpdate) updated++;
      else inserted++;
    }
    return { personIds, inserted, updated };
  }

  async ingestCompanyRelations(
    relations: CompanyRelationsIngest,
  ): Promise<CompanyRelationsResult> {
    const result: CompanyRelationsResult = {
      manages: 0,
      shareholders: 0,
      successions: 0,
      skipped: 0,
    };
    for (const m of relations.manages ?? []) {
      const from = personNodeId(m.personExternalId);
      const to = companyNodeId(m.companyExternalId);
      if (!this.nodes.has(from) || !this.nodes.has(to)) {
        result.skipped++;
        continue;
      }
      this.addEdge({
        type: 'MANAGES',
        from,
        to,
        props: {
          ...(m.role ? { role: m.role } : {}),
          ...(m.since ? { since: m.since } : {}),
          ...(m.until ? { until: m.until } : {}),
        },
      });
      result.manages++;
    }
    for (const s of relations.shareholders ?? []) {
      const from =
        s.holderType === 'Company'
          ? companyNodeId(s.holderExternalId)
          : personNodeId(s.holderExternalId);
      const to = companyNodeId(s.companyExternalId);
      if (!this.nodes.has(from) || !this.nodes.has(to)) {
        result.skipped++;
        continue;
      }
      this.addEdge({
        type: 'SHAREHOLDER_OF',
        from,
        to,
        props: {
          ...(s.sharePercent !== undefined
            ? { sharePercent: s.sharePercent }
            : {}),
          ...(s.since ? { since: s.since } : {}),
          ...(s.until ? { until: s.until } : {}),
        },
      });
      result.shareholders++;
    }
    for (const succ of relations.successions ?? []) {
      const from = companyNodeId(succ.fromCompanyExternalId);
      const to = companyNodeId(succ.toCompanyExternalId);
      if (!this.nodes.has(from) || !this.nodes.has(to)) {
        result.skipped++;
        continue;
      }
      this.addEdge({
        type: 'SUCCEEDED_BY',
        from,
        to,
        props: {
          ...(succ.reason ? { reason: succ.reason } : {}),
        },
      });
      result.successions++;
    }
    return result;
  }

  async linkCompanyToEntity(
    opts: LinkCompanyToEntityOptions,
  ): Promise<LinkCompanyToEntityResult> {
    const from = companyNodeId(opts.companyExternalId);
    const to = opts.entityExternalId;
    if (!this.nodes.has(from) || !this.nodes.has(to)) {
      return { linked: false };
    }
    this.addEdge({ type: 'REFERS_TO', from, to });
    return { linked: true };
  }

  async ingestFinancialSnapshots(
    snapshots: FinancialSnapshotIngest[],
  ): Promise<FinancialSnapshotIngestResult> {
    const snapshotIds: string[] = [];
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    const lastSyncedAt = new Date().toISOString();
    for (const s of snapshots) {
      const companyId = companyNodeId(s.companyExternalId);
      if (!this.nodes.has(companyId)) {
        skipped++;
        continue;
      }
      const id = financialSnapshotNodeId(s.companyExternalId, s.fiscalYear);
      const isUpdate = this.nodes.has(id);
      this.upsertNode({
        id,
        type: 'FinancialSnapshot',
        props: {
          companyExternalId: s.companyExternalId,
          fiscalYear: s.fiscalYear,
          lastSyncedAt,
          ...(s.date ? { date: s.date } : {}),
          ...(s.consolidated !== undefined
            ? { consolidated: s.consolidated }
            : {}),
          ...(s.sourceName ? { sourceName: s.sourceName } : {}),
          items: s.items,
        },
      });
      snapshotIds.push(id);
      if (isUpdate) updated++;
      else inserted++;
      this.addEdge({
        type: 'HAS_FINANCIALS',
        from: companyId,
        to: id,
        props: {
          fiscalYear: s.fiscalYear,
          ...(s.consolidated !== undefined
            ? { consolidated: s.consolidated }
            : {}),
        },
      });
    }
    return { snapshotIds, inserted, updated, skipped };
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
