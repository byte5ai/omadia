/**
 * #796 (epic #470 C9 / G3) — the two claims `coreMigrations.pg.test.ts` cannot make.
 *
 * That suite proves `runCoreMigrations` applies the ledger with every provider
 * key unset. It calls the function directly, so it stays green no matter what
 * `index.ts` does with it — including reverting the boot call entirely, or
 * putting it back behind an LLM credential. The regression #796 is actually
 * about lives in the WIRING, and nothing was asserting the wiring.
 *
 * So this file pins the two properties the fix depends on and the pg suite
 * structurally cannot see:
 *
 *   1. core's migrations run BEFORE `activateAllInstalled()`, and are not
 *      conditional on a provider key — read out of `index.ts` source, because
 *      importing `index.ts` boots the whole middleware.
 *   2. lock contention at boot is retried rather than allowed to reach
 *      `main().catch` → `process.exit(1)`.
 *
 * The source-reading style is the same one `uiRouteCatalogPluginUiNav.test.ts`
 * uses for its plugin-id parity pin: a claim about another file is worth
 * nothing as a comment and something as a test.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { Pool } from 'pg';

import { runCoreMigrations } from '../src/platform/coreMigrations.js';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, '..', 'src');

/** A pool that only has to be closable — no query ever reaches it, because
 *  every case here injects `runMigrations`. Cast because `pg.Pool` has a large
 *  surface and this test needs exactly one method of it. */
function fakePool(onEnd: () => void): Pool {
  return { end: async (): Promise<void> => { onEnd(); } } as unknown as Pool;
}

describe('#796 boot wiring — core migrations precede plugin activation', () => {
  it('calls runCoreMigrations before toolPluginRuntime.activateAllInstalled()', async () => {
    const src = await readFile(resolve(srcDir, 'index.ts'), 'utf8');

    const callIdx = src.indexOf('await runCoreMigrations(');
    assert.notEqual(
      callIdx,
      -1,
      'index.ts no longer awaits runCoreMigrations — core would boot without its ' +
        'own schema again (#796)',
    );

    const activateIdx = src.indexOf('await toolPluginRuntime.activateAllInstalled()');
    assert.notEqual(activateIdx, -1, 'could not find activateAllInstalled() in index.ts');

    assert.ok(
      callIdx < activateIdx,
      'core migrations must run BEFORE activateAllInstalled(): ToolPluginRuntime ' +
        "reads a plugin's SQL-grant row while building its context, so " +
        'plugin_sql_grants has to exist by then',
    );
  });

  it('does not gate the boot call on any provider credential', async () => {
    const src = await readFile(resolve(srcDir, 'index.ts'), 'utf8');
    const callIdx = src.indexOf('await runCoreMigrations(');
    assert.notEqual(callIdx, -1);

    // The statement and the comment block introducing it. A provider key named
    // anywhere in that window means the ledger was re-attached to a credential,
    // which is precisely the #796 defect.
    const window = src.slice(Math.max(0, callIdx - 1_200), callIdx + 400);
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'resolveLlmProvider']) {
      assert.ok(
        !new RegExp(`${key}\\s*[)\\]}]?\\s*(&&|\\|\\||\\?|\\))`).test(window),
        `core migrations appear to be conditional on ${key} again (#796)`,
      );
    }
  });
});

describe('#796 boot wiring — lock contention must not kill the process', () => {
  it('retries while another replica holds the migration lock, then succeeds', async () => {
    // Verbatim shape of the migrator's timeout (registry/migrator.ts), which is
    // what `isLockContentionError` keys on.
    const contention = new Error(
      '[multi-orchestrator] timed out after 2000ms waiting for the ' +
        '_multi_orchestrator_migrations advisory lock; 47 migration(s) still ' +
        'pending (0001_init.sql) — another replica is mid-migration, retry the boot',
    );

    let attempts = 0;
    let ended = 0;
    const outcome = await runCoreMigrations({
      databaseUrl: 'postgres://unused/db',
      createPool: () => fakePool(() => { ended += 1; }),
      runMigrations: async () => {
        attempts += 1;
        if (attempts < 3) throw contention;
      },
    });

    assert.equal(outcome, 'applied');
    assert.equal(attempts, 3, 'contention should be retried, not propagated to main()');
    assert.equal(ended, 1, 'the boot pool must still be closed exactly once');
  });

  it('propagates a real migration failure on the first attempt', async () => {
    let attempts = 0;
    let ended = 0;
    const boom = new Error('syntax error at or near "CREATE" in 0042_thing.sql');

    await assert.rejects(
      runCoreMigrations({
        databaseUrl: 'postgres://unused/db',
        createPool: () => fakePool(() => { ended += 1; }),
        runMigrations: async () => { attempts += 1; throw boom; },
      }),
      /syntax error/,
    );

    assert.equal(attempts, 1, 'a broken migration must fail loudly, not be retried');
    assert.equal(ended, 1, 'the pool must be closed on the failure path too');
  });
});

describe('#796 the retry predicate is pinned to the migrator that produces it', () => {
  it('migrator.ts still emits the phrase isLockContentionError matches', async () => {
    const migrator = await readFile(
      resolve(
        srcDir,
        '..',
        'packages',
        'harness-orchestrator',
        'src',
        'registry',
        'migrator.ts',
      ),
      'utf8',
    );
    const core = await readFile(resolve(srcDir, 'platform', 'coreMigrations.ts'), 'utf8');

    const phrase = 'waiting for the ${LOCK_KEY} advisory lock';
    assert.ok(
      migrator.includes(phrase),
      'migrator.ts no longer builds its timeout message from ' +
        `\`${phrase}\` — coreMigrations.isLockContentionError would stop ` +
        'recognising contention and boot would crash on a replica race instead ' +
        'of waiting. Update both together.',
    );
    assert.ok(
      migrator.includes("const LOCK_KEY = '_multi_orchestrator_migrations';"),
      'LOCK_KEY changed value — the phrase coreMigrations.ts matches is built from it',
    );
    assert.ok(
      core.includes("'waiting for the _multi_orchestrator_migrations advisory lock'"),
      'coreMigrations.ts no longer matches the migrator phrase this test pins',
    );
  });
});
