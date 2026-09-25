/**
 * #978 — `agents.privacy_profile` is reserved and NOT enforced.
 *
 * The column is persisted, echoed by the operator API and rendered in the UI,
 * but no runtime path reads it: `AgentRuntimeConfig` has no posture field and
 * nothing branches on `'strict'`. It used to be a REBUILD reason all the same,
 * so every flip threw away the live `Orchestrator` and rolled every session of
 * that agent — for a value that changed nothing.
 *
 * What a privacy-only edit must do instead is a metadata `update`: the
 * registry's cached `AgentRow` is what `/operator/agents/resolve-channel`
 * reports from, so dropping the action entirely would leave that endpoint
 * reporting the old value. `update` refreshes the row without touching
 * `built`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemoryNudgeRegistry } from '@omadia/plugin-api';
import type {
  EntityRefBus,
  KnowledgeGraph,
  MemoryStore,
} from '@omadia/plugin-api';

import type { OrchestratorDeps } from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import type { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import { diffSnapshots } from '../packages/harness-orchestrator/src/registry/applyDiff.js';
import type {
  AgentRow,
  ConfigSnapshot,
  ConfigStore,
} from '../packages/harness-orchestrator/src/registry/configStore.js';
import { OrchestratorRegistry } from '../packages/harness-orchestrator/src/registry/index.js';

const PUBLIC_ID = '00000000-0000-0000-0000-000000000001';

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
    knowledgeGraph: {} as KnowledgeGraph,
    memoryStore: {} as MemoryStore,
    entityRefBus: {} as EntityRefBus,
    nativeToolRegistry: fakeNativeToolRegistry(),
    nudgeRegistry: new InMemoryNudgeRegistry(),
    responseGuard: () => undefined,
    privacyGuard: () => undefined,
  } as unknown as OrchestratorDeps;
}

function agent(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: PUBLIC_ID,
    slug: 'public',
    name: 'public',
    description: null,
    privacyProfile: 'default',
    status: 'enabled',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function snapshot(a: AgentRow): ConfigSnapshot {
  return {
    agents: [a],
    agentPlugins: [],
    channelBindings: [],
    platformSettings: { fallbackAgentId: null, updatedAt: new Date(0) },
  };
}

class MutableFakeStore implements Pick<ConfigStore, 'loadSnapshot'> {
  constructor(private snap: ConfigSnapshot) {}

  set(snap: ConfigSnapshot): void {
    this.snap = snap;
  }

  loadSnapshot(): Promise<ConfigSnapshot> {
    return Promise.resolve(this.snap);
  }
}

test('#978: a privacy_profile-only change is a metadata update, not a rebuild', () => {
  const plan = diffSnapshots(
    snapshot(agent()),
    snapshot(agent({ privacyProfile: 'strict' })),
  );

  assert.equal(plan.actions.length, 1);
  const action = plan.actions[0]!;
  assert.equal(action.kind, 'update');
  assert.equal(action.kind === 'update' && action.agent.privacyProfile, 'strict');
});

test('#978: flipping privacy_profile keeps the live Orchestrator and refreshes the registry row', async () => {
  const store = new MutableFakeStore(snapshot(agent()));
  const builds: Array<{ slug: string; reason: string }> = [];
  const registry = new OrchestratorRegistry(
    store as unknown as ConfigStore,
    deps(),
    {
      defaultRuntimeConfig: { model: 'm', maxTokens: 100, maxToolIterations: 4 },
      log: () => undefined,
      onAgentBuilt: (slug, _built, reason) => builds.push({ slug, reason }),
    },
  );
  await registry.start();
  builds.length = 0;

  const before = registry.get('public')!.built.orchestrator;

  store.set(snapshot(agent({ privacyProfile: 'strict' })));
  const plan = await registry.reload();

  assert.deepEqual(
    plan.actions.map((a) => a.kind),
    ['update'],
  );
  assert.equal(
    registry.get('public')!.built.orchestrator,
    before,
    'a no-op posture edit must not roll the live sessions of the agent',
  );
  assert.equal(
    registry.get('public')!.agent.privacyProfile,
    'strict',
    'the registry row (read by /operator/agents/resolve-channel) must not go stale',
  );
  assert.deepEqual(builds, [], 'no build callback fires for a metadata update');
});

test('#978: privacy_profile never appears in a rebuild reason', () => {
  const plan = diffSnapshots(
    snapshot(agent()),
    snapshot(agent({ privacyProfile: 'strict', instructions: 'Be terse.' })),
  );

  assert.equal(plan.actions.length, 1);
  const action = plan.actions[0]!;
  assert.equal(action.kind, 'rebuild');
  assert.equal(action.kind === 'rebuild' && action.reason, 'identity_instructions');
  assert.equal(action.kind === 'rebuild' && action.agent.privacyProfile, 'strict');
});

test('#978: an unchanged snapshot (strict on both sides) yields zero actions', () => {
  const plan = diffSnapshots(
    snapshot(agent({ privacyProfile: 'strict' })),
    snapshot(agent({ privacyProfile: 'strict' })),
  );

  assert.deepEqual(plan.actions, []);
});
