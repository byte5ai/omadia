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
 * W5 memory-ACL — the `agents.context_memory` switch actually switching
 * something.
 *
 * THE FAILURE THIS PINS WAS COMPLETELY SILENT, and it is the same shape as
 * #914's: the value was persisted by the operator route, read back into
 * `AgentRow`, echoed by the API and rendered in the UI — and then dropped at
 * the ONE hand-written field list that decides what a built Agent gets. Every
 * registry-built Agent ran the `'off'` default no matter what its row said, so
 * an operator could set `enforce-strict`, see it saved, see it displayed, and
 * still have chat-context turns writing into the agent-wide memory tier.
 *
 * Two halves, both load-bearing:
 *  - `buildForAgent` forwards the mode, so a NEW build honours it;
 *  - `diffSnapshots` calls a changed mode a REBUILD, so a LIVE agent honours
 *    it — without that, the switch only takes effect the next time something
 *    unrelated happens to rebuild the agent, which is indistinguishable from
 *    "it works, sometimes".
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
    assistantIdentity: 'You are the platform assistant.',
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

const RUNTIME = { model: 'm', maxTokens: 100, maxToolIterations: 4 };

/** The binder the Orchestrator was built with — the thing the mode decides.
 *  Same structural-cast convention as the identity and routing guards. */
function binderModeOf(built: ReturnType<typeof buildForAgent>): unknown {
  const orchestrator = built.orchestrator as unknown as {
    memoryBinder?: { mode?: unknown };
  };
  return orchestrator.memoryBinder?.mode;
}

test('the agent row decides the context-memory mode of the built agent', () => {
  for (const mode of ['off', 'enforce', 'enforce-strict'] as const) {
    const built = buildForAgent(agentRow({ contextMemory: mode }), deps(), RUNTIME);
    assert.equal(
      binderModeOf(built),
      mode,
      `an agent row saying ${mode} must build a binder in ${mode}`,
    );
  }
});

test('an agent whose row predates the column still runs the off default', () => {
  // The no-flag-day guarantee: a database without migration 0050 reports
  // `undefined`, which has to keep behaving exactly as it did before.
  assert.equal(binderModeOf(buildForAgent(agentRow(), deps(), RUNTIME)), 'off');
});

function snapshot(agent: AgentRow): ConfigSnapshot {
  return {
    agents: [agent],
    agentPlugins: [],
    channelBindings: [],
    platformSettings: { fallbackAgentId: null, updatedAt: new Date(0) },
  } as unknown as ConfigSnapshot;
}

test('flipping the context-memory mode rebuilds the agent', () => {
  const plan = diffSnapshots(
    snapshot(agentRow({ contextMemory: 'off' })),
    snapshot(agentRow({ contextMemory: 'enforce' })),
  );

  assert.equal(plan.actions.length, 1);
  const action = plan.actions[0];
  assert.equal(action?.kind, 'rebuild');
  assert.match(
    (action as { reason: string }).reason,
    /context_memory/,
    'the reason names the switch, so an operator can see why sessions rolled',
  );
});

test('an absent column and an explicit off are the same state', () => {
  // Otherwise every boot against a pre-0050 database would rebuild every
  // agent once for a change that did not happen.
  const plan = diffSnapshots(
    snapshot(agentRow()),
    snapshot(agentRow({ contextMemory: 'off' })),
  );
  assert.deepEqual(plan.actions, []);
});
