import type { EmbeddingProviderMetadata } from '@omadia/plugin-api';
import type { Pool } from 'pg';

/**
 * #440 — the dimension/model safety gate.
 *
 * `graph_nodes.embedding` is a single cosine-similarity space. Two embedding
 * models writing into it does not fail loudly; recall just degrades, for as
 * long as nobody notices. Now that the provider is pluggable, this gate runs
 * on knowledge-graph activation, compares the active provider against the
 * model recorded in `graph_embedding_model` (migration 0030) and, on a
 * mismatch it cannot resolve, refuses vector writes for the whole boot.
 *
 * Resolution paths:
 *   - first run / empty corpus → record the active model, carry on;
 *   - existing corpus, no record yet (pre-#440 install) → adopt the active
 *     model IF the stored vectors already have its dimension, otherwise block;
 *   - same dimensions, different model → NULL every stored vector and let
 *     `embeddingBackfill.ts` re-embed at its own pace (the backfill's normal
 *     `embedding IS NULL` queue, no separate machinery);
 *   - different dimensions → block. Recovering needs a schema change, since
 *     the column is `vector(768)`: migration 0005 already walked that path
 *     (1536 → 768) by dropping the HNSW index, dropping the column, re-adding
 *     it with the new size and re-creating the index. An operator switching
 *     to, say, text-embedding-3-small must ship the equivalent migration
 *     before the new provider is allowed to write.
 */

export interface EmbeddingModelGateOptions {
  pool: Pool;
  tenantId: string;
  /** Metadata of the active provider, or `undefined` when the resolved
   *  `embeddingClient` predates #440 and carries none. */
  provider: EmbeddingProviderMetadata | undefined;
  log?: (msg: string) => void;
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
    }
  /** Incompatible — the caller must not let this provider write vectors. */
  | {
      status: 'blocked';
      reason: 'dimension-mismatch';
      modelId: string;
      dimensions: number;
      storedModelId: string;
      storedDimensions: number;
    };

/** Pre-#440 corpora have vectors but no recorded model identity. */
const UNKNOWN_STORED_MODEL_ID = '(unrecorded, pre-#440 corpus)';

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

  const stored = await pool.query<StoredModelRow>(
    'SELECT model_id, dimensions FROM graph_embedding_model WHERE tenant_id = $1',
    [tenantId],
  );
  const row = stored.rows[0];

  if (!row) {
    const existingDimensions = await readStoredVectorDimensions(pool, tenantId);
    if (
      existingDimensions !== undefined &&
      existingDimensions !== provider.dimensions
    ) {
      log(
        `[graph-embedding-gate] BLOCKED: stored vectors are ${String(existingDimensions)}-dimensional, active provider '${provider.modelId}' emits ${String(provider.dimensions)} — vector writes disabled. Migrate graph_nodes.embedding to the new size (see migration 0005) or switch back.`,
      );
      return {
        status: 'blocked',
        reason: 'dimension-mismatch',
        modelId: provider.modelId,
        dimensions: provider.dimensions,
        storedModelId: UNKNOWN_STORED_MODEL_ID,
        storedDimensions: existingDimensions,
      };
    }
    await pool.query(
      `INSERT INTO graph_embedding_model (tenant_id, model_id, dimensions)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId, provider.modelId, provider.dimensions],
    );
    log(
      existingDimensions === undefined
        ? `[graph-embedding-gate] recorded '${provider.modelId}' (${String(provider.dimensions)}d) as this tenant's embedding model (empty corpus)`
        : `[graph-embedding-gate] adopted '${provider.modelId}' (${String(provider.dimensions)}d) for the existing corpus — dimensions match, no re-embed needed`,
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
      `[graph-embedding-gate] BLOCKED: corpus was embedded with '${row.model_id}' (${String(row.dimensions)}d), active provider is '${provider.modelId}' (${String(provider.dimensions)}d) — vector writes disabled to keep the similarity space intact. Migrate graph_nodes.embedding to the new size (see migration 0005) or switch back.`,
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
  const clearedVectors = await switchModelAndClearVectors(
    pool,
    tenantId,
    provider,
  );
  log(
    `[graph-embedding-gate] embedding model switched '${row.model_id}' → '${provider.modelId}' (both ${String(provider.dimensions)}d); cleared ${String(clearedVectors)} stored vector(s), embeddingBackfill will re-embed them`,
  );
  return {
    status: 're-embedding',
    modelId: provider.modelId,
    previousModelId: row.model_id,
    clearedVectors,
  };
}

/**
 * Dimension of the vectors already in the corpus, or `undefined` when there
 * are none. `vector_dims` is a pgvector builtin; one row is enough because a
 * typed `vector(n)` column cannot hold mixed sizes.
 */
async function readStoredVectorDimensions(
  pool: Pool,
  tenantId: string,
): Promise<number | undefined> {
  const result = await pool.query<{ dims: number }>(
    `SELECT vector_dims(embedding) AS dims
       FROM graph_nodes
      WHERE tenant_id = $1 AND embedding IS NOT NULL
      LIMIT 1`,
    [tenantId],
  );
  const dims = result.rows[0]?.dims;
  return typeof dims === 'number' ? dims : undefined;
}

async function switchModelAndClearVectors(
  pool: Pool,
  tenantId: string,
  provider: EmbeddingProviderMetadata,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Reset the attempt counter too, otherwise nodes that had exhausted their
    // retries under the old provider would never be picked up again.
    const cleared = await client.query(
      `UPDATE graph_nodes
          SET embedding = NULL,
              embedding_attempts = 0,
              embedding_last_error = NULL,
              embedding_last_error_at = NULL
        WHERE tenant_id = $1 AND embedding IS NOT NULL`,
      [tenantId],
    );
    await client.query(
      `UPDATE graph_embedding_model
          SET model_id = $2, dimensions = $3, updated_at = now()
        WHERE tenant_id = $1`,
      [tenantId, provider.modelId, provider.dimensions],
    );
    await client.query('COMMIT');
    return cleared.rowCount ?? 0;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
