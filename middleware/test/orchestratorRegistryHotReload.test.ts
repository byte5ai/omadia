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
import {
  OrchestratorRegistry,
  type PluginCapabilityLookup,
} from '../packages/harness-orchestrator/src/registry/index.js';

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
  const registry = new OrchestratorRegistry(store as unknown as ConfigStore, deps(), {
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
  const registry = new OrchestratorRegistry(store as unknown as ConfigStore, deps(), {
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
  const registry = new OrchestratorRegistry(store as unknown as ConfigStore, deps(), {
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

const SEO_PLUGIN = '@omadia/agent-seo-analyst';

function pluginRow(agentId: string, pluginId: string, enabled = true) {
  return { agentId, pluginId, config: {}, enabled, createdAt: new Date(0) };
}

/**
 * A grant reaches the running Agent only through a BUILD.
 *
 * The granted plugin set is baked into the `Orchestrator` twice: as the
 * `grantedPluginIds` its dispatch gate checks, and as the domain tools the
 * kernel hydrates from `onAgentBuilt` — which only `add`/`rebuild` fire. So a
 * metadata-only `update` left the operator's change persisted, reported as
 * saved, and inert until the next process start.
 *
 * These two tests pin both directions, because only one of them is merely
 * annoying. Granting late means a capability arrives after a restart nobody
 * asked for; revoking late means a capability the operator took away is still
 * live — the same privilege escalation as #984, just on a timer.
 */
test('granting a plugin rebuilds the Orchestrator (the grant must not wait for a restart)', async () => {
  const store = new MutableFakeStore(baseSnapshot);
  const registry = new OrchestratorRegistry(store as unknown as ConfigStore, deps(), {
    defaultRuntimeConfig: { model: 'm', maxTokens: 100, maxToolIterations: 4 },
  });
  await registry.start();

  const publicBefore = registry.get('public')!.built.orchestrator;

  store.set({
    ...baseSnapshot,
    agentPlugins: [pluginRow('00000000-0000-0000-0000-000000000001', SEO_PLUGIN)],
  });
  const plan = await registry.reload();

  assert.equal(plan.actions.length, 1);
  const action = plan.actions[0]!;
  assert.equal(action.kind, 'rebuild');
  assert.match(
    action.kind === 'rebuild' ? action.reason : '',
    /plugin_grants/,
    'the reason names the grant change, so the log says why the agent restarted',
  );
  assert.notEqual(
    registry.get('public')!.built.orchestrator,
    publicBefore,
    'a fresh Orchestrator is what carries the new grant + tool surface',
  );
  assert.deepEqual(
    registry.get('public')!.plugins.map((p) => p.pluginId),
    [SEO_PLUGIN],
    'plugin list is refreshed on the ActiveAgent metadata',
  );
});

test('revoking a plugin rebuilds too — a withdrawn capability must stop working now', async () => {
  const granted: ConfigSnapshot = {
    ...baseSnapshot,
    agentPlugins: [pluginRow('00000000-0000-0000-0000-000000000001', SEO_PLUGIN)],
  };
  const store = new MutableFakeStore(granted);
  const registry = new OrchestratorRegistry(store as unknown as ConfigStore, deps(), {
    defaultRuntimeConfig: { model: 'm', maxTokens: 100, maxToolIterations: 4 },
  });
  await registry.start();

  const publicBefore = registry.get('public')!.built.orchestrator;

  store.set(baseSnapshot);
  const plan = await registry.reload();

  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0]!.kind, 'rebuild');
  assert.notEqual(registry.get('public')!.built.orchestrator, publicBefore);
  assert.deepEqual(registry.get('public')!.plugins, []);
});

test('disabling a granted plugin counts as a revocation, not a metadata edit', async () => {
  // `enabled: false` is the UI's toggle. The diff groups on the ENABLED rows,
  // so a flip has to read as a set change and not as "same row, new column".
  const granted: ConfigSnapshot = {
    ...baseSnapshot,
    agentPlugins: [pluginRow('00000000-0000-0000-0000-000000000001', SEO_PLUGIN)],
  };
  const store = new MutableFakeStore(granted);
  const registry = new OrchestratorRegistry(store as unknown as ConfigStore, deps(), {
    defaultRuntimeConfig: { model: 'm', maxTokens: 100, maxToolIterations: 4 },
  });
  await registry.start();

  store.set({
    ...baseSnapshot,
    agentPlugins: [
      pluginRow('00000000-0000-0000-0000-000000000001', SEO_PLUGIN, false),
    ],
  });
  const plan = await registry.reload();

  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0]!.kind, 'rebuild');
});

test('T020: a binding-only change still emits a cheap update, not a rebuild', async () => {
  // The `update` path keeps its reason to exist: channel bindings decide WHERE
  // an agent is reachable, never WHAT it may do, so routing changes must not
  // cost every live session its Orchestrator.
  const store = new MutableFakeStore(baseSnapshot);
  const registry = new OrchestratorRegistry(store as unknown as ConfigStore, deps(), {
    defaultRuntimeConfig: { model: 'm', maxTokens: 100, maxToolIterations: 4 },
  });
  await registry.start();

  const publicBefore = registry.get('public')!.built.orchestrator;

  store.set({
    ...baseSnapshot,
    channelBindings: [
      {
        agentId: '00000000-0000-0000-0000-000000000001',
        channelType: 'teams',
        channelKey: '19:abc@thread.skype',
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
});

test('T020: an idempotent reload (no DB change) emits zero actions', async () => {
  const store = new MutableFakeStore(baseSnapshot);
  const registry = new OrchestratorRegistry(store as unknown as ConfigStore, deps(), {
    defaultRuntimeConfig: { model: 'm', maxTokens: 100, maxToolIterations: 4 },
  });
  await registry.start();

  const plan = await registry.reload();
  assert.equal(plan.actions.length, 0);
  assert.equal(plan.platformChanged, false);
});

test('OM-95: consecutive reconciles quarantine the same dead binding only once', async () => {
  const binding = Object.freeze(pluginRow(baseSnapshot.agents[0]!.id, SEO_PLUGIN));
  const snapshot: ConfigSnapshot = Object.freeze({
    ...baseSnapshot,
    agentPlugins: Object.freeze([binding]),
  });
  const store = new MutableFakeStore(snapshot);
  const logged: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const registry = new OrchestratorRegistry(store as unknown as ConfigStore, deps(), {
    defaultRuntimeConfig: { model: 'm', maxTokens: 100, maxToolIterations: 4 },
    pluginLookup: { isMultiInstance: () => true, isInstalled: () => false },
    log: (msg, fields) => logged.push({ msg, ...(fields ? { fields } : {}) }),
  });

  await registry.reload();
  const publicBefore = registry.get('public')!.built.orchestrator;
  const logCount = logged.length;
  const plan = await registry.reload();

  assert.equal(plan.actions.length, 0);
  assert.equal(logged.length, logCount, 'an unchanged quarantine emits no log lines');
  assert.equal(registry.get('public')!.built.orchestrator, publicBefore);
  assert.equal(binding.enabled, true, 'even repeated quarantine never mutates the DB snapshot');
  assert.equal(registry.get('public')!.plugins[0]!.enabled, false);
  assert.deepEqual(
    logged.filter((entry) => entry.msg === 'registry: plugin not installed — disabling binding'),
    [{ msg: 'registry: plugin not installed — disabling binding', fields: { agentId: binding.agentId, pluginId: SEO_PLUGIN } }],
  );
  assert.deepEqual(
    logged.filter((entry) => entry.msg === 'registry: quarantined unsatisfiable plugin binding(s)').map((entry) => entry.fields),
    [{ newlyQuarantined: 1, noLongerQuarantined: 0, totalQuarantined: 1 }],
  );
});

test('OM-95: a recovered plugin clears quarantine memory and a later disappearance logs again', async () => {
  const snapshot: ConfigSnapshot = {
    ...baseSnapshot,
    agentPlugins: [pluginRow(baseSnapshot.agents[0]!.id, SEO_PLUGIN)],
  };
  const store = new MutableFakeStore(snapshot);
  const logged: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  let installed = false;
  const registry = new OrchestratorRegistry(store as unknown as ConfigStore, deps(), {
    defaultRuntimeConfig: { model: 'm', maxTokens: 100, maxToolIterations: 4 },
    pluginLookup: { isMultiInstance: () => true, isInstalled: () => installed },
    log: (msg, fields) => logged.push({ msg, ...(fields ? { fields } : {}) }),
  });

  await registry.start();
  installed = true;
  await registry.reload();
  assert.equal(registry.get('public')!.plugins[0], snapshot.agentPlugins[0], 'recovery restores the untouched enabled row');
  const recoveredLogCount = logged.length;
  await registry.reload();
  assert.equal(logged.length, recoveredLogCount, 'stable recovery is silent too');
  installed = false;
  await registry.reload();

  assert.equal(registry.get('public')!.plugins[0]!.enabled, false);
  assert.equal(logged.filter((entry) => entry.msg === 'registry: plugin not installed — disabling binding').length, 2);
  assert.deepEqual(
    logged.filter((entry) => entry.msg === 'registry: quarantined unsatisfiable plugin binding(s)').map((entry) => entry.fields),
    [
      { newlyQuarantined: 1, noLongerQuarantined: 0, totalQuarantined: 1 },
      { newlyQuarantined: 0, noLongerQuarantined: 1, totalQuarantined: 0 },
      { newlyQuarantined: 1, noLongerQuarantined: 0, totalQuarantined: 1 },
    ],
  );
});

test('OM-95: removed and explicitly disabled bindings leave quarantine memory', async () => {
  for (const removed of [true, false]) {
    const binding = pluginRow(baseSnapshot.agents[0]!.id, SEO_PLUGIN);
    const snapshot: ConfigSnapshot = { ...baseSnapshot, agentPlugins: [binding] };
    const store = new MutableFakeStore(snapshot);
    const logged: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
    const registry = new OrchestratorRegistry(store as unknown as ConfigStore, deps(), {
      defaultRuntimeConfig: { model: 'm', maxTokens: 100, maxToolIterations: 4 },
      pluginLookup: { isMultiInstance: () => true, isInstalled: () => false },
      log: (msg, fields) => logged.push({ msg, ...(fields ? { fields } : {}) }),
    });

    await registry.start();
    store.set({ ...snapshot, agentPlugins: removed ? [] : [{ ...binding, enabled: false }] });
    await registry.reload();
    const clearedLogCount = logged.length;
    await registry.reload();
    assert.equal(logged.length, clearedLogCount, 'empty quarantine remains silent');
    store.set(snapshot);
    await registry.reload();

    assert.equal(logged.filter((entry) => entry.msg === 'registry: plugin not installed — disabling binding').length, 2);
    assert.deepEqual(
      logged.filter((entry) => entry.msg === 'registry: quarantined unsatisfiable plugin binding(s)').map((entry) => entry.fields),
      [
        { newlyQuarantined: 1, noLongerQuarantined: 0, totalQuarantined: 1 },
        { newlyQuarantined: 0, noLongerQuarantined: 1, totalQuarantined: 0 },
        { newlyQuarantined: 1, noLongerQuarantined: 0, totalQuarantined: 1 },
      ],
    );
  }
});

test('OM-95: losing the installation lookup clears quarantine memory without altering the snapshot', async () => {
  for (const missingPluginLookup of [true, false]) {
    const snapshot: ConfigSnapshot = {
      ...baseSnapshot,
      agentPlugins: [pluginRow(baseSnapshot.agents[0]!.id, SEO_PLUGIN)],
    };
    const store = new MutableFakeStore(snapshot);
    const logged: string[] = [];
    let lookup: PluginCapabilityLookup | undefined = {
      isMultiInstance: () => true,
      isInstalled: () => false,
    };
    const registry = new OrchestratorRegistry(store as unknown as ConfigStore, deps(), {
      defaultRuntimeConfig: { model: 'm', maxTokens: 100, maxToolIterations: 4 },
      get pluginLookup() { return lookup; },
      log: (msg) => logged.push(msg),
    });

    await registry.start();
    lookup = missingPluginLookup ? undefined : { isMultiInstance: () => true };
    const quarantineLogCount = logged.filter((msg) => msg.includes('quarantined') || msg.includes('plugin not installed')).length;
    await registry.reload();
    assert.equal(registry.get('public')!.plugins[0], snapshot.agentPlugins[0]);
    assert.equal(
      logged.filter((msg) => msg.includes('quarantined') || msg.includes('plugin not installed')).length,
      quarantineLogCount,
      'missing lookup emits no quarantine logs',
    );
    lookup = { isMultiInstance: () => true, isInstalled: () => false };
    await registry.reload();
    assert.equal(logged.filter((msg) => msg === 'registry: plugin not installed — disabling binding').length, 2);
  }
});

test('OM-95: tuple keys cannot collide and replacing quarantine members logs a change at the same total', async () => {
  // These pairs collide with a NUL-delimited key despite being distinct bindings.
  const first = pluginRow('a\0b', 'c');
  const second = pluginRow('a', 'b\0c');
  const snapshot: ConfigSnapshot = {
    ...baseSnapshot,
    agents: [agent('public', first.agentId), agent('general', second.agentId)],
    agentPlugins: [first],
  };
  const store = new MutableFakeStore(snapshot);
  const logged: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const registry = new OrchestratorRegistry(store as unknown as ConfigStore, deps(), {
    defaultRuntimeConfig: { model: 'm', maxTokens: 100, maxToolIterations: 4 },
    pluginLookup: { isMultiInstance: () => true, isInstalled: () => false },
    log: (msg, fields) => logged.push({ msg, ...(fields ? { fields } : {}) }),
  });

  await registry.start();
  store.set({ ...snapshot, agentPlugins: [second] });
  await registry.reload();

  assert.deepEqual(
    logged.filter((entry) => entry.msg === 'registry: plugin not installed — disabling binding').map((entry) => entry.fields),
    [
      { agentId: first.agentId, pluginId: first.pluginId },
      { agentId: second.agentId, pluginId: second.pluginId },
    ],
  );
  assert.deepEqual(
    logged.filter((entry) => entry.msg === 'registry: quarantined unsatisfiable plugin binding(s)').map((entry) => entry.fields),
    [
      { newlyQuarantined: 1, noLongerQuarantined: 0, totalQuarantined: 1 },
      { newlyQuarantined: 1, noLongerQuarantined: 1, totalQuarantined: 1 },
    ],
  );
});

test('OM-95: quarantine tracking belongs to each registry instance', async () => {
  const snapshot: ConfigSnapshot = {
    ...baseSnapshot,
    agentPlugins: [pluginRow(baseSnapshot.agents[0]!.id, SEO_PLUGIN)],
  };
  const store = new MutableFakeStore(snapshot);
  const firstLogs: string[] = [];
  const secondLogs: string[] = [];
  const options = {
    defaultRuntimeConfig: { model: 'm', maxTokens: 100, maxToolIterations: 4 },
    pluginLookup: { isMultiInstance: () => true, isInstalled: () => false },
  };
  const first = new OrchestratorRegistry(store as unknown as ConfigStore, deps(), {
    ...options,
    log: (msg) => firstLogs.push(msg),
  });
  const second = new OrchestratorRegistry(store as unknown as ConfigStore, deps(), {
    ...options,
    log: (msg) => secondLogs.push(msg),
  });

  await first.start();
  await second.start();
  await first.reload();
  await second.reload();

  for (const logged of [firstLogs, secondLogs]) {
    assert.equal(logged.filter((msg) => msg === 'registry: plugin not installed — disabling binding').length, 1);
    assert.equal(logged.filter((msg) => msg === 'registry: quarantined unsatisfiable plugin binding(s)').length, 1);
  }
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
    store as unknown as ConfigStore,
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
