/**
 * Epic #470 C15 — the declarative half of the migration handoff.
 *
 * `permissions.sql.handoff` names a JSON file INSIDE the package, and core
 * reads it on the boot path, before the plugin has run a single line of its
 * own code. That makes the file plugin-supplied data reaching core's
 * filesystem and then core's database, which is exactly the shape that has to
 * be validated at the boundary rather than trusted and repaired later.
 *
 * So this suite is about refusal, not about the happy path: the happy path is
 * one assertion, and everything else here is a way the file can be wrong.
 *
 * The refusals are TYPED (`PluginHandoffPlanError.reason`) because activation
 * failures are read by operators through the circuit-breaker's message. "plan
 * is invalid" tells an operator nothing they can act on; "escapes the package
 * root" and "is not valid JSON" tell them which of two very different mistakes
 * they made.
 */

import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  MAX_HANDOFF_PLAN_BYTES,
  PluginHandoffPlanError,
  loadHandoffPlan,
} from '../src/platform/pluginHandoffPlan.js';

const PLUGIN_ID = '@test/handoff-plan';

describe('#470 C15 loadHandoffPlan', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'c15-plan-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writePlan(relative: string, body: string): Promise<void> {
    const abs = join(root, relative);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, body, 'utf8');
  }

  function load(declaredPath: string): Promise<unknown> {
    return loadHandoffPlan({
      pluginId: PLUGIN_ID,
      packageRoot: root,
      declaredPath,
    });
  }

  /** Assert a refusal and its reason in one place, so a test that stops
   *  throwing cannot pass by throwing something else. */
  async function refusal(
    declaredPath: string,
    reason: PluginHandoffPlanError['reason'],
  ): Promise<PluginHandoffPlanError> {
    const err = await load(declaredPath).then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(
      err instanceof PluginHandoffPlanError,
      `expected a PluginHandoffPlanError, got ${String(err)}`,
    );
    assert.equal(err.reason, reason);
    assert.equal(err.pluginId, PLUGIN_ID);
    assert.equal(err.declaredPath, declaredPath);
    return err;
  }

  it('reads a well-formed plan', async () => {
    await writePlan(
      'handoff-plan.json',
      JSON.stringify({
        entries: [
          { filename: '0001_a.js', witnessSql: "SELECT to_regclass('public.a') IS NOT NULL" },
          { filename: '0002_b.js', witnessSql: "SELECT to_regclass('public.b') IS NOT NULL" },
        ],
      }),
    );

    const plan = await loadHandoffPlan({
      pluginId: PLUGIN_ID,
      packageRoot: root,
      declaredPath: 'handoff-plan.json',
    });

    assert.deepEqual(
      plan.entries.map((e) => e.filename),
      ['0001_a.js', '0002_b.js'],
    );
    assert.equal(
      plan.dryRun,
      false,
      'a plan that does not ask for a dry run writes — the default may not drift',
    );
  });

  it('carries dryRun through when the plan asks for it', async () => {
    await writePlan(
      'plans/preview.json',
      JSON.stringify({
        dryRun: true,
        entries: [{ filename: '0001_a.js', witnessSql: 'SELECT true' }],
      }),
    );
    const plan = await loadHandoffPlan({
      pluginId: PLUGIN_ID,
      packageRoot: root,
      declaredPath: 'plans/preview.json',
    });
    assert.equal(plan.dryRun, true);
  });

  it('accepts the operator-CLI fields and reports the ledger as advisory only', async () => {
    // One file has to serve both `middleware/scripts/plugin-ledger-handoff.mjs`
    // (which needs to be told the plugin, the ledger and the directory,
    // because it runs with no manifest) and this loader (which knows all
    // three authoritatively and must never take them from plugin data).
    // Rejecting the CLI's fields would force a plugin to ship two files that
    // can drift apart — the one an operator previews and the one core runs.
    await writePlan(
      'handoff-plan.json',
      JSON.stringify({
        pluginId: '@vendor/thing',
        ledger: 'plg_vendor_thing_migrations',
        migrationsDir: 'packages/plugin/migrations',
        entries: [{ filename: '0001_a.js', witnessSql: 'SELECT true' }],
      }),
    );
    const plan = await loadHandoffPlan({
      pluginId: PLUGIN_ID,
      packageRoot: root,
      declaredPath: 'handoff-plan.json',
    });
    assert.deepEqual(
      plan.entries.map((e) => e.filename),
      ['0001_a.js'],
    );
    assert.equal(
      plan.declaredLedger,
      'plg_vendor_thing_migrations',
      'reported so core can warn on a disagreement — never obeyed',
    );
  });

  it('refuses a plan that escapes the package root', async () => {
    await refusal('../outside.json', 'escapes-package-root');
  });

  it('refuses an absolute path', async () => {
    await refusal('/etc/passwd', 'escapes-package-root');
  });

  it('refuses a sibling directory that merely shares the root prefix', async () => {
    // The `+ path.sep` on the containment check is what separates
    // `<root>-evil/plan.json` from `<root>/plan.json`. A bare `startsWith`
    // passes the first one, and the file it reads is outside the package.
    await refusal(`../${basename(root)}-evil/plan.json`, 'escapes-package-root');
  });

  it('refuses a missing file', async () => {
    await refusal('handoff-plan.json', 'unreadable');
  });

  it('refuses a file that is not JSON', async () => {
    await writePlan('handoff-plan.json', 'entries: [] # yaml, not json\n');
    await refusal('handoff-plan.json', 'not-json');
  });

  it('refuses a plan larger than the cap', async () => {
    const filler = 'x'.repeat(MAX_HANDOFF_PLAN_BYTES + 1);
    await writePlan(
      'handoff-plan.json',
      JSON.stringify({
        entries: [{ filename: '0001_a.js', witnessSql: `SELECT '${filler}'` }],
      }),
    );
    await refusal('handoff-plan.json', 'too-large');
  });

  it('refuses an empty entries list', async () => {
    await writePlan('handoff-plan.json', JSON.stringify({ entries: [] }));
    const err = await refusal('handoff-plan.json', 'malformed');
    assert.match(err.message, /entries/);
  });

  it('refuses an entry with no witness', async () => {
    await writePlan(
      'handoff-plan.json',
      JSON.stringify({ entries: [{ filename: '0001_a.js', witnessSql: '   ' }] }),
    );
    await refusal('handoff-plan.json', 'malformed');
  });

  it('refuses an unknown key rather than ignoring it', async () => {
    // `dir` is the one that matters: `SeedLedgerOptions` accepts it and it
    // would be a SECOND way to point the seeder at a directory, next to the
    // manifest's `migrations`. Silently ignoring it would leave a plugin
    // author believing a directory override took effect.
    await writePlan(
      'handoff-plan.json',
      JSON.stringify({
        dir: '../../elsewhere',
        entries: [{ filename: '0001_a.js', witnessSql: 'SELECT true' }],
      }),
    );
    const err = await refusal('handoff-plan.json', 'malformed');
    assert.match(err.message, /dir/);
  });

  it('refuses a duplicated filename', async () => {
    await writePlan(
      'handoff-plan.json',
      JSON.stringify({
        entries: [
          { filename: '0001_a.js', witnessSql: 'SELECT true' },
          { filename: '0001_a.js', witnessSql: 'SELECT false' },
        ],
      }),
    );
    // Two witnesses for one file makes the outcome depend on iteration order.
    // `seedLedger` refuses this too; refusing it HERE means the operator hears
    // about it at load time, naming the file.
    const err = await refusal('handoff-plan.json', 'malformed');
    assert.match(err.message, /0001_a\.js/);
  });

  it('refuses a top-level array', async () => {
    await writePlan(
      'handoff-plan.json',
      JSON.stringify([{ filename: '0001_a.js', witnessSql: 'SELECT true' }]),
    );
    await refusal('handoff-plan.json', 'malformed');
  });
});
