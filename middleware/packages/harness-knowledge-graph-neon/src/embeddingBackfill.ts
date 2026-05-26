import type { Pool } from 'pg';
import type { EmbeddingClient } from '@omadia/embeddings';

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
      if (result.rows.length === 0) return stats;

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
        `[graph-embedding-backfill] sweep done tried=${String(stats.tried)} ok=${String(stats.succeeded)} fail=${String(stats.failed)}`,
      );
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
