import type { Pool } from 'pg';

import type { EmbeddingClient } from '@omadia/embeddings';
import type {
  EditProcessInput,
  EditProcessResult,
  ProcessMemoryService,
  ProcessQueryHit,
  ProcessRecord,
  QueryProcessesInput,
  WriteProcessInput,
  WriteProcessResult,
} from '@omadia/plugin-api';
import {
  PROCESS_DEDUP_DEFAULT_THRESHOLD,
  PROCESS_TITLE_REGEX,
  buildProcessId,
} from '@omadia/plugin-api';

/**
 * @omadia/knowledge-graph-neon — NeonProcessMemoryStore (Palaia
 * Phase 7 / OB-76 Slice 2).
 *
 * Tenant-scoped Pool-backed Implementation der `processMemory@1`-Capability.
 * Eine Row pro (tenant, id) — siehe Migration 0009.
 *
 * Hot-Paths:
 *  - `write` — embedding-pflicht; cosine-similarity-Pre-Check gegen ALLE
 *    Tenant-Processes (scope-übergreifend für Dedup) BEFORE INSERT.
 *  - `query` — Hybrid (BM25 + cosine), reused-Pattern aus OB-72 (single-SQL).
 *  - `edit` — Two-Step: process_history snapshot + processes UPDATE in
 *    derselben Connection (best-effort transactional via BEGIN/COMMIT).
 */

interface ProcessRow {
  id: string;
  scope: string;
  title: string;
  steps: unknown;
  visibility: string;
  version: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ProcessHistoryRow {
  id: string;
  scope?: string;
  title: string;
  steps: unknown;
  visibility: string;
  version: number | string;
  superseded_at: Date | string;
}

export interface NeonProcessMemoryStoreOptions {
  pool: Pool;
  tenantId: string;
  /** Required for `write` (Dedup-First-Write garantie). Optional macht den Store
   *  read-only-ish: write+edit lehnen mit `embedding-unavailable` ab. */
  embeddingClient?: EmbeddingClient;
  /** Default 0.9 — tunable per Setup-Field `process_dedup_threshold`. */
  dedupThreshold?: number;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function asStringArray(steps: unknown): readonly string[] {
  if (!Array.isArray(steps)) return [];
  return steps.filter((x): x is string => typeof x === 'string');
}

function rowToRecord(row: ProcessRow): ProcessRecord {
  return {
    id: row.id,
    scope: row.scope,
    title: row.title,
    steps: asStringArray(row.steps),
    visibility: row.visibility,
    version: Number(row.version),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function vectorLiteral(v: readonly number[]): string {
  const parts = v.map((x) => (Number.isFinite(x) ? x.toFixed(6) : '0'));
  return `[${parts.join(',')}]`;
}

/** Body-Text für Embedding + FTS — title + flatten steps mit \n. Stable
 *  Output-Shape damit Tests deterministisch sind. */
function buildEmbeddingBody(title: string, steps: readonly string[]): string {
  return [title, ...steps].join('\n');
}

export class NeonProcessMemoryStore implements ProcessMemoryService {
  private readonly pool: Pool;
  private readonly tenantId: string;
  private readonly embeddingClient: EmbeddingClient | undefined;
  private readonly dedupThreshold: number;

  constructor(opts: NeonProcessMemoryStoreOptions) {
    this.pool = opts.pool;
    this.tenantId = opts.tenantId;
    this.embeddingClient = opts.embeddingClient;
    const threshold = opts.dedupThreshold ?? PROCESS_DEDUP_DEFAULT_THRESHOLD;
    this.dedupThreshold = Math.max(0, Math.min(1, threshold));
  }

  async write(input: WriteProcessInput): Promise<WriteProcessResult> {
    if (!PROCESS_TITLE_REGEX.test(input.title)) {
      return {
        ok: false,
        reason: 'invalid-title',
        message:
          'Process-Title muss dem Schema "[Domain]: [What it does]" folgen (z.B. "Backend: Deploy to staging").',
      };
    }
    if (!this.embeddingClient) {
      return {
        ok: false,
        reason: 'embedding-unavailable',
        message:
          'Embedding-Service nicht verfügbar — Dedup-First-Write kann nicht garantiert werden. Konfiguriere ollama_base_url.',
      };
    }

    const steps = input.steps.map((s) => String(s));
    const body = buildEmbeddingBody(input.title, steps);
    const embedding = await this.embeddingClient.embed(body);
    if (!Array.isArray(embedding) || embedding.length === 0) {
      return {
        ok: false,
        reason: 'embedding-unavailable',
        message: 'Embedding-Service lieferte leeren Vektor zurück.',
      };
    }
    const queryLit = vectorLiteral(embedding);

    // Dedup-First-Write: cosine-similarity > threshold gegen alle Tenant-
    // Processes (scope-übergreifend — ein Process mit anderem Scope ist
    // immer noch ein Duplicate auf der Workflow-Ebene).
    const dedup = await this.pool.query<{
      id: string;
      title: string;
      similarity: number | string;
    }>(
      `
      SELECT id, title, 1 - (embedding <=> $1::vector) AS similarity
        FROM processes
       WHERE tenant_id = $2
         AND embedding IS NOT NULL
         AND (1 - (embedding <=> $1::vector)) >= $3
       ORDER BY similarity DESC
       LIMIT 1
      `,
      [queryLit, this.tenantId, this.dedupThreshold],
    );
    const conflict = dedup.rows[0];
    if (conflict) {
      return {
        ok: false,
        reason: 'duplicate',
        conflictingId: conflict.id,
        conflictingTitle: conflict.title,
        similarity: Number(conflict.similarity),
      };
    }

    const id = buildProcessId(input.scope, input.title);
    const visibility = input.visibility ?? 'team';
    const inserted = await this.pool.query<ProcessRow>(
      `
      INSERT INTO processes
        (id, tenant_id, scope, title, steps, visibility, embedding, version, created_at, updated_at)
      VALUES
        ($1, $2, $3, $4, $5::jsonb, $6, $7::vector, 1, NOW(), NOW())
      RETURNING id, scope, title, steps, visibility, version, created_at, updated_at
      `,
      [
        id,
        this.tenantId,
        input.scope,
        input.title,
        JSON.stringify(steps),
        visibility,
        queryLit,
      ],
    );
    const row = inserted.rows[0];
    if (!row) {
      // Defensive — INSERT ... RETURNING returns the row unless the row was
      // filtered by RLS, which we don't use here. Keep the branch for the
      // type-narrowing.
      throw new Error('NeonProcessMemoryStore.write: INSERT returned no row');
    }
    return { ok: true, record: rowToRecord(row) };
  }

  async edit(input: EditProcessInput): Promise<EditProcessResult> {
    const titleProvided =
      typeof input.title === 'string' && input.title.length > 0;
    if (titleProvided && !PROCESS_TITLE_REGEX.test(input.title!)) {
      return {
        ok: false,
        reason: 'invalid-title',
        message:
          'Process-Title muss dem Schema "[Domain]: [What it does]" folgen.',
      };
    }

    const stepsProvided = Array.isArray(input.steps);
    const needsEmbeddingRebuild = titleProvided || stepsProvided;
    if (needsEmbeddingRebuild && !this.embeddingClient) {
      return {
        ok: false,
        reason: 'embedding-unavailable',
        message:
          'Embedding-Service nicht verfügbar — title/steps-Änderungen brauchen ein neues Embedding.',
      };
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const existingResult = await client.query<ProcessRow>(
        `
        SELECT id, scope, title, steps, visibility, version, created_at, updated_at
          FROM processes
         WHERE tenant_id = $1 AND id = $2
         FOR UPDATE
        `,
        [this.tenantId, input.id],
      );
      const existing = existingResult.rows[0];
      if (!existing) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'not-found' };
      }

      // Snapshot ALWAYS — Audit-Trail bleibt auch wenn nur visibility
      // geändert wird, damit history die volle Wahrheit zur damaligen
      // Version reflektiert.
      await client.query(
        `
        INSERT INTO process_history
          (id, tenant_id, version, title, steps, visibility, superseded_at)
        VALUES
          ($1, $2, $3, $4, $5::jsonb, $6, NOW())
        `,
        [
          existing.id,
          this.tenantId,
          Number(existing.version),
          existing.title,
          JSON.stringify(asStringArray(existing.steps)),
          existing.visibility,
        ],
      );

      const newTitle = titleProvided ? input.title! : existing.title;
      const newSteps = stepsProvided
        ? input.steps!.map((s) => String(s))
        : asStringArray(existing.steps);
      const newVisibility = input.visibility ?? existing.visibility;

      let embeddingParam: string | null = null;
      if (needsEmbeddingRebuild) {
        const embedding = await this.embeddingClient!.embed(
          buildEmbeddingBody(newTitle, newSteps),
        );
        if (!Array.isArray(embedding) || embedding.length === 0) {
          await client.query('ROLLBACK');
          return {
            ok: false,
            reason: 'embedding-unavailable',
            message: 'Embedding-Service lieferte leeren Vektor zurück.',
          };
        }
        embeddingParam = vectorLiteral(embedding);
      }

      const updated = await client.query<ProcessRow>(
        embeddingParam
          ? `
            UPDATE processes
               SET title = $3,
                   steps = $4::jsonb,
                   visibility = $5,
                   embedding = $6::vector,
                   version = version + 1,
                   updated_at = NOW()
             WHERE tenant_id = $1 AND id = $2
             RETURNING id, scope, title, steps, visibility, version, created_at, updated_at
            `
          : `
            UPDATE processes
               SET title = $3,
                   steps = $4::jsonb,
                   visibility = $5,
                   version = version + 1,
                   updated_at = NOW()
             WHERE tenant_id = $1 AND id = $2
             RETURNING id, scope, title, steps, visibility, version, created_at, updated_at
            `,
        embeddingParam
          ? [
              this.tenantId,
              input.id,
              newTitle,
              JSON.stringify(newSteps),
              newVisibility,
              embeddingParam,
            ]
          : [
              this.tenantId,
              input.id,
              newTitle,
              JSON.stringify(newSteps),
              newVisibility,
            ],
      );

      await client.query('COMMIT');
      const row = updated.rows[0];
      if (!row) {
        throw new Error('NeonProcessMemoryStore.edit: UPDATE returned no row');
      }
      return { ok: true, record: rowToRecord(row) };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // best-effort
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async query(input: QueryProcessesInput): Promise<readonly ProcessQueryHit[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 10, 50));
    const trimmedQuery = input.query.trim();
    if (trimmedQuery.length === 0) return [];

    // Embedding optional — wenn der Sidecar weg ist, fällt query auf reine
    // BM25-Pfad zurück (degraded, aber lebensfähig). Im write-Pfad ist
    // Embedding pflicht; query darf weicher sein.
    let queryEmbedding: number[] | null = null;
    if (this.embeddingClient) {
      try {
        const v = await this.embeddingClient.embed(trimmedQuery);
        queryEmbedding = Array.isArray(v) && v.length > 0 ? v : null;
      } catch {
        // sidecar transient — degrade silently to BM25-only.
        queryEmbedding = null;
      }
    }
    const queryLit = queryEmbedding ? vectorLiteral(queryEmbedding) : null;
    const scopeFilter = input.scope ?? null;

    // Param map:
    //  $1 query embedding (nullable vector literal)
    //  $2 tenant_id
    //  $3 scope filter (nullable)
    //  $4 ftsQuery
    //  $5 limit
    const sql = `
      WITH scored AS (
        SELECT
          id,
          scope,
          title,
          steps,
          visibility,
          version,
          created_at,
          updated_at,
          CASE
            WHEN $1::text IS NULL OR embedding IS NULL THEN 0
            WHEN (1 - (embedding <=> $1::vector)) <> (1 - (embedding <=> $1::vector)) THEN 0
            ELSE 1 - (embedding <=> $1::vector)
          END AS cosine_sim,
          COALESCE(
            ts_rank_cd(
              to_tsvector('simple',
                coalesce(title, '') || ' ' || coalesce(steps::text, '')),
              plainto_tsquery('simple', $4)
            ),
            0
          ) AS bm25_raw
          FROM processes
         WHERE tenant_id = $2
           AND ($3::text IS NULL OR scope = $3)
           AND (
             ($1::text IS NOT NULL AND embedding IS NOT NULL)
             OR to_tsvector('simple',
                  coalesce(title, '') || ' ' || coalesce(steps::text, ''))
                @@ plainto_tsquery('simple', $4)
           )
      ),
      normalised AS (
        SELECT
          id, scope, title, steps, visibility, version, created_at, updated_at,
          cosine_sim,
          CASE WHEN bm25_raw <= 0 THEN 0 ELSE bm25_raw / (bm25_raw + 1) END AS bm25_norm
          FROM scored
      )
      SELECT
        id, scope, title, steps, visibility, version, created_at, updated_at,
        cosine_sim, bm25_norm,
        CASE
          WHEN $1::text IS NULL THEN bm25_norm
          ELSE 0.4 * bm25_norm + 0.6 * cosine_sim
        END AS hybrid_score
        FROM normalised
       WHERE (
         CASE
           WHEN $1::text IS NULL THEN bm25_norm
           ELSE 0.4 * bm25_norm + 0.6 * cosine_sim
         END
       ) > 0
       ORDER BY hybrid_score DESC
       LIMIT $5
    `;

    const result = await this.pool.query<
      ProcessRow & { hybrid_score: number | string }
    >(sql, [queryLit, this.tenantId, scopeFilter, trimmedQuery, limit]);
    return result.rows.map((row) => ({
      record: rowToRecord(row),
      score: Math.max(0, Math.min(1, Number(row.hybrid_score) || 0)),
    }));
  }

  async get(id: string): Promise<ProcessRecord | null> {
    const result = await this.pool.query<ProcessRow>(
      `
      SELECT id, scope, title, steps, visibility, version, created_at, updated_at
        FROM processes
       WHERE tenant_id = $1 AND id = $2
      `,
      [this.tenantId, id],
    );
    const row = result.rows[0];
    return row ? rowToRecord(row) : null;
  }

  async history(id: string): Promise<readonly ProcessRecord[]> {
    const result = await this.pool.query<ProcessHistoryRow>(
      `
      SELECT ph.id, p.scope, ph.title, ph.steps, ph.visibility, ph.version, ph.superseded_at
        FROM process_history ph
        LEFT JOIN processes p
          ON p.tenant_id = ph.tenant_id AND p.id = ph.id
       WHERE ph.tenant_id = $1 AND ph.id = $2
       ORDER BY ph.version DESC
      `,
      [this.tenantId, id],
    );
    return result.rows.map((row) => ({
      id: row.id,
      scope: row.scope ?? '',
      title: row.title,
      steps: asStringArray(row.steps),
      visibility: row.visibility,
      version: Number(row.version),
      // history rows: createdAt nicht persistiert; updatedAt = supersedet_at.
      createdAt: toIso(row.superseded_at),
      updatedAt: toIso(row.superseded_at),
    }));
  }
}
