import { test } from 'node:test';
import assert from 'node:assert/strict';

import Anthropic from '@anthropic-ai/sdk';
import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type { EntityRefBus, KnowledgeGraph, MemoryStore } from '@omadia/plugin-api';

import type { OrchestratorDeps } from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import type { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import type { ModelRoutingConfig } from '../packages/harness-orchestrator/src/modelRouter.js';
import type { AgentRow } from '../packages/harness-orchestrator/src/registry/configStore.js';
import { buildForAgent } from '../packages/harness-orchestrator/src/registry/applyDiff.js';

/**
 * Regression guard: `buildForAgent` must forward `modelRouting` from the
 * registry's `defaultRuntimeConfig` into each per-Agent orchestrator. It was
 * dropped once — the factory hand-lists runtime knobs and the field was
 * forgotten — so per-Agent chats never emitted `turn_routing` and the UI's
 * Haiku-triage badge only ever showed for the default boot-path orchestrator.
 *
 * The decision wiring is verified directly off the built orchestrator (the
 * field is private; read via a structural cast, matching the convention in
 * uiOrchestratorSurface.test.ts).
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

const modelRouting: ModelRoutingConfig = {
  classifierModel: 'claude-haiku-4-5',
  simpleModel: 'claude-sonnet-4-6',
  complexModel: 'claude-opus-4-8',
};

function routingOf(built: ReturnType<typeof buildForAgent>): unknown {
  return (built.orchestrator as unknown as { modelRouting?: unknown }).modelRouting;
}

test('buildForAgent forwards modelRouting into the per-Agent orchestrator', () => {
  const built = buildForAgent(agentRow('accounting'), deps(), {
    model: 'm',
    maxTokens: 100,
    maxToolIterations: 4,
    modelRouting,
  });

  assert.deepEqual(
    routingOf(built),
    modelRouting,
    'per-Agent orchestrator must carry the routing config so it emits turn_routing',
  );
});

test('buildForAgent leaves routing unset when the runtime config has none', () => {
  const built = buildForAgent(agentRow('plain'), deps(), {
    model: 'm',
    maxTokens: 100,
    maxToolIterations: 4,
  });

  assert.equal(
    routingOf(built),
    undefined,
    'no routing config in → no routing on the orchestrator (no event, no badge)',
  );
});
