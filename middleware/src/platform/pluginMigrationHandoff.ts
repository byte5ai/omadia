/**
 * Migration handoff — seeding a plugin's ledger from a core ledger.
 * Epic #470, item C11.
 *
 * THE PROBLEM THIS EXISTS FOR
 * ---------------------------
 * A subsystem that used to live in core, with its migrations in a core
 * migrator's ledger, moves out into a plugin that ships the same schema files
 * and runs them through `runPluginMigrations` against its OWN ledger. On an
 * installation that already ran the core files, the plugin's ledger is empty:
 * the runner would apply all of them again. The files are idempotent, so on a
 * healthy database that is merely slow — but idempotence is a property of the
 * files, and betting an installation on it for nine files at once is not a
 * plan.
 *
 * WHY THE NAIVE SEED IS DANGEROUS
 * -------------------------------
 * The obvious fix — copy the donor ledger's rows into the plugin's ledger and
 * skip those files — destroys an installation in exactly one case, silently:
 *
 *     donor rows present, schema objects ABSENT.
 *
 * That is not hypothetical. It is a database restored from a snapshot taken
 * before the objects existed, a version-skewed rollback, or an operator who
 * dropped a table during an incident. The donor ledger still says "applied".
 * A naive seed writes nine rows, the runner applies nothing, the plugin
 * activates green, and every request against the missing tables 500s — with
 * the cause nine steps and one deploy behind the symptom.
 *
 * So the donor ledger is corroboration, never authority. The DECISION is made
 * by a per-file WITNESS: a query against the live catalog that is true only if
 * the schema object that file creates is actually there.
 *
 *   - witness true                       → seed (the runner will skip the file)
 *   - witness false, donor row present   → DO NOT seed. This is the restore
 *                                          case. The runner applies the file;
 *                                          it is idempotent, so applying it
 *                                          against a partially-present schema
 *                                          is safe and applying it against an
 *                                          absent one is the repair.
 *   - witness false, no donor row        → do not seed (ordinary fresh install)
 *   - witness true, no donor row         → seed anyway. The schema is there;
 *                                          the donor ledger is what was lost.
 *
 * Read down that table and the rule collapses to "the witness decides". That
 * is the point, and it is why the donor read is reported rather than obeyed:
 * the interesting number in the plan is the DISAGREEMENT between the two, and
 * an operator running `dryRun` against production before installing anything
 * should see it. Nine donor rows and three true witnesses is a restore, and it
 * is worth knowing that BEFORE the plugin is installed rather than after.
 *
 * A file with no witness supplied is never seeded. Absence of proof is not
 * proof, and the fallback (let the runner apply an idempotent file) costs one
 * statement.
 *
 * DONOR ROWS ARE NEVER DELETED
 * ----------------------------
 * They are the rollback path. While core still ships the files, deleting the
 * donor rows makes core's own migrator re-run them on the next boot. Uninstall
 * the plugin, revert the deletion, and core's migrator finds its ledger exactly
 * as it left it. Nothing in this module issues a DELETE, and a test pins that.
 */

import type { Pool, PoolClient } from 'pg';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SqlMigrationError } from '@omadia/plugin-api';

import {
  PLUGIN_MIGRATION_LOCK_WAIT_MS,
  PLUGIN_MIGRATION_STATEMENT_TIMEOUT_MS,
  PLUGIN_MIGRATION_LOCK_NS,
  listMigrationFiles,
  migrationChecksum,
  pluginLedgerDdl,
  quoteIdentifier,
} from './pluginMigrations.js';
import { assertLedgerName, PLUGIN_LEDGER_NAMESPACE } from './pluginSqlGrants.js';

/**
 * The core ledger a plugin extracted from core adopts rows from.
 *
 * Core knows where core's ledger is; a plugin does not, and must not have to.
 * This is the one piece of core-specific knowledge in the handoff, and it lives
 * on this side of the boundary deliberately — the plugin supplies its own
 * filenames and its own witnesses, which is knowledge only the plugin has.
 *
 * `_multi_orchestrator_migrations` is the ledger of the migrator that owns
 * `middleware/migrations/` (`runMultiOrchestratorMigrations`). A test asserts
 * this string still appears in that migrator, so a rename there fails here
 * rather than silently seeding nothing.
 */
export const CORE_MIGRATION_DONOR_LEDGER = '_multi_orchestrator_migrations';

/** Column in {@link CORE_MIGRATION_DONOR_LEDGER} holding the filename. */
export const CORE_MIGRATION_DONOR_ID_COLUMN = 'id';

/**
 * Charset a donor table or column name must be in.
 *
 * Wider than `LEDGER_NAME_RE` in two ways, both load-bearing: core's ledgers
 * all start with `_`, and this rule also governs the COLUMN name, where the
 * plugin-ledger minimum of three characters would reject `id` — the actual
 * name of the column this reads. (It did, on the first run; the tests are why
 * this comment is not a guess.)
 *
 * Same discipline as the plugin ledger though: validate against an allowlist
 * BEFORE quoting; the quoting is the second layer, not the defence.
 */
const DONOR_IDENTIFIER_RE = /^[a-z_][a-z0-9_]{0,62}$/;

/** A per-file proof that the schema this file creates is actually present. */
export type MigrationWitness = (client: PoolClient) => Promise<boolean>;

export interface DonorLedger {
  /** Core-owned ledger table to read. Never written, never deleted from. */
  readonly ledgerTable: string;
  /** Column holding the filename. Defaults to
   *  {@link CORE_MIGRATION_DONOR_ID_COLUMN}. */
  readonly idColumn?: string;
  /**
   * The plugin's filenames whose donor rows are in scope.
   *
   * Matched against the donor ledger by STEM — the basename with its final
   * extension removed — because the extraction re-emits `0022_x.sql` as
   * `0022_x.js` (a plugin package cannot always ship raw `.sql`). Matching on
   * the full name would find nothing and quietly report "no donor rows", which
   * looks identical to a fresh installation.
   */
  readonly filenames: readonly string[];
}

export interface SeedPluginLedgerOptions {
  readonly pool: Pool;
  /** Kernel-known plugin id. Never supplied by the plugin. */
  readonly pluginId: string;
  /** The plugin's own ledger, in its reserved `plg_…` namespace. */
  readonly ledger: string;
  /** Absolute path to the plugin's migrations directory. Read to compute the
   *  checksum each seeded row must carry. */
  readonly dir: string;
  readonly donor: DonorLedger;
  /** filename → witness. A file absent from this map is never seeded. */
  readonly witnesses: Readonly<Record<string, MigrationWitness>>;
  /** Evaluate and report, write nothing. Defaults to false. */
  readonly dryRun?: boolean;
  readonly log?: (msg: string) => void;
}

/** What one handoff pass did, or — under `dryRun` — would have done. */
export interface LedgerSeedPlan {
  /** Written into the plugin ledger by this pass. */
  readonly seeded: readonly string[];
  /**
   * Everything the migration runner still has to apply after this pass: every
   * requested file that is neither seeded nor already in the ledger. The
   * superset of {@link skippedNoWitness}.
   */
  readonly applied: readonly string[];
  /**
   * The subset that should worry you: the donor recorded these, but their
   * witness says the schema object is not there. On a healthy installation
   * this list is empty; a non-empty one is a restore, a rollback or a manual
   * drop, and the runner is about to repair it.
   */
  readonly skippedNoWitness: readonly string[];
  /** Already in the plugin ledger before this pass — a re-run, or a peer
   *  replica that got there first. */
  readonly alreadySeeded: readonly string[];
  /** Which requested files the donor ledger actually records. Reported, not
   *  obeyed. */
  readonly donorRecorded: readonly string[];
  readonly ledger: string;
  readonly donorLedger: string;
  readonly dryRun: boolean;
  readonly durationMs: number;
}

/**
 * Seed a plugin's migration ledger from a core ledger, one witness at a time.
 *
 * Runs in ONE transaction under the same advisory lock
 * (`PLUGIN_MIGRATION_LOCK_NS`, keyed on the ledger) that `runPluginMigrations`
 * takes, so a seed and a migrate — or two concurrent seeds — serialise against
 * each other instead of interleaving. Under `dryRun` the transaction is rolled
 * back, which is also what contains any side effect a plugin-supplied witness
 * might have.
 */
export async function seedPluginLedgerFromDonor(
  opts: SeedPluginLedgerOptions,
): Promise<LedgerSeedPlan> {
  const { pool, pluginId, dir, donor, witnesses } = opts;
  const dryRun = opts.dryRun ?? false;
  const log = opts.log ?? (() => undefined);
  const startedAt = Date.now();

  const ledger = assertLedgerName(pluginId, opts.ledger);
  const donorLedger = assertDonorLedgerName(pluginId, ledger, donor.ledgerTable);
  const idColumn = assertDonorIdentifier(
    pluginId,
    ledger,
    'column',
    donor.idColumn ?? CORE_MIGRATION_DONOR_ID_COLUMN,
  );

  // Requested files, in the order the runner would execute them. Sorting here
  // rather than trusting the caller's array order means the plan an operator
  // reads under `dryRun` is in the same order as the applies it is predicting.
  const requested = [...new Set(donor.filenames)].sort();
  if (requested.length === 0) {
    throw new SqlMigrationError(
      pluginId,
      ledger,
      'ledger handoff was asked to seed zero files — an empty entry list is a caller bug, not an empty changeset',
    );
  }

  // Checksums come from the SAME files the runner will hash, computed by the
  // SAME function. A seeded row carrying a checksum the runner would not
  // reproduce trips its drift guard on the next activation, turning a
  // successful handoff into a hard failure one boot later.
  const onDisk = new Set(await listMigrationFiles(dir, pluginId, ledger));
  const checksums = new Map<string, string>();
  for (const file of requested) {
    if (!onDisk.has(file)) {
      throw new SqlMigrationError(
        pluginId,
        ledger,
        `ledger handoff names '${file}', which the migrations directory '${dir}' does not contain — ` +
          'seeding a row for a file the package does not ship would permanently hide a migration that never ran',
      );
    }
    checksums.set(file, migrationChecksum(await readFile(join(dir, file), 'utf8')));
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query(
        `SET LOCAL lock_timeout = '${String(PLUGIN_MIGRATION_LOCK_WAIT_MS)}ms'`,
      );
      // Witnesses are plugin-supplied SQL. Without a statement budget one that
      // never returns holds the ledger lock — and therefore blocks the
      // migration runner — for as long as it likes.
      await client.query(
        `SET LOCAL statement_timeout = '${String(PLUGIN_MIGRATION_STATEMENT_TIMEOUT_MS)}ms'`,
      );
      await client.query(
        'SELECT pg_advisory_xact_lock($1::int, hashtext($2)::int)',
        [PLUGIN_MIGRATION_LOCK_NS, ledger],
      );

      // Under the lock, exactly as the runner does it: a ledger created before
      // the lock reintroduces the `CREATE TABLE IF NOT EXISTS` race (42P07).
      await client.query(pluginLedgerDdl(ledger));

      const present = await readLedgerFilenames(client, ledger);
      const donorStems = await readDonorStems(
        client,
        donorLedger,
        idColumn,
        requested,
      );

      const seeded: string[] = [];
      const applied: string[] = [];
      const skippedNoWitness: string[] = [];
      const alreadySeeded: string[] = [];
      const donorRecorded: string[] = [];

      for (const file of requested) {
        const donorHasIt = donorStems.has(migrationStem(file));
        if (donorHasIt) donorRecorded.push(file);

        if (present.has(file)) {
          alreadySeeded.push(file);
          continue;
        }

        const witness = witnesses[file];
        const proven = witness ? await witness(client) : false;

        if (!proven) {
          applied.push(file);
          if (donorHasIt) skippedNoWitness.push(file);
          continue;
        }

        if (!dryRun) {
          // ON CONFLICT DO NOTHING is belt and braces under the lock: the lock
          // already excludes a concurrent seeder, and a row that appeared
          // anyway means the runner applied the file, whose own row is the
          // more truthful one.
          await client.query(
            `INSERT INTO ${quoteIdentifier(ledger)} (filename, checksum) VALUES ($1, $2) ON CONFLICT (filename) DO NOTHING`,
            [file, checksums.get(file)],
          );
        }
        seeded.push(file);
      }

      if (dryRun) {
        // Rolls back the ledger DDL and anything a witness touched. The plan
        // is computed against the live database and nothing survives it.
        await client.query('ROLLBACK');
      } else {
        await client.query('COMMIT');
      }

      log(
        `[sql] ${pluginId}: ledger handoff${dryRun ? ' (dry run)' : ''} — ` +
          `${String(seeded.length)} seeded, ${String(alreadySeeded.length)} already seeded, ` +
          `${String(applied.length)} left for the migration runner ` +
          `(${String(skippedNoWitness.length)} of them recorded by '${donorLedger}' but not witnessed)`,
      );

      return {
        seeded,
        applied,
        skippedNoWitness,
        alreadySeeded,
        donorRecorded,
        ledger,
        donorLedger,
        dryRun,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  } finally {
    client.release();
  }
}

/**
 * The basename with its final extension removed.
 *
 * `0022_x.sql` and `0022_x.js` are the same migration expressed twice — the
 * extraction re-emits core's SQL as JS because a distributed plugin package
 * cannot always ship raw `.sql`. Everything before the last dot is the
 * identity; the extension is the delivery format.
 */
export function migrationStem(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot <= 0 ? filename : filename.slice(0, dot);
}

/** Filenames already recorded in the plugin's own ledger. */
async function readLedgerFilenames(
  client: PoolClient,
  ledger: string,
): Promise<Set<string>> {
  const result = await client.query<{ filename: string }>(
    `SELECT filename FROM ${quoteIdentifier(ledger)}`,
  );
  return new Set(result.rows.map((r) => r.filename));
}

/**
 * Stems the donor ledger records, restricted to the requested files.
 *
 * A missing donor table is NOT an error: an installation that never ran the
 * core files has no donor ledger at all, and that is the ordinary fresh
 * install. It reports "no donor rows", which is exactly true.
 */
async function readDonorStems(
  client: PoolClient,
  donorLedger: string,
  idColumn: string,
  requested: readonly string[],
): Promise<Set<string>> {
  const exists = await client.query<{ present: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS present',
    [donorLedger],
  );
  if (exists.rows[0]?.present !== true) return new Set();

  const wanted = new Set(requested.map(migrationStem));
  const result = await client.query<{ id: string }>(
    `SELECT ${quoteIdentifier(idColumn)} AS id FROM ${quoteIdentifier(donorLedger)}`,
  );
  const found = new Set<string>();
  for (const row of result.rows) {
    const stem = migrationStem(row.id);
    if (wanted.has(stem)) found.add(stem);
  }
  return found;
}

/** Charset check for any donor identifier reaching SQL outside a bind
 *  parameter. */
function assertDonorIdentifier(
  pluginId: string,
  ledger: string,
  kind: 'table' | 'column',
  name: string,
): string {
  if (!DONOR_IDENTIFIER_RE.test(name)) {
    throw new SqlMigrationError(
      pluginId,
      ledger,
      `donor ${kind} '${name}' must match ${String(DONOR_IDENTIFIER_RE)} — ` +
        'the name reaches SQL as an identifier, where there is no bind-parameter form',
    );
  }
  return name;
}

/**
 * Validate a donor LEDGER table name.
 *
 * On top of the charset, refuses anything inside the kernel-owned `plg_`
 * namespace. A donor is by definition a CORE table; allowing a `plg_…` donor
 * would turn this function into a way for one plugin to read another plugin's
 * migration history, which is precisely the ownership boundary
 * `assertLedgerName` exists to hold. The rule is on the TABLE only — a column
 * called `plg_something` is nobody's ownership claim.
 */
function assertDonorLedgerName(
  pluginId: string,
  ledger: string,
  name: string,
): string {
  assertDonorIdentifier(pluginId, ledger, 'table', name);
  if (name.startsWith(PLUGIN_LEDGER_NAMESPACE)) {
    throw new SqlMigrationError(
      pluginId,
      ledger,
      `donor ledger '${name}' is inside the kernel-owned '${PLUGIN_LEDGER_NAMESPACE}' plugin namespace — ` +
        "a handoff donor is a core table; one plugin may not adopt another plugin's migration history",
    );
  }
  return name;
}
