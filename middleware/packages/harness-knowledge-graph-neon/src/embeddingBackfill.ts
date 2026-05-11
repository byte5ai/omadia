import type { Pool } from 'pg';
import type { EmbeddingClient } from '@omadia/embeddings';

export interface EmbeddingBackfillOptions {
  pool: Pool;
  embeddingClient: EmbeddingClient;
  tenantId: string;
  /** Milliseconds between sweeps. */
  intervalMs: number;
  /** Max Turns picked up per sweep. Keep small so one Ollama hiccup can't
   *  drain the queue into a giant retry storm. */
  batchSize: number;
  /** Hard cap on retries per Turn. Turns that keep failing past this stay
   *  in the table but get skipped forever — investigate manually. */
  maxAttempts: number;
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

interface PendingTurnRow {
  id: string;
  user_message: string | null;
  assistant_answer: string | null;
  embedding_attempts: number;
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
      const result = await opts.pool.query<PendingTurnRow>(
        `
        SELECT id,
               properties->>'userMessage'     AS user_message,
               properties->>'assistantAnswer' AS assistant_answer,
               embedding_attempts
          FROM graph_nodes
         WHERE tenant_id = $1
           AND type = 'Turn'
           AND embedding IS NULL
           AND embedding_attempts < $2
         ORDER BY embedding_attempts ASC, (properties->>'time') ASC
         LIMIT $3
        `,
        [opts.tenantId, opts.maxAttempts, opts.batchSize],
      );
      if (result.rows.length === 0) return stats;

      log(
        `[graph-embedding-backfill] sweep start pending=${String(result.rows.length)}`,
      );

      for (const row of result.rows) {
        stats.tried++;
        const text = `${row.user_message ?? ''}\n\n${row.assistant_answer ?? ''}`.trim();
        if (text.length === 0) {
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
