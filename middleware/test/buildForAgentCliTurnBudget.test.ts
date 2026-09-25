import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type { EntityRefBus, KnowledgeGraph, MemoryStore } from '@omadia/plugin-api';

import type { OrchestratorDeps } from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import type { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import type { AgentRow } from '../packages/harness-orchestrator/src/registry/configStore.js';
import { buildForAgent } from '../packages/harness-orchestrator/src/registry/applyDiff.js';

/**
 * OM-104 / #1077 — the registry path must carry the CLI turn budget.
 *
 * `buildForAgent` hand-lists the runtime knobs it forwards into
 * `buildOrchestratorForAgent`. `cliTurnSeconds` was missing from that list, so
 * with a database (every agent — including the web chat's fallback agent — is
 * built by the registry) the operator's "time limit per turn" had no effect;
 * only the ENV override or the 600 s default applied. `buildOrchestrator.test.ts`
 * covers the conversion to `spawnTimeoutMs`; this file pins the forward.
 */

function fakeNativeToolRegistry(): NativeToolRegistry {
  const names = new Set<string>();
  return {
    has: (name: string) => names.has(name),
    register: (name: string) => {
      names.add(name);
      return () => names.delete(name);
    },
  } as unknown as NativeToolRegistry;
}

function cliDeps(): OrchestratorDeps {
  return {
    knowledgeGraph: {} as KnowledgeGraph,
    memoryStore: {} as MemoryStore,
    entityRefBus: {} as EntityRefBus,
    nativeToolRegistry: fakeNativeToolRegistry(),
    nudgeRegistry: new InMemoryNudgeRegistry(),
    responseGuard: () => undefined,
    privacyGuard: () => undefined,
    // Only `id` is read at construction time; the CLI runtime owns the turn
    // loop, so nothing calls stream()/complete() on this provider.
    provider: { id: 'claude-cli' } as unknown as OrchestratorDeps['provider'],
  };
}

function agentRow(slug: string): AgentRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    slug,
    name: slug,
    description: null,
    privacyProfile: 'default',
    status: 'enabled',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

const BASE_RUNTIME = { model: 'opus-cli', maxTokens: 100, maxToolIterations: 4 };

/** The private deps the CliChatAgent was constructed with. */
function agentDeps(built: ReturnType<typeof buildForAgent>): Record<string, unknown> | undefined {
  return (built.bundle.agent as unknown as { deps?: Record<string, unknown> }).deps;
}

function assertCliAgent(built: ReturnType<typeof buildForAgent>): void {
  // If the CLI branch ever stops swapping in the CLI runtime, the deps
  // assertions below inspect the wrong object and prove nothing.
  assert.notEqual(
    built.bundle.agent,
    built.orchestrator,
    'the claude-cli provider must produce a CliChatAgent, not the orchestrator',
  );
}

test('buildForAgent forwards cliTurnSeconds into the CLI agent (#1077)', () => {
  const built = buildForAgent(agentRow('fallback'), cliDeps(), {
    ...BASE_RUNTIME,
    cliTurnSeconds: 240,
  });

  assertCliAgent(built);
  assert.equal(
    agentDeps(built)?.['spawnTimeoutMs'],
    240_000,
    'the registry-built agent must honour the operator-set turn budget',
  );
});

for (const [label, runtime] of [
  ['absent', { ...BASE_RUNTIME }],
  ['zero', { ...BASE_RUNTIME, cliTurnSeconds: 0 }],
] as const) {
  test(`buildForAgent leaves spawnTimeoutMs unset when cliTurnSeconds is ${label} (#1077)`, () => {
    const built = buildForAgent(agentRow('plain'), cliDeps(), runtime);

    assertCliAgent(built);
    const deps = agentDeps(built);
    assert.ok(deps, 'the CLI agent must expose its construction deps');
    // No own key at all. `resolveCliSpawnTimeoutMs` (cliChatAgent.ts) already
    // falls back to the ENV override for an explicit `undefined`; the stricter
    // check keeps an unset budget from ever reaching the CLI runtime as a key.
    assert.equal(
      Object.prototype.hasOwnProperty.call(deps, 'spawnTimeoutMs'),
      false,
      'an unset budget must leave the ENV override / default reachable',
    );
  });
}
