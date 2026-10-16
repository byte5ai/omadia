import { Pool } from 'pg';

import { isTransientDbError, scramOnlyPoolOptions } from '@omadia/knowledge-graph-neon';
import { runMultiOrchestratorMigrations } from '@omadia/orchestrator';

/**
 * Core's own base schema, applied by core (#796, epic #470 C9 / G3).
 *
 * WHAT WAS WRONG
 * --------------
 * `middleware/migrations/` is a core-owned directory — 47 files, including
 * `0046_plugin_public_path_grants.sql` (C4's operator-consent table for
 * plugin public paths) and `0047_plugin_sql_grants.sql` (C7's operator-consent
 * table for plugin SQL access). Its only production caller was the
 * harness-orchestrator plugin's `activate()`, several hundred lines after an
 * early return:
 *
 *     const provider = await resolveLlmProvider(...);
 *     if (!provider) return { async close() {...} };   // <- ledger never runs
 *
 * So on a deployment with no LLM provider key, core had no schema. Not a
 * degraded one — none. `_multi_orchestrator_migrations` did not exist,
 * neither grant table existed, and recording either consent was structurally
 * impossible. The failure was silent by construction: nothing logged a
 * migration error because no migration was ever attempted.
 *
 * THE RULE
 * --------
 * Core's schema is core's responsibility, and it cannot be conditional on a
 * plugin choosing to activate, let alone on a credential unrelated to it.
 * This runs at boot, before any tool plugin activates, whatever the provider
 * configuration is.
 *
 * WHY ITS OWN POOL
 * ----------------
 * `graphPool` is published into the service registry by the knowledge-graph
 * plugin during `activateAllInstalled()` — i.e. after the point where these
 * tables must already exist, since the SQL-grant gate reads a grant row while
 * building each plugin's context. Waiting for that pool would reintroduce the
 * same defect one layer up: core's schema depending on a plugin. So core opens
 * a small, short-lived connection of its own from `DATABASE_URL`, applies the
 * ledger, and closes it. Two connections for a few hundred milliseconds at
 * boot is the entire cost.
 *
 * IDEMPOTENCE
 * -----------
 * `runMultiOrchestratorMigrations` reads its ledger first and takes the
 * `_multi_orchestrator_migrations` advisory lock only when there is work owed,
 * so the steady-state boot is one SELECT and the orchestrator's own later call
 * is a no-op second pass. Multiple replicas booting together serialise on the
 * same lock they always did.
 *
 * LOCK CONTENTION
 * ---------------
 * The migrator gives up on the advisory lock after
 * `MULTI_ORCH_MIGRATION_LOCK_WAIT_MS` (2s) and throws. That budget was sized
 * for its ORIGINAL call site — inside the orchestrator plugin's `activate()`,
 * which `ToolPluginRuntime` hard-caps at 10s, and where the throw was caught
 * per-plugin: `activateAllInstalled` logged it, marked that one plugin
 * errored, and boot continued. The wording ("timed out") was even chosen so
 * `bootstrap.retryErroredPlugins` would classify it as transient and
 * re-attempt on the next boot.
 *
 * Here there is no such catch: this runs at top level in `main()`, so an
 * escaping throw becomes `process.exit(1)`. Moving the call without moving
 * that assumption would convert a survivable, self-healing lock race into a
 * boot crash — a cold multi-replica boot has 47 files to apply, and "the
 * winner finishes inside 2s" is not a contract anyone can offer.
 *
 * So contention specifically is retried here, up to
 * {@link LOCK_CONTENTION_TOTAL_WAIT_MS}. Each attempt re-enters the migrator,
 * which re-reads the ledger — so once the winner commits, the next attempt
 * takes the migrator's own "applied by another replica while waiting" path and
 * returns clean. Every other error still propagates on its first occurrence:
 * core without its schema must fail loudly, which is the entire point of #796.
 *
 * POSTGRES NOT REACHABLE YET (#1386)
 * ----------------------------------
 * This is the first thing in boot that talks to Postgres, so it is the call
 * that meets a database which is not up yet: `docker compose restart`, a
 * restart-policy restart, a stack outside Compose, or the DNS-alias race on a
 * fresh `up`. It used to rethrow `ENOTFOUND`/`ECONNREFUSED` at once, and the
 * process crash-looped until Postgres answered — on a platform with restart
 * backoff (Kubernetes `CrashLoopBackOff`) that kept the middleware down for
 * minutes after the database was back. The knowledge-graph plugin's
 * `waitForPostgres` already rode out this race, but only when it activates,
 * long after this point.
 *
 * So a transient connection error (the same predicate `waitForPostgres` uses,
 * `isTransientDbError`) is now retried here with capped exponential backoff,
 * for up to {@link DATABASE_WAIT_TOTAL_MS}, with one "waiting for Postgres"
 * log line per attempt. Past that budget the error propagates and the process
 * exits, exactly as before. Auth failures and a missing database are not
 * transient and still fail on the first attempt.
 *
 * The HTTP listener is not up during this wait (it binds at the end of
 * `main()`), so health checks see "not answering yet" rather than "degraded".
 * Each connect attempt is capped at {@link BOOT_CONNECT_TIMEOUT_MS}, so the
 * budget holds against a host that never answers.
 * The budget is sized to stay inside the shipped Compose healthcheck's
 * `start_period` (90 s); Fly's `/health` check does not restart a machine,
 * it only keeps traffic and a deploy waiting.
 */

/** Outcome of a boot-time core-migration run. Returned rather than logged-only
 *  so callers (and tests) can assert which branch was taken. */
export type CoreMigrationsOutcome =
  /** No `DATABASE_URL` — the in-memory backend is in use and there is no
   *  database to migrate. Not an error: tests and zero-config dev boot here. */
  | 'no-database'
  /** The ledger is current, whether this call applied files or found none. */
  | 'applied';

export interface CoreMigrationsOptions {
  /** Postgres connection string. Omit / leave empty to skip. */
  readonly databaseUrl?: string | undefined;
  /** Where progress goes. Defaults to a no-op so tests stay quiet. */
  readonly log?: ((msg: string) => void) | undefined;
  /**
   * Pool factory seam. Defaults to a real `pg.Pool`; overridden in tests that
   * want to hand in a pool against a scratch database without going through
   * the environment.
   */
  readonly createPool?: ((connectionString: string) => Pool) | undefined;
  /**
   * Migration-runner seam. Defaults to the real
   * `runMultiOrchestratorMigrations`; overridden in tests that need to drive
   * the lock-contention retry without racing two real boots against one
   * database.
   */
  readonly runMigrations?:
    | ((pool: Pool, log: (msg: string) => void) => Promise<void>)
    | undefined;
  /** How long to wait for an unreachable Postgres (#1386). Tests shrink it. */
  readonly databaseWaitMs?: number | undefined;
  /** Delay seam, so tests can drive the backoff without real waiting. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

/**
 * How long boot keeps re-attempting while another replica holds the migration
 * lock. Generous on purpose: the cost of waiting is a slower boot, the cost of
 * giving up early is a crash loop that competes with the replica actually
 * making progress. Past this, the migrator's own error propagates unchanged.
 */
const LOCK_CONTENTION_TOTAL_WAIT_MS = 60_000;
/** Pause between attempts. The migrator already spends its own 2s inside each
 *  attempt waiting on the lock, so this only spaces the retries out. */
const LOCK_CONTENTION_RETRY_DELAY_MS = 500;

/**
 * Does this error mean "another replica is mid-migration" rather than "the
 * migration is broken"? Matched on the migrator's message because it exports
 * no error type — and pinned by `coreMigrationsBootWiring.test.ts`, which
 * reads `migrator.ts` and fails if that phrase stops being produced. Only
 * contention is retryable; a failed SQL file must surface on attempt one.
 */
function isLockContentionError(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message.includes(
      'waiting for the _multi_orchestrator_migrations advisory lock',
    )
  );
}

/**
 * How long boot waits for a Postgres that is not reachable yet (#1386).
 * Below the shipped Compose healthcheck's 90 s `start_period`, so a database
 * that comes up inside the window never costs the container its health.
 */
const DATABASE_WAIT_TOTAL_MS = 60_000;
/** First pause after a failed connection; doubles up to the cap below. */
const DATABASE_WAIT_INITIAL_DELAY_MS = 500;
const DATABASE_WAIT_MAX_DELAY_MS = 5_000;
/** Per-attempt connect ceiling for the boot pool, so the wait budget holds. */
const BOOT_CONNECT_TIMEOUT_MS = 5_000;

function describeDbError(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  return typeof code === 'string' && !message.includes(code)
    ? `${code}: ${message}`
    : message;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

export async function runCoreMigrations(
  opts: CoreMigrationsOptions = {},
): Promise<CoreMigrationsOutcome> {
  const databaseUrl = opts.databaseUrl?.trim();
  const log = opts.log ?? ((): void => undefined);
  if (!databaseUrl) return 'no-database';

  const createPool =
    opts.createPool ??
    ((connectionString: string): Pool =>
      // Two connections is enough: the migrator uses exactly one, and the
      // spare keeps a transient checkout failure from stalling boot. The pool
      // is closed before boot continues, so it never competes with the
      // long-lived pools plugins open later. SCRAM-only when the process
      // requires it, like the graph pool (`createNeonPool`).
      //
      // #1386 — a bounded connect, so one attempt against a blackholed host
      // cannot sit in the OS TCP timeout (75 s+) and blow the wait budget.
      // The SCRAM options, when present, set their own value and win.
      new Pool({
        connectionString,
        max: 2,
        idleTimeoutMillis: 1_000,
        connectionTimeoutMillis: BOOT_CONNECT_TIMEOUT_MS,
        ...scramOnlyPoolOptions(),
      }));

  const runMigrations = opts.runMigrations ?? runMultiOrchestratorMigrations;

  const pause = opts.sleep ?? sleep;
  const pool = createPool(databaseUrl);
  // The two budgets are independent on purpose: a slow Postgres start must not
  // eat the time a lock race is owed. So the lock budget starts at the FIRST
  // contention, not at function entry — after a database restart every replica
  // waits for Postgres and then races for the lock at the same moment.
  let lockDeadline: number | undefined;
  const databaseDeadline = Date.now() + (opts.databaseWaitMs ?? DATABASE_WAIT_TOTAL_MS);
  let databaseDelay = DATABASE_WAIT_INITIAL_DELAY_MS;
  try {
    for (;;) {
      try {
        await runMigrations(pool, log);
        return 'applied';
      } catch (err) {
        if (isTransientDbError(err)) {
          const remaining = databaseDeadline - Date.now();
          if (remaining <= 0) throw err;
          const wait = Math.min(databaseDelay, remaining);
          log(
            `[middleware] waiting for Postgres (${describeDbError(err)}) — retrying in ` +
              `${String(wait)}ms, giving up in ${String(Math.ceil(remaining / 1_000))}s`,
          );
          await pause(wait);
          databaseDelay = Math.min(databaseDelay * 2, DATABASE_WAIT_MAX_DELAY_MS);
          continue;
        }
        if (!isLockContentionError(err)) throw err;
        lockDeadline ??= Date.now() + LOCK_CONTENTION_TOTAL_WAIT_MS;
        const remaining = lockDeadline - Date.now();
        if (remaining <= 0) throw err;
        log(
          '[middleware] core migrations: another replica holds the migration lock — ' +
            `retrying for up to ${String(Math.ceil(remaining / 1_000))}s`,
        );
        await pause(Math.min(LOCK_CONTENTION_RETRY_DELAY_MS, remaining));
      }
    }
  } finally {
    // `end()` must not mask a migration failure, and must not itself fail the
    // boot: the migrations are already committed by the time we get here.
    await pool.end().catch(() => undefined);
  }
}
