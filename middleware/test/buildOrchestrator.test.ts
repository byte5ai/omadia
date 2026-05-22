/**
 * US3 — verifies per-Agent Orchestrator construction: `buildOrchestratorForAgent`
 * is callable more than once in one process and yields fully independent
 * instances, each carrying its own `agentId`, with no shared mutable state.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import Anthropic from '@anthropic-ai/sdk';
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
    client: new Anthropic({ apiKey: 'test-key' }),
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
