import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  CLI_SPAWN_TIMEOUT_ENV_KEY,
  resolveCliSpawnTimeoutMs,
} from '@omadia/orchestrator';
import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type { EntityRefBus, KnowledgeGraph, MemoryStore } from '@omadia/plugin-api';

import {
  buildOrchestratorForAgent,
  type OrchestratorDeps,
} from '../../packages/harness-orchestrator/src/buildOrchestrator.js';

import { agentDeps, fakeNativeToolRegistry } from './orchestratorActivateFixture.js';

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

  it('the budget the production build installs wins over the environment', () => {
    // #1077 — this case used to recompute `Math.trunc(s * 1000)` itself, so a
    // unit change in `buildOrchestrator.ts` left it green. It now reads the
    // value the real construction path installs on the CliChatAgent and feeds
    // exactly that into the resolver the agent calls at spawn time.
    const deps: OrchestratorDeps = {
      provider: { id: 'claude-cli' } as unknown as OrchestratorDeps['provider'],
      knowledgeGraph: {} as KnowledgeGraph,
      memoryStore: {} as MemoryStore,
      entityRefBus: {} as EntityRefBus,
      nativeToolRegistry: fakeNativeToolRegistry(),
      nudgeRegistry: new InMemoryNudgeRegistry(),
      responseGuard: () => undefined,
      privacyGuard: () => undefined,
    };
    const built = buildOrchestratorForAgent(
      {
        agentId: 'cli',
        model: 'opus-cli',
        maxTokens: 100,
        maxToolIterations: 4,
        cliTurnSeconds: 240,
      },
      deps,
    );
    const installed = agentDeps(built.bundle.agent)?.['spawnTimeoutMs'];
    assert.equal(installed, 240_000);
    assert.equal(
      resolveCliSpawnTimeoutMs(installed as number, { [CLI_SPAWN_TIMEOUT_ENV_KEY]: '90000' }),
      240_000,
    );
  });
});
