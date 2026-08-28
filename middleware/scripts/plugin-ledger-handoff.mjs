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
 * and it costs one read-only transaction. That claim is now literally true:
 * witnesses run inside a read-only subtransaction over PostgreSQL's extended
 * protocol, so a multi-command witness is refused by the server before it can
 * escape the dry run and a write witness is refused before it can touch
 * either the donor ledger or any bystander table.
 *
 * DRY RUN IS THE DEFAULT, and `--apply` is the only way to write. The inverse
 * default — write unless told otherwise — is wrong for a tool whose entire
 * value is being run against production by someone who has not read it.
 *
 * DELIBERATELY GENERIC. It names no plugin and no table: the plan file
 * supplies the plugin id, the ledger, the migrations directory and the
 * entries, and core supplies the donor ledger. That is not tidiness — the
 * extraction rule (epic #470) was that no core file names the extracted
 * plugin, and the next plugin to leave core will want this tool unchanged.
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
 * ONE PLAN, THREE READERS (epic #470 C15)
 * ---------------------------------------
 * The same JSON is read by three things:
 *
 *   1. this CLI, via `--plan`;
 *   2. the kernel, when a manifest declares `permissions.sql.handoff`
 *      (`middleware/src/platform/pluginHandoffPlan.ts`);
 *   3. a plugin that manages its own ordering, via `ctx.sql.seedLedger`.
 *
 * `entries` (and the optional `dryRun`) are what all three consume, and they
 * are exactly `SeedLedgerOptions`. `pluginId`, `ledger` and `migrationsDir`
 * are for THIS tool alone: it runs with no manifest, so it has to be told
 * them. The kernel knows all three authoritatively and deliberately ignores
 * the file's copies — a plan that could redirect the write would undo the
 * grant matching the manifest — though it does WARN when the plan's `ledger`
 * disagrees with the manifest's, because then the table an operator previewed
 * here is not the table the kernel is about to write.
 *
 * So a plan shipped inside a package for the manifest carries only `entries`,
 * and this tool reads that same file when the three missing fields are
 * supplied as flags:
 *
 *   node middleware/scripts/plugin-ledger-handoff.mjs \
 *     --plan node_modules/@vendor/thing/handoff-plan.json \
 *     --plugin-id @vendor/thing \
 *     --ledger plg_vendor_thing_migrations \
 *     --migrations-dir migrations
 *
 * The kernel's reader is STRICTER than this one: it rejects unknown keys
 * (notably `dir`, which `SeedLedgerOptions` accepts and the kernel refuses to
 * honour) and caps the file size. A plan that the kernel accepts always works
 * here; the reverse is not guaranteed.
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

  For a plan shipped inside a package for 'permissions.sql.handoff', which
  carries only 'entries', supply the three fields the manifest would have
  told the kernel:

  --plugin-id <id>       e.g. @vendor/thing
  --ledger <table>       e.g. plg_vendor_thing_migrations
  --migrations-dir <dir> resolved relative to the plan file
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
    else if (arg === '--plugin-id') args.pluginId = argv[(i += 1)];
    else if (arg === '--ledger') args.ledger = argv[(i += 1)];
    else if (arg === '--migrations-dir') args.migrationsDir = argv[(i += 1)];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else fail(`unknown argument '${arg}'`);
  }
  return args;
}

function fail(msg) {
  process.stderr.write(`plugin-ledger-handoff: ${msg}\n${USAGE}`);
  process.exit(2);
}

function loadPlan(planPath, args) {
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
  // Epic #470 C15 — the same file may also be the one a manifest names in
  // `permissions.sql.handoff`, and that reader knows the plugin, the ledger
  // and the directory authoritatively, so a package-shipped plan carries only
  // `entries` (and optionally `dryRun`). This tool has no manifest, so it
  // still needs all three — but they may now come from flags instead of from
  // the file. That is what lets ONE plan serve both readers: forcing a plugin
  // to ship two files would let the one an operator previews drift from the
  // one the kernel runs.
  if (typeof args.pluginId === 'string' && args.pluginId.length > 0) {
    plan.pluginId = args.pluginId;
  }
  if (typeof args.ledger === 'string' && args.ledger.length > 0) {
    plan.ledger = args.ledger;
  }
  if (typeof args.migrationsDir === 'string' && args.migrationsDir.length > 0) {
    plan.migrationsDir = args.migrationsDir;
  }
  for (const field of ['pluginId', 'ledger', 'migrationsDir']) {
    if (typeof plan[field] !== 'string' || plan[field].length === 0) {
      fail(
        `plan is missing a non-empty '${field}' — add it to the plan file, or pass --${field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`,
      );
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

  const plan = loadPlan(args.plan, args);
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
      witnesses: Object.fromEntries(plan.entries.map((e) => [e.filename, e.witnessSql])),
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
