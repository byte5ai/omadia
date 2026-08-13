import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { Pool } from 'pg';

import { probePgTest } from './_helpers/pgTestDb.js';

import { activate } from '@omadia/knowledge-graph-neon/dist/plugin.js';
import { InstallService } from '../src/plugins/installService.js';

/**
 * Issue #665 — the knowledge-graph plugin must not end the pg pool the whole
 * process is using.
 *
 * WHAT WENT WRONG
 * ---------------
 * This plugin CREATES the pool, so ending it in `close()` reads as correct
 * ownership. It is not, because `close()` is not a process-exit path: it also
 * runs on every deactivate and on the reactivate the config editor fires after
 * any settings save. The kernel resolves `graphPool` ONCE at boot
 * (`src/index.ts`) and hands that same object to ~40 subsystems that never
 * re-resolve it. So `await graphPool.end()` did not release "our" pool — it
 * killed the one everything else still held, and every later query failed with
 * `Cannot use a pool after calling end on the pool` until the machine was
 * restarted. `/health` reported `ok` throughout.
 *
 * WHY THIS TEST IS SHAPED LIKE THIS
 * ---------------------------------
 * The oracle is a QUERY, not a flag. Asserting on a spy or on some `ended`
 * property would pass against a plugin that still ends a pool it merely
 * stopped handing out. The only question that matters is whether the object
 * the kernel is holding still works, so that is what is asked.
 *
 * The pool is not injected — the plugin builds its own via `createNeonPool`.
 * It is captured from `ctx.services.provide('graphPool', …)`, which is exactly
 * how the kernel gets it, so the test holds the same reference index.ts does.
 *
 * MUTATION CHECK (run it before trusting this file): restore
 * `await graphPool.end()` in the plugin's `close()` and both cases below must
 * go red. If they stay green the test is decorative.
 *
 * The suite owns its own schema and tenant: the registry advisory lock is
 * database-wide, so sharing either with a sibling suite deadlocks under the
 * parallel runner.
 */

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'kgPluginPoolLifetime',
  vars: ['KG_POOL_PG_TEST_URL', 'GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
  requireVector: true,
});

const KG_ID = '@omadia/knowledge-graph-neon';

/** Minimal PluginContext — the plugin only touches these six members. */
function makeCtx(captured: { pool?: Pool }): {
  ctx: unknown;
  provided: string[];
} {
  const provided: string[] = [];
  const ctx = {
    log: (): void => {
      /* quiet */
    },
    secrets: {
      get: async (key: string): Promise<string | undefined> =>
        key === 'database_url' ? PG_URL : undefined,
    },
    config: {
      // Everything optional. Embeddings stay off, so the gate parks itself and
      // no Ollama/OpenAI call is attempted — this suite is about the pool.
      get: (): undefined => undefined,
    },
    services: {
      get: (): undefined => undefined,
      provide: (name: string, value: unknown): (() => void) => {
        provided.push(name);
        if (name === 'graphPool') captured.pool = value as Pool;
        return () => {
          /* dispose */
        };
      },
    },
    jobs: {
      register: (): (() => void) => () => {
        /* dispose */
      },
    },
  };
  return { ctx, provided };
}

// Skipping is per-test via `t.skip()`, not a `before` hook: this file matches
// the plain `test/**/*.test.ts` glob as well as `test:pg`, so it runs in the
// no-database step too and must self-skip there. A suite-level hook cannot —
// `SuiteContext` has no `skip()`, and calling it throws the suite red.
describe('#665 — KG plugin close() must not end the shared pg pool', () => {
  it('leaves the pool the kernel holds usable after close()', async (t) => {
    if (!pgAvailable) return t.skip('no test Postgres');

    const captured: { pool?: Pool } = {};
    const { ctx, provided } = makeCtx(captured);

    const handle = await activate(ctx as never);

    // Guard the guard: if the plugin ever stops publishing the pool this way,
    // `captured.pool` would be undefined and every assertion below would
    // vacuously pass. Fail loudly instead.
    assert.ok(
      provided.includes('graphPool'),
      'plugin must still publish graphPool — otherwise this test proves nothing',
    );
    const pool = captured.pool;
    assert.ok(pool, 'graphPool was published but not captured');

    // Sanity: the pool works BEFORE close(), so a failure after it means
    // close() did it, not a broken fixture.
    await pool.query('SELECT 1');

    await handle.close();

    // The oracle. With `graphPool.end()` restored this throws
    // `Cannot use a pool after calling end on the pool`.
    const after = await pool.query<{ ok: number }>('SELECT 1 AS ok');
    assert.equal(
      after.rows[0]?.ok,
      1,
      'the pool the kernel shares with ~40 subsystems must survive close()',
    );

    await pool.end();
  });

  it('survives the reactivate() path every admin route funnels through', async (t) => {
    if (!pgAvailable) return t.skip('no test Postgres');

    const captured: { pool?: Pool } = {};
    const { ctx } = makeCtx(captured);
    const handle = await activate(ctx as never);
    const pool = captured.pool;
    assert.ok(pool);

    // Every unprotected call site in #665 — adminSettings.ts, adminProviders.ts,
    // runtime.ts (x3), auth.ts, selfExtension/service.ts, and the
    // `reactivatePlugin` exposed to plugins from index.ts — reaches the plugin
    // through this one method. Driving it once therefore covers all of them,
    // and doing it through the REAL InstallService keeps that true if the
    // funnel is ever rewired.
    let reactivations = 0;
    const service = new InstallService({
      catalog: { list: () => [], get: () => undefined } as never,
      registry: { has: (id: string) => id === KG_ID } as never,
      vault: {} as never,
      onUninstall: async (): Promise<void> => {
        await handle.close();
      },
      onInstalled: async (): Promise<void> => {
        reactivations += 1;
      },
    } as never);

    await service.reactivate(KG_ID);

    assert.equal(reactivations, 1, 'reactivate must have driven the full hook pair');

    const after = await pool.query<{ ok: number }>('SELECT 1 AS ok');
    assert.equal(
      after.rows[0]?.ok,
      1,
      'a config save must not take the process-wide pool down with it',
    );

    await pool.end();
  });
});
