import type { EmbeddingClient } from '@omadia/plugin-api';
import type { Pool } from 'pg';

import {
  clearStaleVectors,
  isStaleVectorClearPending,
} from './embeddingModelGate.js';
import { buildEmbeddingBody } from './processMemoryStore.js';

/**
 * Slice 7 — node types the backfill knows how to embed. Adding a new
 * type means: (a) include it here, (b) add a partial-index migration
 * mirroring `idx_graph_nodes_turn_embedding_pending`, (c) extend
 * `composeTextForType` below.
 */
export type BackfillableNodeType =
  | 'Turn'
  | 'MemorableKnowledge'
  | 'PalaiaExcerpt';

export interface EmbeddingBackfillOptions {
  pool: Pool;
  embeddingClient: EmbeddingClient;
  tenantId: string;
  /** Milliseconds between sweeps. */
  intervalMs: number;
  /** Max nodes picked up per sweep across ALL configured types. Keep
   *  small so one Ollama hiccup can't drain the queue into a giant
   *  retry storm. */
  batchSize: number;
  /** Hard cap on retries per node. Nodes that keep failing past this
   *  stay in the table but get skipped forever — investigate manually. */
  maxAttempts: number;
  /** Slice 7 — node types to backfill. Default `['Turn']` for
   *  backwards-compat with pre-Slice-7 callers. Pass
   *  `['Turn', 'MemorableKnowledge', 'PalaiaExcerpt']` to opt into the
   *  Slice-7 memory-recall pipeline. */
  nodeTypes?: BackfillableNodeType[];
  /** #440 — also re-embed `processes` rows whose vector is NULL. Off by
   *  default so pre-#440 callers keep their exact behaviour; the KG plugin
   *  turns it on. `processes.embedding` is the second cosine space the
   *  model gate governs, and without this it would never recover from a
   *  provider switch. */
  includeProcesses?: boolean;
  /** #440 — finish a stale-vector clear the gate started but capped. While
   *  one is pending the sweep clears instead of embedding, so a non-NULL
   *  vector always means "old model". Off by default, on in the KG plugin. */
  resumeStaleVectorClear?: boolean;
  log?: (msg: string) => void;
}

export interface EmbeddingBackfillHandle {
  stop(): void;
  /** Run one sweep immediately, bypassing the interval. Used for tests. */
  runOnce(): Promise<EmbeddingBackfillStats>;
}

export interface EmbeddingBackfillStats {
  tried: number;
  succeeded: number;
  failed: number;
  /** Vectors dropped by the resumed stale-vector clear (#440). Non-zero only
   *  while a provider switch is still being worked off. */
  cleared?: number;
}

interface PendingProcessRow {
  id: string;
  title: string;
  steps: unknown;
}

interface PendingNodeRow {
  id: string;
  type: BackfillableNodeType;
  properties: Record<string, unknown>;
  embedding_attempts: number;
}

/**
 * Per-type text composer. Returns the embedding input or `null` if
 * the row carries no useful text (caller marks it as exhausted so the
 * sweep skips it forever).
 */
function composeTextForType(row: PendingNodeRow): string | null {
  const p = row.properties;
  switch (row.type) {
    case 'Turn': {
      const text = `${String(p['userMessage'] ?? '')}\n\n${String(p['assistantAnswer'] ?? '')}`.trim();
      return text.length > 0 ? text : null;
    }
    case 'MemorableKnowledge': {
      const summary = String(p['summary'] ?? '');
      const rationale = String(p['rationale'] ?? '');
      const text = `${summary}\n\n${rationale}`.trim();
      return text.length > 0 ? text : null;
    }
    case 'PalaiaExcerpt': {
      const text = String(p['text'] ?? '').trim();
      return text.length > 0 ? text : null;
    }
  }
}

function vectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

/** How many clear batches one sweep tick is allowed to run (#440). Keeps a
 *  large corpus from monopolising the tick while still making real progress. */
const STALE_CLEAR_BATCHES_PER_SWEEP = 10;
/** `statement_timeout` per clear batch — an index rewrite that hangs must not
 *  wedge the sweep. */
const STALE_CLEAR_STATEMENT_TIMEOUT_MS = 15_000;

/**
 * Scheduled sweep that re-embeds Turn nodes whose original `embedAndStoreTurn`
 * call failed (typical cause: Ollama sidecar timeout or 500). Runs fully
 * independently of the ingest hot path so a slow sweep can't backpressure
 * incoming chat turns.
 *
 * The sweep is in-process (`setInterval`) rather than a separate Fly app
 * because it shares the same `embeddingClient` and pool, and the work is
 * I/O-bound and cheap at our scale. If the backfill ever needs its own
 * process (e.g. corpus explodes into millions of turns), extract into a
 * dedicated worker — the SQL + logic transplant 1:1.
 */
export function startEmbeddingBackfill(
  opts: EmbeddingBackfillOptions,
): EmbeddingBackfillHandle {
  const log = opts.log ?? ((msg: string) => { console.error(msg); });
  const nodeTypes: BackfillableNodeType[] = opts.nodeTypes ?? ['Turn'];
  let running = false;
  /** In-memory retry counter for `processes` (no persisted attempt column). */
  const processFailures = new Map<string, number>();

  const sweepNodes = async (stats: EmbeddingBackfillStats): Promise<void> => {
    try {
      // Slice 7 — fan in across configured node types. The ORDER BY
      // (embedding_attempts, created_at) keeps freshly-failed rows at
      // the back of the queue so a transient Ollama hiccup can't starve
      // older rows. Cross-type ordering is intentionally arbitrary —
      // batch size is small enough that fairness over a few sweeps
      // converges naturally.
      const result = await opts.pool.query<PendingNodeRow>(
        `
        SELECT id,
               type,
               properties,
               embedding_attempts
          FROM graph_nodes
         WHERE tenant_id = $1
           AND type = ANY($2::text[])
           AND embedding IS NULL
           AND embedding_attempts < $3
         ORDER BY embedding_attempts ASC, created_at ASC
         LIMIT $4
        `,
        [opts.tenantId, nodeTypes, opts.maxAttempts, opts.batchSize],
      );
      if (result.rows.length === 0) return;

      log(
        `[graph-embedding-backfill] sweep start pending=${String(result.rows.length)} types=[${nodeTypes.join(',')}]`,
      );

      for (const row of result.rows) {
        stats.tried++;
        const text = composeTextForType(row);
        if (text === null) {
          // Mark as exhausted so we don't keep picking it up. Bumping to
          // maxAttempts is cleaner than adding a second skip predicate.
          await opts.pool.query(
            `UPDATE graph_nodes
               SET embedding_attempts = $1,
                   embedding_last_error_at = NOW(),
                   embedding_last_error = 'empty text — cannot embed'
             WHERE id = $2`,
            [opts.maxAttempts, row.id],
          );
          stats.failed++;
          continue;
        }
        try {
          const vector = await opts.embeddingClient.embed(text);
          if (vector.length === 0) {
            stats.failed++;
            await opts.pool.query(
              `UPDATE graph_nodes
                 SET embedding_attempts = embedding_attempts + 1,
                     embedding_last_error_at = NOW(),
                     embedding_last_error = 'empty vector from embedder'
               WHERE id = $1`,
              [row.id],
            );
            continue;
          }
          await opts.pool.query(
            `UPDATE graph_nodes
               SET embedding = $1::vector,
                   embedding_attempts = 0,
                   embedding_last_error_at = NULL,
                   embedding_last_error = NULL
             WHERE id = $2`,
            [vectorLiteral(vector), row.id],
          );
          stats.succeeded++;
        } catch (err) {
          stats.failed++;
          const message = err instanceof Error ? err.message : String(err);
          try {
            await opts.pool.query(
              `UPDATE graph_nodes
                 SET embedding_attempts = embedding_attempts + 1,
                     embedding_last_error_at = NOW(),
                     embedding_last_error = $1
               WHERE id = $2`,
              [message.slice(0, 500), row.id],
            );
          } catch {
            // swallow — the next sweep will try again
          }
        }
      }

      log(
        `[graph-embedding-backfill] node sweep done tried=${String(stats.tried)} ok=${String(stats.succeeded)} fail=${String(stats.failed)}`,
      );
    } catch (err) {
      log(
        `[graph-embedding-backfill] node sweep error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  /**
   * #440 — `processes.embedding` is the second cosine space governed by the
   * model gate. Its write path embeds inline, so a NULL vector only happens
   * after the gate cleared it on a provider switch; without this sweep those
   * rows would stay NULL forever, which is a silent recall + dedup hole.
   *
   * `processes` has no `embedding_attempts` column, so retries are capped
   * in-memory for the lifetime of this handle rather than persisted. A row
   * that keeps failing is skipped until the next restart — good enough to
   * stop one poison row from occupying the whole batch every tick, and it
   * avoids a schema change for a transient condition.
   */
  const sweepProcesses = async (
    stats: EmbeddingBackfillStats,
  ): Promise<void> => {
    const result = await opts.pool.query<PendingProcessRow>(
      `
      SELECT id, title, steps
        FROM processes
       WHERE tenant_id = $1
         AND embedding IS NULL
       ORDER BY updated_at ASC
       LIMIT $2
      `,
      [opts.tenantId, opts.batchSize],
    );
    const pending = result.rows.filter(
      (r) => (processFailures.get(r.id) ?? 0) < opts.maxAttempts,
    );
    if (pending.length === 0) return;

    log(
      `[graph-embedding-backfill] process sweep start pending=${String(pending.length)}`,
    );
    for (const row of pending) {
      stats.tried++;
      const steps = Array.isArray(row.steps) ? row.steps.map((s) => String(s)) : [];
      const text = buildEmbeddingBody(row.title, steps).trim();
      if (text.length === 0) {
        processFailures.set(row.id, opts.maxAttempts);
        stats.failed++;
        continue;
      }
      try {
        const vector = await opts.embeddingClient.embed(text);
        if (vector.length === 0) throw new Error('empty vector from embedder');
        await opts.pool.query(
          `UPDATE processes
              SET embedding = $1::vector
            WHERE tenant_id = $2 AND id = $3`,
          [vectorLiteral(vector), opts.tenantId, row.id],
        );
        processFailures.delete(row.id);
        stats.succeeded++;
      } catch (err) {
        stats.failed++;
        processFailures.set(row.id, (processFailures.get(row.id) ?? 0) + 1);
        log(
          `[graph-embedding-backfill] process ${row.id} embed failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    log(
      `[graph-embedding-backfill] process sweep done ok=${String(stats.succeeded)} fail=${String(stats.failed)}`,
    );
  };

  const runSweep = async (): Promise<EmbeddingBackfillStats> => {
    if (running) {
      // A previous sweep is still in flight — skip this tick rather than
      // stack calls. Common when Ollama is slow: one sweep of batchSize=20
      // can exceed the interval.
      return { tried: 0, succeeded: 0, failed: 0 };
    }
    running = true;
    const stats: EmbeddingBackfillStats = { tried: 0, succeeded: 0, failed: 0 };
    try {
      // #440 — finish what the gate capped. Embedding anything while stale
      // vectors are still around would break the invariant the clear relies
      // on ("non-NULL ⇒ old model"), so this tick does nothing else.
      if (opts.resumeStaleVectorClear === true) {
        const clearPending = await isStaleVectorClearPending(
          opts.pool,
          opts.tenantId,
        );
        if (clearPending) {
          const cleared = await clearStaleVectors(opts.pool, opts.tenantId, {
            batchSize: opts.batchSize,
            maxRows: opts.batchSize * STALE_CLEAR_BATCHES_PER_SWEEP,
            statementTimeoutMs: STALE_CLEAR_STATEMENT_TIMEOUT_MS,
          });
          stats.cleared = cleared.totalCleared;
          log(
            `[graph-embedding-backfill] stale-vector clear cleared=${String(cleared.totalCleared)} stillPending=${String(cleared.pending)}`,
          );
          return stats;
        }
      }

      await sweepNodes(stats);
      if (opts.includeProcesses === true) await sweepProcesses(stats);
    } catch (err) {
      log(
        `[graph-embedding-backfill] sweep error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      running = false;
    }
    return stats;
  };

  // Initial jittered kick so multiple instances on a coordinated restart
  // don't hit Ollama in lockstep. 0–30 s is enough at single-digit machine
  // count; widen if we scale horizontally.
  const jitterMs = Math.floor(Math.random() * 30_000);
  const initialTimer = setTimeout(() => {
    void runSweep();
  }, jitterMs);
  initialTimer.unref?.();

  const timer = setInterval(() => {
    void runSweep();
  }, opts.intervalMs);
  timer.unref?.();

  return {
    stop(): void {
      clearTimeout(initialTimer);
      clearInterval(timer);
    },
    runOnce: runSweep,
  };
}
