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

/**
 * Rewrite the mismatching vector columns at the provider's width, or give up.
 *
 * Returns the `column-migrated` outcome on success and `undefined` on every
 * other path — "give up" here always means "fall through to the historical
 * `blocked/column-width-mismatch`", which is the outcome that existed before
 * this function and is still correct: writes off, nothing destroyed, operator
 * told exactly what to do. A migration that cannot run must never be louder
 * than that, and must never fail activation.
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
}): Promise<EmbeddingModelGateOutcome | undefined> {
  const named = args.mismatches
    .map((c) => `${c.table}.${c.column} vector(${String(c.declaredDimensions ?? 0)})`)
    .join(', ');
  if (!args.enabled) {
    args.log(
      `[graph-embedding-gate] auto_migrate_vector_columns is OFF — leaving ${named} alone and blocking instead. Turn it on, or migrate by hand the way 0005_turn_embeddings_768.sql did.`,
    );
    return undefined;
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
    return undefined;
  }

  if (!result.ok) {
    args.log(
      `[graph-embedding-gate] ERROR: the vector-column migration did not complete [${result.reason}]: ${result.detail}. ${String(result.migrated.length)} column(s) were migrated and stay migrated; falling back to blocked for this boot.`,
    );
    return undefined;
  }

  args.log(
    `[graph-embedding-gate] vector columns migrated to ${String(args.provider.dimensions)}d for '${args.provider.modelId}' (was '${result.previousModelId ?? '(unrecorded)'}' / ${String(result.previousDimensions ?? 0)}d): ${result.migrated
      .map(
        (m) =>
          `${m.table}.${m.column} vector(${String(m.previousDimensions ?? 0)})→vector(${String(m.newDimensions)}) discarded=${m.discardedVectors === undefined ? 'unknown' : String(m.discardedVectors)}`,
      )
      .join(
        '; ',
      )}. Vector writes are ENABLED; the backfill sweep re-embeds the corpus from NULL, so semantic recall is degraded until it finishes.`,
  );
  return {
    status: 'column-migrated',
    modelId: args.provider.modelId,
    dimensions: args.provider.dimensions,
    previousModelId: result.previousModelId,
    previousDimensions: result.previousDimensions,
    migratedColumns: result.migrated,
    discardedVectors: result.discardedVectors,
  };
}

