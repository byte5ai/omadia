import { test } from 'node:test';
import assert from 'node:assert/strict';

import Anthropic from '@anthropic-ai/sdk';
import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type { EntityRefBus, KnowledgeGraph, MemoryStore } from '@omadia/plugin-api';

import type { OrchestratorDeps } from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import type { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import type { AgentRow } from '../packages/harness-orchestrator/src/registry/configStore.js';
import { buildForAgent } from '../packages/harness-orchestrator/src/registry/applyDiff.js';

/**
 * Wave 8 — regression guard, twin of buildForAgentRouting.test.ts: verifies
 * `buildForAgent` forwards its resolved `personaSkills` param through to the
 * per-Agent orchestrator's private field (read via a structural cast, same
 * convention as uiOrchestratorSurface.test.ts / buildForAgentRouting.test.ts).
 * Guards against the exact "forgotten field in the factory's hand-list"
 * regression that once broke modelRouting.
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

const persona = [
  {
    skillId: '00000000-0000-0000-0000-0000000000a1',
    slug: 'sales-bot',
    name: 'Sales',
    description: 'Handles pricing and quotes',
    body: 'You are the Sales persona.',
  },
];

function personaSkillsOf(built: ReturnType<typeof buildForAgent>): unknown {
  return (built.orchestrator as unknown as { personaSkills?: unknown }).personaSkills;
}

test('buildForAgent forwards personaSkills into the per-Agent orchestrator', () => {
  const built = buildForAgent(
    agentRow('accounting'),
    deps(),
    { model: 'm', maxTokens: 100, maxToolIterations: 4 },
    persona,
  );

  assert.deepEqual(
    personaSkillsOf(built),
    persona,
    'per-Agent orchestrator must carry the persona candidates so it emits turn_persona',
  );
});

test('buildForAgent leaves personaSkills empty when none are resolved for this agent', () => {
  const built = buildForAgent(agentRow('plain'), deps(), {
    model: 'm',
    maxTokens: 100,
    maxToolIterations: 4,
  });

  assert.deepEqual(
    personaSkillsOf(built),
    [],
    'no persona skills in → empty on the orchestrator (no classifier call, no event)',
  );
});
