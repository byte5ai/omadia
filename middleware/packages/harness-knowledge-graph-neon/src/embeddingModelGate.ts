import type { EmbeddingProviderMetadata } from '@omadia/plugin-api';
import type { Pool, PoolClient } from 'pg';

import {
  CLEARABLE_COLUMNS,
  clearStaleVectors,
  isStaleVectorClearPending,
  type ClearOptions,
  type StaleVectorClearResult,
} from './staleVectorClear.js';
import { tryAutoMigrateColumns } from './gateAutoMigration.js';
import {
  // Advisory-lock namespace (first key of the two-int form). It lives in the
  // migration module because the runtime width migration takes a SESSION-level
  // lock in this same space — which is exactly what makes it mutually
  // exclusive with `decideRegistry`'s transaction below.
  LOCK_NS_REGISTRY,
  type MigratedVectorColumn,
} from './vectorColumnMigration.js';

// The clear machinery lives in `staleVectorClear.ts`; re-exported here so
// `embeddingBackfill.ts`, the package index and existing callers keep their
// import path.
export {
  clearStaleVectors,
  isStaleVectorClearPending,
} from './staleVectorClear.js';
export type {
  ClearOptions,
  StaleVectorClearResult,
} from './staleVectorClear.js';

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
 *     the column check;
 *   - the registry says something this instance did not write (lost insert
 *     race, another instance that switched moments ago) → BLOCK, see
 *     `'registry-conflict'`.
 *
 * CONCURRENCY. Two things here are destructive (the model flip and the
 * vector clear) and the middleware runs multi-instance during a rolling
 * deploy, so both are serialised:
 *   - read → decide → flip runs inside ONE transaction holding
 *     `pg_advisory_xact_lock(tenant)`, and the flip itself carries a CAS
 *     predicate on the model/dimensions it read. Losing either means the
 *     registry moved underneath us — the gate blocks instead of guessing;
 *   - the clear holds a session-level `pg_try_advisory_lock(tenant)`. A
 *     second clearer (other instance, or the backfill sweep racing an
 *     activation) does not run concurrently; it reports "still pending" so
 *     nobody lowers `clear_pending` on work it did not do;
 *   - a model switch is refused when the registry row was written within
 *     `switchCooldownMs` AND the corpus still holds vectors. That is the
 *     rolling-deploy oscillation guard: two machine versions with different
 *     adapters would otherwise take turns switching and wiping each other's
 *     re-embedded corpus, with no error surfaced anywhere. The cooldown does
 *     not make such a deploy correct — it makes it loud and non-destructive.
 *
 * WRITES ARE REFUSED WHILE A CLEAR IS PENDING. `clear_pending = TRUE` means
 * "some governed vectors are still old-model, and something will come along
 * and NULL every non-NULL vector it finds". The clear has no model or
 * timestamp discriminator, so any vector written in that window would be
 * destroyed by the resumed pass — and under sustained ingest the pass would
 * never drain. `allowsVectorWrites()` therefore returns false until the
 * clear completes, which makes the documented invariant ("a non-NULL vector
 * is an old-model vector") true by construction rather than by hope. The
 * plugin still arms the backfill in that state so the clear finishes, and
 * once `clear_pending` drops the same sweep re-embeds everything NULL —
 * including whatever was ingested during the window.
 *
 * Two consequences of that invariant, both of which cost a regression to
 * learn, so they are spelled out rather than implied:
 *
 *  - `clear_pending` is consulted BEFORE the "provider reports no metadata"
 *    early return. An adapter that predates #440 (or a third-party one) hands
 *    `readEmbeddingProviderMetadata` nothing, and a blind pass-through there
 *    would allow hot-path writes into exactly the window the resumed sweep
 *    NULLs — the sweep would clear every tick, the hot path would refill every
 *    tick, `clear_pending` would never drop and `/health` would report
 *    `embeddings: true` throughout. Unknown provider therefore still reads the
 *    registry and still refuses writes while a clear is owed;
 *  - a clear that THROWS (per-batch `statement_timeout`, a transient
 *    `pool.connect()` failure) must degrade to "still owed, resumer armed",
 *    never to a `blocked` outcome. `requiresStaleVectorClearResume()` is what
 *    arms the backfill sweep, and it is false for `blocked` — so a thrown
 *    clear that escaped to the plugin's catch-all would permanently disarm the
 *    only thing that can finish the work, with `clear_pending` stuck TRUE and
 *    writes stuck off until an operator noticed. Every `clearStaleVectors`
 *    call here goes through `resumeClear()`, which converts a throw into
 *    `pending: true`.
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
 * What the gate DOES publish is its outcome (the `embeddingModelGateStatus`
 * service), so `/health` reports `embeddings: false` plus the stored-vs-active
 * model instead of the registry-only guess it used to print.
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
  /** Refuse a destructive model switch when the registry row was written
   *  this recently AND vectors still exist. Anti-oscillation guard for
   *  rolling deploys. Default 10 min; 0 disables. Applies UNCHANGED to the
   *  runtime width migration below, which is strictly more destructive. */
  switchCooldownMs?: number;
  /**
   * #440 follow-up — may THIS evaluation rewrite every governed vector column
   * at the active provider's width instead of blocking?
   *
   * DEFAULTS TO FALSE, and omitting it means NOT ALLOWED. That is the whole
   * point of it being a parameter: the rewrite drops every stored embedding
   * and cannot be undone, so the capability travels with the call rather than
   * sitting in the options as an ambient default.
   *
   * It briefly was such a default (true), and a deployment already sitting on
   * `blocked/column-width-mismatch` — the documented state for 768-wide
   * columns under a 1536-wide provider — would then have lost its entire
   * embedding corpus by doing nothing but upgrading and restarting. The
   * `confirmDiscardVectors` prompt lived only on the HTTP route, so the boot
   * path had no prompt at all.
   *
   * Who passes what:
   *   - plugin activation passes nothing (i.e. false) — a restart is never
   *     allowed to destroy a corpus, and `blocked/column-width-mismatch` is
   *     reversible: writes off, nothing dropped, operator told what to do;
   *   - the re-evaluate path passes true only for an operator-initiated switch
   *     that came with `confirmDiscardVectors`, AND only while the KG's
   *     `auto_migrate_vector_columns` master switch is not 'false'.
   */
  allowDestructiveColumnMigration?: boolean;
  /** Wall-clock cap for that migration. `activate()` is killed at 10s, and a
   *  migration that cannot finish degrades to `blocked` rather than failing
   *  activation. Default 5000. */
  autoMigrateBudgetMs?: number;
  log?: (msg: string) => void;
}

/** A `vector` column the gate governs, as discovered in the catalog. */
export interface GovernedVectorColumn {
  table: string;
  column: string;
  /** Declared width, or `undefined` for an untyped `vector` column. */
  declaredDimensions: number | undefined;
}

export type EmbeddingModelGateOutcome =
  /** No provider metadata — nothing to compare against, so the vector-space
   *  identity check is skipped and writes stay allowed. `clearPending` is the
   *  one thing still checked: an owed clear governs the corpus regardless of
   *  which provider is active, so it refuses writes here too. */
  | { status: 'unknown-provider'; clearPending: boolean }
  /** Active model equals the recorded one. `clearPending` is true when an
   *  earlier switch never finished clearing — writes stay refused until it
   *  does, and this activation resumed as much of it as its cap allowed. */
  | {
      status: 'match';
      modelId: string;
      dimensions: number;
      clearPending: boolean;
    }
  /** First record for this tenant (empty corpus, or an adopted pre-#440 one). */
  | { status: 'recorded'; modelId: string; dimensions: number }
  /**
   * The governed vector columns were the wrong width and have been rewritten
   * at the active provider's width, at runtime. Every stored vector was
   * DESTROYED; the backfill sweep re-embeds from NULL. Vector writes are
   * normally allowed immediately — the columns now match the provider, the
   * registry names it, and nothing old is left to mix with.
   *
   * `clearPending` is the exception: the migration's retry-counter reset is
   * bounded, and when it hit its cap the remainder is carried by
   * `clear_pending` for the gate's resume path and the backfill sweep to
   * finish. Writes are refused until they do, because the resumer NULLs every
   * non-NULL governed vector it finds.
   */
  | {
      status: 'column-migrated';
      modelId: string;
      dimensions: number;
      /** Registry identity before the migration, when there was one. */
      previousModelId: string | undefined;
      previousDimensions: number | undefined;
      migratedColumns: readonly MigratedVectorColumn[];
      /** Vectors dropped, or `undefined` when the count could not be taken. */
      discardedVectors: number | undefined;
      /** Capped retry-counter reset still owed. Refuses writes while true. */
      clearPending: boolean;
    }
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
      /** An auto-migration ran, moved some columns and could not record it.
       *  Surfaced so `/health` names the split instead of reporting a width
       *  complaint that no longer describes the schema. */
      migrationHazard?: string;
    }
  /** Another instance owns the registry row and disagrees about the model.
   *  Switching would destroy the corpus it is busy re-embedding. */
  | {
      status: 'blocked';
      reason: 'registry-conflict';
      modelId: string;
      dimensions: number;
      storedModelId: string;
      storedDimensions: number;
      detail: string;
    };

/** Pre-#440 corpora have vectors but no recorded model identity. */
const UNKNOWN_STORED_MODEL_ID = '(unrecorded, pre-#440 corpus)';

const DEFAULT_CLEAR_BATCH_SIZE = 500;
const DEFAULT_CLEAR_MAX_ROWS = 5_000;
const DEFAULT_CLEAR_STATEMENT_TIMEOUT_MS = 15_000;
const DEFAULT_SWITCH_COOLDOWN_MS = 10 * 60 * 1000;
/** `activate()` is hard-capped at 10s (toolPluginRuntime.ts:286-290) and the
 *  migration is only one of the things happening inside it. */
const DEFAULT_AUTO_MIGRATE_BUDGET_MS = 5_000;

/**
 * May this boot's embedding client write vectors?
 *
 * `blocked` is the obvious no. `clear_pending` is the less obvious one: the
 * resumed clear NULLs every non-NULL governed vector it finds, with no model
 * or timestamp discriminator, so anything written while it is owed gets
 * destroyed — and a steady write rate keeps the clear from ever draining.
 * Refusing writes for the duration is what makes "non-NULL ⇒ old model" an
 * invariant instead of a comment.
 */
export function allowsVectorWrites(outcome: EmbeddingModelGateOutcome): boolean {
  if (outcome.status === 'blocked') return false;
  if (hasClearPendingFlag(outcome)) return !outcome.clearPending;
  return true;
}

/** The outcomes that carry an owed-clear flag. `recorded` cannot: it is only
 *  reached by an INSERT that just created the row with `clear_pending` false. */
function hasClearPendingFlag(
  outcome: EmbeddingModelGateOutcome,
): outcome is Extract<
  EmbeddingModelGateOutcome,
  { status: 'match' | 're-embedding' | 'unknown-provider' | 'column-migrated' }
> {
  return (
    outcome.status === 'match' ||
    outcome.status === 're-embedding' ||
    outcome.status === 'unknown-provider' ||
    // A width migration normally lowers the flag (the columns are empty by
    // construction). It raises it only when its bounded retry-counter reset
    // hit the cap, and then writes must stay off for the same reason they do
    // on every other pending clear.
    outcome.status === 'column-migrated'
  );
}

/**
 * Is a stale-vector clear still owed after this activation? The plugin arms
 * the backfill sweep on this even though vector writes are refused — the
 * sweep is the only thing that can finish the clear and lower the flag.
 */
export function requiresStaleVectorClearResume(
  outcome: EmbeddingModelGateOutcome,
): boolean {
  return hasClearPendingFlag(outcome) && outcome.clearPending;
}

interface StoredModelRow {
  model_id: string;
  dimensions: number;
  clear_pending: boolean;
  age_ms: string | number;
}

/** Outcome of the advisory-locked read/decide/flip transaction. */
type RegistryDecision =
  | { kind: 'recorded' }
  | { kind: 'match'; clearPending: boolean }
  | { kind: 'switched'; previousModelId: string }
  | { kind: 'blocked'; outcome: EmbeddingModelGateOutcome };

export async function evaluateEmbeddingModelGate(
  opts: EmbeddingModelGateOptions,
): Promise<EmbeddingModelGateOutcome> {
  const log = opts.log ?? ((msg: string) => { console.error(msg); });
  const { pool, tenantId, provider } = opts;
  const clearOpts: ClearOptions = {
    batchSize: opts.clearBatchSize ?? DEFAULT_CLEAR_BATCH_SIZE,
    maxRows: opts.clearMaxRowsPerActivation ?? DEFAULT_CLEAR_MAX_ROWS,
    statementTimeoutMs:
      opts.clearStatementTimeoutMs ?? DEFAULT_CLEAR_STATEMENT_TIMEOUT_MS,
  };

  if (!provider) {
    // No metadata means the vector-space IDENTITY check cannot run. An owed
    // clear is a property of the CORPUS rather than of whoever is writing to
    // it, so it still governs this boot: returning early here without reading
    // the registry let the hot path refill, every tick, exactly the vectors
    // the resumed sweep had just NULLed. See the header note.
    const owed = await readClearPending(pool, tenantId, log);
    if (!owed) {
      log(
        '[graph-embedding-gate] active embedding client reports no model metadata — cannot verify the vector space; writes allowed unchanged',
      );
      return { status: 'unknown-provider', clearPending: false };
    }
    log(
      '[graph-embedding-gate] active embedding client reports no model metadata AND a stale-vector clear is still owed — resuming it now; vector writes stay disabled until it completes',
    );
    const resumed = await resumeClear(pool, tenantId, clearOpts, log);
    return { status: 'unknown-provider', clearPending: resumed.pending };
  }

  // (1) Declared column width — the check that works on an empty corpus.
  const columns = await discoverGovernedVectorColumns(pool);
  // Raised BEFORE the width branch: a boot that ends up blocked (or migrating)
  // is exactly the boot whose operator most needs to know a vector column is
  // outside this gate's reach.
  const ungoverned = columns.filter(
    (c) => !CLEARABLE_COLUMNS.some((k) => k.table === c.table && k.column === c.column),
  );
  if (ungoverned.length > 0) {
    log(
      `[graph-embedding-gate] WARNING: ${ungoverned
        .map((c) => `${c.table}.${c.column}`)
        .join(', ')} is a vector column this gate cannot clear — a model switch will leave foreign-model vectors there. Add it to CLEARABLE_COLUMNS in staleVectorClear.ts.`,
    );
  }

  const mismatches = columns.filter(
    (c) =>
      c.declaredDimensions !== undefined &&
      c.declaredDimensions !== provider.dimensions,
  );
  if (mismatches.length > 0) {
    // #440 — the normal case for a provider switch (768-wide columns, a
    // 1536/3072-wide model). An operator who confirmed the discard gets the
    // columns rewritten rather than dead-ending on a hand-written migration;
    // everyone else — every boot, every unconfirmed call — falls through to
    // the historical `blocked` outcome below, with the registry untouched.
    const attempt = await tryAutoMigrateColumns({
      pool,
      tenantId,
      provider,
      mismatches,
      // Fail closed. The boot path omits the flag, so it lands here as false
      // and falls through to `blocked/column-width-mismatch` below.
      allowed: opts.allowDestructiveColumnMigration ?? false,
      switchCooldownMs: opts.switchCooldownMs ?? DEFAULT_SWITCH_COOLDOWN_MS,
      budgetMs: opts.autoMigrateBudgetMs ?? DEFAULT_AUTO_MIGRATE_BUDGET_MS,
      log,
    });
    if (attempt.outcome !== undefined) return attempt.outcome;

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
      ...(attempt.hazard !== undefined ? { migrationHazard: attempt.hazard } : {}),
    };
  }

  // (2) Recorded model identity — read/decide/flip under one tenant lock.
  const decision = await decideRegistry(pool, tenantId, provider, {
    switchCooldownMs: opts.switchCooldownMs ?? DEFAULT_SWITCH_COOLDOWN_MS,
    log,
  });

  if (decision.kind === 'blocked') return decision.outcome;
  if (decision.kind === 'recorded') {
    return {
      status: 'recorded',
      modelId: provider.modelId,
      dimensions: provider.dimensions,
    };
  }

  if (decision.kind === 'match') {
    if (!decision.clearPending) {
      return {
        status: 'match',
        modelId: provider.modelId,
        dimensions: provider.dimensions,
        clearPending: false,
      };
    }
    // `switchModelAndClearVectors` flips the registry row BEFORE clearing, so
    // a boot after an interrupted switch lands HERE, not on the switch path —
    // the row already names our model. Resuming from here matters because the
    // only other resumer is conditional: the backfill is skipped when
    // `graph_embedding_backfill_enabled=false` or when the embeddings plugin
    // is deactivated, and `clear_pending` would then stay TRUE forever with
    // nobody reading it while two models share one cosine space.
    log(
      `[graph-embedding-gate] '${provider.modelId}' matches the recorded model but a stale-vector clear is still owed — resuming it now; vector writes stay disabled until it completes`,
    );
    const resumed = await resumeClear(pool, tenantId, clearOpts, log);
    log(
      `[graph-embedding-gate] resumed clear: ${String(resumed.totalCleared)} vector(s) dropped, ${String(resumed.attemptsReset)} retry counter(s) reset, stillPending=${String(resumed.pending)}`,
    );
    return {
      status: 'match',
      modelId: provider.modelId,
      dimensions: provider.dimensions,
      clearPending: resumed.pending,
    };
  }

  // Same vector size, different model: recoverable without a schema change.
  // The registry flip already happened (durably, under the lock); drop the
  // vectors and let the backfill sweep re-embed. A throw from the clear is
  // especially bad HERE — the registry already names the new model while the
  // corpus still holds old vectors — so `resumeClear` degrades it to
  // `pending: true`, which keeps the resumer armed.
  const cleared = await resumeClear(pool, tenantId, clearOpts, log);
  log(
    `[graph-embedding-gate] embedding model switched '${decision.previousModelId}' → '${provider.modelId}' (both ${String(provider.dimensions)}d); cleared ${String(cleared.totalCleared)} stored vector(s), reset ${String(cleared.attemptsReset)} exhausted retry counter(s)${
      cleared.pending
        ? ' — activation cap reached, the embedding backfill sweep clears the rest before it re-embeds anything'
        : ''
    }`,
  );
  return {
    status: 're-embedding',
    modelId: provider.modelId,
    previousModelId: decision.previousModelId,
    clearedVectors: cleared.totalCleared,
    clearPending: cleared.pending,
  };
}

/**
 * Run a stale-vector clear that CANNOT throw at the caller.
 *
 * The clear reaches Postgres in several ways that fail transiently: the
 * per-batch `SET LOCAL statement_timeout` firing on one 500-row UPDATE
 * (SQLSTATE 57014), a `pool.connect()` that cannot get a connection, a
 * cancelled backend during a failover. `runBoundedUpdate` rethrows and neither
 * `drain` nor `clearStaleVectors` catches, so before this wrapper existed the
 * throw escaped the gate entirely — and the plugin's catch-all turned it into
 * `{status:'blocked'}`, for which `requiresStaleVectorClearResume()` is false.
 * The backfill sweep, the ONLY thing that can finish the clear and lower
 * `clear_pending`, was then never armed: writes stayed refused, the flag
 * stayed TRUE, and the next boot reproduced the same state forever.
 *
 * A failed clear is "the clear is still owed", which is exactly `pending:
 * true`. Nothing was lowered, nothing was lost — the work just did not finish
 * this pass, same as hitting the activation cap.
 */
async function resumeClear(
  pool: Pool,
  tenantId: string,
  clearOpts: ClearOptions,
  log: (msg: string) => void,
): Promise<StaleVectorClearResult> {
  try {
    return await clearStaleVectors(pool, tenantId, clearOpts);
  } catch (err) {
    log(
      `[graph-embedding-gate] the stale-vector clear FAILED (${err instanceof Error ? err.message : String(err)}) — clear_pending stays TRUE, vector writes stay refused, and the backfill sweep resumes the work on its next tick`,
    );
    return {
      clearedByTable: {},
      totalCleared: 0,
      pending: true,
      attemptsReset: 0,
    };
  }
}

/**
 * Is a clear owed, for a boot that cannot identify its own provider?
 *
 * Unreadable registry (migration race, permissions) reads as "no clear owed":
 * that is the pre-#440 behaviour of this path, and blocking a boot on a
 * probe that the very next path (`decideRegistry`) would run anyway would
 * trade a narrow risk for a wide one. It is logged loudly rather than
 * swallowed.
 */
async function readClearPending(
  pool: Pool,
  tenantId: string,
  log: (msg: string) => void,
): Promise<boolean> {
  try {
    return await isStaleVectorClearPending(pool, tenantId);
  } catch (err) {
    log(
      `[graph-embedding-gate] could not read graph_embedding_model.clear_pending (${err instanceof Error ? err.message : String(err)}) — proceeding as if no stale-vector clear were owed`,
    );
    return false;
  }
}

/**
 * Read the registry row, decide, and (for a switch) flip it — all inside one
 * transaction holding `pg_advisory_xact_lock(tenant)`.
 *
 * Everything destructive is decided here, so this is the only place that can
 * race. The lock serialises instances; the CAS predicate on the UPDATE and
 * the `RETURNING` check on the INSERT catch anything that changed the row
 * without taking the lock (an older build, a manual `psql` edit).
 */
async function decideRegistry(
  pool: Pool,
  tenantId: string,
  provider: EmbeddingProviderMetadata,
  opts: { switchCooldownMs: number; log: (msg: string) => void },
): Promise<RegistryDecision> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query(
        'SELECT pg_advisory_xact_lock($1::int, hashtext($2)::int)',
        [LOCK_NS_REGISTRY, tenantId],
      );

      let row = await readStoredModel(client, tenantId);
      let lostInsertRace = false;

      if (!row) {
        const hasVectors = await hasStoredVectors(client, tenantId);
        // `ON CONFLICT DO NOTHING` is a no-op on a lost race, and a no-op
        // that reports success would let this instance write into a vector
        // space the registry says belongs to somebody else. RETURNING is what
        // makes the difference observable.
        const inserted = await client.query<StoredModelRow>(
          `INSERT INTO graph_embedding_model (tenant_id, model_id, dimensions)
           VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id) DO NOTHING
           RETURNING model_id, dimensions, clear_pending, 0 AS age_ms`,
          [tenantId, provider.modelId, provider.dimensions],
        );
        if (inserted.rows.length > 0) {
          await client.query('COMMIT');
          opts.log(
            hasVectors
              ? `[graph-embedding-gate] adopted '${provider.modelId}' (${String(provider.dimensions)}d) for the existing corpus — column width matches, no re-embed needed (previously ${UNKNOWN_STORED_MODEL_ID})`
              : `[graph-embedding-gate] recorded '${provider.modelId}' (${String(provider.dimensions)}d) as this tenant's embedding model (empty corpus)`,
          );
          return { kind: 'recorded' };
        }
        row = await readStoredModel(client, tenantId);
        lostInsertRace = true;
        if (!row) {
          // Insert lost AND the row is gone again — somebody is actively
          // rewriting the registry. Refuse rather than guess.
          await client.query('ROLLBACK');
          const detail =
            'the registry row was deleted while this activation was recording its provider';
          opts.log(`[graph-embedding-gate] BLOCKED: ${detail}.`);
          return {
            kind: 'blocked',
            outcome: registryConflict(provider, '(vanished)', 0, detail),
          };
        }
      }

      if (row.dimensions !== provider.dimensions) {
        await client.query('ROLLBACK');
        opts.log(
          `[graph-embedding-gate] BLOCKED: corpus was embedded with '${row.model_id}' (${String(row.dimensions)}d), active provider is '${provider.modelId}' (${String(provider.dimensions)}d) — vector writes disabled to keep the similarity space intact. Migrate the vector columns to the new size (see migration 0005) or switch back.`,
        );
        return {
          kind: 'blocked',
          outcome: {
            status: 'blocked',
            reason: 'dimension-mismatch',
            modelId: provider.modelId,
            dimensions: provider.dimensions,
            storedModelId: row.model_id,
            storedDimensions: row.dimensions,
          },
        };
      }

      if (row.model_id === provider.modelId) {
        const clearPending = row.clear_pending === true;
        await client.query('COMMIT');
        return { kind: 'match', clearPending };
      }

      // Same width, different model — a switch. Destructive: every stored
      // vector goes away. Two guards before we do it.
      if (lostInsertRace) {
        await client.query('ROLLBACK');
        const detail = `another instance recorded '${row.model_id}' for this tenant while this one was starting up`;
        opts.log(
          `[graph-embedding-gate] BLOCKED: ${detail}; '${provider.modelId}' will NOT claim the corpus. Run one embedding provider per deployment, then restart.`,
        );
        return {
          kind: 'blocked',
          outcome: registryConflict(provider, row.model_id, row.dimensions, detail),
        };
      }

      const ageMs = Number(row.age_ms);
      if (
        opts.switchCooldownMs > 0 &&
        Number.isFinite(ageMs) &&
        ageMs < opts.switchCooldownMs &&
        (await hasStoredVectors(client, tenantId))
      ) {
        await client.query('ROLLBACK');
        const detail = `the registry was last written ${String(Math.round(ageMs / 1000))}s ago (cooldown ${String(Math.round(opts.switchCooldownMs / 1000))}s) and the corpus still holds vectors`;
        opts.log(
          `[graph-embedding-gate] BLOCKED: refusing to switch '${row.model_id}' → '${provider.modelId}' — ${detail}. This is the rolling-deploy guard: two machine versions with different adapters would otherwise take turns clearing each other's re-embedded corpus, with no error anywhere. Settle on one provider and restart.`,
        );
        return {
          kind: 'blocked',
          outcome: registryConflict(provider, row.model_id, row.dimensions, detail),
        };
      }

      // Flip the registry FIRST, inside this transaction: `clear_pending` is
      // what makes the clear resumable, so it must be durable before any row
      // is touched. A crash halfway through then resumes on the next boot /
      // the next backfill tick instead of leaving a half-cleared corpus that
      // nothing knows about. The CAS predicate makes the flip conditional on
      // the row still being exactly what we read.
      const flipped = await client.query(
        `UPDATE graph_embedding_model
            SET model_id = $2, dimensions = $3, clear_pending = TRUE, updated_at = now()
          WHERE tenant_id = $1
            AND model_id = $4
            AND dimensions = $5`,
        [
          tenantId,
          provider.modelId,
          provider.dimensions,
          row.model_id,
          row.dimensions,
        ],
      );
      if ((flipped.rowCount ?? 0) !== 1) {
        await client.query('ROLLBACK');
        const detail = `the registry row changed between read and switch (expected '${row.model_id}'/${String(row.dimensions)}d)`;
        opts.log(`[graph-embedding-gate] BLOCKED: ${detail} — no vectors were touched.`);
        return {
          kind: 'blocked',
          outcome: registryConflict(provider, row.model_id, row.dimensions, detail),
        };
      }
      await client.query('COMMIT');
      return { kind: 'switched', previousModelId: row.model_id };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // the transaction is already gone — nothing to undo
      }
      throw err;
    }
  } finally {
    client.release();
  }
}

function registryConflict(
  provider: EmbeddingProviderMetadata,
  storedModelId: string,
  storedDimensions: number,
  detail: string,
): EmbeddingModelGateOutcome {
  return {
    status: 'blocked',
    reason: 'registry-conflict',
    modelId: provider.modelId,
    dimensions: provider.dimensions,
    storedModelId,
    storedDimensions,
    detail,
  };
}

async function readStoredModel(
  client: PoolClient,
  tenantId: string,
): Promise<StoredModelRow | undefined> {
  const stored = await client.query<StoredModelRow>(
    `SELECT model_id,
            dimensions,
            clear_pending,
            EXTRACT(EPOCH FROM (now() - updated_at)) * 1000 AS age_ms
       FROM graph_embedding_model
      WHERE tenant_id = $1`,
    [tenantId],
  );
  return stored.rows[0];
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

/**
 * Cheap existence probe — phrases the log line and, more importantly, arms the
 * anti-oscillation switch cooldown.
 *
 * It spans EVERY governed vector table, not just `graph_nodes`. "The corpus
 * still holds vectors" is the whole predicate the cooldown rests on, and a
 * tenant whose vectors live only in `processes` — or whose `graph_nodes` were
 * already drained by a partially-completed clear — would otherwise read as
 * "nothing to lose" and be handed straight to the destructive switch path.
 * Derived from `CLEARABLE_COLUMNS` so a future governed table is covered
 * without touching this function; the identifiers are module-local constants,
 * never user input.
 */
async function hasStoredVectors(
  client: PoolClient,
  tenantId: string,
): Promise<boolean> {
  const probes = CLEARABLE_COLUMNS.map(
    (c) =>
      `EXISTS (SELECT 1 FROM ${c.table} WHERE tenant_id = $1 AND ${c.column} IS NOT NULL)`,
  ).join('\n          OR ');
  const result = await client.query<{ has_vectors: boolean }>(
    `SELECT (${probes}) AS has_vectors`,
    [tenantId],
  );
  return result.rows[0]?.has_vectors === true;
}
