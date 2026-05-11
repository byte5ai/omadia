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
 *     threshold are skipped (the inner KG is NOT called and the result
 *     mirrors a no-op ingest so callers don't crash).
 *
 * Drop-result shape (HANDOFF Eckpfeiler #6 — `embedAndStoreTurn` stays the
 * single embedding write-path → for a dropped turn we simply return a
 * synthetic `TurnIngestResult` with the IDs the inner backend WOULD have
 * computed; no embedding work runs).
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
  GraphStats,
  SearchTurnsOptions,
  TurnSearchHit,
  EntityCapturedTurnsOptions,
  EntityCapturedTurnsHit,
  SearchTurnsByEmbeddingOptions,
  FindEntitiesOptions,
  CompanyIngest,
  CompanyIngestResult,
  PersonIngest,
  PersonIngestResult,
  CompanyRelationsIngest,
  CompanyRelationsResult,
  LinkCompanyToOdooOptions,
  LinkCompanyToOdooResult,
  FinancialSnapshotIngest,
  FinancialSnapshotIngestResult,
} from '@omadia/plugin-api';
import {
  sessionNodeId,
  turnNodeId,
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

  constructor(opts: CaptureFilteringKnowledgeGraphOptions) {
    this.inner = opts.inner;
    this.filter = opts.filter;
    this.log = opts.log ?? ((msg): void => console.error(msg));
  }

  async ingestTurn(turn: TurnIngest): Promise<TurnIngestResult> {
    const decision = await this.filter.classify({
      userMessage: turn.userMessage,
      assistantAnswer: turn.assistantAnswer,
    });

    if (!decision.persist) {
      // Skip the inner write entirely. Surface a synthetic result so the
      // orchestrator's success path doesn't have to special-case this.
      this.log(
        `[capture-filter] turn skipped (significance=${decision.significance?.toFixed(2) ?? 'null'}) reasons=[${decision.reasons.join('|')}]`,
      );
      return {
        sessionId: sessionNodeId(turn.scope),
        turnId: turnNodeId(turn.scope, turn.time),
        entityNodeIds: [],
      };
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
  // other surface (entities, facts, search, runs, companies, …) forwards
  // verbatim to the inner KG. We could codegen these from the interface,
  // but explicit forwards keep the wrapper greppable and the type system
  // catches additions.
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

  ingestCompanies(companies: CompanyIngest[]): Promise<CompanyIngestResult> {
    return this.inner.ingestCompanies(companies);
  }

  ingestPersons(persons: PersonIngest[]): Promise<PersonIngestResult> {
    return this.inner.ingestPersons(persons);
  }

  ingestCompanyRelations(
    relations: CompanyRelationsIngest,
  ): Promise<CompanyRelationsResult> {
    return this.inner.ingestCompanyRelations(relations);
  }

  linkCompanyToOdoo(
    opts: LinkCompanyToOdooOptions,
  ): Promise<LinkCompanyToOdooResult> {
    return this.inner.linkCompanyToOdoo(opts);
  }

  ingestFinancialSnapshots(
    snapshots: FinancialSnapshotIngest[],
  ): Promise<FinancialSnapshotIngestResult> {
    return this.inner.ingestFinancialSnapshots(snapshots);
  }
}
