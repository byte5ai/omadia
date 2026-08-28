import { test } from 'node:test';
import assert from 'node:assert/strict';

import Anthropic from '@anthropic-ai/sdk';
import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type { EntityRefBus, KnowledgeGraph, MemoryStore } from '@omadia/plugin-api';

import type { OrchestratorDeps } from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import type { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import type {
  AgentRow,
  ConfigSnapshot,
} from '../packages/harness-orchestrator/src/registry/configStore.js';
import {
  buildForAgent,
  diffSnapshots,
} from '../packages/harness-orchestrator/src/registry/applyDiff.js';

/**
 * #914 — the agent's authored behaviour text reaching the running Agent.
 *
 * Twin of `buildForAgentPersonaSkills.test.ts`, and for the same reason: this
 * value travels through a hand-written field list in the factory, and the one
 * failure mode that matters is silent. An identity the operator saved, the API
 * confirmed and the UI rendered, but that never reached the system prompt,
 * looks exactly like a working feature until someone talks to the bot.
 *
 * Two halves, both required:
 *  - `buildForAgent` puts the text in the Orchestrator's identity slot,
 *    overriding the platform-wide one, and leaves it alone when unauthored;
 *  - `diffSnapshots` calls a changed text a REBUILD, because the registry
 *    keeps serving the old Orchestrator otherwise.
 */

const PLATFORM_IDENTITY = 'You are the platform assistant.';

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
    assistantIdentity: PLATFORM_IDENTITY,
  } as unknown as OrchestratorDeps;
}

function agentRow(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    slug: 'sales',
    name: 'Sales Agent',
    description: null,
    privacyProfile: 'default',
    status: 'enabled',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

/** The Orchestrator's private identity slot — same structural-cast
 *  convention as the persona-skills and routing guards. */
function identityOf(built: ReturnType<typeof buildForAgent>): unknown {
  return (built.orchestrator as unknown as { assistantIdentity?: unknown })
    .assistantIdentity;
}

const RUNTIME = { model: 'm', maxTokens: 100, maxToolIterations: 4 };

test('an authored identity replaces the platform assistant identity', () => {
  const built = buildForAgent(
    agentRow({ instructions: 'You are the sales agent. Be brief.' }),
    deps(),
    RUNTIME,
  );

  assert.equal(identityOf(built), 'You are the sales agent. Be brief.');
});

test('an unauthored agent keeps the platform assistant identity', () => {
  assert.equal(
    identityOf(buildForAgent(agentRow(), deps(), RUNTIME)),
    PLATFORM_IDENTITY,
  );
});

test('a blank authored identity is not an identity', () => {
  // Whitespace must not silence the opening section of the system prompt.
  assert.equal(
    identityOf(buildForAgent(agentRow({ instructions: '   ' }), deps(), RUNTIME)),
    PLATFORM_IDENTITY,
  );
});

function snapshot(agent: AgentRow): ConfigSnapshot {
  return {
    agents: [agent],
    agentPlugins: [],
    channelBindings: [],
    platformSettings: { fallbackAgentId: null, updatedAt: new Date(0) },
  } as unknown as ConfigSnapshot;
}

test('changing the authored identity rebuilds the agent', () => {
  const plan = diffSnapshots(
    snapshot(agentRow({ instructions: 'Old text.' })),
    snapshot(agentRow({ instructions: 'New text.' })),
  );

  assert.equal(plan.actions.length, 1);
  const action = plan.actions[0];
  assert.equal(action?.kind, 'rebuild');
  assert.match(
    (action as { reason: string }).reason,
    /identity_instructions/,
    'the rebuild reason names the identity, so an operator can see why sessions rolled',
  );
});

test('an unchanged identity does not rebuild anything', () => {
  const plan = diffSnapshots(
    snapshot(agentRow({ instructions: 'Same text.' })),
    snapshot(agentRow({ instructions: 'Same text.' })),
  );

  assert.deepEqual(plan.actions, []);
});
