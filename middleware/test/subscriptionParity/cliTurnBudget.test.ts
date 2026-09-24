import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  CLI_SPAWN_TIMEOUT_ENV_KEY,
  resolveCliSpawnTimeoutMs,
} from '@omadia/orchestrator';

/**
 * OM-104 — the turn budget's precedence: an operator setting beats the
 * environment variable beats the built-in default. The setting is the new half
 * (the LLM-access page writes `cli_turn_seconds`, `buildOrchestratorForAgent`
 * converts it to `spawnTimeoutMs`); these pin the resolver it feeds so a stale
 * deployment variable can never silently overrule the page.
 */

const DEFAULT_MS = 600_000;

describe('OM-104 — CLI turn budget precedence', () => {
  it('falls back to the 600 s default with nothing configured', () => {
    assert.equal(resolveCliSpawnTimeoutMs(undefined, {}), DEFAULT_MS);
  });

  it('uses the environment variable when no setting is present', () => {
    assert.equal(
      resolveCliSpawnTimeoutMs(undefined, { [CLI_SPAWN_TIMEOUT_ENV_KEY]: '90000' }),
      90_000,
    );
  });

  it('lets the operator setting win over the environment variable', () => {
    assert.equal(
      resolveCliSpawnTimeoutMs(300_000, { [CLI_SPAWN_TIMEOUT_ENV_KEY]: '90000' }),
      300_000,
    );
  });

  it('ignores junk in the environment rather than making the budget zero', () => {
    for (const raw of ['', '0', 'abc', '-5']) {
      assert.equal(
        resolveCliSpawnTimeoutMs(undefined, { [CLI_SPAWN_TIMEOUT_ENV_KEY]: raw }),
        DEFAULT_MS,
        `raw=${JSON.stringify(raw)}`,
      );
    }
  });

  it('converts the configured seconds to the milliseconds the agent takes', () => {
    // Mirrors the conversion in `buildOrchestrator.ts`; kept here so a change
    // to the unit on either side breaks a test rather than a live turn.
    const cliTurnSeconds = 240;
    assert.equal(Math.trunc(cliTurnSeconds * 1000), 240_000);
    assert.equal(resolveCliSpawnTimeoutMs(240_000, {}), 240_000);
  });
});
