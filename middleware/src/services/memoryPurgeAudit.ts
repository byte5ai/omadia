import type { Pool } from 'pg';

/**
 * `memory_purge_audit` — one row per Danger-Zone memory purge (#1336).
 *
 * The row is written BEFORE anything is deleted (`recordStart`) and completed
 * afterwards (`recordOutcome`), the same order `adminUpdate.ts` uses: a row
 * for a purge that then failed is a recoverable annoyance, an executed purge
 * with no record is not. The route refuses the purge when `recordStart`
 * throws.
 *
 * The actor columns mirror `admin_audit` (`actor_id` = omadia user id,
 * `actor_email` = session email or sub). `actor` stays for old readers and
 * holds the same human-readable identity — never the old constant
 * `'admin-ui'`.
 *
 * The table predates the migration runner's reach (it was always created on
 * first use), so its new columns are added the same way: idempotent
 * `ADD COLUMN IF NOT EXISTS`, safe on an existing install.
 */

export interface MemoryPurgeActor {
  /** omadia user id (session `omadia_user_id`), when the session has one. */
  id?: string;
  /** Session email, else the session subject. */
  email?: string;
}

export interface MemoryPurgeCounts {
  scratch: number;
  kg: number;
  conversation: number;
}

export interface MemoryPurgeAuditStart {
  actor: MemoryPurgeActor;
  axis: string;
  selector: string | null;
  reseed: boolean;
  /** What the shared selection resolved right before the purge. */
  planned: MemoryPurgeCounts & { reseedEntries: readonly string[] };
}

/** `deleted` is always what was really removed — on a failure the layers that
 *  finished before it. `error` on a completed purge names a follow-up step
 *  that failed (the re-seed). */
export interface MemoryPurgeAuditOutcome {
  status: 'completed' | 'failed';
  deleted: MemoryPurgeCounts;
  error?: string;
}

export interface MemoryPurgeAuditStore {
  /** Write the row before the purge runs. Returns its id. Throws on failure. */
  recordStart(entry: MemoryPurgeAuditStart): Promise<string>;
  /** Complete the row after the purge ran. Throws on failure. */
  recordOutcome(id: string, outcome: MemoryPurgeAuditOutcome): Promise<void>;
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS memory_purge_audit (
     id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     actor           text NOT NULL,
     axis            text NOT NULL,
     selector        text,
     scratch_deleted integer NOT NULL,
     kg_deleted      integer NOT NULL,
     created_at      timestamptz NOT NULL DEFAULT now()
   )`,
  `ALTER TABLE memory_purge_audit
     ADD COLUMN IF NOT EXISTS actor_id text,
     ADD COLUMN IF NOT EXISTS actor_email text,
     ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'completed',
     ADD COLUMN IF NOT EXISTS reseed boolean NOT NULL DEFAULT false,
     ADD COLUMN IF NOT EXISTS conversation_deleted integer NOT NULL DEFAULT 0,
     ADD COLUMN IF NOT EXISTS planned jsonb,
     ADD COLUMN IF NOT EXISTS error text,
     ADD COLUMN IF NOT EXISTS completed_at timestamptz`,
];

export function createMemoryPurgeAuditStore(pool: Pool): MemoryPurgeAuditStore {
  let ready: Promise<void> | null = null;

  const ensureTable = (): Promise<void> => {
    if (!ready) {
      ready = (async () => {
        for (const statement of SCHEMA_STATEMENTS) await pool.query(statement);
      })().catch((err: unknown) => {
        // Reset so a transient failure (e.g. missing pgcrypto) can retry.
        ready = null;
        throw err;
      });
    }
    return ready;
  };

  return {
    async recordStart(entry) {
      await ensureTable();
      const res = await pool.query<{ id: string }>(
        `INSERT INTO memory_purge_audit
           (actor, actor_id, actor_email, axis, selector, reseed, status,
            scratch_deleted, kg_deleted, conversation_deleted, planned)
         VALUES ($1, $2, $3, $4, $5, $6, 'started', 0, 0, 0, $7)
         RETURNING id`,
        [
          entry.actor.email ?? entry.actor.id ?? 'unknown',
          entry.actor.id ?? null,
          entry.actor.email ?? null,
          entry.axis,
          entry.selector,
          entry.reseed,
          JSON.stringify(entry.planned),
        ],
      );
      const id = res.rows[0]?.id;
      if (!id) throw new Error('memory_purge_audit insert returned no id');
      return id;
    },

    async recordOutcome(id, outcome) {
      await ensureTable();
      await pool.query(
        `UPDATE memory_purge_audit
            SET status = $2, scratch_deleted = $3, kg_deleted = $4,
                conversation_deleted = $5, error = $6, completed_at = now()
          WHERE id = $1`,
        [
          id,
          outcome.status,
          outcome.deleted.scratch,
          outcome.deleted.kg,
          outcome.deleted.conversation,
          outcome.error ?? null,
        ],
      );
    },
  };
}
