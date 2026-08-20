#!/usr/bin/env node
/**
 * Operator CLI for the plugin migration handoff (epic #470, C11).
 *
 * WHAT IT IS FOR
 * --------------
 * A subsystem that used to live in core moves out into a plugin. The plugin
 * ships the same migration files and runs them against its OWN ledger, which
 * on an existing installation is empty — so it would re-apply everything. The
 * handoff records those files as applied, but ONLY where a per-file witness
 * proves the schema object they create is actually there.
 *
 * The handoff itself runs inside the plugin's `activate()`. This CLI exists so
 * an operator can see the plan FIRST, against the real production database,
 * before the plugin is installed and before a single row is written:
 *
 *   node middleware/scripts/plugin-ledger-handoff.mjs --plan handoff.json
 *
 * That is the whole de-risking of the epic's most irreversible-looking step,
 * and it costs one read-only transaction.
 *
 * DRY RUN IS THE DEFAULT, and `--apply` is the only way to write. The inverse
 * default — write unless told otherwise — is wrong for a tool whose entire
 * value is being run against production by someone who has not read it.
 *
 * DELIBERATELY GENERIC. It names no plugin and no table: the plan file
 * supplies the plugin id, the ledger, the migrations directory and the
 * entries, and core supplies the donor ledger. That is not tidiness — core's
 * decoupling ratchet (`scripts/check-core-decoupling.mjs`) requires that no
 * core file name the extracted plugin, and the next plugin to leave core will
 * want this tool unchanged.
 *
 * PLAN FILE
 * ---------
 * ```json
 * {
 *   "pluginId": "@vendor/thing",
 *   "ledger": "plg_vendor_thing_migrations",
 *   "migrationsDir": "packages/plugin/migrations",
 *   "entries": [
 *     { "filename": "0001_x.js", "witnessSql": "SELECT to_regclass('public.x') IS NOT NULL" }
 *   ]
 * }
 * ```
 * `migrationsDir` is resolved relative to the plan file, so a plan shipped
 * inside a plugin package works from wherever the operator copied it.
 *
 * Exit codes: 0 = plan computed (or applied), 1 = the handoff refused,
 * 2 = usage / plan-file error.
 *
 * Requires a built `dist/` (`npm run build` in `middleware/`).
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import pg from 'pg';

import {
  CORE_MIGRATION_DONOR_LEDGER,
  seedPluginLedgerFromDonor,
} from '../dist/platform/pluginMigrationHandoff.js';

const USAGE = `
Usage: node middleware/scripts/plugin-ledger-handoff.mjs --plan <file.json> [options]

  --plan <file>        Required. The handoff plan (see the header of this file).
  --apply              Actually write the ledger rows. Default is a dry run.
  --database-url <url> Overrides $DATABASE_URL.
  --json               Machine-readable output.
`;

function parseArgs(argv) {
  const args = { apply: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--dry-run') args.apply = false;
    else if (arg === '--plan') args.plan = argv[(i += 1)];
    else if (arg === '--database-url') args.databaseUrl = argv[(i += 1)];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else fail(`unknown argument '${arg}'`);
  }
  return args;
}

function fail(msg) {
  process.stderr.write(`plugin-ledger-handoff: ${msg}\n${USAGE}`);
  process.exit(2);
}

function loadPlan(planPath) {
  let raw;
  try {
    raw = readFileSync(planPath, 'utf8');
  } catch (err) {
    fail(`cannot read plan '${planPath}': ${err.message}`);
  }
  let plan;
  try {
    plan = JSON.parse(raw);
  } catch (err) {
    fail(`plan '${planPath}' is not valid JSON: ${err.message}`);
  }
  for (const field of ['pluginId', 'ledger', 'migrationsDir']) {
    if (typeof plan[field] !== 'string' || plan[field].length === 0) {
      fail(`plan is missing a non-empty '${field}'`);
    }
  }
  if (!Array.isArray(plan.entries) || plan.entries.length === 0) {
    fail("plan needs a non-empty 'entries' array");
  }
  for (const entry of plan.entries) {
    if (typeof entry?.filename !== 'string' || entry.filename.length === 0) {
      fail('every entry needs a non-empty filename');
    }
    if (typeof entry?.witnessSql !== 'string' || entry.witnessSql.trim() === '') {
      fail(`entry '${entry.filename}' needs a witnessSql`);
    }
  }
  const base = dirname(resolve(planPath));
  plan.resolvedDir = isAbsolute(plan.migrationsDir)
    ? plan.migrationsDir
    : resolve(base, plan.migrationsDir);
  return plan;
}

/**
 * Wrap one plan entry's SQL as a witness.
 *
 * The shape is enforced, not coerced: exactly one row, exactly one column,
 * and a real boolean. `SELECT count(*)` is the tempting wrong witness — 1 for
 * a table that exists, 0 for one that exists but is empty, and a throw for one
 * that does not — and truthiness would have accepted all three readings.
 */
function witnessFor(entry) {
  return async (client) => {
    const result = await client.query(entry.witnessSql);
    if (result.rows.length !== 1) {
      throw new Error(
        `witness for '${entry.filename}' returned ${result.rows.length} rows; expected exactly 1`,
      );
    }
    const values = Object.values(result.rows[0]);
    if (values.length !== 1 || typeof values[0] !== 'boolean') {
      throw new Error(
        `witness for '${entry.filename}' must yield exactly one boolean column`,
      );
    }
    return values[0];
  };
}

function report(plan, result, apply) {
  const lines = [];
  lines.push('');
  lines.push(`  plugin        ${plan.pluginId}`);
  lines.push(`  ledger        ${result.ledger}`);
  lines.push(`  donor ledger  ${result.donorLedger}`);
  lines.push(`  mode          ${apply ? 'APPLY (rows written)' : 'dry run (nothing written)'}`);
  lines.push('');
  lines.push(`  seeded             ${result.seeded.length}  ${result.seeded.join(', ')}`);
  lines.push(`  already seeded     ${result.alreadySeeded.length}  ${result.alreadySeeded.join(', ')}`);
  lines.push(`  left for migrator  ${result.applied.length}  ${result.applied.join(', ')}`);
  lines.push(`  donor recorded     ${result.donorRecorded.length}`);
  lines.push('');

  if (result.skippedNoWitness.length > 0) {
    // The one number this tool exists to surface. Core's ledger says these
    // ran; the live catalog says the objects are not there. That is a restore,
    // a rolled-back deploy, or a manual drop — and the naive handoff would
    // have written nine rows here and left every request 500ing.
    lines.push('  ⚠ DISAGREEMENT — the donor ledger records these, but their witness is false:');
    for (const file of result.skippedNoWitness) lines.push(`      ${file}`);
    lines.push('');
    lines.push('    This is not a failure of the handoff; it is the handoff working.');
    lines.push('    The plugin\'s migration runner will apply these files, which is the repair.');
    lines.push('    Confirm the database is the one you think it is before continuing.');
    lines.push('');
  } else {
    lines.push('  ✓ no disagreement between the donor ledger and the live catalog');
    lines.push('');
  }

  if (!apply) {
    lines.push('  Nothing was written. Re-run with --apply to record the seeded rows,');
    lines.push('  or simply install the plugin — it performs the same handoff itself.');
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!args.plan) fail('--plan is required');

  const connectionString = args.databaseUrl ?? process.env.DATABASE_URL;
  if (!connectionString) {
    fail('set DATABASE_URL or pass --database-url');
  }

  const plan = loadPlan(args.plan);
  const pool = new pg.Pool({ connectionString, max: 2 });
  try {
    const result = await seedPluginLedgerFromDonor({
      pool,
      pluginId: plan.pluginId,
      ledger: plan.ledger,
      dir: plan.resolvedDir,
      donor: {
        ledgerTable: CORE_MIGRATION_DONOR_LEDGER,
        filenames: plan.entries.map((e) => e.filename),
      },
      witnesses: Object.fromEntries(
        plan.entries.map((e) => [e.filename, witnessFor(e)]),
      ),
      dryRun: !args.apply,
    });

    if (args.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(report(plan, result, args.apply));
    }
    return 0;
  } catch (err) {
    process.stderr.write(`\nplugin-ledger-handoff: refused — ${err.message}\n\n`);
    return 1;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

process.exit(await main());
