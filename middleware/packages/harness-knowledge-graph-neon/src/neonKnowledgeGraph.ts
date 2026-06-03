import { Pool, type PoolClient } from 'pg';

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
  type EntityCapturedTurnsHit,
  type EntityCapturedTurnsOptions,
  type EntityIngest,
  type EntityIngestResult,
  type EntryType,
  type FactIngest,
  type FactIngestResult,
  type FindEntitiesOptions,
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
  type TaskStatus,
  type Tier,
  type TurnIngest,
  type TurnIngestResult,
  type TurnSearchHit,
  type Visibility,
} from '@omadia/plugin-api';
import type { EmbeddingClient } from '@omadia/embeddings';
import {
  GRAPH_EDGE_TYPES,
  GRAPH_NODE_TYPES,
  validateNodeProps,
} from './schema.js';

export interface NeonKnowledgeGraphOptions {
  pool: Pool;
  tenantId?: string;
  /**
   * Optional embedding client used to populate the Turn `embedding` column on
   * every ingest. When absent, `embedding` stays NULL and semantic search
   * falls back to FTS. Embedding failures are logged and non-fatal — the
   * turn is still written to the graph.
   */
  embeddingClient?: EmbeddingClient;
  /**
   * OB-73 (Phase 4) — optional read-path access tracker. When wired, every
   * Turn surfaced by `searchTurns`, `searchTurnsByEmbedding`, `getSession`
   * and `findEntityCapturedTurns` is recorded in-memory and batched into
   * `access_count` / `accessed_at` / COLD→WARM-promotion at decay-sweep
   * time. Absent → reads don't update access metadata (legacy behaviour).
   */
  accessTracker?: { markAccessed(externalId: string | null | undefined): void };
}

export interface NodeRow {
  id: string;
  external_id: string;
  type: string;
  scope: string | null;
  properties: Record<string, unknown>;
  // Palaia (OB-70). Optional in the row interface so SELECTs predating
  // the uplift still compile against this type; rowToNode treats every
  // missing column as "not projected" rather than "default".
  entry_type?: string;
  visibility?: string;
  tier?: string;
  accessed_at?: Date | string | null;
  access_count?: number | string;
  decay_score?: number | string;
  content_hash?: string | null;
  manually_authored?: boolean;
  task_status?: string | null;
  significance?: number | string | null;
}

/**
 * Comma-separated graph_nodes column list for SELECTs that flow through
 * {@link rowToNode}. Centralised so adding a column means editing one place.
 * Callers that only ever look at `external_id`/`scope`/`properties` (e.g. FTS
 * scoring, embedding similarity) keep their tighter projections.
 */
const NODE_COLUMNS =
  'id, external_id, type, scope, properties, entry_type, visibility, tier, accessed_at, access_count, decay_score, content_hash, manually_authored, task_status, significance';

interface RunToolCallWritePayload {
  callId: string;
  toolName: string;
  durationMs: number;
  isError: boolean;
  agentContext: string;
  producedEntityIds?: string[];
}

export function createNeonPool(connectionString: string, poolMax = 5): Pool {
  return new Pool({ connectionString, max: poolMax });
}

/**
 * Postgres-backed knowledge graph (Neon serverless).
 *
 * Identity model: every node has a stable `external_id` (session:<scope>,
 * turn:<scope>:<time>, <system>:<model>:<id>) that matches the in-memory
 * implementation. Callers keep using those string ids; the UUID primary key
 * only matters inside SQL.
 */
export class NeonKnowledgeGraph implements KnowledgeGraph {
  private readonly pool: Pool;

  private readonly tenantId: string;

  private readonly embeddingClient: EmbeddingClient | undefined;

  private readonly accessTracker:
    | { markAccessed(externalId: string | null | undefined): void }
    | undefined;

  constructor(opts: NeonKnowledgeGraphOptions) {
    this.pool = opts.pool;
    this.tenantId = opts.tenantId ?? 'default';
    this.embeddingClient = opts.embeddingClient;
    this.accessTracker = opts.accessTracker;
  }

  async ingestTurn(turn: TurnIngest): Promise<TurnIngestResult> {
    const sessionExtId = sessionNodeId(turn.scope);
    const turnExtId = turnNodeId(turn.scope, turn.time);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const sessionProps = validateNodeProps('Session', {
        scope: turn.scope,
        firstSeenAt: turn.time,
        lastSeenAt: turn.time,
        ...(turn.userId ? { userId: turn.userId } : {}),
      });
      const sessionUuid = await this.upsertNode(client, {
        externalId: sessionExtId,
        type: 'Session',
        scope: turn.scope,
        userId: turn.userId ?? null,
        props: sessionProps,
        mergeProps: { lastSeenAt: turn.time },
      });

      const turnProps = validateNodeProps('Turn', {
        scope: turn.scope,
        time: turn.time,
        userMessage: turn.userMessage,
        assistantAnswer: turn.assistantAnswer,
        ...(turn.toolCalls !== undefined ? { toolCalls: turn.toolCalls } : {}),
        ...(turn.iterations !== undefined
          ? { iterations: turn.iterations }
          : {}),
      });
      const turnUuid = await this.upsertNode(client, {
        externalId: turnExtId,
        type: 'Turn',
        scope: turn.scope,
        userId: turn.userId ?? null,
        props: turnProps,
        entryType: turn.entryType,
        visibility: turn.visibility,
        significance: turn.significance,
      });

      await this.upsertEdge(client, {
        type: 'IN_SESSION',
        fromUuid: turnUuid,
        toUuid: sessionUuid,
      });

      await this.rebuildNextTurnLinks(client, turn.scope, {
        turnUuid,
        time: turn.time,
      });

      const entityNodeIds: string[] = [];
      for (const ref of turn.entityRefs) {
        const extId = entityNodeId(ref);
        const nodeType: GraphNodeType =
          ref.system === 'confluence' ? 'ConfluencePage' : 'OdooEntity';
        const props = validateNodeProps(nodeType, {
          system: ref.system,
          model: ref.model,
          id: ref.id,
          ...(ref.displayName ? { displayName: ref.displayName } : {}),
        });
        const entityUuid = await this.upsertNode(client, {
          externalId: extId,
          type: nodeType,
          scope: null,
          userId: null,
          props,
        });
        await this.upsertEdge(client, {
          type: 'CAPTURED',
          fromUuid: turnUuid,
          toUuid: entityUuid,
        });
        entityNodeIds.push(extId);
      }

      await client.query('COMMIT');

      // Embed the turn *after* commit: a slow embedding sidecar must not
      // block (or roll back) the main ingest. Failure is logged and left
      // as NULL — next retrieval just falls back to FTS for this turn.
      if (this.embeddingClient) {
        void this.embedAndStoreTurn(turnUuid, turn.userMessage, turn.assistantAnswer);
      }

      return { sessionId: sessionExtId, turnId: turnExtId, entityNodeIds };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async ingestEntities(entities: EntityIngest[]): Promise<EntityIngestResult> {
    if (entities.length === 0) {
      return { entityIds: [], inserted: 0, updated: 0 };
    }
    const client = await this.pool.connect();
    const entityIds: string[] = [];
    let inserted = 0;
    let updated = 0;
    try {
      await client.query('BEGIN');
      for (const ent of entities) {
        const extId = entityNodeId({
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
        const props = validateNodeProps(nodeType, {
          system: ent.system,
          model: ent.model,
          id: ent.id,
          ...(ent.displayName ? { displayName: ent.displayName } : {}),
          ...(ent.extras ?? {}),
        });
        const isUpdate = await this.nodeExists(client, extId);
        await this.upsertNode(client, {
          externalId: extId,
          type: nodeType,
          scope: null,
          userId: null,
          props,
        });
        entityIds.push(extId);
        if (isUpdate) updated++;
        else inserted++;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return { entityIds, inserted, updated };
  }

  async ingestFacts(facts: FactIngest[]): Promise<FactIngestResult> {
    if (facts.length === 0) {
      return { factIds: [], inserted: 0, updated: 0 };
    }
    const client = await this.pool.connect();
    const factIds: string[] = [];
    let inserted = 0;
    let updated = 0;
    try {
      await client.query('BEGIN');
      const extractedAt = new Date().toISOString();
      for (const f of facts) {
        const props = validateNodeProps('Fact', {
          sourceTurnId: f.sourceTurnId,
          subject: f.subject,
          predicate: f.predicate,
          object: f.object,
          extractedAt,
          ...(f.confidence !== undefined ? { confidence: f.confidence } : {}),
          ...(f.severity ? { severity: f.severity } : {}),
        });
        const wasUpdate = await this.nodeExists(client, f.factId);
        const factUuid = await this.upsertNode(client, {
          externalId: f.factId,
          type: 'Fact',
          scope: null,
          userId: null,
          props,
        });
        factIds.push(f.factId);
        if (wasUpdate) updated++;
        else inserted++;

        // Wire the Fact → Turn provenance edge. The turn node might not
        // exist yet (backfill race) — upsertEdge-by-uuid requires both ends,
        // so we resolve with tolerance: missing turn → skip the edge, keep
        // the fact.
        const turnUuid = await this.findUuidByExternalId(client, f.sourceTurnId);
        if (turnUuid) {
          await this.upsertEdge(client, {
            type: 'DERIVED_FROM',
            fromUuid: factUuid,
            toUuid: turnUuid,
          });
        }

        // MENTIONS edges: fact → each referenced entity. Tolerates missing
        // entities the same way (sync may not have reached them yet).
        for (const entExtId of f.mentionedEntityIds ?? []) {
          const entUuid = await this.findUuidByExternalId(client, entExtId);
          if (!entUuid) continue;
          await this.upsertEdge(client, {
            type: 'MENTIONS',
            fromUuid: factUuid,
            toUuid: entUuid,
          });
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return { factIds, inserted, updated };
  }

  private async findUuidByExternalId(
    client: PoolClient,
    externalId: string,
  ): Promise<string | null> {
    const result = await client.query<{ id: string }>(
      `SELECT id FROM graph_nodes WHERE tenant_id = $1 AND external_id = $2 LIMIT 1`,
      [this.tenantId, externalId],
    );
    return result.rows[0]?.id ?? null;
  }

  private async nodeExists(
    client: PoolClient,
    externalId: string,
  ): Promise<boolean> {
    const result = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM graph_nodes WHERE tenant_id = $1 AND external_id = $2
       ) AS exists`,
      [this.tenantId, externalId],
    );
    return Boolean(result.rows[0]?.exists);
  }

  /**
   * Compute the embedding for a freshly-ingested Turn and write it back to
   * the embedding column. Runs fire-and-forget relative to the ingest
   * transaction — logs every failure on stderr (Fly drops stdout INFO under
   * load) but never throws to the caller.
   */
  private async embedAndStoreTurn(
    turnUuid: string,
    userMessage: string,
    assistantAnswer: string,
  ): Promise<void> {
    if (!this.embeddingClient) return;
    const text = `${userMessage}\n\n${assistantAnswer}`.trim();
    if (text.length === 0) return;
    // Skip re-embedding a turn that already has a vector. The Markdown replay
    // in backfillGraph() re-runs ingestTurn for every historical transcript
    // on every boot — without this guard, ~30 Ollama requests would fire at
    // once on restart, overwhelming the sidecar. For turns that genuinely
    // need (re-)embedding, the row is left with `embedding = NULL` upstream
    // and the backfill scheduler picks it up.
    const existing = await this.pool.query<{ has_embedding: boolean }>(
      `SELECT embedding IS NOT NULL AS has_embedding FROM graph_nodes WHERE id = $1`,
      [turnUuid],
    );
    if (existing.rows[0]?.has_embedding === true) return;
    try {
      const vector = await this.embeddingClient.embed(text);
      if (vector.length === 0) return;
      await this.pool.query(
        `UPDATE graph_nodes
           SET embedding = $1::vector,
               embedding_attempts = 0,
               embedding_last_error_at = NULL,
               embedding_last_error = NULL
         WHERE id = $2`,
        [vectorLiteral(vector), turnUuid],
      );
      console.error(
        `[graph] embedded turn uuid=${turnUuid.slice(0, 8)}… dims=${String(vector.length)}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[graph] embed failed turn uuid=${turnUuid.slice(0, 8)}…:`,
        message,
      );
      // Bump the attempt counter so the backfill scheduler can cap retries
      // on permanently broken turns. Soft-failing here too: if even this
      // UPDATE fails (pool exhausted, network blip), we still swallow — the
      // main ingest path already committed.
      try {
        await this.pool.query(
          `UPDATE graph_nodes
             SET embedding_attempts = embedding_attempts + 1,
                 embedding_last_error_at = NOW(),
                 embedding_last_error = $1
           WHERE id = $2`,
          [message.slice(0, 500), turnUuid],
        );
      } catch {
        // swallow — see comment above
      }
    }
  }

  async getSession(scope: string): Promise<SessionView | null> {
    const sessionExtId = sessionNodeId(scope);
    const sessionRow = await this.findNodeByExternalId(sessionExtId);
    if (!sessionRow) return null;

    const turnRows = await this.pool.query<NodeRow>(
      `
      SELECT ${NODE_COLUMNS}
      FROM graph_nodes
      WHERE tenant_id = $1 AND type = 'Turn' AND scope = $2
      ORDER BY (properties->>'time') ASC
      `,
      [this.tenantId, scope],
    );

    const turnUuids = turnRows.rows.map((r) => r.id);
    const entityByTurn = new Map<string, GraphNode[]>();
    if (turnUuids.length > 0) {
      const capturedRows = await this.pool.query<NodeRow & { from_uuid: string }>(
        `
        SELECT e.from_node AS from_uuid, ${NODE_COLUMNS.split(', ').map((c) => `n.${c}`).join(', ')}
        FROM graph_edges e
        JOIN graph_nodes n ON n.id = e.to_node
        WHERE e.tenant_id = $1 AND e.type = 'CAPTURED' AND e.from_node = ANY($2::uuid[])
        `,
        [this.tenantId, turnUuids],
      );
      for (const row of capturedRows.rows) {
        const node = rowToNode(row);
        const list = entityByTurn.get(row.from_uuid) ?? [];
        list.push(node);
        entityByTurn.set(row.from_uuid, list);
      }
    }

    // OB-73 — getSession is an audit-style read (dev UI / replay). Record
    // every Turn access so the decay sweep keeps the session warm.
    for (const r of turnRows.rows) {
      this.accessTracker?.markAccessed(r.external_id);
    }

    // Slice 1b-channel-web — include the User-Cluster so graph viewers
    // render the user as a first-class session neighbor without a 2-hop
    // walk via the Turn → User BELONGS_TO edge.
    const sessionUserId =
      typeof sessionRow.properties === 'object' &&
      sessionRow.properties !== null
        ? (sessionRow.properties as { userId?: unknown })['userId']
        : undefined;
    let user: GraphNode | undefined;
    if (typeof sessionUserId === 'string' && sessionUserId.length > 0) {
      const userRow = await this.findNodeByExternalId(userNodeId(sessionUserId));
      if (userRow) user = rowToNode(userRow);
    }

    return {
      session: rowToNode(sessionRow),
      turns: turnRows.rows.map((r) => ({
        turn: rowToNode(r),
        entities: entityByTurn.get(r.id) ?? [],
      })),
      ...(user ? { user } : {}),
    };
  }

  async listSessions(filter?: SessionFilter): Promise<SessionSummary[]> {
    // Parameterised userId filter: NULL means "all users", a string value
    // requires exact match on the session's user_id. Legacy sessions with
    // NULL user_id are excluded from any userId-scoped query.
    const userIdFilter = filter?.userId ?? null;
    const result = await this.pool.query<{
      external_id: string;
      scope: string;
      turn_count: string;
      first_at: string;
      last_at: string;
    }>(
      `
      SELECT
        s.external_id,
        s.scope,
        COUNT(t.id)::text AS turn_count,
        MIN(t.properties->>'time') AS first_at,
        MAX(t.properties->>'time') AS last_at
      FROM graph_nodes s
      LEFT JOIN graph_nodes t
        ON t.tenant_id = s.tenant_id
       AND t.type = 'Turn'
       AND t.scope = s.scope
      WHERE s.tenant_id = $1
        AND s.type = 'Session'
        AND ($2::text IS NULL OR s.user_id = $2)
      GROUP BY s.external_id, s.scope
      HAVING COUNT(t.id) > 0
      ORDER BY last_at DESC
      `,
      [this.tenantId, userIdFilter],
    );

    return result.rows.map((r) => ({
      id: r.external_id,
      scope: r.scope,
      turnCount: Number(r.turn_count),
      firstAt: r.first_at ?? '',
      lastAt: r.last_at ?? '',
    }));
  }

  async getNeighbors(nodeId: string): Promise<GraphNode[]> {
    const node = await this.findNodeByExternalId(nodeId);
    if (!node) return [];
    const result = await this.pool.query<NodeRow>(
      `
      SELECT DISTINCT ${NODE_COLUMNS.split(', ').map((c) => `n.${c}`).join(', ')}
      FROM graph_edges e
      JOIN graph_nodes n
        ON n.id = CASE WHEN e.from_node = $2 THEN e.to_node ELSE e.from_node END
      WHERE e.tenant_id = $1
        AND (e.from_node = $2 OR e.to_node = $2)
      `,
      [this.tenantId, node.id],
    );
    return result.rows.map(rowToNode);
  }

  async stats(): Promise<GraphStats> {
    const nodeCounts = await this.pool.query<{ type: string; count: string }>(
      `SELECT type, COUNT(*)::text AS count
       FROM graph_nodes WHERE tenant_id = $1 GROUP BY type`,
      [this.tenantId],
    );
    const edgeCounts = await this.pool.query<{ type: string; count: string }>(
      `SELECT type, COUNT(*)::text AS count
       FROM graph_edges WHERE tenant_id = $1 GROUP BY type`,
      [this.tenantId],
    );

    const byNodeType = Object.fromEntries(
      GRAPH_NODE_TYPES.map((t) => [t, 0]),
    ) as Record<GraphNodeType, number>;
    for (const row of nodeCounts.rows) {
      if ((GRAPH_NODE_TYPES as readonly string[]).includes(row.type)) {
        byNodeType[row.type as GraphNodeType] = Number(row.count);
      }
    }

    const byEdgeType = Object.fromEntries(
      GRAPH_EDGE_TYPES.map((t) => [t, 0]),
    ) as Record<GraphEdgeType, number>;
    for (const row of edgeCounts.rows) {
      if ((GRAPH_EDGE_TYPES as readonly string[]).includes(row.type)) {
        byEdgeType[row.type as GraphEdgeType] = Number(row.count);
      }
    }

    const totals = await this.pool.query<{ nodes: string; edges: string }>(
      `SELECT
         (SELECT COUNT(*) FROM graph_nodes WHERE tenant_id = $1)::text AS nodes,
         (SELECT COUNT(*) FROM graph_edges WHERE tenant_id = $1)::text AS edges`,
      [this.tenantId],
    );

    return {
      nodes: Number(totals.rows[0]?.nodes ?? 0),
      edges: Number(totals.rows[0]?.edges ?? 0),
      byNodeType,
      byEdgeType,
    };
  }

  async ingestRun(trace: RunTrace): Promise<RunIngestResult> {
    const runExtId = runNodeId(trace.turnId);
    const userExtId = trace.userId ? userNodeId(trace.userId) : undefined;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Resolve the Turn's UUID — the run's EXECUTED edge needs it. If the
      // Turn doesn't exist yet (race against ingestTurn) we abort cleanly
      // rather than writing a dangling Run.
      const turnRow = await client.query<{ id: string }>(
        `SELECT id FROM graph_nodes
         WHERE tenant_id = $1 AND external_id = $2 AND type = 'Turn'`,
        [this.tenantId, trace.turnId],
      );
      const turnUuid = turnRow.rows[0]?.id;
      if (!turnUuid) {
        await client.query('ROLLBACK');
        throw new Error(
          `ingestRun: Turn node ${trace.turnId} not found — call ingestTurn first`,
        );
      }

      // Slice 1b — `trace.userId` is the cluster-root `omadiaUserId`.
      // The User-Cluster node must already exist (created upstream via
      // `resolveOrCreateChannelIdentity`). We verify, refresh `lastSeenAt`,
      // and link via BELONGS_TO. We do NOT auto-create the cluster here —
      // doing so would mask channel-resolution bugs by silently producing
      // orphan clusters with no IS_IDENTITY_OF edges.
      let userUuid: string | undefined;
      if (userExtId && trace.userId) {
        const userRow = await client.query<{ id: string }>(
          `SELECT id FROM graph_nodes
           WHERE tenant_id = $1 AND external_id = $2 AND type = 'User'`,
          [this.tenantId, userExtId],
        );
        userUuid = userRow.rows[0]?.id;
        if (!userUuid) {
          await client.query('ROLLBACK');
          throw new Error(
            `ingestRun: User-Cluster ${userExtId} not found — call resolveOrCreateChannelIdentity first`,
          );
        }
        // Refresh lastSeenAt so cluster activity stays current.
        await client.query(
          `UPDATE graph_nodes
             SET properties = jsonb_set(properties, '{lastSeenAt}', to_jsonb($2::text))
           WHERE id = $1`,
          [userUuid, trace.finishedAt],
        );
        await this.upsertEdge(client, {
          type: 'BELONGS_TO',
          fromUuid: turnUuid,
          toUuid: userUuid,
        });
      }

      const totalToolCalls =
        trace.orchestratorToolCalls.length +
        trace.agentInvocations.reduce(
          (acc, inv) => acc + inv.toolCalls.length,
          0,
        );

      const runProps = validateNodeProps('Run', {
        turnId: trace.turnId,
        scope: trace.scope,
        startedAt: trace.startedAt,
        finishedAt: trace.finishedAt,
        durationMs: trace.durationMs,
        status: trace.status,
        iterations: trace.iterations,
        toolCalls: totalToolCalls,
        ...(trace.error ? { error: trace.error } : {}),
      });
      const runUuid = await this.upsertNode(client, {
        externalId: runExtId,
        type: 'Run',
        scope: trace.scope,
        userId: trace.userId ?? null,
        props: runProps,
      });
      await this.upsertEdge(client, {
        type: 'EXECUTED',
        fromUuid: turnUuid,
        toUuid: runUuid,
      });

      const toolCallIds: string[] = [];
      const agentInvocationIds: string[] = [];

      const writeToolCall = async (
        call: RunToolCallWritePayload,
        parentUuid: string,
      ): Promise<void> => {
        const tcExtId = toolCallNodeId(trace.turnId, call.callId);
        toolCallIds.push(tcExtId);
        const tcProps = validateNodeProps('ToolCall', {
          runId: runExtId,
          toolName: call.toolName,
          durationMs: call.durationMs,
          isError: call.isError,
          agentContext: call.agentContext,
        });
        const tcUuid = await this.upsertNode(client, {
          externalId: tcExtId,
          type: 'ToolCall',
          scope: trace.scope,
          userId: trace.userId ?? null,
          props: tcProps,
        });
        await this.upsertEdge(client, {
          type: 'INVOKED_TOOL',
          fromUuid: parentUuid,
          toUuid: tcUuid,
        });
        for (const producedExt of call.producedEntityIds ?? []) {
          const entRow = await client.query<{ id: string }>(
            `SELECT id FROM graph_nodes
             WHERE tenant_id = $1 AND external_id = $2`,
            [this.tenantId, producedExt],
          );
          const entUuid = entRow.rows[0]?.id;
          if (entUuid) {
            await this.upsertEdge(client, {
              type: 'PRODUCED',
              fromUuid: tcUuid,
              toUuid: entUuid,
            });
          }
        }
      };

      for (const call of trace.orchestratorToolCalls) {
        await writeToolCall(
          { ...call, agentContext: 'orchestrator' },
          runUuid,
        );
      }

      for (const inv of trace.agentInvocations) {
        const invExtId = agentInvocationNodeId(
          trace.turnId,
          inv.agentName,
          inv.index,
        );
        agentInvocationIds.push(invExtId);
        const invProps = validateNodeProps('AgentInvocation', {
          runId: runExtId,
          agentName: inv.agentName,
          index: inv.index,
          durationMs: inv.durationMs,
          subIterations: inv.subIterations,
          subToolCount: inv.toolCalls.length,
          status: inv.status,
        });
        const invUuid = await this.upsertNode(client, {
          externalId: invExtId,
          type: 'AgentInvocation',
          scope: trace.scope,
          userId: trace.userId ?? null,
          props: invProps,
        });
        await this.upsertEdge(client, {
          type: 'INVOKED_AGENT',
          fromUuid: runUuid,
          toUuid: invUuid,
        });
        for (const call of inv.toolCalls) {
          await writeToolCall(
            { ...call, agentContext: inv.agentName },
            invUuid,
          );
        }
      }

      await client.query('COMMIT');
      const result: RunIngestResult = {
        runId: runExtId,
        agentInvocationIds,
        toolCallIds,
      };
      if (userExtId) result.userNodeId = userExtId;
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // --- #133 (plan-as-data) — Plan / PlanStep persistence -------------------

  async ingestPlan(input: PlanIngest): Promise<PlanIngestResult> {
    const planExtId = planNodeId(input.planId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const props = validateNodeProps('Plan', {
        planId: input.planId,
        scope: input.scope,
        ...(input.turnExternalId ? { turnId: input.turnExternalId } : {}),
        ...(input.strategy ? { strategy: input.strategy } : {}),
        ...(input.createdBy ? { createdBy: input.createdBy } : {}),
        createdAt: input.createdAt,
      });
      const planUuid = await this.upsertNode(client, {
        externalId: planExtId,
        type: 'Plan',
        scope: input.scope,
        userId: input.userId ?? null,
        props,
      });
      // Link Plan -> Turn (PLAN_OF) when the Turn already exists. A missing
      // Turn is tolerated — the plan stands on its own.
      if (input.turnExternalId) {
        const turnRow = await client.query<{ id: string }>(
          `SELECT id FROM graph_nodes
           WHERE tenant_id = $1 AND external_id = $2 AND type = 'Turn'`,
          [this.tenantId, input.turnExternalId],
        );
        const turnUuid = turnRow.rows[0]?.id;
        if (turnUuid) {
          await this.upsertEdge(client, {
            type: 'PLAN_OF',
            fromUuid: planUuid,
            toUuid: turnUuid,
          });
        }
      }
      await client.query('COMMIT');
      return { planExternalId: planExtId };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async upsertPlanStep(
    input: PlanStepIngest,
  ): Promise<PlanStepIngestResult> {
    const stepExtId = planStepNodeId(input.stepId);
    const planExtId = planNodeId(input.planId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // The Plan must exist — its UUID anchors the STEP_OF edge.
      const planRow = await client.query<{ id: string }>(
        `SELECT id FROM graph_nodes
         WHERE tenant_id = $1 AND external_id = $2 AND type = 'Plan'`,
        [this.tenantId, planExtId],
      );
      const planUuid = planRow.rows[0]?.id;
      if (!planUuid) {
        await client.query('ROLLBACK');
        throw new Error(
          `upsertPlanStep: Plan ${planExtId} not found — call ingestPlan first`,
        );
      }
      const props = validateNodeProps('PlanStep', {
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
      });
      const stepUuid = await this.upsertNode(client, {
        externalId: stepExtId,
        type: 'PlanStep',
        scope: input.scope,
        props,
      });
      await this.upsertEdge(client, {
        type: 'STEP_OF',
        fromUuid: stepUuid,
        toUuid: planUuid,
      });
      // DEPENDS_ON edges for prerequisite steps that already exist; unknown
      // ids are skipped (the dependency may be ingested later).
      for (const depId of input.dependsOnStepIds ?? []) {
        const depExtId = planStepNodeId(depId);
        const depRow = await client.query<{ id: string }>(
          `SELECT id FROM graph_nodes
           WHERE tenant_id = $1 AND external_id = $2 AND type = 'PlanStep'`,
          [this.tenantId, depExtId],
        );
        const depUuid = depRow.rows[0]?.id;
        if (depUuid) {
          await this.upsertEdge(client, {
            type: 'DEPENDS_ON',
            fromUuid: stepUuid,
            toUuid: depUuid,
          });
        }
      }
      await client.query('COMMIT');
      return { stepExternalId: stepExtId };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getPlan(planExternalId: string): Promise<GraphNode | null> {
    const row = await this.findNodeByExternalId(planExternalId);
    if (!row || row.type !== 'Plan') return null;
    return rowToNode(row);
  }

  async getPlanSteps(planExternalId: string): Promise<GraphNode[]> {
    const planRow = await this.findNodeByExternalId(planExternalId);
    if (!planRow || planRow.type !== 'Plan') return [];
    const res = await this.pool.query<NodeRow>(
      `SELECT ${NODE_COLUMNS}
         FROM graph_nodes
        WHERE tenant_id = $1
          AND type = 'PlanStep'
          AND id IN (
            SELECT from_node FROM graph_edges
             WHERE tenant_id = $1 AND type = 'STEP_OF' AND to_node = $2
          )
        ORDER BY (properties->>'order')::int ASC`,
      [this.tenantId, planRow.id],
    );
    return res.rows.map((r) => rowToNode(r));
  }

  async setPlanStepStatus(
    stepExternalId: string,
    status: PlanStepStatus,
    opts?: { resultSummary?: string },
  ): Promise<void> {
    const patch: Record<string, unknown> = { status };
    if (opts?.resultSummary !== undefined) {
      patch['resultSummary'] = opts.resultSummary;
    }
    await this.pool.query(
      `UPDATE graph_nodes
          SET properties = properties || $3::jsonb
        WHERE tenant_id = $1 AND external_id = $2 AND type = 'PlanStep'`,
      [this.tenantId, stepExternalId, JSON.stringify(patch)],
    );
  }

  async listPlansForScope(scope: string): Promise<GraphNode[]> {
    const res = await this.pool.query<NodeRow>(
      `SELECT ${NODE_COLUMNS}
         FROM graph_nodes
        WHERE tenant_id = $1 AND type = 'Plan' AND scope = $2
        ORDER BY (properties->>'createdAt') DESC NULLS LAST`,
      [this.tenantId, scope],
    );
    return res.rows.map((r) => rowToNode(r));
  }

  async listRecentPlans(opts: {
    userId?: string;
    limit?: number;
    openOnly?: boolean;
    agentScopePrefix?: string;
  }): Promise<GraphNode[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 5, 50));
    // `user_id` lives in its own column (set on ingest), not in props.
    // `openOnly` rolls up step state: a plan counts as "open" when it owns
    // at least one PlanStep still pending/in_progress (failed/skipped are
    // historical — superseded by replan — and don't keep a plan open).
    const res = await this.pool.query<NodeRow>(
      `SELECT ${NODE_COLUMNS}
         FROM graph_nodes p
        WHERE p.tenant_id = $1
          AND p.type = 'Plan'
          AND ($2::text IS NULL OR p.user_id = $2)
          -- Per-orchestrator isolation: Plan.scope is the qualified
          -- agentSlug::conversation (top-level column). Restrict to the
          -- active Agent; the 'default::' branch keeps legacy plans reachable.
          AND ($5::text IS NULL
            OR p.scope LIKE $5 || '%'
            OR ($5 = 'default::' AND p.scope NOT LIKE '%::%'))
          AND ($3::boolean = false OR EXISTS (
            SELECT 1
              FROM graph_nodes s
              JOIN graph_edges e ON e.from_node = s.id
             WHERE e.tenant_id = $1
               AND e.type = 'STEP_OF'
               AND e.to_node = p.id
               AND s.type = 'PlanStep'
               AND s.properties->>'status' IN ('pending', 'in_progress')
          ))
        ORDER BY (p.properties->>'createdAt') DESC NULLS LAST
        LIMIT $4`,
      [
        this.tenantId,
        opts.userId ?? null,
        opts.openOnly === true,
        limit,
        opts.agentScopePrefix ?? null,
      ],
    );
    return res.rows.map((r) => rowToNode(r));
  }

  async getRunForTurn(turnExternalId: string): Promise<RunTraceView | null> {
    const runExtId = runNodeId(turnExternalId);

    // Fetch Turn, Run, User, top-level tool calls and agent invocations in
    // one round-trip each — chatty, but the subgraph is always small (≤ ~20
    // nodes per turn), and readability wins over a cartesian monolith query.
    const turnRow = await this.findNodeByExternalId(turnExternalId);
    if (!turnRow || turnRow.type !== 'Turn') return null;
    const runRow = await this.findNodeByExternalId(runExtId);
    if (!runRow) return null;

    const userRow = await this.pool.query<NodeRow>(
      `SELECT ${NODE_COLUMNS.split(', ').map((c) => `n.${c}`).join(', ')}
       FROM graph_edges e
       JOIN graph_nodes n ON n.id = e.to_node
       WHERE e.tenant_id = $1 AND e.type = 'BELONGS_TO' AND e.from_node = $2
       LIMIT 1`,
      [this.tenantId, turnRow.id],
    );

    const invocationRows = await this.pool.query<NodeRow>(
      `SELECT ${NODE_COLUMNS.split(', ').map((c) => `n.${c}`).join(', ')}
       FROM graph_edges e
       JOIN graph_nodes n ON n.id = e.to_node
       WHERE e.tenant_id = $1 AND e.type = 'INVOKED_AGENT' AND e.from_node = $2
       ORDER BY ((n.properties->>'index')::int) ASC`,
      [this.tenantId, runRow.id],
    );

    // Fetch ALL tool calls descended from this run in one shot (both direct
    // Run→ToolCall for orchestrator-level, and AgentInvocation→ToolCall).
    const parentIds = [runRow.id, ...invocationRows.rows.map((r) => r.id)];
    const toolCallRows = await this.pool.query<NodeRow & { parent_uuid: string }>(
      `SELECT e.from_node AS parent_uuid,
              ${NODE_COLUMNS.split(', ').map((c) => `n.${c}`).join(', ')}
       FROM graph_edges e
       JOIN graph_nodes n ON n.id = e.to_node
       WHERE e.tenant_id = $1
         AND e.type = 'INVOKED_TOOL'
         AND e.from_node = ANY($2::uuid[])`,
      [this.tenantId, parentIds],
    );

    const toolCallIds = toolCallRows.rows.map((r) => r.id);
    const producedByCall = new Map<string, GraphNode[]>();
    if (toolCallIds.length > 0) {
      const producedRows = await this.pool.query<NodeRow & { parent_uuid: string }>(
        `SELECT e.from_node AS parent_uuid,
                ${NODE_COLUMNS.split(', ').map((c) => `n.${c}`).join(', ')}
         FROM graph_edges e
         JOIN graph_nodes n ON n.id = e.to_node
         WHERE e.tenant_id = $1
           AND e.type = 'PRODUCED'
           AND e.from_node = ANY($2::uuid[])`,
        [this.tenantId, toolCallIds],
      );
      for (const row of producedRows.rows) {
        const list = producedByCall.get(row.parent_uuid) ?? [];
        list.push(rowToNode(row));
        producedByCall.set(row.parent_uuid, list);
      }
    }

    const toolCallViewsByParent = new Map<string, RunToolCallView[]>();
    for (const row of toolCallRows.rows) {
      const view: RunToolCallView = {
        node: rowToNode(row),
        producedEntities: producedByCall.get(row.id) ?? [],
      };
      const list = toolCallViewsByParent.get(row.parent_uuid) ?? [];
      list.push(view);
      toolCallViewsByParent.set(row.parent_uuid, list);
    }

    const orchestratorToolCalls = toolCallViewsByParent.get(runRow.id) ?? [];

    const agentInvocations: RunAgentInvocationView[] = invocationRows.rows.map(
      (row) => ({
        node: rowToNode(row),
        toolCalls: toolCallViewsByParent.get(row.id) ?? [],
      }),
    );

    return {
      turn: rowToNode(turnRow),
      run: rowToNode(runRow),
      ...(userRow.rows[0] ? { user: rowToNode(userRow.rows[0]) } : {}),
      orchestratorToolCalls,
      agentInvocations,
    };
  }

  async searchTurns(opts: SearchTurnsOptions): Promise<TurnSearchHit[]> {
    const query = opts.query.trim();
    if (query.length === 0) return [];

    const limit = Math.max(1, Math.min(opts.limit ?? 5, 50));
    const userIdFilter = opts.userId ?? null;
    const excludeScope = opts.excludeScope ?? null;
    const agentScopePrefix = opts.agentScopePrefix ?? null;
    const excludeTurnIds = opts.excludeTurnIds?.length
      ? Array.from(opts.excludeTurnIds)
      : null;

    // plainto_tsquery keeps Postgres happy with arbitrary user input
    // (including punctuation and German compound words). 'simple' config
    // matches the index expression from migration 0004.
    const result = await this.pool.query<{
      external_id: string;
      scope: string;
      properties: Record<string, unknown>;
      entry_type: string;
      manually_authored: boolean;
      rank: number;
    }>(
      `
      SELECT
        external_id,
        scope,
        properties,
        entry_type,
        manually_authored,
        ts_rank_cd(
          to_tsvector(
            'simple',
            coalesce(properties->>'userMessage', '') || ' ' ||
            coalesce(properties->>'assistantAnswer', '')
          ),
          plainto_tsquery('simple', $3)
        ) AS rank
      FROM graph_nodes
      WHERE tenant_id = $1
        AND type = 'Turn'
        AND ($2::text IS NULL OR user_id = $2)
        AND ($4::text IS NULL OR scope <> $4)
        AND ($5::text[] IS NULL OR external_id <> ALL($5::text[]))
        -- Per-orchestrator isolation: when a prefix is given, restrict to the
        -- Agent's own scopes. The 'default::' branch also admits legacy
        -- unqualified rows (no '::' separator) so pre-isolation data stays
        -- reachable for the default Agent without a migration.
        AND ($7::text IS NULL
          OR scope LIKE $7 || '%'
          OR ($7 = 'default::' AND scope NOT LIKE '%::%'))
        AND to_tsvector(
          'simple',
          coalesce(properties->>'userMessage', '') || ' ' ||
          coalesce(properties->>'assistantAnswer', '')
        ) @@ plainto_tsquery('simple', $3)
      ORDER BY rank DESC, (properties->>'time') DESC
      LIMIT $6
      `,
      [
        this.tenantId,
        userIdFilter,
        query,
        excludeScope,
        excludeTurnIds,
        limit,
        agentScopePrefix,
      ],
    );

    // ts_rank_cd is unbounded; normalise via rank / (rank + 1) so callers get
    // a [0, 1) score that's easy to threshold / merge with other signals.
    return result.rows.map((row) => {
      // OB-73 — record access for the decay-sweep flush. No-op when no
      // tracker is wired (legacy callers).
      this.accessTracker?.markAccessed(row.external_id);
      const raw = Number(row.rank) || 0;
      const normalised = raw / (raw + 1);
      return {
        turnId: row.external_id,
        scope: row.scope,
        time: String(row.properties['time'] ?? ''),
        userMessage: String(row.properties['userMessage'] ?? ''),
        assistantAnswer: String(row.properties['assistantAnswer'] ?? ''),
        rank: normalised,
        entryType: row.entry_type as EntryType,
        manuallyAuthored: Boolean(row.manually_authored),
      };
    });
  }

  async searchTurnsByEmbedding(
    opts: SearchTurnsByEmbeddingOptions,
  ): Promise<TurnSearchHit[]> {
    if (opts.queryEmbedding.length === 0) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? 5, 50));
    const minSimilarity = opts.minSimilarity ?? 0.3;
    const userIdFilter = opts.userId ?? null;
    const excludeScope = opts.excludeScope ?? null;
    const agentScopePrefix = opts.agentScopePrefix ?? null;
    const excludeTurnIds = opts.excludeTurnIds?.length
      ? Array.from(opts.excludeTurnIds)
      : null;
    const queryLit = vectorLiteral(opts.queryEmbedding);

    // OB-72 hybrid retrieval. ftsQuery=null/empty → pure-cosine path
    // (backwards-compat); otherwise switch to BM25 + cosine + recency +
    // type-weight scoring in a single SQL.
    const ftsQuery = opts.ftsQuery?.trim();
    const ftsActive = ftsQuery !== undefined && ftsQuery.length > 0;
    const recallMinScore = Math.max(0, Math.min(opts.recallMinScore ?? 0, 1));
    const recallRecencyBoost = Math.max(0, opts.recallRecencyBoost ?? 0.05);
    const includeCold = opts.includeCold === true;
    const entryTypesFilter = opts.entryTypes?.length
      ? Array.from(opts.entryTypes)
      : null;
    const weightMemory = opts.typeWeights?.['memory'] ?? 1.0;
    const weightProcess = opts.typeWeights?.['process'] ?? 1.0;
    const weightTask = opts.typeWeights?.['task'] ?? 1.0;

    // Overshoot so the post-filter (recallMinScore + minSimilarity) doesn't
    // starve when the top candidate is below threshold.
    const overshoot = Math.min(limit * 3, 30);

    // The FTS expression is byte-identical to the index expression in
    // 0004_turn_fts.sql so the planner picks `idx_graph_nodes_turn_fts` —
    // verified via EXPLAIN (OB-72 kickoff). The hybrid score lives in the
    // outer SELECT; the inner CTE does the candidate selection so we hit
    // the right index regardless of which leg actually matched.
    //
    // Param map:
    //   $1  query embedding (vector literal)
    //   $2  tenant_id
    //   $3  userId filter (nullable)
    //   $4  excludeScope (nullable)
    //   $5  excludeTurnIds (nullable text[])
    //   $6  ftsQuery (nullable text)
    //   $7  entryTypes filter (nullable text[])
    //   $8  includeCold (boolean)
    //   $9  recencyBoost rate (real)
    //   $10 weight memory
    //   $11 weight process
    //   $12 weight task
    //   $13 LIMIT (overshoot)
    //   $14 agentScopePrefix (nullable) — per-orchestrator isolation
    const sql = `
      WITH scored AS (
        SELECT
          external_id,
          scope,
          properties,
          entry_type,
          manually_authored,
          tier,
          created_at,
          -- pgvector returns NaN for cosine distance against a zero-norm
          -- vector. Postgres treats NaN as larger than any non-NaN, so
          -- rows would leak through the > 0 score filter. Guard with the
          -- IEEE-754 self-inequality trick: NaN is the only value where
          -- self-equality is FALSE.
          CASE
            WHEN embedding IS NULL THEN 0
            WHEN (1 - (embedding <=> $1::vector)) <> (1 - (embedding <=> $1::vector)) THEN 0
            ELSE 1 - (embedding <=> $1::vector)
          END AS cosine_sim,
          CASE
            WHEN $6::text IS NULL OR $6 = '' THEN 0
            ELSE COALESCE(
              ts_rank_cd(
                to_tsvector(
                  'simple',
                  coalesce(properties->>'userMessage','') || ' ' ||
                  coalesce(properties->>'assistantAnswer','')
                ),
                plainto_tsquery('simple', $6)
              ),
              0
            )
          END AS bm25_raw
        FROM graph_nodes
        WHERE tenant_id = $2
          AND type = 'Turn'
          AND ($3::text IS NULL OR user_id = $3)
          AND ($4::text IS NULL OR scope <> $4)
          AND ($5::text[] IS NULL OR external_id <> ALL($5::text[]))
          -- Per-orchestrator isolation (see searchTurns): own prefix, plus
          -- legacy unqualified rows for the default Agent.
          AND ($14::text IS NULL
            OR scope LIKE $14 || '%'
            OR ($14 = 'default::' AND scope NOT LIKE '%::%'))
          AND ($7::text[] IS NULL OR entry_type = ANY($7::text[]))
          AND ($8::boolean = TRUE OR tier IN ('HOT', 'WARM'))
          AND (
            embedding IS NOT NULL
            OR (
              $6::text IS NOT NULL
              AND $6 <> ''
              AND to_tsvector(
                'simple',
                coalesce(properties->>'userMessage','') || ' ' ||
                coalesce(properties->>'assistantAnswer','')
              ) @@ plainto_tsquery('simple', $6)
            )
          )
      ),
      normalised AS (
        SELECT
          external_id,
          scope,
          properties,
          entry_type,
          manually_authored,
          created_at,
          cosine_sim,
          -- ts_rank_cd is unbounded; map to [0,1) via rank/(rank+1)
          CASE WHEN bm25_raw <= 0 THEN 0 ELSE bm25_raw / (bm25_raw + 1) END AS bm25_norm
        FROM scored
      )
      SELECT
        external_id,
        scope,
        properties,
        entry_type,
        manually_authored,
        cosine_sim,
        bm25_norm,
        (
          (
            CASE WHEN $6::text IS NULL OR $6 = '' THEN cosine_sim
                 ELSE 0.4 * bm25_norm + 0.6 * cosine_sim END
          )
          * CASE entry_type
              WHEN 'process' THEN $11::real
              WHEN 'task'    THEN $12::real
              ELSE                $10::real
            END
          * CASE
              WHEN $9::real = 0 THEN 1
              ELSE EXP(-1 * $9::real * EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400.0)
            END
        ) AS hybrid_score
      FROM normalised
      WHERE (
        CASE WHEN $6::text IS NULL OR $6 = '' THEN cosine_sim
             ELSE 0.4 * bm25_norm + 0.6 * cosine_sim END
      ) > 0
      ORDER BY hybrid_score DESC
      LIMIT $13
    `;

    const result = await this.pool.query<{
      external_id: string;
      scope: string;
      properties: Record<string, unknown>;
      entry_type: string;
      manually_authored: boolean;
      cosine_sim: number | string;
      bm25_norm: number | string;
      hybrid_score: number | string;
    }>(sql, [
      queryLit,
      this.tenantId,
      userIdFilter,
      excludeScope,
      excludeTurnIds,
      ftsActive ? ftsQuery : null,
      entryTypesFilter,
      includeCold,
      recallRecencyBoost,
      weightMemory,
      weightProcess,
      weightTask,
      overshoot,
      agentScopePrefix,
    ]);

    return result.rows
      .map((row) => {
        const cosine = Math.max(0, Math.min(1, Number(row.cosine_sim) || 0));
        const hybridRaw = Number(row.hybrid_score) || 0;
        // Clamp the final score to [0,1]; type-weights >1 can push raw
        // products past 1 — callers expect a normalised rank.
        const hybrid = Math.max(0, Math.min(1, hybridRaw));
        return {
          turnId: row.external_id,
          scope: row.scope,
          time: String(row.properties['time'] ?? ''),
          userMessage: String(row.properties['userMessage'] ?? ''),
          assistantAnswer: String(row.properties['assistantAnswer'] ?? ''),
          rank: ftsActive ? hybrid : cosine,
          entryType: row.entry_type as EntryType,
          manuallyAuthored: Boolean(row.manually_authored),
          // Keep the cosine for the minSimilarity filter — preserves the
          // pre-OB-72 contract: legacy callers pass minSimilarity expecting
          // it to filter on cosine, not on the new hybrid score.
          _cosineForFilter: cosine,
        };
      })
      .filter(
        (hit) =>
          hit._cosineForFilter >= (ftsActive ? 0 : minSimilarity) &&
          hit.rank >= recallMinScore,
      )
      .slice(0, limit)
      .map(({ _cosineForFilter: _, ...hit }) => {
        // OB-73 — record access AFTER the filter+slice so we only credit
        // Turns we actually surface (not the recall-overshoot fluff).
        this.accessTracker?.markAccessed(hit.turnId);
        return hit;
      });
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

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Fast path 1: this exact ChannelIdentity already exists. Refresh
      // `lastSeenAt` + return the existing cluster pointer.
      const existingIdentity = await client.query<{
        identity_uuid: string;
        cluster_uuid: string;
        omadia_user_id: string;
      }>(
        `SELECT
           ci.id AS identity_uuid,
           u.id  AS cluster_uuid,
           (u.properties->>'omadiaUserId') AS omadia_user_id
         FROM graph_nodes ci
         JOIN graph_edges e ON e.from_node = ci.id AND e.type = 'IS_IDENTITY_OF'
         JOIN graph_nodes u ON u.id = e.to_node AND u.type = 'User'
         WHERE ci.tenant_id = $1
           AND ci.external_id = $2
           AND ci.type = 'ChannelIdentity'
         LIMIT 1`,
        [this.tenantId, identityExtId],
      );
      const existing = existingIdentity.rows[0];
      if (existing) {
        await client.query(
          `UPDATE graph_nodes
             SET properties = jsonb_set(properties, '{lastSeenAt}', to_jsonb($2::text))
           WHERE id = $1`,
          [existing.identity_uuid, now],
        );
        await client.query(
          `UPDATE graph_nodes
             SET properties = jsonb_set(properties, '{lastSeenAt}', to_jsonb($2::text))
           WHERE id = $1`,
          [existing.cluster_uuid, now],
        );
        await client.query('COMMIT');
        return {
          channelIdentityNodeId: identityExtId,
          userNodeId: userNodeId(existing.omadia_user_id),
          omadiaUserId: existing.omadia_user_id,
          isNewIdentity: false,
          isNewCluster: false,
        };
      }

      // Merge strategy:
      //   1. AAD-oid match: same tenant, any kind, identical aadObjectId.
      //      Stable Microsoft identifier — robust across channels even
      //      when one side has no email (e.g. a future Teams-bot path
      //      that only carries the AAD oid).
      //   2. Verified-email match: same tenant, lowercased email,
      //      both sides emailVerified=true. Fallback for non-AAD
      //      cross-channel cases (entra-web + verified email channel).
      let clusterUuid: string | undefined;
      let clusterOmadiaUserId: string | undefined;
      let isNewCluster = false;

      if (ingest.aadObjectId) {
        const matched = await client.query<{
          cluster_uuid: string;
          omadia_user_id: string;
        }>(
          `SELECT
             u.id AS cluster_uuid,
             (u.properties->>'omadiaUserId') AS omadia_user_id
           FROM graph_nodes ci
           JOIN graph_edges e ON e.from_node = ci.id AND e.type = 'IS_IDENTITY_OF'
           JOIN graph_nodes u ON u.id = e.to_node AND u.type = 'User'
           WHERE ci.tenant_id = $1
             AND ci.type = 'ChannelIdentity'
             AND ci.properties->>'aadObjectId' = $2
           ORDER BY ci.created_at ASC
           LIMIT 1`,
          [this.tenantId, ingest.aadObjectId],
        );
        const hit = matched.rows[0];
        if (hit) {
          clusterUuid = hit.cluster_uuid;
          clusterOmadiaUserId = hit.omadia_user_id;
        }
      }

      if (!clusterUuid && verifiedEmail) {
        const matched = await client.query<{
          cluster_uuid: string;
          omadia_user_id: string;
        }>(
          `SELECT
             u.id AS cluster_uuid,
             (u.properties->>'omadiaUserId') AS omadia_user_id
           FROM graph_nodes ci
           JOIN graph_edges e ON e.from_node = ci.id AND e.type = 'IS_IDENTITY_OF'
           JOIN graph_nodes u ON u.id = e.to_node AND u.type = 'User'
           WHERE ci.tenant_id = $1
             AND ci.type = 'ChannelIdentity'
             AND lower(ci.properties->>'email') = $2
             AND (ci.properties->>'emailVerified')::boolean = true
           ORDER BY ci.created_at ASC
           LIMIT 1`,
          [this.tenantId, verifiedEmail],
        );
        const hit = matched.rows[0];
        if (hit) {
          clusterUuid = hit.cluster_uuid;
          clusterOmadiaUserId = hit.omadia_user_id;
        }
      }

      // No match — spin up a fresh 1:1 cluster.
      if (!clusterUuid || !clusterOmadiaUserId) {
        clusterOmadiaUserId = randomUUID();
        const userProps = validateNodeProps('User', {
          omadiaUserId: clusterOmadiaUserId,
          firstSeenAt: now,
          lastSeenAt: now,
          ...(ingest.displayName ? { displayName: ingest.displayName } : {}),
        });
        clusterUuid = await this.upsertNode(client, {
          externalId: userNodeId(clusterOmadiaUserId),
          type: 'User',
          scope: null,
          userId: clusterOmadiaUserId,
          props: userProps,
        });
        isNewCluster = true;
      } else {
        // Refresh the existing cluster's lastSeenAt.
        await client.query(
          `UPDATE graph_nodes
             SET properties = jsonb_set(properties, '{lastSeenAt}', to_jsonb($2::text))
           WHERE id = $1`,
          [clusterUuid, now],
        );
      }

      // Create the ChannelIdentity node + IS_IDENTITY_OF edge.
      const identityProps = validateNodeProps('ChannelIdentity', {
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
      });
      const identityUuid = await this.upsertNode(client, {
        externalId: identityExtId,
        type: 'ChannelIdentity',
        scope: null,
        userId: null,
        props: identityProps,
      });
      await this.upsertEdge(client, {
        type: 'IS_IDENTITY_OF',
        fromUuid: identityUuid,
        toUuid: clusterUuid,
      });

      await client.query('COMMIT');
      return {
        channelIdentityNodeId: identityExtId,
        userNodeId: userNodeId(clusterOmadiaUserId),
        omadiaUserId: clusterOmadiaUserId,
        isNewIdentity: true,
        isNewCluster,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async createMemorableKnowledge(
    input: MemorableKnowledgeIngest,
  ): Promise<MemorableKnowledgeIngestResult> {
    const memorableUuid = randomUUID();
    const mkExtId = memorableKnowledgeNodeId(memorableUuid);
    const now = new Date().toISOString();

    const client = await this.pool.connect();
    let skippedInvolved = 0;
    let skippedRequired = 0;
    let skippedDerivedFrom = 0;
    try {
      await client.query('BEGIN');

      const initialOwners = input.aclOwners ?? [];
      const props = validateNodeProps('MemorableKnowledge', {
        kind: input.kind,
        summary: input.summary,
        ...(input.rationale ? { rationale: input.rationale } : {}),
        ...(input.significance !== undefined
          ? { significance: input.significance }
          : {}),
        // Per-orchestrator isolation: stamp the producing Agent so recall can
        // default-isolate by origin (team/public visibility still shares).
        ...(input.originAgent ? { origin_agent: input.originAgent } : {}),
        acl_owners: initialOwners,
        created_at: now,
        created_by: input.createdBy,
      });
      const mkUuid = await this.upsertNode(client, {
        externalId: mkExtId,
        type: 'MemorableKnowledge',
        scope: null,
        userId: null,
        props,
      });

      // INVOLVED edges — resolve omadiaUserId → user-cluster external_id
      // → uuid. Missing clusters are skipped + counted.
      for (const omadiaUserId of input.involvedOmadiaUserIds ?? []) {
        const userUuid = await this.findUuidByExternalId(
          client,
          userNodeId(omadiaUserId),
        );
        if (!userUuid) {
          skippedInvolved++;
          continue;
        }
        await this.upsertEdge(client, {
          type: 'INVOLVED',
          fromUuid: mkUuid,
          toUuid: userUuid,
        });
      }

      // REQUIRES edges — target node must be an Entity (OdooEntity /
      // ConfluencePage / PluginEntity). Other types or missing nodes
      // skip + count.
      for (const entityExtId of input.requiredEntityIds ?? []) {
        const row = await client.query<{ id: string; type: string }>(
          `SELECT id, type FROM graph_nodes
           WHERE tenant_id = $1 AND external_id = $2 LIMIT 1`,
          [this.tenantId, entityExtId],
        );
        const hit = row.rows[0];
        if (
          !hit ||
          (hit.type !== 'OdooEntity' &&
            hit.type !== 'ConfluencePage' &&
            hit.type !== 'PluginEntity')
        ) {
          skippedRequired++;
          continue;
        }
        await this.upsertEdge(client, {
          type: 'REQUIRES',
          fromUuid: mkUuid,
          toUuid: hit.id,
        });
      }

      // DERIVED_FROM edges — Turn nodes only.
      for (const turnExtId of input.derivedFromTurnIds ?? []) {
        const row = await client.query<{ id: string }>(
          `SELECT id FROM graph_nodes
           WHERE tenant_id = $1 AND external_id = $2 AND type = 'Turn'
           LIMIT 1`,
          [this.tenantId, turnExtId],
        );
        const hit = row.rows[0];
        if (!hit) {
          skippedDerivedFrom++;
          continue;
        }
        await this.upsertEdge(client, {
          type: 'DERIVED_FROM',
          fromUuid: mkUuid,
          toUuid: hit.id,
        });
      }

      // Slice 6.5 — atomically persist Palaia-Excerpts as their own
      // PalaiaExcerpt nodes + EXCERPT_OF edges. Throws on hard-cap
      // violation BEFORE COMMIT so callers get a typed error and the
      // MK row is never half-persisted with bad excerpts.
      if (input.palaiaExcerpts && input.palaiaExcerpts.texts.length > 0) {
        await this.writeExcerpts(
          client,
          mkUuid,
          input.palaiaExcerpts,
          now,
        );
      }

      // Slice 3 — audit-log the create with the initial-owner snapshot.
      // We log unconditionally (even empty owners) so every MK has a
      // create-row; downstream tooling can rely on `audit.length >= 1`.
      const auditActor =
        input.actorOmadiaUserId ??
        initialOwners[0] ??
        '00000000-0000-0000-0000-000000000000';
      await this.writeAclAudit(client, {
        memoryExternalId: mkExtId,
        actorOmadiaUserId: auditActor,
        actorChannelIdentityId: input.createdBy,
        action: 'create',
        beforeOwners: [],
        afterOwners: initialOwners,
      });

      await client.query('COMMIT');

      // Slice 7 — fire-and-forget embedding for the MK + each excerpt.
      // Runs OUTSIDE the create-transaction so a slow Ollama doesn't
      // delay the API response. Failures are logged and the
      // backfill-sweep will retry. Detached on purpose: we don't
      // await the promise so the caller's response goes back instantly.
      const mkText = `${input.summary}\n\n${input.rationale ?? ''}`.trim();
      void this.embedAndStoreNode(mkExtId, mkText);
      if (input.palaiaExcerpts && input.palaiaExcerpts.texts.length > 0) {
        const lookup = await this.pool.query<{ external_id: string; properties: { text: string } }>(
          `SELECT ex.external_id, ex.properties
           FROM graph_nodes ex
           JOIN graph_edges e ON e.from_node = ex.id AND e.type = 'EXCERPT_OF'
           JOIN graph_nodes mk ON mk.id = e.to_node
           WHERE ex.tenant_id = $1
             AND ex.type = 'PalaiaExcerpt'
             AND mk.external_id = $2`,
          [this.tenantId, mkExtId],
        );
        for (const row of lookup.rows) {
          void this.embedAndStoreNode(row.external_id, row.properties.text);
        }
      }

      return {
        memorableKnowledgeNodeId: mkExtId,
        skippedInvolved,
        skippedRequired,
        skippedDerivedFrom,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getMemorableKnowledge(
    memorableKnowledgeNodeId: string,
    viewerOmadiaUserId?: string,
  ): Promise<GraphNode | null> {
    const result = await this.pool.query<NodeRow>(
      `SELECT ${NODE_COLUMNS}
       FROM graph_nodes
       WHERE tenant_id = $1
         AND external_id = $2
         AND type = 'MemorableKnowledge'
         AND (
           $3::text IS NULL
           OR properties->'acl_owners' @> jsonb_build_array($3::text)
         )
       LIMIT 1`,
      [this.tenantId, memorableKnowledgeNodeId, viewerOmadiaUserId ?? null],
    );
    const row = result.rows[0];
    return row ? rowToNode(row) : null;
  }

  async listMemorableKnowledgeFor(
    omadiaUserId: string,
    opts: ListMemorableKnowledgeOptions = {},
  ): Promise<GraphNode[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    const userExtId = userNodeId(omadiaUserId);
    // INVOLVED edges go MK → User; "memory I'm involved in" = inbound.
    // Slice 3 — additionally gate by `acl_owners @> [omadiaUserId]`
    // so the caller only sees MKs they are authorised to read. Empty
    // `acl_owners` always fails the @> check → admin-only invisible.
    const rows = await this.pool.query<NodeRow>(
      `SELECT ${NODE_COLUMNS.split(', ').map((c) => `mk.${c}`).join(', ')}
       FROM graph_nodes user_node
       JOIN graph_edges e ON e.to_node = user_node.id AND e.type = 'INVOLVED'
       JOIN graph_nodes mk ON mk.id = e.from_node AND mk.type = 'MemorableKnowledge'
       WHERE user_node.tenant_id = $1
         AND user_node.external_id = $2
         AND user_node.type = 'User'
         AND mk.properties->'acl_owners' @> jsonb_build_array($3::text)
         AND ($4::text IS NULL OR mk.properties->>'kind' = $4)
       ORDER BY mk.created_at DESC
       LIMIT $5`,
      [this.tenantId, userExtId, omadiaUserId, opts.kind ?? null, limit],
    );
    return rows.rows.map(rowToNode);
  }

  // ─── Slice 3 — ACL mutations + audit ──────────────────────────────────

  private async writeAclAudit(
    client: PoolClient,
    entry: {
      memoryExternalId: string;
      actorOmadiaUserId: string;
      actorChannelIdentityId?: string;
      action: AclAction;
      beforeOwners: string[];
      afterOwners: string[] | null;
      reason?: string;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO memory_acl_audit
         (tenant_id, memory_external_id, actor_omadia_user_id,
          actor_channel_identity_id, action, before_owners, after_owners,
          reason)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
      [
        this.tenantId,
        entry.memoryExternalId,
        entry.actorOmadiaUserId,
        entry.actorChannelIdentityId ?? null,
        entry.action,
        JSON.stringify(entry.beforeOwners),
        entry.afterOwners === null ? null : JSON.stringify(entry.afterOwners),
        entry.reason ?? null,
      ],
    );
  }

  private async loadOwnersOrThrow(
    client: PoolClient,
    mkExternalId: string,
  ): Promise<{ uuid: string; owners: string[] }> {
    const row = await client.query<{ id: string; owners: unknown }>(
      `SELECT id, properties->'acl_owners' AS owners
       FROM graph_nodes
       WHERE tenant_id = $1 AND external_id = $2 AND type = 'MemorableKnowledge'
       LIMIT 1`,
      [this.tenantId, mkExternalId],
    );
    const hit = row.rows[0];
    if (!hit) {
      throw Object.assign(new Error('memory_not_found'), {
        code: 'memory_not_found',
      });
    }
    const owners = Array.isArray(hit.owners) ? (hit.owners as string[]) : [];
    return { uuid: hit.id, owners };
  }

  private assertActorIsOwner(
    owners: string[],
    actorOmadiaUserId: string,
  ): void {
    if (!owners.includes(actorOmadiaUserId)) {
      throw Object.assign(new Error('not_an_owner'), { code: 'not_an_owner' });
    }
  }

  async addOwner(
    memorableKnowledgeNodeId: string,
    omadiaUserIdToAdd: string,
    actor: AclMutationOptions,
  ): Promise<string[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { uuid, owners } = await this.loadOwnersOrThrow(
        client,
        memorableKnowledgeNodeId,
      );
      this.assertActorIsOwner(owners, actor.actorOmadiaUserId);
      const next = owners.includes(omadiaUserIdToAdd)
        ? owners
        : [...owners, omadiaUserIdToAdd];
      await client.query(
        `UPDATE graph_nodes
           SET properties = jsonb_set(properties, '{acl_owners}', $2::jsonb, true)
         WHERE id = $1`,
        [uuid, JSON.stringify(next)],
      );
      await this.writeAclAudit(client, {
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
      await client.query('COMMIT');
      return next;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async removeOwner(
    memorableKnowledgeNodeId: string,
    omadiaUserIdToRemove: string,
    actor: AclMutationOptions,
  ): Promise<string[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { uuid, owners } = await this.loadOwnersOrThrow(
        client,
        memorableKnowledgeNodeId,
      );
      this.assertActorIsOwner(owners, actor.actorOmadiaUserId);
      const next = owners.filter((id) => id !== omadiaUserIdToRemove);
      if (owners.includes(omadiaUserIdToRemove) && next.length === 0) {
        throw Object.assign(new Error('cannot_remove_last_owner'), {
          code: 'cannot_remove_last_owner',
        });
      }
      await client.query(
        `UPDATE graph_nodes
           SET properties = jsonb_set(properties, '{acl_owners}', $2::jsonb, true)
         WHERE id = $1`,
        [uuid, JSON.stringify(next)],
      );
      await this.writeAclAudit(client, {
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
      await client.query('COMMIT');
      return next;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async deleteMemory(
    memorableKnowledgeNodeId: string,
    actor: AclMutationOptions,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { uuid, owners } = await this.loadOwnersOrThrow(
        client,
        memorableKnowledgeNodeId,
      );
      this.assertActorIsOwner(owners, actor.actorOmadiaUserId);
      // Audit BEFORE delete so the row references a still-existing
      // memory (even though there's no FK).
      await this.writeAclAudit(client, {
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
      // Slice 6.5 — cascade-delete the PalaiaExcerpt nodes attached
      // to this MK. The EXCERPT_OF edges are auto-cleaned by graph_edges
      // FK CASCADE on either side, but the Excerpt nodes themselves are
      // standalone graph_nodes rows and would orphan if not removed.
      await client.query(
        `DELETE FROM graph_nodes
         WHERE tenant_id = $1
           AND type = 'PalaiaExcerpt'
           AND id IN (
             SELECT from_node FROM graph_edges
             WHERE tenant_id = $1
               AND to_node = $2
               AND type = 'EXCERPT_OF'
           )`,
        [this.tenantId, uuid],
      );
      // CASCADE on graph_edges FK removes inbound/outbound edges.
      await client.query(`DELETE FROM graph_nodes WHERE id = $1`, [uuid]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
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
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { uuid, owners } = await this.loadOwnersOrThrow(
        client,
        memorableKnowledgeNodeId,
      );
      this.assertActorIsOwner(owners, actor.actorOmadiaUserId);

      const propsRow = await client.query<{
        properties: Record<string, unknown>;
      }>(`SELECT properties FROM graph_nodes WHERE id = $1`, [uuid]);
      const current = propsRow.rows[0]!.properties;
      const merged: Record<string, unknown> = { ...current };
      if (patch.kind !== undefined) merged['kind'] = patch.kind;
      if (patch.summary !== undefined) merged['summary'] = patch.summary;
      if (patch.rationale === null) {
        delete merged['rationale'];
      } else if (patch.rationale !== undefined) {
        merged['rationale'] = patch.rationale;
      }
      if (patch.significance !== undefined) {
        merged['significance'] = patch.significance;
      }
      const validated = validateNodeProps('MemorableKnowledge', merged);

      await client.query(
        `UPDATE graph_nodes
           SET properties = $2::jsonb,
               -- Slice 7 — clear the now-stale embedding so the backfill
               -- sweep (or the post-COMMIT re-embed below) writes a
               -- fresh one. Without this, semantic recall would surface
               -- the MK against its old summary indefinitely.
               embedding = NULL,
               embedding_attempts = 0,
               embedding_last_error_at = NULL,
               embedding_last_error = NULL
         WHERE id = $1`,
        [uuid, JSON.stringify(validated)],
      );
      await this.writeAclAudit(client, {
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
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const updated = await this.getMemorableKnowledge(
      memorableKnowledgeNodeId,
      actor.actorOmadiaUserId,
    );
    if (!updated) {
      throw Object.assign(new Error('memory_not_found'), {
        code: 'memory_not_found',
      });
    }

    // Slice 7 — fire-and-forget re-embed with the freshly merged text.
    const mkText = `${String(updated.props['summary'] ?? '')}\n\n${String(updated.props['rationale'] ?? '')}`.trim();
    void this.embedAndStoreNode(memorableKnowledgeNodeId, mkText);

    return updated;
  }

  // ─── Slice 6.5 — PalaiaExcerpt persistence ──────────────────────────

  /**
   * Persist a Palaia-Excerpt batch attached to a freshly-inserted MK.
   * Called from inside `createMemorableKnowledge`'s transaction —
   * relies on the caller to BEGIN/COMMIT. Throws
   * `excerpt_count_exceeded` (>5) or `excerpt_text_too_long` (>300
   * chars) before any insert so the parent MK transaction can roll
   * back cleanly.
   */
  private async writeExcerpts(
    client: PoolClient,
    parentMkUuid: string,
    input: PalaiaExcerptInput,
    nowIso: string,
  ): Promise<void> {
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
      const excerptUuid = randomUUID();
      const excerptExtId = palaiaExcerptNodeId(excerptUuid);
      const props = validateNodeProps('PalaiaExcerpt', {
        text,
        position: i,
        source: input.source,
        created_at: nowIso,
      });
      const excerptNodeUuid = await this.upsertNode(client, {
        externalId: excerptExtId,
        type: 'PalaiaExcerpt',
        scope: null,
        userId: null,
        props,
      });
      await this.upsertEdge(client, {
        type: 'EXCERPT_OF',
        fromUuid: excerptNodeUuid,
        toUuid: parentMkUuid,
      });
    }
  }

  async listExcerptsForMemory(
    memorableKnowledgeNodeId: string,
  ): Promise<PalaiaExcerptNode[]> {
    const rows = await this.pool.query<{
      external_id: string;
      properties: {
        text: string;
        position: number;
        source: ExcerptSource;
        created_at: string;
      };
    }>(
      `SELECT ex.external_id, ex.properties
       FROM graph_nodes mk
       JOIN graph_edges e ON e.to_node = mk.id AND e.type = 'EXCERPT_OF'
       JOIN graph_nodes ex ON ex.id = e.from_node AND ex.type = 'PalaiaExcerpt'
       WHERE mk.tenant_id = $1
         AND mk.external_id = $2
         AND mk.type = 'MemorableKnowledge'
         AND ex.tenant_id = $1
       ORDER BY (ex.properties->>'position')::int ASC`,
      [this.tenantId, memorableKnowledgeNodeId],
    );
    return rows.rows.map((r) => ({
      id: r.external_id,
      type: 'PalaiaExcerpt' as const,
      props: {
        text: r.properties.text,
        position: r.properties.position,
        source: r.properties.source,
        created_at: r.properties.created_at,
      },
    }));
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
    if (patch.text !== undefined && (patch.text.length === 0 || patch.text.length > 300)) {
      throw Object.assign(new Error('excerpt_text_too_long'), {
        code: 'excerpt_text_too_long',
      });
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { owners } = await this.loadOwnersOrThrow(
        client,
        memorableKnowledgeNodeId,
      );
      this.assertActorIsOwner(owners, actor.actorOmadiaUserId);

      const excerptRow = await client.query<{
        id: string;
        properties: Record<string, unknown>;
      }>(
        `SELECT ex.id, ex.properties
         FROM graph_nodes mk
         JOIN graph_edges e ON e.to_node = mk.id AND e.type = 'EXCERPT_OF'
         JOIN graph_nodes ex ON ex.id = e.from_node AND ex.type = 'PalaiaExcerpt'
         WHERE mk.tenant_id = $1
           AND mk.external_id = $2
           AND mk.type = 'MemorableKnowledge'
           AND ex.tenant_id = $1
           AND (ex.properties->>'position')::int = $3
         LIMIT 1`,
        [this.tenantId, memorableKnowledgeNodeId, position],
      );
      const hit = excerptRow.rows[0];
      if (!hit) {
        throw Object.assign(new Error('excerpt_not_found'), {
          code: 'excerpt_not_found',
        });
      }

      const merged: Record<string, unknown> = { ...hit.properties };
      if (patch.text !== undefined) merged['text'] = patch.text;
      if (patch.source !== undefined) merged['source'] = patch.source;
      const validated = validateNodeProps('PalaiaExcerpt', merged);

      await client.query(
        `UPDATE graph_nodes
           SET properties = $2::jsonb,
               -- Slice 7 — clear stale embedding analogous to the
               -- updateMemorableKnowledge path. Backfill / post-COMMIT
               -- re-embed below writes the fresh vector.
               embedding = NULL,
               embedding_attempts = 0,
               embedding_last_error_at = NULL,
               embedding_last_error = NULL
         WHERE id = $1`,
        [hit.id, JSON.stringify(validated)],
      );

      await this.writeAclAudit(client, {
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

      await client.query('COMMIT');

      const refetched = await client.query<{
        external_id: string;
        properties: {
          text: string;
          position: number;
          source: ExcerptSource;
          created_at: string;
        };
      }>(
        `SELECT external_id, properties FROM graph_nodes WHERE id = $1`,
        [hit.id],
      );
      const row = refetched.rows[0]!;

      // Slice 7 — fire-and-forget re-embed with the freshly merged text.
      void this.embedAndStoreNode(row.external_id, row.properties.text);

      return {
        id: row.external_id,
        type: 'PalaiaExcerpt' as const,
        props: {
          text: row.properties.text,
          position: row.properties.position,
          source: row.properties.source,
          created_at: row.properties.created_at,
        },
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ─── Slice 7 — Memory + Excerpt semantic search ─────────────────────

  async searchMemorableKnowledgeByEmbedding(
    opts: MemorableKnowledgeSearchOptions,
  ): Promise<MemorableKnowledgeHit[]> {
    if (opts.queryEmbedding.length === 0) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? 5, 50));
    const minSimilarity = opts.minSimilarity ?? 0.3;
    const queryLit = vectorLiteral(opts.queryEmbedding);

    // ACL: owner-list containment OR (opt-in) team/public visibility within
    // the tenant. `private` is never admitted by the team branch.
    const sql = `
      SELECT ${NODE_COLUMNS},
             CASE
               WHEN embedding IS NULL THEN 0
               WHEN (1 - (embedding <=> $1::vector)) <> (1 - (embedding <=> $1::vector)) THEN 0
               ELSE 1 - (embedding <=> $1::vector)
             END AS cosine_sim
      FROM graph_nodes
      WHERE tenant_id = $2
        AND type = 'MemorableKnowledge'
        AND embedding IS NOT NULL
        AND (
          -- team/public-promoted MK stays shareable across Agents.
          ($5::boolean AND COALESCE(visibility, 'team') IN ('team', 'public'))
          OR (
            properties->'acl_owners' @> jsonb_build_array($3::text)
            -- Per-orchestrator isolation: owner-gated MK is additionally
            -- constrained to the viewing Agent. Legacy MK without an
            -- origin_agent stays visible to the owner.
            AND (
              $6::text IS NULL
              OR COALESCE(properties->>'origin_agent', '') = ''
              OR properties->>'origin_agent' = $6
            )
          )
        )
      ORDER BY cosine_sim DESC
      LIMIT $4
    `;
    const rows = await this.pool.query<NodeRow & { cosine_sim: number }>(sql, [
      queryLit,
      this.tenantId,
      opts.viewerOmadiaUserId,
      limit,
      opts.teamVisibility === true,
      opts.viewerAgentSlug ?? null,
    ]);
    return rows.rows
      .filter((r) => Number(r.cosine_sim) >= minSimilarity)
      .map((r) => ({
        mk: rowToNode(r),
        cosineSim: Number(r.cosine_sim),
      }));
  }

  async searchExcerptsByEmbedding(
    opts: ExcerptSearchOptions,
  ): Promise<PalaiaExcerptHit[]> {
    if (opts.queryEmbedding.length === 0) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? 10, 50));
    const minSimilarity = opts.minSimilarity ?? 0.3;
    const queryLit = vectorLiteral(opts.queryEmbedding);

    // JOIN excerpt → EXCERPT_OF → MK so the ACL gate runs against the
    // parent MK's acl_owners (excerpts themselves carry no ACL).
    const sql = `
      SELECT ex.external_id AS excerpt_external_id,
             ex.properties  AS excerpt_props,
             mk.external_id AS mk_external_id,
             CASE
               WHEN ex.embedding IS NULL THEN 0
               WHEN (1 - (ex.embedding <=> $1::vector)) <> (1 - (ex.embedding <=> $1::vector)) THEN 0
               ELSE 1 - (ex.embedding <=> $1::vector)
             END AS cosine_sim
      FROM graph_nodes ex
      JOIN graph_edges e ON e.from_node = ex.id AND e.type = 'EXCERPT_OF'
      JOIN graph_nodes mk ON mk.id = e.to_node AND mk.type = 'MemorableKnowledge'
      WHERE ex.tenant_id = $2
        AND ex.type = 'PalaiaExcerpt'
        AND ex.embedding IS NOT NULL
        AND mk.tenant_id = $2
        AND (
          -- team/public-promoted parent MK stays shareable across Agents.
          ($5::boolean AND COALESCE(mk.visibility, 'team') IN ('team', 'public'))
          OR (
            mk.properties->'acl_owners' @> jsonb_build_array($3::text)
            -- Per-orchestrator isolation against the parent MK's origin_agent.
            AND (
              $6::text IS NULL
              OR COALESCE(mk.properties->>'origin_agent', '') = ''
              OR mk.properties->>'origin_agent' = $6
            )
          )
        )
      ORDER BY cosine_sim DESC
      LIMIT $4
    `;
    const rows = await this.pool.query<{
      excerpt_external_id: string;
      excerpt_props: {
        text: string;
        position: number;
        source: ExcerptSource;
        created_at: string;
      };
      mk_external_id: string;
      cosine_sim: number;
    }>(sql, [
      queryLit,
      this.tenantId,
      opts.viewerOmadiaUserId,
      limit,
      opts.teamVisibility === true,
      opts.viewerAgentSlug ?? null,
    ]);

    return rows.rows
      .filter((r) => Number(r.cosine_sim) >= minSimilarity)
      .map((r) => ({
        excerpt: {
          id: r.excerpt_external_id,
          type: 'PalaiaExcerpt' as const,
          props: {
            text: r.excerpt_props.text,
            position: r.excerpt_props.position,
            source: r.excerpt_props.source,
            created_at: r.excerpt_props.created_at,
          },
        },
        parentMkId: r.mk_external_id,
        cosineSim: Number(r.cosine_sim),
      }));
  }

  /**
   * Slice 7 — fire-and-forget post-COMMIT embedder for a single node.
   * Keeps the create / update hot path snappy: the transaction
   * commits without waiting for Ollama, and this method writes the
   * embedding column independently. A failure (Ollama down, timeout)
   * is logged but never thrown — the embedding-backfill sweep picks
   * the row up on the next interval.
   *
   * `text` is composed by the caller (per-type composer); see
   * `embedAndStoreNode` callsites in createMemorableKnowledge /
   * writeExcerpts / updateMemorableKnowledge.
   */
  private async embedAndStoreNode(
    externalId: string,
    text: string,
  ): Promise<void> {
    if (!this.embeddingClient) return;
    if (text.trim().length === 0) return;
    try {
      const vector = await this.embeddingClient.embed(text);
      if (vector.length === 0) return;
      await this.pool.query(
        `UPDATE graph_nodes
           SET embedding = $1::vector,
               embedding_attempts = 0,
               embedding_last_error_at = NULL,
               embedding_last_error = NULL
         WHERE tenant_id = $2 AND external_id = $3`,
        [vectorLiteral(vector), this.tenantId, externalId],
      );
    } catch (err) {
      // Log + bump attempt counter so the backfill sweep can rate-limit.
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[graph] sync embed failed for ${externalId}: ${message} — backfill will retry`,
      );
      try {
        await this.pool.query(
          `UPDATE graph_nodes
             SET embedding_attempts = embedding_attempts + 1,
                 embedding_last_error_at = NOW(),
                 embedding_last_error = $1
           WHERE tenant_id = $2 AND external_id = $3`,
          [message.slice(0, 500), this.tenantId, externalId],
        );
      } catch {
        // swallow — backfill will pick it up
      }
    }
  }

  // ─── Slice 9 — Inconsistency persistence + resolve ──────────────────

  /**
   * Build an InconsistencyNode from the stored properties. The
   * `mk_pair` property is the source of truth for the conflicting
   * MKs — robust to a_wins/b_wins which delete the loser + cascade
   * its CONFLICTS_WITH edge.
   */
  private hydrateInconsistency(
    externalId: string,
    properties: InconsistencyNode['props'] & { mk_pair?: [string, string] },
  ): InconsistencyNode | null {
    const pair = properties.mk_pair;
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    return {
      id: externalId,
      type: 'Inconsistency' as const,
      props: properties,
      conflictsWith: [pair[0], pair[1]],
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

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Idempotency: dedupe-check on the (sorted) pair regardless of
      // the existing record's status — operator already saw it.
      const existing = await client.query<{ external_id: string }>(
        `SELECT ix.external_id
           FROM graph_nodes ix
           JOIN graph_edges e1 ON e1.from_node = ix.id AND e1.type = 'CONFLICTS_WITH'
           JOIN graph_nodes mk1 ON mk1.id = e1.to_node
           JOIN graph_edges e2 ON e2.from_node = ix.id AND e2.type = 'CONFLICTS_WITH'
           JOIN graph_nodes mk2 ON mk2.id = e2.to_node
          WHERE ix.tenant_id = $1
            AND ix.type = 'Inconsistency'
            AND mk1.external_id = $2
            AND mk2.external_id = $3
          LIMIT 1`,
        [this.tenantId, sortedPair[0], sortedPair[1]],
      );
      if (existing.rows.length > 0) {
        await client.query('COMMIT');
        return null;
      }

      // Resolve the two MK uuids upfront so we can fail-fast if one is
      // missing (race with deleteMemory).
      const mkRows = await client.query<{ id: string; external_id: string }>(
        `SELECT id, external_id FROM graph_nodes
          WHERE tenant_id = $1
            AND type = 'MemorableKnowledge'
            AND external_id = ANY($2::text[])`,
        [this.tenantId, sortedPair],
      );
      if (mkRows.rows.length !== 2) {
        await client.query('COMMIT');
        return null;
      }

      const now = new Date().toISOString();
      const externalId = inconsistencyNodeId(randomUUID());
      const props = validateNodeProps('Inconsistency', {
        summary: input.summary,
        severity: input.severity,
        status: 'open' as const,
        resolution: null,
        created_at: now,
        resolved_at: null,
        resolved_by: null,
        mk_pair: sortedPair,
      });
      const ixUuid = await this.upsertNode(client, {
        externalId,
        type: 'Inconsistency',
        scope: null,
        userId: null,
        props,
      });
      for (const mk of mkRows.rows) {
        await this.upsertEdge(client, {
          type: 'CONFLICTS_WITH',
          fromUuid: ixUuid,
          toUuid: mk.id,
        });
      }

      await client.query('COMMIT');
      return this.hydrateInconsistency(
        externalId,
        props as InconsistencyNode['props'] & { mk_pair: [string, string] },
      );
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listInconsistencies(
    opts: ListInconsistenciesOptions,
  ): Promise<InconsistencyNode[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    // Surface inconsistencies where the viewer owns at least one of
    // the two conflicting MKs (union-ACL).
    const rows = await this.pool.query<{
      external_id: string;
      properties: InconsistencyNode['props'];
    }>(
      `SELECT DISTINCT ix.external_id, ix.properties
         FROM graph_nodes ix
         JOIN graph_edges e ON e.from_node = ix.id AND e.type = 'CONFLICTS_WITH'
         JOIN graph_nodes mk ON mk.id = e.to_node AND mk.type = 'MemorableKnowledge'
        WHERE ix.tenant_id = $1
          AND ix.type = 'Inconsistency'
          AND mk.properties->'acl_owners' @> jsonb_build_array($2::text)
          AND ($3::text IS NULL OR ix.properties->>'status' = $3)
        ORDER BY ix.external_id DESC
        LIMIT $4`,
      [this.tenantId, opts.viewerOmadiaUserId, opts.status ?? null, limit],
    );
    const out: InconsistencyNode[] = [];
    for (const row of rows.rows) {
      const node = this.hydrateInconsistency(
        row.external_id,
        row.properties as InconsistencyNode['props'] & { mk_pair: [string, string] },
      );
      if (node) out.push(node);
    }
    return out;
  }

  async getInconsistency(
    externalId: string,
    viewerOmadiaUserId: string,
  ): Promise<InconsistencyNode | null> {
    const rows = await this.pool.query<{
      properties: InconsistencyNode['props'];
      owns_one: boolean;
    }>(
      `SELECT ix.properties,
              EXISTS(
                SELECT 1
                  FROM graph_edges e
                  JOIN graph_nodes mk ON mk.id = e.to_node
                 WHERE e.from_node = ix.id
                   AND e.type = 'CONFLICTS_WITH'
                   AND mk.type = 'MemorableKnowledge'
                   AND mk.properties->'acl_owners' @> jsonb_build_array($3::text)
              ) AS owns_one
         FROM graph_nodes ix
        WHERE ix.tenant_id = $1
          AND ix.external_id = $2
          AND ix.type = 'Inconsistency'
        LIMIT 1`,
      [this.tenantId, externalId, viewerOmadiaUserId],
    );
    const hit = rows.rows[0];
    if (!hit || !hit.owns_one) return null;
    return this.hydrateInconsistency(
      externalId,
      hit.properties as InconsistencyNode['props'] & { mk_pair: [string, string] },
    );
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

    // Map resolution → terminal status. dismiss = false-positive →
    // 'dismissed'; everything else = 'resolved'.
    const terminalStatus: InconsistencyStatus =
      resolution === 'dismiss' ? 'dismissed' : 'resolved';

    // a_wins / b_wins: delete the loser BEFORE marking resolved so a
    // failed delete (not_an_owner) leaves the inconsistency open.
    if (resolution === 'a_wins') {
      await this.deleteMemory(existing.conflictsWith[1], actor);
    } else if (resolution === 'b_wins') {
      await this.deleteMemory(existing.conflictsWith[0], actor);
    }

    const now = new Date().toISOString();
    // existing.props comes from hydrateInconsistency which spread the
    // entire property bag — the mk_pair Zod-passthrough survives.
    const nextProps = {
      ...(existing.props as Record<string, unknown>),
      status: terminalStatus,
      resolution,
      resolved_at: now,
      resolved_by: actor.actorOmadiaUserId,
      // Defensive: ensure mk_pair lands in the next-write even if the
      // existing record predates the schema field.
      mk_pair: existing.conflictsWith,
    };
    const validated = validateNodeProps('Inconsistency', nextProps);
    await this.pool.query(
      `UPDATE graph_nodes
          SET properties = $2::jsonb
        WHERE tenant_id = $1
          AND external_id = $3
          AND type = 'Inconsistency'`,
      [this.tenantId, JSON.stringify(validated), externalId],
    );

    const refetched = this.hydrateInconsistency(
      externalId,
      validated as InconsistencyNode['props'] & { mk_pair: [string, string] },
    );
    if (!refetched) {
      // Should be unreachable — at least one of the MKs was deleted
      // by a_wins/b_wins; the surviving one remains. Fallback:
      // synthesise from existing.
      return {
        ...existing,
        props: validated as InconsistencyNode['props'],
      };
    }
    return refetched;
  }

  async listMemorableKnowledgeIdsForBulkInconsistencyCheck(opts: {
    limit: number;
  }): Promise<string[]> {
    const limit = Math.max(1, Math.min(opts.limit, 200));
    const rows = await this.pool.query<{ external_id: string }>(
      `SELECT external_id
         FROM graph_nodes
        WHERE tenant_id = $1
          AND type = 'MemorableKnowledge'
          AND embedding IS NOT NULL
          AND NOT (properties ? 'last_inconsistency_check_at')
        ORDER BY created_at ASC
        LIMIT $2`,
      [this.tenantId, limit],
    );
    return rows.rows.map((r) => r.external_id);
  }

  async countMemorableKnowledgeInconsistencyCheckBuckets(): Promise<{
    unchecked: number;
    alreadyChecked: number;
    withoutEmbedding: number;
  }> {
    const row = await this.pool.query<{
      unchecked: string;
      already_checked: string;
      without_embedding: string;
    }>(
      `SELECT
         count(*) FILTER (
           WHERE embedding IS NOT NULL
             AND NOT (properties ? 'last_inconsistency_check_at')
         )::text AS unchecked,
         count(*) FILTER (
           WHERE properties ? 'last_inconsistency_check_at'
         )::text AS already_checked,
         count(*) FILTER (WHERE embedding IS NULL)::text AS without_embedding
       FROM graph_nodes
       WHERE tenant_id = $1 AND type = 'MemorableKnowledge'`,
      [this.tenantId],
    );
    const r = row.rows[0];
    return {
      unchecked: Number(r?.unchecked ?? '0'),
      alreadyChecked: Number(r?.already_checked ?? '0'),
      withoutEmbedding: Number(r?.without_embedding ?? '0'),
    };
  }

  async markMemorableKnowledgeInconsistencyChecked(
    memorableKnowledgeNodeId: string,
  ): Promise<void> {
    // jsonb_set creates the key if absent, replaces if present. The
    // timestamp string is wrapped in to_jsonb so the column stays
    // jsonb-typed end-to-end.
    await this.pool.query(
      `UPDATE graph_nodes
          SET properties = jsonb_set(
                properties,
                '{last_inconsistency_check_at}',
                to_jsonb(now()::timestamptz),
                true
              )
        WHERE tenant_id = $1
          AND external_id = $2
          AND type = 'MemorableKnowledge'`,
      [this.tenantId, memorableKnowledgeNodeId],
    );
  }

  // ─── Slice 10 — MergeCandidate persistence + resolve ────────────────

  private hydrateMergeCandidate(
    externalId: string,
    properties: MergeCandidateNode['props'] & { mk_pair?: [string, string] },
  ): MergeCandidateNode | null {
    const pair = properties.mk_pair;
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    return {
      id: externalId,
      type: 'MergeCandidate' as const,
      props: properties,
      duplicateOf: [pair[0], pair[1]],
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

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const existing = await client.query<{ external_id: string }>(
        `SELECT mc.external_id
           FROM graph_nodes mc
           JOIN graph_edges e1 ON e1.from_node = mc.id AND e1.type = 'DUPLICATE_OF'
           JOIN graph_nodes mk1 ON mk1.id = e1.to_node
           JOIN graph_edges e2 ON e2.from_node = mc.id AND e2.type = 'DUPLICATE_OF'
           JOIN graph_nodes mk2 ON mk2.id = e2.to_node
          WHERE mc.tenant_id = $1
            AND mc.type = 'MergeCandidate'
            AND mk1.external_id = $2
            AND mk2.external_id = $3
          LIMIT 1`,
        [this.tenantId, sortedPair[0], sortedPair[1]],
      );
      if (existing.rows.length > 0) {
        await client.query('COMMIT');
        return null;
      }

      const mkRows = await client.query<{ id: string; external_id: string }>(
        `SELECT id, external_id FROM graph_nodes
          WHERE tenant_id = $1
            AND type = 'MemorableKnowledge'
            AND external_id = ANY($2::text[])`,
        [this.tenantId, sortedPair],
      );
      if (mkRows.rows.length !== 2) {
        await client.query('COMMIT');
        return null;
      }

      const now = new Date().toISOString();
      const externalId = mergeCandidateNodeId(randomUUID());
      const props = validateNodeProps('MergeCandidate', {
        cosine_sim: input.cosineSim,
        status: 'open' as const,
        resolution: null,
        created_at: now,
        resolved_at: null,
        resolved_by: null,
        mk_pair: sortedPair,
      });
      const mcUuid = await this.upsertNode(client, {
        externalId,
        type: 'MergeCandidate',
        scope: null,
        userId: null,
        props,
      });
      for (const mk of mkRows.rows) {
        await this.upsertEdge(client, {
          type: 'DUPLICATE_OF',
          fromUuid: mcUuid,
          toUuid: mk.id,
        });
      }

      await client.query('COMMIT');
      return this.hydrateMergeCandidate(
        externalId,
        props as MergeCandidateNode['props'] & { mk_pair: [string, string] },
      );
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listMergeCandidates(
    opts: ListMergeCandidatesOptions,
  ): Promise<MergeCandidateNode[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const rows = await this.pool.query<{
      external_id: string;
      properties: MergeCandidateNode['props'];
    }>(
      `SELECT DISTINCT mc.external_id, mc.properties
         FROM graph_nodes mc
         JOIN graph_edges e ON e.from_node = mc.id AND e.type = 'DUPLICATE_OF'
         JOIN graph_nodes mk ON mk.id = e.to_node AND mk.type = 'MemorableKnowledge'
        WHERE mc.tenant_id = $1
          AND mc.type = 'MergeCandidate'
          AND mk.properties->'acl_owners' @> jsonb_build_array($2::text)
          AND ($3::text IS NULL OR mc.properties->>'status' = $3)
        ORDER BY mc.external_id DESC
        LIMIT $4`,
      [this.tenantId, opts.viewerOmadiaUserId, opts.status ?? null, limit],
    );
    const out: MergeCandidateNode[] = [];
    for (const row of rows.rows) {
      const node = this.hydrateMergeCandidate(
        row.external_id,
        row.properties as MergeCandidateNode['props'] & {
          mk_pair: [string, string];
        },
      );
      if (node) out.push(node);
    }
    return out;
  }

  async getMergeCandidate(
    externalId: string,
    viewerOmadiaUserId: string,
  ): Promise<MergeCandidateNode | null> {
    const rows = await this.pool.query<{
      properties: MergeCandidateNode['props'];
      owns_one: boolean;
    }>(
      `SELECT mc.properties,
              EXISTS(
                SELECT 1
                  FROM graph_edges e
                  JOIN graph_nodes mk ON mk.id = e.to_node
                 WHERE e.from_node = mc.id
                   AND e.type = 'DUPLICATE_OF'
                   AND mk.type = 'MemorableKnowledge'
                   AND mk.properties->'acl_owners' @> jsonb_build_array($3::text)
              ) AS owns_one
         FROM graph_nodes mc
        WHERE mc.tenant_id = $1
          AND mc.external_id = $2
          AND mc.type = 'MergeCandidate'
        LIMIT 1`,
      [this.tenantId, externalId, viewerOmadiaUserId],
    );
    const hit = rows.rows[0];
    if (!hit || !hit.owns_one) return null;
    return this.hydrateMergeCandidate(
      externalId,
      hit.properties as MergeCandidateNode['props'] & {
        mk_pair: [string, string];
      },
    );
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

    // Map resolution → terminal status. not_duplicate = false-positive
    // → 'dismissed'; keep_a/keep_b → 'resolved'.
    const terminalStatus: MergeCandidateStatus =
      resolution === 'not_duplicate' ? 'dismissed' : 'resolved';

    if (resolution === 'keep_a') {
      await this.deleteMemory(existing.duplicateOf[1], actor);
    } else if (resolution === 'keep_b') {
      await this.deleteMemory(existing.duplicateOf[0], actor);
    }

    const now = new Date().toISOString();
    const nextProps = {
      ...(existing.props as Record<string, unknown>),
      status: terminalStatus,
      resolution,
      resolved_at: now,
      resolved_by: actor.actorOmadiaUserId,
      mk_pair: existing.duplicateOf,
    };
    const validated = validateNodeProps('MergeCandidate', nextProps);
    await this.pool.query(
      `UPDATE graph_nodes
          SET properties = $2::jsonb
        WHERE tenant_id = $1
          AND external_id = $3
          AND type = 'MergeCandidate'`,
      [this.tenantId, JSON.stringify(validated), externalId],
    );

    const refetched = this.hydrateMergeCandidate(
      externalId,
      validated as MergeCandidateNode['props'] & {
        mk_pair: [string, string];
      },
    );
    if (!refetched) {
      return {
        ...existing,
        props: validated as MergeCandidateNode['props'],
      };
    }
    return refetched;
  }

  async listMemorableKnowledgeIdsForBulkMergeCheck(opts: {
    limit: number;
  }): Promise<string[]> {
    const limit = Math.max(1, Math.min(opts.limit, 500));
    const rows = await this.pool.query<{ external_id: string }>(
      `SELECT external_id
         FROM graph_nodes
        WHERE tenant_id = $1
          AND type = 'MemorableKnowledge'
          AND embedding IS NOT NULL
          AND NOT (properties ? 'last_merge_check_at')
        ORDER BY created_at ASC
        LIMIT $2`,
      [this.tenantId, limit],
    );
    return rows.rows.map((r) => r.external_id);
  }

  async countMemorableKnowledgeMergeCheckBuckets(): Promise<{
    unchecked: number;
    alreadyChecked: number;
    withoutEmbedding: number;
  }> {
    const row = await this.pool.query<{
      unchecked: string;
      already_checked: string;
      without_embedding: string;
    }>(
      `SELECT
         count(*) FILTER (
           WHERE embedding IS NOT NULL
             AND NOT (properties ? 'last_merge_check_at')
         )::text AS unchecked,
         count(*) FILTER (
           WHERE properties ? 'last_merge_check_at'
         )::text AS already_checked,
         count(*) FILTER (WHERE embedding IS NULL)::text AS without_embedding
       FROM graph_nodes
       WHERE tenant_id = $1 AND type = 'MemorableKnowledge'`,
      [this.tenantId],
    );
    const r = row.rows[0];
    return {
      unchecked: Number(r?.unchecked ?? '0'),
      alreadyChecked: Number(r?.already_checked ?? '0'),
      withoutEmbedding: Number(r?.without_embedding ?? '0'),
    };
  }

  async markMemorableKnowledgeMergeChecked(
    memorableKnowledgeNodeId: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE graph_nodes
          SET properties = jsonb_set(
                properties,
                '{last_merge_check_at}',
                to_jsonb(now()::timestamptz),
                true
              )
        WHERE tenant_id = $1
          AND external_id = $2
          AND type = 'MemorableKnowledge'`,
      [this.tenantId, memorableKnowledgeNodeId],
    );
  }

  // ─── Slice 12 — ExcerptMergeCandidate + deleteExcerpt ─────────────

  private hydrateExcerptMergeCandidate(
    externalId: string,
    properties: ExcerptMergeCandidateNode['props'] & {
      excerpt_pair?: [string, string];
    },
  ): ExcerptMergeCandidateNode | null {
    const pair = properties.excerpt_pair;
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    return {
      id: externalId,
      type: 'ExcerptMergeCandidate' as const,
      props: properties,
      duplicateExcerptOf: [pair[0], pair[1]],
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

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const existing = await client.query<{ external_id: string }>(
        `SELECT mc.external_id
           FROM graph_nodes mc
           JOIN graph_edges e1 ON e1.from_node = mc.id AND e1.type = 'DUPLICATE_EXCERPT_OF'
           JOIN graph_nodes ex1 ON ex1.id = e1.to_node
           JOIN graph_edges e2 ON e2.from_node = mc.id AND e2.type = 'DUPLICATE_EXCERPT_OF'
           JOIN graph_nodes ex2 ON ex2.id = e2.to_node
          WHERE mc.tenant_id = $1
            AND mc.type = 'ExcerptMergeCandidate'
            AND ex1.external_id = $2
            AND ex2.external_id = $3
          LIMIT 1`,
        [this.tenantId, sortedPair[0], sortedPair[1]],
      );
      if (existing.rows.length > 0) {
        await client.query('COMMIT');
        return null;
      }

      const excerptRows = await client.query<{ id: string; external_id: string }>(
        `SELECT id, external_id FROM graph_nodes
          WHERE tenant_id = $1
            AND type = 'PalaiaExcerpt'
            AND external_id = ANY($2::text[])`,
        [this.tenantId, sortedPair],
      );
      if (excerptRows.rows.length !== 2) {
        await client.query('COMMIT');
        return null;
      }

      const now = new Date().toISOString();
      const externalId = excerptMergeCandidateNodeId(randomUUID());
      const props = validateNodeProps('ExcerptMergeCandidate', {
        cosine_sim: input.cosineSim,
        status: 'open' as const,
        resolution: null,
        created_at: now,
        resolved_at: null,
        resolved_by: null,
        excerpt_pair: sortedPair,
      });
      const mcUuid = await this.upsertNode(client, {
        externalId,
        type: 'ExcerptMergeCandidate',
        scope: null,
        userId: null,
        props,
      });
      for (const ex of excerptRows.rows) {
        await this.upsertEdge(client, {
          type: 'DUPLICATE_EXCERPT_OF',
          fromUuid: mcUuid,
          toUuid: ex.id,
        });
      }

      await client.query('COMMIT');
      return this.hydrateExcerptMergeCandidate(
        externalId,
        props as ExcerptMergeCandidateNode['props'] & {
          excerpt_pair: [string, string];
        },
      );
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listExcerptMergeCandidates(
    opts: ListExcerptMergeCandidatesOptions,
  ): Promise<ExcerptMergeCandidateNode[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    // ACL: visible when the viewer owns at least one of the two
    // excerpts' parent MKs. The JOIN goes:
    //   ExcerptMergeCandidate -DUPLICATE_EXCERPT_OF-> Excerpt -EXCERPT_OF-> MK
    const rows = await this.pool.query<{
      external_id: string;
      properties: ExcerptMergeCandidateNode['props'];
    }>(
      `SELECT DISTINCT mc.external_id, mc.properties
         FROM graph_nodes mc
         JOIN graph_edges de ON de.from_node = mc.id AND de.type = 'DUPLICATE_EXCERPT_OF'
         JOIN graph_nodes ex ON ex.id = de.to_node AND ex.type = 'PalaiaExcerpt'
         JOIN graph_edges eo ON eo.from_node = ex.id AND eo.type = 'EXCERPT_OF'
         JOIN graph_nodes mk ON mk.id = eo.to_node AND mk.type = 'MemorableKnowledge'
        WHERE mc.tenant_id = $1
          AND mc.type = 'ExcerptMergeCandidate'
          AND mk.properties->'acl_owners' @> jsonb_build_array($2::text)
          AND ($3::text IS NULL OR mc.properties->>'status' = $3)
        ORDER BY mc.external_id DESC
        LIMIT $4`,
      [this.tenantId, opts.viewerOmadiaUserId, opts.status ?? null, limit],
    );
    const out: ExcerptMergeCandidateNode[] = [];
    for (const row of rows.rows) {
      const node = this.hydrateExcerptMergeCandidate(
        row.external_id,
        row.properties as ExcerptMergeCandidateNode['props'] & {
          excerpt_pair: [string, string];
        },
      );
      if (node) out.push(node);
    }
    return out;
  }

  async getExcerptMergeCandidate(
    externalId: string,
    viewerOmadiaUserId: string,
  ): Promise<ExcerptMergeCandidateNode | null> {
    const rows = await this.pool.query<{
      properties: ExcerptMergeCandidateNode['props'];
      owns_one: boolean;
    }>(
      `SELECT mc.properties,
              EXISTS(
                SELECT 1
                  FROM graph_edges de
                  JOIN graph_nodes ex ON ex.id = de.to_node
                  JOIN graph_edges eo ON eo.from_node = ex.id AND eo.type = 'EXCERPT_OF'
                  JOIN graph_nodes mk ON mk.id = eo.to_node
                 WHERE de.from_node = mc.id
                   AND de.type = 'DUPLICATE_EXCERPT_OF'
                   AND ex.type = 'PalaiaExcerpt'
                   AND mk.type = 'MemorableKnowledge'
                   AND mk.properties->'acl_owners' @> jsonb_build_array($3::text)
              ) AS owns_one
         FROM graph_nodes mc
        WHERE mc.tenant_id = $1
          AND mc.external_id = $2
          AND mc.type = 'ExcerptMergeCandidate'
        LIMIT 1`,
      [this.tenantId, externalId, viewerOmadiaUserId],
    );
    const hit = rows.rows[0];
    if (!hit || !hit.owns_one) return null;
    return this.hydrateExcerptMergeCandidate(
      externalId,
      hit.properties as ExcerptMergeCandidateNode['props'] & {
        excerpt_pair: [string, string];
      },
    );
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

    const terminalStatus: ExcerptMergeStatus =
      resolution === 'not_duplicate' ? 'dismissed' : 'resolved';

    // keep_a/keep_b delete the loser excerpt. Look up parent MK +
    // position for the loser, then delegate to deleteExcerpt.
    const loserExternalId =
      resolution === 'keep_a'
        ? existing.duplicateExcerptOf[1]
        : resolution === 'keep_b'
          ? existing.duplicateExcerptOf[0]
          : null;
    if (loserExternalId) {
      const loserMeta = await this.pool.query<{
        parent_external: string;
        position: number;
      }>(
        `SELECT mk.external_id AS parent_external,
                (ex.properties->>'position')::int AS position
           FROM graph_nodes ex
           JOIN graph_edges eo ON eo.from_node = ex.id AND eo.type = 'EXCERPT_OF'
           JOIN graph_nodes mk ON mk.id = eo.to_node AND mk.type = 'MemorableKnowledge'
          WHERE ex.tenant_id = $1
            AND ex.external_id = $2
            AND ex.type = 'PalaiaExcerpt'
          LIMIT 1`,
        [this.tenantId, loserExternalId],
      );
      const meta = loserMeta.rows[0];
      if (meta) {
        await this.deleteExcerpt(meta.parent_external, meta.position, actor);
      }
    }

    const now = new Date().toISOString();
    const nextProps = {
      ...(existing.props as Record<string, unknown>),
      status: terminalStatus,
      resolution,
      resolved_at: now,
      resolved_by: actor.actorOmadiaUserId,
      excerpt_pair: existing.duplicateExcerptOf,
    };
    const validated = validateNodeProps('ExcerptMergeCandidate', nextProps);
    await this.pool.query(
      `UPDATE graph_nodes
          SET properties = $2::jsonb
        WHERE tenant_id = $1
          AND external_id = $3
          AND type = 'ExcerptMergeCandidate'`,
      [this.tenantId, JSON.stringify(validated), externalId],
    );

    const refetched = this.hydrateExcerptMergeCandidate(
      externalId,
      validated as ExcerptMergeCandidateNode['props'] & {
        excerpt_pair: [string, string];
      },
    );
    return (
      refetched ??
      ({ ...existing, props: validated as ExcerptMergeCandidateNode['props'] })
    );
  }

  async deleteExcerpt(
    memorableKnowledgeNodeId: string,
    position: number,
    actor: AclMutationOptions,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { owners } = await this.loadOwnersOrThrow(
        client,
        memorableKnowledgeNodeId,
      );
      this.assertActorIsOwner(owners, actor.actorOmadiaUserId);

      const excerptRow = await client.query<{ id: string }>(
        `SELECT ex.id
           FROM graph_nodes mk
           JOIN graph_edges e ON e.to_node = mk.id AND e.type = 'EXCERPT_OF'
           JOIN graph_nodes ex ON ex.id = e.from_node AND ex.type = 'PalaiaExcerpt'
          WHERE mk.tenant_id = $1
            AND mk.external_id = $2
            AND mk.type = 'MemorableKnowledge'
            AND ex.tenant_id = $1
            AND (ex.properties->>'position')::int = $3
          LIMIT 1`,
        [this.tenantId, memorableKnowledgeNodeId, position],
      );
      const hit = excerptRow.rows[0];
      if (!hit) {
        throw Object.assign(new Error('excerpt_not_found'), {
          code: 'excerpt_not_found',
        });
      }

      // Delete the excerpt + its EXCERPT_OF edge (cascades via FK).
      await client.query(
        `DELETE FROM graph_nodes WHERE tenant_id = $1 AND id = $2`,
        [this.tenantId, hit.id],
      );

      await this.writeAclAudit(client, {
        memoryExternalId: memorableKnowledgeNodeId,
        actorOmadiaUserId: actor.actorOmadiaUserId,
        ...(actor.actorChannelIdentityId
          ? { actorChannelIdentityId: actor.actorChannelIdentityId }
          : {}),
        action: 'delete_excerpt',
        beforeOwners: owners,
        afterOwners: owners,
        ...(actor.reason ? { reason: actor.reason } : {}),
      });

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listPalaiaExcerptIdsForBulkMergeCheck(opts: {
    limit: number;
  }): Promise<string[]> {
    const limit = Math.max(1, Math.min(opts.limit, 500));
    const rows = await this.pool.query<{ external_id: string }>(
      `SELECT external_id
         FROM graph_nodes
        WHERE tenant_id = $1
          AND type = 'PalaiaExcerpt'
          AND embedding IS NOT NULL
          AND NOT (properties ? 'last_excerpt_merge_check_at')
        ORDER BY created_at ASC
        LIMIT $2`,
      [this.tenantId, limit],
    );
    return rows.rows.map((r) => r.external_id);
  }

  async countPalaiaExcerptMergeCheckBuckets(): Promise<{
    unchecked: number;
    alreadyChecked: number;
    withoutEmbedding: number;
  }> {
    const row = await this.pool.query<{
      unchecked: string;
      already_checked: string;
      without_embedding: string;
    }>(
      `SELECT
         count(*) FILTER (
           WHERE embedding IS NOT NULL
             AND NOT (properties ? 'last_excerpt_merge_check_at')
         )::text AS unchecked,
         count(*) FILTER (
           WHERE properties ? 'last_excerpt_merge_check_at'
         )::text AS already_checked,
         count(*) FILTER (WHERE embedding IS NULL)::text AS without_embedding
       FROM graph_nodes
       WHERE tenant_id = $1 AND type = 'PalaiaExcerpt'`,
      [this.tenantId],
    );
    const r = row.rows[0];
    return {
      unchecked: Number(r?.unchecked ?? '0'),
      alreadyChecked: Number(r?.already_checked ?? '0'),
      withoutEmbedding: Number(r?.without_embedding ?? '0'),
    };
  }

  async markPalaiaExcerptMergeChecked(
    excerptExternalId: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE graph_nodes
          SET properties = jsonb_set(
                properties,
                '{last_excerpt_merge_check_at}',
                to_jsonb(now()::timestamptz),
                true
              )
        WHERE tenant_id = $1
          AND external_id = $2
          AND type = 'PalaiaExcerpt'`,
      [this.tenantId, excerptExternalId],
    );
  }

  // ─── Slice 11 — Topic clustering persistence ──────────────────────

  private hydrateTopic(row: {
    external_id: string;
    properties: TopicNode['props'];
  }): TopicNode {
    return {
      id: row.external_id,
      type: 'Topic' as const,
      props: row.properties,
    };
  }

  async listTopics(): Promise<TopicNode[]> {
    const rows = await this.pool.query<{
      external_id: string;
      properties: TopicNode['props'];
    }>(
      `SELECT external_id, properties
         FROM graph_nodes
        WHERE tenant_id = $1 AND type = 'Topic'
        ORDER BY (properties->>'member_count')::int DESC NULLS LAST,
                 properties->>'name' ASC`,
      [this.tenantId],
    );
    return rows.rows.map((r) => this.hydrateTopic(r));
  }

  async getTopic(externalId: string): Promise<TopicNode | null> {
    const rows = await this.pool.query<{
      external_id: string;
      properties: TopicNode['props'];
    }>(
      `SELECT external_id, properties
         FROM graph_nodes
        WHERE tenant_id = $1 AND external_id = $2 AND type = 'Topic'
        LIMIT 1`,
      [this.tenantId, externalId],
    );
    const hit = rows.rows[0];
    return hit ? this.hydrateTopic(hit) : null;
  }

  async listTopicMembers(topicExternalId: string): Promise<GraphNode[]> {
    const rows = await this.pool.query<NodeRow>(
      `SELECT ${NODE_COLUMNS.split(', ').map((c) => `mk.${c}`).join(', ')}
         FROM graph_nodes topic_node
         JOIN graph_edges e ON e.to_node = topic_node.id AND e.type = 'HAS_TOPIC'
         JOIN graph_nodes mk ON mk.id = e.from_node AND mk.type = 'MemorableKnowledge'
        WHERE topic_node.tenant_id = $1
          AND topic_node.external_id = $2
          AND topic_node.type = 'Topic'
        ORDER BY mk.created_at DESC`,
      [this.tenantId, topicExternalId],
    );
    return rows.rows.map(rowToNode);
  }

  async listMemorableKnowledgeWithEmbeddings(): Promise<
    Array<{ mk: GraphNode; embedding: number[] }>
  > {
    const rows = await this.pool.query<NodeRow & { embedding: string | null }>(
      `SELECT ${NODE_COLUMNS}, embedding::text AS embedding
         FROM graph_nodes
        WHERE tenant_id = $1
          AND type = 'MemorableKnowledge'
          AND embedding IS NOT NULL`,
      [this.tenantId],
    );
    const out: Array<{ mk: GraphNode; embedding: number[] }> = [];
    for (const row of rows.rows) {
      if (!row.embedding) continue;
      const text = row.embedding;
      // pgvector text format: `[0.1,0.2,…]`. Strip brackets, split, parse.
      const inner = text.startsWith('[') && text.endsWith(']')
        ? text.slice(1, -1)
        : text;
      const parts = inner.split(',');
      const vec: number[] = new Array(parts.length);
      let allFinite = true;
      for (let i = 0; i < parts.length; i++) {
        const n = Number.parseFloat(parts[i]!);
        if (!Number.isFinite(n)) {
          allFinite = false;
          break;
        }
        vec[i] = n;
      }
      if (!allFinite) continue;
      out.push({ mk: rowToNode(row), embedding: vec });
    }
    return out;
  }

  async deleteAllTopics(): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // graph_edges cascades on graph_nodes delete, but the FK is on
      // the internal uuid not external_id — fetch uuids first, then
      // delete edges + nodes in one transaction.
      const uuidRows = await client.query<{ id: string }>(
        `SELECT id FROM graph_nodes WHERE tenant_id = $1 AND type = 'Topic'`,
        [this.tenantId],
      );
      const uuids = uuidRows.rows.map((r) => r.id);
      if (uuids.length === 0) {
        await client.query('COMMIT');
        return 0;
      }
      await client.query(
        `DELETE FROM graph_edges
          WHERE tenant_id = $1
            AND type = 'HAS_TOPIC'
            AND to_node = ANY($2::uuid[])`,
        [this.tenantId, uuids],
      );
      const deleted = await client.query(
        `DELETE FROM graph_nodes
          WHERE tenant_id = $1 AND type = 'Topic'`,
        [this.tenantId],
      );
      await client.query('COMMIT');
      return deleted.rowCount ?? 0;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async createTopic(input: {
    name: string;
    description: string;
    namingSource: TopicNamingSource;
    memberMkIds: readonly string[];
  }): Promise<TopicNode> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const now = new Date().toISOString();
      const externalId = topicNodeId(randomUUID());
      const props = validateNodeProps('Topic', {
        name: input.name,
        description: input.description,
        member_count: input.memberMkIds.length,
        created_at: now,
        updated_at: now,
        naming_source: input.namingSource,
      });
      const topicUuid = await this.upsertNode(client, {
        externalId,
        type: 'Topic',
        scope: null,
        userId: null,
        props,
      });

      if (input.memberMkIds.length > 0) {
        const mkRows = await client.query<{ id: string; external_id: string }>(
          `SELECT id, external_id FROM graph_nodes
            WHERE tenant_id = $1
              AND type = 'MemorableKnowledge'
              AND external_id = ANY($2::text[])`,
          [this.tenantId, input.memberMkIds],
        );
        for (const mk of mkRows.rows) {
          await this.upsertEdge(client, {
            type: 'HAS_TOPIC',
            fromUuid: mk.id,
            toUuid: topicUuid,
          });
        }
      }

      await client.query('COMMIT');
      return {
        id: externalId,
        type: 'Topic' as const,
        props: props as TopicNode['props'],
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ─── Slice 11.5 — Dev-UI overlays over Slice 9/10/11 nodes ───────

  async listTopicMembershipEdges(): Promise<
    Array<{ from: string; to: string }>
  > {
    const rows = await this.pool.query<{ from_xid: string; to_xid: string }>(
      `SELECT mk.external_id AS from_xid, tp.external_id AS to_xid
         FROM graph_edges e
         JOIN graph_nodes mk ON mk.id = e.from_node
         JOIN graph_nodes tp ON tp.id = e.to_node
        WHERE e.tenant_id = $1
          AND e.type = 'HAS_TOPIC'
          AND mk.type = 'MemorableKnowledge'
          AND tp.type = 'Topic'`,
      [this.tenantId],
    );
    return rows.rows.map((r) => ({ from: r.from_xid, to: r.to_xid }));
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
    const statusFilter = opts?.status ?? null;

    const [incRows, mcRows, emcRows, edgeRows] = await Promise.all([
      this.pool.query<{
        external_id: string;
        properties: InconsistencyNode['props'] & { mk_pair: [string, string] };
      }>(
        `SELECT external_id, properties
           FROM graph_nodes
          WHERE tenant_id = $1 AND type = 'Inconsistency'
            AND ($2::text IS NULL OR properties->>'status' = $2)
          ORDER BY external_id DESC`,
        [this.tenantId, statusFilter],
      ),
      this.pool.query<{
        external_id: string;
        properties: MergeCandidateNode['props'] & { mk_pair: [string, string] };
      }>(
        `SELECT external_id, properties
           FROM graph_nodes
          WHERE tenant_id = $1 AND type = 'MergeCandidate'
            AND ($2::text IS NULL OR properties->>'status' = $2)
          ORDER BY external_id DESC`,
        [this.tenantId, statusFilter],
      ),
      this.pool.query<{
        external_id: string;
        properties: ExcerptMergeCandidateNode['props'] & {
          excerpt_pair: [string, string];
        };
      }>(
        `SELECT external_id, properties
           FROM graph_nodes
          WHERE tenant_id = $1 AND type = 'ExcerptMergeCandidate'
            AND ($2::text IS NULL OR properties->>'status' = $2)
          ORDER BY external_id DESC`,
        [this.tenantId, statusFilter],
      ),
      this.pool.query<{
        from_xid: string;
        to_xid: string;
        edge_type: 'CONFLICTS_WITH' | 'DUPLICATE_OF' | 'DUPLICATE_EXCERPT_OF';
      }>(
        `SELECT src.external_id AS from_xid,
                dst.external_id AS to_xid,
                e.type AS edge_type
           FROM graph_edges e
           JOIN graph_nodes src ON src.id = e.from_node
           JOIN graph_nodes dst ON dst.id = e.to_node
          WHERE e.tenant_id = $1
            AND (
              (e.type IN ('CONFLICTS_WITH', 'DUPLICATE_OF')
                 AND src.type IN ('Inconsistency', 'MergeCandidate')
                 AND dst.type = 'MemorableKnowledge')
              OR (e.type = 'DUPLICATE_EXCERPT_OF'
                 AND src.type = 'ExcerptMergeCandidate'
                 AND dst.type = 'PalaiaExcerpt')
            )`,
        [this.tenantId],
      ),
    ]);

    const inconsistencies: InconsistencyNode[] = [];
    for (const r of incRows.rows) {
      const node = this.hydrateInconsistency(r.external_id, r.properties);
      if (node) inconsistencies.push(node);
    }
    const mergeCandidates: MergeCandidateNode[] = [];
    for (const r of mcRows.rows) {
      const node = this.hydrateMergeCandidate(r.external_id, r.properties);
      if (node) mergeCandidates.push(node);
    }
    const excerptMergeCandidates: ExcerptMergeCandidateNode[] = [];
    for (const r of emcRows.rows) {
      const node = this.hydrateExcerptMergeCandidate(
        r.external_id,
        r.properties,
      );
      if (node) excerptMergeCandidates.push(node);
    }
    return {
      inconsistencies,
      mergeCandidates,
      excerptMergeCandidates,
      edges: edgeRows.rows.map((r) => ({
        from: r.from_xid,
        to: r.to_xid,
        type: r.edge_type,
      })),
    };
  }

  async listMemoryAclAudit(
    memorableKnowledgeNodeId: string,
    opts: { limit?: number } = {},
  ): Promise<AclAuditEntry[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
    const rows = await this.pool.query<{
      id: string;
      memory_external_id: string;
      actor_omadia_user_id: string;
      actor_channel_identity_id: string | null;
      action: AclAction;
      before_owners: unknown;
      after_owners: unknown;
      reason: string | null;
      created_at: Date;
    }>(
      `SELECT id, memory_external_id, actor_omadia_user_id,
              actor_channel_identity_id, action,
              before_owners, after_owners, reason, created_at
       FROM memory_acl_audit
       WHERE tenant_id = $1 AND memory_external_id = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [this.tenantId, memorableKnowledgeNodeId, limit],
    );
    return rows.rows.map((r) => ({
      id: r.id,
      memoryExternalId: r.memory_external_id,
      actorOmadiaUserId: r.actor_omadia_user_id,
      ...(r.actor_channel_identity_id
        ? { actorChannelIdentityId: r.actor_channel_identity_id }
        : {}),
      action: r.action,
      beforeOwners: Array.isArray(r.before_owners)
        ? (r.before_owners as string[])
        : [],
      afterOwners:
        r.after_owners === null
          ? null
          : Array.isArray(r.after_owners)
            ? (r.after_owners as string[])
            : [],
      ...(r.reason ? { reason: r.reason } : {}),
      createdAt:
        r.created_at instanceof Date
          ? r.created_at.toISOString()
          : String(r.created_at),
    }));
  }

  async listMemoriesForScope(
    scope: string | undefined,
    opts: ListMemoriesForScopeOptions = {},
  ): Promise<MemoriesProvenanceView> {
    const limit = Math.max(1, Math.min(opts.limit ?? 200, 500));
    const includeExcerpts = opts.includeExcerpts !== false;
    const scopeArg = scope ?? null;

    // Step 1: anchor MK UUIDs. When a scope is given, only MKs whose
    // DERIVED_FROM provenance lands in a Turn of that scope qualify; in
    // __ALL__ mode every MK is eligible (newest first, capped by limit).
    const mkRows = await this.pool.query<NodeRow>(
      `
      SELECT ${NODE_COLUMNS.split(', ')
        .map((c) => `mk.${c}`)
        .join(', ')}
      FROM graph_nodes mk
      WHERE mk.tenant_id = $1
        AND mk.type = 'MemorableKnowledge'
        AND (
          $2::text IS NULL
          OR EXISTS (
            SELECT 1
            FROM graph_edges e
            JOIN graph_nodes t ON t.id = e.to_node
            WHERE e.from_node = mk.id
              AND e.type = 'DERIVED_FROM'
              AND e.tenant_id = $1
              AND t.tenant_id = $1
              AND t.type = 'Turn'
              AND t.scope = $2
          )
        )
      ORDER BY mk.created_at DESC
      LIMIT $3
      `,
      [this.tenantId, scopeArg, limit],
    );

    if (mkRows.rows.length === 0) {
      return { memories: [], edges: [] };
    }

    const mkExtIdByUuid = new Map<string, string>();
    const mkNodeByExtId = new Map<string, GraphNode>();
    const mkUuids: string[] = [];
    for (const r of mkRows.rows) {
      const node = rowToNode(r);
      mkExtIdByUuid.set(r.id, node.id);
      mkNodeByExtId.set(node.id, node);
      mkUuids.push(r.id);
    }

    // Step 2: load Lvl-1 neighbours (Turn / User / Entity) of every MK.
    const lvl1Rows = await this.pool.query<
      NodeRow & { from_uuid: string; edge_type: string }
    >(
      `
      SELECT e.from_node AS from_uuid,
             e.type      AS edge_type,
             ${NODE_COLUMNS.split(', ')
               .map((c) => `n.${c}`)
               .join(', ')}
      FROM graph_edges e
      JOIN graph_nodes n ON n.id = e.to_node
      WHERE e.tenant_id = $1
        AND e.from_node = ANY($2::uuid[])
        AND e.type IN ('DERIVED_FROM', 'INVOLVED', 'REQUIRES')
        AND n.tenant_id = $1
      `,
      [this.tenantId, mkUuids],
    );

    const level1ByMk = new Map<string, GraphNode[]>();
    const turnUuidsByMk = new Map<string, string[]>();
    const turnExtIdByUuid = new Map<string, string>();
    const edges: MemoryProvenanceEdge[] = [];

    for (const r of lvl1Rows.rows) {
      const mkExtId = mkExtIdByUuid.get(r.from_uuid);
      if (mkExtId === undefined) continue;
      const node = rowToNode(r);
      const list = level1ByMk.get(mkExtId) ?? [];
      list.push(node);
      level1ByMk.set(mkExtId, list);
      edges.push({
        from: mkExtId,
        to: node.id,
        type: r.edge_type as GraphEdgeType,
      });
      if (r.edge_type === 'DERIVED_FROM' && node.type === 'Turn') {
        turnExtIdByUuid.set(r.id, node.id);
        const turns = turnUuidsByMk.get(mkExtId) ?? [];
        turns.push(r.id);
        turnUuidsByMk.set(mkExtId, turns);
      }
    }

    // Step 3: Lvl-2 = Session via IN_SESSION from every Lvl-1 Turn.
    const allTurnUuids = [...turnExtIdByUuid.keys()];
    const level2ByMk = new Map<string, GraphNode[]>();
    if (allTurnUuids.length > 0) {
      const sessionRows = await this.pool.query<
        NodeRow & { from_uuid: string; edge_type: string }
      >(
        `
        SELECT e.from_node AS from_uuid,
               e.type      AS edge_type,
               ${NODE_COLUMNS.split(', ')
                 .map((c) => `n.${c}`)
                 .join(', ')}
        FROM graph_edges e
        JOIN graph_nodes n ON n.id = e.to_node
        WHERE e.tenant_id = $1
          AND e.from_node = ANY($2::uuid[])
          AND e.type = 'IN_SESSION'
          AND n.tenant_id = $1
          AND n.type = 'Session'
        `,
        [this.tenantId, allTurnUuids],
      );

      const sessionsByTurnExtId = new Map<string, GraphNode[]>();
      for (const r of sessionRows.rows) {
        const turnExtId = turnExtIdByUuid.get(r.from_uuid);
        if (turnExtId === undefined) continue;
        const node = rowToNode(r);
        const list = sessionsByTurnExtId.get(turnExtId) ?? [];
        list.push(node);
        sessionsByTurnExtId.set(turnExtId, list);
        edges.push({
          from: turnExtId,
          to: node.id,
          type: 'IN_SESSION',
        });
      }

      for (const [mkExtId, turnUuids] of turnUuidsByMk) {
        const sessions: GraphNode[] = [];
        const seen = new Set<string>();
        for (const tUuid of turnUuids) {
          const tExtId = turnExtIdByUuid.get(tUuid);
          if (tExtId === undefined) continue;
          for (const s of sessionsByTurnExtId.get(tExtId) ?? []) {
            if (seen.has(s.id)) continue;
            seen.add(s.id);
            sessions.push(s);
          }
        }
        if (sessions.length > 0) level2ByMk.set(mkExtId, sessions);
      }
    }

    // Step 4: Excerpts whose parent MK lives in the result set.
    const excerptRowsByMk = new Map<string, GraphNode[]>();
    if (includeExcerpts) {
      const excerptRows = await this.pool.query<
        NodeRow & { to_uuid: string }
      >(
        `
        SELECT e.to_node AS to_uuid,
               ${NODE_COLUMNS.split(', ')
                 .map((c) => `ex.${c}`)
                 .join(', ')}
        FROM graph_edges e
        JOIN graph_nodes ex ON ex.id = e.from_node
        WHERE e.tenant_id = $1
          AND e.to_node = ANY($2::uuid[])
          AND e.type = 'EXCERPT_OF'
          AND ex.tenant_id = $1
          AND ex.type = 'PalaiaExcerpt'
        ORDER BY (ex.properties->>'position')::int ASC NULLS LAST
        `,
        [this.tenantId, mkUuids],
      );

      for (const r of excerptRows.rows) {
        const mkExtId = mkExtIdByUuid.get(r.to_uuid);
        if (mkExtId === undefined) continue;
        const node = rowToNode(r);
        const list = excerptRowsByMk.get(mkExtId) ?? [];
        list.push(node);
        excerptRowsByMk.set(mkExtId, list);
        edges.push({
          from: node.id,
          to: mkExtId,
          type: 'EXCERPT_OF',
        });
      }
    }

    // Assemble per-memory provenance views — MKs first (sorted as they
    // came out of step 1), then their excerpts attached.
    const memories: MemoryWithAncestors[] = [];
    for (const r of mkRows.rows) {
      const mkExtId = r.external_id;
      const mkNode = mkNodeByExtId.get(mkExtId);
      if (!mkNode) continue;
      const mkLevel1 = level1ByMk.get(mkExtId) ?? [];
      const mkLevel2 = level2ByMk.get(mkExtId) ?? [];
      memories.push({ node: mkNode, level1: mkLevel1, level2: mkLevel2 });
      for (const ex of excerptRowsByMk.get(mkExtId) ?? []) {
        memories.push({
          node: ex,
          level1: [mkNode],
          level2: mkLevel1,
        });
      }
    }

    return { memories, edges };
  }

  async findEntities(opts: FindEntitiesOptions): Promise<GraphNode[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 25, 200));
    const model = opts.model.trim();
    if (model.length === 0) return [];
    const nameFilter = opts.nameContains?.trim();
    const hasName = nameFilter !== undefined && nameFilter.length > 0;
    const like = hasName ? `%${nameFilter}%` : null;

    const rows = await this.pool.query<NodeRow>(
      `
      SELECT ${NODE_COLUMNS}
      FROM graph_nodes
      WHERE tenant_id = $1
        AND type IN ('OdooEntity', 'ConfluencePage')
        AND properties->>'model' = $2
        AND (
          $3::text IS NULL
          OR (properties->>'displayName') ILIKE $3
          OR (properties->>'id')         ILIKE $3
        )
      ORDER BY properties->>'displayName' ASC NULLS LAST
      LIMIT $4
      `,
      [this.tenantId, model, like, limit],
    );
    return rows.rows.map(rowToNode);
  }

  async findEntityCapturedTurns(
    opts: EntityCapturedTurnsOptions,
  ): Promise<EntityCapturedTurnsHit[]> {
    const terms = opts.terms
      .map((t) => t.trim())
      .filter((t) => t.length >= 2);
    if (terms.length === 0) return [];

    const perEntityLimit = Math.max(1, Math.min(opts.perEntityLimit ?? 2, 10));
    const entityLimit = Math.max(1, Math.min(opts.entityLimit ?? 5, 25));
    const userIdFilter = opts.userId ?? null;
    const excludeScope = opts.excludeScope ?? null;
    const agentScopePrefix = opts.agentScopePrefix ?? null;
    const likeTerms = terms.map((t) => `%${t}%`);
    const exactTerms = terms;

    // Match entities by displayName OR id (exact). Trigram index on the JSON
    // expression makes the ILIKE branch fast; the equality branch uses the
    // dedicated id trigram index or falls back to a seq scan on a small set.
    const entityRows = await this.pool.query<NodeRow>(
      `
      SELECT ${NODE_COLUMNS}
      FROM graph_nodes
      WHERE tenant_id = $1
        AND type IN ('OdooEntity', 'ConfluencePage')
        AND (
          (properties->>'displayName') ILIKE ANY($2::text[])
          OR (properties->>'id') = ANY($3::text[])
        )
      LIMIT $4
      `,
      [this.tenantId, likeTerms, exactTerms, entityLimit],
    );

    if (entityRows.rows.length === 0) return [];

    const hits: EntityCapturedTurnsHit[] = [];
    for (const row of entityRows.rows) {
      const turnRows = await this.pool.query<{
        external_id: string;
        scope: string;
        properties: Record<string, unknown>;
      }>(
        `
        SELECT t.external_id, t.scope, t.properties
        FROM graph_edges e
        JOIN graph_nodes t ON t.id = e.from_node
        WHERE e.tenant_id = $1
          AND e.type = 'CAPTURED'
          AND e.to_node = $2
          AND t.type = 'Turn'
          AND ($3::text IS NULL OR t.user_id = $3)
          AND ($4::text IS NULL OR t.scope <> $4)
          -- Per-orchestrator isolation: the entity NODE stays global (shared
          -- vocabulary), but entity-anchored recall only surfaces turns of
          -- the active Agent. Closes the cross-agent entity-recall leak.
          AND ($6::text IS NULL
            OR t.scope LIKE $6 || '%'
            OR ($6 = 'default::' AND t.scope NOT LIKE '%::%'))
        ORDER BY (t.properties->>'time') DESC
        LIMIT $5
        `,
        [
          this.tenantId,
          row.id,
          userIdFilter,
          excludeScope,
          perEntityLimit,
          agentScopePrefix,
        ],
      );

      if (turnRows.rows.length === 0) continue;

      hits.push({
        entity: rowToNode(row),
        turns: turnRows.rows.map((t) => {
          // OB-73 — credit each Turn surfaced via entity-anchored recall.
          this.accessTracker?.markAccessed(t.external_id);
          return {
            turnId: t.external_id,
            scope: t.scope,
            time: String(t.properties['time'] ?? ''),
            userMessage: String(t.properties['userMessage'] ?? ''),
            assistantAnswer: String(t.properties['assistantAnswer'] ?? ''),
          };
        }),
      });
    }

    return hits;
  }

  // -------------------------------------------------------------------------

  private async findNodeByExternalId(
    externalId: string,
  ): Promise<NodeRow | null> {
    const result = await this.pool.query<NodeRow>(
      `SELECT ${NODE_COLUMNS}
       FROM graph_nodes WHERE tenant_id = $1 AND external_id = $2`,
      [this.tenantId, externalId],
    );
    return result.rows[0] ?? null;
  }

  private async upsertNode(
    client: PoolClient,
    params: {
      externalId: string;
      type: GraphNodeType;
      scope: string | null;
      userId?: string | null;
      props: Record<string, unknown>;
      mergeProps?: Record<string, unknown>;
      // OB-71 — optional palaia overrides. When undefined, the schema
      // defaults (`memory`/`team`/NULL) take over on insert and the row
      // is left unchanged on conflict. When provided, they overwrite the
      // dedicated columns so a re-classification (e.g. user-edited hint)
      // can update the verdict without touching `properties`.
      entryType?: string;
      visibility?: string;
      significance?: number | null;
    },
  ): Promise<string> {
    const palaiaSet = [
      params.entryType !== undefined ? `entry_type = $8` : null,
      params.visibility !== undefined ? `visibility = $9` : null,
      params.significance !== undefined ? `significance = $10` : null,
    ]
      .filter((s): s is string => s !== null)
      .join(', ');
    const updateClause = palaiaSet ? `, ${palaiaSet}` : '';
    const result = await client.query<{ id: string }>(
      `
      INSERT INTO graph_nodes (external_id, type, tenant_id, scope, user_id, properties, entry_type, visibility, significance)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb,
              COALESCE($8::text, 'memory'),
              COALESCE($9::text, 'team'),
              $10::real)
      ON CONFLICT (tenant_id, external_id) DO UPDATE
        SET properties = graph_nodes.properties || EXCLUDED.properties || $7::jsonb,
            scope = COALESCE(EXCLUDED.scope, graph_nodes.scope),
            user_id = COALESCE(EXCLUDED.user_id, graph_nodes.user_id)${updateClause}
      RETURNING id
      `,
      [
        params.externalId,
        params.type,
        this.tenantId,
        params.scope,
        params.userId ?? null,
        JSON.stringify(params.props),
        JSON.stringify(params.mergeProps ?? {}),
        params.entryType ?? null,
        params.visibility ?? null,
        params.significance ?? null,
      ],
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error('upsertNode: missing id in result');
    return id;
  }

  private async upsertEdge(
    client: PoolClient,
    params: {
      type: GraphEdgeType;
      fromUuid: string;
      toUuid: string;
      props?: Record<string, unknown>;
    },
  ): Promise<void> {
    await client.query(
      `
      INSERT INTO graph_edges (type, from_node, to_node, tenant_id, properties)
      VALUES ($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT (tenant_id, from_node, to_node, type) DO NOTHING
      `,
      [
        params.type,
        params.fromUuid,
        params.toUuid,
        this.tenantId,
        JSON.stringify(params.props ?? {}),
      ],
    );
  }

  /**
   * Maintain the chronological NEXT_TURN chain within a session incrementally.
   * Finds the immediate predecessor/successor of the new turn by time, repoints
   * edges around it, and skips a full chain rebuild — O(log n) per ingest.
   */
  private async rebuildNextTurnLinks(
    client: PoolClient,
    scope: string,
    current: { turnUuid: string; time: string },
  ): Promise<void> {
    const prev = await client.query<{ id: string }>(
      `
      SELECT id FROM graph_nodes
      WHERE tenant_id = $1 AND type = 'Turn' AND scope = $2
        AND (properties->>'time') < $3
      ORDER BY (properties->>'time') DESC
      LIMIT 1
      `,
      [this.tenantId, scope, current.time],
    );
    const next = await client.query<{ id: string }>(
      `
      SELECT id FROM graph_nodes
      WHERE tenant_id = $1 AND type = 'Turn' AND scope = $2
        AND (properties->>'time') > $3
      ORDER BY (properties->>'time') ASC
      LIMIT 1
      `,
      [this.tenantId, scope, current.time],
    );

    const prevUuid = prev.rows[0]?.id ?? null;
    const nextUuid = next.rows[0]?.id ?? null;

    if (prevUuid && nextUuid) {
      await client.query(
        `DELETE FROM graph_edges
         WHERE tenant_id = $1 AND type = 'NEXT_TURN'
           AND from_node = $2 AND to_node = $3`,
        [this.tenantId, prevUuid, nextUuid],
      );
    }
    if (prevUuid) {
      await this.upsertEdge(client, {
        type: 'NEXT_TURN',
        fromUuid: prevUuid,
        toUuid: current.turnUuid,
      });
    }
    if (nextUuid) {
      await this.upsertEdge(client, {
        type: 'NEXT_TURN',
        fromUuid: current.turnUuid,
        toUuid: nextUuid,
      });
    }
  }
}

export function rowToNode(row: NodeRow): GraphNode {
  const node: GraphNode = {
    id: row.external_id,
    type: row.type as GraphNodeType,
    props: row.properties,
  };
  // Palaia uplift (OB-70). Project only when the SELECT included the column —
  // tighter projections (search/FTS/embedding paths) skip these for now. New
  // rows always carry NOT-NULL defaults; pre-migration rows would too once the
  // ALTER TABLE … DEFAULT backfill ran in 0007. The nullable axes
  // (accessed_at/content_hash/significance/task_status) stay null for legacy
  // rows until the OB-80 backfill catches up.
  if (row.entry_type !== undefined) {
    node.entryType = row.entry_type as EntryType;
  }
  if (row.visibility !== undefined) {
    node.visibility = row.visibility as Visibility;
  }
  if (row.tier !== undefined) {
    node.tier = row.tier as Tier;
  }
  if (row.accessed_at !== undefined) {
    const v = row.accessed_at;
    node.accessedAt =
      v === null ? null : v instanceof Date ? v.toISOString() : String(v);
  }
  if (row.access_count !== undefined) {
    node.accessCount = Number(row.access_count);
  }
  if (row.decay_score !== undefined) {
    node.decayScore = Number(row.decay_score);
  }
  if (row.content_hash !== undefined) {
    node.contentHash = row.content_hash;
  }
  if (row.manually_authored !== undefined) {
    node.manuallyAuthored = Boolean(row.manually_authored);
  }
  if (row.task_status !== undefined) {
    node.taskStatus =
      row.task_status === null ? null : (row.task_status as TaskStatus);
  }
  if (row.significance !== undefined) {
    node.significance =
      row.significance === null ? null : Number(row.significance);
  }
  return node;
}

/**
 * Serialises a numeric vector in the literal form pgvector's `::vector` cast
 * accepts (`"[1.2,3.4,…]"`). Using a string literal + cast keeps us out of
 * any driver-side binary-vector encoding so the same path works against
 * vanilla pgvector (via `pg`) and Neon's pooled endpoints alike.
 */
function vectorLiteral(v: readonly number[]): string {
  // Scientific notation is rejected by pgvector's parser — toFixed() keeps us
  // in plain decimal. 6 significant digits are far more precision than cosine
  // similarity actually needs.
  const parts = v.map((x) => {
    if (!Number.isFinite(x)) return '0';
    return x.toFixed(6);
  });
  return `[${parts.join(',')}]`;
}
