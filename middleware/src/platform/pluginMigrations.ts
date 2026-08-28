/**
 * Shared migration runner for plugin-owned schema. Epic #470, item C7 / G4.
 *
 * WHY THIS IS SHARED AND NOT COPIED
 * ---------------------------------
 * `implementation.md` B3 recorded the failure mode this exists to prevent: the
 * core migrators were each an independent read-ledger → filter → apply loop
 * with no lock, so two replicas booting together both read an empty ledger and
 * both executed. `IF NOT EXISTS` hides that; `ADD CONSTRAINT` does not, and
 * migration 0025 turned it into a hard boot failure (42710). Those were fixed
 * one at a time. Handing plugin authors a documented pattern to copy would
 * have recreated the same bug once per plugin, in code the operator cannot
 * patch, and each copy would have to be found and fixed separately.
 *
 * So there is one runner. A plugin calls `ctx.sql.runMigrations()` and gets
 * the locking, the ledger, the checksums and the ordering for free — and
 * cannot opt out of any of them.
 *
 * THE LOCK
 * --------
 * `pg_advisory_xact_lock`, taken inside the transaction that applies the
 * files, keyed on `hashtext(<ledger>)` under a namespace reserved for plugins.
 * Three deliberate choices:
 *
 *   - **Transaction-scoped, not session-scoped.** The lock is released by
 *     COMMIT or ROLLBACK, including the rollback the server performs when a
 *     connection dies. The session-scoped variant the core migrators use needs
 *     a careful release-or-destroy dance (see `conductor/migrator.ts`) exactly
 *     because a leaked session lock outlives the failure that caused it and
 *     blocks every later replica for the connection's lifetime. Nothing here
 *     needs the lock to outlive the transaction, so it does not take one that
 *     can.
 *
 *   - **One transaction for the whole batch, not one per file.** A plugin's
 *     migrations are a unit: a batch that half-applies leaves the plugin's
 *     tables in a state no file in the directory describes. Core migrators
 *     commit per file because their ledgers span years of history where
 *     re-running the whole batch is not an option; a plugin's directory is
 *     small and young enough that all-or-nothing is strictly better.
 *
 *   - **`lock_timeout`, not `pg_try_advisory_lock` with a poll loop.** The
 *     blocking variant with a bounded server-side timeout expresses "wait, but
 *     not forever" in one statement and yields the exact same guarantee the
 *     poll loop was written to provide, without the loop. The unbounded wait
 *     the core migrators rightly avoid is the one WITHOUT a timeout — that is
 *     the part that would turn a rare race into a deterministic failure inside
 *     `ToolPluginRuntime`'s 10s activate budget.
 *
 * A DIFFERENT NAMESPACE FROM CORE
 * -------------------------------
 * Core migrators share advisory namespace 4410 and key on `hashtext(<their
 * ledger>)`. Plugins get their own namespace, so a plugin whose ledger happens
 * to hash to the same int as `_conductor_migrations` cannot block core's boot
 * migrations. Ledger names are plugin-supplied; a shared namespace would make
 * a hash collision an availability lever a plugin could pull.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { SqlMigrationError, type MigrationReport } from '@omadia/plugin-api';
import type { Pool, PoolClient } from 'pg';

import { assertLedgerName } from './pluginSqlGrants.js';

/** Advisory-lock namespace reserved for plugin migrations. Distinct from
 *  core's 4410 — see the file header. */
export const PLUGIN_MIGRATION_LOCK_NS = 4_420;

/**
 * How long a replica waits for another replica's plugin migration before
 * giving up. Held at the same 2s ceiling as the core migrators so the bound
 * is one number across the system, and comfortably inside `ToolPluginRuntime`'s
 * 10s `activate()` cap. Exported so a test can assert the budget rather than
 * trust this comment.
 */
export const PLUGIN_MIGRATION_LOCK_WAIT_MS = 2_000;

/**
 * How long any ONE statement inside a plugin's migration batch may run.
 *
 * `lock_timeout` bounds only how long we wait to ACQUIRE a lock; it says
 * nothing about how long a statement that already holds its locks may execute.
 * Without this, a migration containing a slow backfill — or a plugin that
 * simply ships `SELECT pg_sleep(...)` — blocks middleware boot indefinitely,
 * because this runner is awaited before the plugin's `activate()` is even
 * called.
 *
 * 30s rather than the lock's 2s: waiting on a peer replica should give up
 * fast, but a genuine `CREATE INDEX` or a backfill over a real table is
 * legitimately slower than that, and a bound that fails honest schema work
 * would just push authors to migrate outside the runner where nothing is
 * serialised. Exported so a test asserts the budget instead of trusting this
 * comment.
 */
export const PLUGIN_MIGRATION_STATEMENT_TIMEOUT_MS = 30_000;

/**
 * Postgres SQLSTATEs for the two budgets above, mapped so a contention or
 * runaway-statement condition reaches the caller as a typed
 * {@link SqlMigrationError} rather than a bare `pg` error. Blaming the plugin
 * for "55P03" in an activation log sends the operator to the wrong place: the
 * usual cause is another replica holding the lock, which is not a fault at all.
 */
const LOCK_TIMEOUT_SQLSTATE = '55P03';
const STATEMENT_TIMEOUT_SQLSTATE = '57014';

/** Extensions the runner will execute, in the order `sort()` puts them —
 *  which is filename order, not extension order. */
const MIGRATION_EXTENSIONS = ['.sql', '.js', '.mjs'] as const;

export interface RunPluginMigrationsOptions {
  readonly pool: Pool;
  /** Kernel-known plugin id. Used for ledger-ownership validation and error
   *  attribution — never supplied by the plugin itself. */
  readonly pluginId: string;
  /** Plugin-owned ledger table. Re-validated here even though the manifest
   *  loader already checked it: this function is exported and a future caller
   *  may not have come through the loader. */
  readonly ledger: string;
  /** Absolute path to the directory holding the migration files. Containment
   *  inside the package root is the caller's job (`pluginContext.ts` does it);
   *  by the time a path reaches here it is trusted. */
  readonly dir: string;
  /** Accept a file whose bytes changed after it was applied. Off by default —
   *  see `RunMigrationsOptions.allowChecksumDrift`. */
  readonly allowChecksumDrift?: boolean;
  readonly log?: (msg: string) => void;
}

/**
 * Apply every pending migration in `dir` under the ledger's advisory lock.
 *
 * Returns a {@link MigrationReport}; throws {@link SqlMigrationError} for the
 * two conditions where a plugin package is internally inconsistent (empty or
 * unreadable directory, checksum drift on an applied file) and re-throws
 * anything Postgres raises.
 */
export async function runPluginMigrations(
  opts: RunPluginMigrationsOptions,
): Promise<MigrationReport> {
  const { pool, pluginId, dir, allowChecksumDrift = false } = opts;
  const log = opts.log ?? (() => undefined);
  const startedAt = Date.now();

  // Validate before anything touches the database. A bad ledger name must not
  // reach `quoteIdentifier`, and a plugin whose manifest is wrong should learn
  // that without having consumed a connection from the operator's pool.
  const ledger = assertLedgerName(pluginId, opts.ledger);

  const files = await listMigrationFiles(dir, pluginId, ledger);

  // An empty directory is a MISCONFIGURATION, not a no-op, and this is the one
  // place it can still be caught cheaply. A plugin that declares
  // `permissions.sql.migrations` is asserting it ships schema; a directory with
  // nothing in it means the build dropped the files (the ZIP extension
  // allowlist rejected them, the codegen step did not run, the path in the
  // manifest is a typo). Returning "0 applied, all good" would let the plugin
  // activate and then fail later against tables that were never created — at
  // which point the cause is several layers away from the symptom.
  if (files.length === 0) {
    throw new SqlMigrationError(
      pluginId,
      ledger,
      `migrations directory '${dir}' contains no ${MIGRATION_EXTENSIONS.join(' / ')} files — ` +
        'a declared migrations directory that ships nothing is a packaging failure, not an empty changeset',
    );
  }

  // Hash every file BEFORE opening the transaction. Reading from disk while
  // holding the lock would extend the critical section by an I/O wait that has
  // nothing to do with the database.
  const sources = new Map<string, { text: string; checksum: string }>();
  for (const file of files) {
    const text = await readFile(join(dir, file), 'utf8');
    sources.set(file, { text, checksum: migrationChecksum(text) });
  }

  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await client.query('BEGIN');
    try {
      // Bound the wait inside this transaction only. `SET LOCAL` reverts at
      // COMMIT/ROLLBACK, so a pooled connection is never handed back carrying
      // a modified timeout — the failure mode that makes session-level `SET`
      // in a pooled application so hard to reason about.
      await client.query(
        `SET LOCAL lock_timeout = '${String(PLUGIN_MIGRATION_LOCK_WAIT_MS)}ms'`,
      );
      // `lock_timeout` bounds only lock ACQUISITION. Without a statement
      // budget as well, a migration that acquires its locks and then runs
      // forever holds the advisory lock for as long as it likes and blocks
      // boot — for this replica and, through the lock, for every other one.
      await client.query(
        `SET LOCAL statement_timeout = '${String(PLUGIN_MIGRATION_STATEMENT_TIMEOUT_MS)}ms'`,
      );
      await client.query(
        'SELECT pg_advisory_xact_lock($1::int, hashtext($2)::int)',
        [PLUGIN_MIGRATION_LOCK_NS, ledger],
      );

      // Everything below runs under the lock: ledger creation, the ledger
      // read, and the applies. Creating the ledger before taking the lock
      // would reintroduce the `CREATE TABLE IF NOT EXISTS` race (42P07) the
      // core migrators had to special-case, because the check and the catalog
      // insert are separate steps.
      await client.query(pluginLedgerDdl(ledger));
      const alreadyApplied = await readLedger(client, ledger);

      for (const file of files) {
        const source = sources.get(file);
        /* c8 ignore next -- populated in the loop directly above */
        if (!source) continue;
        const previous = alreadyApplied.get(file);

        if (previous !== undefined) {
          if (previous !== source.checksum && !allowChecksumDrift) {
            throw new SqlMigrationError(
              pluginId,
              ledger,
              `migration '${file}' was already applied with checksum ${previous.slice(0, 12)}… but the package now ships ${source.checksum.slice(0, 12)}… — ` +
                'the database and the package disagree about what ran. Ship the change as a NEW file, or pass allowChecksumDrift when the edit is provably cosmetic',
            );
          }
          skipped.push(file);
          continue;
        }

        log(`[sql] ${pluginId}: applying migration ${file}`);
        await applyOne(client, dir, file, source.text);
        await client.query(
          `INSERT INTO ${quoteIdentifier(ledger)} (filename, checksum) VALUES ($1, $2)`,
          [file, source.checksum],
        );
        applied.push(file);
      }

      await client.query('COMMIT');
    } catch (err) {
      // ROLLBACK also releases the advisory lock — that is the whole reason
      // this uses the xact-scoped variant. Its own failure must not replace
      // the error that caused the rollback.
      await client.query('ROLLBACK').catch(() => undefined);
      throw asMigrationError(err, pluginId, ledger);
    }
  } finally {
    client.release();
  }

  return {
    applied,
    skipped,
    ledger,
    durationMs: Date.now() - startedAt,
  };
}

/** Read the directory and return the migration files in filename order.
 *  A missing/unreadable directory is reported as the packaging failure it is,
 *  not as an empty list. Exported so the C11 handoff seeder hashes exactly the
 *  set of files this runner would execute. */
export async function listMigrationFiles(
  dir: string,
  pluginId: string,
  ledger: string,
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    throw new SqlMigrationError(
      pluginId,
      ledger,
      `migrations directory '${dir}' is not readable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return entries
    .filter((f) => MIGRATION_EXTENSIONS.some((ext) => f.endsWith(ext)))
    .sort();
}

/**
 * Execute one migration file against the open transaction.
 *
 * `.sql` runs verbatim. `.js` / `.mjs` must default-export an
 * `async (client) => {}` and receive the SAME client, so a JS migration is
 * inside the same transaction and under the same lock as an SQL one — the
 * codegen path in `implementation.md` D6 must not be a weaker path.
 */
async function applyOne(
  client: PoolClient,
  dir: string,
  file: string,
  text: string,
): Promise<void> {
  if (file.endsWith('.sql')) {
    await client.query(text);
    return;
  }
  const mod = (await import(pathToFileURL(join(dir, file)).href)) as {
    default?: unknown;
  };
  const run = mod.default;
  if (typeof run !== 'function') {
    throw new Error(
      `migration '${file}' must \`export default async (client) => { … }\` — got ${typeof run}`,
    );
  }
  await (run as (c: PoolClient) => Promise<void>)(client);
}

/** filename → checksum for everything the ledger already records. */
async function readLedger(
  client: PoolClient,
  ledger: string,
): Promise<Map<string, string>> {
  const result = await client.query<{ filename: string; checksum: string }>(
    `SELECT filename, checksum FROM ${quoteIdentifier(ledger)}`,
  );
  return new Map(result.rows.map((r) => [r.filename, r.checksum]));
}

/**
 * DDL for a plugin's migration ledger.
 *
 * EXPORTED because it is a CONTRACT, not an implementation detail. C11's
 * handoff seeder writes rows this runner must later read as "already applied";
 * if the two files each spelled the table out, a column added here would be
 * missing there and the seeded rows would be rejected — or worse, accepted
 * with a NULL where the runner expects a checksum. One definition, two
 * callers.
 */
export function pluginLedgerDdl(ledger: string): string {
  return `
    CREATE TABLE IF NOT EXISTS ${quoteIdentifier(ledger)} (
      filename   TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `;
}

/**
 * Quote a table name for interpolation into DDL.
 *
 * This is NOT the security boundary — `assertLedgerName` is, and it has
 * already rejected every character that could matter by the time a name gets
 * here. The quoting is the second layer: it means a future caller that
 * forgets to validate produces a syntax error rather than an injection. The
 * `"` doubling is retained for the same reason, even though a validated name
 * can never contain one.
 */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Re-type the two timeout conditions; pass everything else through untouched.
 *
 * Deliberately narrow. A blanket "wrap every pg error as SqlMigrationError"
 * would erase the distinction between a plugin shipping invalid SQL (its
 * author's problem, and the raw syntax error is the most useful thing we can
 * show) and the two conditions here, which are the operator's environment
 * rather than the package. Only the latter get re-typed.
 */
function asMigrationError(
  err: unknown,
  pluginId: string,
  ledger: string,
): unknown {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === LOCK_TIMEOUT_SQLSTATE) {
    return new SqlMigrationError(
      pluginId,
      ledger,
      `timed out after ${String(PLUGIN_MIGRATION_LOCK_WAIT_MS)}ms waiting for the migration lock on ledger '${ledger}' — ` +
        'another replica is most likely applying the same batch. This is contention, not a defect in the package; ' +
        'the next activation attempt will find the work already done and skip it',
    );
  }
  if (code === STATEMENT_TIMEOUT_SQLSTATE) {
    return new SqlMigrationError(
      pluginId,
      ledger,
      `a migration statement exceeded the ${String(PLUGIN_MIGRATION_STATEMENT_TIMEOUT_MS)}ms per-statement budget and was cancelled — ` +
        'the whole batch rolled back. Split the long-running step (a backfill, an index build over a large table) ' +
        'out of the boot-time migration path',
    );
  }
  return err;
}

/**
 * The checksum a ledger row carries.
 *
 * Exported for the same reason as {@link pluginLedgerDdl}: C11 seeds rows for
 * files it did not apply, and a seeded row whose checksum is computed
 * differently from the runner's would trip the drift guard on the very next
 * activation — turning a successful handoff into a hard activation failure one
 * boot later.
 */
export function migrationChecksum(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
