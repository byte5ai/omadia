/**
 * The database steps a plugin's activation takes before `activate()` runs
 * (Epic #470 C7 / G4 / C15, ADR-0050): read the operator's `permissions.sql`
 * grant, run the declared ledger handoff, apply the declared migrations.
 *
 * Shared by the tool runtime and the channel runtime (omadia#838): a channel
 * plugin that declares `permissions.sql` (Teams) must get the same grant
 * check and the same kernel-run migrations, or ADR-0050's "one runner, run by
 * the kernel before activate()" holds for every plugin kind but channels.
 */

import type { SqlAccessor } from '@omadia/plugin-api';

import { PluginHandoffPlanError, loadHandoffPlan } from '../platform/pluginHandoffPlan.js';
import type { PluginSqlGrantStore } from '../platform/pluginSqlGrantStore.js';
import type { PluginCatalogEntry } from './manifestLoader.js';

/** What a manifest declares under `permissions.sql`, as the catalog parsed it. */
export type DeclaredSql = NonNullable<PluginCatalogEntry['plugin']['permissions_summary']['sql']>;

/**
 * Wall-clock cap on a plugin's boot-time migration batch.
 *
 * Larger than the 10s `activate()` cap because applying schema is a different
 * kind of work: an index build or a backfill on a real table is legitimately
 * slower than wiring up a plugin's handlers. It is still a cap — the point is
 * that a hung migration fails this ONE activation through the existing
 * circuit-breaker instead of hanging middleware boot for everyone.
 *
 * Sits above `PLUGIN_MIGRATION_STATEMENT_TIMEOUT_MS` (30s) on purpose: the
 * server-side budget should be what cancels a runaway statement, because it
 * cancels it *in Postgres* and rolls the batch back cleanly. This one is the
 * outer net for the case Postgres cannot see — a connection that never
 * answers at all.
 */
export const MIGRATION_TIMEOUT_MS = 60_000;

export interface ReadSqlGrantOptions {
  readonly agentId: string;
  readonly declaredSql: DeclaredSql | undefined;
  readonly sqlGrantStore: PluginSqlGrantStore | undefined;
  readonly log: (msg: string) => void;
  /** Log prefix of the calling runtime (`tool-runtime`, `channels`). */
  readonly tag: string;
}

/**
 * Whether the operator granted this plugin's `permissions.sql`. Read before
 * the context is built: `ctx.services.get` is synchronous and cannot await,
 * so this is the last point where the answer can be obtained honestly; a
 * lookup deferred into the accessor would have to guess while its cache is
 * cold, and a permission that is permissive while cold is not a permission.
 *
 * The grant must also still MATCH the manifest. An operator granted a
 * specific ledger; a package that later ships a manifest naming a different
 * one has not been granted that one, and carrying the stale row forward would
 * let a plugin update silently move its schema somewhere the operator never
 * approved.
 */
export async function readSqlGrant(opts: ReadSqlGrantOptions): Promise<boolean> {
  const { agentId, declaredSql, sqlGrantStore, log, tag } = opts;
  if (!declaredSql || !sqlGrantStore) return false;
  const grant = await sqlGrantStore.get(agentId);
  const sqlGranted = grant?.ledger === declaredSql.ledger;
  if (grant && !sqlGranted) {
    log(
      `[${tag}] ${agentId}: permissions.sql grant is for ledger '${grant.ledger}' but the manifest now declares '${declaredSql.ledger}' — treating as ungranted until the operator re-grants`,
    );
  }
  return sqlGranted;
}

export interface DeclaredSqlBootOptions {
  readonly agentId: string;
  readonly declaredSql: DeclaredSql;
  /** `ctx.sql`: present only when declaration and grant both hold. */
  readonly sql: SqlAccessor | undefined;
  /** The installed package's root, where the handoff plan and migrations live. */
  readonly packageRoot: string;
  readonly log: (msg: string) => void;
  readonly tag: string;
}

/** The declared ledger handoff, then the declared migrations. A failure throws and fails the activation. */
export async function runDeclaredSqlBoot(opts: DeclaredSqlBootOptions): Promise<void> {
  const { agentId, declaredSql, sql, packageRoot, log, tag } = opts;
  // Epic #470 C15 — run the declared ledger handoff BEFORE the migration
  // runner below.
  //
  // C11 gave a plugin `ctx.sql.seedLedger` and documented it as "call this
  // before `runMigrations`", which a plugin cannot honour: the runner below
  // runs before `activate()`, so the plugin's own call always arrived after
  // every ledger row was already written. The 2026-08-21 acceptance run
  // measured `0 seeded, 9 already seeded` on the exact upgrade C11 exists
  // for, with `skippedNoWitness` — the one alarm it was built to raise —
  // unreachable. And nothing failed: that log line is indistinguishable
  // from a healthy re-run.
  //
  // The witnesses are knowledge only the plugin has; the ordering is a
  // decision only core can make. So the plugin declares the plan in its
  // manifest and core executes it here, through the SAME accessor a plugin
  // would have called — read-only witness fence, advisory lock, entry
  // validation and all. `ctx.sql.seedLedger` stays for plugins that manage
  // their own order; against this core it degrades to `alreadySeeded`,
  // which is what it should report once the work is done.
  //
  // A refusal fails the activation, and deliberately takes the migration
  // runner with it: running the files anyway would write exactly the ledger
  // rows the unreadable plan existed to decide on.
  if (declaredSql.handoff && sql) {
    const plan = await loadHandoffPlan({
      pluginId: agentId,
      packageRoot,
      declaredPath: declaredSql.handoff,
    });
    if (plan.declaredLedger && plan.declaredLedger !== declaredSql.ledger) {
      // Not fatal — core's ledger is the granted one and the plan's copy is
      // advisory. But an operator who previewed the handoff with
      // `plugin-ledger-handoff.mjs` read a different table than the one
      // about to be written, and that is worth saying out loud.
      log(
        `[${tag}] WARN ${agentId}: handoff plan names ledger '${plan.declaredLedger}' but the manifest declares '${declaredSql.ledger}' — the manifest wins; an operator dry-run against the plan's table showed a different database`,
      );
    }
    const seedLedger = sql.seedLedger;
    if (!seedLedger) {
      throw new PluginHandoffPlanError(
        agentId,
        declaredSql.handoff,
        'malformed',
        'this kernel builds a SQL accessor with no ledger seeder — the handoff cannot run, and running the migrations instead would silently do the thing the plan exists to prevent',
      );
    }
    // Bounded with the same budget as the runner it precedes, and for the
    // same reason: `seedPluginLedgerFromDonor` sets its timeouts
    // server-side, but neither covers a connection that never answers, and
    // this await sits on the boot path. The two steps also share one
    // advisory lock, so a tighter bound here would only move where the pair
    // gives up.
    const report = await withTimeout(
      seedLedger.call(sql, {
        entries: plan.entries,
      }),
      MIGRATION_TIMEOUT_MS,
      `seedLedger(${agentId}) timed out after ${String(MIGRATION_TIMEOUT_MS / 1000)}s`,
    );
    log(
      `[${tag}] ${agentId}: ledger handoff — ${String(report.seeded.length)} seeded, ` +
        `${String(report.alreadySeeded.length)} already seeded, ` +
        `${String(report.applied.length)} left for the migration runner ` +
        `(ledger '${report.ledger}', donor '${report.donorLedger}', ${String(report.durationMs)}ms)`,
    );
    if (report.skippedNoWitness.length > 0) {
      // THE output this feature exists to produce. The donor ledger records
      // these, but their witness says the schema object is not there: a
      // restore from an older snapshot, a rolled-back deploy, a table
      // dropped during an incident. The runner below repairs it, so this is
      // a warning rather than a refusal — but the operator has to be told
      // the database is not the one they think it is, and told WHICH files,
      // because a count alone gives them nowhere to look.
      log(
        `[${tag}] WARN ${agentId}: ledger handoff — the donor ledger records ` +
          `${String(report.skippedNoWitness.length)} file(s) whose witness says the schema object is ABSENT; ` +
          `the migration runner will apply them, which is the repair — confirm this is the database you think it is: ` +
          report.skippedNoWitness.join(', '),
      );
    }
  }

  // Epic #470 C7 / G4 — apply the plugin's schema BEFORE its `activate()`
  // runs. A plugin whose first act is to query its own tables must not have
  // to remember to migrate first, and the ordering is not a convenience: it
  // is what makes "the tables exist" an invariant `activate()` can rely on
  // rather than a race each plugin re-loses in its own way.
  //
  // Only when the manifest explicitly declares `permissions.sql.migrations`.
  // A plugin that declares `permissions.sql` for pool access alone, with no
  // migrations key, gets `ctx.sql` and decides for itself.
  //
  // A failure here fails the activation. That is deliberate: the alternative
  // is a plugin running against a schema that is not the one it was built
  // for, which fails later, further away, and with the database in a state
  // nobody chose. The circuit-breaker in `activateAllInstalled` treats it
  // like any other activate failure.
  if (declaredSql.migrations && sql) {
    // Bounded with the SAME helper that caps `activate()`, and for the same
    // reason. `runPluginMigrations` sets `lock_timeout` and
    // `statement_timeout` server-side, but neither covers a connection that
    // never answers — a pool exhausted by another plugin, a database that
    // accepted the TCP connection and then went away. This await sits on the
    // boot path ahead of `activate()`, so an unbounded one hangs the whole
    // middleware rather than just this plugin. The budget is its own
    // constant because migrating schema is legitimately slower than
    // activating, and folding it into the 10s activate cap would either
    // starve real migrations or loosen the activate bound.
    const report = await withTimeout(
      sql.runMigrations(),
      MIGRATION_TIMEOUT_MS,
      `runMigrations(${agentId}) timed out after ${String(MIGRATION_TIMEOUT_MS / 1000)}s`,
    );
    if (report.applied.length > 0) {
      log(
        `[${tag}] ${agentId}: applied ${String(report.applied.length)} migration(s) to ledger '${report.ledger}' in ${String(report.durationMs)}ms (${report.applied.join(', ')})`,
      );
    }
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
