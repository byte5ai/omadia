import { promises as fs } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

/**
 * Epic #470 C15 — the manifest-declared migration handoff plan.
 *
 * WHY THIS IS DECLARATIVE AND NOT A PLUGIN CALL
 * ---------------------------------------------
 * C11 gave a plugin `ctx.sql.seedLedger` and documented it as "call this
 * before `runMigrations`". A plugin cannot honour that. Core runs the plugin's
 * migrations ITSELF, before `activate()` (C7 / G4 — so that "the tables exist"
 * is an invariant `activate()` can rely on rather than a race each plugin
 * re-loses in its own way), and there is no ordering a plugin can choose that
 * puts its own call ahead of a call core makes before handing it control. The
 * 2026-08-21 acceptance run measured the consequence: `0 seeded, 9 already
 * seeded` on the exact upgrade C11 exists for, with `skippedNoWitness`
 * unreachable.
 *
 * The witnesses are knowledge only the plugin has; the ordering is a decision
 * only core can make. So the plugin DECLARES and core EXECUTES: the manifest
 * names a JSON file, core reads it and runs the same seeder ahead of its own
 * runner.
 *
 * WHY IT IS VALIDATED THIS HARD
 * -----------------------------
 * The file is plugin-supplied data that reaches core's filesystem and then
 * core's database, on the boot path, before the plugin has run a line of its
 * own code. Everything it can get wrong is caught HERE, at the boundary,
 * where the refusal can still name the plugin and the path — rather than
 * later, inside a transaction, as a constraint violation nobody can trace back
 * to a manifest line.
 */

/** Largest plan file core will read. A nine-file handoff is about 1 KB; this
 *  is three orders of magnitude of headroom and still a bound, so a package
 *  cannot make the boot path read an arbitrarily large file. */
export const MAX_HANDOFF_PLAN_BYTES = 128 * 1024;

/**
 * Why a plan was refused.
 *
 * Typed rather than message-only because an activation failure reaches an
 * operator through the circuit-breaker, and "the plan is invalid" tells them
 * nothing they can act on. These five say which mistake was made.
 */
export type HandoffPlanRefusal =
  | 'escapes-package-root'
  | 'unreadable'
  | 'too-large'
  | 'not-json'
  | 'malformed';

/** Thrown when a manifest declares a handoff plan core will not run. */
export class PluginHandoffPlanError extends Error {
  public readonly pluginId: string;
  public readonly declaredPath: string;
  public readonly reason: HandoffPlanRefusal;

  constructor(
    pluginId: string,
    declaredPath: string,
    reason: HandoffPlanRefusal,
    detail: string,
  ) {
    super(
      `plugin '${pluginId}': permissions.sql.handoff '${declaredPath}' — ${detail}`,
    );
    this.name = 'PluginHandoffPlanError';
    this.pluginId = pluginId;
    this.declaredPath = declaredPath;
    this.reason = reason;
  }
}

export interface HandoffPlanEntry {
  readonly filename: string;
  readonly witnessSql: string;
}

export interface HandoffPlan {
  readonly entries: readonly HandoffPlanEntry[];
  /** Report the plan and write nothing. Defaults to false — a plan that does
   *  not ask for a dry run performs the handoff. */
  readonly dryRun: boolean;
  /**
   * The ledger the plan file names, when it names one.
   *
   * ADVISORY. Core resolves the ledger from the manifest and the operator's
   * grant, and never from plugin data — a plan that could redirect the write
   * would undo the whole point of the grant matching the manifest. It is
   * surfaced only so core can WARN when the two disagree, which is a real
   * split-brain: the operator previews one table with the CLI and core writes
   * another.
   */
  readonly declaredLedger?: string;
}

/**
 * The plan file's shape.
 *
 * `entries` and `dryRun` are core's; the shape is deliberately the one
 * `SqlAccessor.seedLedger` already accepts, so a plugin that manages its own
 * ordering against an older core can pass the same parsed object straight to
 * `ctx.sql.seedLedger`.
 *
 * `pluginId` / `ledger` / `migrationsDir` belong to the operator CLI
 * (`middleware/scripts/plugin-ledger-handoff.mjs`), which runs with no
 * manifest and therefore has to be told them. They are accepted and ignored so
 * that ONE file can serve both readers: forcing a plugin to ship two would let
 * the file an operator previews drift from the file core runs, which is
 * precisely the class of surprise this feature exists to remove.
 *
 * Strict, not permissive. The key that makes it matter is `dir`:
 * `SeedLedgerOptions` accepts it, so a plugin author could reasonably expect
 * it to work here, and silently ignoring it would leave them believing a
 * directory override took effect. Core takes the migrations directory from the
 * manifest and nowhere else — a second path-containment surface buys nothing.
 */
const planSchema = z.strictObject({
  entries: z
    .array(
      z.strictObject({
        filename: z.string().min(1),
        witnessSql: z
          .string()
          .refine((s) => s.trim().length > 0, 'must not be blank'),
      }),
    )
    .min(1, 'entries must list at least one file — a handoff that claims nothing is a mistake, not a no-op'),
  dryRun: z.boolean().optional(),
  // Operator-CLI fields. Reported or ignored, never obeyed. See above.
  pluginId: z.string().optional(),
  ledger: z.string().optional(),
  migrationsDir: z.string().optional(),
});

export interface LoadHandoffPlanOptions {
  /** Kernel-known plugin id, for the error messages. */
  readonly pluginId: string;
  /** Absolute path to the installed package. */
  readonly packageRoot: string;
  /** `permissions.sql.handoff`, verbatim from the manifest. */
  readonly declaredPath: string;
}

/**
 * Read and validate a declared handoff plan.
 *
 * Throws {@link PluginHandoffPlanError} for every rejection. Throwing rather
 * than degrading is the right direction here and the opposite of the manifest
 * loader's rule elsewhere: dropping a malformed `public_paths` entry leaves
 * one fewer unauthenticated surface, but dropping a malformed handoff leaves
 * core's pre-activate runner to write the very ledger rows the plan existed to
 * decide on. A silent skip would reproduce G7 exactly.
 */
export async function loadHandoffPlan(
  opts: LoadHandoffPlanOptions,
): Promise<HandoffPlan> {
  const { pluginId, declaredPath } = opts;
  const refuse = (
    reason: HandoffPlanRefusal,
    detail: string,
  ): PluginHandoffPlanError =>
    new PluginHandoffPlanError(pluginId, declaredPath, reason, detail);

  // Containment first: nothing else may run against a path that is not inside
  // the package. The `+ path.sep` is load-bearing — without it a sibling
  // directory named `<root>-evil` passes a bare `startsWith`.
  const root = path.resolve(opts.packageRoot);
  const resolved = path.resolve(root, declaredPath);
  if (!resolved.startsWith(root + path.sep)) {
    throw refuse(
      'escapes-package-root',
      'resolves outside the package root — a handoff plan must ship inside the package it describes',
    );
  }

  const stat = await fs.stat(resolved).catch(() => undefined);
  if (!stat?.isFile()) {
    throw refuse(
      'unreadable',
      'is not a readable file — the manifest declares a handoff the package does not ship',
    );
  }
  if (stat.size > MAX_HANDOFF_PLAN_BYTES) {
    throw refuse(
      'too-large',
      `is ${String(stat.size)} bytes, over the ${String(MAX_HANDOFF_PLAN_BYTES)}-byte cap`,
    );
  }

  const raw = await fs.readFile(resolved, 'utf8').catch((err: unknown) => {
    throw refuse(
      'unreadable',
      `could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw refuse(
      'not-json',
      `is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const result = planSchema.safeParse(parsed);
  if (!result.success) {
    throw refuse('malformed', describeIssues(result.error));
  }

  // Duplicates survive the schema — an array of two valid entries is a valid
  // array. Two witnesses for one file makes the outcome depend on iteration
  // order, and `Object.fromEntries` downstream would silently keep the last.
  // `seedLedger` refuses this too; refusing it here means the operator hears
  // about it at load time, with the filename in the message.
  const seen = new Set<string>();
  for (const entry of result.data.entries) {
    if (seen.has(entry.filename)) {
      throw refuse(
        'malformed',
        `lists '${entry.filename}' twice — two witnesses for one file makes the outcome depend on iteration order`,
      );
    }
    seen.add(entry.filename);
  }

  return {
    entries: result.data.entries.map((e) => ({
      filename: e.filename,
      witnessSql: e.witnessSql,
    })),
    dryRun: result.data.dryRun ?? false,
    ...(result.data.ledger === undefined
      ? {}
      : { declaredLedger: result.data.ledger }),
  };
}

/** Flatten zod's issues into one line that names the offending keys. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${where}: ${issue.message}`;
    })
    .join('; ');
}
