/**
 * US5 / T023 — hot-reload acceptance tests.
 *
 * Drives a real `OrchestratorRegistry` against a mutable fake `ConfigStore`
 * and asserts:
 *
 *  1. SC-001 / SC-002 — adding/removing an Agent leaves the other Agents'
 *     `Orchestrator` instances untouched (zero downtime).
 *  2. T020 — `diffSnapshots` emits the expected minimal action set for
 *     each mutation kind (add, remove, rebuild on privacy_profile flip,
 *     update on plugin list change).
 *  3. T022 — a throw inside one diff action does not abort the rest of
 *     the diff (per-Agent isolation).
 *  4. Idempotent reload: a `reload()` against an unchanged snapshot yields
 *     zero actions.
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

import type { OrchestratorDeps } from '../packages/harness-orchestrator/src/buildOrchestrator.js';
import type { NativeToolRegistry } from '../packages/harness-orchestrator/src/nativeToolRegistry.js';
import { diffSnapshots } from '../packages/harness-orchestrator/src/registry/applyDiff.js';
import {
  type AgentRow,
  type ConfigSnapshot,
  type ConfigStore,
} from '../packages/harness-orchestrator/src/registry/configStore.js';
import { OrchestratorRegistry } from '../packages/harness-orchestrator/src/registry/index.js';

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

function agent(slug: string, id: string, overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id,
    slug,
    name: slug,
    description: null,
    privacyProfile: 'default',
    status: 'enabled',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

class MutableFakeStore implements Pick<ConfigStore, 'loadSnapshot'> {
  private snapshot: ConfigSnapshot;

  constructor(initial: ConfigSnapshot) {
    this.snapshot = initial;
  }

  set(snap: ConfigSnapshot): void {
    this.snapshot = snap;
  }

  loadSnapshot(): Promise<ConfigSnapshot> {
    return Promise.resolve(this.snapshot);
  }
}

const baseSnapshot: ConfigSnapshot = {
  agents: [
    agent('public', '00000000-0000-0000-0000-000000000001'),
    agent('general', '00000000-0000-0000-0000-000000000002'),
  ],
  agentPlugins: [],
  channelBindings: [],
  platformSettings: { fallbackAgentId: null, updatedAt: new Date(0) },
};

test('SC-001/SC-002: removing one Agent does NOT touch the other Agent\'s Orchestrator', async () => {
  const store = new MutableFakeStore(baseSnapshot);
  const registry = new OrchestratorRegistry(store as ConfigStore, deps(), {
    defaultRuntimeConfig: { model: 'm', maxTokens: 100, maxToolIterations: 4 },
  });
  await registry.start();

  const publicBefore = registry.get('public')!.built.orchestrator;
  const generalBefore = registry.get('general')!.built.orchestrator;

  // Drop the `general` Agent in the next snapshot.
  store.set({
    ...baseSnapshot,
    agents: [agent('public', '00000000-0000-0000-0000-000000000001')],
  });
  const plan = await registry.reload();

  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0]!.kind, 'remove');
  assert.equal(
    registry.get('public')!.built.orchestrator,
    publicBefore,
    'public Orchestrator instance is unchanged after the diff',
  );
  assert.equal(registry.get('general'), undefined);
  // sanity — `general`'s previous Orchestrator handle is unreachable from
  // the registry, but the reference we held is still a live JS object.
  assert.ok(generalBefore);
});

test('SC-001/SC-002: adding a new Agent leaves existing Agents instances untouched', async () => {
  const store = new MutableFakeStore({
    ...baseSnapshot,
    agents: [agent('public', '00000000-0000-0000-0000-000000000001')],
  });
  const registry = new OrchestratorRegistry(store as ConfigStore, deps(), {
    defaultRuntimeConfig: { model: 'm', maxTokens: 100, maxToolIterations: 4 },
  });
  await registry.start();

  const publicBefore = registry.get('public')!.built.orchestrator;

  store.set(baseSnapshot);
  const plan = await registry.reload();

  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0]!.kind, 'add');
  assert.equal(
    registry.get('public')!.built.orchestrator,
    publicBefore,
    'public Orchestrator instance is unchanged after adding general',
  );
  assert.ok(registry.get('general'));
});

test('T020: privacy_profile flip emits a rebuild action and replaces the Orchestrator', async () => {
  const store = new MutableFakeStore(baseSnapshot);
  const registry = new OrchestratorRegistry(store as ConfigStore, deps(), {
    defaultRuntimeConfig: { model: 'm', maxTokens: 100, maxToolIterations: 4 },
  });
  await registry.start();

  const publicBefore = registry.get('public')!.built.orchestrator;

  store.set({
    ...baseSnapshot,
    agents: [
      agent('public', '00000000-0000-0000-0000-000000000001', {
        privacyProfile: 'strict',
      }),
      agent('general', '00000000-0000-0000-0000-000000000002'),
    ],
  });
  const plan = await registry.reload();

  const rebuilds = plan.actions.filter((a) => a.kind === 'rebuild');
  assert.equal(rebuilds.length, 1);
  assert.equal(rebuilds[0]!.kind === 'rebuild' && rebuilds[0]!.agent.slug, 'public');
  assert.notEqual(registry.get('public')!.built.orchestrator, publicBefore);
});

test('T020: plugin list change emits an update action without rebuilding the Orchestrator', async () => {
  const store = new MutableFakeStore(baseSnapshot);
  const registry = new OrchestratorRegistry(store as ConfigStore, deps(), {
    defaultRuntimeConfig: { model: 'm', maxTokens: 100, maxToolIterations: 4 },
  });
  await registry.start();

  const publicBefore = registry.get('public')!.built.orchestrator;

  store.set({
    ...baseSnapshot,
    agentPlugins: [
      {
        agentId: '00000000-0000-0000-0000-000000000001',
        pluginId: '@omadia/agent-seo-analyst',
        config: {},
        enabled: true,
        createdAt: new Date(0),
      },
    ],
  });
  const plan = await registry.reload();

  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0]!.kind, 'update');
  assert.equal(
    registry.get('public')!.built.orchestrator,
    publicBefore,
    'update should NOT replace the Orchestrator instance',
  );
  assert.deepEqual(
    registry.get('public')!.plugins.map((p) => p.pluginId),
    ['@omadia/agent-seo-analyst'],
    'plugin list is refreshed on the ActiveAgent metadata',
  );
});

test('T020: an idempotent reload (no DB change) emits zero actions', async () => {
  const store = new MutableFakeStore(baseSnapshot);
  const registry = new OrchestratorRegistry(store as ConfigStore, deps(), {
    defaultRuntimeConfig: { model: 'm', maxTokens: 100, maxToolIterations: 4 },
  });
  await registry.start();

  const plan = await registry.reload();
  assert.equal(plan.actions.length, 0);
  assert.equal(plan.platformChanged, false);
});

test('T022: a throw inside one Agent\'s rebuild does NOT abort the rest of the diff', async () => {
  // Track how many builds each Agent has had — the deps' nativeToolRegistry
  // throws on the FIRST register call for the second Agent we rebuild.
  let throwsLeft = 1;
  const flaky = (): NativeToolRegistry => {
    const names = new Set<string>();
    return {
      has: () => false,
      register: (name: string) => {
        if (throwsLeft > 0 && name === 'suggest_follow_ups') {
          throwsLeft -= 1;
          throw new Error('synthetic build failure');
        }
        names.add(name);
        return () => names.delete(name);
      },
    } as unknown as NativeToolRegistry;
  };

  const store = new MutableFakeStore(baseSnapshot);
  const flakyDeps: OrchestratorDeps = {
    ...deps(),
    nativeToolRegistry: flaky(),
  };
  // First Agent (public) is built fine because the throw is consumed on the
  // SECOND agent — but during start() both build sequentially. We expect the
  // first to throw + be skipped, the second to come up.
  const registry = new OrchestratorRegistry(
    store as ConfigStore,
    flakyDeps,
    {
      defaultRuntimeConfig: { model: 'm', maxTokens: 100, maxToolIterations: 4 },
      log: () => undefined,
    },
  );
  await registry.start();

  // Exactly one Agent survived; the throw was caught + isolated.
  assert.equal(
    registry.size(),
    1,
    'the diff must isolate the failing Agent, not abort the whole diff',
  );
});

test('T020: diffSnapshots is pure — exposes the action set without touching live state', () => {
  const oldSnap = baseSnapshot;
  const newSnap: ConfigSnapshot = {
    ...baseSnapshot,
    agents: [
      agent('public', '00000000-0000-0000-0000-000000000001', {
        privacyProfile: 'strict',
      }),
      agent('new-agent', '00000000-0000-0000-0000-000000000003'),
    ],
    platformSettings: {
      fallbackAgentId: '00000000-0000-0000-0000-000000000001',
      updatedAt: new Date(1),
    },
  };

  const plan = diffSnapshots(oldSnap, newSnap);

  const kinds = plan.actions.map((a) => a.kind).sort();
  assert.deepEqual(kinds, ['add', 'rebuild', 'remove']);
  assert.equal(plan.platformChanged, true);
});
