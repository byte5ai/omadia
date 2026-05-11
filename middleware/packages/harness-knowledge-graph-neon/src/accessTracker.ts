import type { Pool } from 'pg';

/**
 * @omadia/knowledge-graph-neon — AccessTracker (palaia Phase 4 / OB-73,
 * Slice B).
 *
 * In-memory accumulator that the Neon read-paths (`searchTurns`,
 * `searchTurnsByEmbedding`, `getSession`, `findEntityCapturedTurns`) call
 * via `markAccessed(externalId)` for every Turn they surface. The decay-job
 * sweep flushes the accumulator at the start of each tick — one batched
 * `UPDATE … FROM UNNEST(...)` instead of N inline writes per read.
 *
 * Why not inline-update on read?
 *   - One Turn can be touched 5+ times in a single Hybrid-Retrieval call
 *     (FTS leg, embedding leg, entity-capture leg, getSession audit).
 *     Inline UPDATE per touch = 5+ writes per read = Neon-bill nightmare.
 *   - Reads need to be fast; a write on the read-path latency-budget is
 *     not great.
 *   - Debouncing into a single batch UPDATE per sweep (60min default) is
 *     the same pattern `embedAndStoreTurn` uses for the embedding column.
 *
 * Promotion COLD→WARM happens HERE (not in the decay job) because we know
 * in this sweep which Turns were actually accessed. The decay job only
 * rotates DOWN (HOT→WARM, WARM→COLD). Promotions are a side-effect of the
 * flush UPDATE's `tier = CASE WHEN tier = 'COLD' THEN 'WARM' ELSE tier END`.
 */

export interface AccessTrackerOptions {
  /** Optional log sink. Defaults to `console.error`. */
  log?: (msg: string) => void;
}

export interface AccessTrackerFlushOptions {
  pool: Pool;
  tenantId: string;
}

export interface AccessTrackerFlushStats {
  /** Distinct Turn external_ids whose access_count was bumped. */
  flushed: number;
  /** Subset of `flushed` that were `tier='COLD'` and got promoted to WARM. */
  promotedColdToWarm: number;
  durationMs: number;
}

interface AccessEntry {
  delta: number;
  lastAccess: Date;
}

export class AccessTracker {
  private readonly map = new Map<string, AccessEntry>();
  private readonly log: (msg: string) => void;

  constructor(opts: AccessTrackerOptions = {}) {
    this.log = opts.log ?? ((msg): void => { console.error(msg); });
  }

  /**
   * Record a touch. Cheap: in-memory map insert, no I/O. Safe to call
   * multiple times for the same Turn within a request — the deltas
   * collapse into a single per-Turn count at flush-time. `null`/`undefined`
   * external IDs are ignored (defensive — read-paths shouldn't return
   * them, but a subtle Tigris/Confluence backend slip-up shouldn't crash
   * the read).
   */
  markAccessed(externalId: string | null | undefined): void {
    if (typeof externalId !== 'string' || externalId.length === 0) return;
    const existing = this.map.get(externalId);
    if (existing) {
      existing.delta += 1;
      existing.lastAccess = new Date();
    } else {
      this.map.set(externalId, { delta: 1, lastAccess: new Date() });
    }
  }

  /** Pending entries (for stats / debug). */
  pendingCount(): number {
    return this.map.size;
  }

  /**
   * Drain the tracker into one batched UPDATE. Caller (the decay job
   * handler) is responsible for invoking this BEFORE the decay-rotation
   * sweep so the freshly-touched Turns get their HOT-tier-credit before
   * the rotation thresholds are evaluated.
   *
   * Idempotent: a noop when the map is empty. On error, the in-memory
   * entries are NOT restored — we accept losing one tick's deltas rather
   * than risking double-counts on a retry-storm. Operator-monitor the
   * `[graph-access] flush failed` line if you care; matters far less than
   * preserving correctness elsewhere.
   */
  async flush(
    opts: AccessTrackerFlushOptions,
  ): Promise<AccessTrackerFlushStats> {
    const startedAt = Date.now();
    if (this.map.size === 0) {
      return { flushed: 0, promotedColdToWarm: 0, durationMs: 0 };
    }
    const entries = Array.from(this.map.entries());
    this.map.clear();

    const externalIds = entries.map(([id]) => id);
    const deltas = entries.map(([, v]) => v.delta);
    const lastAccessIso = entries.map(([, v]) => v.lastAccess.toISOString());

    try {
      // Phase 1 — count Turns that will be promoted (COLD before the
      // UPDATE). We need this number for stats; the UPDATE itself just
      // sets `tier = CASE WHEN tier = 'COLD' THEN 'WARM' ELSE tier END`.
      const coldQuery = await opts.pool.query<{ count: string }>(
        `
        SELECT COUNT(*)::text AS count
          FROM graph_nodes
         WHERE tenant_id = $1
           AND type = 'Turn'
           AND tier = 'COLD'
           AND external_id = ANY($2::text[])
        `,
        [opts.tenantId, externalIds],
      );
      const promotedColdToWarm = Number(coldQuery.rows[0]?.count ?? '0');

      // Phase 2 — batched UPDATE. UNNEST aligns the three arrays
      // pairwise; Postgres applies the UPDATE per matched row.
      const updateResult = await opts.pool.query(
        `
        UPDATE graph_nodes AS n
           SET access_count = n.access_count + u.delta,
               accessed_at  = u.last_access,
               tier         = CASE WHEN n.tier = 'COLD' THEN 'WARM' ELSE n.tier END
          FROM UNNEST($2::text[], $3::int[], $4::timestamptz[]) AS u(external_id, delta, last_access)
         WHERE n.tenant_id = $1
           AND n.external_id = u.external_id
           AND n.type = 'Turn'
        `,
        [opts.tenantId, externalIds, deltas, lastAccessIso],
      );
      const flushed = updateResult.rowCount ?? 0;
      const durationMs = Date.now() - startedAt;
      this.log(
        `[graph-access] flush done flushed=${String(flushed)} promoted=${String(promotedColdToWarm)} (${String(durationMs)}ms)`,
      );
      return { flushed, promotedColdToWarm, durationMs };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`[graph-access] flush failed: ${message}`);
      throw err;
    }
  }
}
