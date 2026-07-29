import type { EmbeddingProviderMetadata } from '@omadia/plugin-api';
import type { Pool } from 'pg';

import type {
  EmbeddingModelGateOutcome,
  GovernedVectorColumn,
} from './embeddingModelGate.js';
import { migrateVectorColumns } from './vectorColumnMigration.js';

/**
 * #440 — the bridge between the model/dimension gate and the runtime
 * vector-column width migration.
 *
 * Kept out of `embeddingModelGate.ts` so that file stays a decision table and
 * this one owns the "we are about to destroy the corpus" narration. The
 * mechanics live one layer down in `vectorColumnMigration.ts`.
 */

/** What one auto-migration attempt produced. */
export interface AutoMigrationAttempt {
  /** Set only when the migration completed and produced a gate outcome. */
  outcome?: EmbeddingModelGateOutcome;
  /**
   * Set when the run left the SCHEMA and the REGISTRY disagreeing — columns at
   * the new width, `graph_embedding_model` still naming something else. The
   * caller attaches it to the `blocked/column-width-mismatch` outcome so
   * `/health` names the state instead of showing a generic width complaint
   * that no longer describes the schema.
   */
  hazard?: string;
}

/**
 * Rewrite the mismatching vector columns at the provider's width, or give up.
 *
 * Returns the `column-migrated` outcome on success and an empty (or
 * hazard-carrying) attempt on every other path — "give up" here always means
 * "fall through to the historical `blocked/column-width-mismatch`", which is
 * the outcome that existed before this function and is still correct: writes
 * off, nothing destroyed, operator told exactly what to do. A migration that
 * cannot run must never be louder than that, and must never fail activation.
 *
 * The destructiveness is logged BEFORE the work rather than after, so an
 * operator reading a crash log still sees what was about to happen.
 */
export async function tryAutoMigrateColumns(args: {
  pool: Pool;
  tenantId: string;
  provider: EmbeddingProviderMetadata;
  mismatches: readonly GovernedVectorColumn[];
  enabled: boolean;
  switchCooldownMs: number;
  budgetMs: number;
  log: (msg: string) => void;
}): Promise<AutoMigrationAttempt> {
  const named = args.mismatches
    .map((c) => `${c.table}.${c.column} vector(${String(c.declaredDimensions ?? 0)})`)
    .join(', ');
  if (!args.enabled) {
    args.log(
      `[graph-embedding-gate] auto_migrate_vector_columns is OFF — leaving ${named} alone and blocking instead. Turn it on, or migrate by hand the way 0005_turn_embeddings_768.sql did.`,
    );
    return {};
  }

  args.log(
    `[graph-embedding-gate] WARNING: DESTRUCTIVE auto-migration starting — ${named} will be dropped and re-added as vector(${String(args.provider.dimensions)}) for provider '${args.provider.modelId}'. EVERY stored embedding in those columns is discarded and has to be re-embedded by the backfill sweep, which costs one provider call per row.`,
  );

  let result;
  try {
    result = await migrateVectorColumns({
      pool: args.pool,
      tenantId: args.tenantId,
      targets: args.mismatches.map((c) => ({ table: c.table, column: c.column })),
      targetModelId: args.provider.modelId,
      targetDimensions: args.provider.dimensions,
      switchCooldownMs: args.switchCooldownMs,
      budgetMs: args.budgetMs,
      log: args.log,
    });
  } catch (err) {
    args.log(
      `[graph-embedding-gate] ERROR: the vector-column migration threw (${err instanceof Error ? err.message : String(err)}) — falling back to blocked; the registry was not touched`,
    );
    return {};
  }

  if (!result.ok) {
    args.log(
      `[graph-embedding-gate] ERROR: the vector-column migration did not complete [${result.reason}]: ${result.detail}. ${String(result.migrated.length)} column(s) were migrated and stay migrated; falling back to blocked for this boot.`,
    );
    // A run that migrated nothing is fully recoverable — the next activation
    // sees the same width mismatch and simply retries. A run that migrated
    // SOMETHING and did not flip the registry is not equally benign, and
    // `registry-flip-failed` is the terminal one: every column is at the new
    // width, so the next activation finds no mismatch, never reaches this path
    // again, and dead-ends on `blocked/dimension-mismatch` until a human edits
    // the registry. `budget-exhausted` always leaves at least one column
    // un-migrated (the deadline is checked at the TOP of each target), so the
    // next activation still sees a mismatch and resumes — it is reported for
    // visibility, not because it is stuck.
    if (result.migrated.length > 0) {
      const hazard = `${String(result.migrated.length)} column(s) are already vector(${String(args.provider.dimensions)}) while graph_embedding_model was NOT updated [${result.reason}]: ${result.detail}`;
      args.log(`[graph-embedding-gate] SCHEMA/REGISTRY SPLIT: ${hazard}`);
      return { hazard };
    }
    return {};
  }

  args.log(
    `[graph-embedding-gate] vector columns migrated to ${String(args.provider.dimensions)}d for '${args.provider.modelId}' (was '${result.previousModelId ?? '(unrecorded)'}' / ${String(result.previousDimensions ?? 0)}d): ${result.migrated
      .map(
        (m) =>
          `${m.table}.${m.column} vector(${String(m.previousDimensions ?? 0)})→vector(${String(m.newDimensions)}) discarded=${m.discardedVectors === undefined ? 'unknown' : String(m.discardedVectors)}`,
      )
      .join(
        '; ',
      )}. ${
      result.attemptsResetPending
        ? 'Vector writes stay REFUSED until the capped retry-counter reset finishes (clear_pending is TRUE; the gate resume path and the backfill sweep drain it in bounded batches).'
        : 'Vector writes are ENABLED; the backfill sweep re-embeds the corpus from NULL, so semantic recall is degraded until it finishes.'
    }`,
  );
  return {
    outcome: {
      status: 'column-migrated',
      modelId: args.provider.modelId,
      dimensions: args.provider.dimensions,
      previousModelId: result.previousModelId,
      previousDimensions: result.previousDimensions,
      migratedColumns: result.migrated,
      discardedVectors: result.discardedVectors,
      clearPending: result.attemptsResetPending,
    },
  };
}

