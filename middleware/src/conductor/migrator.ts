import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

const LEDGER_DDL = `
      CREATE TABLE IF NOT EXISTS _conductor_migrations (
        id          TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `;

/**
 * Advisory-lock coordinates. The namespace is shared by every SQL migrator
 * (4400/4401 belong to the knowledge-graph embedding registry and the stale-vector
 * clear); the second key is `hashtext(<ledger table>)`, so each subsystem serialises
 * against its own replicas only and never against a different subsystem's migrations.
 */
const LOCK_NS_MIGRATIONS = 4_410;
const LOCK_KEY = '_conductor_migrations';

/**
 * How long a replica waits for the migration lock before giving up. Held at the same
 * 2s ceiling as the migrators that run inside a plugin `activate()` (which
 * `ToolPluginRuntime` hard-caps at 10s) so the bound is one number across all eight
 * rather than eight numbers to reason about. Exported so the budget can be asserted
 * in a test instead of trusted in a comment.
 */
export const CONDUCTOR_MIGRATION_LOCK_WAIT_MS = 2_000;
const LOCK_POLL_MS = 100;

/**
 * Apply pending Conductor SQL migrations against the shared Postgres pool.
 * Tracking lives in `_conductor_migrations`, independent of the other
 * subsystem migrators. Mirrors `runAuthMigrations` line for line so the
 * migrators stay diff-comparable.
 *
 * Idempotent: each file runs in its own transaction, recorded only on commit.
 *
 * Concurrency: read-ledger → filter → apply is not safe on its own. Two replicas
 * booting together both see the same pending list and both execute it; `IF NOT
 * EXISTS` hides that, `ADD CONSTRAINT` does not (42710 → the loser's boot fails).
 * So the apply loop runs under a session-scoped advisory lock, taken with
 * `pg_try_advisory_lock` (never the blocking variant — an unbounded server-side wait
 * inside a 10s `activate()` would turn a rare race into a deterministic boot failure)
 * and only after the ledger says there is work to do, so the steady-state boot takes
 * no lock at all.
 */
export async function runConductorMigrations(
  pool: Pool,
  log: (msg: string) => void = () => undefined,
): Promise<void> {
  const client = await pool.connect();
  // Tracks whether THIS session provably holds the advisory lock. It is the only
  // input to `client.release()` below: a connection that cannot prove it released
  // the lock is destroyed rather than pooled, because ending the session is the
  // only other way a session-scoped lock goes away.
  let lockHeld = false;
  try {
    await ensureLedger(client);

    // Ledger first, lock second. The overwhelmingly common boot has nothing pending,
    // and that boot must not pay for — or queue behind — a lock.
    let pending = await pendingMigrations(client);
    if (pending.length === 0) return;

    const deadline = Date.now() + CONDUCTOR_MIGRATION_LOCK_WAIT_MS;
    for (;;) {
      lockHeld = await tryAcquireMigrationLock(client);
      if (lockHeld) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(LOCK_POLL_MS, remaining));
    }

    if (!lockHeld) {
      // Never a silent skip: re-read the ledger. If the holder finished while we
      // waited, this replica's schema IS current and the boot continues.
      pending = await pendingMigrations(client);
      if (pending.length === 0) {
        log('[conductor] migrations applied by another replica while waiting');
        return;
      }
      // Otherwise the work is genuinely still owed. Failing loudly is the only honest
      // option; the message says "timed out" deliberately, so
      // `bootstrap.retryErroredPlugins` classifies it as transient and re-attempts
      // activation instead of latching the plugin `errored`.
      throw new Error(
        `[conductor] timed out after ${String(CONDUCTOR_MIGRATION_LOCK_WAIT_MS)}ms waiting for the ${LOCK_KEY} advisory lock; ` +
          `${String(pending.length)} migration(s) still pending (${pending.join(', ')}) — another replica is mid-migration, retry the boot`,
      );
    }

    // Re-read UNDER the lock. The pre-lock read is a fast path, not a decision: the
    // replica we queued behind may have applied part or all of that list before it
    // released.
    pending = await pendingMigrations(client);

    for (const file of pending) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      log(`[conductor] applying migration ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _conductor_migrations (id) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    // Unlock on the success path only, and inside `try` — never in `finally`. In
    // `finally` it would run on a possibly half-open connection whose pool sets no
    // `statement_timeout`, so it could hang the release indefinitely, and an unlock
    // that throws there would replace the original migration error. On the failure
    // path `lockHeld` stays true and the connection is destroyed instead, which
    // releases the lock with the session.
    if (await releaseMigrationLock(client)) lockHeld = false;
  } finally {
    client.release(lockHeld);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `CREATE TABLE IF NOT EXISTS` is not atomic against a concurrent `CREATE TABLE` of
 * the same name: the existence check and the catalog insert are separate steps, so
 * two replicas booting together can both pass the check and the loser fails with
 * 42P07 (duplicate_table) or 23505 (a unique violation on a system catalog index).
 * The table exists either way, so one retry settles it — the second attempt takes
 * the IF NOT EXISTS short-circuit. This runs outside any transaction, so the failed
 * statement leaves nothing to roll back.
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
 * The ledger read, expressed as the list of files still owed. Called twice on the
 * locking path — once before the lock and once after acquiring it.
 */
async function pendingMigrations(client: PoolClient): Promise<string[]> {
  const applied = new Set(
    (await client.query<{ id: string }>('SELECT id FROM _conductor_migrations')).rows.map(
      (r) => r.id,
    ),
  );

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

  return files.filter((f) => !applied.has(f));
}

/**
 * Take the migration lock without ever blocking the backend, and REPORT whether it
 * was taken. The boolean is the whole point: a caller that cannot distinguish
 * "acquired" from "someone else holds it" cannot release anything either.
 */
async function tryAcquireMigrationLock(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock($1::int, hashtext($2)::int) AS locked',
    [LOCK_NS_MIGRATIONS, LOCK_KEY],
  );
  // A fake/limited driver that does not model advisory locks returns no row; treat
  // that as acquired so unit tests still exercise the migrations. Mirrors
  // `tryAcquireRegistryLock` in @omadia/knowledge-graph-neon.
  const row = result.rows[0];
  return row === undefined || row.locked !== false;
}

/**
 * Release the session lock, and REPORT whether it actually went. `false` is what
 * makes the caller destroy the connection instead of pooling it — the only other way
 * a session-scoped lock is released. Swallowing the answer hands a connection that
 * may still hold the lock back to the pool, where it blocks every later replica's
 * migration for the connection's lifetime.
 */
async function releaseMigrationLock(client: PoolClient): Promise<boolean> {
  try {
    const result = await client.query<{ unlocked: boolean }>(
      'SELECT pg_advisory_unlock($1::int, hashtext($2)::int) AS unlocked',
      [LOCK_NS_MIGRATIONS, LOCK_KEY],
    );
    // "No row" mirrors the acquire side: a driver that does not model advisory locks
    // never took one, so nothing is leaked by pooling the connection.
    const row = result.rows[0];
    return row === undefined || row.unlocked !== false;
  } catch {
    return false;
  }
}
