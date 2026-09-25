import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { activate } from '../../packages/harness-orchestrator/src/plugin.js';
import { fakePluginContext } from '../_helpers/fakePluginContext.js';

import {
  agentDeps,
  cliOrchestratorConfig,
  orchestratorKernelServices,
} from './orchestratorActivateFixture.js';

/**
 * OM-104 / #1077 — the `cli_turn_seconds` setup field, end to end through the
 * orchestrator plugin's REAL `activate()`.
 *
 * The LLM-access page writes the field as a string (`'240'`), the plugin
 * parses it and forwards it into the default Agent's runtime config, and
 * `buildOrchestratorForAgent` turns it into the `spawnTimeoutMs` of the
 * `CliChatAgent` published as `chatAgent@1`. Before #1077 no test called
 * `activate()`, so deleting the forward in `plugin.ts` passed CI.
 *
 * No `graphPool` is published, so the registry path is skipped here; the
 * registry's copy of the value is pinned in `cliTurnBudgetRegistry.pg.test.ts`.
 */

async function spawnTimeoutFor(
  cliTurnSeconds: unknown,
): Promise<{ timeout: unknown; hasKey: boolean }> {
  const { ctx, provided } = fakePluginContext({
    config: cliOrchestratorConfig(
      cliTurnSeconds === undefined ? {} : { cli_turn_seconds: cliTurnSeconds },
    ),
    services: orchestratorKernelServices(),
  });
  const handle = await activate(ctx);
  try {
    const bundle = provided.get('chatAgent') as { agent: unknown; raw: unknown } | undefined;
    assert.ok(bundle, 'activate() must publish chatAgent@1 for a claude-cli provider');
    // The CLI branch must have produced a CliChatAgent, or the deps read below
    // inspects the wrong object and proves nothing.
    assert.notEqual(bundle.agent, bundle.raw, 'expected the CliChatAgent, not the orchestrator');
    const deps = agentDeps(bundle.agent);
    assert.ok(deps, 'the CliChatAgent keeps its construction deps');
    return {
      timeout: deps['spawnTimeoutMs'],
      hasKey: Object.prototype.hasOwnProperty.call(deps, 'spawnTimeoutMs'),
    };
  } finally {
    await handle.close();
  }
}

describe('OM-104 — cli_turn_seconds through the orchestrator activate()', () => {
  it('turns the string the admin page writes into milliseconds', async () => {
    const { timeout } = await spawnTimeoutFor('240');
    assert.equal(timeout, 240_000);
  });

  it('accepts a numeric setup value as well', async () => {
    const { timeout } = await spawnTimeoutFor(90);
    assert.equal(timeout, 90_000);
  });

  it('forwards nothing for an unset, zero, junk or negative value', async () => {
    // Absent key ⇒ the environment override and then the 600 s default stay in
    // charge (`resolveCliSpawnTimeoutMs`). A `0` would instead be a budget.
    for (const raw of [undefined, '0', 'abc', '-5', '']) {
      const { hasKey } = await spawnTimeoutFor(raw);
      assert.equal(hasKey, false, `cli_turn_seconds=${JSON.stringify(raw)} must forward nothing`);
    }
  });
});
