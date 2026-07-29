import type { Pool } from 'pg';

import type {
  EditProcessInput,
  EditProcessResult,
  EmbeddingClient,
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

import { captureGateEpoch, type GateEpochReader } from './gateEpoch.js';

/**
 * @omadia/knowledge-graph-neon — NeonProcessMemoryStore (Palaia
 * Phase 7 / OB-76 Slice 2).
 *
 * Tenant-scoped pool-backed implementation of the `processMemory@1` capability.
 * One row per (tenant, id) — see Migration 0009.
 *
 * Hot paths:
 *  - `write` — embedding required; cosine-similarity pre-check against ALL
 *    tenant-processes (scope-agnostic for dedup) BEFORE INSERT.
 *  - `query` — hybrid (BM25 + cosine), reused pattern from OB-72 (single-SQL).
 *  - `edit` — two-step: process_history snapshot + processes UPDATE on the
 *    same connection (best-effort transactional via BEGIN/COMMIT).
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
  /**
   * Live lookup for the embedding client, resolved AT THE MOMENT OF USE.
   *
   * Required for `write` (Dedup-First-Write guarantee). A resolver that
   * returns `undefined` — or no resolver at all — makes the store
   * read-only-ish: `write` and `edit` reject with `embedding-unavailable` and
   * `query` degrades to BM25-only, byte-for-byte the pre-#440 behaviour of an
   * absent client.
   *
   * #440: previously a fixed client captured in the constructor. The
   * model/dimension gate passes `undefined` while it refuses vector writes,
   * and a captured field meant a boot that was gated could never embed again
   * without an operator restart — including after the stale-vector clear that
   * caused the refusal had drained. The resolver removes that.
   */
  resolveEmbeddingClient?: () => EmbeddingClient | undefined;
  /**
   * #440 follow-up — reads the gate's current epoch, for the write fence.
   *
   * `processes.embedding` is the second cosine space the model gate governs.
   * The resolve-once contract above stays (re-resolving mid-transaction turns
   * a clean `embedding-unavailable` rejection into a TypeError), which leaves
   * the window between `await embed()` and the write: a same-width provider
   * switch drains `clear_pending` and re-opens writes inside it, and the
   * previous-provider vector that lands afterwards is unrecoverable — non-NULL
   * under a registry naming the new model, so neither a clear nor the
   * `WHERE embedding IS NULL` sweep ever revisits it. Both writers check this
   * after their embed. Omitted → never fenced (pre-#440 behaviour).
   */
  gateEpoch?: GateEpochReader;
  /** Default 0.9 — tunable via setup-field `process_dedup_threshold`. */
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

/** Body text for embedding + FTS — title + flattened steps joined by \n.
 *  Stable output shape so tests are deterministic. */
/** Exported so the embedding backfill re-embeds processes with exactly the
 *  same body the write path used — a different composition would silently
 *  place re-embedded rows slightly off in the same cosine space. */
export function buildEmbeddingBody(title: string, steps: readonly string[]): string {
  return [title, ...steps].join('\n');
}

export class NeonProcessMemoryStore implements ProcessMemoryService {
  private readonly pool: Pool;
  private readonly tenantId: string;
  /** See `NeonProcessMemoryStoreOptions.resolveEmbeddingClient`. Stored as
   *  the resolver, never as its result. */
  private readonly resolveEmbeddingClient:
    | (() => EmbeddingClient | undefined)
    | undefined;

  /** See `NeonProcessMemoryStoreOptions.gateEpoch`. */
  private readonly gateEpoch: GateEpochReader | undefined;

  private readonly dedupThreshold: number;

  constructor(opts: NeonProcessMemoryStoreOptions) {
    this.pool = opts.pool;
    this.tenantId = opts.tenantId;
    this.resolveEmbeddingClient = opts.resolveEmbeddingClient;
    this.gateEpoch = opts.gateEpoch;
    const threshold = opts.dedupThreshold ?? PROCESS_DEDUP_DEFAULT_THRESHOLD;
    this.dedupThreshold = Math.max(0, Math.min(1, threshold));
  }

  /**
   * The embedding client to use right now, or `undefined` when there is none.
   *
   * Every caller resolves ONCE and keeps the reference for the whole
   * operation. `edit` in particular checks availability long before it embeds
   * (it has a transaction and a history snapshot in between); re-resolving at
   * the embed site would let a gate flip in that window turn a clean
   * `embedding-unavailable` rejection into a TypeError mid-transaction.
   *
   * A resolver that throws reads as "unavailable" — that is the safe
   * direction here, since every caller already has a defined behaviour for it.
   */
  private currentEmbeddingClient(): EmbeddingClient | undefined {
    try {
      return this.resolveEmbeddingClient?.();
    } catch (err) {
      console.error(
        `[processMemory] embedding-client resolver threw (treating as unavailable): ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
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
    const embeddingClient = this.currentEmbeddingClient();
    if (!embeddingClient) {
      return {
        ok: false,
        reason: 'embedding-unavailable',
        message:
          'Embedding-Service nicht verfügbar — Dedup-First-Write kann nicht garantiert werden. Konfiguriere ollama_base_url.',
      };
    }

    const steps = input.steps.map((s) => String(s));
    const body = buildEmbeddingBody(input.title, steps);
    // Captured before the embed, checked after it. See
    // `NeonProcessMemoryStoreOptions.gateEpoch`.
    const fence = captureGateEpoch(this.gateEpoch);
    const embedding = await embeddingClient.embed(body);
    if (!Array.isArray(embedding) || embedding.length === 0) {
      return {
        ok: false,
        reason: 'embedding-unavailable',
        message: 'Embedding-Service lieferte leeren Vektor zurück.',
      };
    }
    // Checked BEFORE the dedup probe, not just before the INSERT: the probe
    // compares this vector against the stored corpus, and a vector from the
    // previous provider would be answering that question in the wrong cosine
    // space. `embedding-unavailable` is the existing, defined rejection for
    // "no usable vector, so Dedup-First-Write cannot be guaranteed" — nothing
    // is written and the caller can simply retry against the new provider.
    if (fence.moved()) {
      return {
        ok: false,
        reason: 'embedding-unavailable',
        message:
          'Der Embedding-Provider wurde während des Schreibvorgangs gewechselt — bitte erneut versuchen.',
      };
    }
    const queryLit = vectorLiteral(embedding);

    // Dedup-First-Write: cosine-similarity > threshold against all
    // tenant-processes (scope-agnostic — a process with a different scope
    // is still a duplicate at the workflow level).
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
    // Resolved here and carried all the way to the embed call below, across
    // the BEGIN + history snapshot. See `currentEmbeddingClient`.
    const embeddingClient = this.currentEmbeddingClient();
    if (needsEmbeddingRebuild && !embeddingClient) {
      return {
        ok: false,
        reason: 'embedding-unavailable',
        message:
          'Embedding-Service nicht verfügbar — title/steps-Änderungen brauchen ein neues Embedding.',
      };
    }
    // Captured alongside the client, for the same reason: both describe the
    // verdict this operation is running under, and both have to survive the
    // BEGIN + history snapshot that sits between here and the embed.
    const fence = captureGateEpoch(this.gateEpoch);

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

      // Snapshot ALWAYS — audit-trail stays even when only visibility
      // changes, so history reflects the full truth of the version at
      // that time.
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
        // Non-null by the `needsEmbeddingRebuild && !embeddingClient` guard
        // above, and the reference is the SAME one that guard checked — no
        // live re-resolve can invalidate it mid-transaction.
        const embedding = await embeddingClient!.embed(
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
        if (fence.moved()) {
          // The gate re-evaluated while we were embedding. ROLLBACK discards
          // the history snapshot along with the version bump, so this is a
          // clean no-op — the row is untouched and the caller gets the same
          // `embedding-unavailable` rejection it already handles. Committing
          // would store a previous-provider vector that no clear and no
          // NULL-only sweep can ever find again.
          await client.query('ROLLBACK');
          return {
            ok: false,
            reason: 'embedding-unavailable',
            message:
              'Der Embedding-Provider wurde während der Änderung gewechselt — bitte erneut versuchen.',
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

    // Embedding optional — if the sidecar is gone, query falls back to the
    // pure BM25 path (degraded but viable). On the write path embedding is
    // mandatory; query is allowed to be softer.
    let queryEmbedding: number[] | null = null;
    const embeddingClient = this.currentEmbeddingClient();
    if (embeddingClient) {
      try {
        const v = await embeddingClient.embed(trimmedQuery);
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
      // history rows: createdAt not persisted; updatedAt = superseded_at.
      createdAt: toIso(row.superseded_at),
      updatedAt: toIso(row.superseded_at),
    }));
  }
}
