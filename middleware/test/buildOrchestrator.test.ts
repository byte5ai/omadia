/**
 * US3 — verifies per-Agent Orchestrator construction: `buildOrchestratorForAgent`
 * is callable more than once in one process and yields fully independent
 * instances, each carrying its own `agentId`, with no shared mutable state.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createAnthropicClient,
  createAnthropicProvider,
} from '@omadia/llm-adapter-anthropic';
import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type {
  EntityRefBus,
  KnowledgeGraph,
  MemoryStore,
} from '@omadia/plugin-api';

import {
  buildOrchestratorForAgent,
  type OrchestratorDeps,
} from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import type { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';

/** Minimal NativeToolRegistry — the Orchestrator constructor only calls
 *  `has` and `register` while seeding the kernel native-tool names. */
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

function deps(): OrchestratorDeps {
  return {
    provider: createAnthropicProvider({
      client: createAnthropicClient({ apiKey: 'test-key' }),
    }),
    knowledgeGraph: {} as KnowledgeGraph,
    memoryStore: {} as MemoryStore,
    entityRefBus: {} as EntityRefBus,
    nativeToolRegistry: fakeNativeToolRegistry(),
    nudgeRegistry: new InMemoryNudgeRegistry(),
    responseGuard: () => undefined,
    privacyGuard: () => undefined,
  };
}

test('builds two independent orchestrators for two Agents', () => {
  const a = buildOrchestratorForAgent(
    { agentId: 'public', model: 'm', maxTokens: 100, maxToolIterations: 4 },
    deps(),
  );
  const b = buildOrchestratorForAgent(
    { agentId: 'general', model: 'm', maxTokens: 100, maxToolIterations: 4 },
    deps(),
  );

  assert.notEqual(a.orchestrator, b.orchestrator);
  assert.equal(a.orchestrator.agentId, 'public');
  assert.equal(b.orchestrator.agentId, 'general');
  assert.notEqual(a.bundle.chatSessionStore, b.bundle.chatSessionStore);
  assert.notEqual(a.bundle.sessionLogger, b.bundle.sessionLogger);
});

test('the built bundle exposes the orchestrator as its raw + bare agent', () => {
  const built = buildOrchestratorForAgent(
    { agentId: 'solo', model: 'm', maxTokens: 100, maxToolIterations: 4 },
    deps(),
  );
  assert.equal(built.bundle.raw, built.orchestrator);
  // No verifier bundle in deps → the bare Orchestrator IS the chatAgent.
  assert.equal(built.bundle.agent, built.orchestrator);
});

/**
 * #1016 — the WIRING pin.
 *
 * The guard itself is tested in `routineTurnOwnerGuard.test.ts`. What this
 * pins is that the production construction path actually installs it: the
 * first round of this fix shipped a correct guard with no caller, so a stale
 * `enterWith` chain still dispatched under the previous principal. Deleting
 * the `turnOwnerGuard` forward in `buildOrchestrator.ts` must fail here.
 */
function cliDeps(
  turnOwnerGuard?: OrchestratorDeps['turnOwnerGuard'],
): OrchestratorDeps {
  return {
    ...deps(),
    // Only `id` is read at construction time; the CLI runtime owns the turn
    // loop, so nothing calls stream()/complete() on this provider.
    provider: { id: 'claude-cli' } as unknown as OrchestratorDeps['provider'],
    ...(turnOwnerGuard ? { turnOwnerGuard } : {}),
  };
}

/** Reads the private deps the agent was constructed with. */
function installedGuard(agent: unknown): unknown {
  return (agent as { deps?: { turnOwnerGuard?: unknown } }).deps?.turnOwnerGuard;
}

test('a claude-cli agent is built with the turn-owner guard from deps (#1016)', () => {
  const guard: OrchestratorDeps['turnOwnerGuard'] = () => (): void => {};
  const built = buildOrchestratorForAgent(
    { agentId: 'cli', model: 'opus-cli', maxTokens: 100, maxToolIterations: 4 },
    cliDeps(guard),
  );

  // The CLI branch swaps the agent for the CLI runtime rather than the
  // orchestrator — if this ever stops holding, the assertion below is
  // inspecting the wrong object and the pin is worthless.
  assert.notEqual(
    built.bundle.agent,
    built.orchestrator,
    'the claude-cli branch must produce a CliChatAgent, not the orchestrator',
  );
  assert.equal(
    installedGuard(built.bundle.agent),
    guard,
    'the guard passed in deps must reach the constructed CliChatAgent',
  );
});

test('a claude-cli agent without a guard in deps installs none (#1016)', () => {
  const built = buildOrchestratorForAgent(
    { agentId: 'cli', model: 'opus-cli', maxTokens: 100, maxToolIterations: 4 },
    cliDeps(),
  );
  // Hosts that publish no `routineTurnOwnerGuard` service keep the pre-#1016
  // behaviour instead of getting a half-built guard.
  assert.equal(installedGuard(built.bundle.agent), undefined);
});
