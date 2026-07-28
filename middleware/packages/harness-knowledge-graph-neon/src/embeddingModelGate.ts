import type { EmbeddingProviderMetadata } from '@omadia/plugin-api';
import type { Pool, PoolClient } from 'pg';

/**
 * #440 — the dimension/model safety gate.
 *
 * A `vector(n)` column is a single cosine-similarity space. Two embedding
 * models writing into it does not fail loudly; recall just degrades, for as
 * long as nobody notices. Now that the provider is pluggable, this gate runs
 * on knowledge-graph activation and answers one question before anything is
 * written: does the active provider belong in the vector space this database
 * already has?
 *
 * It checks two independent things, in this order:
 *
 *  1. **Declared column width** — read from the catalog (`pg_attribute` /
 *     `format_type`), NOT sampled from existing rows. A fresh install has no
 *     rows at all, and that is precisely the case where a wrong provider is
 *     most likely to be installed. Every `vector` column on a tenant-scoped
 *     table is discovered dynamically, so a future migration that adds a
 *     third vector column is covered without touching this file.
 *  2. **Recorded model identity** — `graph_embedding_model` (migration 0030),
 *     one row per tenant, holding the model the stored vectors came from.
 *
 * Resolution paths:
 *   - column width ≠ provider dimensions → BLOCK. No write can succeed
 *     anyway (Postgres rejects the literal), and the previous behaviour was
 *     to swallow that error per row and run FTS-only while reporting
 *     healthy. Recovering needs a column migration: migration 0005 walked
 *     exactly that path (1536 → 768) by dropping the index, dropping the
 *     column, re-adding it at the new size and re-creating the index;
 *   - first run / empty corpus with a matching column → record the active
 *     model, carry on;
 *   - existing corpus, no record yet (pre-#440 install) → adopt the active
 *     model (the column width already proved compatibility);
 *   - same dimensions, different model → clear every governed vector column
 *     in bounded batches and let the embedding backfill re-embed at its own
 *     pace. The clear is resumable: `clear_pending` on the registry row
 *     survives the boot, and `embeddingBackfill` finishes the work;
 *   - recorded dimensions ≠ provider dimensions → BLOCK, same reasoning as
 *     the column check.
 *
 * SCOPE OF THE GATE — read this before claiming "it degrades to FTS-only".
 * The gate governs the knowledge-graph plugin's own embedding client, i.e.
 * every vector WRITE into `graph_nodes` and `processes` plus the backfill
 * sweep. It does NOT withdraw the `embeddingClient@1` capability from the
 * service registry: `contextRetriever`, `inconsistencyDetector`,
 * `mergeCandidateDetector` and `topicDetector` resolve that capability
 * themselves and keep calling it on a blocked boot. Their vector queries then
 * fail inside the guarded try/catch each of them already has, so they yield
 * no recall — the observable behaviour is FTS-only, at the cost of one wasted
 * embed call and one error log per attempt. Withdrawing the capability
 * centrally would need a kernel-side revoke hook that does not exist today.
 */

export interface EmbeddingModelGateOptions {
  pool: Pool;
  tenantId: string;
  /** Metadata of the active provider, or `undefined` when the resolved
   *  `embeddingClient` predates #440 and carries none. */
  provider: EmbeddingProviderMetadata | undefined;
  /** Rows cleared per statement on a model switch. Default 500. */
  clearBatchSize?: number;
  /** Hard cap on rows cleared during THIS activation, per column. The rest
   *  is left to the backfill sweep so activate() cannot stall on a large
   *  corpus. Default 5000. */
  clearMaxRowsPerActivation?: number;
  /** `statement_timeout` applied to each clear batch. Default 15000. */
  clearStatementTimeoutMs?: number;
  log?: (msg: string) => void;
}

/** A `vector` column the gate governs, as discovered in the catalog. */
export interface GovernedVectorColumn {
  table: string;
  column: string;
  /** Declared width, or `undefined` for an untyped `vector` column. */
  declaredDimensions: number | undefined;
}

/** Per-column tally of a stale-vector clear pass. */
export interface StaleVectorClearResult {
  clearedByTable: Record<string, number>;
  totalCleared: number;
  /** `true` when the cap was hit and rows are still waiting. */
  pending: boolean;
}

export type EmbeddingModelGateOutcome =
  /** No provider metadata — nothing to compare, writes stay allowed. */
  | { status: 'unknown-provider' }
  /** Active model equals the recorded one. */
  | { status: 'match'; modelId: string; dimensions: number }
  /** First record for this tenant (empty corpus, or an adopted pre-#440 one). */
  | { status: 'recorded'; modelId: string; dimensions: number }
  /** Same vector size, different model — stored vectors cleared for re-embed. */
  | {
      status: 're-embedding';
      modelId: string;
      previousModelId: string;
      clearedVectors: number;
      /** Cap hit during activation; the backfill sweep finishes the clear. */
      clearPending: boolean;
    }
  /** Incompatible — the caller must not let this provider write vectors. */
  | {
      status: 'blocked';
      reason: 'dimension-mismatch';
      modelId: string;
      dimensions: number;
      storedModelId: string;
      storedDimensions: number;
    }
  | {
      status: 'blocked';
      reason: 'column-width-mismatch';
      modelId: string;
      dimensions: number;
      mismatches: GovernedVectorColumn[];
    };

/** Pre-#440 corpora have vectors but no recorded model identity. */
const UNKNOWN_STORED_MODEL_ID = '(unrecorded, pre-#440 corpus)';

const DEFAULT_CLEAR_BATCH_SIZE = 500;
const DEFAULT_CLEAR_MAX_ROWS = 5_000;
const DEFAULT_CLEAR_STATEMENT_TIMEOUT_MS = 15_000;

/**
 * Columns reset on a same-dimension model switch, and the extra bookkeeping
 * each one needs. Discovery (below) is the authority on which vector columns
 * EXIST; this list says which ones we know how to clear. A column that shows
 * up in discovery but not here is reported loudly rather than silently left
 * with foreign-model vectors.
 */
const CLEARABLE_COLUMNS: ReadonlyArray<{
  table: string;
  column: string;
  /** Extra SET fragments, e.g. resetting the backfill attempt counter. */
  extraSet: string;
}> = [
  {
    table: 'graph_nodes',
    column: 'embedding',
    // Reset the attempt counter too, otherwise nodes that had exhausted
    // their retries under the old provider would never be picked up again.
    extraSet:
      ', embedding_attempts = 0, embedding_last_error = NULL, embedding_last_error_at = NULL',
  },
  // `processes.embedding` (migration 0009) is a second cosine space, used for
  // the write-path dedup pre-check AND for hybrid recall. It has to be
  // cleared on the same switch, otherwise process recall silently scores
  // old-model vectors against new-model queries forever.
  { table: 'processes', column: 'embedding', extraSet: '' },
];

export function allowsVectorWrites(outcome: EmbeddingModelGateOutcome): boolean {
  return outcome.status !== 'blocked';
}

interface StoredModelRow {
  model_id: string;
  dimensions: number;
}

export async function evaluateEmbeddingModelGate(
  opts: EmbeddingModelGateOptions,
): Promise<EmbeddingModelGateOutcome> {
  const log = opts.log ?? ((msg: string) => { console.error(msg); });
  const { pool, tenantId, provider } = opts;

  if (!provider) {
    log(
      '[graph-embedding-gate] active embedding client reports no model metadata — cannot verify the vector space; writes allowed unchanged',
    );
    return { status: 'unknown-provider' };
  }

  // (1) Declared column width — the check that works on an empty corpus.
  const columns = await discoverGovernedVectorColumns(pool);
  const mismatches = columns.filter(
    (c) =>
      c.declaredDimensions !== undefined &&
      c.declaredDimensions !== provider.dimensions,
  );
  if (mismatches.length > 0) {
    log(
      `[graph-embedding-gate] BLOCKED: active provider '${provider.modelId}' emits ${String(provider.dimensions)}-dimensional vectors, but ${mismatches
        .map(
          (c) =>
            `${c.table}.${c.column} is vector(${String(c.declaredDimensions)})`,
        )
        .join(
          ', ',
        )} — vector writes disabled. Every write would be rejected by Postgres and swallowed into the retry counter, leaving the deployment FTS-only while reporting healthy. Use a ${String(mismatches[0]?.declaredDimensions ?? 768)}-dimensional model, or migrate the column(s) the way 0005_turn_embeddings_768.sql did (drop index → drop column → re-add at the new size → re-create index).`,
    );
    return {
      status: 'blocked',
      reason: 'column-width-mismatch',
      modelId: provider.modelId,
      dimensions: provider.dimensions,
      mismatches,
    };
  }
  const ungoverned = columns.filter(
    (c) => !CLEARABLE_COLUMNS.some((k) => k.table === c.table && k.column === c.column),
  );
  if (ungoverned.length > 0) {
    log(
      `[graph-embedding-gate] WARNING: ${ungoverned
        .map((c) => `${c.table}.${c.column}`)
        .join(', ')} is a vector column this gate cannot clear — a model switch will leave foreign-model vectors there. Add it to CLEARABLE_COLUMNS in embeddingModelGate.ts.`,
    );
  }

  // (2) Recorded model identity.
  const stored = await pool.query<StoredModelRow>(
    'SELECT model_id, dimensions FROM graph_embedding_model WHERE tenant_id = $1',
    [tenantId],
  );
  const row = stored.rows[0];

  if (!row) {
    const hasVectors = await hasStoredVectors(pool, tenantId);
    await pool.query(
      `INSERT INTO graph_embedding_model (tenant_id, model_id, dimensions)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId, provider.modelId, provider.dimensions],
    );
    log(
      hasVectors
        ? `[graph-embedding-gate] adopted '${provider.modelId}' (${String(provider.dimensions)}d) for the existing corpus — column width matches, no re-embed needed (previously ${UNKNOWN_STORED_MODEL_ID})`
        : `[graph-embedding-gate] recorded '${provider.modelId}' (${String(provider.dimensions)}d) as this tenant's embedding model (empty corpus)`,
    );
    return {
      status: 'recorded',
      modelId: provider.modelId,
      dimensions: provider.dimensions,
    };
  }

  if (row.model_id === provider.modelId && row.dimensions === provider.dimensions) {
    return {
      status: 'match',
      modelId: provider.modelId,
      dimensions: provider.dimensions,
    };
  }

  if (row.dimensions !== provider.dimensions) {
    log(
      `[graph-embedding-gate] BLOCKED: corpus was embedded with '${row.model_id}' (${String(row.dimensions)}d), active provider is '${provider.modelId}' (${String(provider.dimensions)}d) — vector writes disabled to keep the similarity space intact. Migrate the vector columns to the new size (see migration 0005) or switch back.`,
    );
    return {
      status: 'blocked',
      reason: 'dimension-mismatch',
      modelId: provider.modelId,
      dimensions: provider.dimensions,
      storedModelId: row.model_id,
      storedDimensions: row.dimensions,
    };
  }

  // Same vector size, different model: recoverable without a schema change.
  // Drop the vectors, record the new model, let the backfill sweep re-embed.
  const cleared = await switchModelAndClearVectors(pool, tenantId, provider, {
    batchSize: opts.clearBatchSize ?? DEFAULT_CLEAR_BATCH_SIZE,
    maxRows: opts.clearMaxRowsPerActivation ?? DEFAULT_CLEAR_MAX_ROWS,
    statementTimeoutMs:
      opts.clearStatementTimeoutMs ?? DEFAULT_CLEAR_STATEMENT_TIMEOUT_MS,
  });
  log(
    `[graph-embedding-gate] embedding model switched '${row.model_id}' → '${provider.modelId}' (both ${String(provider.dimensions)}d); cleared ${String(cleared.totalCleared)} stored vector(s)${
      cleared.pending
        ? ' — activation cap reached, the embedding backfill sweep clears the rest before it re-embeds anything'
        : ''
    }`,
  );
  return {
    status: 're-embedding',
    modelId: provider.modelId,
    previousModelId: row.model_id,
    clearedVectors: cleared.totalCleared,
    clearPending: cleared.pending,
  };
}

/**
 * Every `vector` column on a tenant-scoped table in the search path.
 *
 * Discovery instead of a hard-coded pair: a future migration adding a third
 * vector column is then automatically covered by the width check, and shows
 * up in the "cannot clear this" warning if nobody wired it into
 * `CLEARABLE_COLUMNS`. The `tenant_id` requirement keeps unrelated vector
 * columns that happen to share the database out of the gate's business.
 */
export async function discoverGovernedVectorColumns(
  pool: Pool,
): Promise<GovernedVectorColumn[]> {
  const result = await pool.query<{
    table_name: string;
    column_name: string;
    declared_type: string;
    typmod: number | string;
  }>(
    `SELECT c.relname                              AS table_name,
            a.attname                              AS column_name,
            format_type(a.atttypid, a.atttypmod)   AS declared_type,
            a.atttypmod                            AS typmod
       FROM pg_attribute a
       JOIN pg_class     c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_type      t ON t.oid = a.atttypid
      WHERE t.typname = 'vector'
        AND c.relkind = 'r'
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND n.nspname = ANY (current_schemas(false))
        AND EXISTS (
              SELECT 1
                FROM pg_attribute ta
               WHERE ta.attrelid = c.oid
                 AND ta.attname = 'tenant_id'
                 AND ta.attnum > 0
                 AND NOT ta.attisdropped
            )
      ORDER BY c.relname, a.attname`,
  );
  return result.rows.map((r) => ({
    table: r.table_name,
    column: r.column_name,
    declaredDimensions: parseDeclaredDimensions(r.declared_type, r.typmod),
  }));
}

/** `vector(768)` → 768. Falls back to the raw typmod, `undefined` if untyped. */
function parseDeclaredDimensions(
  declaredType: string,
  typmod: number | string,
): number | undefined {
  const match = /\((\d+)\)\s*$/.exec(declaredType ?? '');
  const fromType = match?.[1] !== undefined ? Number(match[1]) : Number.NaN;
  if (Number.isInteger(fromType) && fromType > 0) return fromType;
  const raw = typeof typmod === 'number' ? typmod : Number(typmod);
  return Number.isInteger(raw) && raw > 0 ? raw : undefined;
}

/** Cheap existence probe — only used to phrase the log line. */
async function hasStoredVectors(pool: Pool, tenantId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1
       FROM graph_nodes
      WHERE tenant_id = $1 AND embedding IS NOT NULL
      LIMIT 1`,
    [tenantId],
  );
  return (result.rowCount ?? result.rows.length) > 0;
}

interface ClearOptions {
  batchSize: number;
  maxRows: number;
  statementTimeoutMs: number;
}

async function switchModelAndClearVectors(
  pool: Pool,
  tenantId: string,
  provider: EmbeddingProviderMetadata,
  opts: ClearOptions,
): Promise<StaleVectorClearResult> {
  // Flip the registry FIRST, in its own small transaction: `clear_pending`
  // is what makes the clear resumable, so it must be durable before any row
  // is touched. A crash halfway through then resumes on the next boot / on
  // the next backfill tick instead of leaving a half-cleared corpus that
  // nothing knows about.
  await pool.query(
    `UPDATE graph_embedding_model
        SET model_id = $2, dimensions = $3, clear_pending = TRUE, updated_at = now()
      WHERE tenant_id = $1`,
    [tenantId, provider.modelId, provider.dimensions],
  );
  return clearStaleVectors(pool, tenantId, opts);
}

/** Is a stale-vector clear still owed for this tenant? */
export async function isStaleVectorClearPending(
  pool: Pool,
  tenantId: string,
): Promise<boolean> {
  const result = await pool.query<{ clear_pending: boolean }>(
    'SELECT clear_pending FROM graph_embedding_model WHERE tenant_id = $1',
    [tenantId],
  );
  return result.rows[0]?.clear_pending === true;
}

/**
 * Clear foreign-model vectors in bounded batches.
 *
 * Called twice: once from the gate during activation (capped, so activate()
 * cannot stall on a large corpus and cannot hold one transaction open across
 * a full HNSW-index rewrite), and again from the backfill sweep until
 * `clear_pending` flips back to false. The sweep does NOT re-embed while a
 * clear is pending, which is what keeps "non-NULL means old model" true for
 * the duration.
 */
export async function clearStaleVectors(
  pool: Pool,
  tenantId: string,
  opts: ClearOptions,
): Promise<StaleVectorClearResult> {
  const clearedByTable: Record<string, number> = {};
  let totalCleared = 0;
  let pending = false;

  const client: PoolClient = await pool.connect();
  try {
    for (const target of CLEARABLE_COLUMNS) {
      let clearedHere = 0;
      for (;;) {
        if (clearedHere >= opts.maxRows) {
          pending = true;
          break;
        }
        const limit = Math.min(opts.batchSize, opts.maxRows - clearedHere);
        const affected = await clearOneBatch(client, target, tenantId, limit, opts);
        clearedHere += affected;
        if (affected < limit) break;
      }
      clearedByTable[target.table] = clearedHere;
      totalCleared += clearedHere;
    }
    if (!pending) {
      await client.query(
        `UPDATE graph_embedding_model
            SET clear_pending = FALSE, updated_at = now()
          WHERE tenant_id = $1`,
        [tenantId],
      );
    }
  } finally {
    client.release();
  }

  return { clearedByTable, totalCleared, pending };
}

/**
 * One bounded UPDATE, in its own transaction with its own statement timeout.
 * `ctid IN (SELECT … LIMIT n)` is the standard bounded-update idiom; the
 * table/column names come from the module-local constant above, never from
 * user input.
 */
async function clearOneBatch(
  client: PoolClient,
  target: { table: string; column: string; extraSet: string },
  tenantId: string,
  limit: number,
  opts: ClearOptions,
): Promise<number> {
  await client.query('BEGIN');
  try {
    await client.query(
      `SET LOCAL statement_timeout = ${String(Math.max(1, Math.floor(opts.statementTimeoutMs)))}`,
    );
    const result = await client.query(
      `UPDATE ${target.table}
          SET ${target.column} = NULL${target.extraSet}
        WHERE ctid IN (
                SELECT ctid
                  FROM ${target.table}
                 WHERE tenant_id = $1 AND ${target.column} IS NOT NULL
                 LIMIT ${String(Math.max(1, Math.floor(limit)))}
              )`,
      [tenantId],
    );
    await client.query('COMMIT');
    return result.rowCount ?? 0;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}
