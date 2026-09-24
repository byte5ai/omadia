import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';

import { shutdownUsageRecorder } from '@omadia/usage-telemetry';
import { Pool } from 'pg';

import { activate } from '../../packages/harness-orchestrator/src/plugin.js';
import { fakePluginContext } from '../_helpers/fakePluginContext.js';
import { probePgTest } from '../_helpers/pgTestDb.js';

import { cliOrchestratorConfig, orchestratorKernelServices } from './orchestratorActivateFixture.js';

/**
 * OM-104 / #1077 — the registry half of the `cli_turn_seconds` forward.
 *
 * With a Postgres pool the orchestrator plugin also builds the multi-agent
 * `OrchestratorRegistry`, and hands it the platform runtime defaults every
 * registry-built Agent inherits. `cli_turn_seconds` is one of them
 * (`plugin.ts`, the registry `defaultRuntimeConfig`). This drives the REAL
 * `activate()` against a real database — it applies the core migration ledger
 * itself — and reads the value back off the published `orchestratorRegistry@1`.
 *
 * DELIBERATELY NOT ASSERTED: the `spawnTimeoutMs` of the Agents the registry
 * builds. `registry/applyDiff.ts` `buildForAgent` forwards `maxTurnSeconds`
 * and the loop guards from those defaults but not `cliTurnSeconds`, so every
 * registry-built Agent ignores the setting today. That is a production bug,
 * left unfixed in this tests-only change and not yet tracked by an issue of
 * its own (to be filed as a #1077 follow-up); an assertion on the built Agents
 * would be red on main for that reason alone.
 *
 * Isolation: its own schema via `search_path` (as `coreMigrations.pg.test.ts`
 * does), a capped pool, and `close()` so the ReloadBus LISTEN connection and
 * the usage-recorder timer do not keep the process alive.
 */

const { url: PG_URL, reachable: pgAvailable } = await probePgTest({
  label: 'cliTurnBudgetRegistry',
  vars: ['GRAPH_PG_TEST_URL', 'MEMORY_PG_TEST_URL'],
});

const SCHEMA = 'om104_cli_turn_budget';

const adminPool = pgAvailable
  ? new Pool({ connectionString: PG_URL, max: 1, idleTimeoutMillis: 1_000 })
  : undefined;

after(async () => {
  await adminPool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
  await adminPool?.end().catch(() => undefined);
});

interface RegistryWithOptions {
  readonly options: { readonly defaultRuntimeConfig: Record<string, unknown> };
}

async function registryDefaultsFor(cliTurnSeconds: string): Promise<Record<string, unknown>> {
  await adminPool?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await adminPool?.query(`CREATE SCHEMA ${SCHEMA}`);
  const graphPool = new Pool({
    connectionString: PG_URL,
    // One connection is held by the ReloadBus LISTEN for the plugin's life.
    max: 3,
    idleTimeoutMillis: 1_000,
    options: `-c search_path=${SCHEMA}`,
  });
  const { ctx, provided, logs } = fakePluginContext({
    config: cliOrchestratorConfig({ cli_turn_seconds: cliTurnSeconds }),
    services: { ...orchestratorKernelServices(), graphPool },
  });
  const handle = await activate(ctx);
  try {
    const registry = provided.get('orchestratorRegistry') as RegistryWithOptions | undefined;
    assert.ok(
      registry,
      `orchestratorRegistry@1 must be published; plugin said: ${logs.filter((l) => l.includes('Registry')).join(' | ')}`,
    );
    return registry.options.defaultRuntimeConfig;
  } finally {
    await handle.close();
    await shutdownUsageRecorder();
    await graphPool.end();
  }
}

describe('OM-104 — cli_turn_seconds reaches the orchestrator registry', () => {
  it('hands the configured budget to the registry runtime defaults', {
    skip: pgAvailable ? false : 'no test Postgres reachable',
  }, async () => {
    const defaults = await registryDefaultsFor('240');
    assert.equal(defaults['cliTurnSeconds'], 240);
    // The sibling budget travels the same way; a regression that dropped the
    // whole spread would show here too.
    assert.equal(defaults['model'], 'opus-cli');
  });

  it('leaves the key out when the budget is not set', {
    skip: pgAvailable ? false : 'no test Postgres reachable',
  }, async () => {
    const defaults = await registryDefaultsFor('0');
    assert.equal(Object.prototype.hasOwnProperty.call(defaults, 'cliTurnSeconds'), false);
  });
});
