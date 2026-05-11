import { Pool, type PoolClient } from 'pg';

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
  type CompanyIngestResult,
  type CompanyRelationsIngest,
  type CompanyRelationsResult,
  type EntityCapturedTurnsHit,
  type EntityCapturedTurnsOptions,
  type EntityIngest,
  type EntityIngestResult,
  type EntryType,
  type FactIngest,
  type FactIngestResult,
  type FinancialSnapshotIngest,
  type FinancialSnapshotIngestResult,
  type FindEntitiesOptions,
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

  async ingestCompanies(
    companies: CompanyIngest[],
  ): Promise<CompanyIngestResult> {
    if (companies.length === 0) {
      return { companyIds: [], inserted: 0, updated: 0 };
    }
    const client = await this.pool.connect();
    const companyIds: string[] = [];
    let inserted = 0;
    let updated = 0;
    try {
      await client.query('BEGIN');
      const lastSyncedAt = new Date().toISOString();
      for (const c of companies) {
        const extId = companyNodeId(c.externalId);
        const props = validateNodeProps('Company', {
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
        });
        const wasUpdate = await this.nodeExists(client, extId);
        await this.upsertNode(client, {
          externalId: extId,
          type: 'Company',
          scope: null,
          userId: null,
          props,
        });
        companyIds.push(extId);
        if (wasUpdate) updated++;
        else inserted++;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return { companyIds, inserted, updated };
  }

  async ingestPersons(persons: PersonIngest[]): Promise<PersonIngestResult> {
    if (persons.length === 0) {
      return { personIds: [], inserted: 0, updated: 0 };
    }
    const client = await this.pool.connect();
    const personIds: string[] = [];
    let inserted = 0;
    let updated = 0;
    try {
      await client.query('BEGIN');
      const lastSyncedAt = new Date().toISOString();
      for (const p of persons) {
        const extId = personNodeId(p.externalId);
        const props = validateNodeProps('Person', {
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
        });
        const wasUpdate = await this.nodeExists(client, extId);
        await this.upsertNode(client, {
          externalId: extId,
          type: 'Person',
          scope: null,
          userId: null,
          props,
        });
        personIds.push(extId);
        if (wasUpdate) updated++;
        else inserted++;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
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
    const hasWork =
      (relations.manages?.length ?? 0) +
        (relations.shareholders?.length ?? 0) +
        (relations.successions?.length ?? 0) >
      0;
    if (!hasWork) return result;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const m of relations.manages ?? []) {
        const fromUuid = await this.findUuidByExternalId(
          client,
          personNodeId(m.personExternalId),
        );
        const toUuid = await this.findUuidByExternalId(
          client,
          companyNodeId(m.companyExternalId),
        );
        if (!fromUuid || !toUuid) {
          result.skipped++;
          continue;
        }
        await this.upsertEdge(client, {
          type: 'MANAGES',
          fromUuid,
          toUuid,
          props: {
            ...(m.role ? { role: m.role } : {}),
            ...(m.since ? { since: m.since } : {}),
            ...(m.until ? { until: m.until } : {}),
          },
        });
        result.manages++;
      }
      for (const s of relations.shareholders ?? []) {
        const holderExtId =
          s.holderType === 'Company'
            ? companyNodeId(s.holderExternalId)
            : personNodeId(s.holderExternalId);
        const fromUuid = await this.findUuidByExternalId(client, holderExtId);
        const toUuid = await this.findUuidByExternalId(
          client,
          companyNodeId(s.companyExternalId),
        );
        if (!fromUuid || !toUuid) {
          result.skipped++;
          continue;
        }
        await this.upsertEdge(client, {
          type: 'SHAREHOLDER_OF',
          fromUuid,
          toUuid,
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
        const fromUuid = await this.findUuidByExternalId(
          client,
          companyNodeId(succ.fromCompanyExternalId),
        );
        const toUuid = await this.findUuidByExternalId(
          client,
          companyNodeId(succ.toCompanyExternalId),
        );
        if (!fromUuid || !toUuid) {
          result.skipped++;
          continue;
        }
        await this.upsertEdge(client, {
          type: 'SUCCEEDED_BY',
          fromUuid,
          toUuid,
          props: {
            ...(succ.reason ? { reason: succ.reason } : {}),
          },
        });
        result.successions++;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return result;
  }

  async ingestFinancialSnapshots(
    snapshots: FinancialSnapshotIngest[],
  ): Promise<FinancialSnapshotIngestResult> {
    if (snapshots.length === 0) {
      return { snapshotIds: [], inserted: 0, updated: 0, skipped: 0 };
    }
    const client = await this.pool.connect();
    const snapshotIds: string[] = [];
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    try {
      await client.query('BEGIN');
      const lastSyncedAt = new Date().toISOString();
      for (const s of snapshots) {
        const companyExtId = companyNodeId(s.companyExternalId);
        const companyUuid = await this.findUuidByExternalId(client, companyExtId);
        if (!companyUuid) {
          skipped++;
          continue;
        }
        const extId = financialSnapshotNodeId(s.companyExternalId, s.fiscalYear);
        const props = validateNodeProps('FinancialSnapshot', {
          companyExternalId: s.companyExternalId,
          fiscalYear: s.fiscalYear,
          lastSyncedAt,
          ...(s.date ? { date: s.date } : {}),
          ...(s.consolidated !== undefined
            ? { consolidated: s.consolidated }
            : {}),
          ...(s.sourceName ? { sourceName: s.sourceName } : {}),
          items: s.items,
        });
        const wasUpdate = await this.nodeExists(client, extId);
        const snapshotUuid = await this.upsertNode(client, {
          externalId: extId,
          type: 'FinancialSnapshot',
          scope: null,
          userId: null,
          props,
        });
        snapshotIds.push(extId);
        if (wasUpdate) updated++;
        else inserted++;

        await this.upsertEdge(client, {
          type: 'HAS_FINANCIALS',
          fromUuid: companyUuid,
          toUuid: snapshotUuid,
          props: {
            fiscalYear: s.fiscalYear,
            ...(s.consolidated !== undefined
              ? { consolidated: s.consolidated }
              : {}),
          },
        });
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return { snapshotIds, inserted, updated, skipped };
  }

  async linkCompanyToEntity(
    opts: LinkCompanyToEntityOptions,
  ): Promise<LinkCompanyToEntityResult> {
    const client = await this.pool.connect();
    try {
      const fromUuid = await this.findUuidByExternalId(
        client,
        companyNodeId(opts.companyExternalId),
      );
      const toUuid = await this.findUuidByExternalId(
        client,
        opts.entityExternalId,
      );
      if (!fromUuid || !toUuid) return { linked: false };
      await this.upsertEdge(client, {
        type: 'REFERS_TO',
        fromUuid,
        toUuid,
      });
      return { linked: true };
    } finally {
      client.release();
    }
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

    return {
      session: rowToNode(sessionRow),
      turns: turnRows.rows.map((r) => ({
        turn: rowToNode(r),
        entities: entityByTurn.get(r.id) ?? [],
      })),
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

      let userUuid: string | undefined;
      if (userExtId && trace.userId) {
        const userProps = validateNodeProps('User', {
          userId: trace.userId,
          firstSeenAt: trace.startedAt,
          lastSeenAt: trace.finishedAt,
        });
        userUuid = await this.upsertNode(client, {
          externalId: userExtId,
          type: 'User',
          scope: null,
          userId: trace.userId,
          props: userProps,
          mergeProps: { lastSeenAt: trace.finishedAt },
        });
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
        AND to_tsvector(
          'simple',
          coalesce(properties->>'userMessage', '') || ' ' ||
          coalesce(properties->>'assistantAnswer', '')
        ) @@ plainto_tsquery('simple', $3)
      ORDER BY rank DESC, (properties->>'time') DESC
      LIMIT $6
      `,
      [this.tenantId, userIdFilter, query, excludeScope, excludeTurnIds, limit],
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
        ORDER BY (t.properties->>'time') DESC
        LIMIT $5
        `,
        [this.tenantId, row.id, userIdFilter, excludeScope, perEntityLimit],
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
