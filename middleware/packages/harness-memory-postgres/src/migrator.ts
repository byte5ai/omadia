import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  'migrations',
);

const LEDGER_DDL = `
      CREATE TABLE IF NOT EXISTS _memory_migrations (
        id          TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `;

/**
 * Advisory-lock coordinates. The namespace is shared by every SQL migrator
 * (4400/4401 belong to the knowledge-graph embedding registry and the
 * stale-vector clear); the second key is `hashtext(<ledger table>)`, so each
 * subsystem serialises against its own replicas only and never against a
 * different subsystem's migrations.
 */
const LOCK_NS_MIGRATIONS = 4_410;
const LOCK_KEY = '_memory_migrations';

/**
 * How long a replica waits for the migration lock before giving up. This
 * migrator runs inside `activate()`, which `ToolPluginRuntime` hard-caps at
 * 10s, so the wait has to be bounded well inside that — hence
 * a `lock_timeout` on the wait: an unbounded one would make a concurrent boot
 * a deterministic activation timeout. Exported so the budget can be asserted in a test
 * instead of trusted in a comment.
 */
export const MEMORY_MIGRATION_LOCK_WAIT_MS = 2_000;

/**
 * Applies the memory-store schema migrations against the shared graphPool.
 *
 * Mirrors @omadia/knowledge-graph-neon's `runGraphMigrations`: a dedicated
 * `_memory_migrations` tracking table records which `.sql` files (sorted by
 * name) have already run; each unapplied file executes inside its own
 * transaction. Safe to call on every activate() — already-applied migrations
 * are skipped.
 *
 * Concurrency: read-ledger → filter → apply is not safe on its own. Two
 * replicas booting together both see the same pending list and both execute
 * it; `IF NOT EXISTS` hides that, `ADD CONSTRAINT` does not (42710 → the
 * loser's boot fails). Every file is therefore applied in a transaction that first takes a
 * TRANSACTION-scoped advisory lock (`pg_advisory_xact_lock`, bounded by
 * `lock_timeout`) and re-reads the ledger under it. Transaction-scoped on
 * purpose: a session-level lock breaks behind a transaction-mode connection
 * pooler, see the comment at the lock. The lock is taken only after the
 * ledger says there is work to do, so the steady-state boot takes no lock at
 * all.
 */
export async function runMemoryMigrations(
  pool: Pool,
  log: (msg: string) => void = () => undefined,
): Promise<void> {
  const client = await pool.connect();
  // `true` only when a ROLLBACK itself failed: the connection is then in an
  // unknown state and is destroyed rather than pooled. A lock never needs it:
  // the migration lock is transaction-scoped and ends with COMMIT or ROLLBACK.
  let broken = false;
  try {
    await ensureLedger(client);

    // Ledger first, lock second. The overwhelmingly common boot has nothing
    // pending, and that boot must not pay for — or queue behind — a lock.
    const pending = await pendingMigrations(client);
    if (pending.length === 0) return;

    for (const file of pending) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        // The lock lives and dies with THIS transaction. A session-level
        // advisory lock does not survive a transaction-mode connection pooler
        // (PgBouncer, Neon's `-pooler` host): there every statement outside a
        // transaction may run on another server session, so the lock would be
        // taken on one session and "released" on another, and stay held by a
        // session nobody owns. Inside a transaction the pooler pins one
        // server session, and COMMIT / ROLLBACK release the lock on it.
        //
        // The wait is bounded by `lock_timeout` instead of a poll loop; it is
        // put back to the session default once the lock is held, so the
        // migration's own DDL waits exactly as it did before.
        await client.query(
          `SET LOCAL lock_timeout = '${String(MEMORY_MIGRATION_LOCK_WAIT_MS)}ms'`,
        );
        await client.query(
          'SELECT pg_advisory_xact_lock($1::int, hashtext($2)::int)',
          [LOCK_NS_MIGRATIONS, LOCK_KEY],
        );
        await client.query('SET LOCAL lock_timeout = DEFAULT');
        // Re-read UNDER the lock. The pre-lock read is a fast path, not a
        // decision: the replica we queued behind may have applied this file.
        const applied = await client.query(
          'SELECT 1 FROM _memory_migrations WHERE id = $1',
          [file],
        );
        if (applied.rows.length > 0) {
          await client.query('ROLLBACK');
          continue;
        }
        log(`[memory-pg] applying migration ${file}`);
        await client.query(sql);
        await client.query(
          'INSERT INTO _memory_migrations (id) VALUES ($1)',
          [file],
        );
        await client.query('COMMIT');
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          broken = true;
        }
        if (!isLockTimeout(err)) throw err;
        // Never a silent skip: re-read the ledger. If the holder finished
        // while we waited, this replica's schema IS current and the boot
        // continues.
        const stillPending = broken ? [file] : await pendingMigrations(client);
        if (stillPending.length === 0) {
          log('[memory-pg] migrations applied by another replica while waiting');
          return;
        }
        // Otherwise the work is genuinely still owed. Failing loudly is the
        // only honest option; the message says "timed out" deliberately, so
        // `bootstrap.retryErroredPlugins` classifies it as transient and
        // re-attempts activation instead of latching the plugin `errored`.
        throw new Error(
          `[memory-pg] timed out after ${String(MEMORY_MIGRATION_LOCK_WAIT_MS)}ms waiting for the ${LOCK_KEY} advisory lock; ` +
            `${String(stillPending.length)} migration(s) still pending (${stillPending.join(', ')}) — another replica is mid-migration, retry the boot`,
          { cause: err },
        );
      }
    }
  } finally {
    client.release(broken);
  }
}

/**
 * `CREATE TABLE IF NOT EXISTS` is not atomic against a concurrent `CREATE
 * TABLE` of the same name: the existence check and the catalog insert are
 * separate steps, so two replicas booting together can both pass the check and
 * the loser fails with 42P07 (duplicate_table) or 23505 (a unique violation on
 * a system catalog index). The table exists either way, so one retry settles
 * it — the second attempt takes the IF NOT EXISTS short-circuit. This runs
 * outside any transaction, so the failed statement leaves nothing to roll back.
 */
async function ensureLedger(client: PoolClient): Promise<void> {
  try {
    await client.query(LEDGER_DDL);
  } catch (err) {
    if (!isDuplicateObjectError(err)) throw err;
    await client.query(LEDGER_DDL);
  }
}

function isDuplicateObjectError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === '42P07' || code === '23505';
}

/**
 * The ledger read, expressed as the list of files still owed. Called twice on
 * the locking path — once before the lock and once after acquiring it.
 */
async function pendingMigrations(client: PoolClient): Promise<string[]> {
  const applied = new Set(
    (
      await client.query<{ id: string }>(
        'SELECT id FROM _memory_migrations',
      )
    ).rows.map((r) => r.id),
  );

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  return files.filter((f) => !applied.has(f));
}

/** `lock_timeout` expired while waiting for the migration lock (55P03,
 *  lock_not_available): another replica holds it. */
function isLockTimeout(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === '55P03';
}
